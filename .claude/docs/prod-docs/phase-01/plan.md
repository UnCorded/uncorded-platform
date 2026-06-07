# Phase 01 — Plan

## Stages

Stages are ordered. Each stage has an explicit deliverable so we know when it's done.

### Stage 1 — Audit & inventory
**Deliverable:** `current-state.md` written.

Read the runtime entry path, document what exists today at file:line precision: how it boots, what it does on shutdown, what state it persists, what happens with zero plugins, what the release pipeline currently produces, and what's missing for Phase 01 success criteria. **No code changes.**

### Stage 2 — Spec lock
**Deliverable:** `runtime-lifecycle.md`, `update-ux.md`, all `decisions.md` open items resolved.

Finalize the technical contract (boot, shutdown, update, rollback, state dir, signing) and the operator-facing UX (Danger Zone screens, copy, gates, error states). Decisions sign-off happens here. **No code changes.**

### Stage 2.5 — Routing scaffolding
**Deliverable:** Three new SolidJS routes wired into `apps/website`, exercising the existing in-app state model.

Per D6, add:
- `/servers/:serverId` — server home (resolves serverId → selects in-app)
- `/servers/:serverId/settings` — settings shell (selects server + opens settings)
- `/servers/:serverId/settings/:section` — deep-link to a settings section (`danger` is the Phase 01 target)

Constraints:
- Additive only. App's existing in-app navigation continues to work; routes are entry points, not the new source of truth.
- On mount, routes hydrate in-app state (`useNavigate` + `useParams` → existing server-selection / settings-open setters).
- On relevant in-app nav (open settings, switch server) the URL is kept in sync with `navigate(..., { replace: true })`.
- Unknown serverId falls back to the no-server state with a toast. Unknown section falls back to settings root.

This stage exists separately so the routing change is reviewable on its own and lands before any UX referencing those URLs.

### Stage 3 — Runtime hygiene
**Deliverable:** Code in `platform/runtime/` that — independent of update flow — is shelf-quality.

- Boot path cleanup; meaningful empty state on zero plugins
- Structured logs with levels, secret redaction, request correlation IDs
- `/health` (liveness) and `/ready` (post-startup) split
- Version surfaced in `/health`, in admin UI, and in logs
- Graceful shutdown: drain WS with notice, flush state, exit clean
- env var validation on boot with actionable errors

### Stage 4 — Release pipeline & signing
**Deliverable:** CI publishes signed runtime images; runtime verifies signature on update.

Cross-check against `reference_release_pipeline.md` (memory) and the vault release-pipeline doc. Add signing step if missing; ship public key with runtime.

### Stage 5 — Update mechanism
**Deliverable:** Runtime can be updated end-to-end via the documented mechanism, state preserved, rollback works.

- State directory contract (what survives, where it lives, how plugins will share it later)
- Drain orchestrator (WS notice → close → flush)
- Container-swap orchestration (assumes O1 resolved as Docker-only)
- Rollback path: prior image retained as `:previous`; auto-restore on health check failure
- Backup-before-update (per O3)

### Stage 6 — Update UX
**Deliverable:** Server Settings → Danger Zone → Runtime panel, fully functional.

- Current version, latest available, release notes link
- Pre-flight: connected user count, disk space, compatibility
- Owner-only gate (re-auth or typed confirmation)
- During-update client toast
- Post-update success state + audit entry
- Failure path UI: clear error, rollback indicator, link to logs

### Stage 7 — End-to-end test
**Deliverable:** Documented test passes; phase closes.

Install v0.x.0 → run → publish v0.x.1 → owner triggers update from UI → runtime drains → swaps → boots → owner sees success state. Repeat with intentional failure (e.g. bad image) → verify rollback. **No data loss between versions** (in Phase 01 there's not much state, but the plumbing is what we're proving).

## Ordering rationale

- Stages 1–2 finish all design before any code is written. This honors "Plan Verification" — user reviews specs at file:line before code happens.
- Stage 2.5 (routing) is the only code stage allowed to land before Stage 3 because it's a pre-req the update UX deep-links into; keeping it isolated makes it independently reviewable.
- Stage 3 is foundation; 4–6 depend on it (signing needs version surfacing, update UX needs `/ready`, etc.).
- Stage 7 closes the loop — without it, Phase 01 is "code that probably works", not "shelf-ready."

## Checkpoints

After each stage, briefly check in: did we deliver the stated deliverable? Any open questions for the next stage? Update `decisions.md` if anything was decided in flight.
