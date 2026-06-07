// Generic sidebar section renderer — driven entirely by plugin-contributed
// SidebarItem data. No knowledge of channels, members, or any specific plugin.
//
// Admin controls (+ to create, ⋯ per item) are shown only when the plugin
// includes adminActions in the item data — the shell never decides who sees what.

import { For, Index, Show, createMemo, createSignal, type Component, type JSX } from "solid-js";
import { Dynamic } from "solid-js/web";
import { Hash, Users, Volume2, VolumeX, Plus, Lock, Loader2, MicOff, Pencil, Trash2, Settings, type LucideProps } from "lucide-solid";
import { getClientColor, getNameInitial } from "@uncorded/shared";
import { AvatarStack } from "@/components/ui/avatar-stack";
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipLabel, TooltipTrigger } from "@/components/ui/tooltip";
import { activeServerId } from "@/stores/servers";
import { request } from "@/lib/ws";
import {
  categories,
  getPluginRuntimeCapabilities,
  getPluginReady,
  type SidebarSection,
  type SidebarItem,
} from "@/stores/sidebar";
import { isCollapsed, toggleCollapsed } from "@/stores/sidebar-collapse";
import * as voiceManager from "@/lib/voice-manager";
import { isVoiceProvisioned } from "@/lib/voice-manager";
import { openVoiceSetup } from "@/stores/voice-setup";
import { isVoiceUnreachable } from "@/stores/voice-reachability";
import type { ParticipantSnapshot } from "@uncorded/plugin-sdk-frontend";
import {
  shouldIgnoreDragStart,
  startPointerDrag,
  type DropTarget,
} from "@/lib/drag-state";
import { createContextGesture } from "@/lib/context-gesture";
import { openUserCard } from "@/stores/user-card";

// Map icon names (from plugin manifests) to lucide components.
const ICON_MAP: Record<string, Component<LucideProps>> = {
  hash: Hash,
  users: Users,
  volume2: Volume2,
};

function ItemIcon(props: { icon?: string }) {
  const C = () => ICON_MAP[props.icon ?? "hash"] ?? Hash;
  return <Dynamic component={C()} class="size-3.5 text-muted-foreground shrink-0" />;
}

// Dash-case action IDs (e.g. "create-channel") → camelCase WS actions ("createChannel").
function toWsAction(actionId: string): string {
  return actionId.replace(/-([a-z])/g, (_, c: string) => (c as string).toUpperCase());
}

// Categories are server-level top-level groups. They sit ABOVE plugin sections
// and aggregate items from any plugin by group_id. Plugin sections below render
// every item from their plugin (categorized or not) so each channel always has
// a discoverable home under its plugin's section, even when also surfaced in a
// category. Mental model: tags + folder. The category view is curated; the
// plugin view is the authoritative "everything I have of type X".
export function NavSidebarSections(props: {
  sections: SidebarSection[];
  onSelect?: (item: SidebarItem) => void;
  onItemDrop?: (item: SidebarItem, target: DropTarget) => void;
}) {
  const knownIds = createMemo(() => new Set(categories().map((c) => c.id)));

  const categoryBuckets = createMemo(() => {
    const ids = knownIds();
    const byCat = new Map<string, SidebarItem[]>();
    for (const section of props.sections) {
      for (const item of section.items) {
        const gid = item.group_id;
        if (typeof gid === "string" && ids.has(gid)) {
          const list = byCat.get(gid) ?? [];
          list.push(item);
          byCat.set(gid, list);
        }
      }
    }
    return categories()
      .map((c) => ({ category: c, items: byCat.get(c.id) ?? [] }))
      .filter((b) => b.items.length > 0);
  });

  return (
    <>
      <For each={categoryBuckets()}>
        {(bucket) => (
          <CategoryGroup
            id={bucket.category.id}
            name={bucket.category.name}
            items={bucket.items}
            {...(props.onSelect ? { onSelect: props.onSelect } : {})}
            {...(props.onItemDrop ? { onItemDrop: props.onItemDrop } : {})}
          />
        )}
      </For>
      <For each={props.sections}>
        {(section) => (
          <SidebarSection
            section={section}
            {...(props.onSelect ? { onSelect: props.onSelect } : {})}
            {...(props.onItemDrop ? { onItemDrop: props.onItemDrop } : {})}
          />
        )}
      </For>
    </>
  );
}

// Compact override for the shared SidebarGroup — tighter outer padding so
// stacked sections aren't visually heavy.
const GROUP_CLASS = "px-2 py-1";
// Compact label — h-7 instead of h-8. Whole row is the click target; affordance
// is the foreground-color shift on hover (no chevron). Cursor stays default
// (not pointer) so the row doesn't read as a "button" — the collapse is a
// quiet UX affordance, not a primary action.
const LABEL_CLASS =
  "h-7 select-none transition-colors hover:text-sidebar-foreground";
// Tighter inter-item gap.
const MENU_CLASS = "gap-0.5";
// Compact item button — h-7 with reduced padding. Hover-reveal of the
// inline settings button uses the parent SidebarMenuItem's named group
// (`group/menu-item`) — a bare `group` here would match the sidebar's
// own `group` class and fire on any sidebar hover.
const ITEM_CLASS =
  "peer/menu-button flex w-full items-center gap-2 overflow-hidden rounded-md px-2 py-1 text-sm h-7 cursor-grab active:cursor-grabbing hover:bg-sidebar-accent hover:text-sidebar-accent-foreground transition-colors select-none touch-none";

// Smooth open/close — grid-template-rows animates between 0fr (collapsed) and
// 1fr (expanded), letting the content auto-size while still transitioning.
// `display: none` would be jarring; max-height needs a magic number; this
// trick handles unknown content heights cleanly. The inner div needs
// overflow-hidden so the rows-collapse actually clips the children.
function CollapsibleContent(props: { open: boolean; children: JSX.Element }) {
  return (
    <div
      class="grid transition-[grid-template-rows] duration-200 ease-out"
      style={{ "grid-template-rows": props.open ? "1fr" : "0fr" }}
    >
      <div class="overflow-hidden">{props.children}</div>
    </div>
  );
}

// Top-level category — items can come from any plugin. Each item still renders
// with its plugin icon so the user can tell what kind of thing it is.
function CategoryGroup(props: {
  id: string;
  name: string;
  items: SidebarItem[];
  onSelect?: (item: SidebarItem) => void;
  onItemDrop?: (item: SidebarItem, target: DropTarget) => void;
}) {
  const collapseKey = () => `cat:${props.id}`;
  const open = () => !isCollapsed(collapseKey());
  return (
    <SidebarGroup class={GROUP_CLASS}>
      <SidebarGroupLabel
        class={LABEL_CLASS}
        onClick={() => toggleCollapsed(collapseKey())}
      >
        <span class="truncate">{props.name}</span>
      </SidebarGroupLabel>
      <CollapsibleContent open={open()}>
        <SidebarMenu class={MENU_CLASS}>
          <For each={props.items}>
            {(item) => (
              <SidebarItem
                item={item}
                {...(props.onSelect ? { onSelect: props.onSelect } : {})}
                {...(props.onItemDrop ? { onItemDrop: props.onItemDrop } : {})}
              />
            )}
          </For>
        </SidebarMenu>
      </CollapsibleContent>
    </SidebarGroup>
  );
}

function SidebarSection(props: {
  section: SidebarSection;
  onSelect?: (item: SidebarItem) => void;
  onItemDrop?: (item: SidebarItem, target: DropTarget) => void;
}) {
  // Detect a section-level "create" action. Prefer the new section-scoped
  // adminActions (so the create button shows even with zero items — fixes the
  // chicken-and-egg "fresh server has no channels and no way to make one"
  // case). Fall back to the legacy items[0].adminActions for plugins that
  // haven't migrated to the new shape yet.
  const createAction = () => {
    const fromSection = props.section.adminActions?.find((a) => a.id.startsWith("create-"));
    if (fromSection) return fromSection;
    return props.section.items[0]?.adminActions?.find((a) => a.id.startsWith("create-")) ?? null;
  };

  // Hide a section that has nothing for the viewer to do — no items to click,
  // no create button to render. Admins on a fresh server still see the section
  // (createAction is non-null) so they can bootstrap; non-admins on the same
  // server don't see a useless empty header.
  const isEmpty = createMemo(() => props.section.items.length === 0 && !createAction());
  const collapseKey = () => `sec:${props.section.slug}`;
  const open = () => !isCollapsed(collapseKey());

  return (
    <Show when={!isEmpty()}>
      <SidebarGroup class={GROUP_CLASS}>
        <SidebarGroupLabel
          class={LABEL_CLASS}
          onClick={() => toggleCollapsed(collapseKey())}
        >
          <span class="truncate">{props.section.section}</span>
        </SidebarGroupLabel>

        <Show when={createAction()}>
          {(action) => <CreateButton action={action()} slug={props.section.slug} />}
        </Show>

        <CollapsibleContent open={open()}>
          <SidebarMenu class={MENU_CLASS}>
            <For each={props.section.items}>
              {(item) => (
                <SidebarItem
                  item={item}
                  {...(props.onSelect ? { onSelect: props.onSelect } : {})}
                  {...(props.onItemDrop ? { onItemDrop: props.onItemDrop } : {})}
                />
              )}
            </For>
          </SidebarMenu>
        </CollapsibleContent>
      </SidebarGroup>
    </Show>
  );
}

// Inline create flow — shown as an absolute + button on the section header.
// Clicking it reveals an inline input; Enter submits, Escape cancels.
function CreateButton(props: { action: { id: string; label: string }; slug: string }) {
  const [creating, setCreating] = createSignal(false);
  const [name, setName] = createSignal("");
  const [error, setError] = createSignal("");
  const [saving, setSaving] = createSignal(false);

  let inputRef: HTMLInputElement | undefined;

  function startCreate(e: MouseEvent) {
    // Stop the click from bubbling to the SidebarGroupLabel collapse toggle.
    e.stopPropagation();
    setName("");
    setError("");
    setCreating(true);
    requestAnimationFrame(() => inputRef?.focus());
  }

  function cancel() {
    if (saving()) return;
    setCreating(false);
    setName("");
    setError("");
  }

  async function submit() {
    const n = name().trim();
    if (!n) {
      setError("Name is required");
      return;
    }
    const serverId = activeServerId();
    if (!serverId) return;
    setSaving(true);
    try {
      await request(serverId, props.slug, toWsAction(props.action.id), {
        name: n,
        topic: "",
      });
      setCreating(false);
      setName("");
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create");
    } finally {
      setSaving(false);
    }
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      void submit();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    }
  }

  return (
    <>
      <Tooltip>
        <TooltipTrigger
        data-sidebar="group-action"
        type="button"
        // top-2.5 (10px) centers a 20px-square button on a 28px (h-7) label
        // with 4px (py-1) top group padding: 4 + (28-20)/2 = 8px → top-2.
        class="absolute right-2 top-2 flex aspect-square w-5 items-center justify-center rounded-md p-0 text-sidebar-foreground outline-none ring-sidebar-ring transition-transform hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 [&>svg]:size-4 [&>svg]:shrink-0"
        onClick={startCreate}
      >
        <Plus class="size-4" />
        <span class="sr-only">{props.action.label}</span>
        </TooltipTrigger>
        <TooltipContent side="right">{props.action.label}</TooltipContent>
      </Tooltip>

      <Show when={creating()}>
        <SidebarMenu class={MENU_CLASS}>
          <SidebarMenuItem>
            <div class="flex flex-col gap-1 px-2 py-1">
              <input
                ref={inputRef}
                type="text"
                placeholder="channel-name"
                value={name()}
                onInput={(e) => setName(e.currentTarget.value)}
                onKeyDown={onKeyDown}
                onBlur={() => {
                  if (!saving()) cancel();
                }}
                disabled={saving()}
                class="h-7 w-full rounded border border-sidebar-border bg-sidebar-accent px-2 text-xs text-sidebar-foreground outline-none focus:border-sidebar-ring disabled:opacity-50"
              />
              <Show when={error()}>
                <p class="text-xs text-destructive px-0.5">{error()}</p>
              </Show>
            </div>
          </SidebarMenuItem>
        </SidebarMenu>
      </Show>
    </>
  );
}

// JoinedVoiceRoster — Discord-style expanded participant list rendered under
// the voice channel item the local user is currently joined to. Sources its
// data from the live LiveKit room via voiceManager (not from the
// SidebarPresence stack the server pushes), so per-user mute / volume reflect
// real-time state without a server round-trip.
function JoinedVoiceRoster() {
  // <Index> keys by position, not by item identity. Critical for the volume
  // slider: setLocalParticipantVolume rebuilds the participant object via
  // `prev.map(...)`, which gives the changed entry a new reference. <For>
  // would unmount/remount that row on every input event and the browser
  // would cancel the in-flight drag mid-stroke. <Index> keeps the row
  // mounted and just pushes a fresh accessor — drag survives.
  return (
    <ul class="flex flex-col gap-px pl-7 pr-2 pb-1 -mt-0.5">
      <Index each={voiceManager.participants()}>
        {(p) => <JoinedVoiceParticipantRow participant={p()} />}
      </Index>
    </ul>
  );
}

function JoinedVoiceParticipantRow(props: { participant: ParticipantSnapshot }) {
  const p = () => props.participant;
  const speaking = createMemo(() =>
    voiceManager.activeSpeakerIds().includes(p().userId),
  );
  const displayLabel = () => {
    const n = p().name;
    if (n && n.length > 0) return n;
    return `Member ${(p().identity ?? "").slice(0, 8)}`;
  };
  const isLocal = () => p().isLocal;
  const localMuted = () => p().localMuted === true;
  const volPct = () => Math.round((p().localVolume ?? 1) * 100);

  const onVolume = (e: Event) => {
    const t = e.currentTarget as HTMLInputElement;
    voiceManager.setLocalParticipantVolume(p().userId, Number(t.value) / 100);
  };

  const onToggleLocalMute = (e: MouseEvent) => {
    e.stopPropagation();
    voiceManager.setLocalParticipantMuted(p().userId, !localMuted());
  };

  const handleAvatarClick = (ev: MouseEvent) => {
    ev.stopPropagation();
    openUserCard({
      userId: p().userId,
      displayName: displayLabel(),
      avatarUrl: p().avatarUrl ?? null,
    });
  };

  // Controls (per-user mute + volume slider) are always rendered for remote
  // participants — no hover-reveal. Hover/focus toggling between
  // `display: none` and `display: flex` was fighting native pointer drag:
  // on a click-and-drag, the cursor leaves the row's bounding box almost
  // immediately, the row's `:hover` drops, and `display: none` cancelled
  // the in-flight drag. Touch devices have no `:hover` at all, so the
  // controls were unreachable on mobile entirely.
  return (
    <li class="flex flex-col gap-1 rounded px-1 py-1 hover:bg-sidebar-accent/40">
      <div class="flex items-center gap-2">
        <TooltipLabel label={displayLabel()} side="top">
          <button
            type="button"
            class="relative size-5 shrink-0 cursor-pointer overflow-hidden rounded-full ring-2 ring-sidebar transition-shadow hover:ring-sidebar-primary/40"
            classList={{
              "ring-primary/70": speaking(),
            }}
            style={
              !p().avatarUrl
                ? (() => {
                    const c = getClientColor(p().userId);
                    return {
                      "background-color": c.background,
                      color: c.foreground,
                    };
                  })()
                : {}
            }
            onClick={handleAvatarClick}
          >
            <Show
              when={p().avatarUrl}
              fallback={
                <span class="flex size-full items-center justify-center text-[9px] font-medium">
                  {getNameInitial(displayLabel())}
                </span>
              }
            >
              <img
                src={p().avatarUrl!}
                alt={displayLabel()}
                class="size-full object-cover"
                loading="lazy"
                decoding="async"
              />
            </Show>
          </button>
        </TooltipLabel>
        <span
          class="flex-1 truncate text-xs"
          classList={{
            "text-muted-foreground": p().micMuted,
            "font-medium text-foreground": isLocal(),
          }}
        >
          {displayLabel()}
          <Show when={isLocal()}>
            <span class="ml-1 text-[9px] uppercase tracking-wider text-muted-foreground">
              you
            </span>
          </Show>
        </span>
        {/* Publish-side mute hint (someone else muted their mic). Decorative —
            not a button. */}
        <Show when={p().micMuted && !isLocal()}>
          <MicOff class="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
        </Show>
        {/* Per-listener mute (only meaningful for remote participants). */}
        <Show when={!isLocal()}>
          <TooltipLabel label={localMuted() ? "Unmute for you" : "Mute for you"} side="top">
            <button
              type="button"
              class="rounded p-0.5 text-muted-foreground/70 transition-colors hover:text-foreground"
              classList={{
                "text-destructive hover:text-destructive": localMuted(),
              }}
              aria-label={localMuted() ? "Unmute for you" : "Mute for you"}
              onClick={onToggleLocalMute}
            >
              <Show when={localMuted()} fallback={<Volume2 class="size-3" />}>
                <VolumeX class="size-3" />
              </Show>
            </button>
          </TooltipLabel>
        </Show>
      </div>
      {/* Volume slider — always rendered. 0–100% maps onto LiveKit's 0–1
          setVolume(); HTMLMediaElement.volume rejects values >1 with
          IndexSizeError so we don't expose gain boost here. */}
      <Show when={!isLocal()}>
        <div class="flex items-center gap-2 pl-7 pr-1">
          <input
            type="range"
            min="0"
            max="100"
            step="1"
            value={volPct()}
            onInput={onVolume}
            aria-label={`Volume for ${displayLabel()}`}
            class="h-1 min-w-0 flex-1 cursor-pointer accent-primary"
          />
          <span class="w-8 shrink-0 text-right font-mono text-[10px] tabular-nums text-muted-foreground">
            {volPct()}%
          </span>
        </div>
      </Show>
    </li>
  );
}

// Individual sidebar item — pointer-draggable into panels, clickable to open.
// The pointer pipeline's click-vs-drag threshold (>4px movement) means a
// still-fingered tap never starts a drag, so the native `click` event fires
// normally and onSelect runs.
function SidebarItem(props: {
  item: SidebarItem;
  onSelect?: (item: SidebarItem) => void;
  onItemDrop?: (item: SidebarItem, target: DropTarget) => void;
}) {
  // A voice item belongs to a plugin that holds the `voice.media` runtime
  // capability. Two failure modes both surface as a dim row + setup-modal
  // intercept:
  //
  //   1. Unprovisioned — the server's runtime hasn't been wired with
  //      LIVEKIT_PUBLIC_URL. /health/voice returns "disabled" and
  //      isVoiceProvisioned() flips false (stores/voice-provisioning.ts).
  //
  //   2. Unreachable — voice IS provisioned but Central's reachability probe
  //      can't punch the runtime's RTC ports (TCP 7881 + UDP 3478 — the
  //      embedded TURN/STUN responder; see spec-24 Amendment C for why
  //      we probe 3478 instead of the MUX media port 50000).
  //      Signaling works, media won't, so joining would silently fail.
  //      isVoiceUnreachable() is fed by /health/voice externalReachability
  //      + the voice-channels plugin's `voice.reachability.changed` broadcast.
  // Plugin opted into the serve-ready handshake (manifest field) and hasn't
  // called serveReady() yet — its state isn't hydrated, so clicking the row
  // would silently fail. Mirror the voice-locked dim treatment but show a
  // spinner instead of a lock so the user can tell it's a transient state.
  const loading = createMemo(() => !getPluginReady(props.item.slug));

  const voiceDimmed = createMemo(() => {
    if (!getPluginRuntimeCapabilities(props.item.slug).includes("voice.media")) return false;
    const id = activeServerId();
    return !isVoiceProvisioned(id) || isVoiceUnreachable(id);
  });

  const dimmed = createMemo(() => loading() || voiceDimmed());

  const onItemPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    if (shouldIgnoreDragStart(e.target)) return;
    // Don't allow drag-into-panel for unprovisioned voice items — the
    // dragged target would render the same dimmed empty state, which just
    // duplicates the sidebar UX without doing anything useful.
    if (dimmed()) return;
    if (!props.onItemDrop) return;
    const handler = props.onItemDrop;

    startPointerDrag({
      payload: {
        kind: "sidebar-item",
        item: {
          id: props.item.id,
          label: props.item.label,
          slug: props.item.slug,
          panelType: props.item.panelType,
          ...(props.item.icon ? { icon: props.item.icon } : {}),
        },
      },
      pointerEvent: e,
      onCommit: (target) => handler(props.item, target),
      onCancel: () => {},
    });
  };

  const onItemClick = () => {
    // Don't navigate while the row is in inline-rename mode — clicks on the
    // input bubble up to this handler, and treating them as "open the channel"
    // would yank focus away mid-edit.
    if (renaming()) return;
    // Plugin still hydrating — click is a deliberate no-op. No toast, no
    // navigation. The spinning loader on the right is the affordance; the
    // user will retry once it disappears.
    if (loading()) return;
    if (voiceDimmed()) {
      const id = activeServerId();
      if (id) openVoiceSetup(id);
      return;
    }
    props.onSelect?.(props.item);
  };

  const participants = createMemo(() => props.item.participants ?? []);

  // Per-item admin actions (rename, delete, …) the plugin contributed for this
  // user. `create-*` is excluded — it's a section-level "+" handled separately
  // by SidebarSection. The plugin decides who gets which action; the shell
  // just renders what it's given.
  const itemActions = createMemo(() =>
    (props.item.adminActions ?? []).filter((a) => !a.id.startsWith("create-")),
  );

  // Right-click on desktop, touch/pen long-press on mobile. The primitive
  // coordinates with the pointer-drag pipeline so a hold-then-drag still
  // commits to drag, while a hold-still opens the menu and cancels the
  // pending drag session before any sub-pixel jitter trips it.
  const gesture = createContextGesture({
    enabled: () => !dimmed() && !renaming() && itemActions().length > 0,
    onOpen: ({ x, y }) => {
      setAnchorPos({ x, y });
      setMenuOpen(true);
    },
  });

  // Resolve a lucide icon for an action by its plugin-supplied icon name. We
  // ship sensible defaults for the common verbs (rename → pencil, delete →
  // trash) so a plugin can omit `icon` and still get a recognizable glyph.
  function actionIcon(actionId: string, iconName: string | undefined): Component<LucideProps> {
    if (iconName === "pencil") return Pencil;
    if (iconName === "trash") return Trash2;
    if (iconName === "settings") return Settings;
    if (actionId.startsWith("delete-")) return Trash2;
    if (actionId.startsWith("edit-") || actionId.startsWith("rename-")) return Pencil;
    if (actionId.startsWith("settings-")) return Settings;
    return Pencil;
  }

  // ---------------------------------------------------------------------------
  // Inline rename — Discord-style "click pencil → label becomes input".
  // ---------------------------------------------------------------------------

  const [renaming, setRenaming] = createSignal(false);
  const [renameValue, setRenameValue] = createSignal("");
  const [renameSaving, setRenameSaving] = createSignal(false);
  const [renameError, setRenameError] = createSignal("");
  let renameInput: HTMLInputElement | undefined;

  function startRename() {
    setRenameValue(props.item.label);
    setRenameError("");
    setRenaming(true);
    // Wait a frame so the <input> exists, then focus + select all so the user
    // can type-to-replace without manually clearing the previous name.
    requestAnimationFrame(() => {
      renameInput?.focus();
      renameInput?.select();
    });
  }

  function cancelRename() {
    if (renameSaving()) return;
    setRenaming(false);
    setRenameValue("");
    setRenameError("");
  }

  async function submitRename() {
    const next = renameValue().trim();
    if (next.length === 0) {
      setRenameError("Name is required");
      return;
    }
    if (next === props.item.label) {
      cancelRename();
      return;
    }
    const serverId = activeServerId();
    if (!serverId) return;
    setRenameSaving(true);
    try {
      await request(serverId, props.item.slug, "updateChannel", {
        id: props.item.id,
        name: next,
      });
      setRenaming(false);
      setRenameValue("");
      setRenameError("");
    } catch (err) {
      setRenameError(err instanceof Error ? err.message : "Failed to rename");
    } finally {
      setRenameSaving(false);
    }
  }

  function onRenameKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      void submitRename();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelRename();
    }
  }

  // ---------------------------------------------------------------------------
  // Two-step delete — first menu click arms ("Click again to confirm"), second
  // commits. Avoids the native window.confirm dialog and gives the user a
  // visible "are you sure" beat without leaving the row's context.
  // ---------------------------------------------------------------------------

  const [deleteArmed, setDeleteArmed] = createSignal(false);
  const [menuOpen, setMenuOpen] = createSignal(false);
  // Pointer position where the row's context gesture fired. Drives a hidden
  // 1×1 anchor element so the Kobalte menu opens at the cursor (right-click)
  // or under the finger (long-press) instead of pinned to a fixed corner.
  const [anchorPos, setAnchorPos] = createSignal<{ x: number; y: number } | null>(null);
  let armResetTimer: ReturnType<typeof setTimeout> | undefined;

  function disarmDelete() {
    if (armResetTimer !== undefined) {
      clearTimeout(armResetTimer);
      armResetTimer = undefined;
    }
    setDeleteArmed(false);
  }

  async function commitDelete(action: { id: string }) {
    disarmDelete();
    setMenuOpen(false);
    const serverId = activeServerId();
    if (!serverId) return;
    try {
      await request(serverId, props.item.slug, toWsAction(action.id), {
        id: props.item.id,
      });
    } catch (err) {
      console.error("[sidebar] delete failed:", err);
      // Inline error surface — kept terse so it doesn't replace the dropdown
      // UX with a system dialog. The row will refresh via the deleted event
      // when delete actually succeeds; on failure, we surface here once.
      window.alert(err instanceof Error ? err.message : "Failed to delete");
    }
  }

  function onDeleteSelect(action: { id: string }) {
    if (!deleteArmed()) {
      setDeleteArmed(true);
      // Auto-disarm if the user hesitates — 4s is long enough to reread the
      // confirm label and short enough that the menu doesn't sit in a
      // permanently-armed state if the user wanders off.
      if (armResetTimer !== undefined) clearTimeout(armResetTimer);
      armResetTimer = setTimeout(() => setDeleteArmed(false), 4000);
      return;
    }
    void commitDelete(action);
  }

  function onMenuOpenChange(open: boolean) {
    setMenuOpen(open);
    // Reset the armed state every time the menu closes so the next open
    // starts from the safe "Delete" label, not a pre-armed "Click to confirm".
    if (!open) disarmDelete();
  }

  // ---------------------------------------------------------------------------
  // Action dispatcher — plugin-supplied action ids are matched by prefix so
  // the shell handles the common verbs (rename, delete) with polished inline
  // UX while still leaving room for plugins to contribute custom verbs.
  // ---------------------------------------------------------------------------

  function runAction(action: { id: string; label: string }) {
    if (action.id.startsWith("delete-")) {
      onDeleteSelect(action);
      return;
    }
    if (action.id.startsWith("edit-") || action.id.startsWith("rename-")) {
      startRename();
      return;
    }
    if (action.id.startsWith("settings-")) {
      // Placeholder — per-item settings dialog will land in a follow-up.
      // Closing the menu (the default closeOnSelect behavior) is the only
      // visible effect today.
      return;
    }
    // Extension point — future verbs (archive, lock, …) call their camelCase
    // handler with `{ id }`. Plugins opt in by adding the action to their
    // `sidebar.items` payload and registering a matching handler.
    const serverId = activeServerId();
    if (!serverId) return;
    void (async () => {
      try {
        await request(serverId, props.item.slug, toWsAction(action.id), {
          id: props.item.id,
        });
      } catch (err) {
        console.error("[sidebar] action failed:", err);
        window.alert(err instanceof Error ? err.message : "Action failed");
      }
    })();
  }

  // True iff the local user is joined to THIS voice channel right now. Drives
  // the swap from the compact avatar-stack preview to the full Discord-style
  // expanded roster with per-user volume / mute. We don't gate on slug or
  // capability here — voiceManager.state().channelId is only set after a
  // successful connect, so it's already the authoritative "this is the room
  // you're in" signal. Status check excludes idle/disconnected/failed so a
  // dead session doesn't keep the row expanded.
  const isJoinedHere = createMemo(() => {
    const s = voiceManager.state();
    if (s.channelId !== props.item.id) return false;
    return s.status === "connected" || s.status === "reconnecting";
  });

  return (
    <SidebarMenuItem>
      <div
        data-sidebar="menu-button"
        data-size="default"
        class={ITEM_CLASS}
        classList={{ "opacity-50": dimmed(), "cursor-text": renaming() }}
        onClick={gesture.wrapClick(onItemClick)}
        onPointerDown={(e) => {
          // Gesture first so a long-press timer is armed before the drag
          // pipeline takes pointer capture; if the user holds without
          // moving, gesture fires and cancels the pending drag.
          gesture.onPointerDown(e);
          onItemPointerDown(e);
        }}
        onPointerMove={gesture.onPointerMove}
        onPointerUp={gesture.onPointerUp}
        onPointerCancel={gesture.onPointerCancel}
        onContextMenu={gesture.onContextMenu}
        data-tooltip={
          loading()
            ? "Plugin still loading…"
            : voiceDimmed()
              ? "Voice not configured — click to set up"
              : undefined
        }
      >
        <ItemIcon {...(props.item.icon ? { icon: props.item.icon } : {})} />
        <Show
          when={renaming()}
          fallback={<span class="truncate">{props.item.label}</span>}
        >
          <input
            ref={renameInput}
            type="text"
            value={renameValue()}
            onInput={(e) => setRenameValue(e.currentTarget.value)}
            onKeyDown={onRenameKeyDown}
            onBlur={() => {
              // Submit on blur if there's a non-empty change; otherwise cancel.
              // Lets the user click anywhere to commit, matching Discord/Slack.
              if (renameSaving()) return;
              const next = renameValue().trim();
              if (next.length === 0 || next === props.item.label) {
                cancelRename();
              } else {
                void submitRename();
              }
            }}
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
            disabled={renameSaving()}
            class="h-5 min-w-0 flex-1 rounded border border-sidebar-ring/40 bg-sidebar-accent px-1 text-sm text-sidebar-foreground outline-none focus:border-sidebar-ring disabled:opacity-50"
          />
        </Show>
        <Show when={renameError() !== ""}>
          <span class="text-[10px] text-destructive shrink-0">
            {renameError()}
          </span>
        </Show>
        <Show when={loading()}>
          <Loader2 class="size-3 text-muted-foreground shrink-0 ml-auto animate-spin" />
        </Show>
        <Show when={!loading() && voiceDimmed()}>
          <Lock class="size-3 text-muted-foreground shrink-0 ml-auto" />
        </Show>
        <Show when={!dimmed() && !renaming() && itemActions().length > 0}>
          {/* Inline settings affordance — fades in on row hover (desktop) or
              when the menu is open. Always rendered so the row's right-edge
              layout is stable; opacity-0 keeps it invisible at rest. Touch
              devices never trigger :hover, so they never see this — they
              use long-press, which is wired through `gesture` above. */}
          <button
            type="button"
            aria-label="Item options"
            data-tooltip="Options"
            data-tooltip-side="left"
            class="ml-auto shrink-0 rounded p-0.5 text-muted-foreground/60 opacity-0 transition-opacity group-hover/menu-item:opacity-100 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sidebar-ring"
            classList={{ "opacity-100": menuOpen() }}
            onClick={(e) => {
              e.stopPropagation();
              if (menuOpen()) {
                setMenuOpen(false);
                return;
              }
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
              // Anchor at the button's right edge so the menu opens beside
              // the row, matching the cursor/finger anchoring used by
              // right-click and long-press.
              setAnchorPos({ x: rect.right, y: rect.top });
              setMenuOpen(true);
            }}
          >
            <Settings class="size-3.5" />
          </button>
          {/* The trigger is a hidden 1×1 element positioned at the gesture's
              anchor coordinates so the Kobalte menu opens at the cursor
              (right-click), under the finger (long-press), or beside the
              settings button (click). Kobalte requires a Trigger to compute
              placement; we render one without making it user-interactable.
              visibility:hidden also removes it from focus order so Tab
              navigation isn't disrupted by an empty button. */}
          <DropdownMenu open={menuOpen()} onOpenChange={onMenuOpenChange}>
            <DropdownMenuTrigger
              aria-hidden="true"
              tabindex={-1}
              style={{
                position: "fixed",
                left: `${anchorPos()?.x ?? 0}px`,
                top: `${anchorPos()?.y ?? 0}px`,
                width: "1px",
                height: "1px",
                visibility: "hidden",
                "pointer-events": "none",
              }}
            />
            <DropdownMenuContent class="min-w-44" side="right" align="start" sideOffset={4}>
              <For each={itemActions()}>
                {(action) => {
                  const Icon = actionIcon(action.id, action.icon);
                  const isDestructive = action.id.startsWith("delete-");
                  // Two-step destructive actions: first click arms (label
                  // swaps to "Click again to confirm" + intensified styling),
                  // second click commits. We always pass closeOnSelect={false}
                  // for destructive items and drive the menu open-state
                  // manually — evaluating `deleteArmed()` inside the
                  // closeOnSelect prop races with onSelect (the signal
                  // updates synchronously inside onSelect, then Kobalte reads
                  // the now-true value and closes anyway).
                  const armedHere = () => isDestructive && deleteArmed();
                  return (
                    <DropdownMenuItem
                      destructive={isDestructive}
                      closeOnSelect={!isDestructive}
                      onSelect={() => runAction(action)}
                      classList={{ "bg-destructive/15": armedHere() }}
                    >
                      <Icon class="size-4" />
                      <span>{armedHere() ? "Click again to confirm" : action.label}</span>
                    </DropdownMenuItem>
                  );
                }}
              </For>
            </DropdownMenuContent>
          </DropdownMenu>
        </Show>
      </div>
      <Show
        when={isJoinedHere()}
        fallback={
          <Show when={participants().length > 0}>
            <AvatarStack
              class="pl-7 pr-2 pb-1 -mt-0.5"
              max={4}
              size="sm"
              items={participants().map((p) => ({
                id: p.userId,
                name: p.displayName,
                src: p.avatarUrl,
                onClick: (ev) => {
                  // Stop propagation so clicking a participant avatar never
                  // navigates the active panel (which the SidebarMenuItem's
                  // open-channel handler would otherwise do).
                  ev.stopPropagation();
                  openUserCard({
                    userId: p.userId,
                    displayName: p.displayName,
                    avatarUrl: p.avatarUrl,
                  });
                },
              }))}
            />
          </Show>
        }
      >
        <JoinedVoiceRoster />
      </Show>
    </SidebarMenuItem>
  );
}
