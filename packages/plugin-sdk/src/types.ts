// SDK types — public API surface for plugin developers.

import type {
  IpcUser,
  IpcEventDeliverMessage,
  DataReadWhereClause,
  DataReadOrderBy,
  CoreUser,
  CoreCategory,
  PresenceEntry,
} from "@uncorded/protocol";

export type { PresenceEntry };

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------

/** Handler for incoming requests from the runtime. */
export type RequestHandler = (
  params: Record<string, unknown>,
  user: IpcUser,
) => unknown | Promise<unknown>;

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** Handler for incoming event deliveries. */
export type EventHandler = (event: IpcEventDeliverMessage) => void | Promise<void>;

/** Options for event subscription. */
export interface SubscribeOptions {
  overflow_policy?: "mark_unhealthy" | "drop_oldest" | "drop_newest";
  queue_size?: number;
}

/** Event publishing and subscribing API. */
export interface EventsApi {
  /** Publish an event to a topic. */
  publish(topic: string, payload: unknown, version?: number): void;
  /** Subscribe to events on a topic. Returns a promise that resolves when the subscription is acknowledged. */
  subscribe(topic: string, handler: EventHandler, options?: SubscribeOptions): Promise<void>;
  /** Unsubscribe from a topic. */
  unsubscribe(topic: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

/** Permission check and registration API. */
export interface PermissionsApi {
  /** Register a plugin-defined permission type with the runtime. */
  register(key: string, options: { description: string; default_level: number }): Promise<void>;
  /** Check if a user has a specific permission. */
  check(userId: string, permission: string, scope?: string): Promise<boolean>;
  /** Check if a user has a specific role by name. */
  hasRole(userId: string, roleName: string): Promise<boolean>;
  /** Check if a user meets a minimum role level. */
  hasMinLevel(userId: string, level: number): Promise<boolean>;
  /** Get a user's role information. */
  getRole(userId: string): Promise<{ name: string; level: number }>;
  /** Check if actorId outranks targetId and can perform moderation actions on them. */
  canActOn(actorId: string, targetId: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Core Module API (no capability declaration required)
// ---------------------------------------------------------------------------

export type { CoreUser, CoreCategory };


/** Access to Core Module user profile cache. No capability declaration required. */
export interface CoreApi {
  /** Get a single user's profile by ID. Returns null if not found. */
  getUser(userId: string): Promise<CoreUser | null>;
  /** Get multiple user profiles by ID. Missing IDs are silently omitted. */
  getUsers(userIds: string[]): Promise<CoreUser[]>;
  /** Get all currently connected users. */
  getOnlineUsers(): Promise<CoreUser[]>;
  /**
   * List all server-wide categories ordered by position. Categories are
   * created and managed by admins via the shell — plugins reference a
   * category by id (soft FK). Returns an empty array on a fresh server.
   */
  listCategories(): Promise<CoreCategory[]>;
}

// ---------------------------------------------------------------------------
// Cross-plugin data reads
// ---------------------------------------------------------------------------

/** Structured query builder for cross-plugin reads. Immutable — each method returns a new builder. */
export interface DataReadQuery<T = Record<string, unknown>> {
  where(column: string, op: DataReadWhereClause["op"], value: DataReadWhereClause["value"]): DataReadQuery<T>;
  select(columns: string[]): DataReadQuery<T>;
  orderBy(column: string, direction?: DataReadOrderBy["direction"]): DataReadQuery<T>;
  limit(n: number): DataReadQuery<T>;
  exec(): Promise<T[]>;
}

/** Cross-plugin data read API. */
export interface DataApi {
  /** Start a structured read query against another plugin's published schema. */
  read<T = Record<string, unknown>>(plugin: string, table: string): DataReadQuery<T>;
}

// ---------------------------------------------------------------------------
// Own-database access
// ---------------------------------------------------------------------------

/** Result from a write operation (INSERT, UPDATE, DELETE). */
export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

/** Own-database access — all calls are routed through IPC to the runtime. */
export interface DbApi {
  /** Execute a SELECT and return rows as objects with named columns. */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Execute an INSERT/UPDATE/DELETE and return affected-row metadata. */
  run(sql: string, params?: unknown[]): Promise<RunResult>;
  /** Execute a raw SQL statement (e.g. PRAGMA, CREATE TABLE). Returns nothing. */
  exec(sql: string): Promise<void>;
  /** Execute multiple statements atomically. Each statement gets its own RunResult. */
  batch(statements: Array<{ sql: string; params?: unknown[] }>): Promise<RunResult[]>;
}

// ---------------------------------------------------------------------------
// Key-value store
// ---------------------------------------------------------------------------

/**
 * Key-value store API. Backed by a _kv table in the plugin's own SQLite.
 * Requires data.kv:self in manifest permissions.
 * Values are always strings — serialize complex values with JSON.stringify().
 */
export interface KvApi {
  /** Get a value by key. Returns null if the key does not exist. */
  get(key: string): Promise<string | null>;
  /** Set a value. Creates or overwrites the key. */
  set(key: string, value: string): Promise<void>;
  /** Delete a key. No-op if the key does not exist. */
  delete(key: string): Promise<void>;
  /**
   * List all key-value pairs, optionally filtered by key prefix.
   * Results are ordered by key ascending.
   */
  list(prefix?: string): Promise<{ key: string; value: string }[]>;
  /** Get multiple values by key in one round-trip. Missing keys are omitted from the result. */
  getMany(keys: string[]): Promise<Record<string, string>>;
}

// ---------------------------------------------------------------------------
// Settings (admin-configurable, schema-driven)
// ---------------------------------------------------------------------------

/** Event passed to settings.onChange handlers. */
export interface SettingsChangeEvent {
  key: string;
  value: string | number | boolean;
}

/**
 * Read the plugin's own admin-configurable settings (declared in the
 * manifest's `settings` field) and react to changes pushed by admins via
 * `core.plugin.config_changed`. No capability declaration required — every
 * plugin always reads its own settings.
 */
export interface SettingsApi {
  /**
   * Get the current value for a manifest-declared setting key. Returns the
   * stored value if set, otherwise the manifest `default`. Throws
   * `UNKNOWN_SETTING` if the key isn't declared.
   */
  get(key: string): Promise<string | number | boolean>;
  /**
   * Read every declared setting in one round-trip. Stored values win over
   * defaults; unset keys fall back to the manifest default.
   */
  getAll(): Promise<Record<string, string | number | boolean>>;
  /**
   * Subscribe to admin-driven setting changes. The handler fires once per
   * `PATCH /admin/api/plugins/:slug/config` while the plugin is running.
   * Returns a disposer.
   */
  onChange(handler: (event: SettingsChangeEvent) => void): () => void;
}

// ---------------------------------------------------------------------------
// Broadcast to WebSocket clients
// ---------------------------------------------------------------------------

/**
 * Direct push to connected WebSocket clients. Requires broadcast.clients in
 * the plugin manifest permissions.
 *
 * Event names are automatically namespaced with the plugin slug by the runtime
 * (e.g. "status.update" → "text-channels.status.update" on the wire).
 * The frontend SDK (G9) will strip the prefix transparently.
 */
export interface BroadcastApi {
  /** Push to a single user's active connections. */
  toUser(userId: string, event: string, payload: unknown): Promise<void>;
  /** Push to multiple users in one IPC round-trip. Maximum 100 userIds. */
  toUsers(userIds: string[], event: string, payload: unknown): Promise<void>;
  /** Push to all currently connected users. */
  toAll(event: string, payload: unknown): Promise<void>;
}

// ---------------------------------------------------------------------------
// Presence
// ---------------------------------------------------------------------------

/**
 * The user object passed to presence handlers.
 * Same shape as the user argument in request handlers.
 */
export type PresenceUser = IpcUser;

/** Handler called when a user connects or disconnects. */
export type PresenceHandler = (user: PresenceUser) => void | Promise<void>;

/**
 * First-class presence hooks + scoped (ephemeral, per-WS-session) presence.
 *
 * onConnected / onDisconnected: server-wide hooks, no capability required.
 * join / leave / update / watch / list: scoped presence per spec-23.
 *   - Capability: requires `broadcast.clients` in the manifest (folded in).
 *   - Scopes are auto-prefixed with the calling plugin's slug; do not pass
 *     the prefix yourself.
 *   - join / leave / update infer the originating WS session from the active
 *     sdk.handle() request context. Calling them from a sdk.schedule tick or
 *     a cross-plugin event handler throws PRESENCE_NO_SESSION_CONTEXT.
 */
export interface PresenceApi {
  /** Register a handler called whenever a user connects to the server. */
  onConnected(handler: PresenceHandler): () => void;
  /** Register a handler called whenever a user disconnects from the server. */
  onDisconnected(handler: PresenceHandler): () => void;

  /**
   * Join the calling session to a scope. Auto-prefixed with the plugin slug.
   * Returns a leave function specific to this entry.
   * Call only after the plugin's own ACL check.
   */
  join(
    scope: string,
    userId: string,
    meta?: Record<string, unknown>,
  ): Promise<() => Promise<void>>;

  /** Leave a scope. Removes the entry for (scope, userId) owned by this session. No-op if no match. */
  leave(scope: string, userId: string): Promise<void>;

  /**
   * Replace meta on the calling session's entry in a scope. Silent no-op when
   * no entry exists — update never implicitly joins.
   */
  update(scope: string, userId: string, meta: Record<string, unknown>): Promise<void>;

  /**
   * Observe entries for a scope. The callback receives the latest full entry
   * list on each coalesced tick. Returns an unsubscribe function.
   *
   * coalesceMs defaults to 50; clamps to [0, 500]. 0 means per-event delivery.
   */
  watch(
    scope: string,
    callback: (entries: PresenceEntry[]) => void,
    options?: { coalesceMs?: number },
  ): Promise<() => void>;

  /** One-shot read of all entries currently in a scope. */
  list(scope: string): Promise<PresenceEntry[]>;
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

/** Handler called on each scheduled tick. */
export type ScheduledHandler = (tick: { name: string; firedAt: number }) => void | Promise<void>;

/** Options for sdk.schedule.every(). */
export interface ScheduleOptions {
  /**
   * Maximum time in milliseconds the handler is allowed to run per tick.
   * Defaults to 30 000ms (30s). If the handler exceeds this, the tick resolves
   * with a timeout error so subsequent ticks are not blocked.
   * The handler continues running in the background — this only unblocks the IPC slot.
   */
  timeout_ms?: number | undefined;
}

/**
 * Scheduling API. Requires runtime.schedule in the plugin manifest permissions.
 * Schedules are named; re-registering the same name replaces the previous schedule.
 * The runtime enforces a minimum interval of 1000ms.
 */
export interface ScheduleApi {
  /** Register a named recurring schedule. Called every intervalMs milliseconds. */
  every(name: string, intervalMs: number, handler: ScheduledHandler, options?: ScheduleOptions): Promise<void>;
  /** Cancel a named recurring schedule. No-op if the name was never registered. */
  cancel(name: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Outbound HTTP fetch
// ---------------------------------------------------------------------------

export interface FetchOptions {
  method?: string | undefined;
  headers?: Record<string, string> | undefined;
  /**
   * Request body as a string (JSON, form-encoded, plain text).
   * Binary request bodies are not supported — encode to base64 yourself
   * and set Content-Type appropriately if needed.
   */
  body?: string | undefined;
}

/**
 * Response from sdk.fetch(). The IPC round-trip is complete before this
 * resolves — .text() and .json() are synchronous because the body is already
 * fully buffered.
 */
export interface FetchResponse {
  status: number;
  headers: Record<string, string>;
  /** Decode and return the response body as a UTF-8 string. Sync — body is pre-buffered. */
  text(): string;
  /** Decode the body and JSON.parse it. Sync — body is pre-buffered. */
  json<T = unknown>(): T;
  /** Return the raw response bytes. Sync — body is pre-buffered. */
  bytes(): Uint8Array;
}

// ---------------------------------------------------------------------------
// Plugin handle (the main SDK object)
// ---------------------------------------------------------------------------

/** The SDK handle returned by createPlugin(). */
export interface PluginHandle {
  /** Register a handler for incoming requests. */
  handle(action: string, handler: RequestHandler): void;
  /** Send a request to the runtime (for cross-plugin calls or runtime services). */
  request<T = unknown>(action: string, params?: Record<string, unknown>): Promise<T>;
  /** Event publishing and subscribing. */
  events: EventsApi;
  /** Permission checks and registration. */
  permissions: PermissionsApi;
  /** Cross-plugin data reads. */
  data: DataApi;
  /** Own-database access — enforced by runtime capability check. */
  db: DbApi;
  /** Core Module API — user profiles and presence. No capability declaration required. */
  core: CoreApi;
  /**
   * Key-value store. Requires data.kv:self in the manifest.
   * Values are strings — serialize complex objects with JSON.stringify().
   * The runtime never logs values; declare sensitive keys as type: "secret"
   * in the manifest settings field.
   */
  kv: KvApi;
  /**
   * Admin-configurable settings declared in the plugin's `manifest.settings`.
   * No capability required — every plugin always reads its own settings and
   * receives `core.plugin.config_changed` deliveries unconditionally.
   */
  settings: SettingsApi;
  /**
   * Make an outbound HTTP request via the runtime proxy.
   * Requires `http.fetch:<hostname>` declared in the plugin manifest.
   * Redirects are never followed — a 3xx response is returned as-is.
   */
  fetch(url: string, opts?: FetchOptions): Promise<FetchResponse>;
  /**
   * Register recurring scheduled tasks.
   * Requires `runtime.schedule` declared in the plugin manifest permissions.
   */
  schedule: ScheduleApi;
  /**
   * Direct push to connected WebSocket clients.
   * Requires broadcast.clients in the plugin manifest permissions.
   */
  broadcast: BroadcastApi;
  /**
   * First-class user presence hooks — fires when users connect or disconnect.
   * No capability declaration required.
   */
  presence: PresenceApi;
  /**
   * Voice bridge — mint short-lived LiveKit join tokens, manage rooms, etc.
   * Requires the matching `voice.*:self` permission per method (createJoinToken
   * → `voice.tokens:self`). The runtime returns VOICE_BRIDGE_UNAVAILABLE when
   * the runtime was booted without voice support.
   */
  voice: VoiceApi;
  /**
   * Plugin file storage (spec-26). The plugin's own `<dataDir>/uploads/`
   * directory. Used to stat/sign/delete files previously POSTed to /upload
   * by clients. Requires `storage.file:self` in the manifest permissions.
   */
  files: import("./files").FilesApi;
  /**
   * Signal that the plugin's internal state is hydrated and ready to serve
   * user-facing requests. Distinct from the spawn-time `ready` handshake,
   * which only proves the process is alive. Call this once caches are
   * loaded, member lists fetched, etc.
   *
   * Effective only when the plugin manifest declares
   * `serve_ready_handshake: true`. Without that opt-in the runtime treats
   * the plugin as serve-ready immediately on spawn, and this call is a
   * harmless no-op (the runtime ignores extra `serve_ready` frames).
   */
  serveReady(): void;
}

// ---------------------------------------------------------------------------
// Voice (sdk.voice.*)
// ---------------------------------------------------------------------------

/** Per-track grants embedded in the LiveKit join token. */
export interface VoiceTokenGrants {
  canPublish?: boolean;
  canSubscribe?: boolean;
  canPublishData?: boolean;
}

/**
 * LiveKit `TrackSource` allowlist. Embedded in the JWT as
 * `video.canPublishSources`; LiveKit rejects any publish whose source is not
 * in the list. Plugin handlers DERIVE this from per-user permissions —
 * client-supplied values on `voice.join` params must be discarded (see
 * PR-6 contract §14). Defaults to `["microphone"]` at the runtime when
 * omitted (audio-only, backwards-compatible).
 */
export type VoiceTrackSource =
  | "microphone"
  | "camera"
  | "screen_share"
  | "screen_share_audio";

export interface VoiceJoinToken {
  /** LiveKit-signed JWT the client presents on connect. */
  token: string;
  /** Public LiveKit signaling URL the client connects to. */
  livekitUrl: string;
  /** Unix-ms timestamp when the token expires. Refresh well before this. */
  expiresAt: number;
}

/**
 * Result of `voice.removeParticipant` — used by admin moderation. The runtime
 * mints a fresh `roomAdmin` token, calls LiveKit's `RemoveParticipant` Twirp,
 * and returns success once the room-service ACK lands. The participant is
 * disconnected immediately; their client is responsible for surfacing the
 * disconnect reason.
 */
export interface VoiceRemoveParticipantResult {
  ok: true;
}

/**
 * Runtime voice bridge. Methods are gated per spec-04 capability strings —
 * see pr-4-voice-contract.md §2 for the slug map. Plugins without the
 * matching capability get a typed error from the SDK.
 */
export interface VoiceApi {
  /**
   * Mint a short-lived LiveKit join token for `userId` joining `channelId`.
   * The plugin is responsible for ACL checks (channel exists, user not
   * banned, role gate) before calling.
   *
   * `canPublishSources` gates LiveKit's per-source publish enforcement.
   * Plugin handlers MUST derive this from the user's `voice.screen_share.publish`
   * permission and the channel's e2ee flag — never pass client-supplied
   * values through. Omitting falls back to `["microphone"]`.
   *
   * Capability: `voice.tokens:self`.
   */
  createJoinToken(input: {
    channelId: string;
    userId: string;
    grants?: VoiceTokenGrants;
    canPublishSources?: VoiceTrackSource[];
  }): Promise<VoiceJoinToken>;

  /**
   * Disconnect a participant from a voice room. Used by admin moderation
   * ("Stop their share") since LiveKit doesn't expose a track-level mute
   * primitive today — the safe ship path is full participant kick. The user
   * can rejoin with audio but the offending publication is gone.
   *
   * Capability: `voice.moderation:self`.
   */
  removeParticipant(input: {
    channelId: string;
    userId: string;
    /** Free-form reason logged at the runtime; not surfaced to LiveKit. */
    reason?: string;
  }): Promise<VoiceRemoveParticipantResult>;
}
