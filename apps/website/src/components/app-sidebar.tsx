import { createEffect, onCleanup, onMount, Show, For, createSignal, type JSX } from "solid-js";
import { Compass, LifeBuoy, Plus, ScreenShare, Send, Settings, Wifi, WifiOff } from "lucide-solid";
import { useImgRetry } from "@/lib/img-retry";
import { NavSidebarSections } from "@/components/nav-sidebar-sections";
import { WebAppsCategory } from "@/components/web-apps/web-apps-category";
import type { WebApp } from "@uncorded/electron-bridge";
import { NavSecondary } from "@/components/nav-secondary";
import { NavUser } from "@/components/nav-user";
import { VoiceIndicator } from "@/components/voice-indicator";
import { ServerSwitcher, openExploreServers } from "@/components/server-switcher";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { loadServers, servers, serversLoading, serversError, activeServer, setActiveServer, getServerIconVersion } from "@/stores/servers";
import { sections, sidebarLoading, sidebarError } from "@/stores/sidebar";
import type { SidebarItem } from "@/stores/sidebar";
import { dragContext, type DropTarget } from "@/lib/drag-state";
import { CreateServerWizard } from "@/components/server/create-server-wizard";
import { ServerSettingsSheet } from "@/components/server/server-settings-sheet";
import { SupportSheet } from "@/components/support-sheet";
import { emitCoViewSheetOpen } from "@/lib/co-view-events";
import { UpdatePill } from "@/components/ui/update-pill";
import { onServerSettingsOpen, type ServerSettingsTab } from "@/lib/server-settings-events";
import type { NavSecondaryItem } from "@/components/nav-secondary";

// Per-server icon for the no-server-selected list. Uses the same retry-with-
// backoff helper as ServerSwitcher's main avatar so a transient /icon failure
// during runtime warm-up doesn't permanently fall back to the letter avatar.
function NoServerIcon(props: { serverId: string; tunnelUrl: string; name: string }): JSX.Element {
  const iconUrl = (): string | null => {
    const raw = props.tunnelUrl;
    if (!/^https?:\/\//i.test(raw)) return null;
    const v = getServerIconVersion(props.serverId);
    return v > 0 ? `${raw}/icon?v=${String(v)}` : `${raw}/icon`;
  };
  const retry = useImgRetry(iconUrl);
  const showImg = () => iconUrl() !== null && !retry.exhausted();
  return (
    <Show
      when={showImg()}
      fallback={<span>{props.name.charAt(0).toUpperCase()}</span>}
    >
      <img
        src={retry.srcWithCacheBuster()}
        alt={props.name}
        class="size-full object-cover"
        classList={{ "opacity-0": !retry.loaded() }}
        onLoad={retry.handleLoad}
        onError={retry.handleError}
      />
    </Show>
  );
}

// Ghost-row skeleton shown while sidebar is hydrating. Mimics the typical
// sidebar layout (small icon + text rectangle) so the user sees structure
// landing instead of a single spinner that reads as "broken." Distinct from
// the empty-after-load state, which surfaces an error message.
function SidebarSkeleton(): JSX.Element {
  return (
    <div class="flex flex-col gap-1 px-2 py-3">
      <div class="px-2 pb-2">
        <div class="h-3 w-20 animate-pulse rounded bg-muted-foreground/10" />
      </div>
      <For each={[0, 1, 2, 3]}>
        {() => (
          <div class="flex items-center gap-2 rounded-md px-2 py-1.5">
            <div class="size-4 animate-pulse rounded bg-muted-foreground/10" />
            <div class="h-3 flex-1 max-w-[140px] animate-pulse rounded bg-muted-foreground/10" />
          </div>
        )}
      </For>
    </div>
  );
}

// Server list shown when no server is selected (no bottom actions — those live in AppSidebar).
function NoServerState() {
  return (
    <div class="flex flex-col flex-1 overflow-y-auto">
      <Show when={!serversLoading() && servers().length > 0}>
        <div class="px-2 pt-2 pb-1">
          <p class="px-2 py-1 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
            Your servers
          </p>
          <For each={servers()}>
            {(server) => (
              <button
                type="button"
                class="flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                onClick={() => setActiveServer(server.id)}
              >
                <div class="relative shrink-0">
                  <div class="flex size-6 items-center justify-center rounded-sm bg-muted text-muted-foreground text-xs font-bold overflow-hidden">
                    <Show
                      when={server.tunnel_url}
                      fallback={<span>{server.name.charAt(0).toUpperCase()}</span>}
                    >
                      {(url) => <NoServerIcon serverId={server.id} tunnelUrl={url()} name={server.name} />}
                    </Show>
                  </div>
                  <span
                    class="absolute -bottom-0.5 -right-0.5 size-2 rounded-full border border-sidebar"
                    classList={{
                      "bg-emerald-500": server.is_online,
                      "bg-muted-foreground/40": !server.is_online,
                    }}
                  />
                </div>
                <span class="flex-1 truncate text-left">{server.name}</span>
                <Show
                  when={server.is_online}
                  fallback={<WifiOff class="size-3 shrink-0 text-muted-foreground/40" />}
                >
                  <Wifi class="size-3 shrink-0 text-emerald-500" />
                </Show>
              </button>
            )}
          </For>
        </div>
        <div class="mx-4 my-2 h-px bg-border" />
      </Show>

      <Show when={serversLoading()}>
        <div class="flex items-center justify-center py-8">
          <div class="size-4 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground" />
        </div>
      </Show>

      <Show when={!serversLoading() && servers().length === 0 && !serversError()}>
        <div class="flex flex-col items-center gap-2 px-4 py-8 text-center">
          <div class="flex size-10 items-center justify-center rounded-xl bg-muted/40">
            <img src="/uncorded-icon.png" alt="" class="size-6 object-contain opacity-40" />
          </div>
          <p class="text-sm font-medium text-muted-foreground">No servers yet</p>
          <p class="text-xs text-muted-foreground/60">
            Create your first server to get started.
          </p>
        </div>
      </Show>

      <Show when={!serversLoading() && servers().length === 0 && serversError()}>
        <div class="flex flex-col items-center gap-2 px-4 py-8 text-center">
          <p class="text-sm font-medium text-destructive/80">Couldn't load your servers</p>
          <p class="text-xs text-muted-foreground/60">
            Check your connection, then try again.
          </p>
          <button
            type="button"
            class="mt-1 rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            onClick={() => void loadServers()}
          >
            Retry
          </button>
        </div>
      </Show>
    </div>
  );
}

export function AppSidebar(props: {
  onItemSelect?: (item: SidebarItem) => void;
  onItemDrop?: (item: SidebarItem, target: DropTarget) => void;
  onOpenWebApp?: (app: WebApp) => void;
  onWebAppDrop?: (app: WebApp, target: DropTarget) => void;
}) {
  const [wizardOpen, setWizardOpen] = createSignal(false);
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const [supportOpen, setSupportOpen] = createSignal(false);
  const [pendingSettingsTab, setPendingSettingsTab] = createSignal<ServerSettingsTab | null>(null);
  const sidebarCtx = useSidebar();

  // Cross-component requests to jump into Server Settings on a specific tab
  // (e.g. the sidebar runtime update pill clicking through to Danger Zone).
  // The sheet consumes `pendingTab` and calls back to clear it.
  onMount(() => {
    const dispose = onServerSettingsOpen((tab) => {
      setPendingSettingsTab(tab);
      setSettingsOpen(true);
    });
    onCleanup(dispose);
  });

  const navSecondary: NavSecondaryItem[] = [
    {
      title: "Co-View",
      icon: ScreenShare,
      onClick: () => emitCoViewSheetOpen(),
    },
    { title: "Support", icon: LifeBuoy, onClick: () => setSupportOpen(true) },
    // TODO: wire to feature-request / feedback system once it exists.
    { title: "Feedback", icon: Send, disabled: true },
  ];

  // Mobile fix: the sidebar is rendered inside a Sheet modal that covers the
  // workspace panels. When a sidebar-item drag threshold trips, auto-close
  // the sheet so the user can actually drop onto a panel. Pointer capture has
  // already moved to the drag-capture root by this point, so the source
  // element unmounting along with the Sheet is fine.
  createEffect(() => {
    const ctx = dragContext();
    const kind = ctx?.kind;
    if ((kind === "sidebar-item" || kind === "web-app") && sidebarCtx.isMobile() && sidebarCtx.openMobile()) {
      sidebarCtx.setOpenMobile(false);
    }
  });

  onMount(() => { void loadServers(); });

  return (
    <Sidebar variant="inset">
      <SidebarHeader class="pt-1">
        <SidebarMenu>
          <SidebarMenuItem>
            <div class="flex w-full items-center gap-2">
              <SidebarMenuButton size="lg" href="#" class="flex-1">
                <div class="flex aspect-square size-10 items-center justify-center rounded-lg overflow-hidden shrink-0">
                  <img src="/uncorded-icon.png" alt="UnCorded" class="size-full object-contain" />
                </div>
                <span class="truncate font-bold text-base">UnCorded</span>
              </SidebarMenuButton>
              <UpdatePill />
            </div>
          </SidebarMenuItem>
        </SidebarMenu>
        <Show when={activeServer()}>
          <ServerSwitcher
            onCreateServer={() => setWizardOpen(true)}
            onServerSettings={() => setSettingsOpen(true)}
          />
        </Show>
      </SidebarHeader>

      <SidebarContent>
        <Show
          when={activeServer()}
          fallback={<NoServerState />}
        >
          <Show
            when={!sidebarLoading()}
            fallback={<SidebarSkeleton />}
          >
            <Show
              when={!sidebarError()}
              fallback={
                <div class="flex flex-1 items-center justify-center px-4 py-8">
                  <p class="text-xs text-destructive/80 text-center">
                    Failed to load sidebar. Check your connection.
                  </p>
                </div>
              }
            >
              <NavSidebarSections
                sections={sections()}
                {...(props.onItemSelect ? { onSelect: props.onItemSelect } : {})}
                {...(props.onItemDrop ? { onItemDrop: props.onItemDrop } : {})}
              />
              <Show when={props.onOpenWebApp}>
                {(open) => (
                  <WebAppsCategory
                    onOpenWebApp={open()}
                    onWebAppDrop={props.onWebAppDrop ?? (() => {})}
                  />
                )}
              </Show>
            </Show>
          </Show>
        </Show>

        {/* Bottom actions — anchored at the bottom, visible in both states */}
        <div class="mt-auto flex flex-col gap-0.5 px-2 pb-2">
          <Show
            when={activeServer()}
            fallback={
              <>
                {/* Create works, but self-hosting is the power-user path —
                    the "Advanced" tag steers casual users toward Explore once it ships. */}
                <button
                  type="button"
                  class="flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm text-muted-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                  onClick={() => setWizardOpen(true)}
                >
                  <div class="flex size-5 items-center justify-center shrink-0">
                    <Plus class="size-4" />
                  </div>
                  <span>Create a server</span>
                  <span class="ml-auto text-[10px] uppercase tracking-wider text-muted-foreground/40">Advanced</span>
                </button>
                <button
                  type="button"
                  class="flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm text-muted-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                  onClick={() => openExploreServers()}
                >
                  <div class="flex size-5 items-center justify-center shrink-0">
                    <Compass class="size-4" />
                  </div>
                  <span>Explore servers</span>
                </button>
              </>
            }
          >
            <button
              type="button"
              class="flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              onClick={() => setSettingsOpen(true)}
            >
              <div class="flex size-5 items-center justify-center shrink-0">
                <Settings class="size-4" />
              </div>
              <span>Server settings</span>
            </button>
          </Show>
        </div>

        <NavSecondary items={navSecondary} class="pb-2" />
      </SidebarContent>

      <SidebarFooter>
        {/* Voice indicator sits above NavUser — Discord-parity placement and
            the only "user's persistent state in this app" anchor. Hidden when
            the manager is idle (see VoiceIndicator visibility memo); takes no
            DOM space in that case so the footer collapses to just NavUser. */}
        <VoiceIndicator />
        <NavUser />
      </SidebarFooter>

      <CreateServerWizard open={wizardOpen()} onOpenChange={setWizardOpen} />
      <ServerSettingsSheet
        open={settingsOpen()}
        onOpenChange={setSettingsOpen}
        pendingTab={pendingSettingsTab()}
        onPendingTabConsumed={() => setPendingSettingsTab(null)}
      />
      <SupportSheet open={supportOpen()} onOpenChange={setSupportOpen} />
    </Sidebar>
  );
}
