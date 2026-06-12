import { createSignal, createResource, createMemo, createEffect, onCleanup, Show, Switch, Match, For, type Component } from "solid-js";
import { AlertTriangle, Check, ChevronDown, ChevronUp, Folders, Mail, Pencil, Puzzle, Search, Settings, ShieldCheck, Trash2, Upload, UserPlus, Users, X } from "lucide-solid";
import type { LucideProps } from "lucide-solid";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import * as central from "@/api/central";
import { ApiError } from "@/api/types";
import type { JoinRequest, Server, ServerInvite, ServerMember } from "@/api/types";
import { activeServer, loadServers, bumpServerIconVersion, getServerIconVersion } from "@/stores/servers";
import { isAdmin, currentMember } from "@/stores/membership";
import { request, onPluginMessage } from "@/lib/ws";
import { coreClient, CoreError } from "@/lib/core-client";
import type { CoreMember, CoreRole } from "@uncorded/protocol";
import {
  assignableRoles,
  ensureRolesLoaded,
  refetchRoles,
  rolesStoreFor,
} from "@/stores/permissions";
import { showInlineStatus } from "@/lib/feedback";
import { account } from "@/stores/auth";
import { purgeServer } from "@/lib/server-purge";
import { cn } from "@/lib/utils";
import type { CoreCategory } from "@uncorded/protocol";
import { AdministrationSection } from "./administration";
import { RuntimeUpdatePanel } from "./runtime-update-panel";
import { PluginsSection } from "./plugins-section";

type TabId = "general" | "members" | "categories" | "administration" | "plugins" | "danger";

type ServerSettingsSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When set, the sheet jumps to this tab on next render. The owning
   *  component is expected to clear the value after read so the next
   *  open doesn't re-snap to the same tab unintentionally. */
  pendingTab?: TabId | null;
  onPendingTabConsumed?: () => void;
};

const tabs: { id: TabId; label: string; icon: Component<LucideProps> }[] = [
  { id: "general",    label: "General",    icon: Settings  },
  { id: "members",    label: "Members",    icon: Users     },
  { id: "categories", label: "Categories", icon: Folders   },
  { id: "administration", label: "Admin", icon: ShieldCheck },
  { id: "plugins",    label: "Plugins",    icon: Puzzle    },
  { id: "danger",     label: "Danger",     icon: Trash2    },
];

export function ServerSettingsSheet(props: ServerSettingsSheetProps) {
  const server = () => activeServer();
  const [activeTab, setActiveTab] = createSignal<TabId>("general");

  // External callers (e.g. the runtime update pill) can request opening on
  // a specific tab via `pendingTab`. We consume the value once so subsequent
  // opens fall back to whatever tab the user last selected.
  createEffect(() => {
    const tab = props.pendingTab;
    if (!tab) return;
    setActiveTab(tab);
    props.onPendingTabConsumed?.();
  });

  return (
    <Sheet open={props.open} onOpenChange={props.onOpenChange}>
      <SheetContent
        side="right"
        class="flex w-[22rem] flex-col gap-0 p-0 sm:max-w-[22rem]"
      >
        {/* Header — relative so the folder-tab strip can anchor to its bottom
          * edge and protrude left of the sheet. */}
        <SheetHeader class="relative flex flex-row items-center justify-between gap-0 border-b border-border px-4 py-3 overflow-visible">
          <SheetTitle class="text-sm font-semibold">Server settings</SheetTitle>
          <SheetClose class="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground">
            <X class="size-3.5" />
          </SheetClose>

          {/* Folder tabs — anchored to bottom-left of header, protrude left of
            * the sheet. Icon is the primary affordance (keeps the compact
            * folder-tab silhouette) with the text label riding alongside, so
            * a user can read the section name without hovering. On narrow
            * viewports the label is hidden and the tab collapses to an
            * icon-only square so the whole strip still fits on-screen. */}
          <div class="absolute top-full right-full flex flex-col pt-0">
            {tabs.map((tab, i) => {
              const isActive = () => activeTab() === tab.id;
              return (
                <button
                  type="button"
                  onClick={() => setActiveTab(tab.id)}
                  onMouseEnter={(e) => e.currentTarget.setAttribute("title", tab.label)}
                  aria-label={tab.label}
                  aria-current={isActive() ? "page" : undefined}
                  class={cn(
                    "group relative flex h-10 w-10 min-[30rem]:w-[7.5rem] items-center justify-center min-[30rem]:justify-start gap-2 rounded-tl-lg rounded-bl-lg border px-0 min-[30rem]:px-3 text-xs font-medium transition-colors",
                    i < tabs.length - 1 ? "mb-1" : "",
                    // Active: blends into the sheet body (folder pulled open).
                    // Inactive: recessed card tone so the active tab visibly
                    // "sits in front" of the stack.
                    isActive()
                      ? "-mr-px border-r-0 border-border bg-background text-foreground"
                      : "border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                >
                  <tab.icon class="size-4 shrink-0" />
                  <span class="hidden min-[30rem]:inline whitespace-nowrap">{tab.label}</span>
                </button>
              );
            })}
          </div>
        </SheetHeader>

        <Show
          when={server()}
          fallback={
            <div class="flex flex-1 items-center justify-center p-6">
              <p class="text-sm text-muted-foreground">No server selected.</p>
            </div>
          }
        >
          {(s) => (
            <div class="flex-1 overflow-y-auto">
              <Switch>
                <Match when={activeTab() === "general"}>
                  <IconSection server={s()} />
                  <div class="h-px bg-border" />
                  <EditSection
                    serverId={s().id}
                    currentName={s().name}
                    currentDescription={s().description}
                    onClose={() => props.onOpenChange(false)}
                  />
                  <div class="h-px bg-border" />
                  <InfoSection server={s()} />
                </Match>
                <Match when={activeTab() === "members"}>
                  {/* Central access management — owner-only (every endpoint
                      403s for non-owners, so gate at the call site). Sits
                      above the runtime presence list below. */}
                  <Show when={account()?.id === s().owner_id}>
                    <AccessSection serverId={s().id} />
                    <div class="h-px bg-border" />
                  </Show>
                  <MembersSection serverId={s().id} />
                </Match>
                <Match when={activeTab() === "categories"}>
                  <CategoriesSection serverId={s().id} />
                </Match>
                <Match when={activeTab() === "administration"}>
                  <AdministrationSection serverId={s().id} />
                </Match>
                <Match when={activeTab() === "plugins"}>
                  <PluginsSection serverId={s().id} tunnelUrl={s().tunnel_url ?? ""} />
                </Match>
                <Match when={activeTab() === "danger"}>
                  <DangerSection
                    serverId={s().id}
                    serverName={s().name}
                    onClose={() => props.onOpenChange(false)}
                  />
                </Match>
              </Switch>
            </div>
          )}
        </Show>
      </SheetContent>
    </Sheet>
  );
}

// ── Access section ────────────────────────────────────────────────────────────

// Central's access membership — who may mint tokens for this server. Distinct
// from the runtime presence members in MembersSection below. Owner-only:
// every endpoint here 403s for non-owners, so the parent gates rendering.
function AccessSection(props: { serverId: string }) {
  const [expanded, setExpanded] = createSignal(true);

  // Invite-by-username form.
  const [inviteName, setInviteName] = createSignal("");
  const [inviteBusy, setInviteBusy] = createSignal(false);
  const [inviteNotice, setInviteNotice] = createSignal<{ ok: boolean; text: string } | null>(null);

  // The three Central lists. One shared load-error slot — they load together
  // and the realistic failure (Central unreachable) hits all three at once.
  const [invites, setInvites] = createSignal<ServerInvite[]>([]);
  const [requests, setRequests] = createSignal<JoinRequest[]>([]);
  const [accessList, setAccessList] = createSignal<ServerMember[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [listError, setListError] = createSignal<string | null>(null);

  // Row-action state: which row has an in-flight call, the two-click confirm
  // latch ("kick:<id>" / "ban:<id>"), and the latest action error.
  const [busyKey, setBusyKey] = createSignal<string | null>(null);
  const [confirmKey, setConfirmKey] = createSignal<string | null>(null);
  const [actionError, setActionError] = createSignal<string | null>(null);

  function apiMessage(err: unknown, fallback: string): string {
    return err instanceof ApiError ? err.message : fallback;
  }

  async function refreshInvites(): Promise<void> {
    setInvites(await central.listServerInvites(props.serverId));
  }
  async function refreshRequests(): Promise<void> {
    setRequests(await central.listJoinRequests(props.serverId));
  }
  async function refreshAccessList(): Promise<void> {
    setAccessList(await central.listServerMembers(props.serverId));
  }

  async function loadAll(): Promise<void> {
    setLoading(true);
    setListError(null);
    try {
      await Promise.all([refreshInvites(), refreshRequests(), refreshAccessList()]);
    } catch (err) {
      setListError(apiMessage(err, "Failed to load access lists"));
    } finally {
      setLoading(false);
    }
  }
  // Initial load — the section mounts fresh each time the Members tab activates.
  void loadAll();

  async function handleInvite(e: Event): Promise<void> {
    e.preventDefault();
    const username = inviteName().trim();
    if (!username || inviteBusy()) return;
    setInviteBusy(true);
    setInviteNotice(null);
    try {
      await central.createInvite(props.serverId, username);
      setInviteName("");
      setInviteNotice({ ok: true, text: "Invite sent" });
      await refreshInvites();
    } catch (err) {
      // 404 unknown username / 409 already member or pending / 403 quota —
      // Central's message is human-readable, surface it verbatim.
      setInviteNotice({ ok: false, text: apiMessage(err, "Could not send invite") });
    } finally {
      setInviteBusy(false);
    }
  }

  /** Serialize row actions: one in flight at a time, errors surfaced inline. */
  async function runRowAction(key: string, fn: () => Promise<void>): Promise<void> {
    if (busyKey() !== null) return;
    setBusyKey(key);
    setActionError(null);
    try {
      await fn();
    } catch (err) {
      setActionError(apiMessage(err, "Action failed"));
    } finally {
      setBusyKey(null);
      setConfirmKey(null);
    }
  }

  /** Two-click destructive confirm: first click arms, second click fires. */
  function confirmThen(key: string, fn: () => Promise<void>): void {
    if (confirmKey() === key) {
      void runRowAction(key, fn);
    } else {
      setConfirmKey(key);
    }
  }

  const rowActionBtn =
    "h-6 shrink-0 rounded-md border border-border px-2 text-[11px] text-muted-foreground transition-colors disabled:opacity-50";

  return (
    <section>
      <button
        type="button"
        class="flex w-full items-center justify-between px-4 pb-2 pt-4"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded()}
      >
        <span class="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
          Access
        </span>
        {expanded()
          ? <ChevronUp class="size-3.5 text-muted-foreground" />
          : <ChevronDown class="size-3.5 text-muted-foreground" />}
      </button>

      <Show when={expanded()}>
        <div class="space-y-4 px-4 pb-4">
          <Show when={listError()}>
            <p class="text-xs text-destructive">{listError()}</p>
          </Show>
          <Show when={actionError()}>
            <p class="text-xs text-destructive">{actionError()}</p>
          </Show>

          {/* Invite by username */}
          <form class="space-y-1.5" onSubmit={(e) => void handleInvite(e)}>
            <label class="text-xs font-medium text-muted-foreground">Invite by username</label>
            <div class="flex gap-2">
              <Input
                value={inviteName()}
                onInput={(e) => setInviteName(e.currentTarget.value)}
                placeholder="username"
                class="h-8 text-sm"
              />
              <Button
                type="submit"
                size="sm"
                class="h-8 shrink-0"
                disabled={inviteBusy() || !inviteName().trim()}
              >
                <UserPlus class="size-3.5" />
                {inviteBusy() ? "Sending…" : "Invite"}
              </Button>
            </div>
            <Show when={inviteNotice()}>
              {(n) => (
                <p class={cn("text-xs", n().ok ? "text-emerald-500" : "text-destructive")}>
                  {n().text}
                </p>
              )}
            </Show>
          </form>

          {/* Pending invites */}
          <Show when={invites().length > 0}>
            <div class="space-y-1.5">
              <p class="text-xs font-medium text-muted-foreground">Pending invites</p>
              <For each={invites()}>
                {(inv) => (
                  <div class="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-2 py-1.5">
                    <Mail class="size-3.5 shrink-0 text-muted-foreground" />
                    <div class="min-w-0 flex-1">
                      <p class="truncate text-sm">@{inv.username}</p>
                      <p class="text-[10px] text-muted-foreground">
                        expires {new Date(inv.expires_at).toLocaleDateString()}
                      </p>
                    </div>
                    <button
                      type="button"
                      class={cn(rowActionBtn, "hover:bg-destructive hover:text-white")}
                      disabled={busyKey() !== null}
                      onClick={() =>
                        void runRowAction(`revoke:${inv.id}`, async () => {
                          await central.revokeInvite(props.serverId, inv.id);
                          await refreshInvites();
                        })
                      }
                    >
                      Revoke
                    </button>
                  </div>
                )}
              </For>
            </div>
          </Show>

          {/* Join requests */}
          <Show when={requests().length > 0}>
            <div class="space-y-1.5">
              <p class="text-xs font-medium text-muted-foreground">Join requests</p>
              <For each={requests()}>
                {(req) => (
                  <div class="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-2 py-1.5">
                    <div class="min-w-0 flex-1">
                      <p class="truncate text-sm">{req.display_name}</p>
                      <p class="truncate text-[10px] text-muted-foreground">@{req.username}</p>
                    </div>
                    <button
                      type="button"
                      class="flex size-6 shrink-0 items-center justify-center rounded-md border border-border text-emerald-500 transition-colors hover:bg-emerald-500/10 disabled:opacity-50"
                      disabled={busyKey() !== null}
                      data-tooltip="Accept"
                      aria-label={`Accept join request from ${req.display_name}`}
                      onClick={() =>
                        void runRowAction(`accept:${req.id}`, async () => {
                          await central.acceptJoinRequest(props.serverId, req.id);
                          await Promise.all([refreshRequests(), refreshAccessList()]);
                        })
                      }
                    >
                      <Check class="size-3.5" />
                    </button>
                    <button
                      type="button"
                      class="flex size-6 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
                      disabled={busyKey() !== null}
                      data-tooltip="Decline"
                      aria-label={`Decline join request from ${req.display_name}`}
                      onClick={() =>
                        void runRowAction(`decline:${req.id}`, async () => {
                          await central.declineJoinRequest(props.serverId, req.id);
                          await refreshRequests();
                        })
                      }
                    >
                      <X class="size-3.5" />
                    </button>
                  </div>
                )}
              </For>
            </div>
          </Show>

          {/* Access list */}
          <div class="space-y-1.5">
            <p class="text-xs font-medium text-muted-foreground">Access list</p>
            <Show when={loading() && accessList().length === 0}>
              <p class="text-xs text-muted-foreground">Loading…</p>
            </Show>
            <For each={accessList()}>
              {(m) => (
                <div class="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-2 py-1.5">
                  <div class="min-w-0 flex-1">
                    <p class="truncate text-sm">{m.display_name}</p>
                    <p class="truncate text-[10px] text-muted-foreground">@{m.username}</p>
                  </div>
                  <span class="inline-flex h-5 shrink-0 items-center rounded-full border border-border bg-muted/40 px-2 text-[10px] text-foreground/80">
                    {m.role}
                  </span>
                  <Show when={m.status === "banned"}>
                    <span class="inline-flex h-5 shrink-0 items-center rounded-full border border-destructive/30 bg-destructive/10 px-2 text-[10px] text-destructive">
                      banned
                    </span>
                  </Show>
                  <Show when={m.role === "member"}>
                    <Show
                      when={m.status === "active"}
                      fallback={
                        <button
                          type="button"
                          class={cn(rowActionBtn, "hover:bg-muted hover:text-foreground")}
                          disabled={busyKey() !== null}
                          onClick={() =>
                            void runRowAction(`unban:${m.account_id}`, async () => {
                              await central.unbanMember(props.serverId, m.account_id);
                              await refreshAccessList();
                            })
                          }
                        >
                          Unban
                        </button>
                      }
                    >
                      <button
                        type="button"
                        class={cn(rowActionBtn, "hover:bg-destructive hover:text-white")}
                        classList={{ "border-destructive/50 text-destructive": confirmKey() === `kick:${m.account_id}` }}
                        disabled={busyKey() !== null}
                        onClick={() =>
                          confirmThen(`kick:${m.account_id}`, async () => {
                            await central.kickMember(props.serverId, m.account_id);
                            await refreshAccessList();
                          })
                        }
                      >
                        {confirmKey() === `kick:${m.account_id}` ? "Confirm kick?" : "Kick"}
                      </button>
                      <button
                        type="button"
                        class={cn(rowActionBtn, "hover:bg-destructive hover:text-white")}
                        classList={{ "border-destructive/50 text-destructive": confirmKey() === `ban:${m.account_id}` }}
                        disabled={busyKey() !== null}
                        onClick={() =>
                          confirmThen(`ban:${m.account_id}`, async () => {
                            await central.banMember(props.serverId, m.account_id);
                            await refreshAccessList();
                          })
                        }
                      >
                        {confirmKey() === `ban:${m.account_id}` ? "Confirm ban?" : "Ban"}
                      </button>
                    </Show>
                  </Show>
                </div>
              )}
            </For>
            <Show when={!loading() && accessList().length === 0 && listError() === null}>
              <p class="text-xs text-muted-foreground">No members yet.</p>
            </Show>
          </div>
        </div>
      </Show>
    </section>
  );
}

// ── Members section ───────────────────────────────────────────────────────────

// Local alias — the panel only uses a subset of CoreMember's fields.
type Member = CoreMember;

const MEMBERS_PAGE_SIZE = 200;

function relativeTime(ms: number): string {
  const diffMs = Date.now() - ms;
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}

function MembersSection(props: { serverId: string }) {
  const [search, setSearch] = createSignal("");

  // Roles store powers the inline role picker in each row. Lazy-load on first
  // render of this tab; subsequent opens are no-ops.
  void ensureRolesLoaded(props.serverId);
  const rolesState = createMemo(() => rolesStoreFor(props.serverId)());

  // Actor context — for canManageTarget gating and `assignableRoles()`.
  // `account()` is the source of truth for owner identity (Central-issued);
  // `currentMember()` is the secondary check used when account isn't loaded.
  const me = currentMember;
  const isActorOwner = createMemo(() => {
    const acc = account();
    const srv = activeServer();
    if (acc && srv && acc.id === srv.owner_id) return true;
    return me()?.is_owner === true;
  });
  const actorLevel = createMemo(() => {
    if (isActorOwner()) return Number.POSITIVE_INFINITY;
    return me()?.level ?? 0;
  });
  const dropdownRoles = createMemo(() =>
    assignableRoles(actorLevel(), isActorOwner(), rolesState().roles),
  );

  // Paginated state. `members` is the accumulated buffer across pages.
  // `cursor` is null while a page is loading or before the first fetch.
  const [members, setMembers] = createSignal<Member[]>([]);
  const [total, setTotal] = createSignal(0);
  const [cursor, setCursor] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [loadError, setLoadError] = createSignal(false);

  // Sentinel intersection observer ref for the infinite-scroll trigger.
  let sentinelEl: HTMLDivElement | undefined;

  /**
   * Load one page. When `reset` is true, replaces the buffer; otherwise
   * appends. Server-side ordering is `joined_at DESC`, so a reset returns
   * the freshest members first — matches the section's intent.
   */
  async function loadPage(reset: boolean): Promise<void> {
    if (loading()) return;
    setLoading(true);
    setLoadError(false);
    try {
      const opts: { limit: number; cursor?: string } = { limit: MEMBERS_PAGE_SIZE };
      if (!reset) {
        const c = cursor();
        if (c === null) {
          // No more pages.
          setLoading(false);
          return;
        }
        opts.cursor = c;
      }
      const res = await coreClient.member.list(props.serverId, opts);
      // Defensive: a malformed response (missing/null `members` field) must
      // not poison the signal — once `members()` becomes undefined, every
      // downstream `.length`/`.filter()` throws and the whole sheet wedges.
      const page = Array.isArray(res?.members) ? res.members : [];
      setMembers((prev) => (reset ? page : [...prev, ...page]));
      setTotal(typeof res?.total === "number" ? res.total : 0);
      setCursor(res?.next_cursor ?? null);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }

  // Initial load — fire once. Subsequent reloads come from the event listener.
  void loadPage(true);

  // Re-fetch when a member joins or comes online/offline. Resets to page 1
  // because rejoin/online flips can mutate any page; cheaper to refresh than
  // to track per-row diffs.
  const unsub = onPluginMessage(
    props.serverId,
    "core",
    (msg) => {
      const ev = msg as { type?: string; topic?: string };
      if (
        ev.type === "event" &&
        (ev.topic === "core.member.joined" ||
          ev.topic === "core.user.online" ||
          ev.topic === "core.user.offline")
      ) {
        void loadPage(true);
      }
    },
    "members-panel",
  );
  onCleanup(() => unsub());

  // Infinite scroll: when the sentinel enters the scroll viewport, fetch
  // the next page. Only attaches once the first page has settled and a
  // next_cursor exists. The viewport is the SheetContent's overflow-y-auto
  // container — IntersectionObserver auto-resolves the nearest scroll root.
  createEffect(() => {
    if (!sentinelEl) return;
    if (cursor() === null) return; // no more pages — no observer needed
    const obs = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            void loadPage(false);
          }
        }
      },
      { rootMargin: "200px" },
    );
    obs.observe(sentinelEl);
    onCleanup(() => obs.disconnect());
  });

  const filtered = createMemo(() => {
    const q = search().trim().toLowerCase();
    const list = members();
    if (!q) return list;
    return list.filter((m) => m.display_name.toLowerCase().includes(q));
  });

  const onlineMembers = createMemo(() => filtered().filter((m) => m.is_online));
  const offlineMembers = createMemo(() => filtered().filter((m) => !m.is_online));

  // Loaded count vs server total. The summary line shows "loaded / total"
  // when a paginated tail is still pending so the user knows there is more.
  const loadedCount = createMemo(() => members().length);
  const onlineCount = createMemo(() => members().filter((m) => m.is_online).length);
  const showInitialSpinner = createMemo(() => loading() && members().length === 0);

  return (
    <div class="flex flex-col">
      {/* Summary line */}
      <p class="px-4 pt-4 pb-1 text-[10px] text-muted-foreground">
        <Show when={!showInitialSpinner()} fallback="Loading…">
          <Show
            when={loadedCount() < total()}
            fallback={`${loadedCount()} member${loadedCount() === 1 ? "" : "s"} · ${onlineCount()} online`}
          >
            {loadedCount()} of {total()} member{total() === 1 ? "" : "s"} · {onlineCount()} online (loaded)
          </Show>
        </Show>
      </p>

      {/* Search bar */}
      <div class="relative mx-4 mt-1 mb-2">
        <Search class="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground pointer-events-none" />
        <input
          type="text"
          placeholder="Search members…"
          class="w-full h-8 pl-8 pr-3 text-sm bg-muted/50 border border-border rounded-md outline-none focus:border-border/60 placeholder:text-muted-foreground/60"
          value={search()}
          onInput={(e) => setSearch(e.currentTarget.value)}
        />
      </div>

      {/* Loading spinner — only on the initial fetch. Subsequent page loads
          show their own inline spinner near the sentinel below. */}
      <Show when={showInitialSpinner()}>
        <div class="flex items-center justify-center py-8">
          <div class="size-5 animate-spin rounded-full border-2 border-border border-t-foreground/60" />
        </div>
      </Show>

      {/* Error state */}
      <Show when={loadError() && members().length === 0}>
        <div class="flex items-center justify-center py-8">
          <p class="text-sm text-destructive/80">Failed to load members.</p>
        </div>
      </Show>

      {/* Empty state */}
      <Show when={!showInitialSpinner() && !loadError() && filtered().length === 0}>
        <div class="flex items-center justify-center py-8">
          <p class="text-sm text-muted-foreground">
            {members().length === 0 ? "No members yet." : "No members match your search."}
          </p>
        </div>
      </Show>

      {/* Member list */}
      <Show when={!showInitialSpinner() && filtered().length > 0}>
        {/* Online group */}
        <Show when={onlineMembers().length > 0}>
          <p class="px-4 py-1.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
            Online — {onlineMembers().length}
          </p>
          <For each={onlineMembers()}>
            {(member) => (
              <MemberRow
                member={member}
                serverId={props.serverId}
                roles={rolesState().roles}
                dropdownRoles={dropdownRoles()}
                actorLevel={actorLevel()}
                isActorOwner={isActorOwner()}
                actorUserId={account()?.id ?? null}
                ownerUserId={activeServer()?.owner_id ?? null}
                onSaved={() => void loadPage(true)}
              />
            )}
          </For>
        </Show>

        {/* Offline group */}
        <Show when={offlineMembers().length > 0}>
          <p class="px-4 py-1.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
            Offline — {offlineMembers().length}
          </p>
          <For each={offlineMembers()}>
            {(member) => (
              <MemberRow
                member={member}
                serverId={props.serverId}
                roles={rolesState().roles}
                dropdownRoles={dropdownRoles()}
                actorLevel={actorLevel()}
                isActorOwner={isActorOwner()}
                actorUserId={account()?.id ?? null}
                ownerUserId={activeServer()?.owner_id ?? null}
                onSaved={() => void loadPage(true)}
              />
            )}
          </For>
        </Show>

        {/* Infinite-scroll sentinel — invisible 1px box that the observer
            watches. Only rendered while there are more pages so the cleanup
            runs as soon as the tail is drained. */}
        <Show when={cursor() !== null}>
          <div ref={sentinelEl} class="h-px" aria-hidden="true" />
          <Show when={loading()}>
            <div class="flex items-center justify-center py-3">
              <div class="size-4 animate-spin rounded-full border-2 border-border border-t-foreground/60" />
            </div>
          </Show>
        </Show>
      </Show>
    </div>
  );
}

interface MemberRowProps {
  member: Member;
  serverId: string;
  /** Full roles list (used to resolve the row's current role label). */
  roles: readonly CoreRole[];
  /** Roles the actor is allowed to assign (already filtered). */
  dropdownRoles: readonly CoreRole[];
  actorLevel: number;
  isActorOwner: boolean;
  /** Central account id of the actor — used to hide the picker on self-rows. */
  actorUserId: string | null;
  /** Server owner's Central account id — used to label the owner row. The
   *  CoreMember list payload doesn't carry an `is_owner` flag (see
   *  protocol/core.ts CoreMember), so rows infer it by comparing to the
   *  server's `owner_id`. */
  ownerUserId: string | null;
  /** Called after a successful assign so the parent can refetch the page. */
  onSaved: () => void;
}

function MemberRow(props: MemberRowProps) {
  const m = () => props.member;
  const initial = () => m().display_name.charAt(0).toUpperCase();

  // Current role row — resolved from the loaded roles list. `null` means
  // "no explicit assignment" (default `member` fallback). Owner targets are
  // reported as role_id null too; the picker visibility check filters them
  // out via the level-hierarchy gate below, not by inspecting role_id.
  const currentRole = createMemo<CoreRole | null>(() => {
    const id = m().role_id;
    if (id === null) return null;
    return props.roles.find((r) => r.id === id) ?? null;
  });

  // Owner row detection. CoreMember has no is_owner field — owners are
  // identified by matching the server's owner_id (threaded in by the parent).
  const isOwnerRow = createMemo(() => {
    const oid = props.ownerUserId;
    return oid !== null && oid === m().id;
  });

  // Display label for the role chip. Owners outrank any role (virtual
  // level 100, role row not read — see protocol/core.ts), so surface them
  // explicitly instead of falling through to the "member" default.
  const roleLabel = createMemo(() => {
    if (isOwnerRow()) return "owner";
    return currentRole()?.name ?? "member";
  });

  // Effective target level for hierarchy gating. Default fallback (no
  // assignment) is the engine's `member` level — find it in the roles list,
  // or assume level 10 if roles aren't loaded yet.
  const targetLevel = createMemo(() => {
    const cur = currentRole();
    if (cur) return cur.level;
    const memberRole = props.roles.find((r) => r.name === "member");
    return memberRole?.level ?? 10;
  });

  // Picker visibility:
  //  - hide on self (mirrors Q1 — UI never offers self-management)
  //  - hide if dropdown has no options (actor would have nothing to pick)
  //  - hide if actor cannot manage this target (engine: actorLevel > targetLevel)
  const canEdit = createMemo(() => {
    if (props.actorUserId !== null && props.actorUserId === m().id) return false;
    if (props.dropdownRoles.length === 0) return false;
    if (props.isActorOwner) return true;
    return props.actorLevel > targetLevel();
  });

  // Picker state. Two phases:
  //   editing=false → compact role chip ("moderator"). Click expands.
  //   editing=true  → <select> + (Save when dirty) + cancel X. Save collapses
  //                   back to false on success; cancel discards local edit.
  // `selectedRoleId` only matters while editing; we re-seed it from the
  // persisted value every time we open the picker.
  const [editing, setEditing] = createSignal(false);
  const [selectedRoleId, setSelectedRoleId] = createSignal<number | null>(
    m().role_id,
  );
  const [submitting, setSubmitting] = createSignal(false);
  const dirty = createMemo(() => selectedRoleId() !== m().role_id);

  // If the underlying member changes (refetch), keep the dropdown aligned to
  // truth so a stale local choice can't linger past a save by another actor.
  createEffect(() => {
    setSelectedRoleId(m().role_id);
  });

  function openPicker(): void {
    setSelectedRoleId(m().role_id);
    setEditing(true);
  }

  function cancelPicker(): void {
    if (submitting()) return;
    setSelectedRoleId(m().role_id);
    setEditing(false);
  }

  async function onSave(): Promise<void> {
    if (!dirty() || submitting()) return;
    setSubmitting(true);
    try {
      const next = selectedRoleId();
      if (next === null) {
        // "Default member" — remove explicit assignment.
        await coreClient.role.remove(props.serverId, m().id);
      } else {
        await coreClient.role.assign(props.serverId, m().id, next);
      }
      await refetchRoles(props.serverId);
      props.onSaved();
      showInlineStatus(`Updated ${m().display_name}'s role.`, "info");
      setEditing(false);
    } catch (err) {
      const msg =
        err instanceof CoreError ? err.message : "Could not change role.";
      showInlineStatus(msg, "error");
      // Revert local selection so the UI matches authoritative state. Stay
      // in edit mode so the user can adjust and retry without re-clicking.
      setSelectedRoleId(m().role_id);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div class="flex items-center gap-3 px-4 py-2 hover:bg-muted/40 transition-colors">
      {/* Avatar */}
      <div class="relative shrink-0">
        <div
          class="size-8 rounded-full flex items-center justify-center overflow-hidden text-white text-xs font-semibold select-none"
          style={!m().avatar_url ? {
            background: "linear-gradient(135deg, oklch(0.38 0.12 260), oklch(0.32 0.09 220))",
          } : {}}
        >
          <Show
            when={m().avatar_url}
            fallback={<span>{initial()}</span>}
          >
            <img
              src={m().avatar_url}
              alt={m().display_name}
              class="size-full object-cover"
            />
          </Show>
        </div>
        {/* Status dot */}
        <span
          class="absolute bottom-0 right-0 size-2 rounded-full ring-2 ring-background"
          style={{
            background: m().is_online
              ? "oklch(0.72 0.18 145)"
              : "oklch(0.45 0 0)",
          }}
        />
      </div>

      {/* Name + sub-line — only the offline "last seen" hint, since the
          role chip on the right already surfaces role at a glance. */}
      <div class="min-w-0 flex-1">
        <p class={cn("text-sm font-medium truncate", !m().is_online && "text-muted-foreground")}>
          {m().display_name}
        </p>
        <Show when={!m().is_online}>
          <p class="text-[11px] text-muted-foreground/70 truncate">
            Last seen {relativeTime(m().last_seen_at)}
          </p>
        </Show>
      </div>

      {/* Role chip → expands into picker on click. Read-only chip when the
          actor can't manage the target (own row, owner row, insufficient
          level). */}
      <Show
        when={canEdit() && editing()}
        fallback={
          <Show when={canEdit()} fallback={
            <span class="shrink-0 inline-flex items-center h-6 px-2 rounded-full border border-border bg-muted/40 text-[11px] text-foreground/80">
              {roleLabel()}
            </span>
          }>
            <button
              type="button"
              class="shrink-0 h-6 px-2 rounded-full border border-border bg-muted/40 text-[11px] text-foreground/80 hover:bg-muted hover:border-border/60 transition-colors"
              onClick={openPicker}
              data-tooltip="Change role"
            >
              {roleLabel()}
            </button>
          </Show>
        }
      >
        <div class="flex items-center gap-1 shrink-0">
          <select
            class="h-7 max-w-[7.5rem] rounded-md border border-input bg-background px-2 text-[11px] outline-none focus-visible:border-ring focus-visible:ring-[2px] focus-visible:ring-ring/40 disabled:opacity-50"
            value={selectedRoleId() ?? ""}
            disabled={submitting()}
            ref={(el) => queueMicrotask(() => el?.focus())}
            onChange={(e) => {
              const v = e.currentTarget.value;
              setSelectedRoleId(v === "" ? null : Number.parseInt(v, 10));
            }}
          >
            <option value="">Default member</option>
            <For each={props.dropdownRoles}>
              {(r) => <option value={r.id}>{r.name}</option>}
            </For>
          </select>
          <Show
            when={dirty()}
            fallback={
              <button
                type="button"
                class="size-6 flex items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors disabled:opacity-50"
                disabled={submitting()}
                onClick={cancelPicker}
                data-tooltip="Cancel"
                aria-label="Cancel role change"
              >
                <X class="size-3.5" />
              </button>
            }
          >
            <Button
              size="sm"
              class="h-7 px-2 text-[11px]"
              disabled={submitting()}
              onClick={onSave}
            >
              {submitting() ? "Saving…" : "Save"}
            </Button>
          </Show>
        </div>
      </Show>
    </div>
  );
}

// ── Icon section ─────────────────────────────────────────────────────────────

function IconSection(props: { server: Server }) {
  const iconInputId = "server-settings-icon-input";
  const [iconPreview, setIconPreview] = createSignal<string | null>(null);
  const [uploading, setUploading] = createSignal(false);
  const [uploadError, setUploadError] = createSignal<string | null>(null);

  const initial = () => props.server.name.charAt(0).toUpperCase();
  // Pin to the per-server icon version so a fresh upload (which bumps the
  // version below) reactively replaces the <img> src and the browser refetches
  // instead of showing the cached pre-upload bytes.
  const iconUrl = () => {
    const tunnel = props.server.tunnel_url;
    if (!tunnel) return null;
    const v = getServerIconVersion(props.server.id);
    return v > 0 ? `${tunnel}/icon?v=${String(v)}` : `${tunnel}/icon`;
  };

  async function handleIconChange(e: Event) {
    const file = (e.currentTarget as HTMLInputElement).files?.[0];
    if (!file) return;

    setUploadError(null);
    setUploading(true);

    const prev = iconPreview();
    if (prev) URL.revokeObjectURL(prev);
    setIconPreview(URL.createObjectURL(file));

    try {
      const tunnelUrl = props.server.tunnel_url;
      if (!tunnelUrl) throw new Error("Server has no tunnel URL — bring it online first.");
      const { token } = await central.getServerToken(props.server.id);
      const formData = new FormData();
      formData.append("icon", file);
      const res = await fetch(`${tunnelUrl}/admin/api/icon`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });
      if (!res.ok) {
        let detail = `${res.status}`;
        try {
          const body = await res.json() as { error?: { code?: string; message?: string } };
          if (body.error?.message) detail = body.error.message;
          else if (body.error?.code) detail = body.error.code;
        } catch { /* ignore */ }
        throw new Error(`Upload failed: ${detail}`);
      }
      // Bump the uploader's local cache buster directly so the preview
      // refreshes without depending on the WS broadcast race.
      let updatedAt = Date.now();
      try {
        const body = (await res.json()) as { updatedAt?: number };
        if (typeof body.updatedAt === "number") updatedAt = body.updatedAt;
      } catch {
        // Body parse failure is fine — fall back to client clock.
      }
      bumpServerIconVersion(props.server.id, updatedAt);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed");
      // revert preview on failure
      setIconPreview(null);
    } finally {
      setUploading(false);
      const el = document.getElementById(iconInputId) as HTMLInputElement | null;
      if (el) el.value = "";
    }
  }

  return (
    <section>
      <div
        class="flex flex-col items-center gap-3 border-b border-border px-4 py-6"
        style={{
          background:
            "radial-gradient(ellipse 80% 60% at 50% 0%, color-mix(in oklch, var(--sidebar-primary) 12%, transparent), transparent)",
        }}
      >
        {/* Icon preview */}
        <div class="relative">
          <div class={cn("size-20 rounded-xl flex items-center justify-center overflow-hidden", !(iconPreview() ?? iconUrl()) && "bg-sidebar-primary")}>
            <Show
              when={iconPreview() ?? iconUrl()}
              fallback={
                <span class="text-3xl font-bold text-sidebar-primary-foreground select-none">
                  {initial()}
                </span>
              }
            >
              {(src) => (
                <img
                  src={src()}
                  alt={props.server.name}
                  class="size-full object-cover"
                  onError={() => setIconPreview(null)}
                />
              )}
            </Show>
          </div>
          <Show when={uploading()}>
            <div class="absolute inset-0 flex items-center justify-center rounded-xl bg-black/50">
              <div class="size-5 animate-spin rounded-full border-2 border-white border-t-transparent" />
            </div>
          </Show>
        </div>

        <p class="font-semibold">{props.server.name}</p>

        {/* Upload button */}
        <div class="flex flex-col items-center gap-1">
          <label
            for={iconInputId}
            class="flex cursor-pointer items-center gap-1.5 rounded-md border border-border bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <input
              id={iconInputId}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              class="sr-only"
              onChange={(e) => void handleIconChange(e)}
            />
            <Upload class="size-3" />
            {uploading() ? "Uploading…" : "Upload icon"}
          </label>
          <Show when={!props.server.tunnel_url}>
            <p class="text-[10px] text-muted-foreground/60 text-center">
              Server must be online to upload an icon
            </p>
          </Show>
          <Show when={uploadError()}>
            <p class="text-xs text-destructive text-center max-w-[200px]">{uploadError()}</p>
          </Show>
        </div>
      </div>
    </section>
  );
}

// ── Edit section ────────────────────────────────────────────────────────────

function EditSection(props: {
  serverId: string;
  currentName: string;
  currentDescription: string | null;
  onClose: () => void;
}) {
  const [name, setName] = createSignal(props.currentName);
  const [description, setDescription] = createSignal(props.currentDescription ?? "");
  const [saveStatus, setSaveStatus] = createSignal<"idle" | "saving" | "saved" | "error">("idle");

  const unchanged = () =>
    name().trim() === props.currentName &&
    (description().trim() || null) === props.currentDescription;

  async function handleSave() {
    if (saveStatus() === "saving" || unchanged() || !name().trim()) return;
    setSaveStatus("saving");
    try {
      await central.patchServer(props.serverId, {
        name: name().trim(),
        description: description().trim() || null,
      });
      await loadServers();
      setSaveStatus("saved");
      setTimeout(() => setSaveStatus("idle"), 2000);
    } catch (err) {
      console.error("[EditSection] patchServer failed:", err);
      setSaveStatus("error");
      setTimeout(() => setSaveStatus("idle"), 3000);
    }
  }

  return (
    <section>
      <p class="px-4 pb-2 pt-4 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
        General
      </p>

      <div class="space-y-3 px-4 pb-4">
        <div class="space-y-1.5">
          <label class="text-xs font-medium text-muted-foreground">Server name</label>
          <Input
            value={name()}
            onInput={(e) => setName(e.currentTarget.value)}
            class="h-8 text-sm"
          />
        </div>

        <div class="space-y-1.5">
          <label class="text-xs font-medium text-muted-foreground">Description</label>
          <Input
            value={description()}
            onInput={(e) => setDescription(e.currentTarget.value)}
            placeholder="What's this server for?"
            class="h-8 text-sm"
          />
        </div>

        <div class="flex items-center gap-2 pt-1">
          <Button
            size="sm"
            class="h-8"
            disabled={unchanged() || !name().trim() || saveStatus() === "saving"}
            onClick={() => void handleSave()}
          >
            {saveStatus() === "saving" ? "Saving…" : "Save changes"}
          </Button>
          <Show when={saveStatus() === "saved"}>
            <p class="text-xs text-emerald-500">Saved</p>
          </Show>
          <Show when={saveStatus() === "error"}>
            <p class="text-xs text-destructive">Failed to save</p>
          </Show>
        </div>
      </div>
    </section>
  );
}

// ── Info section ─────────────────────────────────────────────────────────────

function InfoSection(props: { server: Server }) {
  const s = () => props.server;
  return (
    <section>
      <p class="px-4 pb-2 pt-4 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
        Info
      </p>
      <div class="space-y-2 px-4 pb-4">
        <InfoRow label="Visibility" value={s().visibility} />
        <InfoRow label="Status" value={s().is_online ? "Online" : "Offline"} />
        <Show when={s().tunnel_url}>
          <InfoRow label="Tunnel URL" value={s().tunnel_url!} monospace />
        </Show>
        <InfoRow label="Plugins installed" value={String(s().plugin_count)} />
        <InfoRow
          label="Created"
          value={new Date(s().created_at).toLocaleDateString(undefined, {
            year: "numeric",
            month: "long",
            day: "numeric",
          })}
        />
      </div>
    </section>
  );
}

function InfoRow(props: { label: string; value: string; monospace?: boolean }) {
  return (
    <div class="flex items-start justify-between gap-4 rounded-lg border border-border bg-muted/30 px-3 py-2">
      <span class="text-xs text-muted-foreground shrink-0">{props.label}</span>
      <span
        class="text-xs text-right break-all"
        classList={{ "font-mono": props.monospace === true }}
      >
        {props.value}
      </span>
    </div>
  );
}

// ── Categories section ────────────────────────────────────────────────────────

const CATEGORY_NAME_MAX = 64;

interface TextChannel {
  id: string;
  name: string;
  topic: string;
  created_at: number;
  category_id: string | null;
  position: number;
}

function CategoriesSection(props: { serverId: string }) {
  const [tick, setTick] = createSignal(0);
  const [channelsTick, setChannelsTick] = createSignal(0);
  const [createName, setCreateName] = createSignal("");
  const [editingId, setEditingId] = createSignal<string | null>(null);
  const [editingName, setEditingName] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);

  const [cats] = createResource(tick, () =>
    request<{ categories: CoreCategory[] }>(props.serverId, "core", "core.categories.list", {})
      .then((r) => r.categories)
      .catch(() => [] as CoreCategory[]),
  );

  // Channels assignment list — lets admins reassign a channel's category from
  // a dropdown. Sourced from the text-channels plugin; tolerates the plugin
  // being absent (returns []), which simply hides the assignments subsection.
  const [channels] = createResource(channelsTick, () =>
    request<TextChannel[]>(props.serverId, "text-channels", "getChannels", {})
      .catch(() => [] as TextChannel[]),
  );

  const unsub = onPluginMessage(
    props.serverId,
    "core",
    (msg) => {
      const ev = msg as { type?: string; topic?: string };
      if (ev.type === "event" && typeof ev.topic === "string" && ev.topic.startsWith("core.category.")) {
        setTick((t) => t + 1);
      }
    },
    "categories-panel",
  );
  onCleanup(() => unsub());

  // Re-fetch channels when text-channels publishes a relevant event.
  const unsubChannels = onPluginMessage(
    props.serverId,
    "text-channels",
    (msg) => {
      const ev = msg as { type?: string; topic?: string };
      if (ev.type === "event" && typeof ev.topic === "string" && ev.topic.startsWith("text-channels.channel.")) {
        setChannelsTick((t) => t + 1);
      }
    },
    "categories-panel-channels",
  );
  onCleanup(() => unsubChannels());

  async function handleAssignChannel(channelId: string, raw: string) {
    setError(null);
    setBusy(true);
    try {
      await request(props.serverId, "text-channels", "updateChannel", {
        id: channelId,
        category_id: raw === "" ? null : raw,
      });
      setChannelsTick((t) => t + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to move channel");
    } finally {
      setBusy(false);
    }
  }

  async function handleCreate(e: Event) {
    e.preventDefault();
    const n = createName().trim();
    if (!n) return;
    setError(null);
    setBusy(true);
    try {
      await request(props.serverId, "core", "core.categories.create", { name: n });
      setCreateName("");
      setTick((t) => t + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create category");
    } finally {
      setBusy(false);
    }
  }

  function startRename(c: CoreCategory) {
    setEditingId(c.id);
    setEditingName(c.name);
    setError(null);
  }

  function cancelRename() {
    setEditingId(null);
    setEditingName("");
  }

  async function commitRename(id: string) {
    const n = editingName().trim();
    if (!n) {
      cancelRename();
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await request(props.serverId, "core", "core.categories.update", { id, name: n });
      cancelRename();
      setTick((t) => t + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to rename category");
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(c: CoreCategory) {
    if (!confirm(`Delete category "${c.name}"? Items in this category become Uncategorized.`)) return;
    setError(null);
    setBusy(true);
    try {
      await request(props.serverId, "core", "core.categories.delete", { id: c.id });
      setTick((t) => t + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete category");
    } finally {
      setBusy(false);
    }
  }

  async function move(c: CoreCategory, dir: -1 | 1) {
    const list = cats() ?? [];
    const idx = list.findIndex((x) => x.id === c.id);
    const swap = idx + dir;
    if (idx < 0 || swap < 0 || swap >= list.length) return;
    const next = list.slice();
    const tmp = next[idx]!;
    next[idx] = next[swap]!;
    next[swap] = tmp;
    setError(null);
    setBusy(true);
    try {
      await request(props.serverId, "core", "core.categories.reorder", {
        orderedIds: next.map((x) => x.id),
      });
      setTick((t) => t + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reorder categories");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="flex flex-col">
      <Show
        when={isAdmin()}
        fallback={
          <div class="flex flex-1 items-center justify-center p-6">
            <p class="text-sm text-muted-foreground">Admin role required to manage categories.</p>
          </div>
        }
      >
        <Show when={error()}>
          <p class="mx-4 mt-3 text-xs text-destructive">{error()}</p>
        </Show>

        {/* Create form */}
        <form
          class="flex gap-2 p-4 border-b border-border"
          onSubmit={(e) => void handleCreate(e)}
        >
          <input
            type="text"
            placeholder="Category name"
            maxLength={CATEGORY_NAME_MAX}
            class="h-8 flex-1 px-3 text-sm bg-muted/50 border border-border rounded-md outline-none focus:border-border/60 placeholder:text-muted-foreground/60"
            value={createName()}
            onInput={(e) => setCreateName(e.currentTarget.value)}
            disabled={busy()}
          />
          <button
            type="submit"
            class="h-8 px-3 text-xs font-medium bg-foreground text-background rounded-md hover:opacity-85 transition-opacity shrink-0 disabled:opacity-50"
            disabled={busy() || !createName().trim()}
          >
            Add
          </button>
        </form>

        {/* List */}
        <div class="flex flex-col p-4 gap-1.5">
          <Show
            when={(cats() ?? []).length > 0}
            fallback={
              <p class="text-xs text-muted-foreground">No categories yet.</p>
            }
          >
            <For each={cats() ?? []}>
              {(c, i) => {
                const isEditing = () => editingId() === c.id;
                return (
                  <div class="flex items-center gap-1 rounded-md border border-border bg-muted/30 px-2 py-1.5">
                    <div class="flex flex-col">
                      <button
                        type="button"
                        class="flex h-4 w-5 items-center justify-center text-muted-foreground hover:text-foreground disabled:opacity-30"
                        disabled={busy() || i() === 0}
                        onClick={() => void move(c, -1)}
                        data-tooltip="Move up"
                      >
                        <ChevronUp class="size-3" />
                      </button>
                      <button
                        type="button"
                        class="flex h-4 w-5 items-center justify-center text-muted-foreground hover:text-foreground disabled:opacity-30"
                        disabled={busy() || i() === (cats() ?? []).length - 1}
                        onClick={() => void move(c, 1)}
                        data-tooltip="Move down"
                      >
                        <ChevronDown class="size-3" />
                      </button>
                    </div>

                    <Show
                      when={isEditing()}
                      fallback={
                        <span class="flex-1 text-sm truncate px-1">{c.name}</span>
                      }
                    >
                      <input
                        type="text"
                        class="h-7 flex-1 px-2 text-sm bg-background border border-border rounded outline-none focus:border-border/60"
                        value={editingName()}
                        maxLength={CATEGORY_NAME_MAX}
                        autofocus
                        onInput={(e) => setEditingName(e.currentTarget.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            void commitRename(c.id);
                          } else if (e.key === "Escape") {
                            e.preventDefault();
                            cancelRename();
                          }
                        }}
                        onBlur={() => {
                          if (!busy()) void commitRename(c.id);
                        }}
                        disabled={busy()}
                      />
                    </Show>

                    <Show when={!isEditing()}>
                      <button
                        type="button"
                        class="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                        onClick={() => startRename(c)}
                        disabled={busy()}
                        data-tooltip="Rename"
                      >
                        <Pencil class="size-3" />
                      </button>
                      <button
                        type="button"
                        class="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-destructive hover:text-white"
                        onClick={() => void handleDelete(c)}
                        disabled={busy()}
                        data-tooltip="Delete"
                      >
                        <Trash2 class="size-3" />
                      </button>
                    </Show>
                  </div>
                );
              }}
            </For>
          </Show>
        </div>

        {/* Channel assignments — only rendered when text-channels exposes some
          * channels. A missing plugin returns []. */}
        <Show when={(channels() ?? []).length > 0}>
          <div class="border-t border-border" />
          <div class="flex flex-col p-4 gap-1.5">
            <p class="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">
              Channels
            </p>
            <For each={channels() ?? []}>
              {(ch) => (
                <div class="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-2 py-1.5">
                  <span class="flex-1 text-sm truncate"># {ch.name}</span>
                  <select
                    class="h-7 px-2 text-xs bg-background border border-border rounded outline-none focus:border-border/60 disabled:opacity-50"
                    value={ch.category_id ?? ""}
                    disabled={busy()}
                    onChange={(e) =>
                      void handleAssignChannel(ch.id, e.currentTarget.value)
                    }
                  >
                    <option value="">Uncategorized</option>
                    <For each={cats() ?? []}>
                      {(c) => <option value={c.id}>{c.name}</option>}
                    </For>
                  </select>
                </div>
              )}
            </For>
          </div>
        </Show>
      </Show>
    </div>
  );
}

// ── Danger section ──────────────────────────────────────────────────────────

function DangerSection(props: { serverId: string; serverName: string; onClose: () => void }) {
  const [confirming, setConfirming] = createSignal(false);
  const [deleting, setDeleting] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  async function handleDelete() {
    if (deleting()) return;
    setDeleting(true);
    setError(null);
    try {
      await central.deleteServer(props.serverId);
      await purgeServer(props.serverId, "user-delete");
      props.onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete server");
      setDeleting(false);
    }
  }

  return (
    <section>
      <p class="px-4 pb-2 pt-4 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
        Runtime update
      </p>
      <div class="px-4 pb-4">
        <RuntimeUpdatePanel
          serverId={props.serverId}
          onBeforeRestart={() => props.onClose()}
        />
      </div>

      <p class="px-4 pb-2 pt-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
        Danger zone
      </p>
      <div class="px-4 pb-6">
        <Show
          when={confirming()}
          fallback={
            <div class="rounded-lg border border-destructive/20 bg-destructive/5 p-3">
              <p class="mb-3 text-xs text-muted-foreground">
                Deleting this server will stop and remove the Docker container, delete
                all server data, and remove it from Central permanently.
              </p>
              <Button
                variant="destructive"
                size="sm"
                class="w-full"
                onClick={() => setConfirming(true)}
              >
                <Trash2 class="size-4" />
                Delete server
              </Button>
            </div>
          }
        >
          <div class="rounded-lg border border-destructive/30 bg-destructive/5 p-3 space-y-3">
            <div class="flex items-start gap-2.5">
              <AlertTriangle class="size-4 text-destructive shrink-0 mt-0.5" />
              <div>
                <p class="text-sm font-semibold text-destructive">This cannot be undone</p>
                <p class="mt-0.5 text-xs text-muted-foreground">
                  Delete <strong class="text-foreground">{props.serverName}</strong> and all
                  its data permanently?
                </p>
              </div>
            </div>

            <Show when={error()}>
              <p class="text-xs text-destructive">{error()}</p>
            </Show>

            <div class="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                class="flex-1 h-8"
                disabled={deleting()}
                onClick={() => {
                  setConfirming(false);
                  setError(null);
                }}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                size="sm"
                class="flex-1 h-8"
                disabled={deleting()}
                onClick={() => void handleDelete()}
              >
                {deleting() ? "Deleting…" : "Yes, delete"}
              </Button>
            </div>
          </div>
        </Show>
      </div>
    </section>
  );
}
