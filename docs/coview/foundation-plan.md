# CoView Foundation Plan

> Status: **Planning / design foundation** (PR-CV-FOUND-0). No engine code in this PR.
> Owner: Dakota. Author seat: this branch (`foundation/coview-plan`).
> Companion spec: [`.claude/docs/Overview/spec-27-co-view-sessions.md`](../../.claude/docs/Overview/spec-27-co-view-sessions.md) (the locked product spec).
> This doc does **not** replace spec-27. It records the *production refactor direction* for the privacy/trust model and the PR sequence to get there.

---

## 0. TL;DR — the one thing that changes

CoView already exists and is far more built-out than an "ad hoc mirror." It is a structured **state-sync** primitive (not a pixel stream), with a centralized wire contract, a runtime session lifecycle, state/event/cursor/pen channels, rate limits, and audit logging — all tracking spec-27.

The production gap is **not** "build CoView." It is **where the privacy boundary lives**:

- **Today:** the *host's client* decides what is broadcast. The producer scans the host DOM for `data-uc-coview` markers, redacts values, and emits an **opaque** `Record<string, unknown>` diff. The runtime forwards that blob **byte-identically to every viewer** and never inspects a key (`runtime/src/co-view/state-handlers.ts` → `broadcastToViewers`). Privacy is *producer-authoritative*.
- **Target:** the **runtime** is authoritative. State on the wire becomes a **content-free structure** of typed **slots**, each carrying an **origin** (`public | gated | secret | local`) and, for protected values, a `policyRef` / `resourceRef` the runtime can evaluate. The runtime resolves each gated slot **per viewer** and **withholds** values a given viewer is not entitled to. **Secret** values are *structurally unrepresentable* on the viewer wire. No client-side-only hiding remains the security boundary.

Everything below is in service of that single shift. The first vertical slice proves it end-to-end on **one** surface without shipping all of CoView.

---

## 1. Current-state inventory

### 1.1 Spec & docs

- **`.claude/docs/Overview/spec-27-co-view-sessions.md`** — the locked product spec. State-sync not pixel-sync; overlay-contained viewer; host-viewport coordinate system; two visibility modes (public+blacklist / private+whitelist); two render modes (`as-host` / `as-viewer`); three-door permission-elevation model (Render = yes, Data = no, Mutation = never); four-layer privacy model; full wire protocol; bounds table; phased PR plan (PR-CV0…PR-CV7).
- No prior doc under `docs/`. This is the first file in `docs/coview/`.

The spec is already aligned with most production goals (host-started, ephemeral, runtime-gated joins, mutation channel "closed by construction"). **What the spec under-specifies — and what this plan tightens — is the on-wire representation that makes "secret never crosses the wire" a structural property rather than a producer convention.** Spec-27 §The Shell-State Boundary says "the producer-side serializer enforces this list as a closed allowlist." This plan moves that enforcement to the runtime and makes it per-viewer.

### 1.2 Protocol — the wire contract (centralized ✅)

`packages/protocol/src/index.ts`:

- Lifecycle frames: `WsCoViewStartReq/Ack/Nak`, `WsCoViewUpdateReq/Ack/Nak`, `WsCoViewEndReq/Ack`, `WsCoViewJoinReq/Ack/Nak`, `WsCoViewLeaveReq/Ack`, `WsCoViewKickReq/Ack/Nak` (~lines 684–809).
- Roster: `WsCoViewListReq/Res/Changed` (~lines 855–891).
- Broadcasts: `WsCoViewEnded`, `WsCoViewMemberJoined`, `WsCoViewMemberLeft` (~lines 912–939).
- State/event/cursor/snapshot: `WsCoViewState` (line 1007), `WsCoViewEvent` (1033), `WsCoViewCursor` (1077), `WsCoViewSnapshotReq/Res` (1098/1114).
- Config types: `CoViewVisibility`, `CoViewRenderMode`, `CoViewRedactions { panel_ids[]; plugin_slugs[]; custom_selectors[] }` (lines 675–680).

**The load-bearing weakness for production:**

```ts
// packages/protocol/src/index.ts
export type CoViewStateSnapshot = Record<string, unknown>; // line 964
export type CoViewStateDiff     = Record<string, unknown>; // line 970
// WsCoViewState.diff: CoViewStateDiff                       // line 1011
// WsCoViewJoinAck.current_state_snapshot: CoViewStateSnapshot | null // line 762
```

The state payload is **opaque** at the protocol layer. The runtime cannot tell a public route from a secret API key — they are both "some value under some key." Per-viewer withholding is impossible without first giving this payload structure.

Zod validation: `packages/protocol-schemas/src/index.ts` (~lines 84–320) validates server→client *envelope* shapes (enums, frame discriminators) but treats `diff`/`full_state` as opaque records — it cannot enforce slot origins because they don't exist yet.

### 1.3 Runtime — `runtime/src/co-view/`

| File | Role | Production-relevant note |
|---|---|---|
| `index.ts` / `register.ts` | Public API + boot (`startCoView`, `CoViewHandle.dispatch`) | Wired in `runtime/src/main.ts`; router dispatch in `ws/router.ts`. |
| `types.ts` | `CoViewSessionInternal`, `CoViewMemberInternal`, `CO_VIEW_LIMITS` | Limits enforced: `STATE_DIFF_BYTES_MAX = 16*1024` (line 63), `EVENT_PAYLOAD_BYTES_MAX = 4*1024` (65), `HARD_VIEWER_CAP = 50` (57). |
| `registry.ts` | In-memory session store, 3-index lockstep | Ephemeral; no persistence. Host-disconnect grace tracked. |
| `permissions.ts` | `canHostCoView`, `canModerateCoView`, `isVisibleToUser` | **Authorization is already runtime-authoritative for join/host/kick.** Owner bypass, public→blacklist, private→whitelist. |
| `handlers.ts` | Lifecycle dispatch (start/update/end/join/leave/kick/list/connection-close) | Per-subscriber roster visibility (no existence-leak). Audit on every transition. |
| `state-handlers.ts` | `handleState/Event/Cursor/SnapshotReq/Res` | **The gap lives here.** `handleState` checks host-only + seq monotonicity + size cap, folds `replay:"safe"` into `session.safeStateSnapshot`, then `broadcastToViewers` forwards the **same diff to all** (lines 122–130). No per-viewer resolution. Runtime never inspects diff keys. |
| `merge-patch.ts` | RFC-7396 apply | Trusts producer; does not validate keys/values. |
| `audit.ts` | Metadata-only audit writes | Never logs diff/event/snapshot bodies. ✅ |
| `colors.ts` | Deterministic member colors | — |
| `handlers.test.ts` | Lifecycle test suite (virtual clock, mock bus/presence) | Strong lifecycle coverage. **No "protected value cannot cross the wire" test** — because the wire model can't express the concept yet. |

**Net:** the runtime is already the authority for *who is in a session*. It is **not** the authority for *what each member sees inside the state*. That is the production delta.

### 1.4 Website — `apps/website/src/co-view/`

- **Host production:** `host-shell-runner.tsx` (mounts producers, pause-gates outbound), `producer.ts` (coalesced merge-patch diffs + 64-entry ring buffer for gap recovery), `host-context.tsx` (mutable shell-state record + façade controller), `primitives.ts` (auto-instrumented `useCoViewModal/Popover/Input/Tabs/Scroll/ContextMenu`).
- **Viewer consumption:** `viewer-session.tsx`, `consumer.ts` (snapshot + gap recovery; **member color read only from `member.joined` meta, never from event payload — anti-spoof**), `viewer-overlay.tsx` (scaled host-viewport container, panel-visibility honoring, cursor/pen layers).
- **State model:** `state-schema.ts` — `CoViewShellState` with `route`, `workspace`, `panelMeta` (`visibility: "shared"|"skeleton"|"hidden"` line 36), `modals`/`popovers` (title/label + `redacted` flag), `contextMenus` (position only, never content), `tabs`, `scrolls`, `inputs` (`{ caret, valueRedacted, value? }` — raw value only when shared, lines 81–91). Closed top-level allowlist `CO_VIEW_SHELL_STATE_KEYS` (line 118).
- **Annotations:** `cursor-producer.ts` (30 Hz, 9-state vocabulary), `pen-producer.ts` (`perfect-freehand` strokes; color stripped client-side, sourced from member meta).
- **Redaction config:** `co-view-defaults.ts` — `"account-settings"` always-redacted (hardcoded), `"notifications"/"direct-messages"/"personal-files"` user-toggleable; mapped to panel ids via `redactionsForWire()`. Stored in `localStorage`.

**Where today's privacy actually happens (and why it's not production-grade):**

1. The **producer** (host's browser) reads `data-uc-coview="hide|skeleton|value-hidden|value-shared"` markers and a `coViewShareValue` prop, and decides what to put in the diff (`primitives.ts`).
2. Input values are **fail-closed** at the producer (redacted unless explicitly shared) — good default, but enforced *client-side*.
3. The runtime forwards the resulting blob unchanged to all viewers.

So a host whose client is compromised, buggy, or running a tampered build can emit a secret in a diff and **the runtime will faithfully broadcast it**. There is no server-side net. That is the precise property production CoView must add.

### 1.5 Current redaction / privacy model — summary

| Concern | Today | Authoritative where? |
|---|---|---|
| Who may host | `co-view.host` permission | **Runtime** ✅ |
| Who may join | visibility + whitelist/blacklist | **Runtime** ✅ |
| Mutation channel | does not exist | **Structural** ✅ |
| What's *in* the state | producer marker scan + fail-closed inputs | **Client (producer)** ❌ |
| Per-viewer differences | none — same blob to all | **N/A — not modeled** ❌ |
| Secret values | redacted by producer convention | **Client** ❌ |

### 1.6 Current tests

- `runtime/src/co-view/handlers.test.ts` — lifecycle, permissions, caps, grace window, roster-leak prevention. Strong.
- Website: `producer.test.ts`, `consumer.test.ts`, `host-context.test.ts`, `cursor-producer.test.ts`, `pen-producer.test.ts`, `co-view-defaults.test.ts` — coalesce, gap recovery, panel visibility, redaction-config persistence.
- **Missing:** any test asserting that a protected/gated/secret value *cannot* reach an unauthorized viewer's wire, because the model has no server-side concept to test.

---

## 2. Threat model hardening

Before the target architecture, lock the security claim precisely: origin alone is not an authority model.

A slot tagged `origin: "gated"` says "this value requires authorization," but it does not say which authorization rule applies. Production CoView must pair origin with an authority reference the runtime can evaluate. Otherwise the runtime can only trust the producer's broad classification, and a buggy or tampered producer can leak by labeling protected data as `public`.

### 2.1 Defend against

- **Unauthorized viewer receiving protected server data.** A gated value is only included when the runtime can validate the viewer against the slot's `policyRef` / `resourceRef`.
- **Stale permissions.** Role, membership, ban, whitelist, blacklist, and permission changes invalidate projections; uncertainty withholds.
- **Malformed frames.** Unknown slot kinds, missing origins, missing policy refs for gated slots, value-bearing secret slots, over-budget frames, and mismatched value shapes are rejected whole.
- **Buggy producer leaks — within schema-known surfaces.** For any surface and slot in the registry (§3.4), the runtime validates the producer's claim against the schema: a slot the registry marks `gated` / `secret` cannot be emitted as `public`, and runtime-resolved values (`producerValueAllowed: false`) are never host-supplied. A buggy producer therefore cannot leak a **registered** protected slot by mislabeling it.
- **Viewer mutation or spoof frames.** Viewers can annotate and leave/join; they cannot mutate host state or claim another member's cursor/pen identity.
- **Snapshot/live divergence.** Join snapshots and gap-recovery snapshots must pass through the same projection path as live diffs.

### 2.2 Do not fully defend against

- **A malicious host intentionally sharing their own state.** CoView shows what the host chooses to share; deliberate host deception is a social/admin problem, not a wire-security boundary.
- **Semantic misclassification outside the schema.** The registry (§3.4) defends *known* surfaces and slots. If first-party chrome puts a sensitive string into a slot the registry models as `public`, or into an unmodeled surface that is allowed to carry host-provided text, the runtime has no way to know the string is sensitive. Closing this fully requires modeling every sensitive surface in the registry; until then, **arbitrary semantic misclassification in first-party chrome remains out of scope**. Fail-closed defaults (unmodeled surfaces not mirrored; values runtime-resolved wherever the runtime owns them) shrink the surface but do not eliminate it.
- **Side channels from layout, existence, position, or size.** These must be modeled explicitly. Gated values may preserve host-measured size; secret values must use synthetic geometry, and the strongest form can omit the placeholder entirely.
- **Viewer screenshots.** Once authorized state renders in a viewer's browser, the viewer can capture pixels.

---

## 3. Target architecture

### 3.1 Core idea — the surface substrate

Replace the opaque `Record<string, unknown>` state with a **content-free structure model**: a tree of **surfaces** (shell regions, panels, chrome) each containing typed **slots**. A slot describes a *place where a value goes*, the value's **origin**, and, for protected values, the **authority reference** the runtime uses to decide who may see it. The structure (which panels exist, where, what shape) is freely shareable; the *values* are governed by origin plus policy.

```
Surface (e.g. panel "L1", modal "m2", breadcrumb)
 └─ Slot { id, kind, origin, policyRef?, resourceRef?, placeholderShape?, value? }
```

- **Structure** (surface tree, slot ids/kinds/positions, `panelRects`) = always shareable shell metadata. This is what spec-27 §The Shell-State Boundary already permits.
- **Values** = governed by `origin` plus `policyRef` / `resourceRef`. The runtime resolves them per viewer.

### 3.2 Slot origin model

| Origin | Meaning | On the viewer wire | Resolved by |
|---|---|---|---|
| `public` | Pure shell structure / non-sensitive (route path, panel id, tab id, scroll, cursor) | value travels as-is | producer → runtime → all viewers |
| `gated` | Visible only to viewers the runtime authorizes for this slot (e.g. permission-gated chrome label, channel name) | value travels **only to entitled viewers**; others receive a withheld placeholder | **runtime, per viewer, using policy/resource refs** |
| `secret` | Must never leave the host as a value (API keys, tokens, password fields, anything under `data-uc-coview-secrets`) | **no value field exists on the viewer wire** — structurally a placeholder only | structurally — host never serializes a value |
| `local` | Host-only, never relevant to viewers (host's private scratch UI state) | never serialized into any CoView frame | producer drops at source |

Two distinct guarantees, deliberately separated:

- **`gated`** is a *withholding* guarantee: the value may exist on the wire **to authorized viewers**, withheld from others. The runtime decides per viewer by evaluating the slot's authority reference.
- **`secret`** is a *representability* guarantee: the value is **structurally absent** from the viewer-facing type. No authorization can surface it; there is nowhere to put it. This is stronger and cheaper to verify (a type-level property + a serializer that has no code path to emit a secret value).

> Design rule: prefer making a thing `secret` (structurally unrepresentable) over `gated` (withheld) whenever no viewer should ever see the value. Reserve `gated` for "some viewers may, per authorization."

### 3.3 Policy and resource references

For any `gated` slot, the runtime needs enough semantic information to answer "what permission rule controls this exact value?" The canonical slot therefore carries:

```ts
type CoViewSlot = {
  id: string;
  kind: "text" | "image" | "icon" | "count" | "chrome" | "external";
  origin: "public" | "gated" | "secret" | "local";
  policyRef?: string;
  resourceRef?: string;
  placeholderShape?: "synthetic" | "preserve-host-rect" | "absent";
  value?: unknown;
};
```

Examples:

| `policyRef` | `resourceRef` | Runtime interpretation |
|---|---|---|
| `server.name` | server id | Public or server-member-visible server metadata. |
| `channel.name` | channel id | Resolve against the viewer's ability to read that channel. |
| `member.display_name` | user id | Resolve against the viewer's ability to see that member in this server/context. |
| `permission.action` | `core.members.manage` | Resolve against a concrete Core Module permission. |
| `external.browser.title` | panel id | External surface metadata; default withheld unless explicitly modeled. |
| `host.local.placeholder` | local affordance id | Host-only affordance; dropped before viewer projection. |

Rules:

- `gated` slots without a recognized `policyRef` / `resourceRef` are malformed and rejected.
- Producer-supplied policy refs are **claims**, not grants. The runtime evaluates them through its own roles, membership, plugin adapters, and render-mode rules.
- `secret` slots do not carry a value and do not need an authorization rule, because no viewer can ever receive the value.
- Every slot is validated against the **surface schema registry (§3.4)** before projection. The registry — not the producer — decides which slot ids exist on a surface and each slot's required origin; a producer can neither invent slots nor widen exposure.
- `public` is **allowlisted, not producer-declared**: a value is public only because the registry marks that exact slot id on that surface as known-safe public structure/value. Its shape must still match the slot kind/schema.

### 3.4 Surface schema registry

The origin tag and policy ref on a slot are **producer claims**. Claims are not authority. To make "buggy producer leaks" a *defended* case rather than a hope, the runtime — and the protocol package it shares — owns an **allowlisted registry of surface types and their slot schemas**. Every frame is validated against the registry **before** projection; anything the registry does not recognize is rejected.

```ts
// Owned by the runtime / protocol package — NOT producer-supplied.
type SurfaceType = "shell.breadcrumb" | "panel.header" | "external.browser" | /* … */;

type SlotSchema = {
  slotId: string;                 // exact id allowed on this surface
  kind: CoViewSlot["kind"];       // required wire kind
  origin: SlotOrigin;             // REQUIRED origin — the producer cannot widen it
  policyRef?: string;             // required ref name for gated slots
  resourceRefShape?: string;      // e.g. "channelId" | "userId" | "permission.action"
  placeholderShape: "synthetic" | "preserve-host-rect" | "absent";
  producerValueAllowed: boolean;  // may the producer supply the value at all?
};

type SurfaceSchema = {
  type: SurfaceType;
  slots: SlotSchema[];            // closed set; an unknown slot id => reject
};
```

The registry says, for example:

```
shell.breadcrumb:
  slot channel_name  → { kind: text, origin: gated, policyRef: channel.name,
                          resourceRefShape: channelId, placeholderShape: synthetic,
                          producerValueAllowed: false }   # runtime resolves the value
  slot route_segment → { kind: text, origin: public, producerValueAllowed: true }
panel.header:
  slot title         → { kind: text,   origin: public, producerValueAllowed: true }
  slot admin_action  → { kind: chrome, origin: gated,  policyRef: permission.action,
                          resourceRefShape: "core.permissions.manage", ... }
external.browser:
  slot title         → { kind: external, origin: gated, placeholderShape: synthetic,
                          producerValueAllowed: false }   # external surface, withheld by default
```

**Runtime rejects, per frame:**

- Unknown **surface type** → reject.
- Unknown **slot id** for that surface → reject.
- A claimed origin **wider** than the schema requires (schema says `gated`/`secret`, producer claims `public`) → reject. The producer can never *widen* a slot's exposure.
- A `gated` slot **missing the required `policyRef` / `resourceRef` shape** → reject.
- A **value present on a `secret` slot**, or a value present where `producerValueAllowed: false` → reject.
- A value whose **shape does not match** the declared `kind` → reject.

**Producer claims are validated, not trusted.** The producer may *classify within the narrow rules the registry allows* — choose which registered slot is present, and supply a value only where `producerValueAllowed: true` — but it cannot invent slots, cannot relabel a registered `gated`/`secret` slot as `public`, and cannot mark a sensitive surface's value public. There is no "whatever the producer says is public": `public` means **this exact slot id on this exact surface is a known-safe public field**, per the registry.

**Prefer runtime-resolved values over host-provided values.** For values the runtime already owns — channel names, member display names, permission/role labels, server settings — the schema sets `producerValueAllowed: false` and the host sends only the `resourceRef`. The runtime then **resolves the real value for each authorized viewer** (and withholds for the rest). This is strictly stronger than "host sent the value, runtime withholds it": the value never leaves the host for unauthorized viewers, and a buggy host cannot forge or leak it because it never sends one. Host-provided values are reserved for genuinely host-local chrome the runtime cannot resolve (the host's own shared input, a plugin label with no runtime adapter) — and only where the registry marks that exact slot safe.

### 3.5 Where resolution happens — runtime-authoritative per-viewer projection

The producer emits a **single canonical frame** describing the surface tree with slots tagged by origin. The runtime holds the canonical state and, **for each viewer**, computes a **projection**:

```
canonical state ──(runtime, per viewer, per frame)──▶ viewer-specific resolved frame
   public  → copied
   gated   → value included iff runtime authorizes (viewer, policyRef, resourceRef); else placeholder
   secret  → never present (producer never sent a value; type can't carry one)
   local   → never present (dropped at producer)
```

This means `WsCoViewState` is no longer forwarded "as-is." The broadcast path changes from one-blob-to-all to **resolve-then-send-per-viewer** (or, for efficiency, resolve-per-entitlement-class then send-per-class — see §10).

### 3.6 Authorization source

Per-slot `gated` authorization is answered by the **runtime's existing authority surfaces** (Core Module roles/permissions via `rolesEngine`, the same machinery `permissions.ts` already uses for join/kick), plus the session's **render mode**:

- `as-host`: viewers may see the host's **layout and chrome structure** and may receive host-visible chrome affordances only when the relevant slot policy says the value is render-only chrome. It must never mean "send host-authorized data to the viewer." Gated data resolution still uses the viewer's own authority unless the value is explicitly public.
- `as-viewer`: gated chrome slots resolve against **each viewer's own** permissions.

Crucially: **plugin record data (messages, member lists, attachments) is never a slot value of any origin.** It is not CoView state at all. It is fetched by the viewer's own plugin frontend under the viewer's JWT (spec-27 door 2). Slots model *shell chrome*, not plugin content. This keeps the boundary the spec already defends.

### 3.7 External surfaces (browser / live media / plugin iframe)

Browser panels, live media, RTC video, and plugin-iframe interiors are **external surfaces**: CoView models their *frame* (the panel rectangle, title, that "a browser panel is here") but **does not mirror their interior pixels or DOM**. On the viewer side they render as a structural placeholder ("External surface — not mirrored") unless and until a specific surface type is *explicitly modeled* with its own slot schema and origin rules. Default for anything not explicitly modeled is **not mirrored** (fail-closed), consistent with browser panels remaining user-owned.

### 3.8 What stays the same

- State-sync, not pixels. Overlay-contained viewer. Host-viewport coordinate system. Cursor/pen annotation. Ephemeral in-memory sessions. Presence-scope integration. The full lifecycle/roster/audit machinery in `handlers.ts` is **kept** — it is already production-shaped. Coordinates, ring buffer, snapshot req/res, rate limits: kept.

The refactor is concentrated in: **the state payload type (protocol), the producer serializer (website), and the broadcast/resolution path (runtime `state-handlers.ts`)** — plus tests.

### 3.9 Update lanes & performance model

Resolving every slot per viewer at cursor frame rates would be wasteful and is unnecessary: the things that change frequently (cursor, pen) need no per-viewer authorization, and the things that need authorization (chrome labels, channel names) change rarely. The design therefore separates **independent update lanes**, each with its own cadence and its own frame channel:

1. **Structure lane** — the surface tree: which surfaces/panels exist, `panelRects`, slot ids and kinds. Low frequency; changes on navigation/layout. It is content-free structure, so it is shared identically across all viewers (no per-viewer projection).
2. **Slot-metadata lane** — origin / `policyRef` / `resourceRef` / `placeholderShape` per slot. Validated against the registry (§3.4); effectively static within a surface's lifetime.
3. **Slot-value lane** — the resolved values. This is the **only** lane that runs per-viewer projection, and only **changed slots** re-resolve. Projections are cached by `entitlementClassKey` (viewers with identical authorization share one resolved result); a class is invalidated on role / member / permission / whitelist / blacklist change.
4. **Cursor / pen / event lane** — the high-frequency annotation streams. These already exist on their own channels and stay there; they are **never** coupled to slot-value re-resolution. A cursor moving at 30 Hz must trigger zero slot projection.

Consequence: a typical active session re-resolves slot values only when a gated value actually changes (rare), pays per-viewer cost on the slot-value lane alone, and runs cursor/pen at full rate with no authorization work. This keeps the per-viewer model inside spec-27's performance budgets (<150 ms host→viewer p95; cursor <80 ms). The lane separation must be designed into the protocol from CV-FOUND-1, not retrofitted.

---

## 4. Security invariants

These are the acceptance criteria for "production CoView." Each is testable.

1. **Protected data never crosses an unauthorized viewer's wire.** For a `gated` slot, a viewer not authorized for the slot's `policyRef` / `resourceRef` receives a placeholder, never the value — verified by capturing the exact bytes sent to that viewer's connection.
2. **Secret values are structurally unrepresentable.** The viewer-facing state type has **no field** that can carry a `secret` slot's value. The producer has **no code path** that serializes a secret value. This is a type-system + serializer property, not a runtime check that could be bypassed.
3. **Runtime authorization is authoritative.** Per-viewer slot resolution is computed in the runtime from the runtime's own authority (roles/permissions/render-mode/plugin adapters), never trusting a producer-supplied "this viewer may see X" hint.
4. **Stale permissions fail closed.** If a viewer's entitlement for a gated slot is revoked (role change, removal from whitelist, ban), the next projection withholds it; on any uncertainty (auth lookup error, race) the runtime **withholds** rather than includes. Mirrors spec-27's mid-session revoke cascade (`host_permission_revoked`, `no_longer_invited`).
5. **Malformed / over-budget frames are rejected, not truncated.** A frame exceeding `STATE_DIFF_BYTES_MAX` (16 KB) or `EVENT_PAYLOAD_BYTES_MAX` (4 KB), or failing structural validation (unknown slot kind, missing origin, `gated` without a recognized policy/resource ref, value present on a `secret` slot), is **rejected whole** with a typed error. Never silently clipped. (Spec-27 §Bounds and Limits already mandates this; we extend it to structural validation.)
6. **Viewers cannot mutate host state.** The only viewer→server frames accepted are the allowed annotation/control frames (`co-view.cursor`, `co-view.pen.*`, `join/leave/snapshot.req`). No mutation IPC exists; a `secret`/`gated` value never round-trips from a viewer. (Spec-27: mutation channel "closed by construction.")
7. **No client-side-only privacy.** Removing/disabling the viewer-side redaction UI must not expose any protected value, because protection is enforced before the bytes reach the viewer. Client-side markers may *drive* a slot's origin classification, but the *enforcement* is server-side projection + structural typing.
8. **Shape leaks are intentional or absent.** `gated` slots may preserve host-measured geometry for layout parity. `secret` slots must use synthetic geometry or be absent; they never carry real value length or real measured content box unless the surface explicitly accepts that existence leak.

Supporting invariants carried over from spec-27 (kept, not re-derived here): cross-session frame isolation, anti-spoof member color from server meta, audit is metadata-only, pen/cursor rate caps reject-not-truncate.

---

## 5. First vertical slice

**Goal:** prove the architecture end-to-end on exactly **one** shell surface, with all four origins represented, and a test that a protected value cannot reach an unauthorized viewer. Ship nothing else.

**Chosen surface: the shell breadcrumb + one panel header, defined by a registered surface schema and backed by a runtime-resolved value.** Rationale: it is pure chrome (no plugin-data dependency), it naturally contains all four origins, and it already flows through the existing producer. The surface ships as a real `SurfaceSchema` entry in the registry (§3.4) — `shell.breadcrumb` and `panel.header` with their slot allowlist — and the gated slot is **resolved by the runtime from a `resourceRef`**, not a producer-supplied "admin-only label." Concretely the slice carries:

- a `public` slot — the route/panel id and `panelRects` (structure), `producerValueAllowed: true`,
- a `gated` slot — a value the **runtime resolves from a `resourceRef`** (schema sets `producerValueAllowed: false`): e.g. the breadcrumb `channel_name` slot with `policyRef: channel.name`, `resourceRef: <channel_id>`. The host sends only the channel id; the runtime resolves the name **only for viewers who may read that channel** and withholds (synthetic placeholder) for the rest. (`permission.action: core.permissions.manage` on a `panel.header` admin action is an equally valid choice.)
- a `secret` slot — a header field marked `data-uc-coview-secrets` (e.g. a connection token shown in host chrome), which must be structurally absent as a value on the wire and use synthetic/absent geometry,
- a `local` slot — a host-only header affordance dropped at the producer.

**The slice spans, minimally:**

1. **Surface substrate type + registry entry** (`packages/protocol`): a typed `CoViewSurface` / `CoViewSlot { id, kind, origin, policyRef?, resourceRef?, placeholderShape?, value? }` model, the **viewer-facing** variant where `secret` slots cannot carry a value, **and the registered `SurfaceSchema` for `shell.breadcrumb` + `panel.header`** (the allowlist of slot ids / origins / refs the runtime validates against). Replace/augment the opaque `CoViewStateDiff` for these surfaces only (others stay on the legacy opaque path behind a flag — see PR sequence).
2. **Producer classification** (`apps/website/src/co-view/`): emit the breadcrumb surface as registered slots, derived from existing `data-uc-coview` markers + a small origin map. Drop `local` at source; never serialize `secret` values; for the gated slot, emit the `resourceRef` only (no value).
3. **Runtime validation + per-viewer resolution** (`runtime/src/co-view/state-handlers.ts`): replace `broadcastToViewers` for this surface with a path that first **validates the surface against the registry (§3.4)** (reject unknown slots, widened origins, value-on-secret, disallowed producer values), then `resolveForViewer(session, member, canonicalSurface)` projects per viewer — consulting `rolesEngine` / plugin adapters + render mode and **resolving the gated slot's value from its `resourceRef`** for authorized viewers only.
4. **Viewer renderer** (`apps/website/src/co-view/viewer-overlay.tsx`): render the resolved breadcrumb surface; gated-withheld → placeholder; secret → placeholder by construction.
5. **Tests** (the point of the slice): given a viewer **not** authorized for the gated slot, assert the bytes sent to that connection contain the placeholder and **never** the gated value; assert the wire type makes a secret value unrepresentable (compile-time + a runtime serializer test proving no secret value is ever emitted).

If this slice lands clean, the architecture is proven and the rest is mechanical expansion to more surfaces.

---

## 6. PR sequence

Each PR is independently reviewable and ships its own security tests. The legacy opaque state path stays alive behind a per-surface flag until CV-FOUND-6 retires it, so `main` never regresses.

| PR | Scope | Proves |
|---|---|---|
| **CV-FOUND-0** (this) | This planning doc. No engine code. | Design alignment; trust-boundary thesis agreed. |
| **CV-FOUND-1** | Protocol: introduce `CoViewSurface` / `CoViewSlot` / `SlotOrigin` types, `policyRef` / `resourceRef`, placeholder-shape metadata, the **surface schema registry** (allowlisted surface types + slot schemas), the separated update lanes (§3.9), and the viewer-facing variant where `secret` is unrepresentable. Zod schemas reject malformed frames and value-bearing secrets. **Additive** — opaque `CoViewStateDiff` untouched. | The wire can express structure + origin + authority + a registry; secret is structurally absent in the viewer type. |
| **CV-FOUND-2** | Runtime: registry-backed structural validation (reject unknown surface/slot, missing origin, **widened origin**, gated-without-policy, value-on-secret, **disallowed producer value**, over-budget) + `resolveForViewer()` projection. Unit tests prove gated withholding **and runtime-resolved values** against representative runtime policies. **No producer wiring yet.** | Per-viewer withholding + registry validation + fail-closed work in isolation. |
| **CV-FOUND-3** | Producer: classify the **breadcrumb/panel-header** surface into registered slots; emit `resourceRef` (not value) for runtime-resolved gated slots; drop `local`; never emit `secret` values. Serializer tests prove local drops and secret values never serialize. Behind `coview_surface_v2` per-surface flag. | Host emits the substrate for one surface without making the producer the privacy boundary. |
| **CV-FOUND-4** | Runtime broadcast path: route the v2 surface through `resolveForViewer` per viewer (others stay legacy). Viewer renderer renders resolved surface incl. withheld/secret placeholders. Add the end-to-end byte-capture test. | **End-to-end vertical slice** for one surface; protected bytes never reach an unauthorized viewer. |
| **CV-FOUND-5** | Permission-change and cache-invalidation hardening: stale permission fail-closed, entitlement-class cache invalidation, snapshot projection parity. | The invariants in §4 stay true under role/member/permission changes. |
| **CV-FOUND-6** | Migrate remaining surfaces (modals, popovers, inputs, tabs, scroll, panel visibility) to slots; retire the opaque path + the producer-side-only redaction as the *boundary*; keep markers as origin hints. | Whole shell on the substrate; producer-authoritative privacy removed. |

CV-FOUND-1 through -2 are reviewable with zero UI. CV-FOUND-4 is the first PR that shows the model working against a real surface. CV-FOUND-6 is the "no client-side-only privacy remains" gate.

> Relationship to spec-27's PR-CV* plan: spec-27 sequences *feature* delivery (lifecycle → channels → overlay → cursor/pen → UX → mobile → SDK). This CV-FOUND sequence is a **privacy-model refactor** of the state channel that the spec's PR-CV2/CV3 produce. They are complementary; CV-FOUND tightens the boundary spec-27 assumes the serializer enforces.

---

## 7. Test strategy

- **Structural / type-level:** a compile-time assertion (type test) that the viewer-facing state type has no field able to carry a `secret` value. A serializer unit test that, given a surface with a `secret` slot, the produced frame has no value field for it under any input.
- **Surface schema registry:** assert unknown surface types and unknown slot ids reject; assert a producer claim that **widens** a registered `gated` / `secret` slot to `public` rejects; assert a host-supplied value on a `producerValueAllowed: false` slot rejects; assert `public` is honored only for registry-allowlisted slot ids.
- **Policy/reference + runtime resolution:** assert `gated` slots require recognized `policyRef` / `resourceRef`, reject unknown policies, reject resource ids the runtime cannot evaluate, and fail closed on auth lookup errors; assert a `producerValueAllowed: false` gated slot's value is **resolved by the runtime from `resourceRef`** for authorized viewers and never read from the producer.
- **Per-viewer withholding (the headline test):** spin a session with host + two viewers (one authorized for the gated slot's real policy/resource, one not). Drive a canonical frame containing the gated value. Capture the **exact bytes** delivered to each viewer connection (via the runtime's `sendToConnection` seam already mocked in `handlers.test.ts`). Assert: authorized viewer's bytes contain the value; unauthorized viewer's bytes contain the placeholder and **do not** contain the value substring.
- **Fail-closed on stale permission:** revoke the gated entitlement mid-session; assert the next projection withholds; assert an injected auth-lookup error withholds (not includes).
- **Reject-not-truncate:** over-budget frame (>16 KB) and malformed frame (value on a secret slot, unknown slot kind, missing origin, gated slot missing policy/resource refs) each rejected whole with a typed error; nothing partial broadcast.
- **Snapshot parity:** join-time `current_state_snapshot` and gap-recovery `snapshot.res` pass through the same projection path as live state; a value withheld live is also withheld in snapshots.
- **Shape-leak checks:** secret placeholders use synthetic geometry or absence according to `placeholderShape`; they never carry real value length or real measured content size.
- **No viewer mutation:** assert no accepted viewer→server frame can carry a state value back to the host; only cursor/pen/lifecycle frames accepted (extends existing state-handlers tests).
- **Regression guard for the boundary:** a test enumerating allowed slot kinds that fails if a new kind is added without an origin rule (the executable form of spec-27's allowlist test, now origin-aware).
- **Every implementation PR carries its own security tests:** CV-FOUND-1 validates schemas, CV-FOUND-2 validates resolver withholding, CV-FOUND-3 validates producer serialization, CV-FOUND-4 validates end-to-end bytes, CV-FOUND-5 validates invalidation/snapshot parity.
- **Existing suites stay green:** `handlers.test.ts` and the website producer/consumer/cursor/pen tests must pass unchanged through CV-FOUND-4 (legacy path intact), and be updated alongside CV-FOUND-6.

Verification gates per repo discipline: `bun test` and `bun typecheck` clean before any PR merges; every fixed gap adds a regression test.

---

## 8. Explicit non-goals (deferred)

- **Full plugin-iframe mirroring.** Plugin interiors stay external surfaces; viewers fetch their own data under their own JWT (spec-27 door 2). Not modeled here.
- **Live browser / webview pixels.** Browser panels remain user-owned and unmirrored; modeled only as an external-surface placeholder.
- **Live RTC / video pixels.** Out of scope; screen-share (PR-6) is the separate pixel path.
- **Broad CoView polish** — sidebar entry UX, start/active overlays, account-settings defaults, mobile parity, pen TTL tuning. These are spec-27 PR-CV5/CV6 territory; not part of the foundation refactor.
- **Marketplace / community-plugin CoView integrations** and the plugin SDK `sdk.coView.*` hooks (spec-27 PR-CV7). Deferred until the substrate + boundary are proven.
- **E2E encryption, recording, multi-host, cross-server, element-anchored strokes, viewer interaction/Co-Drive** — all explicitly future per spec-27 §Future Refinements. The substrate must not foreclose them (envelope separates routing metadata from payload; slot model leaves room for an optional `anchor`), but none ship here.
- **Removed-from-scope features stay removed:** built-in adblock, Terminal Anywhere, plugin-driven browser opening. This plan does not revive them.

---

## 9. Risks & watch-items

- **Per-viewer resolution cost.** Resolving every frame per viewer at 30 Hz × up to 50 viewers is more CPU than forward-the-blob. The mitigation is the **update-lane separation + entitlement-class caching in §3.9** — it must be designed into the protocol from CV-FOUND-1, not retrofitted. Measure against spec-27 perf budgets (<150 ms host→viewer p95).
- **Snapshot path must also project.** `WsCoViewJoinAck.current_state_snapshot` and gap-recovery `snapshot.res` must run through the same per-viewer resolution — otherwise the join path leaks what the live path withholds. Call out explicitly in CV-FOUND-4.
- **Producer remains a classifier, but not the grant authority.** A buggy producer can still mislabel a `secret` as `public`. The structural guarantee covers *secret values that are correctly classified*, and `policyRef` / `resourceRef` lets the runtime validate many gated claims, but semantic mislabeling remains a producer bug. Mitigation: keep input values fail-closed (default `secret`/`gated`, opt into `public`), require policy refs for gated values, and lint/test the origin map. This matches spec-27's "fail closed" posture and is the honest limit of the boundary (spec-27 §What we do not defend against: a malicious host deceives their own viewers).
- **Two privacy vocabularies during migration.** Legacy `redactions` (panel/plugin/selector) and new slot origins coexist until CV-FOUND-6. Keep `redactions` as a coarse surface-level gate that *maps onto* origins; don't let them diverge.

---

## 10. Review answers / open questions for Dakota

1. **Doc location.** Keep this plan at `docs/coview/foundation-plan.md` for the PR.
2. **Refactor vs. amend the spec.** Keep this plan standalone for review, then amend `spec-27-co-view-sessions.md` after the model is accepted.
3. **First-slice surface choice.** Breadcrumb + one panel header stays acceptable only if the gated value is backed by a real runtime authorization rule. Prefer a channel name in a gated channel, a server setting/admin label tied to `core.permissions.manage`, or a browser-panel title proving external surfaces do not mirror by default.
4. **`gated` granularity.** Start per-viewer in code for correctness, but design entitlement-class cache keys from day one.
5. **Secret representation on the wire.** Present-but-valueless is acceptable, but the slot must specify placeholder shape: `synthetic`, `preserve-host-rect`, or `absent`. Default secret behavior should be synthetic or absent; preserve-host-rect is only for surfaces that explicitly accept the shape leak.
6. **Render-mode interaction.** `as-host` means host layout/chrome structure, not host-authorized data. Data resolution remains viewer-authorized unless the value is explicitly public.
7. **Legacy redaction config.** Keep `co-view-defaults.ts`' `localStorage` per-account defaults as the host-facing UX that *feeds* origin classification for now; it is orthogonal to the wire boundary.

---

## Appendix A — file reference index

Runtime: `runtime/src/co-view/{index,register,registry,permissions,handlers,state-handlers,merge-patch,audit,colors,types}.ts`, tests `handlers.test.ts`; wired via `runtime/src/main.ts` + `runtime/src/ws/router.ts`.

Protocol: `packages/protocol/src/index.ts` (CoView frames ~684–1123; `CoViewStateSnapshot`/`Diff` 964/970); `packages/protocol-schemas/src/index.ts` (~84–320).

Website: `apps/website/src/co-view/{host-shell-runner,producer,host-context,primitives,viewer-session,consumer,viewer-overlay,cursor-producer,pen-producer,state-schema,co-view-defaults,client,active-sessions-store,merge-patch,ring-buffer,coords}.{ts,tsx}` + co-located tests.

Spec: `.claude/docs/Overview/spec-27-co-view-sessions.md`.
