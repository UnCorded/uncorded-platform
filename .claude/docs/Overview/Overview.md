# UnCorded — Overview

*The front door to this vault. Read this first. Every other file is detail for something referenced here.*

---

## The One-Sentence Version

> **UnCorded Central can hand over "this server exists at this URL" and nothing else — because that's all it knows.**

That sentence is the entire privacy architecture of the platform in plain English. Every decision in this vault exists to make it literally, structurally, technically true. If a decision contradicts it, the decision is wrong.

---

## What UnCorded Is

UnCorded is a **collaborative-first platform** where people hang out, build things together, or run a business on their own terms. It is a runtime and a marketplace for communal software — users decide what their community needs and assemble it from plugins. Chat is one of those plugins, not the product.

The core product is a **server runtime** any user can run on their own hardware, plus a **directory** that makes those servers discoverable. Everything else — chat, voice, galleries, game integrations, dashboards, custom tooling — is a plugin that drops into the runtime.

---

## The Three Components

| Component | Where it runs | What it does |
|---|---|---|
| **UnCorded Central** | UnCorded's cloud | Account auth, server directory, plugin marketplace, heartbeat/invalidation. **Never touches user content.** |
| **Server Container** | User's hardware (Docker) | Runs the Bun runtime, loads plugins, stores data in per-plugin SQLite, handles users over a Cloudflare tunnel. Owns all user data. |
| **Client Apps** | User's device | Web (SolidJS) and desktop (Electron). Shell UI with plugin iframes. Desktop adds Docker management and the server creation wizard for hosting. |

---

## The Rust/Steam Analogy

The mental model is borrowed from Facepunch's Rust and Valve's Steam:

| Role in Rust | Role in UnCorded |
|---|---|
| Facepunch — builds the game, runs the workshop, provides auth | **Central** — builds the runtime, hosts the marketplace, issues verified identities |
| Rust server hosts — run servers on their own hardware, install mods, set rules | **Server owners** — run containers, install plugins, set policies |
| Rust players — one Steam account, browse the server list, join anywhere | **Users** — one UnCorded account, browse the directory, join anywhere |

Central does three things: **verifies who you are**, **lists servers**, and **distributes plugins**. Everything else happens on the server.

---

## Phase 1 Wedge

**Phase 1 is built deliberately for homelab builders and gaming communities.** Not because they are the most valuable long-term market — because they are the right first market. They already run Docker, understand tunnels, file bugs constructively, and will build the plugin ecosystem that makes later use cases viable.

**Two load-bearing examples** every design decision should be evaluated against:

1. **The homelab dashboard server.** One container running chat alongside Home Assistant, Plex, Proxmox, and media-request plugins. All plugins reach host services over localhost because they run in the same container. Discord structurally cannot replicate this — Discord is not on the user's machine.
2. **The Minecraft community server.** The Minecraft jar runs in the same container as the chat plugin and an admin control plugin. Admins edit `server.properties`, manage the whitelist, view live logs — because the MC jar is a directory over. Discord can post "Player joined" messages via a bot. That is a toy.

Both depend on a plugin doing something that requires running code **next to other code on the same hardware**. That adjacency is the entire value. No centralized platform can replicate it.

**Graduating from this wedge** is a measurable threshold, not a date: *UnCorded is ready to optimize for non-technical users when the server creation flow no longer requires Docker comfort to complete successfully.*

Details: `spec-01-vision-and-wedge.md`

---

## Locked Architectural Decisions

These are resolved. They do not get reopened without a concrete reason.

- **Server runtime:** Bun on Docker, per-plugin SQLite in WAL mode. Details: `spec-03-server-container.md`
- **Plugin data model:** per-plugin SQLite, plugin-owned writes only, **cross-plugin reads via declared capability** (`data.read:<plugin>.<table>`). Extensions like reactions-on-text-channels read via capability, never duplicate. Details: `spec-05-plugin-data-model.md`
- **Desktop app:** **Electron** with `electron-updater`. Chromium bundled for identical rendering on Windows/macOS/Linux — critical for a solo dev without Apple hardware. Hosts the server creation wizard, Docker container management, plugin marketplace UI, and the same shell viewport as the web app. Code-signed releases, background-download auto-update with restart-to-apply.
- **Web app:** SolidJS + Tailwind CSS, MessagePack for WebSocket frames.
- **Auth model:** Steam-style. Central issues short-lived signed tokens; servers validate against Central's public keys. Standard **JWT with Ed25519** for tokens; MessagePack only for wire frames. Details: `spec-06-authentication.md`
- **Session tokens in the web shell:** `__Host-`-prefixed HTTP-only cookie on the central auth domain, `SameSite=Strict`, `Secure`. Server tokens are in-memory only, short-lived.
- **iframe auth delivery:** origin-verified `postMessage` handshake only. Tokens never touch URLs or persistent storage. Shell pushes refreshes.
- **Tunnel providers Phase 1:** Cloudflare only, in two modes — **Demo** (trycloudflare, ephemeral) and **Production** (authenticated, stable URL). Tailscale Funnel is committed for Phase 2. Details: `spec-03-server-container.md`
- **Plugin communication:** **WebSocket-for-everything.** Plugin frontends talk to their backends over the existing authenticated WebSocket via `sdk.request()` (request/response) and `sdk.subscribe()` (real-time events). No per-plugin HTTP routes. File uploads go through a single runtime HTTP endpoint at `/upload`. The runtime mediates all traffic — auth, capabilities, rate limiting, audit — in one place. Details: `spec-04-plugin-architecture.md`
- **Plugin isolation:** subprocess-per-plugin, container-level cap-drop, capability-mediated IPC. Details: `spec-04-plugin-architecture.md`
- **Plugin permissions:** capability-based, declared in manifest, enforced at the runtime side of the IPC boundary. No in-process trust.
- **Plugin API versioning:** `runtime_version` and `api_version` are independent. Semver. `@uncorded/plugin-sdk` published per API major.
- **Event bus:** runtime-mediated, at-least-once with idempotency by ID, per-(topic, subscriber) FIFO order. **Default backpressure policy is `mark_unhealthy`** — silent drops are opt-in, never default.
- **Central language:** **Bun**, with a 72-hour tripwire to Node if runtime-caused production incidents occur. Enforced by a `no-bun-specific-apis` lint rule and a `PORTABILITY.md` tracking file.
- **Central outage behavior:** **strict by default** — new joins fail closed during outages. Server owners can opt into permissive mode with a loud warning.
- **No DMs, no friends list.** All communication happens inside servers. Two people who want a private chat create a two-person server.
- **No P2P, no WebTorrent.** Everything is server-side. Files live on the server container's filesystem.

---

## Phased Build Plan at a Glance

| Phase | Ships |
|---|---|
| **Phase 1** | Core runtime, Central, desktop app, Cloudflare tunnel (Demo + Production), hot reload, core plugin (text-channels), Official-tier marketplace, strict outage default, capability enforcement |
| **Phase 2** | Core Module (member management, moderation, workspace layout persistence), Verified + Community marketplace tiers, voice-channels (WebRTC + server-side SFU), Tailscale Funnel, emergency revocation push channel, pricing live |
| **Phase 3** | Extension plugin hook system, worker-mode execution, native mobile, observability depth |
| **Post-launch** | Plugin Studio, Managed UnCorded Hosting |

Details: `spec-17-phased-build-plan.md`

---

## Non-Negotiable Engineering Principles

1. **Security is not optional.** Every auth flow designed before implementation. Fail closed.
2. **Tests for everything.** If it isn't tested, it isn't done.
3. **Production standards from day one.** No `any`. Typed errors. Structured logging. Observability from launch.
4. **Simplicity over cleverness.** One mechanism for cache invalidation, not two. One sandbox boundary, not five.
5. **User data is sacred.** Central never touches it. No hidden telemetry on content.
6. **Failures are loud by default.** Silent data loss is the worst failure mode. If it can be silent, make it scream, and let the caller opt into silence with open eyes.

Details: `spec-15-engineering-principles.md`

---

## Vault Map

Each file is a deep-dive on one subsystem. Read the Overview, then go to whichever file is relevant to the question you have.

| File | Covers |
|---|---|
| `spec-01-vision-and-wedge.md` | The product vision, the Phase 1 target audience, the wedge use cases, and the threshold for broadening the audience. |
| `spec-02-system-overview.md` | The three-component architecture diagram and the boundaries between Central, server containers, and clients. |
| `spec-03-server-container.md` | Everything inside the Docker container — runtime startup, plugin loader, tunnel abstraction, heartbeat loop. |
| `spec-04-plugin-architecture.md` | Plugin types (core / standalone / extension), manifest schema, subprocess isolation, capability permissions, event bus, hot reload, resource limits. |
| `spec-05-plugin-data-model.md` | **Per-plugin SQLite, cross-plugin read capability, extension plugin data patterns, cross-plugin cascades.** The file that replaces "everything is a folder" hand-waving with concrete rules. |
| `spec-06-authentication.md` | Steam-style token flow, JWT format, iframe postMessage handshake, token storage model, cache invalidation. |
| `spec-07-url-security.md` | Why public tunnel URLs are safe, how unauthenticated requests are rejected, the fallback upgrade prompt. |
| `spec-08-uncorded-central.md` | Central's API surface, rate limiting, anti-abuse, outage behavior, trust and safety, the permanent-SPOF question. |
| `spec-09-client-apps.md` | Web shell and desktop app architecture, plugin iframe viewport, Docker management on desktop. |
| `spec-10-server-creation.md` | The wizard flow, plugin selection, tunnel mode selection, first boot. |
| `spec-11-marketplace.md` | Trust tiers (Official / Verified / Community / Unsigned), publishing pipeline, revocation, reputation signals. |
| `spec-12-data-flow.md` | How messages, files, and events move through server containers. Why nothing is P2P. |
| `spec-13-trust-and-safety.md` | What UnCorded acknowledges, what it can do, what it will not build. Minors and COPPA posture. |
| `spec-14-monetization.md` | Free accounts, paid hosting, pricing philosophy. |
| `spec-15-engineering-principles.md` | The non-negotiable rules that govern every line of code. |
| `spec-16-tech-stack.md` | The full stack, with justification for each choice and escape hatches where they exist. |
| `spec-17-phased-build-plan.md` | What ships in each phase, what gates the transitions, what is explicitly post-launch. |
| `status-open-questions.md` | All `[TBD-*]` items, their severity, and what has to happen before each one resolves. |
| `archive/19-workspace-layout.md` | The customizable panel workspace system — layout persistence, server owner defaults, panel types, grid model. Replaces single-plugin viewport from `spec-09-client-apps.md`. |
| `spec-20-browser-panel.md` | Built-in browser panel capability — Electron `<webview>` for any URL, web/mobile install prompt fallback, user-owned panels. Plugin-driven open (`platform.browser.open`) is **disabled** pending `client.browser` enforcement (removed from the SDK in `e04ea44`); multi-user co-browsing deferred. |
| `spec-21-sidebar-model.md` | How the sidebar works — runtime-composed from plugin contributions, role-based admin controls, extensions contribute nothing, users never see plugin names. |

---

## How to Use This Vault

- **New to the project?** Read this Overview, then `spec-01-vision-and-wedge.md`, then `spec-02-system-overview.md`. That's a 15-minute orientation.
- **Building a specific subsystem?** Skip to the relevant file. Each one is self-contained enough to use as a spec.
- **Making a design decision?** Check `01` for the wedge, `15` for the principles, and the relevant subsystem file. Use the Overview's "Locked Architectural Decisions" list to confirm what's already settled.
- **Reviewing or onboarding someone else?** Hand them this file. Everything else is reference depth they can dip into.

---

## Documentation Rule: Future Refinements

Every subsystem file documents **what we build now** and **where it's going next**. These are kept in a clearly separated `## Future Refinements` section at the bottom of each file. The purpose is not to spec future work — it's to ensure today's code doesn't accidentally block tomorrow's features.

A future refinement entry has three parts:
1. **What changes** — the specific behavior or capability that gets added later
2. **Why not now** — what's missing (data, users, ecosystem maturity) that makes it premature
3. **What today's code must not do** — the constraint on current implementation to keep the door open

If today's code would make a documented future refinement impossible or expensive, that's a design bug.

---

*This file is the anchor. Other files grow in detail. When a locked decision in this file conflicts with a detailed file, the detailed file is wrong and this file is right — fix the detailed file, not this one.*
