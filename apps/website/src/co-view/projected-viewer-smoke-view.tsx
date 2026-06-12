// CoView projected viewer smoke harness - thin Solid composition (CV-FOUND-9).
//
// Test-only. Composes the REAL component chain the projected branch runs -
// `CoViewViewerSelector` -> `CoViewProjectedViewerMount` -> injected
// `ProjectedFrameStore` -> `CoViewProjectedFrameView` - with the projected arm
// selected through the selector's own DI seam (`projectedEnabled`), never the
// global flag. This proves by typecheck that the integrated `.tsx` chain
// composes end-to-end; the same pipeline's behavior is unit-tested DOM-free in
// `projected-viewer-smoke.ts` / `projected-viewer-smoke.test.ts` (this repo has
// no DOM test environment - exactly why `viewer-selector-view.tsx` and
// `projected-viewer-mount-view.tsx` are typecheck-only too).
//
// Dormant and production-safe: no live module imports this file, and the live
// `App.tsx` call site is untouched - production still mounts the selector with
// `projectedEnabled` undefined, so the legacy `ViewerSession` remains the sole
// production path. This wrapper forwards IDs and a store factory only; it reads
// and synthesizes no frame data, so it can introduce no protected bytes.

import type { JSX } from "solid-js";

import type { ProjectedFrameStoreFactory } from "./projected-viewer-mount";
import { CoViewViewerSelector } from "./viewer-selector-view";

export interface CoViewProjectedViewerSmokeHarnessProps {
  /** Server whose projected frames the injected store receives. */
  serverId: string;
  /** CoView session to mirror. */
  sessionId: string;
  /**
   * The injected store factory - the smoke seam. Required here (unlike the
   * selector's optional prop) because the harness exists precisely to exercise
   * the injected-store path; a test seeds frames through the store it builds.
   */
  createStore: ProjectedFrameStoreFactory;
}

/**
 * Mount the real selector with the projected arm selected via DI. The selector
 * then mounts `CoViewProjectedViewerMount`, which builds its controller over the
 * injected store and renders `CoViewProjectedFrameView` for the latest stored
 * frame - the full integrated chain, selected without touching the global flag.
 */
export function CoViewProjectedViewerSmokeHarness(
  props: CoViewProjectedViewerSmokeHarnessProps,
): JSX.Element {
  return (
    <CoViewViewerSelector
      serverId={props.serverId}
      sessionId={props.sessionId}
      // The legacy `ViewerSession` props the selector's fallback arm requires.
      // On this harness the projected arm is always selected, so they are inert;
      // they exist to satisfy the seam's full prop surface.
      initialSnapshot={null}
      onLeft={() => {}}
      projectedEnabled={true}
      createStore={props.createStore}
    />
  );
}
