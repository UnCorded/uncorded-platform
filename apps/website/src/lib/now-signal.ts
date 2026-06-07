// Module-level shared "now" tick. Components that need to re-render once a
// second to show elapsed time (provisioning checklist row, runtime update
// phase view, etc.) call `useNow()` to get a reactive `Date.now()` accessor.
//
// Also exports `formatElapsed` — the m:ss formatter used alongside the tick.
// Lives here (not the checklist component) so unit tests can import it
// without pulling SolidJS DOM helpers / lucide icons.
//
// Why ref-counted instead of one timer per consumer: a checklist with five
// in-progress rows would otherwise pay five `setInterval` callbacks each
// firing within the same second, plus five SolidJS reactive notifications
// that all run at the same instant. Sharing a single tick collapses that to
// one notification per second total.
//
// The interval only runs while at least one consumer is alive — screens
// that never call `useNow` pay zero cost.

import { createSignal, onCleanup } from "solid-js";

const TICK_MS = 1000;

let timer: ReturnType<typeof setInterval> | null = null;
let refCount = 0;
const [now, setNow] = createSignal(Date.now());

export function useNow(): () => number {
  refCount++;
  if (timer === null) {
    timer = setInterval(() => setNow(Date.now()), TICK_MS);
  }
  onCleanup(() => {
    refCount--;
    if (refCount === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  });
  return now;
}

/** Formats a millisecond duration as `m:ss`. Negative input clamps to `0:00`.
 *  Also exposed via `@/components/ui/progress-checklist` for callers that
 *  already import the checklist surface. */
export function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m)}:${s < 10 ? `0${String(s)}` : String(s)}`;
}
