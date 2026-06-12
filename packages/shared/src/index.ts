export {
  validateManifest,
  PLUGIN_SLUG_RE,
  DEFAULT_PROXY_WS_FRAME_BYTES,
  MIN_PROXY_WS_FRAME_BYTES,
  MAX_PROXY_WS_FRAME_BYTES,
} from "./manifest";
export type { PluginManifest, ManifestError, ManifestResult, PluginSetting, PluginSettingType, ProxyMount, ProxyMountAccess } from "./manifest";
export { parseSemver, satisfiesRange } from "./semver";
export { createLogger, rootLogger, getLogLevel, setLogLevel, parseLogLevel } from "./logger";
export type { Logger, LogLevel } from "./logger";
export { getClientColor, getClientColorString, getNameInitial } from "./avatar-color";
export type { ClientColor } from "./avatar-color";
