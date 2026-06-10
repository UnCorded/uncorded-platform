// ProxyMountOverlay — top-level shell layer that paints one host-owned proxy
// surface (ProxyMountSurface) over each viewport a plugin iframe reserved via
// `sdk.proxy.reserveMount()`. The proxy analogue of ScreenShareOverlay.
//
// Mounted once at the App root, beside ScreenShareOverlay. It carries only the
// per-mount placeholders; the real surfaces (sandboxed <iframe> on web, a
// hardened <webview> on desktop) live in PortalContainer (z-40), positioned to
// mirror their placeholder. So this layer is `pointer-events:none` and its
// z-index is irrelevant to input — it exists purely to host the placeholders
// the proxy manager tracks.
//
// `<For>` keys by reference. proxy-mount-manager keeps each entry object stable
// for its reservation's lifetime (rect mutates in place), so a stable entry maps
// to a stable ProxyMountSurface — the surface never remounts (and the webview
// never reloads) on a rect update; only an add/remove re-runs <For>.

import { For, createSignal, onCleanup, onMount } from "solid-js";
import { proxyMounts$ } from "@/lib/proxy-mount-manager";
import { ProxyMountSurface } from "@/components/proxy-mount-surface";

export function ProxyMountOverlay() {
  // Re-tick on scroll/resize and every animation frame so each surface tracks
  // its plugin iframe's movement. The reserve-viewport envelopes only fire on
  // *iframe-internal* layout changes, so shell scroll/resize would otherwise
  // leave a surface stuck at the old offset (same rationale as ScreenShareOverlay).
  const [layoutTick, setLayoutTick] = createSignal(0);

  onMount(() => {
    const bump = (): void => {
      setLayoutTick((n) => n + 1);
    };
    window.addEventListener("scroll", bump, { passive: true, capture: true });
    window.addEventListener("resize", bump);
    let raf = requestAnimationFrame(function tick() {
      bump();
      raf = requestAnimationFrame(tick);
    });
    onCleanup(() => {
      window.removeEventListener("scroll", bump, { capture: true } as EventListenerOptions);
      window.removeEventListener("resize", bump);
      cancelAnimationFrame(raf);
    });
  });

  return (
    <div
      data-proxy-mount-overlay
      aria-hidden="true"
      style={{
        position: "fixed",
        inset: "0",
        // Click-through: the portaled surfaces (in PortalContainer) capture
        // input; this layer only hosts their placeholders.
        "pointer-events": "none",
        "z-index": "40",
      }}
    >
      <For each={proxyMounts$()}>
        {(entry) => <ProxyMountSurface entry={entry} layoutTick={layoutTick} />}
      </For>
    </div>
  );
}
