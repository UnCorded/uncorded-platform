// Cinematic transition driver for the runtime-update flow.
//
// When the user clicks "Restart to apply update" the workspace shell does an
// outside-in radial collapse over ~600ms (clip-path: circle(150%) → circle(0%)).
// The post-update overlay is mounted as a sibling of the clipped shell, so it
// remains visible during the collapsed state and carries the "update
// installing — don't kill the process" copy through the install phase. After
// install completes and the user clicks Continue, the overlay fades, then the
// workspace expands inside-out (circle(0%) → circle(150%)).
//
// State machine (linear cycle, debounced — late "open" while still mid-close
// is rejected to avoid a fight with the in-flight transition):
//   idle       → workspace fully visible (clip-path: circle(150%)). Default.
//   closing    → clip-path animating to circle(0%) over CINEMATIC_DURATION_MS.
//   open       → clip held at circle(0%), workspace invisible to the user.
//   opening    → clip-path animating back to circle(150%).
//   → idle
//
// We use a single module-scoped signal because the workspace shell is shared;
// the cinematic only fires for the active server's update so per-server
// scoping isn't needed. The CSS transition lives on the workspace wrapper and
// transitions on data-attribute changes, so React-style "fade duration must
// match JS timeout" pitfalls don't apply — the JS just sets the next steady
// state at the right time.

import { createSignal } from "solid-js";

export type CinematicState = "idle" | "closing" | "open" | "opening";

// Matches the `animation: ... 750ms` declarations in `index.css` for the
// `.cinematic-shell[data-cinematic="closing"]` / `="opening"` rules. Keep
// in sync — JS commits the next steady-state after this elapses.
export const CINEMATIC_DURATION_MS = 750;

const [state, setState] = createSignal<CinematicState>("idle");

export function cinematicState(): CinematicState {
  return state();
}

/** Begin the outside-in collapse. Resolves once the workspace is fully
 *  hidden (held at the shutdown end-frame). Safe to call when already
 *  closing/open — returns immediately in that case. */
export async function runCinematicClose(): Promise<void> {
  const current = state();
  if (current === "closing" || current === "open") return;
  setState("closing");
  await wait(CINEMATIC_DURATION_MS);
  // Only commit to "open" if nothing else has driven the state in the
  // meantime (defensive — performUpdate is serialized so this shouldn't
  // happen, but guards against a stale runCinematicOpen() racing past us).
  if (state() === "closing") {
    setState("open");
    notifyCinematicSettled();
  }
}

/** Begin the inside-out expand. Resolves once the workspace is fully
 *  visible again. Safe to call when already opening/idle. */
export async function runCinematicOpen(): Promise<void> {
  const current = state();
  if (current === "opening" || current === "idle") return;
  setState("opening");
  await wait(CINEMATIC_DURATION_MS);
  if (state() === "opening") {
    setState("idle");
    notifyCinematicSettled();
  }
}

/** Force every layout-sensitive consumer (PortalContainer's iframe clip,
 *  ResizeObservers, panel-split trackers) to re-measure once the cinematic
 *  has finished and the cinematic-shell's transform/will-change have been
 *  released. Without this nudge, fixed-positioned descendants that were
 *  bound to the transformed shell mid-animation can hold on to stale clip
 *  bounds — typical symptom is iframes appearing clipped to the screen
 *  centre until the user manually resizes the window.
 *
 *  Schedules on the next frame so the data-attribute change has paint
 *  time to demote the layer before observers re-fire. */
function notifyCinematicSettled(): void {
  if (typeof window === "undefined") return;
  requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
}

/** Reset to idle without animating. Used for hard-error paths where we
 *  need to surface the workspace immediately (e.g. update was abandoned
 *  via cancelPendingRestarts and we want the operator back in business). */
export function resetCinematic(): void {
  setState("idle");
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Test seam — clears state. Not exported from the package barrel.
// ---------------------------------------------------------------------------

export function _resetCinematicForTests(): void {
  setState("idle");
}
