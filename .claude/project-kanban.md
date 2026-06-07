# UnCorded — Production Polish Kanban

> Living checklist. No priority order — pick whatever's ripe.
> Format: `item — file:line — why`. Move completed items to **Done** trail at bottom with commit SHA.
> Strike or re-rank freely. Add seeds when you spot something.

---

## Cross-cutting

- Direct server-URL hits while signed-out should redirect to sign-in — `apps/website/src/App.tsx:1252` only swaps in `<AuthPage>` when `account() === null`. No route guard, so deep-links lose their intended `/servers/<id>` target. Add `?next=` round-trip.
- **[foundation]** Client error toasts swallow Central error codes — fetch helpers in `apps/website/src/api/*` surface `"Request failed"` instead of mapping `code`/`message` from the typed envelope. Tag: foundation — fixing this cascades into Settings (workspace-autosave silent error, MembersSection generic load-fail, EditSection/CategoriesSection save errors). Worth landing before most settings polish.

### Cross-cutting — pre-launch only

> Park here. Cheap when the moment is right, no value before public traffic.

- CSP / `frame-ancestors` audit — confirm Central, web, runtime all set CSP that lets only the desktop shell + the configured tunnel origin frame plugin iframes.
- Marketing site polish — `apps/website/public/` is sparse; before any inbound traffic, ship og-image, twitter card, `robots.txt`, favicon, manifest.

## Auth (Central)

- **[feature gap]** Password-reset flow doesn't exist — no `forgot-password` / `reset-password` route under `apps/central/src/routes/`. Design + ship the request → email → reset cycle, with rate caps on both the send and verify endpoints.
- OAuth expired-state error rendering — TTL is correct at 10 min (`apps/central/src/routes/oauth.ts:100`); confirm the web side renders a friendly error page on expired/exhausted state instead of a raw JSON envelope.

### Auth — pre-launch only

- Email-verification copy — generic; tighten subject + body and double-check the verify link survives Gmail clipping. Touch `apps/central/src/routes/register.ts:122-138` and the email-template module it calls into.

## Central — DB + schema

- _(none open — see Done 2026-05-07: voice_reachability shape now versioned.)_

## Central — Observability

- `/metrics` endpoint with per-route latency histogram — now that access logs exist, layer an in-process histogram (p50/p95/p99 per route) exposed at `/metrics`. Operational nice-to-have.
- Thread `account_id` into the access log — current wrapper deliberately skips it because `authenticate()` hits the DB. Once a request-scoped logger is plumbed through `RouteContext`, handlers can stash the resolved account id and the access line will pick it up for free.

---

## Settings UI — plugin controls + tabs

> All citations under `apps/website/src/components/server/server-settings-sheet.tsx` unless noted.

- **Build the Plugins tab** — currently a placeholder at lines 134–138 ("Plugins — coming soon"). Single feature with these sub-gaps:
  - List view + manifest data + enable/disable/configure/uninstall actions.
  - Loading skeleton and error state (today, failed-load looks identical to empty).
  - Wire runtime API: `apps/website/src/api/runtime.ts` currently exports only workspace + browser-recent helpers; add plugin enable/disable/configure/uninstall.
  - Admin-only role gate at the tab definition (line 45) — match the Administration tab pattern.
  - Entry point from Server Info plugin count (line 855, currently read-only).
  - Offline / tunnel-down state — Plugins tab depends on the runtime; needs a "server offline, can't manage plugins" affordance instead of looking broken.
- No "rotate server secret" UI — `POST /v1/servers/:id/secret/rotate` is implemented (`apps/central/src/routes/server-rotate.ts`) and specced (`spec-08-uncorded-central.md:62`), but neither desktop nor web exposes it. Add a button under DangerSection (typed-confirm) that calls the API, displays the new secret once, and prompts the operator to update the runtime container env + restart.
- Notifications feature is two-half stub — `apps/website/src/components/nav-user.tsx:98-101` is a `<DropdownMenuItem>` with no `onSelect`, and `apps/website/src/components/profile/profile-sheet.tsx` has zero notification-prefs UI. Either wire the dropdown to a notifications inbox + add prefs to profile, or remove the dead menu item until the feature lands.
- Appearance section is "coming soon" copy — `apps/website/src/components/profile/profile-sheet.tsx:707-719`. Binary decision: ship a light/dark/system toggle, or delete the section. Keeping a "coming soon" placeholder shipped is worse than either.
- CategoriesSection uses browser `confirm()` for delete — line 1010 (NOT DangerSection — DangerSection at 1210+ already has a proper inline two-step confirm). Replace with an inline confirm matching DangerSection's pattern.
- EditSection save error UX is generic — line 832 shows "Failed to save" inline with no detail; line 787 only `console.error`s the underlying error. Surface the real `error.code` / `error.message` from the typed envelope, and route the console call through the structured logger so it's grep-able.
- CategoriesSection generic error message — line 1057. Distinguish create vs update vs delete failures so users know which row to retry.
- MembersSection silent-fails to empty on initial-load error — lines 341–344. Add a retry button next to "Failed to load members".
- Workspace autosave silently flips to "error" — `apps/website/src/App.tsx:500`. Add a toast / inline status indicator so users know their unsaved changes are at risk.
- Form-level validation runs only via disabled button state — line 823. Cross-tab submit (e.g. an empty name on the General tab while the user is on Members) just stays disabled with no hint about why. Add per-field hint text or a "fix this on General tab" pointer.
- No audit log / change history surface — `apps/website/src/components/server/administration/index.tsx`. Categories/roles/transfer changes aren't visible to the owner anywhere in the UI.

---

## Runtime — logs (clean + publish)

> Goal: clean noisy/unstructured emit sites, then expose `/admin/api/plugins/{slug}/logs` (and a runtime-level equivalent) to the desktop/web operator UI.

**Cleanliness — drop or convert console.* to structured logger:**
- `plugins/text-channels/backend/index.ts:120-123` — `logWarn` emits `console.error(JSON.stringify({...}))`, but the runtime's plugin-stderr wrapper logs each line as `{line: "<raw string>"}`, so the inner JSON gets string-stringified instead of merged. Needs a new SDK logger API (IPC frame with structured fields) — design first, then plumb. Defer until SDK gap is scoped.

**Format / metadata gaps:**
- _(none open — see Done 2026-05-07: WS request lifecycle trace.)_

**Publish path (operator-visible logs):**
- Endpoint exists but is unwired — `GET /admin/api/plugins/{slug}/logs` at `runtime/src/http/handler.ts:1222-1237`. Verified zero callers in `apps/`. Wire from desktop + web into a per-plugin "Logs" panel.
- In-memory only, 500 entries/plugin cap — `runtime/src/subprocess.ts:123-124`. Decide: stay in-memory (simple, ring survives restart inside the same runtime process), or persist to disk with rotation (durable across container restart).
- No runtime-level (non-plugin) log endpoint — only per-plugin. Add a runtime log buffer + endpoint so operators can see boot/heartbeat/tunnel/WS errors without SSH.
- No streaming endpoint — only point-in-time fetch. A WS or SSE endpoint would let the desktop "Logs" panel tail in real time.
- Desktop has its own duplicate logger — `apps/desktop/src/main.ts:111-138` defines a private `emit`/`log` shim that mirrors `@uncorded/shared`'s shape. Replace with the shared logger so format matches runtime + Central exactly.

---

## Plugin feature gaps (real features, not polish)

> Things missing from shipped plugins that we don't want to lose track of, even if they're not blocking the production push.

**text-channels:**
- No image upload / inline render — paste-image, drag-drop, file picker → R2 upload → message renders preview. Today it's plain text only.
- No file attachment — same upload path as images but generic mime types, with size cap + safe-render rules (no auto-execute, no inline render for non-image).
- No reactions on messages — no UI, no `reactions` table, no IPC handler. (Replies + threading already shipped: `parent_message_id` + `reply_count` schema, Thread Panel UI at `frontend/index.html:1619`.)
- No `@mentions` notification routing — no parser, no `mentioned_user_ids` column, no notification dispatch.
- No client-side search — frontend has no search UI; backend has no `searchMessages` IPC.

**marketplace (apps/website + Central):**
- Real listing page — today it's a single placeholder line at `apps/website/src/components/server/create-server-wizard.tsx:502-505`. Need a browse view with name / icon / description / version / install count.
- Per-plugin detail page — README render, screenshot carousel, permission summary, changelog.
- Install button wired to a real install path (depends on **Plugins — packaging, install path, marketplace** section landing first).
- Version + update flow — server-owner sees "update available" badge per installed plugin.
- Plugin search / filter / category tags.
- Author / publisher attribution + signing key display once plugin signing lands.

**voice-channels:**
- Push-to-talk mode — `plugins/voice-channels/backend/index.ts:515` notes "mic publishing is granted to all members regardless"; no PTT-mode toggle in `apps/website/src/lib/voice-manager.ts` to gate publish on a held key.
- No UI to disable noise suppression / echo cancellation — both are hardcoded ON at `voice-manager.ts:617-621`. Pro audio / music-bot use cases need an opt-out.
- Input + output device picker (incl. Bluetooth) — no `deviceId` selection UI anywhere; voice-manager always uses default devices.
- Mute / deafen / disconnect keyboard shortcuts — voice-manager.ts has no global keybindings; everything routes through the indicator UI.
- Atomic channel hop — switch button exists (`frontend/index.html:865` → handler at `:1275-1282`) but it's disconnect+reconnect, not a single-handshake hop. Real users will hear ~300ms of dropped audio.
- Channel password / invite-code gating — `channels` table has no password/code field; no `joinWithCode` IPC.
- Speaking-while-muted toast — voice-manager tracks muted state but doesn't fire a notice when the active-speaking detector trips while muted.
- Stage-channel / speaker-vs-listener role separation — no listener-only queue, no "raise hand" flow, no per-room publisher cap beyond the existing `max_publishers`.
- Soundboard / push-to-play sample — no sample playback UI.
- Server-mute mic / kick-from-voice — `backend/index.ts:349` has `voice.stopShare` but it's screen-share only. No `voice.muteMic` / `voice.kickFromRoom` moderation IPC.
- Background-audio vs disconnect-on-tab-close — `pagehide`/`beforeunload` cleanup exists but there's no opt-in to keep audio playing when the tab loses focus / closes.
- Stub: `runtime/src/voice/supervisor.ts:199-200` — activeRooms/activeParticipants hardcoded to `0`. Webhook plumbing exists for kicks/bans (`cascade.ts:145`), so wiring participant/room counters is incremental, not greenfield.

**terminal-anywhere + echo-shell — REMOVED (commit `95dec38`):** The entire Terminal Anywhere vertical was removed as a scope reduction — the `terminal-anywhere` + `echo-shell` plugins, the runtime `terminals/*` subsystem, the `terminals.*` IPC/WS frames, the `terminal.use` permission, the CLI pair flow + `apps/cli`, and the website terminal panel/picker. The former open-PR items and feature gaps no longer apply. Historical design is preserved in `.claude/docs/Overview/spec-25-registered-terminals.md` (marked removed).

---

## Plugins — packaging, install path, marketplace

> Goal: only ship what a fresh container needs as core; everything else lives in a marketplace and goes through a real download → verify → install → load cycle that we can E2E-test.

**Bundled vs core decision:**
- Two plugins live under `plugins/` and both are marked `"type":"core"` in their manifests: `text-channels`, `voice-channels`. Decide which actually need to ship in the base image vs. be installable. (`terminal-anywhere` + `echo-shell` were removed in commit `95dec38`.)
- Dockerfile copies the core plugins — `docker/Dockerfile` (`COPY plugins/text-channels/`, `voice-channels/`). The `terminal-anywhere` COPY line was removed with the feature in commit `95dec38`.
- Manifest `type` field is decorative — `packages/shared/src/manifest.ts:7` accepts `core | standalone | extension` but no code branches on it. Either enforce (only `type:"core"` allowed in `/app/core-plugins/`) or drop the field.
- Bundled list is hardcoded in the create-server wizard — `apps/website/src/components/server/create-server-wizard.tsx:466` (`["text-channels","voice-channels"]`). Drift between this list and the Dockerfile is silent.
- Phase 2 plugins missing — `docker/Dockerfile:91` comments "members and moderation are Phase 2"; no `plugins/members/` or `plugins/moderation/` directory exists yet.

**Install path (doesn't exist end-to-end):**
- Central exposes download + integrity hash — `apps/central/src/routes/download-plugin.ts` returns presigned URL + SHA256.
- Runtime has no install handler — `runtime/src/http/handler.ts` has no `/admin/api/plugins/install` route.
- Manual install today: download → verify SHA256 → untar to `/plugins/{slug}/` → edit `server.json` `installed_plugins` array → restart container. Five steps, all manual, no CLI.
- Marketplace UI is a placeholder — `apps/website/src/components/server/create-server-wizard.tsx:502-505` ("Marketplace plugins will appear here once the package registry is live."). Wire to nothing.
- All plugins load eagerly at boot — `runtime/src/main.ts:644-676`. No lazy-load → no install-without-restart.
- "Disable" exists; "uninstall" doesn't — PATCH `/admin/api/plugins/{slug}` flips a `disabled` flag (`runtime/src/http/handler.ts:1163-1220`). Cannot remove from disk or from `server.json`.

**Install testability:**
- No fixture for "fresh container with only core" — every dev/test path seeds `installed_plugins:["text-channels"]` (`runtime/src/dev.ts:124`, `runtime/src/entrypoint.ts:102`). Real "first install" cycle is untested.
- No tarball/untar tooling in repo — would need to add to runtime so install path can be exercised.

---

## Runtime — boot + lifecycle

- Boot fail-fast paths print actionable messages — re-walk `runtime/src/boot/*` and confirm each fatal exit prints what the *operator* needs to do (missing env, bad DB, expired JWT) rather than a stack trace.
- Plugin subprocess crash → user-visible signal — when a plugin dies and is marked unhealthy, the shell still shows it in the sidebar. Add a "this plugin failed to start" tile.
- Graceful shutdown order — verify SIGTERM → drain WS → close plugin IPC → close DB → exit, with a hard-kill timer.

## Runtime — HTTP + WS

- WS close-code taxonomy — desktop and web react differently to the same close codes. Pick a small fixed set (auth-failed, kicked, server-shutting-down, version-mismatch) and document.
- `/manifest.json` cache headers vs SDK bundle — re-verify both share cache lifetime end-to-end after any future plugin-shipping change. (Memory: `feedback_sdk_bundle_cache.md`.)
- Narrow wildcard CORS on public read-only routes — `runtime/src/http/handler.ts:319,451` set `Access-Control-Allow-Origin: *` for `/plugins`, `/manifest.json`, `/health`. Confirm none of these ever return per-account data; if any do (now or in future), narrow to the `deps.allowedOrigins` allowlist used elsewhere. (Memory: `feedback_runtime_cors.md`.)

## Runtime — Plugins (general)

- Capability-declaration drift test — when a plugin adds an IPC call, the manifest must declare the capability. Per-core-plugin unit test asserts manifest ↔ IPC surface match.

## Website — Routing + history

> Phase-01 Stage 2.5 introduces real routing. The items below should land *as part of* that stage, not as separate work.

- No real client routing — `apps/website/src/App.tsx` is one giant component switching on signals. Stage 2.5 introduces a router; until then deep-links / back-button / share-URL all break.
- 404 / unknown-route page — falls through to a blank shell on bad URLs. Add a "this server or page doesn't exist" view as part of the router landing.
- Back-button history on plugin/channel nav — without a router today the shell could `history.pushState` synthetic entries, but the router will handle this natively. Track here so it's not forgotten when Stage 2.5 ships.

## Website — Loading + error states

- Initial-load skeleton on cold sign-in — first paint shows a flash of empty grid while servers/plugins load. Add skeletons.
- WS-disconnected banner — when shell loses WS, surface a small "reconnecting…" banner instead of letting stale state silently drift.
- Empty-state copy on a brand-new account — "no servers yet" should explain how to create one or accept an invite.

## Website — Placeholders to remove

- Marketing copy in `apps/website/src/pages/*` — grep for `lorem`, `TODO`, `placeholder`, `coming soon`. Ship real copy or hide the section.
- Settings → Account: avatar upload UX — confirm presigned-POST flow has progress + error states wired into the panel.
- Plugin marketplace empty/disabled state — Phase 1 ships with core plugins only; the marketplace tab should say so explicitly (or hide).

## Desktop — Main process

- electron-updater "update available" UI — confirm there is a user-visible toast/banner before the update applies, not silent install on next launch.
- Adblock — **removed** (commit `b00667c`, `chore(desktop): remove built-in adblock feature`). The Ghostery-based browser-panel adblock and its per-profile toggle are no longer part of V1; no persistence work remains.
- Crash reporter / diagnostics export — small "save logs to file" menu item for issue triage.
- Desktop logger is a duplicate of `@uncorded/shared` — `apps/desktop/src/main.ts:113-138`. Unify.

## Packages

- `@uncorded/protocol`: wire-format version field — confirm every WS frame carries a protocol version (or that the JWT does) so a stale client/runtime returns a clean "version mismatch" close code.
- `@uncorded/plugin-sdk`: published types snapshot — once SDK is publishable to npm, lock its types snapshot in CI to prevent accidental breaking changes.

## Docs + test infrastructure

- Onboarding: "build from scratch in 30 minutes" — `apps/website/src/pages/docs/*` should walk a homelab user through Docker compose → first server.
- CI green button — `bun typecheck && bun test && bun lint` should be one script and one CI job.
- Flaky-test triage — two pre-existing flaky tests flagged in `project_audit_2026_04_17`. Either fix or quarantine with a tracking comment.
- Install-path E2E test — fresh container + Central + a single non-core plugin, exercise download → verify → install → load → enable → call → uninstall.

---

## Done — 2026-05-07

- C8–C16 cleanup chunks (Central middleware, runtime boot, web shell)
- Test-infra unblock: `RateLimiter.resetForTests()` + voice-probe loopback hook → 2338 pass / 25 skip / 0 fail (commit `0f2243e`)
- Desktop v0.0.6 release cut + auto-update verified end-to-end (commit `7a85270`, GitHub Release `v0.0.6`)
- 18 commits + version bump pushed to `origin/main`
- Central `/health` upgraded — version + commit + uptime + 250ms-capped DB ping; 200/503 split for LB use; driver internals never on the wire (`apps/central/src/routes/health.ts`, unit tests in `apps/central/src/routes/health.test.ts`)
- Logger level gating — `LOG_LEVEL` env (debug/info/warn/error/silent), default info, gate runs **before** `JSON.stringify` so filtered calls cost a single integer compare. `setLogLevel()` for runtime reconfig, always emits a `warn`-level audit line on change. Invalid env falls back to info with one stderr warning. (`packages/shared/src/logger.ts`, 22 tests in `packages/shared/src/logger.test.ts`.)
- Per-IP WS concurrent-connection cap — `WsServerOptions.maxConnectionsPerIp` rejects new upgrades from a saturated IP with HTTP 503 + `MAX_CONNECTIONS_PER_IP` + `Retry-After: 30` before the upgrade is consumed. Pre-auth sockets count, so a hostile peer cannot stockpile half-open connections under the per-IP attempt rate limit. Wired through `settings.max_connections_per_ip` (validator in `runtime/src/main.ts`); seeded at 25 in `apps/desktop/src/provision.ts` and `runtime/src/entrypoint.ts`; treated as unlimited when absent or 0. Tests in `runtime/src/ws/server.test.ts`.
- Central boot is secure-by-default for `NODE_ENV` — `apps/central/src/index.ts:21-22` inverted the predicate: only `NODE_ENV=development` or `NODE_ENV=test` opts into permissive dev paths; anything else (unset, "prod" typo, "staging", "production") forces every required secret to be present at boot. Closes the leak where missing `RESEND_API_KEY` on a misconfigured deploy would log raw verification / server-transfer URLs (with tokens) via the dev fallback in `register.ts:134`, `resend-verification.ts:37`, `profile.ts:347`, `server-transfer.ts:169-176`. New "secure default" tests in `apps/central/src/index.boot.test.ts` cover unset, typo, and staging cases (16/16 pass).
- Central per-request access log — `apps/central/src/access-log.ts` wraps `Bun.serve`'s fetch with one structured info line per request (`method`, `path`, `status`, `duration_ms`, `ip`, `reqId`). Query strings are reduced to a sorted key list so `verify-email`, `server-transfer` confirm/decline, and OAuth `state` tokens never reach log aggregators. `/health` is logged at debug so LB probes don't drown prod logs (opt back in via `LOG_LEVEL=debug`). Account id is intentionally deferred — extracting it would double DB hits per request; tracked as a follow-up that needs a request-scoped logger plumbed through `RouteContext`. Tests in `apps/central/src/access-log.test.ts` cover redaction, status passthrough, debug downgrading, reqId uniqueness, and Response identity (so CORS/Set-Cookie aren't silently rewritten).
- Runtime rate-limiter denials + ban transitions now log structured warns — `runtime/src/http/rate-limiter.ts` accepts an optional `Logger`. `consume()` emits `"rate limit exceeded"` (with `key`, `retryAfterMs`, `tokensPerWindow`, `windowMs`, `suppressedSinceLastWarn`) on the first deny per bucket, then debounces for 30s so a client hammering an empty bucket can't drown the log file — the next emitted line carries the suppressed count so operators see the magnitude. `recordAuthFailure` logs `"ip banned (short)"` / `"ip banned (long)"` with duration + failure count on each threshold crossing. Wired from `runtime/src/main.ts` via `log.child({ component: "rate-limiter" })` for both the WS limiter and the HTTP handler's fallback. 6 new tests in `runtime/src/http/rate-limiter.test.ts` cover first-warn, debounce + suppression count, per-bucket independence, both ban transitions, and the no-logger silence path.
- Voice webhook is no longer silent — `runtime/src/voice/webhook.ts` accepts an optional `Logger` (wired via `log.child({ component: "voice-webhook" })` from `runtime/src/main.ts`). Every early-return now emits one structured line: `warn` for missing/invalid auth (`reason` is one of a fixed set: `"missing Authorization header"`, `"malformed JWT"`, `"invalid signature"`, `"token expired"`, `"iss does not match apiKey"`, `"body hash mismatch"`); `warn` for malformed bodies and missing required fields (with `event`, `channelId`, `field`); `error` for credential lookup failure (message-only); `debug` for unhandled events and foreign-server rooms (no room name in payload — multi-tenant safety). Happy paths emit one `info "voice webhook accepted"` line per delivery with `event`, `channelId`, `userId`, and `reason` (for `participant_left`). Scrub guarantees: `apiKey`, `apiSecret`, raw JWT tokens, `sha256` claims, and raw bodies never enter any logged ctx. 13 new tests in `runtime/src/voice/webhook.test.ts` cover every code path plus a redaction-guarantee test that walks 4 paths and asserts none of `FIXED_API_KEY` / `FIXED_API_SECRET` / minted token / sha256 ever appear in any line's ctx.
- Runtime log cleanup pass — Plugin stdout is no longer double-logged: `runtime/src/subprocess.ts` now appends to the in-memory ring buffer only (the source for `/admin/api/plugins/{slug}/logs`); the duplicate `log.child({plugin}).info("plugin stdout", { line })` mirror was dropping plugin print lines onto the runtime's own stdout. stderr lines are still mirrored to the runtime log (errors should be loud). Cloudflared stdout/stderr fan-out moved off the `entrypoint` component onto its own `tunnel` component (`runtime/src/entrypoint.ts`) so operators can grep `component=tunnel` to isolate tunnel noise from runtime boot lines. `runtime/src/dev.ts` boot banner + shutdown lines now go through `rootLogger.child({ component: "dev" })` instead of `console.log`/`console.error` — dev output matches prod's structured JSON, and the boot banner became one info line carrying `httpUrl`/`wsUrl`/`chatUiUrl`/`pluginCount` as fields. `runtime/src/roles/engine.ts` listener-throw `console.error` switched to `log.error` with `err`/`stack` fields. Typecheck + 1264 runtime tests still pass.
- Heartbeat happy-path now emits a debug line per successful poll — `runtime/src/heartbeat/client.ts` accepts an optional `Logger` via `HeartbeatClientOptions.logger`; both clean and dirty success returns emit `log.debug("heartbeat ok", { dirty, wanIp, deltasApplied?, connectedUsers })`. Gated by `LOG_LEVEL=debug` so prod stays quiet by default; flip the env to debug for operator triage on a misbehaving runtime → Central pairing. Wired from `runtime/src/main.ts` via `heartbeatLog`. 4 new tests in `runtime/src/heartbeat/client.test.ts` cover clean-response logging, dirty-response with delta count, no-logger silent path, and the network-error path emitting no "heartbeat ok" line.
- WS request lifecycle trace — every plugin request frame emits a matched debug pair: `"ws request → ipc dispatch"` on entry (`runtime/src/ws/router.ts:1194`) and `"ipc response → ws dispatch"` on plugin reply (`runtime/src/ws/router.ts:1212`). Both lines carry `reqId` (client-side WS request id), `connId`, `correlationId` (IPC msg id used to join runtime logs to the plugin's own logs), `plugin`, plus `userId`/`action` on entry and `durationMs`/`ok` on response. Core-plugin requests (handled inline, no IPC round-trip) emit one `"ws request (core)"` line at the same site. Capability-denied warns (`runtime/src/ws/router.ts:667-672, 690-696`) now also include `correlationId` so an operator grepping a denial in plugin output can correlate it to the runtime's audit line. 2 new tests in `runtime/src/ws/router.test.ts` cover the matched-pair lifecycle (reqId / correlationId continuity + duration field) and the early-return path emitting no misleading trace, plus the existing capability-denied test extended to assert `correlationId`. Default LOG_LEVEL=info keeps these silent in prod; flip to debug for triage. 268 runtime ws/http tests pass.
- `voice_reachability` JSONB shape is now versioned — `VoiceProbeResult` carries a required `version: 1` literal field, written by Central at `apps/central/src/routes/voice-probe.ts:197` and mirrored in the runtime's local type at `runtime/src/voice/reachability.ts`. The runtime validator (`isVoiceProbeResult`) gates on the field: explicit `1` accepts, missing accepts as legacy v1 (covers any rows persisted before the field existed and older Central deploys still on the air), any other numeric value fails closed so a future Central rollout can't get rendered with v1 assumptions. The response normalizer at the call site stamps `version: 1` so downstream consumers always see a populated envelope. SQLite `restore()` hardcodes `version: 1` for rebuilt rows since by definition v1 = pre-version-field shape; future bumps add a column to the migration alongside whatever shape change motivates the bump. 6 new tests in `runtime/src/voice/reachability.test.ts` cover validator (explicit v1, missing legacy, future v2 rejected, non-numeric rejected, end-to-end normalization) and SQLite restore. 26/26 reachability tests pass; typecheck clean.
- Plugin manifest validator is now typo-resistant — `validateManifest` (`packages/shared/src/manifest.ts`) walks every top-level key after the object check and rejects anything outside `KNOWN_TOP_LEVEL_FIELDS` with a new `UNKNOWN_FIELD` error. Previously a misspelled optional field (e.g. `setings`, `runtime_capabilites`, `dependancies`) was silently dropped, leaving the plugin author convinced their settings/capabilities were wired up when in fact the manifest was treated as if the field didn't exist. Errors now name the offending field and point installers at the allow-list. Existing edge-case test that asserted "extra unknown fields are silently ignored" was reversed to assert rejection. 4 new tests cover: typo on a field-shaped name, typo on a capabilities-shaped name, multiple-unknowns reported (not first-only), every documented optional field still accepted as a sanity check that the allow-list hasn't fallen behind PluginManifest. All 4 shipped plugin manifests' top-level keys verified within the allow-list before commit. 129/129 manifest tests pass; full runtime + packages + website suites green.
- Plugin SQLite WAL checkpoint loop — `PluginDbCache.checkpointAll()` (`runtime/src/ipc/handlers.ts`) runs `PRAGMA wal_checkpoint(TRUNCATE)` on every cached plugin DB and returns one `CheckpointResult` per slug; per-DB errors are captured rather than thrown so one misbehaving plugin can't starve checkpoints on its peers. Wired into `runtime/src/main.ts` as a 30-min `setInterval` plus a final pass in the graceful-shutdown sequence (right before `close database`) so the next boot reads a small WAL instead of a multi-day one. Failures are surfaced via `log.child({component:"plugin-db"}).warn("wal checkpoint failed", {plugin, err})`. Why TRUNCATE rather than the default PASSIVE: PASSIVE skips the truncate when readers are mid-transaction; TRUNCATE waits and resets the WAL to the header so disk usage is bounded — we accept the brief writer lock. 5 new tests in `runtime/src/ipc/handlers.test.ts`: empty cache, single DB, multi-DB, TRUNCATE actually shrinks `-wal` after a 200-row × 4KB blob write burst, and one-DB-failure-doesn't-block-others. 1281 runtime tests pass; typecheck clean.
