// Pointer-based drag pipeline. Replaces the HTML5 DragEvent wiring that
// previously lived inline in panel.tsx and nav-sidebar-sections.tsx.
//
// Design:
//   - A single module-level drag session at a time. `startPointerDrag` opens
//     one, binds document-level pointer/key/blur listeners, and dispatches
//     `onCommit` / `onCancel` back to the caller.
//   - Pointer capture is taken on a stable, always-mounted overlay (registered
//     by <DragCaptureRoot />) — not on the source header — so the capture
//     survives any DOM mutation of the source during the drag (source ghosting
//     in PR-C).
//   - Click-vs-drag threshold: the session only transitions to "dragging"
//     after the pointer moves > 4px from the start. Before that, a pointerup
//     is treated as a click — no commit, no cancel, native `click` event
//     fires normally.
//   - Hit-testing walks `document.elementsFromPoint()` for the first
//     `[data-panel-leaf]` ancestor, so panel tree layout fully drives drop
//     targets (no per-leaf onDragOver listeners).

import { createSignal } from "solid-js";

export type DragEdge = "left" | "right" | "top" | "bottom";
export type DropZone = DragEdge | "center";

export type SidebarItemPayload = {
  id: string;
  label: string;
  icon?: string;
  slug: string;
  panelType: string;
};

export type DragPayload =
  | { kind: "panel"; sourceLeafId: string; sourceWorkspaceId: string }
  | { kind: "sidebar-item"; item: SidebarItemPayload };

export interface DropTarget {
  leafId: string;
  zone: DropZone;
}

const [dragContext, setDragContext] = createSignal<DragPayload | null>(null);
const [dropTarget, setDropTarget] = createSignal<DropTarget | null>(null);
// Cursor position while the drag threshold has been crossed. Consumed by
// portal-host's floating mode so the ghost surface tracks the pointer.
const [cursor, setCursor] = createSignal<{ x: number; y: number } | null>(null);
// True once the cursor has been still for DWELL_MS while a drag is active.
// Consumers gate "expensive" feedback (full layout preview reflow, pill dock)
// on this so nothing janky fires during continuous motion. Any pointermove
// flips this back to false and restarts the timer.
const [dwelling, setDwelling] = createSignal(false);
// Workspace tab currently under the cursor during a drag, as the user hovers
// long enough to trigger a workspace switch. Null when the cursor isn't over
// a tab (or is over the source workspace's own tab, which self-suppresses).
const [tabDwellTarget, setTabDwellTarget] = createSignal<string | null>(null);
// 0..1, advances linearly over TAB_DWELL_MS while tabDwellTarget is non-null.
// Hits 1 exactly once, then the target flips null — consumers watch for
// progress >= 1 with target non-null to fire the switch.
const [tabDwellProgress, setTabDwellProgress] = createSignal(0);

export { dragContext, dropTarget, cursor, dwelling, tabDwellTarget, tabDwellProgress };

// How long the cursor has to be still before we consider the user "parked"
// over a target. 220ms feels responsive for a deliberate hover and rejects
// the fastest normal cross-viewport movement as "still moving."
const DWELL_MS = 220;

// Sub-pixel cursor jitter from hand tremor or trackpad noise shouldn't
// collapse a preview that's already engaged. Only movements beyond this
// radius (in pixels from the last dwell-reset point) are treated as real
// motion and reset the dwell timer.
//
// Two thresholds (hysteresis): getting the preview to *engage* should feel
// responsive, so the pre-dwell threshold is tight. Once the preview has
// docked, the user is committed — fingers on touchscreens can't sit
// perfectly still, trackpads pick up tiny deltas on acceleration, etc. — so
// the undock threshold is much larger. You have to actually mean to leave.
const DWELL_RESET_DELTA_PX = 5;
const DWELL_UNDOCK_DELTA_PX = 16;
// Same threshold for re-hit-testing: tiny noise shouldn't re-query the
// drop target (and risk crossing zone boundaries inside the preview
// layout). Hit-tests update only on real motion; any motion big enough
// to re-test will also have reset the dwell and collapsed the preview.
const HITTEST_DELTA_PX = 3;

// How long the cursor has to linger over a workspace tab during a drag
// before we switch to that workspace. 600ms is deliberately longer than
// the leaf-dwell (220ms) — switching workspaces is a bigger commitment
// than snapping a preview, and we'd rather reject a casual pan-across
// than fire an accidental switch.
const TAB_DWELL_MS = 600;
// Hysteresis for tab hover: once a tab is being dwelled on, the cursor
// has to leave its rect by this margin to cancel — keeps shaky fingers
// or minor overshoot from resetting the progress ring. Entering a tab
// (to start dwell) is still edge-exact, same "responsive to engage,
// generous once engaged" pattern as the leaf preview.
const TAB_HYSTERESIS_PX = 8;

// ---------------------------------------------------------------------------
// Capture root registration
// ---------------------------------------------------------------------------

let captureRoot: HTMLElement | null = null;

export function registerDragCaptureRoot(el: HTMLElement): void {
  captureRoot = el;
}
export function unregisterDragCaptureRoot(el: HTMLElement): void {
  if (captureRoot === el) captureRoot = null;
}

// ---------------------------------------------------------------------------
// Start-exemption
// ---------------------------------------------------------------------------

// Elements that should NOT initiate a drag on pointerdown. Order matters for
// intent: interactive widgets first (buttons, inputs), then opt-out markers.
const DRAG_IGNORE_SELECTOR = [
  "button",
  "input",
  "textarea",
  "select",
  "[contenteditable='true']",
  "[role='menuitem']",
  "[data-no-drag]",
  "[data-resize-handle]",
].join(",");

export function shouldIgnoreDragStart(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest(DRAG_IGNORE_SELECTOR) !== null;
}

// ---------------------------------------------------------------------------
// Hit-testing
// ---------------------------------------------------------------------------

const EDGE_THRESHOLD = 0.25;

/**
 * Resolve the workspace tab under (x, y), if any. Hit-tests for the first
 * ancestor tagged `[data-workspace-tab]` whose attribute value is the
 * workspace id.
 *
 * Hysteresis-aware: if `hysteresis` is provided (workspaceId + its last-known
 * rect) and the point is outside every tab but within TAB_HYSTERESIS_PX of
 * the given rect's edges, treat as still hovering the hysteresis workspace
 * — lets a shaky cursor keep dwell alive across the tab edge.
 */
export function hitTestWorkspaceTabAt(
  x: number,
  y: number,
  hysteresis?: { workspaceId: string; rect: DOMRect } | null,
): { workspaceId: string } | null {
  const elements = typeof document.elementsFromPoint === "function"
    ? document.elementsFromPoint(x, y)
    : ([document.elementFromPoint(x, y)].filter(Boolean) as Element[]);

  for (const el of elements) {
    const tab = el.closest?.("[data-workspace-tab]") as HTMLElement | null;
    if (!tab) continue;
    const id = tab.getAttribute("data-workspace-tab");
    if (id !== null && id.length > 0) return { workspaceId: id };
  }

  if (hysteresis) {
    const r = hysteresis.rect;
    if (
      x >= r.left - TAB_HYSTERESIS_PX
      && x <= r.right + TAB_HYSTERESIS_PX
      && y >= r.top - TAB_HYSTERESIS_PX
      && y <= r.bottom + TAB_HYSTERESIS_PX
    ) {
      return { workspaceId: hysteresis.workspaceId };
    }
  }
  return null;
}

export function hitTestAt(
  x: number,
  y: number,
  excludeLeafId?: string,
): DropTarget | null {
  const elements = typeof document.elementsFromPoint === "function"
    ? document.elementsFromPoint(x, y)
    : ([document.elementFromPoint(x, y)].filter(Boolean) as Element[]);

  for (const el of elements) {
    const leaf = el.closest?.("[data-panel-leaf]") as HTMLElement | null;
    if (!leaf) continue;
    const leafId = leaf.getAttribute("data-panel-leaf");
    if (!leafId) continue;
    // During a panel drag, exclude the source leaf from hit-testing. The
    // preview-tree has physically relocated the source to the resolved target;
    // if we hit-test it here, we'd resolve source-as-target, the preview would
    // revert to base, the cursor would re-hit the real target, and we'd
    // oscillate at frame rate. Skipping the source keeps the target stable.
    if (leafId === excludeLeafId) continue;
    const rect = leaf.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    const rx = (x - rect.left) / rect.width;
    const ry = (y - rect.top) / rect.height;
    let zone: DropZone;
    if (rx < EDGE_THRESHOLD) zone = "left";
    else if (rx > 1 - EDGE_THRESHOLD) zone = "right";
    else if (ry < EDGE_THRESHOLD) zone = "top";
    else if (ry > 1 - EDGE_THRESHOLD) zone = "bottom";
    else zone = "center";
    return { leafId, zone };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

const CLICK_VS_DRAG_THRESHOLD_PX = 4;

interface Session {
  pointerId: number;
  startX: number;
  startY: number;
  started: boolean;
  payload: DragPayload;
  onCommit: (target: DropTarget) => void;
  onCancel: () => void;
  cleanup: () => void;
}

let session: Session | null = null;

/** Returns true if a pointer drag session is currently active (regardless of whether the drag threshold has been crossed). */
export function hasPendingPointerDrag(): boolean {
  return session !== null;
}

/**
 * Tear down the pending pointer-drag session iff it has not yet crossed the
 * movement threshold. Used by the context-gesture primitive when a long-press
 * fires: drag is "armed" on pointerdown but only "started" once the cursor
 * moves >4px, so a long-press without motion leaves the session pending.
 * Without this, a small finger jitter after the menu opens would still trip
 * the drag start. Returns true if a pending session was ended.
 */
export function cancelPendingPointerDrag(): boolean {
  if (session === null || session.started) return false;
  end();
  return true;
}

export interface StartOptions {
  payload: DragPayload;
  pointerEvent: PointerEvent;
  onCommit: (target: DropTarget) => void;
  onCancel: () => void;
}

let dwellTimer: ReturnType<typeof setTimeout> | undefined;
// Anchor point used to decide whether the next pointermove has travelled
// enough to count as "real motion" vs sub-pixel jitter. Updated whenever
// we do reset dwell so the delta threshold is always measured from the
// last reset, not from drag start.
let dwellAnchor: { x: number; y: number } | null = null;
// Anchor for hit-test gating — separate from dwell anchor because the
// delta thresholds differ.
let hitTestAnchor: { x: number; y: number } | null = null;
let lastHitTarget: DropTarget | null = null;

// Tab-dwell lifecycle:
//   - tabDwellStart: performance.now() when progress began for the current
//     target. Elapsed-since is what drives progress; stays fixed across a
//     dwell so micromotion (which doesn't cancel thanks to hysteresis)
//     doesn't keep resetting the timer.
//   - tabDwellLastRect: rect sampled when the target was acquired, used for
//     hysteresis — cursor leaving by more than TAB_HYSTERESIS_PX cancels.
//   - tabDwellRaf: the progress-advance RAF handle.
let tabDwellStart = 0;
let tabDwellLastRect: DOMRect | null = null;
let tabDwellRaf: number | null = null;

function resetDwell(x: number, y: number): void {
  setDwelling(false);
  dwellAnchor = { x, y };
  if (dwellTimer !== undefined) clearTimeout(dwellTimer);
  dwellTimer = setTimeout(() => setDwelling(true), DWELL_MS);
}

function clearDwell(): void {
  if (dwellTimer !== undefined) {
    clearTimeout(dwellTimer);
    dwellTimer = undefined;
  }
  dwellAnchor = null;
  hitTestAnchor = null;
  lastHitTarget = null;
  setDwelling(false);
}

function startTabDwell(workspaceId: string, rect: DOMRect): void {
  setTabDwellTarget(workspaceId);
  tabDwellLastRect = rect;
  tabDwellStart = performance.now();
  setTabDwellProgress(0);
  if (tabDwellRaf !== null) cancelAnimationFrame(tabDwellRaf);
  const tick = () => {
    const elapsed = performance.now() - tabDwellStart;
    const p = Math.min(1, elapsed / TAB_DWELL_MS);
    setTabDwellProgress(p);
    if (p >= 1) {
      // Fire once, then clear — so repeated ticks don't re-trigger if the
      // cursor keeps hovering. App-side effect sees progress=1 + target
      // non-null and performs the switch in the same microtask before we
      // flip target to null here.
      tabDwellRaf = null;
      return;
    }
    tabDwellRaf = requestAnimationFrame(tick);
  };
  tabDwellRaf = requestAnimationFrame(tick);
}

function cancelTabDwell(): void {
  if (tabDwellRaf !== null) {
    cancelAnimationFrame(tabDwellRaf);
    tabDwellRaf = null;
  }
  setTabDwellTarget(null);
  setTabDwellProgress(0);
  tabDwellLastRect = null;
}

export function startPointerDrag(opts: StartOptions): void {
  if (session) end();

  const { payload, pointerEvent, onCommit, onCancel } = opts;
  const pointerId = pointerEvent.pointerId;
  const startX = pointerEvent.clientX;
  const startY = pointerEvent.clientY;

  const onMove = (e: PointerEvent) => {
    if (!session || e.pointerId !== session.pointerId) return;
    if (!session.started) {
      const dx = e.clientX - session.startX;
      const dy = e.clientY - session.startY;
      const thresh = CLICK_VS_DRAG_THRESHOLD_PX * CLICK_VS_DRAG_THRESHOLD_PX;
      if (dx * dx + dy * dy < thresh) return;
      session.started = true;
      setDragContext(session.payload);
      setCursor({ x: e.clientX, y: e.clientY });
      resetDwell(e.clientX, e.clientY);
      hitTestAnchor = { x: e.clientX, y: e.clientY };
      const excludeLeafIdInit =
        session.payload.kind === "panel" ? session.payload.sourceLeafId : undefined;
      const initialTarget = hitTestAt(e.clientX, e.clientY, excludeLeafIdInit);
      lastHitTarget = initialTarget;
      setDropTarget(initialTarget);
      // Cross-workspace switches (tab-dwell) and panel rearrangement during
      // the drag unmount the source leaf. The portal-host's hide-by-default
      // policy keeps that mount alive across the gap, so a destination
      // mount() with the same surfaceKey adopts it. Rekey at commit-time
      // moves the entry under the new key for the cross-workspace path.
      if (captureRoot !== null) {
        captureRoot.style.pointerEvents = "auto";
        // Grabbing cursor lives on the capture root because pointer-capture
        // routes events here; the source header's `active:cursor-grabbing` only
        // applies while its own pointer events are active (they aren't, once
        // capture moves).
        captureRoot.style.cursor = "grabbing";
        try { captureRoot.setPointerCapture(session.pointerId); } catch { /* benign */ }
      }
      return;
    }

    setCursor({ x: e.clientX, y: e.clientY });

    // Dwell delta gate: sub-pixel jitter shouldn't collapse a stable preview.
    // Hysteresis — tight pre-engage threshold (feels responsive), generous
    // post-engage threshold (tolerates touch/trackpad micro-motion without
    // collapsing the docked preview). Once you've committed to the dock, you
    // have real slop to re-aim, adjust grip, steady a shaky finger, etc.
    if (dwellAnchor !== null) {
      const dx = e.clientX - dwellAnchor.x;
      const dy = e.clientY - dwellAnchor.y;
      const threshold = dwelling()
        ? DWELL_UNDOCK_DELTA_PX
        : DWELL_RESET_DELTA_PX;
      if (dx * dx + dy * dy >= threshold * threshold) {
        resetDwell(e.clientX, e.clientY);
      }
    } else {
      resetDwell(e.clientX, e.clientY);
    }

    // Hit-test delta gate: running elementsFromPoint on every 1px move is both
    // wasteful and — critically — risks crossing zone boundaries inside the
    // *preview* layout. Since any motion big enough to change zones will also
    // have cleared DWELL_RESET_DELTA_PX, the preview collapses to base before
    // the next hit-test, so the hit-test always runs against the base layout.
    //
    // While dwelling, suppress hit-tests entirely inside the undock slop —
    // the user has committed to this dock, they shouldn't see the target
    // jump to an adjacent zone from an accidental 10px shake.
    const hitTestThreshold = dwelling()
      ? DWELL_UNDOCK_DELTA_PX
      : HITTEST_DELTA_PX;
    const needHitTest =
      hitTestAnchor === null
      || ((e.clientX - hitTestAnchor.x) ** 2 + (e.clientY - hitTestAnchor.y) ** 2)
         >= hitTestThreshold * hitTestThreshold;
    if (needHitTest) {
      hitTestAnchor = { x: e.clientX, y: e.clientY };
      const excludeLeafId =
        session.payload.kind === "panel" ? session.payload.sourceLeafId : undefined;
      const next = hitTestAt(e.clientX, e.clientY, excludeLeafId);
      // Only write dropTarget if it actually changed — same leaf+zone
      // produces a stable object from hitTestAt (new ref each call), so
      // compare by value to avoid dead-signal churn.
      if (
        next === null
          ? lastHitTarget !== null
          : lastHitTarget === null
            || lastHitTarget.leafId !== next.leafId
            || lastHitTarget.zone !== next.zone
      ) {
        lastHitTarget = next;
        setDropTarget(next);
      }
    }

    // Tab-dwell: orthogonal to leaf hit-testing. Runs every pointermove so
    // progress advances frame-tight as the cursor lingers. Hysteresis keeps
    // dwell alive for cursor shakes inside TAB_HYSTERESIS_PX of the last
    // tab rect. Self-suppresses when the cursor is over the source
    // workspace's own tab (no point switching to where we already are).
    const tabHit = hitTestWorkspaceTabAt(
      e.clientX,
      e.clientY,
      tabDwellLastRect !== null && tabDwellTarget() !== null
        ? { workspaceId: tabDwellTarget()!, rect: tabDwellLastRect }
        : null,
    );
    const sourceWs =
      session.payload.kind === "panel" ? session.payload.sourceWorkspaceId : null;
    if (tabHit !== null && tabHit.workspaceId !== sourceWs) {
      if (tabDwellTarget() !== tabHit.workspaceId) {
        // New tab acquired — sample its rect for hysteresis and start fresh.
        const el = document.querySelector<HTMLElement>(
          `[data-workspace-tab='${CSS.escape(tabHit.workspaceId)}']`,
        );
        const rect = el !== null ? el.getBoundingClientRect() : null;
        if (rect !== null) startTabDwell(tabHit.workspaceId, rect);
      }
      // Same tab: do nothing — rAF ticker continues advancing progress.
    } else if (tabDwellTarget() !== null) {
      cancelTabDwell();
    }
  };

  const onUp = (e: PointerEvent) => {
    if (!session || e.pointerId !== session.pointerId) return;
    const s = session;
    if (!s.started) { end(); return; }
    const target = dropTarget();
    end();
    if (target) s.onCommit(target); else s.onCancel();
  };

  const onCancelEvt = (e: PointerEvent) => {
    if (!session || e.pointerId !== session.pointerId) return;
    const s = session;
    const wasStarted = s.started;
    end();
    if (wasStarted) s.onCancel();
  };

  const onKey = (e: KeyboardEvent) => {
    if (!session || e.key !== "Escape") return;
    const s = session;
    const wasStarted = s.started;
    end();
    if (wasStarted) s.onCancel();
  };

  const onBlur = () => {
    if (!session) return;
    const s = session;
    const wasStarted = s.started;
    end();
    if (wasStarted) s.onCancel();
  };

  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onUp);
  document.addEventListener("pointercancel", onCancelEvt);
  document.addEventListener("keydown", onKey);
  window.addEventListener("blur", onBlur);

  session = {
    pointerId,
    startX,
    startY,
    started: false,
    payload,
    onCommit,
    onCancel,
    cleanup: () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onCancelEvt);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onBlur);
      if (captureRoot !== null) {
        captureRoot.style.pointerEvents = "none";
        captureRoot.style.cursor = "";
        try { captureRoot.releasePointerCapture(pointerId); } catch { /* benign */ }
      }
    },
  };
}

function end(): void {
  if (!session) return;
  session.cleanup();
  session = null;
  setDragContext(null);
  setDropTarget(null);
  setCursor(null);
  clearDwell();
  cancelTabDwell();
}

/** @internal — test hook. */
export function _resetForTests(): void {
  end();
  captureRoot = null;
}
