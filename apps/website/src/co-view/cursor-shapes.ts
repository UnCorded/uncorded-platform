// State → SVG path table for the viewer cursor layer (spec-27 PR-CV4 §Cursor
// vocabulary). Paths are drawn at the cursor's host-viewport coordinate;
// the SVG <g> wrapper handles translation. Shapes are intentionally tiny
// (≤16px tall) so 8 cursors stacked over the same hover target read clearly.
//
// `tap` and `long-press` are reserved for the PR-CV6 mobile producer; we
// register them now so the renderer doesn't crash on unexpected mobile data
// arriving early.

import type { CoViewCursorState } from "@uncorded/protocol";

export interface CursorShape {
  /** SVG path data, anchored at (0, 0) = the cursor's pointer hot-spot. */
  d: string;
  /** Optional secondary path overlaid on top (e.g. text I-beam stem). */
  detail?: string;
  /** Default fill opacity (0..1). */
  opacity?: number;
}

const ARROW =
  "M0 0 L0 14 L4 11 L7 17 L9 16 L6 10 L11 10 Z";

const HAND_PRESSED = "M0 0 L11 0 L11 11 L0 11 Z";

const DRAG_DIAMOND = "M5 0 L10 5 L5 10 L0 5 Z";

const TYPING_BAR = "M-1 0 L1 0 L1 12 L-1 12 Z";

const SELECTING_BAR = "M-1 0 L2 0 L2 12 L-1 12 Z";

const MENU_OPEN_DOTS = "M0 0 L2 0 L2 2 L0 2 Z M4 0 L6 0 L6 2 L4 2 Z M8 0 L10 0 L10 2 L8 2 Z";

const HOVER_DOT = "M0 0 m -3 0 a 3 3 0 1 0 6 0 a 3 3 0 1 0 -6 0";

const TAP_RING = "M0 0 m -5 0 a 5 5 0 1 0 10 0 a 5 5 0 1 0 -10 0";

export const CURSOR_SHAPES: Readonly<Record<CoViewCursorState, CursorShape>> = {
  idle: { d: ARROW },
  hover: { d: ARROW, detail: HOVER_DOT, opacity: 0.95 },
  pressed: { d: HAND_PRESSED, opacity: 0.85 },
  dragging: { d: DRAG_DIAMOND, opacity: 0.95 },
  typing: { d: TYPING_BAR },
  selecting: { d: SELECTING_BAR, opacity: 0.85 },
  "menu-open": { d: ARROW, detail: MENU_OPEN_DOTS },
  tap: { d: TAP_RING, opacity: 0.7 },
  "long-press": { d: TAP_RING, opacity: 0.95 },
};
