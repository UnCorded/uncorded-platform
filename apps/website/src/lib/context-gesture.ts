// Context-menu gesture primitive — unifies right-click (desktop) and
// touch/pen long-press (mobile) into one "open the per-item menu" event.
//
// Why this exists: the alternative — a visible "⋯" trigger button on every
// row — adds visual clutter and steals horizontal space. Right-click and
// long-press are both platform-native gestures users already know.
//
// Coordinates with @/lib/drag-state because rows are also pointer-draggable.
// The drag pipeline arms on pointerdown and only "starts" once the cursor
// moves >4px. We use the same fork: if the user moves before our long-press
// timer fires, drag wins; if our timer fires first (no motion), we cancel
// the pending drag and open the menu.

import { onCleanup } from "solid-js";
import {
  cancelPendingPointerDrag,
  shouldIgnoreDragStart,
} from "@/lib/drag-state";

// 450ms matches the native long-press feel on iOS/Android. Shorter and
// users trigger it accidentally while reading; longer and it feels broken.
const DEFAULT_LONG_PRESS_MS = 450;
// A bit larger than drag's 4px threshold so a finger that wobbles juuust
// past the drag-start line still cancels our timer cleanly. The drag
// pipeline owns the canonical drag-start detection — we only need to
// know "did motion happen?"
const MOVE_CANCEL_PX = 6;
// After firing, swallow the synthetic click that pointerup will produce so
// the row doesn't navigate immediately after the menu opens. 600ms covers
// the worst-case lag between pointerup and the click event on slow touch
// devices without being long enough to swallow a deliberate follow-up tap.
const SUPPRESS_CLICK_MS = 600;

export interface ContextGestureAnchor {
  x: number;
  y: number;
  rect: DOMRect | null;
  source: "mouse" | "touch" | "pen";
}

export interface ContextGestureOptions {
  onOpen: (anchor: ContextGestureAnchor) => void;
  enabled?: () => boolean;
  longPressMs?: number;
}

export interface ContextGestureHandlers {
  onPointerDown: (e: PointerEvent) => void;
  onPointerMove: (e: PointerEvent) => void;
  onPointerUp: (e: PointerEvent) => void;
  onPointerCancel: (e: PointerEvent) => void;
  onContextMenu: (e: MouseEvent) => void;
  /**
   * Wrap a consumer click handler so it no-ops when a recent long-press
   * fired. Right-click never produces a click, so this is only meaningful
   * after touch/pen long-press.
   */
  wrapClick: (handler: (e: MouseEvent) => void) => (e: MouseEvent) => void;
}

export function createContextGesture(
  opts: ContextGestureOptions,
): ContextGestureHandlers {
  const longPressMs = opts.longPressMs ?? DEFAULT_LONG_PRESS_MS;
  const isEnabled = () => (opts.enabled ? opts.enabled() : true);

  let timer: ReturnType<typeof setTimeout> | undefined;
  let pointerId: number | null = null;
  let startX = 0;
  let startY = 0;
  let lastX = 0;
  let lastY = 0;
  let sourceEl: Element | null = null;
  let pointerKind: "mouse" | "touch" | "pen" = "mouse";
  let suppressClickUntil = 0;

  function clearTimer(): void {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  }

  function disarm(): void {
    clearTimer();
    pointerId = null;
    sourceEl = null;
  }

  function fireFromLongPress(): void {
    if (sourceEl === null) return;
    const rect = sourceEl.getBoundingClientRect();
    // Drag is "armed but not started" — clear it so a tiny finger jitter
    // after the menu opens doesn't trip the >4px drag-start check.
    cancelPendingPointerDrag();
    suppressClickUntil = performance.now() + SUPPRESS_CLICK_MS;
    const anchor: ContextGestureAnchor = {
      x: lastX,
      y: lastY,
      rect,
      source: pointerKind,
    };
    disarm();
    opts.onOpen(anchor);
  }

  onCleanup(() => clearTimer());

  return {
    onPointerDown(e) {
      if (!isEnabled()) return;
      // Right-click goes through onContextMenu. Arming a long-press here
      // would double-fire on platforms that synthesize both.
      if (e.button !== 0) return;
      // Skip presses on interactive children — they have their own click
      // semantics and the user shouldn't get a context menu from tapping
      // an embedded button or input.
      if (shouldIgnoreDragStart(e.target)) return;
      // Mouse uses right-click. Only touch/pen need a press-and-hold.
      if (e.pointerType !== "touch" && e.pointerType !== "pen") return;

      clearTimer();
      pointerId = e.pointerId;
      pointerKind = e.pointerType;
      startX = e.clientX;
      startY = e.clientY;
      lastX = e.clientX;
      lastY = e.clientY;
      sourceEl = e.currentTarget as Element;
      timer = setTimeout(fireFromLongPress, longPressMs);
    },

    onPointerMove(e) {
      if (pointerId === null || e.pointerId !== pointerId) return;
      lastX = e.clientX;
      lastY = e.clientY;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (dx * dx + dy * dy >= MOVE_CANCEL_PX * MOVE_CANCEL_PX) {
        // Motion = drag intent. Step aside.
        disarm();
      }
    },

    onPointerUp(e) {
      if (pointerId === null || e.pointerId !== pointerId) return;
      // Released before the timer — normal click path runs (wrapClick will
      // not suppress it because suppressClickUntil hasn't been bumped).
      disarm();
    },

    onPointerCancel(e) {
      if (pointerId === null || e.pointerId !== pointerId) return;
      disarm();
    },

    onContextMenu(e) {
      // Always suppress the native browser/OS context menu on this surface.
      // Even when disabled, surfacing the system menu over our UI is jarring.
      e.preventDefault();
      if (!isEnabled()) return;
      // Touch devices may synthesize a contextmenu after the OS-detected
      // long-press. If our timer already fired, swallow the duplicate.
      if (performance.now() < suppressClickUntil) return;
      // Synthetic contextmenu mid-touch-press: let our timer be the
      // single source of truth so anchor coords stay consistent.
      if (pointerId !== null && pointerKind !== "mouse") return;

      const target = e.currentTarget as Element;
      const rect = target.getBoundingClientRect();
      disarm();
      opts.onOpen({ x: e.clientX, y: e.clientY, rect, source: "mouse" });
    },

    wrapClick(handler) {
      return (e: MouseEvent) => {
        if (performance.now() < suppressClickUntil) {
          e.stopPropagation();
          return;
        }
        handler(e);
      };
    },
  };
}
