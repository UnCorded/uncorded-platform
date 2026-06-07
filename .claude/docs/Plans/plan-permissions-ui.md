---
plan: permissions-ui
spec: spec-22-core-module.md (Amendments A + B)
created: 2026-05-06
status: in-progress
phase: 2
---

# Plan — Permissions Management UI

Implements Amendment B of `spec-22-core-module.md`. The backend permission/role surface already ships (Amendment A, 2026-05-06). This plan covers the production-grade tests, frontend foundation, and UX surfaces needed to ship the feature.

**Headline:** the runtime IPC is built. The work here is verification + frontend + the few backend additions Amendment B commits to (pagination, bulk RPC, fail-fast migration assertion).

---

## Decision log

| ID | Decision | Source |
|---|---|---|
| Q1 | Self-demotion blocked; ownership transfer goes through Central. UI hides the owner role from the assignment dropdown for the actor. | Amendment B, "Self-demotion blocked" |
| Q2 | Default roles (admin/moderator/member) accept permission overrides; the only forbidden ops are rename/re-level/delete. | Amendment B, "Default-role overrides allowed" |
| D1 | Manage entry point is a new dedicated sheet (`member-manage-sheet.tsx`), opened from a Manage button on `user-card-sheet.tsx`. | Amendment B, "Administration tab" |
| D2 | Tri-state UI is a three-button segmented control per permission row (inherit / grant / deny). | Amendment B, "Administration tab" |
| D3 | Existing `moderation` tab renamed to `administration` with three sub-tabs: Bans, Roles, Audit. | Amendment B, "Administration tab" |
| D4 | Optimistic UI applies only to the permission matrix; everything else uses refetch-after-success. | Amendment B, "Optimistic UI on the matrix" |
| Bx | `core.member.list` gains pagination (limit ≤ 500, default 200, opaque cursor). | Amendment B, "core.member.list pagination" |
| By | New `core.permissions.grantMany` bulk RPC for matrix commits. | Amendment B, "Bulk permission RPC" |
| Bz | Fail-fast startup assertion that all expected tables exist. | Amendment B, "Fail-fast migration assertion" |
| Audit retention | Keep all rows; revisit only if a server reports bloat. | Discussion 2026-05-06 |
| Broadcast amplification | Frontend 200ms debounce on `core.permission.changed` refetch. | Discussion 2026-05-06 |
| JWT `is_owner` reauth | Out of scope for this plan; tracked separately. | Discussion 2026-05-06 |

---

## Files in scope

**Backend (read-only confirmation, no rewrites):**
- `C:\Users\jusss\projects\uncorded\platform\runtime\src\core\ipc.ts` — `handleCoreClientAction` already implements every `core.role.*` and `core.permissions.*` action (lines 148–567).
- `C:\Users\jusss\projects\uncorded\platform\runtime\src\core\permissions.ts` — `requirePermission` (line 24) and `assertGrantSafe` (line 54) already implement the named-permission gate and grant-safety guard.
- `C:\Users\jusss\projects\uncorded\platform\runtime\src\roles\engine.ts` — `RolesEngine` already implements role CRUD, hierarchy enforcement (`getCallerLevel` line 501, comparisons at 196/244/272/278/297/388/526), `check()` (line 410), `canActOn()` (line 447), `recordPermissionAudit()` (line 460), `listPermissionAudit()` (line 473).
- `C:\Users\jusss\projects\uncorded\platform\runtime\src\core\permission-seeds.ts` — `core.permissions.manage` seeded at `default_level = 100` (line 32–35).
- `C:\Users\jusss\projects\uncorded\platform\packages\protocol\src\core.ts` — `CORE_TOPICS.PERMISSION_CHANGED` (line 205).

**Backend (additions):**
- `C:\Users\jusss\projects\uncorded\platform\runtime\src\core\dao.ts` — extend `listMembers` for pagination (line 143).
- `C:\Users\jusss\projects\uncorded\platform\runtime\src\core\ipc.ts` — pagination params on `core.member.list` (line 171); new `core.permissions.grantMany` handler.
- `C:\Users\jusss\projects\uncorded\platform\runtime\src\db\expected-tables.ts` — new file, fail-fast assertion list.
- `C:\Users\jusss\projects\uncorded\platform\runtime\src\main.ts` — call assertion after migrations (around line 459).
- `C:\Users\jusss\projects\uncorded\platform\packages\protocol\src\core.ts` — add `CorePermissionChangedPayload` discriminated union type.
- `C:\Users\jusss\projects\uncorded\platform\runtime\tests\` — new test files (one per concern).

**Frontend (new):**
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\lib\core-client.ts` — typed `coreClient.*` wrapper.
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\stores\permissions.ts` — roles + permissions + audit stores with `core.permission.changed` listener.
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\hooks\use-has-permission.ts` — fine-grained permission hook.
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\components\server\member-manage-sheet.tsx` — new focused sheet.
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\components\server\administration\` — new directory: `index.tsx`, `bans-tab.tsx`, `roles-tab.tsx`, `audit-tab.tsx`, `permission-matrix.tsx`, `role-edit-form.tsx`.

**Frontend (modifications):**
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\components\server\server-settings-sheet.tsx` — rename `moderation` tab to `administration` (line 29 tab definition); replace `MembersSection` row with the new manage entry point; replace `ModerationSection` with `<AdministrationSection>`.
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\components\user-card-sheet.tsx` — add "Manage member" button gated by `useHasPermission("core.permissions.manage")`.
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\stores\membership.ts` — add `core.permission.changed` subscription that refetches `core.member.me` (line 41–51 area).
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\lib\ws.ts` — no change; existing `onPluginMessage` handles the new subscription.

---

## PR 0 — Spec lock (Amendment B)

**Status:** ✅ Done — Amendment B committed to `spec-22-core-module.md`.

Single commit, no code changes. Implementation PRs reference Amendment B by section heading.

---

## PR 1 — Backend tests + small additions

**Goal:** prove the existing runtime is production-grade. Add the three Amendment B backend commitments. Zero changes to existing handler behavior beyond pagination on `core.member.list`.

### 1.1 — Tests against existing engine + IPC

Test files (all under `C:\Users\jusss\projects\uncorded\platform\runtime\tests\`):

| File | Coverage |
|---|---|
| `roles-engine.hierarchy.test.ts` | createRole/updateRole/deleteRole/assignRole/removeRole/grantPermission/denyPermission/removePermissionOverride all reject `level >= callerLevel`. Owner bypass succeeds. Each error returns `HIERARCHY_VIOLATION`. |
| `roles-engine.default-roles.test.ts` | Default roles (`is_default = 1`) cannot be renamed (`updateRole` line 199), re-leveled (line 211), or deleted (line 244). Owner attempts return errors. Permission overrides on default roles **succeed** (Q2 lock). |
| `roles-engine.assign.test.ts` | `assignRole` deletes prior assignment then inserts (single-role model, line 265–291). Self-assignment refused. Assigning the owner role refused. Target user with a higher role level refused (`>= callerLevel` line 278). Emits in-process `PermissionChanged(userId)`. |
| `roles-engine.permission-check.test.ts` | `check()` order: owner bypass → explicit override (granted=1 returns true; granted=0 returns false even if default_level would allow) → fall-through to `default_level`. Missing permission returns false. |
| `roles-engine.audit.test.ts` | grant/deny/remove each write a `permission_audit` row with the right action enum. `reason` nullable + truncated path. `listPermissionAudit(limit, offset)` returns rows DESC by ts. |
| `core-ipc.permissions-manage.test.ts` | `requirePermission("core.permissions.manage")` wraps every role.* and permissions.* handler. Non-owner without the permission gets `FORBIDDEN`. Non-owner with the permission proceeds to the engine. Missing rolesEngine returns `CORE_UNAVAILABLE`. |
| `core-ipc.assert-grant-safe.test.ts` | The escalation regression: actor holds only `core.permissions.manage` (admin level). Attempts `core.permissions.grant` of an arbitrary permission they do not hold → `FORBIDDEN` from `assertGrantSafe`. Attempts grant of `core.permissions.manage` against admin role → `FORBIDDEN` from hierarchy. Attempts grant of `core.permissions.manage` against moderator role → `FORBIDDEN` from `assertGrantSafe` because actor's effective check returns the permission they hold via role override only. |
| `core-ipc.broadcast.test.ts` | Each role.* and permissions.* mutation calls `broadcastEvent(CORE_TOPICS.PERMISSION_CHANGED, payload)` with the exact discriminated-union shape from Amendment B. Failed mutations emit nothing. |
| `core-ipc.canactOn.test.ts` | `canActOn` returns true only when actor.level **strictly** > target.level (line 453). Owner bypass succeeds. Self check returns false (peer). |
| `core-ipc.self-demotion.test.ts` | `core.role.assign` and `core.role.remove` refuse when `params.user_id === callerCtx.userId`. Owner attempt also refused (cannot bypass via owner flag). |

**Bun mock.module note:** per `feedback_bun_mock_module_leak.md`, any `import * as X` for restoration must be spread into a plain object at import time or mocks leak across test files.

### 1.2 — `core.member.list` pagination

`C:\Users\jusss\projects\uncorded\platform\runtime\src\core\dao.ts:143` — extend `listMembers(db)` to `listMembers(db, { limit, offset })`. Append `LIMIT ? OFFSET ?` to the existing JOIN. Add a sibling `countMembers(db)` for the cursor terminator.

`C:\Users\jusss\projects\uncorded\platform\runtime\src\core\ipc.ts:171` — parse `params.limit` (default 200, max 500), `params.offset` (default 0). Return `{ members: [...], total: number, next_cursor: string | null }`. Cursor encoding: `"offset:<N>"` for now (opaque to clients; we can swap to a keyset cursor later without breaking the protocol).

Test: `core-ipc.member-list.pagination.test.ts` — limit clamping, default page size, terminator behavior, total count correctness.

### 1.3 — `core.permissions.grantMany` bulk RPC

`C:\Users\jusss\projects\uncorded\platform\runtime\src\core\ipc.ts` — add new branch alongside the existing `core.permissions.*` handlers (after line 564 closing brace).

Behavior:
- Parse `role_id` (positive integer) and `changes` (array; max 50 entries).
- For each change: run `assertGrantSafe`, then call the engine's `grantPermission` / `denyPermission` / `removePermissionOverride`.
- Successful changes write a `permission_audit` row and broadcast a single `core.permission.changed` event.
- Failed changes do **not** abort the batch; they are collected into `skipped`.
- Response shape: `{ applied: number, skipped: Array<{ permission, code, message }> }`.

Test: `core-ipc.grant-many.test.ts` — partial success path, all-skip path, all-apply path, hierarchy mid-batch, audit row count matches `applied`.

### 1.4 — Fail-fast migration assertion

New file: `C:\Users\jusss\projects\uncorded\platform\runtime\src\db\expected-tables.ts` exporting `EXPECTED_TABLES` (per Amendment B).

New file: `C:\Users\jusss\projects\uncorded\platform\runtime\src\db\assert-tables.ts` — function `assertExpectedTables(db, expected): void` that queries `sqlite_master` and throws a typed error listing missing tables.

`C:\Users\jusss\projects\uncorded\platform\runtime\src\main.ts:~459` — call `assertExpectedTables(db, EXPECTED_TABLES)` after both core and roles migrations have run, before `seedCorePermissions(db)`. Failure = log structured error and `process.exit(1)`.

Test: `db.assert-tables.test.ts` — drops a table, asserts the boot path throws with a clear message naming the missing table.

### Perf budget — PR 1

- All new tests collectively run in < 5 s (`bun test`).
- `core.member.list` page (200 rows) responds in < 20 ms on dev hardware.
- `core.permissions.grantMany` (50 changes) responds in < 80 ms.
- Startup assertion adds < 5 ms to boot.

### Definition of done — PR 1

- `bun typecheck` clean.
- `bun test` clean (no regressions in existing suites).
- New tests cover every row in the table at 1.1.
- Changelog entry for the protocol changes (pagination, grantMany).

---

## PR 2 — Frontend foundation

**Goal:** the data layer everything else stacks on. No user-visible surfaces yet.

### 2.1 — Typed `coreClient.*` wrapper

New file: `C:\Users\jusss\projects\uncorded\platform\apps\website\src\lib\core-client.ts`.

Wraps `request(serverId, "core", action, params)` from `lib/ws.ts:226` into typed namespaces: `coreClient.member.{list, me}`, `coreClient.role.{list, create, update, delete, assign, remove}`, `coreClient.permissions.{list, grant, deny, remove, grantMany, audit}`.

Each method: explicit input/output type; throws typed `CoreError` with the backend `code` field intact so the caller can switch on `HIERARCHY_VIOLATION` vs `FORBIDDEN` etc.

### 2.2 — Stores + listener

New file: `C:\Users\jusss\projects\uncorded\platform\apps\website\src\stores\permissions.ts`.

SolidJS stores:
- `rolesStore` — `[roles, refetchRoles]`
- `permissionsStore` — `[permissions, refetchPermissions]` (registered permissions, grouped by `plugin_slug` lazily by consumers)
- `auditStore` — `[entries, hasMore, loadMore]` (paginated)
- `currentMemberStore` — wraps `core.member.me`; refetched on `core.permission.changed` so role-name and level stay live.

`core.permission.changed` listener: subscribes via `onPluginMessage(serverId, "core", handler)` (`lib/ws.ts:159`). Coalesces invalidations through a 200ms `setTimeout` debounce per (serverId, store) pair to avoid thundering refetch under bulk grants. Per `feedback_solid_patcher_cascade.md`, effects must memoize narrow keys to prevent reactive cascades.

### 2.3 — `useHasPermission` hook

New file: `C:\Users\jusss\projects\uncorded\platform\apps\website\src\hooks\use-has-permission.ts`.

Signature: `useHasPermission(permissionKey: string): Accessor<boolean>`.

Implementation: reads `currentMemberStore` (which carries `is_owner`, `level`, `role_name`) plus `permissionsStore` (for `default_level`) and the role's overrides. Returns `true` for owners. For non-owners: explicit role override wins; otherwise `level >= permission.default_level`.

**Important:** this hook is convenience for hiding controls. The backend is authoritative. UI must always render error toasts for backend `FORBIDDEN`. Per Amendment B, "UI gates are convenience only; runtime is authoritative."

### 2.4 — Member list pagination wiring

`C:\Users\jusss\projects\uncorded\platform\apps\website\src\components\server\server-settings-sheet.tsx:171` — replace the unbounded `core.member.list` call with the paginated `coreClient.member.list({ limit: 200 })`. Add an "infinite scroll" sentinel that calls `coreClient.member.list({ limit: 200, cursor: nextCursor })`. The existing search input filters within loaded pages until backend search lands later.

### Perf budget — PR 2

- Initial member panel render with 200 members ≤ 50 ms (no jank).
- `core.permission.changed` debounce window 200 ms, then single refetch.
- `useHasPermission` is O(1) after stores are warm.

### Definition of done — PR 2

- `bun typecheck` clean.
- All `core.*` calls in `server-settings-sheet.tsx` migrated to `coreClient`.
- `currentMemberStore` updates within 250 ms of a backend role change (manual test with two browser windows).
- No reactive cascades when permissions change (verify with SolidJS dev tools / log check).

---

## PR 3 — Member management UX

**Goal:** owners and delegated admins can change a member's role.

### 3.1 — Manage entry point

`C:\Users\jusss\projects\uncorded\platform\apps\website\src\components\user-card-sheet.tsx` — add a "Manage member" button below the existing identity section. Visibility gated by `useHasPermission("core.permissions.manage")`. Hidden when target is the actor themselves (Q1 lock — no self-management UI). Hidden when target is the owner unless actor is also owner. Lucide icon `Settings2` with `class="size-4"` per `feedback_lucide_icon_sizing.md`.

Click opens `<MemberManageSheet userId={target} />` and closes the user card.

### 3.2 — `member-manage-sheet.tsx`

New file: `C:\Users\jusss\projects\uncorded\platform\apps\website\src\components\server\member-manage-sheet.tsx`.

Layout:
- Header: avatar + display name + "Member of [server]" subtitle.
- Section 1 — **Server Role**:
  - Single-select dropdown.
  - Options: `coreClient.role.list()` filtered by actor's effective level (hide roles `>=` actor's level) per `RolesEngine.getCallerLevel` semantics.
  - Owner role hidden from all dropdowns; transferred via Central only.
  - Current role pre-selected.
  - "Change role" button submits `coreClient.role.assign({ user_id, role_id })`.
  - On `HIERARCHY_VIOLATION` / `FORBIDDEN` → toast with backend message; revert dropdown.
- Section 2 — **Reset to default**:
  - Button "Remove explicit role" → `coreClient.role.remove({ user_id })` → user falls back to `member`. Disabled if current role is already `member`.

Self-demotion guard: if `userId === currentUser.id`, the entire sheet is hidden — but in practice the Manage button never opens for self (3.1).

Refetch member list after success (no optimistic UI in PR 3 — locked at D4).

### 3.3 — Hierarchy-aware filtering

Helper in `core-client.ts` or `permissions.ts` store: `assignableRoles(actorLevel, allRoles): Role[]`. Excludes:
- Owner role (always)
- Roles where `role.level >= actorLevel`

Used by the dropdown to show only legal options. Backend remains authoritative — illegal options simply do not appear in the UI.

### Perf budget — PR 3

- Sheet open ≤ 100 ms (sheet animation + first roles fetch).
- Role-change round trip (mutation + refetch + UI reconcile) ≤ 300 ms p50.

### Definition of done — PR 3

- Owner can change a member's role (any level except owner).
- Delegated admin can change roles below their own level.
- Self-management button never appears.
- Owner role never appears in dropdown.
- Backend rejection produces a clear toast.
- Member list reflects the change after refetch.

---

## PR 4 — Administration tab + permissions matrix

**Goal:** the highest-value, highest-risk surface. This is where production-grade discipline matters most.

### 4.1 — Tab rename + sub-tabs

`C:\Users\jusss\projects\uncorded\platform\apps\website\src\components\server\server-settings-sheet.tsx:29` — change tab definition `moderation` → `administration` (label "Administration"). Icon stays `Shield` or moves to `ShieldCheck`.

Replace `<ModerationSection>` (~line 920+) with `<AdministrationSection>` from a new directory:

```
C:\Users\jusss\projects\uncorded\platform\apps\website\src\components\server\administration\
  index.tsx              ← AdministrationSection with sub-tab strip
  bans-tab.tsx           ← extracted from old ModerationSection ban surface
  roles-tab.tsx          ← role list + selected role detail
  audit-tab.tsx          ← unified audit (bans + permissions)
  permission-matrix.tsx  ← the tri-state grid
  role-edit-form.tsx     ← create/rename/delete a role
```

Sub-tab strip uses the existing folder-tab pattern from the parent sheet for consistency.

### 4.2 — Roles sub-tab

Left pane: list of roles ordered by level descending (`coreClient.role.list()`). Each row: name, level badge, member count. Custom roles show a "..." menu with rename/delete (gated by `core.permissions.manage` AND hierarchy). "Create role" button at the bottom. Default roles never show delete; rename/level edit hidden.

Right pane (when a role is selected): role header showing name, level, "Applies to N members" (via `getUsersWithRole(roleId).length` — exposed via a new tiny helper or by reading from cached member list). Below the header: `<PermissionMatrix roleId={selected.id} />`.

### 4.3 — Permission matrix

`C:\Users\jusss\projects\uncorded\platform\apps\website\src\components\server\administration\permission-matrix.tsx`.

Source data: `coreClient.permissions.list()` returns all `Permission` rows. Group by `pluginSlug`. For each `(role, permission)`:
- Determine current state by reading `role.overrides` (new field — see 4.5). State ∈ `{inherit, grant, deny}`.
- Render a three-button segmented control. Click → optimistic flip → mutation → reconcile.

**Optimistic UI implementation (D4):**
1. Local store `pendingChanges: Map<string, "grant" | "deny" | "remove" | "applied">` keyed by `permission.key`.
2. On click: set local state, mark pending, call `coreClient.permissions.grant/deny/remove`.
3. On success: clear pending; the upcoming `core.permission.changed` will reconcile.
4. On error (`HIERARCHY_VIOLATION`, `FORBIDDEN`, `core/invalid_params`): roll back local state, clear pending, toast the backend message.
5. If `core.permission.changed` arrives mid-flight from another actor: drop our optimistic value and accept backend truth.

**Bulk apply:** when the user toggles multiple permissions before any settle, the matrix collects them into a `core.permissions.grantMany` request batched on a 250 ms idle timer. Single broadcast per change still fires; client-side debounce coalesces refetches.

**Danger styling:** permissions with key matching `core.permissions.manage` or any future flag (TBD: a `danger: true` field on `Permission` registration?) get a red treatment + confirmation modal on grant. (The `terminal.use` permission was removed with Terminal Anywhere in commit `95dec38`.) For PR 4 we use a hardcoded list; we can graduate to a registration field later.

### 4.4 — Role edit form

Create role: name (1–64 chars), level (1–99 integer). Submits `coreClient.role.create`.

Rename custom role: same name validation. Submits `coreClient.role.update`.

Delete custom role: confirmation modal explaining "Members with this role will fall back to `member`." Submits `coreClient.role.delete`. After success, the engine reassigns affected users (engine line 234–259) and the member list refetches via the `core.permission.changed` listener.

### 4.5 — Role overrides exposure

Currently `Role` does not include its `role_permissions` rows. Two options:
- **A.** Extend `core.role.list` to return `Role & { overrides: Array<{ permission: string, granted: 0 | 1 }> }`.
- **B.** Add `core.role.permissions` action returning overrides for one role.

**Choice: A.** One round trip for the matrix; payload size is bounded (overrides are the exception, not the rule). Backend change in PR 4: extend `RolesEngine.getRoles()` (`runtime/src/roles/engine.ts:139`) to LEFT JOIN `role_permissions` and group, OR add a `getRoleOverrides(roleId): Array<{key, granted}>` method called per-row in the IPC handler. Either way the WS payload grows by an `overrides` array.

This is a small, additive protocol change. Document in the PR description.

### 4.6 — Audit sub-tab

`audit-tab.tsx` shows a unified table:
- Columns: timestamp · type (Ban / Permission) · actor · target · action · details · reason.
- Source: `coreClient.audit.list({ limit: 100 })` for moderation rows + `coreClient.permissions.audit({ limit: 100 })` for permission rows. Merged client-side, sorted by ts DESC.
- Filter chips: All / Bans / Permissions.
- "Load more" button paginates each source independently.

### Perf budget — PR 4

- Roles sub-tab initial render ≤ 80 ms with 10 roles + 50 permissions.
- Permission matrix render ≤ 120 ms (tri-state buttons × 50 permissions).
- Optimistic flip visible ≤ 16 ms after click.
- Bulk apply (10 permission flips coalesced) ≤ 200 ms server round trip + ≤ 100 ms reconcile.

### Definition of done — PR 4

- `moderation` tab renamed to `administration` everywhere (no orphan strings).
- Bans sub-tab functions identically to before the rename (regression-tested).
- Owner can create/rename/delete custom roles and edit any role's permissions.
- Delegated admin can edit roles below their own level only.
- Tri-state matrix correctly maps inherit/grant/deny.
- Optimistic flip rolls back on backend error with a visible toast.
- Bulk apply produces partial-success behavior matching backend.
- Audit sub-tab shows both ban and permission rows correctly.

---

## PR 5 — Hardening + production polish

**Goal:** what separates "works on the happy path" from "ships."

### 5.1 — Race + reconcile tests

Test files in `apps/website/src/__tests__/`:
- `permissions.race.test.tsx` — two simulated actors edit the same role; the second mutation hits `HIERARCHY_VIOLATION` mid-optimistic; UI reconciles correctly.
- `permissions.revoke.test.tsx` — actor holds `core.permissions.manage`, opens administration, has the permission revoked from another window; the `core.permission.changed` listener triggers a refetch of `core.member.me`; the next mutation attempt errors `FORBIDDEN`; the UI hides admin controls on the next render cycle.
- `permissions.stale-event.test.tsx` — optimistic flip in flight; a `core.permission.changed` from a third actor arrives; local optimistic value is dropped in favor of the refetch.

### 5.2 — Backend integration tests

`C:\Users\jusss\projects\uncorded\platform\runtime\tests\core-permissions-integration.test.ts` — exercises the WS path end-to-end with a real `RolesEngine` (no mocks), covering:
- Owner bootstrap: owner grants `core.permissions.manage` to admin role; admin actor performs grants; admin loses the permission; subsequent grant errors `FORBIDDEN`.
- Cascade verification: terminal subscriber on `RolesEngine.onPermissionChanged` receives the right userId/roleId/permissionKey for each mutation type.
- Migration assertion fires on a fresh DB missing `permission_audit` (drop the table, re-run boot, expect `process.exit` mock to throw).

### 5.3 — Polish

- Permission descriptions: pass over `permission-seeds.ts` and any plugin-registered descriptions for human-readable tone. Add ellipses tooltips on hover.
- Confirmation copy for granting `core.permissions.manage`: "Granting this permission lets the role assign and revoke any other permission they hold. Continue?"
- Search input on permissions matrix when permission count exceeds 25 in a single plugin group.
- "Last edited" column on the role list (uses `roles.updated_at`).
- Audit "export CSV" button — local-only, no backend round trip.

### Perf budget — PR 5

- All race/revoke tests run in < 3 s collectively.
- CSV export of 1000 audit rows ≤ 200 ms client side.

### Definition of done — PR 5

- All race tests pass.
- All integration tests pass against a real engine.
- Permission descriptions reviewed and edited for clarity.
- Danger confirmations visible for `core.permissions.manage`.
- `bun typecheck` and `bun test` clean across all packages.
- Manual smoke: owner + delegated admin + member roles all behave per spec on a fresh server.

---

## Cross-cutting non-goals

Out of scope for this plan; tracked separately:
- Per-user permission overrides (Amendment A locks: role-scoped only).
- JWT `is_owner` reauth cadence (audit item; doesn't gate this plan).
- Owner reassignment via the runtime UI (must go through Central).
- Role inheritance templates (mentioned in spec-22 "Future Refinements").
- Audit log retention/purge (revisit only on report).
- Backend full-text search on members (current path: client-side filter within paged results).
- Per-server plugin configuration (separate `[TBD-plugin-config]` work).

---

## Verification rituals (per PR)

For every PR:
1. `bun typecheck` clean across the affected workspaces.
2. `bun test` clean.
3. Manual smoke against a freshly-seeded local server.
4. Trace the full call chain from UI click → WS → IPC handler → engine → DB → broadcast → store → re-render. No shortcuts (`feedback_commit_discipline.md`).
5. Cross-check field names against the canonical TS types before committing (`feedback_verify_field_names_against_code.md`).

---

## Appendix — Quick code map

```
runtime/src/
  core/
    ipc.ts              ← handleCoreClientAction (148–567); core.* surface
    permissions.ts      ← requirePermission, assertGrantSafe
    permission-seeds.ts ← core.permissions.manage seed
    module.ts           ← CoreModule.listMembers, listBans, listAuditLog
    dao.ts              ← SQL for members + audit_log
  roles/
    engine.ts           ← RolesEngine (102–575)
    types.ts            ← Role, Permission, CallerContext, DEFAULT_ROLES
    migrations/         ← 001 tables, 004 permission_audit
  db/
    expected-tables.ts  ← (NEW PR 1.4)
    assert-tables.ts    ← (NEW PR 1.4)
  main.ts               ← initialization order

packages/protocol/src/
  core.ts               ← CORE_TOPICS.PERMISSION_CHANGED, payload type (extend in PR 1)

apps/website/src/
  lib/
    ws.ts               ← request, onPluginMessage
    core-client.ts      ← (NEW PR 2.1)
  stores/
    membership.ts       ← currentMember (extend in PR 2.2)
    permissions.ts      ← (NEW PR 2.2)
    user-card.ts        ← (existing; consumer in PR 3.1)
  hooks/
    use-has-permission.ts ← (NEW PR 2.3)
  components/
    user-card-sheet.tsx ← Manage button (PR 3.1)
    server/
      server-settings-sheet.tsx ← rename moderation → administration (PR 4.1)
      member-manage-sheet.tsx   ← (NEW PR 3.2)
      administration/           ← (NEW PR 4.1)
        index.tsx
        bans-tab.tsx
        roles-tab.tsx
        audit-tab.tsx
        permission-matrix.tsx
        role-edit-form.tsx
```
