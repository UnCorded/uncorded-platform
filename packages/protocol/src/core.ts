// Core Module protocol types.
// Shared between runtime (CoreModule), plugin-sdk (sdk.core.*), and web client.

// ---------------------------------------------------------------------------
// User profile (Core Module cache, read by plugins via sdk.core.*)
// ---------------------------------------------------------------------------

export interface CoreUser {
  id: string;
  username: string;
  display_name: string;
  avatar_url: string;
  is_online: boolean;
  last_seen_at: number;
  connected_at: number;
}

export interface CoreMember extends CoreUser {
  joined_at: number;
  /**
   * Explicit role assignment for this member. `null` means the member has no
   * row in `user_roles` and falls back to the default `member` role. Returned
   * by `core.member.list` so admin UIs can show + edit roles inline without
   * an N+1 `core.member.role` round-trip per row. The role name and level are
   * resolved client-side via the `roles` store. Per spec-22 Amendment B.
   */
  role_id: number | null;
}

/**
 * Response shape of `core.member.list`. Cursor is opaque to clients —
 * pass it back verbatim as `params.cursor` to fetch the next page, or
 * stop when it is null. Per spec-22 Amendment B.
 */
export interface CoreMemberListResponse {
  members: CoreMember[];
  total: number;
  next_cursor: string | null;
}

export interface CoreBan {
  user_id: string;
  banned_by: string;
  banned_at: number;
  reason: string;
}

export interface CoreAuditEntry {
  id: string;
  action: string;
  actor_id: string;
  target_id: string | null;
  details: string; // JSON string
  created_at: number;
}

// ---------------------------------------------------------------------------
// Workspace layout — recursive binary split tree
// ---------------------------------------------------------------------------

export type PanelLeaf = {
  type: "leaf";
  id: string;
};

export type PanelSplit = {
  type: "split";
  id: string;
  direction: "horizontal" | "vertical";
  /** 0.0–1.0; UI clamps to 0.15–0.85. */
  ratio: number;
  first: PanelNode;
  second: PanelNode;
};

export type PanelNode = PanelLeaf | PanelSplit;

export interface BrowserTab {
  id: string;
  title: string;
  url: string;
}

export interface BrowserRecentEntry {
  title: string;
  url: string;
}

export type LegacyBrowserPanelContent = {
  type: "browser";
  url: string;
  title: string;
};

export type TabbedBrowserPanelContent = {
  type: "browser";
  tabs: BrowserTab[];
  activeTabId: string | null;
  recent?: BrowserRecentEntry[];
};

export type BrowserPanelContent = LegacyBrowserPanelContent | TabbedBrowserPanelContent;

export type PanelContent =
  | {
      type: "plugin";
      serverId: string;
      // No tunnelUrl: panels resolve the live tunnel URL from the reactive
      // servers() store by serverId at render time (see channel-view.tsx).
      // Persisting it by value froze a dead URL across tunnel rotation. Old
      // saved layouts may still carry the field; the runtime validator
      // tolerates and drops it (runtime/src/core/layout.ts).
      slug: string;
      itemId: string;
      itemLabel: string;
      itemIcon?: string;
    }
  | BrowserPanelContent;

export interface WorkspaceLayout {
  /** Schema version — currently always 1. */
  version: 1;
  root: PanelNode;
  /** Maps leaf ID → panel content. All leaf IDs in the tree must have an entry here. */
  panels: Record<string, PanelContent>;
  /** Optional presentation state for "focused panel" mode. */
  focusedLeafId?: string | null;
}

export interface SavedWorkspace {
  id: string;
  name: string | null;
  layout: WorkspaceLayout;
  created_at: number;
  updated_at: number;
}

// ---------------------------------------------------------------------------
// Categories — server-wide, plugin-agnostic. Owned by Core; referenced by
// plugins (text-channels, voice-channels) via a soft FK on category_id.
// ---------------------------------------------------------------------------

export interface CoreCategory {
  id: string;
  name: string;
  position: number;
  created_at: number;
  updated_at: number;
}

// ---------------------------------------------------------------------------
// IPC action types (Plugin → Runtime, handled synchronously by CoreModule)
// No capability declaration required for these actions.
// ---------------------------------------------------------------------------

export interface IpcCoreGetUserRequest {
  type: "core.user.get";
  id: string;
  userId: string;
}

export interface IpcCoreGetUsersRequest {
  type: "core.user.getMany";
  id: string;
  userIds: string[];
}

export interface IpcCoreGetOnlineUsersRequest {
  type: "core.user.getOnline";
  id: string;
}

export interface IpcCoreListCategoriesRequest {
  type: "core.categories.list";
  id: string;
}

export type IpcCoreRequest =
  | IpcCoreGetUserRequest
  | IpcCoreGetUsersRequest
  | IpcCoreGetOnlineUsersRequest
  | IpcCoreListCategoriesRequest;

// ---------------------------------------------------------------------------
// Core event topics (published on standard event bus)
// ---------------------------------------------------------------------------

export const CORE_TOPICS = {
  USER_ONLINE: "core.user.online",
  USER_OFFLINE: "core.user.offline",
  USER_UPDATED: "core.user.updated",
  USER_DELETED: "core.user.deleted",
  MEMBER_JOINED: "core.member.joined",
  MOD_BANNED: "core.moderation.banned",
  MOD_UNBANNED: "core.moderation.unbanned",
  CATEGORY_CREATED: "core.category.created",
  CATEGORY_UPDATED: "core.category.updated",
  CATEGORY_DELETED: "core.category.deleted",
  CATEGORY_REORDERED: "core.category.reordered",
  PERMISSION_CHANGED: "core.permission.changed",
  /** Phase 01 §8/§12: orchestrator-driven runtime update lifecycle.
   *  Payload is the full `RuntimeUpdateState` shape. D4 visibility-universal —
   *  every connected client receives this; only the install action is gated by
   *  the `core.runtime.update` permission. */
  RUNTIME_UPDATE_STATE_CHANGED: "core.runtime.update_state_changed",
  /** Two-stage handshake: a plugin that opted in via
   *  `serve_ready_handshake: true` has finished its post-spawn initialization
   *  and is ready to serve user-facing requests. Payload:
   *  `{ slug: string; ready: boolean }`. The web client uses this to flip
   *  greyed-out sidebar items (with a loading spinner) into clickable rows. */
  RUNTIME_PLUGIN_READY: "runtime.plugin.ready",
} as const;

export type CoreTopic = (typeof CORE_TOPICS)[keyof typeof CORE_TOPICS];

// ---------------------------------------------------------------------------
// Runtime update lifecycle (Phase 01 §8/§12)
// ---------------------------------------------------------------------------
// Promoted into the protocol package so every consumer (runtime, desktop
// orchestrator, website renderer, central heartbeat) speaks the same shape
// without copying the file. The runtime side keeps a thin re-export from
// runtime/src/update-state/types.ts for backwards compatibility with existing
// imports, plus its own `defaultUpdateState` factory.

export type RuntimeUpdateStatus =
  | "disabled"
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "pending-confirm"
  | "backing-up"
  | "downloading"
  | "downloaded"
  // Sits between `downloaded` and `installing`. The orchestrator has the new
  // image cached + verified and will not progress to the irreversible install
  // phase until the user clicks "Restart to apply" (delivered via a separate
  // confirm channel). Hard-pause: the runtime can sit here indefinitely.
  | "awaiting-restart"
  | "installing"
  | "rolling-back"
  | "error";

export type RuntimeUpdateChannel = "stable" | "test" | "dev";

export type RuntimeUpdateErrorContext =
  | "check"
  | "backup"
  | "download"
  | "install"
  | "rollback"
  | null;

export interface RuntimeUpdateState {
  state: RuntimeUpdateStatus;
  errorContext: RuntimeUpdateErrorContext;
  /** Matches process.env.RUNTIME_VERSION at write time. */
  currentVersion: string;
  availableVersion: string | null;
  channel: RuntimeUpdateChannel;
  /** 0..100, 10% buckets. null when not in a downloading state. */
  progress: number | null;
  /** Epoch ms; null until the orchestrator runs its first check. */
  lastCheckedAt: number | null;
  /** One-line, user-safe error description. null when status === "ok"-ish. */
  errorMessage: string | null;
  /** Epoch ms; written by the runtime on every persist. */
  updatedAt: number;
  /** Optional one-line phase detail surfaced to the operator UI, e.g.
   *  "Pulling layer 4/8" during downloading or "Draining traffic" during
   *  installing. Older runtimes won't set it; the renderer treats both
   *  undefined and null as "no substep — just show the phase label". */
  substep?: string | null;
}

// ---------------------------------------------------------------------------
// Core event payloads (what lands in EventBus envelope.payload)
// ---------------------------------------------------------------------------

export interface CoreUserOnlinePayload {
  id: string;
  username: string;
  display_name: string;
  avatar_url: string;
  is_online: boolean;
  connected_at: number;
  last_seen_at: number;
}

export interface CoreUserOfflinePayload {
  id: string;
  is_online: boolean;
  last_seen_at: number;
}

export interface CoreUserUpdatedPayload {
  id: string;
  username: string;
  display_name: string;
  avatar_url: string;
}

export interface CoreUserDeletedPayload {
  id: string;
}

export interface CoreCategoryCreatedPayload {
  category: CoreCategory;
}

export interface CoreCategoryUpdatedPayload {
  category: CoreCategory;
}

export interface CoreCategoryDeletedPayload {
  id: string;
}

export interface CoreCategoryReorderedPayload {
  /** All categories in their new positions, ordered by position ascending. */
  categories: CoreCategory[];
}

// ---------------------------------------------------------------------------
// Roles + permissions (spec-22 Amendment B)
// Wire shape returned by core.role.* and core.permissions.* IPC actions.
// Field names match runtime/src/roles/types.ts (camelCase) — these go straight
// to the wire via the response envelope without remapping.
// ---------------------------------------------------------------------------

export interface CoreRole {
  id: number;
  name: string;
  level: number;
  isDefault: boolean;
  parentRole: number | null;
  createdAt: number;
  updatedAt: number;
  /**
   * Optional per-role explicit overrides, keyed by permission `key`. Returned
   * by `core.role.list` for the permission matrix; **not** included in
   * `core.role.create`/`update` responses (those return the bare role row).
   *
   * Shape mirrors the `role_permissions` table in `runtime/src/roles/migrations`:
   * one entry per (role, permission) where the role has explicitly granted
   * (`granted: true`) or denied (`granted: false`) the permission. Absence
   * means "inherit from default_level."
   */
  overrides?: Array<{ permission: string; granted: boolean }>;

  /**
   * Number of users explicitly assigned to this role via `user_roles`.
   * Returned by `core.role.list` for the matrix header. Members who have
   * never been assigned (and therefore fall back to the default `member`
   * role implicitly) are NOT counted here — display the implicit fallback
   * count separately if you need it.
   *
   * Optional because `core.role.create`/`update` responses return the bare
   * role row without joining the count.
   */
  memberCount?: number;
}

export interface CorePermission {
  id: number;
  key: string;
  description: string;
  defaultLevel: number;
  pluginSlug: string;
  registeredAt: number;
}

/**
 * Response shape of `core.member.me` — caller's own role context.
 * `is_owner: true` implies a virtual level of 100; the role row is not read
 * and `role_id` is null.
 *
 * `role_id` lets the client look up the caller's role row in `rolesStore` so
 * `useHasPermission` can honour explicit grant/deny overrides — without it
 * the hook can only consult `level >= permission.default_level`, which
 * disagrees with the runtime when an override is set.
 */
export interface CoreMemberMe {
  user_id: string;
  is_owner: boolean;
  level: number;
  role_name: string;
  role_id: number | null;
}

/**
 * One row of `core.permissions.audit`. Mirrors the SQLite column layout
 * because the runtime returns it raw — no camelCase remap.
 */
export interface CorePermissionAuditEntry {
  id: number;
  ts: number;
  actor_user_id: string;
  target_role_id: number | null;
  permission: string;
  /** "grant" | "deny" | "remove" — kept open for forward-compat. */
  action: string;
  reason: string | null;
}

/**
 * One change in a `core.permissions.grantMany` request. Reasons are trimmed
 * server-side and dropped if empty.
 */
export interface CorePermissionChange {
  permission: string;
  op: "grant" | "deny" | "remove";
  reason?: string;
}

/**
 * Per-change rejection from `core.permissions.grantMany`. The bulk action has
 * partial-failure semantics: a malformed or forbidden change is recorded here
 * and the rest of the batch still applies.
 */
export interface CorePermissionGrantManySkipped {
  permission: string;
  code: string;
  message: string;
}

export interface CorePermissionGrantManyResponse {
  applied: number;
  skipped: CorePermissionGrantManySkipped[];
}

/**
 * Discriminated union of `core.permission.changed` event payloads.
 * The shape is fully determined by `action`. UI listeners should switch on
 * `action` to decide which slice of state to invalidate.
 */
export type CorePermissionChangedPayload =
  | { action: "core.role.create"; role_id: number }
  | { action: "core.role.update"; role_id: number }
  | { action: "core.role.delete"; role_id: number }
  | { action: "core.role.assign"; user_id: string; role_id: number }
  | { action: "core.role.remove"; user_id: string }
  | { action: "core.permissions.grant"; role_id: number; permission: string }
  | { action: "core.permissions.deny"; role_id: number; permission: string }
  | { action: "core.permissions.remove"; role_id: number; permission: string };

/**
 * Known runtime error codes from the role/permissions surface. Surfaced in the
 * response envelope's `error.code` field. Kept as a union of string literals
 * (not an enum) so the type stays open for forward-compat — unknown codes
 * still type-check as `string`.
 */
export type CoreErrorCode =
  | "FORBIDDEN"
  | "CORE_UNAVAILABLE"
  | "RATE_LIMITED"
  | "HIERARCHY_VIOLATION"
  | "ROLE_NOT_FOUND"
  | "PERMISSION_NOT_FOUND"
  | "ROLE_NAME_TAKEN"
  | "DEFAULT_ROLE_PROTECTED"
  | "INVALID_LEVEL"
  | "SELF_DEMOTION_BLOCKED"
  | "OWNER_ROLE_NOT_ASSIGNABLE"
  | "core/invalid_params"
  | "core/not_found";
