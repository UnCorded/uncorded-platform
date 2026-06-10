# Proxy Mount Panel Surface — first-party rendering for reverse-proxy plugins

**Status:** Proposed (design doc, pre-implementation)
**Scope:** Render axis only. The subpath / `routePrefix` (path axis) is unchanged
and still required — see [Path axis is unchanged](#5-path-axis-is-unchanged).
**Companion docs:** `plugin-reverse-proxy-plan.md`, `phase-0-cookie-topology-decision.md`,
`foundry-manual-qa.md`.

---

## 1. Problem

Reverse-proxy mounts (e.g. Foundry VTT) today render **only** through the plugin
panel iframe. That path inherits two iframe limitations we do not control:

1. **Upstream framing policy.** The proxy passes `X-Frame-Options` and
   `Content-Security-Policy: frame-ancestors` **verbatim** — that is a deliberate
   decision (`runtime/src/proxy/headers.ts:15-16`: iframe policy belongs to the
   upstream app). Any upstream that ships `X-Frame-Options: DENY` cannot be framed
   at all, no matter what we do at the proxy.
2. **Third-party-cookie friction.** The session cookie is `SameSite=None;
   Partitioned`. Chromium/Firefox replay it inside the iframe; Safari/WebKit ITP
   frequently drops an in-frame `Set-Cookie`, which is exactly why the top-level
   `/proxy-open` ticket handoff exists.

We want proxy mounts to be a **first-class panel surface**:

- **Desktop (Electron):** render through the browser-panel **`<webview>`** — a
  first-party Chromium guest. No `X-Frame-Options` problem (it is not a frame),
  no third-party-cookie problem (it is first-party to the proxied origin).
- **Web (no Electron):** fall back to the **proxy iframe** (Chromium/FF), and when
  the upstream can't be framed, surface an "open in browser / install desktop"
  nudge — the acknowledged best-effort path we already ship.

This mirrors the existing browser-panel dual-surface pattern
(`apps/website/src/components/browser-panel.tsx`): webview on desktop, iframe on
web. We are adding a **third panel content type** that reuses that machinery but
pins it to an approved proxy mount.

---

> **Decisions locked (2026-06):** partition = **per-server**
> (`persist:proxy:<serverId>`, §2.3); device permissions = **prompt the user**
> (§4.2); open model = **universal plugin iframe + host-promoted mount surface**
> (§4.4) — the plugin iframe is always present so web users always have the
> plugin, and on desktop the host renders the proxied app through the Electron
> browser viewer (webview) instead of an embedded iframe.

## 2. Architecture decisions (the non-obvious choices)

### 2.1 The webview authenticates via `openUrl`, not `url`

A `<webview partition="...">` has **its own cookie jar**. A session cookie minted
by a main-renderer `fetch` (the way the web bootstrap works) is invisible to the
webview's partition. So we do **not** inject cookies from the main process.

Instead, the webview's **initial `src` is `openUrl`**
(`/proxy-open/:slug/:mount?ticket=…`, `runtime/src/http/proxy.ts:491-568`).
`/proxy-open` runs **first-party inside the webview's partition**, verifies the
single-use ticket (`purpose="open"`, 300 s TTL, bound to `approval_version`),
mints the session cookie **into that partition**, and `302`s to
`/proxy/:slug/:mount/`. This reuses the exact Safari handoff already built — zero
new auth surface, zero Electron cookie injection.

> The ticket is the one-time bridge across the cookie-jar boundary; the 1-hour
> session cookie then lives natively in the partition.

### 2.2 Web fallback uses `url`, not `openUrl`, in the iframe

For the **web iframe**, the initial `src` is **`url`** (the pre-authed
`/proxy/:slug/:mount/`). The bootstrap `POST` already ran with
`credentials: "include"`, so the cookie is in the renderer's first-party jar for
the runtime origin; `SameSite=None; Partitioned` lets it replay in the iframe on
Chromium/Firefox.

`openUrl` does **not** help in an iframe: `/proxy-open`'s `Set-Cookie` would still
be an *in-iframe* set, which Safari/ITP drops just the same. The Safari-correct
path is a **top-level** navigation — that is the existing "open in browser" button
on the can't-frame prompt, which we keep. Precise rule:

| Surface | Initial src | Why |
| --- | --- | --- |
| Desktop webview | `openUrl` | Mints cookie inside the partition's own jar |
| Web iframe (Chromium/FF) | `url` | Cookie already first-party from bootstrap fetch |
| Web, can't frame / Safari | `openUrl` **top-level** (button) | Only top-level nav mints the cookie under ITP |

### 2.3 Dedicated partition `persist:proxy:<serverId>`

The general browser panel uses `partition="persist:browser"`
(`browser-panel.tsx:979`). Proxy mounts get a **dedicated, per-server** partition:
`persist:proxy:<serverId>`. This isolates proxied-app cookies from the user's
ad-hoc browsing and from other servers, and gives us a stable, inspectable tag for
navigation pinning (§4.2).

### 2.4 Pinned / kiosk surface — no address bar, no tabs

The server owner approved **one specific upstream**, not arbitrary browsing.
The proxy-mount surface has no nav chrome and confines navigation to the mount
origin + `/proxy/:slug/:mount/` path (§4.2). Off-origin links open externally via
`shell.openExternal`, matching the existing main-process pattern
(`apps/desktop/src/main.ts:348` `setWindowOpenHandler`, `:393` `will-navigate`).

### 2.5 Ephemeral auth is never persisted in layout

`url` and `openUrl` are **minted fresh per mount** and are short-lived (ticket
300 s, cookie 1 h). They must **not** be stored in the persisted panel content /
workspace layout — a stale ticket `403`s and a re-approval bumps
`approval_version`, invalidating old tickets/cookies. Panel content stores
**identity only** (`slug` + `mount`); the surface bootstraps on every mount.

---

## 3. Data model

**No new `PanelContent` variant.** Per the locked open-model decision (§4.4), a
proxy-backed plugin stays a normal `type: "plugin"` panel — that is what keeps the
plugin universally available on web. The proxied app is rendered as a **host-owned
surface portal-hosted over a region the plugin reserves**, not as a top-level panel
of its own. So the protocol is unchanged; the new identity lives at the
**portal-host element** level.

### 3.1 Proxy-mount viewport (frontend SDK + portal-host)

The plugin reserves a rectangle for its mount the same way the browser panel
reserves one — a placeholder div whose geometry the host tracks via
`portal-host` (`getBoundingClientRect` → `updatePlaceholder`/`requestSync`,
`apps/website/src/lib/portal-host.ts`). Because the plugin's content lives inside
its own iframe, the placeholder geometry is reported **out** to the host across the
frame boundary via the frontend SDK (the same postMessage channel `openMount()`
already uses), and the host positions the surface in the **host document** over
that reported rect. The host owns the surface element; the plugin owns the layout
around it.

`sdk.proxy.openMount(mount)` evolves from "returns `{iframeUrl, openUrl}` for the
plugin to embed" into "reserves a proxy-mount viewport the host renders into." The
return shape stays compatible for hybrid plugins that still want to embed
`iframeUrl` themselves on web.

### 3.2 Surface key

The portal-hosted mount surface is keyed independently of `PanelContent`:

```text
proxy-mount:${serverId}:${slug}:${mountName}
```

This lets the webview survive tab switches / layout shuffles via portal adoption
without a reload (the surface-key contract documented atop
`apps/website/src/lib/surface-key.ts`). The platform branch (webview vs iframe)
is **not** part of the key — it is fixed for the session by `isElectron()`.

> **Cross-document positioning is the one real wrinkle.** A host-owned webview
> cannot be composited *inside* the plugin's iframe document; it is layered over
> it in the host document using the plugin-reported rect. Resolve scroll/resize
> jank during implementation (debounced geometry sync + clip to the panel bounds),
> exactly as the browser panel already does for its own portal surface.

---

## 4. Implementation

### 4.1 Host bootstrap API (`apps/website/src/api/runtime.ts`)

Add a helper next to `runtimeFetch` (which already handles bearer auth +
`AUTH_FAILED` single-retry, lines 28-57):

```ts
// Mints a fresh proxy session for a mount. Returns { url, openUrl }.
// url      → /proxy/:slug/:mount/        (pre-authed, for the web iframe)
// openUrl  → /proxy-open/:slug/:mount?…  (ticket handoff, for the desktop webview)
export async function bootstrapProxyMount(
  tunnelUrl: string, serverId: string, slug: string, mount: string,
): Promise<{ url: string; openUrl: string }> {
  return runtimeFetch(tunnelUrl, serverId,
    `/proxy-sessions/${slug}/${mount}`, { method: "POST" });
}
```

This is the same endpoint the frontend SDK's `sdk.proxy.openMount()` calls
(`runtime/src/http/proxy.ts:422-478`, returns `{ url, openUrl }`). The plugin
iframe triggers the bootstrap (via the SDK); the host owns the resulting render
surface (§4.4).

### 4.2 Desktop: navigation pinning + permissions (`apps/desktop/src/main.ts`)

Webview guest hardening is already global
(`main.ts:1687-1698`: `sandbox=true, contextIsolation=true, nodeIntegration=false,
delete preload`). Add, keyed off the `persist:proxy:` partition prefix so we don't
affect the general browsing webview:

- **`will-navigate`** on the guest: allow only same-origin as the mount's runtime
  origin under the `/proxy/:slug/:mount/` path; everything else → `preventDefault`
  + `shell.openExternal`.
- **`setWindowOpenHandler`**: `{ action: "deny" }`, route external URLs to
  `shell.openExternal` (reuse the existing helper at `:348`).
- **`setPermissionRequestHandler`** on `session.fromPartition("persist:proxy:…")`:
  **prompt the user** on first request for camera/mic/geolocation/notifications
  (decision §6). Surface a native allow/deny prompt scoped to the mount; remember
  the choice per mount. Never auto-grant.
- **Downloads**: handle `will-download` so a proxied app can't silently write to
  disk through the guest.

### 4.3 Frontend: `ProxyMountSurface` (host-owned, portal-hosted)

The host renders this surface over the plugin-reserved viewport rect (§3.1).
Model on `WebviewViewport`/`WebviewSurface` (`browser-panel.tsx:950-1036`) and
`IframeViewport`/`IframeSurface` (`:712-846`), **minus** the nav bar and tabs:

```text
ProxyMountSurface({ serverId, slug, mountName, rect })
  bootstrap = useBootstrapProxyMount(serverId, slug, mountName)  // §4.1
  key = `proxy-mount:${serverId}:${slug}:${mountName}`           // §3.2
  if isElectron():
    <WebviewSurface
       mountKey={key}
       partition={`persist:proxy:${serverId}`}    // §2.3 — per-server
       url={bootstrap.openUrl}                     // §2.1 — handoff into partition
       onElementReady / onElementReleased />       // portal-host adopt
  else:
    IframeViewport.checkCanFrame(bootstrap.url):
      "allowed" → <IframeSurface url={bootstrap.url} />   // §2.2 — pre-authed
      "blocked" → <ProxyMountInstallPrompt openUrl={bootstrap.openUrl} />
                  // top-level "Open in browser" + "Install desktop app"
```

Reuse the **portal-host** mount/adopt/unmount/refcount machinery
(`apps/website/src/lib/portal-host.ts`) so the surface tracks the plugin-reported
rect and survives panel re-layout.

**Robustness — re-bootstrap on staleness (production must-have).** The 1 h session
cookie or a mid-session **re-approval** (which bumps `approval_version` →
`409 PROXY_NOT_APPROVED`, `runtime/src/http/proxy.ts` request path) will eventually
fail the surface. Intercept:

- Desktop: webview `did-fail-load` / an in-guest `401`/`409` → re-call
  `bootstrapProxyMount`, reload the guest with the fresh `openUrl`.
- Web: iframe `403`/`409` (detected via the can't-frame probe re-run or a
  postMessage health ping) → re-bootstrap and reassign `src`.

### 4.4 Open model — universal plugin iframe + host-promoted mount surface

**Decision: the plugin iframe is always the entry point.** Every proxy-backed
plugin renders as a normal `type: "plugin"` panel, so **web users always have the
plugin**, regardless of framing/cookie limits. The plugin calls
`sdk.proxy.openMount(mount)` and reserves a viewport (§3.1); the **host** then
renders the proxied app into that viewport, choosing the surface by platform:

- **Web:** the proxy **iframe** (`url`, §2.2). If the upstream can't be framed,
  the can't-frame prompt offers top-level "open in browser" (`openUrl`) and an
  "install desktop app" nudge.
- **Desktop:** the **Electron browser viewer** (`<webview>`, `openUrl` handoff,
  §2.1) layered over the same viewport — escaping `X-Frame-Options` and the
  Safari-cookie problem. The plugin UI/layout around the viewport is unchanged.

So the **same slug** works everywhere: iframe-embedded on web, promoted into the
desktop browser viewer on desktop — without the plugin author writing two paths.

Because the panel stays `type: "plugin"`, **`PanelBody`
(`apps/website/src/components/panel.tsx:530-556`) needs no new branch.** The
platform switch lives in the proxy-mount viewport renderer (§4.3) invoked from the
plugin's `openMount()` reservation. `foundry-vtt` ships a thin plugin iframe that
does nothing but reserve its `foundry` mount viewport.

> Considered and rejected: a host-native `type: "proxy-mount"` panel that bypasses
> the plugin iframe entirely. Cleaner in isolation, but it would make a pure-proxy
> plugin unusable on web the moment the upstream refuses framing, and split the
> "open the plugin" UX into two code paths. Universal iframe wins.

---

## 5. Path axis is unchanged

This plan changes **how the surface is rendered**, not **what URLs the proxied app
emits**. An app mounted at `/proxy/:slug/:mount/` that builds **root-absolute**
asset/WebSocket URLs (`/scripts/…`, `wss://host/socket.io/…`) still breaks, because
the HTML/CSS rewriter (commit `80ccbb6`) rewrites root-absolute URLs **only** in
`text/html`/`xhtml`/`css` — **not** JavaScript, JSON, or WebSocket URLs.

The fix for that is and remains a **`routePrefix`** on the upstream app (Foundry's
`routePrefix`, dev servers' `--base`), so the app emits mount-prefixed URLs itself.
Render surface (this doc) and route prefix (path axis) are **orthogonal** — the
webview removes the framing/cookie blockers, but a root-mounted app without a route
prefix will still load a blank page from broken asset paths. Document `routePrefix`
as a hard requirement in the reverse-proxy SDK page (`docs/site/sdk/reverse-proxy.md`).

---

## 6. Decisions (locked 2026-06)

1. **Partition scope** — **per-server** `persist:proxy:<serverId>`. Isolates each
   server's proxied-app cookies without fragmenting a single app across its mounts.
2. **Permission policy** — **prompt the user** on first camera/mic/geo request,
   scoped to the mount, remembered per mount; never auto-grant (§4.2).
3. **Open model** — **universal plugin iframe + host-promoted mount surface**
   (§4.4). No host-native `proxy-mount` panel type; the plugin panel stays
   `type: "plugin"` so web users always have the plugin, and desktop promotes the
   mount into the browser viewer.

---

## 7. Phasing (incremental, each independently shippable)

- **Phase 1 — Web viewport via the host.** `bootstrapProxyMount` host API +
  proxy-mount viewport primitive (SDK `openMount()` reserves a host-rendered rect,
  §3.1) + `ProxyMountSurface` web iframe path (`url`) + surface-key. The plugin
  iframe stops embedding the proxy iframe itself; the host renders it. No protocol
  change. Ships web parity. Low risk.
- **Phase 2 — Desktop webview (the big win).** Partition `persist:proxy:<serverId>`,
  `openUrl` handoff as initial `src`, navigation pinning, permission prompt handler,
  download handling, cross-document rect positioning. Removes the `X-Frame-Options`
  and Safari-cookie blockers on desktop.
- **Phase 3 — Robustness + migration.** Auto re-bootstrap on `401`/`409` staleness
  (§4.3). Migrate `foundry-vtt` to a thin viewport-reserving plugin iframe.
- **Phase 4 — Docs.** Reverse-proxy SDK page: render surfaces (desktop vs web),
  `routePrefix` requirement, upstream base-path rule, "open in browser" fallback.

---

## 8. Security review checklist

- [x] Webview guest: `sandbox` + `contextIsolation` + no node + no preload
      (already global, `main.ts:1687-1698`).
- [ ] Navigation pinned to mount origin/path; popups & off-origin → `openExternal`.
- [ ] Dedicated per-server partition; permission handler prompts (never auto-grant).
- [ ] **No** cookie/token injection from the main process — the `/proxy-open`
      ticket handoff is the only auth bridge (smaller attack surface than
      `session…cookies.set`).
- [ ] `openUrl`/`url` never persisted in workspace layout (single-use, TTL-bound,
      `approval_version`-bound).
- [x] Proxy already strips `Authorization`/`Referer` upstream, bounds redirects,
      enforces `approval_version` on every request — unchanged by this plan.
- [ ] Downloads from the guest handled, not silently written.

---

## 9. Test / acceptance matrix

| Area | Test |
| --- | --- |
| Layout persistence | Panel stays `type: "plugin"`; no ephemeral `url`/`openUrl` written to layout (re-bootstrapped on every mount). |
| Viewport | Plugin-reported rect tracks scroll/resize; surface clips to panel bounds, no jank. |
| Surface key | Stable across tab switch / re-layout → portal adopts, no reload. |
| Host API | `bootstrapProxyMount` returns `{url, openUrl}`; `AUTH_FAILED` re-mint path exercised. |
| Desktop | Webview loads `openUrl` → lands on `/proxy/.../`; cookie present in `persist:proxy` partition; off-origin nav blocked → external; popup → external. |
| Web (Chromium/FF) | Iframe loads `url`, renders. |
| Web (Safari / X-Frame-Options: DENY) | Can't-frame prompt → top-level `openUrl` works. |
| Re-approval mid-session | Surface gets `409` → auto re-bootstrap → reload, no user action. |
| Foundry e2e | With `routePrefix` set, socket.io connects under `/proxy/.../`; board renders in desktop panel. |
