// CoView viewer selection - dormant projected-viewer integration point (CV-FOUND-8).
//
// The single decision the live viewer flow makes: render the legacy
// `CoViewViewerOverlay` (via `ViewerSession`) or the sanitized projected mount
// (`CoViewProjectedViewerMount`). This module holds the *testable* choice as a
// DOM-free pure function; the thin Solid component (`viewer-selector-view.tsx`)
// maps the choice onto JSX. The split mirrors `projected-viewer-mount.ts` (pure,
// tested) vs `projected-viewer-mount-view.tsx` (view, typecheck-only).
//
// Dormant by default: `CO_VIEW_PROJECTED_VIEWER_ENABLED` (render-tree-viewer.ts)
// stays false, so production always resolves to the legacy viewer. Enabling is via
// the injected `enabled` flag (tests / a future rollout PR), never by flipping the
// global. This module touches no frame and synthesizes no value - it only chooses,
// so it can introduce no protected bytes; every projection/privacy decision lives
// downstream in `CoViewProjectedViewerMount` -> `projected-frame-store` ->
// `render-tree-viewer`.

import { CO_VIEW_PROJECTED_VIEWER_ENABLED } from "./render-tree-viewer";

/**
 * Which viewer the live flow should mount. The `projected` arm carries the IDs it
 * was selected with so the integration is exact: the projected mount receives
 * precisely this `serverId` / `sessionId` and nothing else.
 */
export type CoViewViewerChoice =
  | { kind: "legacy" }
  | { kind: "projected"; serverId: string; sessionId: string };

/** Inputs to the viewer choice. `enabled` defaults to the dormancy flag. */
export interface SelectCoViewViewerArgs {
  serverId: string;
  sessionId: string;
  /**
   * Override the dormancy flag. Defaults to `CO_VIEW_PROJECTED_VIEWER_ENABLED`
   * (false), so production stays on the legacy viewer; a test passes `true` to
   * exercise the projected arm without dialing a socket or flipping the global.
   */
  enabled?: boolean | undefined;
}

/**
 * Decide which CoView viewer to mount. Fail-closed: when the projected viewer is
 * disabled (the default) it resolves to `legacy`, leaving the legacy overlay as the
 * sole production path. When enabled it resolves to `projected`, forwarding only the
 * `serverId` / `sessionId` - it reads and copies no frame data.
 */
export function selectCoViewViewer(args: SelectCoViewViewerArgs): CoViewViewerChoice {
  const enabled = args.enabled ?? CO_VIEW_PROJECTED_VIEWER_ENABLED;
  if (!enabled) return { kind: "legacy" };
  return { kind: "projected", serverId: args.serverId, sessionId: args.sessionId };
}
