// Test preload — registered via the root bunfig.toml `[test] preload`.
//
// The desktop package imports `electron` (and `electron-updater`) at module
// scope in several files (central.ts → app, auto-update.ts → ipcMain,
// electron-main-deps.ts → app/safeStorage, preload.ts → contextBridge/
// ipcRenderer, …). Bun's test runner cannot load the real Electron runtime:
// electron's npm `index.js` only exports a path string, so any
// `import { app } from "electron"` fails to link with
// "export 'app' not found in 'electron'".
//
// Previously each desktop test stubbed electron in its own beforeAll, relying
// on Bun's process-global mock.module leaking the stub to sibling files. That
// is order-dependent: whichever electron-touching test file Bun links FIRST
// (cloudflared-cli.test.ts on the CI runner's directory walk) links real
// electron before any beforeAll runs, and narrow per-file stubs
// (`{ app: { isPackaged: false } }`) starved siblings that needed ipcMain /
// safeStorage. That passed on Windows/WSL (favourable walk order) but failed
// on ubuntu-latest. Registering the full surface here — before ANY test file
// is linked — makes electron resolve deterministically on every platform.
//
// This file is the single source of truth for the electron stub; desktop test
// files no longer mock electron themselves. Mocking these modules globally is
// harmless for non-desktop suites, which never import them.
import { mock } from "bun:test";

await mock.module("electron", () => ({
  app: {
    isPackaged: false,
    getVersion: () => "0.0.0",
    getAppPath: () => "",
    getPath: () => "",
    setAppUserModelId: () => {},
    commandLine: { appendSwitch: () => {} },
    requestSingleInstanceLock: () => true,
    on: () => {},
    quit: () => {},
    isReady: () => false,
    exit: () => {},
    whenReady: async () => {},
  },
  ipcMain: { handle: () => {}, on: () => {} },
  BrowserWindow: class {},
  dialog: { showErrorBox: () => {} },
  session: { defaultSession: {} },
  shell: { openExternal: async () => {} },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
  contextBridge: { exposeInMainWorld: () => {} },
  ipcRenderer: {
    invoke: async () => undefined,
    on: () => {},
    removeListener: () => {},
  },
}));

await mock.module("electron-updater", () => ({
  autoUpdater: {
    on: () => {},
    removeAllListeners: () => {},
    checkForUpdates: async () => undefined,
    downloadUpdate: async () => undefined,
    quitAndInstall: () => {},
  },
}));
