import type { IpcChannelMap } from "@uncorded/electron-bridge";

// Channel-name strings shared with the preload via the `IpcChannelMap`
// contract. `satisfies` pins every value to that single source of truth, so a
// typo or a name that drifts from preload.ts fails `tsc` instead of silently
// wiring a handler no caller can reach. `import type` is erased at compile
// time, so this module stays a pure, dependency-free constants module.
export const IPC = {
  // Central
  CENTRAL_REGISTER: "central:register",
  CENTRAL_OAUTH_START: "central:oauth-start",
  CENTRAL_LOGIN: "central:login",
  CENTRAL_LOGOUT: "central:logout",
  CENTRAL_GET_PROFILE: "central:get-profile",
  CENTRAL_PATCH_PROFILE: "central:patch-profile",
  CENTRAL_GET_AVATAR_UPLOAD_URL: "central:get-avatar-upload-url",
  CENTRAL_REQUEST: "central:request",
  CENTRAL_LIST_SERVERS: "central:list-servers",
  CENTRAL_LIST_PUBLIC_SERVERS: "central:list-public-servers",
  CENTRAL_CREATE_SERVER: "central:create-server",
  CENTRAL_GET_SERVER_TOKEN: "central:get-server-token",
  CENTRAL_DELETE_SERVER: "central:delete-server",

  // Server provisioning
  SERVER_PROVISION_START: "server:provision:start",
  SERVER_PROVISION_PROGRESS: "server:provision:progress",
  SERVER_PROVISION_DONE: "server:provision:done",
  SERVER_PROVISION_ERROR: "server:provision:error",

  // Docker Desktop boot helpers — used by the create-server wizard's
  // failure card to offer a one-click "Start Docker Desktop" recovery
  // when the pre-flight check sees `docker info` failing.
  DOCKER_FIND_DESKTOP: "docker:find-desktop",
  DOCKER_START_DESKTOP: "docker:start-desktop",
  DOCKER_WAIT_FOR_RUNNING: "docker:wait-for-running",

  // Cloudflare
  CLOUDFLARE_GET_CONNECTION_STATE: "cloudflare:get-connection-state",
  CLOUDFLARE_SIGN_OUT: "cloudflare:sign-out",

  // Voice setup — owner-only flow that wires LIVEKIT_PUBLIC_URL on the
  // runtime container and rebuilds it so /health/voice flips to "ready".
  VOICE_SET_HOSTNAME: "voice:set-hostname",

  // Runtime container update orchestration (Phase 01 §8). Per D3/O8 the
  // desktop is the only first-class orchestrator in v1; per D4 the install
  // action is gated by `core.runtime.update`. Renderer dispatches every
  // update gesture through these channels — the runtime itself is a passive
  // store + broadcaster (decisions.md O8).
  RUNTIME_UPDATE_IS_ORCHESTRATOR: "runtime-update:is-orchestrator",
  RUNTIME_UPDATE_GET_PREFERENCES: "runtime-update:get-preferences",
  RUNTIME_UPDATE_SET_CHANNEL: "runtime-update:set-channel",
  RUNTIME_UPDATE_SET_BACKUP: "runtime-update:set-backup",
  RUNTIME_UPDATE_CHECK: "runtime-update:check",
  RUNTIME_UPDATE_PERFORM: "runtime-update:perform",
  // User clicked "Restart to apply update". Resolves the orchestrator's
  // pending Deferred so performUpdate progresses past the awaiting-restart
  // gate into the install phase. No-op if no update is sitting at the gate.
  RUNTIME_UPDATE_CONFIRM_RESTART: "runtime-update:confirm-restart",

  // Runtime release lookup — used by the create-server wizard so the user
  // sees which version each channel will install before submitting. Same
  // GitHub-Releases scan resolveLatestVersion does internally; surfaced via
  // IPC because the renderer can't call into runtime-releases.ts directly.
  RUNTIME_RELEASES_RESOLVE_LATEST: "runtime-releases:resolve-latest",

  // App lifecycle
  APP_UPDATE_GET_STATE: "app:update:get-state",
  APP_UPDATE_CHECK: "app:update:check",
  APP_UPDATE_DOWNLOAD: "app:update:download",
  APP_UPDATE_INSTALL: "app:update:install",
  APP_UPDATE_STATE: "app:update:state",
  APP_GET_STARTUP_NOTICES: "app:get-startup-notices",

  // Custom titlebar window controls — main owns BrowserWindow.minimize/
  // maximize/close, renderer paints the chrome. WINDOW_CLOSE follows the
  // existing close handler (hide-to-tray); WINDOW_QUIT_CONFIRMED bypasses
  // that to fully quit (used by the close-button-hold confirm modal). The
  // renderer subscribes to WINDOW_MAXIMIZE_STATE so the maximize button can
  // swap to a "restore" glyph while the window is maximized.
  WINDOW_MINIMIZE: "window:minimize",
  WINDOW_MAXIMIZE_TOGGLE: "window:maximize-toggle",
  WINDOW_CLOSE: "window:close",
  WINDOW_QUIT_CONFIRMED: "window:quit-confirmed",
  WINDOW_GET_MAXIMIZED: "window:get-maximized",
  WINDOW_MAXIMIZE_STATE: "window:maximize-state",

  // Screen sharing — custom picker + popout. The renderer drives the picker
  // UI; main owns desktopCapturer (Node-only) and the popout BrowserWindow.
  // Self-mirror filter: every UnCorded window is tagged with
  // `webContents.uncordedWindow = true` at creation; the picker filters
  // results against the live tagged set so the main window, popouts, and
  // any future tagged window can never re-enter as a source.
  SCREEN_SHARE_LIST_SOURCES: "desktop:screen-share:list-sources",
  SCREEN_SHARE_SHOW_PICKER: "desktop:screen-share:show-picker",
  SCREEN_SHARE_RESPOND_PICKER: "desktop:screen-share:respond-picker",
  SCREEN_SHARE_POPOUT_CREATE: "desktop:screen-share:popout-create",
  SCREEN_SHARE_POPOUT_CLOSE: "desktop:screen-share:popout-close",
  SCREEN_SHARE_CHECK_PERMISSION: "desktop:screen-share:check-permission",
  SCREEN_SHARE_REQUEST_PERMISSION: "desktop:screen-share:request-permission",

  // Plugin file downloads — main calls webContents.downloadURL() directly
  // so the Linux popup-intercept failure mode is bypassed entirely.
  DOWNLOADS_START: "desktop:downloads:start",

  // Reverse-proxy <webview> guest registration — the renderer registers each
  // host-owned proxy surface as its webview attaches so main can pin the
  // guest's navigation to its mount and gate its permission requests.
  PROXY_GUEST_REGISTER: "proxy:guest-register",

  // Desktop-owned per-server Web Apps — promoted browser-pane URLs persisted
  // locally (~/.uncorded/web-apps.json). list/add/remove take a serverId
  // (renderer owns server scope; main stays server-agnostic). POP_OUT opens a
  // native same-session window; GET_PREF/SET_PREF persist the dock overlay's
  // per-URL "don't ask again" choice.
  WEB_APPS_LIST: "desktop:web-apps:list",
  WEB_APPS_ADD: "desktop:web-apps:add",
  WEB_APPS_REMOVE: "desktop:web-apps:remove",
  WEB_APPS_GET_PREF: "desktop:web-apps:get-pref",
  WEB_APPS_SET_PREF: "desktop:web-apps:set-pref",

  // Plugin Development Workspace — desktop-owned, machine-global plugin dev
  // folders (~/.uncorded/plugin-dev/<slug>/) that survive server deletion.
  // CREATE scaffolds + copies the agent prompt to the clipboard; LAUNCH_AGENT
  // opens a terminal running the claude CLI in the plugin folder;
  // INSTALL_INTO_SERVER is the deploy seam (NOT_IMPLEMENTED until the deploy
  // phase lands).
  PLUGIN_DEV_LIST: "desktop:plugin-dev:list",
  PLUGIN_DEV_CREATE: "desktop:plugin-dev:create",
  PLUGIN_DEV_DELETE: "desktop:plugin-dev:delete",
  PLUGIN_DEV_OPEN_FOLDER: "desktop:plugin-dev:open-folder",
  PLUGIN_DEV_COPY_PROMPT: "desktop:plugin-dev:copy-prompt",
  PLUGIN_DEV_DETECT_AGENT: "desktop:plugin-dev:detect-agent",
  PLUGIN_DEV_LAUNCH_AGENT: "desktop:plugin-dev:launch-agent",
  PLUGIN_DEV_INSTALL_INTO_SERVER: "desktop:plugin-dev:install-into-server",
  PLUGIN_DEV_LIST_TARGETS: "desktop:plugin-dev:list-targets",
  PLUGIN_DEV_UNDEPLOY: "desktop:plugin-dev:undeploy",
  PLUGIN_DEV_DEPLOY_PROGRESS: "desktop:plugin-dev:deploy-progress",

  // In-app native popup views (WebContentsView). INTERCEPTED is a main→renderer
  // push: main captured a Browser Panel guest's window.open into a native view
  // (preserving its live session) and routes it to the owning panel by
  // webContentsId. SET_BOUNDS positions/hides the view over a renderer-reported
  // rect while DOCKED; RELEASE destroys it. OPEN_WINDOW hosts the view in a free
  // frameless OS popout window; DOCK_REQUESTED is the main→renderer push when the
  // user clicks the popout's "Dock" (popout stays open) and CLAIM_DOCK is the
  // renderer's commit (main re-parents the view, then closes the popout).
  // WINDOW_DOCK/CLOSE/OPEN_EXTERNAL are sent by the popout window's own chrome
  // (popout-preload) back to main.
  LIVE_SURFACE_INTERCEPTED: "desktop:live-surface:intercepted",
  LIVE_SURFACE_CREATE: "desktop:live-surface:create",
  LIVE_SURFACE_SET_BOUNDS: "desktop:live-surface:set-bounds",
  LIVE_SURFACE_RELEASE: "desktop:live-surface:release",
  LIVE_SURFACE_OPEN_WINDOW: "desktop:live-surface:open-window",
  LIVE_SURFACE_CLAIM_DOCK: "desktop:live-surface:claim-dock",
  LIVE_SURFACE_DOCK_REQUESTED: "desktop:live-surface:dock-requested",
  LIVE_SURFACE_TITLE_CHANGED: "desktop:live-surface:title-changed",
  LIVE_SURFACE_WINDOW_DOCK: "desktop:live-surface:window-dock",
  LIVE_SURFACE_WINDOW_CLOSE: "desktop:live-surface:window-close",
  LIVE_SURFACE_WINDOW_OPEN_EXTERNAL: "desktop:live-surface:window-open-external",
} as const satisfies IpcChannelMap;
