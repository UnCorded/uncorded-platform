// Voice — `platform.voice.*` envelope and request types for the shell↔plugin
// postMessage contract. The shell owns the LiveKit Room and pushes state to
// plugin frontends via these envelopes; plugin frontends dispatch user
// intent (connect, mute, leave) back via the request types.
//
// Source of truth: `.claude/docs/Overview/pr-5-voice-client-contract.md` §3
// (envelopes, shell → plugin) and §4 (requests, plugin → shell). Keep this
// file synchronised with that contract; if a name or shape diverges, fix the
// contract first per CLAUDE.md "session discipline".

/** Lifecycle status of the active voice session. §3a row 1. */
export type VoiceStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected"
  | "failed";

export type VoiceScreenShareQuality = "balanced" | "smooth" | "sharp" | "source";

/** Why the active voice session ended. §3a "reason" enum. */
export type VoiceReason =
  | "explicit"
  | "server_kick"
  | "server_ban"
  | "network"
  | "room_destroyed"
  | "identity_collision"
  | "auth_denied"
  | "voice_media_not_granted"
  | "client_load_failed";

/** Failure-mode tag attached to `state.error` and `platform.voice.error` envelopes. §3a/§3d. */
export type VoiceErrorCode =
  | "voice_media_not_granted"
  | "mic_permission_denied"
  | "token_mint_failed"
  | "livekit_unreachable"
  | "identity_collision"
  | "client_load_failed"
  // PR-6 §3a — screen-share-specific failures. Distinct codes so the UI
  // can render targeted copy: a "permission denied" toast for sources
  // (handled by the picker / shell-overlay) shouldn't read like a generic
  // "voice failed" banner.
  | "screen_share_cancelled"
  | "screen_share_e2ee_unsupported"
  | "screen_share_room_full"
  | "screen_share_permission_denied"
  | "screen_share_codec_unsupported";

/**
 * One screen-share publication on a participant. PR-6 §3b. Plugins should
 * key tile state by `trackSid` — the publication identity LiveKit issues at
 * publish time and re-issues if the publisher restarts. `hasAudio` is true
 * when the publisher chose "share audio" in the picker; the audio track is
 * managed by the shell as a peer publication and atomically subscribes
 * with the video (PR-6 §5).
 */
export interface ScreenSharePublication {
  trackSid: string;
  hasAudio: boolean;
  /** True when the *local* participant is the publisher of this share —
   *  drives the persistent "You are sharing" privacy indicator (§3a /
   *  PR-6 contract §15). */
  isPublishedByLocal: boolean;
}

/** One participant in the active room. §3b. */
export interface ParticipantSnapshot {
  userId: string;
  identity: string;
  /** Display label sourced from the JWT `name` claim (Participant.name on the
   *  LiveKit client). Plugins should prefer this over `identity` for any
   *  human-facing UI; identity stays the bare UnCorded user id for stable
   *  matching. Empty/undefined when no display_name was registered for the
   *  user — render `identity` as the fallback. */
  name?: string;
  /** Avatar URL sourced from the LiveKit `metadata` claim
   *  (`{"avatarUrl": "..."}`). Empty/undefined when the user has no avatar
   *  configured — plugins should render the SDK's deterministic-hue fallback
   *  via `avatarHtml({ avatarUrl: null })`. */
  avatarUrl?: string;
  isLocal: boolean;
  micPublished: boolean;
  micMuted: boolean;
  /** Local-side subscription mute (per-listener), independent of the publisher. */
  localMuted: boolean;
  /** Local-side listener volume (0–1; 1 = unity). Defaults to 1. */
  localVolume?: number;
  /**
   * PR-6 §3b — screen-share publications on this participant. Empty when the
   * participant is not sharing. A participant *can* hold more than one if
   * multi-source publishing lands later, but in v1 either 0 or 1 entry; the
   * array shape avoids a future contract bump.
   */
  screenSharePublications?: ScreenSharePublication[];
}

/**
 * Public voice state pushed by the shell. §3a.
 *
 * `channelName` is hand-held through from the plugin's `platform.voice.connect`
 * — the shell never resolves channel records on its own. Optional so the type
 * is also valid before/after a connection. UI surfaces fall back to the id
 * slug when no name is provided.
 */
export interface VoiceState {
  status: VoiceStatus;
  serverId: string | null;
  channelId: string | null;
  channelName?: string;
  mic: { available: boolean; muted: boolean; serverMuted: boolean };
  error?: { code: VoiceErrorCode; message: string };
  reason?: VoiceReason;
  /** Whether the active server has voice configured (LIVEKIT_PUBLIC_URL is set
   *  on the runtime). Pushed by the shell on every voice state envelope. When
   *  `false`, plugins should render voice affordances in a disabled state and
   *  send `platform.voice.request-setup` instead of `connect` on user click —
   *  the shell shows the owner-only setup modal in response. Defaults to
   *  `true` for backwards compatibility with shells that predate the field. */
  provisioned?: boolean;
  /** True when the browser blocked audio playback (autoplay policy). The
   *  shell flips this from LiveKit's `AudioPlaybackStatusChanged` event; it
   *  stays true until the plugin sends `platform.voice.start-audio` from a
   *  user-gesture handler. Plugins should render an inline "Enable audio"
   *  affordance while this is true — without it, remote tracks subscribe but
   *  produce no sound. Distinct from `mic.muted` (which is the publish side). */
  audioPlaybackBlocked?: boolean;
  /** True when the user has deafened — all remote audio is silenced and the
   *  local mic is force-muted while deafened. Session-scoped (clears on
   *  disconnect). Plugins reflect this in their UI; sending `set-deafened`
   *  toggles it. */
  deafened?: boolean;
  /**
   * PR-6 §3a — screen-share substate. Pushed alongside every voice `state`
   * envelope. Plugins read this to drive: the picker ("starting"/"stopping"
   * spinner), the publisher tile's red border + "You are sharing" indicator
   * (`publishStatus === "publishing"`), the quality dropdown selection, the
   * cap-disabled tooltip on the Share button, and the e2ee/permission
   * disabled-state copy.
   *
   * Optional so the type stays valid for older shells that predate PR-6 —
   * plugins should treat absence as "no screen share active" and a missing
   * `provisioned` parent state as "voice not configured at all" (PR-5).
   */
  screenShare?: VoiceScreenShareState;
}

/** PR-6 §3a — public screen-share substate for plugin UI. */
export interface VoiceScreenShareState {
  /** Lifecycle of the *local* publish. `idle` = not sharing; `starting` =
   *  picker open / capture in flight; `publishing` = LiveKit ack'd publish;
   *  `stopping` = teardown in flight. */
  publishStatus: "idle" | "starting" | "publishing" | "stopping";
  /** LiveKit `trackSid` of the local publication, set when
   *  `publishStatus === "publishing"`. Used by plugins to find the matching
   *  ParticipantSnapshot.screenSharePublications entry. */
  publishTrackSid?: string;
  /** Active quality preset for the local publish. `balanced` is the default
   *  1080p30 production preset; `smooth` favors fps over resolution; `sharp`
   *  favors bitrate/detail; `source` is 1080p60. Live-swappable via
   *  `set-screen-share-quality`
   *  (replaceTrack on supported clients; brief stop+republish otherwise). */
  quality: VoiceScreenShareQuality;
  /** True when the local publish includes a paired `screen_share_audio`
   *  track (user opted in via the picker). */
  audioShared: boolean;
  /** Channel-scoped publisher cap (PR-6 §13, default 10). When
   *  `channelPublisherCount >= channelMaxPublishers` and local is not
   *  already publishing, plugins should render the Share button disabled
   *  with a "Channel is at the screen-share limit" tooltip. */
  channelMaxPublishers: number;
  channelPublisherCount: number;
  /** True when the channel has E2EE enabled. PR-6 §15 refuses screen-share
   *  on E2EE channels (track-level encryption for video is PR-7); plugins
   *  hide the Share button entirely with an inline "Screen share unavailable
   *  on encrypted channels" hint. */
  e2eeBlocked: boolean;
}

// ---------------------------------------------------------------------------
// Envelopes — shell → plugin frontend (§3).
// ---------------------------------------------------------------------------

export type VoiceStateEnvelope = { type: "platform.voice.state" } & VoiceState;

export interface VoiceParticipantsEnvelope {
  type: "platform.voice.participants";
  participants: ParticipantSnapshot[];
}

export interface VoiceActiveSpeakersEnvelope {
  type: "platform.voice.active-speakers";
  speakingUserIds: string[];
}

export interface VoiceErrorEnvelope {
  type: "platform.voice.error";
  code: VoiceErrorCode;
  message: string;
}

/**
 * PR-6 §3 — current LRU subscription state for screen shares. Re-pushed on
 * every subscribe/unsubscribe and on `TrackStreamStateChanged` (dynacast
 * pause/resume). Plugins use this to render which tiles are live vs.
 * tray-only and to overlay the "Stream paused" affordance.
 *
 * `volumePctClient` is the per-listener audio volume scale (0–100, where
 * 100 = unity); always 0 when the publication has no `screen_share_audio`
 * peer track. `streamPaused` reflects the SFU-side pause state — true means
 * the SFU has temporarily stopped forwarding due to bandwidth pressure.
 */
export interface VoiceScreenShareSubscription {
  trackSid: string;
  userId: string;
  subscribed: boolean;
  volumePctClient: number;
  streamPaused: boolean;
}

export interface VoiceScreenShareSubscriptionsEnvelope {
  type: "platform.voice.screen-share.subscriptions";
  subscriptions: VoiceScreenShareSubscription[];
}

/**
 * PR-6 §9 / §3 — popout state per visible track. Mirrors what the shell is
 * actively rendering so the plugin can show a "Watching in popout" placeholder
 * inside the slot grid. The shell is the single source of truth for popout
 * window lifetime; plugins request open/close via
 * `popout-screen-share` / `dock-screen-share`.
 */
export interface VoiceScreenSharePopoutEntry {
  trackSid: string;
  popped: boolean;
}

export interface VoiceScreenSharePopoutsEnvelope {
  type: "platform.voice.screen-share.popouts";
  popouts: VoiceScreenSharePopoutEntry[];
}

export type VoiceEnvelope =
  | VoiceStateEnvelope
  | VoiceParticipantsEnvelope
  | VoiceActiveSpeakersEnvelope
  | VoiceErrorEnvelope
  | VoiceScreenShareSubscriptionsEnvelope
  | VoiceScreenSharePopoutsEnvelope;

// ---------------------------------------------------------------------------
// Requests — plugin frontend → shell (§4).
// ---------------------------------------------------------------------------

export interface VoiceConnectRequest {
  type: "platform.voice.connect";
  channelId: string;
  channelName?: string;
}

export interface VoiceDisconnectRequest {
  type: "platform.voice.disconnect";
}

export interface VoiceSetMicMutedRequest {
  type: "platform.voice.set-mic-muted";
  muted: boolean;
}

export interface VoiceSetLocalParticipantMutedRequest {
  type: "platform.voice.set-local-participant-muted";
  userId: string;
  muted: boolean;
}

/**
 * Plugin-frontend → shell: per-user listener-side volume scaling. The shell
 * applies this by setting `RemoteAudioTrack.setVolume()` for every audio
 * publication on the matching participant, which forwards to
 * `HTMLMediaElement.volume`. Range is 0–1 (1 = unity); values outside [0, 1]
 * throw IndexSizeError synchronously, so the shell clamps. Gain boost (>1)
 * would require a Web Audio GainNode chain — not wired today.
 * Session-scoped; not persisted across disconnects.
 */
export interface VoiceSetLocalParticipantVolumeRequest {
  type: "platform.voice.set-local-participant-volume";
  userId: string;
  volume: number;
}

/**
 * Plugin-frontend → shell: toggle deafen. Deafening silences every remote
 * audio element and force-mutes the local mic publication; undeafening
 * restores remote audio at the per-user volume the user had set and
 * unmutes the mic if it wasn't manually muted before deafening. The shell
 * tracks the pre-deafen mic state internally so the round-trip is symmetric.
 */
export interface VoiceSetDeafenedRequest {
  type: "platform.voice.set-deafened";
  deafened: boolean;
}

/**
 * Plugin-frontend → shell: open the owner-only voice setup modal. Sent by
 * voice plugins when a user clicks a disabled voice channel (the shell has
 * pushed `platform.voice.state { provisioned: false }`). The shell decides
 * what to render: the setup modal for owners, a "ask the owner" toast for
 * everyone else.
 */
export interface VoiceRequestSetupRequest {
  type: "platform.voice.request-setup";
}

/**
 * Plugin-frontend → shell: unblock audio playback after the browser blocked
 * autoplay. Must be sent from a synchronous click/touch handler so the call
 * to `room.startAudio()` runs inside the user-gesture activation window. The
 * shell will flip `state.audioPlaybackBlocked` back to `false` once playback
 * actually resumes (driven by LiveKit's `AudioPlaybackStatusChanged`).
 */
export interface VoiceStartAudioRequest {
  type: "platform.voice.start-audio";
}

// ---------------------------------------------------------------------------
// PR-6 — screen-share request types (§4).
// ---------------------------------------------------------------------------

/**
 * Plugin-frontend → shell: begin a screen-share publish. The shell calls
 * `getDisplayMedia` (web) or invokes the custom thumbnail picker (Electron),
 * then publishes the resulting tracks via LiveKit.
 *
 * Concurrent dispatches dedup via the manager's in-flight Promise — clicking
 * the Share button twice within one tick won't open two pickers. Picker
 * cancellation surfaces as `platform.voice.error { code: "screen_share_cancelled" }`
 * with no state change.
 */
export interface VoiceStartScreenShareRequest {
  type: "platform.voice.start-screen-share";
  /** Opt-in audio share (system/tab audio). Web: `getDisplayMedia({ audio })`;
   *  Electron: passes through to the custom picker. */
  audio: boolean;
  quality: VoiceScreenShareQuality;
  /** Electron-only — pre-resolved source id from a custom picker. The shell
   *  ignores this on web (the browser owns picker UI). */
  sourceId?: string;
}

export interface VoiceStopScreenShareRequest {
  type: "platform.voice.stop-screen-share";
}

export interface VoiceSetScreenShareQualityRequest {
  type: "platform.voice.set-screen-share-quality";
  quality: VoiceScreenShareQuality;
}

/**
 * LRU subscribe — adds the track to the active 4-stream window. If the
 * window is already at capacity, the manager evicts the oldest active
 * subscription before subscribing.
 */
export interface VoiceSubscribeScreenShareRequest {
  type: "platform.voice.subscribe-screen-share";
  trackSid: string;
}

export interface VoiceUnsubscribeScreenShareRequest {
  type: "platform.voice.unsubscribe-screen-share";
  trackSid: string;
}

export interface VoicePopoutScreenShareRequest {
  type: "platform.voice.popout-screen-share";
  trackSid: string;
}

export interface VoiceDockScreenShareRequest {
  type: "platform.voice.dock-screen-share";
  trackSid: string;
}

/**
 * Slot reservations — plugins render `<div data-uc-screen-slot="…">`
 * placeholders, ask the shell to paint a `<video>` over the rect, and
 * report rect updates as the iframe layout shifts.
 *
 * `frameKey` is the postMessage origin/frame identifier the shell already
 * uses for every plugin iframe (PR-5 §17); the plugin SDK fills it from the
 * handshake context, so plugin authors never write it manually.
 */
export interface VoiceRegisterScreenSlotRequest {
  type: "platform.voice.register-screen-slot";
  slotId: string;
  trackSid: string;
  rect: { x: number; y: number; width: number; height: number };
}

export interface VoiceUpdateScreenSlotRequest {
  type: "platform.voice.update-screen-slot";
  slotId: string;
  rect: { x: number; y: number; width: number; height: number };
}

export interface VoiceUnregisterScreenSlotRequest {
  type: "platform.voice.unregister-screen-slot";
  slotId: string;
}

/** Per-listener audio volume on a screen-share-audio track. 0–100, clamped
 *  client-side; the shell maps to RemoteAudioTrack.setVolume() in the 0–1
 *  range. Session-scoped (clears on disconnect). */
export interface VoiceSetScreenShareVolumeRequest {
  type: "platform.voice.set-screen-share-volume";
  trackSid: string;
  volumePct: number;
}

export interface VoiceMuteScreenShareAudioRequest {
  type: "platform.voice.mute-screen-share-audio";
  trackSid: string;
  muted: boolean;
}

/**
 * Admin "Stop their share" — privileged path that bypasses the local user's
 * subscription state. The shell forwards to the plugin backend via a
 * dedicated IPC handler (`voice.stopShare`); the backend re-checks
 * `voice.moderation.stop_share` permission and calls the runtime
 * `voice.removeParticipant` SDK method. LiveKit doesn't expose track-level
 * mute today (PR-6 §13), so the moderation primitive is participant-kick.
 */
export interface VoiceAdminStopScreenShareRequest {
  type: "platform.voice.admin-stop-screen-share";
  channelId: string;
  userId: string;
  reason?: string;
}

export type VoiceScreenShareRequest =
  | VoiceStartScreenShareRequest
  | VoiceStopScreenShareRequest
  | VoiceSetScreenShareQualityRequest
  | VoiceSubscribeScreenShareRequest
  | VoiceUnsubscribeScreenShareRequest
  | VoicePopoutScreenShareRequest
  | VoiceDockScreenShareRequest
  | VoiceRegisterScreenSlotRequest
  | VoiceUpdateScreenSlotRequest
  | VoiceUnregisterScreenSlotRequest
  | VoiceSetScreenShareVolumeRequest
  | VoiceMuteScreenShareAudioRequest
  | VoiceAdminStopScreenShareRequest;

export type VoiceRequest =
  | VoiceConnectRequest
  | VoiceDisconnectRequest
  | VoiceSetMicMutedRequest
  | VoiceSetLocalParticipantMutedRequest
  | VoiceSetLocalParticipantVolumeRequest
  | VoiceSetDeafenedRequest
  | VoiceRequestSetupRequest
  | VoiceStartAudioRequest
  | VoiceScreenShareRequest;
