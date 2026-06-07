// @uncorded/plugin-sdk — the public API surface for plugin developers.
// Wraps the stdio IPC transport into a clean, typed SDK handle.

export type {
  PluginHandle,
  RequestHandler,
  EventHandler,
  SubscribeOptions,
  EventsApi,
  PermissionsApi,
  DataApi,
  DataReadQuery,
  CoreApi,
  CoreUser,
  KvApi,
  FetchOptions,
  FetchResponse,
  ScheduleApi,
  ScheduleOptions,
  ScheduledHandler,
  PresenceApi,
  PresenceHandler,
  PresenceUser,
  PresenceEntry,
  BroadcastApi,
  VoiceApi,
  VoiceJoinToken,
  VoiceTokenGrants,
} from "./types";

export { getCurrentSession, getRequestContext } from "./request-context";

export { SdkError, SdkProtocolError } from "./errors";

export { createPlugin } from "./plugin";
export type { FileUploadedMessage, PluginOptions } from "./plugin";

export type { FilesApi, FileStat, FileListEntry, SignedFile } from "./files";
