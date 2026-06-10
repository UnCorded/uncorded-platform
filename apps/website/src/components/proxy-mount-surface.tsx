// ProxyMountSurface — one host-owned reverse-proxy surface, positioned over the
// viewport rect a plugin iframe reserved via `sdk.proxy.reserveMount()`.
//
// The plugin panel stays `type:"plugin"`; the HOST promotes an approved mount
// into a surface it owns and positions. This is the proxy analogue of a
// screen-share <video> tile (screen-share-overlay.tsx): the rect the plugin
// reports is iframe-LOCAL, so we project it into shell coordinates by adding the
// plugin iframe's portal-host mount rect, then clamp to that rect so a
// resize/scroll race can never paint the surface outside the plugin panel.
//
// Web path (this phase): bootstrap the proxy session, probe whether the proxied
// URL can be framed, and render a sandboxed <iframe> (reusing IframeSurface,
// which portals the element into PortalContainer so panel rearranges don't
// reload it). An upstream that refuses framing (X-Frame-Options / restrictive
// frame-ancestors) shows an "Open in browser" prompt instead — the desktop
// <webview> path that escapes those restrictions arrives in a later chunk.
//
// The real surface element lives in PortalContainer (z-40), positioned to mirror
// this component's placeholder. This overlay layer only carries the placeholder,
// so it stays `pointer-events:none`; input lands on the portaled element, which
// portal-host marks `pointer-events:auto`.

import {
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
} from "solid-js";
import type { Accessor } from "solid-js";
import { checkCanFrame } from "@/api/central";
import { bootstrapProxyMount } from "@/api/runtime";
import { proxyMountSurfaceKey } from "@/lib/surface-key";
import { isElectron } from "@/lib/electron";
import * as portalHost from "@/lib/portal-host";
import { projectViewportRect, type OverlayRect } from "@/lib/proxy-mount-geometry";
import type { ProxyMountEntry } from "@/lib/proxy-mount-manager";
import { IframeSurface, WebviewSurface } from "@/components/browser-panel";

export function ProxyMountSurface(props: {
  entry: ProxyMountEntry;
  layoutTick: Accessor<number>;
}) {
  // Stable across this reservation's lifetime — keys the portal mount so
  // adoption/teardown go through the proxy surface, never collide with the
  // plugin panel or a browser panel.
  const key = createMemo(() =>
    proxyMountSurfaceKey(props.entry.serverId, props.entry.slug, props.entry.mountName),
  );

  // Shell-space, clamped placeholder rect. Recomputes every layoutTick and on
  // any rect mutation; the plugin reports iframe-local coords, so project by the
  // plugin iframe's portal mount rect (fall back to a live getBoundingClientRect
  // before the portal has a rect) and clamp to it. Mirrors screen-share-overlay.
  const shellRect = createMemo<OverlayRect>(() => {
    props.layoutTick();
    const r = props.entry.rect;
    const mountRect = portalHost.getMountRect(props.entry.frameKey);
    const frameRect = mountRect
      ? { x: mountRect.x, y: mountRect.y, width: mountRect.w, height: mountRect.h }
      : props.entry.iframe.getBoundingClientRect();
    return projectViewportRect(r, frameRect);
  });

  // Bootstrap the proxy session once. `props.entry` is a stable reference for
  // the reservation's lifetime (the manager mutates rect in place, never the
  // object), so the source never churns and the POST fires exactly once.
  const [bootstrap] = createResource(
    () => props.entry,
    (entry) =>
      bootstrapProxyMount(entry.tunnelUrl, entry.serverId, entry.slug, entry.mountName),
  );

  // Can the proxied URL be framed on the web? An upstream that sends
  // X-Frame-Options: DENY / a restrictive frame-ancestors can't be embedded
  // here — fall back to the first-party "Open in browser" affordance.
  const [probe, setProbe] = createSignal<"checking" | "allowed" | "blocked">("checking");
  // IframeSurface also reports framing failures it only learns at load time
  // (the probe can't catch every case); treat that as blocked too.
  const [loadBlocked, setLoadBlocked] = createSignal(false);

  createEffect(() => {
    const b = bootstrap();
    if (!b) return;
    // Desktop renders the proxied app in a <webview>, which escapes framing
    // restrictions entirely — the can-frame probe is a web-only concern.
    if (isElectron()) return;
    setProbe("checking");
    setLoadBlocked(false);
    checkCanFrame(b.url)
      .then((ok) => setProbe(ok ? "allowed" : "blocked"))
      // A probe failure (network/central hiccup) shouldn't block a framable
      // app — optimistically allow; a real framing refusal still trips the
      // load-time onBlocked path below.
      .catch(() => setProbe("allowed"));
  });

  // Real teardown when the reservation ends (manager unregister → overlay
  // removes this component). IframeSurface.onCleanup only hides (unmount); we
  // own the surface key, so destroy it for good to avoid leaking the iframe.
  onCleanup(() => {
    portalHost.destroyByKey(key());
  });

  return (
    <div
      data-proxy-mount-surface={props.entry.mountName}
      style={{
        position: "absolute",
        left: `${shellRect().x}px`,
        top: `${shellRect().y}px`,
        width: `${shellRect().width}px`,
        height: `${shellRect().height}px`,
        // Hide (without unmounting) while the panel is on a background tab or
        // not yet laid out — a zero box means the plugin iframe is hidden.
        display: shellRect().width === 0 || shellRect().height === 0 ? "none" : "flex",
        "flex-direction": "column",
        // The placeholder is inert; the portaled surface (in PortalContainer)
        // captures input. Keep this layer click-through.
        "pointer-events": "none",
      }}
    >
      <Show when={bootstrap()} fallback={<ProxyStatus label="Connecting…" spin />}>
        {(b) => (
          <Show
            when={isElectron()}
            fallback={
              // Web: probe whether the proxied URL can be framed, then embed a
              // sandboxed <iframe> or fall back to "Open in browser".
              <Switch fallback={<ProxyStatus label="Checking…" spin />}>
                <Match when={probe() === "allowed" && !loadBlocked()}>
                  <IframeSurface
                    mountKey={key()}
                    url={b().url}
                    onBlocked={() => setLoadBlocked(true)}
                  />
                </Match>
                <Match when={probe() === "blocked" || loadBlocked()}>
                  <ProxyOpenInBrowser url={b().url} openUrl={b().openUrl} />
                </Match>
              </Switch>
            }
          >
            {/* Desktop: a hardened <webview> on a per-server partition. Load
                `openUrl` (not `url`) — the single-use ticket mints the proxy-
                session cookie first-party inside the partition jar before
                redirecting into the mount, which is the only path that works
                when the framed cookie would be blocked. */}
            <WebviewSurface
              mountKey={key()}
              url={b().openUrl}
              partition={`persist:proxy:${props.entry.serverId}`}
              onElementReady={() => {
                // Register this guest with the main process so it can pin the
                // webview's navigation to its mount and gate permission
                // requests. Pin to the mount URL (`/proxy/<slug>/<mount>/`),
                // NOT openUrl — openUrl is the one-shot cookie-minting redirect
                // that lands the guest on the mount URL. Both are absolute
                // (bootstrapProxyMount absolutized them against tunnelUrl).
                const bridge = window.electron?.proxy;
                if (!bridge) return;
                let mountUrl: URL;
                try {
                  mountUrl = new URL(b().url);
                } catch {
                  return;
                }
                void bridge
                  .registerGuest({
                    partition: `persist:proxy:${props.entry.serverId}`,
                    mountOrigin: mountUrl.origin,
                    mountPathPrefix: mountUrl.pathname,
                  })
                  .catch(() => {
                    // Best-effort: a registration failure leaves the guest
                    // unpinned but still sandboxed by the global
                    // will-attach-webview hardening. Nothing actionable here.
                  });
              }}
              onElementReleased={() => {}}
            />
          </Show>
        )}
      </Show>
    </div>
  );
}

function ProxyStatus(props: { label: string; spin?: boolean }) {
  return (
    <div
      class="flex flex-1 flex-col items-center justify-center gap-3 p-6 select-none"
      style={{ "pointer-events": "auto" }}
    >
      <Show when={props.spin}>
        <div class="size-6 rounded-full border-2 border-muted border-t-muted-foreground animate-spin" />
      </Show>
      <p class="text-xs text-muted-foreground">{props.label}</p>
    </div>
  );
}

function ProxyOpenInBrowser(props: { url: string; openUrl: string }) {
  const host = () => {
    try {
      return new URL(props.url).hostname;
    } catch {
      return props.url;
    }
  };
  return (
    <div
      class="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center select-none"
      style={{ "pointer-events": "auto" }}
    >
      <div class="max-w-xs">
        <p class="text-sm font-medium text-foreground">This app can’t be embedded here</p>
        <p class="mt-1.5 text-xs text-muted-foreground leading-relaxed">
          <span class="font-mono text-foreground/70 break-all">{host()}</span> blocks framing.
          Open it in your browser, or use the UnCorded desktop app to run it natively.
        </p>
      </div>
      <a
        href={props.openUrl}
        target="_blank"
        rel="noopener noreferrer"
        class="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
      >
        Open in browser
      </a>
    </div>
  );
}
