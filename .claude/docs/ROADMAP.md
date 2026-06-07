# UnCorded Build Roadmap

Last updated: 2026-04-10

---

## Phase 1 — Bootable Server (critical path)

Goal: `docker run` works. Users can create and use a server.

| # | Item | Status |
|---|------|--------|
| 1 | **Roles engine** — core.db SQLite, 4 default roles (owner/admin/mod/member), custom role CRUD, plugin-defined permission registration, SDK check/hasRole/hasMinLevel | ✅ Done |
| 2 | **Startup orchestrator** — boot() wiring all subsystems, strict capabilities (no-checker = deny+error), signal handlers, PID 1 warning | ✅ Done |
| 3 | **Plugin SDK** (`@uncorded/plugin-sdk`) — sdk.request/handle, sdk.events, sdk.permissions, sdk.data. Typed, publishable. | ✅ Done |
| 4 | **text-channels core plugin** — manifest, migrations, message CRUD via SDK, minimal chat iframe UI. Proves full loop. | ✅ Done |
| 5 | **HTTP endpoints** — /health, /upload, /plugins/\<slug\>/ui/\*, /plugins/\<slug\>/manifest.json, /admin/ stub | ✅ Done |
| 6 | **Heartbeat client** — POST to Central every 30s, dirty flag optimization, delta application (bans/profiles/revocations) | ✅ Done |
| 7 | **Dockerfile** — uncorded/server image, 3 volumes, --cap-drop=ALL, --security-opt=no-new-privileges, read-only rootfs, tini | ✅ Done |

---

## Phase 1.5 — Desktop App + Central (shippable)

Goal: Phase 1 is shippable. Users can create accounts, find servers, install plugins.

| # | Item | Status |
|---|------|--------|
| 8 | **Central API** — auth (Argon2id + Ed25519 JWT), OAuth (Google/Discord/GitHub), server directory, email verification, Turnstile CAPTCHA, ASN rate limiting, structured logging, plugin marketplace read/write, R2 integration, avatar upload | ✅ Done |
| 9 | **Desktop app** — Electron main process scaffold, Docker detection + management, IPC channels, OS-backed secret store, auto-update, server creation wizard (wizard UI follows item 10) | 🔶 In progress — scaffold, Docker, IPC, secret-store contract, auth bridge done; provisioning wizard remaining |
| 10 | **Web app shell** — SolidJS + Tailwind, server list, plugin nav, iframe viewport, postMessage auth handshake, WebSocket management, token refresh, becomes Electron renderer | ✅ Done |
| 11 | **Admin panel** — /admin/ web UI: role management, plugin management, cascade panel, audit log (Terminal Anywhere / xterm.js removed — deferred, not shipped in V1) | ✅ Done |

---

## Phase 2 — Public Directory + Voice

| # | Item | Status |
|---|------|--------|
| 12 | Emergency plugin revocation | 🔲 |
| 13 | Public server directory | 🔲 |
| 14 | Voice (WebRTC SFU) | 🔲 |
| 15 | Tailscale Funnel support | 🔲 |
| 16 | Marketplace tiers (Verified, Community) | 🔲 |
| 17 | Plugin pricing / payments | 🔲 |
| 18 | Watchdog improvements | 🔲 |

---

## Phase 3 — Extension Ecosystem + Mobile

| # | Item | Status |
|---|------|--------|
| 19 | UI injection hooks (plugin-to-plugin sidebar/toolbar contributions) | 🔲 |
| 20 | Worker-thread mode (high-throughput plugins) | 🔲 |
| 21 | Native mobile app (iOS/Android — join/use servers only, no hosting) | 🔲 |
| 22 | Role inheritance | 🔲 |

---

## Post-Launch

| # | Item | Status |
|---|------|--------|
| 23 | Plugin Studio (visual plugin builder) | 🔲 |
| 24 | Managed Hosting (servers on UnCorded infrastructure) | 🔲 |

---

## Notes

- Items gate sequentially within Phase 1. Don't skip ahead.
- Item 10 (web app) must ship before the item 9 wizard UI can be completed — the Electron shell loads the SolidJS renderer.
- Item 11 (admin panel) depends on item 10's SolidJS shell being in place.
- Phase 2 items are independent of each other and can be parallelized once Phase 1.5 is done.
- Mobile (item 21) requires a separate auth delivery design — the postMessage iframe model doesn't port to native mobile.
