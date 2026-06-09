# Phase 0 — Proxy-Session Cookie Topology Decision Record

**Status: LOCKED — empirically confirmed 2026-06-09.**
The [`cookie-spike/`](./cookie-spike/) harness was run against a live HTTPS
Cloudflare quick-tunnel runtime origin across Chromium, Firefox, and WebKit
(Playwright engine builds), including a Chromium third-party-cookie-blocked pass.
The results (§4) confirm the predicted cookie attributes (§3) and surface one
target-client limitation — **Safari/WebKit cannot carry any cookie in a
cross-site iframe**, which is handled by the top-level "Open in browser" fallback
(empirically verified to work). Phase 1 must mint proxy-session cookies with
exactly the locked attributes (§3) and implement the Safari fallback (§4a).

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

```text
Name:        __Host-uncorded-proxy-<pluginSlug>-<mountName>
Value:       signed, opaque, mount-bound (user id, server id, plugin slug,
             mount name, approval version, expiry)
Attributes:  Secure; HttpOnly; Path=/; SameSite=None; Partitioned
```

Rationale: `SameSite=None; Secure; Partitioned` is the only combination that
survives a third-party iframe across modern browsers; it is also harmless if a
given server happens to be same-site. `__Host-` adds tamper-resistance on the
name (forces Secure + Path=/ + no Domain), and binding is carried in the value.

### Local dev where the runtime is `http://localhost:3000` (same-site)

```text
Name:        uncorded-proxy-<pluginSlug>-<mountName>   (no __Host-/Partitioned)
Attributes:  Secure; HttpOnly; Path=/; SameSite=None   (sandboxed plugin panel)
             HttpOnly; Path=/; SameSite=Lax            (non-framed fallback)
```

Rationale: production still uses the locked `__Host-` + `Partitioned` HTTPS
cookie. For local development, browsers treat `localhost` as a trustworthy
origin for `Secure` cookies, so sandboxed plugin panels can exercise the framed
flow with `Secure; SameSite=None` even on `http://localhost`. Keep the plain
`SameSite=Lax` branch only as a non-framed/local fallback. Gate both behind an
explicit dev-only localhost check so production can never silently drop the
locked production attributes.

> A dev shell on `http://localhost:5174` pointed at an HTTPS *tunnel* runtime is
> cross-site **and** Secure-capable, so it uses the **production** cookie, not
> the dev fallback. The dev fallback is strictly the `http://localhost` runtime.

## 4. Empirical results (2026-06-09)

### Method

- **Runtime origin (iframe):** live HTTPS quick tunnel
  `https://lauren-guides-…​.trycloudflare.com` → local spike server (`:8787`).
- **Shell origin (top-level):** a **second** live HTTPS quick tunnel
  `https://waves-…​.trycloudflare.com` → same spike server.
  `trycloudflare.com` is on the Public Suffix List, so the two tunnel hostnames
  are **different registrable domains → genuinely cross-site**, exactly the
  production relationship. An `http://localhost:8787` shell was also run as a
  second cross-site case; results matched, ruling out an insecure-top-level
  artifact.
- **Engines:** Playwright builds — Chromium 148, Firefox 150, WebKit 26.4
  (Safari engine). Driven headless via `playwright`. The Chromium 3pc-blocked
  pass forces the production cookie-phase-out state with CDP
  `Network.setCookieControls { enableThirdPartyCookieRestriction: true }`.
- **Measured:** cookie carriage on the three browser-generated request types the
  proxy depends on — (a) iframe **document navigation**, (b) framed
  **subresource `fetch()`**, (c) **WebSocket upgrade**. `firstLoad` is the very
  first iframe load (no cookie exists yet, so doc-nav is always `n`); `reNav`
  re-navigates the iframe with the cookie already set (this is the row that
  matters for doc-nav, and it models real usage where bootstrap sets the cookie
  *before* the iframe loads).

> ⚠️ These are **Playwright engine builds**, not shipping consumer browsers, and
> run headless. They are an excellent behavioral proxy (WebKit tracks Safari
> ITP; the Chromium 3pc-blocked pass is the authoritative phase-out signal) but
> the Safari result especially should be re-confirmed on real Safari hardware
> before GA. The *direction* of every result is unambiguous and reproducible.

### Cross-site iframe — shell `https://<tunnelB>` → runtime `https://<tunnelA>` (the embedded-panel case)

`Y` = carried, `n` = not carried. doc-nav column reports the **reNav** (cookie
already set) reading; fetch/ws are identical on firstLoad and reNav unless noted.

| Engine / condition | Variant | doc nav | fetch | WS | Stored? |
|--------------------|---------|:------:|:-----:|:--:|---------|
| **Chromium 148** (3pc allowed) | `lax` | n | n | n | — |
| | `none` | Y | Y | Y | yes |
| | `none-partitioned` | Y | Y | Y | yes (partitioned) |
| | `host-none-partitioned` | Y | Y | Y | yes, `partitionKey=https://<tunnelB>` |
| **Chromium 148** (**3pc BLOCKED**) | `lax` | n | n | n | — |
| | `none` | **n** | **n** | **n** | **no** (blocked) |
| | `none-partitioned` | Y | Y | Y | yes (partitioned) |
| | `host-none-partitioned` | **Y** | **Y** | **Y** | yes (partitioned) |
| **Firefox 150** (default) | `lax` | n | n | n | — |
| | `none` | Y | Y | Y | yes |
| | `none-partitioned` | Y | Y | Y | yes |
| | `host-none-partitioned` | Y | Y | Y | yes |
| **WebKit 26.4 / Safari** (default ITP) | `lax` | n | n | n | — |
| | `none` | n | n | n | no |
| | `none-partitioned` | n | n | n | no |
| | `host-none-partitioned` | **n** | **n** | **n** | **no — not even stored** |

**Readings:**

1. **`__Host-; SameSite=None; Secure; Partitioned` is the correct production
   cookie.** It is the *only* combination (with `none-partitioned`) that survives
   Chromium's third-party-cookie phase-out, and it carries on **all three**
   request types — document navigation, subresource fetch, **and WebSocket
   upgrade** — under 3pc blocking. `__Host-` is accepted together with
   `Partitioned` (cookie stored with the prefix and a `partitionKey`), so the
   prefix's tamper-resistance is free.
2. **Unpartitioned `none` is not viable** — it works only while 3pc is allowed
   and is cleanly dropped (set *and* send) the moment 3pc blocking is on. `lax`
   never carries cross-site, as expected.
3. **WebSocket carries the partitioned cookie** wherever the partitioned cookie
   works at all (Chromium, Firefox). No WS-specific fallback is needed on those
   engines; Phase 3 can rely on the cookie on the upgrade request.
4. **Safari/WebKit carries nothing in a cross-site iframe** — and the cookie is
   not even stored. This is **not** a cookie-attribute problem: *no* attribute
   set (Lax/None/Partitioned/`__Host-`) works, because Safari ITP refuses
   third-party cookie storage in an iframe without the Storage Access API. See
   §4a.

### Same/cross-site per client path (concrete)

| Client path | Shell origin | Runtime (`tunnel_url`) | Relationship | Cookie path |
|-------------|--------------|------------------------|--------------|-------------|
| Web prod | `https://uncorded.app` | `*.trycloudflare.com` / custom CF hostname | **cross-site** | production `__Host-…Partitioned` |
| Web dev | `http://localhost:5174` | `*.trycloudflare.com` | cross-site, Secure-capable runtime | production cookie |
| Web dev | `http://localhost:5174` | `http://localhost:3000` | **same-site** | localhost dev cookie (`Secure; SameSite=None` in sandboxed plugin panels, `Lax` fallback otherwise) |
| Desktop prod | `https://uncorded.app` (Electron=Chromium) | `*.trycloudflare.com` / custom | **cross-site** | production cookie (✓ Chromium) |
| Desktop dev | `http://localhost:5174` | as web dev | cross-site / same-site | as web dev |

The same-site dev case (`localhost:5174`→`localhost:3000`) is same-**site**
(host `localhost`, port-only difference), so `SameSite=Lax` is carried in
ordinary same-site contexts. Sandboxed plugin panels are opaque-origin frames,
however, so local panel testing uses the framed-compatible localhost cookie
(`Secure; SameSite=None`, no `Partitioned`) that browsers accept on localhost.

## 4a. Safari/WebKit limitation and the locked fallback

In a cross-site iframe Safari carries **no** proxy-session cookie. The locked
handling is the plan's **"Open in browser"** path: a **top-level** (first-party)
navigation to the proxied URL. Verified empirically in WebKit 26.4 — loading the
runtime page top-level (not framed) carries the cookie on **all three** request
types and stores it:

| WebKit, top-level (first-party) | doc nav | fetch | WS | Stored? |
|---------------------------------|:------:|:-----:|:--:|---------|
| `host-none-partitioned` | Y | Y | Y | yes |
| `dev-lax` | Y | Y | Y | yes |
| `lax` | Y | Y | Y | yes |

**Locked Safari behavior (Phase 5 panel):**

- Render the embedded iframe as on every engine. Because the cookie won't carry
  in Safari, the proxied content fails closed (401) inside the frame.
- Always offer **"Open in browser"** → top-level navigation to the proxied URL,
  where the cookie is first-party and works. This is the committed Safari path.
- *Optional future enhancement (not required to ship):* call
  `document.requestStorageAccess()` from the iframe on a user gesture to attempt
  in-frame access. Not relied upon by the locked design.

This satisfies the gate rule "if any one request type fails in a target client,
adjust the design": the adjustment is the app-layer fallback (no cookie attribute
can fix Safari's iframe policy), and it is verified to work.

## 5. Open questions — resolved

- **Does Safari send `Partitioned` cookies in the framed fetch + WS shape?**
  No — Safari/WebKit stores and sends nothing in a cross-site iframe under ITP,
  regardless of `Partitioned`/`__Host-`. Handled by the top-level fallback (§4a).
- **Does the WebSocket upgrade carry the partitioned cookie in every browser?**
  Yes on Chromium and Firefox (including Chromium 3pc-blocked). No on Safari
  in-frame (nothing carries there). No WS-specific cookie fallback is needed on
  the engines where the cookie works at all.
- **Is `__Host-` + `Partitioned` accepted together?** Yes — confirmed stored
  with the prefix and a `partitionKey` on Chromium; Firefox stores it too.

## 6. Lock — summary

**LOCKED 2026-06-09.** The predicted decision (§3) holds unchanged:

- **Production:** `__Host-uncorded-proxy-<slug>-<mount>`,
  `Secure; HttpOnly; Path=/; SameSite=None; Partitioned`, mount-binding in the
  signed value. Verified to carry on document navigation, subresource fetch, and
  WebSocket upgrade on Chromium (incl. 3pc-blocked) and Firefox.
- **Dev (`http://localhost` runtime, same-site only):** `uncorded-proxy-<slug>-<mount>`,
  `Secure; HttpOnly; Path=/; SameSite=None` for sandboxed plugin panels, with
  `HttpOnly; Path=/; SameSite=Lax` retained only as a non-framed/local fallback.
  Never emit a non-`Secure` cookie when the runtime origin is HTTPS.
- **Deviation from prediction:** one new constraint — **Safari/WebKit cannot use
  the embedded iframe** for proxied content; Phase 5 must ship the verified
  top-level "Open in browser" fallback (§4a). No change to cookie attributes.

Phase 1's `mintProxySessionCookie` must emit exactly this attribute set, with a
single dev-only branch for the `http://localhost` runtime case. Phase 5 must
implement the Safari fallback.

The [`cookie-spike/`](./cookie-spike/) harness, this record's raw runs, and the
standalone multi-engine driver (`<USER_HOME>/pw-spike`, throwaway) backed
these results. The `cookie-spike/` directory is disposable now that this is
locked.
