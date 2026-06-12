import { contextBridge, ipcRenderer } from "electron";

// Dedicated preload for the live-surface POPOUT window's chrome page (the
// thin draggable header strip rendered by buildPopoutChromeHtml in main.ts).
// That window hosts a live WebContentsView as a child below the header; this
// preload gives the header's buttons a minimal, fire-and-forget bridge back to
// main. No surfaceId is passed — main resolves the surface from `event.sender`
// (this window's webContents), so the page can't address another popout.
//
// Spelled-out literals (not imported from ./ipc): sandboxed preloads can't
// require() a sibling module at runtime under the plain-tsc desktop build.
const CH = {
  WINDOW_DOCK: "desktop:live-surface:window-dock",
  WINDOW_CLOSE: "desktop:live-surface:window-close",
  WINDOW_OPEN_EXTERNAL: "desktop:live-surface:window-open-external",
} as const;

contextBridge.exposeInMainWorld("popoutChrome", {
  /** Re-anchor this window's live view into the main app as a workspace panel. */
  dock(): void {
    ipcRenderer.send(CH.WINDOW_DOCK);
  },
  /** Open the live view's current URL in the user's default system browser. */
  openExternal(): void {
    ipcRenderer.send(CH.WINDOW_OPEN_EXTERNAL);
  },
  /** Close this popout window and destroy its live view. */
  close(): void {
    ipcRenderer.send(CH.WINDOW_CLOSE);
  },
});
