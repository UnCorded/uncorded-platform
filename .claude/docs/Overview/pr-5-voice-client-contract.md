---
purpose: "Inter-commit contract for PR-5 voice client wiring (shell-owned LiveKit Room + voice-channels plugin renders UI from shell state). Locks the shell-as-media-host architecture and the shell↔plugin postMessage envelopes before code is written, so voice doesn't fork from the existing platform.* protocol."
depends-on: [spec-24-voice, spec-04-plugin-architecture, pr-4-voice-contract]
last-verified: 2026-04-27 (5a manager review pass v2 + indicator landed — channelName threaded through §3a/§4a for indicator label; visibility teardown deferred 60s; identity-collision mapping; leading-edge throttle; AbortController wiring; bfcache state push; envelope/request types promoted to @uncorded/plugin-sdk-frontend; 5b voice-channels frontend rebuilt against typed SDK with cap-gated CTA; 5c Bun-tier smoke tests landed — singleton/cap-gate/snapshot regression + Permissions-Policy source-level audit; fresh-mount iframe snapshot race fixed via `snapshotFor()` deferred until uncorded.ready; LiveKit-dependent §13 rows deferred to 5d Playwright tier)
---

# PR-5 Voice Client — Implementation Contract

PR-4 shipped the runtime side (token mint, webhook, ban cascade, plugin scaffold + frontend stub). PR-5 wires `livekit-client` into a **shell-owned voice manager** and replaces the plugin stub with a UI that renders from shell-pushed state. Same locked-decisions style as `pr-4-voice-contract.md`: each row is a surface where shell and plugin would otherwise drift.

The high-level shape:

- **The shell owns the LiveKit `Room`, mic capture, mute state, and audio playback.** A singleton voice manager at app-root scope holds `Room` lifecycle independently of any plugin iframe.
- **The plugin owns presentation only.** It renders the participant roster, talking indicators, mute/leave UI, and channel-selection UI from state the shell pushes via postMessage. It does not bundle `livekit-client` and never touches a `MediaStream`.
- **`voice.media` is a runtime capability the shell checks before honoring a plugin's connect request.** It is no longer an iframe Permissions Policy delegation. The mic never leaves shell context.
- LiveKit's signal channel handles token refresh autonomously; client-side never explicitly refreshes (§6).
- The shell's persistent voice indicator (mic-hot dot + Leave) lives above `NavUser` (§15) and reads directly from shell-owned `Room` state.

This architecture was chosen 2026-04-27 after §17 made the plugin-owned-media path require a hidden-iframe persistence trick that was strictly worse than moving media into the shell. See §17 for the resolution log.

---

## 1. Capability semantics — `voice.media` as a shell-side grant check

When a plugin iframe posts `platform.voice.connect`, the shell's voice manager:

1. Reads the plugin's `runtime_capabilities` from the validated plugin registry (`GET /plugins`).
2. Refuses the request if `voice.media` is not in the set — replies with a `platform.voice.error { code: "voice_media_not_granted" }` push.
3. Otherwise proceeds with mic capture and `Room.connect`.

| Capability | What it grants |
|---|---|
| `voice.media` | Plugin may request shell to acquire mic and connect to a LiveKit room on its behalf. |
| (future) `voice.media.video` | Plugin may also request camera capture for screenshare/video calls — same shell-mediated model. |

**Trust path — pin this, don't shortcut it.**

The shell reads capabilities from the `GET /plugins` runtime endpoint, which serializes from `PluginRegistry.listPlugins()` after manifest validation. The plugin process cannot write to the registry — `runtime_capabilities` in the response is the validated set, not the raw on-disk manifest.

- **5a task:** extend `handlePluginList` in [`runtime/src/http/handler.ts:373-386`](../../../runtime/src/http/handler.ts) to include `runtime_capabilities: p.manifest.runtime_capabilities ?? []` in the response (currently surfaces only `client_capabilities`). Type the addition into the website's plugin-list fetch.
- **5b plugin-side cap gate.** The shell forwards `runtime_capabilities` to the iframe in the handshake (`uncorded.token` postMessage adds a `runtimeCapabilities: string[]` field, validated at the plugin side and exposed as `sdk.platform.voice.granted`). Plugin frontends use this to **hide** the "Join voice" affordance when the cap isn't granted — defense-in-depth so the user never sees a button that would round-trip just to fail. The shell-side rejection at #2 is still the authoritative gate; the plugin-side check is render-time UX only.
- **Phase 1 grant model:** validation against `VALID_RUNTIME_CAPABILITIES` (in [`packages/shared/src/manifest.ts`](../../../packages/shared/src/manifest.ts), populated by PR-4d to include `voice.media`) **is** the grant. A future server-admin approval layer (Phase 2+) can intercept between validation and registry insertion without changing this contract — the shell still reads from `GET /plugins`.
- **No iframe `allow="microphone"`.** The shell does not delegate mic to any plugin iframe under this architecture. Mic capture is a shell-trusted operation; capability gating happens in trusted code, not in browser policy attached to a sandbox.
- **Plugins do not directly specify Permissions Policy tokens.** The capability→behavior mapping is shell-internal.
- **Parent document Permissions Policy.** The shell's HTML/server response must NOT ship a `Permissions-Policy` header that blocks `microphone` in the shell's own document — `getUserMedia` will fail otherwise. PR-5c smoke test confirms.

## 2. Iframe sandbox flags — unchanged

`sandbox="allow-scripts allow-forms allow-popups"`. **No `allow-same-origin`**. The opaque-origin guarantee is load-bearing for plugin trust and is independent of voice — voice plugins are sandboxed identically to text plugins because they no longer participate in media capture.

## 3. Shell → Plugin envelopes (`platform.voice.*`)

Shell pushes from the singleton voice manager (§15) to the active voice-channels iframe whenever Room state changes. `event.origin` validation on the plugin side is unchanged — origin matches `shellOrigin`.

The TypeScript definitions for every envelope and request shape in §3 / §4 live in `@uncorded/plugin-sdk-frontend` (`packages/plugin-sdk-frontend/src/voice.ts`). Shell code (`apps/website/src/lib/voice-manager.ts`) and plugin frontends both import from there — single source so a contract drift breaks the type-check on both sides simultaneously.

### 3a. `platform.voice.state` — Room state push

```ts
{
  type: "platform.voice.state";
  status: "idle" | "connecting" | "connected" | "reconnecting" | "disconnected" | "failed";
  serverId: string | null;     // null when status === "idle"
  channelId: string | null;    // null when status === "idle"
  channelName?: string;        // optional display name; populated by the
                               // plugin via §4a `platform.voice.connect`
                               // (the plugin owns the channel record). The
                               // shell never resolves this on its own — if a
                               // caller didn't pass it, the indicator and
                               // any plugin UI fall back to a `channelId`
                               // slug. Carrying it on the state envelope
                               // means the indicator (a sibling consumer of
                               // the manager store, §15) doesn't need its
                               // own channel-name lookup path.
  // local mic state (server-enforced mutes + local user mutes both reflect here)
  mic: {
    available: boolean;          // false when getUserMedia denied / no device
    muted: boolean;              // true if EITHER local-mute or server-mute is in effect
    serverMuted: boolean;        // server-enforced (spec-24:197). NOTE PR-5: field shape is
                                 // forward-compat; no runtime path currently flips this true
                                 // (see §16 — MutePublishedTrack actuation deferred).
  };
  // optional — present in failed/disconnected
  error?: { code: string; message: string };
  reason?: "explicit" | "server_kick" | "server_ban" | "network" | "room_destroyed" | "identity_collision" | "auth_denied" | "voice_media_not_granted" | "client_load_failed";
}
```

- `status` semantics: `idle` = not in any room (initial state and post-explicit-leave); `connecting` = signaling open, awaiting room-joined; `connected` = room joined, mic published (or denied — `mic.available=false`); `reconnecting` = LiveKit auto-reconnect in progress; `disconnected` = clean exit; `failed` = connect/auth failed.
- `reason` reuses spec-24 §Event Topics enum + client-side additions (`identity_collision`, `auth_denied`) + grant-failure (`voice_media_not_granted`). **`token_expired` is intentionally absent** — see §6.
- The plugin still owns the server-side channel record via its existing IPC; the optional `channelName` on the wire is purely a display-label hand-off so the shell-side indicator doesn't need a parallel lookup path. Plugin UIs may still resolve their own labels from their channel store if they want richer formatting.

### 3b. `platform.voice.participants` — roster delta push

```ts
{
  type: "platform.voice.participants";
  // initial snapshot, plus full snapshot on any reconnect — plugin replaces
  // its local roster wholesale rather than reconciling deltas. ~200 byte
  // snapshot of a 20-participant room is cheap; ordering bugs from delta
  // streams are not.
  participants: Array<{
    userId: string;
    identity: string;          // LiveKit identity (= userId in our convention)
    isLocal: boolean;
    micPublished: boolean;     // has an active audio track
    micMuted: boolean;         // remote-side reported mute (LiveKit TrackMuted event)
    localMuted: boolean;       // *this user's* local choice to mute audio FROM this participant
  }>;
}
```

### 3c. `platform.voice.active-speakers` — talking indicator push

```ts
{
  type: "platform.voice.active-speakers";
  speakingUserIds: string[];   // LiveKit ActiveSpeakersChanged
}
```

- Throttle: plugin re-renders are CSS-class flips on existing roster rows; do not re-render the whole roster on each push. ≤5/sec ceiling at the shell-side dispatch — **leading-edge first push, trailing-edge throttle for subsequent within-window changes** (no perceptible lag at the start of an utterance, still capped to 5/sec).

### 3d. `platform.voice.error` — one-shot error pushes

```ts
{
  type: "platform.voice.error";
  code: "voice_media_not_granted" | "mic_permission_denied" | "token_mint_failed" | "livekit_unreachable" | "identity_collision" | "client_load_failed";
  message: string;
}
```

Distinct from `state.failed` because some errors are non-fatal (e.g., `mic_permission_denied` may leave Room connected with mic.available=false — still useful to surface a one-shot message in the plugin UI).

## 4. Plugin → Shell envelopes (`platform.voice.*`)

Plugins request actions; shell is the single writer to `Room`.

Plugin frontends never construct these envelopes by hand — `@uncorded/plugin-sdk-frontend` exposes `sdk.platform.voice.connect()`, `disconnect()`, `setMicMuted(...)`, `setLocalParticipantMuted(...)` which post the typed envelopes for them, and the matching `onState` / `onParticipants` / `onActiveSpeakers` / `onError` listeners for the shell→plugin direction. The plugin authors against the typed API; the postMessage shape is the SDK's job to keep aligned with §3 / §4.

### 4a. `platform.voice.connect`

```ts
{
  type: "platform.voice.connect";
  channelId: string;           // plugin-resolved channel identity
  channelName?: string;        // optional display name — recommended; the
                               // plugin already knows it from its channel
                               // record at the moment of dispatch. The
                               // shell stores it on `state.channelName`
                               // and renders it in the indicator label.
}
```

- The shell looks up `serverId` and the originating plugin's slug from the iframe's mount context (already known via `PluginContent`; routed through `createPluginHandle`'s closure in `channel-view.tsx` — the same lift-and-forward pattern the shell uses for other plugin-issued platform messages).
- The shell calls `request(serverId, "voice-channels", "voice.join", { channelId })` (`apps/website/src/lib/ws.ts:162`) — **the exact same WS path the iframe SDK uses** when the plugin's own UI calls `plugin.request(...)`. The plugin field on the request envelope IS the dispatch target; the runtime's WS auth context supplies user identity. There is no privilege backdoor: the shell is just an additional WS sender. The cap holder is voice-channels via manifest `voice.tokens:self`; the plugin's `voice.join` handler runs ACL + grant resolution + calls `plugin.voice.createJoinToken({ channelId, userId, grants })`. PR-5 adds **no new runtime route** for token minting — the contract pins this path so a future contributor doesn't introduce a parallel "shell-only" mint that bypasses the plugin's ACL.
- On grant absence (`voice.media` not in plugin's `runtime_capabilities`): shell rejects without sending the WS request and pushes `platform.voice.state { status: "failed", reason: "voice_media_not_granted" }` + `platform.voice.error`. The grant check is shell-side and runs **before** the WS hop.

### 4b. `platform.voice.disconnect`

```ts
{ type: "platform.voice.disconnect" }
```

Shell calls `room.disconnect()`. Idempotent.

### 4c. `platform.voice.set-mic-muted`

```ts
{
  type: "platform.voice.set-mic-muted";
  muted: boolean;
}
```

- Shell honors the request unless `mic.serverMuted=true` in current state (server-mute pre-empts; the `unmute` is a no-op and shell pushes current state again so the UI re-syncs).

### 4d. `platform.voice.set-local-participant-muted`

```ts
{
  type: "platform.voice.set-local-participant-muted";
  userId: string;              // remote participant whose audio to mute LOCALLY
  muted: boolean;
}
```

- Shell adjusts the LiveKit subscriber-side audio. Does NOT call any RoomService API — purely local rendering choice. Reflects in `participants[i].localMuted` on next push.

## 5. Multi-channel exclusivity + cross-server handoff — single-owner trivial

A user can only be in one voice channel at a time. The shell is the single Room owner, so this is trivial:

- **Same-server channel switch** (user clicks join on channel B while connected to A on the same server): shell calls `room.disconnect()`, then mints + connects B. The plugin observes via `state.disconnected` then `state.connecting/connected` pushes.
- **Cross-server switch** (user switches to a different server's workspace while in voice on the current server): the voice plugin iframe unmounts (still keyed `plugin:${serverId}:${slug}` per `surface-key.ts:23`), but **the shell's Room is unaffected**. The user remains in voice on the original server even though no voice UI is mounted — the indicator (§15) is the only voice surface.
- **Joining voice on the new server while already connected elsewhere**: the new server's voice plugin posts `platform.voice.connect`; shell sees an active Room on a different server, calls `room.disconnect()` synchronously, then connects the new room. The `Leave` packet flushes via the existing WebSocket close. No 2 000 ms timeout, no toast, no identity-collision race — single owner orders the operations.

The previous draft's shell-mediated 2 000 ms handoff is no longer necessary and is removed. Cross-server handoff is now a single-actor sequence.

## 6. Token lifecycle — server-driven, not client-driven

**`livekit-client` has no public client-side token refresh API. Token rotation is SFU-internal.** Verified 2026-04-27 against `livekit/livekit` server source.

- The shell obtains the 300 s JWT for the initial `room.connect(url, token)` call via `request(serverId, "voice-channels", "voice.join", { channelId })` — same path the iframe SDK uses for plugin-issued IPC, see §4a. The voice-channels plugin handler mints the token using its `voice.tokens:self` capability and returns `{ token, livekitUrl, expiresAt }`. This is the **bootstrap auth window**, not the session lifetime.
- The LiveKit SFU runs a per-participant `tokenTicker` (5-minute interval, hardcoded) in [`pkg/service/roommanager.go`](https://github.com/livekit/livekit/blob/master/pkg/service/roommanager.go) (`refreshToken()`). It mints a fresh JWT **using its own configured `(apiKey, apiSecret)`** and the in-memory `participant.ClaimGrants()`, then pushes it down the signal channel via `SendRefreshToken` (10-minute TTL on each refresh).
- The runtime's apiSecret matches the SFU's. The SFU does not consult the runtime on refresh — there is **no inbound webhook or hook** for "about to refresh, please reauthorize."
- The SDK's `RTCEngine` adopts the refreshed token silently via `onTokenRefresh` ([`SignalClient.ts:176, 853-855`](https://github.com/livekit/client-sdk-js/blob/main/src/api/SignalClient.ts)).
- **Shell schedules nothing.** No re-mint, no manual refresh, no listener on `onTokenRefresh`. The 300 s TTL on initial mint is fine because the SFU takes over and pushes its own 10-minute-TTL refreshes every 5 minutes.
- **No `token_expired` reason in the state envelope.** Once connected, the client cannot observe token expiry — the SFU either refreshed it or terminated the connection with a different reason.

### Mid-session authorization caveat — read with §16

The SFU mints refreshes from its **in-memory** `ClaimGrants`. Mid-session authorization is only as fresh as the runtime's outbound mutations to that in-memory state via `RoomService` Twirp calls (`UpdateParticipant`, `MutePublishedTrack`, `RemoveParticipant`). The runtime is not consulted at refresh time.

What works in PR-5:
- **Ban → kick.** PR-4c cascade calls `RemoveParticipant`. Shell sees `PARTICIPANT_REMOVED` disconnect → pushes `state { status: "disconnected", reason: "server_ban" }`.

What does NOT work in PR-5 (deferred — see §16):
- **Role downgrade that should mute or disconnect.** No runtime listener fans out to LiveKit admin calls.
- **Server-mute via role change.** `runtime/src/voice/room-service.ts` has only `RemoveParticipant`; `MutePublishedTrack` is unwired.

## 7. Cleanup — shell-document level, not iframe level

The shell voice manager owns Room lifecycle independently of plugin iframes. Cleanup hooks are at the shell document level:

1. `window.addEventListener("pagehide", ...)` — covers tab close, refresh, back/forward. Fires teardown immediately.
2. `document.addEventListener("visibilitychange", ...)` with `document.visibilityState === "hidden"` — Mobile Safari fallback **and** general "user really left" signal. Fires a **deferred** teardown via 60s `setTimeout`; cancelled if `visibilityState` returns to `visible` (tab-switch / app-switch — the common case). 60s is the chosen window because it comfortably exceeds typical tab-switch cycles (seconds) while still firing before LiveKit's own server-side zombie-participant timeout (~30-60s) on real "user closed the app" flows. **Naive immediate teardown on hidden is a regression — desktop tab-switch is a frequent UX pattern and disconnecting from voice on every tab switch breaks Discord-parity expectations.**
3. `window.addEventListener("beforeunload", ...)` — best-effort `Leave` flush; not relied on for correctness.
4. Shell route teardown (e.g., logout / app-shell unmount) — singleton's `dispose()` hook calls `room.disconnect()`.

LiveKit's `Leave` signal is a regular WebSocket message; `room.disconnect()` schedules a send but does not block on delivery. Shell calls `room.disconnect()` synchronously and relies on the WebSocket's own teardown to flush in-flight bytes. If reliable Leave delivery becomes a problem in practice, fall back to `navigator.sendBeacon(livekitUrl + "/leave", ...)` — but this is not required, and LiveKit's zombie-participant timeout catches missed Leaves.

Plugin iframe lifecycle is **decoupled from voice cleanup**. An iframe unmount (server switch, panel close, drag rearrange) does NOT trigger Room teardown — the shell's manager survives.

## 8. Identity collision — two tabs of same user

LiveKit rejects the second connection from the same `participant.identity` with `DisconnectReason.DUPLICATE_IDENTITY`. The shell detects this code, pushes `platform.voice.state { status: "failed", reason: "identity_collision" }` + `platform.voice.error`. No retry loop. Plugin renders a clear UI from the error: "You're already in this voice channel from another tab. Leave it to join here."

## 9. Autoplay / user-gesture requirement

Browser autoplay policy: connecting to LiveKit and acquiring mic require a user gesture in the call stack. The shell's voice manager exposes a `connect(channelId)` method that MUST be called from within a click handler context. The plugin's "Connect" button click event is forwarded through `platform.voice.connect`, and the shell synchronously dispatches the manager call before the message loop yields — preserving the gesture-bound stack.

This is the cleaner-than-iframe path: under the previous (rejected) plugin-owned model, the click happened in iframe context but mic capture would have happened in iframe context too (gesture preserved by Permissions Policy). Under shell-owned, the click happens in iframe context but mic capture happens in shell context — the cross-context gesture chain is preserved by browsers because `postMessage` synchronously invokes the receiver while the original gesture is still on the stack. Browser support: confirmed in Chromium and Firefox; Safari historically stricter — PR-5c smoke test verifies in WebKit.

## 10. getUserMedia constraints

```ts
{ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }
```

Pinned at the shell call site. LiveKit's defaults match these but explicit beats implicit. Video constraints are out of scope for PR-5 (screenshare lands later per spec-24:42).

## 11. CORS on LiveKit signaling endpoint

The shell connects to `livekitUrl` from its own (non-null) origin (`app.uncorded.app` for web, `desktop://...` for Electron). LiveKit's signaling endpoint must respond with `Access-Control-Allow-Origin: *` (or echo-back) on the WebSocket upgrade and any associated REST calls. Self-hosted LiveKit defaults satisfy this; PR-5c smoke test confirms with both web and desktop origins.

## 12. Bundle scope — lazy-loaded shell chunk

`livekit-client` (~200 kB min) bundles in the **shell** as a dynamically imported chunk:

- The voice manager module uses `await import("livekit-client")` on first `connect()` call.
- Vite/Rollup emits a separate JS chunk; users who never join voice never download it.
- Plugins do NOT bundle livekit-client — the voice-channels plugin bundle shrinks substantially relative to the rejected plugin-owned model.

If a future plugin needs media capture, it requests via the shell voice manager (or a sibling shell media manager for video). Plugins do not host media engines.

## 13. Failure modes — required smoke tests

| Scenario | Expected behavior |
|---|---|
| Mid-call ban (cascade kicks user) | `Room.Disconnected` event with `PARTICIPANT_REMOVED` → shell pushes `state { status: "disconnected", reason: "server_ban" }` → plugin shows "You were disconnected by a moderator." |
| Token mint denied at connect (banned, role too low) | Typed error from `voice.tokens` IPC → shell pushes `state { status: "failed", reason: "auth_denied", error }` → plugin shows the typed message. |
| Plugin lacks `voice.media` | Shell short-circuits; no IPC mint, no Room.connect → pushes `state { status: "failed", reason: "voice_media_not_granted" }` → plugin shows "Voice not enabled for this plugin." |
| LiveKit unreachable on connect | `Room.connect` rejects → push `state { status: "failed", error }` → plugin shows "Voice service unreachable" with manual Retry. |
| Mic permission denied after token mint | Token wasted (300 s TTL is harmless). Shell pushes `state { status: "connected", mic: { available: false, muted: true, serverMuted: false } }` + `error { code: "mic_permission_denied" }` → plugin shows "Mic blocked — check browser permissions." |
| Two-tab identity collision | §8. |
| Tab backgrounded ≥ 2 min | LiveKit handles. Shell verifies state stays `connected` on return; mic stays open. |
| Long session past 5 min (token-refresh path) | Connection stays up. SDK adopts server-pushed refresh tokens silently. Smoke test: connect, leave the tab idle for 7 min, verify still connected. |
| Server-mute applied mid-call (role change) | **Deferred — see §16.** No runtime path currently calls `MutePublishedTrack`. Smoke test scaffold lives in 5c marked `.skip` with a TODO referencing §16. The shell's `TrackMuted` listener IS wired so the path is ready, but production cannot exercise it. |
| Cross-server switch while in voice | Shell stays connected through the unmount of the outgoing voice iframe; indicator (§15) keeps showing connected state. Joining voice on the new server triggers the §5 single-owner reconnect; no identity-collision race. |
| Closing voice panel while connected | Iframe unmount; shell Room unaffected; indicator continues to show connected. |
| Singleton survives workspace switch | Switching workspace tabs in the website does not re-instantiate the voice manager (§15 pin). Smoke test: connect, switch workspace tabs 5×, verify state cardinality === 1 in dev console. |

## 14. Server-scoped room name — already locked

Room name = `server:<server-id>:voice:<channel-id>` (pr-4 §1, spec-24:195). The shell composes this when minting the join token; it does not let plugins specify the room name directly.

## 15. Indicator placement — sidebar footer, above NavUser

Spec-23 (scoped presence) does not own a "user persistent live session" surface. The voice indicator is a new surface.

**Pin: above [`NavUser`](../../../apps/website/src/components/nav-user.tsx) in the sidebar footer.**

Discord-parity placement and the only existing "user's persistent state in this app" anchor.

**State source: the shell voice manager directly.** Indicator subscribes to the singleton's reactive store (`createSignal`-backed). It is NOT a mirror of plugin-pushed state — the plugin and the indicator are sibling consumers of the same shell store.

**Visual states — pinned so 5a doesn't have to invent them.**

| State | Visual | Label | Actions |
|---|---|---|---|
| `idle` / `disconnected` | not rendered | — | — |
| `failed` | brief inline error row for ~5 s, then auto-dismiss | "Voice failed · {error.message truncated}" | Retry, Dismiss |
| `connecting` | pulsing dot (accent color, 1 Hz pulse) | "Connecting to #{channel-name}…" | none |
| `reconnecting` | pulsing dot (warning amber) | "Reconnecting to #{channel-name}…" | Leave (no mute — media plane is down so mute is a no-op) |
| `connected` + `mic.muted=false` | solid dot (accent) | "In voice · #{channel-name}" | Mute, Leave |
| `connected` + `mic.muted=true` + `mic.serverMuted=false` | solid dot with mic-off overlay | "Muted · #{channel-name}" | Unmute, Leave |
| `connected` + `mic.serverMuted=true` | solid dot with mic-off-locked overlay | "Server-muted · #{channel-name}" | Leave (Unmute disabled) |
| `connected` + `mic.available=false` | solid dot with mic-blocked overlay | "Mic unavailable · #{channel-name}" | Leave (no mute toggle) |
| Active-speaker on local user | per row above + transient ring/glow on the dot | (label unchanged) | (actions unchanged) |

Behavior pins:

- **Active-speaker ring** is decorative-only: do not re-render the row; mutate a CSS class.
- **Width:** matches sidebar collapsed/expanded state via existing `useSidebar` context. Collapsed-sidebar variant shows just the dot + state-icon overlay.
- **Click on channel-name region:** navigates the workspace to the voice plugin's panel for the connected server. The Room is unaffected by this navigation — it's purely a workspace UI shift.
- **Mute / Leave buttons:** call the shell voice manager directly (NOT via postMessage roundtrip). State updates are in-process and immediate; the plugin observes the change via the next `state` push as a side effect.
- **Failed-state Retry:** calls `manager.retry()` (which clears failed state and re-runs connect). Indicator does not directly call `voice.tokens`.

### Manager pins — load-bearing implementation contract

The 7 pins below are pre-flight requirements for `apps/website/src/lib/voice-manager.ts`. Together they define the singleton's identity, lifecycle, error surface, and integration with the existing iframe handler pipeline. Each one is the kind of decision that's painful to retrofit if missed.

**1. Plugin identity comes from the postMessage source iframe — reuse the existing `platform.*` lift pattern.**
The voice manager does NOT keep its own iframe→slug map. The per-iframe `onMessage` handler installed by `createPluginHandle` ([`apps/website/src/components/channel-view.tsx:133-174`](../../../apps/website/src/components/channel-view.tsx)) already has `serverId` and `slug` in closure. Extend that handler to dispatch `platform.voice.*` envelopes by calling the manager with `{ serverId, slug, ...payload }` — the same lift-and-forward pattern the shell uses for other plugin-issued `platform.*` envelopes. (The former `platform.browser.open` example here used `apps/website/src/lib/browser-panel-events.ts`, which was deleted with plugin-driven browser opening in commit `e04ea44`.) A parallel iframe-tracking map in voice-manager.ts is forbidden — it'd drift from PluginFrame mount/unmount and `event.origin` validation already lives in the existing handler.

**2. Token minting goes through the voice-channels plugin via `request()` — no privilege backdoor.**
See §4a. The shell calls `request(serverId, "voice-channels", "voice.join", { channelId })`. Cap holder is voice-channels (manifest `voice.tokens:self`); the manager is just a WS sender, identical to the iframe SDK. **PR-5 adds no new runtime route** for token mint — verified 2026-04-27 via `apps/website/src/lib/ws.ts:162` and `plugins/voice-channels/backend/index.ts:245-279`. If 5a runs into a missing IPC method, surface immediately and stop — do not invent a shell-only path.

**3. State pushes are filtered by `serverId`.**
The manager's reactive store carries `(serverId, channelId, status, mic, ...)`. When pushing `platform.voice.state` to iframes, dispatch only to iframes whose mount context's `serverId` matches the manager's current connection serverId. An iframe on a different server must NEVER see voice state from another server's room — pre-empts a leak across server identities. The cross-server-while-connected smoke test in §13 covers this.

**4. Multi-mount within one server: broadcast to all matching iframes.**
A user can open the voice-channels plugin in multiple panels at once (split, separate workspace) for the same server. The manager dispatches state pushes to **every** iframe whose `serverId` matches; each iframe re-renders independently. No "active iframe" bookkeeping. Since the existing `createPluginHandle` runs per-iframe and forwards via the manager's subscription API, the broadcast is just "n subscribers receive the same push" — no special path. Test: open two panels of voice-channels in the same server, connect, verify both render the same roster + same active speakers.

**5. Connect race: cancel-and-replace, not queue.**
If `connect(channelId)` is called while a previous `connect()` is still in flight (token mint pending or `Room.connect` resolving), the manager:
1. Aborts the previous attempt's `AbortController` — the in-flight `request()` for the token mint short-circuits client-side via `signal` so the manager doesn't wait for an orphan response. (`apps/website/src/lib/ws.ts:162` accepts `{ signal }` and rejects with `signal.reason` when fired.)
2. Bumps `attemptId`. Every `await` boundary in `connect()` checks `myAttempt !== attemptId` after resuming; a stale attempt that was already past its abort point exits without mutating signals or leaking a Room.
3. Calls `room.disconnect()` if a partial Room object exists.
4. Starts the new attempt with a fresh attempt-id token; only the latest attempt-id is allowed to mutate the public state signals.
The store transitions: `connecting(A) → connecting(B)` (no intervening `failed`/`disconnected` flicker). UI sees a smooth state continuation. Avoids the "user double-clicks Connect / clicks Connect on B while A is still resolving" race that would otherwise leave two Rooms or stale state. The runtime-side mint completes either way (token is single-use and will be discarded server-side on its TTL), but the client never spends a tick waiting on it.

**6. Lazy-import error path: `CLIENT_LOAD_FAILED`.**
`await import("livekit-client")` can reject (network failure, chunk hash mismatch after a deploy, CSP block). The manager:
1. Awaits the dynamic import inside `connect()`.
2. On rejection: pushes `platform.voice.error { code: "CLIENT_LOAD_FAILED", message }` and `platform.voice.state { status: "failed", reason: "client_load_failed", error }`. (Add `client_load_failed` to the §3a `reason` enum and `CLIENT_LOAD_FAILED` to the §3d `code` enum.)
3. Caches the resolved module on a module-level promise so retries reuse a successful load.
A retry from the indicator's `Retry` button (§15) re-runs the import — typical pattern for chunk failures after deploy is "next attempt picks up new hash."

**7. Singleton init site: module-level inside `voice-manager.ts`, imported from `apps/website/src/index.tsx`.**
Implementation:
- `voice-manager.ts` declares module-level `let room: Room | null = null` and constructs reactive signals inside a single top-level `createRoot(() => { ... })` block. Importing the module is the init.
- `apps/website/src/index.tsx` adds a side-effect import: `import "@/lib/voice-manager";` (or — equivalent — the cleanup-hook setup is invoked from `App` `onMount`, but state lives at module scope).
- **NOT** inside `App.tsx`'s reactive body, **NOT** inside any route/workspace component, **NOT** inside `<SidebarProvider>`. Mounting the manager inside a reactive scope that can re-instantiate (e.g., re-rendering on navigation) defeats the entire point of shell ownership.
- Cleanup hooks (§7: `pagehide`, `visibilitychange`, `beforeunload`) attach in the same module-level scope.
- Test: `import { voiceManager } from "..."` from any module returns the same instance; the dev console exposes `window.__voiceManager` (dev-only) so the singleton-cardinality smoke test in §13 can verify `=== 1`.

This is the single most important architectural pin in PR-5. The other six are scoped consequences; #7 is the foundation.

## 16. Known limitations — role-based mid-session revocation

**Load-bearing. Do not delete on contract revisions; convert to a "fixed in PR-X" pointer when the actuation path lands.**

LiveKit's signal-channel token refresh is **SFU-internal**: the SFU re-mints from in-memory `ClaimGrants` using its own apiSecret every 5 min (10 min TTL), and never calls back into the runtime. Verified 2026-04-27 against `livekit/livekit/pkg/service/roommanager.go`.

What this means for PR-5:

- **Bans propagate immediately** via PR-4c cascade → `RemoveParticipant` → `PARTICIPANT_REMOVED` disconnect.
- **Role-based revocation does NOT propagate to in-progress voice sessions.** No role-change → LiveKit hook today.
- **Server-mute via role change is a paper feature** — `runtime/src/voice/room-service.ts:2-3` only implements `RemoveParticipant`; `MutePublishedTrack` is acknowledged in the file comment as deferred.
- **Worst-case lag:** until the user voluntarily disconnects.

**Future PR (TBD — call it PR-5.5):** wire role-change events → `RoomService.UpdateParticipant` (revoke `canPublish`) and/or `RoomService.MutePublishedTrack`. Implementation site is `runtime/src/voice/room-service.ts` plus a listener on the cascade event bus.

This was a deliberate scope cut for PR-5 after weighing three options on 2026-04-27:

| Option | Outcome |
|---|---|
| A — wire role→LiveKit in PR-5 | Rejected: expands PR-5 scope into runtime work. |
| B — defer with explicit pin | **Chosen.** This §16. |
| C — shorten initial TTL + re-check on refresh | Rejected: SFU self-mints from `getFirstKeyPair()`; runtime is never in the refresh loop. Non-viable. |

**For consumers of this contract:** if your feature plan assumes mid-session role-based mute or kick "just works," it does not until PR-5.5 lands. Plan accordingly.

## 17. Architecture log — shell-owned media

Originally surfaced 2026-04-27 as "voice persistence across panel/workspace navigation" gap; resolved by re-evaluating the plugin-owned-media decision and choosing a shell-owned media manager.

The portal-host (`apps/website/src/lib/portal-host.ts`) refcounts iframes by `surfaceKey`. Under the previous plugin-owned model, voice would have lived in the `voice-channels` iframe and been destroyed when the last `PluginFrame` referencing it unmounted (panel close, workspace switch, etc.). Workarounds considered:

- **A. Limited indicator** — voice dies with the panel. Discord-non-parity, indicator becomes redundant.
- **B. Hidden persistence handle** — invisible PluginFrame holding extra refcount. Worked in theory; in practice it would have made the plugin a UI-less media-engine-in-a-sandbox-costume — plugin-owned in name, not in fact, with no real benefit for the cost.
- **C. Shell owns Room** — **chosen 2026-04-27.** Mic capture stays in trusted code; capability check enforced by shell logic instead of browser policy on a sandbox; persistence is automatic; future media plugins (video, screenshare) follow the same pattern via shell-side managers; bundle cost mitigated by route-level lazy chunk.

The tradeoff on the rejected per-plugin-bundle isolation rule: media engines are a poor fit for that rule because they touch system-level concerns (mic capture, audio playback, cross-session state) the host has to coordinate anyway. Treating media as a host service rather than per-plugin code aligns with how every comparable platform handles it.

---

## Sub-commit boundaries

| Commit | Surface | Depends on |
|---|---|---|
| 5a | Shell-side: extend `GET /plugins` to include `runtime_capabilities`; build the singleton shell voice manager (lazy-loaded `livekit-client` chunk; mic capture; `voice.media` grant check; `voice.tokens` IPC integration; Room lifecycle); shell-side voice indicator component above `NavUser` reading directly from manager state; promote `platform.voice.*` envelope/request types to `@uncorded/plugin-sdk-frontend` (both directions); shell document-level cleanup hooks (§7) | PR-4d (`voice.media` capability defined) |
| 5b | `voice-channels` frontend: replace stub with full participant-roster UI rendered from §3b/§3c shell pushes; "Connect / Disconnect / Mute / Leave" buttons that post §4a–§4d requests; collision UX; failed-state retry UX. **No `livekit-client` dependency in the plugin bundle.** | 5a (envelope types + manager) |
| 5c | Bun-tier smoke tests for the §13 rows reachable without a real LiveKit cluster: singleton cardinality (§15 pin #7), `voice.media` cap-gate failure path (§1, §13 row 3), `snapshotFor()` cross-server filter (§3, pin #3), `subscribe()` no-initial-snapshot regression (5c-prep fresh-mount race fix). Static verification that the shell's HTML/Vite config ships no `Permissions-Policy: microphone=()` header (§1). Plugin frontend's `platform.voice.state` envelope adds a `typeof status === "string"` parity guard (defense-only — shell is trusted). | 5a + 5b |
| 5d (deferred) | Playwright + LiveKit harness for the §13 rows that require a real SFU and multi-context orchestration: mid-call ban (cascade kicks user), token mint denied at connect, LiveKit unreachable, mic permission denied after token mint, two-tab identity collision (§8), tab-backgrounded-≥2-min, long-session-past-5-min token-refresh path (§6), cross-server switch while in voice (§5), closing voice panel while connected. Server-mute-via-role-change row stays `.skip` per §16 until PR-5.5. Picks up the Permissions-Policy verification at the deployed origin (matters at hosting layer, not source). | 5c (coverage tier) + LiveKit dev cluster + CI Playwright runner |

### 5d harness needs — pre-flight for whoever picks it up

So the next person doesn't have to reverse-engineer the gap from the rows above:

- **LiveKit dev cluster.** Self-hosted LiveKit container reachable from CI; URL injected via env var (e.g. `E2E_LIVEKIT_URL=ws://livekit:7880`). Same `apiKey/apiSecret` pair as the test runtime so the runtime's `voice.tokens` plugin handler mints tokens the SFU accepts. **Don't point at LiveKit Cloud** — token-refresh and ban-cascade rows need to drive admin Twirp calls (`RemoveParticipant`, eventually `MutePublishedTrack`) which require server-side credentials.
- **Two browser contexts per identity-collision row.** Playwright's `browser.newContext()` × 2, both authenticated as the same user. Page A connects to voice, page B attempts the same channel; assertion is `state.failed { reason: "identity_collision" }` on B (LiveKit `DUPLICATE_IDENTITY`). The §8 path also surfaces via `Room.connect()` rejection during signaling — the manager's `isDuplicateIdentityError` (`voice-manager.ts:610`) is the codepath under test.
- **Mic permission auto-grant.** Chromium: `--use-fake-ui-for-media-stream` + `--use-fake-device-for-media-stream` launch flags (Playwright: `chromium.launch({ args: [...] })`). WebKit doesn't support the flag set; the mic-denied row uses Chromium with the auto-grant flag REMOVED to drive the deny path. Don't try to reproduce in WebKit — Safari prompts and there's no headless override.
- **Ban-via-runtime fixture.** A test helper that drives the runtime's ban cascade end-to-end: HTTP `POST` to a moderation endpoint, or direct admin Twirp `RemoveParticipant` if the runtime's moderation route isn't wired to a public surface yet. The shell observes `Room.Disconnected` with `PARTICIPANT_REMOVED` and pushes `state.disconnected { reason: "server_ban" }`. The fixture should NOT mock the disconnect — the load-bearing assertion is that the cascade actually reaches the SFU.
- **Singleton-cardinality assertion.** Done via the dev-only `window.__voiceManager` handle (`voice-manager.ts:778`, gated on `import.meta.env.DEV`). The Playwright test connects, switches workspace tabs ≥5×, asserts `window.__voiceManager.state` is the same function reference each time. CI must run a dev build for this hook to be exposed.
- **Token-refresh-past-5-min row.** Test sits idle for 6 minutes after connect; assertion is `voice.state` still reports `connected` and `participants` is unchanged. Slow row by design — keep it tagged `@slow` so it doesn't bloat the smoke job; runs in a nightly tier.

If any of these pre-reqs aren't ready when 5d is picked up, the missing rows stay deferred — don't ship a Playwright suite that mocks the SFU. The whole point of the deferral is that the Bun tier already handles everything testable WITHOUT a real SFU; 5d's value is the parts the unit tier can't reach.

### 5c follow-up — fresh-mount snapshot race (resolved before tests landed)

While reviewing 5b for 5c, found an iframe-mount ordering race: `voice-manager.subscribe()` fired the initial state snapshot synchronously at registration, but a fresh `PluginFrame` mount registers the subscriber BEFORE `iframe.src` is set — so the three initial pushes landed in `about:blank` and were lost. Repro: connect on Server A → switch to Server B → switch back. The voice-channels iframe fresh-mounted, missed the snapshot, and rendered the idle "Join voice" CTA on a channel the manager was already connected to.

Fixed by removing the initial-snapshot block from `subscribe()` and adding `snapshotFor(serverId, fn)` — explicit one-shot helper that callers invoke once they know the iframe's SDK dispatch listener is attached. `channel-view.tsx` calls it inside the `uncorded.ready` handler, after `uncorded.token` + `uncorded.navigate` post. Adoption path is unaffected because the adopted iframe is already showing the latest state from the prior subscriber's pushes; the new subscriber will receive future pushes via the existing broadcast path.

Locked: any change to envelope shapes, capability semantics, or media ownership must update this doc first, then the code.
