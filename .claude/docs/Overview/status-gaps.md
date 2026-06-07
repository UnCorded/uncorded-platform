---
vision: "Central knows nothing beyond 'this server exists at this URL'"
tenet: "All tenets"
depends-on: [spec-04-plugin-architecture.md, spec-06-authentication.md, 09-websocket-protocol.md, spec-22-core-module.md]
last-verified: 2026-04-19
---

# 23 — Known Gaps and Technical Debt

*Confirmed issues that are documented here rather than fixed immediately — either because they require a spec pass before touching, need broader architectural work, or are deferred to a later phase. Each entry has a severity, a description, and a resolution path.*

*Issues that were confirmed bugs and immediately fixed are NOT listed here — see commit history.*

---

## Deferred by design

### D3 — `sdk.core.listMembers()` not exposed to plugin subprocesses — **DEFERRED (YAGNI)**
**Closed:** 2026-04-16 as deferred; no Phase 1 caller.  
**Finding:** Verification during batch-2 hardening surfaced that the gap is larger than originally written. Two halves were missing: (1) `handleCoreIpc` has no `core.member.list` branch, and (2) `@uncorded/plugin-sdk` has no `sdk.core.listMembers()` method at all — zero matches in the package source. The spec (`spec-22-core-module.md`) promised the SDK method; the implementation never landed in either tier.  
**Who still works:** The shell members UI (`apps/website/src/components/server/server-settings-sheet.tsx`) uses the WS-client path `request(serverId, "core", "core.member.list", {})`, which hits `handleCoreClientAction` — already implemented, unchanged, works today.  
**Resolution:** Marked as deferred in `spec-22-core-module.md:319` rather than implementing speculatively. A plugin that later needs member listing should land the SDK method and the `handleCoreIpc` branch in the same commit so the two tiers stay in lockstep (avoids the "SDK method exists but always errors at runtime" failure mode). Until then, the WS-client path covers the only real caller.

---

## Recently closed

Kept here as a short audit trail — the commits are authoritative. Remove an entry once the next major doc pass rolls around.

### Closed 2026-04-19 (Phase 1 sweep)
- **G1** banChecker uncaught throw in WS auth path — wrapped in try/catch, fail closed with structured log (`82315f4`).
- **G2** `"core"` / `"admin"` not reserved plugin slugs — rejected in `resolvePlugins` before manifest read (`55f8108`).
- **G3** wildcard CORS on authenticated HTTP endpoints — introduced `settings.allowed_origins` and a `corsAuth` route flag; dispatcher echoes Origin only on allowlist match (`82315f4`).
- **G4** `ownership.transferred` delta did not invalidate former owner's sessions — added `router.disconnectFormerOwner` and wired it into the delta handler (`55f8108`).
- **G6** `max_connections` parsed but not enforced — WS upgrade now rejects with 503 + Retry-After once the cap is reached (`e95de55`).
- **G12** manifest validator rejected `permissions: []` — allowed; frontend-only plugins are a legitimate case (`5360626`).
- **G13** `sidebar.section` silently stripped — added to `ManifestSidebar`, validated, threaded through `handlePluginSidebar` as a per-plugin default (`5360626`).
- **IPC EPIPE** — Bun FileSink `flush()` / `end()` returned promises whose rejections escaped the surrounding try/catch; test teardown logged "Unhandled error between tests" (surfaced during the threads implementation session). Attached `.catch` to both sites and added an `unhandledRejection` guard in the test suite (`b5b83d4`).

### Closed earlier
- **G5** JTI revocation set not pruned on a timer — periodic `setInterval` in `main.ts:868` prunes every 10 min independent of delta traffic.
- **G7** `http.fetch` capability dispatch missing — `handleHttpFetch` in `runtime/src/ipc/handlers.ts` and `sdk.fetch()` in `packages/plugin-sdk/src/fetch.ts`; host validation, forbidden header strip (Host/Cookie/Authorization), `redirect: "manual"`, 30s timeout, 10 MB body cap.
- **G8** `PLUGIN_DATA_DIR` env var missing on subprocess spawn — set at `runtime/src/subprocess.ts:203`.
- **G9** frontend plugin SDK missing — shipped as `packages/plugin-sdk-frontend/` (`plugin.ts`, `handshake.ts`, `request.ts`, `events.ts`, `global.ts`, `types.ts`).
- **G10** `uncorded.navigate` postMessage used text-channels-specific field names — shell now sends `itemId` / `itemLabel`; the frontend SDK accepts both old and new names for a transition period.
- **G11** capability-denied IPC response routed as `{ type: "error" }` but SDK only handled `{ type: "response" }` — runtime now sends `{ type: "response", error }` consistently (`router.ts:534–540`); SDK correlator handles it.
- **G14** IPC transport and WS outbound broadcasts had no size cap — 4 MB per-line transport cap in both directions, 1 MB WS broadcast cap, pre-encoded buffer reuse on fan-out, `RESPONSE_TOO_LARGE` / `PAYLOAD_TOO_LARGE` typed errors to plugins.
- **D1** core IPC action names in spec-22 drifted from code — spec table rewritten to use the code's `core.member.list` / `core.ban.{create,delete,list}` / `core.audit.list` (2026-04-19 vault pass).
- **D2** moderator level listed as 50 in spec-22 but 60 in code — spec table corrected to 60 (2026-04-19 vault pass).
- **D4** `HeartbeatResponse.public_keys` typed as `string[]` — type is `readonly PublicKeyEntry[]` (`runtime/src/heartbeat/types.ts:84`); no runtime cast required.
