---
vision: "Central knows nothing beyond 'this server exists at this URL'"
tenet: "All tenets originate here"
depends-on: []
last-verified: 2026-04-05
---

# UnCorded — Architecture Vault

> **UnCorded Central can hand over "this server exists at this URL" and nothing else — because that's all it knows.**

This folder is the **single source of truth** for UnCorded's architecture. Every design decision, every tradeoff, every future refinement lives here.

---

## What UnCorded Is (60-second version)

UnCorded is a collaborative-first platform where users host their own servers as Docker containers on their own hardware. Every feature — chat, voice, galleries, dashboards, game integrations — is a plugin. UnCorded Central provides identity, a server directory, and a plugin marketplace. Central never touches user content.

**Mental model:** Steam + Rust. Central verifies identity and lists servers. Server owners run containers, install plugins, set rules. Users have one account and join anywhere.

**Phase 1 audience:** homelab builders and gaming communities. They already run Docker, find bugs constructively, and will build the plugin ecosystem.

---

## How to Use This Vault

**New to the project?**
Read in order: `Overview.md` → `01` → `02` → then whichever subsystem you're building.

**Building a specific subsystem?**
Jump to the relevant file. Each one is self-contained — the frontmatter shows what tenet it serves and what files it relates to.

**Making a design decision?**
Check `Overview.md` for locked decisions. Check the relevant subsystem file for detail. Check `01` for the wedge use cases to test your decision against.

**Looking for open questions?**
`status-open-questions.md` collects every `[TBD-*]` item with severity and context.

---

## Quick Reference

| I need to know... | Read this |
|---|---|
| What UnCorded is and who it's for | `spec-01-vision-and-wedge.md` |
| How the three components relate | `spec-02-system-overview.md` |
| What's inside the Docker container | `spec-03-server-container.md` |
| How plugins work | `spec-04-plugin-architecture.md` |
| How plugin data and cross-plugin reads work | `spec-05-plugin-data-model.md` |
| How auth, tokens, roles, and the admin panel work | `spec-06-authentication.md` |
| User profiles, presence, and workspace persistence | `spec-22-core-module.md` |
| Terminal Anywhere (**removed** in `95dec38` — historical design spec only) | `spec-25-registered-terminals.md` |
| What's decided vs what's still open | `Overview.md` (locked decisions) + `status-open-questions.md` |
| The full file map with descriptions | `ROUTING.md` |

---

## Rules for This Vault

1. **Every file has frontmatter** — vision, tenet, dependencies, last-verified date. No exceptions.
2. **Every file has a Future Refinements section** — what changes later, why not now, what today's code must not do.
3. **Files are self-contained.** A reader can open any file and understand it without reading the others. Frontmatter dependencies are context, not prerequisites.
4. **The Overview is the anchor.** When a locked decision in the Overview conflicts with a detailed file, the detailed file is wrong. Fix the detailed file.
5. **No decision without reasoning.** Every "we chose X" has a "because Y" attached. Future readers need the why, not just the what.
6. **Failures are loud by default.** This applies to docs too — if something is unclear, missing, or contradictory, that's a bug in the vault, not a reader problem.
