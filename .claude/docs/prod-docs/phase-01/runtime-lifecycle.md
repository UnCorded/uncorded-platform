# Phase 01 — Runtime Lifecycle Spec

> **Scope:** The technical contract for runtime boot, ready, shutdown, update, and rollback. Pairs with `update-ux.md` (operator UX). Reflects decisions D1–D6 and O1–O8 in `decisions.md`. **No implementation in this doc** — this is the contract Stage 3–5 implementation builds against.

---

## 1 · Inputs to the runtime

The runtime accepts inputs through three channels:

1. **Image** — the binary the orchestrator pulled. Built by `platform/.github/workflows/release-runtime.yml` (Stage 4 deliverable; today only the desktop equivalent exists, see `current-state.md` F1). Image carries `RUNTIME_VERSION` ENV baked from build-arg.
2. **Mounted volumes** — `/plugins`, `/data`, `/config`, `/run/tunnel` (tmpfs). Per `current-state.md`: state survives `docker rm -f` and is the contract Phase 02 plugins inherit.
3. **Environment + stdin** — env vars (validated at boot), tunnel token via stdin (5s window then fallback to local mode per `entrypoint.sh`).

Stage 4 adds:
- Image is **signed** (per O4, signing pipeline TBD); runtime verifies image signature against a public key shipped with itself before completing boot. Failed verification = exit code `40` (see §6).

## 2 · Boot lifecycle

Boot is **two-phase**: a fast liveness phase that gets `/health` answering, then a readiness phase that brings up plugin subprocesses, the WS hub, and Central key sync. Until readiness completes, `/health` returns 200 (process is up) but `/ready` returns 503.

### 2.1 First boot vs warm boot

A boot is **first-boot** iff `/config/server.json` does not exist. Per `entrypoint.ts:90-124`, first-boot today seeds `installed_plugins: ["text-channels"]` and `mkdir`s `/data/plugins/text-channels` unconditionally. Stage 3 changes this:

- **Phase 01 first-boot seeds an empty `installed_plugins: []`** (per F5; "zero-plugin boot" must actually work). The `text-channels` install becomes a recommended-default the user accepts in the first-run UI, not a forced seed.
- The first-run UI (rendered by the shell when `installed_plugins` is empty) is the empty-state surface called out in the success criteria. Stage 3 deliverable.

### 2.2 Boot sequence

Concrete order, post-`tini` exec:

1. **PID-1 environment guards** (`entrypoint.ts:60-67` today) — fail fast if invariants are wrong. Exit code `10` on any failure (see §6). Guards are:
   - `RUNTIME_ENCRYPTION_SECRET` present and ≥32 chars. **Phase 01 change:** if absent, auto-generate at first boot and persist to `/config/secret` mode `0600` owned by UID 1001 (per F7). Existing manual-set path remains supported — env beats file.
   - `RUNTIME_VERSION` ENV present (Stage 3 introduces this; today's `entrypoint.ts:493` hardcodes `"1.0.0"` — F3).
   - `/data`, `/config`, `/plugins` writable.
   - Image signature verification (Stage 4 deliverable, O4).
2. **Liveness up** — bind HTTP server, register `/health`. Liveness endpoint goes green here.
3. **State load** — read `/config/server.json` (or first-boot seed it).
4. **Central key sync** — fetch + cache Central public keys. Failure does **not** block readiness (key cache stale = `/health` reports `degraded`, see §3).
5. **Plugin subprocesses** — spawn each plugin in `installed_plugins` per the existing IPC model. Zero plugins is a valid configuration; readiness still completes.
6. **WS hub** — accept connections.
7. **Update-state restore** — read `/config/update-state.json` (new in Phase 01) and broadcast its contents on first WS connection. This is how a client that connects mid-update sees the right pill.
8. **Readiness up** — `/ready` returns 200.
9. **Heartbeat to Central begins** — emit first heartbeat with `runtimeVersion` + `channel` (per O2, O6).

Stage 3 must verify steps 1, 5, 6, 8 actually happen in this order with structured logs.

## 3 · `/health` vs `/ready`

Today there is one `/health` endpoint (`platform/runtime/src/http/handler.ts:380-399`) which gates only on Central key freshness. Phase 01 splits liveness from readiness.

### 3.1 `/health` — liveness

- Returns 200 from step 2 onward, regardless of plugin state.
- Returns `degraded` (200, body indicates the issue) for non-fatal conditions: Central key cache stale, channel switch in progress.
- Returns 503 only when the process is unhealthy enough that the orchestrator should restart it: PID 1 stuck, fatal subsystem crashes that didn't trigger `unhandledRejection`.
- Body shape (extends current handler):
  ```ts
  {
    status: "ok" | "degraded" | "unhealthy",
    version: string,            // RUNTIME_VERSION (sourced from build, not literal)
    uptime: number,             // seconds
    plugins: number,            // count, not gating
    reason?: string,            // present when status !== "ok"
  }
  ```
- Used by: Docker HEALTHCHECK (replacing the misleading `bun -e fetch /health` comment block, F4), orchestrator liveness probes.

### 3.2 `/ready` — readiness

- Returns 200 only when **step 8** of §2.2 completes.
- Returns 503 with `reason` while booting or during a drain.
- Body shape:
  ```ts
  {
    ready: boolean,
    version: string,
    plugins_loaded: number,
    plugins_expected: number,
    reason?: string,            // "booting" | "draining" | "key-sync-pending"
  }
  ```
- Used by: post-update health check (the pass/fail gate that decides commit vs rollback — see §9), Central directory's "is the server reachable" check.

### 3.3 Why both

Update orchestration needs **readiness**, not liveness, to decide whether the new image is healthy. A liveness-only check is too forgiving — a runtime that's up but failed to load any plugins should fail the post-swap gate, but today's `/health` would return 200 in that case.

## 4 · Version surfacing pipeline

Today `runtimeVersion` is the literal `"1.0.0"` at `entrypoint.ts:493` (F3). Stage 3 introduces:

```
release tag (vX.Y.Z) ─→ Dockerfile build-arg RUNTIME_VERSION
                       └→ ENV RUNTIME_VERSION=X.Y.Z baked into image
                          └→ entrypoint reads process.env.RUNTIME_VERSION at boot
                             └→ surfaced in:
                                ├── /health body
                                ├── /ready body
                                ├── heartbeat to Central
                                ├── update-state broadcast (currentVersion field)
                                ├── admin UI (Danger Zone "Runtime · vX.Y.Z")
                                └── all log entries (structured field "rv")
```

Verification: a runtime running v0.3.1 reports `0.3.1` in every surface listed above; a v0.3.2 image reports `0.3.2`. This is the precondition for Stage 7's E2E test having any meaning.

## 5 · Shutdown lifecycle

Triggered by:
- `SIGTERM` from `docker stop` (orchestrator drain)
- `SIGINT`
- `serverDeleted` from Central (`entrypoint.ts:498-505`, exit 42)
- `unhandledRejection` / `uncaughtException` (`entrypoint.ts:427-461`)

### 5.1 Graceful drain sequence

Phase 01 promises this works end-to-end (today's plumbing exists per `current-state.md`, but per F1 the drain hasn't been verified to actually drain WS clients).

1. **Mark `/ready` 503** with `reason: "draining"`. Liveness stays 200.
2. **Broadcast `server_draining` WS event** to all connected clients with `grace_seconds: N` (default 30, configurable per server).
3. **Stop accepting new WS connections.** New connection attempts get HTTP 503 with `Retry-After: <grace_seconds>`.
4. **Wait grace period** for clients to disconnect cleanly. During this window:
   - Plugins continue to receive events.
   - Existing WS connections continue to work for messages already in flight.
   - The orchestrator's `update_state` shows `installing` (per `update-ux.md` §2.3).
5. **Force-close remaining WS connections** with WS close code `1012` (Service Restart). Clients should auto-reconnect after the swap.
6. **Stop plugins.** Send `shutdown` IPC to each plugin subprocess; wait up to 5s for clean exit; SIGKILL stragglers.
7. **Flush state.** Each plugin's SQLite is in WAL mode; final checkpoint runs as part of plugin shutdown. Runtime-side state (`server.json`, `update-state.json`) is already on disk by virtue of being written synchronously on every change.
8. **Exit clean** with appropriate code (§6).

Total budget for graceful drain: `grace_seconds + 5s plugin grace + 1s flush ≈ 36s` default. The orchestrator passes `grace_seconds` based on connected user count (per `update-ux.md` §4.4 helper text).

### 5.2 Crash drain

`unhandledRejection` / `uncaughtException` skip steps 2–4 (no time to negotiate). They:
1. Mark `/ready` 503.
2. Force-close WS with code `1011` (Internal Error).
3. Best-effort plugin shutdown with 1s grace.
4. Exit with code corresponding to the error (§6).

## 6 · Exit codes

Codes the orchestrator interprets:

| Code | Meaning | Orchestrator action |
| --- | --- | --- |
| `0` | Clean exit (graceful drain, e.g. update-triggered restart) | If `update-state == installing`, proceed to swap; otherwise restart. |
| `10` | Boot precondition failure (env var, writable mount, signature) | Surface to operator; do not restart-loop. State → `error/check`. |
| `40` | Image signature verification failed | Halt update; restore `:previous`; state → `error/install`. |
| `42` | Central reported `serverDeleted` | Stop the container; remove the registry entry. Don't restart. (Existing behavior, `entrypoint.ts:498-505`.) |
| `1` | Unhandled crash | Restart up to 3× in 60s; if exceeded, surface to operator. |
| Other non-zero | Unexpected | Treat as `1`. |

Code `40` is new for Stage 4 signing. Code `10` already exists implicitly (today `process.exit(1)` on env failure at `entrypoint.ts:60-67`); Stage 3 reassigns it to `10` so the orchestrator can distinguish boot misconfiguration from crashes.

## 7 · State directory contract

Per O3 and F8, state already persists across `docker rm -f`. Phase 01 **documents** the contract Phase 02 plugins inherit; it does not invent new persistence plumbing.

### 7.1 Layout

```
/data/                                    (volume: uncorded-data)
├── plugins/
│   └── <slug>/
│       ├── data.sqlite                   (plugin-owned, WAL mode)
│       ├── data.sqlite-shm
│       └── data.sqlite-wal
└── (no other top-level entries in Phase 01)

/config/                                  (volume: uncorded-config)
├── server.json                           (config: name, channel, installed_plugins, role bindings)
├── secret                                (RUNTIME_ENCRYPTION_SECRET if auto-generated; mode 0600)
├── update-state.json                     (last-known update-state, NEW in Phase 01)
├── voice/                                (existing)
│   └── ...
└── backups/                              (NEW in Phase 01; see §7.3)
    └── <ISO8601>-pre-update/
        ├── data/                         (snapshot of /data at update start)
        └── config/                       (snapshot of /config except backups/)

/plugins/                                 (volume: uncorded-plugins)
└── (plugin install artifacts; Phase 02 territory)

/run/tunnel                               (tmpfs; tunnel token only)
```

### 7.2 Survival contract

Three guarantees:

1. **Across update:** All of `/data`, `/config` (except `/config/backups/` rotation, see §7.3), and `/plugins` survive a container swap. They're named volumes; the swap is image-level, not volume-level.
2. **Across rollback:** Same. The state dir is restored from the pre-update snapshot only if rollback is triggered AND backup-before-update was enabled (per O3, default ON).
3. **Across `serverDeleted`:** Volumes are torn down by the orchestrator after the runtime exits 42. The orchestrator removes the registry entry and prompts the operator before deleting volumes (current desktop behavior).

### 7.3 Backup-before-update

Per O3:
- Default ON, owner-toggleable per server.
- Triggered when state transitions `pending-confirm → backing-up`.
- Implementation: orchestrator (not runtime) runs `docker run --rm -v uncorded-data:/src -v uncorded-data:/dst alpine sh -c 'cp -a /src/. /dst/backups/<ISO>-pre-update/data/'` (sketch — concrete invocation finalized in Stage 5).
- Retention: keep last 3 pre-update backups; rotate older ones at update commit time. Failed updates' backups are retained until the next successful update (so the operator can diagnose).
- On rollback: orchestrator restores from the `<ISO>-pre-update/` snapshot before relaunching `:previous` image.

## 8 · Update lifecycle (orchestrator-driven)

Per O8 and D3, the orchestrator owns the lifecycle. The runtime is a passive store + broadcaster.

### 8.1 Sequence

```
[orchestrator]                             [runtime]                          [clients]
    |                                          |                                  |
    | check channel for new version            |                                  |
    | (or runtime triggers manual check from   |                                  |
    |  POST /admin/api/check-update from UI)   |                                  |
    |                                          |                                  |
    | found: vX.Y.Z+1                          |                                  |
    | POST /admin/api/update-state             |                                  |
    |   { state: "available", availableVersion } -->                              |
    |                                          | persist to update-state.json     |
    |                                          | broadcast update_state_changed -->
    |                                          |                                  | render pill (amber)
    |                                          |                                  |
    | (operator clicks Update + types UPDATE)  |                                  |
    | POST /admin/api/update-state             |                                  |
    |   { state: "pending-confirm" } -->       | persist + broadcast              |
    |   ... user confirms ...                  |                                  |
    | POST /admin/api/update-state             |                                  |
    |   { state: "backing-up" } -->            | persist + broadcast              |
    |                                          |                                  |
    | snapshot /data + /config (per O3)        |                                  |
    | POST /admin/api/update-state             |                                  |
    |   { state: "downloading", progress: 0 } -->                                 |
    |                                          |                                  |
    | docker pull uncorded-runtime:X.Y.Z+1     |                                  |
    | (verify image signature locally too)     |                                  |
    | POST /admin/api/update-state             |                                  |
    |   { state: "downloaded" } -->            |                                  |
    |                                          |                                  |
    | POST /admin/api/update-state             |                                  |
    |   { state: "installing" } -->            | broadcast (clients see toast)    |
    | (runtime begins drain per §5.1 due       |                                  |
    |  to receiving installing state)          |                                  |
    | wait grace_seconds                       |                                  |
    | docker stop --time grace_seconds         |                                  |
    | docker tag :latest :previous             |                                  |
    | docker tag :X.Y.Z+1 :latest              |                                  |
    | docker run :latest                       |                                  |
    |                                          | NEW PROCESS BOOTS                |
    |                                          | step 7: read update-state.json   |
    |                                          | (still says "installing")        |
    |                                          | step 8: /ready 200               |
    |                                          |                                  |
    | poll /ready until 200 OR timeout 90s     |                                  |
    | -- branch on result --                   |                                  |
    | OK: POST /admin/api/update-state         |                                  |
    |   { state: "idle", currentVersion: X.Y.Z+1 } -->                            |
    |                                          | broadcast → clients see green    |
    | FAIL: see §9                             |                                  |
```

### 8.2 Mechanics

- **State writes are authoritative-from-orchestrator.** The runtime accepts state transitions from the orchestrator without question (auth-gated; see §11). The runtime does not refuse state transitions based on internal validation — its job is to record + broadcast.
- **Drain trigger.** Receiving `state: "installing"` is what kicks the drain in §5.1. The runtime knows it's about to be replaced and starts negotiating with clients.
- **The runtime never pulls.** No docker socket, no permission. F6 in `current-state.md`.
- **Atomicity is image-level, not volume-level.** Volumes are continuous; the container is what gets atomically replaced.

## 9 · Rollback lifecycle

Triggered when post-swap `/ready` polling fails (§8.1 last branch).

### 9.1 Sequence

```
[orchestrator]                             [runtime]
    |                                          |
    | post-swap /ready never reached 200        |
    | (timeout 90s OR /ready returns 503        |
    |  with non-recoverable reason)             |
    |                                          |
    | POST /admin/api/update-state              |
    |   { state: "rolling-back",                |
    |     errorContext: "install" } -->        | broadcast (clients see red pill)
    |                                          |
    | docker stop new-version                   |
    | docker tag :previous :latest              |
    | (if backup-before-update was ON):         |
    |   restore /data, /config from snapshot   |
    | docker run :latest                        |
    |                                          | OLD VERSION BOOTS
    |                                          | step 7: reads update-state.json  
    |                                          | which says "rolling-back"        
    |                                          | step 8: /ready 200               
    |                                          |
    | poll /ready until 200 OR 90s              |
    | OK:                                       |
    |   POST /admin/api/update-state            |
    |     { state: "idle",                      |
    |       currentVersion: X.Y.Z (prior),      |
    |       errorContext: null,                 |
    |       errorMessage: "Update to X.Y.Z+1    |
    |       failed; rolled back successfully" } |
    | FAIL:                                     |
    |   POST /admin/api/update-state            |
    |     { state: "error",                     |
    |       errorContext: "rollback" } -->     | clients see escalation copy
```

### 9.2 Why this works without runtime cooperation

The runtime restored from `:previous` is unaware it's a rollback in any structural sense. It just boots, reads `update-state.json`, sees `rolling-back`, and broadcasts. The orchestrator is the one that knows "we successfully restored prior version" and writes the final `idle` state.

This is the upside of the passive-store model: the runtime has no rollback-specific code path, just a state field.

### 9.3 Hard failure (`error/rollback`)

If the rollback itself fails (e.g. `:previous` image is gone, volume restore failed), the orchestrator writes `state: "error", errorContext: "rollback"` and stops attempting auto-recovery. The runtime panel shows the manual-recovery copy from `update-ux.md` §4.4.

This is the worst case. Phase 01 makes the failure mode loud (red pill, no retry button, link to logs and runbook); it does not invent a recovery path.

## 10 · Signing & verification

Per O4 (open, deferred to Stage 1 completion):

- Release pipeline signs each runtime image (sigstore cosign or in-house Ed25519 — decision lands before Stage 4).
- Public key is shipped inside the runtime binary itself (not fetched at runtime — bootstrap problem).
- Boot-time signature verification (§2.2 step 1) compares the running image's signature against the embedded key.
- Failed verification: exit `40`, orchestrator detects, restores `:previous`, writes `error/install`.
- Orchestrator-side signature verification (`docker pull` + verify before tagging `:latest`) is also performed; the runtime's own check is a defense-in-depth backstop in case orchestrator was compromised.

Stage 4 deliverable. Spec gaps (where the signing key lives, key rotation procedure, public-key embed mechanism) close before Stage 4 starts.

## 11 · Admin API surface

New endpoints introduced in Phase 01:

### 11.1 `POST /admin/api/update-state`

Auth: existing admin token + `core.runtime.update` permission (per D5). Orchestrator-only in practice — non-orchestrator clients get 403 from the permission gate.

Body: any subset of the broadcast shape (§12 below). Runtime validates types, persists to `/config/update-state.json`, broadcasts.

Returns: `{ ok: true, state: <merged state> }`.

### 11.2 `GET /admin/api/update-state`

Auth: any authenticated user (visibility is universal per D4).

Returns: current update-state. Used on first WS connect before the broadcast lands; also used by `/ready` polling clients.

### 11.3 `POST /admin/api/check-update`

Auth: `core.runtime.update` permission.

Triggers a `state: "checking"` broadcast and forwards the check request to the orchestrator (which actually queries the channel). Rate-limited to 1 per 30s per server (per `update-ux.md` §7).

### 11.4 `GET /admin/api/update-log`

Auth: `core.runtime.update` permission.

Returns the structured log entries from the most recent update attempt. Powers the "logs" link from the error states in `update-ux.md` §4.4. Stage 5 deliverable.

### 11.5 Heartbeat extension

Existing heartbeat to Central gains:
- `runtimeVersion` (already specced; hardcoded today)
- `channel` (per O2)
- `updateState` (per O2/O6 — informational, not action-driving)

Telemetry fields (anonymized version + uptime + crash report per O6) are reserved in the schema but not collected.

## 12 · Update-state shape (canonical)

Single source of truth for the wire shape. Used by:
- WS broadcast (`update_state_changed`)
- `GET /admin/api/update-state` response
- `POST /admin/api/update-state` request body (subset)
- `/config/update-state.json` on-disk format

```ts
type UpdateState = {
  state:
    | "disabled" | "idle" | "checking" | "up-to-date"
    | "available" | "pending-confirm"
    | "backing-up" | "downloading" | "downloaded" | "installing"
    | "rolling-back" | "error";
  errorContext: "check" | "backup" | "download" | "install" | "rollback" | null;
  currentVersion: string;            // matches process.env.RUNTIME_VERSION at write time
  availableVersion: string | null;
  channel: "stable" | "beta" | "dev";
  progress: number | null;           // 0..100, 10% buckets
  lastCheckedAt: number;             // epoch ms
  errorMessage: string | null;       // one-line, user-safe
  updatedAt: number;                 // epoch ms; written by runtime on every persist
};
```

## 13 · Configuration / env vars

Stage 3 env-var validation table. Each is checked at boot; failures exit `10`.

| Var | Required | Default | Notes |
| --- | --- | --- | --- |
| `RUNTIME_ENCRYPTION_SECRET` | conditionally | (auto-generated to `/config/secret`) | F7 fix: auto-generate if absent. ≥32 chars. |
| `RUNTIME_VERSION` | yes | (set by Dockerfile build-arg) | F3 fix; baked into image, not operator-set. |
| `RUNTIME_CHANNEL` | no | `stable` | Per O2; persisted in `server.json` after first boot. |
| `CENTRAL_URL` | yes | — | Existing. |
| `SERVER_TOKEN` | yes | — | Existing. |
| `RUNTIME_DRAIN_GRACE_SECONDS` | no | `30` | Per §5.1 step 4. Owner-overridable per server. |
| `RUNTIME_BACKUP_BEFORE_UPDATE` | no | `true` | Per O3; persisted in `server.json` after first boot. |

Operator-facing error messages on validation failure are actionable (per Stage 3 deliverable in `plan.md`): name the var, name the file, name the fix.

## 14 · Open items deferred to implementation

Not blockers; flagged so they don't get lost.

- **Concrete drain grace default:** §5.1 says 30s; Stage 5 may tune by connected-user count.
- **Backup volume location:** §7.3 sketches the snapshot mechanic but the orchestrator's exact `docker run` invocation is finalized in Stage 5.
- **`/ready` poll timeout:** §8.1 / §9.1 say 90s; Stage 5 may tune.
- **Update-state schema versioning:** if §12 ever changes, add a `schemaVersion` field. Phase 01 ships v1; the field is reserved.
- **Plugin shutdown protocol:** §5.1 step 6 assumes a `shutdown` IPC. Confirm this exists in the SDK before Stage 5; if not, add it (Stage 3 hygiene).
- **Heartbeat update-state coupling:** §11.5 includes `updateState` in heartbeat. If Central treats heartbeat as health signal, ensure `installing`/`rolling-back` states don't trip directory "server is down" logic.
