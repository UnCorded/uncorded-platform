// Desktop auto-update state machine + IPC surface.
//
// Structured as pure reducers so reducer behavior is unit-testable without
// spinning up Electron. `setupAutoUpdater` wires reducers to the real
// `electron-updater` event stream; `setupAutoUpdateIpc` exposes the
// user-gated triggers + snapshot channel to the renderer.
//
// Disabled in dev (!app.isPackaged), on non-AppImage Linux, and when
// `UNCORDED_DISABLE_AUTO_UPDATE=1`. In those cases no timers are armed and
// no electron-updater listeners attach — only the IPC snapshot handler
// responds, returning { enabled: false, status: "disabled" }.

import { ipcMain } from "electron";
import {
  autoUpdater,
  type ProgressInfo,
  type UpdateInfo,
} from "electron-updater";
import { IPC } from "./ipc";

export type UpdateStatus =
  | "disabled"
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "downloaded"
  | "error";

export type ErrorContext = "check" | "download" | "install" | null;

export interface UpdateState {
  enabled: boolean;
  status: UpdateStatus;
  currentVersion: string;
  availableVersion: string | null;
  downloadedVersion: string | null;
  downloadPercent: number | null;
  checkedAt: string | null;
  message: string | null;
  errorContext: ErrorContext;
  canRetry: boolean;
}

// Future settings page can override these. 15s lets the shell settle before
// we start pinging GitHub; 4h balances freshness against rate-limit etiquette
// on a single desktop cohort.
const STARTUP_CHECK_DELAY_MS = 15_000;
const POLL_INTERVAL_MS = 4 * 60 * 60 * 1_000;
const PROGRESS_BUCKET_SIZE = 10;

export interface DisabledReason {
  disabled: boolean;
  reason?: string;
}

export interface DisabledReasonInput {
  isPackaged: boolean;
  platform: string;
  env: Record<string, string | undefined>;
}

export function getDisabledReason(input: DisabledReasonInput): DisabledReason {
  if (!input.isPackaged) return { disabled: true, reason: "dev-build" };
  if (input.env["UNCORDED_DISABLE_AUTO_UPDATE"] === "1") {
    return { disabled: true, reason: "env-override" };
  }
  if (input.platform === "linux" && !input.env["APPIMAGE"]) {
    return { disabled: true, reason: "linux-non-appimage" };
  }
  return { disabled: false };
}

// Broadcast only when the download crosses a 10% bucket — otherwise a fast
// link floods the renderer with per-chunk events. Paired with
// reduceOnDownloadProgress which bucket-rounds the stored value.
export function shouldBroadcastProgress(
  previousPercent: number | null,
  nextPercent: number,
): boolean {
  if (previousPercent === null) return true;
  const prevBucket = Math.floor(previousPercent / PROGRESS_BUCKET_SIZE);
  const nextBucket = Math.floor(nextPercent / PROGRESS_BUCKET_SIZE);
  return nextBucket !== prevBucket;
}

export function initialState(
  enabled: boolean,
  currentVersion: string,
): UpdateState {
  return {
    enabled,
    status: enabled ? "idle" : "disabled",
    currentVersion,
    availableVersion: null,
    downloadedVersion: null,
    downloadPercent: null,
    checkedAt: null,
    message: null,
    errorContext: null,
    canRetry: false,
  };
}

export function reduceOnCheckStart(s: UpdateState): UpdateState {
  return {
    ...s,
    status: "checking",
    message: null,
    errorContext: null,
    canRetry: false,
  };
}

export function reduceOnCheckFailure(
  s: UpdateState,
  message: string,
): UpdateState {
  return {
    ...s,
    status: "error",
    message,
    errorContext: "check",
    canRetry: true,
  };
}

export function reduceOnUpdateAvailable(
  s: UpdateState,
  info: { version: string },
): UpdateState {
  return {
    ...s,
    status: "available",
    availableVersion: info.version,
    downloadPercent: null,
    checkedAt: new Date().toISOString(),
    message: null,
    errorContext: null,
    canRetry: false,
  };
}

export function reduceOnNoUpdate(s: UpdateState): UpdateState {
  return {
    ...s,
    status: "up-to-date",
    availableVersion: null,
    downloadedVersion: null,
    downloadPercent: null,
    checkedAt: new Date().toISOString(),
    message: null,
    errorContext: null,
    canRetry: false,
  };
}

export function reduceOnDownloadStart(s: UpdateState): UpdateState {
  return {
    ...s,
    status: "downloading",
    downloadPercent: 0,
    message: null,
    errorContext: null,
    canRetry: false,
  };
}

export function reduceOnDownloadProgress(
  s: UpdateState,
  percent: number,
): UpdateState {
  const bucketed = Math.min(
    100,
    Math.floor(percent / PROGRESS_BUCKET_SIZE) * PROGRESS_BUCKET_SIZE,
  );
  return { ...s, status: "downloading", downloadPercent: bucketed };
}

export function reduceOnDownloadFailure(
  s: UpdateState,
  message: string,
): UpdateState {
  return {
    ...s,
    status: "error",
    downloadPercent: null,
    message,
    errorContext: "download",
    canRetry: true,
  };
}

export function reduceOnDownloadComplete(
  s: UpdateState,
  info: { version: string },
): UpdateState {
  return {
    ...s,
    status: "downloaded",
    downloadedVersion: info.version,
    downloadPercent: 100,
    message: null,
    errorContext: null,
    canRetry: false,
  };
}

export function reduceOnInstallFailure(
  s: UpdateState,
  message: string,
): UpdateState {
  return {
    ...s,
    status: "error",
    message,
    errorContext: "install",
    canRetry: true,
  };
}

export interface AutoUpdateLogger {
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
}

interface ElectronUpdaterLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  debug(msg: string): void;
}

// Adapts our JSON logger (main.ts `log`) into the plain-string shape
// `electron-updater` asks for. `debug` folds into `info` with a subsystem
// tag — we'd rather have the detail than suppress it.
export function makeElectronUpdaterLogger(
  log: AutoUpdateLogger,
): ElectronUpdaterLogger {
  const tag = { subsystem: "autoUpdater" };
  return {
    info(msg: string) {
      log.info(msg, tag);
    },
    warn(msg: string) {
      log.warn(msg, tag);
    },
    error(msg: string) {
      log.error(msg, tag);
    },
    debug(msg: string) {
      log.info(msg, tag);
    },
  };
}

let state: UpdateState = initialState(false, "0.0.0");
let broadcast: (s: UpdateState) => void = () => {};
let logger: AutoUpdateLogger = {
  info() {},
  warn() {},
  error() {},
};
let startupTimer: ReturnType<typeof setTimeout> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

function setState(next: UpdateState): void {
  state = next;
  broadcast(state);
}

function triggerCheck(): void {
  if (state.status !== "checking") {
    setState(reduceOnCheckStart(state));
  }
  autoUpdater.checkForUpdates().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    setState(reduceOnCheckFailure(state, message));
  });
}

function triggerDownload(): void {
  setState(reduceOnDownloadStart(state));
  autoUpdater.downloadUpdate().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    setState(reduceOnDownloadFailure(state, message));
  });
}

function triggerInstall(): void {
  // quitAndInstall internally calls app.quit() — existing `before-quit`
  // handler in main.ts stops Docker containers before Electron exits, so
  // this reuses the existing shutdown path instead of introducing another.
  try {
    autoUpdater.quitAndInstall(false, true);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    setState(reduceOnInstallFailure(state, message));
  }
}

export interface SetupArgs {
  logger: AutoUpdateLogger;
  sendToWindow: (channel: string, payload: unknown) => void;
  isPackaged: boolean;
  platform: string;
  env: Record<string, string | undefined>;
  currentVersion: string;
}

export function setupAutoUpdater(args: SetupArgs): UpdateState {
  logger = args.logger;
  broadcast = (s) => args.sendToWindow(IPC.APP_UPDATE_STATE, s);

  const { disabled, reason } = getDisabledReason({
    isPackaged: args.isPackaged,
    platform: args.platform,
    env: args.env,
  });

  state = initialState(!disabled, args.currentVersion);

  if (disabled) {
    logger.info("auto-updater disabled", {
      subsystem: "autoUpdater",
      reason,
    });
    return state;
  }

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;
  autoUpdater.logger = makeElectronUpdaterLogger(logger);

  autoUpdater.on("update-available", (info: UpdateInfo) => {
    setState(reduceOnUpdateAvailable(state, { version: info.version }));
  });

  autoUpdater.on("update-not-available", () => {
    setState(reduceOnNoUpdate(state));
  });

  autoUpdater.on("download-progress", (progress: ProgressInfo) => {
    const next = progress.percent ?? 0;
    if (!shouldBroadcastProgress(state.downloadPercent, next)) return;
    setState(reduceOnDownloadProgress(state, next));
  });

  autoUpdater.on("update-downloaded", (info: UpdateInfo) => {
    setState(reduceOnDownloadComplete(state, { version: info.version }));
  });

  autoUpdater.on("error", (err) => {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("auto-updater error", {
      subsystem: "autoUpdater",
      err: message,
      status: state.status,
    });
    // electron-updater's "error" event doesn't tell us which phase blew up.
    // Infer from current status: downloading → download failure;
    // everything else → check failure. Install errors are caught in
    // triggerInstall's own try/catch (quitAndInstall is synchronous).
    if (state.status === "downloading") {
      setState(reduceOnDownloadFailure(state, message));
    } else {
      setState(reduceOnCheckFailure(state, message));
    }
  });

  startupTimer = setTimeout(() => {
    triggerCheck();
  }, STARTUP_CHECK_DELAY_MS);

  pollTimer = setInterval(() => {
    triggerCheck();
  }, POLL_INTERVAL_MS);

  return state;
}

// Public API for main-process callers (e.g. the Help menu item) that want
// to kick off a check without going through IPC. Returns the current
// snapshot; progress/outcome arrives via the broadcast channel.
export function getUpdateState(): UpdateState {
  return state;
}

export function requestUpdateCheck(): UpdateState {
  if (!state.enabled) return state;
  triggerCheck();
  return state;
}

export function setupAutoUpdateIpc(): void {
  ipcMain.handle(IPC.APP_UPDATE_GET_STATE, () => state);

  ipcMain.handle(IPC.APP_UPDATE_CHECK, () => requestUpdateCheck());

  ipcMain.handle(IPC.APP_UPDATE_DOWNLOAD, () => {
    if (!state.enabled) return state;
    const retryingDownload =
      state.status === "error" && state.errorContext === "download";
    if (state.status !== "available" && !retryingDownload) {
      return state;
    }
    triggerDownload();
    return state;
  });

  ipcMain.handle(IPC.APP_UPDATE_INSTALL, () => {
    if (!state.enabled) return;
    const retryingInstall =
      state.status === "error" && state.errorContext === "install";
    if (state.status !== "downloaded" && !retryingInstall) {
      return;
    }
    triggerInstall();
  });
}

// Test-only: lets the reducer suite verify setupAutoUpdater's side effects
// are torn down between cases. Never called by main.ts — the process exits
// whole on quit.
export function teardownAutoUpdater(): void {
  if (startupTimer) clearTimeout(startupTimer);
  if (pollTimer) clearInterval(pollTimer);
  startupTimer = null;
  pollTimer = null;
  autoUpdater.removeAllListeners();
}
