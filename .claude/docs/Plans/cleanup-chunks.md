---
plan: cleanup-chunks
created: 2026-05-07
status: proposed
---

# Plan — Branch Cleanup, Audit, and Commit

> **HISTORICAL (superseded).** This 2026-05-07 plan describes a one-time cleanup of the
> **frozen source platform** (paths under `…\projects\uncorded\platform\…`), not this repo;
> it is kept for provenance only. Two of its chunks describe features since **removed** as
> scope reductions: **C9–C12 (Terminal Anywhere / CLI pairing / `apps/cli`)** removed in
> commit `95dec38`, and the **adblock** half of **C15** removed in commit `b00667c`. Do not
> treat those chunks as pending work. (The browser-panel half of C15 stays — user-owned
> browser panels are retained.)

The `main` branch has 111 modified files (+9,436 / −1,774) and 190 untracked files in addition to one unpushed commit (`8ab274c`). This plan turns that into ~14 reviewable, dependency-ordered commits, each gated on `bun typecheck` and `bun test`.

**Goal of this branch cleanup:** zero dirty files, every line on `main` either justified by a spec/plan or deleted, ready for the Phase 01 production-readiness work to begin from a clean base.

---

## Pre-flight decisions (resolved 2026-05-07)

| ID | Question | Decision |
|---|---|---|
| P1 | Worktrees `S1-plugin-data-dir` and `S4-admin-framing` — keep or toss? | **Delete both.** Confirmed byte-identical scaffolds with stale configs (reference `apps/web` which no longer exists) and empty `runtime/` dirs. Nothing unique inside. |
| P2 | Push cadence | **Push only at the end.** One CI run, one review window. |
| P3 | Lint gating per chunk | **Add `bun lint` per chunk** in addition to typecheck + test. |
| P4 | Pre-existing failing tests | **Fix them inside their owning chunk.** If a failing test lives in code C5 touches, fix in C5. |

---

## Cross-chunk gates (apply to every commit)

1. `bun typecheck` clean (project-wide)
2. `bun test` clean for files touched by the chunk
3. No new `any`, no stray `console.log`, no orphan TODO without an issue link
4. Every new public function has at least one test in the same chunk
5. Commit message references the spec/plan (`spec-XX`, `plan-…`, or `prod-docs/phase-01/…`)
6. Co-author trailer: `Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>`

---

## Chunk order (dependency-respecting)

Each chunk lists: **scope sentence**, **files**, **audit focus**, **acceptance**.

### C0 — Triage / garbage (no code, fastest)

**Scope:** Remove obviously-broken artifacts before any audit.

**Delete (untracked):**
- `C:\Users\jusss\projects\uncorded\platform\C\357\200\272Usersjusss.claudeprojectsC--Users-jusss-projects-uncordedfull-test.log`
- `C:\Users\jusss\projects\uncorded\platform\C\357\200\272UsersjusssAppDataLocalTempbun-full-test.log`
- `C:\Users\jusss\projects\uncorded\platform\C\357\200\272Usersjussstest-out.txt`

These are mangled Windows paths captured as filenames from past `bun test > C:\…` redirects. They contain no source code. Use `git clean -f` only against this exact list (no wildcards).

**Delete (parent-level, not in repo):**
- `C:\Users\jusss\projects\uncorded\worktrees\S1-plugin-data-dir\` (whole tree)
- `C:\Users\jusss\projects\uncorded\worktrees\S4-admin-framing\` (whole tree)

These are abandoned subagent scaffolds with three obsolete config files and empty `runtime/` dirs. Confirmed byte-identical to each other; configs reference `apps/web` (no longer exists).

**Acceptance:** `git status` no longer shows the three log files; `C:\Users\jusss\projects\uncorded\worktrees\` is empty.

---

### C1 — Vault spec additions + amendments (docs only, unblocks everything)

**Scope:** Land the three new contract docs and the amendments to existing specs that the in-flight code depends on. Pure documentation; no code.

**Untracked:**
- `C:\Users\jusss\projects\uncorded\platform\.claude\docs\Overview\pr-6-screen-share-contract.md`
- `C:\Users\jusss\projects\uncorded\platform\.claude\docs\Overview\pr-VR-voice-reachability.md`
- `C:\Users\jusss\projects\uncorded\platform\.claude\docs\Overview\spec-25-registered-terminals.md`

**Modified:**
- `C:\Users\jusss\projects\uncorded\platform\.claude\docs\Overview\README.md`
- `C:\Users\jusss\projects\uncorded\platform\.claude\docs\Overview\ROUTING.md`
- `C:\Users\jusss\projects\uncorded\platform\.claude\docs\Overview\spec-04-plugin-architecture.md`
- `C:\Users\jusss\projects\uncorded\platform\.claude\docs\Overview\spec-22-core-module.md`
- `C:\Users\jusss\projects\uncorded\platform\.claude\docs\Overview\spec-24-voice.md`

**Audit focus:**
- Cross-reference each new spec against memory: `feedback_vault_amendment_letters` (sequential letters), `feedback_verify_field_names_against_code` (field names match canonical TS).
- Diff `spec-22-core-module.md` against `plan-permissions-ui.md` Decision Log to confirm Amendments A/B match what the plan says they say.
- Diff `spec-24-voice.md` against `pr-VR-voice-reachability.md` to confirm voice spec references the addendum, not duplicates it.
- `README.md` and `ROUTING.md` should table-of-contents the new specs.

**Acceptance:** Vault renders coherent end-to-end; no orphan amendment letters; no contract-vs-spec drift visible from a fresh read.

---

### C2 — Production Phase 01 docs (docs only, scope-locks the future)

**Scope:** Land the prod-docs folder that defines the production-readiness pass.

**Untracked:**
- `C:\Users\jusss\projects\uncorded\platform\.claude\docs\prod-docs\phase-01\README.md`
- `C:\Users\jusss\projects\uncorded\platform\.claude\docs\prod-docs\phase-01\current-state.md`
- `C:\Users\jusss\projects\uncorded\platform\.claude\docs\prod-docs\phase-01\decisions.md`
- `C:\Users\jusss\projects\uncorded\platform\.claude\docs\prod-docs\phase-01\plan.md`
- `C:\Users\jusss\projects\uncorded\platform\.claude\docs\prod-docs\phase-01\runtime-lifecycle.md`
- `C:\Users\jusss\projects\uncorded\platform\.claude\docs\prod-docs\phase-01\update-ux.md`

**Audit focus:**
- Read all six top-to-bottom and confirm they tell a coherent story.
- `decisions.md` should have no "TBD" without an owner + date.
- `current-state.md` claims must be true — pick three file:line citations and verify.
- `plan.md` stages 1–7 must be reachable from `update-ux.md` and `runtime-lifecycle.md`.

**Acceptance:** The folder is self-contained orientation as it claims; a fresh session could pick up Phase 01 work from these six files alone.

---

### C3 — Protocol package: crypto + IPC codec + core types (foundation)

**Scope:** Wire-format additions used by terminal-anywhere, CLI pairing, and any future end-to-end-encrypted plugin transport.

**Untracked:**
- `C:\Users\jusss\projects\uncorded\platform\packages\protocol\src\crypto\fingerprint.ts`
- `C:\Users\jusss\projects\uncorded\platform\packages\protocol\src\crypto\fingerprint.test.ts`
- `C:\Users\jusss\projects\uncorded\platform\packages\protocol\src\crypto\session-cipher.ts`
- `C:\Users\jusss\projects\uncorded\platform\packages\protocol\src\crypto\session-cipher.test.ts`
- `C:\Users\jusss\projects\uncorded\platform\packages\protocol\src\crypto\session-cipher.bench.ts`
- `C:\Users\jusss\projects\uncorded\platform\packages\protocol\src\crypto\adversarial.test.ts`
- `C:\Users\jusss\projects\uncorded\platform\packages\protocol\src\ipc-codec.ts`

**Modified:**
- `C:\Users\jusss\projects\uncorded\platform\packages\protocol\src\core.ts`
- `C:\Users\jusss\projects\uncorded\platform\packages\protocol\src\index.ts`
- `C:\Users\jusss\projects\uncorded\platform\packages\protocol-schemas\src\index.ts`
- `C:\Users\jusss\projects\uncorded\platform\packages\protocol-schemas\src\index.test.ts`

**Audit focus:**
- Adversarial test must cover: tampered ciphertext, replay, key-mismatch, fingerprint-collision attempts.
- Bench should set a perf budget the audit can re-run.
- `ipc-codec.ts` — confirm it's used by exactly one consumer; if zero, it's dead code; if many, document.
- No ad-hoc `crypto.subtle` calls outside this module after this chunk lands.

**Acceptance:** Protocol package builds standalone; adversarial test green; bench reports a number we record in the commit body.

---

### C4 — Runtime DB hardening (foundation for migrations 012/013)

**Scope:** The fail-fast `expected-tables` assertion called for in `plan-permissions-ui.md` decision Bz, plus its test scaffold.

**Untracked:**
- `C:\Users\jusss\projects\uncorded\platform\runtime\src\db\assert-tables.ts`
- `C:\Users\jusss\projects\uncorded\platform\runtime\src\db\assert-tables.test.ts`
- `C:\Users\jusss\projects\uncorded\platform\runtime\src\db\expected-tables.ts`

**Modified (just the lines that wire the assertion in):**
- `C:\Users\jusss\projects\uncorded\platform\runtime\src\main.ts` (call assert-tables after migrations; ~line 459 per the plan)

**Audit focus:**
- Assertion must run after migrations and before the runtime accepts traffic.
- `expected-tables.ts` must list all 13 migrations' final table set, not partial.
- Failure mode: process exits non-zero with a structured error.

**Acceptance:** Boot a runtime against an empty DB, assertion passes; rename a table in dev, assertion fails loudly with a useful message.

> The rest of `runtime/src/main.ts` modifications stay uncommitted; they fold into the chunks below.

---

### C5 — Permissions / roles backend (Amendment A finalization + Amendment B additions)

**Scope:** All runtime-side work for plan-permissions-ui PR-1 and PR-2 (backend tests, pagination, `grantMany`, broadcast cleanup). UI lands in C6.

**Untracked:**
- `C:\Users\jusss\projects\uncorded\platform\runtime\src\core\ipc.assert-grant-safe.test.ts`
- `C:\Users\jusss\projects\uncorded\platform\runtime\src\core\ipc.broadcast.test.ts`
- `C:\Users\jusss\projects\uncorded\platform\runtime\src\core\ipc.member-list-pagination.test.ts`
- `C:\Users\jusss\projects\uncorded\platform\runtime\src\core\ipc.member-list-perf.test.ts`
- `C:\Users\jusss\projects\uncorded\platform\runtime\src\core\ipc.member-role.test.ts`
- `C:\Users\jusss\projects\uncorded\platform\runtime\src\core\ipc.permissions-grant-many.test.ts`
- `C:\Users\jusss\projects\uncorded\platform\runtime\src\core\ipc.permissions-grant-many-perf.test.ts`
- `C:\Users\jusss\projects\uncorded\platform\runtime\src\core\ipc.permissions-integration.test.ts`
- `C:\Users\jusss\projects\uncorded\platform\runtime\src\core\ipc.permissions-manage-gating.test.ts`
- `C:\Users\jusss\projects\uncorded\platform\runtime\src\core\ipc.role-list.test.ts`
- `C:\Users\jusss\projects\uncorded\platform\runtime\src\core\ipc.self-demotion.test.ts`
- `C:\Users\jusss\projects\uncorded\platform\runtime\src\roles\engine.audit.test.ts`
- `C:\Users\jusss\projects\uncorded\platform\runtime\src\roles\engine.canActOn.test.ts`
- `C:\Users\jusss\projects\uncorded\platform\runtime\src\roles\engine.default-roles-overrides.test.ts`
- `C:\Users\jusss\projects\uncorded\platform\runtime\src\roles\engine.permission-changed.test.ts`

**Modified:**
- `C:\Users\jusss\projects\uncorded\platform\runtime\src\core\dao.ts`
- `C:\Users\jusss\projects\uncorded\platform\runtime\src\core\ipc.ts`
- `C:\Users\jusss\projects\uncorded\platform\runtime\src\core\ipc.test.ts`
- `C:\Users\jusss\projects\uncorded\platform\runtime\src\core\module.ts`
- `C:\Users\jusss\projects\uncorded\platform\runtime\src\core\permission-seeds.ts`
- `C:\Users\jusss\projects\uncorded\platform\runtime\src\roles\engine.ts`
- `C:\Users\jusss\projects\uncorded\platform\runtime\src\roles\engine.test.ts`

**Audit focus:**
- Self-demotion blocked end-to-end (Q1 in plan-permissions-ui).
- `core.member.list` pagination: limit ≤ 500, default 200, opaque cursor.
- `core.permissions.grantMany` is atomic — partial failure rolls back.
- `core.permission.changed` event payload is a discriminated union with all variants tested.
- `assertGrantSafe` rejects level-elevation attempts.

**Acceptance:** Every Amendment B backend commitment has a passing test; perf tests have recorded budgets in commit body.

---

### C6 — Permissions / administration UI (frontend half of plan-permissions-ui)

**Scope:** Member-manage sheet, administration tabs (Bans/Roles/Audit), permission matrix, optimistic UI, broadcast subscription.

**Untracked:**
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\components\server\administration\index.tsx`
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\components\server\administration\bans-tab.tsx`
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\components\server\administration\roles-tab.tsx`
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\components\server\administration\audit-tab.tsx`
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\components\server\administration\permission-matrix.tsx`
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\components\server\administration\role-edit-form.tsx`
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\components\server\administration\matrix-coordinator.ts`
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\components\server\administration\matrix-coordinator.test.ts`
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\components\server\administration\matrix-state.ts`
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\components\server\administration\matrix-state.test.ts`
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\components\server\administration\audit-csv.test.ts`
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\components\server\administration\permissions.race.test.ts`
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\components\server\administration\permissions.stale-event.test.ts`
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\components\server\member-manage-sheet.tsx`
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\hooks\has-permission-eval.ts`
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\hooks\has-permission-eval.test.ts`
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\hooks\use-has-permission.ts`
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\hooks\permissions.revoke.test.ts`
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\stores\permissions.ts`
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\stores\permissions.test.ts`
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\stores\member-manage.ts`
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\lib\core-client.ts`
- `C:\Users\jusss\projects\uncorded\platform\.claude\docs\Plans\plan-permissions-ui.md`

**Modified (the wiring sites):**
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\components\server\server-settings-sheet.tsx`
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\components\user-card-sheet.tsx`
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\stores\membership.ts`

**Audit focus:**
- 200ms debounce on `core.permission.changed` refetch (Discussion 2026-05-06 in plan).
- Optimistic UI is matrix-only; everything else uses refetch-after-success (D4 in plan).
- "Manage member" button gated by `useHasPermission("core.permissions.manage")`.
- Owner role hidden from assignment dropdown for the actor (Q1).
- Default-role override UI doesn't allow rename/re-level/delete (Q2).

**Acceptance:** Manual click-through against a runtime: open a member, toggle inherit/grant/deny, see broadcast update other clients within ~250ms; revoke own permission, dropdown updates.

---

### C7 — Voice reachability vertical slice (PR-VR)

**Scope:** Direct-server voice path: STUN/TCP probes from client and Central, runtime reachability state, plugin-side derivation/redaction.

**Untracked:**
- `C:\Users\jusss\projects\uncorded\platform\apps\central\migrations\004-voice-reachability.ts`
- `C:\Users\jusss\projects\uncorded\platform\apps\central\src\probe\stun-probe.ts`
- `C:\Users\jusss\projects\uncorded\platform\apps\central\src\probe\tcp-probe.ts`
- `C:\Users\jusss\projects\uncorded\platform\apps\central\src\probe\types.ts`
- `C:\Users\jusss\projects\uncorded\platform\apps\central\src\routes\voice-probe.ts`
- `C:\Users\jusss\projects\uncorded\platform\apps\central\src\routes\voice-probe.test.ts`
- `C:\Users\jusss\projects\uncorded\platform\apps\central\src\routes\voice-probe.unit.test.ts`
- `C:\Users\jusss\projects\uncorded\platform\runtime\src\voice\reachability.ts`
- `C:\Users\jusss\projects\uncorded\platform\runtime\src\voice\reachability.test.ts`
- `C:\Users\jusss\projects\uncorded\platform\runtime\src\core\migrations\013_create_voice_reachability_state.sql`
- `C:\Users\jusss\projects\uncorded\platform\plugins\voice-channels\backend\reachability-redact.ts`
- `C:\Users\jusss\projects\uncorded\platform\plugins\voice-channels\backend\voice-join.ts`
- `C:\Users\jusss\projects\uncorded\platform\plugins\voice-channels\__tests__\reachability-redact.test.ts`
- `C:\Users\jusss\projects\uncorded\platform\plugins\voice-channels\__tests__\voice-join-source-derivation.test.ts`
- `C:\Users\jusss\projects\uncorded\platform\plugins\voice-channels\migrations\003_max_publishers.sql`
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\lib\voice-direct-probe.ts`
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\stores\voice-reachability.ts`

**Modified (likely tied — confirm during audit):**
- `C:\Users\jusss\projects\uncorded\platform\apps\central\src\routes.ts`
- `C:\Users\jusss\projects\uncorded\platform\apps\central\src\middleware.ts`
- `C:\Users\jusss\projects\uncorded\platform\apps\central\schema.sql`
- `C:\Users\jusss\projects\uncorded\platform\plugins\voice-channels\backend\index.ts`
- `C:\Users\jusss\projects\uncorded\platform\plugins\voice-channels\frontend\index.html`
- `C:\Users\jusss\projects\uncorded\platform\plugins\voice-channels\manifest.json`

**Audit focus:**
- Reachability data redaction — never leak server-internal IPs to clients.
- STUN probe doesn't open an outbound to user-supplied addresses without gating.
- `max_publishers` migration has a sane default.
- Cross-check `pr-VR-voice-reachability.md` against the wire format here.

**Acceptance:** With voice plugin running, a client can derive direct vs relay path; reachability state survives runtime restart.

---

### C8 — Voice runtime polish (residual modifications not covered by C7)

**Scope:** Voice client/runtime updates that aren't strictly reachability — token rotation, config tweaks, supervisor smoke test fixes.

**Modified:**
- `C:\Users\jusss\projects\uncorded\platform\runtime\src\voice\config.ts`
- `C:\Users\jusss\projects\uncorded\platform\runtime\src\voice\config.test.ts`
- `C:\Users\jusss\projects\uncorded\platform\runtime\src\voice\ipc.ts`
- `C:\Users\jusss\projects\uncorded\platform\runtime\src\voice\ipc.test.ts`
- `C:\Users\jusss\projects\uncorded\platform\runtime\src\voice\tokens.ts`
- `C:\Users\jusss\projects\uncorded\platform\runtime\src\voice\tokens.test.ts`
- `C:\Users\jusss\projects\uncorded\platform\runtime\src\voice\webhook.ts`
- `C:\Users\jusss\projects\uncorded\platform\runtime\src\voice\supervisor.smoke.test.ts`
- `C:\Users\jusss\projects\uncorded\platform\packages\plugin-sdk\src\voice.ts`
- `C:\Users\jusss\projects\uncorded\platform\packages\plugin-sdk\src\__tests__\voice.test.ts`
- `C:\Users\jusss\projects\uncorded\platform\packages\plugin-sdk-frontend\src\voice.ts`
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\lib\voice-manager.ts`
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\lib\voice-manager.test.ts`
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\components\voice\voice-setup-modal.tsx`

**Audit focus:**
- Memory `feedback_jwt_jti_burn_no_ttl_skip` — confirm token reuse is impossible on reconnect.
- Memory `feedback_ws_connect_race` — voice tokens were entangled with WS race fix; verify no regression.

**Acceptance:** Voice E2E smoke test passes on a fresh runtime + a fresh client.

---

### C9 — Terminal Anywhere: runtime + plugins (spec-25)

**Scope:** Backend half of Terminal Anywhere — runtime terminals/* module, registered_terminals migration, echo-shell + terminal-anywhere plugins.

**Untracked:**
- `C:\Users\jusss\projects\uncorded\platform\runtime\src\terminals\` (21 files: dao/handshake/relay/cascade/permissions/audit/state/limits/fingerprint/pair-tokens/plugin-bridge/http/register/types/index + tests)
- `C:\Users\jusss\projects\uncorded\platform\runtime\src\core\migrations\012_create_registered_terminals.sql`
- `C:\Users\jusss\projects\uncorded\platform\runtime\scripts\test-terminals-relay.ts`
- `C:\Users\jusss\projects\uncorded\platform\plugins\echo-shell\backend\index.ts`
- `C:\Users\jusss\projects\uncorded\platform\plugins\echo-shell\manifest.json`
- `C:\Users\jusss\projects\uncorded\platform\plugins\terminal-anywhere\backend\index.ts`
- `C:\Users\jusss\projects\uncorded\platform\plugins\terminal-anywhere\manifest.json`

**Modified:**
- `C:\Users\jusss\projects\uncorded\platform\runtime\src\http\handler.ts`
- `C:\Users\jusss\projects\uncorded\platform\runtime\src\http\handler.test.ts`
- `C:\Users\jusss\projects\uncorded\platform\runtime\src\http\types.ts`
- `C:\Users\jusss\projects\uncorded\platform\runtime\src\ws\router.ts`
- `C:\Users\jusss\projects\uncorded\platform\runtime\src\ws\router.test.ts`
- `C:\Users\jusss\projects\uncorded\platform\runtime\src\ws\server.ts`
- `C:\Users\jusss\projects\uncorded\platform\runtime\src\ws\server.test.ts`
- `C:\Users\jusss\projects\uncorded\platform\runtime\src\ws\__fixtures__\ws-echo-plugin.ts`
- `C:\Users\jusss\projects\uncorded\platform\runtime\src\ipc\transport.ts`
- `C:\Users\jusss\projects\uncorded\platform\runtime\src\main.ts` (terminal mount points)
- `C:\Users\jusss\projects\uncorded\platform\packages\shared\src\manifest.ts` (terminal capability declarations)

**Audit focus:**
- Spec-25 conformance — every IPC verb in the spec has a runtime handler and at least one test.
- Cascade test must cover ban, role-revoke, server-leave.
- Pair tokens are JTI-burned (memory `feedback_jwt_jti_burn_no_ttl_skip`).
- Capability check on `terminal.relay` declared in manifest schema.
- `echo-shell` is a documentation/proof plugin, not shipped by default.

**Acceptance:** `bun run runtime/scripts/test-terminals-relay.ts` round-trips a frame end-to-end.

---

### C10 — Terminal Anywhere: SDK + website UI

**Scope:** Frontend half — SDK terminal API, website terminal panel/picker, website-side helpers and integration tests.

**Untracked:**
- `C:\Users\jusss\projects\uncorded\platform\packages\plugin-sdk\src\terminals.ts`
- `C:\Users\jusss\projects\uncorded\platform\packages\plugin-sdk\src\__tests__\terminals.test.ts`
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\components\terminal-panel.tsx`
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\components\terminal-picker.tsx`
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\api\terminals.ts`
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\api\terminals.test.ts`
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\lib\terminal-attach.ts`
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\lib\terminal-attach.test.ts`
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\lib\terminal-panel-runtime.ts`
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\lib\terminal-panel-runtime.test.ts`
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\lib\terminal-panel-runtime.integration.test.ts`
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\lib\terminal-panel-state.ts`
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\lib\terminal-panel-state.test.ts`
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\lib\terminal-picker-data.ts`
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\lib\terminal-picker-data.test.ts`
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\lib\terminal-test-host.ts`

**Modified (likely tied):**
- `C:\Users\jusss\projects\uncorded\platform\packages\plugin-sdk\src\index.ts`
- `C:\Users\jusss\projects\uncorded\platform\packages\plugin-sdk\src\plugin.ts`
- `C:\Users\jusss\projects\uncorded\platform\packages\plugin-sdk\src\transport.ts`
- `C:\Users\jusss\projects\uncorded\platform\packages\plugin-sdk\src\schemas.ts`
- `C:\Users\jusss\projects\uncorded\platform\packages\plugin-sdk\src\types.ts`
- `C:\Users\jusss\projects\uncorded\platform\packages\plugin-sdk-frontend\src\index.ts`
- `C:\Users\jusss\projects\uncorded\platform\packages\plugin-sdk-frontend\src\plugin.ts`
- `C:\Users\jusss\projects\uncorded\platform\packages\plugin-sdk-frontend\src\handshake.ts`
- `C:\Users\jusss\projects\uncorded\platform\packages\plugin-sdk-frontend\src\types.ts`

**Audit focus:**
- SDK terminal surface matches spec-25 verbs exactly.
- Integration test runs against a real runtime, not mocks (memory `feedback_audit` re: mock divergence).
- Terminal panel respects `feedback_iframe_isolation` — interactions inside the terminal iframe don't leak to parent.

**Acceptance:** Manual: open `echo-shell` plugin, type into terminal, see echoed output.

---

### C11 — CLI pairing (Central + Website auth surface)

**Scope:** The pair-flow that lets the CLI app trade an OAuth login for a stored credential. Wraps memory `project_terminal_anywhere_plan` PR-T5 prep.

**Untracked:**
- `C:\Users\jusss\projects\uncorded\platform\apps\central\migrations\003-cli-installs.ts`
- `C:\Users\jusss\projects\uncorded\platform\apps\central\src\routes\cli-pair.ts`
- `C:\Users\jusss\projects\uncorded\platform\apps\central\src\routes\cli-pair.test.ts`
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\api\cli-pair.ts`
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\components\cli-pair-page.tsx`
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\lib\cli-pair-helpers.ts`
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\lib\cli-pair-helpers.test.ts`
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\lib\attach-keypair.ts`
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\lib\attach-keypair.test.ts`
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\lib\attach-session-cipher.ts`
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\lib\attach-session-cipher.test.ts`
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\lib\attach-session-cipher.bench.ts`

**Modified:**
- `C:\Users\jusss\projects\uncorded\platform\apps\central\src\crypto.ts`
- `C:\Users\jusss\projects\uncorded\platform\apps\central\schema.sql` (only the cli-installs lines)
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\App.tsx` (route registration)
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\index.tsx` (route registration)

**Audit focus:**
- Pair token TTL is short (recommend ≤ 5 min) and one-shot.
- Central crypto changes don't break existing JWT issuance (regression test required).
- `attach-session-cipher` correctly negotiates the session key derived in C3.
- No CLI fingerprint stored in plaintext on Central side.

**Acceptance:** Run pair flow end-to-end with C12's CLI client (gates C12 behind this).

---

### C12 — CLI app (`apps/cli`)

**Scope:** The CLI binary that consumes C11's pair flow and C9's terminal relay.

**Untracked:**
- `C:\Users\jusss\projects\uncorded\platform\apps\cli\` (whole subtree, ~25 files)

**Audit focus:**
- Memory `feedback_full_paths_in_plans` is a doc rule, but the CLI must *not* hard-code Windows paths.
- `secret-store.ts` uses OS keychain; falls back to encrypted file.
- `host-keypair.ts` uses C3 fingerprint — no parallel implementation.
- `integration.test.ts` runs against a real Central + a real runtime, not mocks.

**Acceptance:** From a fresh machine, `cli pair` → `cli terminal-anywhere connect` opens a working terminal through the runtime.

---

### C13 — OAuth icons + auth UI polish

**Scope:** Auth-page visual upgrade (OAuth provider icons) and the small modifications around it.

**Untracked:**
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\components\auth\oauth-icons.tsx`

**Modified:**
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\components\auth\auth-page.tsx`
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\components\profile\profile-sheet.tsx`
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\stores\auth.ts`
- `C:\Users\jusss\projects\uncorded\platform\apps\central\src\routes\heartbeat.ts` (only if changes are auth-related — verify)
- `C:\Users\jusss\projects\uncorded\platform\apps\central\src\routes\heartbeat.test.ts` (same)

**Audit focus:**
- Memory `feedback_lucide_icon_sizing` — explicit `class="size-4"` on every icon.
- Provider icons are SVG, not PNG; tree-shakeable.

**Acceptance:** Auth page renders all provider buttons with correct icons; no console errors.

---

### C14 — Misc UI helpers + drag/panel polish

**Scope:** Small helpers that don't tie to a single feature.

**Untracked:**
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\hooks\` (any leftover after C6)
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\lib\context-gesture.ts` + test
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\lib\format-relative.ts` + test
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\lib\trailing-debounce.ts` + test
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\lib\use-coarse-pointer.ts` + test
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\lib\use-panel-surface.ts` + test
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\lib\plugin-panel-events.ts`
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\lib\panel-layout.test.ts`

**Modified:**
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\lib\drag-state.ts`
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\lib\panel-layout.ts`
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\lib\portal-host.ts`
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\lib\portal-host.test.ts`
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\lib\surface-key.ts`
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\components\drag-pill.tsx`
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\components\panel.tsx`
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\components\portal-container.tsx`
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\components\screen-share-overlay.tsx`
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\components\nav-sidebar-sections.tsx`
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\components\channel-view.tsx`

**Audit focus:**
- Memory `feedback_drag_ux_pattern` — dwell-gate + hysteresis + authoritative transform; no animate-in keyframes.
- `feedback_no_panel_keybinds` — no keyboard shortcuts in panel mgmt.
- Hooks have a single export and a test.

**Acceptance:** Drag/drop a panel; drag a server pill; both feel right (no jitter, no double-handler).

---

### C15 — Browser-panel + adblock leftovers

**Scope:** The desktop adblock + website browser-panel changes that don't fit elsewhere.

**Modified:**
- `C:\Users\jusss\projects\uncorded\platform\apps\desktop\src\adblock.ts`
- `C:\Users\jusss\projects\uncorded\platform\apps\desktop\src\adblock.test.ts`
- `C:\Users\jusss\projects\uncorded\platform\apps\desktop\src\central.test.ts`
- `C:\Users\jusss\projects\uncorded\platform\apps\desktop\src\cloudflare.test.ts`
- `C:\Users\jusss\projects\uncorded\platform\apps\desktop\src\ipc.ts`
- `C:\Users\jusss\projects\uncorded\platform\apps\desktop\src\main.ts`
- `C:\Users\jusss\projects\uncorded\platform\apps\desktop\src\preload.ts`
- `C:\Users\jusss\projects\uncorded\platform\apps\desktop\src\provision.test.ts`
- `C:\Users\jusss\projects\uncorded\platform\apps\desktop\src\server-runtime.ts`
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\components\browser-panel.tsx`
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\lib\browser-panel-state.ts`
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\lib\browser-panel-state.test.ts`
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\stores\adblock.ts`
- `C:\Users\jusss\projects\uncorded\platform\packages\electron-bridge\src\index.ts`

**Audit focus:**
- Memory `feedback_adblock_ubo_extension` — Ghostery on persist:browser, tri-state, polyfill, executeJavaScript guards.
- Memory `feedback_browser_panel_strategy` — iframe-first, webview fallback on Electron only.

**Acceptance:** Browser panel loads a third-party site in iframe (web) and webview (Electron); ad blocker tri-state cycles correctly.

---

### C16 — Tooling, docker, scripts, Central misc

**Scope:** Whatever the audit hasn't placed by now — should be small.

**Untracked:**
- `C:\Users\jusss\projects\uncorded\platform\apps\central\scripts\restore-db-password.ts`
- `C:\Users\jusss\projects\uncorded\platform\apps\central\src\crypto-rotation.test.ts` (likely C3 — re-decide)
- `C:\Users\jusss\projects\uncorded\platform\apps\website\scripts\check-bundle-size.ts`
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\lib\ws.test.ts` (modified, but resolves leftover)

**Modified:**
- `C:\Users\jusss\projects\uncorded\platform\docker\Dockerfile`
- `C:\Users\jusss\projects\uncorded\platform\package.json`
- `C:\Users\jusss\projects\uncorded\platform\apps\central\package.json`
- `C:\Users\jusss\projects\uncorded\platform\apps\desktop\package.json`
- `C:\Users\jusss\projects\uncorded\platform\apps\website\package.json`
- `C:\Users\jusss\projects\uncorded\platform\apps\central\src\test-helpers.ts`
- `C:\Users\jusss\projects\uncorded\platform\runtime\src\heartbeat\client.ts`
- `C:\Users\jusss\projects\uncorded\platform\runtime\src\heartbeat\types.ts`
- `C:\Users\jusss\projects\uncorded\platform\plugins\text-channels\backend\index.ts`
- `C:\Users\jusss\projects\uncorded\platform\plugins\text-channels\frontend\index.html`
- `C:\Users\jusss\projects\uncorded\platform\runtime\admin\app.js`
- `C:\Users\jusss\projects\uncorded\platform\runtime\admin\index.html`
- `C:\Users\jusss\projects\uncorded\platform\runtime\admin\styles.css`
- `C:\Users\jusss\projects\uncorded\platform\runtime\src\text-channels.test.ts`
- `C:\Users\jusss\projects\uncorded\platform\scripts\typecheck-all.cjs`
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\lib\ws.ts` (if not consumed by C5/C6)
- `C:\Users\jusss\projects\uncorded\platform\apps\website\src\lib\ws.test.ts`

**Audit focus:**
- Memory `feedback_docker_build` — `uncorded-runtime:latest`, `COPY` every new runtime/ subdir.
- Memory `feedback_db_password_drift` — `restore-db-password.ts` is the recovery script, document its trigger.
- Memory `feedback_rate_limiter_format` — Central rate config uses `maxTokens/refillRate`; verify `package.json` change doesn't reintroduce the wrong format anywhere.

**Acceptance:** `bun typecheck && bun test && bun lint` clean across the entire monorepo.

---

## Final step (after every chunk lands)

1. `git status` shows zero changes.
2. `git log --oneline origin/main..HEAD` lists 16–17 commits in the expected order.
3. Push when you say so (per P2).
4. Open the production-readiness Phase 01 work from a clean base.

---

## Things this plan deliberately does NOT do

- No refactoring outside the chunk it touches (per `feedback_no_unsolicited_subagents` and the "minimal changes" principle).
- No adding features or speculative abstractions.
- No deleting suspicious-looking code without a confirming audit pass.
- No squashing — every chunk is its own commit so the audit trail survives.
- No force-push, no rebase against origin.

---

## Estimated effort

Reading + auditing 300 files at this fidelity is the long part. Rough budget per chunk:
- C0, C1, C2, C13, C14, C16: ~15 min each
- C3, C4, C8, C15: ~30 min each
- C5, C6, C9, C10: ~60 min each
- C7, C11, C12: ~45 min each

Total: ~10 hours of focused work, broken across whatever number of sessions makes sense. Each chunk leaves the tree green; you can stop after any chunk.
