# Phase 01 — Current State (Partial)

> **Scope:** build & update surfaces only. Full runtime inventory is a later Stage 1 deliverable. This file is a **factual snapshot** of what exists in code today, written 2026-05-07.

---

## Build pipeline today

### `bun run docker:rebuild-runtime`
Source: `platform/scripts/rebuild-runtime-image.ts`

Flow:
1. `docker build -t uncorded-runtime:latest -f docker/Dockerfile .` with `LIVEKIT_SHA256_AMD64` and `LIVEKIT_SHA256_ARM64` build-args (mandatory; build refuses without them).
2. Reads `~/.uncorded/registry.json`. For each entry, `docker rm -f <containerId>`.
3. Operator relaunches desktop → `restoreServerContainers` (`platform/apps/desktop/src/main.ts:562`) recreates containers on the new image with fresh tunnel tokens from Electron `safeStorage`.

This is a **dev convenience**, not a release flow. No tag other than `:latest`. No registry push. No version metadata baked in.

### `platform/docker/Dockerfile.patch`
A parallel "fast incremental rebuild" Dockerfile that does `FROM uncorded-runtime:latest` and COPYs three specific source files (`runtime/src/main.ts`, `runtime/src/ws/router.ts`, `packages/protocol/src/index.ts`, plus three text-channels files) into the existing image. Drift-prone — any new runtime file added without updating this list goes stale. Dev-only.

### `platform/.github/workflows/release.yml`
**Desktop only.** Builds the Electron installer matrix (ubuntu + windows) and uploads as DRAFT to `UnCorded/releases` (separate repo) via `RELEASES_PAT`. Manual promote-to-published gate before `electron-updater` clients see the release. Matches the `reference_release_pipeline` memory.

There is **no runtime-image equivalent** of this workflow. Phase 01 Stage 4 invents it.

---

## Container shape (`platform/docker/Dockerfile`)

- Base: `oven/bun:1.3` (debian-slim).
- Multi-stage: separate stages download cloudflared (`v2025.2.0`), tini (`v0.19.0`), and LiveKit (`v1.11.0`, sha256-verified) into a tini/cloudflared/livekit-bin layout.
- Final image runs as UID 1001, with `/sbin/tini --` as PID 1 and `entrypoint.sh` as the wrapper.
- Volume mount targets created in image: `/plugins`, `/data`, `/config`, `/config/voice`, `/run/tunnel` (tmpfs).
- HEALTHCHECK runs `bun -e fetch /health` from inside the container. **Comment lines 138–148 of the Dockerfile claim /health requires ≥1 plugin ready — that comment is stale; the actual handler does not check plugins (see Findings F3 below).**

## Compose shape (`platform/docker/docker-compose.yml`)

Locked-down posture:
- `cap_drop: ALL`
- `security_opt: no-new-privileges:true`
- `read_only: true` rootfs
- `tmpfs: /tmp`
- `restart: unless-stopped`
- Three named volumes: `uncorded-plugins`, `uncorded-data`, `uncorded-config`.

Compose users do **not** get an authenticated cloudflare tunnel out of the box — entrypoint reads stdin for 5s and falls back to local mode if no token arrives. The desktop is the only path that supplies real tunnel credentials today.

## Entrypoint (`platform/runtime/src/entrypoint.ts`)

- **L60–67** — `RUNTIME_ENCRYPTION_SECRET` precondition: ≥32 chars or `process.exit(1)` at boot. Currently the operator-facing message says "generate with `openssl rand -hex 32`."
- **L90–124** — On first boot (no `/config/server.json`), seeds a default config with `installed_plugins: ["text-channels"]` (not empty). Also unconditionally creates `/data/plugins/text-channels/`.
- **L427–461** — Process-level `unhandledRejection` and `uncaughtException` handlers call the `runtimeShutdown` returned by `boot()` before exiting. Graceful-shutdown plumbing exists; we have not yet verified it actually drains WS clients.
- **L493** — `runtimeVersion: "1.0.0"` is **hardcoded**. This string is what propagates to /health and heartbeat. Not derived from the image build.
- **L498–505** — On `serverDeleted` from Central, runtime calls `process.exit(42)`. Distinct exit code so operators / desktop can distinguish from a crash.

## /health handler (`platform/runtime/src/http/handler.ts:380-399`)

```ts
function handleHealth(_req, _params, deps) {
  const uptimeSeconds = Math.floor((Date.now() - deps.config.startedAt) / 1000);
  const keysStale = deps.areKeysStale();
  const body = {
    status: keysStale ? "degraded" : "ok",
    plugins: deps.pluginRegistry.getPluginCount(),
    uptime: uptimeSeconds,
    ...(keysStale && { reason: "public-key cache stale" }),
  };
  return Response.json(body, { status: keysStale ? 503 : 200 });
}
```

Gates **only** on Central public-key cache freshness. Zero plugins is fine — `plugins: 0` returns 200. There is no `/ready` endpoint distinct from `/health`.

## Volumes / state contract today

- `uncorded-plugins` → `/plugins` (UID 1001 owned). Currently used by core plugins only.
- `uncorded-data` → `/data` (UID 1001 owned). Per-plugin SQLite DBs live under `/data/plugins/<slug>/`.
- `uncorded-config` → `/config` (UID 1001 owned). Holds `server.json`, voice config, etc.
- `/run/tunnel` is tmpfs — token never on disk.
- `RUNTIME_ENCRYPTION_SECRET` is currently env-only; not persisted anywhere.

Volumes survive `docker rm -f`. **State persistence across update is already structurally there — the work is contract documentation, not plumbing.**

---

## Findings — things that change Phase 01 plan

### F1 · No operator-facing update flow exists today
The existing `docker:rebuild-runtime` is a developer flow. Phase 01 invents the operator update flow from scratch. This is greenfield, not refactor.

### F2 · Image is unversioned
Only `:latest`. Stage 4 must introduce versioned tags (e.g. `uncorded-runtime:0.3.1`) plus a `:previous` rollback tag. Without versioned tags, "what version is running" and "rollback to v0.3.1" have no meaning.

### F3 · `runtimeVersion` is hardcoded at `entrypoint.ts:493`
String literal `"1.0.0"`. Stage 3 hygiene must source this from the image build: build-arg → ENV → `process.env.RUNTIME_VERSION` → boot reads it. Without this, every "version surfaced in /health and admin UI" claim is fiction.

### F4 · Stale comment in Dockerfile HEALTHCHECK
`docker/Dockerfile:138-148` claims `/health` requires ≥1 plugin ready. Code does not. Cosmetic but symbolic — exactly the kind of drift this push is cleaning up.

### F5 · Zero-plugin boot path may be unexercised
`entrypoint.ts:96` seeds `installed_plugins: ["text-channels"]` on first boot. `entrypoint.ts:94` unconditionally `mkdirSync`s `/data/plugins/text-channels`. The "truly empty installed_plugins" path is theoretically supported but probably never run. Stage 1 must verify with an actual zero-plugin boot.

### F6 · The container cannot update itself
Update orchestration **must** live in the host. The runtime has no docker socket and no permission to swap its own image. This forces a decision (see new open item O8).

### F7 · `RUNTIME_ENCRYPTION_SECRET` first-boot UX is sharp
The container exits at boot if missing. Desktop currently sets it from somewhere — needs verification. Compose operators have to set it manually. Production-grade target: auto-generate on first boot if absent and persist to `/config/secret` at mode 0600, owned by 1001.

### F8 · State persistence infrastructure already in place
Volumes survive container removal. The Phase 01 work for "no data loss across update" is **documentation of the contract** plus a backup hook before the swap, not new persistence plumbing.

### F9 · `docker/Dockerfile.patch` is cruft
Drift-prone parallel Dockerfile that lists specific files. Stage 3 should delete it; full rebuilds with layer caching are fast enough.

### F10 · Dual start paths = dual update paths
- Desktop-orchestrated (Electron + safeStorage tunnel tokens + Docker SDK)
- Compose-orchestrated (raw `docker compose up`, no desktop)

The two have different update orchestration stories. Phase 01 must pick which it supports for the polished UX (see O8).
