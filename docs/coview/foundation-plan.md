# CoView Foundation Plan

> Status: **Planning / design foundation** (PR-CV-FOUND-0). No engine code in this PR.
> Owner: Dakota. Author seat: this branch (`foundation/coview-plan`).
> Companion spec: [`.claude/docs/Overview/spec-27-co-view-sessions.md`](../../.claude/docs/Overview/spec-27-co-view-sessions.md) (the locked product spec).
> This doc does **not** replace spec-27. It records the production foundation direction for CoView's parity, privacy, performance, and PR sequence.

---

## 0. TL;DR

CoView should feel like a high-quality live view of the host's UnCorded app, but with per-viewer redaction. It is **not** a pixel stream and it is **not** a rebuilt viewer-specific UI.

The target is **host render-tree projection**:

1. The host publishes a sanitized render tree/state for the UI it actually rendered.
2. The runtime preserves host-rendered structure, controls, layout, hover/focus/open state, scroll state, and menu state.
3. The runtime projects **data-bearing values** per viewer using resource permissions.
4. The viewer renders the same host UI shape, with protected values replaced by same-shape placeholders when that viewer is not entitled.

The core rule:

```text
control visibility = host permissions
data visibility    = viewer permissions
action execution   = viewer permissions / CoView collaboration policy
```

Example: if John is hosting and his channel context menu contains `Delete channel`, every viewer sees the `Delete channel` button because that is John's UI. A viewer without delete permission cannot execute that action. If the channel itself is private to John and Billy, Sarah still sees the panel, menu, hover, and button structure, but channel names, message bodies, timestamps, avatars, image pixels, and other channel data are projected as placeholders.

This is the production boundary this plan optimizes for:

- **Data values secure**
- **Structure seamless**
- **Video-like parity**
- **Website-render quality**
- **Per-viewer redaction**

---

## 1. Current-State Inventory

### 1.1 Spec & docs

- **`.claude/docs/Overview/spec-27-co-view-sessions.md`** defines CoView as structured state-sync, not pixel-sync. It already includes runtime-gated joins, overlay-contained viewing, host viewport coordinates, render modes, and a mutation channel closed by construction.
- The spec's privacy model assumes a producer-side shell-state boundary. This plan keeps the non-pixel direction, but moves the production privacy boundary to runtime projection.

### 1.2 Protocol

`packages/protocol/src/index.ts` already centralizes CoView lifecycle, roster, state, event, cursor, and snapshot frames.

The production gap is the state payload:

```ts
export type CoViewStateSnapshot = Record<string, unknown>;
export type CoViewStateDiff = Record<string, unknown>;
```

An opaque record cannot express "this text came from channel X" or "this image is album Y." Because the runtime cannot understand the values, it currently cannot project different bytes to different viewers.

### 1.3 Runtime

`runtime/src/co-view/` is already strong for session lifecycle:

| Concern | Current state |
|---|---|
| Host/join/kick/list authorization | Runtime-authoritative |
| Session registry | Ephemeral and indexed |
| Rate/size limits | Present |
| Audit | Metadata-only |
| State broadcast | Same opaque blob forwarded to all viewers |
| Per-viewer value projection | Not modeled |

The runtime is already the authority for **who is in a session**. It is not yet the authority for **which values each viewer receives**.

### 1.4 Website

`apps/website/src/co-view/` already has:

- host runner and producer
- consumer and viewer overlay
- shell-state schema
- cursor and pen producers
- redaction defaults
- producer/client tests

The current implementation is closer to "structured shell state" than a raw DOM mirror. That is useful, but the production goal needs to be sharpened: the viewer should see the **host-rendered UI shape and interaction state**, not a viewer-specific reconstruction that hides controls.

### 1.5 Current privacy model

| Concern | Today | Target |
|---|---|---|
| Who may host/join | Runtime | Runtime |
| Whether viewers can mutate host state | No mutation channel | Still closed |
| What controls exist | Producer-rendered shell state | Host-rendered UI tree/state |
| Which values travel | Producer redaction convention | Runtime projection per viewer |
| Per-viewer differences | None | Required |
| Secrets | Client-side redaction convention | Structurally absent or placeholder-only |

---

## 2. Product Model

### 2.1 Same UI means host-rendered structure

CoView must preserve the UI the host actually sees:

- panel tree
- tabs
- rows
- buttons
- menus
- labels as UI elements
- hover states
- focus states
- pressed/selected states
- open context menus
- scroll positions
- cursor/pen state
- element boxes and layout

Viewer permissions must **not** recalculate which controls exist. Host permissions already decided that when the host UI rendered.

### 2.2 Data values are projected

Data-bearing values are the privacy boundary:

- channel names
- message text
- author names
- timestamps
- avatars
- icons that reveal resource data
- image pixels
- album names
- photo captions
- document titles
- plugin resource values
- browser/page metadata if modeled

If the viewer can read the underlying resource, they receive the real value. If not, they receive a placeholder with the same intended shape.

### 2.3 Actions are separate

Seeing a button is not permission to execute the button.

For a viewer click on a host-rendered control, the default behavior is:

- no host mutation
- optional pointer/annotation/request behavior if CoView later supports it
- direct execution only if explicitly authorized by a future collaboration policy

This keeps video-like parity without granting ambient permissions.

---

## 3. Concrete Examples

### 3.1 Private text channel

John hosts a CoView session while viewing `#leadership`. Billy can read that channel. Sarah cannot.

John opens the channel context menu and hovers `Delete channel`.

Billy receives real channel data:

```html
<div class="channel-panel" data-host-panel="p1">
  <header>
    <span class="channel-icon">#</span>
    <span class="channel-name">leadership</span>
  </header>

  <div class="message-row is-hovered">
    <span class="msg-author">John</span>
    <span class="msg-ts">10:42 AM</span>
    <div class="msg-text">We need to review pricing before launch.</div>
  </div>

  <div class="context-menu open">
    <button>Mark as read</button>
    <button>Copy link</button>
    <button class="danger is-hovered">Delete channel</button>
  </div>
</div>
```

Sarah receives the same host UI structure and state, with channel data projected:

```html
<div class="channel-panel" data-host-panel="p1">
  <header>
    <span class="channel-icon placeholder same-size"></span>
    <span class="channel-name placeholder same-width"></span>
  </header>

  <div class="message-row is-hovered">
    <span class="msg-author placeholder same-width"></span>
    <span class="msg-ts placeholder same-width"></span>
    <div class="msg-text placeholder same-shape"></div>
  </div>

  <div class="context-menu open">
    <button>Mark as read</button>
    <button>Copy link</button>
    <button class="danger is-hovered">Delete channel</button>
  </div>
</div>
```

The context menu is not hidden. The delete button is not replaced with "Unavailable action." Sarah is watching John's UI. Sarah simply does not receive protected channel values and cannot execute John's action.

### 3.2 Family album plugin

Dad builds a family album plugin with the SDK. The album resource is restricted to Dad, Mom, and Billy.

If Billy watches Dad's CoView session, Billy sees the real album:

```html
<div class="album-panel">
  <h1>Summer 2026 Beach Trip</h1>
  <div class="photo-card is-hovered">
    <img src="photo://real/123" alt="Kids at the pier" />
    <span class="photo-title">Kids at the pier</span>
    <button>Open</button>
    <button>Download</button>
    <button>Share</button>
  </div>
</div>
```

If Sarah does not have album access, Sarah still sees Dad's album UI structure:

```html
<div class="album-panel">
  <h1><span class="placeholder same-width"></span></h1>
  <div class="photo-card is-hovered">
    <div class="image-placeholder same-size"></div>
    <span class="photo-title placeholder same-width"></span>
    <button>Open</button>
    <button>Download</button>
    <button>Share</button>
  </div>
</div>
```

The plugin author should not have to write a second CoView UI. The safe path should be normal SDK resource rendering: album/photo/caption/image nodes carry resource provenance, and the runtime projects those values per viewer.

### 3.3 Excalidraw-style plugin

Canvas-heavy plugins are harder because raw pixels hide the value/resource boundary.

The foundation rule:

- If the canvas content is backed by platform-governed resources with known provenance, the runtime can project it.
- If it is arbitrary pixels with no provenance, unauthorized viewers must receive a same-size placeholder for the content region.
- Platform/host chrome, toolbars, hover state, selection boxes, cursor position, and open menus can still mirror if they are content-free or resource-provenanced.

The goal is not "canvas gone forever." The goal is "unknown pixels do not become the privacy boundary." The SDK should make resource-provenanced canvas/drawing data possible later, but V1 cannot pretend arbitrary pixels are safe.

---

## 4. Target Architecture

### 4.1 Host render-tree projection

Replace opaque state blobs with a sanitized host render tree:

```ts
type CoViewRenderNode = {
  id: string;
  kind: "element" | "text" | "image" | "canvas" | "icon" | "control";
  role?: string;
  tag?: string;
  box: { x: number; y: number; width: number; height: number };
  state?: {
    hovered?: boolean;
    focused?: boolean;
    pressed?: boolean;
    selected?: boolean;
    open?: boolean;
    disabled?: boolean;
    scroll?: { x: number; y: number };
  };
  attrs?: CoViewSafeAttrs;
  value?: CoViewValueRef;
  children?: CoViewRenderNode[];
};
```

This is not raw DOM serialization. It is a renderer-safe tree that preserves what matters for parity while dropping dangerous or irrelevant browser internals.

### 4.2 Safe attributes

Only an explicit allowlist of attributes may travel:

```ts
type CoViewSafeAttrs = {
  classTokens?: string[];
  ariaRole?: string;
  ariaExpanded?: boolean;
  ariaChecked?: boolean;
  controlKind?: "button" | "menuitem" | "tab" | "input" | "select" | "toolbar";
  placeholderShape?: PlaceholderShape;
};
```

Raw `href`, `src`, inline styles, `title`, `alt`, `aria-label`, `data-*`, CSS generated content, and arbitrary attributes are data-bearing until proven otherwise. They must either become `CoViewValueRef`s or be dropped.

### 4.3 Value references

Data-bearing content is represented as a value reference:

```ts
type CoViewValueRef =
  | { origin: "public"; value: JsonValue }
  | {
      origin: "gated";
      policyRef: PolicyRef;
      resourceRef: ResourceRef;
      value?: JsonValue;
      placeholderShape: PlaceholderShape;
    }
  | { origin: "secret"; placeholderShape: Exclude<PlaceholderShape, "preserve-host-rect"> }
  | { origin: "local" };

type PlaceholderShape =
  | { mode: "synthetic"; width?: number; height?: number; lines?: number }
  | { mode: "preserve-host-rect"; sizeLeakAccepted: true; reason: string }
  | { mode: "absent" };
```

Rules:

- `public` values may travel to all viewers.
- `gated` values travel only to viewers authorized for `policyRef` + `resourceRef`.
- unauthorized viewers receive the placeholder, not the value.
- `secret` values are structurally unrepresentable on the viewer wire.
- `local` values never leave the producer.
- Runtime validation treats any incoming canonical frame containing `{ origin: "local" }` as malformed and returns a deterministic reject response. `local` may be dropped by the producer serializer before send; it must never be silently dropped by the runtime.
- `preserve-host-rect` is allowed only when the schema explicitly accepts the size/existence leak.

### 4.4 Resource and policy references

The runtime needs concrete authority references:

```ts
type PolicyRef =
  | "server.read"
  | "channel.read"
  | "channel.message.read"
  | "member.read"
  | "album.read"
  | "album.photo.read"
  | "plugin.resource.read"
  | "external.metadata.read";

type ResourceRef =
  | { kind: "server"; serverId: string }
  | { kind: "channel"; channelId: string }
  | { kind: "message"; channelId: string; messageId: string }
  | { kind: "member"; userId: string }
  | { kind: "album"; albumId: string }
  | { kind: "albumPhoto"; albumId: string; photoId: string }
  | { kind: "pluginResource"; pluginSlug: string; resourceType: string; resourceId: string }
  | { kind: "panel"; panelId: string };
```

V1 resolution is scoped to the CoView session's current server/workspace context. Cross-server resources are malformed unless explicitly designed later.

### 4.5 Render node categories

| Category | Mirrored from host? | Projected per viewer? | Notes |
|---|---:|---:|---|
| Layout boxes | Yes | No | May leak existence/size; schema controls sensitive cases. |
| Controls/buttons/menus | Yes | No for visibility | Host permissions decide existence. |
| Control enabled/disabled visual state | Yes | No for visibility | This reflects host UI state. It does not grant viewer action authority. |
| Hover/focus/open state | Yes | No | Needed for video-like parity. |
| Text values | Yes as nodes | Yes for content | Same node, projected value. |
| Images/icons | Yes as nodes | Yes for pixels/meaning | Icon can be data-bearing. |
| Canvas pixels | Same box | Yes if provenanced | Unknown pixels default to placeholder for unauthorized viewers. |
| Viewer clicks | N/A | Separately authorized | Default: no host mutation. |

### 4.6 Runtime projection

The runtime receives canonical host render frames and sends projected viewer frames:

```text
canonical host render tree
  -> validate schema / budgets / provenance
  -> group viewers by entitlement class
  -> resolve values per entitlement class
  -> send projected render tree to each viewer
```

Projection must preserve node identity and structure unless a surface is explicitly unsupported or unmodeled. For a gated value, projection changes only the value payload:

```ts
type CoViewProjectedValue =
  | { state: "visible"; value: JsonValue }
  | { state: "withheld"; placeholderShape: PlaceholderShape }
  | { state: "secret"; placeholderShape: PlaceholderShape }
  | { state: "unsupported"; reason: string };
```

### 4.7 Entitlement-class cache

Per-viewer projection cannot be O(viewers x nodes x frames) on every frame.

CV-FOUND-2 must implement an entitlement-class projection cache with deterministic keys. The top-level projection cache key includes:

- session id
- render mode
- viewer entitlement class
- resource permission version
- surface/schema version
- frame sequence or changed value ids

The `viewer entitlement class` component is itself a canonical serialized record, with fields in this exact order:

```text
role_set=<sorted canonical role ids>
session_visibility_mode=<public|private>
whitelist_membership_flag=<0|1>
blacklist_membership_flag=<0|1>
owner_flag=<0|1>
banned_flag=<0|1>
moderator_flag=<0|1>
render_mode=<as-host|as-viewer>        # only when distinct from top-level render mode
feature_flags=<sorted canonical per-view feature flags>
```

Normalization rules:

- Role ids, feature flags, user ids, server ids, resource ids, and enum values use canonical protocol ids and casing, never display labels.
- Sets are sorted bytewise by canonical id before serialization.
- Booleans serialize as `0` / `1`.
- Empty sets serialize as an empty value, not as an omitted field.
- Field order is fixed before concatenating or hashing; implementations must not use object iteration order.
- A viewer may share a projection only when every serialized entitlement-class field matches. This prevents over-broad cache sharing across owner/moderator/banned/whitelist/blacklist/render-mode differences.

Cursor/pen frames and pure hover/open/control-state frames must not trigger value authorization work unless a data-bearing value changed.

### 4.8 Update lanes

Separate update lanes keep performance predictable:

| Lane | Examples | Projection cost |
|---|---|---|
| Structure | nodes added/removed, panel layout, menu open/close | validate + maybe cache bust |
| Interaction state | hover, focus, selected, scroll, cursor | no value auth work |
| Value metadata | resourceRef/policyRef changes | validation + cache bust |
| Value content | text/image/icon/content changes | per-entitlement projection |

This preserves video-like responsiveness for hover/menu/cursor state without doing full authorization work at 30 Hz.

### 4.9 Surface schema registry

A registry still matters, but its role changes. It is not a schema for rebuilding a viewer UI. It is a schema for validating render-tree and value provenance.

The registry defines:

- allowed surface types
- allowed node kinds
- allowed value kinds
- which attributes may travel
- which values may be host-provided
- which values must be runtime-resolved
- `producerValueAllowed`, which defaults to `false` if omitted
- accepted placeholder modes
- accepted size/existence leaks
- unsupported/default behavior

Fail-closed producer values are a CV-FOUND-1 contract requirement. A gated slot is runtime-resolved unless its schema explicitly sets `producerValueAllowed: true`; otherwise a host-provided `value` on that slot is malformed and rejected. This distinction matters: a host may provide render structure and interaction state, but protected data values must either be runtime-resolved from `resourceRef` or explicitly allowed by schema. Forgetting the default would turn omission into accidental value exposure.

Registered first-party surfaces get detailed validation. Unregistered plugin interiors fail closed for data values but can still mirror outer shell/structure if safe.

### 4.10 Plugin SDK direction

The plugin SDK should make the safe path the normal path.

Plugin authors should build normal UI, but sensitive data comes from platform-governed resources or SDK primitives that carry provenance:

```tsx
<ResourceText resourceRef={{ kind: "album", albumId }} policyRef="album.read">
  {album.title}
</ResourceText>

<ResourceImage resourceRef={{ kind: "albumPhoto", albumId, photoId }} policyRef="album.photo.read" src={photo.url} />

<Button>Download</Button>
```

The buttons mirror because they are controls. The title/image project because they are data values. The author does not write a second CoView UI.

For raw plugin output with no provenance, runtime projection cannot safely infer privacy. It should preserve container/layout where possible and withhold content values by default.

---

## 5. Security Invariants

1. **Controls are not data permissions.** A viewer seeing a host-rendered control does not gain permission to run that action.
2. **Host permissions decide host UI structure.** If the host UI rendered a menu item, viewers see that menu item unless the entire surface is unsupported.
3. **Viewer permissions decide data values.** Data-bearing values resolve per viewer through runtime policy/resource evaluation.
4. **No protected byte crosses an unauthorized viewer's wire.** Client-side redaction is not the boundary.
5. **Secret values are unrepresentable.** Viewer-facing frame types have no field capable of carrying a secret value.
6. **Local values never leave the producer.**
7. **Snapshot and live frames use the same projection path.**
8. **Malformed frames reject whole.** Unknown node kinds, over-budget frames, value-bearing secrets, incoming `origin: "local"` values, host-provided values on `producerValueAllowed: false` slots, missing policy refs, and unsafe attributes are rejected, not truncated.
9. **Authorization uncertainty withholds.** Resolver errors, stale permission versions, deleted resources, and missing adapters fail closed.
10. **Layout leaks are explicit.** Preserving real size/count/position for a withheld value requires schema acceptance.
11. **Viewer mutation stays closed.** Accepted viewer frames are lifecycle/cursor/pen/annotation only unless a future CoDrive policy explicitly adds action execution.
12. **Transport assumption is normal TLS/WebSocket isolation.** This foundation does not add E2E encryption.

---

## 6. First Vertical Slice

The first implementation slice should prove the real product problem, not a toy breadcrumb.

**Recommended slice: one gated text-channel panel render tree.**

Why:

- It exercises resource-level visibility (`channel.read`).
- It preserves a rich host UI: panel header, message rows, hover actions, context menu, timestamps, author names, message body.
- It proves that controls are mirrored from host permissions while values are projected from viewer permissions.
- It is easier to reason about than canvas-heavy plugins but representative of the actual product.

Minimum slice:

1. Host opens a text channel panel.
2. Host hovers a message and opens a context menu containing at least one host-permission-derived action.
3. Viewer A can read the channel.
4. Viewer B cannot read the channel.
5. Runtime sends Viewer A real channel/message values.
6. Runtime sends Viewer B the same render tree structure/state with placeholders for channel/message values.
7. Both viewers see the same context menu controls and hover state.
8. Viewer B's wire bytes do not contain the channel name, message body, author name, timestamp value, image URL, or other protected values.

This slice should not require every channel feature. One stable message row plus one context menu is enough to prove the model.

---

## 7. PR Sequence

Each PR must ship its own security/performance tests. Legacy CoView state can remain during migration, but any v2 render-tree surface must use runtime projection.

| PR | Scope | Proves |
|---|---|---|
| **CV-FOUND-0** | This planning doc. | Design alignment around host render-tree projection. |
| **CV-FOUND-1** | Protocol types: canonical/projected render tree, safe attrs, value refs, placeholder shapes, policy/resource refs, viewer value states, Zod schemas, and schema defaults including `producerValueAllowed: false`. Additive; legacy state untouched. | Wire can express same UI structure plus per-viewer values. Secret/local cannot reach viewer type, and schema omission cannot permit host-provided protected values. |
| **CV-FOUND-2** | Runtime projection core: schema validation, resolver interface, `resolveForViewer`, deterministic entitlement-class cache, update lanes, projection benchmark. No producer wiring yet. | Per-viewer value projection is correct and has the production performance shape without over-broad cache sharing. |
| **CV-FOUND-3** | Website producer: emit one text-channel panel render tree behind a flag. Preserve controls/state; mark channel/message data with resource refs; drop local/secret values. Pipe producer output through runtime validator in tests, including rejection of any leaked `origin: "local"` or host-provided value on a runtime-resolved slot. | Host can produce a valid render tree without becoming the privacy authority. |
| **CV-FOUND-4** | Runtime broadcast path + viewer renderer for the text-channel slice. Live and snapshot frames use projection. | End-to-end: authorized viewer gets real values; unauthorized viewer gets same UI structure with placeholders; protected bytes never cross unauthorized wire. |
| **CV-FOUND-5** | Permission changes, cache invalidation, stale-resource behavior, snapshot/gap recovery parity. | Revocation and auth uncertainty fail closed without breaking structure. |
| **CV-FOUND-6** | Expand first-party surfaces: modals, popovers, inputs, tabs, scroll, panel chrome, richer channel rows. Retire producer-authoritative privacy for migrated surfaces. | Whole first-party shell follows the new boundary. |
| **CV-FOUND-7** | Plugin SDK resource primitives and plugin render-tree guidance. Family-album-style plugins can opt into safe projection without rebuilding a CoView UI. | Plugin authors get an easy safe path. |

---

## 8. Test Strategy

- **Type-level:** projected viewer frames cannot carry `secret` values or `local` values.
- **Schema validation:** reject unsafe attrs, unknown node kinds, unsafe `src`/`href`/`title`/`alt`/`aria-label` values, value-bearing secrets, incoming `origin: "local"` values, host-provided values on `producerValueAllowed: false` slots, missing policy/resource refs, and over-budget frames.
- **Host-control parity:** for a host-rendered context menu, both authorized and unauthorized viewers receive the same control nodes and interaction state.
- **Data projection:** authorized viewer bytes contain real text/image/icon values; unauthorized viewer bytes contain placeholders and not the protected substrings/URLs.
- **Action separation:** a viewer receiving a host-rendered button cannot execute that action unless an explicit collaboration policy allows it.
- **Snapshot parity:** join snapshots and gap-recovery snapshots project identically to live frames.
- **Permission revocation:** a viewer who loses `channel.read` starts receiving placeholders on the next projected frame.
- **Resolver failure:** auth lookup errors, missing plugin adapters, and deleted resources withhold and log diagnostics.
- **Shape leak checks:** `preserve-host-rect` requires schema-level `sizeLeakAccepted`; secret values default to synthetic/absent.
- **Performance benchmark:** CV-FOUND-2 tracks frames/sec per session at fixed viewer and entitlement-class counts, e.g. 50 viewers across 1, 5, and 25 entitlement classes using the canonical entitlement-class serialization in section 4.7. Interaction-only frames should produce zero value-resolution work.
- **No broad skips:** keep existing CoView/runtime/website suites green through the migration.

Verification gates per repo discipline: `bun run typecheck`, relevant `bun test` suites, and lint with no new warnings in touched files before any implementation PR merges.

---

## 9. Non-Goals

- Pixel streaming / screen sharing. That remains a separate product path.
- Arbitrary raw DOM serialization. CoView emits a sanitized render tree, not browser internals.
- Automatic safe projection of arbitrary canvas pixels with no resource provenance.
- Viewer action execution / CoDrive. Viewers can see host controls; they cannot execute host actions by default.
- E2E encryption, recording, multi-host, cross-server CoView.
- Reintroducing removed features: built-in adblock, Terminal Anywhere, plugin-driven browser opening.

---

## 10. Risks & Watch Items

- **Unsafe "exact DOM" temptation.** Raw DOM can leak through attributes, URLs, labels, alt text, CSS content, dimensions, and canvas pixels. The correct target is same rendered UI structure through a sanitized render tree.
- **Over-redaction breaks the product.** Hiding panels, menus, buttons, or controls because the viewer lacks permissions is wrong for CoView. Viewers are watching the host UI.
- **Under-redaction leaks data.** Any data-bearing text/image/icon/URL must have provenance or fail closed.
- **Plugin ergonomics decide adoption.** If plugin authors must write a second CoView UI, the model will not scale. SDK resource primitives need to make value provenance natural.
- **Performance must be built early.** Projection cache and update lanes belong in CV-FOUND-2, before the first end-to-end UI slice makes the feature feel "done."
- **Layout leaks need product decisions.** Same-size placeholders create strong parity but can leak count/length/existence. The schema must mark accepted leaks explicitly.
- **Two models during migration.** Legacy producer redaction and v2 runtime projection will coexist temporarily. Do not treat legacy producer redaction as production security for migrated surfaces.

---

## 11. Open Questions

1. **Placeholder policy for private channels.** Should unauthorized viewers see exact message count/row heights, or a stable synthetic skeleton count?
2. **Icons as data.** For private channels, should channel/member/avatar icons preserve shape only, or should some generic icon type remain visible?
3. **Context menu labels.** If a label itself reveals protected data, should the control remain with placeholder text while preserving size? Current answer: yes.
4. **Plugin resource API.** What is the minimal SDK primitive set that makes family-album-style plugins easy without a custom CoView schema?
5. **Canvas provenance.** What platform APIs would let drawing/canvas plugins expose object-level provenance without giving up their rendering model?
6. **Viewer click semantics.** Should clicks be ignored, shown as pointers, or become "request host action" events in a later PR?

---

## Appendix A - File Reference Index

Runtime: `runtime/src/co-view/{index,register,registry,permissions,handlers,state-handlers,merge-patch,audit,colors,types}.ts`, tests `runtime/src/co-view/handlers.test.ts`; wired via `runtime/src/main.ts` and `runtime/src/ws/router.ts`.

Protocol: `packages/protocol/src/index.ts`; `packages/protocol-schemas/src/index.ts`.

Website: `apps/website/src/co-view/{host-shell-runner,producer,host-context,primitives,viewer-session,consumer,viewer-overlay,cursor-producer,pen-producer,state-schema,co-view-defaults,client,active-sessions-store,merge-patch,ring-buffer,coords}.{ts,tsx}` plus co-located tests.

Spec: `.claude/docs/Overview/spec-27-co-view-sessions.md`.
