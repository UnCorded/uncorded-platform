// Public surface of the scoped-presence runtime module.

export { ScopedPresenceModule } from "./module";
export type { JoinSuccess, ScopedPresenceOptions, InstalledSlugsProvider } from "./module";
export { handlePresenceIpc } from "./ipc";
export { ScopeRegistry } from "./registry";
export {
  PRESENCE_ERROR_CODES,
  PRESENCE_LIMITS,
} from "./types";
export type {
  PresenceErrorCode,
  PresenceError,
  PresenceResult,
  EvictionReason,
  PresenceEntryInternal,
} from "./types";
export { validateScope, prefixScope, crossPluginCheck } from "./scope";
