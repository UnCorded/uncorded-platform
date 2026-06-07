// Concrete supervisor for the bundled LiveKit SFU.
//
// Lifecycle:
//   doStart  → ensure credentials persisted (encrypted) → render livekit.yaml
//              (only if changed) → Bun.spawn livekit-server --config <path>
//              → poll the signaling port until LiveKit responds → "running"
//   doStop   → SIGTERM → wait up to STOP_GRACE_MS → SIGKILL fallback
//   health   → maps the generic ServiceState to spec-24's VoiceHealth.status,
//              stubs activeRooms/activeParticipants until PR-4 wires the
//              media-bridge counts via LiveKit webhooks.
//   rotateSecret → fresh credentials + persist + restart-if-running.
//                  Existing JWTs minted under the old secret are invalidated
//                  by LiveKit when it reloads with the new key.
//
// Readiness check uses an HTTP probe on the signaling port (not log-line
// scraping) so we couple to LiveKit's documented HTTP contract instead
// of its log format.
//
// Stderr is piped to the runtime logger with a per-second rate limit so
// a chatty or runaway sidecar can't fill the log volume.

import type { Subprocess } from "bun";
import type { Database } from "bun:sqlite";
import { rootLogger } from "@uncorded/shared";
import { BaseManagedServiceSupervisor } from "../managed-services/supervisor";
import type {
  ServiceHealth,
  ServiceSlug,
  ServiceState,
} from "../managed-services/types";
import {
  getOrCreateLiveKitCredentials,
  rotateLiveKitCredentials,
} from "./secrets";
import {
  ensureConfigWritten,
  DEFAULT_PORT_PLAN,
  type VoicePortPlan,
} from "./config";

const log = rootLogger.child({ component: "voice-supervisor" });

const STOP_GRACE_MS = 5000;
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const READINESS_POLL_INTERVAL_MS = 200;
const STDERR_RATE_LIMIT_PER_SEC = 50;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VoiceHealth extends ServiceHealth {
  /** Spec-24 status label, derived from the underlying ServiceState. */
  status: "ready" | "starting" | "degraded" | "unhealthy" | "disabled";
  livekitVersion: string | null;
  /** Active LiveKit rooms. PR-3a stubs as 0; PR-4 wires the bridge counts. */
  activeRooms: number;
  /** Active participants across all rooms. PR-3a stubs as 0. */
  activeParticipants: number;
}

/** Minimal subprocess surface — keeps Bun.spawn injectable for tests. */
export interface SpawnedProcess {
  pid: number;
  exited: Promise<unknown>;
  stderr?: ReadableStream<Uint8Array> | null;
  kill(signal?: string | number): void;
}

export type Spawner = (cmd: string[]) => SpawnedProcess;
export type ReadinessProbe = (url: string) => Promise<boolean>;

export interface LiveKitSupervisorDeps {
  db: Database;
  livekitBinPath: string;
  configPath: string;
  ports?: VoicePortPlan;
  livekitVersion?: string;
  /** Host's primary RFC1918 LAN IPv4 (forwarded from the desktop wrapper
   *  via HOST_LAN_IP). Rendered as `node_ip` so LiveKit advertises it as
   *  an ICE host candidate for on-LAN peers. Absent → STUN-only. */
  internalIp?: string;
  // Test injection points — defaults use Bun.spawn / fetch.
  spawner?: Spawner;
  readinessProbe?: ReadinessProbe;
  startupTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Supervisor
// ---------------------------------------------------------------------------

export class LiveKitSupervisor extends BaseManagedServiceSupervisor {
  private readonly db: Database;
  private readonly livekitBinPath: string;
  private readonly configPath: string;
  private readonly ports: VoicePortPlan;
  private readonly livekitVersion: string | null;
  private readonly internalIp: string | null;
  private readonly spawner: Spawner;
  private readonly readinessProbe: ReadinessProbe;
  private readonly startupTimeoutMs: number;
  private process: SpawnedProcess | null = null;

  constructor(slug: ServiceSlug, deps: LiveKitSupervisorDeps) {
    super(slug);
    this.db = deps.db;
    this.livekitBinPath = deps.livekitBinPath;
    this.configPath = deps.configPath;
    this.ports = deps.ports ?? DEFAULT_PORT_PLAN;
    this.livekitVersion = deps.livekitVersion ?? null;
    this.internalIp = deps.internalIp ?? null;
    this.spawner = deps.spawner ?? defaultSpawner;
    this.readinessProbe = deps.readinessProbe ?? defaultReadinessProbe;
    this.startupTimeoutMs = deps.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  }

  protected async doStart(): Promise<void> {
    const creds = await getOrCreateLiveKitCredentials(this.db);
    const wrote = ensureConfigWritten(
      {
        apiKey: creds.apiKey,
        apiSecret: creds.apiSecret,
        ports: this.ports,
        ...(this.internalIp !== null ? { internalIp: this.internalIp } : {}),
      },
      this.configPath,
    );
    if (wrote) {
      log.info("livekit config written", { path: this.configPath });
    }

    const cmd = [this.livekitBinPath, "--config", this.configPath];
    this.process = this.spawner(cmd);
    log.info("livekit-server spawned", { pid: this.process.pid });

    if (this.process.stderr) {
      void pipeStderr(this.process.stderr, this.slug);
    }

    // Poll readiness on the signaling port. Don't tie to log-line
    // matching — LiveKit's log format isn't a stable contract.
    const probeUrl = `http://127.0.0.1:${this.ports.signaling}/`;
    const deadline = Date.now() + this.startupTimeoutMs;
    while (Date.now() < deadline) {
      let ready = false;
      try {
        ready = await this.readinessProbe(probeUrl);
      } catch {
        // probe error is just "not ready yet"
      }
      if (ready) return;
      await sleep(READINESS_POLL_INTERVAL_MS);
    }

    // Timed out — kill the half-started process so we don't leak it.
    const stuck = this.process;
    this.process = null;
    try {
      stuck.kill("SIGKILL");
    } catch {
      // already exited
    }
    throw new Error(
      `livekit-server failed to become ready within ${this.startupTimeoutMs}ms`,
    );
  }

  protected async doStop(): Promise<void> {
    const proc = this.process;
    if (!proc) return;
    this.process = null;
    try {
      proc.kill("SIGTERM");
    } catch {
      return; // already gone
    }
    const exited = Promise.resolve(proc.exited).then(() => true).catch(() => true);
    const timeout = new Promise<boolean>((res) => setTimeout(() => res(false), STOP_GRACE_MS));
    const exitedInTime = await Promise.race([exited, timeout]);
    if (!exitedInTime) {
      log.warn("livekit-server did not exit within grace; sending SIGKILL", {
        graceMs: STOP_GRACE_MS,
      });
      try {
        proc.kill("SIGKILL");
      } catch {
        // already dead
      }
    }
  }

  override async health(): Promise<VoiceHealth> {
    const base = await super.health();
    return {
      ...base,
      status: this.mapStatus(base.state),
      livekitVersion: this.livekitVersion,
      activeRooms: 0,        // PR-4 wires the LiveKit webhook bridge
      activeParticipants: 0, // PR-4 wires the LiveKit webhook bridge
    };
  }

  /**
   * Generate fresh credentials, persist them encrypted, and restart
   * LiveKit if it's currently running so the new secret takes effect.
   * JWTs minted under the previous secret become invalid — live
   * participants will see auth failures and reconnect.
   *
   * Restart goes through the base class's serialized op queue (via
   * restart()) so a concurrent claim/release can't interleave with the
   * stop+start cycle and leave the supervisor in an indeterminate state.
   */
  async rotateSecret(): Promise<void> {
    await rotateLiveKitCredentials(this.db);
    log.info("livekit secret rotated", { slug: this.slug });
    await this.restart();
  }

  /**
   * Public wrapper around the base class's protected `restart()` so the
   * /admin/api/voice/restart route can drive a forced bounce without
   * subclassing the supervisor or duplicating opChain plumbing in the
   * route handler. Same semantics as `restart()`: no-op if the service
   * isn't running; on start failure, state lands on "stopped" with
   * lastError populated and the error is rethrown for the caller.
   */
  async adminRestart(): Promise<void> {
    await this.restart();
  }

  /** Read-only view of the configured port plan. Exposed so the admin
   *  state endpoint can report the bindings without taking a private
   *  reference to the supervisor's internals. */
  getPorts(): VoicePortPlan {
    return this.ports;
  }

  private mapStatus(state: ServiceState): VoiceHealth["status"] {
    switch (state) {
      case "running":
        return "ready";
      case "starting":
        return "starting";
      case "stopping":
        return "ready"; // still serving traffic until stopped
      case "stopped":
        // With claimers → previous start failed, retry pending.
        // Without claimers → no consumer asked for it, voice not activated.
        return this.claimerCount() === 0 ? "disabled" : "unhealthy";
      case "quarantined":
        return "unhealthy";
    }
  }
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

function defaultSpawner(cmd: string[]): SpawnedProcess {
  const sub: Subprocess = Bun.spawn(cmd, {
    stdin: "ignore",
    stdout: "ignore", // LiveKit logs to stderr
    stderr: "pipe",
  });
  return {
    pid: sub.pid,
    exited: sub.exited,
    stderr: sub.stderr instanceof ReadableStream ? sub.stderr : null,
    kill: (signal) => sub.kill(signal as never),
  };
}

async function defaultReadinessProbe(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
    // Any HTTP response (including 404) means the process is listening.
    return res.status > 0;
  } catch {
    return false;
  }
}

// LiveKit's tab-separated logger writes the level as the second column,
// e.g. "2026-05-08T...\tWARN\tlivekit\t...". Parse it so warnings and errors
// don't get re-emitted as info — operator-relevant lines (like the
// "UDP receive buffer is too small for production" warning) need to surface
// at the matching level for log aggregators / alerting to catch them.
const LIVEKIT_LEVEL_RE = /\t(DEBUG|INFO|WARN|ERROR|FATAL|DPANIC|PANIC)\t/;
function logLivekitLine(slug: string, line: string): void {
  const level = LIVEKIT_LEVEL_RE.exec(line)?.[1] ?? "INFO";
  switch (level) {
    case "WARN":
      log.warn("livekit stderr", { slug, line });
      return;
    case "ERROR":
    case "FATAL":
    case "DPANIC":
    case "PANIC":
      log.error("livekit stderr", { slug, line });
      return;
    case "DEBUG":
      log.debug("livekit stderr", { slug, line });
      return;
    default:
      log.info("livekit stderr", { slug, line });
  }
}

async function pipeStderr(
  stream: ReadableStream<Uint8Array>,
  slug: string,
): Promise<void> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buf = "";
  let windowStart = Date.now();
  let inWindow = 0;
  let droppedThisWindow = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trimEnd();
        buf = buf.slice(nl + 1);
        const now = Date.now();
        if (now - windowStart > 1000) {
          if (droppedThisWindow > 0) {
            log.warn("livekit stderr rate-limited", { slug, dropped: droppedThisWindow });
          }
          windowStart = now;
          inWindow = 0;
          droppedThisWindow = 0;
        }
        if (inWindow < STDERR_RATE_LIMIT_PER_SEC) {
          if (line.length > 0) logLivekitLine(slug, line);
          inWindow++;
        } else {
          droppedThisWindow++;
        }
      }
    }
  } catch {
    // Stream closed; nothing actionable.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
