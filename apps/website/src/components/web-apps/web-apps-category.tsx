// Desktop-only "Web Apps" sidebar category — the one sanctioned exception to
// "the sidebar renders what the runtime provides" (memory:
// desktop-owned-web-apps-sidebar). The list is per-server but desktop-local
// (~/.uncorded/web-apps.json), never synced. Clicking a row opens the page as a
// warm, login-sticky browser panel inside UnCorded; the X removes it.
//
// Mounted inside the activeServer() Show in app-sidebar, but still self-guards
// on isElectron() so a plain web build renders nothing.

import { For, Show, createEffect, createSignal } from "solid-js";
import { Globe, X } from "lucide-solid";
import type { WebApp } from "@uncorded/electron-bridge";
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { isElectron } from "@/lib/electron";
import { activeServer } from "@/stores/servers";
import { webAppsFor, loadWebApps, removeWebApp } from "@/stores/web-apps";
import { isCollapsed, toggleCollapsed } from "@/stores/sidebar-collapse";
import {
  shouldIgnoreDragStart,
  startPointerDrag,
  type DropTarget,
} from "@/lib/drag-state";

// Match nav-sidebar-sections.tsx so the category sits flush with plugin groups.
const GROUP_CLASS = "px-2 py-1";
const LABEL_CLASS = "h-7 select-none transition-colors hover:text-sidebar-foreground";
const MENU_CLASS = "gap-0.5";
const ITEM_CLASS =
  "group/webapp peer/menu-button flex w-full items-center gap-2 overflow-hidden rounded-md px-2 py-1 text-sm h-7 cursor-pointer hover:bg-sidebar-accent hover:text-sidebar-accent-foreground transition-colors select-none";

const COLLAPSE_KEY = "webapps";

function CollapsibleContent(props: { open: boolean; children: import("solid-js").JSX.Element }) {
  return (
    <div
      class="grid transition-[grid-template-rows] duration-200 ease-out"
      style={{ "grid-template-rows": props.open ? "1fr" : "0fr" }}
    >
      <div class="overflow-hidden">{props.children}</div>
    </div>
  );
}

function WebAppFavicon(props: { app: WebApp }) {
  const [failed, setFailed] = createSignal(false);
  return (
    <Show
      when={props.app.faviconUrl && !failed()}
      fallback={<Globe class="size-3.5 shrink-0 text-muted-foreground" />}
    >
      <img
        src={props.app.faviconUrl}
        alt=""
        class="size-3.5 shrink-0 rounded-sm object-contain"
        onError={() => setFailed(true)}
      />
    </Show>
  );
}

export function WebAppsCategory(props: {
  onOpenWebApp: (app: WebApp) => void;
  onWebAppDrop: (app: WebApp, target: DropTarget) => void;
}) {
  if (!isElectron()) return null;

  // Web App rows are draggable into the workspace like normal sidebar items
  // (drop into a leaf/edge) AND clickable to open in the active leaf — the
  // click-vs-drag threshold in startPointerDrag keeps both gestures on one row.
  const onRowPointerDown = (app: WebApp, e: PointerEvent) => {
    if (e.button !== 0) return;
    if (shouldIgnoreDragStart(e.target)) return; // exempts the X remove button
    startPointerDrag({
      payload: {
        kind: "web-app",
        app: {
          id: app.id,
          url: app.url,
          title: app.title,
          ...(app.faviconUrl ? { faviconUrl: app.faviconUrl } : {}),
        },
      },
      pointerEvent: e,
      onCommit: (target) => props.onWebAppDrop(app, target),
      onCancel: () => {},
    });
  };

  const open = () => !isCollapsed(COLLAPSE_KEY);
  const apps = () => {
    const server = activeServer();
    return server ? webAppsFor(server.id) : [];
  };

  // Refetch whenever the active server changes — the list is per-server.
  createEffect(() => {
    const server = activeServer();
    if (server) void loadWebApps(server.id);
  });

  return (
    <Show when={apps().length > 0}>
      <SidebarGroup class={GROUP_CLASS}>
        <SidebarGroupLabel class={LABEL_CLASS} onClick={() => toggleCollapsed(COLLAPSE_KEY)}>
          <span class="truncate">Web Apps</span>
        </SidebarGroupLabel>
        <CollapsibleContent open={open()}>
          <SidebarMenu class={MENU_CLASS}>
            <For each={apps()}>
              {(app) => (
                <SidebarMenuItem>
                  <div
                    class={ITEM_CLASS}
                    onPointerDown={(e) => onRowPointerDown(app, e)}
                    onClick={() => props.onOpenWebApp(app)}
                  >
                    <WebAppFavicon app={app} />
                    <span class="flex-1 truncate">{app.title}</span>
                    <button
                      type="button"
                      class="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground opacity-0 pointer-events-none group-hover/webapp:opacity-100 group-hover/webapp:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      aria-label={`Remove ${app.title}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        const server = activeServer();
                        if (server) void removeWebApp(server.id, app.id);
                      }}
                    >
                      <X class="size-3" />
                    </button>
                  </div>
                </SidebarMenuItem>
              )}
            </For>
          </SidebarMenu>
        </CollapsibleContent>
      </SidebarGroup>
    </Show>
  );
}
