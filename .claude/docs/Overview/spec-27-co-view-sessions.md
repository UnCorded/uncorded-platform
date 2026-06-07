---
vision: "Central knows nothing beyond 'this server exists at this URL'"
tenet: "Get help should be universal — no platform left behind"
depends-on: [spec-04-plugin-architecture, spec-22-core-module, spec-23-scoped-presence, spec-09-client-apps]
last-verified: 2026-05-14
---

# 27 — Co-View Sessions

*A real-time guidance primitive: a host shares **the live state of their UnCorded shell** to one or more viewers, who watch it render inside a sized overlay and annotate over it with a laser pen + live cursor. State, not pixels — each viewer renders their own DOM from a stream of host events. Works on every platform that runs the shell, including mobile.*

---

## Why This Exists

Two real needs converge on the same primitive:

1. **"Show me where to click"** — a user is lost in a settings panel; a friend wants to point at the toggle without explaining six menu names. Discord-style screen share works for desktop; on mobile (where there is no `getDisplayMedia`) the user is stuck.
2. **"Help me without driving"** — even on desktop, screen share is the wrong tool when the helper does not need to *see pixels of unrelated apps* but does need to *see the host's UnCorded view exactly as the host sees it*, including admin-gated chrome the helper might not see in their own client.

Pixel-stream solutions (PR-6 screen share, OBS, MoonLight) solve the first by capturing the OS framebuffer. They cost MB/s of bandwidth, have 100-300ms encoder latency, expose every other window on the host's desktop, and **do not work on mobile** because no mobile platform exposes a public screen-capture API to a web app or wraps one cleanly into Electron-equivalent on iOS/Android.

Co-View is the other model: instead of streaming the host's framebuffer, the runtime broadcasts a stream of **shell state events** (route, panel layout, cursor position, hover state, modal open, input value). Each viewer's own UnCorded shell consumes the stream and renders the same DOM — at the viewer's native resolution, with the viewer's GPU, in a sized overlay over the viewer's own client. Bandwidth is KB/s, latency is dominated by network RTT (no encoder), and mobile works because nothing platform-specific is needed beyond the shell already runs there.

This is **not a voice-channels feature.** It is a runtime/shell primitive, available from anywhere in the app, gated by per-server permission and per-account default. The voice plugin can deep-link into it but does not own it.

---

## Locked Decisions

- **State-sync, not pixel-sync.** The runtime never captures, encodes, or streams a framebuffer. It broadcasts shell state diffs and discrete event records over WSS; viewers re-render. No video codec, no LiveKit, no SFU — Co-View rides the existing per-server WSS connection.
- **Branding.** Surfaced as **Co-View** in product copy. Anywhere the user-facing string would say "share screen" → "screen share" stays for the OS-pixel path; the state-sync path is always "Co-View." Deliberately not "Share UnCorded" (mistakable for sharing a download link) and not "Spectator" (passive connotation; viewers can annotate).
- **Runtime/shell feature, not a plugin.** Lives in `runtime/src/co-view/` (backend) and `apps/website/src/co-view/` (frontend). The viewer's own shell renders the inner shell using the viewer's own plugin iframes under the viewer's own identity — Co-View never executes host-credentialed code in a viewer's browser. The host's stream carries **shell structure only, never plugin content** — see §The Shell-State Boundary for the canonical allowlist. Plugin chrome appears with the host's role gates because the shell consults the host's permission set for *render gates only* (§Permission Elevation door 1). Plugin authors opt in to additional chrome-level redaction via the SDK: see §Privacy & Redaction Model.
- **Sidebar entry point.** The shell renders a Co-View row immediately above Support & Feedback. Disabled (greyed) when not connected to a server. Two-state when connected:
  - **No active sessions** → click opens "Start a Co-View" overlay (host flow).
  - **≥ 1 active session in this server** → click opens a roster of in-progress sessions; "Start new" is a secondary action in the roster.
- **Overlay-contained viewer.** A viewer never replaces their own shell. The host's view renders inside a sized overlay (HTML-preview-style), scaled to fit the overlay's dimensions. The viewer's own shell, sidebar, and current panels remain interactive around the overlay. The host's viewport is rendered at fixed host-pixel dimensions inside the overlay and CSS-`transform: scale(...)` to fit — so a 1920×1080 desktop host viewed in a 480×270 overlay sees the host's UI at exactly its real proportions, just smaller.
- **One coordinate system: host viewport space.** All cursor positions, slot rectangles, and annotation strokes are in host-viewport CSS pixels (post-DPR, pre-scale). Each viewer applies the overlay's scale transform once at render time. Element-stable coordinates (DOM-anchored offsets) are explicitly **rejected** as a design path — they break under host scrolling, virtualized lists, and animated layout.
- **Two visibility modes:**
  - **Public + blacklist** — anyone on the server can join unless explicitly blocked.
  - **Private + whitelist** — only invited users may join; everyone else cannot see the session exists in the roster.
  - Default per host is **Private + whitelist (empty)**. The host explicitly invites for each session.
- **Two render-permission modes (host-chosen at start):**
  - **As host (default)** — viewers see the host's chrome with the host's permission level. Admin-only buttons render for everyone in the session, exactly as they appear to the host.
  - **As viewer** — viewers see the host's *navigation and interaction* but the chrome is filtered through each viewer's own permissions. Useful when the host wants to verify "what does a regular member actually see at this screen?"
  - Even in *as host* mode, viewers cannot **act** — see §Permission Elevation.
- **Per-account default privacy with per-session override.** Account Settings → Co-View has: default visibility (private/public), default render mode (as-host / as-viewer), default redaction set (always-hide list of plugin slugs or panel ids). Every "Start Co-View" overlay shows these defaults pre-filled and editable per session. There is no separate `allow_mobile_host` setting — see §Layout Stability for why mobile is just a smaller workspace.
- **Three event categories** drive state-sync. Treat them differently:
  - **Navigation** (replay-safe): route changes, panel-layout writes, modal-open, popover-open, focus changes. Viewer re-runs them on join (catch-up) and on the live stream.
  - **Mutation** (host-local, never replayed, never on the wire): form submits, send-message, delete, kick, save. There is no `co-view.mutation.*` frame. The viewer sees the *visible result* of the mutation (the input clears, the sent message appears) because the resulting state diff flows through `co-view.state`. Animation cues that need an explicit "host pressed something" signal (button-press ripple, send-button confirmation pulse) ride `co-view.event { kind: "host.action_observed" }` — payload is `{ element_id, action_kind }`, never the underlying request payload.
  - **Continuous input** (state broadcast with redaction): typing in inputs, cursor position, hover, scroll position, drag in progress. Coalesced; redacted by §Privacy.
- **Permission elevation is render-only, three-tier.** When a viewer joins an *as-host* session, the runtime grants the viewer's session a temporary `co-view.render-as:<host_user_id>` capability. The shell honors it for **rendering** (admin-only chrome appears). Plugin **data fetches** still execute under the viewer's own identity (the viewer cannot read messages they would not normally see). **Mutations** never reach the plugin. Three doors, only one opens. See §Permission Elevation.
- **Ephemeral in-memory session state with reconnect grace.** Co-View sessions live in `runtime/src/co-view/registry.ts` only. Nothing persists. A host disconnect of < 60s holds the session open; longer ends it. A viewer disconnect always re-joins fresh on reconnect (no per-viewer scrollback).
- **Single runtime process per server.** Per `spec-03-server-container.md`, every UnCorded server is one Bun process inside one Docker container; there is no multi-runtime sharding within a server. In-memory session state is therefore not a deployment liability. If a future multi-runtime mode lands, it requires sticky routing of `(session_id, member_id)` pairs to the runtime owning the session — flagged as a future refinement; not v1 work.
- **Annotation layer is custom, not Excalidraw.** Built around `perfect-freehand` (~5 KB, pressure-curve smoothing) for pen strokes. Cursor + pen render as SVG over a sibling `<canvas>` on top of the host overlay. We do **not** import Excalidraw — its data model assumes a persistent canvas and infinite-pan world; Co-View needs ephemeral strokes anchored to the host viewport. Strokes fade after a configurable TTL (default 4s).
- **Cursor states are first-class.** Idle / hover / pressed / dragging / typing / selecting / context-menu-open / tap (mobile) / long-press (mobile). The cursor channel emits state transitions, not just `(x, y)` pairs, so viewers see *intent*, not just position.
- **Mobile is the same workspace at smaller dimensions; the protocol does not branch.** Today's shell already treats mobile as "the same `PanelLayout` tree at width < 768px" — `apps/website/src/components/ui/sidebar.tsx:81-90` flips the sidebar from a fixed column to an offcanvas Sheet, but `App.tsx` mounts a single `PanelLayout` with no mobile branch, and `apps/website/src/components/panel.tsx:266` derives touch chrome from `useCoarsePointer` (an MQL on `(pointer: coarse)`, see `apps/website/src/lib/use-coarse-pointer.ts`) — independent of viewport width. Co-View inherits this directly: a mobile host's workspace renders inside a desktop viewer's overlay at the host's measured dimensions; a desktop host's 4-panel split renders inside a mobile viewer's overlay at the host's dimensions, scaled. The host's `inputMode: "fine" | "coarse"` ships in the state stream so the inner shell renders the correct chrome variant. See §Layout Stability.
- **Replay safety is decided at the producer.** Auto-instrumented primitives (Modal, Popover, ContextMenu, Tooltip, Input, Button, etc., wrapped at the SDK level) tag each emission with `replay: "safe" | "unsafe"`. Plugin code that emits its own state goes through `sdk.coView.publish(event, { replay })` — `unsafe` events are always dropped from join-time catch-up and only delivered live. Default for unrecognized custom events is `unsafe` (fail closed).
- **Co-View piggybacks on scoped presence.** A session is a presence scope: `co-view.session.<session_id>`. Membership = "is in this session." Meta = `{ role: "host" | "viewer", cursor: {...}, color: "#…" }`. The presence primitive (spec-23) handles join/leave/cleanup; Co-View adds the event channels on top.
- **Two channels per session, both runtime-internal:**
  - `co-view.state.<session_id>` — coalesced shell-state diffs (the watch-list of auto-instrumented things).
  - `co-view.events.<session_id>` — discrete events (route nav, modal open, cursor state, pen stroke).
  - Both ride the existing event bus. Neither plugins nor clients subscribe directly; the shell mediates.

---

## What Co-View Is Not

- **Not a screen share replacement.** PR-6 screen share (`pr-6-screen-share-contract.md`) and Co-View ship side-by-side. Screen share captures the OS framebuffer and is the right tool when the host wants to show a non-UnCorded window. Co-View renders state and is the right tool when the host wants to show their UnCorded view (and the only tool that works on mobile).
- **Not a remote control.** Viewers never act on the host's account or session. Pen + cursor are the only outputs. The mutation channel is closed by construction (it does not exist).
- **Not a recording.** No persistent storage; no server-side capture; no replay. End-of-session means the bytes are gone.
- **Not a collaboration mode for plugins.** Two users editing a shared canvas is a different problem (a collaborative-editing plugin owns its own CRDT/OT layer). Co-View is one-host-many-viewers, ephemeral, read-only-but-annotated.
- **Not a voice integration.** A host can be in voice while in Co-View; the runtime does not couple them. Spec-24 / PR-6 own voice; this spec owns shell state.
- **Not authoritative for plugin-internal state.** Plugins that want their internal scroll/selection to be visible in Co-View opt in via `sdk.coView.publish` (see §Plugin SDK Hook). Plugins that do nothing emit only what the auto-instrumented shell primitives capture.

---

## Threat Model

### What we defend against

- **Privilege escalation via render-as-host.** A viewer in *as-host* mode sees admin chrome but cannot act. The mutation channel is closed at the runtime (no `co-view.mutation.*` IPC frame exists; the SDK exposes no API to issue one). The only outputs from a viewer are `co-view.cursor` and `co-view.pen` frames, both of which the runtime accepts only for the viewer's own session entry and routes only to other Co-View members of the same session.
- **Cross-session leak.** Each session has a fresh `session_id` (ulid). Frame routing is `(session_id, member)`-keyed. The runtime rejects a frame whose `session_id` does not match a session the calling WS session is a member of.
- **Unauthorized join.** The runtime checks the host's whitelist/blacklist on every `co-view.join.req`. The Co-View permission `co-view.host` (server-level, owner-grantable) gates *starting* a session; viewers do not need a permission to join — only the host's invite (private) or absence-from-blacklist (public).
- **Sensitive data exposure via auto-instrumentation.** The four-layer redaction model (data access → view metadata → element marker → user toggle) bounds what the auto-instrumented primitives publish. Input values are redacted by default (fail-closed); primitives opt into sharing via `coViewShareValue`. See §Privacy & Redaction Model.
- **Replay of mutation as side effect.** Mutation events are tagged `replay: "unsafe"` at the producer. Join-time catch-up drops them. Live delivery includes them only as *visual* state changes (the input cleared) — the viewer never re-issues the underlying request.
- **Pen flood DoS.** Stroke ingest is rate-limited (`co-view.pen` ≤ 60 events/sec/member, coalesced server-side; max 200 strokes per viewer in flight). Cursor channel is rate-limited (`co-view.cursor` ≤ 30 events/sec/member, coalesced).
- **Plugin content masquerading as shell state.** The producer-side serializer that builds `co-view.state` diffs and `co-view.event` payloads asserts every emitted key against a closed allowlist of shell-structure fields (route, panel ids, `panelRects`, modal stack, popover stack, focused element id, scroll positions, redacted-input shadows, tab ids, cursor + pen). Unknown keys are dropped with a structured-log warning; tests in `runtime/src/co-view/__tests__/serializer.test.ts` enumerate the allowlist and fail if a code change adds a key without updating the list. The same tests **also validate value shapes** for allowed keys: a structurally-allowed field like `modal.title` is permitted to carry a string but rejected if the value contains plugin-record shapes (keys named `message`, `body`, `attachments`, `members`, `reactions`, or any nested object outside the field's documented schema). This catches the common failure mode where a structurally-allowed key gets fed plugin-fetched data — codex's "harmless-looking field named `previewText`" scenario. This is the executable form of §The Shell-State Boundary.

### What we do not defend against

- **The host's own client being malicious.** A host who deliberately publishes false state (forged `co-view.event` frames via devtools) deceives their own viewers. The viewers see what the host's runtime publishes; if the host bypasses the SDK, that is a social attack, not a security boundary. Server admins can `co-view.kick` and ban; nothing else is in scope.
- **A viewer screenshotting the overlay.** Co-View renders normal DOM in the viewer's browser; screenshots are inevitable. Hosts who do not trust viewers should not invite them.
- **Out-of-band pixel capture by the viewer's OS.** Same as above. Co-View renders state, but on the viewer's machine that state becomes pixels.
- **Plugin authors who render secrets in chrome the SDK observes.** Free-form DOM text *inside* a plugin iframe is NOT broadcast — the viewer's plugin frontend fetches its own data under the viewer's identity (door 2), so a secret rendered in an arbitrary `<div>` inside the host's plugin iframe is never seen by the runtime as host data and never reaches viewers. The narrow leak surface is **chrome the SDK auto-instruments**: modal titles, popover labels, tab labels, button text — these *are* part of the broadcast shell state because they describe the host's UI structure, and a plugin that renders a secret as a modal title (e.g. `<Modal title={apiKey}>`) leaks it via the navigation stream. Author-set `data-uc-coview="hide"` on the chrome element redacts it; `<form data-uc-coview-secrets>` does the same at the form level. The plugin author guide in `spec-04` documents this with the rule "treat any string you put into a shell primitive's label/title prop as user-visible to anyone the host invites."
- **Network observers between host and runtime.** Bytes are TLS-protected by the existing WSS connection. Co-View does **not** add E2E encryption between host and viewer (unlike spec-25 terminals). Rationale: Co-View ships the host's UnCorded view, which the runtime is already authoritative for; there is no "the server cannot see this" property to preserve. If a future Co-View use case requires E2E (e.g. private-channel co-view with end-to-end encrypted message content), it amends this spec.

---

## The Co-View Session Record

Held in `runtime/src/co-view/registry.ts`. **In-memory only.** Nothing is persisted; runtime restart ends every session.

```ts
interface CoViewSession {
  id: string;                       // ulid
  hostUserId: string;
  hostSessionId: string;            // the host's WS session_id (spec-23)
  visibility: "public" | "private";
  whitelist: Set<string>;           // user_ids; private mode
  blacklist: Set<string>;           // user_ids; public mode
  renderMode: "as-host" | "as-viewer";
  redactions: {
    panelIds: Set<string>;          // hide whole panels
    pluginSlugs: Set<string>;       // hide every panel of this plugin
    customSelectors: string[];      // host-added ad-hoc CSS selectors
  };
  createdAt: number;
  members: Map<string, CoViewMember>;  // ws_session_id → member (host included; role differentiates)
  cursors: Map<string, CursorState>;   // member_id → state (last seen)
  hostDisconnectedAt: number | null;   // null = host connected; non-null = countdown to teardown
}

interface CoViewMember {
  userId: string;
  sessionId: string;                // WS session_id
  joinedAt: number;
  color: string;                    // assigned at join, for cursor + pen
  role: "host" | "viewer";
}

interface CursorState {
  x: number;                        // host-viewport CSS px
  y: number;
  state: "idle" | "hover" | "pressed" | "dragging" | "typing"
       | "selecting" | "menu-open" | "tap" | "long-press";
  ts: number;
}
```

**Capacity:** soft cap 25 viewers per session, hard cap 50. Above the soft cap, new joins succeed but emit a structured-log warning and an audit event; above the hard cap, joins are rejected with `co_view_session_full`.

---

## Authorization Model

Two permission keys, both server-level, defined in the Core Module's permission registry:

- **`co-view.host`** — required to *start* a Co-View session. Default off; owner explicitly grants. A user without this permission sees the sidebar entry greyed with tooltip "Ask the server owner to grant Co-View hosting."
- **`co-view.moderate`** — required to call `co-view.kick.req` against a session the caller does not host (server admin "stop this Co-View" action). Default level **80** (admin).

**Joining a session needs no permission** — the host's invite (private) or absence-from-blacklist (public) is the gate.

The runtime enforces:

- `start.req` requires `co-view.host`.
- `join.req` consults the session's visibility + whitelist/blacklist.
- `kick.req` requires either being the session's host OR holding `co-view.moderate`.
- `mutation` frames do not exist; there is no IPC type to authorize.

---

## Permission Elevation — Three Doors

This is the most security-critical decision in the spec. Spell it out.

| Door | What | Elevated for *as-host* viewers? |
|---|---|---|
| **Render** | Which DOM nodes the viewer's shell paints (admin-only buttons, owner-only panels, role-gated chrome) | **YES.** The shell consults `co-view.render-as` instead of the viewer's own role for chrome visibility. |
| **Data** | What plugin data the viewer's runtime fetches (messages they can read, members they can list) | **NO.** Plugin queries always run under the viewer's identity. Co-View does not fetch the host's view of plugin data on the viewer's behalf — instead, the viewer renders their own data and the host's *navigation* on top. If the host is in `#secret-channel` and the viewer cannot see it, the viewer sees an empty/redacted panel where `#secret-channel` would be. |
| **Mutation** | Whether the viewer can issue a request to a plugin or the runtime that changes state | **NEVER.** No path exists. The mutation channel is not implemented. |

**Why data is door 2 and not door 1.** A viewer in *as-host* mode can see, for example, the **layout** of a private channel the host has open — the panel chrome, the channel name in the breadcrumb, the topic field if the host's plugin renders it as a navigation property — but cannot see the *messages*, because messages are plugin data fetched by the viewer's plugin frontend running under the viewer's own JWT. This is the right cut: "show me what the admin UI looks like" works, "let the viewer steal admin-only message contents" does not.

**Practical consequence.** When a viewer joins *as-host* and the host is reading a private channel:
- The breadcrumb shows the channel name (it is in the host's URL/route, which is in the navigation event stream).
- The channel panel renders, with the message-list area empty and a small Co-View badge: "You don't have access to this channel's messages."
- Pen + cursor still work over the rendered panel chrome.
- No message text is leaked.

**Practical consequence 2.** In *as-viewer* mode, the breadcrumb still shows the channel name (navigation is a leak Co-View accepts; the host can avoid it by switching channels before starting), but the chrome is filtered through the viewer's own role. Admin-only buttons do not render. Useful for "what does my UI look like to a regular member?"

The host can hide breadcrumbs entirely via the redaction set if even the channel name is sensitive.

---

## The Shell-State Boundary

The single rule everything else follows from:

**Plugin content/data is not Co-View state. Shell structure is Co-View state.**

This is the boundary the implementation defends, the boundary the threat model assumes, and the boundary that makes private destinations (channels, threads, DMs — none of which exist yet) cost Co-View no new security model when they ship.

### What the host MAY broadcast

- Route (URL path within the shell)
- Panel ids and panel layout (`panelRects`, split tree, ratios)
- Channel id / slug — and any identifier the shell already places into the URL or breadcrumb
- Scroll position per panel (intra-panel offsets, mirrored from host)
- Focused field id and caret position
- Redacted input shadows (caret + value-redacted indicator; raw value only when the primitive carries `coViewShareValue`)
- Modal / popover / context-menu stack (open/close, anchor, **label or title text** if the SDK primitive carries it)
- Tab id selections
- Cursor + pen events

### What the host MUST NOT broadcast

- Message rows or any plugin-fetched record
- Member lists fetched by plugins
- Attachment previews or file contents
- Channel contents (text, embeds, reactions)
- API responses, query results, cached plugin data
- Arbitrary iframe DOM — the runtime never reads inside a plugin iframe's DOM tree

The producer-side serializer enforces this list as a closed allowlist (see Threat Model, "Plugin content masquerading as shell state").

### Why this cut works

The viewer's plugin frontend fetches data under the viewer's JWT (door 2). If the viewer cannot read `#staff` messages, the plugin backend denies the subscription and the iframe renders a placeholder. The host's view of the channel — which messages, who is in it, which files — never traverses Co-View as a host-credentialed payload, because **no code path exists** that fetches host-plugin data and ships it to a viewer. The spec forbids adding one.

### The product rule

**Private content is protected by data permissions. Private destination metadata may be visible unless redacted.**

A viewer in *as-host* mode may learn "the host is in `#staff`" — that fact is in the route. A viewer cannot read `#staff` messages — that data is fetched under the viewer's JWT. If a session needs to hide even the destination, the host uses redaction layer 2 (hide the panel), the redaction-set `customSelectors` (hide the breadcrumb), or pause-share until they navigate elsewhere. This matches the leak surface most modern apps already accept (URLs, breadcrumbs, mentions, audit logs, invite contexts).

### What private destinations will need from plugins later (not Co-View)

When private channels (or threads, or DMs) ship, Co-View itself needs no new security model — door 2 makes it automatic. The plugins that own those destinations *will* need Co-View-aware empty/redacted states:

- "You don't have access to this channel" placeholder when subscription is denied (door-2 outcome).
- Hidden-panel placeholder honoring redaction layer 2.
- Redacted-breadcrumb / redacted-channel-title rendering when the host marks them.
- Distinct rendering for "route not found" vs "no access at this route" (today the channels plugin returns a generic empty state for both).
- Tests on the plugin's frontend asserting that no plugin-fetched record appears in any DOM the SDK auto-instruments (modal titles, popover labels, tab labels) — the chrome-text leak surface.

These items land alongside whichever PR introduces the first private destination type. They are tracked against that PR, not against Co-View.

### Author's rule of thumb

> *"If a string goes into a Modal/Popover/Tab/Button label or title prop, assume anyone the host invites will see it. If a value lives only inside the plugin iframe's DOM, the SDK does not see it and Co-View does not broadcast it."*

Documented in the plugin author guide (`spec-04`).

---

## Layout Stability

The single hardest design risk in Co-View is *visual fidelity under viewer-owned data* — door 2 of permission elevation means the viewer's plugin iframes fetch their own data, so a panel's content height can diverge from the host's. Without an explicit rule, cursors at host-viewport y=600 can land in dead space below a shorter viewer-side panel, and pen strokes drift off their visual targets.

### The rule

Inside a Co-View inner shell, every panel is pinned to its **host-measured rect**, not to the viewer's natural content height:

```
panelRects: {
  [leafId: string]: {
    x: number;          // host-viewport CSS px, top-left of the panel container
    y: number;
    w: number;
    h: number;
    scrollTop: number;  // intra-panel scroll, mirrored from host
    scrollLeft: number;
  }
}
```

The `panelRects` map is part of the broadcast shell-state (in `co-view.state` diffs and in `join.ack.current_state_snapshot`). The viewer's inner-shell panel host applies these CSS dimensions on every panel container. Plugin iframes inside those containers render into the host-given size regardless of their own content's natural height; if the viewer's data is shorter, the bottom is whitespace; if taller, it's clipped by `overflow: hidden`.

Modals and popovers follow the same rule — they are pinned to host-measured rects, not to viewer-content-derived rects, broadcast as part of the modal/popover stack state.

### Why this rule is feasible

It is a **swap of the source of truth for layout**, not a new constraint imposed on plugins. The current shell is already layout-driven, not content-driven, in three load-bearing places:

1. **Workspace splits use CSS `flex` ratios.** `apps/website/src/components/panel.tsx:685-686` and `:731-732` render every split as `<div style={{ flex: ratio }}>` — the panel container's size is determined by the parent split's ratio cascading down from the workspace root, not by what the plugin iframe wants. The split tree itself (`apps/website/src/lib/panel-layout.ts` — `LeafNode` / `SplitNode` with `ratio: number`) is a pure tree with no pixel measurements. Co-View just swaps "the viewer's saved split tree" for "the host's split tree" inside the inner shell; the rendering machinery is the same.
2. **Plugin iframes already render into a shell-given size.** The panel host sets the iframe's bounding box; iframes do not negotiate size with their parent. There is no postMessage protocol today through which a plugin asks to be taller. Co-View introduces no new constraint here.
3. **Mobile and desktop use the same workspace.** `apps/website/src/components/ui/sidebar.tsx:81-90` flips the sidebar from a fixed column to an offcanvas Sheet at width < 768px, but `App.tsx` mounts a single `PanelLayout` with no mobile branch. Touch chrome (two-stage close, ⋯ collapsed split icons) is gated by `useCoarsePointer` (`apps/website/src/lib/use-coarse-pointer.ts`) — an MQL on `(pointer: coarse)`, independent of viewport width. Co-View inherits both: the host's `inputMode: "fine" | "coarse"` rides in the state stream so the inner shell renders the same chrome the host sees, regardless of the viewer's own input mode.

### Coordinate consequence

With the rule in place, cursor and pen coordinates remain in host-viewport space and the inner shell renders them at overlay-local pixels via a single 2D transform (`translate(panX, panY) scale(s)`). At any zoom and pan, host's cursor at host`(400, 600)` paints at overlay-local `((400 - panX) * scale, (600 - panY) * scale)`. The viewer's pointer events are translated back through the inverse transform to host-viewport coordinates before being broadcast.

A cursor over "row 47 of host's message list" lands at the right viewport y on the viewer side even when the viewer's list has zero visible rows. The visual is "cursor over an empty area where messages would be" — semantically correct for door 2, and the host can pre-empt the awkwardness by hiding the panel entirely (Privacy layer 2).

### What plugins MUST respect

Inside a Co-View inner shell:

- The plugin iframe's `scrollHeight` is irrelevant; the panel container is host-sized. Plugins that one day might communicate "I want to be taller" via postMessage (none do today) would be ignored.
- The plugin iframe's intrinsic `viewport` (in case the plugin sets its own meta viewport) is irrelevant; the inner shell sets the iframe's size in CSS pixels.
- If a plugin renders a chrome element (e.g. a modal triggered from inside the iframe) at content-derived dimensions, those dimensions are broadcast as host-measured rects when the modal opens — the viewer renders the same modal at the same rect. Plugin-internal animation timing for the open/close transition is the plugin's own; the viewer sees the modal pop in at the final rect (no animated open on the viewer side, by current design).

A runtime warning surfaces in dev when a plugin attempts to size itself in a way the inner shell will override.

---

## Privacy & Redaction Model — Four Layers

Order of evaluation; the first that hides wins.

1. **Data access (door 2 above).** The viewer's plugin frontend never fetches data the viewer cannot read. This is the strongest layer; it is the default; nothing extra is required to enable it.
2. **View metadata.** Each panel in the workspace layout has a `coView: "shared" | "skeleton" | "hidden"` property (default `"shared"`). `"skeleton"` renders the panel chrome but blanks the contents. `"hidden"` renders a placeholder ("Panel hidden by host"). Set per panel via the host's Co-View overlay before starting; the host can also flip mid-session via the active-session controls.
3. **Element marker.** A plugin author marks a DOM node with `data-uc-coview="hide"` (replace with placeholder), `data-uc-coview="skeleton"` (replace with shape-of-content), or `data-uc-coview="value-hidden"` (e.g. the input itself renders, but its current value is replaced with `••••••`). The auto-instrumented input wrapper and the shell's serializer respect these; ad-hoc plugin DOM only respects them if it goes through the SDK's instrumented primitives.
4. **User toggle.** A persistent overlay during the host's session shows checkboxes for every active panel: "Share this panel," "Show as skeleton," "Hide entirely," plus a sticky "Pause sharing" button that suspends *all* state diff publication while held. The pause state is not an event the runtime infers — it is an explicit producer-side gate.

**Default for input values: redacted.** Every `<input>`, `<textarea>`, and `[contenteditable]` value is hidden from the state stream by default — the viewer sees the field render with its host-side caret position and a placeholder fill (e.g. `••••`) but no characters. Primitives opt into broadcasting raw values explicitly:

- The `<Input>` / `<Textarea>` primitives accept a `coViewShareValue` prop (default `false`).
- Ad-hoc DOM marks itself shareable with `data-uc-coview="value-shared"`.
- The compose box in text-channels is the canonical "share value" case ("watch what I'm typing"); plugin authors opt in case by case.

This is the inverse of an earlier draft that allow-listed text/email/url/search/tel/number — that default leaked sensitive content (DM bodies, search queries, payment-form fields) by accident. Fail-closed is the correct posture here; one prop per primitive is a small ergonomic cost for the safety win.

**Always-hidden by construction:**
- Account Settings (entire route — this is the user's identity / billing surface).
- The Co-View "active sessions" roster itself (recursion).
- Any DOM under a `<form data-uc-coview-secrets>` ancestor (escape hatch for plugin authors).
- The Cmd-K / quick-switcher overlay (would leak server names, friend names, etc.).

---

## Wire Protocol

All over the existing per-server runtime WSS endpoint, MessagePack-framed, sharing the same connection plugins use. Each frame is a flat `{ type: "co-view.<op>", ...fields }` object — same convention as `runtime.*` and `voice.*`.

> Field names in this section are the *intended* shape. Implementation MUST verify against canonical types in `packages/protocol/src/index.ts` before merge — per memory `feedback_verify_field_names_against_code.md`.

### Lifecycle

```
host  → server   co-view.start.req       { visibility, whitelist[], blacklist[], render_mode, redactions }
server → host    co-view.start.ack       { session_id, host_color }
                 co-view.start.nak       { code, message }

host  → server   co-view.update.req      { session_id, visibility?, whitelist?, blacklist?, render_mode?, redactions?, paused? }
server → host    co-view.update.ack      { session_id }

host  → server   co-view.end.req         { session_id, reason }
server → all     co-view.ended           { session_id, reason }
```

### Membership

```
client → server  co-view.join.req        { session_id }
server → client  co-view.join.ack        { session_id, host_user_id, render_mode, viewer_color, current_state_snapshot }
                 co-view.join.nak        { session_id, code, message }

server → host    co-view.member.joined   { session_id, user_id, color }
server → all     co-view.member.left     { session_id, user_id, reason }   // reason ∈ "explicit"|"session_closed"|"kicked"|"host_ended"

host    → server co-view.kick.req        { session_id, target_user_id, reason }
admin   → server co-view.kick.req        { session_id, target_user_id, reason }   // requires co-view.moderate
client  → server co-view.leave.req       { session_id }
```

### State sync (host → viewers)

```
host  → server   co-view.state           { session_id, seq, diff, replay: "safe"|"unsafe", ts }
server → viewers co-view.state           { session_id, seq, diff, replay, ts }   // forwarded as-is
```

`diff` is a JSON-merge-patch-shaped object over the well-known shell state schema (route, panel layout, modal stack, popover stack, focused element id, scroll positions per panel, redacted-input shadow values, etc.). The schema is owned by `apps/website/src/co-view/state-schema.ts` and shared as a TypeScript type with the viewer.

`seq` is a per-(session, host) monotonically increasing uint32, starts at 0, increments per state frame. Viewers track `last_seq` per session and request a snapshot on gap detection.

`replay: "safe"` — included in join-time catch-up snapshot.
`replay: "unsafe"` — only delivered live; dropped from snapshot.

### Discrete events (host → viewers)

```
host  → server   co-view.event           { session_id, kind, payload, replay, ts }
server → viewers co-view.event           { session_id, kind, payload, replay, ts }
```

`kind` is one of:

- `nav.route_change` — `{ from, to }` (URL path within the shell, redacted per redaction set)
- `nav.panel_open` — `{ panel_id, kind, slug }`
- `nav.panel_close` — `{ panel_id }`
- `nav.modal_open` — `{ modal_id, redacted }`  (`redacted: true` blanks the modal in viewers)
- `nav.modal_close` — `{ modal_id }`
- `nav.popover_open` / `nav.popover_close`
- `nav.context_menu_open` / `nav.context_menu_close`
- `host.action_observed` — host pressed a `<Button>` or equivalent. Payload `{ element_id, action_kind }` (e.g. `"submit"`, `"send"`, `"cancel"`). Drives viewer-side animation cues (button-press ripple, send pulse). Replay-unsafe by definition; never replayed. The state diff carries the actual visible result.
- `pen.stroke_begin` — `{ stroke_id, color }`
- `pen.stroke_point` — `{ stroke_id, points: [{x,y,p}, ...] }`  (coalesced)
- `pen.stroke_end` — `{ stroke_id }`
- `pen.clear` — `{ scope: "mine"|"all" }`  (host-only `"all"`)

### Cursor channel (member → all)

```
member → server  co-view.cursor          { session_id, x, y, state, ts }
server → others  co-view.cursor          { session_id, member_id, x, y, state, ts }
```

Coalesced server-side at 33ms (≤ 30 Hz). The runtime drops every cursor frame whose `(x, y, state)` matches the previous within the coalesce window — only deltas propagate.

### Snapshot — initial join vs. gap recovery

Two distinct paths, deliberately separated:

**Initial join — snapshot rides on `co-view.join.ack`.** The runtime fetches the host's current safe-state from the host's last cached snapshot (kept fresh by the host's state-channel producer) and inlines it into `join.ack.current_state_snapshot`. One round trip from viewer to first paint. No follow-up `snapshot.req` is needed for the join path. If the cached snapshot is empty (race: viewer joined before host published any state), `join.ack` carries `current_state_snapshot: null` and the viewer waits for the first `co-view.state` frame.

**Gap recovery — explicit `snapshot.req`/`res`.** Used only when a viewer detects a `seq` gap on the live `co-view.state` stream (a frame's `seq` skipped past `last_seq + 1`):

```
viewer → server  co-view.snapshot.req    { session_id, since_seq: number }
server → host    co-view.snapshot.req    { session_id, member_id, since_seq }
host   → server  co-view.snapshot.res    { session_id, member_id, seq, diffs?: StateDiff[], full_state? }
server → viewer  co-view.snapshot.res    { session_id, seq, diffs?, full_state? }
```

If the host's diff ring buffer (last 64 `co-view.state` frames) still contains every frame from `since_seq + 1` through current, the host returns `diffs: [...]` for the viewer to apply in order. Otherwise the host returns `full_state: {...}` and the viewer rebuilds from scratch. Either way, `seq` in the response is the host's current sequence number; the viewer aligns to it before resuming live processing.

Snapshots (both initial and gap-recovery) carry only `replay: "safe"` state. Unsafe events are never snapshotted, by construction.

### Heartbeat

Host and viewer rely on the existing WSS keepalive. Co-View does not add its own ping. Host disconnect = the host's WS session closes → registry marks `hostDisconnectedAt`; 60s grace, then `co-view.ended { reason: "host_lost" }` to all viewers and registry deletes the session.

---

## Auto-Instrumented Primitives

The shell ships a set of primitive components that emit Co-View state automatically. Plugin code that uses these primitives gets Co-View support for free; plugin code that hand-rolls equivalents must call `sdk.coView.publish` itself.

| Primitive | Emits |
|---|---|
| `<Modal>` | `nav.modal_open` on mount, `nav.modal_close` on unmount; `redacted: true` if any descendant has `data-uc-coview="hide"`. |
| `<Popover>` | `nav.popover_open` / `nav.popover_close`. Anchor element id included so viewers can position correctly. |
| `<ContextMenu>` | `nav.context_menu_open` with anchor, `nav.context_menu_close`. Selected item is NOT broadcast (it would leak right-click target before user confirmed). |
| `<Tooltip>` | NOT broadcast — viewers do not benefit from tooltip text appearing under the host's cursor; it would actually be confusing. |
| `<Input>` / `<Textarea>` | Caret position + a `valueRedacted: boolean` always broadcast. Raw value broadcast ONLY when the primitive instance has `coViewShareValue` set (default false; see Privacy §default for input values). Diffs published as `co-view.state` patches under `inputs[id]`. |
| `<Button>` | Click emits `co-view.event { kind: "host.action_observed", payload: { element_id, action_kind } }` for animation cues. No mutation, no replay. |
| `<Tabs>` | Active tab id broadcast as `co-view.state` patch. Replay-safe. |
| `<ScrollContainer>` | Scroll position coalesced at 50ms, broadcast as `co-view.state` patch. Replay-safe. |
| Panel mount/unmount (workspace layout) | `nav.panel_open` / `nav.panel_close` broadcast at the panel-host level, automatically. |
| Route navigation (router) | `nav.route_change` broadcast on every history push. |

Primitives live in `apps/website/src/components/primitives/` (already exists; some primitives have been partially wired for tooltip work in another session — Co-View instrumentation lands as a separate PR).

**Instrumentation cost:** a single `useCoViewBroadcast(stateRef)` hook subscribed to the shell's broadcast channel. When no Co-View session is active for the current user, the hook is a no-op (early return on a singleton ref). Active sessions add ~1 microtask per primitive state change.

---

## Plugin SDK Hook

Plugin frontends opt-in for plugin-internal state via:

```ts
// in @uncorded/plugin-sdk-frontend
sdk.coView.publish(kind: string, payload: unknown, opts?: { replay?: "safe" | "unsafe" }): void;
sdk.coView.observe<T>(key: string, getValue: () => T, opts?: { coalesceMs?: number; replay?: "safe" | "unsafe" }): () => void;
sdk.coView.isHosting(): boolean;
sdk.coView.markPrivate(el: Element): void;        // adds data-uc-coview="hide"
sdk.coView.markValueHidden(el: Element): void;    // adds data-uc-coview="value-hidden"
sdk.coView.pauseShare(): void;
sdk.coView.resumeShare(): void;
```

`observe` is the typical use: a plugin's selected-message-id, expanded-thread-id, scroll-anchor, etc. The hook walks the value at `coalesceMs` (default 50) and publishes diffs on change.

**Default replay safety for plugin-published events is `"unsafe"`** — opt in to safe explicitly. This is the right default because plugin authors are likeliest to forget that "selected message id 12345" replayed on join could surface a message the viewer should not see; treating it as unsafe means it propagates only live (when the viewer is actively watching), and the host's *current* view is what the viewer sees on join.

`pauseShare()` / `resumeShare()` are produce-side gates — they suspend *outbound* state and event publication but leave the session open; viewers see their last received frame frozen with a "Host paused sharing" overlay until resumed.

**Capability:** `co-view.publish` — plugins must declare this in their manifest's `permissions` array to call `sdk.coView.publish` / `observe`. Hooks no-op cleanly if undeclared (development warning logged once). `markPrivate` / `markValueHidden` / `isHosting` do not require the capability — they are read-only / DOM-attribute helpers.

---

## Cursor & Annotation Layer

### Rendering

The viewer's overlay is composed of three stacked layers:

1. **State layer** (DOM) — the shell rendering the host's state. Sized to host viewport, scaled to fit overlay.
2. **Cursor layer** (SVG) — one cursor per member. Each cursor is a small SVG path (state-dependent shape) plus a label with the member's name. Renders at host-viewport coordinates, scales with the state layer.
3. **Annotation layer** (Canvas) — pen strokes rendered with `perfect-freehand`. Two passes per frame: completed strokes (cached; redrawn on resize), in-flight strokes (per-point `getStroke()` re-evaluation). Strokes fade after `strokeTtlMs` (default 4000); fully-faded strokes are evicted.

### Cursor states

| State | Visual | Trigger |
|---|---|---|
| `idle` | small arrow | default |
| `hover` | arrow + small ring at hover target | pointer over an interactive element |
| `pressed` | arrow + filled ring | pointerdown |
| `dragging` | arrow + trailing line from press point | pointermove while pressed > 4px from press origin |
| `typing` | I-beam + small pulse | focus on a text input + recent keystroke |
| `selecting` | I-beam + selection-range underline (host-side selection range broadcast) | non-empty text selection |
| `menu-open` | arrow + small "▾" | a popover/context-menu has the cursor as anchor |
| `tap` | (mobile) brief expanding ring | touchstart/end within 200ms |
| `long-press` | (mobile) ring with progress fill | touchstart held > 500ms |

State transitions are detected in the host's pointer/touch handlers and emitted as part of the `co-view.cursor` frame. The shell never tries to infer state from raw `(x, y)` deltas alone — that would lose semantic information (a "drag" detected purely by movement looks the same as a "hover swipe").

### Pen tool

- Activated by toolbar button or keyboard shortcut `Alt+P` (host and viewers).
- Each member's strokes are color-coded with their assigned `color` (deterministic from member id + session id seed).
- `pen.stroke_begin` / `_point` / `_end` rides `co-view.event`. Coalescing collects up to 16 points or 33ms, whichever first, before emitting.
- Strokes are NEVER persisted, NEVER snapshotted — `pen.stroke_*` events are `replay: "unsafe"` by definition.
- `pen.clear { scope: "mine" }` clears the calling member's strokes for everyone in the session. `pen.clear { scope: "all" }` clears every member's strokes; only the host can issue `"all"`.
- TTL fade is local to each viewer (each viewer's render layer ages the stroke from its own clock starting at receive time; one viewer joining late does not see strokes that already faded on others).

### Element-level pen anchoring (rejected)

Considered: anchoring strokes to a host DOM element so a stroke "stays on the button" when the host scrolls. Rejected for v1: requires sending element identifiers per point, which is fragile under virtualized lists, animated layouts, and panel rearranges. Strokes are anchored to **host-viewport coordinates**; they appear to "stick" to the underlying UI only as long as that UI does not move. This is a deliberate trade-off — the laser-pen use case is "point at this thing for a moment," not "annotate this button forever."

---

## Frontend SDK Surface (host + viewer)

Mostly already exposed by the shell, but called out for completeness.

```ts
interface CoViewClient {
  // host
  start(opts: StartOpts): Promise<{ sessionId: string }>;
  update(sessionId: string, patch: Partial<StartOpts>): Promise<void>;
  end(sessionId: string, reason?: string): Promise<void>;
  pauseShare(): void;
  resumeShare(): void;
  invite(sessionId: string, userIds: string[]): Promise<void>;
  uninvite(sessionId: string, userIds: string[]): Promise<void>;
  kick(sessionId: string, targetUserId: string, reason?: string): Promise<void>;

  // viewer
  join(sessionId: string): Promise<void>;
  leave(sessionId: string): Promise<void>;

  // observation
  listActive(): Promise<CoViewSessionSummary[]>;     // sessions in the current server visible to the user
  observeActive(cb: (sessions: CoViewSessionSummary[]) => void): () => void;
  observeMembers(sessionId: string, cb: (members: CoViewMember[]) => void): () => void;
  observeCursors(sessionId: string, cb: (cursors: Map<string, CursorState>) => void): () => void;
}
```

Only the *shell* talks to the runtime via these — plugins use `sdk.coView.*` which is a strict subset (`publish`, `observe`, `isHosting`, `mark*`, `pauseShare`, `resumeShare`).

---

## Bounds and Limits

| Bound | Value | Notes |
|---|---|---|
| Sessions per server | unbounded (soft-capped by event-bus throughput) | Audit-logged count; alerts at > 50 concurrent. |
| Viewers per session | soft 25, hard 50 | Hard cap rejects with `co_view_session_full`. |
| State frame rate (host outbound) | ≤ 30/sec coalesced | Coalesced at producer (50ms windows). |
| Cursor frame rate | ≤ 30/sec/member | Server-side coalesce drops dupes. |
| Pen frame rate | ≤ 60/sec/member | Per-stroke point coalescing (16 points or 33ms). |
| In-flight strokes per viewer | 200 | Older strokes auto-evicted on overflow. |
| Snapshot ring-buffer per session | 64 diffs | Older = full-snapshot reissue. |
| Host disconnect grace | 60s | Hard-coded v1. |
| Pen stroke TTL | 4s default, 1–60s configurable per session | Set by host in start overlay. |
| Diff payload size | 16 KB max | Larger diffs trigger a full-state snapshot instead. |
| Event payload size | 4 KB max | Per `co-view.event` frame. |
| Custom selectors in redactions | 32 max per session | Per-selector length cap 256 chars. |

Violations surface as typed errors on the calling SDK promise. The runtime never silently truncates — over-budget events are rejected.

---

## Phase Scope

| Feature | Phase |
|---|---|
| `runtime/src/co-view/` registry + presence integration | Phase 2 |
| `co-view.start.*`, `join.*`, `end.*`, `member.*`, `kick.*`, `leave.*` wire frames | Phase 2 |
| `co-view.state` + `co-view.event` channels with coalesce | Phase 2 |
| `co-view.cursor` channel with state vocabulary | Phase 2 |
| Auto-instrumented primitives: Modal, Popover, ContextMenu, Input, Tabs, ScrollContainer, route, panel-mount | Phase 2 |
| Sidebar entry point + start/active overlays | Phase 2 |
| Overlay-contained viewer with scale-to-fit + cursor + pen layers | Phase 2 |
| `co-view.host` + `co-view.moderate` permissions in Core Module | Phase 2 |
| Account Settings → Co-View defaults | Phase 2 |
| Mobile host + mobile viewer (touch event mapping, mobile overlay) | Phase 2 |
| Plugin SDK hooks (`sdk.coView.*`) + `co-view.publish` capability | Phase 2 |
| Audit log integration | Phase 2 |
| Element-anchored stroke persistence | Future (see refinements) |
| E2E encryption between host and viewers | Future (see refinements) |
| Recording / replay | Out of scope (explicitly rejected; see §What Co-View Is Not) |

---

## Build Sequence

Phased PRs, each independently shippable behind a per-server feature flag (`co_view_enabled`, default off in dev only) until PR-CV6.

| PR | Scope | Verifies |
|---|---|---|
| **PR-CV0** (this) | Vault spec lands and is reviewed | Design alignment |
| **PR-CV1** | Runtime: `co-view/registry.ts`, lifecycle frames (`start`/`end`/`join`/`leave`/`kick`), presence-scope integration, permission gates, audit log. No state channel yet. Testable via raw WSS scripts. | Server-side primitive works |
| **PR-CV2** | State + event channels (coalesced producer-side, ring buffer for snapshots), snapshot req/res, replay-safety tagging. Auto-instrumentation of Route + Panel mount/unmount only. Viewer renders a "raw state diff" debug panel — no overlay yet. | State sync is correct |
| **PR-CV3** | Auto-instrument the rest (Modal/Popover/ContextMenu/Input/Tabs/ScrollContainer). Privacy & redaction layers 1-3 (data, view metadata, element marker). Viewer-side overlay shell (sized container + scaled state layer; no cursor/pen yet). | Real shell renders for viewers |
| **PR-CV4** | Cursor channel + cursor states + SVG cursor layer. Pen tool + `perfect-freehand` integration + canvas annotation layer. Pen TTL + clear. | Live annotation works end-to-end |
| **PR-CV5** | Sidebar entry point. Start-session overlay (visibility, render mode, redactions). Active-session roster. Per-account defaults in Account Settings. Pause/resume share. User toggle (privacy layer 4). | Production UX |
| **PR-CV6** | Mobile host + viewer. Touch event vocabulary mapping. Mobile overlay (full-screen-on-tap, gesture to dismiss). Permission default audit + flag default-on for opted-in servers. | Mobile parity, public-launchable |
| **PR-CV7** | Plugin SDK frontend hooks (`sdk.coView.publish`/`observe`/etc.), `co-view.publish` capability, manifest gating. Migrate text-channels to publish thread-selection state as a proof-of-concept. | Plugins integrate cleanly |

PR-CV1 and PR-CV2 are reviewable without any UI; PR-CV3 is the first commit that shows pixels. PR-CV6 is the public-readiness gate — do not announce Co-View externally before PR-CV6.

---

## Audit Log

Logged to `core.db` audit table (existing infrastructure). Metadata only — never state or pen content.

| Event | Fields |
|---|---|
| `co_view.session_started` | `session_id, host_user_id, visibility, render_mode, ts` |
| `co_view.session_ended` | `session_id, reason, duration_ms, peak_viewers, ts` |
| `co_view.member_joined` | `session_id, user_id, ts` |
| `co_view.member_left` | `session_id, user_id, reason, duration_ms, ts` |
| `co_view.member_kicked` | `session_id, target_user_id, by_user_id, reason, ts` |
| `co_view.permission_denied` | `user_id, action, session_id?, reason, ts` |
| `co_view.session_paused` / `_resumed` | `session_id, by_user_id, ts` |
| `co_view.update_applied` | `session_id, fields_changed[], ts` |

Owner-visible in admin panel. Filterable by user, session, time range. Standard audit-log retention.

---

## Performance Budgets

- **Start → first paint in viewer overlay:** < 600ms p95 on regional connection (handshake + initial snapshot + first render).
- **Host action → viewer paint:** < 150ms p95 server-side (coalesce window + bus + WS forward + viewer render); end-to-end including WAN RTT typically 200-300ms.
- **Cursor latency (host move → viewer cursor render):** < 80ms p95 server-side (bus tick + 33ms coalesce).
- **Pen stroke latency (host point → viewer point render):** < 80ms p95 server-side; in-flight strokes update at viewer render rate (60 FPS).
- **Idle host bandwidth:** < 1 KB/sec (heartbeat + occasional cursor-state changes).
- **Active host bandwidth (typing + scrolling):** 5-30 KB/sec.
- **Active host bandwidth (pen drawing):** 10-50 KB/sec for one heavy stroke.
- **Viewer client overhead vs. solo shell:** < 5% additional CPU at 30Hz state sync; < 10% with active pen.
- **Memory per session in runtime:** < 64 KB (registry record + snapshot ring buffer + presence entries).

These are aspirational targets for the spec; PR-CV6 measures actual numbers and locks them in.

---

## Failure Modes — Required Smoke Tests

| Scenario | Expected behavior |
|---|---|
| Host disconnects briefly (< 60s) | Viewers see "Host reconnecting…" overlay; session resumes when host returns. |
| Host disconnects > 60s | Session ends; viewers see "Host left." Audit logs `host_lost`. |
| Host closes their tab without ending | Equivalent to disconnect; same flow. |
| Viewer disconnects briefly | Viewer's session entry evicted; on reconnect, viewer must re-issue `join.req`. No partial reconnect. |
| Host has `co-view.host` revoked mid-session | Session ends within 1s with `reason: "host_permission_revoked"` (cascade subscriber, same shape as terminals cascade in spec-25). |
| Host banned from server mid-session | Session ends within 1s with `reason: "host_banned"`. |
| Viewer gains visibility (added to whitelist) mid-session | Viewer's `observeActive` callback fires; viewer can now `join`. No pre-join history is delivered. |
| Viewer loses visibility (added to blacklist / removed from whitelist) mid-session | Viewer is auto-kicked with `reason: "no_longer_invited"`. |
| Plugin frontend renders an unmarked input of any type | Default-fail-closed: every `<input>` / `<textarea>` / `[contenteditable]` value is redacted in the state stream unless the primitive carries `coViewShareValue` or the DOM node is marked `data-uc-coview="value-shared"`. |
| Plugin emits a custom event without specifying `replay` | Treated as `replay: "unsafe"` (fail closed). |
| Viewer joins mid-session | Snapshot delivered with safe-only state; viewer's overlay paints from snapshot then live diffs. Unsafe events from before join are not delivered. |
| Snapshot ring buffer rotates past viewer's `since_seq` | Host sends full snapshot. Viewer rebuilds. |
| Diff exceeds 16 KB | Producer fragments OR forces a snapshot; never silently truncates. |
| Pen flood (viewer spams strokes) | Server-side coalesce + 60/sec/member rate cap; over-budget frames rejected; viewer's SDK surfaces `co_view_pen_rate_exceeded`. |
| Cursor flood | 30/sec/member coalesce; same rejection path. |
| Two hosts try to start in the same WS session | Second start rejects with `co_view_already_hosting` (one host session per WS). |
| Viewer on mobile | Overlay fills screen at start; back-gesture / pull-down dismisses to roster; rejoin restores. |
| Host on mobile | No special gating — mobile is the same workspace at smaller dimensions per §Locked Decisions. The host's `inputMode: "coarse"` rides in the state stream; viewers render the host's touch chrome. |
| Host enables PR-6 screen share while in Co-View | Both run; viewers see Co-View overlay (state) + Co-View badge "host is also screen-sharing in voice". They are independent. |
| Plugin without `co-view.publish` calls `sdk.coView.publish` | No-op; one-time dev warning logged via the SDK's standard manifest-gate path. |
| Account Settings opened mid-Co-View session | Account Settings always-hidden — viewer sees redaction placeholder while host is in that route. |
| Cmd-K opened mid-session | Quick switcher always-hidden — viewer sees overlay with redaction placeholder during the open period. |

---

## Future Refinements

### Element-anchored pen strokes
- **What changes:** pen strokes can be anchored to a DOM element (via stable element id) so a stroke "stays on the button" when the host scrolls or rearranges.
- **Why not now:** virtualized lists and animated layouts make element-id stability fragile; the laser-pen use case is satisfied by viewport-anchored strokes with TTL.
- **What today's code must not do:** assume strokes are coordinate-only forever — the `pen.stroke_*` event payload should leave room for an optional `anchor: { element_id }` field in v2 without a wire break.

### E2E encryption host → viewers
- **What changes:** the runtime relays encrypted state/event/cursor frames; viewers decrypt with an ephemeral session key derived per-viewer.
- **Why not now:** the host's UnCorded view is data the runtime is already authoritative for; there is no confidentiality property to add. E2E becomes valuable only if viewers should see private-channel messages (door 2 of permission elevation), which v1 does not allow.
- **What today's code must not do:** assume the runtime always sees plaintext frame payloads. The frame envelope should already separate routing metadata (`session_id`, `member_id`) from payload, so a future `ciphertext` payload field is additive.

### Plugin-internal navigation in the snapshot
- **What changes:** `sdk.coView.observe` values can be tagged `replay: "safe"` AND included in the join-time snapshot, so a viewer joining mid-session sees the host's currently-selected thread, expanded message, etc.
- **Why not now:** v1 ships safe replay for shell-level state only; plugin-published state is unsafe-by-default to avoid accidental leak. Once a few plugins ship Co-View integrations and the privacy patterns are battle-tested, opt-in safe replay for plugin state is a one-flag change.
- **What today's code must not do:** treat the snapshot as a closed set. The snapshot transport should already accept plugin-namespaced state under `pluginState[<slug>]` so future integration is additive.

### Viewer interaction (door 4)
- **What changes:** a fourth permission door — *interaction* — that lets a viewer with elevated trust drive the host's session (queue clicks, type into inputs that the host accepts).
- **Why not now:** the threat surface explodes (viewer can act with host's identity); UX needs explicit confirmation per action; no demonstrated demand. Mutation channel does not exist in v1 by deliberate construction.
- **What today's code must not do:** add any IPC frame whose effect is "viewer issues a request that runs under host identity." If the need arises, design as a wholly separate primitive (call it Co-Drive), not as an extension of Co-View.

### Recording for support sessions
- **What changes:** server-side recording of the state/event stream (not pixels) to a local file, replayable by the host or admin later.
- **Why not now:** straightforward to add (the streams are JSON), but adds storage management, retention policy, and consent UX. No demand yet.
- **What today's code must not do:** assume frames are transient at the point they are produced. The producer-side coalesce is fine; do not, however, mutate frame contents post-publish in a way that would make a recorded frame inconsistent with what live viewers received.

### Multi-host sessions
- **What changes:** two hosts share the same session, viewers see both hosts' cursors + pens, picking which view the overlay renders.
- **Why not now:** state-sync from two sources requires conflict resolution on the shell-state schema; out of scope for v1's "one user shows their view" use case.
- **What today's code must not do:** hard-code `session.hostUserId` as singular without leaving the `members` map general — multi-host is "promote a member to host," which is a registry-state change, not a wire-protocol change.

### Cross-server Co-View
- **What changes:** a host invites a viewer who is not a member of the host's server; viewer joins via Central-mediated handshake, sees only the session (no other server data).
- **Why not now:** Central does not currently mediate cross-server identity beyond JWT issuance. Cross-server invite would need a Central endpoint and a one-shot scoped token. Not Phase 2.
- **What today's code must not do:** assume `viewer.user_id` is always a member of the server. The membership check should already query Core Module's member list (which is the right place to extend for cross-server later).

---

## Relationship to Other Docs

- `spec-04-plugin-architecture.md` — capability grammar (`co-view.publish`), plugin SDK surface, manifest `permissions[]`. Plugin authors implementing Co-View support read this for the SDK boundary.
- `spec-22-core-module.md` — permission registry (`co-view.host`, `co-view.moderate`), audit log, member list (used by visibility checks).
- `spec-23-scoped-presence.md` — Co-View sessions are a specialized presence scope (`co-view.session.<session_id>`); the runtime presence module owns membership lifecycle, eviction, and session-close cascade. Co-View adds the state/event/cursor/pen channels on top.
- `spec-09-client-apps.md` — shell-level routing, panel layout, and the workspace primitives that auto-instrumentation hooks into.
- `pr-6-screen-share-contract.md` — sibling feature; pixel-stream path. Co-View and screen share ship side-by-side and serve different use cases (UnCorded UI guidance vs. arbitrary-window sharing).
