---
vision: "Central knows nothing beyond 'this server exists at this URL'"
tenet: "All tenets originate here"
depends-on: []
last-verified: 2026-04-05
---

# 01 — Vision and Wedge

*Why UnCorded exists, who it's for first, and when the audience broadens.*

---

## The One-Sentence Version

> **UnCorded Central can hand over "this server exists at this URL" and nothing else — because that's all it knows.**

Every decision in this project traces back to making that sentence literally, structurally, technically true.

---

## What UnCorded Is

UnCorded is a **collaborative-first platform** where people hang out, build things together, or run a business — on their own terms. Users decide what their community needs and assemble it from plugins. Chat is one of those plugins, not the product.

The core product is:
1. A **server runtime** any user can run on their own hardware inside a Docker container.
2. A **directory** that makes those servers discoverable.
3. A **marketplace** where developers publish plugins and users install them.

Everything else — text chat, voice, photo galleries, game server management, dashboards, custom tooling — is a plugin that drops into the runtime.

---

## What UnCorded Is Not

- **Not a chat app.** Chat is a plugin. A server with no chat plugin is still a valid server.
- **Not a Discord clone.** Discord is a centralized chat platform that hosts your data. UnCorded is a runtime that lets you host anything on your hardware. The overlap is superficial.
- **Not a hosting company.** UnCorded doesn't run your server. You do. UnCorded verifies your identity, lists your server, and distributes plugins. That's it.

---

## The Rust/Steam Analogy

The mental model is borrowed from Facepunch's Rust and Valve's Steam:

| Role in Rust | Role in UnCorded |
|---|---|
| **Facepunch** — builds the game, runs the workshop, provides auth | **UnCorded Central** — builds the runtime, hosts the marketplace, issues verified identities |
| **Rust server hosts** — run servers on their own hardware, install mods, set rules | **Server owners** — run containers, install plugins, set policies |
| **Rust players** — one Steam account, browse the server list, join anywhere | **Users** — one UnCorded account, browse the directory, join anywhere |

Central does three things: **verifies who you are**, **lists servers**, and **distributes plugins**. Everything else happens on the server.

---

## Core Tenets

### 1. Collaborative-first
Every feature exists to help people do something together. A solo tool with no collaboration surface is not an UnCorded plugin — it's an app that belongs elsewhere.

### 2. Every feature is a choice
Core plugins (text channels, members, moderation) are pre-checked in the server creation wizard as sensible defaults, but every one is a boolean the owner can uncheck. A server can start with the full core suite, a subset, or completely empty. Defaults exist for onboarding; choice remains the principle.

### 3. Local-first, user-owned data
Your server's data lives on your hardware, in your SQLite databases, in your filesystem. UnCorded Central never touches user content. There is no proprietary cloud storage layer. A server is a folder. A plugin is a folder. You can back it up, move it, rebuild it.

### 4. No lock-in
The data format is SQLite — universally readable. The wire format is MessagePack — open standard. The plugin format is a folder with a manifest, a backend, and a frontend. There is no proprietary encoding you can't escape.

---

## Who UnCorded Is For (Phase 1)

**Phase 1 is built deliberately for homelab builders and gaming communities.** Not because they are the most valuable long-term market — because they are the right first market.

### Why these users first

- **They already run Docker.** The server creation flow requires Docker. Homelab users have a Docker install running right now. Most people do not.
- **They already understand tunnels, reverse proxies, port forwarding.** These are not intimidating words to the target audience.
- **They find bugs constructively.** When something breaks, they file an issue with logs and a reproduction instead of churning.
- **They build the plugin ecosystem.** A homelab user with a weekend and a Minecraft server will write a plugin. A therapist will not, and should not have to.
- **They are forgiving about rough edges.** For at least the first year, UnCorded will have rough edges. The target audience will tolerate them. Professional users will not, and should not be asked to.

### Who is NOT the Phase 1 audience

The architecture supports professional use cases today — a therapist needing HIPAA-aligned communication, a small business owner replacing SaaS tools, a researcher sharing datasets on institutional infrastructure. If any of them find UnCorded in Phase 1 and choose to use it, they are welcome. Nothing is taken from them.

But professional adoption cannot be bought with better onboarding alone. It requires trust, security credibility, compliance documentation, and a track record of not losing data. **Those are earned, not shipped.** You earn them by running reliably for a year with users who forgive rough edges while you do.

### What Phase 1 discipline means in practice

- Marketing targets r/selfhosted, r/homelab, Minecraft and Rust community forums, indie gamedev servers.
- Plugin prioritization favors homelab and gaming utility over business productivity.
- Compliance documentation (HIPAA, GDPR, SOC 2) is explicitly not a Phase 1 deliverable.
- Onboarding copy may assume the user knows what Docker is.
- Feature requests from professional users are respected, logged, and deferred.

---

## The Two Load-Bearing Examples

Every Phase 1 design decision should be evaluated against these two use cases. If a decision makes either of them harder, it is the wrong decision.

### Example 1: The homelab dashboard server

A homelab user runs Home Assistant, Plex, Proxmox, and Pi-hole on the same machine. They want one place to chat with family, monitor services, and give trusted guests scoped access to the media library.

On UnCorded, this is **one server container** running four plugins: a chat plugin, a Home Assistant bridge plugin, a Plex status plugin, and a media-request plugin. All four plugins reach the host's services over localhost because they run in the same container. Family members join via a stable URL. Guests get invite links with scoped access.

**Why Discord cannot do this:** Discord bots cannot see Home Assistant. Discord cannot host a Plex request queue. Discord cannot run on the user's hardware. The homelab user currently glues together Home Assistant's native UI, Tautulli, Overseerr, and a Discord channel — four tools, four logins, no shared identity. UnCorded replaces all four with one server.

### Example 2: The Minecraft community server

A small Minecraft community has an admin, a few moderators, and a couple dozen regular players. The Minecraft server runs on the admin's spare PC. They currently use Discord for voice, announcements, and rule discussions.

On UnCorded, the Minecraft server and the community run in the **same container**. A Minecraft control plugin lets admins edit `server.properties`, manage the whitelist, restart the server, view live logs, and see real-time player counts — because the MC jar is running in the next directory over. A chat plugin replaces Discord text. A voice plugin (Phase 2) replaces Discord voice.

**Why Discord cannot do this:** Discord can post "Player joined" messages via a bot. That is a toy. Discord cannot start the Minecraft server, cannot edit its config files, cannot run it at all, because Discord does not live on the admin's machine. UnCorded does.

### What both examples share

Both use a plugin to do something that requires running code **next to other code on the same hardware**. That adjacency is the entire value. No centralized chat platform can replicate it, ever, because centralized means "not on your machine."

---

## The Threshold for Broadening the Audience

Graduating from the Phase 1 target to a broader audience is not a date. It is a **measurable UX threshold:**

> UnCorded is ready to optimize for non-technical users when the server creation flow no longer requires Docker comfort to complete successfully.

Until that threshold is met, marketing, documentation, plugin prioritization, and feature selection all stay focused on the Phase 1 audience.

### What crosses the threshold

- **Managed hosting** (post-launch): UnCorded runs the container for you. No Docker, no desktop app required to own a server. This eliminates the self-hosting friction entirely for users who want the UnCorded model without running infrastructure.
- **One-click installers**: a desktop app flow that installs Docker automatically if it's not present, instead of assuming it exists.
- **Simplified tunnel setup**: automatic Production tunnel without requiring the user to create a Cloudflare account (requires business relationship with Cloudflare or an alternative tunnel provider).

None of these are Phase 1. All of them are on the roadmap.

---

## Use Cases Beyond the Wedge

These are not Phase 1 targets, but they are architecturally supported and represent the long-term market:

| Use case | Why it can't exist on Discord | When it matters |
|---|---|---|
| **Family photo archive** | Photos live on grandma's PC, not Discord's servers. Privacy by architecture. | Early traction — spreads by word of mouth |
| **Small business workspace** | CRM, invoicing, Kanban, chat — all plugins, all on the owner's hardware. Replaces 4 SaaS subscriptions. | Early traction — businesses have budget |
| **Therapist / lawyer / accountant communication** | HIPAA, attorney-client privilege, financial compliance. Data must live on the professional's hardware. | Long-term value — regulated industries, Phase 2+ |
| **Classroom / education** | FERPA compliance. Assignments and grades on institutional infrastructure. | Long-term value — Phase 2+ |
| **Research lab data sharing** | Institutional compliance. Datasets shared on institutional infra. | Long-term value — Phase 2+ |
| **Adult creator community** | No deplatforming risk. Content on the creator's hardware, not a platform that changes ToS. | Real market — handle carefully, let it find you organically |
| **Political organizing / journalism** | Self-hosted, uncensorable by platform. Central can only hand over "this server exists at this URL." | Real market — handle carefully |

### The strongest early-traction cases

The three most reachable use cases outside the Phase 1 wedge are:
1. **Family photo archive** — non-technical but spread by word of mouth within families
2. **Homelab dashboard** — already the Phase 1 wedge
3. **Small business workspace** — actively shopping for cheaper alternatives to SaaS stacks

### The highest long-term value cases

The three most valuable use cases over time are:
1. **Regulated industries** (healthcare, legal, education) — compliance mandates, serious budget, no good alternatives
2. **Small business workspace** — recurring revenue, high retention
3. **Creator communities** — large market, strong loyalty, willingness to pay

---

## What Success Looks Like

### Phase 1 success (homelab + gaming wedge)
- 50-100 self-hosted servers running reliably.
- 3-5 third-party plugins published by community developers.
- Zero data loss incidents.
- A server owner can create, run, and manage a server without asking for help.
- The two load-bearing examples (homelab dashboard, Minecraft community) both work end-to-end.

### Phase 2 success (voice + marketplace + trust)
- Voice channels work reliably for groups of 10+.
- Verified and Community marketplace tiers are live with real third-party plugins.
- Tailscale Funnel ships as a second tunnel provider.
- Emergency revocation push channel is live and gates the public directory opening.

### Phase 3+ success (broader audience)
- Non-technical users can create a server (managed hosting or simplified local setup).
- Regulated-industry pilots are running with compliance documentation.
- Plugin Studio ships, accelerating the developer ecosystem.

---

## Future Refinements

### Marketing and positioning strategy
- **What changes:** A formal go-to-market document that maps the use case tiers (early traction / long-term value / handle carefully) to specific channels, messaging, and timing.
- **Why not now:** Phase 1 marketing is simple: post in homelab and gaming forums. A formal GTM strategy is premature before the product exists.
- **What today's code must not do:** The product must not use language in its UI, error messages, or onboarding that assumes a specific use case. "Create a server" is neutral. "Create a gaming server" is not. Keep the interface use-case-agnostic so it fits all audiences without rewrites.

### Competitive positioning document
- **What changes:** A clear, updated document that maps UnCorded's strengths against Discord, Slack, Mattermost, Matrix, and self-hosted alternatives.
- **Why not now:** The product must exist before it can be compared. Positioning against competitors before Phase 1 ships is guessing.
- **What today's code must not do:** Nothing — this is a marketing concern, not a code concern. But worth noting: the architecture should never make a decision solely to match a competitor's feature. The wedge use cases are the north star, not feature parity.
