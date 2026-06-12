import { contextBridge, ipcRenderer } from "electron";
import type {
  Account,
  AvatarUploadUrl,
  CloudflareConnectionState,
  IpcChannelMap,
  ProvisionDoneEvent,
  ProvisionProgressEvent,
  RuntimeCheckOutcome,
  RuntimeUpdateChannel,
  RuntimeUpdateOutcome,
  RuntimeUpdatePreferences,
  ScreenSharePermissionStatus,
  ScreenShareRequest,
  ScreenShareSelection,
  ScreenShareSource,
  Server,
  StartupNotice,
  UpdateState,
  WebApp,
  WebAppPref,
} from "@uncorded/electron-bridge";

type CleanupFn = () => void;

// These channel strings are intentionally spelled out here rather than imported
// from ./ipc: this preload runs sandboxed (sandbox: true) and the desktop build
// is plain tsc with no bundler, so a sandboxed preload cannot require() a
// sibling module at runtime. The `satisfies IpcChannelMap` guard pins every
// value to the shared contract in @uncorded/electron-bridge (and thus to
// ipc.ts, which is pinned to the same type), so any typo or drift from the main
// side now fails `tsc` instead of failing silently at runtime. `import type` is
// erased, so nothing is required here at runtime.
const IPC = {
  // Central
  CENTRAL_REGISTER: "central:register",
  CENTRAL_OAUTH_START: "central:oauth-start",
  CENTRAL_LOGIN: "central:login",
  CENTRAL_LOGOUT: "central:logout",
  CENTRAL_GET_PROFILE: "central:get-profile",
  CENTRAL_PATCH_PROFILE: "central:patch-profile",
  CENTRAL_GET_AVATAR_UPLOAD_URL: "central:get-avatar-upload-url",
  CENTRAL_LIST_SERVERS: "central:list-servers",
  CENTRAL_CREATE_SERVER: "central:create-server",
  CENTRAL_GET_SERVER_TOKEN: "central:get-server-token",
  CENTRAL_DELETE_SERVER: "central:delete-server",

  // Server provisioning
  SERVER_PROVISION_START: "server:provision:start",
  SERVER_PROVISION_PROGRESS: "server:provision:progress",
  SERVER_PROVISION_DONE: "server:provision:done",
  SERVER_PROVISION_ERROR: "server:provision:error",

  // Docker Desktop boot helpers
  DOCKER_FIND_DESKTOP: "docker:find-desktop",
  DOCKER_START_DESKTOP: "docker:start-desktop",
  DOCKER_WAIT_FOR_RUNNING: "docker:wait-for-running",

  // Cloudflare
  CLOUDFLARE_GET_CONNECTION_STATE: "cloudflare:get-connection-state",
  CLOUDFLARE_SIGN_OUT: "cloudflare:sign-out",

  // Voice setup
  VOICE_SET_HOSTNAME: "voice:set-hostname",

  // Runtime container update orchestration
  RUNTIME_UPDATE_IS_ORCHESTRATOR: "runtime-update:is-orchestrator",
  RUNTIME_UPDATE_GET_PREFERENCES: "runtime-update:get-preferences",
  RUNTIME_UPDATE_SET_CHANNEL: "runtime-update:set-channel",
  RUNTIME_UPDATE_SET_BACKUP: "runtime-update:set-backup",
  RUNTIME_UPDATE_CHECK: "runtime-update:check",
  RUNTIME_UPDATE_PERFORM: "runtime-update:perform",
  RUNTIME_UPDATE_CONFIRM_RESTART: "runtime-update:confirm-restart",

  RUNTIME_RELEASES_RESOLVE_LATEST: "runtime-releases:resolve-latest",

  // App lifecycle
  APP_UPDATE_GET_STATE: "app:update:get-state",
  APP_UPDATE_CHECK: "app:update:check",
  APP_UPDATE_DOWNLOAD: "app:update:download",
  APP_UPDATE_INSTALL: "app:update:install",
  APP_UPDATE_STATE: "app:update:state",
  APP_GET_STARTUP_NOTICES: "app:get-startup-notices",

  // Custom titlebar window controls
  WINDOW_MINIMIZE: "window:minimize",
  WINDOW_MAXIMIZE_TOGGLE: "window:maximize-toggle",
  WINDOW_CLOSE: "window:close",
  WINDOW_QUIT_CONFIRMED: "window:quit-confirmed",
  WINDOW_GET_MAXIMIZED: "window:get-maximized",
  WINDOW_MAXIMIZE_STATE: "window:maximize-state",

  // Screen sharing
  SCREEN_SHARE_LIST_SOURCES: "desktop:screen-share:list-sources",
  SCREEN_SHARE_SHOW_PICKER: "desktop:screen-share:show-picker",
  SCREEN_SHARE_RESPOND_PICKER: "desktop:screen-share:respond-picker",
  SCREEN_SHARE_POPOUT_CREATE: "desktop:screen-share:popout-create",
  SCREEN_SHARE_POPOUT_CLOSE: "desktop:screen-share:popout-close",
  SCREEN_SHARE_CHECK_PERMISSION: "desktop:screen-share:check-permission",
  SCREEN_SHARE_REQUEST_PERMISSION: "desktop:screen-share:request-permission",

  // Plugin file downloads
  DOWNLOADS_START: "desktop:downloads:start",

  // Reverse-proxy <webview> guest registration
  PROXY_GUEST_REGISTER: "proxy:guest-register",

  // Desktop-owned per-server Web Apps
  WEB_APPS_LIST: "desktop:web-apps:list",
  WEB_APPS_ADD: "desktop:web-apps:add",
  WEB_APPS_REMOVE: "desktop:web-apps:remove",
  WEB_APPS_GET_PREF: "desktop:web-apps:get-pref",
  WEB_APPS_SET_PREF: "desktop:web-apps:set-pref",
  LIVE_SURFACE_INTERCEPTED: "desktop:live-surface:intercepted",
  LIVE_SURFACE_CREATE: "desktop:live-surface:create",
  LIVE_SURFACE_SET_BOUNDS: "desktop:live-surface:set-bounds",
  LIVE_SURFACE_RELEASE: "desktop:live-surface:release",
  LIVE_SURFACE_OPEN_WINDOW: "desktop:live-surface:open-window",
  LIVE_SURFACE_CLAIM_DOCK: "desktop:live-surface:claim-dock",
  LIVE_SURFACE_DOCK_REQUESTED: "desktop:live-surface:dock-requested",
  LIVE_SURFACE_WINDOW_DOCK: "desktop:live-surface:window-dock",
  LIVE_SURFACE_WINDOW_CLOSE: "desktop:live-surface:window-close",
  LIVE_SURFACE_WINDOW_OPEN_EXTERNAL: "desktop:live-surface:window-open-external",
} as const satisfies IpcChannelMap;

function ipcInvoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : `${channel} failed`;
    throw new Error(message);
  }) as Promise<T>;
}

contextBridge.exposeInMainWorld("electron", {
  central: {
    register(
      email: string,
      username: string,
      password: string,
      display_name: string,
      captcha_token: string,
    ): Promise<void> {
      return ipcInvoke<void>(
        IPC.CENTRAL_REGISTER,
        email,
        username,
        password,
        display_name,
        captcha_token,
      );
    },
    startOAuth(provider: "google" | "discord" | "github"): Promise<Account> {
      return ipcInvoke<Account>(IPC.CENTRAL_OAUTH_START, provider);
    },
    login(identifier: string, password: string): Promise<Account> {
      return ipcInvoke<Account>(IPC.CENTRAL_LOGIN, identifier, password);
    },
    logout(): Promise<void> {
      return ipcInvoke<void>(IPC.CENTRAL_LOGOUT);
    },
    getProfile(): Promise<Account> {
      return ipcInvoke<Account>(IPC.CENTRAL_GET_PROFILE);
    },
    patchProfile(patch: {
      username?: string;
      display_name?: string;
      avatar_url?: string | null;
      email?: string;
      current_password?: string;
      new_password?: string;
    }): Promise<Account> {
      return ipcInvoke<Account>(IPC.CENTRAL_PATCH_PROFILE, patch);
    },
    getAvatarUploadUrl(contentType: string): Promise<AvatarUploadUrl> {
      return ipcInvoke<AvatarUploadUrl>(IPC.CENTRAL_GET_AVATAR_UPLOAD_URL, contentType);
    },
    listServers(): Promise<Server[]> {
      return ipcInvoke<Server[]>(IPC.CENTRAL_LIST_SERVERS);
    },
    createServer(
      name: string,
      description: string | null,
      visibility: "public" | "private",
    ): Promise<{ id: string; server_secret: string }> {
      return ipcInvoke<{ id: string; server_secret: string }>(IPC.CENTRAL_CREATE_SERVER, {
        name,
        description,
        visibility,
      });
    },
    getServerToken(serverId: string): Promise<{ token: string; expires_at: number }> {
      return ipcInvoke<{ token: string; expires_at: number }>(IPC.CENTRAL_GET_SERVER_TOKEN, serverId);
    },
    deleteServer(serverId: string): Promise<void> {
      return ipcInvoke<void>(IPC.CENTRAL_DELETE_SERVER, serverId);
    },
  },

  serverProvisioning: {
    start(payload: {
      name: string;
      description: string | null;
      visibility: "public" | "private";
      selectedPlugins: string[];
      tunnelMode: "cloudflare" | "demo";
      cloudflare_tunnel_token?: string | undefined;
      cloudflare_public_hostname?: string | undefined;
      channel?: RuntimeUpdateChannel;
    }): Promise<{ sessionId: string }> {
      return ipcInvoke<{ sessionId: string }>(IPC.SERVER_PROVISION_START, payload);
    },
    onProgress(handler: (payload: ProvisionProgressEvent) => void): CleanupFn {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: ProvisionProgressEvent,
      ): void => handler(payload);
      ipcRenderer.on(IPC.SERVER_PROVISION_PROGRESS, listener);
      return () => ipcRenderer.removeListener(IPC.SERVER_PROVISION_PROGRESS, listener);
    },
    onDone(handler: (payload: ProvisionDoneEvent) => void): CleanupFn {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: ProvisionDoneEvent,
      ): void => handler(payload);
      ipcRenderer.on(IPC.SERVER_PROVISION_DONE, listener);
      return () => ipcRenderer.removeListener(IPC.SERVER_PROVISION_DONE, listener);
    },
    onError(
      handler: (payload: { sessionId: string; message: string; errorCode?: string }) => void,
    ): CleanupFn {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: { sessionId: string; message: string; errorCode?: string },
      ): void => handler(payload);
      ipcRenderer.on(IPC.SERVER_PROVISION_ERROR, listener);
      return () => ipcRenderer.removeListener(IPC.SERVER_PROVISION_ERROR, listener);
    },
  },

  cloudflare: {
    getConnectionState(): Promise<CloudflareConnectionState> {
      return ipcInvoke<CloudflareConnectionState>(IPC.CLOUDFLARE_GET_CONNECTION_STATE);
    },
    signOut(): Promise<void> {
      return ipcInvoke<void>(IPC.CLOUDFLARE_SIGN_OUT);
    },
  },

  docker: {
    findDesktop(): Promise<{ found: boolean; path?: string }> {
      return ipcInvoke<{ found: boolean; path?: string }>(IPC.DOCKER_FIND_DESKTOP);
    },
    startDesktop(): Promise<void> {
      return ipcInvoke<void>(IPC.DOCKER_START_DESKTOP);
    },
    waitForRunning(timeoutMs?: number): Promise<boolean> {
      return ipcInvoke<boolean>(IPC.DOCKER_WAIT_FOR_RUNNING, timeoutMs);
    },
  },

  voice: {
    // Persist the voice subdomain on the local server registry and rebuild
    // the runtime container with LIVEKIT_PUBLIC_URL=wss://<hostname>. The
    // promise resolves when the new container is up; the renderer should
    // then re-probe /health/voice (the existing voice-provisioning store
    // does this automatically on WS reconnect).
    setHostname(serverId: string, hostname: string | null): Promise<{ containerId: string }> {
      return ipcInvoke<{ containerId: string }>(IPC.VOICE_SET_HOSTNAME, serverId, hostname);
    },
  },

  proxy: {
    // Register a host-owned reverse-proxy <webview> guest as it attaches, so
    // the main process can pin its navigation to the mount and gate its
    // permission requests. Keyed by session partition; re-registering the
    // same partition updates the pin.
    registerGuest(input: {
      partition: string;
      mountOrigin: string;
      mountPathPrefix: string;
    }): Promise<void> {
      return ipcInvoke<void>(IPC.PROXY_GUEST_REGISTER, input);
    },
  },

  runtimeUpdate: {
    isOrchestrator(): Promise<boolean> {
      return ipcInvoke<boolean>(IPC.RUNTIME_UPDATE_IS_ORCHESTRATOR);
    },
    getPreferences(serverId: string): Promise<RuntimeUpdatePreferences> {
      return ipcInvoke<RuntimeUpdatePreferences>(IPC.RUNTIME_UPDATE_GET_PREFERENCES, serverId);
    },
    setChannel(serverId: string, channel: RuntimeUpdateChannel): Promise<void> {
      return ipcInvoke<void>(IPC.RUNTIME_UPDATE_SET_CHANNEL, serverId, channel);
    },
    setBackupBeforeUpdate(serverId: string, enabled: boolean): Promise<void> {
      return ipcInvoke<void>(IPC.RUNTIME_UPDATE_SET_BACKUP, serverId, enabled);
    },
    checkForUpdate(serverId: string): Promise<RuntimeCheckOutcome> {
      return ipcInvoke<RuntimeCheckOutcome>(IPC.RUNTIME_UPDATE_CHECK, serverId);
    },
    performUpdate(serverId: string): Promise<RuntimeUpdateOutcome> {
      return ipcInvoke<RuntimeUpdateOutcome>(IPC.RUNTIME_UPDATE_PERFORM, serverId);
    },
    confirmRestart(serverId: string): Promise<boolean> {
      return ipcInvoke<boolean>(IPC.RUNTIME_UPDATE_CONFIRM_RESTART, serverId);
    },
  },

  runtimeReleases: {
    resolveLatest(channel: RuntimeUpdateChannel): Promise<string | null> {
      return ipcInvoke<string | null>(IPC.RUNTIME_RELEASES_RESOLVE_LATEST, channel);
    },
  },

  app: {
    // Pulled by the renderer on mount. Main defers the response until the
    // startup sequence (reconcile + restoreServerContainers) finishes so the
    // renderer can't race ahead and see an empty list before the quarantine
    // flag is set. See main.ts startupCompletePromise.
    getStartupNotices(): Promise<StartupNotice[]> {
      return ipcInvoke<StartupNotice[]>(IPC.APP_GET_STARTUP_NOTICES);
    },
    platform: process.platform,
  },

  window: {
    minimize(): Promise<void> {
      return ipcInvoke<void>(IPC.WINDOW_MINIMIZE);
    },
    maximizeToggle(): Promise<void> {
      return ipcInvoke<void>(IPC.WINDOW_MAXIMIZE_TOGGLE);
    },
    close(): Promise<void> {
      return ipcInvoke<void>(IPC.WINDOW_CLOSE);
    },
    quit(): Promise<void> {
      return ipcInvoke<void>(IPC.WINDOW_QUIT_CONFIRMED);
    },
    getMaximized(): Promise<boolean> {
      return ipcInvoke<boolean>(IPC.WINDOW_GET_MAXIMIZED);
    },
    onMaximizeChange(handler: (maximized: boolean) => void): CleanupFn {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: boolean,
      ): void => handler(payload);
      ipcRenderer.on(IPC.WINDOW_MAXIMIZE_STATE, listener);
      return () => ipcRenderer.removeListener(IPC.WINDOW_MAXIMIZE_STATE, listener);
    },
  },

  update: {
    getState(): Promise<UpdateState> {
      return ipcInvoke<UpdateState>(IPC.APP_UPDATE_GET_STATE);
    },
    // Fire-and-forget. Resolves with a snapshot of state (often already the
    // next phase because reducers transition synchronously inside the main
    // handler), but callers should treat `onState` as the source of truth.
    check(): Promise<UpdateState> {
      return ipcInvoke<UpdateState>(IPC.APP_UPDATE_CHECK);
    },
    download(): Promise<UpdateState> {
      return ipcInvoke<UpdateState>(IPC.APP_UPDATE_DOWNLOAD);
    },
    // The process quits before this resolves in the happy path. A resolved
    // `void` only ever happens on a no-op (wrong state / disabled).
    install(): Promise<void> {
      return ipcInvoke<void>(IPC.APP_UPDATE_INSTALL);
    },
    onState(handler: (state: UpdateState) => void): CleanupFn {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: UpdateState,
      ): void => handler(payload);
      ipcRenderer.on(IPC.APP_UPDATE_STATE, listener);
      return () => ipcRenderer.removeListener(IPC.APP_UPDATE_STATE, listener);
    },
  },

  downloads: {
    start(url: string): Promise<void> {
      return ipcInvoke<void>(IPC.DOWNLOADS_START, url);
    },
  },

  screenShare: {
    listSources(): Promise<ScreenShareSource[]> {
      return ipcInvoke<ScreenShareSource[]>(IPC.SCREEN_SHARE_LIST_SOURCES);
    },
    onShowPicker(handler: (req: ScreenShareRequest) => void): CleanupFn {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: ScreenShareRequest,
      ): void => handler(payload);
      ipcRenderer.on(IPC.SCREEN_SHARE_SHOW_PICKER, listener);
      return () => ipcRenderer.removeListener(IPC.SCREEN_SHARE_SHOW_PICKER, listener);
    },
    respondToPicker(
      requestId: string,
      selection: ScreenShareSelection | null,
    ): Promise<void> {
      return ipcInvoke<void>(IPC.SCREEN_SHARE_RESPOND_PICKER, requestId, selection);
    },
    popoutCreate(payload: {
      trackSid: string;
      title: string;
      sourceUrl: string;
    }): Promise<{ windowId: number }> {
      return ipcInvoke<{ windowId: number }>(IPC.SCREEN_SHARE_POPOUT_CREATE, payload);
    },
    popoutClose(trackSid: string): Promise<void> {
      return ipcInvoke<void>(IPC.SCREEN_SHARE_POPOUT_CLOSE, trackSid);
    },
    checkPermission(): Promise<ScreenSharePermissionStatus> {
      return ipcInvoke<ScreenSharePermissionStatus>(IPC.SCREEN_SHARE_CHECK_PERMISSION);
    },
    requestPermission(): Promise<{ status: "ok" | "unsupported" }> {
      return ipcInvoke<{ status: "ok" | "unsupported" }>(IPC.SCREEN_SHARE_REQUEST_PERMISSION);
    },
  },

  webApps: {
    list(serverId: string): Promise<WebApp[]> {
      return ipcInvoke<WebApp[]>(IPC.WEB_APPS_LIST, serverId);
    },
    add(
      serverId: string,
      input: { url: string; title?: string; faviconUrl?: string },
    ): Promise<WebApp> {
      return ipcInvoke<WebApp>(IPC.WEB_APPS_ADD, serverId, input);
    },
    remove(serverId: string, id: string): Promise<void> {
      return ipcInvoke<void>(IPC.WEB_APPS_REMOVE, serverId, id);
    },
    getPref(url: string): Promise<WebAppPref | null> {
      return ipcInvoke<WebAppPref | null>(IPC.WEB_APPS_GET_PREF, url);
    },
    setPref(url: string, action: WebAppPref): Promise<void> {
      return ipcInvoke<void>(IPC.WEB_APPS_SET_PREF, url, action);
    },
  },

  liveSurface: {
    create(url: string): Promise<number> {
      return ipcInvoke<number>(IPC.LIVE_SURFACE_CREATE, url);
    },
    setBounds(
      surfaceId: number,
      bounds: { x: number; y: number; width: number; height: number },
      visible: boolean,
    ): Promise<void> {
      return ipcInvoke<void>(IPC.LIVE_SURFACE_SET_BOUNDS, surfaceId, bounds, visible);
    },
    release(surfaceId: number): Promise<void> {
      return ipcInvoke<void>(IPC.LIVE_SURFACE_RELEASE, surfaceId);
    },
    openWindow(surfaceId: number): Promise<void> {
      return ipcInvoke<void>(IPC.LIVE_SURFACE_OPEN_WINDOW, surfaceId);
    },
    claimDock(surfaceId: number): Promise<boolean> {
      return ipcInvoke<boolean>(IPC.LIVE_SURFACE_CLAIM_DOCK, surfaceId);
    },
    onIntercepted(
      handler: (payload: { surfaceId: number; url: string; webContentsId: number }) => void,
    ): CleanupFn {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: { surfaceId: number; url: string; webContentsId: number },
      ): void => handler(payload);
      ipcRenderer.on(IPC.LIVE_SURFACE_INTERCEPTED, listener);
      return () => ipcRenderer.removeListener(IPC.LIVE_SURFACE_INTERCEPTED, listener);
    },
    onDockRequested(
      handler: (payload: { surfaceId: number; url: string; title: string }) => void,
    ): CleanupFn {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: { surfaceId: number; url: string; title: string },
      ): void => handler(payload);
      ipcRenderer.on(IPC.LIVE_SURFACE_DOCK_REQUESTED, listener);
      return () => ipcRenderer.removeListener(IPC.LIVE_SURFACE_DOCK_REQUESTED, listener);
    },
  },

});
