---
purpose: "Inter-commit contract for PR-4 voice (4a tokens, 4b webhooks, 4c ban cascade, 4d voice-channels plugin). Ship-once decisions implementers should not re-derive."
depends-on: [spec-24-voice, spec-22-core-module, spec-04-plugin-architecture]
last-verified: 2026-04-27
---

# PR-4 Voice — Implementation Contract

Locked decisions for the four PR-4 sub-commits. Each row is a contract surface where an inconsistency between sub-commits would silently break integration. If any of these need to change, change the spec first.

---

## 1. Join token claim shape

LiveKit JWT, signed `HS256` with the persisted `apiSecret`:

```json
{
  "iss": "<apiKey>",
  "sub": "<userId>",
  "nbf": <now-seconds>,
  "exp": <now-seconds + 300>,
  "video": {
    "room": "server:<server-id>:voice:<channel-id>",
    "roomJoin": true,
    "canPublish": true,
    "canSubscribe": true,
    "canPublishData": true
  }
}
```

- `iss` is the **LiveKit API key**, not the UnCorded server ID. LiveKit's verifier looks up the matching secret keyed by `iss`. Cross-server isolation comes from each server having its own `(apiKey, apiSecret)` pair, not from `iss` carrying server identity.
- `sub` is the bare UnCorded user ID (UUID). No `uncorded:<server>:<user>` namespacing — each server's LiveKit deployment is its own collision domain.
- TTL: 300s (spec-24:248). Client refreshes at 60s remaining.
- `video.room`: `server:<server-id>:voice:<channel-id>` (spec-24:195). Webhook handler must validate the `server:<server-id>:` prefix on inbound events.

## 2. Capability slugs (spec-24:88-93, spec-04 grammar)

| Slug | Method |
|---|---|
| `voice.tokens:self` | `sdk.voice.createJoinToken` |
| `voice.rooms:self` | `sdk.voice.updateRoomConfig` |
| `voice.moderation:self` | `sdk.voice.muteUser`, `unmuteUser`, `disconnectUser` |
| `voice.channels.create` | Core role permission, default-granted to level ≥ 80 |

No new capability slugs in PR-4. Earlier proposals (`voice.tokens:mint`) are not the spec — `:self` is the spec-04 scope grammar.

## 3. Grant policy: plugin requests, runtime validates

The plugin names the grants it wants on each token (`{ canPublish, canSubscribe, canPublishData }`). The runtime validates each requested grant against the plugin's declared `voice.tokens:self` capability and rejects anything the capability doesn't authorize. This keeps the runtime as the policy *enforcement* point and the plugin as the policy *decision* point — `voice-channels` can mint listener-only tokens for muted users, push-to-talk-only tokens for raid mode, etc., without the runtime hard-coding the channel UX.

Defaults if grants are omitted: `canPublish=true, canSubscribe=true, canPublishData=true`.

## 4. Event topic names (spec-24:207-214)

All locked. Reproduced for implementer convenience:

| Topic | Payload |
|---|---|
| `runtime.voice.participant.joined` | `{ channelId, userId, sessionId, ts }` |
| `runtime.voice.participant.left` | `{ channelId, userId, sessionId, reason, ts }` |
| `runtime.voice.participant.muted` | `{ channelId, userId, mutedBy, ts }` |
| `runtime.voice.participant.unmuted` | `{ channelId, userId, unmutedBy, ts }` |
| `runtime.voice.room.created` | `{ channelId, config, ts }` |
| `runtime.voice.room.destroyed` | `{ channelId, ts }` |
| `runtime.voice.health.changed` | `{ status, lastError?, ts }` |

`reason ∈ {explicit, server_kick, server_ban, network, room_destroyed}`.

**`sessionId` semantics.** LiveKit's webhook always emits `participant.sid`; the empty string is the missing-data sentinel rather than a valid identifier. 4c's cascade subscriber correlates pending kicks against deliveries by `(channelId, userId)` and treats `sessionId` as advisory — never as a primary key — because the SFU does not echo the session id we'd issue when we initiate the kick.

**`room.created.config` payload field.** LiveKit's `room_started` webhook carries no room config (it's a thin notification, not a config dump). The 4b webhook handler emits `config: {}` — a placeholder. If `voice-channels` (4d) needs the room config in `runtime.voice.room.created`, the publishing side has to source it from the runtime's room-creation call rather than from the webhook. Treat the `config` field as "currently always empty; reserved for future enrichment from the create-room path."

**Cascade reason resolution.** When 4c initiates a `disconnectUser`, it stages a pending-kick entry keyed by `(channelId, userId)` with `reason ∈ {server_kick, server_ban}` and a TTL bounded by the LiveKit webhook retry budget. The webhook handler consults that map before publishing `participant.left`: if a pending entry matches, the published event's `reason` is the staged value (and the entry is consumed); otherwise it falls through to `"explicit"`. This keeps `reason` resolution local to the runtime instead of pushing it into every subscriber, and audit + UI both see the right value on the first delivery.

## 5. Webhook signature derivation (LiveKit-defined)

- `Content-Type: application/webhook+json`
- `Authorization` header: a JWT signed with the same `(apiKey, apiSecret)` pair as join tokens
- The JWT carries a `sha256` claim = `base64(sha256(rawBody))`
- Verification = JWT signature check + body hash equality

**Rotation behavior:** `rotateSecret()` invalidates both live join tokens *and* in-flight webhook deliveries. LiveKit retries webhooks on auth failure, so the loss window is small; dual-key acceptance during rotation is intentionally not implemented (expands attack window for marginal benefit).

**4b YAML wiring:** `runtime/src/voice/config.ts:renderLiveKitYaml` currently does not emit a `webhook:` block. 4b adds:

```yaml
webhook:
  api_key: <apiKey>
  urls:
    - http://127.0.0.1:3000/runtime/voice/webhook
```

Receive URL is loopback — webhook traffic never leaves the runtime container's network namespace. The path lives under `/runtime/` to keep it out of plugin and admin route trees.

**"Loopback" describes LiveKit's behavior, not a runtime-side enforcement boundary.** `Bun.serve` binds `0.0.0.0` and the public tunnel can route any inbound traffic to `/runtime/voice/webhook`. Authentication is the JWT-Authorization signature + body-hash check — that's what protects the endpoint. Path-fingerprinting probes will consume the per-IP rate limit but cannot mint events. If a future deployment needs hard loopback enforcement (e.g., to keep auth burn off the metrics graph), an `if (!isLoopback(request)) return 404` shim is the place to add it; today the contract chooses simplicity over that defense.

**Rate-limit budget.** The runtime applies a webhook-specific bucket (`RATE_VOICE_WEBHOOK`, target ≥ 600 events/min/IP) rather than the generic `RATE_HEALTH` budget. A burst is the expected case once 4c lands: a moderator banning N active voice users fans out to N `participant_left` events from a single LiveKit IP within seconds. The webhook path must not throttle its own cascade. Pick the bucket size so a room destroy on a 100-participant room (≈ 100 deliveries) fits comfortably without retry pressure.

## 6. JWT identity = bare user ID

`sub` claim is the UnCorded user UUID, no namespacing. Reasoning: each server has its own LiveKit deployment with its own keypair, so identity is per-server-unique by construction. Webhook handler maps inbound `participant.identity` → user_id by identity function. Ban cascade looks up bans by the same bare user ID. If federation ever lands (Phase 3+), it's a controlled migration with bounded scope.

## 7. Ban-cascade audit shape

Extends the `recordAudit(deps, user, action, targetType, targetId, payload)` pattern from PR-3b.

- `action: "voice.cascade.kick"` (one row per disconnected room — per-row granularity, not per-summary, for forensic clarity)
- `target_type: "voice"`, `target_id: <channelId>`
- Actor: forwarded from the source `core.moderation.banned` event's `banned_by` field. The original ban is already audited under `core.ban.create`; cascade rows attribute resulting kicks to the same actor for traceability. `actor_role` is resolved through `RolesEngine.getRole(actorId)` for human moderators; synthetic actors with a `__`-prefixed id (e.g., `__central__` for delta-driven bans) record `actor_role = "system"` rather than running through the role lookup.
- Fallback: if a future system-initiated cascade fires without an attributable actor (auto-cleanup, expired ban auto-restoration), use the synthetic actor `system:cascade` rather than NULL — keeps audit queries simple.
- `payload_json: { banned_user_id, reason, source_event: "core.moderation.banned", outcome, error_code?, error_message? }`
  - `outcome ∈ { "kicked", "not_in_room", "failed" }`. `kicked` = LiveKit returned 2xx; `not_in_room` = the room-service responded 404 (kick race lost — participant already left); `failed` = anything else.
  - `error_code` + `error_message` are present only when `outcome != "kicked"` and carry the structured failure code from the room-service client (`NOT_FOUND` / `TIMEOUT` / `AUTH_FAILED` / `UNREACHABLE` / `UNEXPECTED`) plus its message. Triage-grade detail; never user-visible.

Subscription topic is `core.moderation.banned` (and `core.moderation.unbanned` to short-circuit pending kicks if a ban is rescinded mid-cascade), per spec-22:279-280. Spec-24 previously named these as `core.user.banned` / `core.user.kicked`; that wording is now corrected.

**Cascade-pending state ownership.** 4c keeps an in-process `Map<string, { reason, expiresAt }>` keyed by `${channelId}:${userId}`. Insert on `disconnectUser` request; consume from the webhook handler when the matching `participant_left` arrives (see §4 *Cascade reason resolution*); evict on TTL (LiveKit retry budget + a small safety margin, suggested ≤ 30s) to bound memory growth on a runaway SFU. The map lives in module state owned by the cascade subscriber — the webhook handler reads it via a thin lookup function passed in `VoiceWebhookDeps`. No persistence: a runtime restart drops pending entries and the next webhook delivery falls through to `"explicit"`, which is correct (the kick already happened; we just lost the reason annotation, and the audit row from 4c's per-room write still carries the canonical reason).

---

## Sub-commit boundaries

| Commit | Surface | Depends on |
|---|---|---|
| 4a | `sdk.voice.createJoinToken` IPC + LiveKit JWT minting + capability gating | (none — pure runtime) |
| 4b | `/runtime/voice/webhook` receiver + signature verification + `runtime.voice.*` event publishing + YAML `webhook:` block | 4a (shares secret derivation) |
| 4c | Subscribe to `core.moderation.banned` → `disconnectUser` per active room + audit rows | 4a (token minting for the LiveKit room-service API call), 4b (webhook confirms kick landed) |
| 4d | `voice-channels` plugin (manifest + backend + frontend stub) | 4a, 4b, and the channel-CRUD surface introduced for it |
