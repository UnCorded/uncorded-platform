// Voice external-reachability state machine — spec-24 Amendment A.
//
// Owns the runtime's view of "are our RTC ports reachable from the public
// internet?" This is the silent-failure surface where signaling reaches the
// container through Cloudflare Tunnel but media never flows because the
// owner's router doesn't forward TCP 7881 / UDP 3478. The probe targets
// LiveKit's embedded TURN/STUN responder on UDP 3478 (Amendment C) rather
// than the MUX media port on UDP 50000 (Amendment B) — pion ICE drops cold
// STUN Binding Requests at the MUX socket because its USERNAME-required
// dispatch has no active session to map to, so probing 50000 always times
// out even on a perfectly forwarded router. RFC 5766 §6.5 forces TURN
// servers to answer bare STUN, which makes 3478 the deterministic
// reachability proxy. UDP 50000 still carries real call media; we just
// don't probe it.
//
// Probes are run by Central (which has a public vantage); the runtime only
// drives WHEN to probe, caches the result, and surfaces it to the UI through
// /health/voice + a runtime event.
//
// Triggers:
//   1. boot         — fired once after voice supervisor is `ready` AND the
//                     first heartbeat completed (so Central has a
//                     last_heartbeat_ip to target).
//   2. wan_change   — heartbeat client surfaces wan_ip on every response;
//                     a delta against the cached value triggers a re-probe.
//   3. ice_cluster  — derived from LiveKit webhook stream: ≥3 short-lived
//                     joins (≤10s) with zero ≥30s sessions in a 5-min window.
//                     5-min cooldown specific to this trigger so a single
//                     burst can't loop.
//   4. manual       — owner-driven, via POST /admin/api/voice/probe.
//                     Bypasses the 60s post-probe cooldown that gates the
//                     three automatic triggers.
//
// Persistence:
//   The most recent VoiceProbeResult is mirrored to the single-row
//   `voice_reachability_state` SQLite table so a quick container bounce
//   doesn't lose state. Restart of the LiveKit subprocess alone (without
//   container recreate) doesn't reset reachability — the WAN path didn't
//   change.

import type { Database } from "bun:sqlite";
import { rootLogger } from "@uncorded/shared";

// ---------------------------------------------------------------------------
// Public types — mirror spec-24 Amendment A1
// ---------------------------------------------------------------------------

export interface PortGroupResult {
  reachable: boolean;
  latencyMs: number | null;
  error: string | null;
}

export interface VoiceProbeResult {
  /**
   * Schema version of this result envelope. Mirrors Central's
   * `VoiceProbeResult.version` (see apps/central/src/probe/types.ts).
   * Current writers emit 1. The validator below accepts a missing
   * version field as legacy v1 (for SQLite rows persisted before this
   * field existed) but rejects unknown numeric versions so a future
   * Central rollout can't silently render with v1 assumptions.
   */
  version: 1;
  status: "ready" | "unreachable";
  /** ISO8601 — Central's wall clock at probe completion. */
  checkedAt: string;
  /** Probed WAN IP (Central's view of the runtime's source address). */
  wanIp: string;
  rtcTcp: PortGroupResult;
  rtcUdp: PortGroupResult;
}

export type VoiceReachabilityState =
  | { status: "checking"; lastResult: VoiceProbeResult | null }
  | { status: "ready"; result: VoiceProbeResult }
  | { status: "unreachable"; result: VoiceProbeResult };

export interface VoiceReachabilityChangedEvent {
  previous: VoiceReachabilityState | null;
  current: VoiceReachabilityState;
}

// ---------------------------------------------------------------------------
// Internal state — richer than the public projection (adds idle + cooldown)
// ---------------------------------------------------------------------------

type InternalState =
  | { phase: "idle" }
  | {
      phase: "checking";
      startedAt: number;
      lastResult: VoiceProbeResult | null;
    }
  | { phase: "settled"; result: VoiceProbeResult }
  | { phase: "cooldown"; until: number; result: VoiceProbeResult };

export type ProbeTrigger = "boot" | "wan_change" | "ice_cluster" | "manual";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROBE_COOLDOWN_MS = 60_000;
const ICE_CLUSTER_COOLDOWN_MS = 5 * 60_000;
const ICE_FAILED_JOIN_WINDOW_MS = 10_000;
const ICE_SUCCESS_SESSION_MS = 30_000;
const ICE_DETECTION_WINDOW_MS = 5 * 60_000;
const ICE_FAILED_JOIN_THRESHOLD = 3;
const PROBE_HTTP_TIMEOUT_MS = 12_000;
const BOOT_DELAY_MS = 2_000;

// ---------------------------------------------------------------------------
// Errors surfaced from requestProbe()
// ---------------------------------------------------------------------------

export type ProbeRequestResult =
  | { ok: true; result: VoiceProbeResult }
  | { ok: false; code: "in_flight" | "cooldown" | "voice_disabled" | "remote"; message: string; retryAfterMs?: number };

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

export interface ReachabilityDeps {
  db: Database;
  centralUrl: string;
  serverId: string;
  serverSecret: string;
  /** Publish `runtime.voice.reachability.changed` on status delta. */
  publishRuntimeEvent: (topic: string, payload: unknown) => void;
  /** Injectable fetch — defaults to globalThis.fetch. */
  fetch?: typeof globalThis.fetch;
  /** Injectable wall clock (epoch ms). Defaults to Date.now. */
  now?: () => number;
  /** Injectable timer setter. Defaults to globalThis.setTimeout. */
  setTimeout?: (cb: () => void, ms: number) => unknown;
  /** Matching clear. */
  clearTimeout?: (handle: unknown) => void;
}

export interface ReachabilityHandle {
  /** Restore from SQLite cache. Must be called before the first trigger. */
  init(): void;
  /** Public projection of internal state. Sub-millisecond hot-path getter. */
  getState(): VoiceReachabilityState | null;
  /** Trigger a probe. Automatic triggers are gated by the 60s cooldown;
   *  `manual` bypasses it. Concurrent calls coalesce onto the in-flight
   *  promise. */
  requestProbe(trigger: ProbeTrigger): Promise<ProbeRequestResult>;

  // Hooks called by the boot orchestrator and the heartbeat / webhook
  // subsystems. Keep these synchronous — they fire from hot paths.
  noteVoiceReady(): void;
  noteWanIp(wanIp: string): void;
  noteParticipantJoined(channelId: string, userId: string, sessionId: string): void;
  noteParticipantLeft(channelId: string, userId: string, sessionId: string): void;

  /** Cancel any pending boot timer. Idempotent. Used by main.ts on shutdown. */
  shutdown(): void;
}

interface ParticipantSession {
  joinedAt: number;
  channelId: string;
}

const log = rootLogger.child({ component: "voice.reachability" });

const TOPIC_REACHABILITY_CHANGED = "runtime.voice.reachability.changed";

export function createReachability(deps: ReachabilityDeps): ReachabilityHandle {
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const now = deps.now ?? Date.now;
  const setTimeoutFn =
    deps.setTimeout ?? ((cb, ms) => globalThis.setTimeout(cb, ms));
  const clearTimeoutFn =
    deps.clearTimeout ??
    ((h: unknown) => globalThis.clearTimeout(h as Parameters<typeof globalThis.clearTimeout>[0]));

  let internal: InternalState = { phase: "idle" };
  let inflight: Promise<ProbeRequestResult> | null = null;
  let voiceReady = false;
  let lastWanIp: string | null = null;
  let bootProbeScheduled = false;
  let bootTimerHandle: unknown = null;

  // Per-identity active sessions for ICE-cluster detection. Keyed by
  // `${channelId}:${userId}`; we don't carry sessionId because LiveKit's
  // webhook re-uses identities on reconnect and sessionId differs each time —
  // tracking by identity matches the failed-join semantics in the spec.
  const activeSessions = new Map<string, ParticipantSession>();
  // Sliding window of completed sessions: { ts: leaveTime, durationMs }.
  // Trimmed on each event to entries within ICE_DETECTION_WINDOW_MS of `now`.
  interface CompletedSession {
    leftAt: number;
    durationMs: number;
  }
  let recentSessions: CompletedSession[] = [];
  let lastIceProbeAt = 0;

  // ----- internal helpers --------------------------------------------------

  function publicState(): VoiceReachabilityState | null {
    switch (internal.phase) {
      case "idle":
        return null;
      case "checking":
        return { status: "checking", lastResult: internal.lastResult };
      case "settled":
        return { status: internal.result.status, result: internal.result };
      case "cooldown":
        return { status: internal.result.status, result: internal.result };
    }
  }

  function publishIfChanged(previous: VoiceReachabilityState | null): void {
    const current = publicState();
    if (current === null) return;
    const prevStatus = previous?.status ?? null;
    if (prevStatus === current.status) return;
    try {
      deps.publishRuntimeEvent(TOPIC_REACHABILITY_CHANGED, {
        previous,
        current,
      } satisfies VoiceReachabilityChangedEvent);
    } catch (err) {
      log.warn("publishRuntimeEvent threw", {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  function persist(result: VoiceProbeResult): void {
    try {
      deps.db
        .prepare(
          `INSERT INTO voice_reachability_state
             (id, status, checked_at, wan_ip, rtc_tcp_json, rtc_udp_json)
           VALUES (1, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             status       = excluded.status,
             checked_at   = excluded.checked_at,
             wan_ip       = excluded.wan_ip,
             rtc_tcp_json = excluded.rtc_tcp_json,
             rtc_udp_json = excluded.rtc_udp_json`,
        )
        .run(
          result.status,
          Date.parse(result.checkedAt),
          result.wanIp,
          JSON.stringify(result.rtcTcp),
          JSON.stringify(result.rtcUdp),
        );
    } catch (err) {
      log.warn("failed to persist voice reachability", {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  function restore(): void {
    try {
      const row = deps.db
        .query<
          {
            status: string;
            checked_at: number;
            wan_ip: string;
            rtc_tcp_json: string;
            rtc_udp_json: string;
          },
          []
        >(
          `SELECT status, checked_at, wan_ip, rtc_tcp_json, rtc_udp_json
             FROM voice_reachability_state
             WHERE id = 1`,
        )
        .get();
      if (!row) return;
      if (row.status !== "ready" && row.status !== "unreachable") return;
      const rtcTcp = JSON.parse(row.rtc_tcp_json) as PortGroupResult;
      const rtcUdp = JSON.parse(row.rtc_udp_json) as PortGroupResult;
      const result: VoiceProbeResult = {
        // SQLite columns predate the version field; rebuilt rows are
        // structurally v1 by definition. Future schema bumps add a
        // version column to the migration alongside whatever shape change
        // motivated the bump.
        version: 1,
        status: row.status,
        checkedAt: new Date(row.checked_at).toISOString(),
        wanIp: row.wan_ip,
        rtcTcp,
        rtcUdp,
      };
      // Restore directly to settled (no cooldown) — a fresh process didn't
      // just probe, the persisted row is informational only.
      internal = { phase: "settled", result };
    } catch (err) {
      log.warn("failed to restore voice reachability", {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  function maybeScheduleBoot(): void {
    if (bootProbeScheduled) return;
    if (!voiceReady) return;
    if (lastWanIp === null) return;
    bootProbeScheduled = true;
    bootTimerHandle = setTimeoutFn(() => {
      bootTimerHandle = null;
      void requestProbe("boot").catch(() => {
        // requestProbe never rejects — defensive.
      });
    }, BOOT_DELAY_MS);
  }

  function trimRecentSessions(t: number): void {
    const cutoff = t - ICE_DETECTION_WINDOW_MS;
    recentSessions = recentSessions.filter((s) => s.leftAt >= cutoff);
  }

  function recordSession(durationMs: number, leftAt: number): void {
    recentSessions.push({ leftAt, durationMs });
    trimRecentSessions(leftAt);
  }

  function maybeFireIceTrigger(t: number): void {
    if (t - lastIceProbeAt < ICE_CLUSTER_COOLDOWN_MS) return;
    trimRecentSessions(t);
    let failed = 0;
    let succeeded = 0;
    for (const s of recentSessions) {
      if (s.durationMs >= ICE_SUCCESS_SESSION_MS) succeeded++;
      else if (s.durationMs <= ICE_FAILED_JOIN_WINDOW_MS) failed++;
    }
    if (failed >= ICE_FAILED_JOIN_THRESHOLD && succeeded === 0) {
      lastIceProbeAt = t;
      log.warn("ICE failure cluster detected — triggering reachability probe", {
        failed,
        succeeded,
        windowMs: ICE_DETECTION_WINDOW_MS,
      });
      void requestProbe("ice_cluster").catch(() => {});
    }
  }

  // ----- public API --------------------------------------------------------

  function init(): void {
    restore();
  }

  function getState(): VoiceReachabilityState | null {
    // Cooldown's only purpose is to gate auto-probes; the public projection
    // treats cooldown the same as settled. If the cooldown deadline passed,
    // promote internal state so subsequent introspection reads cleanly.
    if (internal.phase === "cooldown" && now() >= internal.until) {
      internal = { phase: "settled", result: internal.result };
    }
    return publicState();
  }

  function noteVoiceReady(): void {
    voiceReady = true;
    maybeScheduleBoot();
  }

  function noteWanIp(wanIp: string): void {
    const previous = lastWanIp;
    lastWanIp = wanIp;
    if (previous === null) {
      // First observation — used as the boot gate, not a wan_change trigger.
      maybeScheduleBoot();
      return;
    }
    if (previous === wanIp) return;
    log.info("WAN IP changed — triggering reachability probe", {
      previous,
      current: wanIp,
    });
    void requestProbe("wan_change").catch(() => {});
  }

  function noteParticipantJoined(
    channelId: string,
    userId: string,
    _sessionId: string,
  ): void {
    const key = `${channelId}:${userId}`;
    activeSessions.set(key, { joinedAt: now(), channelId });
  }

  function noteParticipantLeft(
    channelId: string,
    userId: string,
    _sessionId: string,
  ): void {
    const key = `${channelId}:${userId}`;
    const session = activeSessions.get(key);
    if (!session) return;
    activeSessions.delete(key);
    const t = now();
    const durationMs = t - session.joinedAt;
    recordSession(durationMs, t);
    maybeFireIceTrigger(t);
  }

  async function requestProbe(
    trigger: ProbeTrigger,
  ): Promise<ProbeRequestResult> {
    if (inflight) return inflight;

    // Cooldown gate — manual bypasses, automatic triggers wait it out.
    if (internal.phase === "cooldown") {
      const remaining = internal.until - now();
      if (remaining > 0 && trigger !== "manual") {
        return {
          ok: false,
          code: "cooldown",
          message: `Probe cooldown active (${String(Math.ceil(remaining / 1000))}s remaining)`,
          retryAfterMs: remaining,
        };
      }
      // Manual override: drop straight into `checking`, preserving the
      // last result for UI continuity.
      if (remaining > 0 && trigger === "manual") {
        internal = {
          phase: "checking",
          startedAt: now(),
          lastResult: internal.result,
        };
      } else {
        // Cooldown has organically elapsed — promote and fall through.
        internal = { phase: "settled", result: internal.result };
      }
    }

    const previous = publicState();

    // Transition to checking.
    if (internal.phase === "settled") {
      internal = {
        phase: "checking",
        startedAt: now(),
        lastResult: internal.result,
      };
    } else if (internal.phase === "idle") {
      internal = { phase: "checking", startedAt: now(), lastResult: null };
    }
    // else: already checking — fall through to the inflight start

    publishIfChanged(previous);

    inflight = (async (): Promise<ProbeRequestResult> => {
      try {
        const result = await callCentral();
        if (result.ok) {
          const cooldownUntil = now() + PROBE_COOLDOWN_MS;
          const prevForPublish = publicState();
          internal = {
            phase: "cooldown",
            until: cooldownUntil,
            result: result.result,
          };
          persist(result.result);
          publishIfChanged(prevForPublish);
          return { ok: true, result: result.result };
        }
        // Failure: leave the prior settled/cooldown state intact for the
        // UI but exit the checking phase. Rolling back to lastResult means
        // the user keeps seeing whatever Central last told us, not a fresh
        // "unreachable" verdict that came from a Central outage.
        if (internal.phase === "checking") {
          if (internal.lastResult) {
            internal = { phase: "settled", result: internal.lastResult };
          } else {
            internal = { phase: "idle" };
          }
        }
        return result;
      } finally {
        inflight = null;
      }
    })();

    return inflight;
  }

  function shutdown(): void {
    if (bootTimerHandle !== null) {
      clearTimeoutFn(bootTimerHandle);
      bootTimerHandle = null;
    }
  }

  // ----- HTTP call ---------------------------------------------------------

  async function callCentral(): Promise<ProbeRequestResult> {
    const url =
      deps.centralUrl.replace(/\/+$/, "") +
      `/v1/servers/${deps.serverId}/voice/probe`;
    let res: Response;
    try {
      res = await fetchFn(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ server_secret: deps.serverSecret }),
        signal: AbortSignal.timeout(PROBE_HTTP_TIMEOUT_MS),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn("voice probe network error", { err: message });
      return {
        ok: false,
        code: "remote",
        message: `Central unreachable: ${message}`,
      };
    }

    if (!res.ok) {
      let body: string | undefined;
      try {
        body = await res.text();
      } catch {
        // ignore
      }
      log.warn("voice probe non-2xx", {
        status: res.status,
        body: body?.slice(0, 200),
      });
      // Central enforces its own DB-backed 60s cooldown per server. When that
      // fires we get a 429 with `Retry-After: <seconds>`. Surface it as a
      // distinct cooldown result so the operator UI can show a countdown
      // instead of a generic "Central returned 429".
      if (res.status === 429) {
        const retryHeader = res.headers.get("retry-after");
        const seconds = retryHeader ? Number(retryHeader) : Number.NaN;
        const retryAfterMs = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
        return {
          ok: false,
          code: "cooldown",
          message:
            retryAfterMs !== undefined
              ? `Central probe cooldown active (${String(Math.ceil(retryAfterMs / 1000))}s remaining)`
              : "Central probe cooldown active",
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        };
      }
      return {
        ok: false,
        code: "remote",
        message: `Central returned ${String(res.status)}`,
      };
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return {
        ok: false,
        code: "remote",
        message: "Central response was not valid JSON",
      };
    }

    if (!isVoiceProbeResult(body)) {
      return {
        ok: false,
        code: "remote",
        message: "Central response did not match VoiceProbeResult shape",
      };
    }

    // Normalize: validator allows missing version (older Central deploys
    // that haven't picked up the field yet) and treats it as v1. Stamping
    // version: 1 here means downstream consumers always see a fully
    // populated envelope, so they can rely on the literal type.
    return { ok: true, result: { ...body, version: 1 } };
  }

  return {
    init,
    getState,
    requestProbe,
    noteVoiceReady,
    noteWanIp,
    noteParticipantJoined,
    noteParticipantLeft,
    shutdown,
  };
}

// ---------------------------------------------------------------------------
// Response validation
// ---------------------------------------------------------------------------

function isPortGroupResult(v: unknown): v is PortGroupResult {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o["reachable"] === "boolean" &&
    (typeof o["latencyMs"] === "number" || o["latencyMs"] === null) &&
    (typeof o["error"] === "string" || o["error"] === null)
  );
}

export function isVoiceProbeResult(v: unknown): v is VoiceProbeResult {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  // Version gate: missing is treated as legacy v1 (rows persisted before
  // this field existed); explicit 1 is the current shape. Any other
  // numeric value is from a future Central — fail closed so the runtime
  // doesn't render v2+ data with v1 assumptions. The narrowed type still
  // claims `version: 1` because the response normalizer at the call site
  // fills missing values with 1.
  const ver = o["version"];
  if (ver !== undefined && ver !== 1) return false;
  return (
    (o["status"] === "ready" || o["status"] === "unreachable") &&
    typeof o["checkedAt"] === "string" &&
    typeof o["wanIp"] === "string" &&
    isPortGroupResult(o["rtcTcp"]) &&
    isPortGroupResult(o["rtcUdp"])
  );
}
