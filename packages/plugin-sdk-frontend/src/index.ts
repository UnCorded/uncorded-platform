// @uncorded/plugin-sdk-frontend — browser SDK for UnCorded plugin frontends.
//
// Usage:
//   const sdk = await createPluginFrontend()
//   await sdk.request("getMessages", { channelId: "abc" })
//   sdk.subscribe("text-channels.message.created", handler)
//   sdk.on("notification", handler)   // broadcast, slug prefix stripped
//   sdk.onNavigate(({ itemId }) => { ... })
//
//   // UI helpers — framework-agnostic, safe to use in vanilla iframes.
//   import { createAvatar, avatarHtml } from "@uncorded/plugin-sdk-frontend";
//   container.appendChild(createAvatar({ userId, displayName, avatarUrl }));

export { createPluginFrontend } from "./plugin";
export { SDK_API_VERSION } from "./version";
export { PluginError } from "./errors";
export type {
  PluginFrontend,
  NavigateEvent,
  EventHandler,
  CreatePluginFrontendOptions,
  VoicePluginApi,
  VoiceErrorPayload,
  PluginPanelOpenOptions,
  UserCardShowOptions,
  VoiceStartScreenShareOptions,
  VoiceScreenSlotHandle,
} from "./types";

// Avatar primitive — see avatar.ts. Color + initial logic now flows through
// the shared @uncorded/shared util so the runtime, shell, and plugin SDK all
// pick the same hue for the same id.
export {
  createAvatar,
  avatarHtml,
  avatarColor,
  avatarTextColor,
  avatarInitial,
  isSafeAvatarUrl,
} from "./avatar";
export type { AvatarOptions, AvatarShape } from "./avatar";

// File-attachment client — see files.ts.
export { UploadError } from "./files";
export type {
  FilesPluginApi,
  UploadOptions,
  UploadProgress,
  UploadResult,
} from "./files";

// Reverse-proxy client — see proxy.ts. `sdk.proxy.openMount(mount)` bootstraps
// a declared proxy mount and returns the iframe + first-party fallback URLs.
export { ProxyError } from "./proxy";
export type { ProxyPluginApi, ProxyMountSession } from "./proxy";

// `platform.voice.*` shell ↔ plugin frontend envelope contract — see
// `.claude/docs/Overview/pr-5-voice-client-contract.md` §3 / §4 (PR-5) and
// `.claude/docs/Overview/pr-6-screen-share-contract.md` (PR-6 additions).
export type {
  VoiceStatus,
  VoiceReason,
  VoiceErrorCode,
  VoiceScreenShareQuality,
  ParticipantSnapshot,
  ScreenSharePublication,
  VoiceState,
  VoiceScreenShareState,
  VoiceStateEnvelope,
  VoiceParticipantsEnvelope,
  VoiceActiveSpeakersEnvelope,
  VoiceErrorEnvelope,
  VoiceScreenShareSubscription,
  VoiceScreenShareSubscriptionsEnvelope,
  VoiceScreenSharePopoutEntry,
  VoiceScreenSharePopoutsEnvelope,
  VoiceEnvelope,
  VoiceConnectRequest,
  VoiceDisconnectRequest,
  VoiceSetMicMutedRequest,
  VoiceSetLocalParticipantMutedRequest,
  VoiceSetLocalParticipantVolumeRequest,
  VoiceSetDeafenedRequest,
  VoiceRequestSetupRequest,
  VoiceStartAudioRequest,
  VoiceStartScreenShareRequest,
  VoiceStopScreenShareRequest,
  VoiceSetScreenShareQualityRequest,
  VoiceSubscribeScreenShareRequest,
  VoiceUnsubscribeScreenShareRequest,
  VoicePopoutScreenShareRequest,
  VoiceDockScreenShareRequest,
  VoiceRegisterScreenSlotRequest,
  VoiceUpdateScreenSlotRequest,
  VoiceUnregisterScreenSlotRequest,
  VoiceSetScreenShareVolumeRequest,
  VoiceMuteScreenShareAudioRequest,
  VoiceAdminStopScreenShareRequest,
  VoiceScreenShareRequest,
  VoiceRequest,
} from "./voice";
