# Phase 0 — Proxy-Session Cookie Topology Decision Record

**Status: PREDICTED — pending empirical confirmation.**
This record states the analysis and the predicted cookie attributes. The
[`cookie-spike/`](./cookie-spike/) harness must be run across the real client
paths and the results matrix below filled in. Once confirmed, flip the status to
**LOCKED**. Phase 1 must mint proxy-session cookies with exactly the locked
attributes (plan §"Phase 0" gate). **Do not write bootstrap-cookie code until
this is LOCKED.**

---

## 1. Topology (the load-bearing fact)

The proxy-session cookie is set on, and only ever sent to, the **runtime**
origin. It authenticates `/proxy/:slug/:mount/*`, which is served by the runtime.
The plugin iframe document (`/plugins/:slug/ui`) is *also* on the runtime origin,
so the iframe document and the proxy requests it generates are **same-origin with
each other**. The cookie is therefore first-party *to the runtime*.

What determines third-party treatment is the **top-level shell** that embeds the
iframe, because browsers evaluate cookies against the top-level site:

| Client path | Shell (top-level) origin | Runtime (iframe) origin | Relationship |
|-------------|--------------------------|--------------------------|--------------|
| Web (prod) | `https://uncorded.app` | variable — see below | **usually cross-site** |
| Web (dev) | `http://localhost:5174` | `*.trycloudflare.com` (or `http://localhost:3000`) | cross-site (tunnel) / same-site (localhost) |
| Desktop (prod) | `https://uncorded.app` (Electron loads prod web) | variable — see below | **usually cross-site** |
| Desktop (dev) | `http://localhost:5174` | as web dev | cross-site / same-site |

**The runtime origin is not stable.** Per the provisioning/runtime path:

- **Demo mode:** runtime starts a Cloudflare *quick tunnel* and parses a random
  `https://<random>.trycloudflare.com` from `cloudflared` stderr
  (`runtime/src/entrypoint.ts`, `DEMO_URL_RE`).
- **Authenticated Cloudflare mode:** desktop passes a tunnel token + optional
  `cloudflare_public_hostname`; runtime returns `https://${public_hostname}`
  (`apps/desktop/src/server-runtime.ts`, `runtime/src/entrypoint.ts`).
- **No public hostname / propagating tunnel:** runtime may report
  `http://localhost:3000` until a public URL appears; the desktop provisioner
  waits past first heartbeat for a public URL to avoid handing off localhost
  (`apps/desktop/src/provision.ts`).

`*.trycloudflare.com` and arbitrary custom hostnames are **different registrable
domains** from `uncorded.app`, so the plugin iframe is a **third-party,
cross-site frame** in the common case. The only same-site case is the temporary
`http://localhost` fallback embedded in a `localhost` shell.

> Note: the existing admin iframe CSP (`runtime/src/http/handler.ts`)
> `frame-ancestors 'self' http://localhost:* https://uncorded.app
> https://*.uncorded.app` lists `*.uncorded.app`, but the *runtime's own*
> public origin is whatever the tunnel resolves to (trycloudflare/custom), not a
> guaranteed `*.uncorded.app` subdomain. Treat the runtime origin as variable
> and cross-site unless a concrete `tunnel_url` proves same-site.

## 2. Consequence for cookies

A cross-site iframe only sends its cookies on browser-generated subresource /
navigation / WebSocket requests if the cookie is:

1. `SameSite=None; Secure` — `Lax`/`Strict` are not sent in a cross-site
   subresource or WS context, and `None` requires `Secure` (so HTTPS only); **and**
2. **`Partitioned` (CHIPS)** — under Chrome's third-party-cookie phase-out,
   Safari ITP, and Firefox Total Cookie Protection, an *unpartitioned*
   `SameSite=None` cookie is blocked in a third-party context. `Partitioned`
   stores it in a jar keyed to the top-level site, which is exactly the per-user
   single-shell case we have.

`__Host-` prefix requires `Secure`, `Path=/`, and **no `Domain`** — all
compatible with `SameSite=None; Partitioned`. `__Host-` cannot be path-scoped to
`/proxy/:slug/:mount`, so **mount-binding lives in the signed cookie value**, not
the path (plan §"Critical Browser Auth Constraint"). `Path=/` also means the
browser will send the cookie to non-proxy runtime routes — so **only
`/proxy/:slug/:mount/*` may read/act on it; every other route must ignore it.**

## 3. Predicted decision

### Production (HTTPS tunnel — trycloudflare or custom hostname; cross-site)

```
Name:        __Host-uncorded-proxy-<pluginSlug>-<mountName>
Value:       signed, opaque, mount-bound (user id, server id, plugin slug,
             mount name, approval version, expiry)
Attributes:  Secure; HttpOnly; Path=/; SameSite=None; Partitioned
```

Rationale: `SameSite=None; Secure; Partitioned` is the only combination that
survives a third-party iframe across modern browsers; it is also harmless if a
given server happens to be same-site. `__Host-` adds tamper-resistance on the
name (forces Secure + Path=/ + no Domain), and binding is carried in the value.

### Local dev where the runtime is `http://localhost:3000` (same-site, no HTTPS)

```
Name:        uncorded-proxy-<pluginSlug>-<mountName>   (no __Host-/Partitioned)
Attributes:  HttpOnly; Path=/; SameSite=Lax
```

Rationale: `http://localhost` cannot use `Secure`, hence cannot use
`SameSite=None`, `Partitioned`, or `__Host-`. This case only arises when the
shell is also `localhost` (same-site), where `Lax` is sufficient. Gate this
behind an explicit dev-only flag so production can never silently drop `Secure`.

> A dev shell on `http://localhost:5174` pointed at an HTTPS *tunnel* runtime is
> cross-site **and** Secure-capable, so it uses the **production** cookie, not
> the dev fallback. The dev fallback is strictly the `http://localhost` runtime.

## 4. Empirical results matrix — FILL THIS IN (then LOCK)

Run [`cookie-spike/`](./cookie-spike/) per its README. `Y` = cookie carried,
`n` = not carried. Record browser + version.

### Cross-site: shell `https://uncorded.app` (or `localhost:5174`) → runtime `https://<tunnel>.trycloudflare.com`

| Variant | doc nav | subresource fetch | WS upgrade | Browser/version | Notes |
|---------|:------:|:-----------------:|:----------:|-----------------|-------|
| `lax` | | | | | (expected: all n) |
| `none` | | | | | (expected: blocked under 3pc) |
| `none-partitioned` | | | | | |
| `host-none-partitioned` | | | | | (predicted winner) |

Repeat the table for: **Chrome/Electron-Chromium**, **Safari**, **Firefox**, and
for the **authenticated/custom-hostname tunnel** if available.

### Same-site dev: shell `http://localhost:5174` → runtime `http://localhost:3000`

| Variant | doc nav | subresource fetch | WS upgrade | Browser/version | Notes |
|---------|:------:|:-----------------:|:----------:|-----------------|-------|
| `dev-lax` | | | | | (expected: all Y) |

### Per-client same/cross-site confirmation

| Client path | Concrete shell origin | Concrete `tunnel_url` | Same-site or cross-site? |
|-------------|----------------------|-----------------------|--------------------------|
| Web dev | | | |
| Web prod | | | |
| Desktop dev | | | |
| Desktop prod | | | |

## 5. Open questions to resolve while running

- Does Safari send `Partitioned` cookies in this exact framed-fetch + WS shape?
  (Safari's CHIPS support is newer; if it fails, the panel must lean on
  "Open in browser" for Safari users, or we accept top-level-only on Safari.)
- Does the WebSocket upgrade carry the partitioned cookie in every browser?
  (Phase 3 depends on this; if not, WS proxy needs a cookie-in-subprotocol or
  query-token fallback — note it here, do not silently degrade.)
- Confirm `__Host-` + `Partitioned` is accepted together (some older engines
  rejected the combination).

## 6. Lock

When the matrix is complete and the predicted decision holds (or is amended),
change **Status** at the top to `LOCKED`, summarize any deviation here, and
proceed to Phase 1. Phase 1's `mintProxySessionCookie` must emit exactly the
locked attribute set, with a single dev-only branch for the `http://localhost`
runtime case.
