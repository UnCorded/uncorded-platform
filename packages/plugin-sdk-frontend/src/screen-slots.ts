// Screen-slot reporter — iframe-side helper that watches a placeholder
// `<div data-uc-screen-slot="…">` element and posts its bounding-rect to the
// shell so the shell can paint a `<video>` overlay aligned to it.
//
// PR-6 §6 / contract §3 — the iframe never holds the `MediaStream`; it just
// reports geometry. rAF-coalesced + `ResizeObserver` so a single layout shift
// or scroll burst produces at most one `update-screen-slot` per frame.
//
// The shell is the source of truth for which iframe sent the message
// (`frameKey` is derived from the postMessage source, not user-supplied);
// plugin authors never write that field manually.

import type { VoiceScreenSlotHandle } from "./types";

export interface ObserveScreenSlotDeps {
  /** Posts a message to the shell (already origin-targeted). */
  send: (msg: unknown) => void;
}

/**
 * Begin observing `el` and report its layout rect to the shell as a screen-share
 * slot for `trackSid`. Returns a dispose function that emits
 * `unregister-screen-slot` and tears down all listeners. Idempotent on dispose.
 */
export function observeScreenSlot(
  deps: ObserveScreenSlotDeps,
  el: HTMLElement,
  trackSid: string,
  slotId: string,
): VoiceScreenSlotHandle {
  let disposed = false;
  let rafScheduled = false;
  let registered = false;
  let lastRect: { x: number; y: number; width: number; height: number } | null = null;

  function readRect(): { x: number; y: number; width: number; height: number } {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }

  function rectsEqual(
    a: { x: number; y: number; width: number; height: number } | null,
    b: { x: number; y: number; width: number; height: number },
  ): boolean {
    if (!a) return false;
    return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
  }

  function flush(): void {
    rafScheduled = false;
    if (disposed) return;
    const rect = readRect();
    if (rectsEqual(lastRect, rect)) return;
    lastRect = rect;
    if (!registered) {
      deps.send({
        type: "platform.voice.register-screen-slot",
        slotId,
        trackSid,
        rect,
      });
      registered = true;
    } else {
      deps.send({
        type: "platform.voice.update-screen-slot",
        slotId,
        rect,
      });
    }
  }

  function schedule(): void {
    if (disposed || rafScheduled) return;
    rafScheduled = true;
    // rAF coalesces bursts; if the document is hidden, browsers throttle but
    // still eventually fire (acceptable — slot is invisible anyway).
    requestAnimationFrame(flush);
  }

  // Initial publish on the next frame so the placeholder has been laid out.
  schedule();

  const ro = new ResizeObserver(() => schedule());
  ro.observe(el);

  // Scroll inside the iframe (or any ancestor) shifts `getBoundingClientRect`
  // without firing ResizeObserver; bind a passive listener.
  const onScroll = (): void => schedule();
  window.addEventListener("scroll", onScroll, { passive: true, capture: true });
  window.addEventListener("resize", onScroll);

  return () => {
    if (disposed) return;
    disposed = true;
    ro.disconnect();
    window.removeEventListener("scroll", onScroll, { capture: true } as EventListenerOptions);
    window.removeEventListener("resize", onScroll);
    if (registered) {
      deps.send({
        type: "platform.voice.unregister-screen-slot",
        slotId,
      });
    }
  };
}
