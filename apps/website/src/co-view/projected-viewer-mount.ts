// CoView projected viewer mount - wiring core (CV-FOUND-7).
//
// Connects the dormant projected-frame receive path to the sanitized viewer
// renderer: `createProjectedFrameStore(serverId)` -> latest frame for a
// `sessionId` -> `CoViewProjectedFrameView`. This module holds the *testable*
// lifecycle logic as a small imperative controller; the thin Solid component
// (`projected-viewer-mount-view.tsx`) is a declarative wrapper over it. The split
// mirrors `render-tree-viewer.ts` (pure, tested) vs `render-tree-viewer-view.tsx`
// (view, typecheck-only) - element templates in a `.tsx` touch `document` at
// module load, so the unit-testable logic lives here in a DOM-free `.ts`.
//
// Dormant by default: `CO_VIEW_PROJECTED_VIEWER_ENABLED` (render-tree-viewer.ts)
// stays false, so the controller short-circuits to an inert, store-less form and
// the component renders nothing. A test (or the next CV-FOUND PR) opts in via the
// `enabled` flag, injecting a store factory rather than dialing a real socket.
//
// The mount path is a pure pass-through of already-projected frames: it reads the
// store's stored `CoViewProjectedRenderFrame` and never synthesizes a value, so -
// exactly like `projected-frame-store.ts` - it can introduce no protected bytes.
// Every projection/privacy decision already happened upstream (runtime projector
// -> projected-frame-store -> render-tree-viewer).

import type { CoViewProjectedRenderFrame } from "@uncorded/protocol";

import { createProjectedFrameStore, type ProjectedFrameStore } from "./projected-frame-store";
import { CO_VIEW_PROJECTED_VIEWER_ENABLED } from "./render-tree-viewer";

/** Factory shape for the projected-frame store, injectable for tests. */
export type ProjectedFrameStoreFactory = (serverId: string) => ProjectedFrameStore;

/** Injectable dependencies / overrides for the mount controller. */
export interface ProjectedViewerMountDeps {
  /**
   * Master switch. Defaults to `CO_VIEW_PROJECTED_VIEWER_ENABLED` (false), so
   * production callers stay dormant; a test passes `true` to exercise the path.
   */
  enabled?: boolean | undefined;
  /**
   * Store factory, defaulting to `createProjectedFrameStore`. Injected in tests
   * to assert construction/disposal and seed frames without dialing a socket.
   */
  createStore?: ProjectedFrameStoreFactory | undefined;
}

/**
 * The small imperative surface the Solid component drives. When disabled it is
 * inert: `active` is false, no store was constructed, and `frame()` always yields
 * `undefined`, so nothing can mount.
 */
export interface ProjectedViewerMountController {
  /** Whether a store was constructed (i.e. the path is live for this mount). */
  readonly active: boolean;
  /** Latest projected frame stored for `sessionId`, or `undefined` if none. */
  frame: (sessionId: string) => CoViewProjectedRenderFrame | undefined;
  /** Tear down the underlying store subscription. */
  dispose: () => void;
}

/**
 * The shared no-op controller returned on the dormant path. It constructs no
 * store and subscribes to nothing - disposal is a safe no-op.
 */
const INERT_CONTROLLER: ProjectedViewerMountController = {
  active: false,
  frame: () => undefined,
  dispose: () => {},
};

/**
 * Build the mount controller for one `serverId`. Fail-closed: when the viewer is
 * disabled it returns the inert controller WITHOUT calling the store factory -
 * the dormant path must construct and subscribe to nothing. When enabled it
 * constructs exactly one store and exposes a by-session frame read plus disposal.
 */
export function createProjectedViewerMountController(
  serverId: string,
  deps: ProjectedViewerMountDeps = {},
): ProjectedViewerMountController {
  const enabled = deps.enabled ?? CO_VIEW_PROJECTED_VIEWER_ENABLED;
  if (!enabled) return INERT_CONTROLLER;

  const create = deps.createStore ?? createProjectedFrameStore;
  const store = create(serverId);
  return {
    active: true,
    frame: (sessionId: string) => store.frame(sessionId),
    dispose: () => store.dispose(),
  };
}
