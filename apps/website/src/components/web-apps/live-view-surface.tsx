// LiveViewSurface — the live-view analog of WebviewSurface. Where
// WebviewSurface portals a DOM <webview>, this renders a plain placeholder div
// and reports its on-screen rect to the main process, which positions a native
// `WebContentsView` over it. The view itself lives in main (it holds the
// popup's preserved session — cookies + sessionStorage + opener); here we only
// own its geometry.
//
// Lifecycle: onMount → live-surface-host.track(surfaceId, el); onCleanup →
// untrack (reports visible:false so main parks the view off-screen). We do NOT
// release the view here — release is owned by panel-close / web-app-removal /
// floating-frame dismissal. That separation is what lets the live view survive
// transient unmounts (tab switch, fullscreen toggle) the same way portaled
// webviews do.
//
// Because the native view paints ABOVE this div, nothing rendered inside it
// would be visible — so the placeholder is intentionally empty.

import { onCleanup, onMount } from "solid-js";
import * as liveSurfaceHost from "@/lib/live-surface-host";

export function LiveViewSurface(props: { surfaceId: number }) {
  let placeholder!: HTMLDivElement;

  onMount(() => {
    liveSurfaceHost.track(props.surfaceId, placeholder);
  });

  onCleanup(() => {
    liveSurfaceHost.untrack(props.surfaceId, placeholder);
  });

  return <div class="relative flex-1 min-h-0" ref={placeholder} />;
}
