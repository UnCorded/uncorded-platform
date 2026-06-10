// Proxy-mount viewport reporter — iframe-side helper that watches a placeholder
// element and posts its bounding-rect to the shell so the shell can position a
// host-owned proxy surface (a dedicated Electron <webview> on desktop, a
// sandboxed <iframe> on web) aligned to it.
//
// This is the proxy-mount analogue of `observeScreenSlot` (screen-slots.ts):
// the iframe never holds the surface — it only reports geometry. rAF-coalesced
// + `ResizeObserver` so a layout shift or scroll burst produces at most one
// `update-viewport` per frame.
//
// The shell is the source of truth for which iframe sent the message and which
// server/plugin it belongs to (frameKey + serverId + slug are derived from the
// postMessage source and the trusted PluginFrame scope, never this payload);
// plugin authors only choose the mount name and the placeholder element.

export interface ObserveProxyViewportDeps {
  /** Posts a message to the shell (already origin-targeted). */
  send: (msg: unknown) => void;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Dispose handle returned by `sdk.proxy.reserveMount(mount, el)`. Idempotent. */
export type ProxyViewportHandle = () => void;

/**
 * Begin observing `el` and report its layout rect to the shell as the viewport
 * for proxy `mount` of plugin `slug`. Returns a dispose function that emits
 * `unregister-viewport` and tears down all listeners. Idempotent on dispose.
 */
export function observeProxyViewport(
  deps: ObserveProxyViewportDeps,
  el: HTMLElement,
  slug: string,
  mount: string,
): ProxyViewportHandle {
  let disposed = false;
  let rafScheduled = false;
  let registered = false;
  let lastRect: Rect | null = null;

  function readRect(): Rect {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }

  function rectsEqual(a: Rect | null, b: Rect): boolean {
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
        type: "platform.proxy.register-viewport",
        slug,
        mountName: mount,
        rect,
      });
      registered = true;
    } else {
      deps.send({
        type: "platform.proxy.update-viewport",
        mountName: mount,
        rect,
      });
    }
  }

  function schedule(): void {
    if (disposed || rafScheduled) return;
    rafScheduled = true;
    // rAF coalesces bursts; if the document is hidden, browsers throttle but
    // still eventually fire (acceptable — the surface is invisible anyway).
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
        type: "platform.proxy.unregister-viewport",
        mountName: mount,
      });
    }
  };
}
