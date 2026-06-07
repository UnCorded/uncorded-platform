// Heartbeat client types — Central connection, delta dispatch, public key caching.

import type { RuntimeUpdateChannel, RuntimeUpdateState } from "../update-state/types";

// ---------------------------------------------------------------------------
// Delta types (discriminated union on `type`)
// ---------------------------------------------------------------------------

export interface UserProfileChangedDelta {
  type: "user.profile_changed";
  user_id: string;
  username: string;
  display_name: string;
  avatar_url: string;
}

export interface UserBannedDelta {
  type: "user.banned";
  user_id: string;
  reason: string;
}

export interface UserUnbannedDelta {
  type: "user.unbanned";
  user_id: string;
}

export interface TokenRevokedDelta {
  type: "token.revoked";
  jti: string;
}

export interface PluginRevokedDelta {
  type: "plugin.revoked";
  plugin_slug: string;
  version: string;
}

export interface OwnershipTransferredDelta {
  type: "ownership.transferred";
  new_owner: string;
}

export type HeartbeatDelta =
  | UserProfileChangedDelta
  | UserBannedDelta
  | UserUnbannedDelta
  | TokenRevokedDelta
  | PluginRevokedDelta
  | OwnershipTransferredDelta;

// ---------------------------------------------------------------------------
// Delta handlers — one callback per delta type, all optional
// ---------------------------------------------------------------------------

export type DeltaHandlers = {
  [K in HeartbeatDelta["type"]]?: (
    delta: Extract<HeartbeatDelta, { type: K }>,
  ) => void;
};

// ---------------------------------------------------------------------------
// Heartbeat request / response (wire shapes)
// ---------------------------------------------------------------------------

export interface HeartbeatRequest {
  server_id: string;
  server_secret: string;
  last_sync_version: number;
  tunnel_url: string;
  runtime_version: string;
  connected_users: number;
  plugin_count: number;
  tunnel_state?: string | undefined;
  /** Runtime update channel (Phase 01 §11.5). Echoes update-state.json so
   *  Central can correlate which release stream a server is tracking. */
  channel?: RuntimeUpdateChannel | undefined;
  /** Snapshot of the runtime update state (Phase 01 §11.5 — informational,
   *  not action-driving). Lets Central distinguish "server is down" from
   *  "server is mid-update" in directory health, and surface upgrade
   *  pressure in future ops dashboards. */
  update_state?: RuntimeUpdateState | undefined;
}

export interface PublicKeyEntry {
  id: string;
  public_key: JsonWebKey;
}

export type HeartbeatResponse =
  | { dirty: false; wan_ip?: string | undefined }
  | {
      dirty: true;
      sync_version: number;
      public_keys: readonly PublicKeyEntry[];
      deltas: readonly HeartbeatDelta[];
      full_snapshot?: boolean | undefined;
      /** Central echoes the request's cf-connecting-ip / x-forwarded-for tail
       *  so the runtime can detect WAN-IP changes (laptop-to-new-network, ISP
       *  lease, VPS migration) and re-probe voice reachability without a
       *  container restart. Omitted if Central couldn't determine the client
       *  IP (e.g. dev request without CF/XFF). spec-24 Amendment A2. */
      wan_ip?: string | undefined;
    };

// ---------------------------------------------------------------------------
// Poll result
// ---------------------------------------------------------------------------

export type PollResult =
  | { ok: true; dirty: boolean; deltasApplied: number }
  | { ok: false; error: { code: string; message: string } };

// ---------------------------------------------------------------------------
// Heartbeat client options (constructor injection)
// ---------------------------------------------------------------------------

export interface HeartbeatClientOptions {
  centralUrl: string;
  serverId: string;
  serverSecret: string;
  runtimeVersion: string;

  /** Called at poll time to get the current tunnel URL */
  getTunnelUrl: () => string;
  /** Called at poll time to get live connected user count */
  getConnectedUsers: () => number;
  /** Called at poll time to get live plugin count */
  getPluginCount: () => number;

  deltaHandlers: DeltaHandlers;

  // -- Injectable dependencies ------------------------------------------------

  /** Injectable fetch. Default: globalThis.fetch */
  fetch?: typeof globalThis.fetch | undefined;
  /** Injectable setInterval. Default: globalThis.setInterval */
  setInterval?: ((cb: () => void, ms: number) => unknown) | undefined;
  /** Injectable clearInterval. Default: globalThis.clearInterval */
  clearInterval?: ((id: unknown) => void) | undefined;

  // -- Optional config with defaults ------------------------------------------

  /** Polling interval in ms. Default: 30_000 */
  intervalMs?: number | undefined;
  /** Initial public keys from server.json cache */
  cachedPublicKeys?: readonly PublicKeyEntry[] | undefined;
  /** Initial sync version from server.json */
  cachedSyncVersion?: number | undefined;
  /** Warning callback (Central unreachable, unknown delta type, handler error) */
  onWarn?: ((message: string) => void) | undefined;
  /** Optional tunnel state getter — returns "shutdown" during graceful shutdown.
   *  When set and non-undefined, the value is included in the heartbeat request. */
  getTunnelState?: (() => string | undefined) | undefined;
  /** Live read of the runtime update-state at poll time (Phase 01 §11.5).
   *  Optional — when undefined, `channel` and `update_state` are omitted from
   *  the heartbeat request. */
  getUpdateState?: (() => RuntimeUpdateState) | undefined;
  /** Called after a dirty heartbeat updates keys and sync version.
   *  Use to persist delta state (e.g., write back to server.json). */
  onDirtySync?: ((syncVersion: number, publicKeys: readonly PublicKeyEntry[]) => void | Promise<void>) | undefined;
  /** Called when Central signals full_snapshot: true (deltas expired).
   *  Wire to force-disconnect all users so they re-authenticate. */
  onFullSnapshot?: (() => void) | undefined;
  /** Called when Central returns 404 on the heartbeat endpoint for N consecutive
   *  polls (see serverDeletedThreshold). Fires once, then never again for the
   *  lifetime of this client. Wire to gracefully shut the runtime down. */
  onServerDeleted?: (() => void) | undefined;
  /** Consecutive 404 heartbeats required before onServerDeleted fires.
   *  Default: 3 (protects against transient Central DB blips). */
  serverDeletedThreshold?: number | undefined;
  /** Expected key rotation cadence in ms — Central rotates every 24h by
   *  default. The cache is treated as stale once age exceeds 2× this window.
   *  Default: 24h. */
  keyRotationWindowMs?: number | undefined;
  /** Fires once each time the cached-key age crosses the stale threshold
   *  (2× keyRotationWindowMs). Wire to log.error and mark the container
   *  unhealthy so the orchestrator stops routing auth'd traffic — a stale
   *  cache means Central may have revoked a key we still accept. */
  onKeysStale?: ((ageMs: number) => void) | undefined;
  /** Fires when the heartbeat response's `wan_ip` changes since the last
   *  observation (or is observed for the first time). Wired by spec-24
   *  Amendment A: the voice reachability state machine subscribes here to
   *  trigger a re-probe whenever the runtime's external IP shifts. Never
   *  fires when Central omits `wan_ip` from the response — a missing value
   *  is treated as "not learned yet", not as "WAN went away". */
  onWanIp?: ((wanIp: string) => void) | undefined;
  /** Injectable wall clock for deterministic staleness tests.
   *  Default: Date.now */
  now?: (() => number) | undefined;
  /** Optional structured logger — when set, every successful poll emits a
   *  `debug` line (`"heartbeat ok"` with `wanIp`, `dirty`, `deltasApplied`,
   *  `connectedUsers`). Gated by `LOG_LEVEL=debug` so prod runs stay quiet
   *  by default; set `LOG_LEVEL=debug` for operator triage. */
  logger?: import("@uncorded/shared").Logger | undefined;
}

// ---------------------------------------------------------------------------
// CentralConnection — the handle returned by createHeartbeatClient
// ---------------------------------------------------------------------------

export interface CentralConnection {
  /** Execute a single poll cycle. */
  poll(): Promise<PollResult>;

  /** Start the polling loop. Calls poll() immediately, then every intervalMs. */
  start(): void;

  /** Stop the polling loop. Does NOT clear cached keys. */
  stop(): void;

  /** Force an immediate poll. Single-flight + min-interval throttled.
   *  Resolves once the in-flight poll settles (success or fail).
   *  Does NOT throw — failure to refresh is silent so callers can fall through
   *  to their normal "key not found" rejection. */
  forceRefresh(): Promise<void>;

  /** Synchronous getter for cached Ed25519 public keys. */
  getPublicKeys(): readonly PublicKeyEntry[];

  /** Current sync version. */
  getSyncVersion(): number;

  /** Milliseconds since the key cache was last confirmed current against
   *  Central (dirty or clean response both count). Returns null if Central
   *  has never been reached successfully since the client started — the
   *  cache may still hold keys loaded from server.json but those have no
   *  freshness guarantee. */
  getKeysAgeMs(): number | null;

  /** True when the cache has exceeded 2× rotation window and should no
   *  longer be trusted for auth. */
  areKeysStale(): boolean;

  // Phase 2: persistent WebSocket connection
  // connect(): Promise<void>;
}
