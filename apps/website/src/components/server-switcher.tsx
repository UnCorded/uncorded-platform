import { Show, For, createSignal, createEffect, type JSX } from "solid-js";
import { Check, Compass, ChevronsUpDown, LogOut, Mail, Plus, Wifi, WifiOff, X } from "lucide-solid";
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
import { account } from "@/stores/auth";
import {
  servers,
  serversLoading,
  activeServer,
  setActiveServer,
  getServerIconVersion,
  loadServers,
} from "@/stores/servers";
import {
  RuntimeUpdatePill,
  runtimeUpdatePillVisible,
} from "@/components/server/runtime-update-pill";
import * as central from "@/api/central";
import { ApiError, type MyInvite } from "@/api/types";
import { openExploreServers } from "@/components/server/explore-servers-dialog";

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

  // Pending invites — loaded once on mount and refreshed every time the
  // dropdown opens, so a freshly-sent invite shows up without a reload.
  const [myInvites, setMyInvites] = createSignal<MyInvite[]>([]);
  const [inviteBusyId, setInviteBusyId] = createSignal<string | null>(null);
  // One inline error slot for invite/leave actions inside the menu.
  const [menuError, setMenuError] = createSignal<string | null>(null);
  // Two-click confirm latch for the per-row "Leave" affordance.
  const [leaveConfirmId, setLeaveConfirmId] = createSignal<string | null>(null);

  async function refreshInvites(): Promise<void> {
    // Skip while logged out — the call is a guaranteed 401 (the switcher
    // mounts before/without a session) and the browser logs every failed
    // network request to the console even when we swallow the rejection.
    if (account() === null) return;
    try {
      setMyInvites(await central.listMyInvites());
    } catch {
      // Central unreachable — keep whatever we had.
    }
  }
  // Reactive on login: fires once the account resolves (and on hot login
  // after the auth gate), not just at mount time.
  createEffect(() => {
    if (account() !== null) void refreshInvites();
  });

  async function handleAcceptInvite(inv: MyInvite): Promise<void> {
    if (inviteBusyId() !== null) return;
    setInviteBusyId(inv.id);
    setMenuError(null);
    try {
      const { server_id } = await central.acceptInvite(inv.id);
      await Promise.all([refreshInvites(), loadServers()]);
      setActiveServer(server_id);
    } catch (err) {
      setMenuError(err instanceof ApiError ? err.message : "Could not accept invite");
      void refreshInvites();
    } finally {
      setInviteBusyId(null);
    }
  }

  async function handleDeclineInvite(inv: MyInvite): Promise<void> {
    if (inviteBusyId() !== null) return;
    setInviteBusyId(inv.id);
    setMenuError(null);
    try {
      await central.declineInvite(inv.id);
      await refreshInvites();
    } catch (err) {
      setMenuError(err instanceof ApiError ? err.message : "Could not decline invite");
      void refreshInvites();
    } finally {
      setInviteBusyId(null);
    }
  }

  async function handleLeave(serverId: string): Promise<void> {
    setMenuError(null);
    try {
      await central.leaveServer(serverId);
      setLeaveConfirmId(null);
      if (activeServer()?.id === serverId) setActiveServer(null);
      await loadServers();
    } catch (err) {
      setMenuError(err instanceof ApiError ? err.message : "Could not leave server");
    }
  }

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu
          onOpenChange={(open) => {
            if (open) {
              void refreshInvites();
            } else {
              setLeaveConfirmId(null);
              setMenuError(null);
            }
          }}
        >
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
            <div class="ml-auto flex shrink-0 items-center gap-1">
              {/* Invite count badge — visible without opening the menu. */}
              <Show when={myInvites().length > 0}>
                <span class="rounded-full bg-sidebar-primary px-1.5 py-0.5 text-[10px] font-semibold text-sidebar-primary-foreground">
                  {myInvites().length} invite{myInvites().length === 1 ? "" : "s"}
                </span>
              </Show>
              <ChevronsUpDown class="size-4" />
            </div>
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
                    class="group/row gap-2 p-2"
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
                    {/* Leave (non-owner only) — hover-revealed, two-click
                        confirm. Pointer events are stopped so the row's
                        onSelect doesn't fire and the menu stays open. */}
                    <Show when={server.role === "member"}>
                      <button
                        type="button"
                        class="flex h-5 shrink-0 items-center gap-1 rounded px-1 text-[10px] text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover/row:opacity-100"
                        classList={{
                          "opacity-100 text-destructive": leaveConfirmId() === server.id,
                        }}
                        data-tooltip="Leave server"
                        onPointerDown={(e) => e.stopPropagation()}
                        onPointerUp={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation();
                          e.preventDefault();
                          if (leaveConfirmId() === server.id) {
                            void handleLeave(server.id);
                          } else {
                            setLeaveConfirmId(server.id);
                          }
                        }}
                      >
                        <Show
                          when={leaveConfirmId() === server.id}
                          fallback={<LogOut class="size-3" />}
                        >
                          Leave?
                        </Show>
                      </button>
                    </Show>
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

            {/* Pending invites — plain rows (not menu items) so the Accept /
                Decline buttons don't trigger item selection or close the menu. */}
            <Show when={myInvites().length > 0}>
              <DropdownMenuSeparator />
              <DropdownMenuLabel class="text-xs text-muted-foreground">
                Invitations
              </DropdownMenuLabel>
              <For each={myInvites()}>
                {(inv) => (
                  <div class="flex items-center gap-2 px-2 py-1.5">
                    <div class="flex size-6 items-center justify-center rounded-md border bg-background shrink-0">
                      <Mail class="size-3.5" />
                    </div>
                    <div class="min-w-0 flex-1">
                      <p class="truncate text-sm">{inv.server_name}</p>
                      <p class="truncate text-[10px] text-muted-foreground">
                        invited by @{inv.invited_by_username}
                      </p>
                    </div>
                    <button
                      type="button"
                      class="flex size-6 shrink-0 items-center justify-center rounded-md border bg-background text-emerald-500 transition-colors hover:bg-emerald-500/10 disabled:opacity-50"
                      disabled={inviteBusyId() !== null}
                      data-tooltip="Accept"
                      aria-label={`Accept invite to ${inv.server_name}`}
                      onClick={() => void handleAcceptInvite(inv)}
                    >
                      <Check class="size-3.5" />
                    </button>
                    <button
                      type="button"
                      class="flex size-6 shrink-0 items-center justify-center rounded-md border bg-background text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
                      disabled={inviteBusyId() !== null}
                      data-tooltip="Decline"
                      aria-label={`Decline invite to ${inv.server_name}`}
                      onClick={() => void handleDeclineInvite(inv)}
                    >
                      <X class="size-3.5" />
                    </button>
                  </div>
                )}
              </For>
            </Show>

            <Show when={menuError()}>
              <p class="px-2 py-1 text-[11px] text-destructive">{menuError()}</p>
            </Show>

            <DropdownMenuSeparator />

            <DropdownMenuItem class="gap-2 p-2" onSelect={() => props.onCreateServer()}>
              <div class="flex size-6 items-center justify-center rounded-md border bg-background shrink-0">
                <Plus class="size-4" />
              </div>
              <span class="font-medium text-muted-foreground/70">Create a server</span>
              <span class="ml-auto text-[10px] text-muted-foreground/50 font-medium">Advanced</span>
            </DropdownMenuItem>

            <DropdownMenuItem class="gap-2 p-2" onSelect={() => openExploreServers()}>
              <div class="flex size-6 items-center justify-center rounded-md border bg-background shrink-0">
                <Compass class="size-4" />
              </div>
              <span class="font-medium text-muted-foreground">Explore servers</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

      </SidebarMenuItem>
    </SidebarMenu>
  );
}
