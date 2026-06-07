---
vision: "Central knows nothing beyond 'this server exists at this URL'"
tenet: "Every feature is a choice"
depends-on: [spec-04-plugin-architecture, spec-09-client-apps, spec-22-core-module]
last-verified: 2026-04-14
---

> **Archived 2026-04-16 — Superseded by [`spec-22-core-module.md`](../spec-22-core-module.md).** The split-tree layout model in spec-22 replaces the grid model described below. This document is retained for historical context only.

# 19 — Workspace Layout

*The customizable panel system that replaces the single-plugin viewport. Users arrange plugins into panels. Layouts persist per user per server. Server owners set defaults.*

---

## What the Workspace Is

The workspace replaces the current single-plugin viewport in the shell. Instead of one plugin filling the entire viewport, users can arrange multiple panels — each containing a plugin UI or a browser panel — into a layout they control.

The workspace is **platform infrastructure**. It is not a plugin. Plugins render inside panels. The platform owns panel creation, sizing, positioning, and persistence.

```
+----------------------------------------------------------+
|  Shell                                                    |
|  +----------+-------------------+----------------------+ |
|  | Sidebar  |  Panel A          |  Panel B             | |
|  |          |  [text-channels]  |  [members]           | |
|  | Server 1 |                   |                      | |
|  | Server 2 +-------------------+----------------------+ |
|  | Server 3 |  Panel C                                 | |
|  |          |  [browser: https://map.example.com]      | |
|  +----------+------------------------------------------+ |
+----------------------------------------------------------+
```

---

## Locked Decisions

- **The workspace is client-side only.** Layout rendering happens in the shell. The server stores layout data but never renders it.
- **One workspace per server per user.** A user's layout for Server A is independent of their layout for Server B.
- **The shell owns the workspace.** Plugins cannot move, resize, or destroy panels they did not create. Plugins can request panels but the user controls the final arrangement.
- **Default layouts are server-owned, not user-owned.** A server owner's default layout is the starting point for new users. Users can then customize from there. Changes are saved to the user's own layout, not the server default.

---

## Panel Types

| Type | What renders | Requires |
|---|---|---|
| **Plugin panel** | A plugin's frontend iframe | Plugin installed on the server |
| **Browser panel** | An Electron webview or web fallback | `client.browser` capability (see `20-browser-panel.md`) |

More panel types may be added in future phases (e.g. dashboard widgets, embedded terminal). The panel container interface is designed to be extensible.

---

## Layout Data Model

> **Note:** The grid model below is superseded by `22-core-module.md`, which locks the layout as a **recursive binary split tree**. The persistence mechanism (JSON blob in core DB, keyed by user) and the owner controls described in this document remain valid. Refer to `22-core-module.md` for the authoritative data model.

A layout is a JSON blob stored on the server per user. The runtime stores it in the core database (not a plugin database). See `22-core-module.md` for the full type definitions.

---

## Layout Persistence

### Per-user layout

Stored server-side as a JSON blob in the core runtime database, keyed by `(user_id, server_id)`. Fetched by the shell on server connect. Saved on every user layout change (debounced — not on every drag event).

Because it lives on the server, it roams across devices automatically. A user who sets up their layout on desktop sees the same layout on web.

### Server default layout

Stored server-side as a JSON blob, keyed by `server_id`. Set by the server owner via an admin action. Applied to new users who have no saved layout for this server. Never overwritten by user customization — the default is a template, not a live document.

### Layout resolution order

1. User's saved layout for this server → use it
2. No user layout → copy server default layout as the user's starting layout
3. No server default → use platform default (single panel, full viewport)

---

## Shell Changes

The current shell has a single `<PluginViewport>` component that renders one iframe. This is replaced by a `<Workspace>` component that:

- Reads the user's layout on mount
- Renders each panel at its grid position
- Handles panel resize and drag (user interaction)
- Saves layout changes back to the server (debounced)
- Passes auth tokens to plugin iframes exactly as before (no change to the postMessage auth model)

### What does NOT change

- iframe isolation and the postMessage auth handshake are unchanged
- One WebSocket per server, routed by plugin slug — unchanged
- Plugin frontend code does not need to know it's in a panel

---

## Plugin Panel Creation

Plugins do not directly create panels. The user adds panels from the sidebar, same as today — they navigate to a plugin and it opens in a panel. The workspace remembers where that panel was placed.

Future: plugins may be able to *suggest* opening a sibling panel (e.g. a media plugin suggests opening a browser panel next to it). This is a Phase 3 feature and is not in scope for this document.

---

## Server Owner Controls

Server owners can:

- **Set a default layout** — via the server admin panel. Defines the starting arrangement for new users.
- **Lock panels** — mark specific panels as non-movable for all users (e.g. "the members list is always here"). Locked panels are visually distinguished.
- **Restrict panel types** — optionally prevent users from adding browser panels (operator preference, e.g. a children's server).

Server owners cannot:

- Force a layout change on users who have already customized their layout
- See or modify individual users' saved layouts

---

## Responsive Behavior

The grid reflows on small screens. On mobile-width viewports (< 768px):

- Multi-panel layouts collapse to a single-panel stacked view
- Users can swipe between panels
- Locked panels from server owners remain visible and in order

The workspace is functional on mobile but the multi-panel editing experience is desktop-only.

---

## Phase Scope

| Feature | Phase |
|---|---|
| Basic workspace with resizable panels | Phase 2 |
| Layout persistence (per-user, server default) | Phase 2 |
| Server owner default layouts + locked panels | Phase 2 |
| Panel restrict controls (block browser panels) | Phase 2 |
| Plugin-suggested sibling panels | Phase 3 |
| Shared/synchronized layouts (same view for all users) | Phase 3 |

---

## Relationship to Other Docs

- `09-client-apps.md` — describes the current shell architecture that this replaces
- `20-browser-panel.md` — describes the browser panel type specifically
- `04-plugin-architecture.md` — plugin frontends are unchanged; they render inside panels
