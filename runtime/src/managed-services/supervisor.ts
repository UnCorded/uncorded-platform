// Base supervisor for a managed service. Concrete supervisors (LiveKit,
// etc.) extend this and implement the protected `doStart`/`doStop` hooks.
// All ref-counting, state-machine transitions, and backoff/quarantine
// scheduling live here so subclasses don't reinvent failure handling.
//
// Reference counting model:
//   - Each plugin slug calling `claim()` becomes a claimer.
//   - Spawn happens when the claimer set transitions from 0 to 1.
//   - Stop happens when the claimer set transitions from 1 to 0.
//   - A given plugin claiming twice is idempotent (Set semantics).
//
// Failure handling mirrors the plugin subprocess model (subprocess.ts):
//   - BACKOFF_SCHEDULE on consecutive start failures.
//   - QUARANTINE_THRESHOLD failures inside QUARANTINE_WINDOW → "quarantined".
//   - Quarantined supervisors keep their claimers but refuse to auto-spawn
//     until shutdown() is called (manual un-quarantine path: full teardown
//     and re-claim). PR-3 will add admin tooling for this.
//
// Retry posture (intentional for 2b): a failed start does NOT schedule
// an internal timer. The supervisor records nextBackoff for telemetry
// and waits for the next external claim() call to retry. Concrete PR-3+
// supervisors that need transient-failure recovery without a re-claim
// (e.g. LiveKit dropping mid-call) must wire their own retry — either
// inside doStart, or by graduating this base class to own a setTimeout
// loop. Decision deferred so 2b tests don't need timer mocks.

import { rootLogger } from "@uncorded/shared";
import type {
  ClaimContext,
  ClaimResult,
  ManagedServiceSupervisor,
  ServiceHealth,
  ServiceSlug,
  ServiceState,
} from "./types";

const log = rootLogger.child({ component: "managed-service" });

// Match SubprocessManager so the operator mental model is consistent.
export const BACKOFF_SCHEDULE = [1000, 2000, 5000, 15000, 60000] as const;
const QUARANTINE_WINDOW_MS = 10 * 60 * 1000;
const QUARANTINE_THRESHOLD = 5;

interface FailureTracker {
  failures: number[];
  backoffIndex: number;
}

function makeTracker(): FailureTracker {
  return { failures: [], backoffIndex: 0 };
}

function recordFailure(t: FailureTracker): void {
  const now = Date.now();
  t.failures.push(now);
  // Prune in place so the array can't grow unbounded under sustained
  // flap (intermittent failures over hours). Window is short relative
  // to QUARANTINE_THRESHOLD, so the post-prune length is bounded by
  // failure rate × QUARANTINE_WINDOW_MS in practice.
  const cutoff = now - QUARANTINE_WINDOW_MS;
  t.failures = t.failures.filter((ts) => ts >= cutoff);
}

function shouldQuarantine(t: FailureTracker): boolean {
  // recordFailure already pruned to the window, so length is the count.
  return t.failures.length >= QUARANTINE_THRESHOLD;
}

function nextBackoff(t: FailureTracker): number {
  const idx = Math.min(t.backoffIndex, BACKOFF_SCHEDULE.length - 1);
  if (t.backoffIndex < BACKOFF_SCHEDULE.length - 1) t.backoffIndex++;
  return BACKOFF_SCHEDULE[idx]!;
}

export abstract class BaseManagedServiceSupervisor
  implements ManagedServiceSupervisor
{
  readonly slug: ServiceSlug;
  private claimers = new Set<string>();
  private currentState: ServiceState = "stopped";
  private failures = makeTracker();
  // Wall-clock at the most recent successful start, or null if not running.
  // Reset to null on stop. health() reports uptimeMs derived from this.
  private startedAt: number | null = null;
  // Snapshot of the most recent failure for telemetry. Cleared on a
  // subsequent successful start so health() reflects current truth.
  protected lastError: { code: string; message: string; ts: number } | null = null;
  // Serialized op queue: every state transition awaits the previous one
  // so we can't overlap a stop with a re-spawn caused by a fast claim.
  private opChain: Promise<void> = Promise.resolve();

  constructor(slug: ServiceSlug) {
    this.slug = slug;
  }

  state(): ServiceState {
    return this.currentState;
  }

  claimerCount(): number {
    return this.claimers.size;
  }

  async claim(ctx: ClaimContext): Promise<ClaimResult> {
    if (this.currentState === "quarantined") {
      // Record the claimer even though we're refusing to spawn. Rationale:
      // shutdown() is the documented un-quarantine path — when an operator
      // shuts down, claims clear; the next claim from any plugin starts
      // clean. Keeping claimers here means after a hypothetical future
      // un-quarantine-without-shutdown path (not in 2b), prior claimers
      // don't have to re-claim manually.
      this.claimers.add(ctx.pluginSlug);
      return {
        ok: false,
        error: {
          code: "SERVICE_QUARANTINED",
          message: `Service "${this.slug}" is quarantined; will not auto-start.`,
        },
      };
    }

    this.claimers.add(ctx.pluginSlug);
    if (this.currentState === "running" || this.currentState === "starting") {
      // Already running or another claim is spawning us — just attach.
      return { ok: true, state: this.currentState };
    }
    // Otherwise (stopped or stopping), queue a spawn. A previous failed
    // spawn may have left claimers > 0 with state="stopped"; the next claim
    // (from any plugin) retries.

    return this.runOp(async () => {
      // Re-check inside the serialized op — claimers may have churned.
      if (this.claimers.size === 0) return { ok: true as const, state: this.currentState };
      if (this.currentState === "running") return { ok: true as const, state: this.currentState };

      this.currentState = "starting";
      log.info("managed service starting", { slug: this.slug, claimer: ctx.pluginSlug });
      try {
        await this.doStart();
        this.currentState = "running";
        this.startedAt = Date.now();
        this.lastError = null;
        this.failures = makeTracker();
        return { ok: true as const, state: this.currentState };
      } catch (err) {
        recordFailure(this.failures);
        const msg = err instanceof Error ? err.message : String(err);
        if (shouldQuarantine(this.failures)) {
          this.currentState = "quarantined";
          this.startedAt = null;
          this.lastError = { code: "SERVICE_QUARANTINED", message: msg, ts: Date.now() };
          log.error("managed service quarantined after repeated start failures", {
            slug: this.slug,
            failures: this.failures.failures.length,
          });
          return {
            ok: false as const,
            error: { code: "SERVICE_QUARANTINED", message: msg },
          };
        }
        this.currentState = "stopped";
        this.startedAt = null;
        this.lastError = { code: "SERVICE_START_FAILED", message: msg, ts: Date.now() };
        const delay = nextBackoff(this.failures);
        log.warn("managed service start failed, will retry on next claim", {
          slug: this.slug,
          err: msg,
          backoffMs: delay,
        });
        return {
          ok: false as const,
          error: { code: "SERVICE_START_FAILED", message: msg },
        };
      }
    });
  }

  async release(ctx: ClaimContext): Promise<ClaimResult> {
    if (!this.claimers.has(ctx.pluginSlug)) {
      // Idempotent: releasing without a prior claim is a no-op success.
      return { ok: true, state: this.currentState };
    }
    this.claimers.delete(ctx.pluginSlug);
    if (this.claimers.size > 0) {
      // Other plugins still hold claims — keep running.
      return { ok: true, state: this.currentState };
    }

    return this.runOp(async () => {
      // Another claim may have arrived inside the queued op. If so, abort
      // the stop and report current state.
      if (this.claimers.size > 0) return { ok: true as const, state: this.currentState };
      if (this.currentState === "stopped" || this.currentState === "quarantined") {
        return { ok: true as const, state: this.currentState };
      }
      this.currentState = "stopping";
      log.info("managed service stopping (last claim released)", {
        slug: this.slug,
        releaser: ctx.pluginSlug,
      });
      try {
        await this.doStop();
      } catch (err) {
        log.warn("managed service stop hook threw", {
          slug: this.slug,
          err: err instanceof Error ? err.message : String(err),
        });
      }
      this.currentState = "stopped";
      this.startedAt = null;
      return { ok: true as const, state: this.currentState };
    });
  }

  async shutdown(): Promise<void> {
    this.claimers.clear();
    // Reset the failure tracker on shutdown. shutdown() is the
    // user-visible un-quarantine path; if an operator tears down and
    // re-claims, the next start should be evaluated on its own merits,
    // not against historical failures from a possibly-different config.
    this.failures = makeTracker();
    this.lastError = null;
    if (this.currentState === "stopped" || this.currentState === "quarantined") {
      this.currentState = "stopped";
      this.startedAt = null;
      return;
    }
    await this.runOp(async () => {
      this.currentState = "stopping";
      try {
        await this.doStop();
      } catch (err) {
        log.warn("managed service shutdown hook threw", {
          slug: this.slug,
          err: err instanceof Error ? err.message : String(err),
        });
      }
      this.currentState = "stopped";
      this.startedAt = null;
      return { ok: true as const, state: this.currentState };
    });
  }

  /**
   * Default health snapshot. Subclasses with richer telemetry (e.g. a
   * media-server version, room counts) override this and return a
   * structurally-extended type — TypeScript permits the override via
   * return-type covariance.
   */
  async health(): Promise<ServiceHealth> {
    return {
      state: this.currentState,
      uptimeMs: this.startedAt === null ? null : Date.now() - this.startedAt,
      lastError: this.lastError,
    };
  }

  /** Subclass hook: spawn the underlying process / open the connection. */
  protected abstract doStart(): Promise<void>;

  /** Subclass hook: gracefully stop the underlying process. */
  protected abstract doStop(): Promise<void>;

  /**
   * Stop and immediately re-start the service under the serialized op queue.
   * No-op if the service isn't currently running. Use this from subclasses
   * that need to bounce the process (credential rotation, config reload,
   * admin /restart endpoint) — calling doStop+doStart directly bypasses
   * opChain and can race with a concurrent claim/release.
   *
   * On stop failure: logged, restart still attempts the start phase.
   * On start failure: state lands on "stopped" with lastError populated;
   * the next external claim() retries (no implicit re-quarantine — admin-
   * initiated restarts shouldn't burn the backoff budget). Caller sees the
   * thrown error so admin endpoints can surface it.
   */
  protected async restart(): Promise<void> {
    if (this.currentState !== "running") return;
    await this.runOp(async () => {
      // Re-check inside the serialized op — claim/release may have run between
      // the gate above and us reaching the head of the queue.
      if (this.currentState !== "running") return;

      this.currentState = "stopping";
      log.info("managed service restarting (stop phase)", { slug: this.slug });
      try {
        await this.doStop();
      } catch (err) {
        log.warn("restart stop hook threw; proceeding to start phase", {
          slug: this.slug,
          err: err instanceof Error ? err.message : String(err),
        });
      }

      this.currentState = "starting";
      log.info("managed service restarting (start phase)", { slug: this.slug });
      try {
        await this.doStart();
        this.currentState = "running";
        this.startedAt = Date.now();
        this.lastError = null;
      } catch (err) {
        this.currentState = "stopped";
        this.startedAt = null;
        const msg = err instanceof Error ? err.message : String(err);
        this.lastError = { code: "SERVICE_RESTART_FAILED", message: msg, ts: Date.now() };
        throw err;
      }
    });
  }

  // Serialize all state-changing ops so concurrent claim/release calls
  // can't interleave start and stop.
  private runOp<T>(op: () => Promise<T>): Promise<T> {
    let resolveOp: (v: T) => void;
    let rejectOp: (e: unknown) => void;
    const result = new Promise<T>((res, rej) => {
      resolveOp = res;
      rejectOp = rej;
    });
    this.opChain = this.opChain.then(async () => {
      try {
        const v = await op();
        resolveOp(v);
      } catch (e) {
        rejectOp(e);
      }
    });
    return result;
  }
}
