# Reverse-proxy plugins

A reverse-proxy plugin lets an UnCorded server expose a **self-hosted web app**
(a "upstream") to its members through the runtime's reverse proxy, behind a
sidebar panel. The canonical example is [Foundry VTT](https://github.com/UnCorded/uncorded-platform/tree/main/plugins/foundry-vtt):
a sidebar entry whose panel loads a proxied Foundry server in an iframe.

## Mental model

The proxy is **runtime-owned**. Your plugin never proxies bytes itself. You:

1. **Declare** one or more `proxy_mounts` in the manifest, each pointing at a
   setting that holds the upstream URL.
2. **Surface** a sidebar item from the backend (a few lines — no proxy logic).
3. **Open** the mount from the frontend panel: call `sdk.proxy.openMount(name)`,
   get back `{ iframeUrl, openUrl }`, and point an `<iframe>` at `iframeUrl`.

The runtime handles approval gating, session cookies, access policy, and the
actual HTTP/WebSocket forwarding under `/proxy/<slug>/<mount>/*`.

```
manifest proxy_mount ──▶ owner approves ──▶ runtime serves upstream
   (upstream_setting)     (Server settings)    /proxy/<slug>/<mount>/*
        │                                              ▲
        ▼                                              │
   backend: sidebar item ──▶ frontend: sdk.proxy.openMount() ──▶ iframe.src
```

> The backend SDK has **no** proxy API. Don't look for `createProxyMount()` —
> everything proxy-related is declared in the manifest and driven from the
> frontend.

---

## 1. Manifest

Source of truth: [`packages/shared/src/manifest.ts`](https://github.com/UnCorded/uncorded-platform/blob/main/packages/shared/src/manifest.ts).
A reverse-proxy-only plugin is `type: "standalone"` (it owns no data and runs no
logic of its own).

```json
{
  "name": "proxy-demo",
  "version": "0.1.0",
  "api_version": "^1.0",
  "author": "you",
  "description": "Proxy a self-hosted app into the UnCorded sidebar.",
  "license": "MIT",
  "type": "standalone",
  "icon": "Globe",
  "backend": { "entry": "backend/index.ts" },
  "frontend": { "entry": "frontend/index.html" },
  "permissions": ["proxy.http:self", "proxy.websocket:self"],
  "sidebar": { "contributes": true, "section": "Apps" },
  "settings": [
    {
      "key": "demo_upstream_url",
      "label": "Upstream URL",
      "description": "Base URL of the app to proxy. For a host app from the Docker runtime use http://host.docker.internal:<port>.",
      "type": "string",
      "default": "http://host.docker.internal:3011",
      "required": true
    }
  ],
  "proxy_mounts": [
    { "name": "demo", "upstream_setting": "demo_upstream_url", "access": "members" }
  ]
}
```

### Top-level fields (required unless noted)

| Field | Type | Notes |
| --- | --- | --- |
| `name` | string | Lowercase slug. This is the plugin's slug everywhere (`installed_plugins`, URLs, the install folder name). |
| `version` | string | Semver `MAJOR.MINOR.PATCH`. |
| `api_version` | string | Semver range, e.g. `^1.0`. |
| `author`, `description` | string | Human-readable. |
| `type` | `"standalone"` \| `"core"` \| `"extension"` | Proxy-only plugins are `standalone`. `extension` also needs `extends`. |
| `permissions` | string[] | Must include the proxy permission(s) — see below. |
| `backend` / `frontend` | `{ entry }` | At least one required; a proxy panel needs **both**. |
| `settings` | array | Declares the upstream setting(s) referenced by mounts. |
| `proxy_mounts` | array | The mounts. Non-empty when present. |
| `sidebar` | `{ contributes, section, ... }` | Set `contributes: true` to show a sidebar item. |
| `license`, `icon` | string | Optional. `icon` is a lucide icon name. |

### `proxy_mounts[]`

| Field | Type | Notes |
| --- | --- | --- |
| `name` | string | Slug-safe (`[a-z0-9-]`), unique within the plugin. Appears in the URL: `/proxy/<slug>/<name>/*`. |
| `upstream_setting` | string | **Key of a setting in this same manifest** (type `string` or `secret`) whose value is the upstream URL. The manifest never carries the URL directly. |
| `access` | `"members"` \| `"owner"` | Optional, defaults to `"members"`. `owner` restricts the mount to the server owner/admins. |

### Permissions

Declare what the mount needs — **WebSocket is not implied by HTTP**:

- `proxy.http:self` — forward HTTP requests to the upstream.
- `proxy.websocket:self` — forward WebSocket upgrades (needed for live apps,
  hot-reload, game sockets, etc.).

Validation rejects a manifest that declares `proxy_mounts` without at least one
of these permissions.

---

## 2. Backend

The backend is tiny: register a sidebar item. No proxy code.

```ts
// backend/index.ts
import { createPlugin } from "@uncorded/plugin-sdk";

const plugin = createPlugin();

plugin.handle("sidebar.items", async () => ({
  items: [
    {
      id: "demo",
      label: "Proxy Demo",
      icon: "Globe",
      panelType: "plugin" as const,
      slug: "proxy-demo",   // must equal manifest "name"
      section: "Apps",
    },
  ],
}));
```

`createPlugin()` returns a `PluginHandle` with the full backend surface
(`handle`, `request`, `events`, `db`, `kv`, `settings`, `broadcast`,
`presence`, `fetch`, …) — but a proxy-only plugin uses none of it beyond
`handle("sidebar.items", …)`.

### Packaging — backends run as subprocesses

The runtime executes each backend as its **own subprocess** with the plugin
directory as the working directory (`Bun.spawn(["bun","--smol","run", entry], { cwd: pluginPath })` —
see [`runtime/src/subprocess.ts`](https://github.com/UnCorded/uncorded-platform/blob/main/runtime/src/subprocess.ts)).
That means:

- Any `import` (e.g. `@uncorded/plugin-sdk`) is resolved against the plugin's
  **own `node_modules`**. The runtime does **not** run `bun install` / `npm install`
  on your plugin.
- **Package your plugin with its dependencies present** — ship `node_modules`
  in the installed folder, or include a `package.json` + lockfile and install
  into the folder before installing the plugin.

> A backend that imports nothing (raw stdio only) will load without packaging,
> but real plugins use the SDK and therefore must be packaged with deps. Don't
> ship an SDK-importing backend without its `node_modules`.

---

## 3. Frontend

The panel HTML loads the frontend SDK, opens the mount, and points an iframe at
the result. Adapted from [`plugins/foundry-vtt/frontend`](https://github.com/UnCorded/uncorded-platform/tree/main/plugins/foundry-vtt/frontend):

```html
<!-- frontend/index.html -->
<body>
  <p id="status">Connecting…</p>
  <iframe id="frame" allow="fullscreen; clipboard-read; clipboard-write" title="Proxy Demo"></iframe>
  <div id="fallback" hidden>
    <span>Trouble loading?</span>
    <a id="open-link" target="_blank" rel="noreferrer">Open in browser</a>
  </div>

  <!-- Served by the runtime; do not bundle it yourself. -->
  <script src="/sdk/plugin-frontend.js"></script>
  <script type="module">
    const MOUNT = "demo"; // must equal a proxy_mounts[].name

    const sdk = await window.UncodedPlugin.createPluginFrontend();
    const status = document.getElementById("status");
    const frame = document.getElementById("frame");
    const link = document.getElementById("open-link");
    const fallback = document.getElementById("fallback");

    try {
      const session = await sdk.proxy.openMount(MOUNT);
      frame.src = session.iframeUrl;     // proxied URL, cookie already minted
      link.href = session.openUrl;       // first-party "Open in browser" fallback
      status.hidden = true;
      fallback.hidden = false;
    } catch (err) {
      // err is a ProxyError — err.code tells you why (see table below)
      status.textContent = `Couldn't open: ${err.code}`;
    }
  </script>
</body>
```

### `sdk.proxy.openMount(name)`

Returns a `ProxyMountSession`:

| Field | Use |
| --- | --- |
| `iframeUrl` | Set as the panel iframe `src`. The proxy-session cookie is already minted. |
| `openUrl` | Wire to an "Open in browser" link/`target="_blank"`. Navigating top-level re-mints the cookie first-party — **required where framed third-party cookies are blocked (Safari/WebKit)**, harmless elsewhere. |

Always render the `openUrl` affordance. It's the only path that works when the
framed cookie is blocked.

### `ProxyError`

`openMount()` throws a `ProxyError` with a `.code` (and `.status`):

| `code` | Meaning |
| --- | --- |
| `INVALID_ARGUMENT` | Bad mount name passed to `openMount()`. |
| `UNAUTHORIZED` | 401 — missing/expired session token. |
| `FORBIDDEN` | 403 — owner-only mount, capability missing. |
| `NOT_FOUND` | 404 — plugin/mount not declared. |
| `NOT_APPROVED` | 409 — **mount not approved by the server admin** (the common one during setup). |
| `RATE_LIMITED` | 429. |
| `NETWORK_ERROR` | fetch rejected (offline / CORS / DNS). |
| `MALFORMED_RESPONSE` | 2xx body missing `url`/`openUrl`. |
| `BOOTSTRAP_FAILED` | any other non-2xx. |

---

## 4. Install & run (local testing)

Dropping a plugin folder is **not** enough. Three things must be true, in order.

### a. Place the folder

Install under the server's plugin directory, named exactly the manifest `name`:

```
<server-data>/plugins/<slug>/
# e.g. C:\Users\you\.uncorded\servers\<server>\plugins\proxy-demo\
#   manifest.json
#   backend/index.ts        (+ node_modules if it imports the SDK)
#   frontend/index.html
```

### b. Register the slug in `server.json`

The runtime only loads plugins listed in `installed_plugins`. Add the slug to
the server's `server.json` (the runtime reads it at boot — see
[`runtime/src/main.ts`](https://github.com/UnCorded/uncorded-platform/blob/main/runtime/src/main.ts)):

```json
{
  "installed_plugins": ["proxy-demo"]
}
```

### c. Restart through the desktop app — **not** `docker restart`

The runtime reads `installed_plugins` only at boot, so the container must be
recreated to pick up the change. **Restart via the desktop app / orchestrator**,
which tears down and recreates the container.

> ⚠️ **Never `docker restart` a server using an authenticated Cloudflare
> tunnel.** The tunnel token lives at `/run/tunnel/tunnel.json` on a **tmpfs**
> mount and is piped in over stdin when the desktop app *creates* the container.
> A bare `docker restart` does not re-pipe it, so the tunnel silently degrades.
> The container's restart policy is `no` by design — the desktop app owns the
> lifecycle and rebuilds the container (re-piping the token) on launch. Always
> go through desktop.

### Reaching a host app from the Docker runtime

The runtime container uses **bridge networking**, so `localhost` inside the
container is the container, not your machine. To proxy an app running on your
host, set the upstream setting to:

```
http://host.docker.internal:<port>
```

(`host.docker.internal` is a Docker Desktop feature; it resolves to the host.)

---

## 5. Making the proxied app load correctly

A mount is served at the **subpath** `/proxy/<slug>/<mount>/`, not at the root.
Most "the panel is blank" problems are an app that assumes it lives at `/`.

### The mount is a subpath — give your app its base path

The runtime rewrites **root-absolute URLs in HTML and CSS** (`/styles/app.css` →
`/proxy/<slug>/<mount>/styles/app.css`) — including those in inline
`style="…url()…"` and `<base href>` — so a static page loads. It does **not**
rewrite URLs your app builds in **JavaScript** (`fetch("/api/…")`, dynamic
`import()`, a WebSocket/`socket.io` connection URL), nor absolute URLs that
hard-code the upstream's own host. Those still miss the mount.

So your app needs to know its public base path. The runtime tells it on every
upstream request (HTTP and WebSocket) via:

```
X-Forwarded-Prefix: /proxy/<slug>/<mount>
```

If your framework is reverse-proxy-aware it reads that header and emits URLs under
the mount automatically — nothing to do. Otherwise set the app's own base-path
option to that exact path:

| App / framework | Base-path setting |
| --- | --- |
| Foundry VTT | `routePrefix` (Configuration → or `options.json`) |
| Vite (dev) | `--base /proxy/<slug>/<mount>/` (plus `--host`, see below) |
| Vite / Rollup (build) | `base` in `vite.config` |
| Next.js | `basePath` in `next.config.js` |
| Create React App | `"homepage"` in `package.json` (or `PUBLIC_URL`) |
| Express / Node | mount the router under the prefix, or read `X-Forwarded-Prefix` |
| Generic | a "base path" / "base href" / "script name" / "context path" setting |

> **Caveat — the prefix has three path segments** (`proxy`, `<slug>`, `<mount>`).
> A few apps only accept a single-segment route prefix; those can't be mounted at
> a subpath and need to be run at a dedicated origin instead.

### Authentication — cookies *or* tokens both work

The proxy is auth-agnostic. Whatever your app uses to authenticate its own users
flows through untouched:

- **Session cookies** — your app's `Set-Cookie` is rewritten to the mount path and
  replayed by the browser on every request, including the WebSocket handshake.
- **Bearer / token-in-`localStorage`** — your app's own `Authorization: Bearer …`
  header is forwarded to its backend.

UnCorded's *own* session never reaches your app: the proxy-session cookie and the
bootstrap Bearer are stripped, and the authenticated user is passed separately as
`X-Uncorded-User-Id`.

### What your app receives

Every forwarded request (HTTP and WS) carries:

| Header | Value |
| --- | --- |
| `Host` | the upstream's own host — generate absolute URLs from `X-Forwarded-Host` instead if your app emits any |
| `X-Forwarded-Host` | the public UnCorded host the user addressed |
| `X-Forwarded-Proto` | `https` / `http` |
| `X-Forwarded-For` | client IP |
| `X-Forwarded-Prefix` | `/proxy/<slug>/<mount>` — your public base path |
| `X-Uncorded-User-Id` | the authenticated UnCorded user |

Responses stream through as-is. The runtime requests **uncompressed** bodies from
your app (`Accept-Encoding: identity`) so it can rewrite HTML/CSS reliably — you
configure nothing, and the public edge still compresses to the end user.

### Real-time apps (WebSockets)

Declare `proxy.websocket:self` in `permissions`. The proxy then bridges
`wss://…/proxy/<slug>/<mount>/*` to the upstream and — **on the handshake** —
forwards the same context it sends on HTTP: your app's cookies (so a socket
authenticated by session cookie, like Foundry's, sees its session), any
`Authorization` header, the `x-forwarded-*` identity headers, and
`X-Forwarded-Prefix`. You don't configure any of this; it mirrors the HTTP path
automatically.

> **Token auth over WebSockets:** browsers can't set an `Authorization` header on
> a `WebSocket()` — so token-auth realtime apps pass the token in the connection
> URL's query string or a `Sec-WebSocket-Protocol` subprotocol. Both pass through
> the proxy untouched. (The forwarded `Authorization` above covers non-browser ws
> clients and server-to-server sockets.)

> **Origin checks:** the runtime composes the upstream socket itself, so a WS
> server that enforces a strict `Origin` allowlist (some `socket.io` configs,
> Jupyter) may need the upstream's own origin allowed. Most apps authenticate the
> socket by cookie/token and don't require this.

### Changing the upstream or port

- **Editing the upstream setting invalidates the approval** — re-approve after
  changing the URL (see [Approval](#approval-mounts-fail-closed)).
- **Local host apps must bind all interfaces, not loopback.** The runtime runs in
  a container and reaches your machine via `host.docker.internal`. An app bound to
  `127.0.0.1`/`[::1]` refuses that connection (you'll see `PROXY_UPSTREAM_ERROR` /
  502). Bind `0.0.0.0` (e.g. Vite `--host`) and point the upstream setting at
  `http://host.docker.internal:<port>`.

---

## 6. Approval — mounts fail closed

Proxy mounts are **denied until an owner approves them**. There is no implicit
trust: with no approval row, every request to the mount returns
`PROXY_NOT_APPROVED` (surfaced to the frontend as `NOT_APPROVED` / 409). See
[`runtime/src/http/proxy.ts`](https://github.com/UnCorded/uncorded-platform/blob/main/runtime/src/http/proxy.ts)
and the `proxy_approvals` table.

**To approve:** Server settings → **Plugins** → your plugin → **Settings** →
**Approve** (per mount).

Approval is bound to the upstream value. **Changing the upstream setting
invalidates the approval** — re-approve after editing the URL. (Internally the
approval is keyed and version-bumped so old proxy-session cookies stop working.)

---

## 7. Reference — runtime routes

You won't call these directly (the SDK does), but they're useful when debugging:

| Route | Purpose |
| --- | --- |
| `POST /proxy-sessions/:slug/:mount` | Bootstrap a proxy-session (Bearer auth). Returns `{ url, openUrl }`. This is what `sdk.proxy.openMount()` calls. |
| `/proxy/:slug/:mount/*` | The proxy itself. Validates the session cookie; forwards HTTP + WebSocket to the upstream. |
| `POST /admin/.../plugins/:slug/proxy-mounts/:mount/approve` | Owner/admin approval (driven by the Server settings UI). |

---

## Testing checklist

A quick gate before you say "it works":

- [ ] Manifest validates: `proxy_mounts[].upstream_setting` references a real
      `string`/`secret` setting; `permissions` include `proxy.http:self`
      (and `proxy.websocket:self` if the app uses sockets).
- [ ] Plugin folder is under `<server>/plugins/<slug>/` **and** the slug is in
      `server.json` → `installed_plugins`.
- [ ] If the backend imports `@uncorded/plugin-sdk`, its `node_modules` is
      present in the installed folder.
- [ ] Restarted via the **desktop app** (not `docker restart`).
- [ ] Upstream reachable from the container — host apps via
      `http://host.docker.internal:<port>`.
- [ ] Mount **approved** in Server settings → Plugins → Settings → Approve
      (re-approve if you changed the upstream).
- [ ] Panel loads: GET `/`, asset requests, and (if used) the WebSocket upgrade
      all reach the upstream.
