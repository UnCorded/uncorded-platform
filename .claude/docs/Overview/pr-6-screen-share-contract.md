---
purpose: "Inter-commit contract for PR-6 screen share — extends PR-5's shell-as-media-host architecture from audio to video. Locks the trust boundary (canPublishSources is derived in plugin handler, not runtime IPC), the LRU subscription model, the in-iframe overlay portal, the Electron picker, and the server-side moderation primitive before code is written, so screen share cannot drift from the platform.* contract."
depends-on: [spec-24-voice, pr-4-voice-contract, pr-5-voice-client-contract]
last-verified: 2026-05-01 (planning pass v2 — second-pass review surfaced trust-boundary, e2ee-refusal, server-side-stop, max_publishers, persistent-indicator, atomic-LRU-coupling, dynacast-verification, in-flight-Promise dedup, SDK-cache-bust, and webContents-tag-mirror-filter as load-bearing requirements)
---

# PR-6 Screen Share — Implementation Contract

PR-4 shipped the runtime side (token mint, webhook, ban cascade); PR-5 shipped the audio client (shell-owned Room, plugin-owned UI). PR-6 extends both layers to add screen sharing **the production-grade way the first time** — multi-publisher, 4-stream LRU per viewer, in-iframe overlay rendering, Electron custom picker, opt-in audio, cursor always captured, server-enforced moderation.

The high-level shape:

- **Shell-as-media-host carries forward.** The shell owns `Room`, every `MediaStreamTrack`, the `getDisplayMedia` call, and every `<video>` element. The plugin iframe owns presentation: it renders `<div data-uc-screen-slot="…">` placeholders and reports their rectangles via postMessage; the shell paints absolutely-positioned `<video>` elements over each slot. The plugin **never** imports `livekit-client` and **never** sees a `MediaStream`.
- **canPublishSources is derived in the plugin `voice.join` handler — not in runtime IPC.** This is the single authorization point. Runtime IPC validates *shape* (allowlisted enum); the plugin handler decides *who* (permission check + e2ee gate). Client-supplied `canPublishSources` on `voice.join` is **discarded** (defense-in-depth, mirrors the existing `grants` drop).
- **Hard cap of 4 simultaneous video subscriptions per viewing client.** 5+ publishers exist on the wire; viewer subscribes to 4 and sees the rest in a click-to-swap tray. `RemoteTrackPublication.setSubscribed(true|false)` is the toggle. Dynacast (required at Room construction) makes non-subscribed publications zero downlink.
- **Server-side moderation ships in PR-6, not deferred.** Admin "Stop their share" via participant-kick (LiveKit doesn't expose track-level mute today). Track-level surgical mute is a follow-up.
- **E2EE channels refuse screen share** with `screen_share_e2ee_unsupported`. `setE2EEEnabled` for video is PR-7 work; this contract refuses to ship a state where the channel `e2ee` flag silently doesn't apply to one track type.
- **Per-channel `max_publishers` cap (default 10)** prevents homelab DOS from N×2 Mbps publishers.

This architecture follows PR-5 §17's resolution (shell-owned media is the only model that scales to multi-track, multi-window, and persistent-across-iframe-unmount UX). See §17 for the screen-share-specific consequences.

---

## 1. Capability semantics — `voice.screen_share` and `voice.moderation`

Two new runtime capabilities and one new plugin permission:

| Capability / Permission | Layer | What it grants |
|---|---|---|
| `voice.screen_share` | runtime capability | Plugin may request shell to acquire a screen-share track and publish to LiveKit on a user's behalf. Receiving doesn't need a cap. |
| `voice.moderation` | runtime capability | Plugin may call `plugin.voice.removeParticipant(...)` for moderation actions (admin "Stop their share", admin disconnect). |
| `voice.screen_share.publish` | plugin permission | Per-user gate: a user with this permission gets `canPublishSources` including `screen_share` + `screen_share_audio`. Default level **20** (member). |
| `voice.moderation.stop_share` | plugin permission | Per-user gate: caller must have this to invoke `voice.stopShare`. Default level **80** (admin). |

The capability validates the *plugin* (manifest registration); the per-user permission gates *individual users*. A user without the publish permission gets `canPublishSources: ["microphone"]` only and LiveKit rejects any screen-share publish with a permissions error.

**Trust path — load-bearing.** See §14 for the full trust-boundary table. The single authorization point is the plugin `voice.join` handler in `voice-channels/backend/index.ts`; everything else is shape validation or relay.

## 2. Iframe sandbox flags — unchanged from PR-5

`sandbox="allow-scripts allow-forms allow-popups"`. **No `allow-same-origin`.** No `allow="display-capture"` either — the iframe never calls `getDisplayMedia`; the shell does. The iframe-side SDK (`sdk.platform.voice.observeScreenSlot(el, trackSid)`) only attaches a `ResizeObserver` + posts rectangles. No browser policy attached to the sandbox grants media-related rights to plugins.

**Permissions-Policy on the shell document.** Must be set explicitly to `display-capture=(self), microphone=(self)` so the shell can call `getDisplayMedia` and `getUserMedia`. Iframes don't need delegation.

**CSP on the shell document.** `media-src 'self' blob:` (already required by PR-5 for audio; reaffirm for video). The shell-attached `<video>` elements read from `MediaStream` blob URLs.

## 3. Shell → Plugin envelopes (`platform.voice.*`)

PR-5 envelopes (`state`, `participants`, `active-speakers`, `error`) carry forward unchanged. PR-6 adds two envelopes and extends `state` and `participants`.

The TypeScript definitions live in `@uncorded/plugin-sdk-frontend` (`packages/plugin-sdk-frontend/src/voice.ts`) — single source so a contract drift breaks the type-check on both sides simultaneously.

### 3a. `platform.voice.state` — extended

Adds `screenShare` substate and three new error codes:

```ts
{
  type: "platform.voice.state";
  // ...PR-5 fields unchanged...
  screenShare: {
    publishStatus: "idle" | "starting" | "publishing" | "stopping";
    publishTrackSid?: string;
    quality: "auto" | "smooth" | "sharp";
    audioShared: boolean;
    channelMaxPublishers: number;
    channelPublisherCount: number;
    e2eeBlocked: boolean;          // true on channels with e2ee=true; share button hidden
  };
  // VoiceErrorCode now includes:
  //   "screen_share_cancelled"          | user dismissed picker
  //   "screen_share_e2ee_unsupported"   | channel has e2ee=true
  //   "screen_share_room_full"          | channel hit max_publishers
  //   "screen_share_permission_denied"  | user lacks voice.screen_share.publish
  //   "screen_share_codec_unsupported"  | no usable VP9/VP8 codec
}
```

### 3b. `platform.voice.participants` — extended

`ParticipantSnapshot` adds `screenSharePublications`:

```ts
{
  // ...PR-5 fields unchanged...
  screenSharePublications: Array<{
    trackSid: string;
    hasAudio: boolean;
    isPublishedByLocal: boolean;   // drives the "You are sharing" indicator
  }>;
}
```

Empty array = participant is not sharing. `isPublishedByLocal` is set on the local participant's snapshot so the plugin can render the persistent self-sharing indicator without re-deriving identity.

### 3c. `platform.voice.screen-share.subscriptions` — new

Per-client LRU subscription state. Plugin renders 4 video tiles + the tray from this.

```ts
{
  type: "platform.voice.screen-share.subscriptions";
  subscriptions: Array<{
    trackSid: string;
    userId: string;
    subscribed: boolean;
    volumePctClient: number;       // 0-100, listener-side volume scaling
    streamPaused: boolean;         // dynacast paused this stream (TrackStreamStateChanged)
  }>;
}
```

`streamPaused` reflects LiveKit's `TrackStreamStateChanged` (`active` ↔ `paused`); plugins overlay a "Stream paused" affordance over the tile. Clicking resume forwards a `subscribe-screen-share` request that triggers LiveKit to resume the stream.

### 3d. `platform.voice.screen-share.popout` — new

Per-track popout state.

```ts
{
  type: "platform.voice.screen-share.popout";
  trackSid: string;
  popped: boolean;                 // true while the tile is in popout
}
```

When `popped: true`, the plugin renders a "Watching in popout" placeholder over the slot — the actual `<video>` is in the popout window, not the slot.

## 4. Plugin → Shell requests (`platform.voice.*`)

PR-5 requests unchanged. PR-6 adds 13 new request types.

| Type | Payload | Effect |
|---|---|---|
| `start-screen-share` | `{ audio: boolean; quality?: "auto"\|"smooth"\|"sharp"; sourceId?: string }` | Shell calls `getDisplayMedia` (web) or invokes Electron picker. `sourceId` is Electron-only (custom picker passes the chosen source). |
| `stop-screen-share` | `{}` | Idempotent. |
| `set-screen-share-quality` | `{ quality: "auto"\|"smooth"\|"sharp" }` | First attempt `replaceTrack` for live swap; fallback stop+republish. |
| `subscribe-screen-share` | `{ trackSid: string }` | Adds to LRU. Evicts oldest if at cap-4. Audio for the same publisher subscribes atomically. |
| `unsubscribe-screen-share` | `{ trackSid: string }` | Drops from LRU. Audio drops atomically. |
| `popout-screen-share` | `{ trackSid: string }` | Web: `requestFullscreen` on `<video>`. Electron: borderless always-on-top `BrowserWindow`. |
| `dock-screen-share` | `{ trackSid: string }` | Returns popout to slot. |
| `register-screen-slot` | `{ slotId: string; rect: DOMRect; trackSid?: string }` | Plugin announces a slot placeholder. Shell paints `<video>` over it. |
| `update-screen-slot` | `{ slotId: string; rect: DOMRect }` | Slot moved/resized. rAF-coalesced from iframe side. |
| `unregister-screen-slot` | `{ slotId: string }` | Plugin cleared the slot. Shell removes the `<video>`. |
| `set-screen-share-volume` | `{ trackSid: string; volume: number }` | 0-1; clamped at shell. |
| `mute-screen-share-audio` | `{ trackSid: string; muted: boolean }` | Local-only audio mute. |
| `admin-stop-screen-share` | `{ targetUserId: string }` | Calls plugin SDK `voice.stopShare`. Caller must have `voice.moderation.stop_share` (≥ 80). Plugin handler enforces. |

## 5. Multi-publisher + LRU subscription model

**Concurrent publishers per channel** are constrained only by the per-channel `max_publishers` cap (default 10, admin-configurable; see §13).

**Per-client subscriptions are hard-capped at 4.** The 5th-Nth publishers exist on the wire but the client does not subscribe — `RemoteTrackPublication.setSubscribed(false)`. Dynacast (enabled at Room construction in `voice-manager.ts:428-441` via `new lk.Room({ adaptiveStream: true, dynacast: true, webAudioMix: true })`) makes non-subscribed publications zero downlink.

**LRU with click-to-swap.** When a 5th publisher starts and the client is at cap-4, the new publisher appears in the tray; clicking a tray entry evicts the LRU oldest and subscribes the new one. Manual pin overrides eviction (pinned tile is excluded from LRU; if the pin holder leaves, the slot auto-refills from the most recent unsubscribed sharer in the tray).

**Audio↔video atomic coupling.** Screen-share-audio is published as a separate track (LiveKit `Track.Source.ScreenShareAudio`). Subscription is **lockstep** with the paired video:

- When video subscribes, audio subscribes in the same microtask. Both promises must resolve before the swap is reported as complete (no audio gap).
- When video unsubscribes, audio unsubscribes in the same microtask (no orphan audio).
- Pairing: audio pubs are paired to their video pubs by participant + same-tick publish event (LiveKit publishes both on `setScreenShareEnabled(true, { audio: true })` within microseconds; verify in 6d via simultaneous track-published callbacks).

Without atomic coupling, swapping LRU entries produces an audible click as audio cuts mid-sentence, OR audio for an unsubscribed video accumulates as orphan downlink.

## 6. Capture options — what the shell sends to `getDisplayMedia` / `setScreenShareEnabled`

Pinned at the shell call site. Plugin never sees these:

```ts
const captureOpts: ScreenShareCaptureOptions = {
  audio: requestAudio,             // from picker checkbox
  video: true,
  resolution: presetResolution(quality),
  selfBrowserSurface: "exclude",   // web: prevent UnCorded tab self-mirror
  surfaceSwitching: "include",     // browser allows mid-share switch
  systemAudio: requestAudio ? "include" : "exclude",
  contentHint: quality === "smooth" ? "motion" : "detail",
};
const trackPublishOpts: TrackPublishOptions = {
  videoCodec: pickVideoCodec(),    // VP9 → VP8, never H264 for screen content
  videoEncoding: presetEncoding(quality),
  scalabilityMode: codecSupportsSVC() ? "L3T3" : undefined,
};
```

`pickVideoCodec()` reads `RTCRtpSender.getCapabilities("video")?.codecs` and falls back VP9 → VP8. **Never H264** — screen content needs lossless-ish text rendering, which favors the VP9 software path; H264's hardware acceleration matters more for camera content where compression artifacts are masked by motion blur.

`cursor` capture is **always on** — the underlying `getDisplayMedia` defaults to `cursor: "always"` on Chromium and the equivalent on Firefox; Electron's custom picker passes the choice through `desktopCapturer`. Plugin cannot turn this off.

### 6a. Quality preset table

| Preset | Resolution | FPS | Encoding bitrate | Content hint |
|---|---|---|---|---|
| `auto` (default) | up to 1080p | up to 30 | adaptive (LiveKit dynacast picks) | inferred per frame |
| `smooth` | 720p | 60 | 2.5 Mbps | `motion` |
| `sharp` | 1080p | 30 | 4 Mbps | `detail` |

1080p30 is the ceiling. Higher resolutions/framerates would exceed the per-stream encoder CPU budget on consumer hardware.

### 6b. Quality preset live-swap

`setScreenShareQuality(preset)` first attempts `LocalVideoTrack.replaceTrack(newTrack)` with the new encoding (livekit-client 2.x supports this on `LocalVideoTrack`). If unsupported by the underlying browser, falls back to stop+republish — UI shows a "Switching quality…" overlay during the brief gap (subscribers see `TrackUnpublished` → `TrackPublished` for the new sid).

## 7. Cleanup — track lifecycle

The shell's voice manager already owns Room lifecycle (PR-5 §7). PR-6 extends:

1. **Local screen-share publish ends** when:
   - User clicks Stop in the plugin UI → `stop-screen-share` → `setScreenShareEnabled(false)`.
   - User clicks Stop in the persistent indicator → same path.
   - Captured surface ends (window closes, tab navigates away) → `MediaStreamTrack.onended` → `setScreenShareEnabled(false)`.
   - Voice disconnects (any reason) → screen-share publication tears down with the room.
   - Cross-server switch: shell calls `stopScreenShare()` synchronously before disconnecting from current room (PR-5 §5 single-owner reconnect).
   - HMR: `import.meta.hot.accept(...)` cleanup tears down active publish + subscription `<video>` portals + popout windows.
2. **Remote subscription detach** mirrors PR-5's audio cleanup at `voice-manager.ts:977-982`. For each unsubscribed remote video track: `track.detach().forEach(el => el.remove())`. **Critical for popouts:** popout uses `track.clone()` to safely transport the track to a separate window; on popout-close OR voice-disconnect, the manager must detach AND `clone.stop()` for both the original AND the clone. Forgetting the clone leaks `MediaStreamTrack` references that keep the source's `getDisplayMedia` capture alive — on macOS, the system "screen recording" indicator stays on persistently after sharing stops.

## 8. Reconnect — local re-publish

LiveKit auto-republishes local tracks on `Reconnected`. The shell verifies and, if needed, manually re-publishes by re-running `setScreenShareEnabled(true, captureOpts, trackPublishOpts)` from cached options. Subscribers see the new sid after the brief reconnect window.

## 9. Popout — per-platform

| Platform | Mechanism |
|---|---|
| Web | Shell calls `requestFullscreen()` on the `<video>` element directly. Esc / system gesture exits. Full PiP API integration deferred (see §15 known limits). |
| Electron | Main process opens a borderless transparent always-on-top `BrowserWindow`. Renderer attaches a video tag to a `MediaStreamTrack` cloned via `track.clone()` (intra-process, no cross-origin transfer). `webContents.uncordedWindow = true` so the popout itself can never be re-shared into a mirror loop. |

While popped out, the plugin's slot shows a "Watching in popout" placeholder; clicking it sends `dock-screen-share` to return the video.

Disconnecting from voice while popped out closes the popout via the cleanup chain. Unsubscribing a popped-out track also closes the popout (subscribe state is single source of truth).

## 10. Codec, encoding, and the publisher's CPU budget

VP9 + L3T3 SVC where supported; VP8 fallback for Safari, older Electron, or any environment without VP9 encoder support. **VP8 over H264** locked decision (see §6).

**Per-stream encoder CPU (publisher), 1080p30 VP9 L3T3 SVC**: target ≤ 15% of one modern core (Apple Silicon, Zen 3+). Older consumer CPUs (Intel 8th gen, Zen 1) realistically hit 20-25%; if a publisher's encoder thread saturates, dynacast's automatic layer drop reduces output. Hardware-accelerated VP9 encoding is rare; software is the reality. Originally planned 8% was the LiveKit *camera* bench number — screen content (large frames, frequent diffs) is heavier. 6h benchmarks before commit and updates this section with measured numbers.

**Per-stream decoder CPU (subscriber)**: ≤ 5% per VP9 stream, ≤ 7% per VP8 stream.

## 11. Audio sharing

Opt-in per share via the picker checkbox. When enabled:

- Web: `getDisplayMedia({ audio: true })` — Chromium captures tab/system audio depending on what surface the user picked.
- Electron: `desktopCapturer` returns audio if the surface supports it; `loopback` mode for Windows system audio (driver-dependent).

Published as a separate LiveKit track with `Track.Source.ScreenShareAudio`. Subscription is atomically coupled to the paired video subscription (§5). Listener-side volume scales 0-1 via `RemoteAudioTrack.setVolume()`; mute is local-only.

Known interaction: macOS Bluetooth headset + screen-share-audio routing can fight (browser-level limitation). Plugin surfaces a one-time toast on detection if not fixable in scope.

## 12. Mobile — hidden, not graceful

`navigator.mediaDevices.getDisplayMedia` is not available on iOS Safari, Android Chrome, or any mobile WebView. The Share button is **hidden entirely** on mobile (`!navigator.mediaDevices?.getDisplayMedia`); no tooltip-on-disabled (noise — mobile users know the constraint). The plugin re-checks on every layout change so a user resizing a window from desktop-narrow to desktop-wide doesn't get stuck on the hidden state.

## 13. `max_publishers` cap and admin moderation

### 13a. Per-channel cap

New column on `voice-channels.channels`: `max_publishers INTEGER NOT NULL DEFAULT 10`. Admin can configure per channel via `voice.channelConfig` request. Hitting the cap returns `screen_share_room_full`:

- **Client-side check:** plugin disables the Share button when `channelPublisherCount >= channelMaxPublishers` (fast feedback, derived from the live `participants` envelope).
- **Server-side check (source of truth):** runtime enforces via LiveKit webhook on `track_published` (or via a count check before forwarding `setScreenShareEnabled` — verify the webhook path in 6b). On rejection, runtime calls `RoomService.removeParticipant`-style mute or simply returns the error to the client; the client then sees `track.publish` rejected by LiveKit.

Without this cap, a channel with 50 publishers × 2 Mbps = 100 Mbps + ~5 cores SFU ingest. A homelab box gets DOS'd. Cap is non-negotiable.

### 13b. Admin "Stop their share" — ships in PR-6

Lifts forward what PR-5 §16 deferred for audio. Plugin handler `voice.stopShare`:

1. Verifies caller has `voice.moderation.stop_share` (default level 80).
2. Calls `plugin.voice.removeParticipant({ channelId, userId, reason })`.
3. SDK forwards to runtime IPC `voice.moderation`, which calls LiveKit `RoomService.RemoveParticipant` via `mintAdminToken` (existing plumbing in `runtime/src/voice/tokens.ts:176-203`).

LiveKit doesn't expose track-level mute today (`MutePublishedTrack` is unwired in `runtime/src/voice/room-service.ts`). Full participant kick is the safe ship path because:

- Screen-share content has higher abuse risk than audio (NSFW, credential leaks, social engineering).
- Track-level mute is a follow-up (PR-5.5/6.5) once the runtime wires `MutePublishedTrack`.
- Kicked user can rejoin the room with audio-only; the offending share is gone immediately.

UI: each tile gets a "Stop their share" button when caller has `voice.moderation` granted. Confirms via lightweight modal before dispatching `admin-stop-screen-share`.

## 14. Trust boundary — single authorization point

Critical pin. Each layer's responsibility:

| Layer | Validates | Authorizes |
|---|---|---|
| Plugin frontend (iframe) | nothing (untrusted) | nothing |
| `channel-view.tsx` postMessage gate | origin, frame-key, request shape | forwards whitelisted types only |
| Voice-manager (shell) | nothing (trusts plugin handler) | local mic/screen capture, LRU subscriptions |
| Plugin SDK frontend → backend bridge | type, schema | plugin-permission scope (declared in manifest) |
| **Plugin `voice-channels/backend/voice.join`** | **`channel.e2ee`, drops client `canPublishSources`** | **`hasMinLevel(user.id, "voice.screen_share.publish", 20)`** |
| Runtime IPC `voice.tokens` | shape: `string[]`, allowlist enum `["microphone", "camera", "screen_share", "screen_share_audio"]` | trusts plugin handler |
| Token mint (`tokens.ts`) | crypto-signs the claims | embeds `video.canPublishSources` |
| LiveKit SFU | verifies JWT signature | enforces `canPublishSources` per publish call |

The single authorization point is the row in **bold**. Everything else is shape validation or relay.

### 14a. The plugin handler's three responsibilities

In `plugins/voice-channels/backend/index.ts:245-279`, the `voice.join` handler:

1. **Drops** any `canPublishSources` field present on the inbound params (defense-in-depth, mirrors the existing `grants` drop).
2. **Refuses** with `screen_share_e2ee_unsupported` if `channel.e2ee === true` AND inbound params indicate a screen-share-capable client. Cleaner shape: just never grant screen sources on e2ee channels — the cleaner path is to set `canPublishSources: ["microphone"]` regardless of permission when e2ee is set.
3. **Derives** sources: `const canShareScreen = await plugin.permissions.hasMinLevel(user.id, "voice.screen_share.publish", 20)`. Sets `canPublishSources` to `["microphone", "screen_share", "screen_share_audio"]` if `canShareScreen && !channel.e2ee`, else `["microphone"]`.
4. **Forwards** to `plugin.voice.createJoinToken({ channelId, userId, canPublishSources })`. Token mint embeds `video.canPublishSources` in the JWT; LiveKit enforces server-side.

A test (`plugins/voice-channels/__tests__/voice-join-source-derivation.test.ts`) covers all four paths: user with permission gets full sources; user without gets `["microphone"]`; client-supplied `canPublishSources` on params is dropped; e2ee channel returns `["microphone"]` regardless.

### 14b. Why the runtime IPC is not the gate

`runtime/src/voice/ipc.ts:63-79` is shape-validation only. It validates `canPublishSources` is `string[]` with every entry in the allowlist enum, then forwards to `mintJoinToken`. **No policy.** The runtime doesn't have an authenticated `user.id` at this layer — the plugin process does. Putting the gate in the runtime would require duplicating the permission check or trusting the plugin's IPC sender, neither of which is desirable.

### 14c. E2EE refusal — not a silent break

spec-24 §41: "When set, the LiveKit room is created with end-to-end encryption — the SFU relays only encrypted streams." If PR-6 shipped without §14a step 2, video would publish unencrypted into an e2ee room. **Refused with `screen_share_e2ee_unsupported`** until track-level video encryption is wired in PR-7. The plugin frontend hides the Share button entirely on e2ee channels with an inline "Screen share unavailable on encrypted channels" hint.

## 15. Persistent "You are sharing" indicator

Privacy-critical. While local user is publishing screen share:

1. **In-app badge** — top of the voice-channels frontend's actions bar: red dot + "● You are sharing — Stop". Clicking Stop sends `stop-screen-share`.
2. **Roster card border** — local user's roster card gets a 2px red border. Always visible, regardless of scroll position or modal overlays.
3. **Voice indicator (sidebar)** — the existing PR-5 indicator (`apps/website/src/components/...`) gets a small "📺" overlay on the dot while sharing.

The indicator is non-dismissible while publishing. Users must always know they're broadcasting. Discord uses both an in-app badge and a small floating indicator; UnCorded ships at least the in-app + roster + sidebar variants.

## 16. SDK API version and cache coupling

The new envelopes, requests, and `sdk.platform.voice.*` methods require an SDK version bump:

- `packages/plugin-sdk-frontend` exports `SDK_API_VERSION = "1.1"`.
- Plugin manifest `api_version` bumps `^1.0` → `^1.1`.
- Shell reads the iframe's reported version at handshake. If `< 1.1`, shell forces a hard reload of `/sdk/plugin-frontend.js` AND the iframe HTML — both cache lifetimes must be coupled, per memory `feedback_sdk_bundle_cache.md`.

Without coupling, a stale cached plugin frontend calls `sdk.platform.voice.observeScreenSlot` and crashes (`TypeError: undefined is not a function`).

## 17. Phased rollout — coupling rule

```
6a — Vault contract                 (this doc)
6b — Token grants + manifest cap    (cap stays COMMENTED OUT in manifest until 6g)
6c — SDK contract types
6d — Shell publish + LRU subscribe
6e — Shell overlay portal
6f — Electron picker + popout
6g — Plugin frontend UI + UNCOMMENT cap
6h — Bun unit + integration smoke + benchmarks
6i — Playwright + Electron E2E (DEFERRED — same dev-cluster gating as PR-5d)
```

**Coupling rule for 6b → 6g:** the runtime cap `voice.screen_share` ships in 6b but stays commented out in `plugins/voice-channels/manifest.json` until 6g. Until 6g lands, direct `setScreenShareEnabled(true)` attempts via devtools hit "permissions error" cleanly because the plugin handler returns `["microphone"]` only. The cap is uncommented in 6g together with the Share button — bypass window closes the same commit the UI opens.

## 18. Failure modes — required smoke tests

Extends PR-5 §13. New rows:

| Scenario | Expected behavior |
|---|---|
| User cancels picker | `getDisplayMedia` rejects with `NotAllowedError` (web) or handler returns null (Electron). Shell pushes `error { code: "screen_share_cancelled" }`, no state change. |
| User shares the UnCorded tab/window itself | Web: `selfBrowserSurface: "exclude"` blocks it. Electron: custom picker filters by `webContents.uncordedWindow === true` over the live tagged set (covers main + every popout + future tray windows). |
| User closes the captured surface | `MediaStreamTrack.onended` fires. Shell calls `setScreenShareEnabled(false)`, pushes state. |
| User starts second share without stopping first | UI confirms "Replace current share?" toast; user can cancel. On confirm, LiveKit replaces the publication. |
| 5th publisher joins while client is at LRU cap-4 | Unsubscribed by default. Tray shows the new sharer; click-to-swap evicts oldest. |
| Pinned tile's publisher leaves | Slot auto-fills from the most recent unsubscribed sharer; if no waitlist, "No active share" placeholder. |
| Reconnect during share | LiveKit re-publishes on `Reconnected`. Manager verifies; manually re-publishes if needed. |
| Cross-server switch while sharing | Shell `stopScreenShare()` synchronously before disconnect; PR-5 §5 single-owner reconnect. |
| Tab backgrounded ≥ 60s while sharing | PR-5 §7 visibility teardown disconnects the room; screen-share track tears down with it. |
| Mic-permission-denied user tries to share | Independent path — share works; mic.available stays false. |
| macOS user without screen-recording permission | Handler returns no sources / OS denies. Dialog with "Open System Settings" CTA via `x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture`. |
| Electron user denies screen-share permission mid-flow | Handler callback fires with empty source. UI returns to idle. |
| User has `voice.media` but not `voice.screen_share.publish` | Plugin handler returns `["microphone"]` only. LiveKit rejects publish with `permissions error`. Shell surfaces `screen_share_permission_denied`. |
| Direct devtools `setScreenShareEnabled(true)` bypass | LiveKit rejects with permissions error (token grant doesn't include `screen_share`). Confirms client-side bypass is impossible. |
| Two-tab identity collision while sharing | Blocked by `DUPLICATE_IDENTITY` at room-join (PR-5 §8); not screen-share-specific. |
| Bandwidth degradation | Dynacast pauses non-visible subscriptions; `TrackStreamStateChanged` (`active` ↔ `paused`). Shell forwards as `streamPaused` in subscriptions envelope. |
| Plugin frontend re-mount after split-panel rearrange | Slot register/unregister is idempotent on `(frameKey, slotId)`. No TTL eviction; explicit unregister + janitor on iframe disconnect handle staleness. |
| Mobile user clicks Share button | Button is hidden on mobile; no path to dispatch. |
| iOS Safari | Same as mobile. |
| VP9 unsupported in older Electron | Detect via `RTCRtpSender.getCapabilities("video")?.codecs`; fall back to VP8. |
| Screen-share-audio + Bluetooth headset on macOS | Known browser/OS interaction. One-time toast on detection if not fixable in scope. |
| User pops out, then unsubscribes via tray | Popout closes automatically (subscribe state is single source of truth). |
| User pops out, then disconnects from voice | Popout closes via `disconnect()` cleanup chain. Both original and `track.clone()` references released; macOS recording indicator clears. |
| Quality preset swap mid-share | First try `LocalVideoTrack.replaceTrack`; fallback stop+republish. UI overlay during swap. |
| Server-side mute screen share | Admin "Stop their share" button → participant kick (track-level mute deferred to PR-5.5/6.5). |
| Frame timing for slot rects | rAF-coalesced from iframe + shell. Worst case 32ms lag during heavy iframe scroll. |
| Iframe with hidden `display:none` parent | `getBoundingClientRect()` returns `{0,0,0,0}`. Shell hides overlay when rect width or height is 0. |
| Multi-mount (split panel) | Each iframe has its own `frameKey`, registers its own slots. LRU is per-client, shared across frames. |
| Popout while in split-panel | Popout takes precedence; both iframes' slots show "Watching in popout" placeholder. |
| Vite HMR dev hot-reload | `import.meta.hot.accept(...)` cleanup tears down active publish + `<video>` portals + popout windows. |
| Permissions-Policy `display-capture` denial | Shell catches `NotAllowedError` from getDisplayMedia, surfaces error. Shell document MUST set `Permissions-Policy: display-capture=(self)` explicitly so iframes don't inherit blocking from a parent document. |
| Concurrent `start-screen-share` from misbehaving plugin | Manager dedupes via `inFlightStartShare: Promise \| null` (mirrors `openConnection` pattern per memory `feedback_ws_connect_race.md`). User picker opens once, not twice. |
| Stale slot rectangles on iframe pause (devtools breakpoint, GC, throttled tab) | No TTL eviction. Slot map persists until explicit `unregister` or iframe disconnect. 2s TTL was rejected because it would drop slots during normal pauses. |
| Channel hits `max_publishers` cap mid-share-attempt | Server-side webhook returns `screen_share_room_full`. Plugin button is also disabled client-side when `channelPublisherCount >= channelMaxPublishers`. |
| User shares on E2EE channel | Refused at plugin handler; client surfaces "Screen share unavailable on encrypted channels". |
| SDK API version skew (stale cached frontend) | Shell reads `SDK_API_VERSION` from iframe handshake; if `< 1.1`, force-reloads `/sdk/plugin-frontend.js` + iframe HTML. |
| Local audio detach for popouts | On popout-close OR voice-disconnect, manager detaches AND `clone.stop()` for both original AND clone. Forgetting leaks references that keep `getDisplayMedia` alive (macOS recording indicator). |

## 19. Known limitations

Follow PR-5 §16 model: convert each to a "fixed in PR-X" pointer when the actuation path lands.

- **E2EE for screen-share tracks** — refused in v1 with `screen_share_e2ee_unsupported`. `setE2EEEnabled` for video is PR-7 work.
- **Track-level mute (`MutePublishedTrack`)** for both audio and video — admin moderation in v1 is participant-kick; track-level surgical mute is PR-5.5/6.5.
- **Recording shares server-side (LiveKit Egress)** — separate feature, post-MVP.
- **Annotation / drawing on remote tiles** — UI-only feature, can ship later.
- **Picture-in-picture API integration on web (`requestPictureInPicture`)** — could replace shell-managed popout on web; deferred until popout UX is stable.
- **Cross-region SFU support** — single-room, single-runtime model unchanged.
- **Spotlight / "follow speaker" auto-pin** — manual pin only in v1.
- **macOS Bluetooth headset + screen-share-audio routing** — browser/OS interaction; surfaces as toast.

## 20. Architecture log

Originally surfaced 2026-05-01 as "screen sharing for voice channels". Resolved by extending PR-5's shell-as-media-host architecture from audio to video without forking the platform.* contract.

The key architectural questions resolved during planning:

- **Q: Where does the `<video>` element live — iframe or shell?** A: Shell. Cross-origin sandboxed iframes block `MediaStream` postMessage transfer reliably (Firefox/Safari); the production path is the lowest common denominator. Shell paints `<video>` over plugin-reported slot rectangles via the existing portal-host primitive.
- **Q: Where does authorization happen — runtime IPC or plugin handler?** A: Plugin handler. The runtime IPC has no authenticated user.id. Plugin handler is the single source of truth (see §14).
- **Q: Should e2ee channels accept video and we silently break the contract, or refuse?** A: Refuse. spec-24 §41 is load-bearing; silently breaking it is worse than feature-flagging it for a future PR.
- **Q: What's the per-client subscription cap?** A: 4 (user-locked). 5+ visible in tray, click-to-swap. Dynacast handles non-subscribed bandwidth.
- **Q: Is admin "Stop their share" deferred like audio mute is?** A: No — screen-share content has higher abuse risk; participant-kick is the safe ship path until track-level mute lands.

Locked: any change to envelope shapes, capability semantics, trust boundary, or e2ee policy must update this doc first, then the code.
