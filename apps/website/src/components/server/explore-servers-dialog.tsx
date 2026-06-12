import { createSignal, createMemo, createEffect, untrack, Show, For } from "solid-js";
import { Search, Users } from "lucide-solid";
import {
  Dialog,
  DialogContent,
  DialogClose,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import * as central from "@/api/central";
import { ApiError, type Server } from "@/api/types";
import { servers, fastPollServers } from "@/stores/servers";
import { withAuthGate, joinTarget, clearJoinTarget } from "@/stores/auth-intent";
import { ServerIcon } from "@/components/server-switcher";

interface ExploreServersDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// Per-row join state. "requested" is sticky for the dialog's lifetime — the
// server owner has to act before re-requesting makes sense, so the button
// stays disabled rather than inviting a 409 loop.
interface RowState {
  phase: "idle" | "pending" | "requested";
  error: string | null;
}

const IDLE_ROW: RowState = { phase: "idle", error: null };

// Open state lives at module scope, with a single always-mounted host (see
// ExploreServersHost), so every surface that can open Explore — the switcher
// dropdown, the sidebar's no-server view, a joinTarget replay — drives the
// same dialog instance. Mounting the dialog inside one of those surfaces is
// the bug this prevents: the switcher only renders when a server is active,
// so an "open" signal fired from the no-server view had no dialog to show.
const [exploreOpen, setExploreOpen] = createSignal(false);

export function openExploreServers(): void {
  setExploreOpen(true);
}

/** Mount exactly once, somewhere that always renders (AppSidebar root). */
export function ExploreServersHost() {
  // joinTarget replay must open the dialog from here, not from the switcher:
  // a ?join= deep link usually lands with NO server selected, which is
  // precisely when the switcher (and any effect inside it) isn't mounted.
  createEffect(() => {
    if (joinTarget() !== null) setExploreOpen(true);
  });
  return <ExploreServersDialog open={exploreOpen()} onOpenChange={setExploreOpen} />;
}

export function ExploreServersDialog(props: ExploreServersDialogProps) {
  const [directory, setDirectory] = createSignal<Server[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [loadError, setLoadError] = createSignal<string | null>(null);
  const [search, setSearch] = createSignal("");
  const [rowStates, setRowStates] = createSignal<Record<string, RowState>>({});
  // Outcome banner for the joinTarget replay path — the target server may be
  // private (not in the directory at all), so its result can't live on a row.
  const [notice, setNotice] = createSignal<string | null>(null);

  async function loadDirectory(): Promise<void> {
    setLoading(true);
    setLoadError(null);
    try {
      setDirectory(await central.listPublicServers());
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Failed to load servers");
    } finally {
      setLoading(false);
    }
  }

  // Re-fetch on every open so the online-only directory is fresh.
  createEffect(() => {
    if (props.open) void loadDirectory();
  });

  // Client-side filter — listPublicServers already returns only online
  // public servers, so there's nothing to paginate at current scale.
  const filtered = createMemo(() => {
    const q = search().trim().toLowerCase();
    const list = directory();
    if (!q) return list;
    return list.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        (s.description ?? "").toLowerCase().includes(q),
    );
  });

  /** Already a member — the sidebar store is the source of truth. */
  const joined = (serverId: string): boolean =>
    servers().some((s) => s.id === serverId);

  const rowState = (serverId: string): RowState =>
    rowStates()[serverId] ?? IDLE_ROW;

  function patchRow(serverId: string, next: RowState): void {
    setRowStates((prev) => ({ ...prev, [serverId]: next }));
  }

  async function requestJoin(serverId: string): Promise<void> {
    if (rowState(serverId).phase !== "idle") return;
    patchRow(serverId, { phase: "pending", error: null });
    try {
      const res = await withAuthGate({ action: "join", serverId }, () =>
        central.createJoinRequest(serverId),
      );
      if (res === null) {
        // Gated — AuthPage took over; the stashed intent replays post-login
        // via joinTarget, so just get out of the way.
        patchRow(serverId, IDLE_ROW);
        props.onOpenChange(false);
        return;
      }
      patchRow(serverId, { phase: "requested", error: null });
      // The accept lands on the OWNER's screen — poll fast for a few minutes
      // so the server appears here within seconds of acceptance instead of
      // waiting out the 60s cycle (or a page refresh).
      fastPollServers();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // Already pending / already member / banned — Central's message says
        // which; either way another click would just 409 again.
        patchRow(serverId, {
          phase: "requested",
          error: err.message || "Already requested",
        });
      } else {
        patchRow(serverId, {
          phase: "idle",
          error: err instanceof ApiError ? err.message : "Request failed",
        });
      }
    }
  }

  // joinTarget replay: a ?join= deep link or post-login intent lands here
  // (the switcher already opened the dialog). Fire the request once, surface
  // the outcome, and clear the target so it can't replay again.
  createEffect(() => {
    const target = joinTarget();
    if (target === null) return;
    clearJoinTarget();
    untrack(() => {
      setNotice(null);
      if (joined(target)) {
        setNotice("You're already a member of that server.");
        return;
      }
      void requestJoin(target).then(() => {
        const st = rowState(target);
        if (st.error !== null) setNotice(st.error);
        else if (st.phase === "requested") setNotice("Join request sent.");
      });
    });
  });

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent class="max-w-md p-0 flex flex-col" coViewTitle="Explore servers">
        <div class="border-b border-border px-5 py-4">
          <DialogTitle class="text-base">Explore servers</DialogTitle>
          <DialogDescription class="mt-1 text-xs">
            Public servers that are online right now. Joining requires the
            owner's approval.
          </DialogDescription>
          <DialogClose />
        </div>

        {/* Search */}
        <div class="relative mx-5 mt-4">
          <Search class="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground pointer-events-none" />
          <input
            type="text"
            placeholder="Search servers…"
            class="w-full h-8 pl-8 pr-3 text-sm bg-muted/50 border border-border rounded-md outline-none focus:border-border/60 placeholder:text-muted-foreground/60"
            value={search()}
            onInput={(e) => setSearch(e.currentTarget.value)}
          />
        </div>

        <Show when={notice()}>
          <p class="mx-5 mt-2 text-xs text-muted-foreground">{notice()}</p>
        </Show>

        {/* Directory list */}
        <div class="flex max-h-[50vh] flex-col gap-1.5 overflow-y-auto p-5 pt-3">
          <Show when={loading() && directory().length === 0}>
            <div class="flex items-center justify-center py-8">
              <div class="size-5 animate-spin rounded-full border-2 border-border border-t-foreground/60" />
            </div>
          </Show>

          <Show when={loadError()}>
            <p class="py-4 text-center text-xs text-destructive">{loadError()}</p>
          </Show>

          <Show when={!loading() && loadError() === null && filtered().length === 0}>
            <p class="py-8 text-center text-sm text-muted-foreground">
              {directory().length === 0
                ? "No public servers are online right now."
                : "No servers match your search."}
            </p>
          </Show>

          <For each={filtered()}>
            {(srv) => {
              const st = () => rowState(srv.id);
              return (
                <div class="flex items-center gap-3 rounded-lg border border-border bg-muted/30 px-3 py-2">
                  {/* Directory rows carry no tunnel_url (it travels with the
                      join token) — null falls back to the letter avatar. */}
                  <ServerIcon serverId={srv.id} name={srv.name} tunnelUrl={null} size="sm" />
                  <div class="min-w-0 flex-1">
                    <p class="truncate text-sm font-medium">{srv.name}</p>
                    <p class="flex items-center gap-1 truncate text-xs text-muted-foreground">
                      <Users class="size-3 shrink-0" />
                      {srv.connected_users} online
                      <Show when={srv.description}>
                        <span class="truncate">· {srv.description}</span>
                      </Show>
                    </p>
                    <Show when={st().error}>
                      <p class="truncate text-[11px] text-destructive">{st().error}</p>
                    </Show>
                  </div>
                  <Show
                    when={!joined(srv.id)}
                    fallback={
                      <span class="shrink-0 text-xs text-muted-foreground">Joined</span>
                    }
                  >
                    <Button
                      size="sm"
                      class="h-7 shrink-0 px-2.5 text-xs"
                      disabled={st().phase !== "idle"}
                      onClick={() => void requestJoin(srv.id)}
                    >
                      {st().phase === "requested"
                        ? "Requested"
                        : st().phase === "pending"
                          ? "Requesting…"
                          : "Request to join"}
                    </Button>
                  </Show>
                </div>
              );
            }}
          </For>
        </div>
      </DialogContent>
    </Dialog>
  );
}
