// Pen producer (spec-27 PR-CV4 §Pen tool & annotation layer).
//
// Emits `co-view.event` frames for the pen channel:
//   pen.stroke_begin → pen.stroke_point* → pen.stroke_end → pen.clear?
//
// The producer never sends color. Color is derived on the consumer from the
// member's broadcast membership metadata (see consumer's `memberMeta`); a
// client-supplied color in `pen.stroke_begin` is intentionally dropped on the
// server. This makes color-spoofing impossible.
//
// Coordinate translation goes through `clientPointToHostViewport`, the same
// helper the cursor producer uses, so host (IDENTITY) and viewer (live overlay
// transform) stay in sync.
//
// Coalesce policy for `pen.stroke_point`: 16 points OR 33 ms, whichever first.
// `pen.stroke_end` ALWAYS fires, even if a flush of buffered points is about
// to fire in the same tick — the runtime guarantees terminal frames are not
// rate-limited, so the consumer can rely on receiving end markers and never
// keeping a stroke alive forever.

import type { WsCoViewEvent } from "@uncorded/protocol";

import {
  IDENTITY_TRANSFORM,
  clientPointToHostViewport,
  type OverlayTransform,
} from "./coords";

/** Max buffered points before forcing a `pen.stroke_point` flush. */
export const PEN_POINT_BATCH_MAX = 16;
/** Max buffered point age (ms) before forcing a `pen.stroke_point` flush. */
export const PEN_POINT_BATCH_MS = 33;

interface PenPoint {
  x: number;
  y: number;
  /** Pressure 0..1, defaults to 0.5 if the device doesn't report it. */
  p: number;
}

export interface PenProducerDeps {
  sessionId: string;
  send: (frame: WsCoViewEvent) => void;
  /** Overlay element for clientX/Y → host-viewport translation. Default null (host). */
  getOverlayEl?: () => HTMLElement | null;
  /** Live overlay transform. Default IDENTITY (host). */
  getOverlayTransform?: () => OverlayTransform;
  /**
   * Returns true when the local user is the session host. The runtime ALSO
   * enforces this server-side; the producer guard just hides the wire frame
   * so non-hosts don't burn rate-limit budget on a guaranteed-rejected call.
   */
  isHost?: () => boolean;
  /** Generate a stroke id. Defaults to crypto.randomUUID(). */
  generateStrokeId?: () => string;
  /** Window scope. Defaults to globalThis.window. */
  window?: Window & typeof globalThis;
  /** Override the clock for tests. */
  now?: () => number;
}

export interface PenProducer {
  dispose: () => void;
  isActive: () => boolean;
  /** Toggle pen mode (also bound to Alt+P). */
  toggle: () => void;
  /** Force-end the in-flight stroke if any (e.g., on Esc or tool change). */
  endStroke: () => void;
  clearMine: () => void;
  /** Host-only — the runtime drops scope:"all" from non-hosts. */
  clearAll: () => void;
}

export function createPenProducer(deps: PenProducerDeps): PenProducer {
  const win = deps.window ?? (globalThis as unknown as Window & typeof globalThis);
  const now = deps.now ?? Date.now;
  const getOverlayEl = deps.getOverlayEl ?? (() => null);
  const getTransform = deps.getOverlayTransform ?? (() => IDENTITY_TRANSFORM);
  const isHost = deps.isHost ?? (() => false);
  const generateStrokeId =
    deps.generateStrokeId ?? (() => crypto.randomUUID());

  let active = false;
  let disposed = false;

  // Active stroke state — non-null between begin and end.
  let strokeId: string | null = null;
  let buffer: PenPoint[] = [];
  let bufferStartedAt = 0;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;

  function emit(kind: WsCoViewEvent["kind"], payload: Record<string, unknown>): void {
    if (disposed) return;
    const frame: WsCoViewEvent = {
      type: "co-view.event",
      session_id: deps.sessionId,
      kind,
      payload,
      replay: "unsafe",
      ts: now(),
    };
    deps.send(frame);
  }

  function flushPoints(): void {
    if (flushTimer !== undefined) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }
    if (strokeId === null || buffer.length === 0) return;
    const points = buffer;
    buffer = [];
    emit("pen.stroke_point", { stroke_id: strokeId, points });
  }

  function scheduleFlush(): void {
    if (flushTimer !== undefined) return;
    const elapsed = now() - bufferStartedAt;
    const remaining = Math.max(0, PEN_POINT_BATCH_MS - elapsed);
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      flushPoints();
    }, remaining);
  }

  function translate(ev: { clientX: number; clientY: number }): { x: number; y: number } {
    return clientPointToHostViewport(ev, getOverlayEl(), getTransform());
  }

  function beginStroke(ev: PointerEvent): void {
    if (strokeId !== null) endStroke();
    strokeId = generateStrokeId();
    buffer = [];
    bufferStartedAt = now();
    const { x, y } = translate(ev);
    // Begin frame carries no color (server ignores any client color).
    emit("pen.stroke_begin", { stroke_id: strokeId });
    appendPoint(ev, x, y);
  }

  function appendPoint(
    ev: { pressure?: number },
    x: number,
    y: number,
  ): void {
    if (strokeId === null) return;
    const pressure =
      typeof ev.pressure === "number" && ev.pressure > 0 ? ev.pressure : 0.5;
    if (buffer.length === 0) bufferStartedAt = now();
    buffer.push({ x, y, p: pressure });
    if (buffer.length >= PEN_POINT_BATCH_MAX) {
      flushPoints();
      return;
    }
    scheduleFlush();
  }

  function endStroke(): void {
    if (strokeId === null) return;
    flushPoints();
    const id = strokeId;
    strokeId = null;
    emit("pen.stroke_end", { stroke_id: id });
  }

  function onPointerDown(ev: PointerEvent): void {
    if (!active) return;
    beginStroke(ev);
  }
  function onPointerMove(ev: PointerEvent): void {
    if (!active || strokeId === null) return;
    const { x, y } = translate(ev);
    appendPoint(ev, x, y);
  }
  function onPointerUp(_ev: PointerEvent): void {
    if (strokeId !== null) endStroke();
  }
  function onPointerCancel(_ev: PointerEvent): void {
    if (strokeId !== null) endStroke();
  }
  function onKeyDown(ev: KeyboardEvent): void {
    if (ev.altKey && (ev.key === "p" || ev.key === "P")) {
      toggle();
      return;
    }
    if (ev.key === "Escape" && strokeId !== null) {
      endStroke();
    }
  }

  function toggle(): void {
    active = !active;
    if (!active && strokeId !== null) endStroke();
  }

  function clearMine(): void {
    emit("pen.clear", { scope: "mine" });
  }
  function clearAll(): void {
    if (!isHost()) return;
    emit("pen.clear", { scope: "all" });
  }

  win.addEventListener("pointerdown", onPointerDown, { passive: true });
  win.addEventListener("pointermove", onPointerMove, { passive: true });
  win.addEventListener("pointerup", onPointerUp, { passive: true });
  win.addEventListener("pointercancel", onPointerCancel, { passive: true });
  win.addEventListener("keydown", onKeyDown, { passive: true });

  function dispose(): void {
    if (disposed) return;
    // End the in-flight stroke before flipping the disposed flag so the
    // terminal frame still goes out — the consumer relies on stroke_end to
    // unblock TTL eviction.
    if (strokeId !== null) endStroke();
    disposed = true;
    if (flushTimer !== undefined) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }
    win.removeEventListener("pointerdown", onPointerDown);
    win.removeEventListener("pointermove", onPointerMove);
    win.removeEventListener("pointerup", onPointerUp);
    win.removeEventListener("pointercancel", onPointerCancel);
    win.removeEventListener("keydown", onKeyDown);
  }

  return {
    dispose,
    isActive: () => active,
    toggle,
    endStroke,
    clearMine,
    clearAll,
  };
}
