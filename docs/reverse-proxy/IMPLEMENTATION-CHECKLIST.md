# Reverse-Proxy Plugin — Implementation Checklist

One PR, commits per phase. Source of truth: `plugin-reverse-proxy-plan.md`.
Do not push until explicitly asked. CodeRabbit review happens after the full
implementation lands and `bun test` + `bun typecheck` are clean.

Legend: `[ ]` todo · `[~]` in progress · `[x]` done

---

## Phase 0 — Cookie Topology Spike (GATE) — commit: `chore(proxy): phase 0 cookie topology spike`

Throwaway harness, **no production proxy code**. Gates all cookie work.

- [x] Throwaway runnable spike server (`docs/reverse-proxy/cookie-spike/spike-server.ts`)
      — sets a proxy-session-shaped cookie with selectable attributes; echoes
      carriage on (a) iframe document navigation, (b) sub-resource fetch,
      (c) WebSocket upgrade.
- [x] Embeddable shell + iframe pages + variant matrix UI.
- [x] README with run + `cloudflared` quick-tunnel + per-shell embedding steps.
- [x] Decision record scaffold (`phase-0-cookie-topology-decision.md`) with
      topology analysis, predicted decision, and an empty results matrix.
- [x] **Empirical run (2026-06-09):** swept all variants across a live HTTPS
      Cloudflare quick-tunnel runtime origin (cross-site, PSL-separated) in
      Chromium 148 (incl. a CDP 3pc-blocked pass), Firefox 150, and WebKit 26.4.
      Verified doc-nav + subresource fetch + WS-upgrade carriage. Results in the
      decision record §4.
- [x] **GATE LOCKED:** `__Host-…; Secure; HttpOnly; Path=/; SameSite=None;
      Partitioned` carries on all three request types on Chromium (incl.
      3pc-blocked) and Firefox. **Deviation found:** Safari/WebKit carries no
      cookie in a cross-site iframe → Phase 5 must ship the verified top-level
      "Open in browser" fallback (decision record §4a). No change to attributes.

## Phase 1 — Foundation PR — commit(s): manifest, approval store, bootstrap cookie, minimal proxy

**Manifest & capability** (`packages/shared/src/manifest.ts`)
- [x] Add `proxy_mounts` to `PluginManifest` type + `KNOWN_TOP_LEVEL_FIELDS`.
- [x] Validate `proxy_mounts`: optional, non-empty array; per-mount `name`
      (slug-safe, unique); `upstream_setting` references a declared
      `string`/`secret` setting; optional `access` ∈ {`members`,`owner`}
      (default `members`); unknown mount fields rejected.
- [x] Require ≥1 of `proxy.http:self` / `proxy.websocket:self` in `permissions`
      when `proxy_mounts` present.
- [x] Manifest tests: valid mounts, dup names, missing/ wrong-type setting,
      unknown fields, missing capability.

**Approval store** (runtime-owned SQLite)
- [x] Migration: `proxy_approvals` table (plugin_slug, plugin_version,
      mount_name, mount_definition_hash, upstream_setting_key,
      normalized_upstream_origin, normalized_upstream_base_path,
      approved_by_user_id, approved_at, approval_version). Add to
      `runtime/src/db/expected-tables.ts`.
- [x] Upstream URL validator + normalizer (origin + base path; reject userinfo,
      non-http(s), empty host, bad port, fragments, IPv6 zone ids).
- [x] Approval store/resolver (runtime SQLite only). `mount_definition_hash`
      over the mount definition.
- [x] Invalidation hook in `PATCH /admin/api/plugins/:slug/config` when changed
      key == a mount's `upstream_setting` (transactional with the config write).
- [x] Tests seed approvals directly through the store (admin approve endpoint is Phase 4).

**Bootstrap cookie** (implements Phase 0 decision)
- [x] Proxy-session sign / mint / validate. Bind: user id, server id, plugin
      slug, mount name, approval version, expiry.
- [x] `POST /proxy-sessions/:slug/:mount` (Bearer-authed via `extractAuth`).
- [x] Tests: valid, expired, wrong-mount, wrong-user, stale-approval.

**Minimal HTTP proxy proof**
- [x] Local upstream test server + minimal `/proxy/:slug/:mount/*` passthrough
      (cookie-validated, fail-closed; no header/cookie/redirect/DNS/limits yet).
- [x] E2E: Bearer bootstrap → cookie → no-Authorization browser-style request
      loads stub upstream HTML.

## Phase 2 — HTTP Proxy Core — commit: `feat(proxy): http forwarder`
- [x] Streamed request/response forwarding.
- [x] Header sanitizer (hop-by-hop, auth/cookie strip, forwarded-identity policy,
      strip spoofed `x-forwarded-*` / `x-uncorded-*`, set runtime-owned).
- [x] Cookie rewriting + mount-scoped cookie forwarding.
- [x] Redirect handling: reject cross-origin redirects (`redirect: "manual"`).
- [x] Connection-time DNS resolution/classification + re-approval on class change.
- [x] Limits/timeouts (constants from plan) + structured proxy errors.
- [x] Tests: header policy, cookie rewrite, redirect rejection, streaming, limits,
      SSRF redirect (169.254.169.254) rejected, query-string redaction in logs.

## Phase 3 — WebSocket Proxy — commit: `feat(proxy): websocket forwarder`
- [ ] Proxy upgrade detected before the `/ws` branch; `ws.data.kind` tagging.
- [ ] Branch `open`/`message`/`drain`/`close`; proxy frames never hit `router`.
- [ ] Reuse mount resolver + upstream validator; gate on `proxy.websocket:self`;
      cookie + approval check before upstream connect.
- [ ] Pipe both directions; frame-size cap (1009), idle timeout, close propagation,
      safe subprotocols, backpressure (`send()===-1`, `drain`, `bufferedAmount`).
- [ ] Tests: echo through proxy; oversized frame → 1009, never enters `/ws` router.

## Phase 4 — Admin UI & Approval Endpoint — commit: `feat(proxy): admin approval`
- [ ] `POST /admin/api/plugins/:slug/proxy-mounts/:mount/approve` — only writer of
      approval rows; normalize current upstream, write row, record approver/time,
      bump `approval_version`.
- [ ] Admin surface: show mounts + normalized upstream; pending-approval distinct
      from settings save; warnings for loopback/`host.docker.internal`/RFC1918/
      link-local/`.local`; show access mode.

## Phase 5 — Foundry Plugin — commit: `feat(plugins): foundry-vtt`
- [ ] `plugins/foundry-vtt`: manifest, backend `sidebar.items`, frontend panel.
- [ ] Bootstrap cookie before iframe `src`; "Open in browser" fallback to proxied URL.
- [ ] **Safari/WebKit (LOCKED, decision §4a):** the cookie does not carry in a
      cross-site iframe; always offer "Open in browser" (top-level navigation to
      the proxied URL, verified to work). Optional later: `requestStorageAccess()`.
- [ ] Manual test against real Foundry (operator checklist in plan §Phase 5).

---

## Definition of done (every phase)
- `bun typecheck` clean · `bun test` clean · regression test for any fix.
- No `any`; typed errors; structured logging; capability-checked; fail-closed.
