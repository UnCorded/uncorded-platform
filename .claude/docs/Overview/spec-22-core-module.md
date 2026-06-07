---
vision: "Central knows nothing beyond 'this server exists at this URL'"
tenet: "Every feature is a choice — except the foundation everything else stands on"
depends-on: [spec-03-server-container, spec-04-plugin-architecture, spec-06-authentication, archive/19-workspace-layout]
last-verified: 2026-04-15
---

# 22 — Core Module

*The always-on runtime module that owns user profiles, presence, and workspace layout persistence. Not a plugin. Cannot be disabled. Provides the guaranteed foundation every plugin can depend on.*

---

## Why This Exists

Plugins are opt-out by design. That works for features — text channels, moderation, polls. It breaks down for infrastructure that other plugins depend on.

Two problems forced this design:

**Profile data can't live in an opt-out plugin.** If `display_name` and `avatar_url` live in the Members plugin, every plugin that renders a user's name or avatar breaks when Members is disabled. The Members plugin is useful, but it shouldn't be mandatory just because text-channels needs to know who wrote a message.

**Workspace layouts can't live in an opt-out plugin.** The panel workspace is platform infrastructure — it belongs to the shell, not to any plugin. Persisting it in a plugin's database means the shell's layout can disappear when a plugin is toggled. That's the wrong model.

The Core Module is the answer: a runtime-built-in module that sits alongside the roles/permissions engine, is initialized unconditionally at boot, and provides guaranteed-available data and APIs to every plugin on the server.

---

## What the Core Module Is

The Core Module is **not a plugin**. It has no manifest, no subprocess, no `plugin_settings` row. It is a TypeScript module in `runtime/src/core/` that:

- Initializes during the server boot sequence, before any plugin loads
- Adds its tables to `core.db` via its own numbered migration files
- Handles a defined set of IPC action types, routed to it by the runtime
- Exposes data to plugins via new `sdk.core.*` methods
- Publishes events onto the existing event bus

Server owners cannot disable it. It does not appear in the plugin manager. It is infrastructure, like the TCP stack.

---

## Locked Decisions

- **Profile data lives in the Core Module.** `display_name`, `avatar_url`, and `last_seen_at` live in `core.db`. No plugin owns this data.
- **Members and Moderation are not plugins.** The `members` and `moderation` plugins are removed. Member management (join history, member list, presence) and moderation (bans, audit log) are Core Module built-ins. Their management UI lives in the shell's server settings sheet, not in plugin iframes.
- **Workspace layouts live in the Core Module.** The core runtime DB stores one layout blob per `(user_id, server_id)` and one server default layout blob per `server_id`.
- **The workspace uses a split tree, not a grid.** See Layout Model below.
- **Presence is derived from live WS connections.** `is_online` is not stored durably — it is set to `true` on WS auth and cleared on WS close. The runtime already owns the connection map; presence is a thin projection of it.
- **Core Module data is accessible to all plugins** via `sdk.core.*` methods. No capability declaration required — every plugin gets it.
- **Core Module events are published to the standard event bus.** Plugins subscribe the same way they subscribe to any event.

---

## Core Database Tables

All tables live in `core.db` (at `/data/core.db`). Migrations live in `runtime/src/core/migrations/`.

### `users` — profile cache

```sql
CREATE TABLE users (
  id           TEXT PRIMARY KEY,
  display_name TEXT NOT NULL DEFAULT '',
  avatar_url   TEXT NOT NULL DEFAULT '',
  is_online    INTEGER NOT NULL DEFAULT 0 CHECK (is_online IN (0, 1)),
  last_seen_at INTEGER NOT NULL DEFAULT 0,
  connected_at INTEGER NOT NULL DEFAULT 0
);
```

Populated from JWT claims (`display_name`, `avatar_url`) on every successful WS auth. Updated on reconnect — always reflects the most recent token. `is_online` is set to `1` on connect and `0` on disconnect. `last_seen_at` is updated on every connect and disconnect.

This is a **cache**, not a source of truth. Central is the authoritative source for `display_name` and `avatar_url`. The runtime keeps it current via two mechanisms:

1. Every WS auth upserts the row from the JWT claims.
2. The `runtime.cascade.user.profile_changed` event (emitted by the heartbeat when Central reports a profile change) updates the row.

### `members` — join history

```sql
CREATE TABLE members (
  id        TEXT PRIMARY KEY,
  joined_at INTEGER NOT NULL
);
```

One row per user who has ever authenticated on this server. `joined_at` is the timestamp of first connection. Never updated after insert — it is a historical record. `id` joins to `users.id` for display names and presence.

### `bans` — active bans

```sql
CREATE TABLE bans (
  user_id   TEXT PRIMARY KEY,
  banned_by TEXT NOT NULL,
  banned_at INTEGER NOT NULL,
  reason    TEXT NOT NULL DEFAULT ''
);
```

A user with a row in this table is banned. The runtime checks this table during WS auth and rejects connections from banned users. `banned_by` is the actor's user ID.

### `audit_log` — moderation history

```sql
CREATE TABLE audit_log (
  id         TEXT PRIMARY KEY,
  action     TEXT NOT NULL,
  actor_id   TEXT NOT NULL,
  target_id  TEXT,
  details    TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
```

Append-only. Every Core Module moderation action writes a row. `action` values: `ban`, `unban`, `kick`. `details` is a JSON object (e.g. `{ "reason": "spam" }`). Never deleted — audit logs are permanent.

### `workspace_layouts` — per-user layout persistence

```sql
CREATE TABLE workspace_layouts (
  user_id    TEXT NOT NULL,
  layout_json TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id)
);
```

One row per user. Stores the full workspace layout as a JSON blob (see Layout Model). Fetched by the shell on server connect. Saved on user layout changes (debounced — not on every drag event, see Persistence below).

### `server_default_layout` — owner-set starting layout

```sql
CREATE TABLE server_default_layout (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  layout_json TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);
```

Single-row table (enforced by `CHECK (id = 1)`). Set by the server owner via the admin panel. Applied as the starting layout for users who have no saved layout. Never overwritten by user activity.

---

## Layout Model

The workspace uses a **recursive binary split tree**, not a grid.

```ts
type PanelNode =
  | { type: "leaf"; id: string }
  | { type: "split"; id: string; direction: "horizontal" | "vertical"; ratio: number; first: PanelNode; second: PanelNode };

interface WorkspaceLayout {
  version: number;
  root: PanelNode;
  panels: Record<string, PanelContent>;  // leafId → content
}

interface PanelContent {
  type: "channel";
  serverId: string;
  tunnelUrl: string;
  slug: string;
  channelId: string;
  channelName: string;
  channelType: "text" | "voice";
}
```

**Why split tree, not grid:** The split tree matches how users think about arranging chat panels — "put this channel next to that one," "split this panel in half." Grids are better for dashboards with precise pixel control. The current shell implementation uses a split tree and it works well. The grid model specified in `archive/19-workspace-layout.md` is superseded by this document.

**Ratio:** Each split node has a `ratio` (0.0–1.0, clamped to 0.15–0.85 in the UI) representing the size of `first` relative to the total. Stored in the layout blob. Survives round-trips.

**Panel IDs:** Leaf IDs are stable random strings generated at split time. They are used as the key in `panels` to look up what content is loaded. IDs survive serialization and cross-device sync.

---

## Lifecycle

### On WS auth (user connects)

1. Check `bans` table — reject with `403` if user is banned.
2. Upsert the `users` row from JWT claims (`id`, `display_name`, `avatar_url`).
3. Set `is_online = 1`, `connected_at = now`, `last_seen_at = now`.
4. Insert into `members (id, joined_at)` if not already present (first-time join).
5. Publish `core.user.online` event.

### On WS close (user disconnects)

1. Set `is_online = 0`, `last_seen_at = now` in the `users` row.
2. Publish `core.user.offline` event.

### On `runtime.cascade.user.profile_changed`

1. Update `display_name` and `avatar_url` in the `users` row.
2. Publish `core.user.updated` event so plugins can refresh cached display names.

### On `runtime.cascade.user.deleted`

1. Update the `users` row: set `display_name = '[deleted]'`, `avatar_url = ''`.
2. Publish `core.user.deleted` event.

---

## SDK Surface

New `sdk.core` namespace available to all plugins with no capability declaration required.

```ts
interface CoreApi {
  /** Get a single user's profile from the cache. Returns null if user has never connected. */
  getUser(userId: string): Promise<CoreUser | null>;

  /** Get multiple users' profiles in one call. Missing users are omitted from the result. */
  getUsers(userIds: string[]): Promise<CoreUser[]>;

  /** Get all currently online users. */
  getOnlineUsers(): Promise<CoreUser[]>;

  /** Get all users who have ever joined (join history). */
  listMembers(): Promise<CoreMember[]>;
}

interface CoreUser {
  id: string;
  display_name: string;
  avatar_url: string;
  is_online: boolean;
  last_seen_at: number;
}

interface CoreMember {
  id: string;
  display_name: string;
  avatar_url: string;
  is_online: boolean;
  last_seen_at: number;
  joined_at: number;
}
```

`sdk.core` is implemented as a thin IPC wrapper — it sends a `core.*` action type to the runtime, which handles it synchronously (direct SQLite read, no subprocess hop).

## Core Management IPC Actions

These actions are handled directly by the runtime Core Module. They are invoked by the **shell** (not plugins) via the same IPC channel, gated by the caller's role level.

| Action | Min role | Description |
|---|---|---|
| `core.member.list` | Member (10) | Returns all members with profile + joined_at + is_online |
| `core.ban.create` | Moderator (60) | Bans a user. Params: `{ user_id, reason? }`. Writes to `bans` + `audit_log`. Disconnects active session. |
| `core.ban.delete` | Moderator (60) | Removes a ban. Params: `{ user_id }`. Writes to `audit_log`. |
| `core.ban.list` | Moderator (60) | Returns all active bans |
| `core.audit.list` | Moderator (60) | Returns audit log entries. Params: `{ limit?, offset? }` |

The shell calls these actions the same way plugins do — via the authenticated WebSocket. Role enforcement is in the runtime, not the client.

### Amendment A - Permissions Management UI and IPC (2026-05-06)

The shell's Members settings surface grows a role and permission-management workflow backed by the runtime roles engine. This is role-scoped in Phase 2: each user has exactly one role, and permission overrides are stored on roles. There are no per-user permission overrides in this amendment.

**Meta-permission.** The named permission is `core.permissions.manage`, registered under the synthetic `core` plugin slug with `default_level = 100`. Owners hold it by bypass. Non-owners may manage roles and permissions only when they hold this permission through their role level or an explicit role override. This replaces hardcoded owner-only permission mutation gates while preserving bootstrap safety: only owners receive it by default.

**Who can edit whom.** Runtime enforcement is authoritative. The UI may hide unreachable controls, but the IPC handlers must fail closed and delegate hierarchy checks to `RolesEngine`:

- A caller cannot create, update, delete, assign, or remove a role at or above the caller's effective level.
- A caller cannot change a target member whose current role level is at or above the caller's effective level.
- Default roles cannot be renamed, re-leveled, or deleted.
- Permission grants and denies require both `core.permissions.manage` and the permission being granted or denied. This prevents a delegated admin from handing out a permission they do not already hold.

**Shell IPC surface.** The authenticated WS client path (`plugin: "core"`) exposes:

| Action | Gate | Description |
|---|---|---|
| `core.role.list` | `core.permissions.manage` | Returns all roles ordered by level descending. |
| `core.role.create` | `core.permissions.manage` | Params: `{ name, level }`. Returns `{ role }`. |
| `core.role.update` | `core.permissions.manage` | Params: `{ role_id, name?, level? }`. Returns `{ role }`. |
| `core.role.delete` | `core.permissions.manage` | Params: `{ role_id }`. Reassigns affected users to `member` via the engine. |
| `core.role.assign` | `core.permissions.manage` | Params: `{ user_id, role_id }`. Replaces the user's current role. |
| `core.role.remove` | `core.permissions.manage` | Params: `{ user_id }`. Removes the explicit role so the user falls back to `member`. |
| `core.permissions.list` | `core.permissions.manage` | Returns registered permissions for grouping by `plugin_slug`. |
| `core.permissions.grant` / `deny` / `remove` | `core.permissions.manage` | Mutates a role-scoped permission override. Params: `{ role_id, permission, reason? }`. |
| `core.permissions.audit` | `core.permissions.manage` | Returns permission audit rows. Params: `{ limit?, offset? }`. |

**Realtime refresh.** Successful role assignment/removal, role update/delete, and permission override mutations broadcast `core.permission.changed` to connected shell clients. Clients treat the event as an invalidation signal and refetch members, roles, and permissions rather than attempting to patch local authority state.

**Audit UX.** Permission override mutations write to `permission_audit` with actor, target role, permission key, action, timestamp, and optional reason. The UI exposes this as an audit tab in the same management surface. Role CRUD and assignment audit may later move into the same stable schema, but this amendment only requires the existing permission audit log for permission grants/denies/removes.

**Member-row overlay.** The first UI should be per-member entry, but the permission section must explicitly state the role being edited and that changes apply to all members with that role. If the shell shows "Per-Plugin Permissions" while opened from a member row, it is editing the member's current role permissions, not private user overrides.

### Amendment B - Storage Schema, Wire Payloads, and UI Layout (2026-05-06)

Amendment A defined the IPC surface and UX intent for permission management. Amendment B ratifies the storage schema (already in code but absent from this spec), nails down the `core.permission.changed` wire payload, locks the UI layout decisions made before frontend implementation, and commits to several production-grade backend changes.

**Storage schema.** The `roles`, `user_roles`, `role_permissions`, and `permission_audit` tables live alongside the Core Module tables in `core.db`. Migrations live in `runtime/src/roles/migrations/` (separate directory from `runtime/src/core/migrations/` because the roles engine is its own subsystem).

```sql
-- roles/migrations/001_create_tables.sql
CREATE TABLE roles (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL UNIQUE,
  level       INTEGER NOT NULL CHECK (level >= 1 AND level <= 100),
  is_default  INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  parent_role INTEGER REFERENCES roles(id) ON DELETE SET NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE user_roles (
  user_id TEXT    NOT NULL,
  role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_id)
);

CREATE TABLE permissions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  key           TEXT    NOT NULL UNIQUE,
  description   TEXT    NOT NULL DEFAULT '',
  default_level INTEGER NOT NULL CHECK (default_level >= 0 AND default_level <= 100),
  plugin_slug   TEXT    NOT NULL,
  registered_at INTEGER NOT NULL
);

CREATE TABLE role_permissions (
  role_id       INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id INTEGER NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  granted       INTEGER NOT NULL DEFAULT 1 CHECK (granted IN (0, 1)),
  PRIMARY KEY (role_id, permission_id)
);

-- roles/migrations/004_permission_audit.sql
CREATE TABLE permission_audit (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ts             INTEGER NOT NULL,
  actor_user_id  TEXT    NOT NULL,
  target_role_id INTEGER,
  permission     TEXT    NOT NULL,
  action         TEXT    NOT NULL CHECK (action IN ('grant', 'deny', 'remove')),
  reason         TEXT
);
CREATE INDEX idx_permission_audit_ts   ON permission_audit(ts DESC);
CREATE INDEX idx_permission_audit_role ON permission_audit(target_role_id);
```

**Tri-state model.** Permission state for `(role, permission)` is represented by the presence/absence of a `role_permissions` row plus its `granted` flag:

| State | `role_permissions` row | Effective rule |
|---|---|---|
| `inherit` | absent | Allowed iff `permission.default_level ≤ role.level` |
| `grant` | present, `granted = 1` | Always allowed for this role |
| `deny` | present, `granted = 0` | Always denied for this role |

The check order in `RolesEngine.check()` (`runtime/src/roles/engine.ts:410`) is: owner bypass → explicit override → fall-through to default_level. Owner bypass cannot be overridden by a deny.

**Default-role overrides allowed.** The four default roles (owner, admin, moderator, member) accept `role_permissions` rows just like custom roles. Server owners may grant additional permissions to default roles or deny default-allowed permissions. The only operations forbidden on default roles are rename, re-level, and delete (`is_default = 1` is enforced in `runtime/src/roles/engine.ts:189` and `:234`).

**Owner role assignment.** The `owner` role is Central-bound. The runtime trusts `JwtPayload.is_owner` as the authoritative owner signal; the `owner` row in `roles` exists for level/permission lookup but membership in it is **not** assignable through `core.role.assign`. The handler refuses any assignment whose target role is `is_default = 1 AND name = 'owner'`. Ownership transfer goes through Central, not the runtime.

**Self-demotion blocked.** A caller cannot change their own role through `core.role.assign` or `core.role.remove`. The handler refuses any mutation where `params.user_id === callerCtx.userId`. Owners (who would be the realistic case for "demote me") cannot self-demote because the owner role itself is non-assignable; non-owners are blocked by the symmetric handler check. A user who needs to step down as owner does so through Central reassigning ownership.

**`core.permission.changed` wire payload.** The event is a discriminated union keyed on `action`. The full schema:

```ts
type CorePermissionChangedPayload =
  | { action: "core.role.create";        role_id: number }
  | { action: "core.role.update";        role_id: number }
  | { action: "core.role.delete";        role_id: number }
  | { action: "core.role.assign";        role_id: number; user_id: string }
  | { action: "core.role.remove";        user_id: string }
  | { action: "core.permissions.grant";  role_id: number; permission: string }
  | { action: "core.permissions.deny";   role_id: number; permission: string }
  | { action: "core.permissions.remove"; role_id: number; permission: string };
```

This payload type lives in `packages/protocol/src/core.ts` so both runtime and shell import the same definition. Clients should treat the payload as an invalidation hint and refetch — they may use `role_id` / `user_id` to scope refetches but must not patch local authority state from the payload alone.

**`core.member.list` pagination.** The handler grows `{ limit?: number, offset?: number, cursor?: string }` parameters. `limit` defaults to 200 and is clamped to a maximum of 500. The response gains a `next_cursor` field which is null when fully drained. Callers without paging fields receive the first page only — the legacy "return all members" behavior is removed because it does not survive at scale. The schema change is non-breaking for the existing read-only members panel because the panel will be migrated to the new wrapper in PR 2.

**Bulk permission RPC.** A new `core.permissions.grantMany` action lets the matrix UI commit a set of overrides in one round trip:

```ts
core.permissions.grantMany {
  role_id: number,
  changes: Array<{ permission: string, op: "grant" | "deny" | "remove", reason?: string }>
}
→ { applied: number, skipped: Array<{ permission: string, code: string, message: string }> }
```

Each change runs through `assertGrantSafe` and the engine's hierarchy check independently; failed changes are reported in `skipped` while successful ones still apply. A single `core.permission.changed` broadcast is fanned out per successful change; clients must debounce the resulting refetch.

**Fail-fast migration assertion.** During boot, after migrations run, the runtime asserts that every expected table exists in `core.db`. The expected list lives next to the migrations:

```ts
// runtime/src/db/expected-tables.ts
export const EXPECTED_TABLES = [
  // core
  "users", "members", "bans", "audit_log", "workspace_layouts", "server_default_layout",
  // roles
  "roles", "user_roles", "permissions", "role_permissions", "permission_audit",
];
```

If any table is missing, the runtime logs a structured error and refuses to accept connections. A half-migrated server cannot silently lose audit rows.

**Administration tab.** The shell server-settings sheet renames the existing `moderation` tab to `administration` (label "Administration"). The tab contains three sub-tabs:

1. **Bans** — current ban list and create/delete (existing surface, moved verbatim).
2. **Roles** — role CRUD plus the per-role permission matrix grouped by `plugin_slug`. The matrix shows `inherit | grant | deny` as a three-button segmented control per permission row. The header shows the role name and "Applies to N members" so the editor knows the scope.
3. **Audit** — unified view over `audit_log` (moderation actions) and `permission_audit` (permission changes), filterable by source. Backed by `core.audit.list` and `core.permissions.audit`.

Member role assignment is **not** in this tab. Per-member role changes happen in a focused `member-manage-sheet` opened from a "Manage member" button on the user card (`apps/website/src/components/user-card-sheet.tsx`). The button is gated by `core.permissions.manage` and hidden otherwise. Hierarchy is enforced authoritatively by the runtime; the UI hides unreachable roles from the dropdown as a convenience.

**Optimistic UI on the matrix.** The permission matrix may apply changes optimistically with reconcile-on-event semantics: local toggle flips immediately, mutation is sent, on success the local state is reconciled against the eventual `core.permission.changed` broadcast, on `HIERARCHY_VIOLATION` or `FORBIDDEN` the local state is rolled back and the backend message is surfaced as a toast. Optimistic UI is restricted to the matrix; member assignment, role CRUD, and bans use refetch-after-success.

### Migration path for existing plugins

**text-channels:** Replace `plugin.data.read('members', 'members')` with `sdk.core.getUsers(authorIds)`. Remove `data.read:members.members` from manifest permissions.

**members plugin:** Deleted. All functionality absorbed into Core Module + shell UI.

**moderation plugin:** Deleted. All functionality absorbed into Core Module + shell UI.

---

## Events

Published on the standard event bus. Any plugin can subscribe.

| Topic | Payload | When |
|---|---|---|
| `core.user.online` | `{ id, display_name, avatar_url, connected_at }` | User WS auth succeeds |
| `core.user.offline` | `{ id, last_seen_at }` | User WS connection closes |
| `core.user.updated` | `{ id, display_name, avatar_url }` | Profile changed via cascade |
| `core.user.deleted` | `{ id }` | Account deleted via cascade |
| `core.member.joined` | `{ id, display_name, avatar_url, joined_at }` | First-time join recorded |
| `core.moderation.banned` | `{ user_id, banned_by, reason }` | User banned |
| `core.moderation.unbanned` | `{ user_id, actor_id }` | Ban lifted |

---

## Workspace HTTP Endpoints

New endpoints on the runtime HTTP server. All require valid JWT auth (level ≥ 10, i.e. any member).

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/workspace/layout` | Member | Fetch the calling user's saved layout. Returns the server default if no user layout exists, or the platform default if neither exists. |
| `PUT` | `/workspace/layout` | Member | Save the calling user's layout. Body: `{ layout: WorkspaceLayout }`. Debounce is client-side — the server saves every PUT. |
| `GET` | `/workspace/default` | Member | Fetch the server's default layout. |
| `PUT` | `/workspace/default` | Admin (level ≥ 80) | Set the server's default layout. Body: `{ layout: WorkspaceLayout }`. |

---

## Impact on Existing Docs

| Doc | What changes |
|---|---|
| `archive/19-workspace-layout.md` | Grid model superseded by split tree. Layout persistence model unchanged (still core DB, still per-user). |
| `spec-04-plugin-architecture.md` | Core Module added as a fourth tier below Core/Standalone/Extension — "Runtime Built-in." Members plugin updated from profile owner to UI layer. |
| `spec-06-authentication.md` | WS auth sequence gains a step: upsert Core Module `users` row. |

---

## Members and Moderation Plugin Removal

The `members` and `moderation` plugins are removed entirely. They are not replaced with equivalents — their functionality is absorbed into Core Module and the shell.

**Why:** Members and Moderation are not optional features. Every server needs to know who joined and every server needs to be able to ban users. Making them plugins gave them plugin affordances (disableable, iframe viewport, separate subprocess, separate DB) that don't match what they are. Core Module is the correct home for infrastructure every server depends on. The shell settings sheet is the correct UI surface for server management.

**What the shell gains:**
- A Members panel in the server settings sheet (list of all members with join date and online status)
- A Moderation panel in the server settings sheet (active bans + ban/unban form + audit log)

**What plugins gain:**
- `sdk.core.getUser()`, `sdk.core.getUsers()`, `sdk.core.getOnlineUsers()` — profile + presence data available with no capability declaration needed
- `sdk.core.listMembers()` — **Deferred.** No Phase 1 plugin needs this; the shell's members UI uses the WS-client path (`core.member.list` via `handleCoreClientAction`) which is already implemented. Add the SDK method + `handleCoreIpc` subprocess branch together when the first plugin caller lands, so the SDK and runtime stay in lockstep.

---

## Phase Scope

| Feature | Phase |
|---|---|
| Core Module boot initialization | Phase 2 |
| `users` profile cache + presence events | Phase 2 |
| `members` join history table | Phase 2 |
| `bans` + `audit_log` tables | Phase 2 |
| `sdk.core.getUser` / `getUsers` / `getOnlineUsers` / `listMembers` | Phase 2 |
| Core management IPC actions (`core.ban.create/delete/list`, `core.audit.list`) | Phase 2 |
| Shell: Members panel in server settings sheet | Phase 2 |
| Shell: Moderation panel in server settings sheet | Phase 2 |
| Remove `plugins/members/` and `plugins/moderation/` | Phase 2 |
| Migration: text-channels uses `sdk.core` instead of `data.read:members` | Phase 2 |
| Workspace layout persistence (save/load endpoints) | Phase 2 |
| Server default layout (admin set/get) | Phase 2 |
| Per-user workspace sync across devices | Phase 2 (automatic — server-side storage) |
| Server owner locked panels | Phase 2 |
| Plugin-suggested sibling panels | Phase 3 |

---

## Future Refinements

- **Plugin config surface** — server owners setting per-plugin configuration (e.g. max message length in text-channels) is a separate concern not covered here. It requires a manifest `config` schema, a `plugin_config` table in core DB, and `sdk.core.getConfig()`. Tracked as `[TBD-plugin-config]` in `status-open-questions.md`.
- **Cross-device workspace sync notifications** — if a user has two devices open simultaneously, a layout change on one should propagate to the other. The mechanism (push via existing WS or polling on focus) is deferred to Phase 3.
- **Presence granularity** — `is_online` is binary. Future phases could add idle state, platform (desktop vs web), or per-server status messages.

---

## Relationship to Other Docs

- `spec-03-server-container.md` — `core.db` location and ownership
- `spec-04-plugin-architecture.md` — plugin types and SDK surface
- `spec-06-authentication.md` — WS auth sequence that triggers profile upsert
- `archive/19-workspace-layout.md` — workspace layout spec (grid model superseded by this doc's split tree)
