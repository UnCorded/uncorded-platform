// Native-surface host — the positioning layer for Electron WebContentsViews
// that live ABOVE the renderer DOM.
//
// Why this exists (and why it can't reuse portal-host):
//   portal-host positions DOM elements (iframes, webviews) by writing their
//   `style.left/top/width/height` so they sit over an in-tree placeholder. A
//   native `WebContentsView` is NOT in the DOM — it's an OS-level view the main
//   process paints over the window's content area. We can't style it; we can
//   only tell main where to put it via IPC (`nativeSurface.setBounds`).
//
//   So this module mirrors portal-host's *proven* rect loop (ResizeObserver
//   invalidator + rAF settle, window resize/scroll invalidation) but, instead
//   of mutating element styles, it reports each placeholder's
//   getBoundingClientRect() to main on change. Main drives the matching
//   `WebContentsView.setBounds()`.
//
// Visibility:
//   A native view paints above all renderer DOM, so it MUST be hidden whenever
//   its placeholder isn't a live, on-screen rectangle:
//     - placeholder has a 0×0 box (inactive tab / focus-collapse / display:none
//       ancestor) → report visible:false.
//     - a blocking modal/overlay is open → setSuspended(true) forces every
//       surface to visible:false (the view would otherwise paint over the modal),
//       restored on close.
//   This host never destroys a view — release is owned by panel-close /
//   web-app-removal via `nativeSurface.release`. untrack() merely stops tracking
//   and reports a final visible:false.

import { createSignal } from "solid-js";
import { getElectron, isElectron } from "@/lib/electron";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Surface {
  surfaceId: number;
  placeholder: HTMLElement;
  resizeObserver: ResizeObserver;
  /** Last bounds reported to main, to suppress redundant IPC. */
  lastBounds: Bounds | null;
  /** Last visibility reported to main. */
  lastVisible: boolean | null;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const surfaces = new Map<number, Surface>();

let pollActive = false;
let unchangedFrames = 0;

// While suspended, every surface reports visible:false regardless of its rect.
// Used to hide native views under a blocking modal/overlay (they paint above
// the DOM, so a modal can't cover them).
let suspended = false;

// ---------------------------------------------------------------------------
// Track / untrack
// ---------------------------------------------------------------------------

/**
 * Begin tracking a placeholder for the given native surface. The surface's
 * on-screen bounds will be reported to main whenever the placeholder's rect
 * changes. No-op outside Electron.
 */
export function track(surfaceId: number, placeholder: HTMLElement): void {
  if (!isElectron()) return;
  const existing = surfaces.get(surfaceId);
  if (existing !== undefined) {
    // Re-point to the new placeholder (e.g. the panel body div was recreated).
    if (existing.placeholder !== placeholder) {
      existing.resizeObserver.disconnect();
      existing.placeholder = placeholder;
      existing.resizeObserver = new ResizeObserver(() => startPoll());
      existing.resizeObserver.observe(placeholder);
      existing.lastBounds = null;
      existing.lastVisible = null;
    }
    syncSurface(existing);
    startPoll();
    return;
  }

  const ro = new ResizeObserver(() => startPoll());
  ro.observe(placeholder);
  const entry: Surface = {
    surfaceId,
    placeholder,
    resizeObserver: ro,
    lastBounds: null,
    lastVisible: null,
  };
  surfaces.set(surfaceId, entry);
  syncSurface(entry);
  startPoll();
}

/**
 * Stop tracking a surface and report a final visible:false so main parks the
 * native view off-screen. Does NOT release/destroy the view — that's owned by
 * panel-close / web-app-removal.
 *
 * `placeholder` is an ownership guard for the dock hand-off: when a floating
 * frame docks, the panel's NativeViewSurface re-`track`s the SAME surfaceId
 * (repointing to its own placeholder) before the floating frame's onCleanup
 * runs. Passing the caller's own placeholder makes a stale untrack a no-op once
 * a newer placeholder owns the surface, so the freshly-docked view isn't hidden.
 */
export function untrack(surfaceId: number, placeholder?: HTMLElement): void {
  const entry = surfaces.get(surfaceId);
  if (entry === undefined) return;
  // A newer track() already repointed this surface to a different placeholder —
  // the caller no longer owns it; leave the new owner's tracking intact.
  if (placeholder !== undefined && entry.placeholder !== placeholder) return;
  entry.resizeObserver.disconnect();
  surfaces.delete(surfaceId);
  // Hide the view: the placeholder is leaving the DOM, so without this the
  // native view would freeze at its last rect, painting over the app.
  reportBounds(surfaceId, { x: 0, y: 0, width: 0, height: 0 }, false);
}

// Reactive count of open "native-surface blockers" — full-bleed/modal overlays
// that must paint above the panels. A native WebContentsView always renders
// above ALL renderer DOM, so an overlay can never sit above a panel by z-index;
// the only way to honor "overlays display above panels" is to HIDE the native
// views while a blocker is open. Every Kobalte Dialog/Sheet pushes a blocker for
// its open lifetime (see components/ui/dialog.tsx + sheet.tsx), so all modals get
// this automatically. The App-level suspend effect ORs this with the non-Kobalte
// full-bleed overlays (file preview, update takeover).
const [blockerCount, setBlockerCount] = createSignal(0);

/** True while any modal/full-bleed overlay that must cover the panels is open. */
export function surfaceBlockersActive(): boolean {
  return blockerCount() > 0;
}

/**
 * Register a native-surface blocker for an overlay's open lifetime. Increments
 * the reactive count; the returned cleanup decrements it. Pair with onCleanup so
 * the count releases when the overlay unmounts (including its exit animation).
 */
export function pushSurfaceBlocker(): () => void {
  setBlockerCount((n) => n + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    setBlockerCount((n) => Math.max(0, n - 1));
  };
}

/**
 * Force every tracked surface to visible:false (true) or restore normal
 * rect-driven visibility (false). Wired to the app's blocking-modal open state:
 * a native view paints above the DOM, so any modal must suspend it.
 */
export function setSuspended(value: boolean): void {
  if (suspended === value) return;
  suspended = value;
  // Re-evaluate everyone: suspending hides all; un-suspending restarts the poll
  // so each surface re-reports its true rect/visibility on the next tick.
  for (const entry of surfaces.values()) {
    // Invalidate cache so the next sync always re-emits.
    entry.lastVisible = null;
    syncSurface(entry);
  }
  startPoll();
}

// ---------------------------------------------------------------------------
// Rect-sync internals
// ---------------------------------------------------------------------------

function computeBounds(placeholder: HTMLElement): Bounds {
  const r = placeholder.getBoundingClientRect();
  return {
    x: Math.round(r.left),
    y: Math.round(r.top),
    width: Math.round(r.width),
    height: Math.round(r.height),
  };
}

function boundsEqual(a: Bounds | null, b: Bounds): boolean {
  if (a === null) return false;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function reportBounds(surfaceId: number, bounds: Bounds, visible: boolean): void {
  if (!isElectron()) return;
  void getElectron().nativeSurface.setBounds(surfaceId, bounds, visible);
}

/** Returns true if it emitted an IPC update (i.e. something changed). */
function syncSurface(entry: Surface): boolean {
  const bounds = computeBounds(entry.placeholder);
  // A 0×0 box means no live layout (inactive tab, collapsed, display:none
  // ancestor) — hide rather than park a stray rect. Suspension forces hidden.
  const visible = !suspended && bounds.width > 0 && bounds.height > 0;

  const boundsSame = boundsEqual(entry.lastBounds, bounds);
  const visibleSame = entry.lastVisible === visible;
  if (boundsSame && visibleSame) return false;

  entry.lastBounds = bounds;
  entry.lastVisible = visible;
  reportBounds(entry.surfaceId, bounds, visible);
  return true;
}

function syncAll(): boolean {
  let changed = false;
  for (const entry of surfaces.values()) {
    if (syncSurface(entry)) changed = true;
  }
  return changed;
}

function startPoll(): void {
  if (pollActive) return;
  pollActive = true;
  unchangedFrames = 0;
  if (typeof requestAnimationFrame === "undefined") return;
  requestAnimationFrame(pollTick);
}

function pollTick(): void {
  const changed = syncAll();
  if (changed) {
    unchangedFrames = 0;
  } else {
    unchangedFrames++;
  }
  // Settle after 2 unchanged frames; RO + window listeners restart on real
  // layout changes.
  if (unchangedFrames < 2) {
    requestAnimationFrame(pollTick);
  } else {
    pollActive = false;
  }
}

/**
 * Force a re-sync (and restart the poll). Used when a placeholder transitions
 * from no-box to has-box (tab activation) — ResizeObserver doesn't reliably
 * fire across that transition.
 */
export function requestSync(surfaceId?: number): void {
  if (surfaceId !== undefined) {
    const entry = surfaces.get(surfaceId);
    if (entry) syncSurface(entry);
  }
  startPoll();
}

// ---------------------------------------------------------------------------
// Global invalidators (mirror portal-host)
// ---------------------------------------------------------------------------

if (typeof window !== "undefined") {
  window.addEventListener("resize", () => startPoll());
  window.addEventListener("scroll", () => startPoll(), { passive: true, capture: true });
}
