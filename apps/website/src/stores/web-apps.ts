import { batch, createSignal } from "solid-js";
import type { WebApp, WebAppPref } from "@uncorded/electron-bridge";
import { isElectron, getElectron } from "@/lib/electron";
import { registerLiveSurface } from "@/lib/live-surfaces";
import { showToast } from "@/lib/feedback";
import { activeServerId } from "./servers";

// Renderer-side cache + actions for desktop-owned, PER-SERVER Web Apps.
// The desktop main process is the source of truth (~/.uncorded/web-apps.json);
// this store mirrors it so the sidebar can render synchronously and the browser
// panel's dock overlay can mutate optimistically. Electron-only — every entry
// point early-returns under a plain web/mobile build (no window.electron).
//
// Keyed by serverId because the list is per-server (memory:
// desktop-owned-web-apps-sidebar). The single main window is the only writer,
// so there's no cross-window broadcast to reconcile — local mutations after a
// successful bridge call are authoritative until the next loadWebApps().

const [byServer, setByServer] = createSignal<Record<string, WebApp[]>>({});

/** Reactive accessor: the web apps known for a server (empty until loaded). */
export function webAppsFor(serverId: string): WebApp[] {
  return byServer()[serverId] ?? [];
}

/** Fetch (or refetch) a server's web apps from the desktop store. No-op on web. */
export async function loadWebApps(serverId: string): Promise<void> {
  if (!isElectron()) return;
  try {
    const list = await getElectron().webApps.list(serverId);
    setByServer((m) => ({ ...m, [serverId]: list }));
  } catch (err) {
    console.error("[web-apps] list failed", { serverId, err });
  }
}

/**
 * Persist a web app for `serverId` and reflect it in the cache. Idempotent on
 * the main side (adding an existing URL returns the existing entry), so the
 * cache merge de-dupes by id. Returns the stored entry, or null on failure.
 */
export async function addWebApp(
  serverId: string,
  input: { url: string; title?: string; faviconUrl?: string },
): Promise<WebApp | null> {
  if (!isElectron()) return null;
  try {
    const entry = await getElectron().webApps.add(serverId, input);
    setByServer((m) => {
      const cur = m[serverId] ?? [];
      if (cur.some((w) => w.id === entry.id)) return m;
      return { ...m, [serverId]: [...cur, entry] };
    });
    return entry;
  } catch (err) {
    console.error("[web-apps] add failed", { serverId, err });
    return null;
  }
}

/** Remove a web app and drop it from the cache. No-op on web. */
export async function removeWebApp(serverId: string, id: string): Promise<void> {
  if (!isElectron()) return;
  try {
    await getElectron().webApps.remove(serverId, id);
    setByServer((m) => ({
      ...m,
      [serverId]: (m[serverId] ?? []).filter((w) => w.id !== id),
    }));
  } catch (err) {
    console.error("[web-apps] remove failed", { serverId, id, err });
  }
}

/** Open `url` in a native, login-sticky pop-out window. No-op on web. */
export async function popOutWebApp(url: string): Promise<void> {
  if (!isElectron()) return;
  try {
    await getElectron().webApps.popOut(url);
  } catch (err) {
    console.error("[web-apps] popOut failed", { url, err });
  }
}

/**
 * The dock overlay's saved per-URL choice (keyed by exact URL). Returns null on
 * web or when the user hasn't saved a preference for this URL yet.
 */
export async function getWebAppPref(url: string): Promise<WebAppPref | null> {
  if (!isElectron()) return null;
  try {
    return await getElectron().webApps.getPref(url);
  } catch (err) {
    console.error("[web-apps] getPref failed", { url, err });
    return null;
  }
}

/** Persist the dock overlay's "save preference for this URL" choice. No-op on web. */
export async function setWebAppPref(url: string, action: WebAppPref): Promise<void> {
  if (!isElectron()) return;
  try {
    await getElectron().webApps.setPref(url, action);
  } catch (err) {
    console.error("[web-apps] setPref failed", { url, action, err });
  }
}

/**
 * Subscribe to a Browser Panel guest's intercepted `window.open`. Main has
 * already captured it into a native `WebContentsView` (preserving the popup's
 * live session — cookies + sessionStorage + opener) parked hidden, and pushes
 * this event. The payload carries the `surfaceId` (keys all later
 * setBounds/release/popOut), the `url`, and the `webContentsId` of the owning
 * <webview> guest (to route the floating frame onto the panel that triggered
 * it). Returns an unsubscribe fn; a no-op on web.
 */
export function onNativeSurfaceIntercepted(
  cb: (payload: { surfaceId: number; url: string; webContentsId: number }) => void,
): () => void {
  if (!isElectron()) return () => {};
  return getElectron().nativeSurface.onIntercepted(cb);
}

/**
 * Create a fresh live native view loading `url` and return its surfaceId, or null
 * on web / failure. Drives a Web App panel's always-live mount: the panel binds
 * the returned surfaceId to its instanceId (registerLiveSurface) and renders the
 * live view. Cookies/localStorage carry over via persist:browser; no in-memory
 * session is preserved (fresh load).
 */
export async function nativeSurfaceCreate(url: string): Promise<number | null> {
  if (!isElectron()) return null;
  try {
    return await getElectron().nativeSurface.create(url);
  } catch (err) {
    console.error("[web-apps] nativeSurface.create failed", { url, err });
    return null;
  }
}

/**
 * Destroy a native view and its webContents. Called when the floating frame is
 * dismissed, or when a docked Web App panel hosting the live view closes. After
 * release the same URL falls back to a fresh <webview> (cookie-logged-in).
 * No-op on web.
 */
export async function nativeSurfaceRelease(surfaceId: number): Promise<void> {
  if (!isElectron()) return;
  try {
    await getElectron().nativeSurface.release(surfaceId);
  } catch (err) {
    console.error("[web-apps] nativeSurface.release failed", { surfaceId, err });
  }
}

/**
 * Open the native view in its own free, frameless OS window that owns the live
 * view directly (header + content glued, movable anywhere off-app). The live
 * session is preserved — no reload. Where it docks is resolved at dock time
 * (whatever server is active then), so no target is passed. No-op on web.
 */
export async function nativeSurfaceOpenWindow(surfaceId: number): Promise<void> {
  if (!isElectron()) return;
  try {
    await getElectron().nativeSurface.openWindow(surfaceId);
  } catch (err) {
    console.error("[web-apps] nativeSurface.openWindow failed", { surfaceId, err });
  }
}

/**
 * Step 2 of the dock handshake: claim the view for docking. Main re-parents it
 * into the main window (parked hidden) and closes its popout if it had one.
 * Returns whether the view is parked and ready to be tracked — on false the
 * caller must NOT open a panel (the popout stays open, the user loses nothing).
 */
async function nativeSurfaceClaimDock(surfaceId: number): Promise<boolean> {
  if (!isElectron()) return false;
  try {
    return await getElectron().nativeSurface.claimDock(surfaceId);
  } catch (err) {
    console.error("[web-apps] nativeSurface.claimDock failed", { surfaceId, err });
    return false;
  }
}

/**
 * Step 1 of the dock handshake: the user clicked "Dock" in a popout window. The
 * popout is still open and still owns the view — the subscriber (App) verifies
 * it can host a panel and commits via dockLiveSurface. Returns an unsubscribe
 * fn; a no-op on web. Survives the originating browser panel closing (App wires
 * this at the top level, not per-panel).
 */
export function onNativeSurfaceDockRequested(
  cb: (payload: { surfaceId: number; url: string; title: string }) => void,
): () => void {
  if (!isElectron()) return () => {};
  return getElectron().nativeSurface.onDockRequested(cb);
}

/**
 * Dock a live native view into the CURRENT workspace as a panel: claim the view
 * from main (re-parent + close its popout), bind the live `surfaceId` to a fresh
 * per-panel instanceId, and request the panel be opened. Pure layout act — no
 * bookmark is created (dock ≠ save; "Save as Web App" stays explicit). Shared by
 * the "panel" pref auto-dock and the popout window's "Dock" button. Fail-closed:
 * with no active server (the workspace can't host panels) we toast and stop
 * BEFORE claiming, so the popout stays open and the user loses nothing.
 */
export async function dockLiveSurface(
  surfaceId: number,
  url: string,
  title = "",
): Promise<void> {
  if (!isElectron()) return;
  if (!activeServerId()) {
    showToast("Open a server to dock this window", "info");
    return;
  }
  // Claim BEFORE opening the panel: after a successful claim the view is parked
  // hidden in the main window and nothing else owns it, so no stale popout-side
  // geometry can race the panel's first setBounds. On false the view is gone or
  // unclaimable — opening a panel would mount blank, so we stop (the popout, if
  // any, is untouched).
  if (!(await nativeSurfaceClaimDock(surfaceId))) return;
  // Mint a FRESH per-panel instanceId and bind the incoming live surface to it.
  // The panel opened below carries this same instanceId, so its always-live path
  // adopts THIS surface instead of creating a second one.
  //
  // batch() is load-bearing: registering the live surface and opening the panel
  // MUST commit together. Without it, the registerLiveSurface write flushes the
  // App-level release-reconciliation effect synchronously BEFORE the panel
  // exists, so the effect sees a registered surface with no panel referencing it,
  // treats it as orphaned, and releases the freshly-docked live view — the panel
  // then mounts blank. Batching defers that effect until after the panel content
  // is in place, so it correctly sees the surface as live and in-use.
  const instanceId = crypto.randomUUID();
  batch(() => {
    registerLiveSurface(instanceId, surfaceId);
    emitOpenWebAppAsPanel({ url, title }, instanceId);
  });
}

// Pub/sub so the post-hoc dock prompt (rendered deep inside the browser panel)
// can ask App-level layout to open a docked panel, without drilling a callback
// through the whole panel tree. Mirrors lib/plugin-panel-events. The payload is
// just {url, title} — NOT a WebApp — because docking doesn't bookmark; a saved
// WebApp passes structurally when the sidebar opens one. The instanceId is
// minted by the caller (dockLiveSurface) so the live surface binding and the
// opened panel's content agree on the same per-panel identity.
type OpenAsPanelHandler = (app: { url: string; title: string }, instanceId: string) => void;
const openAsPanelHandlers = new Set<OpenAsPanelHandler>();

/** Subscribe to "dock this page as a panel" requests (App wires this to its layout). */
export function onOpenWebAppAsPanel(fn: OpenAsPanelHandler): () => void {
  openAsPanelHandlers.add(fn);
  return () => {
    openAsPanelHandlers.delete(fn);
  };
}

/** Request that a page be opened as a docked panel under a given instanceId. */
export function emitOpenWebAppAsPanel(
  app: { url: string; title: string },
  instanceId: string,
): void {
  for (const handler of [...openAsPanelHandlers]) handler(app, instanceId);
}
