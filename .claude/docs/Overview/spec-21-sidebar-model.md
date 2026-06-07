---
vision: "Central knows nothing beyond 'this server exists at this URL'"
tenet: "Every feature is a choice"
depends-on: [spec-04-plugin-architecture, spec-09-client-apps, archive/19-workspace-layout]
last-verified: 2026-04-13
---

# 21 — Sidebar Model

*The sidebar is a runtime-composed list of items provided by installed plugins. The platform renders it. Plugins fill it. The shell never needs to know what a channel is.*

---

## The Core Principle

The sidebar has no built-in knowledge of channels, rooms, or any plugin concept. It is a generic list renderer. When a plugin is installed and running, it contributes items to the sidebar. When it is removed, its items disappear. The platform is not aware of what those items mean.

**Users never see plugins. They see features.**

A server with text-channels installed has a chat section. A server with a Minecraft plugin has a console and a live map. A server with only a kanban plugin has a board. The sidebar reflects what the server has, not what plugins are installed.

---

## Locked Decisions

- **The sidebar is runtime-composed.** The shell queries each running plugin for its sidebar items when the user connects to a server. The manifest does not fully describe sidebar shape — the plugin provides it live.
- **Plugins are invisible to users.** Plugin management lives in server settings only. The main UI never exposes plugin names, versions, or install state to regular users.
- **Admin controls are role-based, not plugin-based.** The platform does not know which items have admin controls. The plugin decides what to show based on the user's role. Same items, different controls.
- **Extensions contribute nothing to the sidebar.** A reactions extension, a mentions extension, an emoji pack — none of these appear in the sidebar. They layer onto existing plugin UI silently.
- **The shell is content-agnostic.** It renders items and opens them as panels. It does not know the difference between a chat channel and a game console.

---

## How Plugins Contribute Sidebar Items

When the shell connects to a server and a user authenticates, the shell calls each installed plugin's sidebar endpoint. The plugin responds with its current item list.

### Item shape

```ts
interface SidebarItem {
  id: string           // stable ID (e.g. channel ID, room ID)
  label: string        // display name
  icon?: string        // icon name from the platform icon set
  panelType: 'plugin'  // always 'plugin' for plugin-provided items
  slug: string         // which plugin owns this item
  adminActions?: SidebarAction[]  // only included if the requesting user has admin role
}

interface SidebarAction {
  id: string
  label: string
  icon?: string
}
```

### Example — text-channels plugin response

For a regular user:
```json
[
  { "id": "ch-general",       "label": "general",       "icon": "hash",   "panelType": "plugin", "slug": "text-channels" },
  { "id": "ch-announcements", "label": "announcements", "icon": "hash",   "panelType": "plugin", "slug": "text-channels" },
  { "id": "ch-dev-talk",      "label": "dev-talk",      "icon": "hash",   "panelType": "plugin", "slug": "text-channels" }
]
```

For a server admin:
```json
[
  { "id": "ch-general", "label": "general", "icon": "hash", "panelType": "plugin", "slug": "text-channels",
    "adminActions": [
      { "id": "create-channel", "label": "New Channel", "icon": "plus" },
      { "id": "edit-channel",   "label": "Edit",         "icon": "pencil" }
    ]
  },
  ...
]
```

The plugin decides what admin actions to include based on the user's role. The shell renders whatever it receives — it does not add or remove controls.

---

## Sidebar Sections

Plugins can optionally group their items under a named section header. The section name is part of the item response, not a separate declaration.

```ts
interface SidebarItem {
  ...
  section?: string  // e.g. "Chat", "Voice", "Minecraft"
}
```

If all items from a plugin share the same section, they render under one collapsible header. If a plugin provides no section, its items appear ungrouped.

The server owner can rename sections and reorder them via server settings. The plugin provides the default. The owner customizes from there.

---

## The Admin Actions Pattern

Admin actions are rendered inline next to the section header or individual items — not in a separate menu. A **+** next to "Chat" creates a channel. A **⋯** next to a specific channel opens edit/delete options.

When a user without admin role views the same sidebar, those controls are simply absent. The items are the same. The controls are not.

This means:
- No separate "admin view" vs "user view" — same sidebar, role-filtered controls
- No modals explaining what plugins are — the UI just shows what the server has
- No confusion about what the + does — it's always contextual to the section it's next to

---

## What Appears in the Sidebar vs Settings

| Appears in sidebar | Appears in settings only |
|---|---|
| Text channels (created by the plugin) | Plugin install / uninstall |
| Voice rooms | Plugin version and update |
| Plugin-specific items (console, map, board) | Plugin configuration |
| Browser panel items (if added by owner) | Sidebar section reordering |
| Server Settings item (for admins) | User role management |

Server Settings is itself a sidebar item — admins can drag it into a panel and manage the server without leaving the workspace. Regular users do not see it.

---

## Extensions and the Sidebar

Extension plugins (reactions, mentions, emoji packs, thread support) do not contribute sidebar items. They hook into the base plugin's frontend and layer their UI onto existing content.

From the user's perspective, reactions just appear on messages. There is no "Reactions" section in the sidebar. The extension is invisible.

From the shell's perspective, the extension has no sidebar contribution — the shell never queries it for items.

---

## Static Items (Non-Plugin)

A small number of sidebar items come from the platform itself, not from plugins:

| Item | Source | Who sees it |
|---|---|---|
| Server Settings | Platform | Admins only |
| Add Panel (browser) | Platform (`client.browser`) | All users (desktop only) |

These are always present regardless of which plugins are installed. They are not configurable by plugins.

---

## Sidebar Item Lifecycle

Items are not static — they change as the server state changes. When an admin creates a new channel, the text-channels plugin publishes a `text-channels.channel.created` event. The shell listens for this event and refreshes its sidebar item list from the plugin.

This means:
- New channels appear in real-time without a page reload
- Deleted channels disappear immediately
- Room state changes (voice room now has members) update the sidebar live

The shell subscribes to sidebar-relevant events from each plugin on connect and unsubscribes on disconnect.

---

## Manifest Declaration

Plugins declare whether they contribute sidebar items in their manifest. This lets the shell know whether to query a plugin at all.

```json
{
  "sidebar": {
    "contributes": true,
    "section": "Chat",
    "refresh_on": ["text-channels.channel.created", "text-channels.channel.deleted"]
  }
}
```

| Field | Description |
|---|---|
| `contributes` | Whether this plugin provides sidebar items. False for extensions. |
| `section` | Default section header label. Server owner can rename. |
| `refresh_on` | Event topics that should trigger a sidebar refresh for this plugin. |

Extensions set `contributes: false` and omit `section` and `refresh_on`.

---

## Phase Scope

| Feature | Phase |
|---|---|
| Runtime-composed sidebar from plugin items | Phase 2 |
| Role-based admin actions (+ for channel creation, etc.) | Phase 2 |
| Real-time sidebar updates via events | Phase 2 |
| Server owner section renaming and reordering | Phase 2 |
| Extension contributes-nothing model | Phase 2 |
| Plugin-injected UI into another plugin's sidebar section | Phase 3 |

---

## Relationship to Other Docs

- `spec-04-plugin-architecture.md` — manifest schema; `sidebar` field added here
- `spec-09-client-apps.md` — current shell architecture; sidebar section superseded by this doc
- `archive/19-workspace-layout.md` — sidebar items open as panels in the workspace
- `spec-20-browser-panel.md` — browser panel as a static platform sidebar item

---

## Amendment A — Section-Scoped Admin Actions (2026-05-11 — applies in PR ac187ed-followup)

The original `sidebar.items` contract returned a bare `SidebarItem[]`, and the shell read the section-level "+" (e.g. *New Channel*) from `items[0].adminActions` — anchoring section-scope actions on the first item by convention.

This breaks on a freshly-provisioned server with zero items: `items[0]` is undefined, no create button renders, and the section is hidden entirely (the shell hides empty-with-no-create sections to keep the bar tidy). Result: the owner sees a blank sidebar with no way to create the first channel.

### Resolution

`sidebar.items` accepts two response shapes:

```ts
// Legacy — still accepted
type LegacyResponse = SidebarItem[]

// New — preferred
interface SidebarItemsResponse {
  items: SidebarItem[]
  /** Section-scoped admin actions. Render adjacent to the section header
   *  regardless of items.length. The shell prefers these over
   *  items[0].adminActions when picking the section "+" target. */
  adminActions?: SidebarAction[]
}
```

The shell:
- Renders the section whenever there is *something for the viewer to do*: at least one item, OR a section-level create action visible to the current user. Admins on a fresh server see the section (the section-scoped "+" anchors it); non-admins viewing the same fresh server still see no header — there is nothing to click and nothing to create, so a bare label would be dead UX.
- Picks the section "+" from `response.adminActions` first, falling back to `items[0].adminActions` for plugins that haven't migrated.
- Per-item `adminActions` continue to render inline next to individual items (edit, delete, settings).

### Migration

`text-channels` and `voice-channels` migrated as part of this amendment. They now return:

```json
{
  "items": [...],
  "adminActions": [{ "id": "create-channel", "label": "New Channel", "icon": "plus" }]
}
```

with per-item `adminActions` reduced to `[edit, settings, delete]` (no longer duplicating `create-channel`).

Third-party plugins continue to work unchanged — the bare-array shape is permanently supported as a back-compat path.
