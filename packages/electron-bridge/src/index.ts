// Type contract for the context-bridge surface that the desktop app's
// preload.ts exposes on `window.electron`. Lives in a shared package so the
// website (renderer) and desktop (preload + main) reference one source of
// truth — neither side reaches across app boundaries to import types.
//
// Do not import Node or Electron runtime types here.

/** Mirrors Node's `process.platform` values. Inlined here so the bridge
 *  package doesn't have to import Node runtime types. */
export type Platform =
  | "aix"
  | "android"
  | "darwin"
  | "freebsd"
  | "haiku"
  | "linux"
  | "openbsd"
  | "sunos"
  | "win32"
  | "cygwin"
  | "netbsd";

export interface DockerStatus {
  installed: boolean;
  running: boolean;
}

export interface Container {
  id: string;
  name: string;
  image: string;
  status: string;
  created: number;
}

type CleanupFn = () => void;

export interface Account {
  id: string;
  email: string;
  username: string;
  /** ISO-8601 timestamp of the last username change, or null if never renamed. */
  username_changed_at: string | null;
  /** ISO-8601 timestamp at which the cooldown ends, or null if a rename is currently allowed. */
  username_change_available_at: string | null;
  display_name: string;
  avatar_url: string | null;
  email_verified: boolean;
  phone_verified: boolean;
  providers?: string[];
}

export interface Server {
  id: string;
  name: string;
  description: string | null;
  visibility: "public" | "private";
  owner_id: string;
  /** Resolved client-side from the token mint (Central's list/get responses
   *  no longer carry the URL — it is a membership capability bundled with the
   *  join token). null until the first token for this server is minted. */
  tunnel_url: string | null;
  /** Membership role from /v1/me/servers — absent on directory rows. */
  role?: "owner" | "member";
  /** Membership joined_at from /v1/me/servers — absent on directory rows. */
  joined_at?: string;
  /** Tunnel lifecycle reported by the runtime heartbeat: "demo" | "named" |
   *  "local" | "expired", or null until the first heartbeat carries it.
   *  Mirrors the website `Server` type so the bridge array stays assignable. */
  tunnel_state: "demo" | "named" | "local" | "expired" | null;
  runtime_version: string | null;
  connected_users: number;
  plugin_count: number;
  is_online: boolean;
  last_heartbeat_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProvisionProgressEvent {
  sessionId: string;
  step: string;
  status: "running" | "progress" | "completed" | "warning";
  message: string;
  detail?: string;
  /** Numeric pull progress 0..1 — only emitted by the download-runtime
   *  step. The wizard renders this as a determinate progress bar; absence
   *  means "indeterminate" (spinner). */
  percent?: number;
}

export interface ProvisionDoneEvent {
  sessionId: string;
  serverId: string;
  slug: string;
  tunnelUrl: string | null;
  containerId: string;
  hostPort: number;
}

export interface CloudflareConnectionState {
  connected: boolean;
  accountTag?: string;
}

export interface AvatarUploadUrl {
  upload_url: string;
  upload_fields: Record<string, string>;
  final_url: string;
  expires_in: number;
  max_bytes: number;
}

// Surfaced by the renderer on mount via window.electron.app.getStartupNotices().
// One-off notices the main process accrues during startup — e.g. registry
// quarantine after corrupt-file recovery. The `id` is open-ended so future
// notice types (tunnel-token expired, update failed, etc.) don't require an
// electron-bridge change the renderer has to wait on.
export interface StartupNotice {
  id: "registry-quarantined" | (string & {});
  severity: "info" | "warning" | "error";
  message: string;
  detail?: string;
}

export type UpdateStatus =
  | "disabled"
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "downloaded"
  | "error";

export interface UpdateState {
  enabled: boolean;
  status: UpdateStatus;
  currentVersion: string;
  availableVersion: string | null;
  downloadedVersion: string | null;
  downloadPercent: number | null;
  checkedAt: string | null;
  message: string | null;
  errorContext: "check" | "download" | "install" | null;
  canRetry: boolean;
}

// Per-server runtime container update orchestration (Phase 01 §8). The
// renderer drives every update gesture through this surface; the runtime
// itself is a passive store + broadcaster (decisions.md O8/D4) and the
// orchestrator (desktop main) is the actor that pulls images, swaps
// containers, and writes state transitions back into the runtime.
//
// `RuntimeUpdateChannel` mirrors the same union the runtime exposes on
// /admin/api/update-state — keeping it shared here avoids the renderer
// having to import a runtime-side type just to render a dropdown.
export type RuntimeUpdateChannel = "stable" | "test" | "dev";

// Per-server preferences the renderer reads when rendering the Runtime
// panel. `channel` lives on the runtime side (persisted in update-state.json
// and broadcast over WS); `backupBeforeUpdate` lives on the desktop's local
// registry because it's an orchestrator-side toggle (only desktop actually
// performs the snapshot, so only desktop needs the bit).
export interface RuntimeUpdatePreferences {
  channel: RuntimeUpdateChannel;
  /** O3 default ON: undefined or true → snapshot; only `false` skips. */
  backupBeforeUpdate: boolean;
}

// Outcome of a manual check-for-update click. The runtime enforces a 1/30s
// per-server rate limit; surfacing the throttle lets the renderer show a
// "try again in a moment" hint instead of leaving the user clicking refresh
// into the void.
export type RuntimeCheckOutcome =
  | { ok: true }
  | { ok: false; reason: "rate-limited" };

// `phase` mirrors `RuntimeUpdatePhase` from runtime-update.ts; renderer
// uses it to pick the right copy from update-ux.md §4.4.
export type RuntimeUpdateOutcome =
  | {
      ok: true;
      version: string;
      containerId: string;
      rolledBack: false;
    }
  | {
      ok: false;
      phase: "check" | "backup" | "download" | "install" | "rollback";
      reason: string;
      rolledBack: boolean;
      rollbackOk?: boolean;
      containerId?: string;
      version?: string;
    };

// Single source-of-truth shape for picker entries. Main encodes the
// thumbnail + app icon as data URLs so the renderer doesn't need any Node
// APIs (NativeImage is main-only).
export interface ScreenShareSource {
  id: string;
  name: string;
  thumbnailDataUrl: string;
  appIconDataUrl: string | null;
  displayId: string;
  type: "screen" | "window";
}

// Picker request as it arrives in the renderer. The renderer must respond
// via window.electron.screenShare.respondToPicker(requestId, selection).
// Failing to respond hangs the originating getDisplayMedia call until the
// renderer reloads or the main process tears down.
export interface ScreenShareRequest {
  requestId: string;
  sources: ScreenShareSource[];
  // Whether the page asked for system audio. The picker UI reflects this
  // as the default state of the "Share audio" toggle. Even when true, the
  // user can opt out; even when false, the user can opt in (subject to OS
  // / source-type support).
  audioRequested: boolean;
}

export interface ScreenShareSelection {
  sourceId: string;
  audio: boolean;
}

// macOS screen-recording permission states from systemPreferences. On
// non-macOS platforms the main process returns "granted" (no per-app
// recording gate exists outside macOS). "not-determined" only occurs on
// macOS before the user has been asked once; "denied"/"restricted" both
// route to the System Settings deep link.
export type ScreenSharePermissionStatus =
  | "not-determined"
  | "granted"
  | "denied"
  | "restricted"
  | "unknown";

// A browser-pane URL the user promoted to a persistent, login-sticky webview
// panel. PER-SERVER scoped (each server has its own set, keyed serverId-side in
// the desktop store) but desktop-owned — the runtime/Central never see these.
// Shared here because the renderer (which can't import desktop-app modules)
// needs the shape, and the desktop store imports this same type so there's one
// source of truth. See memory `desktop-owned-web-apps-sidebar`.
export interface WebApp {
  id: string;
  url: string;
  title: string;
  faviconUrl?: string;
  /** Epoch ms the entry was added; used for stable sidebar ordering. */
  addedAt: number;
}

/** A saved per-URL preference for where a page opens: docked into the current
 *  workspace as a panel, or in its own frameless live popout window. Legacy
 *  values "panel"/"popout" are migrated on read (apps/desktop/web-apps-store). */
export type WebAppPref = "dock" | "window";

export interface ElectronBridge {
  central: {
    register(
      email: string,
      username: string,
      password: string,
      display_name: string,
      captcha_token: string,
    ): Promise<void>;
    startOAuth(provider: "google" | "discord" | "github"): Promise<Account>;
    /** `identifier` is either an email address or a username (case-insensitive). */
    login(identifier: string, password: string): Promise<Account>;
    logout(): Promise<void>;
    getProfile(): Promise<Account>;
    patchProfile(patch: {
      username?: string;
      display_name?: string;
      avatar_url?: string | null;
      email?: string;
      current_password?: string;
      new_password?: string;
    }): Promise<Account>;
    getAvatarUploadUrl(contentType: string): Promise<AvatarUploadUrl>;
    /** Generic authed /v1 passthrough — the renderer's own fetch carries no
     *  session inside Electron, so plain Central calls proxy through main
     *  with the keychain session attached. Optional: older packaged preloads
     *  (auto-update lag) won't expose it; callers must feature-check. */
    request?(
      method: string,
      path: string,
      bodyJson?: string,
    ): Promise<{ status: number; body: unknown }>;
    /** Sidebar source: the user's memberships (/v1/me/servers) — includes
     *  offline servers so an inactive server never vanishes. */
    listServers(): Promise<Server[]>;
    /** Online-only public directory (/v1/servers) — the Explore surface. */
    listPublicServers(): Promise<Server[]>;
    createServer(
      name: string,
      description: string | null,
      visibility: "public" | "private",
    ): Promise<{ id: string; server_secret: string }>;
    getServerToken(serverId: string): Promise<{ token: string; expires_at: number; tunnel_url: string | null }>;
    deleteServer(serverId: string): Promise<void>;
  };
  docker: {
    getStatus(): Promise<DockerStatus>;
    listContainers(nameFilter?: string): Promise<Container[]>;
    startContainer(id: string): Promise<void>;
    startLogs(containerId: string): Promise<void>;
    stopLogs(containerId: string): Promise<void>;
    pullImage(image: string): Promise<void>;
    onLogsData(handler: (payload: { containerId: string; line: string }) => void): CleanupFn;
    onLogsEnd(handler: (payload: { containerId: string }) => void): CleanupFn;
    onPullProgress(handler: (payload: { image: string; line: string }) => void): CleanupFn;
    onPullDone(handler: (payload: { image: string }) => void): CleanupFn;
    onPullError(handler: (payload: { image: string; message: string }) => void): CleanupFn;
    /**
     * Look for a Docker Desktop install on disk so the create-server wizard
     * can offer a one-click "Start Docker Desktop" recovery when the
     * pre-flight check sees the daemon down. Returns `{ found: false }` on
     * Linux (dockerd is a system service, not user-launchable) and on
     * Windows/macOS systems where no install path matches.
     */
    findDesktop(): Promise<{ found: boolean; path?: string }>;
    /**
     * Launch Docker Desktop and return immediately. Throws if no install was
     * found by `findDesktop`. Caller should follow with `waitForRunning` to
     * poll for daemon readiness.
     */
    startDesktop(): Promise<void>;
    /**
     * Poll `docker info` until the daemon answers, or until `timeoutMs`
     * elapses (default 120s, capped at 5m). Resolves `true` when running,
     * `false` on timeout.
     */
    waitForRunning(timeoutMs?: number): Promise<boolean>;
  };
  serverProvisioning: {
    start(payload: {
      name: string;
      description: string | null;
      visibility: "public" | "private";
      selectedPlugins: string[];
      tunnelMode: "cloudflare" | "demo";
      cloudflare_tunnel_token?: string | undefined;
      cloudflare_public_hostname?: string | undefined;
      /** Runtime distribution channel for the initial pull. Optional;
       *  main.ts defaults to "dev" if absent (until the first stable
       *  runtime release exists). */
      channel?: RuntimeUpdateChannel;
    }): Promise<{ sessionId: string }>;
    onProgress(handler: (payload: ProvisionProgressEvent) => void): CleanupFn;
    onDone(handler: (payload: ProvisionDoneEvent) => void): CleanupFn;
    onError(handler: (payload: { sessionId: string; message: string; errorCode?: string }) => void): CleanupFn;
  };
  cloudflare: {
    getConnectionState(): Promise<CloudflareConnectionState>;
    signOut(): Promise<void>;
  };
  voice: {
    setHostname(serverId: string, hostname: string | null): Promise<{ containerId: string }>;
  };
  proxy: {
    /**
     * Register a host-owned reverse-proxy <webview> guest with the main
     * process so it can pin the guest's navigation to its mount and gate its
     * permission requests. Called once per guest as the <webview> attaches.
     * Keyed by session partition (`persist:proxy:<serverId>`); re-registering
     * the same partition updates the pin.
     */
    registerGuest(input: {
      partition: string;
      mountOrigin: string;
      mountPathPrefix: string;
    }): Promise<void>;
  };
  runtimeUpdate: {
    /**
     * Always `true` when the renderer is running inside the desktop shell
     * (the desktop is the only first-class orchestrator in Phase 01 per
     * D3/O8). The hosted control plane will return `false` here for clients
     * that aren't the orchestrator session, gating the install button
     * without changing the visibility of the pill.
     */
    isOrchestrator(): Promise<boolean>;
    /**
     * One-shot read of per-server preferences (channel + backup toggle).
     * Channel sourced from the runtime's update-state; backup toggle from
     * the desktop's local registry. Renderer should treat the WS broadcast
     * as the source of truth for `channel` after this initial read.
     */
    getPreferences(serverId: string): Promise<RuntimeUpdatePreferences>;
    /**
     * Persist `channel` to the runtime via POST /admin/api/update-state.
     * Triggers a `core.runtime.update_state_changed` WS broadcast that
     * every connected client picks up — including the same renderer that
     * issued the call. Renderer should not optimistically update its store.
     */
    setChannel(serverId: string, channel: RuntimeUpdateChannel): Promise<void>;
    /**
     * Persist the per-server backup-before-update preference to the local
     * registry. Default ON (O3) — only stored when the user explicitly
     * disables it. Effect is local-only; no WS broadcast.
     */
    setBackupBeforeUpdate(serverId: string, enabled: boolean): Promise<void>;
    /**
     * Trigger a check-for-update cycle. The runtime's
     * /admin/api/check-update endpoint flips state to "checking" + fires
     * the WS broadcast; the orchestrator then resolves the latest version
     * for the active channel and POSTs the resulting state. Rate-limited
     * 1/30s per server inside the runtime.
     */
    checkForUpdate(serverId: string): Promise<RuntimeCheckOutcome>;
    /**
     * Run the orchestrator-side update state machine for a single server.
     * Long-running — typical happy-path is dominated by `docker pull` and
     * the post-swap /ready wait. Resolves with the outcome; the renderer
     * follows the WS broadcast for live progress and uses the returned
     * outcome only for terminal handling (toast, retry button, etc.).
     */
    performUpdate(serverId: string): Promise<RuntimeUpdateOutcome>;
    /**
     * Resolve the orchestrator-side `awaiting-restart` gate so the runtime
     * can progress into the irreversible install phase. Fired by the
     * renderer's "Restart to apply update" button. Returns `true` if a gate
     * was actually released; `false` if no update was sitting at the gate
     * (idempotent / safe to call multiple times). The runtime sits at
     * `awaiting-restart` indefinitely until this fires (hard pause — no
     * implicit timeout).
     */
    confirmRestart(serverId: string): Promise<boolean>;
  };
  runtimeReleases: {
    /**
     * Resolves the newest version published on `channel` (per the
     * `runtime-*` GitHub release tag scan), or `null` when the channel has
     * no published release yet. Used by the create-server wizard to preview
     * the version each channel will install before the user submits, and to
     * disable the channel option when no release exists.
     */
    resolveLatest(channel: RuntimeUpdateChannel): Promise<string | null>;
  };
  keychain: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
  };
  app: {
    getStartupNotices(): Promise<StartupNotice[]>;
    /** OS family the renderer is running under. Read once at preload
     *  injection (not async) so the titlebar can pick the right shortcut
     *  text and traffic-light reservation without waiting on IPC. */
    platform: Platform;
  };
  /** Custom titlebar window controls — Win/Linux only. The renderer paints
   *  the chrome and routes gestures here. `close()` follows the existing
   *  hide-to-tray close handler; `quit()` is the long-press-X escape hatch
   *  that fully quits (parity with the tray's "Quit UnCorded" item). */
  window: {
    minimize(): Promise<void>;
    maximizeToggle(): Promise<void>;
    close(): Promise<void>;
    quit(): Promise<void>;
    getMaximized(): Promise<boolean>;
    onMaximizeChange(handler: (maximized: boolean) => void): CleanupFn;
  };
  update: {
    getState(): Promise<UpdateState>;
    check(): Promise<UpdateState>;
    download(): Promise<UpdateState>;
    install(): Promise<void>;
    onState(handler: (state: UpdateState) => void): CleanupFn;
  };
  downloads: {
    /**
     * Trigger a native download for `url`. Used by the shell to honor a
     * plugin's `platform.files.download` request without routing the click
     * through `<a target="_blank">` + `setWindowOpenHandler`. The previous
     * popup-intercept path failed on Linux Electron — the popup opens but
     * `webContents.downloadURL` from `setWindowOpenHandler` silently dropped
     * the download. This direct main-process call uses the parent webContents
     * itself, which works on every platform.
     *
     * `url` MUST be a runtime signed file URL (matches `/files/...?t=&exp=&u=`)
     * — main re-checks the URL shape and rejects anything else.
     */
    start(url: string): Promise<void>;
  };
  screenShare: {
    /**
     * One-shot list of capturable screens and windows, with thumbnails. Main
     * filters out every UnCorded BrowserWindow (main + popouts) so the
     * picker can never feed an UnCorded window back as a source — that's
     * the screen-of-screen mirror loop edge case. Use this for the
     * thumbnail-grid layout in the picker modal.
     */
    listSources(): Promise<ScreenShareSource[]>;
    /**
     * Subscribe to picker open requests from the main process. Fires when
     * the user (or LiveKit on its behalf) calls `getDisplayMedia` and main
     * delegates to the renderer for source selection. The renderer MUST
     * call respondToPicker(requestId, selection|null) — null cancels.
     */
    onShowPicker(handler: (req: ScreenShareRequest) => void): CleanupFn;
    respondToPicker(requestId: string, selection: ScreenShareSelection | null): Promise<void>;
    /**
     * Pop out a screen-share tile into a borderless always-on-top window.
     * The popout window is also tagged uncordedWindow=true so it can't be
     * re-shared into a mirror loop. Returns the window id used for close.
     */
    popoutCreate(payload: {
      trackSid: string;
      title: string;
      sourceUrl: string;
    }): Promise<{ windowId: number }>;
    popoutClose(trackSid: string): Promise<void>;
    /**
     * macOS screen-recording permission probe. Always returns "granted" on
     * non-macOS. On macOS, "denied" or "restricted" routes to the System
     * Settings deep link via requestPermission.
     */
    checkPermission(): Promise<ScreenSharePermissionStatus>;
    /**
     * macOS-only no-op that opens System Settings → Privacy → Screen
     * Recording. Returns "ok" once the deep link was handed off; the user
     * must come back and re-trigger the share. On non-macOS, resolves "ok".
     */
    requestPermission(): Promise<{ status: "ok" | "unsupported" }>;
  };
  // Desktop-owned, PER-SERVER "Web Apps" — browser-pane URLs promoted to
  // persistent login-sticky webview panels. Storage is local to the desktop
  // (~/.uncorded/web-apps.json), never synced to the runtime/Central. The
  // renderer gates this whole surface on isElectron() — website/mobile can't
  // host <webview> so they never call it. The renderer owns serverId (main is
  // server-agnostic), so list/add/remove take it explicitly.
  webApps: {
    list(serverId: string): Promise<WebApp[]>;
    add(
      serverId: string,
      input: { url: string; title?: string; faviconUrl?: string },
    ): Promise<WebApp>;
    remove(serverId: string, id: string): Promise<void>;
    /**
     * The dock overlay's "save preference for this URL" — keyed by the EXACT
     * URL (not host), global (the choice is about the URL, not the server).
     * `getPref` returns null until the user has saved a choice for this URL.
     */
    getPref(url: string): Promise<WebAppPref | null>;
    setPref(url: string, action: WebAppPref): Promise<void>;
  };
  // In-app native popup views. When a Browser Panel guest calls `window.open`,
  // main captures it (via `setWindowOpenHandler`'s `createWindow`) into a fresh
  // `WebContentsView` instead of an OS window — preserving the popup's live
  // session (cookies + sessionStorage + opener). The view is either hosted in a
  // free, frameless OS popout window (where it OWNS the view directly) or docked
  // into the main window and positioned by the renderer reporting an on-screen
  // rect over IPC (anchored to a panel body).
  liveSurface: {
    /**
     * Create a fresh live native view loading `url` (http(s) only), parked hidden
     * until the renderer reports a host rect. Returns the `surfaceId` to bind to
     * a Web App panel's instanceId. The view shares the `persist:browser`
     * partition, so prior logins (cookies/localStorage) carry over; no in-memory
     * session is preserved (it's a fresh load). Drives the always-live mount path.
     */
    create(url: string): Promise<number>;
    /**
     * Position the native view (identified by the `surfaceId` from
     * `onIntercepted`) over a rect in the window's content area (CSS px == DIPs
     * at zoom 1, content origin at 0,0). `visible:false` hides it without
     * destroying it — used when the host placeholder is off-screen (inactive
     * tab, focus-collapse) or a blocking modal is open (the view would otherwise
     * paint over it). Used only while the view is DOCKED in the main window.
     *
     * Fire-and-forget (`ipcRenderer.send`, not invoke): this fires per
     * animation frame during panel drags, and any round-trip latency shows up
     * as the view trailing its panel. Ordering is guaranteed by the channel;
     * invalid payloads are logged and dropped main-side.
     */
    setBounds(
      surfaceId: number,
      bounds: { x: number; y: number; width: number; height: number },
      visible: boolean,
    ): void;
    /**
     * Destroy the native view and its webContents. Called when the host panel
     * closes / the Web App is removed. The renderer then falls back to a fresh
     * `<webview>` if the same URL re-opens.
     */
    release(surfaceId: number): Promise<void>;
    /**
     * Open the native view in its own free, frameless OS window that owns the
     * view directly (header + content glued, movable anywhere off-app). The live
     * session is preserved (no reload). Where it docks is resolved at dock time
     * (the renderer's then-active server) — no target is remembered here.
     */
    openWindow(surfaceId: number): Promise<void>;
    /**
     * Step 2 of the dock handshake: claim the view for docking. Main re-parents
     * it into the main window (parked hidden), then closes its popout window if
     * it had one. Returns whether the view is parked and ready to be tracked —
     * on `false` (view destroyed, no main window) the caller must NOT open a
     * panel; the popout, if any, stays open and the user loses nothing.
     * Idempotent for a view already parked in the main window (the popup-pref
     * auto-dock path).
     */
    claimDock(surfaceId: number): Promise<boolean>;
    /**
     * Fires when a Browser Panel guest opens a new window. Main has already
     * created the native view (parked hidden) and loaded the URL into it;
     * `webContentsId` identifies the guest (match `<webview>.getWebContentsId()`)
     * so the owning panel can host it, and `surfaceId` keys all later
     * setBounds/release/openWindow calls.
     */
    onIntercepted(
      handler: (payload: { surfaceId: number; url: string; webContentsId: number }) => void,
    ): CleanupFn;
    /**
     * Step 1 of the dock handshake: fires when the user clicks "Dock" in a
     * popout window. The popout is still open and still owns the view — the
     * renderer verifies it can host a panel (an active server; toast + stop if
     * not), then commits via `claimDock(surfaceId)` and only on `true` opens a
     * workspace panel at the live `url`. Claim-before-panel means no stale
     * setBounds can race the move.
     */
    onDockRequested(
      handler: (payload: { surfaceId: number; url: string; title: string }) => void,
    ): CleanupFn;
    /**
     * Fires when a live view's document title changes (`page-title-updated`),
     * so a docked panel's header can track the page like a browser tab does.
     * Main also mirrors the title onto a popout's OS window title itself; this
     * event is for renderer-owned chrome only.
     */
    onTitleChanged(
      handler: (payload: { surfaceId: number; title: string }) => void,
    ): CleanupFn;
  };
}

// Canonical IPC channel contract for the desktop main <-> preload transport.
//
// This is the single source of truth for the channel-name strings that wire
// `ipcMain.handle` (main process) to `ipcRenderer.invoke`/`.on` (preload). Both
// `apps/desktop/src/ipc.ts` (main side) and `apps/desktop/src/preload.ts`
// (preload side) declare a runtime `IPC` constant and pin it with
// `... as const satisfies IpcChannelMap`.
//
// Why the literals are still spelled out in both desktop files instead of
// imported once at runtime: the main window's preload runs sandboxed
// (`sandbox: true`), and the desktop build is plain `tsc` with no bundler, so a
// sandboxed preload cannot `require()` a sibling module at runtime. The strings
// must therefore be physically present in the compiled preload. Pinning both
// copies to this type makes them a verified mirror: a typo or drift in either
// file — which used to fail silently at runtime (the handler simply never
// fired) — is now a `tsc` error. The exact-literal value types are what catch a
// mistyped channel string; the closed key set catches an added/renamed/removed
// channel.
//
// The renderer never references these strings (it speaks only the typed
// `ElectronBridge` surface above), but the contract lives here so the one
// shared, dependency-free package owns it.
export interface IpcChannelMap {
  // Central
  readonly CENTRAL_REGISTER: "central:register";
  readonly CENTRAL_OAUTH_START: "central:oauth-start";
  readonly CENTRAL_LOGIN: "central:login";
  readonly CENTRAL_LOGOUT: "central:logout";
  readonly CENTRAL_GET_PROFILE: "central:get-profile";
  readonly CENTRAL_PATCH_PROFILE: "central:patch-profile";
  readonly CENTRAL_GET_AVATAR_UPLOAD_URL: "central:get-avatar-upload-url";
  readonly CENTRAL_REQUEST: "central:request";
  readonly CENTRAL_LIST_SERVERS: "central:list-servers";
  readonly CENTRAL_LIST_PUBLIC_SERVERS: "central:list-public-servers";
  readonly CENTRAL_CREATE_SERVER: "central:create-server";
  readonly CENTRAL_GET_SERVER_TOKEN: "central:get-server-token";
  readonly CENTRAL_DELETE_SERVER: "central:delete-server";

  // Server provisioning
  readonly SERVER_PROVISION_START: "server:provision:start";
  readonly SERVER_PROVISION_PROGRESS: "server:provision:progress";
  readonly SERVER_PROVISION_DONE: "server:provision:done";
  readonly SERVER_PROVISION_ERROR: "server:provision:error";

  // Docker Desktop boot helpers
  readonly DOCKER_FIND_DESKTOP: "docker:find-desktop";
  readonly DOCKER_START_DESKTOP: "docker:start-desktop";
  readonly DOCKER_WAIT_FOR_RUNNING: "docker:wait-for-running";

  // Cloudflare
  readonly CLOUDFLARE_GET_CONNECTION_STATE: "cloudflare:get-connection-state";
  readonly CLOUDFLARE_SIGN_OUT: "cloudflare:sign-out";

  // Voice setup
  readonly VOICE_SET_HOSTNAME: "voice:set-hostname";

  // Runtime container update orchestration
  readonly RUNTIME_UPDATE_IS_ORCHESTRATOR: "runtime-update:is-orchestrator";
  readonly RUNTIME_UPDATE_GET_PREFERENCES: "runtime-update:get-preferences";
  readonly RUNTIME_UPDATE_SET_CHANNEL: "runtime-update:set-channel";
  readonly RUNTIME_UPDATE_SET_BACKUP: "runtime-update:set-backup";
  readonly RUNTIME_UPDATE_CHECK: "runtime-update:check";
  readonly RUNTIME_UPDATE_PERFORM: "runtime-update:perform";
  readonly RUNTIME_UPDATE_CONFIRM_RESTART: "runtime-update:confirm-restart";

  // Runtime release lookup
  readonly RUNTIME_RELEASES_RESOLVE_LATEST: "runtime-releases:resolve-latest";

  // App lifecycle
  readonly APP_UPDATE_GET_STATE: "app:update:get-state";
  readonly APP_UPDATE_CHECK: "app:update:check";
  readonly APP_UPDATE_DOWNLOAD: "app:update:download";
  readonly APP_UPDATE_INSTALL: "app:update:install";
  readonly APP_UPDATE_STATE: "app:update:state";
  readonly APP_GET_STARTUP_NOTICES: "app:get-startup-notices";

  // Custom titlebar window controls
  readonly WINDOW_MINIMIZE: "window:minimize";
  readonly WINDOW_MAXIMIZE_TOGGLE: "window:maximize-toggle";
  readonly WINDOW_CLOSE: "window:close";
  readonly WINDOW_QUIT_CONFIRMED: "window:quit-confirmed";
  readonly WINDOW_GET_MAXIMIZED: "window:get-maximized";
  readonly WINDOW_MAXIMIZE_STATE: "window:maximize-state";

  // Screen sharing
  readonly SCREEN_SHARE_LIST_SOURCES: "desktop:screen-share:list-sources";
  readonly SCREEN_SHARE_SHOW_PICKER: "desktop:screen-share:show-picker";
  readonly SCREEN_SHARE_RESPOND_PICKER: "desktop:screen-share:respond-picker";
  readonly SCREEN_SHARE_POPOUT_CREATE: "desktop:screen-share:popout-create";
  readonly SCREEN_SHARE_POPOUT_CLOSE: "desktop:screen-share:popout-close";
  readonly SCREEN_SHARE_CHECK_PERMISSION: "desktop:screen-share:check-permission";
  readonly SCREEN_SHARE_REQUEST_PERMISSION: "desktop:screen-share:request-permission";

  // Plugin file downloads
  readonly DOWNLOADS_START: "desktop:downloads:start";

  // Reverse-proxy <webview> guest registration
  readonly PROXY_GUEST_REGISTER: "proxy:guest-register";

  // Desktop-owned per-server Web Apps
  readonly WEB_APPS_LIST: "desktop:web-apps:list";
  readonly WEB_APPS_ADD: "desktop:web-apps:add";
  readonly WEB_APPS_REMOVE: "desktop:web-apps:remove";
  readonly WEB_APPS_GET_PREF: "desktop:web-apps:get-pref";
  readonly WEB_APPS_SET_PREF: "desktop:web-apps:set-pref";

  // In-app native popup views (WebContentsView). A Browser Panel guest's
  // window.open is captured into a native view hosted in a free OS popout window
  // (which owns it directly) or docked into the main window and positioned via
  // bounds-over-IPC — preserving the popup's live session either way.
  readonly LIVE_SURFACE_INTERCEPTED: "desktop:live-surface:intercepted";
  readonly LIVE_SURFACE_CREATE: "desktop:live-surface:create";
  readonly LIVE_SURFACE_SET_BOUNDS: "desktop:live-surface:set-bounds";
  readonly LIVE_SURFACE_RELEASE: "desktop:live-surface:release";
  readonly LIVE_SURFACE_OPEN_WINDOW: "desktop:live-surface:open-window";
  readonly LIVE_SURFACE_CLAIM_DOCK: "desktop:live-surface:claim-dock";
  readonly LIVE_SURFACE_DOCK_REQUESTED: "desktop:live-surface:dock-requested";
  readonly LIVE_SURFACE_TITLE_CHANGED: "desktop:live-surface:title-changed";
  // Sent by the popout window's own chrome (popout-preload) to main.
  readonly LIVE_SURFACE_WINDOW_DOCK: "desktop:live-surface:window-dock";
  readonly LIVE_SURFACE_WINDOW_CLOSE: "desktop:live-surface:window-close";
  readonly LIVE_SURFACE_WINDOW_OPEN_EXTERNAL: "desktop:live-surface:window-open-external";
}

declare global {
  interface Window {
    electron: ElectronBridge;
  }
}
