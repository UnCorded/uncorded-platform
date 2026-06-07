# Phase 01 — Decisions

Running log. Resolved decisions stay; open ones move to **Resolved** with date and rationale once locked.

---

## Resolved

### D1 · prod-docs folder structure (2026-05-07)
Each phase gets its own folder under `platform/.claude/docs/prod-docs/phase-NN/`. Folders are self-contained — a fresh session should be able to orient by reading the folder alone. Over time, prod-docs absorbs or supersedes the older `Overview/spec-*.md` documents; until then, older specs remain authoritative for areas not yet covered by a prod-docs phase folder.

### D2 · Engagement mode for the production push (2026-05-07)
Partner mode, not order-taker mode. Recorded in memory as `feedback_production_partnership.md`. Production-grade is a hard constraint; Claude is expected to surface operator/end-user concerns proactively, not wait for them to be listed.

### O1 · Update mechanism (resolved 2026-05-07)
**Docker container-swap is the only first-class supported update path in v1. In-place binary update is not supported.**

Atomic install + atomic rollback (keep prior image tagged `:previous`). State dir is just a mounted volume — well-understood semantics. Matches the existing build flow. Supporting in-place too would double the test matrix and require a self-updater that has to handle file permissions, partial downloads, and live process replacement — none of it on the critical path to shelf-ready. Self-hosters who refuse Docker can still run the same image under Podman or build from source; we don't owe them a bespoke updater.

### O2 · Update channels (resolved 2026-05-07)
**Ship with channels in v1. Defaults to `stable`. Owners can switch per server (stable / beta / dev) from Danger Zone.**

Cheap to add now, expensive to retrofit because it changes the update-check API shape. Lets us release to brave self-hosters without affecting everyone.

### O3 · Backup-before-update default (resolved 2026-05-07)
**Default ON, owner can disable per-server in Danger Zone.** Backup is a snapshot of the state dir written next to it. Restored automatically on rollback.

Phase 01 state is minimal, but this is the contract Phase 02 plugins inherit. Default-on now means plugins can rely on it forever. Cost is added update duration — acceptable.

### O5 · First-update dry-run (resolved 2026-05-07)
**Out of Phase 01.** Nice-to-have; cut from v1 to keep scope tight. Revisit when plugin updates are a second use case in Phase 02+.

### O6 · Telemetry (resolved 2026-05-07)
**Reserve schema fields now for anonymized version + uptime + crash report. Do not implement collection in Phase 01.** Implementation is a later phase, opt-in only.

Lets v2 ship telemetry without a breaking change to the heartbeat/update-check shape.

### O7 · Owner gate strength on update (resolved 2026-05-07)
**Typed confirmation ("type the server name") + owner check. No re-auth.**

Action is reversible (rollback exists), owner-gated, audit-logged. Re-auth is friction without proportional safety gain — a compromised owner laptop bypasses re-auth too. Typed confirmation is enough to defeat accidental clicks.

### O8 · Which start paths support owner-driven update in v1 (resolved 2026-05-07)
**Desktop is the only first-class orchestrator in Phase 01, but the runtime treats orchestrator identity abstractly.** Compose self-hosters get a documented manual flow (`docker compose pull && docker compose up -d`) shown in the Danger Zone UX, plus a roadmap entry for sidecar-based or watchtower-style auto-update in a later phase.

The runtime cannot update itself (no docker socket, no permission to swap its own image — see `current-state.md` F6). Update orchestration lives in the host. Desktop already has the plumbing (`apps/desktop/src/main.ts:562 restoreServerContainers`); compose has no orchestrator. Inventing one in Phase 01 doubles the test surface. Compose users are operators who already run docker; a polished manual flow is acceptable for v1.

**Mechanics (locked together with D3, D4, D5):**
- The runtime is a **passive update-state store + broadcaster**. It exposes `POST /admin/api/update-state` (auth + role-gated) for the orchestrator to write state into, and broadcasts `update_state_changed` over WS to all connected clients on every transition.
- The orchestrator (desktop today) owns the lifecycle: pull, drain, swap, rollback, write state. It POSTs state transitions to the runtime; the runtime is dumb storage.
- All clients render the same pill/state from the broadcast — visibility is universal. The install button is conditionally rendered when the client detects it *is* the orchestrator AND the user has the role permission (see D4, D5).

### D3 · Orchestrator abstraction principle (2026-05-07)
**Runtime code must not hardcode "desktop = orchestrator." The orchestrator role is identified by capability, not identity.**

**Why:** The user is considering an UnCorded-hosted managed-server offering, where the "orchestrator" is hosted control-plane infrastructure rather than the user's desktop. Phase 01 ships desktop-only, but the contract has to keep the role swappable so a future hosted control plane can assume it without protocol surgery.

**How to apply:** The runtime's update-state API authenticates the orchestrator via the existing admin-token / owner-token mechanism, not via a hardcoded "is_desktop" flag. Client-side orchestrator detection (which decides whether to render the install button) reads from a capability advertised by the host environment — desktop sets it via IPC; hosted shell would set it via session context. Compose users have no orchestrator and therefore no install button — by design, not by special case.

### D4 · Update-state visibility model (2026-05-07)
**Visibility is universal; action is gated.** Every connected client sees the runtime's update state via WS broadcast (`update_state_changed`). The install action is rendered only when the client is the orchestrator AND the user has `core.runtime.update` (see D5).

**Why:** The user wants users on any client to know when their server is out of date — a self-hoster checking from the web should see the same pill as the operator on desktop. But the install action belongs only on the device that can actually perform the swap. Splitting visibility from action lets us keep the universal pill without exposing a button that would 403 for most clients.

**How to apply:** Pill component reads pure state from WS. Install button has two predicates: `clientIsOrchestrator` (set by host env) AND `hasPermission("core.runtime.update")`. Both must be true to render the action. Off-orchestrator clients see informational copy ("update available — install from <orchestrator location>"), with the copy varying for admins vs non-admins.

### D5 · Permission gate for runtime updates (2026-05-07)
**`core.runtime.update` at `defaultLevel: 80`** — owner + admin by default; mods/members blocked. Server owners can rebind via the existing roles engine if they want to widen or narrow it.

**Why:** Owner-only is too restrictive for healthy operations (admins are why the role exists). Member-accessible is unsafe (rollbacks exist, but a mid-day forced-update DOS is not a great failure mode). The roles engine already supports per-server overrides (`platform/runtime/src/roles/types.ts:111-116` defines owner=100, admin=80, moderator=60, member=10), so 80 is the natural cut.

**How to apply:** Add `core.runtime.update` to the runtime permission registry with `defaultLevel: 80`. The `POST /admin/api/update-state` endpoint enforces it server-side; the client-side install button hides on permission absence. Same pattern as existing admin-gated actions.

### D6 · Routing scope for Phase 01 (2026-05-07)
**Add exactly three routes, no broader URL-driven nav refactor:**
- `/servers/:serverId` — server home
- `/servers/:serverId/settings` — settings shell
- `/servers/:serverId/settings/:section` — section deep-link target (Danger Zone is `:section = danger`)

**Why:** Sidebar pill needs a deep-link target so click → settings/danger works regardless of where the user is. Broader URL coverage (per-channel routes, per-plugin admin routes) is a tempting scope expansion but unrelated to Phase 01 success criteria. The user explicitly noted "we don't have routes setup, we need to do this" — this is the minimum that unblocks the update UX.

**How to apply:** Stage 2.5 in `plan.md`. Existing in-app state (server selection, settings panel) remains the default UX; the new routes are additive entry points that hydrate the same in-app state. Don't refactor `App` to be route-driven — just teach it to honor URL params on mount and update URL on relevant nav.

---

## Open

_(none open)_

---

## Resolved (continued)

### O4 · Signing pipeline (resolved 2026-05-09)

Four sub-decisions, all locked together so Stage 4 can proceed without intra-stage churn:

**O4.1 · Registry: GHCR (`ghcr.io/uncorded/runtime`).**
GitHub Actions' built-in `GITHUB_TOKEN` has push access to GHCR with no extra secret, package permissions are configured per-repo (so the platform repo can push to `ghcr.io/uncorded/runtime` directly), and anonymous public pulls have no Docker-Hub-style per-IP rate limit. Self-hosters `docker pull ghcr.io/uncorded/runtime:0.1.0` with no auth. Org-level "Improved Container Support" must be enabled (one-time user action, see `reference_release_pipeline.md`).

**O4.2 · Signing scheme: cosign + long-lived Ed25519 key in Bitwarden.**
One keypair, generated once via `cosign generate-key-pair`. Private half stored in Bitwarden under `uncorded/runtime/COSIGN_PRIVATE_KEY` + `uncorded/runtime/COSIGN_PASSWORD`, mirrored to GitHub Actions secrets of the same names. Public half embedded in the runtime + desktop. Matches the existing "all secrets in Bitwarden" pattern (per `feedback_db_password_drift` and 2026-04-30 secret-rotation audit). Rejected keyless/Fulcio because (a) verification needs Rekor reachability at boot — bad fit for self-hosted runtimes that may have constrained egress, (b) revocation/key-loss recovery is more abstract than rotating a Bitwarden secret, (c) no operator familiarity with OIDC-bound trust policies. Trade-off accepted: long-lived key means rotation is a documented procedure (in the runbook), not zero-effort.

**O4.3 · Public key shipping: TS constant in `runtime/src/signing/cosign-pubkey.ts`.**
Hardcoded PEM string exported from a tiny module. Version-controlled so rotation is a reviewed PR, easy to grep/audit, no Dockerfile path to maintain. Same pattern as Central's seeded public keys. Rejected file-in-image (`/etc/uncorded/cosign.pub`) because the rotation procedure is identical (rebuild + retag) and the file route adds Dockerfile surface for no real win.

**O4.4 · Version source: `workflow_dispatch` input + git tag.**
`release-runtime.yml` takes `version` as a required input (e.g. `0.1.0`). CI passes it as both the `RUNTIME_VERSION` Dockerfile build-arg and the image tag (`ghcr.io/uncorded/runtime:0.1.0` + `:latest`). Tag created on the platform repo at publish time, matching desktop's "bump-then-dispatch" shape. Rejected `runtime/VERSION` file because it adds a tracked file for a single string and creates a confusing dual source-of-truth with the workflow input.

**Why all four together:** the registry choice constrains the signing tooling (cosign supports both, but GHCR-native works seamlessly with cosign); the signing scheme constrains the pubkey shape (PEM string vs Fulcio cert chain); the pubkey shipping constrains the runtime verify code; the version source ties the image tag back to the build-arg. Locking them as a quadruple keeps the Stage 4 PR scope contained.

### D7 · Stage 5 backup mechanism: host-bind copy, not alpine sidecar (2026-05-09)

`runtime-lifecycle.md` §7.3 sketched the backup as `docker run --rm alpine cp -a /src /dst`. Desktop diverges: every per-server volume is already a host bind mount (`server-runtime.ts:121-130` mounts `<volumePath>/{data,config,plugins}` directly, not docker volumes), so `runtime-backup.ts` does the snapshot via `node:fs/promises` instead. Same atomicity (rename-from-`.partial`) and same on-disk layout (`<volumePath>/config/backups/<ISO>-pre-update/{data,config}`) — just no sidecar to spawn.

**Why:** The alpine sketch was for the docker-volumes case (mobile / hosted control planes that don't have host paths). Forcing desktop to also spawn a sidecar would mean an extra image dependency, an extra docker invocation per update, and platform-specific UID/GID quirks for no benefit. Mobile / hosted streams keep the sidecar option open — the runtime never observes which path the orchestrator took.

**How to apply:** future control-plane orchestrators reuse `runtime-update.ts`'s `RuntimeUpdateIo.createBackup` seam and supply their own backup implementation (e.g. an alpine-helper exec). The state machine doesn't change.
