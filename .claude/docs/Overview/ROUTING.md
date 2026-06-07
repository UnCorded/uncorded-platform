---
vision: "Central knows nothing beyond 'this server exists at this URL'"
tenet: "Simplicity over cleverness"
depends-on: []
last-verified: 2026-04-05
---

# Routing — Vault File Map

*What's in each file, what tenet it serves, and how files relate to each other.*

---

## Entry Points

| File | Purpose |
|---|---|
| `README.md` | The front door. 60-second overview, how to use the vault, quick reference table. |
| `Overview.md` | The anchor. Locked decisions, phased plan, engineering principles summary, full vault map with descriptions. |

---

## Architecture Files

| # | File | Tenet | Covers | Depends on |
|---|---|---|---|---|
| 01 | `spec-01-vision-and-wedge.md` | All tenets originate here | Product vision, Phase 1 audience, wedge use cases, success criteria, the measurable UX threshold for broadening | — |
| 02 | `spec-02-system-overview.md` | Simplicity over cleverness | Three-component architecture, data flows between components, trust boundaries, failure modes, what Central knows (and doesn't) | 01 |
| 03 | `spec-03-server-container.md` | Local-first, user-owned data | Docker container internals, filesystem layout, startup sequence, HTTP surface, WebSocket lifecycle, rate limiting, tunnel abstraction, presence, networking, container lifecycle | 01, 04, 05, 06 |
| 04 | `spec-04-plugin-architecture.md` | Every feature is a choice | Plugin structure, types (core/standalone/extension), manifest schema, lifecycle (7-step load, unload), WebSocket-for-everything communication, capability permissions, event bus, resource limits, hot reload, API versioning | 01, 05 |
| 05 | `spec-05-plugin-data-model.md` | Local-first, user-owned data | Per-plugin SQLite, private-by-default published schema, raw SQL for own DB, structured cross-plugin reads, numbered migrations, cross-plugin cascades, data retention on uninstall | 04 |
| 06 | `spec-06-authentication.md` | Security is not optional | Account creation (email + Google OAuth), Steam-style auth flow, JWT with Ed25519, token storage model, iframe postMessage handshake, heartbeat with dirty flag, ownership on Central, built-in roles system, admin panel | 01, 03 |

## Planned Files (Not Yet Written)

| # | File | Tenet | Will cover | Depends on |
|---|---|---|---|---|
| 07 | `spec-07-url-security.md` | Security is not optional | Why public tunnel URLs are safe, unauthenticated request rejection, the upgrade prompt on tunnel failure | 03, 06 |
| 08 | `spec-08-uncorded-central.md` | Simplicity over cleverness | Central's API surface, rate limiting, anti-abuse, outage behavior, the permanent SPOF question | 02, 06 |
| 09 | `spec-09-client-apps.md` | Every feature is a choice | Web shell (SolidJS), desktop app (Electron), iframe viewport, Docker management, token management | 03, 04, 06 |
| 10 | `spec-10-server-creation.md` | Every feature is a choice | The desktop wizard flow, plugin selection, tunnel mode, first boot, transactional rollback on failure | 03, 09 |
| 11 | `spec-11-marketplace.md` | Security is not optional | Trust tiers (Official/Verified/Community/Unsigned), publishing pipeline, static analysis, revocation, reputation signals | 04, 08 |
| 12 | `spec-12-data-flow.md` | Local-first, user-owned data | How messages, files, and events move through the system. Why everything is server-side, no P2P. | 02, 03, 04 |
| 13 | `spec-13-trust-and-safety.md` | Security is not optional | Platform responsibility, what Central can/cannot do, CSAM/threats, the 30-second window, COPPA/minors, the "hard line" against content scanning | 02, 06, 08 |
| 14 | `spec-14-monetization.md` | Collaborative-first | Free accounts, paid hosting, pricing philosophy, what users pay for, cost structure | 01, 08 |
| 15 | `spec-15-engineering-principles.md` | All tenets | Full expansion of all 6 principles with examples and enforcement mechanisms | 01 |
| 16 | `spec-16-tech-stack.md` | Simplicity over cleverness | Every technology choice with justification, escape hatches, and the Bun tripwire | 01, 03, 08, 09 |
| 17 | `spec-17-phased-build-plan.md` | All tenets | Phase 1/2/3/post-launch scope, gate conditions, success criteria, what is explicitly deferred | All files |
| 18 | `status-open-questions.md` | All tenets | Every [TBD-*] item collected, with severity, context, and what must happen before each resolves | All files |

---

## Dependency Graph

```
spec-01-vision-and-wedge
  └── spec-02-system-overview
        ├── spec-03-server-container ←── spec-04-plugin-architecture ←── spec-05-plugin-data-model
        │         │
        │         └── spec-06-authentication
        │                   │
        │         ┌─────────┘
        │         │
        ├── spec-07-url-security
        ├── spec-08-uncorded-central
        │         │
        │         ├── spec-11-marketplace
        │         ├── spec-13-trust-and-safety
        │         └── spec-14-monetization
        │
        ├── spec-09-client-apps
        │         └── spec-10-server-creation
        │
        └── spec-12-data-flow

spec-15-engineering-principles ← standalone (references 01)
spec-16-tech-stack             ← standalone (references 01, 03, 08, 09)
spec-17-phased-build-plan      ← references all files
status-open-questions         ← references all files
```

---

## Cross-Reference: Where Key Concepts Live

| Concept | Primary file | Also referenced in |
|---|---|---|
| One-sentence vision | 01, Overview | Every file's frontmatter |
| Rust/Steam analogy | 01 | 02, Overview |
| Wedge use cases (homelab, Minecraft) | 01 | Overview |
| Three-component architecture | 02 | Overview |
| Trust boundaries | 02 | 06, 07 |
| Container startup sequence | 03 | — |
| WebSocket-for-everything | 04 | 03, 05 |
| Plugin manifest schema | 04 | 05 |
| Capability permissions | 04 | 05, 06 |
| Event bus + backpressure | 04 | 05 |
| Per-plugin SQLite | 05 | 03, 04 |
| Published schema / cross-plugin reads | 05 | 04 |
| Cross-plugin cascades | 05 | — |
| Auth flow (Steam-style JWT) | 06 | 03, 07 |
| Token storage model | 06 | 07, 09 |
| iframe postMessage handshake | 06 | 04, 09 |
| Heartbeat + dirty flag | 06 | 03, 08 |
| Built-in roles system | 06 | 03, 09 |
| Admin panel | 06 | 03 |
| Registered terminals (Terminal Anywhere) — **removed in `95dec38`; spec-25 is historical only** | 25 | — |
| Rate limiting (server-side) | 03 | 06 |
| Rate limiting (Central) | 08 (planned) | 06 |
| Tunnel abstraction | 03 | 10 |
| Plugin data model | 05 | 04 |
| Principle #6 (failures are loud) | 15 (planned) | 04, 05, Overview |
