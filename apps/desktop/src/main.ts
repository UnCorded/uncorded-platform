import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  ipcMain,
  Menu,
  type MenuItemConstructorOptions,
  nativeImage,
  session,
  shell,
  systemPreferences,
  Tray,
  type WebContents,
} from "electron";
import path from "path";
import { randomBytes, randomUUID } from "node:crypto";
import { DESKTOP_APP_ID } from "./desktop-identity";
import { IPC } from "./ipc";
import * as docker from "./docker";
import * as central from "./central";
import { getCloudflareConnectionState, signOutCloudflare } from "./cloudflare";
import { provisionServer } from "./provision";
import { deleteSecret, encryptionSecretKey, getSecret, getSecretStoreStatus, migrateSecrets, setSecret, tunnelSecretKey } from "./desktop-secrets";
import { registerServer, getServerRecord, removeServerRecord, listServerRecords, registryWasQuarantinedThisSession, lastQuarantinePath } from "./server-registry";
import type {
  ScreenSharePermissionStatus,
  ScreenShareSelection,
  ScreenShareSource,
  StartupNotice,
} from "@uncorded/electron-bridge";
import { removeIfExists, runServerContainer } from "./server-runtime";
import { reconcileRegistryWithCentral } from "./reconcile";
import { rm } from "node:fs/promises";
import {
  getUpdateState,
  requestUpdateCheck,
  setupAutoUpdater,
  setupAutoUpdateIpc,
} from "./auto-update";
import * as runtimeOrchestrator from "./runtime-orchestrator";
import { resolveLatestVersion } from "./runtime-releases";
import type {
  RuntimeCheckOutcome,
  RuntimeUpdateChannel,
  RuntimeUpdateOutcome,
  RuntimeUpdatePreferences,
} from "@uncorded/electron-bridge";

let win: BrowserWindow | null = null;
let tray: Tray | null = null;

// Flipped to true by the `before-quit` handler once a real quit is underway
// (tray "Quit UnCorded", auto-update install, OS shutdown). Without this flag
// a user clicking X during a real-quit path would trigger the close-to-tray
// hide() and swallow the quit. When false, window `close` events are
// intercepted and routed to hide-to-tray.
let isQuittingForReal = false;

// Dev loads the website's Vite dev server for HMR. In packaged builds we point
// the window at the public web shell rather than bundling a stale copy of
// apps/website/dist into every desktop release. Keeping a single deployed
// origin also collapses the allowed_origins matrix the runtime has to
// enforce (see provision.ts seed and runtime/src/http/handler.ts corsAuth).
const DEV_WEB_URL = "http://localhost:5174";
const PROD_WEB_URL = "https://uncorded.app";

// Hosts the user can be sent to from a renderer-initiated `window.open` /
// target=_blank link. Any other host is denied; we never just trust whatever
// URL the renderer hands us. Kept tight to "things UnCorded itself owns or
// links to as part of the product".
const EXTERNAL_HTTPS_ALLOWLIST = new Set<string>([
  "uncorded.app",
  "www.uncorded.app",
  "central.uncorded.app",
  "docs.uncorded.app",
  "github.com",
]);

const OAUTH_PROVIDERS = new Set(["google", "discord", "github"]);
const DESKTOP_AUTH_PROTOCOL = "uncorded";

// Runtime signed-URL shape (spec-26): `/files/<slug>/<filename>` with HMAC
// params (`t`, `exp`, `u`). The runtime re-verifies the signature on every
// request, so the test below does not need a per-server tunnel-host allowlist
// — a forged URL would 403 at the server. The pattern just disambiguates "the
// user clicked a plugin file-attachment link" from arbitrary `window.open`.
function isRuntimeSignedFileUrl(u: URL): boolean {
  return (
    u.pathname.startsWith("/files/") &&
    u.searchParams.has("t") &&
    u.searchParams.has("exp") &&
    u.searchParams.has("u")
  );
}

// Resolve the active shell URL. `app.isPackaged` is the Electron-official
// signal — env vars (NODE_ENV) can leak into packaged builds and silently
// flip dev-only behavior on, which is exactly the footgun this swap closes.
function shellUrl(): string {
  return app.isPackaged ? PROD_WEB_URL : DEV_WEB_URL;
}

// Maximum acceptable size for a Cloudflare tunnel token coming in over IPC.
// Real tokens are ~1KB; capping at 2KB rejects pathological payloads from a
// compromised renderer before they ever reach provision.ts / disk.
const MAX_TUNNEL_TOKEN_BYTES = 2048;

// Core plugins whose frontend dirs get bind-mounted into dev containers so
// UI edits are live without an image rebuild. Slug must match the directory
// under plugins/ and the runtime's core-plugin path inside the image.
const DEV_HOT_RELOAD_PLUGINS = ["text-channels"] as const;

/**
 * Compute dev-only plugin frontend bind mounts from the monorepo root.
 * Returns an empty list in packaged builds (prod ships baked-in assets). The
 * project root is `apps/desktop/..` at dev time — app.getAppPath() resolves
 * to the desktop app dir whether we're running via Vite's dev watcher or
 * the packaged asar, so joining up two levels is stable.
 */
function devPluginFrontendMounts(): { slug: string; hostDir: string }[] {
  if (app.isPackaged) return [];
  const projectRoot = path.resolve(app.getAppPath(), "..", "..");
  return DEV_HOT_RELOAD_PLUGINS.map((slug) => ({
    slug,
    hostDir: path.join(projectRoot, "plugins", slug, "frontend"),
  }));
}

type LogLevel = "info" | "warn" | "error";

function emit(level: LogLevel, message: string, ctx?: Record<string, unknown>): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg: message,
    component: "desktop-main",
    ...ctx,
  });
  if (level === "error") {
    process.stderr.write(line + "\n");
    return;
  }
  process.stdout.write(line + "\n");
}

const log = {
  info(message: string, ctx?: Record<string, unknown>) {
    emit("info", message, ctx);
  },
  warn(message: string, ctx?: Record<string, unknown>) {
    emit("warn", message, ctx);
  },
  error(message: string, ctx?: Record<string, unknown>) {
    emit("error", message, ctx);
  },
};

let fatalDesktopErrorShown = false;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sendToWindow(channel: string, payload: unknown): void {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) {
    return;
  }
  win.webContents.send(channel, payload);
}

function surfaceDesktopFailure(kind: "unhandledRejection" | "uncaughtException", err: unknown): void {
  log.error("desktop process error", {
    subsystem: `desktop.${kind}`,
    err: errorMessage(err),
    stack: err instanceof Error ? err.stack : undefined,
  });

  if (fatalDesktopErrorShown) {
    return;
  }
  fatalDesktopErrorShown = true;

  const message = `UnCorded Desktop hit a ${kind} in the main process.\n\n${errorMessage(err)}`;
  if (app.isReady()) {
    dialog.showErrorBox("UnCorded Desktop Error", message);
  }
}

function registerProcessErrorHandlers(): void {
  process.on("unhandledRejection", (reason) => {
    surfaceDesktopFailure("unhandledRejection", reason);
  });

  process.on("uncaughtException", (error) => {
    surfaceDesktopFailure("uncaughtException", error);
    app.exit(1);
  });
}

registerProcessErrorHandlers();

function ipcError(channel: string, err: unknown): Error {
  const wrapped = new Error(`${channel} failed: ${errorMessage(err)}`);
  wrapped.name = "DesktopIpcError";
  return wrapped;
}

// IPC sender origin guard. Every renderer→main IPC must originate from the
// active shell origin; messages from a detached frame, an unknown frame, or
// any other origin are dropped. This is defense-in-depth: navigation guards
// (will-navigate / setWindowOpenHandler) already keep the renderer pointed
// at the shell origin, but a senderFrame that has detached before the
// handler runs returns null, so we fail closed rather than trusting it.
function isAllowedIpcSender(senderUrl: string | undefined | null): boolean {
  if (!senderUrl) return false;
  try {
    const sender = new URL(senderUrl);
    const expected = new URL(shellUrl());
    return sender.origin === expected.origin;
  } catch {
    return false;
  }
}

function handleIpc<T extends unknown[]>(
  channel: string,
  handler: (_event: Electron.IpcMainInvokeEvent, ...args: T) => Promise<unknown> | unknown,
): void {
  ipcMain.handle(channel, async (event, ...args) => {
    const senderUrl = event.senderFrame?.url;
    if (!isAllowedIpcSender(senderUrl)) {
      log.warn("ipc rejected — sender origin not allowed", {
        channel,
        senderUrl: senderUrl ?? null,
      });
      throw ipcError(channel, new Error("forbidden sender origin"));
    }
    try {
      return await handler(event, ...(args as T));
    } catch (err) {
      log.error("ipc handler failed", {
        channel,
        err: errorMessage(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      throw ipcError(channel, err);
    }
  });
}

// Build the CSP we layer onto the shell's top-level response. NOTE: this
// overlays whatever CSP `uncorded.app` itself serves — we are not reading
// the upstream policy and merging, we are replacing the header for the
// top-level document response only. Plugin iframes load from arbitrary
// user-tunnel origins and are NOT covered (they get the upstream policy
// from their own origins, plus the sandbox attributes set in
// channel-view.tsx).
//
// Per the plan we deliberately omit `default-src` so plugin iframes aren't
// blocked by a too-narrow fallback. Each fetch directive is enumerated
// explicitly.
function buildShellCSP(): string {
  const isDev = !app.isPackaged;

  // Central API + R2 assets are the always-allowed connect targets. Plugin
  // tunnels typically resolve to *.trycloudflare.com but users may bring
  // custom hostnames over time; we widen `https:` and `wss:` for that case
  // rather than try to enumerate every tunnel variant. The shell makes both
  // HTTPS (workspace layouts, plugin listing, admin icon) and WSS (realtime)
  // calls to the active server's tunnel origin, so both schemes need to be
  // allowed.
  const connectSrc = [
    "'self'",
    "https://central.uncorded.app",
    "https://assets.uncorded.app",
    "https:",
    "wss:",
  ];
  const frameSrc = ["https:"];
  const imgSrc = ["'self'", "https:", "data:", "blob:"];
  const scriptSrc = ["'self'"];
  const styleSrc = ["'self'", "'unsafe-inline'"];
  const fontSrc = ["'self'", "https:", "data:"];

  if (isDev) {
    // Vite HMR client + dev-server proxied requests + plugin iframes during
    // local plugin development all use http://localhost:* and ws://localhost:*.
    // Allow inline + eval for scripts in dev because Vite's HMR client and
    // some dev plugins inject inline scripts; packaged builds keep tight
    // 'self'-only script policy.
    connectSrc.push("http://localhost:*", "ws://localhost:*");
    frameSrc.push("http://localhost:*");
    imgSrc.push("http://localhost:*");
    scriptSrc.push("http://localhost:*", "'unsafe-inline'", "'unsafe-eval'");
    styleSrc.push("http://localhost:*");
    fontSrc.push("http://localhost:*");
  }

  const directives: Record<string, string[]> = {
    "connect-src": connectSrc,
    "frame-src": frameSrc,
    "img-src": imgSrc,
    "script-src": scriptSrc,
    "style-src": styleSrc,
    "font-src": fontSrc,
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
  };

  return Object.entries(directives)
    .map(([k, v]) => `${k} ${v.join(" ")}`)
    .join("; ");
}

function installShellCSP(): void {
  const shellOrigins = [DEV_WEB_URL, PROD_WEB_URL];
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    // Only override CSP for the shell's own top-level document. Sub-resource
    // requests, plugin iframe traffic, and webview navigations get whatever
    // their origin server sets.
    const isShellMainFrame =
      details.resourceType === "mainFrame" &&
      shellOrigins.some((origin) => details.url.startsWith(origin));
    if (!isShellMainFrame) {
      callback({});
      return;
    }
    const csp = buildShellCSP();
    const headers = { ...details.responseHeaders };
    // Strip any upstream CSP variants so our policy isn't combined with a
    // looser one from origin.
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === "content-security-policy") delete headers[key];
      if (key.toLowerCase() === "content-security-policy-report-only") delete headers[key];
    }
    headers["Content-Security-Policy"] = [csp];
    callback({ responseHeaders: headers });
  });
}

function attachWindowSecurityGuards(target: BrowserWindow): void {
  // Block any new-window attempt by default. Allowlisted external HTTPS
  // hosts get handed off to the OS browser via shell.openExternal — never
  // opened inside the Electron BrowserWindow (which would render outside
  // the shell's CSP and navigation guards).
  target.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const u = new URL(url);
      if (u.protocol === "https:" && EXTERNAL_HTTPS_ALLOWLIST.has(u.hostname)) {
        void shell.openExternal(url).catch((err) => {
          log.warn("failed to open external url", {
            url,
            err: errorMessage(err),
          });
        });
      } else if (u.protocol === "https:" && isRuntimeSignedFileUrl(u)) {
        // Plugin file-attachment click from inside a sandboxed runtime iframe.
        // `?download=1` (spec-26) is the explicit "save" affordance — route
        // through Electron's native download manager so the OS save dialog
        // appears in-app without a flash of empty BrowserWindow. Otherwise it
        // is an inline-preview link (e.g. a PDF where the runtime serves
        // `Content-Disposition: inline`) — hand off to the OS browser so the
        // built-in PDF viewer renders it; opening a new BrowserWindow inside
        // Electron would bypass our CSP/preload guards.
        if (u.searchParams.get("download") === "1") {
          target.webContents.downloadURL(url);
        } else {
          void shell.openExternal(url).catch((err) => {
            log.warn("failed to open external url", {
              url,
              err: errorMessage(err),
            });
          });
        }
      } else {
        log.warn("blocked window.open to non-allowlisted URL", { url });
      }
    } catch (err) {
      log.warn("blocked window.open with malformed URL", {
        url,
        err: errorMessage(err),
      });
    }
    return { action: "deny" };
  });

  // Refuse renderer-initiated navigations off the active shell origin.
  // A crafted link or `location.href = ...` to evil.com would otherwise
  // navigate the BrowserWindow itself — once that happens our CSP and
  // preload script are gone and the renderer is whatever evil.com served.
  target.webContents.on("will-navigate", (event, navigationUrl) => {
    let target: URL;
    let expected: URL;
    try {
      target = new URL(navigationUrl);
      expected = new URL(shellUrl());
    } catch {
      event.preventDefault();
      log.warn("blocked navigation with malformed URL", { navigationUrl });
      return;
    }
    if (target.origin !== expected.origin) {
      event.preventDefault();
      log.warn("blocked navigation off shell origin", {
        from: expected.origin,
        to: target.origin,
      });
    }
  });
}

// "Check for Updates…" used to live on a hidden Alt-revealed application
// menu; that surface is gone now. The titlebar's CheckUpdatesButton is the
// canonical user-facing trigger, and the menu itself is suppressed below so
// pressing Alt doesn't pop Electron's default File/Edit/View bar back in.
let pendingOAuth:
  | {
      provider: string;
      resolve: (account: unknown) => void;
      reject: (err: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  | null = null;

function rejectPendingOAuth(message: string): void {
  if (!pendingOAuth) return;
  const pending = pendingOAuth;
  pendingOAuth = null;
  clearTimeout(pending.timeout);
  pending.reject(new Error(message));
}

async function completePendingOAuth(code: string): Promise<void> {
  const pending = pendingOAuth;
  pendingOAuth = null;
  if (pending) clearTimeout(pending.timeout);
  try {
    await central.exchangeDesktopOAuthCode(code);
    const profile = await central.getProfile();
    pending?.resolve(profile);
    showMainWindow();
    if (!pending && win && !win.isDestroyed()) {
      win.webContents.reload();
    }
  } catch (err) {
    pending?.reject(err instanceof Error ? err : new Error(String(err)));
  }
}

function handleProtocolUrl(rawUrl: string): void {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return;
  }
  if (url.protocol !== `${DESKTOP_AUTH_PROTOCOL}:`) return;
  if (url.hostname !== "auth" || url.pathname !== "/oauth") return;

  const err = url.searchParams.get("error");
  if (err) {
    rejectPendingOAuth("OAuth sign-in failed.");
    showMainWindow();
    return;
  }
  const code = url.searchParams.get("code");
  if (!code) {
    rejectPendingOAuth("OAuth sign-in finished without a callback code.");
    showMainWindow();
    return;
  }
  void completePendingOAuth(code);
}

function startDesktopOAuth(provider: string): Promise<unknown> {
  if (!OAUTH_PROVIDERS.has(provider)) {
    return Promise.reject(new Error("Unsupported OAuth provider."));
  }
  rejectPendingOAuth("A newer OAuth sign-in was started.");

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      rejectPendingOAuth("OAuth sign-in timed out.");
    }, 5 * 60 * 1000);
    pendingOAuth = { provider, resolve, reject, timeout };
    const authUrl = `${central.getBaseUrl()}/v1/auth/${provider}?desktop=1`;
    void shell.openExternal(authUrl).catch((err) => {
      rejectPendingOAuth(
        `Failed to open browser for OAuth sign-in: ${errorMessage(err)}`,
      );
    });
  });
}

function suppressDefaultAppMenu(): void {
  Menu.setApplicationMenu(null);
}

function createWindow(): void {
  // Explicit window icon so the UnCorded logo shows in the window chrome and
  // taskbar without relying on electron-builder's rcedit step (which only
  // runs during `bun run build`). In dev (`npm run dev:watch`) the running
  // electron binary would otherwise show its default atom icon.
  const windowIconName = process.platform === "win32" ? "icon.ico" : "icon.png";
  const windowIcon = nativeImage.createFromPath(
    path.join(__dirname, "..", "assets", windowIconName),
  );

  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    ...(windowIcon.isEmpty() ? {} : { icon: windowIcon }),
    // Custom titlebar: sidebar-tone bar painted by the renderer
    // (apps/website/src/components/titlebar.tsx). Mac keeps inset traffic
    // lights via `hiddenInset`; Win/Linux is fully frameless so the renderer
    // paints min/max/close itself — needed because OS-painted overlay buttons
    // don't blend with our sidebar tone and break the centered server pill's
    // optical balance. The tradeoff: no Win11 Snap Layouts on hover-maximize
    // (Snap is only exposed for native overlay buttons, not custom DOM).
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    ...(process.platform === "darwin"
      ? { trafficLightPosition: { x: 12, y: 8 } }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // browser-panel.tsx uses <webview>; keep enabled but lock attached
      // webviews down via the `will-attach-webview` handler below.
      webviewTag: true,
    },
  });

  attachWindowSecurityGuards(win);
  tagAsUncordedWindow(win.webContents);

  const webUrl = shellUrl();
  void win.loadURL(webUrl).catch((err) => {
    log.error("failed to load desktop web shell", {
      url: webUrl,
      err: errorMessage(err),
    });
  });
  if (!app.isPackaged) {
    win.webContents.openDevTools();
  }

  win.webContents.on("render-process-gone", (_event, details) => {
    log.error("renderer process gone", {
      reason: details.reason,
      exitCode: details.exitCode,
    });
  });

  // F5 / Ctrl+R reload, Ctrl+Shift+R force-reload (cache bypass), F12 devtools.
  // Electron's default application menu used to wire these via role bindings,
  // but suppressDefaultAppMenu() removed the menu entirely, taking the
  // accelerators with it. Re-bind here so the keyboard reload paths the user
  // expects from any browser-shaped surface keep working.
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    const key = input.key.toLowerCase();
    const ctrlOrMeta = input.control || input.meta;
    if (key === "f5" || (ctrlOrMeta && key === "r" && !input.shift)) {
      win?.webContents.reload();
      event.preventDefault();
      return;
    }
    if (ctrlOrMeta && input.shift && key === "r") {
      win?.webContents.reloadIgnoringCache();
      event.preventDefault();
      return;
    }
    if (key === "f12") {
      win?.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

  // Close button → hide-to-tray. Keeps server containers running so the user
  // can "close the app" without losing their Discord-style background state;
  // the tray icon is the way to fully quit (which then runs the before-quit
  // container teardown). Real quit paths (tray Quit, auto-update install,
  // OS shutdown) set isQuittingForReal first and skip this branch.
  win.on("close", (event) => {
    if (isQuittingForReal) return;
    event.preventDefault();
    win?.hide();
  });

  win.on("closed", () => {
    win = null;
  });

  // Push maximize-state changes to the renderer so the custom titlebar's
  // maximize button can swap to a "restore" glyph (and back). The renderer
  // reads the initial state via WINDOW_GET_MAXIMIZED on mount; these events
  // keep it in sync after that.
  const emitMaxState = (maximized: boolean): void => {
    win?.webContents.send(IPC.WINDOW_MAXIMIZE_STATE, maximized);
  };
  win.on("maximize", () => emitMaxState(true));
  win.on("unmaximize", () => emitMaxState(false));
  win.on("enter-full-screen", () => emitMaxState(true));
  win.on("leave-full-screen", () => emitMaxState(false));
}

// Bring the main window forward from any state (hidden to tray, minimized,
// or just unfocused). Used by the tray click handler and the second-instance
// re-launch path so a user double-clicking the shortcut while UnCorded is
// backgrounded always gets the window back.
function showMainWindow(): void {
  if (!win) {
    createWindow();
    return;
  }
  if (!win.isVisible()) win.show();
  if (win.isMinimized()) win.restore();
  win.focus();
}

// Tray icon + context menu. Created once on app-ready and persists for the
// lifetime of the process. Left-click and double-click restore the window;
// right-click opens the context menu. "Quit UnCorded" is the only path that
// fully exits — the window X button only hides to tray.
function createTray(): void {
  if (tray) return;
  // .ico on Windows embeds 16/32/48/256 px frames so the tray renders crisp
  // at whatever DPI the system is on. Elsewhere the 512 PNG is downscaled by
  // Electron. `assets/` is bundled into the asar via electron-builder.yml's
  // files glob so this path resolves in both dev and packaged builds.
  const iconName = process.platform === "win32" ? "icon.ico" : "icon.png";
  const iconPath = path.join(__dirname, "..", "assets", iconName);
  const image = nativeImage.createFromPath(iconPath);
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
  tray.setToolTip("UnCorded");

  const template: MenuItemConstructorOptions[] = [
    { label: "Open UnCorded", click: showMainWindow },
    { type: "separator" },
    {
      label: "Check for Updates…",
      enabled: getUpdateState().enabled,
      click: () => {
        requestUpdateCheck();
      },
    },
    { type: "separator" },
    {
      label: "Quit UnCorded",
      click: () => {
        app.quit();
      },
    },
  ];
  tray.setContextMenu(Menu.buildFromTemplate(template));
  tray.on("click", showMainWindow);
  tray.on("double-click", showMainWindow);
}

// Tear down every local artefact for a server: container, volume, registry
// record, secret-store tunnel token. Shared between the user-initiated
// CENTRAL_DELETE_SERVER handler and (in PR-B) the startup reconciliation
// path that removes orphans Central no longer knows about. Each step is
// best-effort so a half-torn-down server can still be fully cleaned up on
// a retry — nothing here should throw on a missing container or volume.
async function purgeLocalServer(serverId: string): Promise<void> {
  const record = getServerRecord(serverId);
  if (record) {
    try {
      await docker.stopContainer(record.containerId);
    } catch {
      // Container may already be stopped — continue
    }
    try {
      await docker.removeContainer(record.containerId);
    } catch {
      // Container may already be gone — continue
    }
    try {
      await rm(record.volumePath, { recursive: true, force: true });
    } catch {
      // Best effort — continue
    }
    removeServerRecord(serverId);
  }
  // Clear the cached tunnel token. We do NOT clear on container stop —
  // stops happen routinely (laptop sleep, app quit) and a clear there
  // would force the user to re-paste the token on every restart. Purge
  // is the only intent strong enough to invalidate stored secrets.
  deleteSecret(tunnelSecretKey(serverId));
  // The runtime encryption secret is purge-only for the same reason: a
  // stop is routine, but rotating the secret across stop-start cycles
  // would orphan every encrypted-at-rest row. Cleared with the tunnel.
  deleteSecret(encryptionSecretKey(serverId));
}

// On launch: walk the local server registry, force-remove any stale container
// (left over from a prior session, possibly with a different image / config),
// pull the tunnel token from the secret store, and start a fresh container with
// the token piped over stdin. The new container id replaces the old one in
// the registry. Failures are isolated per-server — a single broken record
// never blocks the rest from coming up.
async function restoreServerContainers(): Promise<void> {
  const records = listServerRecords();
  if (records.length === 0) return;

  log.info("restoring server containers from registry", { count: records.length });

  for (const { serverId, record } of records) {
    try {
      await removeIfExists(record.containerId);
      const tunnelToken = getSecret(tunnelSecretKey(serverId)) ?? undefined;
      // Legacy servers (created before runtime encryption was required)
      // won't have a stored secret. Generate-on-missing so they keep
      // booting; this means any rows the old server encrypted under the
      // missing-secret-era are unrecoverable, but Phase 1 has no
      // encrypted-at-rest data older than the runtime-secret precondition.
      let runtimeEncryptionSecret = getSecret(encryptionSecretKey(serverId));
      if (!runtimeEncryptionSecret) {
        runtimeEncryptionSecret = randomBytes(32).toString("hex");
        setSecret(encryptionSecretKey(serverId), runtimeEncryptionSecret);
      }
      const newContainerId = await runServerContainer({
        volumePath: record.volumePath,
        hostPort: record.hostPort,
        tunnelToken,
        runtimeEncryptionSecret,
        ...(record.tunnelPublicHostname ? { tunnelPublicHostname: record.tunnelPublicHostname } : {}),
        ...(record.voicePublicHostname ? { voicePublicHostname: record.voicePublicHostname } : {}),
        ...(record.imageSignature ? { imageSignature: record.imageSignature } : {}),
        devPluginFrontendMounts: devPluginFrontendMounts(),
      });
      registerServer(serverId, { ...record, containerId: newContainerId });
      log.info("restored server container", {
        serverId,
        containerId: newContainerId,
        hostPort: record.hostPort,
        tunnel: tunnelToken ? "authenticated" : "demo",
      });
    } catch (err) {
      log.error("failed to restore server container", {
        serverId,
        err: errorMessage(err),
      });
    }
  }
}

// Bind real registry + central + purge dependencies into the pure reconcile
// function defined in reconcile.ts. Split so that module is unit-testable
// without pulling in Electron / docker / secret-store dependencies.
function runReconcileRegistryWithCentral(): Promise<void> {
  return reconcileRegistryWithCentral({
    listRemoteServers: () => central.listServers(),
    listLocalRecords: () => listServerRecords(),
    wasQuarantinedThisSession: () => registryWasQuarantinedThisSession(),
    purgeLocalServer,
    log,
  });
}

// On quit: stop every container the registry knows about so the runtime can
// flush its WAL and shut down cleanly. We don't remove containers here —
// removal happens on the next launch in restoreServerContainers, which gives
// us a chance to inspect a stopped container post-mortem if a user reports
// a crash.
async function stopAllServerContainers(): Promise<void> {
  const records = listServerRecords();
  if (records.length === 0) return;

  log.info("stopping server containers on quit", { count: records.length });

  await Promise.all(
    records.map(async ({ serverId, record }) => {
      try {
        await docker.stopContainer(record.containerId);
      } catch (err) {
        // Container may already be stopped / removed — log and continue.
        log.warn("failed to stop container on quit", {
          serverId,
          containerId: record.containerId,
          err: errorMessage(err),
        });
      }
    }),
  );
}

// Startup completion gate for APP_GET_STARTUP_NOTICES. The renderer pulls
// notices on mount — but its onMount can race the main-process startup work
// that sets the quarantine flag. Without a gate, a fast renderer reads "no
// notices" before quarantine runs and the banner is silently lost.
//
// The 5s timeout is a safety belt for a hung startup path (e.g. docker socket
// unreachable): don't pin the renderer to a "checking…" state forever — return
// whatever notices have accrued by the deadline.
let startupCompleteResolve: () => void = () => {};
const startupCompletePromise = new Promise<void>((resolve) => {
  startupCompleteResolve = resolve;
});
setTimeout(() => startupCompleteResolve(), 5000);

// Screen share — picker, popout, and self-mirror filter.
//
// Self-mirror filter:
//   Every UnCorded BrowserWindow (main + popouts + future tray windows) gets
//   a custom property on its WebContents at creation time
//   (`(contents as any).uncordedWindow = true`). The picker uses the live
//   set of tagged contents to drop UnCorded windows from desktopCapturer
//   results — title- or PID-based filtering is too easy to spoof and breaks
//   when the user renames things, but the tag is set in the same code path
//   that creates the window so it can never be missed.
//
// Picker flow:
//   1. Renderer (or LiveKit on its behalf) calls navigator.mediaDevices.getDisplayMedia
//   2. Chromium routes to setDisplayMediaRequestHandler below
//   3. Main process gathers + filters sources, generates a request id, and
//      sends a SCREEN_SHARE_SHOW_PICKER push to the renderer
//   4. Renderer mounts the picker modal (screen-share-picker.tsx), user
//      picks a source or cancels
//   5. Renderer calls window.electron.screenShare.respondToPicker(reqId, sel)
//   6. Main looks up the pending callback, hands it the selection (or a
//      no-source response on cancel), removes it from the map.
//
// Hung picker safety: the renderer might never call respondToPicker
// (page reload, console error). Each pending entry has a 60s deadline; on
// expiry main calls callback({}) so getDisplayMedia rejects cleanly with
// NotAllowedError. The renderer treats that as a cancel.

interface PendingPickerCall {
  callback: Parameters<NonNullable<Parameters<typeof session.defaultSession.setDisplayMediaRequestHandler>[0]>>[1];
  sources: Electron.DesktopCapturerSource[];
  // Cleared by the resolver and by the deadline timer; whichever fires
  // first wins, the other becomes a no-op.
  resolved: boolean;
  deadline: NodeJS.Timeout;
}
const pendingPickers = new Map<string, PendingPickerCall>();
const PICKER_DEADLINE_MS = 60_000;

const popoutWindowsByTrackSid = new Map<string, BrowserWindow>();

function tagAsUncordedWindow(contents: WebContents): void {
  // Attaching to the WebContents object directly. Electron doesn't expose a
  // public typed slot for app metadata, so we widen via `unknown` and own
  // the lookup key. Stays for the lifetime of the contents.
  (contents as unknown as { uncordedWindow: boolean }).uncordedWindow = true;
}

function isUncordedWebContents(contents: WebContents): boolean {
  return Boolean(
    (contents as unknown as { uncordedWindow?: boolean }).uncordedWindow,
  );
}

function uncordedMediaSourceIds(): Set<string> {
  // getMediaSourceId(): per-WebContents id usable to compare against
  // desktopCapturer.getSources() ids ("window:<n>:<m>"). Tagged contents get
  // their id pulled into a set; results matching are filtered out.
  const ids = new Set<string>();
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed()) continue;
    if (!isUncordedWebContents(w.webContents)) continue;
    try {
      ids.add(w.webContents.getMediaSourceId(w.webContents));
    } catch {
      // getMediaSourceId can throw if the contents is not loaded yet — the
      // contents wasn't capturable anyway, no entry to filter.
    }
  }
  return ids;
}

function encodeSource(source: Electron.DesktopCapturerSource): ScreenShareSource {
  return {
    id: source.id,
    name: source.name,
    thumbnailDataUrl: source.thumbnail.isEmpty()
      ? ""
      : source.thumbnail.toDataURL(),
    appIconDataUrl:
      source.appIcon && !source.appIcon.isEmpty() ? source.appIcon.toDataURL() : null,
    displayId: source.display_id ?? "",
    type: source.id.startsWith("screen:") ? "screen" : "window",
  };
}

async function listScreenShareSources(): Promise<{
  raw: Electron.DesktopCapturerSource[];
  filtered: ScreenShareSource[];
}> {
  const sources = await desktopCapturer.getSources({
    types: ["screen", "window"],
    thumbnailSize: { width: 320, height: 180 },
    fetchWindowIcons: true,
  });
  const drop = uncordedMediaSourceIds();
  const filtered: ScreenShareSource[] = [];
  for (const s of sources) {
    if (drop.has(s.id)) continue;
    filtered.push(encodeSource(s));
  }
  return { raw: sources, filtered };
}

function installDisplayMediaHandler(): void {
  session.defaultSession.setDisplayMediaRequestHandler(
    async (request, callback) => {
      // Confirm the request came from the shell origin. Plugin iframes
      // have their own origin and don't have getDisplayMedia (the shell
      // owns capture per PR-5 §17), but a misbehaving iframe could try.
      const frameUrl = request.frame?.url;
      if (frameUrl && !isAllowedIpcSender(frameUrl)) {
        log.warn("display-media request from non-shell origin denied", {
          frameUrl,
        });
        callback({});
        return;
      }

      let listed: Awaited<ReturnType<typeof listScreenShareSources>>;
      try {
        listed = await listScreenShareSources();
      } catch (err) {
        log.error("desktopCapturer.getSources failed", {
          err: errorMessage(err),
        });
        callback({});
        return;
      }

      if (listed.filtered.length === 0) {
        // No capturable sources after filtering UnCorded windows. macOS
        // permission denial typically lands here too (the OS gives back
        // an empty array). Surface as cancel; the renderer's
        // `screen_share_cancelled` envelope is the right bucket.
        callback({});
        return;
      }

      const requestId = randomUUID();
      const audioRequested = Boolean(request.audioRequested);
      const pending: PendingPickerCall = {
        callback,
        sources: listed.raw,
        resolved: false,
        deadline: setTimeout(() => {
          const stillPending = pendingPickers.get(requestId);
          if (!stillPending || stillPending.resolved) return;
          stillPending.resolved = true;
          pendingPickers.delete(requestId);
          log.warn("screen share picker timed out — auto-cancelling", {
            requestId,
          });
          stillPending.callback({});
        }, PICKER_DEADLINE_MS),
      };
      pendingPickers.set(requestId, pending);

      sendToWindow(IPC.SCREEN_SHARE_SHOW_PICKER, {
        requestId,
        sources: listed.filtered,
        audioRequested,
      });
    },
    { useSystemPicker: false },
  );
}

function resolvePicker(
  requestId: string,
  selection: ScreenShareSelection | null,
): void {
  const pending = pendingPickers.get(requestId);
  if (!pending) {
    log.warn("respondToPicker: unknown requestId", { requestId });
    return;
  }
  if (pending.resolved) return;
  pending.resolved = true;
  clearTimeout(pending.deadline);
  pendingPickers.delete(requestId);

  if (!selection) {
    pending.callback({});
    return;
  }
  const source = pending.sources.find((s) => s.id === selection.sourceId);
  if (!source) {
    log.warn("respondToPicker: sourceId not in pending list", {
      requestId,
      sourceId: selection.sourceId,
    });
    pending.callback({});
    return;
  }
  // `loopback` is the supported audio bucket for `screen_share_audio` on
  // Chromium-on-Electron. macOS support is best-effort (system audio routing
  // through Bluetooth headsets is the known-flaky case — see
  // pr-6-screen-share-contract §15). When the user opted out of audio we
  // omit the audio field so Chromium doesn't even ask.
  if (selection.audio) {
    pending.callback({ video: source, audio: "loopback" });
  } else {
    pending.callback({ video: source });
  }
}

function macosPermissionStatus(): ScreenSharePermissionStatus {
  if (process.platform !== "darwin") return "granted";
  // getMediaAccessStatus("screen") is macOS-only; on other platforms it
  // returns "unknown" per the docs. We've already short-circuited above.
  try {
    const status = systemPreferences.getMediaAccessStatus("screen");
    switch (status) {
      case "granted":
      case "denied":
      case "restricted":
      case "not-determined":
      case "unknown":
        return status;
      default:
        return "unknown";
    }
  } catch (err) {
    log.warn("getMediaAccessStatus(screen) threw", { err: errorMessage(err) });
    return "unknown";
  }
}

async function openScreenRecordingSettings(): Promise<{
  status: "ok" | "unsupported";
}> {
  if (process.platform !== "darwin") return { status: "unsupported" };
  // Apple has historically renamed this URL between major versions; this
  // form is verified on macOS 13. macOS 14/15 verification is part of the
  // 6f manual smoke (plan §13). If the deep link fails we fall back to
  // opening the Privacy & Security pane root rather than crashing.
  const deepLink =
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";
  try {
    await shell.openExternal(deepLink);
    return { status: "ok" };
  } catch (err) {
    log.warn("Privacy_ScreenCapture deep link failed; falling back", {
      err: errorMessage(err),
    });
    try {
      await shell.openExternal(
        "x-apple.systempreferences:com.apple.preference.security",
      );
    } catch (fallbackErr) {
      log.error("Privacy pane fallback also failed", {
        err: errorMessage(fallbackErr),
      });
    }
    return { status: "ok" };
  }
}

function buildPopoutHtml(opts: {
  trackSid: string;
  title: string;
  sourceUrl: string;
}): string {
  // Standalone HTML loaded into the popout. No preload, no Node access —
  // this window is a passive viewer. The trackSid is round-tripped back to
  // the shell only via `popoutClose` from the renderer (this HTML never
  // reads it; included only as a source of human-readable identity in
  // logs/devtools).
  const escTitle = opts.title.replace(/[&<>"']/g, (c) =>
    c === "&"
      ? "&amp;"
      : c === "<"
        ? "&lt;"
        : c === ">"
          ? "&gt;"
          : c === '"'
            ? "&quot;"
            : "&#39;",
  );
  const escSourceUrl = opts.sourceUrl.replace(/"/g, "&quot;");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escTitle}</title>
<style>
  html, body { margin: 0; padding: 0; height: 100%; background: #000; overflow: hidden; }
  body { display: flex; align-items: center; justify-content: center; }
  iframe { border: 0; width: 100%; height: 100%; background: #000; }
</style>
</head>
<body>
<iframe src="${escSourceUrl}" allow="autoplay" sandbox="allow-scripts allow-same-origin"></iframe>
</body>
</html>`;
}

function createScreenSharePopout(payload: {
  trackSid: string;
  title: string;
  sourceUrl: string;
}): { windowId: number } {
  const existing = popoutWindowsByTrackSid.get(payload.trackSid);
  if (existing && !existing.isDestroyed()) {
    existing.show();
    existing.focus();
    return { windowId: existing.id };
  }

  const popout = new BrowserWindow({
    width: 960,
    height: 540,
    minWidth: 320,
    minHeight: 180,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    resizable: true,
    backgroundColor: "#000000",
    title: payload.title,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // No preload here — popout is a passive viewer with no IPC needs.
    },
  });
  // Self-mirror filter must cover popouts too — otherwise a user could
  // pop out a tile and re-share it back into the channel as a window.
  tagAsUncordedWindow(popout.webContents);

  popout.setAlwaysOnTop(true, "floating");
  popout.removeMenu();

  // Inline the HTML rather than serving a route. Keeps the popout
  // fully isolated from the shell origin and its CSP so the renderer
  // can't cross-talk into it. The iframe inside loads the requested
  // sourceUrl (same shell origin in practice — voice-manager passes the
  // attached <video>'s blob URL or a cloned-track sink).
  const dataUrl =
    "data:text/html;charset=utf-8," +
    encodeURIComponent(buildPopoutHtml(payload));
  void popout.loadURL(dataUrl).catch((err) => {
    log.error("popout loadURL failed", { err: errorMessage(err) });
  });

  popoutWindowsByTrackSid.set(payload.trackSid, popout);
  popout.on("closed", () => {
    if (popoutWindowsByTrackSid.get(payload.trackSid) === popout) {
      popoutWindowsByTrackSid.delete(payload.trackSid);
    }
  });

  return { windowId: popout.id };
}

function closeScreenSharePopout(trackSid: string): void {
  const win = popoutWindowsByTrackSid.get(trackSid);
  if (!win) return;
  popoutWindowsByTrackSid.delete(trackSid);
  if (!win.isDestroyed()) win.close();
}

function registerIpcHandlers(): void {
  // Central
  handleIpc(
    IPC.CENTRAL_REGISTER,
    (
      _event,
      email: string,
      username: string,
      password: string,
      display_name: string,
      captcha_token: string,
    ) => central.register(email, username, password, display_name, captcha_token),
  );
  handleIpc(IPC.CENTRAL_LOGIN, (_event, identifier: string, password: string) =>
    central.login(identifier, password),
  );
  handleIpc(IPC.CENTRAL_OAUTH_START, (_event, provider: string) =>
    startDesktopOAuth(provider),
  );
  handleIpc(IPC.CENTRAL_LOGOUT, () => central.logout());
  handleIpc(IPC.CENTRAL_GET_PROFILE, () => central.getProfile());
  handleIpc(
    IPC.CENTRAL_PATCH_PROFILE,
    (
      _event,
      patch: {
        username?: string;
        display_name?: string;
        avatar_url?: string | null;
        email?: string;
        current_password?: string;
        new_password?: string;
      },
    ) => central.patchProfile(patch),
  );
  handleIpc(IPC.CENTRAL_GET_AVATAR_UPLOAD_URL, (_event, contentType: string) =>
    central.getAvatarUploadUrl(contentType),
  );
  handleIpc(IPC.CENTRAL_LIST_SERVERS, () => central.listServers());
  handleIpc(
    IPC.CENTRAL_CREATE_SERVER,
    (_event, payload: {
      name: string;
      description: string | null;
      visibility: "public" | "private";
    }) => central.createServer(payload.name, payload.description, payload.visibility),
  );
  handleIpc(IPC.CENTRAL_GET_SERVER_TOKEN, (_event, serverId: string) =>
    central.getServerToken(serverId),
  );
  handleIpc(IPC.CENTRAL_DELETE_SERVER, async (_event, serverId: string) => {
    // Central is authoritative — confirm the delete before tearing down
    // local resources. Previous ordering tore down the container and volume
    // first, so a 500/5xx from Central left the user with a broken record
    // (container gone, entry survives, next restoreServerContainers runs
    // against a vanished volumePath). Central-first keeps local intact on
    // failure so the user can retry. 404 still counts as success (idempotent:
    // "ensure this server is gone" is satisfied if it's already gone).
    try {
      await central.deleteServer(serverId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/404|not found/i.test(msg)) throw err;
      log.info("central delete returned 404 — server already gone", { serverId });
    }

    await purgeLocalServer(serverId);
  });

  handleIpc(IPC.SERVER_PROVISION_START, (_event, payload: {
    name: string;
    description: string | null;
    visibility: "public" | "private";
    selectedPlugins: string[];
    tunnelMode: "cloudflare" | "demo";
    cloudflare_tunnel_token?: string | undefined;
    cloudflare_public_hostname?: string | undefined;
    channel?: RuntimeUpdateChannel;
  }) => {
    // Reject pathological tunnel-token payloads before they ever reach
    // provision.ts / disk. Real Cloudflare tunnel tokens are ~1KB; anything
    // larger is either a renderer mistake or malicious input.
    if (typeof payload.cloudflare_tunnel_token === "string") {
      const tokenLen = Buffer.byteLength(payload.cloudflare_tunnel_token, "utf8");
      if (tokenLen > MAX_TUNNEL_TOKEN_BYTES) {
        throw ipcError(
          IPC.SERVER_PROVISION_START,
          new Error(
            `cloudflare_tunnel_token too large (${tokenLen} bytes; max ${MAX_TUNNEL_TOKEN_BYTES})`,
          ),
        );
      }
    }

    // Validate channel — same union the runtime exposes. Default to "dev"
    // for first-boot until a stable runtime exists. (See plan D4 in
    // .claude/plans/snuggly-wishing-flamingo.md.)
    const channel: RuntimeUpdateChannel =
      payload.channel === "stable" || payload.channel === "beta" || payload.channel === "dev"
        ? payload.channel
        : "dev";
    const provisionInput = { ...payload, channel };

    const sessionId = randomUUID();

    // Capture the last warning event's errorCode so the terminal ERROR
    // payload can carry it forward. The provisioner emits the failing
    // step's warning event before throwing, so by the time the catch
    // below runs `lastErrorCode` is the precise code for the failure
    // — letting the wizard render friendly copy without having to
    // correlate progress + error event streams in the renderer.
    let lastErrorCode: string | undefined;

    void provisionServer(provisionInput, (eventPayload) => {
      if (eventPayload.status === "warning" && eventPayload.errorCode) {
        lastErrorCode = eventPayload.errorCode;
      }
      sendToWindow(IPC.SERVER_PROVISION_PROGRESS, {
        sessionId,
        ...eventPayload,
      });
    }, { devPluginFrontendMounts: devPluginFrontendMounts() }).then((result) => {
      registerServer(result.serverId, {
        containerId: result.containerId,
        volumePath: result.volumePath,
        hostPort: result.hostPort,
        ...(result.tunnelPublicHostname ? { tunnelPublicHostname: result.tunnelPublicHostname } : {}),
        ...(result.imageSignature ? { imageSignature: result.imageSignature } : {}),
      });
      sendToWindow(IPC.SERVER_PROVISION_DONE, { sessionId, ...result });
    }).catch((err) => {
      sendToWindow(IPC.SERVER_PROVISION_ERROR, {
        sessionId,
        message: errorMessage(err),
        ...(lastErrorCode ? { errorCode: lastErrorCode } : {}),
      });
    });

    return { sessionId };
  });

  handleIpc(IPC.CLOUDFLARE_GET_CONNECTION_STATE, () => getCloudflareConnectionState());
  handleIpc(IPC.CLOUDFLARE_SIGN_OUT, () => {
    signOutCloudflare();
  });

  // Docker Desktop boot helpers — backs the wizard's "Start Docker Desktop"
  // recovery button when the pre-flight check sees the daemon down.
  handleIpc(IPC.DOCKER_FIND_DESKTOP, (): { found: boolean; path?: string } => {
    const found = docker.findDockerDesktop();
    return found ? { found: true, path: found } : { found: false };
  });
  handleIpc(IPC.DOCKER_START_DESKTOP, (): void => {
    const found = docker.findDockerDesktop();
    if (!found) {
      throw ipcError(IPC.DOCKER_START_DESKTOP, new Error("Docker Desktop is not installed."));
    }
    docker.startDockerDesktop(found);
  });
  handleIpc(IPC.DOCKER_WAIT_FOR_RUNNING, (_event, timeoutMs?: number): Promise<boolean> => {
    // Cap the renderer-supplied timeout so a malicious payload can't pin
    // an IPC handler open indefinitely. 5 minutes is well past the slowest
    // observed Docker Desktop cold-start.
    const MAX_WAIT_MS = 5 * 60_000;
    const requested = typeof timeoutMs === "number" && timeoutMs > 0 ? timeoutMs : undefined;
    const bounded = requested === undefined ? undefined : Math.min(requested, MAX_WAIT_MS);
    return docker.waitForDockerRunning(bounded === undefined ? {} : { timeoutMs: bounded });
  });

  // Owner-initiated voice setup. The renderer's setup modal calls this with
  // the subdomain the owner just routed through their tunnel (e.g.
  // "voice.mygame.example.com" → :7880). We persist it on the local registry
  // and rebuild the runtime container with LIVEKIT_PUBLIC_URL set, which
  // flips /health/voice from "disabled" to "ready". Pass null to clear.
  handleIpc(IPC.VOICE_SET_HOSTNAME, async (
    _event,
    serverId: string,
    hostname: string | null,
  ): Promise<{ containerId: string }> => {
    if (typeof serverId !== "string" || serverId.length === 0) {
      throw ipcError(IPC.VOICE_SET_HOSTNAME, new Error("serverId required"));
    }
    if (hostname !== null) {
      // Conservative DNS hostname check — letters/digits/dots/hyphens only.
      // Bounded length so we don't write arbitrary blobs into the registry
      // file.  Tighter validation than tunnel_token because this becomes a
      // wss:// URL the runtime exports to clients via the voice token; a
      // garbage value silently breaks every join attempt.
      if (typeof hostname !== "string" || hostname.length === 0 || hostname.length > 253) {
        throw ipcError(IPC.VOICE_SET_HOSTNAME, new Error("invalid hostname length"));
      }
      if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(hostname)) {
        throw ipcError(IPC.VOICE_SET_HOSTNAME, new Error("invalid hostname characters"));
      }
    }

    const record = getServerRecord(serverId);
    if (!record) {
      throw ipcError(IPC.VOICE_SET_HOSTNAME, new Error(`unknown server ${serverId}`));
    }

    // Persist before rebuilding so a crash mid-rebuild leaves the registry
    // pointed at the new hostname; the next restoreServerContainers run
    // picks it up and re-rebuilds from a clean slate.
    const nextRecord = { ...record };
    if (hostname === null) {
      delete nextRecord.voicePublicHostname;
    } else {
      nextRecord.voicePublicHostname = hostname;
    }
    registerServer(serverId, nextRecord);

    // Rebuild the container with the updated env. Same shape as the launch
    // path's restoreServerContainers — keep them in lock-step on tmpfs flags
    // and tunnel-token piping.
    await removeIfExists(record.containerId);
    const tunnelToken = getSecret(tunnelSecretKey(serverId)) ?? undefined;
    let runtimeEncryptionSecret = getSecret(encryptionSecretKey(serverId));
    if (!runtimeEncryptionSecret) {
      runtimeEncryptionSecret = randomBytes(32).toString("hex");
      setSecret(encryptionSecretKey(serverId), runtimeEncryptionSecret);
    }
    const newContainerId = await runServerContainer({
      volumePath: record.volumePath,
      hostPort: record.hostPort,
      tunnelToken,
      runtimeEncryptionSecret,
      ...(record.tunnelPublicHostname ? { tunnelPublicHostname: record.tunnelPublicHostname } : {}),
      ...(hostname !== null ? { voicePublicHostname: hostname } : {}),
      ...(record.imageSignature ? { imageSignature: record.imageSignature } : {}),
      devPluginFrontendMounts: devPluginFrontendMounts(),
    });
    registerServer(serverId, { ...nextRecord, containerId: newContainerId });
    log.info("voice hostname updated", { serverId, hostname, containerId: newContainerId });
    return { containerId: newContainerId };
  });

  // Runtime update orchestration (Phase 01 §8). Per D3/O8 the desktop is the
  // only first-class orchestrator in v1; per D4 the install action is gated
  // by `core.runtime.update`. Renderer dispatches every update gesture
  // through these channels — the runtime itself is a passive store +
  // broadcaster (decisions.md O8). The handlers below are thin validators
  // that hand off to runtime-orchestrator, which owns the GHCR pull / tag
  // dance / rollback logic.
  handleIpc(IPC.RUNTIME_UPDATE_IS_ORCHESTRATOR, (): boolean => {
    return runtimeOrchestrator.isOrchestrator();
  });

  handleIpc(IPC.RUNTIME_UPDATE_GET_PREFERENCES, async (
    _event,
    serverId: string,
  ): Promise<RuntimeUpdatePreferences> => {
    if (typeof serverId !== "string" || serverId.length === 0) {
      throw ipcError(IPC.RUNTIME_UPDATE_GET_PREFERENCES, new Error("serverId required"));
    }
    return runtimeOrchestrator.getPreferencesForServer(serverId);
  });

  handleIpc(IPC.RUNTIME_UPDATE_SET_CHANNEL, async (
    _event,
    serverId: string,
    channel: RuntimeUpdateChannel,
  ): Promise<void> => {
    if (typeof serverId !== "string" || serverId.length === 0) {
      throw ipcError(IPC.RUNTIME_UPDATE_SET_CHANNEL, new Error("serverId required"));
    }
    if (channel !== "stable" && channel !== "beta" && channel !== "dev") {
      throw ipcError(
        IPC.RUNTIME_UPDATE_SET_CHANNEL,
        new Error(`channel must be one of stable|beta|dev (got ${String(channel)})`),
      );
    }
    await runtimeOrchestrator.setChannelForServer(serverId, channel);
  });

  handleIpc(IPC.RUNTIME_UPDATE_SET_BACKUP, (
    _event,
    serverId: string,
    enabled: boolean,
  ): void => {
    if (typeof serverId !== "string" || serverId.length === 0) {
      throw ipcError(IPC.RUNTIME_UPDATE_SET_BACKUP, new Error("serverId required"));
    }
    if (typeof enabled !== "boolean") {
      throw ipcError(IPC.RUNTIME_UPDATE_SET_BACKUP, new Error("enabled must be boolean"));
    }
    runtimeOrchestrator.setBackupBeforeUpdateForServer(serverId, enabled);
  });

  handleIpc(IPC.RUNTIME_UPDATE_CHECK, async (
    _event,
    serverId: string,
  ): Promise<RuntimeCheckOutcome> => {
    if (typeof serverId !== "string" || serverId.length === 0) {
      throw ipcError(IPC.RUNTIME_UPDATE_CHECK, new Error("serverId required"));
    }
    return runtimeOrchestrator.checkForUpdate(serverId);
  });

  handleIpc(IPC.RUNTIME_UPDATE_PERFORM, async (
    _event,
    serverId: string,
  ): Promise<RuntimeUpdateOutcome> => {
    if (typeof serverId !== "string" || serverId.length === 0) {
      throw ipcError(IPC.RUNTIME_UPDATE_PERFORM, new Error("serverId required"));
    }
    return runtimeOrchestrator.performUpdateForServer(serverId);
  });

  // User clicked "Restart to apply update" — resolves the awaiting-restart
  // gate inside performUpdateForServer. Returns true if a gate was
  // released, false if no update was pending (idempotent / safe to call).
  handleIpc(IPC.RUNTIME_UPDATE_CONFIRM_RESTART, (
    _event,
    serverId: string,
  ): boolean => {
    if (typeof serverId !== "string" || serverId.length === 0) {
      throw ipcError(IPC.RUNTIME_UPDATE_CONFIRM_RESTART, new Error("serverId required"));
    }
    return runtimeOrchestrator.confirmRestartForServer(serverId);
  });

  // Wizard preview — pass currentVersion "0.0.0" so the call returns the
  // newest version on the channel rather than "no upgrade available". Returns
  // null when the channel has no published release yet (the wizard then
  // disables that channel option). Network failures bubble back to the
  // renderer as a thrown IPC error, which the wizard surfaces as "couldn't
  // resolve version" without blocking the user.
  handleIpc(IPC.RUNTIME_RELEASES_RESOLVE_LATEST, async (
    _event,
    channel: RuntimeUpdateChannel,
  ): Promise<string | null> => {
    if (channel !== "stable" && channel !== "beta" && channel !== "dev") {
      throw ipcError(
        IPC.RUNTIME_RELEASES_RESOLVE_LATEST,
        new Error("channel must be stable|beta|dev"),
      );
    }
    return resolveLatestVersion({ channel, currentVersion: "0.0.0" });
  });

  // Plugin file downloads. The shell relays a plugin's
  // `platform.files.download` here so we can call `downloadURL` on the main
  // window's webContents directly — the old path went through `<a target=_blank>`
  // → `setWindowOpenHandler` → `downloadURL`, and that popup-intercept flow
  // failed on Linux Electron (popup opens, download never starts). URL shape
  // is the same `/files/...?t=&exp=&u=` HMAC-signed form the runtime issues;
  // we re-check it here as defense-in-depth so a buggy shell can't ask main
  // to download arbitrary URLs.
  handleIpc(IPC.DOWNLOADS_START, (_event, rawUrl: unknown) => {
    if (typeof rawUrl !== "string" || rawUrl.length > 4096) {
      throw ipcError(IPC.DOWNLOADS_START, new Error("url must be a string ≤4KB"));
    }
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw ipcError(IPC.DOWNLOADS_START, new Error("url is not parsable"));
    }
    if (parsed.protocol !== "https:" || !isRuntimeSignedFileUrl(parsed)) {
      throw ipcError(IPC.DOWNLOADS_START, new Error("url is not a runtime signed file URL"));
    }
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) {
      throw ipcError(IPC.DOWNLOADS_START, new Error("no active window"));
    }
    win.webContents.downloadURL(rawUrl);
  });

  // Screen sharing — see installDisplayMediaHandler() above for the picker
  // delegation flow. The renderer-facing surface is window.electron.screenShare.
  handleIpc(IPC.SCREEN_SHARE_LIST_SOURCES, async (): Promise<ScreenShareSource[]> => {
    const listed = await listScreenShareSources();
    return listed.filtered;
  });
  handleIpc(
    IPC.SCREEN_SHARE_RESPOND_PICKER,
    (_event, requestId: string, selection: ScreenShareSelection | null) => {
      if (typeof requestId !== "string" || requestId.length === 0) {
        throw ipcError(
          IPC.SCREEN_SHARE_RESPOND_PICKER,
          new Error("requestId required"),
        );
      }
      if (selection !== null) {
        if (
          !selection ||
          typeof selection !== "object" ||
          typeof selection.sourceId !== "string" ||
          typeof selection.audio !== "boolean"
        ) {
          throw ipcError(
            IPC.SCREEN_SHARE_RESPOND_PICKER,
            new Error("invalid selection shape"),
          );
        }
      }
      resolvePicker(requestId, selection);
    },
  );
  handleIpc(
    IPC.SCREEN_SHARE_POPOUT_CREATE,
    (_event, payload: { trackSid: string; title: string; sourceUrl: string }) => {
      if (
        !payload ||
        typeof payload.trackSid !== "string" ||
        typeof payload.title !== "string" ||
        typeof payload.sourceUrl !== "string"
      ) {
        throw ipcError(
          IPC.SCREEN_SHARE_POPOUT_CREATE,
          new Error("invalid popout payload"),
        );
      }
      return createScreenSharePopout(payload);
    },
  );
  handleIpc(IPC.SCREEN_SHARE_POPOUT_CLOSE, (_event, trackSid: string) => {
    if (typeof trackSid !== "string" || trackSid.length === 0) {
      throw ipcError(
        IPC.SCREEN_SHARE_POPOUT_CLOSE,
        new Error("trackSid required"),
      );
    }
    closeScreenSharePopout(trackSid);
  });
  handleIpc(IPC.SCREEN_SHARE_CHECK_PERMISSION, () => macosPermissionStatus());
  handleIpc(IPC.SCREEN_SHARE_REQUEST_PERMISSION, () => openScreenRecordingSettings());

  handleIpc(IPC.APP_GET_STARTUP_NOTICES, async (): Promise<StartupNotice[]> => {
    await startupCompletePromise;
    const notices: StartupNotice[] = [];
    if (registryWasQuarantinedThisSession()) {
      const qPath = lastQuarantinePath();
      notices.push({
        id: "registry-quarantined",
        severity: "warning",
        message: "Local server data was reset after a corrupt file was detected. Provision your servers again to restore them.",
        ...(qPath ? { detail: `The corrupt file was saved as ${qPath}.` } : {}),
      });
    }
    return notices;
  });

  // Custom titlebar window controls. Renderer paints the chrome and routes
  // gestures here. WINDOW_CLOSE goes through the existing hide-to-tray close
  // handler; WINDOW_QUIT_CONFIRMED is the long-press-X escape hatch that
  // bypasses hide-to-tray to fully quit (parity with the tray's "Quit
  // UnCorded" item — see `quitUncorded()` and the `before-quit` teardown).
  handleIpc(IPC.WINDOW_MINIMIZE, () => {
    win?.minimize();
  });
  handleIpc(IPC.WINDOW_MAXIMIZE_TOGGLE, () => {
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  handleIpc(IPC.WINDOW_CLOSE, () => {
    win?.close();
  });
  handleIpc(IPC.WINDOW_QUIT_CONFIRMED, () => {
    // Mirrors the tray's "Quit UnCorded" item. `before-quit` flips
    // isQuittingForReal so the close handler's hide-to-tray branch is
    // skipped, then teardown (container stop + secret cleanup) runs.
    app.quit();
  });
  handleIpc(IPC.WINDOW_GET_MAXIMIZED, () => win?.isMaximized() ?? false);
}

// Single-instance lock: a second `npm start` (or double-click on a packaged
// launcher) must not race the first process over the local server registry
// or Docker. The second instance immediately quits; the first instance
// re-focuses its existing window in response to the `second-instance` event.
const gotInstanceLock = app.requestSingleInstanceLock();
if (!gotInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    // Window may be hidden-to-tray when a second launch attempt happens;
    // showMainWindow unhides, unminimizes, and focuses in one step.
    for (const arg of argv) {
      if (arg.startsWith(`${DESKTOP_AUTH_PROTOCOL}://`)) {
        handleProtocolUrl(arg);
      }
    }
    showMainWindow();
  });

  app.on("open-url", (event, url) => {
    event.preventDefault();
    handleProtocolUrl(url);
  });

  app.whenReady().then(async () => {
    app.setAppUserModelId(DESKTOP_APP_ID);
    if (app.isPackaged) {
      app.setAsDefaultProtocolClient(DESKTOP_AUTH_PROTOCOL);
    } else {
      app.setAsDefaultProtocolClient(DESKTOP_AUTH_PROTOCOL, process.execPath, [
        path.resolve(process.argv[1] ?? "."),
      ]);
    }
    for (const arg of process.argv) {
      if (arg.startsWith(`${DESKTOP_AUTH_PROTOCOL}://`)) {
        handleProtocolUrl(arg);
      }
    }
    if (!app.isPackaged) {
      app.commandLine.appendSwitch("allow-insecure-localhost");
    }
    migrateSecrets();
    log.info("secret store ready", { ...getSecretStoreStatus() });
    installShellCSP();
    installDisplayMediaHandler();

    // Lock down every <webview> the renderer attaches. The renderer trusts
    // user-controlled URLs (browser panel), so the guest must run with
    // sandbox + contextIsolation + no Node — and definitely no preload from
    // our shell, which would expose the desktop IPC bridge to arbitrary web
    // pages.
    app.on("web-contents-created", (_event, contents) => {
      contents.on("will-attach-webview", (_e, webPreferences) => {
        webPreferences.nodeIntegration = false;
        webPreferences.contextIsolation = true;
        webPreferences.sandbox = true;
        delete webPreferences.preload;
      });
    });

    // Flush the session's HTTP cache + any stale Service Worker registered
    // by the previous UnCorded project that used to be hosted at
    // uncorded.app. Without this, testers upgrading from the old app see
    // stale HTML/JS until they manually hard-reload. Cookies, localStorage,
    // and IndexedDB are deliberately preserved so the auto-login session
    // and app settings survive every boot.
    try {
      await session.defaultSession.clearCache();
      await session.defaultSession.clearStorageData({
        storages: ["serviceworkers"],
      });
    } catch (err) {
      log.warn("session cache/serviceworker clear failed", {
        err: errorMessage(err),
      });
    }

    registerIpcHandlers();

    createWindow();
    createTray();
    setupAutoUpdater({
      logger: log,
      sendToWindow,
      isPackaged: app.isPackaged,
      platform: process.platform,
      env: process.env,
      currentVersion: app.getVersion(),
    });
    setupAutoUpdateIpc();
    suppressDefaultAppMenu();

    // Reconcile BEFORE restoring so an orphan container (Central doesn't
    // know about it anymore) never gets woken back up and handed a tunnel
    // port. Then bring the survivors online with a fresh token from the
    // secret store. Fire-and-forget: per-server failures are logged but never
    // block the shell from opening — the user can still inspect the bad
    // server in the UI and recover manually.
    //
    // Resolve startupCompletePromise when both registry-touching steps
    // finish (success or otherwise) so APP_GET_STARTUP_NOTICES has a
    // complete view of the quarantine flag. Any registry corruption that
    // triggers a quarantine has already flushed by the time the first
    // read() completes inside reconcile.
    void runReconcileRegistryWithCentral()
      .catch((err) => {
        log.error("reconcileRegistryWithCentral crashed", { err: errorMessage(err) });
      })
      .then(() => restoreServerContainers())
      .catch((err) => {
        log.error("restoreServerContainers crashed", { err: errorMessage(err) });
      })
      .finally(() => {
        startupCompleteResolve();
      });
  });

  // Stop containers cleanly when the user quits the desktop app. `before-quit`
  // is the right hook — it fires once per quit attempt, before any windows
  // close, and we can defer quit while we wait on the docker stops. After
  // that completes (or on a per-stop failure logged inside) we re-emit quit.
  let quitting = false;
  app.on("before-quit", (event) => {
    if (quitting) return;
    // Flip the flag FIRST so the window `close` handler stops hiding-to-tray
    // and lets the window actually close when app.quit() re-fires below.
    // Order matters — `isQuittingForReal` must be visible to `close` before
    // any windows start closing as part of the quit sequence.
    isQuittingForReal = true;
    event.preventDefault();
    quitting = true;
    // Reject any restart-gates so performUpdateForServer exits cleanly to
    // `state: "available"` instead of leaving runtimes stuck in
    // `awaiting-restart` across the next launch.
    runtimeOrchestrator.cancelPendingRestarts("Application is quitting");
    void stopAllServerContainers()
      .catch((err) => {
        log.error("stopAllServerContainers crashed", { err: errorMessage(err) });
      })
      .finally(() => {
        app.quit();
      });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("activate", () => {
    if (win === null) createWindow();
  });
}
