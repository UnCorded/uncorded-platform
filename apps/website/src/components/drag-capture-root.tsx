// <DragCaptureRoot /> — a stable, always-mounted viewport overlay that owns
// pointer capture for the duration of a pointer-drag session.
//
// Why not capture on the source element: per the Pointer Events spec,
// setPointerCapture is released when the capture target is disconnected from
// the DOM. The source leaf may be visually ghosted or re-parented during a
// drag (physical-motion model in PR-C), so capturing there is spec-brittle.
// A dedicated overlay that never unmounts avoids the problem.
//
// The element itself stays at pointer-events: none until a drag threshold is
// crossed; only then does drag-state.ts set it to "auto" and grab capture.
// Z-index sits between normal portal iframes (40) and modals (50) so the
// capture surface can intercept pointer events over the workspace without
// obscuring modals that might open mid-drag.

import { onMount, onCleanup } from "solid-js";
import {
  registerDragCaptureRoot,
  unregisterDragCaptureRoot,
} from "@/lib/drag-state";

export function DragCaptureRoot() {
  let rootRef!: HTMLDivElement;

  onMount(() => {
    registerDragCaptureRoot(rootRef);
    onCleanup(() => unregisterDragCaptureRoot(rootRef));
  });

  return (
    <div
      ref={rootRef}
      data-drag-capture-root
      aria-hidden="true"
      style={{
        position: "fixed",
        inset: "0",
        "pointer-events": "none",
        "z-index": "48",
        "touch-action": "none",
      }}
    />
  );
}
