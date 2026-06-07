---
vision: "Central knows nothing beyond 'this server exists at this URL'"
tenet: "All tenets"
depends-on: [all files]
last-verified: 2026-04-05
---

# 17 — Phased Build Plan

*What ships in each phase, what gates the transitions, and what is explicitly deferred.*

---

## Phase 1 — Foundation

**Audience:** homelab builders and gaming communities.
**Goal:** a working self-hosted server platform with the core plugin experience.

### What ships

**Server Container Runtime**
- Bun runtime with plugin loader, auth gateway, roles engine, event bus, watchdog
- 9-step startup sequence with per-step error reporting
- WebSocket-for-everything communication model
- Single `/upload` endpoint for file uploads
- Per-plugin SQLite in WAL mode
- Published schema for cross-plugin reads
- Numbered SQL migrations, runtime-executed
- Cross-plugin cascades (event-driven, best-effort, visible failures)
- Hot reload (file watch → graceful restart → re-validate → respawn)
- Capability-based permission enforcement at IPC boundary
- Subprocess-per-plugin isolation with container-level cap-drop
- Resource limits (memory, CPU, PIDs, FDs, disk) with quarantine on crash loops
- Event bus with `mark_unhealthy` default backpressure
- Plugin API versioning (runtime_version + api_version, semver)
- Rate limiting on every endpoint
- `@uncorded/plugin-sdk` v1.0 published

**Tunnel**
- Cloudflare in Demo + Production modes
- `TunnelProvider` interface (abstraction for future providers)
- Tunnel health detection with upgrade prompt on Demo failure
- `tunnel.fallback` field in config (reserved, not wired)

**Auth and Identity**
- Central auth: email + password + Google OAuth
- Anti-abuse: CAPTCHA, email verification, per-IP and per-ASN rate limits
- JWT with Ed25519 token issuance
- `__Host-` HTTP-only session cookies, in-memory server tokens
- postMessage iframe auth handshake
- Heartbeat every 30 seconds with dirty flag optimization
- Server ownership on Central
- Built-in roles: owner, admin, moderator, member + custom roles
- `sdk.permissions.*` API for plugins
- Admin panel at `/admin/` with owner/admin access

**Central**
- Account registration and login
- Server directory (register, browse, online/offline tracking)
- Plugin marketplace (Official tier only — UnCorded's own plugins)
- Heartbeat endpoint with sync version + dirty flag
- Rate limiting on all endpoints
- `no-bun-specific-apis` lint rule + `PORTABILITY.md`
- Strict fail-closed outage default, permissive mode opt-in

**Core Plugins (Official tier)**
- `text-channels` — messages, mentions, edits, deletions

**Core Module** (runtime built-in, not a plugin — Phase 2)
- Profile cache, presence, join history, bans, audit log
- Shell management UI in server settings sheet
- *Note: `members` and `moderation` plugins are removed in Phase 2; their functionality moves here*

**Client Apps**
- Web app (SolidJS + Tailwind): shell UI, server list, plugin iframe viewport, marketplace browser
- Desktop app (Electron): everything in web + Docker management + server creation wizard + auto-updates
- Code-signed desktop builds for Windows and macOS

**Infrastructure**
- Central deployed (Bun + PostgreSQL + Cloudflare R2)
- CI/CD pipeline with tests, linting, signing
- Structured logging and observability on Central from day one

### What does NOT ship in Phase 1

- Voice channels (Phase 2)
- Tailscale Funnel (Phase 2)
- Verified/Community marketplace tiers (Phase 2)
- Emergency revocation push channel (Phase 2 — gates public directory)
- Extension plugin UI injection / hook system (Phase 3)
- Worker-thread execution mode (Phase 3)
- Native mobile app (Phase 3+)
- Plugin Studio (post-launch)
- Managed hosting (post-launch)
- HIPAA/GDPR/SOC 2 compliance documentation (Phase 2+ audience concern)

### Phase 1 success criteria

- 50-100 self-hosted servers running reliably
- 3-5 third-party plugins published by community developers
- Zero data loss incidents
- A server owner can create, run, and manage a server without asking for help
- The homelab dashboard and Minecraft community examples both work end-to-end

---

## Phase 2 — Voice, Trust, and Scale

**Audience:** expanding beyond the initial wedge. Public directory opens.

### What ships

- **Core Module** — boot initialization, profile cache, presence, join history (`members` table), bans + audit log, `sdk.core` API surface, shell Members + Moderation panels in server settings sheet. Replaces the `members` and `moderation` plugins which are removed.
- **Workspace layout persistence** — `workspace_layouts` and `server_default_layout` tables, GET/PUT `/workspace/layout` and `/workspace/default` endpoints, shell saves/restores layout per user per server.
- **Voice channels** — WebRTC with server-side SFU (LiveKit, bundled in the runtime image, dormant until activated by a `voice.media`-capable plugin), Opus codec. LiveKit signaling is direct between client and the server's LiveKit endpoint; the UnCorded WebSocket carries channel state, presence, and moderation events but not media signaling. `[TBD-voice-turn-hosting]` resolved per `spec-24-voice.md`: self-host default with bundled TURN on TCP/443; managed relay deferred to Phase 2.5.
- **Tailscale Funnel** — second tunnel provider, committed deliverable. Tailnet/port-exposure caveat documented.
- **Emergency revocation push channel** — WebSocket from Central to running servers for real-time ban/revocation delivery. **Gates the public directory opening.**
- **Public server directory** — opens once emergency push is live. Servers can opt into being discoverable.
- **Verified publisher tier** — identity verification, security review, signed releases with a publisher key Central holds.
- **Community plugin tier** — any UnCorded account can publish. No review. Self-signed. "Community plugin" label.
- **Pricing goes live** — exact tiers determined from Phase 1 cost data.
- **Plugin update notifications** — heartbeat includes update-available flags, admin panel and desktop app surface them.

### Phase 2 success criteria

- Voice channels work reliably for groups of 10+
- Verified and Community marketplace tiers live with real third-party plugins
- Emergency push channel live, public directory open
- Tailscale Funnel shipping as an alternative tunnel provider
- Pricing active with paying server owners

### Phase 2 gate condition

Phase 2 does not begin until Phase 1 success criteria are met. Specifically: servers running reliably and community plugins being published indicates the foundation is solid enough to build on.

---

## Phase 3 — Extension Ecosystem, Mobile, and Maturity

**Audience:** broader developer ecosystem and first non-technical users.

### What ships

- **Extension plugin hook system** — base plugins expose UI injection points, extensions render inside base plugin iframes. The formal hook API.
- **Worker-thread execution mode** — signed/verified plugins can opt into `"execution": "worker"` for lower overhead. Subprocess remains the default.
- **Native mobile app** — iOS/Android for joining servers (not hosting). Requires resolving `[TBD-mobile-auth-model]`.
- **Observability depth** — per-plugin metrics dashboards, health history, connection analytics in the admin panel.
- **Role inheritance and permission templates** — roles can inherit from parent roles. Templates for common setups ("gaming community," "work team," "family").

### Phase 3 success criteria

- Extension plugins are being built and published by third-party developers
- Non-technical users can join and use servers from mobile
- Server owners have actionable observability into their server's health

---

## Post-Launch — Developer Tooling and Ecosystem Depth

These ship after the core platform is live, validated, and stable. They are explicitly deferred because they need real-world usage data to design correctly.

### Plugin Studio
A first-party developer-tool plugin. Developers install it on their own server, connect their own Anthropic API key, and use it to build plugins faster — live editing, AI-assisted generation, one-click publishing. Each developer brings their own key. UnCorded never proxies AI calls. See `Overview.md` for the full concept.

**Trigger:** ships after watching 3-5 real plugin developers build plugins the hard way. The pain points they hit are what Plugin Studio solves.

**Dependency:** requires `runtime.plugin.install` capability to be wired up (reserved in Phase 1, implemented when Plugin Studio needs it).

### Managed UnCorded Hosting
UnCorded runs containers for users who don't want to self-host. Eliminates the Docker/desktop-app funnel. Opens the platform to non-technical server owners and the professional use cases (therapy, small business, education) deferred in `spec-01-vision-and-wedge.md`.

**Trust boundary preserved:** a managed server is still the user's server. UnCorded operates infrastructure but treats data the same as a self-hosted server's data.

**Trigger:** ships after the core platform is operationally mature enough that UnCorded can confidently run other people's servers.

---

## How Phase Transitions Work

Phase transitions are not dates. They are **gate conditions:**

| Transition | Gate |
|---|---|
| Phase 1 → Phase 2 | Phase 1 success criteria met. Servers running reliably, community plugins being published. |
| Phase 2 → Phase 3 | Emergency push live, public directory open, pricing active, voice channels working, marketplace tiers live. |
| Phase 3 → Post-launch | Extension hook system live, mobile app live, non-technical users successfully onboarding. |

If a gate isn't met, the phase doesn't advance. Features from the next phase do not leak backwards to "help" meet the current gate. The current phase ships what it committed to, proves it works, and then the next phase begins.

---

## What Is Explicitly Never Phase 1

These items come up repeatedly in design discussions. For clarity, they are explicitly not Phase 1, and the reasoning is documented:

| Item | Why not Phase 1 |
|---|---|
| Voice channels | SFU + WebRTC is 3-6 months of engineering. Phase 2. |
| Public server directory | Requires emergency push channel. Not safe without it. Phase 2. |
| Compliance docs (HIPAA, GDPR) | Phase 1 audience doesn't need them. Phase 2+ audience does. |
| Mobile app | postMessage auth model doesn't port to native. Phase 3. |
| Plugin Studio | Need real plugin developers to hit real pain first. Post-launch. |
| Managed hosting | Need operational maturity before hosting for others. Post-launch. |
| Federation | Enormous protocol design problem. Not on any phase roadmap yet. |
| E2E encryption | Changes the entire data model. A future refinement, not a phase item. |
