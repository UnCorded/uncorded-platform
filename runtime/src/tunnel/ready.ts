// Authenticated-tunnel readiness — spec-10 Amendment A.
//
// Cloudflared logs "Registered tunnel connection" once per CF edge connection
// as it brings up its four-connection mesh. The very first registration fires
// BEFORE the ingress config is installed and well before all edges are up —
// CF edge colos that haven't seen the registration return 5xx/404 for the
// hostname for several seconds afterwards. Resolving on the first connection
// alone hands the desktop wizard a tunnel URL the user's browser cannot reach.
//
// The gate below waits for BOTH:
//   1. "Updated to new configuration"  → ingress config is installed
//   2. EITHER ≥2 edge connections, OR a 5s grace window after the first
//      connection registration (a single-edge degraded boot is acceptable —
//      we don't want to hang on it).
//
// This module also contains the non-blocking runtime self-probe — a
// best-effort HTTPS check of the runtime's own public /health URL from
// inside the container. Different network path from the user's browser,
// so a failure here is diagnostic only; the desktop probe (spec-10
// Amendment A step 8.5) is the authoritative gate.

export const TUNNEL_READY_DEADLINE_MS = 30_000;
export const TUNNEL_READY_GRACE_MS = 5_000;

const INGRESS_CONFIG_LINE = "Updated to new configuration";
const CONNECTION_REGISTERED_LINE = "Registered tunnel connection";

export interface AwaitAuthenticatedTunnelReadyDeps {
  readonly publicUrl: string;
  readonly stderrStream: ReadableStream<Uint8Array>;
  /** Called for every parsed stderr line (production wires this to logCloudflaredLine). */
  readonly onLine?: (line: string) => void;
  /** Injectable monotonic clock; defaults to Date.now. */
  readonly now?: () => number;
  /** Injectable timer hooks; default to globalThis. */
  readonly setTimeoutFn?: (cb: () => void, ms: number) => unknown;
  readonly clearTimeoutFn?: (handle: unknown) => void;
  /** Overall startup budget. Default 30s. */
  readonly deadlineMs?: number;
  /** Grace window applied after the first connection registers, in case the
   *  second never arrives. Default 5s. */
  readonly graceMs?: number;
}

/**
 * Run the state machine that decides when the authenticated tunnel is ready.
 *
 * Resolves with `publicUrl` once the gate is met. Rejects if the deadline
 * expires or the stream closes without the gate being met.
 *
 * Owns no process lifecycle — the caller spawns and kills cloudflared. Owns
 * the timers it allocates and clears them on every exit path.
 */
export async function awaitAuthenticatedTunnelReady(
  deps: AwaitAuthenticatedTunnelReadyDeps,
): Promise<string> {
  const now = deps.now ?? Date.now;
  const setT = deps.setTimeoutFn ?? ((cb, ms) => setTimeout(cb, ms));
  const clearT = deps.clearTimeoutFn ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const deadlineMs = deps.deadlineMs ?? TUNNEL_READY_DEADLINE_MS;
  const graceMs = deps.graceMs ?? TUNNEL_READY_GRACE_MS;
  const onLine = deps.onLine ?? (() => undefined);

  return new Promise<string>((resolve, reject) => {
    let connectionCount = 0;
    let ingressConfigSeen = false;
    let firstConnectionAt: number | null = null;
    let settled = false;
    let graceHandle: unknown = null;

    const deadlineHandle = setT(() => {
      if (settled) return;
      settled = true;
      if (graceHandle !== null) clearT(graceHandle);
      reject(new Error("cloudflared authenticated tunnel did not register within 30 seconds"));
    }, deadlineMs);

    function settleResolve(): void {
      if (settled) return;
      settled = true;
      clearT(deadlineHandle);
      if (graceHandle !== null) clearT(graceHandle);
      resolve(deps.publicUrl);
    }

    function settleReject(err: Error): void {
      if (settled) return;
      settled = true;
      clearT(deadlineHandle);
      if (graceHandle !== null) clearT(graceHandle);
      reject(err);
    }

    function maybeArmGrace(): void {
      // Arm grace the moment both ingress config AND ≥1 connection are seen.
      // Re-evaluation on subsequent lines catches the happy path (a second
      // connection arriving inside the window). Grace covers the degraded
      // single-edge boot.
      if (graceHandle !== null) return;
      if (!ingressConfigSeen) return;
      if (firstConnectionAt === null) return;
      const elapsed = now() - firstConnectionAt;
      const remaining = Math.max(0, graceMs - elapsed);
      graceHandle = setT(() => {
        graceHandle = null;
        if (!settled && ingressConfigSeen && connectionCount >= 1) settleResolve();
      }, remaining);
    }

    function evaluate(): void {
      if (settled) return;
      if (ingressConfigSeen && connectionCount >= 2) {
        settleResolve();
        return;
      }
      maybeArmGrace();
    }

    void (async () => {
      try {
        const reader = deps.stderrStream.getReader();
        const decoder = new TextDecoder();
        let buf = "";

        while (!settled) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const line of lines) {
            onLine(line);
            if (line.includes(INGRESS_CONFIG_LINE)) {
              ingressConfigSeen = true;
            }
            if (line.includes(CONNECTION_REGISTERED_LINE)) {
              connectionCount += 1;
              if (firstConnectionAt === null) firstConnectionAt = now();
            }
            evaluate();
            if (settled) break;
          }
        }
      } catch {
        // Stream closed — expected on process exit; fall through to the
        // settle-reject below if we haven't already settled.
      }

      if (!settled) {
        settleReject(new Error("cloudflared authenticated tunnel exited without registering a connection"));
      }
    })();
  });
}

// ---------------------------------------------------------------------------
// Runtime self-probe
// ---------------------------------------------------------------------------

export type RuntimeSelfProbeFailureReason = "dns" | "http" | "timeout" | "abort" | "unknown";

export interface RuntimeSelfProbeResult {
  readonly ok: boolean;
  readonly reason?: RuntimeSelfProbeFailureReason;
  readonly status?: number;
  readonly attempts: number;
}

export interface RuntimeSelfProbeDeps {
  readonly publicUrl: string;
  readonly fetchFn?: typeof fetch;
  readonly attempts?: number;
  readonly backoffMs?: readonly number[];
  readonly perAttemptTimeoutMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

function classifySelfProbeError(err: unknown): RuntimeSelfProbeFailureReason {
  if (err instanceof Error) {
    if (err.name === "AbortError" || /aborted|timeout/i.test(err.message)) return "timeout";
    if (/getaddrinfo|EAI_AGAIN|ENOTFOUND|dns/i.test(err.message)) return "dns";
    return "http";
  }
  return "unknown";
}

export async function runRuntimeTunnelSelfProbe(
  deps: RuntimeSelfProbeDeps,
): Promise<RuntimeSelfProbeResult> {
  const fetchFn = deps.fetchFn ?? fetch;
  const attempts = deps.attempts ?? 3;
  const backoff = deps.backoffMs ?? [500, 1500, 3000];
  const perAttemptTimeoutMs = deps.perAttemptTimeoutMs ?? 3_000;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const url = `${deps.publicUrl.replace(/\/$/, "")}/health`;

  let lastReason: RuntimeSelfProbeFailureReason = "unknown";
  let lastStatus: number | undefined;

  for (let i = 0; i < attempts; i++) {
    if (i > 0) {
      const delay = backoff[Math.min(i - 1, backoff.length - 1)] ?? 0;
      await sleep(delay);
    }
    try {
      const res = await fetchFn(url, {
        method: "GET",
        signal: AbortSignal.timeout(perAttemptTimeoutMs),
        credentials: "omit",
        cache: "no-store",
      });
      if (res.ok) {
        return { ok: true, attempts: i + 1, status: res.status };
      }
      lastReason = "http";
      lastStatus = res.status;
    } catch (err) {
      lastReason = classifySelfProbeError(err);
    }
  }

  return lastStatus !== undefined
    ? { ok: false, reason: lastReason, status: lastStatus, attempts }
    : { ok: false, reason: lastReason, attempts };
}
