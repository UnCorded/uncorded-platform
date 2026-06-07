// `(pointer: coarse)` media-query primitive — true when the primary input is
// a finger / pen, false when it's a mouse. Used to branch UI affordances that
// should differ on touch vs mouse without conflating with viewport width
// (foldables, iPads with no keyboard, detached-keyboard tablets all want the
// pointer query, not a px breakpoint).
//
// Reactive: subscribes to the MQL so a tablet user docking a Bluetooth mouse
// flips the signal at runtime without a reload. SSR / no-window environments
// (bun:test) return false statically.
//
// Caveat: touchscreen laptops with no mouse plugged in report `coarse`. That
// lumps a small power-user segment in with the mobile cohort. Acceptable v1;
// we'd add an explicit "compact chrome" toggle if anyone complains.

import { createSignal, onCleanup } from "solid-js";

const QUERY = "(pointer: coarse)";

export function useCoarsePointer(): () => boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => false;
  }

  const mql = window.matchMedia(QUERY);
  const [coarse, setCoarse] = createSignal(mql.matches);

  const onChange = (e: MediaQueryListEvent) => setCoarse(e.matches);
  mql.addEventListener("change", onChange);
  onCleanup(() => mql.removeEventListener("change", onChange));

  return coarse;
}
