// WebAppPanel — renders a desktop "Web App" with no browser chrome as an
// always-live native view. Every Web App panel owns a live `WebContentsView` in
// the main process (a movable native surface), so opening, popping out, docking,
// and re-docking all preserve the SAME live session — no `<webview>` reload path.
//
// Identity: the panel's per-instance `instanceId` (minted by the renderer,
// persisted in PanelContent) keys the renderer-only, session-only live-surfaces
// map (live-surfaces.ts). On a fresh open / restart / crash that map is empty, so
// this panel creates a live view loading `url` and binds it to `instanceId`. On a
// remount (panel move, tab switch) the entry already exists → no re-create, the
// live session is kept. Two panels of the same saved URL get distinct instanceIds
// → two independent live views (they still share the `persist:browser` cookie jar,
// so logins carry across).
//
// The live view paints ABOVE renderer DOM and lives in main; LiveViewSurface
// here only reports its on-screen rect (live-surface-host) so main positions
// the view. Release (destroy) is owned elsewhere (App's reconciliation effect /
// web-app removal), so the view survives transient unmounts.
//
// Web/mobile builds can't host a native view; a synced layout could still carry a
// webapp panel onto a non-desktop client, so we render a clear placeholder.

import { Show, onMount } from "solid-js";
import { Globe } from "lucide-solid";
import type { WebAppPanelContent } from "@uncorded/protocol";
import { isElectron } from "@/lib/electron";
import { liveSurfaceId, peekLiveSurface, registerLiveSurface } from "@/lib/live-surfaces";
import { liveSurfaceCreate, liveSurfaceRelease } from "@/stores/web-apps";
import * as liveSurfaceHost from "@/lib/live-surface-host";
import { LiveViewSurface } from "@/components/web-apps/live-view-surface";

// Guard against a double-create when a panel remounts while its first
// liveSurfaceCreate is still in flight: the live-surfaces map isn't populated
// until the await resolves, so peekLiveSurface alone can't dedupe an overlap.
// Keyed by instanceId; cleared once create settles.
const creating = new Set<string>();

export function WebAppPanel(props: { content: WebAppPanelContent; panelId: string }) {
  // Reactive live-view link for this panel instance. Present → render the live
  // native view; absent → still creating (or web build) → loading placeholder.
  const surfaceId = liveSurfaceId(props.content.instanceId);

  // Always-live: ensure a live native view exists for this instanceId. On a fresh
  // open / restart the map is empty, so create one loading the URL and bind it.
  // On remount (panel move) the entry already exists → skip. Web/mobile no-ops.
  onMount(() => {
    if (!isElectron()) return;
    // Kick the rect poll: a panel that mounts while its tab is inactive has a 0×0
    // placeholder, and ResizeObserver doesn't reliably fire on the later
    // activation transition (mirrors the old portalHost.requestSync kick).
    liveSurfaceHost.requestSync();

    const instanceId = props.content.instanceId;
    if (peekLiveSurface(instanceId) !== null) return;
    if (creating.has(instanceId)) return;
    creating.add(instanceId);
    void liveSurfaceCreate(props.content.url)
      .then((sid) => {
        if (sid === null) return;
        // A dock flow (or a racing remount) may have registered a surface for
        // this instance while ours was in flight. If so, our freshly-created view
        // is redundant — release it so it doesn't leak.
        if (peekLiveSurface(instanceId) !== null) {
          void liveSurfaceRelease(sid);
          return;
        }
        registerLiveSurface(instanceId, sid);
      })
      .finally(() => {
        creating.delete(instanceId);
      });
  });

  return (
    <Show
      when={isElectron()}
      fallback={
        <div class="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center select-none">
          <div class="flex size-14 items-center justify-center rounded-2xl bg-muted/50">
            <Globe class="size-7 text-muted-foreground" />
          </div>
          <div class="max-w-xs">
            <p class="text-sm font-medium text-foreground">Web Apps need the desktop app</p>
            <p class="mt-1.5 text-xs text-muted-foreground leading-relaxed">
              <span class="font-mono text-foreground/70 break-all">{props.content.title}</span> runs
              in a native view, available only in the UnCorded desktop app.
            </p>
          </div>
        </div>
      }
    >
      <Show
        when={surfaceId()}
        fallback={
          <div class="flex flex-1 flex-col items-center justify-center gap-3 select-none">
            <div class="size-6 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground" />
            <p class="text-xs text-muted-foreground">Loading…</p>
          </div>
        }
      >
        {(id) => <LiveViewSurface surfaceId={id()} />}
      </Show>
    </Show>
  );
}
