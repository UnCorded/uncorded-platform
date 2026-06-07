---
vision: "Central knows nothing beyond 'this server exists at this URL'"
tenet: "Every feature is a choice"
depends-on: [spec-03-server-container, spec-04-plugin-architecture, spec-06-authentication]
last-verified: 2026-04-05
---

# 09 — Client Apps

*The web app and the desktop app. How the shell works, how plugin iframes are managed, and what the desktop app adds.*

---

## Two Apps, One Codebase

| App | Built with | What it adds over web |
|---|---|---|
| **Web app** | SolidJS + Tailwind CSS | Accessible from any browser. No install. Join servers, use plugins, browse marketplace. |
| **Desktop app** | Electron (wraps the web app) | Docker management, server creation wizard, container lifecycle controls, plugin marketplace install-to-server flow, auto-updates via `electron-updater`. |

The desktop app is the web app plus Electron-specific features. The web codebase is shared — Electron loads it in its Chromium webview. Platform-specific code (Docker management, auto-update, OS keychain) lives in Electron's main process.

---

## The Shell

> **Note (2026-04-13):** The single-plugin viewport described below is superseded by the workspace layout system (`archive/19-workspace-layout.md`). The iframe auth model, WebSocket management, and all other shell responsibilities are unchanged — only the viewport container is being replaced with a multi-panel workspace. Read `archive/19-workspace-layout.md` for the current design.

Both apps share the same **shell** — the outer UI that wraps plugin content:

```
+--------------------------------------------------+
|  Shell (SolidJS)                                 |
|  +----------+-----------------------------------+|
|  | Sidebar  |  Plugin Viewport (iframe)         ||
|  |          |                                   ||
|  | Server 1 |  [text-channels UI]               ||
|  | Server 2 |                                   ||
|  | Server 3 |  or                               ||
|  |          |                                   ||
|  | Plugins: |  [photo-gallery UI]               ||
|  |  # chat  |                                   ||
|  |  # photos|  or                               ||
|  |  # admin |                                   ||
|  |          |  [admin panel]                    ||
|  +----------+-----------------------------------+|
+--------------------------------------------------+
```

### Shell responsibilities

- **Server list** — shows the user's servers with online/offline status
- **Plugin navigation** — sidebar is runtime-composed from plugin contributions. See `spec-21-sidebar-model.md` for the full model. Plugins are never surfaced by name to users — the sidebar shows features, not plugin names.
- **iframe viewport** — loads the selected plugin's frontend in a sandboxed iframe
- **Auth management** — holds session tokens, fetches server auth tokens, pushes to iframes via postMessage
- **Token refresh** — proactively refreshes server auth tokens before expiration, pushes new tokens to active iframes
- **WebSocket management** — maintains one WebSocket per connected server, routes messages to/from the correct iframe
- **Presence** — shows connected users based on `runtime.user.connected/disconnected` events

### What the shell does NOT do

- Render plugin content. Plugins own their iframes entirely.
- Store messages, files, or plugin data. All data lives on the server.
- Communicate with Central during normal server usage. After token fetch, everything goes to the server directly.

---

## iframe Management

Each plugin's frontend renders in its own iframe. The shell creates, manages, and destroys iframes as the user navigates.

### iframe creation

When the user clicks a plugin in the sidebar:

1. Shell creates an `<iframe>` with `src="/plugins/<slug>/ui/index.html"` on the current server's tunnel URL.
2. iframe loads. Plugin frontend code runs.
3. iframe posts `{ type: "uncorded.ready" }` to parent.
4. Shell verifies `event.source` and `event.origin`.
5. Shell posts `{ type: "uncorded.token", token, expiresAt }` to the iframe.
6. Plugin frontend initializes with the token, connects to the server via the shell's WebSocket.

### iframe isolation

- Each plugin runs in its own iframe with its own origin.
- Iframes cannot read each other's content, tokens, or DOM.
- The shell communicates with iframes exclusively via `postMessage` with origin verification on both sides.
- A malicious iframe cannot request tokens for other plugins.
- A malicious iframe cannot access the shell's session token (HTTP-only cookie, invisible to JavaScript).

### iframe lifecycle

- **Created** when the user opens a plugin.
- **Kept alive** while the user navigates between plugins on the same server (hidden, not destroyed). This preserves plugin state.
- **Destroyed** when the user switches servers or explicitly closes the plugin.
- **Token refresh** — the shell pushes new tokens to active AND hidden iframes before expiration. No iframe goes stale.

---

## WebSocket Management

The shell maintains **one WebSocket per server** the user is currently connected to.

```
Shell
├── WebSocket to Server A (tunnel URL A)
│   ├── Routes requests/events to text-channels iframe
│   └── Routes requests/events to photo-gallery iframe
└── WebSocket to Server B (tunnel URL B)
    └── Routes requests/events to minecraft-admin iframe
```

### Message routing

- **Outbound (iframe → server):** Plugin iframe calls `sdk.request()` → SDK posts a message to the shell via `postMessage` → shell tags it with the plugin slug → sends over the server's WebSocket.
- **Inbound (server → iframe):** Server sends a WebSocket message tagged with a plugin slug → shell routes it to the correct iframe via `postMessage`.
- **Events:** Server pushes events → shell checks which iframes are subscribed → delivers to each via `postMessage`.

### Connection lifecycle

- WebSocket opened when user navigates to a server.
- Kept alive with periodic pings while any plugin on that server is open.
- Closed when the user leaves the server (all plugins closed) or on disconnect.
- Auto-reconnect on transient failures with exponential backoff.

---

## Desktop-Specific Features

The Electron desktop app adds capabilities the web app cannot provide:

### Docker management

- **Detect Docker** — checks if Docker is installed and the daemon is running.
- **Container lifecycle** — start, stop, restart, delete server containers.
- **Image management** — pull new `uncorded/server` images, show available versions.
- **Container logs** — stream container stdout/stderr to a log viewer.
- **Resource monitoring** — show container CPU/memory usage (via Docker stats API).

### Server creation wizard

The full wizard flow lives in the desktop app. See `spec-10-server-creation.md`.

### Auto-update

- **`electron-updater`** checks for new desktop app versions on launch and periodically.
- **Background download** — updates download in the background while the user works.
- **Restart-to-apply** — user is prompted to restart when an update is ready. Not forced.
- **Code-signed releases** — Windows and macOS builds are signed.

### OS integration

- **System tray (optional, not default)** — the app can minimize to tray for container monitoring. This is opt-in, not the default behavior. **The desktop app is NOT required to be running for servers to operate.** Docker containers run independently (`--restart=unless-stopped`). The admin panel at `/admin/` is web-based. The desktop app is a management tool you open when needed, not a daemon.
- **Notifications** — native OS notifications for: server went offline, plugin crashed, update available.
- **OS keychain** — packaged desktop builds store secrets in the operating system credential manager: macOS Keychain, Windows Credential Manager, Linux Secret Service/libsecret.
- **Durability contract** — with a stable desktop `appId`, updates and reinstalls under the same OS user preserve stored secrets. This includes the Central session token, Cloudflare account state, and per-server tunnel tokens.
- **Fail-closed packaged builds** — if the OS credential service is unavailable, the packaged desktop app refuses to silently downgrade to a weaker store. Dev mode may use an app-local encrypted file for convenience, but that fallback is not a shipping contract.

### Resource acknowledgment for homelab hardware

Electron bundles Chromium. This has a cost:
- **Install size:** ~200 MB.
- **Idle memory:** ~100-150 MB when running.
- On a Raspberry Pi 4 (2 GB RAM), the desktop app plus a server container with 5 plugins (~700 MB) consumes roughly half the available RAM.

**This is acceptable because the desktop app does not need to be running for the server to work.** Open it to create servers, install plugins, check logs. Close it when done. The server keeps running. Homelab users on constrained hardware should close the desktop app after setup and use the web-based admin panel for ongoing management.

---

## Web-Only Considerations

The web app runs in a standard browser. It cannot:

- Manage Docker containers (no Docker access from a browser)
- Create servers (requires Docker)
- Access the OS keychain (uses HTTP-only cookies instead)
- Run in the background (closes when the tab closes)
- Send native notifications (can use the Notifications API with user permission)

**The web app is for joining and using servers.** The desktop app is for hosting and managing them.

---

## Summary

| Question | Answer |
|---|---|
| How many apps? | Two — web (SolidJS) and desktop (Electron wrapping the web app). |
| What's shared? | The entire web codebase. Electron adds Docker management and OS integration. |
| How do plugins render? | In sandboxed iframes inside the shell's viewport. |
| How do iframes get auth? | postMessage handshake with origin verification. Shell pushes token refreshes. |
| How many WebSockets? | One per connected server. Shell routes messages to/from the correct iframe. |
| Who can create servers? | Desktop app only (requires Docker). |
| Who can join servers? | Both web and desktop. |
| Auto-updates? | Desktop: `electron-updater` with background download. Web: always latest (served by Central or CDN). |

---

## Future Refinements

### Mobile app (native)
- **What changes:** A native mobile app (iOS/Android) for joining and using servers. Not for hosting — mobile devices don't run Docker.
- **Why not now:** The postMessage iframe auth model doesn't port cleanly to native mobile (no iframe primitive). The auth delivery mechanism needs a parallel design. See `[TBD-mobile-auth-model]`.
- **What today's code must not do:** The SDK's client-side code must not assume it runs in a browser iframe. The core SDK should be transport-agnostic — `sdk.request()` and `sdk.subscribe()` work whether the underlying transport is postMessage, WebSocket, or a native bridge. The iframe-specific transport is one implementation.

### PWA support
- **What changes:** The web app could be installable as a Progressive Web App — home screen icon, offline shell, push notifications via service worker.
- **Why not now:** PWA adds service worker complexity. The web app works fine in a browser tab for Phase 1.
- **What today's code must not do:** The web app must not rely on Electron-specific APIs for core functionality. Everything the web app does must work in a standard browser. This is already true by design.

### Desktop app without Electron (lighter alternative)
- **What changes:** If Electron's resource usage becomes a real problem, the desktop app could be rebuilt with Tauri or a lighter wrapper.
- **Why not now:** Electron was chosen for Chromium consistency and developer familiarity. It's the right call for Phase 1.
- **What today's code must not do:** Desktop-specific features (Docker management, auto-update, OS keychain) must be in a separate Electron main-process module, not mixed into the SolidJS web codebase. This makes the web codebase extractable if the desktop wrapper ever changes.
