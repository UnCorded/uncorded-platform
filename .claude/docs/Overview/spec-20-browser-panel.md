---
vision: "Central knows nothing beyond 'this server exists at this URL'"
tenet: "Every feature is a choice"
depends-on: [spec-09-client-apps, archive/19-workspace-layout, spec-04-plugin-architecture]
last-verified: 2026-04-13
---

# 20 — Browser Panel

*The built-in client capability for rendering any URL inside the workspace. Electron renders a full native webview. Web and mobile get a graceful install prompt. Plugins declare `client.browser` to use it.*

> **Status (2026-06-05):** User-owned browser panels, the navigation bar, and Electron
> `<webview>` hardening are **live**. **Plugin-driven** opening (`platform.browser.open()`)
> is **disabled** pending `client.browser` capability enforcement — it was removed from the
> frontend SDK in commit `e04ea44`, and the shell ignores any `platform.browser.open`
> message. See "Opening a browser panel (plugin frontend API)" below.

---

## What the Browser Panel Is

The browser panel is a **built-in platform capability**, not a plugin. It renders arbitrary URLs inside the workspace using the client's native browser primitive. Plugins that need to show external web content request a browser panel — they do not implement their own iframe or webview.

The platform owns the rendering. The plugin passes a URL and config.

---

## Locked Decisions

- **Client-side only.** No server-side rendering, no Chromium in the container, no WebRTC streaming. The browser runs on the user's machine, not on the server owner's hardware.
- **Built-in, not installable.** The browser panel capability ships with every UnCorded client. Server owners cannot remove it (though they can restrict it — see `archive/19-workspace-layout.md`).
- **Electron uses `<webview>`.** Electron's webview tag runs in a separate renderer process and bypasses X-Frame-Options and CSP frame restrictions. Any URL works.
- **Web and mobile show an install prompt.** There is no degraded iframe fallback that pretends to work. If a plugin requires `client.browser` and the user is on web or mobile, they see a clear prompt to install the desktop app.
- **Multi-user co-browsing is deferred.** Sharing a browser session between users requires a server-side cloud browser (Chromium in container + WebRTC). This is a Phase 3 feature. The Phase 2 browser panel is single-user only.

---

## Why Built-In and Not a Plugin

Every plugin that needs external web content — game dashboards, live maps, documentation, OAuth flows, external web tools — reaches for the same primitive. If this were a plugin:

- Every server would need to install and maintain it
- Plugin developers would have a hard dependency on another plugin being present
- The capability would be optional rather than universal

The browser panel is infrastructure. Plugins consume it, they do not implement it.

---

## How It Works Per Client

### Electron (desktop)

- Renders a `<webview>` tag inside the panel container
- `<webview>` runs in a separate renderer process — not constrained by X-Frame-Options or `frame-ancestors` CSP
- Any URL loads fully, including sites that block iframes (Google, YouTube, GitHub, etc.)
- Full interaction: clicks, keyboard input, scrolling, form submission
- Sandboxed from the shell — the webview cannot access shell DOM, cookies, or tokens
- Navigation bar (URL input, back/forward, reload) rendered by the shell around the webview

### Web (browser)

- Browser panels are non-functional in the standard web app
- The panel renders a prompt: *"Browser panels require the UnCorded desktop app"* with a download link
- The prompt is clean and intentional — not a broken iframe or an error state
- All other panel types (plugin iframes) work normally on web

### Mobile

- Same as web: install prompt for browser panels
- Plugin panels work normally

---

## Plugin Integration

### Declaring the requirement

Plugins that use browser panels declare `client.browser` in their manifest:

```json
{
  "name": "minecraft-bridge",
  "client_capabilities": ["client.browser"]
}
```

The platform uses this declaration to:
- Warn during install if the plugin requires `client.browser` (so server owners know their users need desktop)
- Render the install prompt correctly when a `client.browser`-dependent panel is opened on web/mobile

### Opening a browser panel (plugin frontend API)

> **DISABLED — pending `client.browser` capability enforcement.** Plugin-driven browser
> opening was removed from the frontend SDK in commit `e04ea44` (`platform.browser.open()`
> and `BrowserOpenOptions` dropped; the shell ignores any `platform.browser.open` message,
> and the automatic plugin→browser-panel effect was deleted). It returns only once
> `client.browser` is actually enforced (manifest declaration → install-time warning →
> runtime gate). **User-owned browser panels are unaffected** — users still add and navigate
> browser panels themselves (see "Standalone Browser Panels" below). The API shape and use
> cases below are retained as the design target for when the capability is enforced.

Plugin frontends request a browser panel through the platform SDK:

```ts
// Open a browser panel next to the current plugin panel
platform.browser.open({
  url: "https://map.example.com/server/abc123",
  title: "Live Map",           // panel tab label
  mode: "single",              // "single" only in Phase 2
})
```

The platform places the browser panel in the workspace. The user can move and resize it like any other panel.

### Use cases

| Plugin | Browser panel use |
|---|---|
| Minecraft bridge | Opens the server's live map (Overviewer, Dynmap) |
| OAuth integrations | Handles redirect flows inside the app instead of spawning an OS browser |
| Cloudflare-protected services | Auth challenge completes inside the app |
| Documentation plugin | Opens plugin or server documentation inline |
| Media plugin | Opens a streaming site (Twitch, YouTube) |
| Admin panel | Opens an external web tool (Grafana, Netdata) |
| Any plugin | Opens any URL the plugin or user provides |

### URL bar and navigation

The shell renders a navigation bar around every browser panel:

- URL input field (user can type a new URL)
- Back / Forward buttons
- Reload button
- The plugin can set the initial URL but the user can navigate freely from there

This means browser panels are also useful as general-purpose user browser tabs within the workspace — users can add a blank browser panel and navigate to any URL themselves, independent of any plugin.

---

## Standalone Browser Panels

Users can add browser panels to their workspace without a plugin requesting it. From the workspace panel picker:

1. User clicks "Add Panel"
2. Selects "Browser"
3. Types a URL
4. Panel opens with that URL

This is the "open any URL as a panel" use case — the workspace equivalent of a browser tab, but inside UnCorded. On Electron, it works for any URL. On web/mobile, the install prompt appears.

---

## Security Considerations

### Webview sandboxing

Electron webviews are isolated from the shell renderer:
- The webview cannot access the shell's DOM, JavaScript context, session cookies, or auth tokens
- The shell communicates with the webview only via `webview.executeJavaScript()` for controlled interactions (e.g. injecting a URL change) — not arbitrary script execution
- `nodeintegration` is disabled in webviews
- `contextIsolation` is enabled

### URL restrictions

Server owners can restrict browser panels to an allowlist of domains (see `archive/19-workspace-layout.md`). This is optional — by default any URL is allowed.

UnCorded does not filter URLs at the platform level. The server owner is responsible for their server's configuration. The user is responsible for the URLs they open.

### No token injection into webviews

Auth tokens are never injected into browser panel webviews. The webview is a general-purpose browser — it has no relationship to the UnCorded auth model. If a plugin needs to pass auth context to a URL it opens, it must do so via URL parameters or cookies set by the external service.

---

## Phase Scope

| Feature | Phase |
|---|---|
| Browser panel in Electron (`<webview>`) | Phase 2 |
| Web/mobile install prompt | Phase 2 |
| Plugin `client.browser` manifest declaration | Phase 2 |
| `platform.browser.open()` SDK method | **Disabled** — removed in `e04ea44`; returns with `client.browser` enforcement |
| Standalone user browser panels (no plugin) | Phase 2 |
| Navigation bar (URL input, back/forward, reload) | Phase 2 |
| Server owner domain allowlist | Phase 2 |
| Multi-user shared browser sessions (cloud browser + WebRTC) | Phase 3 |
| Mobile native browser panel (WKWebView / WebView) | Phase 3 |

---

## Relationship to Other Docs

- `archive/19-workspace-layout.md` — the panel container system that browser panels live inside
- `spec-09-client-apps.md` — Electron architecture; webview is Electron-specific
- `spec-04-plugin-architecture.md` — how plugins declare `client_capabilities`
