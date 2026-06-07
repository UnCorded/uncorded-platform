# Found While Building

*Deviations, gaps, and decisions discovered during implementation that aren't covered by the original spec files. Each entry references the spec it relates to and whether it was fixed, deferred, or added as a new decision.*

---

## From Pre-Docker Audit (2026-04-07)

### C1 — Plugin Restart Loop Not Wired
**Spec:** `spec-04-plugin-architecture.md` — Restart policy: exponential backoff (1s, 2s, 5s, 15s, 60s), quarantine after 5 crashes in 10 minutes.
**Reality:** `subprocess.ts` has `RestartTracker`, `recordCrash()`, `shouldQuarantine()`, `getBackoffDelay()` — all implemented as pure functions. But `main.ts` calls `spawn()` once at boot and never re-calls it after a crash. The restart policy is dead code.
**Status:** FIXED — 2026-04-07. Added `SpawnContext` stored on each `PluginProcess`. `handleExit()` now schedules `setTimeout(() => respawn(...), backoffDelay)` using stored context. Quarantined plugins stay down. `stopAll()` cancels pending respawn timers. `onRespawn` callback for external listeners (e.g. router re-attachment).

### C2 — No Watchdog Health Check
**Spec:** `spec-04-plugin-architecture.md` — Runtime sends heartbeat ping on IPC every 10 seconds. Plugin misses 3 consecutive pings (30s) → force-kill + increment restart counter.
**Reality:** Zero implementation. No ping, no timeout, no force-kill. A hung plugin stays in "ready" state indefinitely.
**Status:** FIXED — 2026-04-07. Added `Watchdog` class (runtime/src/watchdog.ts) with configurable ping interval and max missed pings. Sends `{ type: "ping" }` via IPC; plugin SDK auto-responds with `{ type: "pong" }`. Router forwards pong to watchdog via `handlePong()`. 3 missed pings → SIGKILL → feeds into C1 restart loop. Wired into boot/shutdown in main.ts.

### C3 — Capability Enforcement in IPC Path (VERIFIED)
**Spec:** `spec-04-plugin-architecture.md` — Every capability call is checked against the plugin's declared permissions. Undeclared = reject immediately.
**Reality:** `router.ts` line 283 calls `buildCapabilityString()`, lines 284-316 gate on the result BEFORE any handler dispatch. `data.read`, `events.publish`, `events.subscribe` are all capability-checked with scoped strings. Passthrough types (`response`, `terminal.output`, `ready`, `permissions.*`) are intentionally exempt.
**Status:** NOT A BUG — verified 2026-04-07

### C4 — WebSocket Rate Limiting Missing
**Spec:** `spec-03-server-container.md` — Per-endpoint rate limits: WS connection attempts (10/min per IP), WS auth failures (5/min per IP with escalating bans), sdk.request() calls (60/min per user per plugin), sdk.subscribe() calls (20/min per user).
**Reality:** HTTP `RateLimiter` exists and works. WebSocket has zero rate limiting. An attacker can DoS the server via `/ws`.
**Status:** FIXED — 2026-04-07. Shared `RateLimiter` instance covers WS traffic. Connection rate: 10/min per IP (429 on upgrade). Auth failures: reuses escalating ban logic (5min/1hr bans). sdk.request(): 60/min per user per plugin (RATE_LIMITED error response). WS close code 4008 for rate limit violations. Wired in ws/server.ts (connection/auth) and ws/router.ts (per-message).

### C5 — Environment Variable Leakage
**Spec:** `spec-04-plugin-architecture.md` — "No inherited env vars, no inherited handles." Only PLUGIN_SLUG, PLUGIN_DATA_DIR, PLUGIN_API_VERSION are set.
**Reality:** `Bun.spawn()` with explicit `env` replaces `process.env` on Linux/Docker (the deployment target). On Windows dev, OS-level system vars (`SYSTEMROOT`, `PATH`, etc.) are injected by the kernel regardless — this is a platform behavior, not a Bun bug. Parent-defined env vars (e.g. database URLs, API keys) do NOT leak. Verified with subprocess env-plugin.ts fixture test.
**Status:** NOT A BUG — verified 2026-04-07. Bun.spawn already isolates env on Linux; Windows kernel vars are unavoidable and non-sensitive.

### C6 — Token Revocation Not Enforced
**Spec:** `spec-06-authentication.md` — Servers can track seen `jti` values to prevent replay within the token's lifetime.
**Reality:** `token.revoked` delta handler logs but doesn't enforce. No JTI tracking, no revocation list. Known deferral from heartbeat session.
**Status:** FIXED — 2026-04-07. Added `JtiRevocationSet` (ws/revocation.ts) with TTL pruning (10 min). Delta handler adds JTIs, WS auth checks the set before accepting tokens. TokenValidationResult extended with optional `jti` field.

### C7 — API Version Compatibility Check Missing
**Spec:** `spec-04-plugin-architecture.md` — Step 1: "Checks api_version compatibility with current runtime."
**Reality:** Resolver validates manifest schema and checks `api_version` field exists, but never calls `satisfiesRange()` against the runtime's actual API version. A plugin declaring `api_version: "^2.0"` loads on a 1.x runtime.
**Status:** FIXED — 2026-04-07. `resolvePlugins()` now accepts optional `runtimeApiVersion` parameter. When provided, calls `satisfiesRange(runtimeApiVersion, manifest.api_version)` and rejects with `INCOMPATIBLE_API_VERSION`. Wired in `main.ts` boot sequence.

### I1 — Multiple Connections Per User Break Presence
**Spec:** `spec-03-server-container.md` — Presence events on connect/disconnect.
**Reality:** Every new WebSocket emits `runtime.user.connected`. Closing one connection emits `runtime.user.disconnected` while other tabs remain open. No multi-connection tracking.
**Status:** FIXED — 2026-04-07. Added `userConnections: Map<userId, Set<connectionId>>` to `MessageRouter`. `runtime.user.connected` emits only on first connection for a user; `runtime.user.disconnected` emits only when the last connection closes. `connectedUsers` map updates to surviving connection on partial disconnect. `disconnectUser()` closes all connections and emits one disconnect event.

### I4 — No Graceful Shutdown Event to Clients
**Spec:** `spec-03-server-container.md` — "Active WebSocket connections receive a `runtime.server.shutting_down` event."
**Reality:** Shutdown sequence stops plugins and closes the server but never broadcasts this event.
**Status:** FIXED — 2026-04-07. Shutdown step 2 now calls `router.broadcastEvent("runtime.server.shutting_down", ...)` before stopping plugins. `broadcastEvent` made public on `MessageRouter`.

### I5 — FIFO Broken During Event Retries
**Spec:** `spec-04-plugin-architecture.md` — "Per-(topic, subscriber) FIFO order."
**Reality:** During retry backoff, new events can be delivered ahead of the failed event.
**Status:** FIXED — 2026-04-07. Added `retrying` flag to `SubscriberState`. When a retry timer is scheduled, `retrying = true` prevents `enqueueEvent` from calling `processQueue` — new events queue behind the retrying event. When the timer fires, `retrying = false` and `processQueue` drains everything in FIFO order. Cleaned up on unsubscribe.

### I6 — Event Bus Capability Checks (VERIFIED)
**Spec:** `spec-04-plugin-architecture.md` — "Publishing requires events.publish:\<topic\>. Subscribing requires events.subscribe:\<topic\>."
**Reality:** Router enforces `events.publish:<topic>` and `events.subscribe:<topic>` capability checks at lines 283-316 before messages reach the event bus. The bus itself does not check — enforcement is pre-emptive at the router layer.
**Status:** NOT A BUG — verified 2026-04-07

### I7 — Plugin Data Directory Path (VERIFIED)
**Spec:** `spec-03-server-container.md` — `/data/plugins/text-channels.db` (per-plugin).
**Reality:** `PLUGIN_DATA_DIR` is set to `${dataDir}/plugins` (the plugins root). Each plugin appends its own slug: `join(PLUGIN_DATA_DIR, slug, ...)`. The runtime also creates per-plugin directories at `join(dataDir, "plugins", slug)` during boot. Per-plugin isolation is maintained — the env var is the root, not the per-plugin path.
**Status:** NOT A BUG — verified 2026-04-07. Convention: PLUGIN_DATA_DIR is the plugins root; plugin appends its slug.

### I8 — Delta State Not Persisted Across Restarts
**Spec:** `spec-03-server-container.md` — `last_sync_version` in server.json.
**Reality:** Public keys and sync version cached in memory only. After crash, server re-syncs from version 0.
**Status:** FIXED — 2026-04-07. Added `onDirtySync` callback to `HeartbeatClientOptions`. After each dirty heartbeat, the callback fires with `(syncVersion, publicKeys)`. Wired in `main.ts` to read current `server.json`, update `last_sync_version` and `central_public_keys`, and write back atomically via `Bun.write()`. Errors are logged but don't break heartbeat polling.

---

## Decisions Made During Implementation

### EPIPE on Windows
**Spec:** N/A
**Decision:** Bun surfaces pipe errors from dead subprocesses on Windows. Cosmetic — code handles EPIPE correctly, Bun's internal handler reports it separately. Accepted as platform quirk.

### Permissions IPC as PASSTHROUGH_TYPES
**Spec:** Not explicitly addressed.
**Decision:** `permissions.*` message types bypass capability checking because they're runtime infrastructure available to every plugin. Added to PASSTHROUGH_TYPES in router.ts.

### Owner Bypass via Connected Users Map
**Spec:** `spec-06-authentication.md` — Owner identity from JWT `is_owner` flag.
**Decision:** Permission IPC handlers resolve owner status by checking the router's connected users map (`role === "owner"`). Falls back to `false` if user not connected. No protocol changes needed.

### Rate Limiter Ban Expiry Preserves Failure Count
**Spec:** `spec-03-server-container.md` — Escalating IP bans.
**Decision:** Found bug where `isBanned()` deleted the entire ban entry on expiry, resetting the failure counter. Fixed: `bannedUntil = 0` preserves the count so bans escalate correctly from short (5min) to long (1hr).

---

## From Minor Audit (2026-04-07)

### M1 — Missing `runtime.dlq.overflow` Event
**Spec:** `spec-04-plugin-architecture.md` — Overflow events (`runtime.subscriber.overflow`, `runtime.dlq.overflow`) are rate-limited to one per plugin per 60 seconds.
**Reality:** Bus emitted `runtime.subscriber.unhealthy` and `runtime.subscriber.overflow` but never `runtime.dlq.overflow` when events drained to the dead-letter log.
**Status:** FIXED — 2026-04-07. `drainToDeadLetter()` now calls `emitOverflow()` with `"runtime.dlq.overflow"` after draining. Same coalescing pattern as other overflow events.

### M2 — Event Handler Errors Swallowed in SDK
**Spec:** `spec-04-plugin-architecture.md` — Failure handling: "retried with backoff (1s, 5s, 30s). After 5 consecutive failures, the subscription is marked unhealthy."
**Reality:** SDK's `handleDelivery()` caught handler errors with `.catch(() => {})` — silent swallow. Runtime had no visibility into handler failures.
**Status:** FIXED — 2026-04-07. SDK now catches both sync and async handler errors and sends `{ type: "event.deliver.error", id, error }` back to the runtime. Router logs the error. `event.deliver.error` added to `PASSTHROUGH_TYPES` (infrastructure, not a capability).

### M3 — Owner Bypass Returns True for Nonexistent Permissions
**Spec:** `spec-06-authentication.md` — Owner role bypasses all permission checks.
**Reality:** `permissions.check()` returns `true` for owners even when the permission key doesn't exist in the system.
**Status:** INTENTIONAL — documented 2026-04-07. Correct per spec: "Owner = everything." Plugin authors should test permission logic with non-owner accounts.

### M4 — No Shutdown Timeout on `stopAll()`
**Spec:** `spec-04-plugin-architecture.md` — 5s grace period per plugin, SIGKILL after.
**Reality:** `stopAll()` stops plugins sequentially with per-plugin 5s grace. No outer deadline bounding total shutdown time.
**Status:** ACCEPTED — documented 2026-04-07. Spec defines per-plugin grace, not an outer deadline. Sequential shutdown is correct for ordered cleanup (reverse dependency order). Parallel shutdown with an outer deadline could be a future optimization if total shutdown time becomes a concern.

### M5 — Type Cast Evasion in Event Delivery
**Spec:** N/A — internal implementation detail.
**Reality:** `bus.ts` line 398 uses `msg as unknown as IpcMessage` because `IpcEventDeliverMessage` is structurally compatible but lacks the index signature.
**Status:** ACCEPTED — documented 2026-04-07. TypeScript structural limitation. The cast is safe because `IpcEventDeliverMessage` is a subset of `IpcMessage`. The double cast (`as unknown as`) is the standard pattern for bridging incompatible but structurally sound types.

### M6 — Resolver Code Cleanup
**Spec:** N/A — code quality.
**Reality:** `resolver.ts` topological sort had an abandoned first-attempt implementation (with "Wait — I have the direction inverted" comments) that built data structures immediately discarded and rebuilt.
**Status:** FIXED — 2026-04-07. Removed the dead first attempt. Only the correct implementation remains.

### M8 — Unvalidated Public Key Bundle
**Spec:** `spec-06-authentication.md` — Central sends Ed25519 public keys to servers.
**Reality:** Heartbeat client stores the key bundle from Central without validating key format (e.g., key length, encoding).
**Status:** ACCEPTED — documented 2026-04-07. Real validation happens at token verification time — a malformed key causes `ed25519.verify()` to fail, which is the correct failure mode (auth denied). Pre-validating key format would add complexity with no security benefit; the downstream check is authoritative.

### M9 — Silent Drop of Malformed WS Messages
**Spec:** N/A — developer experience.
**Reality:** Malformed messages from authenticated WebSocket clients were silently dropped. Client got no feedback — would wait for a timeout that never comes.
**Status:** FIXED — 2026-04-07. Server now sends `{ type: "error", message: "Malformed message" }` back to the client. Connection stays open (don't punish a client for one bad message).

### M10 — `permissions.register()` Signature Mismatch
**Spec:** `spec-06-authentication.md` — `sdk.permissions.register("photo-gallery.upload", { description: "Can upload photos", default_level: 10 })`.
**Reality:** SDK used three separate parameters: `register(key, description, defaultLevel)`.
**Status:** FIXED — 2026-04-07. Changed to `register(key, { description, default_level })` matching the spec. Updated `PermissionsApi` interface, implementation, and `text-channels` plugin call site. IPC message format unchanged.

### M11 — Missing `sdk.subscribe()` Rate Limit Consumption
**Spec:** `spec-03-server-container.md` — `sdk.subscribe()` calls are rate-limited to 20/min at the IPC layer.
**Reality:** `runtime/src/ws/router.ts` imported `RATE_WS_SUBSCRIBE` but never consumed it in `handleEventSubscribe()`, so plugins could subscribe without any runtime throttling.
**Status:** FIXED — 2026-04-07. `handleEventSubscribe()` now consumes `RATE_WS_SUBSCRIBE` using the per-plugin key `ws:subscribe:<slug>` before `eventBus.subscribe()`. Rate-limited calls return `event.ack` with `RATE_LIMITED` / `Subscribe rate limit exceeded`. Added regression coverage for the 21st rapid subscribe from one plugin slug.

---

## From Heartbeat Audit (2026-04-08)

### H1 — full_snapshot Response Silently Ignored
**Spec:** `spec-03-server-container.md` — Heartbeat delta sync with Central.
**Reality:** Central returns `{ dirty: true, deltas: [], full_snapshot: true }` when a server's deltas have expired (24h retention). The heartbeat client saw 0 deltas, updated `lastSyncVersion`, and silently moved on — missing all bans, revocations, and profile changes from the gap. **Security issue:** revoked tokens remained valid on servers that missed the revocation delta.
**Status:** FIXED — 2026-04-08. Added `full_snapshot?: boolean` to `HeartbeatResponse`. Heartbeat client now checks `full_snapshot === true` after delta processing: logs a loud warning and invokes `onFullSnapshot` callback. Added `disconnectAllUsers(code, reason)` to `MessageRouter` — iterates all connections and closes them via `removeConnection()` (full cleanup of presence, pending requests, terminal subscriptions). Wired in `main.ts`: `onFullSnapshot` calls `router.disconnectAllUsers(4001, "Server re-sync required")`. Sync version still advances so subsequent heartbeats resume normal delta flow.

---

## From Docker Build (2026-04-07)

### Plugin Subprocesses Need PATH and HOME
**Spec:** `spec-04-plugin-architecture.md` — "No inherited env vars." Only PLUGIN_SLUG, PLUGIN_DATA_DIR, PLUGIN_API_VERSION are set.
**Reality:** In Docker, plugin subprocesses couldn't find `bun` without `PATH`, and Bun itself needs `HOME` for its cache directory. Without these, `Bun.spawn()` fails.
**Decision:** Subprocess env now includes `PATH` and `HOME` from the parent process alongside the three spec-required vars. This is a controlled deviation — only two OS-level vars are inherited, not the full parent env. Acceptable because `PATH` and `HOME` are non-sensitive infrastructure vars required for process execution.
