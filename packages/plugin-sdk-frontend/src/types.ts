// Public types for @uncorded/plugin-sdk-frontend.

import type { FilesPluginApi } from "./files";
import type {
  ParticipantSnapshot,
  VoiceErrorCode,
  VoiceScreenShareQuality,
  VoiceScreenSharePopoutEntry,
  VoiceScreenShareSubscription,
  VoiceState,
} from "./voice";

/** Payload delivered to sdk.onNavigate() handlers. Uses generic names — G10 fix. */
export interface NavigateEvent {
  itemId: string;
  itemLabel: string;
}

export type EventHandler<T = unknown> = (payload: T) => void | Promise<void>;

/** Payload delivered to `platform.voice.onError` handlers. */
export interface VoiceErrorPayload {
  code: VoiceErrorCode;
  message: string;
}

/**
 * Options for `platform.voice.startScreenShare()`. The shell owns the picker
 * (web: `getDisplayMedia`; Electron: custom thumbnail modal); plugins only
 * declare intent. `audio` opts in to the paired `screen_share_audio` track;
 * cursor is always captured (PR-6 §5).
 */
export interface VoiceStartScreenShareOptions {
  audio: boolean;
  quality: VoiceScreenShareQuality;
  /** Electron-only — pre-resolved source id from a custom picker. Web ignores. */
  sourceId?: string;
}

/**
 * Slot reservation handle returned by
 * `platform.voice.observeScreenSlot(el, trackSid)`. The SDK attaches a
 * `ResizeObserver` to the placeholder element, posts
 * `register-screen-slot` / `update-screen-slot` rect updates as the iframe
 * layout shifts (rAF-coalesced), and emits `unregister-screen-slot` when the
 * caller invokes the returned dispose function. Calling `dispose()` more than
 * once is a no-op.
 */
export type VoiceScreenSlotHandle = () => void;

/**
 * Voice bridge — the iframe side of the §3 / §4 `platform.voice.*` postMessage
 * contract. The shell owns the LiveKit Room and pushes state in via the `on*`
 * hooks; the plugin posts user intent (connect, mute, leave) back via the
 * action methods. The plugin itself never imports `livekit-client` or touches
 * `getUserMedia` — those live in the shell voice manager.
 *
 * Capability gating: `granted` reflects whether the plugin's manifest declares
 * (and the runtime granted) `voice.media`. Use it to hide "Join voice"
 * affordances at render time; the manager will also reject `connect()` calls
 * from un-granted plugins, but defending in the UI prevents the user ever
 * seeing a misleading button.
 */
export interface VoicePluginApi {
  /** True if the runtime granted this plugin the `voice.media` capability. */
  readonly granted: boolean;
  /** True if the runtime granted this plugin the `voice.screen_share` capability (PR-6). */
  readonly screenShareGranted: boolean;
  /** True if the runtime granted this plugin the `voice.moderation` capability (PR-6 admin "Stop their share"). */
  readonly moderationGranted: boolean;

  /** Send §4a `platform.voice.connect`. The plugin owns the channel record, so it must pass `channelName` for the shell to display. */
  connect(input: { channelId: string; channelName?: string }): void;
  /** Send §4b `platform.voice.disconnect`. */
  disconnect(): void;
  /** Send §4c `platform.voice.set-mic-muted`. */
  setMicMuted(muted: boolean): void;
  /** Send §4d `platform.voice.set-local-participant-muted`. */
  setLocalParticipantMuted(input: { userId: string; muted: boolean }): void;
  /** Per-user listener-side volume (0–2; 1 = unity, >1 = gain boost). */
  setLocalParticipantVolume(input: { userId: string; volume: number }): void;
  /** Toggle deafen — silences all remote audio and force-mutes the local mic. */
  setDeafened(deafened: boolean): void;
  /**
   * Send `platform.voice.start-audio` to unblock browser-blocked autoplay.
   * MUST be called from a synchronous click/touch handler — the shell's
   * `room.startAudio()` call has to land inside the user-gesture activation
   * window or it no-ops. Render the affordance whenever
   * `state.audioPlaybackBlocked === true`.
   */
  startAudio(): void;

  // -------------------------------------------------------------------------
  // PR-6 — screen share
  // -------------------------------------------------------------------------

  /**
   * Begin a screen-share publish. Concurrent dispatches dedup via the shell's
   * in-flight Promise (clicking Share twice in one tick won't open two pickers);
   * the second call returns silently and resolves on the first call's
   * outcome. Picker cancellation surfaces as a transient
   * `screen_share_cancelled` error envelope, no state change.
   */
  startScreenShare(options: VoiceStartScreenShareOptions): void;
  stopScreenShare(): void;
  setScreenShareQuality(quality: VoiceScreenShareQuality): void;
  /** LRU subscribe — adds the track to the active 4-stream window. Manager evicts the oldest if at cap. */
  subscribeScreenShare(trackSid: string): void;
  unsubscribeScreenShare(trackSid: string): void;
  popoutScreenShare(trackSid: string): void;
  dockScreenShare(trackSid: string): void;
  /** Per-listener audio volume (0–100). Session-scoped. */
  setScreenShareVolume(trackSid: string, volumePct: number): void;
  muteScreenShareAudio(trackSid: string, muted: boolean): void;
  /** Admin "Stop their share" — backend re-checks `voice.moderation.stop_share` and kicks the participant. */
  adminStopScreenShare(input: { channelId: string; userId: string; reason?: string }): void;

  /**
   * Reserve a `<video>` slot painted by the shell over the given placeholder
   * element. The SDK observes the element's bounding rect (rAF-coalesced) and
   * updates the shell as it shifts. Returns a dispose function that
   * unregisters the slot. Calling dispose more than once is a no-op.
   *
   * Pass any stable string for `slotId` that's unique within this iframe;
   * convention is `"slot-0"…"slot-3"` for the 4-tile grid.
   */
  observeScreenSlot(
    el: HTMLElement,
    trackSid: string,
    slotId: string,
  ): VoiceScreenSlotHandle;

  /** Subscribe to §3a `platform.voice.state` pushes. Returns unsubscribe. */
  onState(handler: (state: VoiceState) => void): () => void;
  /** Subscribe to §3b `platform.voice.participants` pushes. Returns unsubscribe. */
  onParticipants(handler: (participants: ParticipantSnapshot[]) => void): () => void;
  /** Subscribe to §3c `platform.voice.active-speakers` pushes. Throttled to 5/sec by the shell — UI must not assume per-frame fidelity. Returns unsubscribe. */
  onActiveSpeakers(handler: (speakingUserIds: string[]) => void): () => void;
  /** Subscribe to §3d `platform.voice.error` pushes (transient). Returns unsubscribe. */
  onError(handler: (err: VoiceErrorPayload) => void): () => void;
  /** Subscribe to PR-6 LRU subscription state pushes. Returns unsubscribe. */
  onScreenShareSubscriptions(handler: (subs: VoiceScreenShareSubscription[]) => void): () => void;
  /** Subscribe to PR-6 popout state pushes. Returns unsubscribe. */
  onScreenSharePopouts(handler: (popouts: VoiceScreenSharePopoutEntry[]) => void): () => void;
}

export interface PluginPanelOpenOptions {
  /** Plugin-local route/id for the new panel. Delivered back via onNavigate(). */
  itemId: string;
  /** Human-readable panel title. */
  itemLabel: string;
  /** Optional icon token/string shown by shell panel chrome where supported. */
  itemIcon?: string | undefined;
  /** Initial placement. Defaults to opening beside the requesting panel. */
  placement?: "beside-current" | "replace-current" | undefined;
  /** Duplicate policy within the current workspace. Defaults to reuse-or-create. */
  mode?: "reuse-or-create" | "new" | undefined;
}

/** Options for platform.files.preview(). */
export interface FilePreviewOptions {
  /**
   * Runtime file URL (the inline form, *without* `?download=1`). Must point
   * at the same runtime that issued the plugin token; the shell rejects URLs
   * targeting any other origin.
   */
  url: string;
  /** Filename shown in the overlay caption and used as the download attribute. */
  name: string;
}

/** Options for platform.files.download(). */
export interface FileDownloadOptions {
  /**
   * Runtime file URL — either the bare signed form or one already carrying
   * `?download=1`. The shell forces `?download=1` before kicking off the
   * download so plugins don't have to thread that param themselves. Must
   * point at the same runtime that issued the plugin token; the shell
   * rejects URLs targeting any other origin.
   */
  url: string;
  /**
   * Original filename. The shell appends `?n=<encoded>` so the runtime emits
   * `Content-Disposition: attachment; filename="<original>"` (RFC 6266); the
   * `download` HTML attribute is ignored cross-origin so the header is the
   * only knob that survives.
   */
  name: string;
}

/** Options for platform.userCard.show(). */
export interface UserCardShowOptions {
  /** Stable user identifier. Required — the card will not render without it. */
  userId: string;
  /**
   * Display name to show in the card hero. When omitted, the shell uses
   * the userId as the visible label so the card never shows "?".
   */
  displayName?: string | undefined;
  /**
   * Optional https avatar URL. The shell guards against non-http(s) values
   * and falls back to the deterministic-color initial when missing.
   */
  avatarUrl?: string | null | undefined;
}

/** The fully-initialized frontend SDK handle. All methods are safe to call immediately. */
export interface PluginFrontend {
  /** The plugin's slug, as assigned by the runtime. */
  readonly slug: string;
  /** The auth token issued by the runtime for this session. */
  readonly token: string;

  /**
   * Send a request to the plugin backend subprocess and wait for the response.
   * Correlates by ID — same pattern as the backend sdk.request().
   */
  request<T = unknown>(action: string, params?: Record<string, unknown>): Promise<T>;

  /**
   * Subscribe to server-side event bus topics (e.g. "text-channels.message.created").
   * Sends a subscribe postMessage to the shell; runtime delivers matching events.
   * Returns an unsubscribe function.
   */
  subscribe<T = unknown>(topic: string, handler: EventHandler<T>): () => void;

  /**
   * Receive broadcast events pushed from the plugin backend via sdk.broadcast.
   * The slug prefix is stripped transparently — write sdk.on("status.update", handler),
   * not sdk.on("text-channels.status.update", handler).
   * Returns an unsubscribe function.
   *
   * NOTE (G9): No subscribe message is sent. Broadcast events are pushed directly to
   * the WS connection by the backend; the shell routes all slug-prefixed events to this iframe.
   */
  on<T = unknown>(event: string, handler: EventHandler<T>): () => void;

  /**
   * Register a handler for sidebar navigation events (user selects a sidebar item).
   * Returns an unsubscribe function.
   */
  onNavigate(handler: (nav: NavigateEvent) => void): () => void;

  /**
   * Attachment helper — wraps the runtime's `POST /upload` endpoint with
   * progress events, AbortSignal cancellation, and a structured error envelope.
   * See `FilesPluginApi`.
   */
  readonly files: FilesPluginApi;

  /** Platform-level capabilities exposed to plugins. */
  readonly platform: {
    readonly panels: {
      /**
       * Ask the shell to open another panel for this same plugin. The shell
       * owns placement and validation; the new iframe receives the requested
       * itemId/itemLabel through onNavigate().
       */
      open(options: PluginPanelOpenOptions): void;
      /** Ask the shell to focus/fullscreen the current panel. */
      focusCurrent(): void;
    };
    /**
     * Voice bridge — see `VoicePluginApi`. Available regardless of capability,
     * but `connect()` will fail (and `granted` is false) when the plugin's
     * manifest does not declare `voice.media`.
     */
    readonly voice: VoicePluginApi;
    readonly userCard: {
      /**
       * Ask the shell to surface its rich user card for the given user.
       * Plugins typically wire this to avatar click handlers — the shell
       * owns the rendering so every plugin gets the same look + behavior
       * for free, and future enhancements (DM CTA, mutual servers, role
       * badges) ship across all plugins simultaneously.
       *
       * No manifest declaration is required; the shell decides whether to
       * honor the request based on its own UX policy.
       */
      show(options: UserCardShowOptions): void;
    };
    readonly files: {
      /**
       * Ask the shell to open the file-preview overlay over a runtime file
       * URL. The shell renders the overlay outside the plugin sandbox so
       * PDFs (and other inline-safe MIMEs) render in a browsing context
       * with a real origin — nested iframes inside the plugin's own sandbox
       * inherit its opaque origin and Chromium's PDFium refuses to paint
       * there. URLs are pinned to the requesting iframe's runtime origin.
       */
      preview(options: FilePreviewOptions): void;
      /**
       * Ask the shell to trigger a native download for a runtime file URL.
       * The plugin's own `<a download>` path is unreliable: cross-origin
       * `download` attribute is ignored, and on Linux Electron the
       * setWindowOpenHandler popup-intercept flow silently drops
       * `webContents.downloadURL`. The shell owns the download trigger so
       * every platform (web, macOS, Windows, Linux) goes through the same
       * path. URLs are pinned to the requesting iframe's runtime origin.
       */
      download(options: FileDownloadOptions): void;
    };
  };
}

/** Options for createPluginFrontend(). */
export interface CreatePluginFrontendOptions {
  /**
   * How long to wait for the shell to respond to uncorded.ready before rejecting.
   * Default: 5000ms.
   */
  handshakeTimeoutMs?: number | undefined;
}
