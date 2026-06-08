// Wire protocol types — shared between client and server.
export * from "./core.js";
// Plugin resource permission foundation (RP-FOUND-1) — additive identity,
// action vocabulary, and version-stamped authorization decision shapes.
export * from "./plugin-resources.js";
// CoView render-tree projection foundation (CV-FOUND-1) — additive canonical /
// projected render-tree types, value origins, value refs, policy/resource refs,
// and the surface schema registry skeleton. Legacy CoView state is untouched.
export * from "./co-view-render-tree.js";
// WebSocket uses these as the message envelope format.
// IPC uses the Ipc* variants for runtime ↔ plugin communication.

// Crypto helpers (PR-T4) — single source of truth for fingerprint format and
// per-attach-session cipher. Re-exported under namespaces so `derive` and
// any future overlapping names stay scoped.
export * as fingerprint from "./crypto/fingerprint.js";
export * as sessionCipher from "./crypto/session-cipher.js";
export {
  ReplayDetectedError,
  FingerprintMismatchError,
  DIRECTION_HOST_TO_ATTACH,
  DIRECTION_ATTACH_TO_HOST,
  type Direction,
  type SessionKeyMaterial,
  type HostKeypair,
  type AttachKeypair,
  type EncryptedFrame,
  type DecryptedFrame,
} from "./crypto/session-cipher.js";

// IPC JSON codec — preserves Uint8Array fields across newline-delimited JSON.
export { encodeIpcJson, decodeIpcJson } from "./ipc-codec.js";

// ---------------------------------------------------------------------------
// IPC transport primitives (shared by runtime and plugin-sdk)
// ---------------------------------------------------------------------------

/** All IPC messages use this envelope. */
export interface IpcMessage {
  type: string;
  id?: string;
  [key: string]: unknown;
}

export type MessageHandler = (message: IpcMessage) => void;

/**
 * Transport abstraction for bidirectional IPC.
 * One code path, all platforms.
 */
export interface IpcTransport {
  send(message: IpcMessage): void;
  onMessage(handler: MessageHandler): void;
  close(): void;
}

// ---------------------------------------------------------------------------
// Common
// ---------------------------------------------------------------------------

export interface ResponseError {
  code: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Client → Server (WebSocket)
// ---------------------------------------------------------------------------

export interface AuthMessage {
  type: "auth";
  token: string;
}

export interface RequestMessage {
  type: "request";
  id: string;
  plugin: string;
  action: string;
  params: Record<string, unknown>;
}

export type ClientMessage =
  | AuthMessage
  | RequestMessage
  | WsCoViewStartReq
  | WsCoViewUpdateReq
  | WsCoViewEndReq
  | WsCoViewJoinReq
  | WsCoViewLeaveReq
  | WsCoViewKickReq
  | WsCoViewListReq
  | WsCoViewState
  | WsCoViewEvent
  | WsCoViewCursor
  | WsCoViewSnapshotReq
  | WsCoViewSnapshotRes;

// ---------------------------------------------------------------------------
// Server → Client (WebSocket)
// ---------------------------------------------------------------------------

export interface AuthResultMessage {
  type: "auth.result";
  ok: boolean;
  error?: string | undefined;
}

export interface ResponseMessage {
  type: "response";
  id: string;
  result?: unknown;
  error?: ResponseError | undefined;
}

export interface EventMessage {
  type: "event";
  topic: string;
  payload: unknown;
}

export type ServerMessage =
  | AuthResultMessage
  | ResponseMessage
  | EventMessage
  | WsCoViewStartAck
  | WsCoViewStartNak
  | WsCoViewUpdateAck
  | WsCoViewUpdateNak
  | WsCoViewEndAck
  | WsCoViewJoinAck
  | WsCoViewJoinNak
  | WsCoViewLeaveAck
  | WsCoViewKickAck
  | WsCoViewKickNak
  | WsCoViewListRes
  | WsCoViewListChanged
  | WsCoViewEnded
  | WsCoViewMemberJoined
  | WsCoViewMemberLeft
  | WsCoViewState
  | WsCoViewEvent
  | WsCoViewCursor
  | WsCoViewSnapshotReq
  | WsCoViewSnapshotRes;

// ---------------------------------------------------------------------------
// IPC: Runtime ↔ Plugin subprocess (stdio JSON)
// ---------------------------------------------------------------------------

export interface IpcUser {
  id: string;
  displayName: string;
  avatarUrl: string;
  role: string;
}

export interface IpcRequestMessage {
  type: "request";
  id: string;
  action: string;
  params: Record<string, unknown>;
  user: IpcUser;
  /**
   * Opaque WS session that originated this request. Stable for the life of
   * the WS connection, never reused. Present only for client-originated
   * requests; absent for runtime-originated calls (schedule.tick, cascade
   * dispatch). The SDK pins this in AsyncLocalStorage so nested presence
   * calls can attribute themselves to the originating session.
   */
  session_id?: string | undefined;
}

export interface IpcResponseMessage {
  type: "response";
  id: string;
  result?: unknown;
  error?: ResponseError | undefined;
}

// ---------------------------------------------------------------------------
// IPC: Event bus messages (Runtime ↔ Plugin)
// ---------------------------------------------------------------------------

/** Plugin → Runtime: publish an event to a topic. */
export interface IpcEventPublishMessage {
  type: "events.publish";
  id?: string | undefined;
  topic: string;
  payload: unknown;
  version?: number | undefined;
}

/** Plugin → Runtime: subscribe to a topic pattern. */
export interface IpcEventSubscribeMessage {
  type: "events.subscribe";
  id?: string | undefined;
  topic: string;
  overflow_policy?: "mark_unhealthy" | "drop_oldest" | "drop_newest" | undefined;
  queue_size?: number | undefined;
}

/** Plugin → Runtime: unsubscribe from a topic pattern. */
export interface IpcEventUnsubscribeMessage {
  type: "events.unsubscribe";
  id?: string | undefined;
  topic: string;
}

/** Runtime → Plugin: deliver an event to a subscriber. */
export interface IpcEventDeliverMessage {
  type: "event.deliver";
  topic: string;
  version: number;
  id: string;
  ts: number;
  source_plugin: string;
  payload: unknown;
}

/**
 * Runtime → Plugin: a single setting value declared in this plugin's manifest
 * was changed by an admin via `PATCH /admin/api/plugins/:slug/config`.
 *
 * Per spec-04 Amendment A, every plugin always receives changes for its own
 * keys (no permission required, no subscription needed). The SDK's
 * `handle.settings.onChange` API surfaces these to user code.
 */
export interface IpcPluginConfigChangedMessage {
  type: "core.plugin.config_changed";
  key: string;
  value: string | number | boolean;
  changed_by_user_id: string;
  ts: number;
}

/** Runtime → Plugin: acknowledge a publish/subscribe/unsubscribe. */
export interface IpcEventAckMessage {
  type: "event.ack";
  id: string;
  ok: boolean;
  event_id?: string | undefined;
  error?: ResponseError | undefined;
}

// ---------------------------------------------------------------------------
// IPC: Plugin ready handshake
// ---------------------------------------------------------------------------

/** Plugin → Runtime: signal that the plugin has finished initialization. */
export interface IpcReadyMessage {
  type: "ready";
}

/**
 * Plugin → Runtime: opt-in second-stage handshake. Sent once the plugin's
 * internal state (hydrated caches, fetched member lists, role tables, etc.)
 * is ready to serve user-facing requests — distinct from the spawn-time
 * `ready` handshake, which only proves the process is alive.
 *
 * Plugins opt in via the `serve_ready_handshake: true` manifest field.
 * Without opt-in, the runtime treats them as serve-ready immediately on
 * spawn (current behavior). With opt-in, the web client greys out their
 * sidebar items until this frame arrives.
 */
export interface IpcServeReadyMessage {
  type: "serve_ready";
}

// ---------------------------------------------------------------------------
// IPC: Permission messages (Plugin → Runtime)
// ---------------------------------------------------------------------------

/** Plugin → Runtime: register a plugin-defined permission type. */
export interface IpcPermissionsRegisterMessage {
  type: "permissions.register";
  id: string;
  key: string;
  description: string;
  default_level: number;
}

/** Plugin → Runtime: check if a user has a specific permission. */
export interface IpcPermissionsCheckMessage {
  type: "permissions.check";
  id: string;
  user_id: string;
  permission: string;
  scope?: string | undefined;
}

/** Plugin → Runtime: check if a user has a specific role by name. */
export interface IpcPermissionsHasRoleMessage {
  type: "permissions.has_role";
  id: string;
  user_id: string;
  role_name: string;
}

/** Plugin → Runtime: check if a user meets a minimum role level. */
export interface IpcPermissionsHasMinLevelMessage {
  type: "permissions.has_min_level";
  id: string;
  user_id: string;
  level: number;
}

/** Plugin → Runtime: get a user's role information. */
export interface IpcPermissionsGetRoleMessage {
  type: "permissions.get_role";
  id: string;
  user_id: string;
}

// ---------------------------------------------------------------------------
// IPC: Cross-plugin data read (Plugin → Runtime)
// ---------------------------------------------------------------------------

export interface DataReadWhereClause {
  column: string;
  op: "=" | "!=" | "<" | ">" | "<=" | ">=" | "LIKE";
  value: string | number | boolean | null;
}

export interface DataReadOrderBy {
  column: string;
  direction: "asc" | "desc";
}

// ---------------------------------------------------------------------------
// JWT payload (issued by Central, validated by runtime)
// ---------------------------------------------------------------------------

export interface JwtPayload {
  sub: string;         // account ID
  server_id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
  is_owner: boolean;
  iat: number;
  exp: number;
  jti: string;
}

/** Plugin → Runtime: structured read query against another plugin's published schema. */
export interface IpcDataReadMessage {
  type: "data.read";
  id: string;
  plugin: string;
  table: string;
  where?: DataReadWhereClause[] | undefined;
  select?: string[] | undefined;
  order_by?: DataReadOrderBy[] | undefined;
  limit?: number | undefined;
}

// ---------------------------------------------------------------------------
// Sidebar (runtime → client, plugin → runtime)
// ---------------------------------------------------------------------------

export interface SidebarAction {
  id: string;
  label: string;
  icon?: string | undefined;
}

/**
 * Optional presence row for items where "who is currently here" is meaningful
 * (voice channels, watch rooms, etc.). Plugins populate this in their
 * `sidebar.items` response and keep it fresh by broadcasting their own
 * presence events; the shell renders a stacked-avatar row under the item
 * label without knowing the plugin's specific presence semantics.
 */
export interface SidebarPresence {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface SidebarItem {
  id: string;
  label: string;
  icon?: string | undefined;
  panelType: "plugin";
  slug: string;
  section?: string | undefined;
  /**
   * Soft FK to a Core category id (`core.categories.list`), or null/undefined
   * for "uncategorized". The shell groups items by category within a section;
   * unknown ids fall through to the uncategorized bucket.
   */
  group_id?: string | null | undefined;
  adminActions?: SidebarAction[] | undefined;
  /**
   * Current presence list (e.g. voice channel occupants). Empty / undefined
   * means "no one here" — the shell skips the avatar row. Updated reactively
   * by plugin-emitted presence events; this field is the initial-sync
   * snapshot returned with `sidebar.items`.
   */
  participants?: SidebarPresence[] | undefined;
}

// ---------------------------------------------------------------------------
// IPC: Key-value store (Plugin → Runtime)
// ---------------------------------------------------------------------------

/**
 * Plugin → Runtime: key-value store operations.
 * All operations target the plugin's own _kv table (data.kv:self capability).
 * Values are never logged by the runtime regardless of content — callers must
 * not assume values are safe to log either (secret settings land here).
 */
export type IpcKvMethod = "get" | "set" | "delete" | "list" | "getMany";

export interface IpcKvMessage {
  type: "data.kv";
  id: string;
  method: IpcKvMethod;
  /** Key for get / set / delete. */
  key?: string | undefined;
  /** Value for set. */
  value?: string | undefined;
  /** Prefix filter for list. Empty or omitted = return all keys. */
  prefix?: string | undefined;
  /** Keys for getMany. */
  keys?: string[] | undefined;
}

// ---------------------------------------------------------------------------
// IPC: Plugin settings store (Plugin → Runtime, spec-04 Amendment A)
// ---------------------------------------------------------------------------

/**
 * Plugin reads from its own `_config` table — the typed admin-set values
 * declared in `manifest.settings`. No permission required (a plugin always
 * has access to its own config). Writes happen exclusively via
 * `PATCH /admin/api/plugins/:slug/config` from the admin UI.
 *
 * The result merges any stored row with the manifest `default` so callers
 * never see undefined for declared keys.
 */
export type IpcConfigMethod = "get" | "getAll";

export interface IpcConfigMessage {
  type: "data.config";
  id: string;
  method: IpcConfigMethod;
  /** Key for get. Required when method === "get". */
  key?: string | undefined;
}

// ---------------------------------------------------------------------------
// IPC: Outbound HTTP fetch (Plugin → Runtime)
// ---------------------------------------------------------------------------

/** Plugin → Runtime: make an outbound HTTP request via the runtime proxy. */
export interface IpcHttpFetchMessage {
  type: "http.fetch";
  id: string;
  /** Full URL to fetch. */
  url: string;
  /**
   * Hostname extracted from url by the SDK — used for capability scope check
   * (http.fetch:<host>). The handler validates that this matches the parsed url.
   */
  host: string;
  method?: string | undefined;
  headers?: Record<string, string> | undefined;
  /**
   * Request body as a string (JSON, form-encoded, plain text).
   * Binary request bodies are not supported in Phase 1.
   */
  body?: string | undefined;
}

/** Result returned in the IPC response result field for http.fetch requests. */
export interface IpcHttpFetchResult {
  status: number;
  /** Response headers as a plain string→string map. */
  headers: Record<string, string>;
  /** Response body, always base64-encoded. */
  body: string;
  encoding: "base64";
}

// ---------------------------------------------------------------------------
// IPC: Broadcast to WebSocket clients (Plugin → Runtime)
// ---------------------------------------------------------------------------

/**
 * Plugin → Runtime: push a WS event to specific users' connections.
 * Requires broadcast.clients capability.
 * The runtime prefixes the event name with the plugin slug before sending:
 * event "status.update" from plugin "text-channels" → topic "text-channels.status.update".
 */
export interface IpcBroadcastToUsersMessage {
  type: "broadcast.toUsers";
  id: string;
  /** Target user IDs. Maximum 100 per call. */
  userIds: string[];
  /** Event name (unprefixed — runtime adds the slug prefix). */
  event: string;
  payload: unknown;
}

/**
 * Plugin → Runtime: push a WS event to all connected users.
 * Requires broadcast.clients capability.
 */
export interface IpcBroadcastToAllMessage {
  type: "broadcast.toAll";
  id: string;
  event: string;
  payload: unknown;
}

// ---------------------------------------------------------------------------
// IPC: Presence event topics (Runtime → Plugin, via event bus)
// ---------------------------------------------------------------------------

/**
 * Topics published by the runtime to the event bus on user connect/disconnect.
 * Plugins subscribe via sdk.presence.onConnected / sdk.presence.onDisconnected.
 * No capability declaration required (same as sdk.core.getOnlineUsers).
 */
export const PRESENCE_TOPICS = {
  USER_CONNECTED: "runtime.user.connected",
  USER_DISCONNECTED: "runtime.user.disconnected",
} as const;

// ---------------------------------------------------------------------------
// IPC: Scheduling (Plugin → Runtime)
// ---------------------------------------------------------------------------

/** Plugin → Runtime: register a named recurring schedule. */
export interface IpcScheduleRegisterMessage {
  type: "schedule.register";
  id: string;
  /** Unique name for this schedule within the plugin. Re-registering the same
   *  name replaces the existing schedule. */
  name: string;
  /** Interval in milliseconds. Minimum 1000ms enforced by the runtime. */
  interval_ms: number;
}

/** Plugin → Runtime: cancel a named recurring schedule. */
export interface IpcScheduleUnregisterMessage {
  type: "schedule.unregister";
  id: string;
  name: string;
}

// ---------------------------------------------------------------------------
// IPC: Scoped presence (Plugin → Runtime + Runtime → Plugin event topics)
// ---------------------------------------------------------------------------
//
// Per spec-23-scoped-presence.md. Capability folded into broadcast.clients —
// no new permission string. The runtime auto-prefixes scope with the calling
// plugin's slug; plugins never write their own slug in the scope argument.

/**
 * Plugin → Runtime: join the current request's WS session to a scope.
 * `session_id` is injected by the SDK from the AsyncLocalStorage request
 * context; the runtime verifies it against active connections and rejects
 * with PRESENCE_SESSION_GONE if the session has already closed.
 */
export interface IpcPresenceJoinMessage {
  type: "presence.join";
  id: string;
  scope: string;
  user_id: string;
  meta?: Record<string, unknown> | undefined;
  session_id: string;
}

/** Plugin → Runtime: leave a scope owned by the current session. */
export interface IpcPresenceLeaveMessage {
  type: "presence.leave";
  id: string;
  scope: string;
  user_id: string;
  session_id: string;
}

/**
 * Plugin → Runtime: replace meta on the current session's entry in a scope.
 * Silent no-op if no entry exists for (scope, session_id) — update never
 * implicitly joins. Always bumps updated_at and emits runtime.presence.updated
 * (even when meta is byte-identical) so watchers can use updated_at as a heartbeat.
 */
export interface IpcPresenceUpdateMessage {
  type: "presence.update";
  id: string;
  scope: string;
  user_id: string;
  meta: Record<string, unknown>;
  session_id: string;
}

/** Plugin → Runtime: one-shot read of all entries currently in a scope. */
export interface IpcPresenceListMessage {
  type: "presence.list";
  id: string;
  scope: string;
}

/** A single scoped-presence entry as returned to plugin code. */
export interface PresenceEntry {
  /** Fully-qualified scope, including the plugin slug prefix. */
  scope: string;
  user_id: string;
  /** Opaque runtime-assigned session identifier; stable for the WS session. */
  session_id: string;
  meta: Record<string, unknown>;
  joined_at: number;
  updated_at: number;
}

/** Result returned in IpcResponseMessage.result for presence.join. */
export interface IpcPresenceJoinResult {
  /** Fully-qualified scope (plugin slug already prefixed). */
  scope: string;
  joined_at: number;
}

/** Result returned in IpcResponseMessage.result for presence.list. */
export type IpcPresenceListResult = readonly PresenceEntry[];

/**
 * Topics emitted by the scoped-presence runtime module on each lifecycle
 * change. Plugins do not subscribe to these directly via sdk.events.subscribe;
 * sdk.presence.watch() handles the subscription, scope filtering, and
 * coalescing on the SDK side.
 */
export const RUNTIME_PRESENCE_TOPICS = {
  JOINED: "runtime.presence.joined",
  UPDATED: "runtime.presence.updated",
  LEFT: "runtime.presence.left",
} as const;

export interface RuntimePresenceJoinedPayload {
  scope: string;
  user_id: string;
  session_id: string;
  meta: Record<string, unknown>;
  ts: number;
}

export type RuntimePresenceUpdatedPayload = RuntimePresenceJoinedPayload;

export interface RuntimePresenceLeftPayload {
  scope: string;
  user_id: string;
  session_id: string;
  /** Why the entry departed. Future durable-handoff code subscribes on this. */
  reason: "explicit" | "session_closed" | "plugin_unloaded";
  ts: number;
}

// ---------------------------------------------------------------------------
// Co-View Sessions (spec-27) — WebSocket wire types
// ---------------------------------------------------------------------------
//
// PR-CV1 ships the lifecycle frames — start / update / end / join / leave /
// kick plus the server-side member.* and ended broadcasts.
// PR-CV2 adds the state + event channels, the snapshot req/res pair, and
// replay-safety tagging. Cursor and pen channels land in PR-CV4 and are NOT
// defined here.

/** Session visibility. Default per-host is "private". */
export type CoViewVisibility = "public" | "private";

/**
 * Render-permission mode chosen by the host at start.
 *  - "as-host": viewers see the host's chrome with the host's permission level
 *    (admin-only buttons render for everyone).
 *  - "as-viewer": chrome is filtered through each viewer's own permissions.
 */
export type CoViewRenderMode = "as-host" | "as-viewer";

/** Host-configured redaction set; applies layers 2 and the host-side of 3 (spec §Privacy & Redaction Model). */
export interface CoViewRedactions {
  panel_ids: string[];
  plugin_slugs: string[];
  custom_selectors: string[];
}

// ---------- lifecycle: host ----------

export interface WsCoViewStartReq {
  type: "co-view.start.req";
  visibility: CoViewVisibility;
  whitelist: string[];
  blacklist: string[];
  render_mode: CoViewRenderMode;
  redactions: CoViewRedactions;
}

export interface WsCoViewStartAck {
  type: "co-view.start.ack";
  session_id: string;
  host_color: string;
}

export interface WsCoViewStartNak {
  type: "co-view.start.nak";
  code:
    | "permission_denied"
    | "already_hosting"
    | "invalid_payload";
  message: string;
}

export interface WsCoViewUpdateReq {
  type: "co-view.update.req";
  session_id: string;
  visibility?: CoViewVisibility | undefined;
  whitelist?: string[] | undefined;
  blacklist?: string[] | undefined;
  render_mode?: CoViewRenderMode | undefined;
  redactions?: CoViewRedactions | undefined;
  paused?: boolean | undefined;
}

export interface WsCoViewUpdateAck {
  type: "co-view.update.ack";
  session_id: string;
}

export interface WsCoViewUpdateNak {
  type: "co-view.update.nak";
  session_id: string;
  code: "not_host" | "session_not_found" | "invalid_payload";
  message: string;
}

export interface WsCoViewEndReq {
  type: "co-view.end.req";
  session_id: string;
  reason?: string | undefined;
}

export interface WsCoViewEndAck {
  type: "co-view.end.ack";
  session_id: string;
}

// ---------- lifecycle: viewer ----------

export interface WsCoViewJoinReq {
  type: "co-view.join.req";
  session_id: string;
}

export interface WsCoViewJoinAck {
  type: "co-view.join.ack";
  session_id: string;
  host_user_id: string;
  render_mode: CoViewRenderMode;
  viewer_color: string;
  /**
   * Snapshot of the host's cumulative safe-state at join time. The runtime
   * applies every `replay: "safe"` `co-view.state` diff to a per-session
   * cache and inlines the result here so the joining viewer can paint
   * without a follow-up snapshot.req. `null` when the host has not yet
   * pushed any safe state (race: viewer joined before first state frame).
   */
  current_state_snapshot: CoViewStateSnapshot | null;
}

export interface WsCoViewJoinNak {
  type: "co-view.join.nak";
  session_id: string;
  code:
    | "session_not_found"
    | "session_full"
    | "blacklisted"
    | "not_invited";
  message: string;
}

export interface WsCoViewLeaveReq {
  type: "co-view.leave.req";
  session_id: string;
}

export interface WsCoViewLeaveAck {
  type: "co-view.leave.ack";
  session_id: string;
}

// ---------- moderation ----------

export interface WsCoViewKickReq {
  type: "co-view.kick.req";
  session_id: string;
  target_user_id: string;
  reason?: string | undefined;
}

export interface WsCoViewKickAck {
  type: "co-view.kick.ack";
  session_id: string;
  target_user_id: string;
}

export interface WsCoViewKickNak {
  type: "co-view.kick.nak";
  session_id: string;
  code:
    | "not_host_or_moderator"
    | "session_not_found"
    | "target_not_in_session";
  message: string;
}

// ---------- active-sessions roster (PR-CV5) ----------

/**
 * Lightweight per-session summary. Server-side filtered through
 * `isVisibleToUser` before reaching any client — a viewer never receives a
 * summary for a session they could not actually join (no existence leak).
 */
export interface CoViewSessionSummary {
  session_id: string;
  server_id: string;
  host_user_id: string;
  /**
   * The host's WS connection id. In v1 this equals the `member_id` field
   * stamped on cursor / pen frames (per spec-27: `member_id = ws_session_id`).
   * Named `host_session_id` to keep the word "member" from doing double duty
   * (server member vs. WS connection member).
   */
  host_session_id: string;
  host_display_name: string;
  visibility: CoViewVisibility;
  render_mode: CoViewRenderMode;
  /** ms epoch when the session was created. */
  started_at: number;
  viewer_count: number;
  paused: boolean;
}

/**
 * Client → server: subscribe to active-sessions changes for a server. The
 * runtime treats a `list.req` for a `(connection, server)` pair as both
 *   1. an immediate snapshot (replied via `co-view.list.res`), and
 *   2. an implicit subscription — subsequent visibility / lifecycle changes
 *      are pushed via `co-view.list.changed`.
 *
 * A second `list.req` for the same `(connection, server)` REPLACES the prior
 * subscription's per-subscriber visible-set (re-snapshot). Different servers
 * coexist as independent subscriptions on the same connection.
 *
 * Authorization: the connection must already be authenticated for `server_id`
 * (same gate as any other server-scoped op); otherwise the runtime nak's via
 * the standard error response. PR-CV5 does not gate `list.req` on
 * `co-view.host` — viewers without host permission still need to see the
 * roster to join.
 */
export interface WsCoViewListReq {
  type: "co-view.list.req";
  request_id: string;
  server_id: string;
}

/** Server → client: snapshot reply to a `list.req`. */
export interface WsCoViewListRes {
  type: "co-view.list.res";
  request_id: string;
  server_id: string;
  sessions: CoViewSessionSummary[];
}

/**
 * Server → client push: a session's visibility, lifecycle, or pause state
 * changed. Only sent to subscribers whose visible-set is affected.
 *
 *   - `added`: subscriber gained visibility OR a new session was created and
 *     is visible to them. Carries the full summary; subscriber adds `session_id`
 *     to their tracked set.
 *   - `updated`: subscriber already had this session in their visible-set
 *     and a non-removal change occurred (viewer count, pause flag, render
 *     mode, etc.). Carries the full summary.
 *   - `removed`: subscriber previously had this session in their visible-set
 *     and either the session ended OR the subscriber lost visibility. Carries
 *     only `session_id`. Subscribers who never saw the session do NOT receive
 *     this frame — the runtime tracks per-subscriber visible-sets to prevent
 *     leaking the existence of sessions a viewer was never invited to.
 */
export interface WsCoViewListChanged {
  type: "co-view.list.changed";
  server_id: string;
  change: "added" | "updated" | "removed";
  session_id: string;
  /** Full summary on `added` / `updated`; absent on `removed`. */
  session?: CoViewSessionSummary | undefined;
}

// ---------- broadcasts ----------

/** Reasons a member departed (also stamped on audit + presence.left). */
export type CoViewMemberLeftReason =
  | "explicit"
  | "session_closed"
  | "kicked"
  | "host_ended"
  | "no_longer_invited"
  | "blacklisted_mid_session";

/** Reasons a session ended (sent on `co-view.ended`). */
export type CoViewEndReason =
  | "host_ended"
  | "host_lost"
  | "host_permission_revoked"
  | "host_banned";

export interface WsCoViewEnded {
  type: "co-view.ended";
  session_id: string;
  reason: CoViewEndReason;
}

export interface WsCoViewMemberJoined {
  type: "co-view.member.joined";
  session_id: string;
  user_id: string;
  /**
   * Per-connection member id (= WS connection id in v1) — the same id the
   * runtime stamps on `co-view.cursor` and `pen.*` `WsCoViewEvent` frames.
   * Consumers key their cursor/stroke→color lookup off this field. Optional
   * for PR-CV2/CV3 forward-compat; runtime always sets it as of PR-CV4.
   */
  member_id?: string | undefined;
  color: string;
}

export interface WsCoViewMemberLeft {
  type: "co-view.member.left";
  session_id: string;
  user_id: string;
  /** See `WsCoViewMemberJoined.member_id`. */
  member_id?: string | undefined;
  reason: CoViewMemberLeftReason;
}

// ---------- state + event channels (PR-CV2) ----------

/**
 * Replay-safety tag — set by the producer (host shell or plugin SDK).
 * `"safe"` frames are folded into the per-session cumulative snapshot and
 * delivered to viewers joining mid-session via `join.ack.current_state_snapshot`
 * or via `co-view.snapshot.res`. `"unsafe"` frames are live-only — never
 * snapshotted, never replayed on join. Defaults at the producer are spelled
 * out in spec-27 §Locked Decisions: shell-instrumented navigation = safe;
 * plugin-published custom state = unsafe-by-default.
 */
export type CoViewReplaySafety = "safe" | "unsafe";

/**
 * Shape of the well-known shell-state snapshot the runtime maintains per
 * session. Held loose-typed at the protocol layer because the schema is owned
 * by the website's `apps/website/src/co-view/state-schema.ts`; the runtime
 * never inspects fields, it just merge-patches diffs into the cache.
 *
 * The producer-side serializer enforces a closed allowlist of keys per
 * spec-27 §The Shell-State Boundary — runtime trusts the producer here, but
 * audits must NOT log snapshot or diff bodies.
 */
export type CoViewStateSnapshot = Record<string, unknown>;

/**
 * JSON-merge-patch (RFC 7396) shape for `co-view.state.diff`. Loosely typed
 * at this layer for the same reason as the snapshot above.
 */
export type CoViewStateDiff = Record<string, unknown>;

/**
 * Discrete event kinds emitted on `co-view.event`. PR-CV2 actively emits
 * `nav.route_change`, `nav.panel_open`, `nav.panel_close` and accepts
 * `host.action_observed` from instrumented buttons (the surface lands fully
 * with PR-CV3). PR-CV4 adds `nav.modal_*`, `nav.popover_*`, `nav.context_menu_*`,
 * and the `pen.*` family. The union is open-ended at the type level so future
 * kinds are additive — the runtime forwards anything in the right shape.
 */
export type CoViewEventKind =
  | "nav.route_change"
  | "nav.panel_open"
  | "nav.panel_close"
  | "nav.modal_open"
  | "nav.modal_close"
  | "nav.popover_open"
  | "nav.popover_close"
  | "nav.context_menu_open"
  | "nav.context_menu_close"
  | "host.action_observed"
  | "pen.stroke_begin"
  | "pen.stroke_point"
  | "pen.stroke_end"
  | "pen.clear";

/**
 * Coalesced shell-state diff. Host emits at ≤30 Hz (50 ms producer windows
 * per spec). `seq` is a per-(session, host) monotonically-increasing uint32
 * starting at 0. `full_state` is an optional escape hatch for the producer
 * to push a complete snapshot inline — the runtime treats a frame with
 * `full_state` as "replace the cached snapshot wholesale" and `diff` is
 * ignored when `full_state` is present.
 *
 * Wire size is hard-capped at 16 KB (spec §Bounds and Limits); over-budget
 * frames are rejected by the runtime, never silently truncated.
 */
export interface WsCoViewState {
  type: "co-view.state";
  session_id: string;
  seq: number;
  diff: CoViewStateDiff;
  replay: CoViewReplaySafety;
  ts: number;
  full_state?: CoViewStateSnapshot | undefined;
}

/**
 * Discrete event frame. 4 KB hard cap on the serialized payload per spec.
 * Forwarded as-is to all viewers; never folded into the state snapshot.
 *
 * `member_id` is server-stamped on outbound `pen.*` frames so viewers can
 * resolve color/name from `co-view.member.joined` metadata. Absent on the
 * inbound (client→server) hop; any client-supplied value is dropped before the
 * server stamps its own. Identity is the WS connection id (`ws_session_id`)
 * in v1 — see `WsCoViewCursor.member_id` for the same semantics.
 *
 * Untrusted client fields on `pen.stroke_begin`: a payload may carry a
 * `color` field, but the server and consumer MUST IGNORE it. Color is derived
 * on the consumer from `member_id → membership color` (broadcast via
 * `co-view.member.joined`). Treating client-supplied `color` as advisory only
 * prevents impersonation via color spoofing.
 */
export interface WsCoViewEvent {
  type: "co-view.event";
  session_id: string;
  kind: CoViewEventKind;
  payload: Record<string, unknown>;
  replay: CoViewReplaySafety;
  ts: number;
  /** Server-stamped on outbound for `pen.*` kinds. Absent on inbound. */
  member_id?: string | undefined;
}

// ---------- cursor channel (PR-CV4) ----------

/**
 * 9-state cursor vocabulary defined by spec-27 §Cursor & Annotation Layer.
 * The viewer overlay maps each state to an SVG cursor shape via
 * `apps/website/src/co-view/cursor-shapes.ts`. `tap` and `long-press` are
 * mobile-only and reserved for PR-CV6 — desktop producers never emit them.
 */
export type CoViewCursorState =
  | "idle"
  | "hover"
  | "pressed"
  | "dragging"
  | "typing"
  | "selecting"
  | "menu-open"
  | "tap"
  | "long-press";

/**
 * Cursor frame published by every member ≤30 Hz (33 ms throttle, leading-edge,
 * volatile/drop-on-backpressure per spec). Coordinates are host-viewport CSS
 * pixels; the viewer overlay applies its own scale.
 *
 * `member_id` is server-stamped before forwarding to other members; absent on
 * the member→server hop. v1: `member_id = ws_session_id` (fresh on every
 * reconnect). Named `member_id` (not `user_id`) deliberately: this is
 * per-connection, not per-account. Any reconnect-with-resume aliasing
 * semantics will require an explicit protocol amendment.
 *
 * Client-supplied `member_id` on the inbound hop is dropped — the server is
 * the only authority on identity.
 */
export interface WsCoViewCursor {
  type: "co-view.cursor";
  session_id: string;
  /** Server-stamped on outbound. Absent on inbound. */
  member_id?: string | undefined;
  /** Host-viewport CSS pixel coordinate. */
  x: number;
  /** Host-viewport CSS pixel coordinate. */
  y: number;
  state: CoViewCursorState;
  ts: number;
}

/**
 * Viewer → server: gap-recovery request. Triggered when the viewer's
 * consumer detects a `seq` gap on the live `co-view.state` stream. The
 * runtime stamps `member_id` (the requesting viewer's WS connection id) and
 * forwards to the host so the host's local ring buffer can decide between
 * sending diffs vs a full state. `member_id` is omitted on the client side
 * and required on the server-side forward.
 */
export interface WsCoViewSnapshotReq {
  type: "co-view.snapshot.req";
  session_id: string;
  since_seq: number;
  /** Server-stamped before forwarding to host; absent on viewer→server hop. */
  member_id?: string | undefined;
}

/**
 * Host → server: gap-recovery response. The runtime addresses the response
 * to the viewer named by `member_id` (which must echo the value the host
 * received on the inbound snapshot.req). Either `diffs` is set (host's ring
 * buffer covers the gap) OR `full_state` is set (host fell off the buffer
 * and is shipping a complete snapshot for the viewer to rebuild from). One
 * MUST be set — runtime drops frames that have neither.
 */
export interface WsCoViewSnapshotRes {
  type: "co-view.snapshot.res";
  session_id: string;
  /** Required on host→server hop; runtime uses it to address the viewer. */
  member_id?: string | undefined;
  /** Host's current `seq` at the moment the snapshot was assembled. */
  seq: number;
  diffs?: WsCoViewState[] | undefined;
  full_state?: CoViewStateSnapshot | undefined;
}

// ---------- runtime → plugin event topics ----------

/**
 * Runtime topics broadcast by the Co-View module for plugin observers (PR-CV7+
 * will let plugins subscribe via the SDK; PR-CV1 just publishes them so the
 * shell + audit consumers can react). Topic names are flat and final — adding
 * new entries here is additive but renaming any existing value breaks the
 * shell subscriber.
 */
export const RUNTIME_CO_VIEW_TOPICS = {
  SESSION_STARTED: "runtime.co-view.session.started",
  SESSION_ENDED: "runtime.co-view.session.ended",
  MEMBER_JOINED: "runtime.co-view.member.joined",
  MEMBER_LEFT: "runtime.co-view.member.left",
} as const;

export interface RuntimeCoViewSessionStartedPayload {
  session_id: string;
  host_user_id: string;
  visibility: CoViewVisibility;
  render_mode: CoViewRenderMode;
  ts: number;
}

export interface RuntimeCoViewSessionEndedPayload {
  session_id: string;
  reason: CoViewEndReason;
  ts: number;
}

export interface RuntimeCoViewMemberJoinedPayload {
  session_id: string;
  user_id: string;
  color: string;
  ts: number;
}

export interface RuntimeCoViewMemberLeftPayload {
  session_id: string;
  user_id: string;
  reason: CoViewMemberLeftReason;
  ts: number;
}
