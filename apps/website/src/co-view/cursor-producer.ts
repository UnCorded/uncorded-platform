// Cursor producer (spec-27 PR-CV4 §Cursor channel).
//
// Wires window-level pointer/focus/selection listeners into a 30 Hz cursor
// frame stream. Used by BOTH the host (input mode = "host", overlay element =
// null, IDENTITY_TRANSFORM) and the viewer (input mode = "viewer", overlay
// element = the scaled overlay container, live transform). Coordinate math
// lives in `coords.ts` so the two paths cannot drift.
//
// State priority — `pressed` and `dragging` describe the user's current
// committed UI interaction and outrank the recency-based `typing` and
// `selecting` signals (a viewer watching the host should see the drag, not a
// stale typing flag). `menu-open` is a host-context flag rather than a DOM
// scan so the producer pays nothing when no menu is open.
//
// Throttle is 33 ms leading-edge: the first event in an idle window fires
// immediately so cursor lag is invisible during normal motion; bursts collapse
// to a trailing flush of the last-known coordinates.
//
// `tap` and `long-press` are reserved for the mobile producer (PR-CV6).
// Desktop producers never emit them.

import type { CoViewCursorState, WsCoViewCursor } from "@uncorded/protocol";

import {
  IDENTITY_TRANSFORM,
  clientPointToHostViewport,
  type OverlayTransform,
} from "./coords";

/** Default leading-edge throttle interval (33 ms ≈ 30 Hz). */
export const CURSOR_THROTTLE_MS = 33;
/** How long after the last keystroke a focused input still reports `typing`. */
export const TYPING_RECENCY_MS = 2000;
/** Move distance (CSS px in host-viewport space) that promotes pressed → dragging. */
export const DRAG_THRESHOLD_PX = 4;

export interface CursorProducerDeps {
  sessionId: string;
  /** Send a frame. Producer never stamps `member_id` — that's server-side. */
  send: (frame: WsCoViewCursor) => void;
  /**
   * Returns the overlay element clicks happen INSIDE. Host producers pass a
   * function returning `null` (raw window coordinates are already in
   * host-viewport space). Viewer producers pass a function returning the
   * scaled overlay container.
   */
  getOverlayEl?: () => HTMLElement | null;
  /** Live overlay transform. Defaults to IDENTITY (host). */
  getOverlayTransform?: () => OverlayTransform;
  /**
   * Returns true if a popover or context menu is currently open. The producer
   * reads this for the `menu-open` state. Defaults to `() => false`.
   */
  isMenuOpen?: () => boolean;
  /** Window scope. Defaults to globalThis.window. Tests inject a fake. */
  window?: Window & typeof globalThis;
  /** Override the clock for tests. */
  now?: () => number;
}

export interface CursorProducer {
  dispose: () => void;
  /** Test hook — current classified state. */
  _state: () => CoViewCursorState;
  /** Test hook — last sent frame, or null. */
  _last: () => WsCoViewCursor | null;
  /** Test hook — force re-classification + flush of the last known coords. */
  _flush: () => void;
}

/**
 * Build a cursor producer. Returns a `dispose` to unbind every listener.
 * Safe to construct outside a hosting session — the producer just emits frames
 * the runtime will reject if the connection isn't a session member.
 */
export function createCursorProducer(deps: CursorProducerDeps): CursorProducer {
  const win = deps.window ?? (globalThis as unknown as Window & typeof globalThis);
  const now = deps.now ?? Date.now;
  const getOverlayEl = deps.getOverlayEl ?? (() => null);
  const getTransform = deps.getOverlayTransform ?? (() => IDENTITY_TRANSFORM);
  const isMenuOpen = deps.isMenuOpen ?? (() => false);

  let disposed = false;
  let state: CoViewCursorState = "idle";

  // Last raw pointer position in *host-viewport* CSS px.
  let lastX = 0;
  let lastY = 0;
  let havePoint = false;

  // Pressed / dragging tracking.
  let pressed = false;
  let pressOriginX = 0;
  let pressOriginY = 0;

  // Typing recency: last keystroke time on a focused editable element.
  // `null` means no keystroke has been observed yet — focus alone never
  // counts as typing.
  let lastKeystroke: number | null = null;
  let focusedEditable: Element | null = null;

  // Hover target (re-evaluated on pointermove against `currentTarget`).
  let hoverInteractive = false;

  // Throttle bookkeeping.
  let lastSentTs = 0;
  let lastSent: WsCoViewCursor | null = null;
  let trailingTimer: ReturnType<typeof setTimeout> | undefined;

  function isEditable(el: EventTarget | null): boolean {
    if (el === null || typeof el !== "object") return false;
    const e = el as { tagName?: string; isContentEditable?: boolean };
    if (e.tagName === "INPUT" || e.tagName === "TEXTAREA") return true;
    if (e.isContentEditable === true) return true;
    return false;
  }

  function isInteractive(el: Element | null): boolean {
    if (el === null) return false;
    const e = el as Element & {
      matches?: (selector: string) => boolean;
      closest?: (selector: string) => Element | null;
    };
    if (
      typeof e.matches === "function" &&
      e.matches(
        'button, a[href], [role="button"], [role="link"], [role="menuitem"], input, textarea, select, [tabindex]:not([tabindex="-1"])',
      )
    ) {
      return true;
    }
    if (typeof e.closest === "function") {
      return e.closest(
        'button, a[href], [role="button"], [role="link"], [role="menuitem"]',
      ) !== null;
    }
    return false;
  }

  function hasNonEmptySelection(): boolean {
    const sel = win.document?.getSelection?.();
    if (!sel) return false;
    if (sel.isCollapsed) return false;
    const text = sel.toString();
    return text.length > 0;
  }

  function classify(): CoViewCursorState {
    // Priority order — see file-level comment for rationale.
    if (pressed) {
      const dx = Math.abs(lastX - pressOriginX);
      const dy = Math.abs(lastY - pressOriginY);
      if (dx > DRAG_THRESHOLD_PX || dy > DRAG_THRESHOLD_PX) return "dragging";
      return "pressed";
    }
    if (isMenuOpen()) return "menu-open";
    if (hasNonEmptySelection()) return "selecting";
    if (
      focusedEditable !== null &&
      lastKeystroke !== null &&
      now() - lastKeystroke < TYPING_RECENCY_MS
    ) {
      return "typing";
    }
    if (hoverInteractive) return "hover";
    return "idle";
  }

  function publish(): void {
    if (disposed || !havePoint) return;
    state = classify();
    if (
      lastSent !== null &&
      lastSent.x === lastX &&
      lastSent.y === lastY &&
      lastSent.state === state
    ) {
      return;
    }
    const frame: WsCoViewCursor = {
      type: "co-view.cursor",
      session_id: deps.sessionId,
      x: lastX,
      y: lastY,
      state,
      ts: now(),
    };
    lastSent = frame;
    lastSentTs = frame.ts;
    deps.send(frame);
  }

  function schedule(): void {
    if (disposed) return;
    const elapsed = now() - lastSentTs;
    if (lastSent === null || elapsed >= CURSOR_THROTTLE_MS) {
      if (trailingTimer !== undefined) {
        clearTimeout(trailingTimer);
        trailingTimer = undefined;
      }
      publish();
      return;
    }
    if (trailingTimer !== undefined) return;
    trailingTimer = setTimeout(() => {
      trailingTimer = undefined;
      publish();
    }, CURSOR_THROTTLE_MS - elapsed);
  }

  function updatePoint(ev: { clientX: number; clientY: number }): void {
    const overlay = getOverlayEl();
    const xform = getTransform();
    const p = clientPointToHostViewport(ev, overlay, xform);
    lastX = p.x;
    lastY = p.y;
    havePoint = true;
  }

  function onPointerMove(ev: PointerEvent): void {
    updatePoint(ev);
    hoverInteractive = isInteractive(ev.target as Element | null);
    schedule();
  }
  function onPointerDown(ev: PointerEvent): void {
    updatePoint(ev);
    pressed = true;
    pressOriginX = lastX;
    pressOriginY = lastY;
    schedule();
  }
  function onPointerUp(ev: PointerEvent): void {
    updatePoint(ev);
    pressed = false;
    schedule();
  }
  function onPointerCancel(ev: PointerEvent): void {
    updatePoint(ev);
    pressed = false;
    schedule();
  }
  function onFocusIn(ev: FocusEvent): void {
    if (isEditable(ev.target)) {
      focusedEditable = ev.target as Element;
      // Don't reset lastKeystroke — focus alone isn't typing.
    }
    schedule();
  }
  function onFocusOut(ev: FocusEvent): void {
    if (focusedEditable === ev.target) focusedEditable = null;
    schedule();
  }
  function onKeyDown(ev: KeyboardEvent): void {
    if (focusedEditable === null) return;
    const target = ev.target as Node | null;
    const focused = focusedEditable as Element & {
      contains?: (other: Node | null) => boolean;
    };
    if (target !== focused) {
      const contains = typeof focused.contains === "function"
        ? focused.contains(target)
        : false;
      if (!contains) return;
    }
    lastKeystroke = now();
    schedule();
  }
  function onSelectionChange(): void {
    schedule();
  }

  win.addEventListener("pointermove", onPointerMove, { passive: true });
  win.addEventListener("pointerdown", onPointerDown, { passive: true });
  win.addEventListener("pointerup", onPointerUp, { passive: true });
  win.addEventListener("pointercancel", onPointerCancel, { passive: true });
  win.addEventListener("focusin", onFocusIn);
  win.addEventListener("focusout", onFocusOut);
  win.addEventListener("keydown", onKeyDown, { passive: true });
  win.document?.addEventListener("selectionchange", onSelectionChange);

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    if (trailingTimer !== undefined) {
      clearTimeout(trailingTimer);
      trailingTimer = undefined;
    }
    win.removeEventListener("pointermove", onPointerMove);
    win.removeEventListener("pointerdown", onPointerDown);
    win.removeEventListener("pointerup", onPointerUp);
    win.removeEventListener("pointercancel", onPointerCancel);
    win.removeEventListener("focusin", onFocusIn);
    win.removeEventListener("focusout", onFocusOut);
    win.removeEventListener("keydown", onKeyDown);
    win.document?.removeEventListener("selectionchange", onSelectionChange);
  }

  return {
    dispose,
    _state: () => state,
    _last: () => lastSent,
    _flush: publish,
  };
}
