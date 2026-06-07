// Managed-service framework — types only.
//
// A "managed service" is a sidecar process the runtime spawns and supervises
// on behalf of one or more plugins (e.g. LiveKit for voice). Unlike plugin
// subprocesses, services are shared across plugins via reference-counted
// claim/release: spawn when the first plugin claims, stop when the last
// plugin releases. Failure handling mirrors the plugin subprocess model
// (backoff, quarantine) so a misbehaving sidecar can't take down the
// runtime.
//
// Concrete supervisors (LiveKitSupervisor, etc.) self-register via the
// static registry in registry.ts at module init time.

/** Slug identifying a managed service in the static registry. */
export type ServiceSlug = string;

/**
 * Lifecycle state of a single managed-service supervisor.
 *
 * - "stopped": no claimers (or all claims released), no process running.
 * - "starting": at least one claim, supervisor is spawning the process.
 * - "running": supervisor reports the process is healthy and reachable.
 * - "stopping": supervisor is gracefully tearing down (last release, or
 *   internal restart triggered).
 * - "quarantined": too many start failures inside the quarantine window;
 *   the supervisor will not auto-restart until manually un-quarantined.
 */
export type ServiceState =
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "quarantined";

/**
 * Context passed to the underlying supervisor when claim/release fires.
 * Used for ref-count bookkeeping (which plugins hold a claim) and for
 * structured logging. Capability/permission checks happen upstream at
 * the IPC boundary — by the time a request reaches the supervisor the
 * caller is already authorized. Do not add capability enforcement here:
 * the supervisor sees an already-trusted slug and adding a check would
 * give a false sense of defense-in-depth.
 */
export interface ClaimContext {
  /** Plugin slug that initiated the claim or release. */
  pluginSlug: string;
}

/**
 * Result of a `claim()` or `release()` call. Distinct OK / ERR shape
 * mirrors the rest of the runtime so callers can pattern-match instead of
 * try/catching.
 */
export type ClaimResult =
  | { ok: true; state: ServiceState }
  | { ok: false; error: { code: string; message: string } };

/**
 * Generic health snapshot returned by `health()`. Concrete supervisors
 * may return a richer shape (LiveKit returns `VoiceHealth` adding
 * `livekitVersion`/`activeRooms`/`activeParticipants` etc.) — TypeScript
 * permits the override via return-type covariance because the richer
 * shape extends this one structurally.
 */
export interface ServiceHealth {
  /** Lifecycle state at the moment the snapshot was taken. */
  state: ServiceState;
  /** Wall-clock ms since the last successful start, or null if not running. */
  uptimeMs: number | null;
  /** Most recent failure observed, or null if last start succeeded. */
  lastError: { code: string; message: string; ts: number } | null;
}

/**
 * Public API a concrete supervisor must expose. The base class in
 * supervisor.ts implements claim/release/state plumbing; subclasses only
 * need to implement the abstract `doStart` / `doStop` hooks.
 */
export interface ManagedServiceSupervisor {
  readonly slug: ServiceSlug;
  /** Add a claimer; spawns the process if going 0 → 1. */
  claim(ctx: ClaimContext): Promise<ClaimResult>;
  /** Remove a claimer; stops the process if going 1 → 0. */
  release(ctx: ClaimContext): Promise<ClaimResult>;
  /** Read the current lifecycle state. */
  state(): ServiceState;
  /** Read the current claimer count. Test-only callers must not depend
   *  on this for runtime correctness — the supervisor owns its state. */
  claimerCount(): number;
  /** Force-stop and clear claims. Used during graceful shutdown. */
  shutdown(): Promise<void>;
  /** Health snapshot. Subclasses may override with a richer return type
   *  (e.g. `VoiceHealth`) — assignable via return-type covariance. */
  health(): Promise<ServiceHealth>;
}

/**
 * Factory signature: produces a supervisor for the given service slug.
 * Concrete implementations may capture configuration in the closure.
 */
export type SupervisorFactory = (slug: ServiceSlug) => ManagedServiceSupervisor;
