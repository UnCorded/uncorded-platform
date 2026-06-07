import { Show, For, type JSX } from "solid-js";
import { Compass, ChevronsUpDown, Plus, Wifi, WifiOff } from "lucide-solid";
import { useImgRetry } from "@/lib/img-retry";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import {
  servers,
  serversLoading,
  activeServer,
  setActiveServer,
  getServerIconVersion,
} from "@/stores/servers";
import {
  RuntimeUpdatePill,
  runtimeUpdatePillVisible,
} from "@/components/server/runtime-update-pill";

export function ServerIcon(props: {
  serverId: string;
  name: string;
  tunnelUrl: string | null;
  size: "xs" | "sm" | "lg";
}): JSX.Element {
  // Defense in depth: only render icons from http(s) tunnel URLs. Rejects a
  // compromised upstream that returns `data:`, `javascript:`, or a relative
  // path — falls through to the letter avatar instead.
  //
  // The `?v=<iconVersion>` cache buster is bumped by `runtime.icon.changed` WS
  // events. New URL → useImgRetry resets → <img> re-fetches. This means a
  // viewer who joined before the owner uploaded the icon flips to the real
  // image the moment the upload broadcast arrives, no hard refresh needed.
  const iconUrl = (): string | null => {
    const raw = props.tunnelUrl;
    if (raw === null) return null;
    if (!/^https?:\/\//i.test(raw)) return null;
    const v = getServerIconVersion(props.serverId);
    return v > 0 ? `${raw}/icon?v=${String(v)}` : `${raw}/icon`;
  };
  const retry = useImgRetry(iconUrl);
  const showImg = () => iconUrl() !== null && !retry.exhausted();
  const showLetter = () => !retry.loaded() || retry.exhausted();

  const sizeClass =
    props.size === "lg" ? "size-8" : props.size === "xs" ? "size-5" : "size-6";
  const textClass =
    props.size === "lg"
      ? "text-sm font-bold"
      : props.size === "xs"
        ? "text-[10px] font-bold"
        : "text-xs font-bold";
  const roundClass = props.size === "lg" ? "rounded-lg" : "rounded-sm";

  return (
    <div
      class={`relative flex aspect-square ${sizeClass} items-center justify-center ${roundClass} shrink-0 overflow-hidden`}
      classList={{
        "bg-sidebar-primary text-sidebar-primary-foreground": showLetter(),
        "bg-transparent": !showLetter(),
      }}
    >
      <Show when={showLetter()}>
        <span class={textClass}>{props.name.charAt(0).toUpperCase()}</span>
      </Show>
      <Show when={showImg()}>
        <img
          src={retry.srcWithCacheBuster()}
          alt={props.name}
          class="absolute inset-0 size-full object-cover"
          classList={{ "opacity-0": !retry.loaded() }}
          onLoad={retry.handleLoad}
          onError={retry.handleError}
        />
      </Show>
    </div>
  );
}

export function ServerSwitcher(props: {
  onCreateServer: () => void;
  onServerSettings: () => void;
}) {
  const { isMobile } = useSidebar();

  const current = () => activeServer();

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            as={SidebarMenuButton as any}
            size="lg"
            class="data-[expanded]:bg-sidebar-accent data-[expanded]:text-sidebar-accent-foreground"
          >
            <Show
              when={current()}
              fallback={
                <div class="flex aspect-square size-8 items-center justify-center rounded-lg bg-muted shrink-0">
                  <span class="text-xs text-muted-foreground">
                    {serversLoading() ? "…" : "?"}
                  </span>
                </div>
              }
            >
              {(s) => (
                <>
                  <div class="relative shrink-0">
                    <ServerIcon serverId={s().id} name={s().name} tunnelUrl={s().tunnel_url} size="lg" />
                    <span
                      class="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-sidebar"
                      classList={{
                        "bg-emerald-500": s().is_online,
                        "bg-muted-foreground/40": !s().is_online,
                      }}
                    />
                  </div>
                  <div class="flex flex-col flex-1 text-left min-w-0">
                    <span class="truncate font-semibold text-sm">{s().name}</span>
                    <span class="truncate text-xs text-muted-foreground">
                      {s().is_online
                        ? `${s().connected_users} online · ${s().plugin_count} plugins`
                        : "Offline"}
                    </span>
                  </div>
                </>
              )}
            </Show>
            <ChevronsUpDown class="ml-auto size-4 shrink-0" />
          </DropdownMenuTrigger>

          <DropdownMenuContent
            class="w-(--kb-popper-anchor-width) min-w-56 rounded-lg"
            side={isMobile() ? "bottom" : "bottom"}
            align="start"
            sideOffset={4}
          >
            <DropdownMenuLabel class="text-xs text-muted-foreground">
              Servers
            </DropdownMenuLabel>

            <Show when={!serversLoading() && servers().length === 0}>
              <div class="px-2 py-3 text-center text-xs text-muted-foreground">
                No servers yet
              </div>
            </Show>

            <For each={servers()}>
              {(server) => {
                // Per-server runtime update badge: when the orchestrator is
                // mid-update (or has an update available), the pill replaces
                // the Wifi/WifiOff indicator in this row. Both share the
                // trailing slot so the user sees one status badge per server.
                const pillVisible = runtimeUpdatePillVisible(server.id);
                return (
                  <DropdownMenuItem
                    class="gap-2 p-2"
                    onSelect={() => setActiveServer(server.id)}
                  >
                    <div class="relative shrink-0">
                      <ServerIcon serverId={server.id} name={server.name} tunnelUrl={server.tunnel_url} size="sm" />
                      <span
                        class="absolute -bottom-0.5 -right-0.5 size-2 rounded-full border border-popover"
                        classList={{
                          "bg-emerald-500": server.is_online,
                          "bg-muted-foreground/40": !server.is_online,
                        }}
                      />
                    </div>
                    <span class="truncate flex-1">{server.name}</span>
                    <Show
                      when={pillVisible()}
                      fallback={
                        <Show
                          when={server.is_online}
                          fallback={<WifiOff class="size-3 text-muted-foreground/50 shrink-0" />}
                        >
                          <Wifi class="size-3 text-emerald-500 shrink-0" />
                        </Show>
                      }
                    >
                      <RuntimeUpdatePill serverId={server.id} />
                    </Show>
                  </DropdownMenuItem>
                );
              }}
            </For>

            <DropdownMenuSeparator />

            <DropdownMenuItem class="gap-2 p-2" onSelect={() => props.onCreateServer()}>
              <div class="flex size-6 items-center justify-center rounded-md border bg-background shrink-0">
                <Plus class="size-4" />
              </div>
              <span class="font-medium text-muted-foreground/70">Create a server</span>
              <span class="ml-auto text-[10px] text-muted-foreground/50 font-medium">Advanced</span>
            </DropdownMenuItem>

            <DropdownMenuItem class="gap-2 p-2" disabled>
              <div class="flex size-6 items-center justify-center rounded-md border bg-background shrink-0">
                <Compass class="size-4" />
              </div>
              <span class="font-medium text-muted-foreground">Explore servers</span>
              <span class="ml-auto text-[10px] text-muted-foreground/50 font-medium">Soon</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
