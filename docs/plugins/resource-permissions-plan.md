# Plugin Resource Permissions Foundation Plan

> Status: **Planning / design foundation** (RP-FOUND-0). No product code in this PR.
> Owner: Dakota. Author seat: this branch (`foundation/plugin-resource-permissions-plan`).
> Companion docs: [`docs/coview/foundation-plan.md`](../coview/foundation-plan.md) (the CoView render-tree projection plan that consumes this layer) and `.claude/docs/Overview/spec-27-co-view-sessions.md` (the locked CoView product spec).
> This doc defines the **resource / permission layer** that CoView and other runtime systems evaluate per viewer. It does not implement it.

---

## 0. TL;DR

CoView's foundation plan already names the authority it depends on but does not own it:

```ts
// docs/coview/foundation-plan.md §4.3 / §4.4 — proposed, not yet backed
type CoViewValueRef =
  | { origin: "gated"; policyRef: PolicyRef; resourceRef: ResourceRef; ... }
  | ...;

type ResourceRef =
  | { kind: "pluginResource"; pluginSlug: string; resourceType: string; resourceId: string }
  | ...;
```

CoView projects a host render tree and asks, per data-bearing value:

```text
viewer + policyRef + resourceRef -> real value | placeholder
```

Today the runtime cannot answer that question for plugin data. The existing permission model
(`RolesEngine`) is **role/level-based and server-wide**: a permission key is either held by your
role across the whole server or it is not. There is no notion of "Billy may read album 7 but not
album 9." Plugin capabilities (`resource.action[:scope]` in `runtime/src/capabilities/checker.ts`)
gate *plugin → runtime IPC*, not *user → resource* access.

This plan defines a first-class **plugin resource permission layer**: how plugins declare
resources, attach ACLs, and expose `resourceRef` / `policyRef` values that the runtime — and only
the runtime — resolves per user. The goal is that a plugin author writing a normal family-album UI
gets per-viewer CoView projection for free, because their album/photo/caption values are backed by
resource permissions instead of opaque blobs.

The boundary this plan optimizes for:

- **Runtime is the grant authority.** The host client and plugin client are not.
- **Resources are addressable and inheritable.** A photo inherits its album's read grant.
- **Authorization is per-user, per-resource, per-action.** Not per-role-globally.
- **The safe path is the normal path.** SDK resource primitives carry provenance so authors do not write a second CoView UI.
- **Fail closed.** Unknown resources, unknown actions, stale grants, and unprovenanced data deny.

---

## 1. Problem Statement

### 1.1 The question CoView needs answered

CoView's render-tree projection (foundation-plan §4.6) groups viewers by entitlement class and
resolves each gated value for that class. For a plugin value it must call something equivalent to:

```text
canReadPluginResource(viewer, { pluginSlug, resourceType, resourceId }) -> allowed?
```

and, for actions a viewer might be authorized to take separately from the host:

```text
canPluginResourceAction(viewer, resourceRef, action) -> allowed?
```

Nothing in the runtime can answer these for plugin data today.

### 1.2 Current-state inventory

| Mechanism | What it governs | Granularity | Per-resource? | Source |
|---|---|---|---|---|
| `RolesEngine.check(userId, key, ctx)` | Named server permissions | Role / level, server-wide | **No** | `runtime/src/roles/engine.ts` |
| Role table | owner 100 / admin 80 / moderator 60 / member 10 | Role level | No | `runtime/src/roles/types.ts` |
| Core permission seeds | Platform built-in perms (`co-view.host`, `core.permissions.manage`) | `default_level` + per-role grant/deny override | No | `runtime/src/core/permission-seeds.ts` |
| `CapabilityChecker` | Plugin → runtime IPC calls | `resource.action[:scope]` declared in manifest | No (gates the plugin, not the user) | `runtime/src/capabilities/checker.ts` |
| `platform.permissions.*` SDK | Plugin asks runtime about a user's role/permission | Role / level | No | `packages/plugin-sdk/src/permissions.ts` |
| `platform.data.read(plugin, table)` | Cross-plugin reads | Table columns via `public_schema` | No (column-level allowlist, not per-row ACL) | `packages/plugin-sdk/src/data.ts`, plugin manifest `public_schema` |
| `PermissionChangedEvent` | Re-evaluate effective perms on mutation | `{ userId?, roleId?, permissionKey? }` | n/a — already the invalidation signal | `runtime/src/roles/engine.ts` |

Two things are true at once:

1. The runtime is already authoritative for **role membership and named permissions**, and already
   emits a change signal (`PermissionChangedEvent`) that drives session/permission re-evaluation.
   This is the right substrate to build on — we extend it, we do not replace it.
2. There is **no per-resource ACL anywhere**. The closest things — capability scopes and
   `public_schema` column allowlists — are coarse, static, and not user-relative.

### 1.3 Why a quick CoView-local hack is wrong

It would be tempting to special-case a few resource kinds inside CoView's projection path
(`channel.read`, `album.read`) and call it done. That fails the moment a third plugin ships:

- Every plugin would invent its own visibility convention, none runtime-enforced.
- CoView would carry product knowledge of each plugin's data model.
- "Visible value" would be decided client-side or producer-side — exactly the boundary the CoView
  plan §5 forbids ("no protected byte crosses an unauthorized viewer's wire").
- Revocation/ban/stale-grant behavior would be reimplemented per plugin, inconsistently.

CoView-grade projection requires a **general** answer to `viewer + policyRef + resourceRef → allowed?`
that the runtime owns. That answer is this layer.

---

## 2. Goals

1. **Per-user / per-role / per-resource visibility** for plugin data — not just per-role-globally.
2. **Runtime-authoritative authorization.** The runtime resolves grants; host and plugin clients
   only carry references. A reference is never a grant.
3. **A natural SDK path** so resource-backed rendering is the default, not extra work. A plugin
   that uses `ResourceText` / `ResourceImage` gets correct per-viewer CoView projection for free.
4. **First-class support for CoView value projection** — this layer is the authority behind
   `CoViewValueRef.origin = "gated"` (foundation-plan §4.3).
5. **One permission model, not N.** Plugins declare resources and actions against a shared
   registry; they do not each invent an ACL engine.
6. **Inheritance** so common shapes (photo inherits album, message inherits channel) are declared
   once, not re-granted per child.
7. **Fail-closed by construction.** Unknown resource, unknown action, missing adapter, stale
   version, unprovenanced value → deny / withhold.
8. **Reuse the existing change signal.** Resource ACL mutations invalidate projection caches via
   the same versioned-invalidation mechanism that `PermissionChangedEvent` already established.

---

## 3. Non-Goals

- **No product code in this PR.** This is design only. Type sketches here are illustrative, not final.
- **No CoView implementation.** CoView's render tree, producer, and viewer renderer are out of scope
  here; this doc only defines the authority CoView calls.
- **No quick/temporary permission hack.** No CoView-local resource special-casing, no client-side
  redaction treated as a security boundary.
- **No arbitrary automatic redaction of unprovenanced pixels/data.** If data has no resource
  provenance, this layer does not guess; the consumer (CoView) withholds. This layer never
  fabricates provenance.
- **No viewer action execution / CoDrive.** This layer can *answer* `canPluginResourceAction`, but it
  does not execute viewer-initiated mutations against host state. Action execution remains a separate,
  later, explicitly-designed system.
- **No cross-server resource resolution in V1.** Resources resolve within one server/workspace scope.
- **No replacement of the role engine.** Roles/levels remain; this layer composes with them.

---

## 4. Resource Model

### 4.1 What a resource is

A **plugin resource** is an addressable unit of plugin-owned data that can carry an ACL and back
data-bearing values. It is identified by a stable tuple:

```ts
type PluginResourceKey = {
  serverId: string;        // scope — one server/workspace; cross-server is out of scope (§3)
  pluginSlug: string;      // owning plugin, e.g. "family-album"
  resourceType: string;    // registered type, e.g. "album" | "photo"
  resourceId: string;      // plugin-assigned stable id, opaque to the runtime
};
```

This maps directly onto the CoView plan's `ResourceRef`:

```ts
// docs/coview/foundation-plan.md §4.4
{ kind: "pluginResource"; pluginSlug: string; resourceType: string; resourceId: string }
```

CoView's `ResourceRef` is the same identity minus `serverId`, which CoView already binds from the
session's server context ("V1 resolution is scoped to the CoView session's current server/workspace
context", foundation-plan §4.4). The runtime re-attaches `serverId` from the calling context. A
`ResourceRef` that arrives with a mismatched or cross-server scope is malformed and rejected.

### 4.2 Resource types are registered, not free-form

A plugin must **register** its resource types at install/boot, analogous to how plugins register
named permissions today (`RolesEngine.registerPermission`). Registration declares:

- the `resourceType` name (namespaced under the plugin slug, so `family-album:album`);
- its allowed **actions** (§5);
- its **parent type**, if any (for inheritance, §4.4);
- which **value slots** it exposes and their `policyRef` mapping (§4.5);
- whether values may be host-provided or must be runtime-resolved (mirrors CoView's
  `producerValueAllowed`, default `false`).

An unregistered `resourceType` is unknown and fails closed. This is the resource-layer analogue of
the capability checker's "undeclared = hard reject."

### 4.3 Scope

Every resource lives in exactly one **server/workspace scope** (`serverId`). Scope is part of the
key, part of every ACL row, and part of every cache key. There is no global/cross-server resource in
V1. A workspace is the same scoping unit the runtime already uses for core data; this layer does not
introduce a new scope concept, it reuses the server boundary.

### 4.4 Parent / child resources and inheritance

Resources form a **tree per (server, plugin)**. A child resource may inherit ACL grants from its
parent:

```text
album:summer-2026            (read: Dad, Mom, Billy)
  └─ photo:img-001           (inherits album read)
  └─ photo:img-002           (inherits album read; + explicit deny: Billy)
```

Inheritance rules:

- A resource declares a `parentRef` at create time (or none for a root).
- By default a child **inherits its parent's ACL** for inheritable actions. The registry declares
  which actions inherit (commonly `read` and `comment`; rarely `admin`).
- A child may **add** grants (broaden) or **add explicit denies** (narrow). Deny precedence (§6.4)
  means a child deny wins over an inherited allow.
- Inheritance is resolved at evaluation time against the **current** parent ACL, so a parent
  revocation propagates to children without rewriting child rows. (This makes parent ACL version a
  cache-key input for child evaluations — see §11.)
- Depth is bounded; cycles are rejected at create time. A pathological depth limit (e.g. 16) keeps
  resolution cost bounded and is a registry constant, not per-plugin.

This is what lets a "photo inherits album read permission" be declared once. The family-album plugin
never writes a per-photo ACL for the common case.

### 4.5 Resource metadata vs protected value content

A resource has two distinct surfaces, and the distinction is load-bearing:

| Surface | Examples | Default exposure |
|---|---|---|
| **Metadata** | existence, `resourceType`, child count, structural shape, layout box | Governed by the registry; *may* be exposed to non-readers if the schema accepts the leak (§6 of CoView plan — `preserve-host-rect`, count leaks). Default: existence/count **not** leaked. |
| **Protected value content** | album title text, photo pixels, caption, document body | Gated by `read` (or a finer value-level `policyRef`). Default: **withheld** from non-readers. |

The existence/count decision is not cosmetic: it determines whether an unauthorized viewer sees
fourteen message-shaped placeholders, a stable synthetic skeleton, or a single hidden-content state.
Default V1 behavior is **synthetic/no count leak** unless a resource type explicitly accepts
existence/count leakage in its schema. This must be resolved for the first CoView text-channel slice
before CV-FOUND-4 ships, not deferred to visual polish.

A **value slot** is a named data-bearing field on a resource that the SDK can bind a render value to.
The registry maps each slot to a `policyRef`:

```text
resourceType "album"
  slot "title"   -> policyRef "family-album:album.read"
  slot "coverImage" -> policyRef "family-album:album.read"

resourceType "photo"
  slot "pixels"  -> policyRef "family-album:photo.read"
  slot "caption" -> policyRef "family-album:photo.read"
```

This mapping is exactly what CoView needs: a gated `CoViewValueRef` carries `{ resourceRef, policyRef }`,
and the runtime resolves the slot value for the viewer or substitutes the placeholder. The plugin
author binds `ResourceText`/`ResourceImage` to a slot; the registry already knows the `policyRef`.

---

## 5. Permission Model

### 5.1 Base actions

Every resource type supports a base action vocabulary. These are the verbs CoView and other systems
reason about:

| Action | Meaning | Typical CoView use |
|---|---|---|
| `read` | See the protected value content. | The core projection gate — `read` ⇒ real value, else placeholder. |
| `comment` | Add commentary/annotation without mutating the resource. | Future CoView annotation lane (still not host mutation). |
| `edit` | Mutate the resource's protected content. | Not exercised by passive viewing; relevant to `canPluginResourceAction`. |
| `share` | Grant others access (delegated granting, bounded by §6.7). | Not a viewing concern; an authoring concern. |
| `admin` | Manage the resource's ACL and lifecycle (delete, re-parent). | Never auto-inherited; never implied by `read`. |

Actions are **not** a strict hierarchy by default. `admin` does not imply `read` unless the registry
says so; this avoids surprising "admin can always see content" leaks for resources where management
and content visibility are intentionally separate. The registry may declare implications explicitly
(e.g. `edit ⇒ read`) per resource type.

### 5.2 Plugin-defined actions (typed and registered)

Plugins may define additional actions, but only **typed, registered** ones. A custom action:

- is namespaced under the plugin slug (`family-album:download`);
- is declared in the resource type registration with a description and whether it inherits;
- maps to a `policyRef` so CoView/`canPluginResourceAction` can evaluate it uniformly.

An unregistered action string fails closed exactly like an unregistered capability. There is no
free-form `check(user, "whatever")` for resources — the action must exist in the registry. This is
the resource analogue of the existing rule that a plugin cannot call an IPC capability it never
declared.

### 5.3 Relationship to roles/levels

Resource permissions **compose with** the role engine; they do not bypass it:

- A grant may target a **role** ("everyone with role `family`"), in which case role membership is
  resolved through the existing `RolesEngine`.
- Owner bypass and level hierarchy continue to apply at the server level for server-level permission
  management. They do **not** imply plugin resource `read` in V1. A server owner may receive
  resource-management powers only through explicit ACL or explicit registry policy, and content
  `read` still requires an explicit resource grant. This avoids surprising CoView leaks where a
  server owner sees private plugin content merely because they own the server.
- Named server permissions (e.g. a plugin's `family-album.manage`) can still gate *plugin-wide*
  operations; resource ACLs gate *per-resource* ones. Both can be required.

---

## 6. ACL Model

### 6.1 Principal types

An ACL entry's subject (principal) is one of:

```ts
type ResourcePrincipal =
  | { kind: "user"; userId: string }
  | { kind: "role"; roleId: number }              // resolved via RolesEngine
  | { kind: "everyone" }                            // every member of the server/workspace scope
  | { kind: "owner" };                              // the resource's owner principal(s)
```

`everyone` is scoped to the server/workspace, never global. `owner` is the resource's creator or an
explicitly assigned owner, and is the only principal that holds `admin` by default on a root
resource.

### 6.2 ACL entry shape

```ts
type ResourceAclEntry = {
  resourceKey: PluginResourceKey;
  principal: ResourcePrincipal;
  action: string;                 // registered base or plugin action
  effect: "allow" | "deny";
  // provenance for audit / revocation
  grantedBy: string;              // user id of granter (or "system" for registry-seeded rows)
  grantedAt: number;
  source: "explicit" | "registry-seeded";
};

type EffectiveAclDecision = {
  allowed: boolean;
  reason: "explicit-allow" | "role-allow" | "everyone-allow" | "inherited-allow"
        | "explicit-deny" | "role-deny" | "everyone-deny" | "default-deny";
  versions: AuthVersions;
};
```

ACLs are stored as explicit rows. Inherited entries are **not** materialized per child (§4.4);
they are computed at evaluation time and surfaced as an `EffectiveAclDecision`. Registry defaults are
also decisions, not stored rows, unless a migration deliberately seeds explicit registry-owned rows.

### 6.3 Group / role / everyone resolution

A `role` or `everyone` grant expands to the matching user set through the existing role engine at
evaluation time. The expansion is **not** cached as a frozen user list — role membership changes
flow through `PermissionChangedEvent`, which already names `roleId` as a change scope. That event
becomes a cache-invalidation trigger for resource evaluations that depended on the role (§11).

### 6.4 Deny vs allow precedence

Fixed precedence, evaluated most-specific-first, deny-wins within a specificity tier:

```text
1. explicit user deny         (most specific deny wins immediately)
2. explicit user allow
3. role deny
4. role allow
5. everyone deny
6. everyone allow
7. inherited (parent) result — recurse, applying 1–6 at the parent
8. registry default for the action (default: deny)
```

Rules:

- **Deny wins over allow at the same or broader specificity.** An explicit user deny beats any role
  or everyone allow. A child explicit deny beats an inherited allow.
- A more-specific allow can override a broader deny (user allow beats role deny) — this is what makes
  "ban Billy from photo-002 even though the album is shared" expressible without nuking the album.
- If no entry matches at any level, the registry default applies; the default is **deny**.

### 6.5 Inherited ACLs

Inheritance is resolved by recursing into the parent at step 7 only when the child produced no
decisive explicit/role/everyone result. This means:

- A parent allow flows to children for inheritable actions.
- A child can shadow it with an explicit child entry.
- A parent revocation immediately changes child outcomes (parent version is a child cache input).

### 6.6 Bans, revocation, and stale-permission invalidation

- **Revocation** is removing an allow (or adding a deny). It takes effect on the next evaluation; the
  resource's ACL **version** bumps, invalidating any projection cache keyed on it (§11).
- **Ban** is a server-level state (a user removed/banned from the server) that must short-circuit all
  resource evaluations to deny, regardless of lingering resource ACL rows. The banned state is read
  from the existing membership/role system, and a ban is a `PermissionChangedEvent` that busts every
  cache entry for that user. This is the resource analogue of CoView's "permission revocation ⇒
  placeholders on the next projected frame."
- **Stale-permission invalidation** is structural: every grant decision is stamped with the resource
  ACL version (and parent versions consulted) and the resource-permission version used. A consumer
  (CoView) holding a cached projection at an older version must re-resolve. There is no TTL-only path;
  invalidation is event-driven via versioning, with an optional TTL backstop.

### 6.7 Delegated granting (`share`) is bounded

A principal with `share` can grant access, but only access **they themselves hold and only at or
below their own action set** — the resource analogue of the existing `assertGrantSafe`
privilege-escalation guard in `runtime/src/core/permissions.ts`. A user
cannot `share` `admin` if they only hold `read`. This prevents resource-ACL privilege escalation
mirroring the role-engine's `HIERARCHY_VIOLATION` protection.

### 6.8 Fail-closed behavior

The ACL evaluator denies on: unknown resource, unknown action, unregistered resource type, missing
plugin adapter, evaluation error, version mismatch it cannot resolve, or cycle/over-depth in the
parent chain. Denial is the default return, not an exception that a caller might swallow into an
allow.

---

## 7. Runtime APIs / Resolver

The resolver is the **only** authority. It lives in the runtime (alongside `runtime/src/roles/` and
`runtime/src/co-view/`), reads ACL state, composes with `RolesEngine`, and returns decisions. Host
and plugin clients never evaluate ACLs; they hold references and call the resolver.

### 7.1 Core authorization API (conceptual)

```ts
interface PluginResourceResolver {
  // Can this viewer see the protected value content of this resource?
  canReadPluginResource(
    viewer: ViewerContext,
    resourceRef: ResourceRef,
  ): Promise<AuthDecision>;

  // Can this viewer take a (registered) action on this resource?
  canPluginResourceAction(
    viewer: ViewerContext,
    resourceRef: ResourceRef,
    action: string,
  ): Promise<AuthDecision>;

  // Resolve a specific value slot for a viewer: real value or withheld marker.
  // This is the call CoView makes per gated CoViewValueRef.
  resolvePluginResourceValue(
    viewer: ViewerContext,
    resourceRef: ResourceRef,
    valueRef: ValueSlotRef,
  ): Promise<ResolvedValue>;
}

type AuthDecision = {
  allowed: boolean;
  reason: "explicit-allow" | "role-allow" | "everyone-allow" | "inherited-allow"
        | "explicit-deny" | "role-deny" | "everyone-deny" | "default-deny"
        | "unknown-resource" | "unknown-action" | "banned" | "stale" | "error";
  // versions consulted, so the caller can cache and later detect staleness
  versions: { resourceAclVersion: number; resourcePermissionVersion: number; parentVersions?: number[] };
};

type ResolvedValue =
  | { state: "visible"; value: JsonValue; versions: AuthVersions }
  | { state: "withheld"; placeholderShape: PlaceholderShape; versions: AuthVersions }
  | { state: "unsupported"; reason: string };
```

`ResolvedValue.state` aligns deliberately with CoView's `CoViewProjectedValue` (foundation-plan §4.6)
so CoView can map resolver output to projected output without a translation layer: `visible → visible`,
`withheld → withheld`, secret slots never reach this path (see §10).

### 7.2 ViewerContext

```ts
type ViewerContext = {
  userId: string;
  serverId: string;
  // resolved lazily by the resolver, but carried for cache-key construction:
  roleIds?: number[];
  isOwner?: boolean;
  isBanned?: boolean;
};
```

The resolver, not the caller, is authoritative for `roleIds`/`isOwner`/`isBanned`; values passed in
are hints for cache-key construction and are re-verified. The current `RolesEngine` is a single-role
model (`getRole(userId)` returns one effective role), so V1 serializes `roleIds` as a one-item
canonical set. The list shape is reserved for future multi-role/group support and keeps this plan
aligned with CoView's entitlement-class vocabulary.

### 7.3 Plugin adapter interface

Some resources need plugin-side existence/parent/value lookups the runtime cannot infer. The runtime
does not know a photo belongs to an album, and it also cannot resolve `photo.caption` from a
`resourceRef` unless the plugin exposes a value source. The plugin therefore exposes a **read-only
adapter** over IPC:

```ts
interface PluginResourceAdapter {
  describe(resourceType: string, resourceId: string): Promise<{
    exists: boolean;
    parentRef?: ResourceRef;
    ownerUserIds?: string[];
  } | null>;

  resolveValue(resourceType: string, resourceId: string, slot: string): Promise<{
    exists: boolean;
    value?: JsonValue;
    placeholderShape?: PlaceholderShape;
    valueVersion: number;
  } | null>;
}
```

The adapter answers *structure, ownership, and value materialization*, never *authorization*.
Authorization stays in the resolver. `resolveValue` runs only after the resolver has authorized the
viewer for the slot's `policyRef` / `resourceRef`; unauthorized viewers receive placeholders without
calling the value provider. A missing adapter, a `null` response, or `exists: false` fails closed.
Adapter results are cacheable and versioned like ACLs.

This closes an important trust gap: for a slot with `producerValueAllowed: false`, the host/plugin
frontend may render the literal value locally, but the CoView render tree carries only the
`resourceRef` + slot. The real value sent to an authorized viewer comes from the runtime-controlled
adapter path, not from Dad's browser.

The adapter is still a **trusted plugin-runtime boundary**, not a proof system. If a malicious or
buggy plugin returns Sarah's photo bytes for `photoId=img-001`, the runtime can verify that the
viewer is authorized for `img-001`, but it cannot semantically prove the returned bytes are the
correct bytes for that id. Mitigations belong in the implementation plan: plugin process isolation,
adapter capability gating, metadata-only audit logs for `resolveValue` calls, value/version stamps,
and optional future content-addressing or checksum validation for imported assets. This is why
registry-owned ACLs are necessary but not sufficient; plugin adapters remain part of the trusted
computing base for plugin-owned content.

### 7.4 CoView consumes these APIs

CoView's projection path (foundation-plan §4.6) replaces "resolve values per entitlement class" with
calls into this resolver for every `pluginResource`-kinded `ResourceRef`. CoView remains responsible
for grouping viewers into entitlement classes and for non-plugin resource kinds (channel, message,
member); this layer owns the **plugin** kinds and provides the version stamps CoView's
entitlement-class cache (foundation-plan §4.7) keys on via its `resource permission version` field.

---

## 8. SDK APIs

Sketches, not final signatures. The intent: a plugin declares resources and renders normal UI; the
SDK carries provenance so the runtime can project per viewer.

### 8.1 Backend: declare, create, grant, revoke, check

```ts
// Registration (install/boot) — declares types, actions, parent, value slots.
platform.resources.define({
  type: "album",
  actions: ["read", "comment", "edit", "share", "admin", "download"], // download is plugin-defined
  inheritableActions: ["read", "comment"],
  valueSlots: {
    title:      { policy: "album.read" },
    coverImage: { policy: "album.read" },
  },
  producerValueAllowed: false, // protected values are runtime-resolved (CoView parity)
});

platform.resources.define({
  type: "photo",
  parentType: "album",
  actions: ["read", "comment", "download", "admin"],
  inheritableActions: ["read", "comment"],
  valueSlots: {
    pixels:  { policy: "photo.read" },
    caption: { policy: "photo.read" },
  },
});

// Create an instance (returns a ResourceRef the plugin stores with its row).
const albumRef = await platform.resources.create({
  type: "album",
  resourceId: album.id,
  owner: { kind: "user", userId: dadId },
});

const photoRef = await platform.resources.create({
  type: "photo",
  resourceId: photo.id,
  parent: albumRef, // inherits album read
});

// Grant / revoke — these are ACL mutations; they bump versions and fire invalidation.
await platform.resources.grant(albumRef, { kind: "user", userId: billyId }, "read");
await platform.resources.revoke(albumRef, { kind: "user", userId: sarahId }, "read");

// Check — thin pass-through to the resolver; never trust the answer client-side for security,
// it is for UI affordances only. The wire boundary is still runtime-enforced.
const canRead = await platform.resources.check(viewerId, photoRef, "read");
```

### 8.2 Frontend: resource-provenanced render primitives

These render normal UI but tag the value with its `resourceRef` + slot so CoView projects it. To the
plugin author they look like ordinary components:

```tsx
// Family album plugin — normal UI, resource-backed values.
<div class="album-panel">
  <h1>
    <ResourceText resource={albumRef} slot="title">{album.title}</ResourceText>
  </h1>

  <div class="photo-card">
    <ResourceImage resource={photoRef} slot="pixels" src={photo.url} />
    <ResourceText resource={photoRef} slot="caption">{photo.caption}</ResourceText>
    <ResourceIcon resource={photoRef} slot="badge" name={photo.kind} />

    {/* Controls are NOT resource values — they mirror from host UI as-is. */}
    <button>Open</button>
    <button>Download</button>
    <button>Share</button>
  </div>
</div>
```

```tsx
// Generic escape hatch when a value does not fit text/image/icon.
<ResourceValue resource={docRef} slot="body" value={doc.body} placeholder={{ mode: "synthetic", lines: 12 }} />
```

- `ResourceText` / `ResourceImage` / `ResourceIcon` are typed wrappers that emit a gated
  `CoViewValueRef` (`{ origin: "gated", resourceRef, policyRef, placeholderShape }`) in the render
  tree. For `producerValueAllowed: false` slots, that CoView value ref does **not** include the
  literal child/`src`; authorized viewer values are fetched through the runtime adapter path in §7.3.
  When CoView is **not** active, the component still renders the literal child/`src` for the local UI.
- `ResourceValue` is the general primitive; the three named ones are ergonomic shortcuts with sensible
  default placeholder shapes (one-line text, same-rect image, icon glyph).
- The author writes their UI **once**. Buttons mirror as controls; resource slots project as values.
  There is no second CoView component tree. This is the central product requirement.

For image/canvas-like content, "resource-provenanced" means the projected value is materialized from a
registered value slot through the runtime adapter or platform storage path. A plugin cannot make
arbitrary frontend pixels safe by wrapping them in `ResourceImage` with a made-up `resourceRef`: the
runtime validates the registered resource type, slot, action, and value source. Unknown pixels,
external URLs, raw canvas buffers, and values not produced by the registered adapter path are
unprovenanced and withheld for unauthorized viewers.

### 8.3 The family-album walkthrough

1. Dad's plugin calls `platform.resources.define` for `album` and `photo` at boot.
2. When Dad creates "Summer 2026", the plugin calls `platform.resources.create({ type: "album", ... })`
   and grants `read` to Dad, Mom, Billy.
3. Each photo is created with `parent: albumRef`, inheriting album read.
4. Dad's frontend renders the album with `ResourceText`/`ResourceImage` bound to those refs.
5. Dad hosts a CoView session. CoView captures the render tree; the album title/photo slots are gated
   `CoViewValueRef`s.
6. For **Billy** (has `album.read`), the resolver returns `visible` → Billy sees the real album.
7. For **Sarah** (no grant, no inherited grant, default deny), the resolver returns `withheld` →
   Sarah sees Dad's identical panel/buttons/hover/layout with same-shape placeholders for title,
   pixels, caption.
8. Dad never wrote CoView-specific code.

---

## 9. CoView Integration

This layer is the authority behind CoView's central rule:

```text
viewer + policyRef + resourceRef -> real value | placeholder
```

Concretely:

| CoView concept (foundation-plan) | Backed by this layer |
|---|---|
| `ResourceRef` kind `pluginResource` (§4.4) | `PluginResourceKey` minus server scope (§4.1) |
| `PolicyRef` for plugin slots (§4.4, `plugin.resource.read`) | Per-slot `policyRef` from resource type registration (§4.5) |
| `CoViewValueRef.origin = "gated"` (§4.3) | Resolver decision `visible`/`withheld` (§7.1) |
| "resolve values per entitlement class" (§4.6) | `resolvePluginResourceValue` per class member (§7.4) |
| "resource permission version" cache key (§4.7) | `versions.resourcePermissionVersion` / `resourceAclVersion` (§7.1) |
| "permission revocation ⇒ placeholders next frame" (§8) | ACL version bump + `PermissionChangedEvent` invalidation (§6.6) |

Boundary preserved: **controls and structure mirror from the host UI; only data values project.**
The resolver is never asked "should this button exist" — button existence is host UI structure
(CoView plan §2.1, §4.5). The resolver is asked only "may this viewer see this value / take this
action." A plugin's `<button>Delete</button>` mirrors to all viewers; the album *title* projects.

CoView keeps ownership of: entitlement-class grouping, the render tree, placeholder rendering, and
non-plugin resource kinds. This layer owns: plugin resource identity, ACLs, inheritance, and the
per-viewer value/action decision for plugin slots.

---

## 10. Security Invariants

1. **Runtime is the grant authority.** The host client and plugin client are not. A reference
   (`resourceRef`/`policyRef`) is a *claim about identity*, never a *grant*.
2. **Unknown fails closed.** Unknown resource, unregistered type, unregistered action, missing
   adapter, `exists: false`, cycle/over-depth → deny.
3. **Default is deny.** Registry default for any action with no matching ACL entry is deny (§6.4).
4. **Deny wins within specificity tier.** Explicit user deny cannot be overridden by a broader allow
   (§6.4).
5. **Stale permissions invalidate projection.** Every decision is version-stamped; an ACL/role/parent
   change bumps versions and busts dependent caches via `PermissionChangedEvent` (§6.6, §11). No cache
   serves a value past its authorizing version.
6. **`producerValueAllowed` defaults to `false` for protected values.** A protected value slot is
   runtime-resolved unless its registration explicitly opts in; a host/plugin-provided value on a
   `false` slot is malformed and rejected — identical to CoView plan §4.9. Omission never becomes
   exposure.
7. **Unprovenanced plugin data cannot be safely projected.** If a value carries no `resourceRef`,
   this layer does not invent one; the consumer withholds. Provenance is required for visibility, not
   assumed.
8. **Adapters are trusted value providers, not authorization authorities.** The runtime decides whether
   a viewer may receive a value; the plugin adapter supplies the value after authorization. Adapter
   calls must be capability-gated, audited by metadata, versioned, and isolated because the runtime
   cannot prove plugin-returned bytes are semantically correct for a resource id.
9. **No protected byte crosses an unauthorized viewer's wire.** The resolver returns `withheld` *before*
   the value is serialized toward a viewer. Client-side redaction is not the boundary (CoView plan §5.4).
10. **Secret slots are unrepresentable on the viewer wire.** A slot classified secret (credentials,
   tokens) is never carried as a resolvable value; it resolves only to a placeholder or absent, mirroring
   CoView's `origin: "secret"` (foundation-plan §4.3). The resolver has no path that returns a secret
   value to a viewer.
11. **Authorization uncertainty withholds.** Resolver errors, deleted resources, version it cannot
    reconcile, banned principal → withhold, log a diagnostic, never fall open.
12. **Delegated grants cannot escalate.** `share` is bounded by the granter's own held actions
    (§6.7), mirroring `assertGrantSafe`.
13. **Action authority is separate from visibility.** `canPluginResourceAction` is evaluated
    independently of `canReadPluginResource`; seeing a value (or a control) never implies the right to
    mutate it. This layer answers the question but executes nothing.

---

## 11. Performance

CoView resolves values for many viewers at interaction-frequency. Per-viewer DB lookups on every
hover/cursor frame are not acceptable (CoView plan §4.7 already forbids this). This layer must make
the common case cache-friendly.

### 11.1 Versioning is the invalidation primitive

- Each resource carries a monotonically increasing **ACL version**, bumped on any grant/revoke/deny
  mutation and on owner/parent reassignment.
- A server-scoped **resource-permission version** covers role-membership changes and bans that affect
  resource evaluation (driven by `PermissionChangedEvent`'s `roleId`/`userId` scopes).
- A child evaluation's version vector includes the **parent ACL versions** it consulted, so a parent
  revocation invalidates child cache entries without rewriting child rows.

### 11.2 Entitlement-class grouping, not per-user

The resolver decision for `read`/action on a resource depends only on the viewer's *entitlement
class*, not their identity once all resource-relative membership facts are encoded in the key — the
same insight CoView's §4.7 cache uses. Two viewers in the same class (same effective role set, same
explicit user-grant/deny membership for this resource, same owner/ban flags, same inherited-parent
membership facts) get the same decision and can share a cache entry. The cache key composes:

```text
serverId + resourceKey + action
  + resourceAclVersion + parentVersions + resourcePermissionVersion
  + viewer-entitlement-class
```

where `viewer-entitlement-class` reuses CoView's canonical entitlement-class serialization
(foundation-plan §4.7) plus a per-resource membership component. That component records whether the
viewer is explicitly named by an allow/deny on this resource, whether any of the viewer's roles are
named by an allow/deny, whether `everyone` applies, whether `owner` applies, and the same facts for
each inherited parent consulted. This keeps cache sharing as wide as is *safe* and no wider:
owner/ban/explicit-grant/explicit-deny/inherited-membership differences split classes, exactly as
CoView requires.

### 11.3 ACL changes invalidate the right keys, narrowly

- A grant/revoke on resource R bumps R's ACL version → invalidates only keys containing R (and, for
  inheritable actions, children whose version vector consulted R).
- A role membership change fires `PermissionChangedEvent { roleId }` → invalidates keys whose
  entitlement class included that role.
- A ban fires `PermissionChangedEvent { userId }` → invalidates all keys for that user's classes.

The mechanism already exists for session/permission re-evaluation; this layer subscribes to the same
event and bumps the same kind of version.

### 11.4 Interaction frames do no authorization work

Per CoView's update lanes (foundation-plan §4.8), hover/focus/scroll/cursor frames carry no value
change and therefore trigger **zero** resolver calls. The resolver is consulted only on value-content
or value-metadata changes, or on a version bump. A 30 Hz cursor stream must never touch the ACL store.

---

## 12. PR Sequence

Each implementation PR ships its own security and performance tests (`bun typecheck`, relevant
`bun test`, lint clean on touched files) before merge, per repo discipline. Prefix: **RP-FOUND-N**.
The sequence interleaves with CoView's CV-FOUND ladder — RP-FOUND-1..4 should land before
CV-FOUND-7 (CoView's plugin SDK primitives), since CV-FOUND-7 consumes this resolver.

| PR | Scope | Proves |
|---|---|---|
| **RP-FOUND-0** | This planning doc. | Design alignment on a first-class plugin resource permission layer that CoView consumes. |
| **RP-FOUND-1** | Protocol/types: `PluginResourceKey`, `ResourceRef` plugin kind alignment with CoView, `ValueSlotRef`, `AuthDecision`, `ResolvedValue`, action vocabulary, Zod schemas. Additive; no behavior. | The wire/type layer can express resource identity, actions, and version-stamped decisions; secret values are unrepresentable on viewer-facing types. |
| **RP-FOUND-2** | Runtime resource registry + store: resource type registration (types, actions, parent, value slots, `producerValueAllowed: false` default), resource create/describe, ACL row store, version columns. No resolver yet. | Resources and ACLs persist with scope, parent links, and versioning; unregistered types/actions reject. |
| **RP-FOUND-3** | ACL resolver: precedence (§6.4), inheritance (§6.5), role/everyone/owner expansion via `RolesEngine`, ban short-circuit, fail-closed paths, `assertGrantSafe`-style delegated-grant guard. Pure decision engine + exhaustive unit tests. | `viewer + resourceRef + action → decision` is correct, deny-wins, and fail-closed. |
| **RP-FOUND-4** | SDK backend APIs: `resources.define/create/grant/revoke/check` over IPC, plugin adapter (`describe` + authorized `resolveValue` materialization) interface, capability declaration to use them. Tests prove a `producerValueAllowed: false` slot's viewer value comes from the adapter path, not the host render frame. | Plugins can declare and govern resources through the SDK; checks pass through to the runtime resolver only, and protected values have a runtime-controlled source. |
| **RP-FOUND-5** | SDK frontend primitives: `ResourceText`/`ResourceImage`/`ResourceIcon`/`ResourceValue` emitting gated `CoViewValueRef`s; literal render when CoView inactive. | A plugin renders resource-backed UI once; provenance travels for projection. |
| **RP-FOUND-6** | Demo family-album-style plugin or fixture exercising define → create → inherit → grant → render, with a resolver integration test (Billy sees, Sarah withheld). | The end-to-end model holds on a realistic plugin without a second CoView UI. |
| **RP-FOUND-7** | CoView integration: CoView's projection path calls the resolver for `pluginResource` refs; version stamps feed the entitlement-class cache. (Coordinates with CV-FOUND-7.) | CoView projects plugin values per viewer through this authority. |
| **RP-FOUND-8** | Hardening/perf/invalidation: entitlement-class cache, version-bump invalidation wired to `PermissionChangedEvent`, ban/revocation/stale tests, projection benchmark at fixed viewer × class counts, zero-resolver-work assertion for interaction frames. | Revocation/ban fail closed; interaction frames do no auth work; cache sharing is safe and narrow. |

---

## 13. Open Questions

1. **Persistence location — blocking before RP-FOUND-2.** Do plugin resource ACLs live in core (`core.db`, alongside roles) so the
   runtime resolver can read them without an IPC round-trip per check, or in the plugin's own SQLite
   with the runtime reading via adapter? Core-owned ACLs make the resolver fast and authoritative;
   plugin-owned ACLs keep data local to the plugin but add IPC latency and a trust question. Leaning
   core-owned ACL rows keyed by `(serverId, pluginSlug, resourceType, resourceId)`, plugin-owned
   *content*. This is not optional implementation detail: RP-FOUND-2 must not start until this is
   decided, because the resolver/cache design depends on whether ACL rows are locally readable.
2. **Role/group integration depth.** Do we expose plugin-defined groups, or only reuse server roles
   for `role` principals? Reusing server roles is simpler and consistent; plugin-defined groups may be
   needed for "the kids" that does not map to a server role.
3. **Custom action naming + collision.** Confirm the namespacing rule (`pluginSlug:action`) and
   whether base action names can be shadowed/redefined per resource type (proposed: no — base actions
   are reserved).
4. **Existence / count leakage — blocking before CV-FOUND-4.** For an unauthorized viewer, may CoView reveal that a resource
   exists or how many children it has (row count, photo count)? CoView plan §11.1 asks the same about
   message counts. Default here: existence/count **not** leaked unless the slot/registry accepts the
   leak (mirrors `preserve-host-rect`). The first text-channel viewer slice needs this answered before
   it renders unauthorized placeholders.
5. **Inheritance semantics edge cases.** Re-parenting a resource (move photo to another album) — does
   it re-evaluate against the new parent immediately (yes, by version bump) and should it ever be
   blocked if it would broaden access? Also: multi-parent resources (a photo in two albums) — out of
   scope for V1 tree model, or needed?
6. **External URLs / images becoming resource-provenanced.** A plugin rendering an external image
   (`<img src="https://...">`) has no resource provenance, so CoView must withhold it for non-owners.
   What is the path for a plugin to *mint* provenance for external content — proxy it through a
   runtime-governed `external.metadata.read`-style resource, or require import into a plugin resource
   first? CoView plan §4.4 already reserves `external.metadata.read`; this layer should define how a
   plugin opts external content into a `resourceRef`.
7. **Owner bypass for resources.** Recommendation for V1: no implicit content `read` bypass for server
   owners. Owners may receive explicit management powers by registry policy, but reading protected
   plugin content should require an explicit ACL/role grant. This is safer for CoView because
   host-owner status alone should not cause private plugin values to project as visible.

---

## Appendix A — File Reference Index

Existing surfaces this layer composes with or extends:

- Role engine & named permissions: `runtime/src/roles/engine.ts`, `runtime/src/roles/types.ts`,
  `runtime/src/core/permissions.ts` (`requirePermission`, `assertGrantSafe`),
  `runtime/src/core/permission-seeds.ts`.
- Plugin capability gate (IPC, not per-resource): `runtime/src/capabilities/checker.ts`.
- Plugin SDK permission/data surfaces: `packages/plugin-sdk/src/permissions.ts`,
  `packages/plugin-sdk/src/data.ts`, `packages/plugin-sdk/src/core.ts`,
  `packages/plugin-sdk/src/index.ts`.
- Plugin frontend SDK: `packages/plugin-sdk-frontend/src/index.ts`.
- Plugin manifests (capabilities + `public_schema`): `plugins/text-channels/manifest.json`,
  `plugins/voice-channels/manifest.json`.
- Protocol: `packages/protocol/src/index.ts`, `packages/protocol-schemas/src/index.ts`.
- CoView (consumer of this layer): `runtime/src/co-view/` (`permissions.ts`, `handlers.ts`,
  `registry.ts`, `types.ts`), `docs/coview/foundation-plan.md`.
- CoView spec: `.claude/docs/Overview/spec-27-co-view-sessions.md`.
