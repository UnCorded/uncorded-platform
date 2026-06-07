---
vision: "Central knows nothing beyond 'this server exists at this URL'"
tenet: "Every feature is a choice"
depends-on: [spec-04-plugin-architecture, spec-06-authentication, spec-21-sidebar-model, spec-22-core-module, spec-23-scoped-presence]
last-verified: 2026-04-26
---

# 24 — Voice Channels

*Real-time voice + screenshare with Discord-parity feel. LiveKit SFU bundled in the runtime image, dormant until a voice-capable plugin is installed. Runtime owns auth, permissions, and lifecycle; LiveKit owns media; plugins own UX.*

---

## Why This Exists

UnCorded is a chat platform with plugin claims until voice ships. Voice is table-stakes for the homelab + gaming audience and the gating feature for the public-server-directory phase.

A pure-plugin model for voice does not work: media servers are not ordinary plugin code. SFU lifecycle, TURN, token minting, server bans bridging, and resource ownership are infrastructure-level concerns that must be runtime-mediated. A pure-runtime model fails the other way: it sentences every UnCorded server to ship LiveKit weight whether or not anyone wants voice.

The shape is **optional core capability + plugin-owned experience**. The runtime always ships the voice control plane (auth, token minting, permissions, supervision). The voice media plane (LiveKit process, ports, TURN) is dormant in the image and only activates when a plugin declaring `voice.media` is installed. UX lives in a first-party `voice-channels` plugin that mirrors `text-channels` — own sidebar slot, own SQLite, own CRUD — so the plugin model stays honest.

This spec resolves `[TBD-voice-turn-hosting]`.

---

## Locked Decisions

- **Two layers in the manifest.** Plugins declare `runtime_capabilities` (abstract — `voice.media`) and `managed_services` (concrete — `livekit`). The runtime keys the install/activation flow off the capability; the service field is how the runtime picks a provider. A future second provider does not break existing plugins.
- **LiveKit baked into the runtime image, supervised as a child process.** Always present, never started until activated. No Docker-in-Docker, no separate download/signature pipeline, no compose stack. The runtime starts/stops LiveKit, generates its config, owns its API secret.
- **Voice is not a plugin subprocess.** The voice media plane runs as a runtime-supervised native process, not as a plugin under the IPC contract. Plugins consume voice through `sdk.voice.*`.
- **Self-host default; optional managed relay (Phase 2.5).** Default deployment is owner-hosted LiveKit + bundled TURN on TCP/443. CGNAT-bound owners can opt into an UnCorded-operated or third-party TURN relay with explicit consent ("voice media may transit UnCorded infrastructure"). The relay is *not* part of Phase 2 voice ship.
- **Activation requires a container recreate.** Container port mappings cannot be added at runtime. When the owner enables voice, the desktop recreates the runtime container with the voice ports bound. One-time disruption; documented in the install flow.
- **LiveKit signaling is direct, not proxied through the UnCorded WS.** Clients open a LiveKit signaling connection directly to the LiveKit endpoint on the server. The UnCorded `/ws` carries channel state, presence, mute/kick events — not media signaling. (This revises the earlier "signaling over existing WebSocket" line in `spec-17`.)
- **Auth bridge: runtime mints LiveKit JWTs.** Client requests a join token via `sdk.request("voice.join", { channelId })`. The voice plugin authorizes (role check, channel exists, not banned) and calls `sdk.voice.createJoinToken`. The runtime checks role/ban state again at the bridge boundary, then signs a short-lived LiveKit JWT scoped to room `server:<id>:voice:<channelId>` with the user's identity and publish/subscribe permissions.
- **Token TTL: short with auto-refresh.** 5–10 minute LiveKit join tokens. Client refreshes via the runtime before expiry. Banning a user takes effect on the next refresh, with the runtime additionally calling `sdk.voice.disconnectUser` immediately on `core.moderation.banned`.
- **LiveKit API secret is server-local.** Generated at first voice activation, stored in `core.db` (encrypted at rest with the existing per-server key) and never sent to Central. Rotatable from the admin panel. Plugins never see the raw secret — only the bridge mints tokens.
- **Auto-create rooms.** First join to a channel creates the LiveKit room with config from the plugin's `roomConfig` argument. Last user leaving deletes the room. Plugins do not own room lifecycle directly; they own channel records and pass config through `createJoinToken`.
- **Categories live in core.** A new `categories` table in the Core Module is referenced by both `text-channels.channels.category_id` and `voice-channels.channels.category_id`. CRUD + reorder + the `core.categories.manage` permission are in Core. This locks Discord-style mixed channel lists without coupling the two plugins.
- **Channel creation is admin-only by default.** The voice plugin declares a `voice.channels.create` permission gated by Core's role system. Default-granted to roles `owner` and `admin` (level ≥ 80). Owners can grant the permission to any role.
- **No recording in v1.** LiveKit Egress is not bundled. Recording is a future separate plugin requesting a `voice.recording` capability. Future recording plugins must check the per-room E2EE flag and refuse to record E2EE rooms.
- **Per-room E2EE toggle.** Voice channels carry an `e2ee` boolean. When set, the LiveKit room is created with end-to-end encryption — the SFU relays only encrypted streams; the server owner cannot decrypt. Mute/kick/ban (control plane) still work. Recording/transcription/AI plugins must refuse on E2EE rooms.
- **Voice + screenshare ship together.** Screenshare is a track-type publish on the same LiveKit room and same auth path. Plugin UI exposes the picker; runtime bridge requires no changes beyond track-type permission flags in the join token.
- **Marketplace is the install entry point.** Voice does not get a dedicated "Enable Voice" toggle in server settings. Owner installs the `voice-channels` plugin from the marketplace; the desktop detects the `voice.media` capability and triggers the consent + setup flow. Activation feels first-class because of the flow, not because the surface is special.
- **Failure handling.** LiveKit child process is auto-restarted with exponential backoff; after N failures (5, configurable) voice is reported as unhealthy and channels grey out in the sidebar with "Voice temporarily unavailable." Voice health is exposed at `/health/voice` separate from the main `/health` probe.

---

## What Voice Is Not

- **Not a generic plugin.** Plugins cannot start their own SFU, hold their own LiveKit secret, or mint media tokens. The runtime is the only token issuer.
- **Not part of Central.** Central does not hold LiveKit secrets, does not relay media (until and unless the optional Phase 2.5 relay ships under explicit consent), and does not see voice telemetry beyond "voice subsystem reports healthy/unhealthy" via the existing heartbeat.
- **Not a Cloudflare-Tunnel feature.** WebRTC is UDP-first; CF Tunnel does not carry UDP. Owners enabling voice open real ports (or accept the relay path). This is the deployment-shape change Phase 2 voice introduces.
- **Not a chat replacement.** Text channels remain a separate plugin. Voice and text share categories (Core) but not data, schemas, or sidebar slots.
- **Not E2EE by default.** E2EE is an opt-in per-room flag for owners with a privacy requirement. Default is off — server-side capability features (future transcription, captions, AI) need decrypted media.

---

## Plane Separation

```
Client (web/desktop)
  ├─ UnCorded WS  ──────────────►  Runtime
  │                                 ├─ /voice/token, /voice/health
  │                                 ├─ permission checks (Core)
  │                                 ├─ token minting (LiveKit JWT)
  │                                 ├─ moderation bridge (mute/kick/ban → SFU)
  │                                 └─ supervises ↓
  │                                              LiveKit child process
  └─ LiveKit signaling + media  ──────────────►  (UDP/TCP, on activation only)
```

The UnCorded WS carries plugin RPC, broadcast events, and presence. The LiveKit connection carries media signaling and (via TURN/UDP/TCP) media itself. They never cross. Auth is bridged: the client uses its UnCorded JWT to ask for a LiveKit JWT.

---

## Manifest Contract

A plugin requesting voice declares:

```json
{
  "name": "voice-channels",
  "type": "core",
  "requires": {
    "runtime_capabilities": ["voice.media"],
    "managed_services": ["livekit"]
  },
  "permissions": [
    "voice.rooms:self",
    "voice.tokens:self",
    "voice.moderation:self",
    "voice.channels.create"
  ]
}
```

- `runtime_capabilities`: abstract capabilities the plugin requires the runtime to provide. The runtime keys activation logic off this list. Voice's capability is `voice.media`.
- `managed_services`: concrete service implementations the runtime should manage on the plugin's behalf. The runtime maps `livekit` to its bundled LiveKit supervisor.
- `permissions`: per-spec-04, capability strings the plugin requests at install. `voice.rooms:self`, `voice.tokens:self`, `voice.moderation:self` are namespaced under the plugin's own scope. `voice.channels.create` is a Core role permission.

On install the desktop detects the `voice.media` capability and runs the activation flow before the plugin's first start.

---

## Activation Flow

1. Owner installs `voice-channels` (or any plugin declaring `voice.media`) from the marketplace.
2. Desktop reads the manifest, sees `voice.media`, queries the runtime for current voice state — if voice is already activated, skip to step 8.
3. Desktop shows the activation consent screen:
   - Required ports list (signaling TCP, RTC UDP range, optional TURN/443)
   - Bandwidth caveats (residential upload ceiling)
   - Self-host vs managed-relay choice (Phase 2.5: relay option appears greyed-out as "Coming soon" with the consent string drafted but inactive)
4. Owner confirms. Desktop persists the choice (`voice.activated = true`, `voice.relay_mode = self_host | managed`) in the server registry.
5. Desktop stops the runtime container.
6. Desktop recreates the container with the voice port bindings added to the `docker run` command.
7. On boot, the runtime sees `voice.activated`, generates the LiveKit API key/secret pair (random, 256-bit), writes config to `/config/voice/livekit.yaml`, starts the LiveKit child process, and brings the voice subsystem online.
8. Plugin starts. `sdk.voice.*` is now callable; `voice-channels` registers its sidebar slot and channel CRUD.

Disabling voice is the inverse: plugin uninstall → runtime supervisor signals LiveKit to drain → container recreate without voice ports → secret retained for re-activation unless explicitly rotated.

---

## Backend SDK Surface

`sdk.voice.*` is the runtime's bridge API. Available only to plugins declaring `voice.rooms:self`, `voice.tokens:self`, or `voice.moderation:self` (per-method capability gating).

```ts
interface VoiceApi {
  /**
   * Mint a short-lived LiveKit join token for a user joining a channel.
   * Auto-creates the LiveKit room on first call with the supplied config.
   * Subsequent calls for the same channel ignore roomConfig — room already exists.
   * Caller must run its own ACL check before calling.
   * Capability: voice.tokens:self
   */
  createJoinToken(input: {
    channelId: string;
    userId: string;
    canPublish?: boolean;
    canPublishData?: boolean;
    canSubscribe?: boolean;
    roomConfig?: VoiceRoomConfig;
  }): Promise<{ token: string; livekitUrl: string; expiresAt: number }>;

  /**
   * Update room config for an existing channel. If the room is currently active,
   * config takes effect on next room recreate (when last user leaves and rejoins).
   * Capability: voice.rooms:self
   */
  updateRoomConfig(input: { channelId: string; roomConfig: Partial<VoiceRoomConfig> }): Promise<void>;

  /**
   * Mute a user in a channel. Server-enforced — the user's published audio track
   * is muted at the SFU. Survives client reconnects until unmute or session end.
   * Capability: voice.moderation:self
   */
  muteUser(input: { channelId: string; userId: string }): Promise<void>;
  unmuteUser(input: { channelId: string; userId: string }): Promise<void>;

  /**
   * Forcibly disconnect a user from a channel. Used by the ban cascade and
   * by the plugin's own kick UX.
   * Capability: voice.moderation:self
   */
  disconnectUser(input: { channelId: string; userId: string; reason?: string }): Promise<void>;

  /**
   * Returns voice subsystem health. Wraps /health/voice.
   * Capability: none (read-only health)
   */
  getHealth(): Promise<VoiceHealth>;
}

interface VoiceRoomConfig {
  bitrateKbps?: number;          // default 64
  maxParticipants?: number;      // default 25, hard cap 99
  videoMaxResolution?: "480p" | "720p" | "1080p";  // default "720p"
  videoMaxFramerate?: 15 | 24 | 30 | 60;            // default 30
  e2ee?: boolean;                // default false
}

interface VoiceHealth {
  status: "ready" | "starting" | "degraded" | "unhealthy" | "disabled";
  livekitVersion: string | null;
  uptimeMs: number | null;
  lastError: { code: string; message: string; ts: number } | null;
  activeRooms: number;
  activeParticipants: number;
}
```

### Semantics

- **Capability gating per method.** `createJoinToken` requires `voice.tokens:self`. `muteUser` / `unmuteUser` / `disconnectUser` require `voice.moderation:self`. `updateRoomConfig` requires `voice.rooms:self`. A plugin without the capability gets a typed error at the SDK boundary.
- **Tokens carry server identity.** The minted JWT's `iss` is the LiveKit API key (LiveKit looks up the matching secret by `iss`, so this field is fixed by the SFU's verification protocol — see [PR-4 voice contract](./pr-4-voice-contract.md) for the full claim shape). Cross-server isolation comes from each server having its own apiKey/apiSecret pair: a token signed by server A's secret will not validate against server B's secret. The `video.room` claim is `server:<server-id>:voice:<channel-id>`. The `sub` claim is the bare UnCorded user ID.
- **Auto-room creation, auto-deletion.** First `createJoinToken` for a channel creates the LiveKit room. The runtime tracks active participant counts via LiveKit webhooks; when the count hits zero, the room is destroyed. Stale rooms are GC'd every 5 minutes as a safety net.
- **Mute is server-enforced.** `muteUser` writes server-side track permissions to LiveKit, not a client request. The user's audio publish track is force-muted at the SFU until `unmuteUser` is called or their session ends.
- **Ban cascade.** The runtime voice bridge subscribes to `core.moderation.banned` (and `core.moderation.unbanned` to short-circuit pending kick rows) from the Core Module — see [spec-22 §Event Topics](./spec-22-core-module.md) for payload shapes — and calls `disconnectUser` for every active room the banned user is in. Plugins do not need to wire this themselves.

---

## Wire Events

The runtime publishes voice-related events on the standard event bus under the reserved `runtime.*` namespace. `voice-channels` and any future voice-capable plugin subscribe via `sdk.events.subscribe`.

| Topic | Payload | When |
|---|---|---|
| `runtime.voice.participant.joined` | `{ channelId, userId, sessionId, ts }` | A user successfully connects to a LiveKit room |
| `runtime.voice.participant.left` | `{ channelId, userId, sessionId, reason, ts }` | A user disconnects (`reason ∈ {explicit, server_kick, server_ban, network, room_destroyed}`) |
| `runtime.voice.participant.muted` | `{ channelId, userId, mutedBy, ts }` | Server-side mute applied |
| `runtime.voice.participant.unmuted` | `{ channelId, userId, unmutedBy, ts }` | Server-side mute removed |
| `runtime.voice.room.created` | `{ channelId, config, ts }` | LiveKit room was created |
| `runtime.voice.room.destroyed` | `{ channelId, ts }` | LiveKit room was destroyed |
| `runtime.voice.health.changed` | `{ status, lastError?, ts }` | Voice subsystem status transitioned |

Plugins use these to drive UI updates (occupancy badges, speaker indicators, mute icons). Per spec-23 conventions, occupancy can also be modeled as a scoped presence at `voice-channels.channel.<id>.occupants` for per-user metadata like `{ muted, deafened, speaking, screen_sharing }`, with the plugin updating it from these events.

---

## HTTP Surface

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /health/voice` | none | Voice subsystem health JSON (mirrors `VoiceHealth`). Separate from `/health` to avoid voice flakiness failing the runtime probe. |
| `GET /admin/api/voice/state` | owner JWT | Activation status, relay mode, secret rotation timestamp, port bindings. |
| `POST /admin/api/voice/rotate-secret` | owner JWT | Generates a fresh LiveKit API secret; existing tokens become invalid; live participants are kicked. |
| `POST /admin/api/voice/restart` | owner JWT | Force restart the LiveKit child process. |

LiveKit's own ports (signaling/media/TURN) are exposed at the OS level on activation; they do not pass through the runtime's HTTP server.

---

## Frontend SDK

No additions. Voice clients use the standard plugin RPC + LiveKit web SDK directly:

- Plugin requests `sdk.request("voice.join", { channelId })` → backend calls `sdk.voice.createJoinToken` → returns `{ token, livekitUrl }` → client connects to `livekitUrl` with `token` using `livekit-client`.
- Plugin observes `sdk.on("voice.participant.joined", handler)` etc. — broadcast events the plugin's backend fans out from the `runtime.voice.*` topics with `sdk.broadcast.toUsers()`.

Backend-owned ACL is preserved: every voice event a client sees has been authorized by the plugin's broadcast call.

---

## Bounds and Limits

| Bound | Value | Notes |
|---|---|---|
| Token TTL | 5 minutes (300s) | Refresh window: client refreshes at 60s remaining. Server-side ban revocation propagates within one TTL. |
| Max participants per room | 99 hard, 25 default | Discord parity ceiling, default reflects residential upload reality. Owners override per channel. |
| Max rooms per server | 200 | Sanity ceiling. |
| Audio bitrate range | 8–256 kbps | Default 64 kbps. |
| LiveKit restart backoff | 1s, 2s, 4s, 8s, 16s | Linear cap at 16s after 5 failures; voice marked unhealthy. |
| Rate limit on `createJoinToken` | 10/sec/user | DoS guard — a single user spamming join is bounded. |
| Rate limit on moderation calls | 30/sec/server | Mute/kick/disconnect aggregate per server. |

---

## Failure Modes

- **LiveKit fails to start.** Health reports `unhealthy`; activation flow surfaces the error to the owner; voice channels grey out in the sidebar with "Voice unavailable — see admin panel."
- **LiveKit crashes mid-session.** Auto-restart with backoff. Active sessions are dropped (LiveKit clients reconnect automatically once the SFU is back). The runtime emits `runtime.voice.health.changed` so plugins can show degraded state.
- **Container recreate fails during activation.** Desktop rolls back to pre-activation state; plugin install is reverted; owner sees a clear error.
- **Owner rotates the LiveKit secret.** All live tokens become invalid; LiveKit rejects them; clients receive auth failures and surface "Voice session expired — rejoin." Documented behavior, not a regression.
- **CGNAT-bound owner without relay.** Owners self-hosting on CGNAT see voice activate (ports bind locally) but external participants cannot connect. Diagnostics in `/admin/api/voice/state` flag "external reachability unverified" until at least one external participant successfully connects. Phase 2.5 relay path resolves this.

---

## Phase Scope

| Feature | Phase |
|---|---|
| LiveKit baked in runtime image | Phase 2 |
| `runtime/src/voice/` supervisor + bridge | Phase 2 |
| `sdk.voice.*` API surface | Phase 2 |
| `runtime.voice.*` event topics | Phase 2 |
| Categories table in Core Module | Phase 2 |
| `voice-channels` core plugin (sidebar, CRUD, join UX, screenshare) | Phase 2 |
| Per-room E2EE flag | Phase 2 |
| `text-channels` migration to use Core categories | Phase 2 |
| Bundled TURN on TCP/443 | Phase 2 |
| `/health/voice` + admin voice state endpoints | Phase 2 |
| Managed relay (UnCorded-operated or third-party) | Phase 2.5 |
| Voice recording (separate `voice-recording` plugin) | Phase 3+ |
| Server-side transcription / captions / AI features | Phase 3+ |

---

## Future Refinements

### Managed relay (Phase 2.5)
- **What changes:** UnCorded operates a TURN relay (or contracts a third-party). Owners enabling voice can pick `relay_mode: managed` at activation; clients route media through the relay when self-host TURN fails.
- **Why not now:** The relay infrastructure is operational complexity orthogonal to voice itself; ship voice working for the port-forwardable majority first, then add the escape hatch.
- **What today's code must not do:** The activation flow already surfaces the relay choice as "Coming soon"; do not hardwire `self_host` as the only valid `relay_mode` value. The DB column accepts `self_host | managed | third_party` from day one.

### Recording (`voice-recording` plugin)
- **What changes:** A separate plugin requests a `voice.recording` capability. The runtime starts LiveKit Egress on demand. Recordings are written to a configurable storage backend (initially the runtime's `/data` volume; later S3/R2 with the file plugin's storage adapter).
- **Why not now:** Recording is a different consent surface (laws vary by jurisdiction), a different storage surface, and a different retention surface. Do not couple it to voice v1.
- **What today's code must not do:** Reserve `voice.recording` in the capability namespace. Do not let v1 voice plugins claim it.

### Server-side transcription / captions / AI
- **What changes:** A capability like `voice.media.read` lets a plugin subscribe to decrypted audio frames for transcription, captions, or AI features.
- **Why not now:** No first consumer exists; the subscriber API surface should be designed against a real plugin, not a hypothesis.
- **What today's code must not do:** E2EE rooms must remain unsubscribable to such future plugins. The `e2ee` flag is a hard contract.

### Voice region / multi-SFU
- **What changes:** Owners with very large servers might want a sharded SFU or geographically distributed media plane.
- **Why not now:** A single-node LiveKit handles 200+ participants; Phase 2 audience does not need sharding.
- **What today's code must not do:** Do not assume a single LiveKit URL per server in any data structure that could later be sharded — the join-token response carries a `livekitUrl` for a reason.

---

## Relationship to Other Docs

- `spec-04-plugin-architecture.md` — capability grammar, manifest schema, event bus reserved namespace, slug auto-prefixing
- `spec-06-authentication.md` — server JWT (the input to the auth bridge), session identity, ban cascade events
- `spec-17-phased-build-plan.md` — voice as a Phase 2 deliverable; the line "signaling over the existing WebSocket" is revised by this spec
- `spec-21-sidebar-model.md` — voice plugin claims a sidebar slot the same way text-channels does
- `spec-22-core-module.md` — categories table lives here; ban cascade events come from here; LiveKit secret encrypted with the per-server key
- `spec-23-scoped-presence.md` — voice channel occupancy modeled as a presence scope; speaker/mute/screen-sharing state in `meta`

---

## Resolves

- `[TBD-voice-turn-hosting]` — resolved as: self-host default with bundled TURN on TCP/443; managed relay deferred to Phase 2.5 under explicit consent.

---

## Amendment A (2026-05-05 — applies in PR-VR1..VR4)

The §Failure Modes line "Diagnostics in `/admin/api/voice/state` flag 'external reachability unverified' until at least one external participant successfully connects" is upgraded from a passive diagnostic to an active state machine with a user-facing affordance. Motivation: an owner moving the runtime to a new home network, new PC, or new VPS sees voice channels lit but media silently fails at ICE — the failure is invisible until a peer tries to join. This amendment makes reachability explicit and self-correcting.

### A1. New `externalReachability` field on `VoiceHealth`

Two types: a Central-produced `VoiceProbeResult` (one snapshot, never `checking`) and a runtime/UI-facing `VoiceReachabilityState` that wraps the snapshot with a transient `checking` state and a never-probed sentinel.

`/health/voice` adds a sibling to `status`:

```ts
interface VoiceHealth {
  status: "ready" | "starting" | "degraded" | "unhealthy" | "disabled";
  livekitVersion: string | null;
  uptimeMs: number | null;
  lastError: { code: string; ts: string } | null;
  activeRooms: number;
  activeParticipants: number;
  // Amendment A — null until the runtime has published its first reachability state.
  externalReachability: VoiceReachabilityState | null;
}

// Central → runtime. Always a complete snapshot of one probe.
interface VoiceProbeResult {
  status: "ready" | "unreachable";
  checkedAt: string;                  // ISO8601
  wanIp: string;
  rtcTcp: PortGroupResult;
  rtcUdp: PortGroupResult;
}
interface PortGroupResult {
  reachable: boolean;
  latencyMs: number | null;
  error: string | null;               // e.g. "ETIMEDOUT", "ECONNREFUSED", "STUN_TIMEOUT"
}

// Runtime cache + UI feed. "checking" is a transient state during a probe in flight.
type VoiceReachabilityState =
  | { status: "checking"; lastResult: VoiceProbeResult | null }   // probe in flight; lastResult is the prior snapshot
  | { status: "ready"; result: VoiceProbeResult }
  | { status: "unreachable"; result: VoiceProbeResult };
```

Semantics: a probe yields `VoiceProbeResult.status === "ready"` iff at least one of `{rtcTcp, rtcUdp}` is `reachable: true`. LiveKit ICE selects the working path; the owner does not need both. `unreachable` means both failed. `checking` only ever exists in the runtime cache while a probe is in flight; Central never returns it.

The public `/health/voice` redaction (existing for `lastError`) extends to `externalReachability`: `error` strings on rtcTcp/rtcUdp are redacted (replaced with the error code only) and `wanIp` is replaced with `null` on the public endpoint; the full payload is owner-visible at `/admin/api/voice/state`.

### A2. Probe service (Central-side)

New endpoint:

| Endpoint | Auth | Purpose |
|---|---|---|
| `POST /v1/servers/:id/voice/probe` | `server_secret` in JSON body (matches heartbeat) | Triggers Central → runtime WAN probe. Returns `VoiceProbeResult`. Rate-limited 1/min/server (DB-backed cooldown) plus an in-process burst bucket. |

Probe target = the `cf-connecting-ip` Central recorded on the server's most recent heartbeat (already captured via `getClientIp` in `apps/central/src/middleware.ts:169`). The probe target is **not** taken from request input — clients cannot direct Central to probe arbitrary IPs.

Probe steps, parallelized, total budget ≤ 10s:

1. **TCP 7881 (RTC TCP fallback).** `net.createConnection({ host: wanIp, port: 7881, timeout: 5000 })`. Success = TCP handshake completes within timeout. `latencyMs` = handshake duration. Closed immediately after.
2. **UDP 50000 (RTC MUX port).** STUN binding request (RFC 5389 §6) to `wanIp:50000` over UDP, 3 retries with 1s spacing. With `rtc.udp_port` (UDP MUX, see Amendment B) LiveKit binds this socket at process start and answers STUN binding requests immediately, so a cold probe sees the same socket real media will use. Success = a valid binding response observed. `latencyMs` = first response RTT.

Refusal conditions (return `400 Bad Request`):
- Probed IP would be RFC1918, loopback, link-local, or CGNAT (100.64.0.0/10) — block the misconfig where Central somehow has a private source IP.
- Server has no recorded `cf-connecting-ip` from a heartbeat in the last 6 hours.

Per-server probe cooldown: 60s. Probe results are persisted on the server row (`voice_reachability_jsonb`, `voice_reachability_checked_at`) so they survive Central restarts and a re-fetch by the runtime returns last-known until the cooldown expires.

### A3. Triggers (runtime-side)

Module: `runtime/src/voice/reachability.ts` (new).

Probe runs on:

1. **Container boot.** Triggered when **both** conditions hold: voice supervisor has transitioned to `ready` AND the runtime has received at least one heartbeat response from Central (i.e. `wan_ip` is known). Scheduled one-shot ~2s after both conditions are met. Heartbeat-first ordering matters: probing before the first heartbeat means Central has no `last_heartbeat_ip` to target and would refuse with `no_recent_heartbeat`.
2. **WAN IP change.** Heartbeat response echoes `wan_ip: <cf-connecting-ip>` so the runtime can detect when its source IP has changed (laptop carried to a new network without container restart, ISP renewed lease, VPS migration). Cached locally; on delta, fire one probe.
3. **ICE failure cluster.** Maintained from the LiveKit webhook stream: a "failed join" = a `participant_left` arriving within 10s of a `participant_joined` for the same identity, with `numParticipants: 0` at left time. ≥3 failed joins and zero successful sessions (≥30s) in any 5-minute window → fire one probe. 5-min cooldown specific to this trigger so a single failure burst can't loop probes. Note: LiveKit's `connection_quality_changed` event is *not* delivered via webhooks (only over the data channel) — webhook-only trackers cannot rely on it.
4. **Manual retry.** Voice-channels modal calls runtime `POST /admin/api/voice/probe` (proxy to Central). Owner-only via existing `requireMinLevel(80)` gate.

The runtime caches the latest `VoiceReachabilityResult` in-memory; persists to `core.db` so a quick container bounce does not lose state. Restart of the LiveKit subprocess alone (without container recreate) does not reset reachability — the WAN path didn't change.

### A4. New runtime event topic

`runtime.voice.reachability.changed`, payload:

```ts
interface VoiceReachabilityChangedEvent {
  previous: VoiceReachabilityState | null;
  current: VoiceReachabilityState;
}
```

Published whenever `current.status` differs from `previous.status` (the four meaningful transitions: null → checking, checking → ready, checking → unreachable, ready ↔ unreachable). Repeated probes that confirm the prior state do not publish. Voice-channels plugin subscribes to drive UI dimming.

### A5. UI contract (voice-channels plugin)

Three rendered states for voice channel rows in the sidebar:

| `externalReachability.status` | Render |
|---|---|
| `checking` (or null & voice just activated) | Normal style + subtle pulse on channel name; click is no-op for ~5–15s |
| `ready` | Normal interactive |
| `unreachable` | 50% opacity, click opens **Voice Setup Required** modal (owner-only — non-owners see disabled state with tooltip "Voice unavailable") |

Modal copy is generic, not router-specific. Three sections:

1. **What's wrong** — "Voice ports aren't reachable from the internet."
2. **Why** — "Voice signaling reaches your server through your tunnel, but voice/video media needs direct ports because tunnels can't carry it. Without direct ports, peers join but no audio flows."
3. **What to do** — "In your router or VPS firewall, forward these ports to this computer:"
   - `TCP 7881` (voice fallback) — copyable
   - `UDP 50000` (voice media; UDP MUX per Amendment B) — copyable
   - "Computer's local IP: `<HOST_LAN_IP>`" — copyable; if `HOST_LAN_IP` is unset, show "Find your computer's local IP first (run `ipconfig` on Windows or `ifconfig` on Linux/Mac)"

Footer: **Test again** button. Calls runtime `POST /admin/api/voice/probe`, shows spinner ≤10s, then either dismisses on success or replaces the body with per-port-group results so the owner can see TCP-fixed-but-UDP-still-broken.

### A6. New HTTP routes

| Endpoint | Auth | Purpose |
|---|---|---|
| `POST /admin/api/voice/probe` (runtime) | owner JWT (level ≥ 80) | Forwards to Central probe, returns updated result. Rate-limited 1/min/server (server-side cooldown shared with auto-probes). |

`GET /admin/api/voice/state` is extended to include the latest `externalReachability` value.

### A7. What this amendment does NOT change

- `health.status` still reflects only the local LiveKit subprocess state — `ready` does not imply `externalReachability.ready`. Two independent dimensions.
- Phase 2.5 managed relay is still the long-term answer for CGNAT-bound owners. This amendment surfaces the gap; relay closes it.
- E2EE rooms are unchanged. Reachability probes do not touch room state, tokens, or content.
- The §Activation Flow consent screen is unchanged. Probing happens after activation, not as part of it.

### A8. Phase scope

PR-VR1 (Central probe service) → PR-VR2 (runtime triggers + state) → PR-VR3 (voice-channels UI + modal) → PR-VR4 (telemetry + copy polish). All Phase 2 — ships before voice GA. Tracking plan: `pr-VR-voice-reachability.md`.

## Amendment B (2026-05-06 — applies in PR-VR3.1)

Replaces the LiveKit RTC UDP port range (50000–50100) with a **single UDP MUX port** (50000). Amendment A is otherwise unchanged.

### B1. Why the change

PR-VR3 dev validation surfaced a probe failure that wasn't a router/firewall problem: the WAN UDP path was correctly forwarded by Eero and published by Docker, but Central's STUN binding probe to `wanIp:50050` consistently timed out, while a real LiveKit session against a different UDP port in the range succeeded.

Root cause: with `rtc.port_range_start/end` (LiveKit's "port range" mode), LiveKit binds UDP sockets **lazily, per session**. The kernel only listens on a given UDP port for the lifetime of an active room. Outside an active session, the entire 50000–50100 range is closed — STUN binding requests bounce off ICMP "port unreachable" or are silently dropped, depending on the host's response policy. Since the reachability probe is by design a *cold* probe (it must run before a session, on boot or on WAN change), it can never observe a bound socket in port-range mode. A2's claim that "LiveKit responds to STUN binding requests on every UDP port in its RTC range" is therefore false; it responds on every UDP port that already has a *live* session bound to it, which is zero in the cold case.

### B2. Decision

Use LiveKit's `rtc.udp_port` ("UDP MUX") mode: a single UDP socket bound at LiveKit startup, multiplexing all sessions over that one port via STUN-derived ICE candidate IDs. The port is open and answers STUN binding requests from process start, so Central's cold probe sees the same socket that real call media will use.

This trades a small amount of theoretical scaling headroom (one socket vs. one-per-session) for two concrete wins:

1. **Truthful cold probes.** The reachability probe now exercises the exact path media will use, with no "but only when a call is active" caveat. Owners who pass the probe will pass when joining a real channel; owners who fail know to fix their router *before* friends join and watch silent calls.
2. **Smaller router-config blast radius.** Owners forward one UDP port instead of 101. Less surface area for misconfig (CGNAT-bound owners forward fewer mappings; cheap routers with low NAT-table limits don't blow their budget on a range they'll never use).

LiveKit upstream documents UDP MUX as the recommended single-host configuration; port-range mode exists primarily for multi-host SFU clusters where each node owns a slice. UnCorded Phase 1/2 deployments are single-host (one runtime container per server), so the cluster motivation does not apply.

### B3. Wire changes

| Field | Before | After |
|---|---|---|
| `livekit.yaml` `rtc.port_range_start` | `50000` | *(removed)* |
| `livekit.yaml` `rtc.port_range_end`   | `50100` | *(removed)* |
| `livekit.yaml` `rtc.udp_port`         | *(absent)* | `50000` |
| `runtime` `VoicePortPlan.rtcUdpRangeStart` | `50000` | *(removed)* |
| `runtime` `VoicePortPlan.rtcUdpRangeEnd`   | `50100` | *(removed)* |
| `runtime` `VoicePortPlan.rtcUdpPort`       | *(absent)* | `50000` |
| `GET /admin/api/voice/state` `ports.rtcUdpRangeStart/End` | present | replaced with `ports.rtcUdpPort` |
| Central A2 probe target UDP port | `50050` (mid-range) | `50000` (the mux port itself) |
| Docker port publish (`apps/desktop/src/server-runtime.ts`) | `50000-50100/udp` | `50000/udp` |

The Central voice-probe still injects the UDP target via `VOICE_PROBE_UDP_PORT` for tests; only the production default changes.

### B4. UI copy changes (Amendment A5 / setup modal)

- "UDP `50000–50100` (RTP media)" → "UDP `50000` (RTP media)" (modal port row, ports-form copy, voice-channels backend comment, voice-reachability store doc-comment, nav-sidebar voice-dim explainer).
- The "Forward these ports" router-setup list still shows two rows (TCP 7881, UDP 50000) so the structure is unchanged.

### B5. Owner upgrade path

The runtime container exposes only port 50000/udp on next launch. Existing owners have a router rule for `50000–50100/udp` from PR-VR3 — that rule continues to work (it's a superset; LiveKit will only listen on 50000 inside the container, and the unused 50001–50100 forward chain hits closed ports but is harmless). No forced action; the post-launch setup modal will show the new copy.

### B6. What this amendment does NOT change

- Amendment A's reachability state machine, event topic, and UI dimming behavior are unchanged.
- TCP 7881 (ICE-TCP fallback) is unchanged. Owners still forward both ports for best media path; UDP 50000 alone is sufficient when the network supports UDP.
- Probe cooldown (60s per server, DB-backed) is unchanged.
- This amendment is local to the runtime + Central probe + UI copy. Plugin SDKs, JWT shape, and Cloudflare Tunnel setup are unaffected.

## Amendment C (2026-05-06 — applies in PR-VR3.2)

Replaces Amendment B's UDP probe target. Probing the LiveKit UDP MUX port (50000) directly does not return a STUN response: pion ICE's UDP mux dispatcher drops STUN Binding Requests whose `USERNAME` attribute does not map to an active ICE session, which is always the case for a cold reachability probe. Amendment B fixed the "nothing listening cold" half of the cold-probe problem; Amendment C fixes the "listener drops unauthenticated STUN" half by routing the probe to a different LiveKit-internal UDP listener that *does* answer plain Binding Requests: the embedded TURN server.

### C1. Why pion drops cold STUN at the MUX socket

pion's `UDPMuxDefault.connWorker` reads `stun.AttrUsername` on every incoming STUN packet, splits on `:` to extract a remote ufrag, and looks the ufrag up in its connection map. Unmatched requests are silently dropped (this is intentional — it prevents STUN-amplification reflection attacks against the SFU's media socket). Our cold probe sends a vanilla RFC 5389 Binding Request with no USERNAME, so it never reaches a handler.

This was empirically observed during Amendment B dev validation: the runtime container was rebuilt with `rtc.udp_port: 50000`, the kernel showed an open UDP socket bound at process start (resolving Amendment B's cold-bind concern), the router forwarded UDP correctly, but the probe still timed out. Reading pion's source confirmed the cause.

### C2. Decision

Enable LiveKit's embedded TURN server (UDP only, no TLS) on a separate UDP port and point the Central reachability probe at *that* port instead. RFC 5766 §6.5 mandates that a TURN server respond to STUN Binding Requests without TURN credentials, returning XOR-MAPPED-ADDRESS — exactly what our probe expects. pion's TURN implementation honors this. The probe gets a truthful response; the same machine, same NAT path, and same kernel UDP stack are exercised, so probe-pass strongly correlates with media-port-reachable.

The TURN listener doubles as a **media relay** for clients whose networks block direct UDP to 50000 (corporate WiFi, cellular, hotel networks, iOS Safari over restrictive carriers). LiveKit issues per-session TURN credentials inside the existing room JWT, so clients automatically negotiate TURN as an ICE candidate. Owners on restrictive networks gain a working voice path for free as a side effect of the probe fix.

### C3. Port choice

UDP **3478** — the IANA-registered STUN/TURN port. Two reasons:

1. The well-known number is what router admin UIs, ISP support, and online "open this port" guides reference for VoIP. Owner-side discoverability is high.
2. LiveKit's defaults and most deployment guides use 3478, so future LiveKit upgrades are unlikely to break anything assumed about this port.

If a specific consumer router or carrier-grade NAT is later observed to mangle traffic on 3478 (some legacy ALGs special-case it), the port is fully configurable via `VoicePortPlan.turnUdpPort` and can be relocated without protocol or wire changes — only the runtime YAML, desktop port-publish, and Central `DEFAULT_UDP_PORT` need to move together.

### C4. Wire changes (incremental over Amendment B)

| Field | Before (post-B) | After (post-C) |
|---|---|---|
| `livekit.yaml` `turn.enabled` | *(absent / default false)* | `true` |
| `livekit.yaml` `turn.udp_port` | *(absent)* | `3478` |
| `runtime` `VoicePortPlan.turnUdpPort` | *(absent)* | `3478` |
| `GET /admin/api/voice/state` `ports.turnUdpPort` | *(absent)* | `3478` |
| Central probe target UDP port | `50000` (MUX) | `3478` (TURN STUN responder) |
| Docker port publish (`apps/desktop/src/server-runtime.ts`) | adds `3478/udp` alongside existing `50000/udp` | (unchanged after this PR) |

`livekit.yaml` `turn.tls_port`, `turn.cert_file`, and `turn.domain` remain absent. The TURN server starts in plain-UDP mode without certs or a public hostname; the TLS listener is skipped at startup, which LiveKit handles gracefully.

### C5. Probe semantics

Probe still runs both legs in parallel:

1. TCP 7881 — ICE-TCP fallback reachability (unchanged).
2. UDP 3478 — STUN Binding Request to the embedded TURN server (changed). Success ⟹ owner's UDP path is reachable through their NAT to *some* port on the runtime, which we treat as "UDP works" because the same NAT mapping rules apply to UDP 50000 in nearly all consumer-router scenarios.

Reachability classification stays as Amendment B fixed it: `status === "ready"` iff *both* legs reach. UDP 50000 is not directly probed (pion drops the request); the modal lists it as an additional recommended forward for direct-media path quality.

### C6. UI contract changes

The owner-facing modal's "forward these ports" list grows by one row:

- `TCP 7881` (ICE-TCP fallback) — REQUIRED, probe target
- `UDP 3478` (STUN/TURN — voice signaling + relay) — REQUIRED, probe target
- `UDP 50000` (RTP media — direct path, optional but recommended) — NOT probed; LiveKit will fall back to TURN relay if this is closed

The reachability detail block lists two rows (TCP 7881, UDP 3478) with reachable/latency/error each. The "what to do" copy explains that UDP 3478 is required for voice to work at all, and UDP 50000 is a quality optimization.

### C7. Owner upgrade path

Existing owners with Amendment B-era rules need to **add a UDP 3478 forward** to their router. The setup modal renders the new row on next launch; the post-rebuild reachability probe will surface UDP 3478 as unreachable until they do. TCP 7881 + UDP 50000 rules continue to work as-is (UDP 50000 is no longer probed but still needed for direct media).

### C8. Why this is production-grade

- LiveKit's embedded TURN is the same component LiveKit Cloud uses for its own preflight checker and relay fallback. We are not running anything off-the-shelf can't run.
- pion/turn's STUN handler answers Binding Requests cold by RFC mandate. The probe response is deterministic, not LiveKit-version-fragile.
- TURN relay availability turns "voice unreachable" into a soft failure on restrictive networks: even when the owner's router blocks direct UDP, calls relay through TURN. iOS Safari especially benefits.
- Zero new long-running code in our codebase. Pure config + UI copy + probe target redirect.

### C9. What this amendment does NOT change

- Amendment A's reachability state machine, event topic, and UI dimming behavior are unchanged.
- Amendment B's `rtc.udp_port: 50000` UDP MUX configuration is unchanged. C *adds* a TURN listener; it does not remove the MUX socket.
- TCP 7881 leg is unchanged.
- Probe cooldown (60s per server, DB-backed) is unchanged.
- No new auth/JWT changes. TURN credentials are issued by LiveKit inside existing room JWTs.
