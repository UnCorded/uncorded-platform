---
title: PR-VR — Voice External Reachability Probe + UI
spec: spec-24-voice.md (Amendments A, B, C)
last-updated: 2026-05-06
phases: [VR1, VR2, VR3, VR4]
---

# PR-VR — Voice External Reachability

Implements Amendment A of `spec-24-voice.md`. Closes the silent-failure mode where voice channels appear ready but media never flows because RTC ports are unreachable from the internet (new home, new VPS, new router, no port forward).

## Architecture (1-page summary)

```
                  ┌────────────── runtime (in container) ────────────────┐
                  │                                                       │
  voice supervisor│ reachability.ts (state machine + cache)              │
   livekit alive ─┼─►  triggers: boot+5s, WAN-IP delta, ICE-fail cluster │
                  │           manual /admin/api/voice/probe              │
                  │                       │                               │
                  │              POST /v1/servers/:id/voice/probe        │
                  │                       │                               │
                  └───────────────────────┼───────────────────────────────┘
                                          │
                                          ▼
                  ┌─────────── Central ────────────────────┐
                  │ voice-probe.ts                          │
                  │   target = last cf-connecting-ip        │
                  │   parallel:                             │
                  │     net.connect(wan, 7881, t=5s)        │
                  │     stunBinding(wan, 3478, t=5s)        │
                  │   persist to servers.voice_reachability │
                  │   rate limit 1/min/server               │
                  └────────────────────┬────────────────────┘
                                       │ result
                                       ▼
                            runtime caches + publishes
                          runtime.voice.reachability.changed
                                       │
                                       ▼
            voice-channels plugin → dimmed UI / modal / Test again button
```

## Files touched (full paths)

### PR-VR1 — Central probe service

**New:**
- `platform/apps/central/src/routes/voice-probe.ts`
- `platform/apps/central/src/routes/voice-probe.test.ts`
- `platform/apps/central/src/probe/tcp-probe.ts`
- `platform/apps/central/src/probe/stun-probe.ts`
- `platform/apps/central/src/probe/types.ts`
- `platform/apps/central/migrations/004-voice-reachability.ts`

**Modified:**
- `platform/apps/central/src/routes.ts` — register `POST /v1/servers/:id/voice/probe`
- `platform/apps/central/src/middleware.ts` — add `RATE_VOICE_PROBE` (60s cooldown, 1 token, 1/60s refill)
- `platform/apps/central/src/routes/heartbeat.ts` — capture `cf-connecting-ip` into `servers.last_heartbeat_ip`; echo `wan_ip` in response
- `platform/apps/central/migrations/` — new migration adds columns: `last_heartbeat_ip TEXT`, `voice_reachability JSONB`, `voice_reachability_checked_at TIMESTAMPTZ`

**DB schema:**

```sql
ALTER TABLE servers
  ADD COLUMN last_heartbeat_ip       TEXT,
  ADD COLUMN voice_reachability      JSONB,
  ADD COLUMN voice_reachability_checked_at TIMESTAMPTZ;
```

**Probe contract (`platform/apps/central/src/probe/types.ts`):**

```ts
// Central → runtime. One probe = one snapshot. Never "checking".
export interface VoiceProbeResult {
  status: "ready" | "unreachable";
  checkedAt: string;                  // ISO8601
  wanIp: string;
  rtcTcp: PortGroupResult;
  rtcUdp: PortGroupResult;
}
export interface PortGroupResult {
  reachable: boolean;
  latencyMs: number | null;
  error: string | null;     // human-readable error code, e.g. "ETIMEDOUT", "ECONNREFUSED", "STUN_TIMEOUT"
}
```

The runtime-side `VoiceReachabilityState` (a discriminated union including `checking`) lives in `platform/runtime/src/voice/reachability.ts` and is built on top of `VoiceProbeResult`. See spec-24 Amendment A1 for the full type.

**Refusal contract (returns `400`):**
- Target IP parses as RFC1918 / loopback / link-local / CGNAT (100.64.0.0/10) / multicast / unspecified
- `last_heartbeat_ip` is null OR `last_heartbeat_at` older than 6 hours

**Tests (`voice-probe.test.ts`):**
- happy-path TCP+UDP both reachable → status "ready"
- TCP only reachable → status "ready", rtcUdp.reachable=false
- UDP only reachable → status "ready", rtcTcp.reachable=false
- Both fail → status "unreachable"
- IP refusal: 192.168.x, 127.x, 169.254.x, 100.64.x → 400 with code "private_target"
- No recent heartbeat → 400 with code "no_recent_heartbeat"
- Per-server cooldown: 2nd probe within 60s returns 429 with `Retry-After`
- Auth: missing/invalid server_secret → 401
- Result is persisted to `servers.voice_reachability`

**Test infra:**
- `voice-probe.test.ts` uses `node:net` `createServer` to mock LiveKit on 7881 (+ a UDP socket replying to STUN binding requests on a probed port). Tests bind ephemeral ports and pass `targetPortOverrides` into the probe module.
- The probe module accepts `{ tcpPort, udpPort }` injection via test-only options to avoid hardcoding 7881/50000 in tests.

**Perf budgets:**
- Probe total wall-clock ≤ 10s p99 (5s timeout × 2 in parallel)
- Heartbeat handler additional latency from `last_heartbeat_ip` write ≤ 2ms p99 (single SQL UPDATE column add to existing query)

**Done when:**
- `bun test apps/central/src/routes/voice-probe.test.ts` green
- `bun test apps/central/src/routes/heartbeat.test.ts` green (with new `wan_ip` echo + IP capture asserted)
- `bun typecheck` green
- Manual smoke: `curl -X POST -H 'x-server-secret: ...' http://localhost:4000/v1/servers/$ID/voice/probe` against the live test server returns the expected result for the current router state

### PR-VR2 — Runtime reachability state machine

**New:**
- `platform/runtime/src/voice/reachability.ts`
- `platform/runtime/src/voice/reachability.test.ts`

**Modified:**
- `platform/runtime/src/voice/supervisor.ts` — emit `ready` lifecycle hook the reachability module subscribes to (not the supervisor's job to call probe; one-way notify)
- `platform/runtime/src/voice/webhook.ts` — track `participant_joined` events for ICE-failure-cluster heuristic
- `platform/runtime/src/voice/ipc.ts` — expose `voice.reachability.get()` to plugins (read-only) and `voice.reachability.requestProbe()` (capability-gated, owner-only)
- `platform/runtime/src/heartbeat/client.ts` — read `wan_ip` from heartbeat response, fire callback on delta
- `platform/runtime/src/heartbeat/types.ts` — extend `HeartbeatResponse` with `wan_ip?: string`
- `platform/runtime/src/main.ts` — wire `reachability.start({ centralUrl, serverSecret, voiceSupervisor, heartbeatClient, eventBus })` after voice activation
- `platform/runtime/src/http/handler.ts` — extend `/health/voice` with `externalReachability`; add `POST /admin/api/voice/probe` route
- `platform/runtime/src/http/types.ts` — extend `VoiceHealth` with `externalReachability` (mirror Amendment A1)
- `platform/runtime/src/voice/supervisor.ts` — `health()` reads reachability cache and merges into return value
- `platform/runtime/src/core/migrations/013_create_voice_reachability_state.sql` — new SQL migration creating a single-row table:

```sql
CREATE TABLE IF NOT EXISTS voice_reachability_state (
  id              INTEGER PRIMARY KEY CHECK (id = 1),  -- single-row enforced
  status          TEXT    NOT NULL,
  checked_at      INTEGER NOT NULL,
  wan_ip          TEXT    NOT NULL,
  rtc_tcp_json    TEXT    NOT NULL,
  rtc_udp_json    TEXT    NOT NULL
);
```

(SQLite, single-row; runtime is per-server so we don't need server_id. Picked up by `CoreModule.initialize()` via the existing `runMigrations` glob in `platform/runtime/src/core/module.ts:90` — same path as the LiveKit secret table at `010_create_voice_config.sql`. No new wiring required.)

**State machine (`reachability.ts`):**

Internally the module tracks a richer state than the public `VoiceReachabilityState` (see spec-24 A1 for the public union). The internal state adds `idle` (pre-activation) and `cooldown` (post-probe lockout):

```ts
type InternalState =
  | { phase: "idle" }                                            // voice not activated yet
  | { phase: "checking"; startedAt: number; lastResult: VoiceProbeResult | null }
  | { phase: "settled"; result: VoiceProbeResult }
  | { phase: "cooldown"; until: number; result: VoiceProbeResult };
```

The public `voice.reachability.get()` projects this to the spec's `VoiceReachabilityState | null`:
- `idle` → `null`
- `checking` → `{ status: "checking", lastResult }`
- `settled` / `cooldown` → `{ status: result.status, result }`

Triggers map to `requestProbe(reason: "boot" | "wan_change" | "ice_cluster" | "manual")`:
- Boot trigger fires only after voice supervisor is `ready` AND first heartbeat completed (`wan_ip` known). Both gates wired through `main.ts` start sequence.
- `idle` / `settled` → `checking` → POST → on success: `settled`, persist row to `voice_reachability_state`, publish event on status delta → `cooldown` (60s)
- During `checking`, additional `requestProbe` calls noop (return current in-flight promise)
- During `cooldown`, additional non-`manual` requests skipped; `manual` rejected with rate-limit error (UI surfaces "wait Xs")

**ICE-failure-cluster heuristic (`webhook.ts`):**
- Maintain a sliding window of `participant_joined` / `participant_left` webhook events (last 10 minutes; trim on each event)
- "Failed join" = `participant_left` within 10s of the same identity's `participant_joined` AND `numParticipants: 0` at left time
- "Successful session" = a participant whose lifespan was ≥30s (we never see `connection_quality_changed` over webhooks, so this is the proxy)
- ≥3 failed joins AND zero successful sessions in any 5-minute window → fire `requestProbe("ice_cluster")`
- 5-min cooldown on this trigger specifically (separate from the 60s probe cooldown)

**Tests:**
- All four trigger types fire a probe at the right time
- Cooldown blocks redundant auto-probes; manual after cooldown elapsed succeeds
- Probe failure (Central 500) leaves prior `settled.result` in place; logs but does not transition to `unreachable`
- WAN IP delta detection: cached IP differs from heartbeat response `wan_ip` → probe; same IP → no probe
- ICE-cluster: simulate 3 quick join/leave events → probe fires; simulate 1 join + 1 long session → does not fire
- Event published only on status transition, not every probe

**Perf budgets:**
- Reachability state lookup (sync, in-memory cache) ≤ 0.1ms — `voice.reachability.get()` is hot path for sidebar render
- Heartbeat client `wan_ip` delta check ≤ 0.05ms (string compare)
- Probe call timeout 12s (10s Central budget + 2s slack)

**Done when:**
- `bun test runtime/src/voice/reachability.test.ts` green
- `bun test runtime/src/heartbeat/client.test.ts` green (new wan_ip handling)
- `bun typecheck` green
- `/health/voice` shape includes `externalReachability` after first probe (verified via curl against running container)

### PR-VR3 — voice-channels plugin UI

**New:**
- `platform/plugins/voice-channels/frontend/components/voice-channel-row.tsx` (or extend existing — TBD by current voice-channels UI structure)
- `platform/plugins/voice-channels/frontend/components/voice-setup-modal.tsx`
- `platform/plugins/voice-channels/frontend/hooks/use-voice-reachability.ts`
- `platform/plugins/voice-channels/frontend/components/voice-setup-modal.test.tsx`

**Modified:**
- `platform/plugins/voice-channels/backend/index.ts` — subscribe to `runtime.voice.reachability.changed`, broadcast to plugin's frontend channel
- `platform/plugins/voice-channels/frontend/index.tsx` — render channel rows with reachability state class
- `platform/plugins/voice-channels/frontend/styles.css` (or Tailwind classes inline) — `.voice-channel-row[data-reachability="unreachable"]` opacity-50, cursor not-allowed; `[data-reachability="checking"]` pulse animation

**UI behavior:**
- Hook `useVoiceReachability()` returns `{ status, lastChecked, result, requestProbe }` — fed by SDK event subscription + initial GET via `voice.reachability.get()`
- Channel row: `data-reachability` attribute drives styles
- Click handler: if `unreachable` AND user is owner (level ≥ 80, available from session context) → open `VoiceSetupModal`; if `checking` → no-op; otherwise → existing join flow
- Modal `Test again` button: disabled during in-flight probe; shows spinner; on response, renders per-port-group result; on full success, modal auto-dismisses 1.5s after showing "Reachable ✓"

**Modal copy** (locked verbatim per Amendment A5):
- Header: "Voice Setup Required"
- Body: "Voice ports aren't reachable from the internet. Voice signaling reaches your server through your tunnel, but voice/video media needs direct ports because tunnels can't carry it. Without direct ports, peers join but no audio flows."
- Action: "In your router or VPS firewall, forward these ports to this computer:"
  - `TCP 7881` — voice fallback (probed)
  - `UDP 3478` — voice probe + TURN/STUN responder (probed; see spec-24 Amendment C)
  - `UDP 50000` — voice media (UDP MUX, recommended; not probed because pion ICE drops cold STUN at the MUX socket)
  - `Computer's local IP: <HOST_LAN_IP>` (or fallback message)
- Per-port-group results section (after first Test again click): two rows with ✓/✗ + latency or error code
- Footer: `[Test again]` button + `[Close]` button

**Tests:**
- Channel rows render with correct `data-reachability` for each state
- Owner click on `unreachable` row opens modal; non-owner click is no-op (no modal)
- `Test again` flow: button → spinner → result rendered; cooldown error → "wait Xs" message
- Modal auto-dismiss on success transition
- Reachability change event from SDK updates UI within one tick

**Done when:**
- `bun test plugins/voice-channels/` green
- Manual smoke in dev: with router unforwarded → channels dimmed, modal shows correct ports/IP, Test again returns unreachable; forward ports + Test again → modal dismisses, channels brighten
- `bun lint` clean

### PR-VR4 — Polish + telemetry

**Modified:**
- `platform/runtime/src/voice/reachability.ts` — emit structured logs for every probe outcome (info on success, warn on transition to unreachable, debug on cooldown skip)
- `platform/apps/central/src/routes/voice-probe.ts` — emit per-server probe metrics to existing logging (count, p50/p95 latency per port group, result distribution)
- `platform/plugins/voice-channels/frontend/components/voice-setup-modal.tsx` — add a "Why this happens" expandable section (one paragraph, plain-language) for users who want depth
- Copy review pass on modal text — final wording locked here, not in PR-VR3

**Done when:**
- One-week soak in dev: zero false-positive `unreachable` events on properly-forwarded networks
- Logging present and structured per `spec-15` engineering principles
- README in `platform/plugins/voice-channels/` mentions the reachability dimming behavior

## Cross-cutting concerns

- **Privacy:** `wan_ip` shown in `/health/voice` is owner-only on `/admin/api/voice/state`. Public `/health/voice` redacts it (returns `wanIp: null` and only the `status` summary). Already covered by existing redaction in `runtime/src/http/handler.ts:737`.
- **Security:** Central probe target is server-bound (last heartbeat IP), not client-controllable. Private-IP refusal blocks probes to RFC1918 ranges in case of bad heartbeat data. Per-server cooldown bounds the resource cost.
- **Backwards-compat:** Older runtimes without reachability return `externalReachability: null` from `/health/voice`. UI treats `null` as `checking` for ≤30s after voice activation, then as `ready` (best-effort fallback — older runtimes don't have the broken-port problem at all unless ports were never opened, in which case the user already knows).
- **CGNAT:** A CGNAT-bound owner (Phase 2.5 managed-relay candidate) will probe `unreachable` and see the modal. Modal mentions "VPS firewall" so the message generalizes; the long-term answer (managed relay) is unchanged from spec.

## Open questions (to resolve before/during PR-VR1)

1. Does Bun's `node:net` socket support a clean way to assert a connection completed *handshake* vs. opened a half-open TCP slot? — verify in PR-VR1 spike before committing the `latencyMs` semantics.
2. STUN binding library: pull in `stun` from npm or implement RFC 5389 §6 by hand (~80 lines)? Hand-rolled removes a dep but adds maintenance. **Recommend hand-roll.**
3. Where to render the dimmed style — the voice-channels plugin or the shell? Plugin owns row visuals (per spec-21 sidebar model), so plugin. Confirms in PR-VR3.

## Non-goals

- Detecting *which* peer's network is broken — this probe is server-side only. A peer with their own NAT issue is a separate failure surface.
- Auto-fixing UPnP / NAT-PMP — out of scope; lots of routers disable both by default and we don't want to silently mutate router state.
- Probing the UDP MUX media port (50000) directly — pion ICE drops cold STUN Binding Requests at the MUX socket (USERNAME-required dispatch), so the probe targets LiveKit's embedded TURN STUN responder on UDP 3478. See spec-24 Amendment C.
