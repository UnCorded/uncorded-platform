# Plugin Reverse Proxy Plan

## Objective

Add a runtime-owned reverse-proxy capability for plugins. The first consumer is a small Foundry VTT plugin that adds a `Foundry` item to the server sidebar and opens the configured Foundry instance inside a plugin panel.

This is not Foundry-specific infrastructure. The same primitive should later work for owner-approved personal software: dashboards, dev tools, campaign helpers, and other local or LAN web apps.

## Current State

UnCorded already has:

- plugin manifests, settings, backend handlers, frontend iframes, sidebar items, and broadcasts
- backend SDK `plugin.fetch()` for bounded outbound HTTP requests
- runtime HTTP routes for plugin static assets and uploads
- a runtime WebSocket server dedicated to UnCorded's `/ws` protocol
- Bearer-token authentication for runtime HTTP APIs, plus WebSocket auth frames for browser clients

UnCorded does not currently have:

- plugin-declared proxy mounts
- runtime proxy routes for arbitrary app HTTP traffic
- runtime proxy support for non-UnCorded WebSocket upgrades
- a safe owner approval model for exposing local/LAN services
- cookie-backed proxy sessions for browser-generated iframe, asset, and WebSocket requests

## V1 Goals

- Let a plugin declare one or more reverse-proxy mounts in `manifest.json`.
- Let an owner configure a fixed upstream URL through the existing plugin settings system.
- Serve each mount under the runtime origin at `/proxy/:pluginSlug/:mountName/*`.
- Support HTTP methods, streaming request/response bodies, and WebSocket upgrades.
- Require an authenticated, mount-bound proxy session before proxying.
- Make the exposed upstream clear in admin UI.
- Keep plugin code simple: the Foundry plugin should only need a sidebar handler and a frontend iframe/fallback link.

## Non-Goals

- Do not run Foundry as a runtime managed service in v1.
- Do not let plugin code proxy arbitrary URLs.
- Do not bypass upstream authentication, licensing, frame policy, or app security.
- Do not make UnCorded manage Foundry users/sessions.
- Do not create an unauthenticated public web proxy.
- Do not implement plugin-driven browser panels in this work.

## Security Model

Reverse proxying can expose private services that remote users could not normally reach. Examples include `127.0.0.1`, `host.docker.internal`, `192.168.x.x`, router admin pages, Docker services, databases, and local dev servers.

V1 uses a constrained model:

- the manifest declares named mounts only
- each mount points to a manifest-declared setting
- the owner/admin configures the upstream value
- the runtime validates and normalizes the upstream
- the runtime owns HTTP routing and WebSocket upgrade handling
- the plugin only receives or hardcodes the mount URL
- proxy access requires a short-lived, signed, mount-bound proxy-session cookie minted after normal UnCorded authentication
- the admin UI shows what upstream is being exposed

The plugin must never receive an API shaped like `proxy(anyUrl)`.

## Critical Browser Auth Constraint

The runtime's normal HTTP auth model is Bearer-token based. That does not work for proxied browser applications.

A plugin frontend can make an authenticated `fetch()` with an `Authorization: Bearer <jwt>` header, but the proxied app cannot. Once an iframe is pointed at `/proxy/:slug/:mount/`, the browser and the upstream app generate the follow-on traffic:

- iframe document navigation
- script/style/image/font requests
- form posts
- WebSocket upgrades
- app-generated asset URLs

Those browser-controlled requests cannot attach the UnCorded Bearer token. Signed query-string URLs are also insufficient because the upstream app generates its own sub-URLs without UnCorded signatures.

Therefore v1 requires a new proxy-session subsystem:

1. Plugin frontend initializes with the normal plugin frontend SDK and receives the runtime auth token.
2. Plugin frontend calls an authenticated bootstrap endpoint with Bearer auth.
3. Runtime performs the same plugin, mount, access, upstream validation, and approval checks.
4. Runtime mints a short-lived, signed, HttpOnly proxy-session cookie bound to:
   - user id
   - server id
   - plugin slug
   - mount name
   - approval version
   - expiry
5. Plugin frontend sets the iframe `src` only after the bootstrap endpoint succeeds.
6. `/proxy/:slug/:mount/*` validates the proxy-session cookie, not the Bearer header.

The proxy route must not rely on `Authorization` headers for browser-loaded content.

Cookie attributes need a topology spike before implementation. If the plugin iframe is embedded under a different site than the runtime tunnel origin, the proxy-session cookie is a third-party iframe cookie; `SameSite=Lax` may not be sent. The likely production setting is `SameSite=None; Secure; HttpOnly`, while local development may need a non-secure dev-only mode. Do not assume cookie behavior here. Resolve it in the Phase 0 cookie topology spike (see Implementation Plan) across the web, desktop, and tunnel paths, and record the decision before any bootstrap-cookie code is written in the foundation PR.

Runtime origins are not stable UnCorded subdomains today. The desktop provisioner stores whatever runtime heartbeat reports as `tunnel_url`: demo mode uses a random `https://<slug>.trycloudflare.com` URL emitted by cloudflared quick tunnels; authenticated mode uses the owner-supplied Cloudflare public hostname when provided; missing/propagating tunnels can temporarily report the local fallback `http://localhost:3000`. Treat the runtime origin as variable and usually cross-site relative to the `uncorded.app` shell unless the actual `tunnel_url` proves otherwise.

Use a `__Host-` cookie only if the cookie satisfies the prefix rules: `Secure`, no `Domain`, and `Path=/`. Since a `__Host-` cookie cannot be path-scoped to `/proxy/:slug/:mount`, the cookie value itself must be signed and mount-bound. A valid naming pattern is:

```text
__Host-uncorded-proxy-<pluginSlug>-<mountName>
```

Because a `__Host-` cookie uses `Path=/`, the browser may send it to non-proxy runtime routes. Only `/proxy/:slug/:mount/*` should validate or act on proxy-session cookies; every other runtime route must ignore them.

## Production Constraints

This should be treated as runtime infrastructure, not a convenience wrapper. The proxy path must have explicit operational boundaries from the first implementation:

- bounded concurrent upstream connections
- bounded request header size
- bounded response header size
- bounded WebSocket frame size
- idle timeouts for HTTP streams and WebSocket connections
- upstream connect timeout
- upstream first-byte timeout
- structured logs for every denied proxy attempt
- metrics for active proxy connections, bytes transferred, upstream errors, and close reasons
- deterministic cleanup when a plugin is disabled, removed, crashes, or changes config

The implementation should fail closed. A missing plugin, disabled plugin, missing mount, invalid upstream, missing capability, unauthenticated user, or unapproved changed upstream must return an explicit error and never attempt an upstream connection.

## Manifest Contract

Add canonical top-level field `proxy_mounts`.

```json
{
  "name": "foundry-vtt",
  "permissions": ["proxy.http:self", "proxy.websocket:self"],
  "settings": [
    {
      "key": "foundry_upstream_url",
      "label": "Foundry upstream URL",
      "type": "string",
      "default": "http://host.docker.internal:30000",
      "required": true
    }
  ],
  "proxy_mounts": [
    {
      "name": "foundry",
      "upstream_setting": "foundry_upstream_url",
      "access": "members"
    }
  ]
}
```

Validation rules:

- `proxy_mounts` is optional.
- If present, it must be a non-empty array.
- `name` is required and uses the same slug-safe pattern as plugin slugs.
- `name` values must be unique per plugin.
- `upstream_setting` is required.
- `upstream_setting` must reference a setting declared in the same manifest.
- The referenced setting must be `type: "string"` or `type: "secret"`.
- `access` is optional in the manifest and defaults to `"members"`.
- Valid v1 `access` values: `"members"`, `"owner"`.
- A plugin with proxy mounts must declare at least one proxy transport capability:
  `proxy.http:self` or `proxy.websocket:self`.
- A mount intended for a normal web app should declare both `proxy.http:self`
  and `proxy.websocket:self`.
- Unknown fields inside each mount fail validation.

Do not add a singular `proxy` shape. The array form is the v1 contract.

## Capability Contract

Add fixed capabilities:

```text
proxy.http:self
proxy.websocket:self
```

`proxy.http:self` means:

- The plugin may declare proxy mounts under its own plugin namespace.
- The runtime may serve HTTP requests for those mounts after owner
  configuration and validation.
- The capability does not allow backend code to choose request targets
  dynamically.

`proxy.websocket:self` means:

- The plugin may use runtime-owned WebSocket upgrade forwarding for declared
  proxy mounts.
- WebSocket support is visible and independently auditable in the manifest.
- The runtime still owns the upstream selection and upgrade handling.

Do not treat WebSocket support as implicitly covered by `proxy.http:self`.
Foundry and most personal web apps should declare both capabilities.

## Runtime Route Contract

Add runtime route:

```text
/proxy/:pluginSlug/:mountName/*
```

Supported methods:

```text
GET HEAD POST PUT PATCH DELETE OPTIONS
```

Request flow:

1. Match `/proxy/:pluginSlug/:mountName/*`.
2. Validate the mount-bound proxy-session cookie.
3. Resolve installed plugin by `pluginSlug`.
4. Resolve proxy mount by `mountName`.
5. Verify the plugin has `proxy.http:self`.
6. Enforce mount access policy.
7. Read the upstream URL from plugin settings, falling back to manifest default.
8. Validate and normalize the upstream URL.
9. Verify the normalized upstream is approved for this mount.
10. Build the upstream request URL from upstream base path plus proxied suffix.
11. Forward method, query string, sanitized headers, and body stream.
12. Stream the upstream response back to the client with sanitized headers.

Add authenticated bootstrap route:

```text
POST /proxy-sessions/:pluginSlug/:mountName
```

Bootstrap request flow:

1. Authenticate with normal runtime Bearer auth.
2. Resolve plugin and mount.
3. Check mount access policy.
4. Validate upstream setting.
5. Verify upstream approval.
6. Mint or rotate the proxy-session cookie.
7. Return the proxied base URL:

```json
{
  "url": "/proxy/foundry-vtt/foundry/"
}
```

The bootstrap route may use existing `extractAuth()` semantics. The proxy route itself must not.

Add admin approval route:

```text
POST /admin/api/plugins/:pluginSlug/proxy-mounts/:mountName/approve
```

This is the only way to create or refresh a mount approval. It is owner/admin gated through existing role/permission machinery, separate from `PATCH /admin/api/plugins/:slug/config`, and must never fire as a side effect of a normal settings save. On success it:

1. Reads the current upstream setting for the mount.
2. Validates and normalizes the upstream.
3. Writes or updates the approval row (normalized origin plus base path).
4. Records `approved_by_user_id` and `approved_at`.
5. Bumps `approval_version`, invalidating any proxy-session cookie minted against the prior version.

Re-approval after an upstream change uses this same route. There is no implicit approval.

Path mapping example:

```text
upstream: http://host.docker.internal:30000
request:  /proxy/foundry-vtt/foundry/socket.io/?EIO=4&transport=polling
target:   http://host.docker.internal:30000/socket.io/?EIO=4&transport=polling
```

If the upstream has a base path:

```text
upstream: http://host.docker.internal:30000/foundry
request:  /proxy/foundry-vtt/foundry/assets/app.js
target:   http://host.docker.internal:30000/foundry/assets/app.js
```

## WebSocket Upgrade Contract

The current runtime is a single `Bun.serve()` with one `websocket` handler object. V1 must add proxy upgrade handling for `/proxy/:pluginSlug/:mountName/*` without changing the UnCorded `/ws` protocol.

Required behavior:

- detect `Upgrade: websocket` on proxy routes before the `/ws` branch and before delegating to `httpFetch`
- validate the mount-bound proxy-session cookie before opening the upstream socket
- apply the same mount resolution and upstream validation as HTTP
- require the plugin manifest to include `proxy.websocket:self`
- enforce mount access policy
- verify the normalized upstream is approved for this mount
- connect to the upstream WebSocket URL using `ws:` or `wss:` based on upstream protocol
- preserve client-requested WebSocket subprotocols when safe
- pipe frames both directions
- close both sides when either side closes
- enforce maximum frame size
- enforce idle timeout
- apply per-IP and per-user rate limits
- apply backpressure; do not buffer unbounded frames while either side is slow
- never expose the upstream URL to unauthenticated users

Implementation constraint:

- tag accepted sockets with `ws.data.kind = "runtime"` for UnCorded protocol sockets or `ws.data.kind = "proxy"` for proxy sockets
- branch at the top of `open`, `message`, `drain`, and `close`
- proxy frames must never enter `router.handleMessage`
- UnCorded protocol frames must never be piped upstream
- proxy frame size is bounded by the shared Bun server frame cap unless the runtime is split into separate servers later

Backpressure should use Bun's concrete primitives:

- treat `ws.send()` returning `-1` as downstream backpressure
- use `drain(ws)` to resume
- watch upstream client WebSocket `bufferedAmount`
- stop or pause forwarding when either side is above the configured high-water mark

This belongs in runtime server/proxy code, not in plugin backend code.

## Approval Model

Plugin settings alone are not enough for private-network exposure. V1 should store an approval record for each normalized upstream target.

Storage owner: approval records live in runtime-owned SQLite via a runtime migration. They must not live in the plugin's own SQLite database or `_config` table, because plugin code must never be able to read, forge, or preserve its own approval.

Approval record:

```text
plugin_slug
plugin_version
mount_name
mount_definition_hash
upstream_setting_key
normalized_upstream_origin
normalized_upstream_base_path
approved_by_user_id
approved_at
approval_version
```

Rules:

- A mount with no approval is disabled.
- Changing the upstream setting invalidates the prior approval.
- Changing the manifest `proxy_mounts` entry invalidates the prior approval for that mount by changing `mount_definition_hash`.
- Disabling or uninstalling the plugin disables all approvals for that plugin.
- Reinstalling a plugin with the same slug must not silently reuse stale approvals unless `plugin_version`, `mount_definition_hash`, and normalized upstream still match.
- Admin UI must show pending approval separately from normal settings save.
- Approval is created or refreshed only through `POST /admin/api/plugins/:slug/proxy-mounts/:mount/approve`. Nothing else may write an approval row; config writes may only invalidate one.
- Runtime must check approval on every HTTP request and WebSocket upgrade, not only at startup.

Invalidation hook:

- plugin settings writes already flow through `PATCH /admin/api/plugins/:slug/config`
- when the changed key equals a mount's `upstream_setting`, invalidate the approval row in the same write path
- this should be transactional with the config update where the existing storage boundaries allow it
- do not rely on a background watcher to keep approvals in sync

This keeps private-network exposure intentional even if a plugin update changes defaults or an admin edits settings casually.

## Upstream Validation

Allowed:

- `http:`
- `https:`

Rejected:

- missing or relative URLs
- URLs with username or password
- non-HTTP schemes
- empty host
- malformed ports
- fragments
- IPv6 zone identifiers
- encoded host confusion such as mixed Unicode/punycode forms that do not normalize cleanly

Normalization:

- store/compute normalized origin plus normalized base path
- remove trailing slash from base path except `/`
- preserve explicit port
- do not follow redirects to a different origin
- resolve and record DNS result class for warning/audit only

DNS and rebinding:

- Resolve hostname at connection time.
- Classify resolved addresses as public, loopback, RFC1918, link-local, unique-local IPv6, or other private ranges.
- Log the classification with the proxy connection.
- If the hostname resolves to a different address class than when approved, require re-approval unless the approved host is a known local alias such as `host.docker.internal`.
- Do not cache DNS forever; use normal resolver behavior plus a short runtime cache if needed for performance.
- Never let a redirect change the upstream origin, even if the redirected target would otherwise pass validation.

Known limitation: DNS classification is advisory if HTTP forwarding uses `fetch()`/Bun's normal resolver path. The runtime can resolve and classify a hostname, but `fetch()` resolves again internally, creating a TOCTOU gap for DNS rebinding. Hard DNS pinning would require manually connecting to the classified IP while preserving the original `Host`/TLS semantics, which is a larger implementation. V1 treats classification as audit/re-approval defense, not a hard SSRF guarantee. `redirect: "manual"` and same-origin redirect rejection are the hard controls.

Private network targets are allowed because exposing owner-approved local services is the point of the feature. The guardrail is explicit owner configuration, not a private-IP ban.

Admin UI copy must make private targets clear:

```text
This exposes http://host.docker.internal:30000 to authenticated members of this server.
```

## Auth and Access Policy

V1 decision: proxy mounts are authenticated. The manifest may choose `"members"` or `"owner"` access per mount.

Access modes:

- `"members"`: any authenticated server member can access the mount.
- `"owner"`: only the server owner can access the mount.

Map access checks onto existing runtime auth/roles primitives. Do not create a parallel role system. `"members"` means the proxy-session bootstrap saw a valid authenticated server member. `"owner"` should use the existing owner/min-level path with owner bypass semantics.

Follow-up: add named permission or role-level gates per mount.

Rationale: Foundry has its own login/session model, and the first version should prove the proxy path before adding a second authorization matrix. The runtime gate still prevents unauthenticated internet access to private upstreams.

The approve/re-approve admin endpoint should use the existing server administration permission path rather than a proxy-specific role model. The exact permission can be chosen during implementation based on the nearby plugin settings/admin API, but it must not be callable by ordinary members.

CSRF and browser-origin policy:

- Browser-generated proxy requests authenticate with the proxy-session cookie, not Bearer auth.
- Runtime proxy-session validation must run before proxying every method, not just mutating methods.
- Do not add wildcard CORS to proxy routes.
- Do not allow cross-origin credentialed reads of proxy responses.
- SameSite/Secure cookie attributes are the runtime's CSRF control for the proxy auth gate; verify them in the actual iframe/tunnel topology.
- For non-GET methods, preserve upstream semantics. UnCorded should not invent CSRF protection for the upstream app, but it must not bypass its own proxy-session gate.

## Header Policy

Strip request hop-by-hop headers:

```text
connection
upgrade
keep-alive
proxy-authenticate
proxy-authorization
te
trailer
transfer-encoding
```

Do not forward these request headers to upstream:

```text
authorization
cookie
```

Do not forward the proxy-session cookie upstream.

Strip the inbound `Cookie` header, parse it runtime-side, then reconstruct an upstream `Cookie` header containing only upstream-app cookies that were previously rewritten for this exact proxy mount.

Strip client-supplied forwarded identity headers before setting runtime-owned values:

```text
x-forwarded-*
x-uncorded-*
```

Set forwarded context headers:

```text
x-forwarded-host
x-forwarded-proto
x-forwarded-for
x-uncorded-user-id
```

Set upstream `Host` to the upstream host, not the UnCorded runtime host, unless a future mount option explicitly requests host preservation.

Forward request headers by denylist plus size limits in v1. Longer term, consider an allowlist mode for sensitive mounts.

Strip response hop-by-hop headers using the same hop-by-hop list.

Do not strip or rewrite:

```text
content-security-policy
x-frame-options
```

Iframe policy belongs to the upstream app/operator. If the app blocks embedded viewing, the plugin panel should show an "Open in browser" fallback that points to the proxied UnCorded URL.

## Cookie Policy

Cookie handling is required for Foundry to be usable.

There are two cookie classes:

1. Runtime proxy-session cookies. These authenticate access to `/proxy/:slug/:mount/*`.
2. Upstream application cookies. These belong to Foundry or another proxied app.

Proxy-session cookies:

- are minted only by `POST /proxy-sessions/:slug/:mount`
- are signed/opaque
- are bound to user id, server id, plugin slug, mount name, approval version, and expiry
- are HttpOnly
- are Secure in production
- use tested SameSite settings for the actual iframe/tunnel topology
- are never forwarded upstream

Upstream application cookies:

- preserve upstream `Set-Cookie`
- rewrite cookie `Path` to `/proxy/:pluginSlug/:mountName` when the upstream path is `/` or absent
- preserve `HttpOnly`, `Secure`, `SameSite`, and expiry attributes
- strip or rewrite `Domain` so cookies bind to the UnCorded runtime host
- forward only cookies scoped to the requested proxy mount
- avoid leaking cookies between plugins or between mounts in the same plugin
- handle multiple `Set-Cookie` headers without collapsing them into one comma-joined header
- preserve cookie names and values exactly
- do not expose upstream cookies to plugin backend code

Tests must cover:

- proxy-session bootstrap sets a cookie after Bearer-authenticated access check
- browser-style proxy request with no Authorization but valid proxy-session cookie succeeds
- expired, wrong-user, wrong-plugin, wrong-mount, or stale-approval proxy-session cookie is rejected
- upstream `Set-Cookie: sid=abc; Path=/`
- upstream cookie without `Path`
- two proxy mounts setting the same cookie name
- request forwarding sends only the matching mount cookie

## Path and Asset Policy

The proxy route is path-preserving, not an HTML-rewriting proxy.

V1 should not rewrite HTML, JavaScript, CSS, or arbitrary response bodies. Apps that emit absolute asset URLs like `/assets/app.js` may require upstream route-prefix configuration to work correctly under `/proxy/:slug/:mount`.

For Foundry, test both:

- upstream without `routePrefix`
- upstream configured with a route prefix compatible with the proxy base path

If Foundry requires `routePrefix`, document that as operator setup rather than adding broad response rewriting.

## Limits and Timeouts

V1 should define conservative defaults in code, with constants and tests:

```text
upstream_connect_timeout_ms: 5000
upstream_first_byte_timeout_ms: 30000
idle_stream_timeout_ms: 60000
max_request_header_bytes: 32768
max_response_header_bytes: 32768
max_websocket_frame_bytes: 65536
max_concurrent_proxy_connections: server-configured, default 256
max_concurrent_proxy_connections_per_user: server-configured, default 16
max_concurrent_proxy_connections_per_mount: server-configured, default 64
```

Do not impose a small response body cap on proxied HTTP responses; streaming apps and assets need to work. Enforce connection and idle limits instead.

## Error Semantics

Proxy errors should be explicit without leaking private upstream details to unauthorized users.

Recommended status mapping:

- `401` missing, invalid, expired, or stale proxy-session cookie on proxy routes; missing/invalid Bearer token on bootstrap/admin routes
- `403` authenticated but not allowed by mount access policy
- `404` plugin or mount not found
- `409` mount exists but upstream is not approved
- `422` upstream setting is invalid
- `502` upstream connection failed or invalid upstream response
- `504` upstream timeout

For authenticated users, include a stable error code:

```json
{
  "error": {
    "code": "PROXY_UPSTREAM_TIMEOUT",
    "message": "The upstream application did not respond in time."
  }
}
```

Do not include private upstream hostnames in normal member-facing error messages. Owner/admin diagnostics may include them.

## Observability

Add structured logs for:

- proxy request denied
- proxy upstream approval missing
- proxy upstream invalid
- upstream connect failure
- upstream timeout
- cross-origin redirect rejected
- WebSocket open/close with close code and reason class
- cookie rewrite errors

Add counters/gauges for:

- active proxy HTTP streams
- active proxy WebSockets
- bytes upstream/downstream by plugin and mount
- upstream error count by code class
- denied request count by reason
- approval-required count

Logs must redact query strings by default because proxied apps may put tokens in URLs.

Use the existing runtime `RateLimiter` infrastructure. Add proxy-specific rate configs such as `RATE_PROXY_HTTP` and `RATE_PROXY_WS_CONNECT` beside the existing HTTP/WS rate configs instead of introducing a separate limiter. Preserve the established pattern: IP-scoped checks before auth where possible, then user-scoped checks after proxy-session validation/bootstrap.

## Plugin SDK Surface

No backend SDK proxy API is required for v1.

Optional frontend helper, if cheap:

```ts
sdk.platform.proxy.url("foundry")
```

returns:

```text
/proxy/foundry-vtt/foundry/
```

This helper is convenience only. The route contract is stable enough that v1 plugins can hardcode their own mount URL.

## Foundry Plugin

Manifest:

```json
{
  "name": "foundry-vtt",
  "version": "0.1.0",
  "api_version": "^1.0",
  "author": "UnCorded",
  "description": "Open a Foundry VTT server from the UnCorded sidebar.",
  "type": "standalone",
  "icon": "Dice6",
  "backend": { "entry": "backend/index.ts" },
  "frontend": { "entry": "frontend/index.html" },
  "permissions": ["proxy.http:self", "proxy.websocket:self"],
  "sidebar": {
    "contributes": true,
    "section": "Tabletop"
  },
  "settings": [
    {
      "key": "foundry_upstream_url",
      "label": "Foundry upstream URL",
      "type": "string",
      "default": "http://host.docker.internal:30000",
      "required": true
    }
  ],
  "proxy_mounts": [
    {
    "name": "foundry",
    "upstream_setting": "foundry_upstream_url",
    "access": "members"
    }
  ]
}
```

Backend:

```ts
import { createPlugin } from "@uncorded/plugin-sdk";

const plugin = createPlugin();

plugin.handle("sidebar.items", async () => ({
  items: [
    {
      id: "foundry",
      label: "Foundry",
      icon: "Dice6",
      panelType: "plugin",
      slug: "foundry-vtt",
      section: "Tabletop"
    }
  ]
}));
```

Frontend:

```html
<!doctype html>
<html>
  <body style="margin:0;height:100vh;overflow:hidden">
    <iframe
      id="foundry-frame"
      style="width:100%;height:100%;border:0"
      allow="fullscreen; clipboard-read; clipboard-write"
    ></iframe>
    <a id="open-link" href="/proxy/foundry-vtt/foundry/" target="_blank" rel="noreferrer">
      Open in browser
    </a>
    <script src="/sdk/plugin-frontend.js"></script>
    <script>
      (async () => {
        const sdk = await window.UncodedPlugin.createPluginFrontend();
        const res = await fetch("/proxy-sessions/foundry-vtt/foundry", {
          method: "POST",
          headers: { Authorization: `Bearer ${sdk.token}` },
          credentials: "same-origin"
        });
        if (!res.ok) return;
        const body = await res.json();
        document.getElementById("foundry-frame").src = body.url;
        document.getElementById("open-link").href = body.url;
      })();
    </script>
  </body>
</html>
```

The fallback link should be visually polished in the real plugin, but the behavior is intentionally simple.

## Iframe Policy

V1 does not treat iframe compatibility as a runtime or SDK concern.

The runtime should faithfully proxy upstream headers. The plugin should provide an "Open in browser" fallback to the proxied UnCorded URL. If the upstream app refuses framing, needs mobile-specific layout, or behaves poorly in an iframe, that is an upstream/operator issue.

## Implementation Plan

### PR Sequencing

Ship in this order. The first shippable PR is a hard foundation — not Foundry, not WebSocket.

- **Phase 0 — Cookie Topology Spike** (gate; throwaway harness, no production proxy code)
- **Phase 1 — Foundation PR**: manifest validation and capability, approval store and invalidation, the proxy-session bootstrap cookie, and a tiny HTTP proxy test app that proves the bootstrap → cookie → proxy loop
- **Phase 2 — HTTP Proxy Core**: full forwarding, header/cookie policy, redirects, limits
- **Phase 3 — WebSocket Proxy**
- **Phase 4 — Admin UI and Approval Endpoint**
- **Phase 5 — Foundry Plugin**

Foundry is the last consumer, not the first scaffold. Do not begin with Foundry or with WebSocket forwarding. The foundation PR must stand on its own: a plugin can declare a mount, an owner can approve an upstream, and an authenticated browser-style request can load a stub upstream page through a minimal proxy — with nothing Foundry-specific and no WebSocket path.

### Phase 0: Cookie Topology Spike

Gate for Phase 1. The proxy-session cookie is the load-bearing auth primitive, so its attributes must be verified in the real topology before any cookie code is written.

- Stand up a throwaway stub `/proxy` route on the runtime origin that sets a proxy-session-shaped cookie and echoes whether it was received.
- Load that route inside a plugin iframe through all three client paths:
  - web client (`localhost:5174`)
  - desktop (Electron)
  - live runtime `tunnel_url` from Central/heartbeat, including demo quick tunnel (`*.trycloudflare.com`) and authenticated/custom-hostname tunnel when available
- For each path and each concrete `tunnel_url`, record whether the cookie is sent on:
  - top-level iframe navigation to `/proxy/...`
  - sub-resource requests generated by the framed document
  - a WebSocket upgrade to the runtime origin
- Record whether the shell origin and runtime `tunnel_url` are same-site or cross-site in each client; this determines whether the cookie is a third-party cookie.
- Test the attribute variants: `SameSite=None; Secure` vs `SameSite=Lax`, `__Host-` prefix vs plain name, with and without `Partitioned` (CHIPS) for the cross-site case, and a non-secure dev-only fallback for `localhost`.
- **Deliverable:** a short decision record committed under `docs/reverse-proxy/` naming the exact cookie attributes per environment, whether `__Host-` is viable, and whether `Partitioned` is required.
- **Gate:** Phase 1 must mint cookies with exactly the attributes this spike validated. Do not implement bootstrap-cookie minting before this decision is recorded.

### Phase 1: Foundation PR

The hard foundation. Everything needed to prove the auth and approval spine end to end, with a deliberately minimal proxy. No Foundry, no WebSocket, no full header/cookie policy.

Manifest and capability:

- Add `proxy_mounts` to shared manifest types and the validator's known top-level fields.
- Validate `proxy_mounts` schema and per-plugin `name` uniqueness.
- Validate `upstream_setting` references a declared string/secret setting.
- Require at least one proxy transport capability when `proxy_mounts` is present.
- Validate optional `access` values; reject unknown mount fields.
- Add capability parser/checker coverage only where useful; the permission grammar already accepts `proxy.http:self` and `proxy.websocket:self`, so most work is cross-field manifest validation and runtime capability checks.
- Add manifest tests for valid mounts, duplicate names, missing settings, wrong setting type, unknown fields, and missing capability.

Approval store:

- Add the runtime-owned approval table via a runtime migration.
- Add the approval resolver/store (runtime SQLite, never plugin SQLite).
- Include `plugin_version`, `mount_definition_hash`, and `upstream_setting_key` in approval rows so plugin upgrades and manifest mount changes cannot silently preserve stale approvals.
- Add the upstream URL validator and normalizer (static normalization that produces the normalized origin plus base path stored in an approval row).
- Hook approval invalidation into `PATCH /admin/api/plugins/:slug/config` when the changed key matches a mount's `upstream_setting`.
- Foundation tests seed approvals directly through the store; the explicit admin approve endpoint arrives in Phase 4.

Bootstrap cookie:

- Add proxy-session signing/mint/validation implementing the Phase 0 cookie decision.
- Add `POST /proxy-sessions/:slug/:mount` (Bearer-authed), binding the cookie to user id, server id, plugin slug, mount name, approval version, and expiry.
- Add tests for valid, expired, wrong-mount, wrong-user, and stale-approval cookies.

Tiny HTTP proxy test app:

- Add a local upstream test server and a minimal `/proxy/:slug/:mount/*` passthrough used only to prove the bootstrap → cookie → proxy loop.
- This minimal passthrough must still fail closed: no valid proxy-session cookie, no upstream connection.
- It deliberately omits header sanitizing, cookie rewriting, redirect handling, DNS classification, and limits — all deferred to Phase 2.
- Add the end-to-end test: bootstrap with Bearer, then a browser-style request with no Authorization but a valid cookie loads a stub upstream HTML page.

### Phase 2: HTTP Proxy Core

Promote the minimal passthrough to the production forwarder.

- Add full HTTP forwarding with streamed request/response bodies.
- Add the request/response header sanitizer (hop-by-hop, auth, and forwarded-identity policy).
- Add cookie rewriting and mount-scoped cookie forwarding.
- Add redirect handling that rejects cross-origin redirects.
- Add connection-time DNS resolution/classification and re-approval on class change.
- Add limits, timeouts, and structured proxy errors.
- Add tests with a local upstream HTTP server covering header policy, cookie rewriting, redirect rejection, streaming, and limits.

### Phase 3: WebSocket Proxy

- Add proxy upgrade handling before or beside the existing `/ws` branch.
- Tag WebSocket connection kind and branch `open`, `message`, `drain`, and `close` handling.
- Reuse proxy mount resolver and upstream validator.
- Gate upgrades on `proxy.websocket:self`.
- Validate proxy-session cookie before connecting.
- Check upstream approval before connecting.
- Pipe frames both directions.
- Enforce frame size, idle timeout, and close propagation.
- Preserve safe subprotocols.
- Use `ws.send()` backpressure return values, `drain(ws)`, and upstream `bufferedAmount` to prove bounded buffering.
- Add tests with a local upstream WebSocket server.

### Phase 4: Admin UI and Approval Endpoint

- Add `POST /admin/api/plugins/:slug/proxy-mounts/:mount/approve` as the explicit approve/re-approve action: normalize the current upstream, write/update the approval row, record `approved_by_user_id` and `approved_at`, and bump `approval_version`. This is the only writer of approval rows.
- Show proxy mounts on the plugin settings/admin surface with the normalized upstream target.
- Show pending approval separately from normal settings save, wired to the approve endpoint.
- Warn for loopback, `host.docker.internal`, RFC1918, link-local, and `.local` targets.
- State the selected access mode for each mount.
- Keep setting edits owner/admin gated through existing plugin settings controls.

### Phase 5: Foundry Plugin

- Add `plugins/foundry-vtt`.
- Add manifest, backend sidebar handler, and frontend panel.
- Bootstrap proxy-session cookie before setting iframe `src`.
- Add iframe fallback link to proxied URL.
- Test against a real Foundry instance:
  - setup screen loads
  - world login works
  - static assets load
  - cookies persist under proxy mount
  - WebSocket/session behavior works
  - reload works
  - "Open in browser" opens proxied URL, not private upstream URL

## Acceptance Criteria

- A plugin with valid `proxy_mounts` loads successfully.
- A plugin with invalid proxy mount schema fails manifest validation with precise errors.
- An unauthenticated request to `/proxy/:slug/:mount/*` is rejected.
- A browser-style request with no Authorization header but a valid proxy-session cookie can load a simple upstream HTML page through the proxy.
- An expired or wrong-mount proxy-session cookie is rejected.
- Request bodies stream to upstream without buffering the whole body.
- Response bodies stream back without buffering the whole body.
- Hop-by-hop and UnCorded auth headers are not forwarded upstream.
- Client-supplied `x-forwarded-*` and `x-uncorded-*` headers are replaced with runtime-owned values.
- Cookie paths are rewritten so mount cookies do not leak across plugins/mounts.
- Changing an upstream setting invalidates approval and disables proxying until re-approved.
- WebSocket echo through `/proxy/:slug/:mount/*` works.
- Proxy WebSocket frames over the shared frame cap close with 1009 and do not enter the UnCorded `/ws` router.
- Cross-origin redirects are rejected or contained.
- SSRF redirect to a metadata/private target such as `http://169.254.169.254/` is rejected because cross-origin redirects are not followed.
- DNS class changes are logged and require re-approval unless explicitly allowed.
- Proxy logs redact query strings.
- Foundry plugin appears in the sidebar and opens the proxied route in a panel.
- If iframe rendering fails, the panel offers an "Open in browser" link to the proxied route.

## Follow-Ups

- Per-mount role or named-permission gates.
- Health check/status indicator for upstream availability.
- Frontend SDK helper for proxy mount URLs.
- Better diagnostics for upstream path-prefix issues.
- Browser/webview panel integration after `client.browser` is designed.
