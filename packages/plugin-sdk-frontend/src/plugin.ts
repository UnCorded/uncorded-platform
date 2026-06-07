// createPluginFrontend() — async factory that performs the shell handshake and
// returns a fully-initialized SDK handle.
//
// Security: every inbound postMessage is origin-checked against shellOrigin
// (derived from document.referrer on load). All outbound postMessages are
// targeted at shellOrigin — never "*".

import { performHandshake } from "./handshake";
import { createRequestClient } from "./request";
import { createEventsClient } from "./events";
import { createFilesClient } from "./files";
import { observeScreenSlot as observeScreenSlotImpl } from "./screen-slots";
import type {
  CreatePluginFrontendOptions,
  EventHandler,
  FileDownloadOptions,
  FilePreviewOptions,
  NavigateEvent,
  PluginPanelOpenOptions,
  PluginFrontend,
  UserCardShowOptions,
  VoiceErrorPayload,
  VoicePluginApi,
  VoiceScreenSlotHandle,
  VoiceStartScreenShareOptions,
} from "./types";
import type {
  ParticipantSnapshot,
  VoiceActiveSpeakersEnvelope,
  VoiceErrorEnvelope,
  VoiceParticipantsEnvelope,
  VoiceScreenSharePopoutEntry,
  VoiceScreenSharePopoutsEnvelope,
  VoiceScreenShareSubscription,
  VoiceScreenShareSubscriptionsEnvelope,
  VoiceState,
  VoiceStateEnvelope,
} from "./voice";

const HANDSHAKE_TIMEOUT_DEFAULT_MS = 5_000;

interface NavigateHandlerEntry {
  id: symbol;
  handler: (nav: NavigateEvent) => void;
}

export async function createPluginFrontend(
  options?: CreatePluginFrontendOptions,
): Promise<PluginFrontend> {
  const { token, slug, runtimeCapabilities, shellOrigin, initialNavigation } = await performHandshake(
    options?.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_DEFAULT_MS,
  );

  function send(msg: unknown): void {
    window.parent.postMessage(msg, shellOrigin);
  }

  const requestClient = createRequestClient(send, slug);
  const eventsClient = createEventsClient(send, slug);
  const filesClient = createFilesClient({
    token,
    slug,
    // Iframe is loaded directly from the runtime origin
    // (`iframe.src = "${tunnelUrl}/plugins/${slug}/ui/"`), so
    // `window.location.origin` is the runtime origin even when the iframe is
    // sandboxed without `allow-same-origin`. POST /upload returns wildcard ACAO
    // so opaque-origin (`Origin: null`) requests succeed.
    runtimeOrigin: window.location.origin,
  });
  const navigateHandlers: NavigateHandlerEntry[] = [];
  let currentNavigation: NavigateEvent | null = initialNavigation ?? null;

  // Voice — handler buckets for each `platform.voice.*` envelope type. Plugins
  // register through the `platform.voice.on*` methods; the message dispatcher
  // below fans out incoming envelopes. Each handler list is iterated over a
  // copy so a handler that unsubscribes mid-fanout doesn't shift the iteration.
  const voiceStateHandlers: Array<(state: VoiceState) => void> = [];
  const voiceParticipantsHandlers: Array<(p: ParticipantSnapshot[]) => void> = [];
  const voiceActiveSpeakersHandlers: Array<(ids: string[]) => void> = [];
  const voiceErrorHandlers: Array<(err: VoiceErrorPayload) => void> = [];
  const voiceScreenShareSubscriptionHandlers: Array<(subs: VoiceScreenShareSubscription[]) => void> = [];
  const voiceScreenSharePopoutHandlers: Array<(popouts: VoiceScreenSharePopoutEntry[]) => void> = [];

  function safeFanout<T>(handlers: Array<(payload: T) => void>, payload: T): void {
    for (const fn of [...handlers]) {
      try {
        fn(payload);
      } catch {
        // Individual handler errors are isolated.
      }
    }
  }

  window.addEventListener("message", (event: MessageEvent) => {
    // Origin validation — reject any message not from the shell.
    if (event.origin !== shellOrigin) return;

    const msg = event.data as Record<string, unknown> | null | undefined;
    if (!msg || typeof msg["type"] !== "string") return;

    switch (msg["type"]) {
      case "response":
        requestClient.handleResponse(msg);
        break;

      case "event": {
        const topic = msg["topic"];
        if (typeof topic === "string") {
          eventsClient.handleEvent(topic, msg["payload"]);
        }
        break;
      }

      case "uncorded.navigate": {
        // G10 fix: the shell currently sends channelId/channelName (text-channels-specific).
        // Accept both old and new field names so this works before and after the shell update.
        const itemId = msg["itemId"] ?? msg["channelId"];
        const itemLabel = msg["itemLabel"] ?? msg["channelName"];
        if (typeof itemId !== "string" || typeof itemLabel !== "string") break;
        const nav: NavigateEvent = { itemId, itemLabel };
        currentNavigation = nav;
        for (const { handler } of [...navigateHandlers]) {
          try {
            handler(nav);
          } catch {
            // Individual handler errors don't affect others.
          }
        }
        break;
      }

      case "platform.voice.state": {
        // Trusted source (shell) — the structural guard is parity with the
        // other voice-envelope cases below, not an attack-surface check.
        // Catches a regression where the shell ships a malformed state push
        // instead of silently mirroring garbage into the plugin's UI.
        if (typeof msg["status"] !== "string") break;
        const env = msg as unknown as VoiceStateEnvelope;
        const { type: _t, ...state } = env;
        safeFanout(voiceStateHandlers, state as VoiceState);
        break;
      }

      case "platform.voice.participants": {
        const env = msg as unknown as VoiceParticipantsEnvelope;
        if (Array.isArray(env.participants)) {
          safeFanout(voiceParticipantsHandlers, env.participants);
        }
        break;
      }

      case "platform.voice.active-speakers": {
        const env = msg as unknown as VoiceActiveSpeakersEnvelope;
        if (Array.isArray(env.speakingUserIds)) {
          safeFanout(voiceActiveSpeakersHandlers, env.speakingUserIds);
        }
        break;
      }

      case "platform.voice.error": {
        const env = msg as unknown as VoiceErrorEnvelope;
        if (typeof env.code === "string" && typeof env.message === "string") {
          safeFanout(voiceErrorHandlers, { code: env.code, message: env.message });
        }
        break;
      }

      case "platform.voice.screen-share.subscriptions": {
        const env = msg as unknown as VoiceScreenShareSubscriptionsEnvelope;
        if (Array.isArray(env.subscriptions)) {
          safeFanout(voiceScreenShareSubscriptionHandlers, env.subscriptions);
        }
        break;
      }

      case "platform.voice.screen-share.popouts": {
        const env = msg as unknown as VoiceScreenSharePopoutsEnvelope;
        if (Array.isArray(env.popouts)) {
          safeFanout(voiceScreenSharePopoutHandlers, env.popouts);
        }
        break;
      }

      // uncorded.token is only handled during handshake — silently ignored here.
    }
  });

  function makeUnsubscribe<T>(list: Array<(payload: T) => void>, fn: (payload: T) => void): () => void {
    list.push(fn);
    return () => {
      const idx = list.indexOf(fn);
      if (idx !== -1) list.splice(idx, 1);
    };
  }

  const voice: VoicePluginApi = {
    get granted() {
      return runtimeCapabilities.includes("voice.media");
    },
    get screenShareGranted() {
      return runtimeCapabilities.includes("voice.screen_share");
    },
    get moderationGranted() {
      return runtimeCapabilities.includes("voice.moderation");
    },
    connect(input) {
      send({
        type: "platform.voice.connect",
        channelId: input.channelId,
        ...(input.channelName !== undefined ? { channelName: input.channelName } : {}),
      });
    },
    disconnect() {
      send({ type: "platform.voice.disconnect" });
    },
    setMicMuted(muted) {
      send({ type: "platform.voice.set-mic-muted", muted });
    },
    setLocalParticipantMuted(input) {
      send({
        type: "platform.voice.set-local-participant-muted",
        userId: input.userId,
        muted: input.muted,
      });
    },
    setLocalParticipantVolume(input) {
      send({
        type: "platform.voice.set-local-participant-volume",
        userId: input.userId,
        volume: input.volume,
      });
    },
    setDeafened(deafened) {
      send({ type: "platform.voice.set-deafened", deafened });
    },
    startAudio() {
      send({ type: "platform.voice.start-audio" });
    },
    startScreenShare(options: VoiceStartScreenShareOptions) {
      send({
        type: "platform.voice.start-screen-share",
        audio: options.audio,
        quality: options.quality,
        ...(options.sourceId !== undefined ? { sourceId: options.sourceId } : {}),
      });
    },
    stopScreenShare() {
      send({ type: "platform.voice.stop-screen-share" });
    },
    setScreenShareQuality(quality) {
      send({ type: "platform.voice.set-screen-share-quality", quality });
    },
    subscribeScreenShare(trackSid) {
      send({ type: "platform.voice.subscribe-screen-share", trackSid });
    },
    unsubscribeScreenShare(trackSid) {
      send({ type: "platform.voice.unsubscribe-screen-share", trackSid });
    },
    popoutScreenShare(trackSid) {
      send({ type: "platform.voice.popout-screen-share", trackSid });
    },
    dockScreenShare(trackSid) {
      send({ type: "platform.voice.dock-screen-share", trackSid });
    },
    setScreenShareVolume(trackSid, volumePct) {
      send({
        type: "platform.voice.set-screen-share-volume",
        trackSid,
        volumePct,
      });
    },
    muteScreenShareAudio(trackSid, muted) {
      send({ type: "platform.voice.mute-screen-share-audio", trackSid, muted });
    },
    adminStopScreenShare(input) {
      send({
        type: "platform.voice.admin-stop-screen-share",
        channelId: input.channelId,
        userId: input.userId,
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
      });
    },
    observeScreenSlot(el, trackSid, slotId): VoiceScreenSlotHandle {
      return observeScreenSlotImpl({ send }, el, trackSid, slotId);
    },
    onState(handler) {
      return makeUnsubscribe(voiceStateHandlers, handler);
    },
    onParticipants(handler) {
      return makeUnsubscribe(voiceParticipantsHandlers, handler);
    },
    onActiveSpeakers(handler) {
      return makeUnsubscribe(voiceActiveSpeakersHandlers, handler);
    },
    onError(handler) {
      return makeUnsubscribe(voiceErrorHandlers, handler);
    },
    onScreenShareSubscriptions(handler) {
      return makeUnsubscribe(voiceScreenShareSubscriptionHandlers, handler);
    },
    onScreenSharePopouts(handler) {
      return makeUnsubscribe(voiceScreenSharePopoutHandlers, handler);
    },
  };

  return {
    get slug() {
      return slug;
    },
    get token() {
      return token;
    },

    request<T = unknown>(action: string, params?: Record<string, unknown>): Promise<T> {
      return requestClient.request<T>(action, params);
    },

    subscribe<T = unknown>(topic: string, handler: EventHandler<T>): () => void {
      return eventsClient.subscribe<T>(topic, handler);
    },

    on<T = unknown>(event: string, handler: EventHandler<T>): () => void {
      return eventsClient.on<T>(event, handler);
    },

    onNavigate(handler: (nav: NavigateEvent) => void): () => void {
      const id = Symbol();
      navigateHandlers.push({ id, handler });
      if (currentNavigation !== null) {
        queueMicrotask(() => {
          if (navigateHandlers.some((entry) => entry.id === id)) {
            handler(currentNavigation!);
          }
        });
      }
      return () => {
        const idx = navigateHandlers.findIndex((e) => e.id === id);
        if (idx !== -1) navigateHandlers.splice(idx, 1);
      };
    },

    files: filesClient,

    platform: {
      panels: {
        open(options: PluginPanelOpenOptions): void {
          send({
            type: "platform.panels.open",
            itemId: options.itemId,
            itemLabel: options.itemLabel,
            ...(options.itemIcon !== undefined ? { itemIcon: options.itemIcon } : {}),
            ...(options.placement !== undefined ? { placement: options.placement } : {}),
            ...(options.mode !== undefined ? { mode: options.mode } : {}),
          });
        },
        focusCurrent(): void {
          send({ type: "platform.panels.focus-current" });
        },
      },
      voice,
      userCard: {
        show(options: UserCardShowOptions): void {
          send({
            type: "platform.user-card.show",
            userId: options.userId,
            ...(options.displayName !== undefined ? { displayName: options.displayName } : {}),
            ...(options.avatarUrl !== undefined ? { avatarUrl: options.avatarUrl } : {}),
          });
        },
      },
      files: {
        preview(options: FilePreviewOptions): void {
          send({
            type: "platform.files.preview",
            url: options.url,
            name: options.name,
          });
        },
        download(options: FileDownloadOptions): void {
          send({
            type: "platform.files.download",
            url: options.url,
            name: options.name,
          });
        },
      },
    },
  };
}
