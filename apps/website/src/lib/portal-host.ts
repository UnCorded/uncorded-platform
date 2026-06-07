// Portal host — the positioning layer for iframes and webviews that outlive
// the panel tree's DOM.
//
// Why this exists:
//   Per WHATWG, moving an <iframe> between DOM parents triggers a navigation
//   reset (reload, lost state, broken WS). The panel tree restructures
//   constantly (splits, resizes, drag rearrange, fullscreen toggle, workspace
//   switch). Hosting surfaces in-tree means every rearrange reloads them.
//   Moving them to a single top-level portal and positioning absolutely via
//   their placeholder's bounding rect keeps the DOM parent constant — no
//   re-parenting, no reload.
//
// Lifecycle policy (hide-by-default):
//   The portal NEVER destroys a mount on its own. unmount(key) decrements
//   refcount and, at zero, hides the element (display:none) and disconnects
//   the ResizeObserver — but the element stays in the portal tree, alive,
//   ready for a future mount(key) to re-adopt it. This means:
//
//     - Fullscreen toggle (focus collapse) keeps non-focused iframes alive
//       so exiting fullscreen doesn't reload every panel.
//     - Workspace switch keeps the prior workspace's iframes alive so
//       returning to it doesn't reload every panel.
//     - Cross-workspace drag preservation falls out of the same path —
//       no separate preservation flag needed.
//
//   The only ways to destroy a mount are explicit:
//     - destroyByKey(key)        — close a single panel
//     - destroyByWorkspace(wsId) — close a workspace, server purge, etc.
//
//   Callers (App.tsx) wire these into user-intent close sites: panel close,
//   workspace close, server purge, server change, surfaceKey overwrite.
//
// Design:
//   - Dumb about content: callers hand in an HTMLElement (iframe, webview).
//     Creation of the element is the caller's responsibility. Destruction of
//     the element happens here, only at destroyByKey/destroyByWorkspace time.
//   - Positioning: every mount is absolutely positioned in the portal root,
//     styled to match its placeholder's getBoundingClientRect.
//   - Rect tracking: rAF-poll loop is the primary mechanism (covers ancestor
//     flex/transform changes that ResizeObserver misses). RO acts as an
//     invalidator — any RO fire restarts the poll loop. Loop settles after
//     2 consecutive frames of identical rects for every tracked mount.
//   - onDestroy callback: callers register cleanup (WS unsubscribe, voice
//     unsubscribe, listener removal) here so it runs once when the iframe is
//     truly torn down — not every time the SolidJS wrapper component
//     unmounts. This is what lets WS messages keep flowing into hidden
//     iframes between focus toggles or workspace switches.

import { isElectron as _isElectron } from "@/lib/electron";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface MountOptions {
  /**
   * Unique within the portal. Callers typically use
   * `${workspaceId}:${leafId}:${surfaceKey}` so that a surfaceKey change
   * within the same leaf produces a new mount (destroy old, create new).
   */
  key: string;
  /** For cross-workspace reconciliation and bulk teardown. */
  workspaceId: string;
  /** The in-tree placeholder div this mount tracks. */
  placeholder: HTMLElement;
  /** The surface element (iframe, webview). Caller owns creation. */
  element: HTMLElement;
  /**
   * Called after the element is inserted into the portal parent and before
   * the first rect-sync. Useful for attaching load listeners that need the
   * element in the live tree. NOT called on adoption — the element is
   * already loaded and live.
   */
  onAttached?: (element: HTMLElement) => void;
  /**
   * Called once when the mount is truly destroyed via destroyByKey or
   * destroyByWorkspace — NOT on unmount(). This is where the caller should
   * unregister WS handlers, voice subscriptions, message listeners, etc.
   * that are tied to the iframe's lifetime, not the SolidJS wrapper's.
   *
   * If a mount is replaced via re-mount with same key (which never happens
   * since hasMount(key) → adoption), this would not fire. Callers should
   * not rely on it firing on overlap — it fires exactly once at real teardown.
   */
  onDestroy?: () => void;
}

interface Mount {
  key: string;
  workspaceId: string;
  placeholder: HTMLElement;
  element: HTMLElement;
  lastRect: Rect | null;
  resizeObserver: ResizeObserver;
  // Refcount: each mount(key) bumps this; each unmount(key) decrements. The
  // element is hidden (display:none) at refcount=0, but the entry stays in
  // the map. Real teardown happens only via destroyByKey/destroyByWorkspace.
  refCount: number;
  /** Lifetime cleanup; runs once on real destroy. */
  onDestroy: (() => void) | null;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let portalRoot: HTMLElement | null = null;
const mounts = new Map<string, Mount>();

let pollActive = false;
let unchangedFrames = 0;
let pollHandle: number | null = null;

const VIEWPORT_RECT: () => Rect = () => ({
  x: 0,
  y: 0,
  w: typeof window === "undefined" ? 0 : window.innerWidth,
  h: typeof window === "undefined" ? 0 : window.innerHeight,
});

// ---------------------------------------------------------------------------
// Portal root registration (singleton invariant)
// ---------------------------------------------------------------------------

/**
 * Called by <PortalContainer /> on mount. The portal contract relies on a
 * single DOM parent so that cross-workspace drag can transfer mounts without
 * re-parenting.
 *
 * In dev (Vite HMR) the root component can remount before the previous
 * PortalContainer's onCleanup runs, so we'd see a transient duplicate. To
 * keep HMR usable we re-seat to the new root and migrate any live mounts
 * over — production still gets a hard warning so a real duplicate-mount bug
 * is loud.
 */
export function registerPortalRoot(el: HTMLElement): void {
  if (portalRoot !== null && portalRoot !== el) {
    const isDev = import.meta.env?.DEV ?? true;
    if (!isDev) {
      console.error(
        "[portal-host] A second PortalContainer was mounted. The portal " +
        "contract requires a single root. Check App.tsx for duplicate mounts.",
      );
    }
    // Migrate live mount elements to the new root so they survive HMR. Their
    // absolute positions are viewport-anchored, so the move is a no-op for
    // the user. Done unconditionally (not dev-only) so that even the
    // production warning path keeps the UI alive instead of leaving iframes
    // stranded under a detached parent.
    for (const entry of mounts.values()) {
      if (entry.element.parentElement !== el) {
        el.appendChild(entry.element);
      }
    }
  }
  portalRoot = el;
}

export function unregisterPortalRoot(el: HTMLElement): void {
  if (portalRoot === el) portalRoot = null;
}

// ---------------------------------------------------------------------------
// Mount / unmount
// ---------------------------------------------------------------------------

export function mount(opts: MountOptions): void {
  if (portalRoot === null) {
    throw new Error("[portal-host] mount() called before PortalContainer registered");
  }
  const existing = mounts.get(opts.key);
  if (existing !== undefined) {
    // Adopt: overlapping mounts for the same surfaceKey are expected during
    // panel rearrange, fullscreen toggle, and workspace switch. Bump refcount,
    // repoint to the new placeholder, restore visibility, and leave the
    // existing element in place. The caller's onAttached is skipped — the
    // element is already live and loaded. The caller's onDestroy is also
    // skipped — the original entry's onDestroy is still valid since the
    // iframe (and its subscriptions) is the same.
    existing.refCount++;
    if (existing.element.style.display === "none") existing.element.style.display = "";
    existing.workspaceId = opts.workspaceId;
    if (existing.placeholder !== opts.placeholder) {
      existing.resizeObserver.disconnect();
      existing.placeholder = opts.placeholder;
      existing.resizeObserver = new ResizeObserver(() => startRectPoll());
      existing.resizeObserver.observe(opts.placeholder);
    } else {
      // RO was disconnected during the hide path; re-observe so future
      // resizes invalidate the poll loop again.
      existing.resizeObserver.disconnect();
      existing.resizeObserver = new ResizeObserver(() => startRectPoll());
      existing.resizeObserver.observe(opts.placeholder);
    }
    syncRect(existing);
    startRectPoll();
    return;
  }

  const el = opts.element;
  // Baseline styling for absolute positioning over the placeholder.
  el.style.position = "absolute";
  el.style.margin = "0";
  el.style.border = "0";
  el.style.pointerEvents = "auto";

  const ro = new ResizeObserver(() => startRectPoll());
  ro.observe(opts.placeholder);

  const entry: Mount = {
    key: opts.key,
    workspaceId: opts.workspaceId,
    placeholder: opts.placeholder,
    element: el,
    lastRect: null,
    resizeObserver: ro,
    refCount: 1,
    onDestroy: opts.onDestroy ?? null,
  };
  mounts.set(opts.key, entry);

  portalRoot.appendChild(el);
  opts.onAttached?.(el);

  // Sync immediately so the element doesn't flash at (0, 0) for a frame.
  syncRect(entry);
  startRectPoll();
}

/**
 * Decrement the refcount. At zero, hide the element (display:none) and
 * disconnect the ResizeObserver — but DO NOT remove from the map or call
 * onDestroy. The element stays alive in the portal so a future mount(key)
 * can adopt it.
 *
 * Call destroyByKey or destroyByWorkspace to actually tear down a mount.
 */
export function unmount(key: string): void {
  const entry = mounts.get(key);
  if (!entry) return;
  entry.refCount--;
  if (entry.refCount > 0) return;
  // Hide path: placeholder is going away (component unmounted), but we keep
  // the element alive for adoption later. Disconnect the RO since its
  // observed node is about to detach; mount() reconnects it on adoption.
  entry.resizeObserver.disconnect();
  entry.element.style.display = "none";
}

/**
 * Destroy a mount: detach the element from the portal, run its onDestroy
 * cleanup, and remove the map entry. No-op if the key isn't registered.
 *
 * This is the only path that actually frees a mount — unmount() merely
 * hides. Call this at user-intent close points: panel close, workspace
 * close, server purge, surfaceKey overwrite.
 */
export function destroyByKey(key: string): void {
  const entry = mounts.get(key);
  if (entry === undefined) return;
  teardown(entry);
}

/**
 * Destroy every mount whose workspaceId matches. Used by closeWorkspace,
 * onServerPurged (per-server), and the activeServerId change effect.
 */
export function destroyByWorkspace(workspaceId: string): void {
  // Snapshot before iteration: teardown() mutates `mounts` via mounts.delete.
  // eslint-disable-next-line unicorn/no-useless-spread
  for (const entry of [...mounts.values()]) {
    if (entry.workspaceId === workspaceId) teardown(entry);
  }
}

/**
 * Destroy every mount, period. Used at server change to tear down all
 * iframes from the previous server.
 */
export function destroyAll(): void {
  // eslint-disable-next-line unicorn/no-useless-spread
  for (const entry of [...mounts.values()]) teardown(entry);
}

function teardown(entry: Mount): void {
  entry.resizeObserver.disconnect();
  if (entry.element.parentElement === portalRoot && portalRoot !== null) {
    portalRoot.removeChild(entry.element);
  }
  if (entry.onDestroy !== null) {
    try {
      entry.onDestroy();
    } catch (err) {
      console.error("[portal-host] onDestroy threw for key", entry.key, err);
    }
  }
  mounts.delete(entry.key);
}

/**
 * Reindex a live mount under a new key. The DOM element, element styles, and
 * placeholder binding are unchanged — only the map entry moves. Used by
 * cross-workspace drag commit: the source mount was keyed
 * `${sourceWorkspace}:${sourceLeaf}:${surfaceKey}`, and the destination leaf
 * will try to mount `${destWorkspace}:${newLeaf}:${surfaceKey}`. Calling
 * rekey() synchronously just before the store update routes the destination
 * mount() into the adopt path.
 *
 * No-ops if oldKey doesn't exist or equals newKey. Throws if newKey already
 * exists (caller bug — would orphan the old entry under newKey).
 */
export function rekey(oldKey: string, newKey: string): void {
  if (oldKey === newKey) return;
  const entry = mounts.get(oldKey);
  if (!entry) return;
  if (mounts.has(newKey)) {
    throw new Error(`[portal-host] rekey collision: newKey '${newKey}' already mounted`);
  }
  mounts.delete(oldKey);
  entry.key = newKey;
  mounts.set(newKey, entry);
}

// Force a rect re-sync. Used when a placeholder transitions from no-box
// (display:none ancestor) to has-box — ResizeObserver doesn't always fire
// reliably across that transition, which leaves the portaled element stuck
// at visibility:hidden even though its placeholder now has a real rect.
// Callers (e.g. tab-switch) invoke this to guarantee the next frame syncs.
//
// With a key: sync that one mount immediately, then start the poll.
// Without a key: just start the poll, which sweeps every mount on the next
// rAF tick.
export function requestSync(key?: string): void {
  if (key !== undefined) {
    const entry = mounts.get(key);
    if (entry) syncRect(entry);
  }
  startRectPoll();
}

/** Swap the placeholder a mount tracks — used when a leaf's DOM is recreated but the mount should persist. */
export function updatePlaceholder(key: string, placeholder: HTMLElement): void {
  const entry = mounts.get(key);
  if (!entry) return;
  entry.resizeObserver.disconnect();
  entry.placeholder = placeholder;
  entry.resizeObserver = new ResizeObserver(() => startRectPoll());
  entry.resizeObserver.observe(placeholder);
  syncRect(entry);
  startRectPoll();
}

// ---------------------------------------------------------------------------
// Lookup (for reconciliation in sync-diff)
// ---------------------------------------------------------------------------

export function hasMount(key: string): boolean {
  return mounts.has(key);
}

export function getMountElement(key: string): HTMLElement | null {
  return mounts.get(key)?.element ?? null;
}

/** All mount keys currently live in the portal, for audits and debugging. */
export function liveMountKeys(): string[] {
  return Array.from(mounts.keys());
}

export function getMountRect(key: string): Rect | null {
  const entry = mounts.get(key);
  if (!entry || entry.refCount === 0) return null;
  return computeRect(entry);
}

// ---------------------------------------------------------------------------
// Rect-sync internals
// ---------------------------------------------------------------------------

function computeRect(entry: Mount): Rect {
  const rect = entry.placeholder.getBoundingClientRect();
  return { x: rect.left, y: rect.top, w: rect.width, h: rect.height };
}

function rectsEqual(a: Rect | null, b: Rect): boolean {
  if (a === null) return false;
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

function syncRect(entry: Mount): boolean {
  // Hidden entries (refCount=0, display:none) don't need rect work — their
  // placeholder is detached from the live DOM, getBoundingClientRect returns
  // zeros, and styling them is wasted work. Skip until they're re-adopted.
  if (entry.refCount === 0) return false;
  const rect = computeRect(entry);
  if (rectsEqual(entry.lastRect, rect)) return false;
  const s = entry.element.style;
  s.left = `${rect.x}px`;
  s.top = `${rect.y}px`;
  s.width = `${rect.w}px`;
  s.height = `${rect.h}px`;
  // If the placeholder hasn't been laid out yet (w=0, h=0), hide so we don't
  // flash a stray 0×0 element.
  s.visibility = rect.w === 0 || rect.h === 0 ? "hidden" : "visible";
  entry.lastRect = rect;
  return true;
}

function syncAll(): boolean {
  let changed = false;
  for (const entry of mounts.values()) {
    if (syncRect(entry)) changed = true;
  }
  return changed;
}

function startRectPoll(): void {
  if (pollActive) return;
  pollActive = true;
  unchangedFrames = 0;
  if (typeof requestAnimationFrame === "undefined") return;
  pollHandle = requestAnimationFrame(pollTick);
}

function pollTick(): void {
  pollHandle = null;
  const changed = syncAll();
  if (changed) {
    unchangedFrames = 0;
  } else {
    unchangedFrames++;
  }
  // Settle condition: 2 unchanged frames in a row. RO + window listeners
  // restart the loop on real layout changes.
  if (unchangedFrames < 2) {
    pollHandle = requestAnimationFrame(pollTick);
  } else {
    pollActive = false;
  }
}

// ---------------------------------------------------------------------------
// Global invalidators
// ---------------------------------------------------------------------------

if (typeof window !== "undefined") {
  // Window resize triggers placeholder rect changes but not always RO (if the
  // placeholder's size didn't change, just its position). Poll unconditionally.
  window.addEventListener("resize", () => startRectPoll());
  // Scroll can shift placeholder rects (iframes don't scroll with the page).
  window.addEventListener("scroll", () => startRectPoll(), { passive: true, capture: true });
}

// ---------------------------------------------------------------------------
// Test-only reset (internal)
// ---------------------------------------------------------------------------

/** @internal — for tests to reset module state between cases. */
export function _resetForTests(): void {
  if (pollHandle !== null && typeof cancelAnimationFrame !== "undefined") {
    cancelAnimationFrame(pollHandle);
  }
  pollHandle = null;
  pollActive = false;
  unchangedFrames = 0;
  for (const entry of mounts.values()) {
    entry.resizeObserver.disconnect();
    if (entry.element.parentElement === portalRoot && portalRoot !== null) {
      portalRoot.removeChild(entry.element);
    }
  }
  mounts.clear();
  portalRoot = null;
}

// Keep isElectron export consumable for portal-host callers (barrel pattern).
export const isElectron = _isElectron;
export { VIEWPORT_RECT as _viewportRect };
