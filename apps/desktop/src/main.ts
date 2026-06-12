import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  ipcMain,
  Menu,
  type MenuItemConstructorOptions,
  nativeImage,
  screen,
  session,
  shell,
  systemPreferences,
  Tray,
  webContents,
  WebContentsView,
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
import { listWebApps, addWebApp, removeWebApp, getUrlPref, setUrlPref } from "./web-apps-store";
import type { WebAppPref } from "./web-apps-store";
import type {
  ScreenSharePermissionStatus,
  ScreenShareSelection,
  ScreenShareSource,
  StartupNotice,
} from "@uncorded/electron-bridge";
import { removeIfExists, runServerContainer } from "./server-runtime";
import { reconcileRegistryWithCentral } from "./reconcile";
import { archiveServerVolume, gcExpiredArchives } from "./server-archive";
import {
  getUpdateState,
  requestUpdateCheck,
  setupAutoUpdater,
  setupAutoUpdateIpc,
} from "./auto-update";
import * as runtimeOrchestrator from "./runtime-orchestrator";
import { resolveLatestVersion } from "./runtime-releases";
import {
  isProxyNavAllowed,
  proxyPermissionDecision,
  type ProxyMountRegistration,
} from "./proxy-guest-guards";
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

// Reverse-proxy <webview> mounts, keyed `${partition}::${mountPathPrefix}`.
// The renderer registers each guest as its webview attaches
// (PROXY_GUEST_REGISTER); main uses the registration to pin the guest's
// navigation to its mount and to recognise a partition as a proxy partition
// when wiring per-guest hardening. A server's mounts share one partition by
// design but live under distinct `/proxy/<slug>/<mount>/` prefixes, so keying
// by (partition, prefix) keeps each mount's pin distinct — otherwise a second
// mount's registration would clobber the first's and over-restrict its
// in-surface navigation. Entries are intentionally process-lifetime: a
// partition's session is long-lived and a stale entry only ever over-restricts
// (opens externally).
const proxyGuestRegistry = new Map<string, ProxyMountRegistration>();

function proxyMountKey(partition: string, mountPathPrefix: string): string {
  return `${partition}::${mountPathPrefix}`;
}

// Remembered allow/deny permission decisions for proxy guests, keyed
// `${partition}::${permission}`. A proxied third-party app must never silently
// obtain camera/mic/location; the host asks once via a native dialog and
// remembers the answer here so it doesn't re-prompt on every request.
const proxyPermissionMemory = new Map<string, boolean>();

// Partitions whose session handlers have already been installed, so
// hardenProxyPartition() stays idempotent across repeated registrations.
const hardenedProxyPartitions = new Set<string>();

// Guest webContents whose navigation guards are already attached, so we never
// double-bind will-navigate / setWindowOpenHandler on the same guest.
const guardedProxyContents = new WeakSet<WebContents>();

// Guest webContents whose host↔guest zoom reconcile is already wired, so we
// bind the did-finish-load pin exactly once per guest.
const zoomPinnedProxyContents = new WeakSet<WebContents>();

// Browser Panel guest webContents whose popup guard is already attached. Kept
// separate from guardedProxyContents because the two guests get different
// treatment: proxy guests are navigation-pinned to their mount, while a Browser
// Panel guest browses freely and has its window.open captured into an in-app
// native view (see attachBrowserGuestPopupGuard). Without this guard, a site's
// "detach" (window.open) silently dead-ends — the popup is blocked and the page
// dereferences a null window handle.
const guardedBrowserContents = new WeakSet<WebContents>();

// In-app native popup views (WebContentsView), keyed by an integer surfaceId.
// Each holds the LIVE webContents of a captured Browser Panel window.open, so
// the popup keeps its opener + sessionStorage + persist:browser login. The
// renderer positions them by reporting on-screen rects (LIVE_SURFACE_SET_BOUNDS)
// and releases them (LIVE_SURFACE_RELEASE) when the host frame/panel closes.
// Entries self-remove when the underlying webContents is destroyed.
const liveSurfaces = new Map<number, WebContentsView>();
let liveSurfaceSeq = 1;
// SurfaceIds currently set visible. WebContentsView has no getVisible() in this
// Electron, so we track the hidden→visible transition ourselves to fire a single
// repaint kick on dock (see LIVE_SURFACE_SET_BOUNDS).
const visibleLiveSurfaces = new Set<number>();
// Surfaces that already used their one automatic crash recovery (see
// attachLiveViewResilience). A second renderer crash stays dead rather than
// spinning a reload loop; entries clear when the surface is destroyed.
const crashReloadedSurfaces = new Set<number>();

// Free, frameless OS windows that host a popped-out native view directly (the
// view is a child of the popout's own contentView, so it moves with the window
// and isn't clipped to the main app). Keyed by the same surfaceId. Dock target
// is resolved at dock time by the renderer (whatever server/workspace is active
// then), so no association is remembered here. Membership in this map is also
// the trust boundary for the popout chrome's ipcMain.on messages.
const surfacePopouts = new Map<number, BrowserWindow>();
// Height (DIP) of the popout window's draggable chrome strip; the live view is
// parked below it. Must match the .bar height in buildPopoutChromeHtml.
const POPOUT_HEADER_H = 40;

// Human-readable labels for the permissions a proxy guest may prompt for, used
// in the native allow/deny dialog. Anything not promptable is denied without a
// dialog, so it never needs a label here.
const PROXY_PERMISSION_LABELS: Record<string, string> = {
  media: "camera and microphone",
  geolocation: "your location",
  notifications: "notifications",
  midi: "MIDI devices",
  midiSysex: "MIDI devices",
};

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

// Fire-and-forget variant of handleIpc for high-frequency renderer→main
// messages sent with `ipcRenderer.send` (no reply channel). Same sender-origin
// guard; handler throws are logged and the message dropped — there is nowhere
// to surface an error, and a malformed frame must not take main down.
function onIpc<T extends unknown[]>(
  channel: string,
  handler: (_event: Electron.IpcMainEvent, ...args: T) => void,
): void {
  ipcMain.on(channel, (event, ...args) => {
    const senderUrl = event.senderFrame?.url;
    if (!isAllowedIpcSender(senderUrl)) {
      log.warn("ipc rejected — sender origin not allowed", {
        channel,
        senderUrl: senderUrl ?? null,
      });
      return;
    }
    try {
      handler(event, ...(args as T));
    } catch (err) {
      log.error("ipc handler failed", {
        channel,
        err: errorMessage(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
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

// Find the proxy-mount registration a guest webContents is currently loaded
// under. Matches by session partition AND by the mount the guest's current URL
// sits in, so a server's two mounts (same partition, distinct prefixes) each
// resolve to their own pin instead of clobbering one another. Falls back to any
// same-partition registration when the current URL is uninformative (e.g.
// `about:blank` before first load). Returns null for any non-proxy webview
// (e.g. a Browser Panel guest on `persist:browser`), which is how the nav
// guards stay inert for everything but proxy mounts.
function proxyRegistrationForContents(contents: WebContents): ProxyMountRegistration | null {
  let currentUrl = "";
  try {
    currentUrl = contents.getURL();
  } catch {
    currentUrl = "";
  }
  let samePartitionFallback: ProxyMountRegistration | null = null;
  for (const reg of proxyGuestRegistry.values()) {
    if (contents.session !== session.fromPartition(reg.partition)) continue;
    if (currentUrl && isProxyNavAllowed(currentUrl, reg)) return reg;
    samePartitionFallback ??= reg;
  }
  return samePartitionFallback;
}

// Any registration on a partition — used only to name the app's host in the
// permission dialog, where the specific mount doesn't matter (all mounts on a
// server share an origin).
function proxyRegistrationForPartition(partition: string): ProxyMountRegistration | null {
  for (const reg of proxyGuestRegistry.values()) {
    if (reg.partition === partition) return reg;
  }
  return null;
}

// True when `contents` is a webview guest running on a hardened proxy
// partition. Used by the global web-contents-created hook to attach nav guards
// to a guest that attaches AFTER its registration landed (the registration's
// own getAllWebContents() sweep covers the reverse ordering).
function isProxyGuestContents(contents: WebContents): boolean {
  if (contents.getType() !== "webview") return false;
  for (const partition of hardenedProxyPartitions) {
    if (contents.session === session.fromPartition(partition)) return true;
  }
  return false;
}

// Pin a proxy guest's navigation to its mount. An in-surface navigation that
// leaves the mount (different origin, or off the `/proxy/<slug>/<mount>/` path)
// is treated as an external link: prevented and handed to the OS browser. New
// windows are always denied and routed externally — a proxied app never opens
// an in-app window. This is the guest analogue of attachWindowSecurityGuards,
// origin-pinned to the mount rather than the shell. Idempotent per guest.
function attachProxyGuestNavGuards(contents: WebContents): void {
  if (guardedProxyContents.has(contents)) return;
  guardedProxyContents.add(contents);

  contents.on("will-navigate", (event, navigationUrl) => {
    const reg = proxyRegistrationForContents(contents);
    // Not a proxy guest, or its registration is gone — leave navigation to the
    // default policy rather than blocking a Browser Panel guest.
    if (!reg) return;
    if (isProxyNavAllowed(navigationUrl, reg)) return;
    event.preventDefault();
    void shell.openExternal(navigationUrl).catch((err) => {
      log.warn("failed to open external proxy navigation", {
        url: navigationUrl,
        err: errorMessage(err),
      });
    });
  });

  contents.setWindowOpenHandler(({ url }) => {
    try {
      const u = new URL(url);
      if (u.protocol === "https:" || u.protocol === "http:") {
        void shell.openExternal(url).catch((err) => {
          log.warn("failed to open external proxy popup", {
            url,
            err: errorMessage(err),
          });
        });
      } else {
        log.warn("blocked proxy guest window.open to non-http url", { url });
      }
    } catch (err) {
      log.warn("blocked proxy guest window.open with malformed url", {
        url,
        err: errorMessage(err),
      });
    }
    return { action: "deny" };
  });
}

// True when `contents` is the Browser Panel's webview guest — a webview bound to
// the shared `persist:browser` partition. Distinct from isProxyGuestContents:
// the browser pane is user-driven and not pinned to any mount, so it gets only
// the popup guard below, never the proxy navigation pin.
function isBrowserPanelGuest(contents: WebContents): boolean {
  if (contents.getType() !== "webview") return false;
  return contents.session === session.fromPartition("persist:browser");
}

// Live views whose popup guard is already attached (mirrors
// guardedBrowserContents for WebContentsView-hosted pages).
const guardedLiveViewContents = new WeakSet<WebContents>();

// window.open from a LIVE view (a Web App panel's view, a docked captured
// popup, or a popped-out window's content). Same http(s) validation and
// createWindow adoption as attachBrowserGuestPopupGuard, but there is no
// Browser Panel to route a floating frame to — the captured popup opens
// directly as its own frameless live popout window (dockable later).
// Recursive: the popup's view gets this same guard, so popups-from-popups
// stay inside the capture model instead of leaking default Electron windows.
// Idempotent per webContents.
function attachLiveViewPopupGuard(view: WebContentsView): void {
  const contents = view.webContents;
  if (guardedLiveViewContents.has(contents)) return;
  guardedLiveViewContents.add(contents);

  contents.setWindowOpenHandler(({ url }) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      log.warn("blocked live-view window.open with malformed url", { url });
      return { action: "deny" };
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      log.warn("blocked live-view window.open to non-http url", { url });
      return { action: "deny" };
    }
    return {
      action: "allow",
      createWindow: (options) => {
        // Adopt the pre-created WebContents (live session: cookies +
        // sessionStorage + opener); only `background-tab` disposition leaves it
        // undefined — there we build a fresh sandboxed view on the shared
        // partition and load the URL ourselves. Same contract as
        // attachBrowserGuestPopupGuard's createWindow.
        const adopted = (options as { webContents?: WebContents }).webContents;
        const popupView = adopted
          ? new WebContentsView({ webContents: adopted })
          : new WebContentsView({
              webPreferences: {
                partition: "persist:browser",
                nodeIntegration: false,
                contextIsolation: true,
                sandbox: true,
              },
            });
        const surfaceId = liveSurfaceSeq++;
        liveSurfaces.set(surfaceId, popupView);
        if (!adopted) void popupView.webContents.loadURL(url);
        popupView.webContents.on("destroyed", () => {
          liveSurfaces.delete(surfaceId);
          visibleLiveSurfaces.delete(surfaceId);
          crashReloadedSurfaces.delete(surfaceId);
        });
        attachLiveViewResilience(surfaceId, popupView);
        // Straight into its own popout window — never parked in main, so there
        // is no renderer hand-off to leak if nothing claims it.
        createLiveSurfacePopout(surfaceId, url);
        return popupView.webContents;
      },
    };
  });
}

// Every live-view creation chokepoint runs this: capture the view's window.open
// into the popout model, and give a crashed renderer ONE automatic reload. A
// second crash is a crash loop — leave it dead (the user can close the panel /
// window; a full crashed-panel UI is deferred).
function attachLiveViewResilience(surfaceId: number, view: WebContentsView): void {
  attachLiveViewPopupGuard(view);
  attachLiveViewTitleSync(surfaceId, view);
  view.webContents.on("render-process-gone", (_event, details) => {
    if (view.webContents.isDestroyed()) return;
    if (crashReloadedSurfaces.has(surfaceId)) {
      log.warn("live view crashed again after auto-reload; leaving it dead", {
        surfaceId,
        reason: details.reason,
      });
      return;
    }
    crashReloadedSurfaces.add(surfaceId);
    log.warn("live view renderer gone; auto-reloading once", {
      surfaceId,
      reason: details.reason,
      url: view.webContents.getURL(),
    });
    view.webContents.reload();
  });
}

// Mirror a live view's document title everywhere it's shown, like a browser
// tab: the popout's OS window/taskbar title and the renderer (which tracks the
// docked panel header via LIVE_SURFACE_TITLE_CHANGED). The popout chrome
// strip's label intentionally stays the HOST, not the title — it's the
// provenance cue, and a page must not be able to restyle it via document.title;
// did-navigate refreshes it only when the host actually changes.
function attachLiveViewTitleSync(surfaceId: number, view: WebContentsView): void {
  view.webContents.on("page-title-updated", (_event, title) => {
    const popout = surfacePopouts.get(surfaceId);
    if (popout && !popout.isDestroyed()) popout.setTitle(title);
    sendToWindow(IPC.LIVE_SURFACE_TITLE_CHANGED, { surfaceId, title });
  });
  view.webContents.on("did-navigate", (_event, url) => {
    const popout = surfacePopouts.get(surfaceId);
    if (!popout || popout.isDestroyed()) return;
    let host = url;
    try {
      host = new URL(url).host;
    } catch {
      /* keep raw string */
    }
    // The chrome strip is our own data: page — poke its DOM directly rather
    // than growing the popout preload's IPC surface for one label.
    void popout.webContents
      .executeJavaScript(
        `(el => { if (el) { el.textContent = ${JSON.stringify(host)}; el.title = ${JSON.stringify(host)}; } })(document.querySelector(".host"))`,
        true,
      )
      .catch((err: unknown) => {
        log.warn("popout host-label update failed", { surfaceId, err: errorMessage(err) });
      });
  });
}

// Tear down a live view's contents the way the PAGE would close itself.
//
// A direct webContents.close() destroys the contents, but for a CAPTURED
// window.open popup the close is INVISIBLE to the web platform: the opener's
// window proxy never flips `closed`, and the popup's unload handlers never
// notify the opener. A site that tracks its popout (e.g. a roll20 character
// sheet) therefore still believes the popup is open — clicking "pop out" again
// does nothing (no window.open call ever reaches our capture handler) and the
// site renders its in-page surrogate blank. Evidence: the popout→close→reopen
// trace showed contents destroyed cleanly, then ZERO window.open activity on
// the reopen attempt.
//
// Running window.close() INSIDE the page takes the full browser close path:
// unload fires and the opener observes the close, so the site can re-open
// later. Script may not be able to self-close (crashed renderer, never-loaded
// view, non-script-opened page) — a short fallback hard-closes anything still
// alive, restoring the old behavior at worst.
function closeLiveViewContents(surfaceId: number, view: WebContentsView): void {
  const contents = view.webContents;
  if (contents.isDestroyed()) return;
  contents.executeJavaScript("window.close()", true).catch(() => {
    /* dead/never-loaded renderer — the fallback below hard-closes */
  });
  setTimeout(() => {
    if (!contents.isDestroyed()) {
      log.info("live view ignored window.close(); hard-closing contents", { surfaceId });
      contents.close();
    }
  }, 1500);
}

// Handle a Browser Panel guest's window.open (a site's "detach"/"pop-out").
// Instead of an OS window, we capture the popup into an in-app `WebContentsView`
// via `createWindow`: it returns a WebContents we construct, and Electron
// navigates the popup into THAT. Because the view is the genuine auxiliary
// browsing context, the popup keeps its live `window.opener`, its copy of the
// opener's sessionStorage, AND the shared `persist:browser` login — the exact
// in-memory state that re-opening a bare URL in a fresh <webview> would drop
// (the regression that left Roll20/OAuth popups logged-out or stuck loading).
//
// The view paints above renderer DOM, so the renderer positions it by reporting
// on-screen rects (LIVE_SURFACE_SET_BOUNDS) — first inside a floating frame,
// then anchored to a docked panel's body if the user docks it. We park it hidden
// (0×0) and notify the renderer (LIVE_SURFACE_INTERCEPTED, matched to the
// owning panel by webContentsId) to take over positioning. Non-http(s) schemes
// are denied.
//
// CRITICAL: `createWindow` MUST adopt the WebContents Electron pre-created and
// passed in `options.webContents` — that's the popup whose live session we want.
// Constructing a fresh WebContents instead throws "Invalid webContents. Created
// window should be connected to webContents passed with options object." The one
// exception is `background-tab` disposition (middle/ctrl-click), where Electron
// defers creation and `options.webContents` is undefined — there we make a fresh
// view on `persist:browser` and load the URL ourselves (a new tab carries no
// opener/sessionStorage to preserve anyway). Idempotent per guest.
function attachBrowserGuestPopupGuard(contents: WebContents): void {
  if (guardedBrowserContents.has(contents)) return;
  guardedBrowserContents.add(contents);

  contents.setWindowOpenHandler(({ url }) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      log.warn("blocked browser-panel window.open with malformed url", { url });
      return { action: "deny" };
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      log.warn("blocked browser-panel window.open to non-http url", { url });
      return { action: "deny" };
    }
    if (!win || win.isDestroyed()) {
      log.warn("browser-panel window.open with no main window to host it", { url });
      return { action: "deny" };
    }
    const hostWindow = win;
    return {
      action: "allow",
      createWindow: (options) => {
        // Adopt the popup's pre-created WebContents (Electron passes it in
        // `options.webContents`) so it keeps its live session — cookies +
        // sessionStorage + opener. It already inherits the opener guest's
        // `persist:browser` partition and sandboxed prefs, so we don't (and
        // mustn't) re-specify webPreferences when adopting. Only `background-tab`
        // disposition leaves `webContents` undefined (deferred creation); there
        // we build a fresh sandboxed view on the shared partition and load the
        // URL ourselves.
        const adopted = (options as { webContents?: WebContents }).webContents;
        const view = adopted
          ? new WebContentsView({ webContents: adopted })
          : new WebContentsView({
              webPreferences: {
                partition: "persist:browser",
                nodeIntegration: false,
                contextIsolation: true,
                sandbox: true,
              },
            });
        const surfaceId = liveSurfaceSeq++;
        liveSurfaces.set(surfaceId, view);
        hostWindow.contentView.addChildView(view);
        // Parked hidden until the renderer reports a host rect for it.
        view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
        view.setVisible(false);
        // Deferred background-tab popup: Electron didn't navigate it for us.
        if (!adopted) void view.webContents.loadURL(url);
        view.webContents.on("destroyed", () => {
          liveSurfaces.delete(surfaceId);
          visibleLiveSurfaces.delete(surfaceId);
          crashReloadedSurfaces.delete(surfaceId);
        });
        attachLiveViewResilience(surfaceId, view);
        sendToWindow(IPC.LIVE_SURFACE_INTERCEPTED, {
          surfaceId,
          url,
          webContentsId: contents.id,
        });
        return view.webContents;
      },
    };
  });
}

// Reconcile a proxy guest's effective scale to the host window's display so the
// guest lays out to the same CSS viewport it is painted into.
//
// The bug this fixes: a host-owned <webview> runs on its own webContents, which
// does NOT inherit the shell's devicePixelRatio. On a fractional Windows display
// scale (125% / 150%) the guest's `window.devicePixelRatio` can differ from the
// host's, so the guest interprets its painted device-pixel box as a *wider* CSS
// viewport than the box actually occupies — a WebGL/canvas app (Foundry VTT)
// then lays out its sidebar/tokens to that phantom width and they fall off the
// painted edge, with hit-testing offset to match. The same-renderer openMount
// iframe never shows this because it shares the host DPR.
//
// Fix: a <webview>'s effective scale is `devicePixelRatio × zoomFactor`. We want
// guest CSS width == host CSS box width, i.e. zoomFactor = hostScale / guestDPR.
// When the guest already follows the same display (guestDPR == hostScale) this
// is 1 — a deliberate no-op, so a correctly-sized 100%-scale guest is never
// perturbed and this can't regress the common case. Pinned visual-zoom limits
// keep a stray trackpad pinch from reintroducing a mismatch. Reapplied on every
// did-finish-load because a navigation can reset the zoom factor.
function reconcileProxyGuestZoom(contents: WebContents): void {
  if (contents.isDestroyed()) return;
  let hostScale: number;
  try {
    const bounds = win && !win.isDestroyed() ? win.getBounds() : null;
    hostScale = bounds
      ? screen.getDisplayMatching(bounds).scaleFactor
      : screen.getPrimaryDisplay().scaleFactor;
  } catch (err) {
    log.warn("proxy guest zoom reconcile: could not read host display scale", {
      err: errorMessage(err),
    });
    return;
  }
  contents
    .executeJavaScript("window.devicePixelRatio", true)
    .then((raw: unknown) => {
      if (contents.isDestroyed()) return;
      const guestDpr = typeof raw === "number" ? raw : Number.NaN;
      if (!Number.isFinite(guestDpr) || guestDpr <= 0) return;
      // Our zoomFactor is the only scale that should be in play; stop a stray
      // pinch from compounding on top of it.
      contents.setVisualZoomLevelLimits(1, 1).catch(() => {});
      const target = hostScale / guestDpr;
      // Host and guest already agree — leave the guest at 1× rather than nudging
      // it by a sub-percent rounding wobble.
      if (Math.abs(target - 1) < 0.01) {
        if (Math.abs(contents.getZoomFactor() - 1) >= 0.01) contents.setZoomFactor(1);
        return;
      }
      contents.setZoomFactor(target);
    })
    .catch((err) => {
      log.warn("proxy guest zoom reconcile failed", { err: errorMessage(err) });
    });
}

// Wire the host↔guest zoom reconcile onto a proxy guest. Idempotent per guest.
// Bound on did-finish-load so it runs after the initial mount load and again
// after the openUrl→mount redirect and any in-mount navigation (each of which
// can reset the guest's zoom factor).
function attachProxyGuestZoomPin(contents: WebContents): void {
  if (zoomPinnedProxyContents.has(contents)) return;
  zoomPinnedProxyContents.add(contents);
  contents.on("did-finish-load", () => reconcileProxyGuestZoom(contents));
}

// Native allow/deny dialog for a proxy guest permission request. The proxied
// app is third-party, so we never silently grant camera/mic/location — the host
// asks the user, naming the app's host, and the answer is remembered per
// (partition, permission) so we don't re-prompt.
async function promptProxyPermission(partition: string, permission: string): Promise<boolean> {
  const reg = proxyRegistrationForPartition(partition);
  let host = partition;
  if (reg) {
    try {
      host = new URL(reg.mountOrigin).host;
    } catch {
      host = reg.mountOrigin;
    }
  }
  const what = PROXY_PERMISSION_LABELS[permission] ?? permission;
  const options: Electron.MessageBoxOptions = {
    type: "question",
    buttons: ["Deny", "Allow"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: "Permission request",
    message: `Allow access to ${what}?`,
    detail: `The app at ${host} is requesting access to ${what}. This choice is remembered for this app.`,
  };
  const result =
    win && !win.isDestroyed()
      ? await dialog.showMessageBox(win, options)
      : await dialog.showMessageBox(options);
  return result.response === 1;
}

// Harden a proxy guest's session and pin every live guest on it. Called from
// the PROXY_GUEST_REGISTER handler. Two layers:
//   1. Per-partition session handlers (permissions, downloads) — installed once
//      per partition, idempotent via hardenedProxyPartitions.
//   2. Per-guest navigation guards — attached to every webview currently live
//      on this partition. This covers the attach-before-register ordering (the
//      guest already exists when registration lands). The register-before-
//      attach ordering — the common one, since the renderer fires the register
//      IPC synchronously as it appends the <webview>, before Electron has
//      asynchronously created the guest webContents — is covered by the global
//      web-contents-created hook (whenReady), which attaches the same guards
//      once the guest appears on a now-hardened partition.
// The global will-attach-webview block (whenReady) already forces sandbox /
// contextIsolation / no-Node / no-preload on every guest; this adds the
// proxy-specific navigation pin and permission gating on top.
function hardenProxyPartition(partition: string): void {
  if (!hardenedProxyPartitions.has(partition)) {
    hardenedProxyPartitions.add(partition);
    const sess = session.fromPartition(partition);

    sess.setPermissionRequestHandler((_wc, permission, callback) => {
      const remembered = proxyPermissionMemory.get(`${partition}::${permission}`);
      const decision = proxyPermissionDecision(remembered, permission);
      if (decision === "allow") {
        callback(true);
        return;
      }
      if (decision === "deny") {
        callback(false);
        return;
      }
      void promptProxyPermission(partition, permission)
        .then((granted) => {
          proxyPermissionMemory.set(`${partition}::${permission}`, granted);
          callback(granted);
        })
        .catch((err) => {
          log.warn("proxy permission prompt failed — denying", {
            partition,
            permission,
            err: errorMessage(err),
          });
          callback(false);
        });
    });

    // The synchronous check handler (navigator.permissions.query and friends)
    // must never prompt; surface only an explicitly remembered allow.
    sess.setPermissionCheckHandler((_wc, permission) => {
      return proxyPermissionMemory.get(`${partition}::${permission}`) === true;
    });

    // Never silently write a download to disk. Leaving savePath unset makes
    // Electron raise the OS save dialog; this listener exists to document that
    // and to log the routing.
    sess.on("will-download", (_event, item) => {
      log.info("proxy guest download routed to OS save dialog", {
        partition,
        url: item.getURL(),
        filename: item.getFilename(),
      });
    });
  }

  for (const contents of webContents.getAllWebContents()) {
    if (contents.getType() !== "webview") continue;
    if (contents.session !== session.fromPartition(partition)) continue;
    attachProxyGuestNavGuards(contents);
    // Mirror the web-contents-created branch: a guest that already exists when
    // its partition is hardened still needs its effective scale pinned to the
    // host display, or DPR reconciliation is skipped for pre-registered guests.
    attachProxyGuestZoomPin(contents);
  }
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

  // A real shell navigation (F5/Ctrl+R reload, dev-server restart) tears down
  // the renderer, and with it the session-only live-surfaces map — after the
  // new document loads, NOTHING can reference the WebContentsViews parked or
  // docked in this window, so they'd leak (each holds a renderer process)
  // while painting stale pixels over the fresh shell. Destroy them up front.
  // Popped-out views are exempt: their windows own their lifetime, and a
  // post-reload renderer can still dock them (the dock flow re-sends
  // surfaceId + url). The shell is an SPA, so main-frame non-same-document
  // navigations only happen on reload; the initial load sweeps an empty map.
  win.webContents.on("did-start-navigation", (details) => {
    if (!details.isMainFrame || details.isSameDocument) return;
    for (const [surfaceId, view] of [...liveSurfaces]) {
      if (surfacePopouts.has(surfaceId)) continue;
      liveSurfaces.delete(surfaceId);
      visibleLiveSurfaces.delete(surfaceId);
      if (win && !win.isDestroyed()) win.contentView.removeChildView(view);
      closeLiveViewContents(surfaceId, view);
    }
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
    // Archive — never hard-delete — the server volume. It holds irreplaceable
    // user data (custom plugins, channel history, server config) that no
    // teardown, automatic (reconcile orphan-purge) or intentional (delete),
    // should permanently destroy. archiveServerVolume moves it into
    // ~/.uncorded/trash; gcExpiredArchives reclaims it (and the encryption
    // secret) after the retention window. Best-effort: a failed archive leaves
    // the volume in place — still NOT deleted — rather than wedging the purge.
    try {
      const result = await archiveServerVolume(serverId, record.volumePath);
      if (result.archived) {
        log.info("archived server volume on purge", { serverId, dest: result.dest });
      }
    } catch (err) {
      log.warn("failed to archive server volume on purge — left in place", {
        serverId,
        err: errorMessage(err),
      });
    }
    removeServerRecord(serverId);
  }
  // Clear the cached tunnel token. We do NOT clear on container stop —
  // stops happen routinely (laptop sleep, app quit) and a clear there
  // would force the user to re-paste the token on every restart. Purge
  // is the only intent strong enough to invalidate it.
  deleteSecret(tunnelSecretKey(serverId));
  // The runtime encryption secret is deliberately KEPT here: it's required to
  // decrypt the just-archived at-rest data, so dropping it now would make the
  // archived volume unrecoverable. gcExpiredArchives deletes it only once it
  // removes the archived volume past the retention window.
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
    // Memberships, not the online-only directory: an offline server is still
    // ours and must NOT be treated as an orphan (the old directory-backed
    // list purged local data for any server that was merely inactive).
    listRemoteServers: () => central.listServers(),
    listLocalRecords: () => listServerRecords(),
    wasQuarantinedThisSession: () => registryWasQuarantinedThisSession(),
    purgeLocalServer: async (serverId: string) => {
      await purgeLocalServer(serverId);
      // An orphan purged here may be a server deleted from another client,
      // sitting in Central's 'deleting' state waiting for OUR purge-confirm
      // (this desktop holds the data). Fire it best-effort: 404 means it
      // settled already, 409 means it wasn't a delete (we left / were
      // kicked) — both fine to swallow; the reaper backstops a lost confirm.
      try {
        await central.confirmServerPurge(serverId);
      } catch (err) {
        // 404 = already settled, 409 = not a delete (we left / were kicked) —
        // both expected. Anything else still resolves via Central's reaper,
        // but log it so a systematic confirm failure is operationally visible.
        const benign =
          central.isCentralNotFound(err) ||
          (err instanceof central.CentralHttpError && err.status === 409);
        if (!benign) {
          log.warn("reconcile purge-confirm failed — Central reaper will free the slot", {
            serverId,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
    },
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

// ---------------------------------------------------------------------------
// Native-surface popout windows
// ---------------------------------------------------------------------------

// The draggable chrome strip rendered as the popout window's own page. The live
// WebContentsView is parked BELOW it (y = POPOUT_HEADER_H), so the buttons here
// are never under the native view (which always paints above DOM) — fixing the
// "header buttons don't work / content drifts" failure of the old in-app frame.
// Buttons talk to main via the popoutChrome bridge (popout-preload.ts).
function buildPopoutChromeHtml(opts: { host: string }): string {
  const esc = (s: string): string =>
    s.replace(/[&<>"']/g, (c) =>
      c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
    );
  const host = esc(opts.host);
  // Dock resolves its target at dock time (the renderer's active server), so the
  // button is always offered; with no active server the renderer toasts and the
  // window stays open (fail closed).
  const dockBtn = `<button class="btn" onclick="window.popoutChrome.dock()">Dock</button>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${host}</title>
<style>
  html,body{margin:0;padding:0;height:100%;background:#0b0b0e;color:#e7e7ea;
    font:13px/1.2 system-ui,'Segoe UI',sans-serif;overflow:hidden;}
  .bar{height:${POPOUT_HEADER_H}px;display:flex;align-items:center;gap:8px;
    padding:0 8px;box-sizing:border-box;background:#15151a;
    border-bottom:1px solid #26262e;-webkit-app-region:drag;user-select:none;}
  .host{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;
    white-space:nowrap;color:#b9b9c3;}
  .btn{-webkit-app-region:no-drag;appearance:none;border:1px solid #2e2e38;
    background:#1d1d24;color:#e7e7ea;height:26px;padding:0 10px;border-radius:6px;
    font:inherit;cursor:pointer;outline:none;transition:background 150ms ease;}
  .btn:hover{background:#272730;}
  .btn:active{background:#32323c;}
  .btn:focus-visible{outline:2px solid #6e6ef0;outline-offset:1px;}
  .btn.close{padding:0 9px;font-size:12px;}
</style>
</head>
<body>
  <div class="bar">
    <span class="host" title="${host}">${host}</span>
    ${dockBtn}
    <button class="btn" onclick="window.popoutChrome.openExternal()">Open in browser</button>
    <button class="btn close" onclick="window.popoutChrome.close()" aria-label="Close">&#10005;</button>
  </div>
</body>
</html>`;
}

// Position the live view to fill the popout window below the chrome strip.
function layoutSurfacePopout(popout: BrowserWindow, view: WebContentsView): void {
  const [width = 0, height = 0] = popout.getContentSize();
  view.setBounds({
    x: 0,
    y: POPOUT_HEADER_H,
    width,
    height: Math.max(0, height - POPOUT_HEADER_H),
  });
}

// Resolve which popout (and its surfaceId) a chrome-button IPC came from. Only
// our own popout windows are in surfacePopouts, so a match IS the authorization.
function popoutFromSender(
  sender: WebContents,
): { surfaceId: number; window: BrowserWindow } | null {
  for (const [surfaceId, window] of surfacePopouts) {
    if (window.webContents.id === sender.id) {
      return { surfaceId, window };
    }
  }
  return null;
}

// Re-assert a deterministic z-order for the docked native views: ascending
// surfaceId. A view's surfaceId is fixed for its whole life (unchanged by
// pop-out / dock), so this order never depends on add/dock churn — the user
// sees the same stacking every time. Electron moves an already-added child to
// topmost on re-add, so iterating ascending leaves the highest surfaceId on top
// and the lowest on the bottom. The renderer is the window's root webContents
// (not a child view), so the only contentView children are these native views.
function restackLiveSurfaces(): void {
  if (!win || win.isDestroyed()) return;
  const ids = [...liveSurfaces.keys()].sort((a, b) => a - b);
  for (const id of ids) {
    // A popped-out view lives in its popout window's contentView. addChildView
    // on the MAIN window would silently re-parent it (Electron moves a view to
    // the new parent), yanking the live view out of the window the user is
    // looking at — the popout goes blank. POPPED-OUT means the popout owns the
    // view exclusively (same invariant as the SET_BOUNDS / RELEASE guards).
    if (surfacePopouts.has(id)) continue;
    const view = liveSurfaces.get(id);
    if (view && !view.webContents.isDestroyed()) win.contentView.addChildView(view);
  }
}

// Create a fresh live native view for an arbitrary URL and park it hidden in the
// main window until the renderer reports a host rect. Mirrors the deferred
// `background-tab` branch of attachBrowserGuestPopupGuard (a brand-new view on
// the shared persist:browser partition, sandboxed), but is driven directly by a
// Web App panel's always-live mount path rather than a guest window.open. There
// is no live session to preserve here — the view loads `url` fresh — but it
// shares the partition, so cookies/localStorage from prior logins carry over.
// Returns the surfaceId the renderer binds to the panel's instanceId.
function createLiveSurface(url: string): number {
  if (!win || win.isDestroyed()) {
    throw new Error("no main window to host native surface");
  }
  const hostWindow = win;
  const view = new WebContentsView({
    webPreferences: {
      partition: "persist:browser",
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  const surfaceId = liveSurfaceSeq++;
  liveSurfaces.set(surfaceId, view);
  hostWindow.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
  view.setVisible(false);
  void view.webContents.loadURL(url);
  view.webContents.on("destroyed", () => {
    liveSurfaces.delete(surfaceId);
    visibleLiveSurfaces.delete(surfaceId);
    crashReloadedSurfaces.delete(surfaceId);
  });
  attachLiveViewResilience(surfaceId, view);
  restackLiveSurfaces();
  return surfaceId;
}

// Move a captured native view OUT of the main window and into its own free,
// frameless OS window that owns it directly. The live session is preserved (no
// reload) and the window can move anywhere, off-app / onto another monitor.
function createLiveSurfacePopout(surfaceId: number, fallbackUrl = ""): void {
  const view = liveSurfaces.get(surfaceId);
  if (!view || view.webContents.isDestroyed()) return;
  // Detach from the main window if it's currently parented there (docked/parked).
  if (win && !win.isDestroyed()) win.contentView.removeChildView(view);
  // A DOCKED view arriving here (panel-header "Pop out") is in the visible set;
  // POPPED-OUT means "not visible in the main window", so keep the invariant.
  // The next dock then correctly reads as hidden→visible for the repaint kick.
  visibleLiveSurfaces.delete(surfaceId);

  // A view popped out the instant it was captured (live-view popup guard) hasn't
  // committed its navigation yet, so getURL() is still "" — fall back to the
  // window.open URL for the chrome strip's host label.
  const currentUrl = view.webContents.getURL() || fallbackUrl;
  let host = currentUrl;
  try {
    host = new URL(currentUrl).host;
  } catch {
    /* keep raw string */
  }

  const popout = new BrowserWindow({
    width: 900,
    height: 640,
    minWidth: 480,
    minHeight: 320,
    // Taskbar label before the chrome page (whose <title> is also the host)
    // finishes loading — never the bare app name.
    title: host,
    frame: false,
    backgroundColor: "#0b0b0e",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "popout-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // Self-mirror filter must cover these too (a popped-out site could otherwise
  // be re-shared into a channel as a window source).
  tagAsUncordedWindow(popout.webContents);
  popout.removeMenu();

  popout.contentView.addChildView(view);
  view.setVisible(true);
  const relayout = (): void => layoutSurfacePopout(popout, view);
  relayout();
  popout.on("resize", relayout);
  // Content size is only final once the chrome page has laid out.
  popout.webContents.once("did-finish-load", () => {
    relayout();
    // An already-loaded view popping out (panel-header "Pop out") won't refire
    // page-title-updated — push its current title now, after the chrome page's
    // own <title> (the host fallback) has been applied so it can't overwrite.
    if (!view.webContents.isDestroyed()) {
      const title = view.webContents.getTitle();
      if (title !== "" && !popout.isDestroyed()) popout.setTitle(title);
    }
  });

  const dataUrl =
    "data:text/html;charset=utf-8," + encodeURIComponent(buildPopoutChromeHtml({ host }));
  void popout.loadURL(dataUrl).catch((err) => {
    log.error("live-surface popout loadURL failed", { err: errorMessage(err) });
  });

  surfacePopouts.set(surfaceId, popout);
  popout.on("closed", () => {
    const entry = surfacePopouts.get(surfaceId);
    // Still mapped → closed without docking: destroy the live view. (Dock claim
    // deletes the entry first, so this won't fire for a docked view.)
    if (entry === popout) {
      surfacePopouts.delete(surfaceId);
      liveSurfaces.delete(surfaceId);
      closeLiveViewContents(surfaceId, view);
    }
  });
}

// Step 1 of the dock handshake: the popout chrome's Dock button asks the
// renderer to dock this view. The popout is NOT touched — the renderer first
// verifies it can host a panel (an active server) and then claims the view via
// LIVE_SURFACE_CLAIM_DOCK. If anything renderer-side fails (no server, claim
// races a teardown), the popout simply stays open and the user loses nothing.
function requestDockFromPopout(found: { surfaceId: number; window: BrowserWindow }): void {
  const { surfaceId, window: popout } = found;
  const view = liveSurfaces.get(surfaceId);
  if (!view || view.webContents.isDestroyed()) {
    // Nothing left to dock — the popout is hosting a dead view; let its
    // 'closed' handler clean up the map entry.
    if (!popout.isDestroyed()) popout.close();
    return;
  }
  sendToWindow(IPC.LIVE_SURFACE_DOCK_REQUESTED, {
    surfaceId,
    url: view.webContents.getURL(),
    title: view.webContents.getTitle(),
  });
}

// Step 2 of the dock handshake: the renderer commits. Re-parent the popped-out
// view back into the main window (parked hidden) and close the popout. The
// webContents persists across the move, so the live session is kept. Returns
// whether the view is now parked in the main window — the renderer only opens
// a panel on true. Idempotent for a view that's already in the main window
// (the popup-pref auto-dock path claims a view that never popped out).
function claimDockLiveSurface(surfaceId: number): boolean {
  const view = liveSurfaces.get(surfaceId);
  if (!view || view.webContents.isDestroyed()) return false;
  if (!win || win.isDestroyed()) return false;
  const popout = surfacePopouts.get(surfaceId);
  // Drop the popout entry FIRST: (a) the popout's 'closed' handler must not
  // destroy the view we're claiming, and (b) restackLiveSurfaces skips
  // popped-out surfaces, so the entry must be gone before the re-normalize
  // below or the claimed view would be left out of the stack.
  surfacePopouts.delete(surfaceId);
  if (popout && !popout.isDestroyed()) popout.contentView.removeChildView(view);
  win.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
  view.setVisible(false);
  // Parked hidden in main: the next renderer-driven setBounds is a genuine
  // hidden→visible transition, so the repaint kick there fires for the dock.
  visibleLiveSurfaces.delete(surfaceId);
  // Docking re-adds the view on TOP regardless of its surfaceId — the one path
  // that breaks the ascending-id stack. Re-normalize so z-order stays stable.
  restackLiveSurfaces();
  if (popout && !popout.isDestroyed()) popout.close();
  return true;
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
  // Generic authed Central passthrough for the renderer's plain /v1 calls
  // (membership surfaces, patchServer, …). Scope-guarded to relative /v1
  // paths so the renderer can't point main's keychain session at an
  // arbitrary host.
  handleIpc(
    IPC.CENTRAL_REQUEST,
    (_event, payload: { method: string; path: string; bodyJson?: string }) => {
      const ALLOWED_METHODS = new Set(["GET", "POST", "PATCH", "PUT", "DELETE"]);
      if (
        typeof payload?.method !== "string" ||
        !ALLOWED_METHODS.has(payload.method.toUpperCase()) ||
        typeof payload.path !== "string" ||
        !payload.path.startsWith("/v1/") ||
        payload.path.includes("://") ||
        payload.path.includes("..")
      ) {
        throw new Error("central:request requires an allowed method and a relative /v1 path");
      }
      return central.rendererRequest(
        payload.method.toUpperCase(),
        payload.path,
        payload.bodyJson,
      );
    },
  );

  // central:list-servers serves the sidebar — the user's memberships
  // (/v1/me/servers), liveness-independent so inactive servers never vanish.
  // central:list-public-servers is the online-only Explore directory.
  handleIpc(IPC.CENTRAL_LIST_SERVERS, () => central.listServers());
  handleIpc(IPC.CENTRAL_LIST_PUBLIC_SERVERS, () => central.listPublicServers());
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
      if (!central.isCentralNotFound(err)) throw err;
      log.info("central delete returned 404 — server already gone", { serverId });
    }

    await purgeLocalServer(serverId);

    // Phase 2 of the two-phase delete: confirm the local purge so Central
    // hard-deletes the row and frees the owned-quota slot. Best-effort — a
    // 404 means it already settled, anything else is reaped server-side
    // after the abandoned-delete window.
    try {
      await central.confirmServerPurge(serverId);
    } catch (err) {
      if (!central.isCentralNotFound(err)) {
        log.warn("purge-confirm failed — Central reaper will free the slot", {
          serverId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
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
      payload.channel === "stable" || payload.channel === "test" || payload.channel === "dev"
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
    }, {
      devPluginFrontendMounts: devPluginFrontendMounts(),
      // Persist to the local registry the instant the container is confirmed
      // healthy — BEFORE provisioning's best-effort heartbeat / public-tunnel
      // waits — so a server that's up but whose Central round-trip times out
      // still survives a restart. restoreServerContainers reads this registry
      // on every launch; without an entry here the server can never auto-boot.
      persistServerRecord: (serverId, record) => { registerServer(serverId, record); },
    }).then((result) => {
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
    if (channel !== "stable" && channel !== "test" && channel !== "dev") {
      throw ipcError(
        IPC.RUNTIME_UPDATE_SET_CHANNEL,
        new Error(`channel must be one of stable|test|dev (got ${String(channel)})`),
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
    if (channel !== "stable" && channel !== "test" && channel !== "dev") {
      throw ipcError(
        IPC.RUNTIME_RELEASES_RESOLVE_LATEST,
        new Error("channel must be stable|test|dev"),
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

  // Register a host-owned reverse-proxy <webview> guest. The renderer calls
  // this as the guest attaches, handing us the partition it runs in plus the
  // mount's origin and path prefix. We store it so the guest's navigation can
  // be pinned to its mount and its permission requests gated. The payload is
  // fully validated — never trust the renderer's shape — and the partition
  // must be a `persist:proxy:` partition so this can't be used to harden (and
  // thereby re-scope permissions on) the general browser partition.
  handleIpc(IPC.PROXY_GUEST_REGISTER, (_event, raw: unknown) => {
    if (!raw || typeof raw !== "object") {
      throw ipcError(IPC.PROXY_GUEST_REGISTER, new Error("registration must be an object"));
    }
    const input = raw as Record<string, unknown>;
    const partition = input.partition;
    const mountOrigin = input.mountOrigin;
    const mountPathPrefix = input.mountPathPrefix;
    if (
      typeof partition !== "string" ||
      typeof mountOrigin !== "string" ||
      typeof mountPathPrefix !== "string"
    ) {
      throw ipcError(
        IPC.PROXY_GUEST_REGISTER,
        new Error("partition, mountOrigin, mountPathPrefix must be strings"),
      );
    }
    if (!partition.startsWith("persist:proxy:") || partition.length > 256) {
      throw ipcError(IPC.PROXY_GUEST_REGISTER, new Error("invalid proxy partition"));
    }
    // mountOrigin must be a bare https origin (no path/query), and the prefix a
    // mount path under /proxy/ with a trailing slash — the exact shape
    // bootstrapProxyMount produces. Reject anything else outright.
    let origin: URL;
    try {
      origin = new URL(mountOrigin);
    } catch {
      throw ipcError(IPC.PROXY_GUEST_REGISTER, new Error("mountOrigin is not a URL"));
    }
    if (
      origin.protocol !== "https:" ||
      origin.origin !== mountOrigin ||
      !mountPathPrefix.startsWith("/proxy/") ||
      !mountPathPrefix.endsWith("/") ||
      mountPathPrefix.length > 1024
    ) {
      throw ipcError(IPC.PROXY_GUEST_REGISTER, new Error("invalid mount origin or path prefix"));
    }
    proxyGuestRegistry.set(proxyMountKey(partition, mountPathPrefix), {
      partition,
      mountOrigin,
      mountPathPrefix,
    });
    hardenProxyPartition(partition);
  });

  // Desktop-owned per-server Web Apps. Storage is local (~/.uncorded/web-apps.json);
  // main is server-agnostic — the renderer (which owns the active server) passes
  // serverId on every call. Inputs are validated here because the store trusts
  // its callers. POP_OUT/GET_PREF/SET_PREF back the browser panel's dock overlay.
  handleIpc(IPC.WEB_APPS_LIST, (_event, serverId: unknown) => {
    if (typeof serverId !== "string" || serverId.length === 0) {
      throw ipcError(IPC.WEB_APPS_LIST, new Error("serverId must be a non-empty string"));
    }
    return listWebApps(serverId);
  });
  handleIpc(IPC.WEB_APPS_ADD, (_event, serverId: unknown, input: unknown) => {
    if (typeof serverId !== "string" || serverId.length === 0) {
      throw ipcError(IPC.WEB_APPS_ADD, new Error("serverId must be a non-empty string"));
    }
    if (!input || typeof input !== "object") {
      throw ipcError(IPC.WEB_APPS_ADD, new Error("input must be an object"));
    }
    const { url, title, faviconUrl } = input as Record<string, unknown>;
    // 2048 (not the 4096 sanity cap used elsewhere): a saved Web App's url is
    // persisted verbatim into synced layouts, whose validator rejects panel
    // urls over 2048 — accepting more here would let an add succeed and then
    // poison every workspace sync that includes the panel.
    if (typeof url !== "string" || url.length === 0 || url.length > 2048) {
      throw ipcError(IPC.WEB_APPS_ADD, new Error("url must be a string ≤2048 chars"));
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw ipcError(IPC.WEB_APPS_ADD, new Error("url is not parsable"));
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw ipcError(IPC.WEB_APPS_ADD, new Error("url must be http(s)"));
    }
    if (title !== undefined && typeof title !== "string") {
      throw ipcError(IPC.WEB_APPS_ADD, new Error("title must be a string"));
    }
    if (faviconUrl !== undefined && typeof faviconUrl !== "string") {
      throw ipcError(IPC.WEB_APPS_ADD, new Error("faviconUrl must be a string"));
    }
    return addWebApp(serverId, {
      url,
      ...(title !== undefined ? { title } : {}),
      ...(faviconUrl !== undefined ? { faviconUrl } : {}),
    });
  });
  handleIpc(IPC.WEB_APPS_REMOVE, (_event, serverId: unknown, id: unknown) => {
    if (typeof serverId !== "string" || serverId.length === 0) {
      throw ipcError(IPC.WEB_APPS_REMOVE, new Error("serverId must be a non-empty string"));
    }
    if (typeof id !== "string" || id.length === 0) {
      throw ipcError(IPC.WEB_APPS_REMOVE, new Error("id must be a non-empty string"));
    }
    removeWebApp(serverId, id);
  });
  // The old WEB_APPS_POP_OUT (a bare BrowserWindow on persist:browser) is gone:
  // it was the one lossy path — a fresh OS window with no dock affordance and no
  // capture model. "Open in window" is now always create + OPEN_WINDOW (a live
  // surface in the frameless popout, dockable later).
  handleIpc(IPC.WEB_APPS_GET_PREF, (_event, url: unknown) => {
    if (typeof url !== "string" || url.length === 0) {
      throw ipcError(IPC.WEB_APPS_GET_PREF, new Error("url must be a non-empty string"));
    }
    return getUrlPref(url);
  });
  handleIpc(IPC.WEB_APPS_SET_PREF, (_event, url: unknown, action: unknown) => {
    if (typeof url !== "string" || url.length === 0 || url.length > 4096) {
      throw ipcError(IPC.WEB_APPS_SET_PREF, new Error("url must be a string ≤4KB"));
    }
    if (action !== "dock" && action !== "window") {
      throw ipcError(IPC.WEB_APPS_SET_PREF, new Error("action must be 'dock' or 'window'"));
    }
    setUrlPref(url, action satisfies WebAppPref);
  });
  // Position an in-app native popup view over a renderer-reported rect (CSS px ==
  // DIPs at zoom 1; the shell fills the content area whose origin is 0,0 under the
  // hidden title bar). visible:false hides it without destroying it (off-screen
  // host placeholder, or a blocking modal that would otherwise be painted over).
  // Fire-and-forget (onIpc, ipcRenderer.send): this is the per-frame hot path
  // while a panel is dragged — an invoke round-trip is visible as the view
  // trailing its panel. Validation throws are logged + dropped by onIpc.
  onIpc(
    IPC.LIVE_SURFACE_SET_BOUNDS,
    (_event, surfaceId: unknown, bounds: unknown, visible: unknown) => {
      if (typeof surfaceId !== "number" || !Number.isInteger(surfaceId)) {
        throw ipcError(IPC.LIVE_SURFACE_SET_BOUNDS, new Error("surfaceId must be an integer"));
      }
      if (typeof visible !== "boolean") {
        throw ipcError(IPC.LIVE_SURFACE_SET_BOUNDS, new Error("visible must be a boolean"));
      }
      const b = bounds as { x: unknown; y: unknown; width: unknown; height: unknown } | null;
      if (
        !b ||
        typeof b.x !== "number" ||
        typeof b.y !== "number" ||
        typeof b.width !== "number" ||
        typeof b.height !== "number"
      ) {
        throw ipcError(IPC.LIVE_SURFACE_SET_BOUNDS, new Error("bounds must be {x,y,width,height}"));
      }
      const view = liveSurfaces.get(surfaceId);
      if (!view) return;
      // While popped out, the popout window owns the view's geometry and
      // visibility (its resize handler drives layoutSurfacePopout). Any
      // renderer report arriving now is stale by definition — e.g. the
      // originating panel closing fires untrack → visible:false, which would
      // 0×0-hide the view INSIDE the popout the user is looking at. Mirror of
      // the LIVE_SURFACE_RELEASE popout guard.
      if (surfacePopouts.has(surfaceId)) return;
      const wasVisible = visibleLiveSurfaces.has(surfaceId);
      view.setBounds({
        x: Math.round(b.x),
        y: Math.round(b.y),
        width: Math.max(0, Math.round(b.width)),
        height: Math.max(0, Math.round(b.height)),
      });
      view.setVisible(visible);
      if (visible) visibleLiveSurfaces.add(surfaceId);
      else visibleLiveSurfaces.delete(surfaceId);
      // Defensive repaint kick on the hidden→visible transition (the dock
      // case): a view re-attached from a closed popout window could in theory
      // re-join the main window's compositor without scheduling a paint.
      // NOTE: the blank-dock bug this was written for turned out to be pinned
      // renderer-side suspension (leaked surface blockers — see
      // website/src/components/ui/surface-blocker.tsx), not a missed repaint;
      // kept only because it's cheap and idempotent for views already painting.
      if (visible && !wasVisible && !view.webContents.isDestroyed()) {
        view.webContents.invalidate();
      }
    },
  );
  // Create a fresh live native view for a URL and return its surfaceId. Drives a
  // Web App panel's always-live mount: the panel binds the returned surfaceId to
  // its instanceId and renders the live WebContentsView. http(s)-only, same URL
  // guard as WEB_APPS_ADD.
  handleIpc(IPC.LIVE_SURFACE_CREATE, (_event, url: unknown) => {
    if (typeof url !== "string" || url.length === 0 || url.length > 4096) {
      throw ipcError(IPC.LIVE_SURFACE_CREATE, new Error("url must be a string ≤4KB"));
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw ipcError(IPC.LIVE_SURFACE_CREATE, new Error("url is not parsable"));
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw ipcError(IPC.LIVE_SURFACE_CREATE, new Error("url must be http(s)"));
    }
    return createLiveSurface(url);
  });
  // Destroy an in-app native popup view (host frame/panel closed, or Web App
  // removed). The renderer then re-creates a fresh live view for the URL on the
  // next mount. NO-OP while the surface is popped out into its own window — that
  // window's own 'closed' handler owns the view's lifetime, and destroying it
  // here would yank the live view out from under a window the user still has open.
  handleIpc(IPC.LIVE_SURFACE_RELEASE, (_event, surfaceId: unknown) => {
    if (typeof surfaceId !== "number" || !Number.isInteger(surfaceId)) {
      throw ipcError(IPC.LIVE_SURFACE_RELEASE, new Error("surfaceId must be an integer"));
    }
    if (surfacePopouts.has(surfaceId)) return;
    const view = liveSurfaces.get(surfaceId);
    if (!view) return;
    liveSurfaces.delete(surfaceId);
    if (win && !win.isDestroyed()) win.contentView.removeChildView(view);
    closeLiveViewContents(surfaceId, view);
  });
  // Open the native view in its own free, frameless OS window that owns it
  // directly (header + content glued, movable anywhere off-app). Live session
  // preserved — no reload. Where it docks is resolved at dock time (the
  // renderer's then-active server), so no target is passed here.
  handleIpc(IPC.LIVE_SURFACE_OPEN_WINDOW, (_event, surfaceId: unknown) => {
    if (typeof surfaceId !== "number" || !Number.isInteger(surfaceId)) {
      throw ipcError(IPC.LIVE_SURFACE_OPEN_WINDOW, new Error("surfaceId must be an integer"));
    }
    createLiveSurfacePopout(surfaceId);
  });
  // Step 2 of the dock handshake (see claimDockLiveSurface): the renderer has
  // verified it can host a panel and now claims the view. Returns whether the
  // view is parked in the main window ready to be tracked — on false the
  // renderer must NOT open a panel (the popout, if any, stays open).
  handleIpc(IPC.LIVE_SURFACE_CLAIM_DOCK, (_event, surfaceId: unknown) => {
    if (typeof surfaceId !== "number" || !Number.isInteger(surfaceId)) {
      throw ipcError(IPC.LIVE_SURFACE_CLAIM_DOCK, new Error("surfaceId must be an integer"));
    }
    return claimDockLiveSurface(surfaceId);
  });
  // Popout-window chrome buttons (popout-preload.ts → ipcRenderer.send). These
  // come from a data: URL page that can't pass the shell-origin guard, so they
  // use ipcMain.on directly; the trust boundary is surfacePopouts membership
  // (popoutFromSender returns null for any sender that isn't one of our popouts).
  ipcMain.on(IPC.LIVE_SURFACE_WINDOW_DOCK, (event) => {
    const found = popoutFromSender(event.sender);
    if (found) requestDockFromPopout(found);
  });
  ipcMain.on(IPC.LIVE_SURFACE_WINDOW_CLOSE, (event) => {
    const found = popoutFromSender(event.sender);
    // Just close the window; its 'closed' handler (entry still mapped) releases
    // the live view.
    if (found && !found.window.isDestroyed()) found.window.close();
  });
  ipcMain.on(IPC.LIVE_SURFACE_WINDOW_OPEN_EXTERNAL, (event) => {
    const found = popoutFromSender(event.sender);
    if (!found) return;
    const view = liveSurfaces.get(found.surfaceId);
    if (!view || view.webContents.isDestroyed()) return;
    const url = view.webContents.getURL();
    if (url.startsWith("https:") || url.startsWith("http:")) {
      void shell.openExternal(url).catch((err) => {
        log.error("live-surface popout open-external failed", { err: errorMessage(err) });
      });
    }
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

      // Pin a reverse-proxy guest's navigation as soon as it appears. The
      // renderer fires PROXY_GUEST_REGISTER synchronously while appending the
      // <webview>, before Electron has created this guest webContents, so the
      // register handler's own sweep usually can't see the guest yet — this
      // hook closes that race by attaching the guards once the guest exists on
      // an already-hardened proxy partition. Non-proxy guests (Browser Panel on
      // `persist:browser`) never match, so their window.open stays untouched.
      if (isProxyGuestContents(contents)) {
        attachProxyGuestNavGuards(contents);
        // Pin the guest's effective scale to the host display so a fractional
        // Windows scale can't make it lay out to a wider viewport than painted.
        attachProxyGuestZoomPin(contents);
      } else if (isBrowserPanelGuest(contents)) {
        // Browser Panel guest (`persist:browser`): capture window.open into an
        // in-app live view so a site's detach/pop-out works instead of dead-ending.
        attachBrowserGuestPopupGuard(contents);
      }
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

    // Reclaim archived server volumes (and their encryption secrets) past the
    // retention window. Independent of the restore chain and best-effort — a
    // failure here only means trash lingers, never lost live data. See
    // purgeLocalServer / server-archive.ts for why teardown archives instead of
    // hard-deleting.
    void gcExpiredArchives({
      onReclaim: (sid) => {
        deleteSecret(encryptionSecretKey(sid));
        log.info("trash GC reclaimed archived server", { serverId: sid });
      },
      onError: (name, err) => {
        log.warn("trash GC failed to remove archived entry", { name, err: errorMessage(err) });
      },
    }).catch((err) => {
      log.error("gcExpiredArchives crashed", { err: errorMessage(err) });
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
    // Close live-surface popouts now (quit is deferred below, so they'd
    // otherwise linger until the re-emitted quit). Each window's 'closed'
    // handler runs the opener-visible teardown (closeLiveViewContents).
    for (const popout of surfacePopouts.values()) {
      if (!popout.isDestroyed()) popout.close();
    }
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
