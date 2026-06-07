# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

UnCorded is a self-hosted collaborative platform where users run Docker containers on their own hardware. Every feature (chat, voice, dashboards, game integrations) is a plugin. UnCorded Central provides identity, a server directory, and a plugin marketplace — it never touches user content.

**Mental model:** Steam + Rust. Central verifies identity and lists servers. Server owners run containers and install plugins. Users have one account and join anywhere.

**Phase 1 audience:** Homelab builders and gaming communities.

## Commands

```bash
bun typecheck        # TypeScript strict checking (no emit)
bun test             # Bun's native test runner
bun run test:integration  # text-channels full-loop integration test
bun run test:central # Central API full lifecycle; requires local Postgres on :5432 (postgres/postgres)
bun lint             # Oxlint (Rust-based linter)
```

**Dev workflow (local):**
```bash
# Terminal 1 — Central API (port 4000)
cd apps/central && bun dev

# Terminal 2 — Web dev server (port 5174, proxies /v1 → localhost:4000)
cd apps/website && bun dev

# Terminal 3 — Electron desktop (loads web from localhost:5174 in dev)
cd apps/desktop && npm run dev:watch

# Terminal 4 — Cloudflare Tunnel (exposes Central publicly)
cloudflared tunnel run uncorded-central
```

**Networking:**
- Central API: `localhost:4000` locally, `central.uncorded.app` publicly (via Cloudflare Tunnel)
- Web dev: `localhost:5174` — Vite proxy forwards `/v1` and `/health` to `localhost:4000`
- R2 assets: `assets.uncorded.app` (Cloudflare R2, bucket: `uncorded-central`)
- To point web at prod Central instead: `VITE_CENTRAL_URL=https://central.uncorded.app bun dev`
- Cloudflare Tunnel config: `~/.cloudflared/config.yml` (tunnel ID: `a1bdfc80-a021-4ffd-9f4b-0543fb10ff56`)

## Monorepo Structure

Bun workspaces with `packages/*` and `apps/*`.

**Packages (shared libraries):**
- `@uncorded/shared` — common types and utilities
- `@uncorded/protocol` — MessagePack wire protocol, JWT token format, WebSocket frame schemas
- `@uncorded/plugin-sdk` — plugin developer SDK (publishable to npm)

**Apps:**
- `apps/central/` — UnCorded Central (Bun backend, PostgreSQL)
- `apps/website/` — web client (SolidJS + Tailwind v4, rebuilt — active frontend)
- `apps/desktop/` — desktop client (Electron)

**Other:**
- `runtime/src/` — server container Bun runtime (plugin loader, IPC, event bus)
- `plugins/` — core plugins: `text-channels/`, `members/`, `moderation/`
- `docker/` — container build config
- `scripts/` — build and deployment scripts

## Architecture Vault

`.claude/docs/Overview/` contains 21 specification documents — the single source of truth for all design decisions. Start with `README.md` → `Overview.md` → `spec-01-vision-and-wedge.md` → `spec-02-system-overview.md`, then jump to the relevant subsystem file.

When a locked decision in `Overview.md` conflicts with a detailed file, the Overview wins.

## Three-Component Architecture

1. **Central (cloud):** Auth (email + Google OAuth), server directory, plugin marketplace, heartbeat monitoring. Issues Ed25519-signed JWTs. Never touches user content.
2. **Server container (user's hardware):** Single Docker container running Bun. Hosts plugin subprocesses via stdio JSON IPC. Per-plugin SQLite (WAL mode). Cloudflare tunnel for public access.
3. **Client apps (user's device):** SolidJS web app, Electron desktop. Plugin UIs rendered in sandboxed iframes with origin-verified postMessage auth.

## Key Technical Decisions

- **Runtime:** Bun (with 72-hour tripwire fallback to Node.js if blocking issues found)
- **Wire format:** MessagePack on WebSocket, JSON on IPC (stdio) and low-frequency paths (Central API, heartbeat)
- **Plugin isolation:** Each plugin runs as a subprocess with its own SQLite database. Cross-plugin writes are forbidden; cross-plugin reads require declared capabilities in the manifest.
- **Auth tokens:** Ed25519-signed JWTs. Web stores in `__Host-`-prefixed HTTP-only cookies. Servers validate against Central's cached public keys.
- **Rate limiting:** Every endpoint, shipped in Phase 1 (not deferred polish).
- **Event bus:** At-least-once delivery, per-(topic, subscriber) FIFO ordering, `mark_unhealthy` as default backpressure (failures are loud).

## TypeScript Configuration

- Target: ESNext, module resolution: bundler
- Strict mode with `noUncheckedIndexedAccess`, `noImplicitOverride`, `exactOptionalPropertyTypes`
- `verbatimModuleSyntax` and `isolatedModules` enabled
- Path aliases: `@uncorded/shared`, `@uncorded/protocol`, `@uncorded/plugin-sdk`

## Conventions

- **No `any` type** — strict TypeScript enforced
- **Typed errors** with code, message, context — not raw Error instances
- **Structured logging** — JSON with timestamps, levels, plugin slugs, request IDs
- **Capability checking** — every IPC call validated against manifest permissions; undeclared = hard reject
- **Tests are mandatory** — unit, integration, E2E; failing tests block merge
- **Security is not optional** — design auth flows before implementing; fail closed

## IPC Note

Plugin IPC uses stdio (JSON over stdin/stdout). This works cross-platform with no
OS-specific abstractions needed. stdin is owned by the IPC transport — plugins must
not read stdin for other purposes. stdout lines prefixed with `IPC:` are IPC
responses; unprefixed stdout and stderr are captured by the runtime log collector.
(The interactive-terminal `terminals.*` IPC frame family was removed in commit `95dec38`
along with the rest of the Terminal Anywhere vertical; there is no interactive terminal
surface in V1.)

## Session Discipline

- Nothing moves forward until `bun test` passes clean
- Nothing moves forward until `bun typecheck` passes clean
- Every bug fix adds a regression test before the PR is mergeable
- If a decision contradicts the vault, fix the vault first, then the code
- Prefer extending existing mechanisms over adding parallel ones
- When in doubt, check `spec-15-engineering-principles.md`

## Load Order for New Sessions

When starting a new implementation session, read these in order:
1. `CLAUDE.md` (this file)
2. `Overview.md` (locked decisions)
3. The specific subsystem file(s) relevant to today's work

Do not read all 21 vault files on every session. Load what's relevant.
