import { Match, Show, Switch, createSignal, onCleanup, type Component } from "solid-js";
import { Dynamic } from "solid-js/web";
import { Check, Columns2, ExternalLink, Globe, Hash, Maximize2, Minimize2, MoreHorizontal, Pencil, Rows2, Volume2, Users, X, type LucideProps } from "lucide-solid";
import { cn } from "@/lib/utils";
import { useCoarsePointer } from "@/lib/use-coarse-pointer";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { type LeafNode, type PanelNode, type SplitNode, PREVIEW_LEAF_ID } from "@/lib/panel-layout";
import { type PanelContent } from "@uncorded/protocol";
import { PluginFrame } from "@/components/channel-view";
import { BrowserPanel } from "@/components/browser-panel";
import { WebAppPanel } from "@/components/web-apps/web-app-panel";
import { browserPanelLabel, createEmptyBrowserPanel } from "@/lib/browser-panel-state";
import {
  dragContext,
  dropTarget,
  dwelling,
  shouldIgnoreDragStart,
  startPointerDrag,
  type DragPayload,
  type DropZone,
} from "@/lib/drag-state";
import { useWorkspaceContext } from "@/lib/workspace-context";
import { requestSync } from "@/lib/live-surface-host";
import { requestSync as requestPortalSync } from "@/lib/portal-host";
import { clearLiveSurface, peekLiveSurface } from "@/lib/live-surfaces";
import { liveSurfaceOpenWindow } from "@/stores/web-apps";
import { isElectron } from "@/lib/electron";

const ICON_MAP: Record<string, Component<LucideProps>> = {
  hash: Hash,
  users: Users,
  volume2: Volume2,
};

type SharedProps = {
  focusedLeafId: string | null;
  canClose: boolean;
  onSplit: (id: string, direction: "horizontal" | "vertical") => void;
  onToggleFocus: (id: string) => void;
  onClose: (id: string) => void;
  onUpdateRatio: (id: string, ratio: number) => void;
  getContent: (id: string) => PanelContent | undefined;
  onDrop: (id: string, content: PanelContent) => void;
  onUpdateContent: (id: string, content: PanelContent) => void;
  onDropSplit: (
    id: string,
    content: PanelContent,
    direction: "horizontal" | "vertical",
    position: "before" | "after"
  ) => void;
  onMovePanel: (
    sourceId: string,
    targetId: string,
    zone: DropZone,
    sourceWorkspaceId: string,
  ) => void;
};

export function PanelLayout(props: SharedProps & { node: PanelNode }) {
  return (
    <Show
      when={props.node.type === "leaf"}
      fallback={
        <PanelSplit
          node={props.node as SplitNode}
          focusedLeafId={props.focusedLeafId}
          canClose={props.canClose}
          onSplit={props.onSplit}
          onToggleFocus={props.onToggleFocus}
          onClose={props.onClose}
          onUpdateRatio={props.onUpdateRatio}
          getContent={props.getContent}
          onDrop={props.onDrop}
          onUpdateContent={props.onUpdateContent}
          onDropSplit={props.onDropSplit}
          onMovePanel={props.onMovePanel}
        />
      }
    >
      <Show
        when={(props.node as LeafNode).id === PREVIEW_LEAF_ID}
        fallback={
          <PanelLeaf
            node={props.node as LeafNode}
            canClose={props.canClose}
            isFocused={props.focusedLeafId === (props.node as LeafNode).id}
            content={props.getContent((props.node as LeafNode).id)}
            onSplit={(dir) => props.onSplit((props.node as LeafNode).id, dir)}
            onToggleFocus={() => props.onToggleFocus((props.node as LeafNode).id)}
            onClose={() => props.onClose((props.node as LeafNode).id)}
            onDrop={(content) => props.onDrop((props.node as LeafNode).id, content)}
            onUpdateContent={(content) => props.onUpdateContent((props.node as LeafNode).id, content)}
            onDropSplit={(content, direction, position) =>
              props.onDropSplit((props.node as LeafNode).id, content, direction, position)
            }
            onMovePanel={props.onMovePanel}
          />
        }
      >
        <PanelPreviewGhost />
      </Show>
    </Show>
  );
}

// Transient leaf rendered in place of the soon-to-be-committed new panel
// during a sidebar-item drag (once the user has dwelled). Reads label + icon
// from the live drag context so the ghost shows what's about to land. Not
// interactive; pointer-events: none everywhere so hit-testing can still see
// the surrounding real leaves.
//
// data-panel-leaf is set to PREVIEW_LEAF_ID so drag-pill.tsx can dock to it.
function PanelPreviewGhost() {
  const ghostDisplay = () => {
    const ctx = dragContext();
    if (ctx === null || ctx.kind !== "sidebar-item") return null;
    return { label: ctx.item.label, icon: ctx.item.icon ?? "hash" };
  };
  return (
    <div
      class="flex flex-col flex-1 min-w-0 min-h-0 overflow-hidden relative pointer-events-none animate-in fade-in-0 zoom-in-95 duration-200 ease-out"
      data-panel-leaf={PREVIEW_LEAF_ID}
    >
      <div class="flex h-9 shrink-0 items-center border-b border-dashed border-sidebar-primary/60 px-3 gap-2 bg-sidebar-primary/10">
        <Show when={ghostDisplay()}>
          {(d) => (
            <>
              <GhostHeaderIcon icon={d().icon} />
              <span class="text-sm font-medium truncate text-sidebar-primary">
                {d().label}
              </span>
            </>
          )}
        </Show>
      </div>
      <div class="flex flex-1 items-center justify-center bg-sidebar-primary/5">
        <p class="text-xs text-sidebar-primary/70 select-none animate-in fade-in-0 slide-in-from-bottom-1 duration-300 delay-100 fill-mode-both">
          Release to open
        </p>
      </div>
    </div>
  );
}

function GhostHeaderIcon(props: { icon: string }) {
  const IconC = () => ICON_MAP[props.icon] ?? Hash;
  return <Dynamic component={IconC()} class="size-3.5 text-sidebar-primary shrink-0" />;
}

// 5-box aim guide rendered inside an empty leaf while a sidebar-item drag is
// active. Boxes mirror the EDGE_THRESHOLD=0.25 hit-test in drag-state so the
// box the user sees highlighted matches the zone their cursor resolves to.
// Edge hovers still trigger the standard reflow preview in App.tsx — the guide
// is the in-panel affordance, the reflow is the out-of-panel consequence.
function EmptyPanelZoneGuide(props: { leafId: string }) {
  const targetZone = () => {
    const t = dropTarget();
    return t?.leafId === props.leafId ? t.zone : null;
  };
  const boxClass = (zone: DropZone, pos: string) =>
    cn(
      "absolute m-1 rounded-md border-2 border-dashed transition-colors duration-150",
      pos,
      targetZone() === zone
        ? "border-sidebar-primary bg-sidebar-primary/10"
        : "border-sidebar-primary/20"
    );
  return (
    <div class="absolute inset-0 pointer-events-none animate-in fade-in-0 duration-200">
      <div class={boxClass("left",   "left-0 top-0 bottom-0 w-1/4")} />
      <div class={boxClass("right",  "right-0 top-0 bottom-0 w-1/4")} />
      <div class={boxClass("top",    "left-1/4 right-1/4 top-0 h-1/4")} />
      <div class={boxClass("bottom", "left-1/4 right-1/4 bottom-0 h-1/4")} />
      <div class={boxClass("center", "left-1/4 right-1/4 top-1/4 bottom-1/4")} />
    </div>
  );
}

// Placeholder shown when a panel body has nothing to render. Two modes:
//   - empty-workspace: the workspace has a single leaf and it's empty. Onboarding
//     copy points the user at the sidebar.
//   - empty-panel: this leaf is empty but lives alongside other panels. Copy
//     points at in-panel actions (drop target, ⋯ menu) instead of the sidebar.
//
// `canClose` from PanelLeaf is the natural discriminator (countLeaves > 1).
type EmptyPanelMode = "empty-workspace" | "empty-panel";

function EmptyPanelState(props: { mode: EmptyPanelMode }) {
  return (
    <div class="flex flex-1 flex-col items-center justify-center gap-1.5 px-4 text-center select-none">
      <Switch>
        <Match when={props.mode === "empty-workspace"}>
          <h3 class="text-sm font-medium text-muted-foreground">
            Empty workspace
          </h3>
          <p class="text-xs text-muted-foreground/60 max-w-xs">
            Drag something from the sidebar to get started
          </p>
        </Match>
        <Match when={props.mode === "empty-panel"}>
          <h3 class="text-sm font-medium text-muted-foreground">
            Empty panel
          </h3>
          <p class="text-xs text-muted-foreground/60 max-w-xs">
            Drop a sidebar item here, or use the ⋯ menu to open a browser
          </p>
        </Match>
      </Switch>
    </div>
  );
}

function PanelLeaf(props: {
  node: LeafNode;
  canClose: boolean;
  isFocused: boolean;
  content: PanelContent | undefined;
  onSplit: (direction: "horizontal" | "vertical") => void;
  onToggleFocus: () => void;
  onClose: () => void;
  onDrop: (content: PanelContent) => void;
  onUpdateContent: (content: PanelContent) => void;
  onDropSplit: (
    content: PanelContent,
    direction: "horizontal" | "vertical",
    position: "before" | "after"
  ) => void;
  onMovePanel: (
    sourceId: string,
    targetId: string,
    zone: DropZone,
    sourceWorkspaceId: string,
  ) => void;
}) {
  // Source workspace id for cross-workspace drag commit. Captured at
  // pointerdown-time so the commit handler knows where the panel came from
  // even if the user dwelled on a different workspace's tab and switched
  // activeId mid-drag.
  const { activeId } = useWorkspaceContext();

  // Touch (`pointer: coarse`) gets reorganised header chrome: split icons
  // collapse into the ⋯ dropdown, and the close button arms-then-commits to
  // protect against mistaps where a panel can't be undone. Mouse users keep
  // the dense single-tap row.
  const coarse = useCoarsePointer();

  // Two-stage close — first tap arms (X swaps to a red check, 4s timer
  // disarms automatically), second tap commits. Mirrors the sidebar's
  // delete-action pattern at nav-sidebar-sections.tsx so muscle memory and
  // timing are consistent. Mouse users skip both stages: a single click
  // commits because mouse aim is precise and pixel-targeted.
  const [closeArmed, setCloseArmed] = createSignal(false);
  let closeArmTimer: ReturnType<typeof setTimeout> | undefined;
  const disarmClose = () => {
    if (closeArmTimer !== undefined) {
      clearTimeout(closeArmTimer);
      closeArmTimer = undefined;
    }
    setCloseArmed(false);
  };
  onCleanup(disarmClose);
  const onCloseClick = () => {
    if (!coarse()) {
      props.onClose();
      return;
    }
    if (!closeArmed()) {
      setCloseArmed(true);
      if (closeArmTimer !== undefined) clearTimeout(closeArmTimer);
      closeArmTimer = setTimeout(() => setCloseArmed(false), 4000);
      return;
    }
    disarmClose();
    props.onClose();
  };

  // Inline rename for Web App panels — hover the header → pencil → the title
  // becomes an input (Enter saves, Esc/blur cancels). The new title is written
  // straight into PanelContent via onUpdateContent; because surfaceKeyOf keys
  // a webapp by its webAppId (not title), the rename does NOT reload the
  // webview. Scoped to `webapp` content for v1 (plugin/browser titles are
  // derived, not user-owned).
  const renamableWebApp = (): (PanelContent & { type: "webapp" }) | null => {
    const c = props.content;
    return c !== undefined && c.type === "webapp" ? c : null;
  };
  const [renaming, setRenaming] = createSignal(false);
  const [renameValue, setRenameValue] = createSignal("");
  let renameInput: HTMLInputElement | undefined;

  const startRename = () => {
    const webapp = renamableWebApp();
    if (webapp === null) return;
    setRenameValue(webapp.title);
    setRenaming(true);
    requestAnimationFrame(() => {
      renameInput?.focus();
      renameInput?.select();
    });
  };
  const cancelRename = () => {
    setRenaming(false);
    setRenameValue("");
  };
  const submitRename = () => {
    const webapp = renamableWebApp();
    if (webapp === null) {
      cancelRename();
      return;
    }
    const next = renameValue().trim();
    if (next.length === 0 || next === webapp.title) {
      cancelRename();
      return;
    }
    // `renamed` pins the user's label: live page-title sync skips renamed
    // panels, so navigation can't clobber a deliberate name.
    props.onUpdateContent({ ...webapp, title: next, renamed: true });
    cancelRename();
  };
  const onRenameKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submitRename();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelRename();
    }
  };

  // DOCKED → POPPED-OUT for a live Web App panel: move the EXISTING native
  // view into a frameless popout window — the inverse of the popout's "Dock"
  // button, with the live session preserved (no reload). Order matters:
  // openWindow first, so main registers the surface in surfacePopouts and the
  // ownership guards drop the closing panel's stale SET_BOUNDS/RELEASE; then
  // clear the instance binding so App's reconciliation release never targets
  // the moved view. Electron-only (native views don't exist on web), and a
  // no-op while the surface is still being created (nothing live to move).
  const popOutWebAppPanel = async (): Promise<void> => {
    const c = props.content;
    if (c === undefined || c.type !== "webapp") return;
    const surfaceId = peekLiveSurface(c.instanceId);
    if (surfaceId === null) return;
    await liveSurfaceOpenWindow(surfaceId);
    clearLiveSurface(c.instanceId);
    props.onClose();
  };
  const canPopOut = () =>
    isElectron() && props.content?.type === "webapp";

  // Empty-panel zone guide: during a sidebar-item drag, an empty leaf paints
  // a 5-box affordance (4 edges + center) so the user sees where they can aim.
  // Box geometry mirrors the EDGE_THRESHOLD hit-test in drag-state.
  //
  // Collapsed as soon as the user dwells on this leaf, regardless of zone —
  // edge dwell triggers the layout-level reflow preview (PREVIEW_LEAF_ID
  // squeezes this leaf to ~50%), and center dwell triggers CenterDropOverlay
  // at App root. Both have their own dedicated feedback channel; keeping the
  // 5-box guide visible during dwell stacks two indicators on top of each
  // other and reads as visual noise. Live hit-test (pre-dwell) keeps the
  // guide so the user still sees where the boxes are while aiming.
  const isSidebarDragging = () => {
    const kind = dragContext()?.kind;
    return kind === "sidebar-item" || kind === "web-app";
  };
  const showZoneGuide = () => {
    if (props.content !== undefined) return false;
    if (!isSidebarDragging()) return false;
    if (dwelling()) {
      const tgt = dropTarget();
      if (tgt?.leafId === props.node.id) return false;
    }
    return true;
  };

  const onHeaderPointerDown = (e: PointerEvent) => {
    // Left button only — right/middle click and context menu must pass through.
    if (e.button !== 0) return;
    // Let buttons, dropdowns, inputs, and explicitly opted-out elements handle
    // their own events. The dropdown trigger (tagged data-no-drag below) falls
    // into this path.
    if (shouldIgnoreDragStart(e.target)) return;

    // Snapshot everything onCommit needs at pointerdown time. In a cross-
    // workspace drag the 600ms tab-dwell switches activeId mid-drag, which
    // tears down the source workspace's panel tree — at which point reading
    // props.node.id / props.onMovePanel from inside the onCommit closure
    // walks a Solid proxy chain whose parent Split no longer exists, and
    // you get "Cannot read properties of undefined (reading 'first')".
    const sourceLeafId = props.node.id;
    const sourceWorkspaceId = activeId();
    const movePanel = props.onMovePanel;

    startPointerDrag({
      payload: {
        kind: "panel",
        sourceLeafId,
        sourceWorkspaceId,
      } satisfies DragPayload,
      pointerEvent: e,
      onCommit: (target) => {
        if (target.leafId === sourceLeafId) return; // self-drop
        // Same-workspace center drops are rejected — a panel moving onto
        // another panel's center has no unambiguous semantic (replace?
        // stack?). Cross-workspace center drops go through: the natural
        // landing spot in a fresh/empty destination workspace is the
        // single empty leaf's center, and handleMovePanel treats that as
        // "occupy the empty leaf".
        if (target.zone === "center" && sourceWorkspaceId === activeId()) return;
        movePanel(sourceLeafId, target.leafId, target.zone, sourceWorkspaceId);
      },
      onCancel: () => {},
    });
  };

  return (
    <div
      class="flex flex-col flex-1 min-w-0 min-h-0 overflow-hidden relative"
      data-panel-leaf={props.node.id}
    >
      {/* Panel header */}
      <div
        class="flex h-9 shrink-0 items-center border-b px-3 gap-2 bg-background cursor-grab active:cursor-grabbing select-none touch-none"
        data-panel-header
        onPointerDown={onHeaderPointerDown}
      >
        <div class="group/title flex items-center gap-1.5 flex-1 min-w-0">
          <Show when={props.content}>
            {(content) => <PanelHeaderIcon content={content()} />}
          </Show>
          <Show
            when={renaming()}
            fallback={
              <>
                <span
                  class="text-sm truncate"
                  classList={{
                    "text-muted-foreground": !props.content,
                    "text-foreground font-medium": !!props.content,
                  }}
                >
                  {props.content
                    ? props.content.type === "browser"
                      ? browserPanelLabel(props.content)
                      : props.content.type === "webapp"
                        ? props.content.title
                        : props.content.itemLabel
                    : "Empty Panel"}
                </span>
                <Show when={renamableWebApp()}>
                  <button
                    type="button"
                    class="flex shrink-0 items-center justify-center rounded-sm p-0.5 text-muted-foreground opacity-0 transition-opacity outline-none hover:text-foreground group-hover/title:opacity-100 focus-visible:opacity-100"
                    aria-label="Rename panel"
                    data-tooltip="Rename panel"
                    onClick={startRename}
                  >
                    <Pencil class="size-3" />
                  </button>
                </Show>
              </>
            }
          >
            <input
              ref={renameInput}
              type="text"
              value={renameValue()}
              onInput={(e) => setRenameValue(e.currentTarget.value)}
              onKeyDown={onRenameKeyDown}
              onBlur={submitRename}
              onClick={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
              class="h-5 min-w-0 flex-1 rounded border border-ring/40 bg-muted px-1 text-sm text-foreground outline-none focus:border-ring"
            />
          </Show>
        </div>

        <div class="flex items-center gap-1 shrink-0" data-no-drag>
          <button
            type="button"
            class="flex items-center justify-center rounded-sm p-1 text-muted-foreground transition-colors outline-none shrink-0 hover:bg-muted hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed"
            aria-label={props.isFocused ? "Restore workspace layout" : "Focus panel"}
            data-tooltip={props.isFocused ? "Restore workspace layout" : "Focus panel"}
            disabled={!props.content}
            onClick={props.onToggleFocus}
          >
            <Show
              when={props.isFocused}
              fallback={<Maximize2 class="size-3.5" />}
            >
              <Minimize2 class="size-3.5" />
            </Show>
          </button>

          {/* Split actions: dedicated icon buttons on mouse for one-tap reach,
           *  collapsed into the ⋯ dropdown on touch where header pixels are
           *  scarce and splits are a low-frequency power action. */}
          <Show when={!coarse()}>
            <button
              type="button"
              class="flex items-center justify-center rounded-sm p-1 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors outline-none shrink-0"
              aria-label="Split right"
              data-tooltip="Split right"
              onClick={() => props.onSplit("horizontal")}
            >
              <Columns2 class="size-3.5" />
            </button>

            <button
              type="button"
              class="flex items-center justify-center rounded-sm p-1 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors outline-none shrink-0"
              aria-label="Split down"
              data-tooltip="Split down"
              onClick={() => props.onSplit("vertical")}
            >
              <Rows2 class="size-3.5" />
            </button>
          </Show>

          <DropdownMenu>
            <DropdownMenuTrigger
              class="flex items-center justify-center rounded-sm p-1 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors outline-none shrink-0"
              data-tooltip="Panel actions"
            >
              <MoreHorizontal class="size-3.5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent side="bottom" align="end">
              <Show when={coarse()}>
                <DropdownMenuItem onSelect={() => props.onSplit("horizontal")}>
                  <Columns2 class="size-4" />
                  <span>Split right</span>
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => props.onSplit("vertical")}>
                  <Rows2 class="size-4" />
                  <span>Split down</span>
                </DropdownMenuItem>
              </Show>
              <DropdownMenuItem onSelect={() => props.onDrop(createEmptyBrowserPanel())}>
                <Globe class="size-4" />
                <span>Open browser</span>
              </DropdownMenuItem>
              <Show when={canPopOut()}>
                <DropdownMenuItem onSelect={() => void popOutWebAppPanel()}>
                  <ExternalLink class="size-4" />
                  <span>Pop out</span>
                </DropdownMenuItem>
              </Show>
            </DropdownMenuContent>
          </DropdownMenu>

          <Show when={props.canClose}>
            {/* Two-stage close on touch: first tap arms (X → red check, 4s
             *  auto-disarm), second tap commits. Mouse users get a single
             *  tap. aria-label updates so screen readers narrate the armed
             *  state. */}
            <button
              type="button"
              class={cn(
                "flex items-center justify-center rounded-sm p-1 transition-colors outline-none shrink-0",
                closeArmed()
                  ? "bg-destructive/15 text-destructive"
                  : "text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              )}
              aria-label={closeArmed() ? "Tap again to confirm close" : "Close panel"}
              data-tooltip={closeArmed() ? "Tap again to confirm close" : "Close panel"}
              aria-pressed={closeArmed()}
              onClick={onCloseClick}
            >
              <Show when={closeArmed()} fallback={<X class="size-3.5" />}>
                <Check class="size-3.5" />
              </Show>
            </button>
          </Show>
        </div>
      </div>

      {/* Panel body */}
      <div class="flex flex-col flex-1 min-h-0 relative">
        <Show
          when={props.content}
          fallback={
            <Show when={!isSidebarDragging()}>
              <EmptyPanelState
                mode={props.canClose ? "empty-panel" : "empty-workspace"}
              />
            </Show>
          }
        >
          {/* Non-keyed: content ref updates without recreating PanelBody.
              PluginFrame / BrowserPanel handle in-place navigation for
              same-surfaceKey content changes via portal-host. */}
          {(content) => (
            <PanelBody
              content={content()}
              panelId={props.node.id}
              onUpdateContent={props.onUpdateContent}
            />
          )}
        </Show>

        {/* Empty-panel zone guide — 5 aim targets during a sidebar-item drag.
         *  Center-drop preview lives at App root (see CenterDropOverlay) because
         *  portal iframes (z-40) sit in a sibling stacking context and would
         *  otherwise occlude an in-tree overlay. */}
        <Show when={showZoneGuide()}>
          <EmptyPanelZoneGuide leafId={props.node.id} />
        </Show>
      </div>

    </div>
  );
}

// ---------------------------------------------------------------------------
// Panel content helpers
// ---------------------------------------------------------------------------

function PanelHeaderIcon(props: { content: PanelContent }) {
  if (props.content.type === "browser" || props.content.type === "webapp") {
    return <Globe class="size-3.5 text-muted-foreground shrink-0" />;
  }
  const plugin = props.content;
  const IconC = () => ICON_MAP[plugin.itemIcon ?? "hash"] ?? Hash;
  return <Dynamic component={IconC()} class="size-3.5 text-muted-foreground shrink-0" />;
}

function PanelBody(props: {
  content: PanelContent;
  panelId: string;
  onUpdateContent: (content: PanelContent) => void;
}) {
  // Match with reactive `when`: same-type reference updates pass through to
  // the child (itemId / URL changes navigate the portaled surface in place);
  // type flips recreate the branch.
  type BrowserContent = Extract<PanelContent, { type: "browser" }>;
  type PluginContent = Extract<PanelContent, { type: "plugin" }>;
  type WebAppContent = Extract<PanelContent, { type: "webapp" }>;
  return (
    <Switch>
      <Match when={props.content.type === "browser" ? (props.content as BrowserContent) : null}>
        {(browser) => (
          <BrowserPanel
            content={browser()}
            panelId={props.panelId}
            onChange={props.onUpdateContent}
          />
        )}
      </Match>
      <Match when={props.content.type === "webapp" ? (props.content as WebAppContent) : null}>
        {(webapp) => <WebAppPanel content={webapp()} panelId={props.panelId} />}
      </Match>
      <Match when={props.content.type === "plugin" ? (props.content as PluginContent) : null}>
        {(plugin) => <PluginFrame content={plugin()} panelId={props.panelId} />}
      </Match>
    </Switch>
  );
}

function PanelSplit(props: SharedProps & { node: SplitNode }) {
  let containerRef: HTMLDivElement | undefined;
  const [resizing, setResizing] = createSignal(false);

  const startDrag = (e: PointerEvent) => {
    // Ignore right-click and middle-click; allow mouse (button 0), touch,
    // and pen. Touch events have button === 0 in the PointerEvent spec.
    if (e.button !== 0) return;
    e.preventDefault();
    const isHorizontal = props.node.direction === "horizontal";
    const startPos = isHorizontal ? e.clientX : e.clientY;
    const startRatio = props.node.ratio;
    const nodeId = props.node.id;
    const pointerId = e.pointerId;
    const target = e.currentTarget as HTMLElement;

    // Lock the pointer to this element so the drag continues even if the
    // finger / cursor strays off the 1px handle (critical for touch).
    try {
      target.setPointerCapture(pointerId);
    } catch {
      // Some browsers throw if the pointer has already been released — benign.
    }

    setResizing(true);
    document.body.style.userSelect = "none";
    document.body.style.cursor = isHorizontal ? "col-resize" : "row-resize";
    // Prevent iframes and webviews from swallowing pointer events during resize.
    document.querySelectorAll("iframe, webview").forEach((f) => {
      (f as HTMLElement).style.pointerEvents = "none";
    });

    // rAF-throttle: buffer the latest ratio and flush once per frame
    let pendingRatio: number | null = null;
    let rafId: number | null = null;

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId || !containerRef) return;
      const pos = isHorizontal ? ev.clientX : ev.clientY;
      const size = isHorizontal ? containerRef.offsetWidth : containerRef.offsetHeight;
      if (size === 0) return;
      pendingRatio = Math.max(0.15, Math.min(0.85, startRatio + (pos - startPos) / size));
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        if (pendingRatio !== null) {
          props.onUpdateRatio(nodeId, pendingRatio);
          pendingRatio = null;
          // Solid flushed the flex styles synchronously above, so a forced
          // rect read now reports native-surface bounds to main in the SAME
          // frame, before paint — the view stays locked to the panel instead
          // of trailing the drag. Also the only signal for panels that only
          // MOVED (ResizeObserver fires for size changes, never position).
          // Order matters: live-surface sync first (pure reads — one forced
          // layout after the flex write), then portal sync (reads the clean
          // layout, then writes portal styles that settle before paint).
          requestSync();
          requestPortalSync();
        }
      });
    };

    const cleanup = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      setResizing(false);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      // Restore to "auto", not "" — portal container sets pointer-events: none
      // and pointer-events inherits, so clearing the inline would make the
      // child iframe inherit "none" and become non-interactive.
      document.querySelectorAll("iframe, webview").forEach((f) => {
        (f as HTMLElement).style.pointerEvents = "auto";
      });
      if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
      try { target.releasePointerCapture(pointerId); } catch { /* already released */ }
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", cleanup);
      document.removeEventListener("pointercancel", cleanup);
    };

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", cleanup);
    // pointercancel fires when the OS steals the pointer (e.g., iOS gesture
    // recognisers) — treat the same as pointerup so we clean up state.
    document.addEventListener("pointercancel", cleanup);
  };

  return (
    <div
      ref={containerRef}
      class={cn(
        "flex flex-1 min-w-0 min-h-0",
        props.node.direction === "horizontal" ? "flex-row" : "flex-col"
      )}
    >
      <div
        class={cn("flex min-w-0 min-h-0 overflow-hidden", !resizing() && "transition-[flex] duration-200 ease-[cubic-bezier(0.32,0.72,0,1)]")}
        style={{ flex: props.node.ratio }}
      >
        <PanelLayout
          node={props.node.first}
          focusedLeafId={props.focusedLeafId}
          canClose={props.canClose}
          onSplit={props.onSplit}
          onToggleFocus={props.onToggleFocus}
          onClose={props.onClose}
          onUpdateRatio={props.onUpdateRatio}
          getContent={props.getContent}
          onDrop={props.onDrop}
          onUpdateContent={props.onUpdateContent}
          onDropSplit={props.onDropSplit}
          onMovePanel={props.onMovePanel}
        />
      </div>

      {/* Resize handle. The visible bar stays thin (1px) for a clean look,
       * but a transparent absolute overlay extends the hit zone to a
       * touch-friendly ~16px so fingers can grab it without pixel-perfect
       * aim. touch-action: none prevents the browser from hijacking the
       * gesture as a scroll. data-resize-handle opts out of drag-start so
       * pointerdown on the handle never begins a panel drag. */}
      <div
        class={cn(
          "relative shrink-0 bg-border hover:bg-sidebar-primary transition-colors z-10",
          props.node.direction === "horizontal"
            ? "w-1 cursor-col-resize"
            : "h-1 cursor-row-resize"
        )}
      >
        <div
          class={cn(
            "absolute touch-none",
            props.node.direction === "horizontal"
              ? "inset-y-0 -left-2 -right-2 cursor-col-resize"
              : "inset-x-0 -top-2 -bottom-2 cursor-row-resize"
          )}
          data-resize-handle
          onPointerDown={startDrag}
        />
      </div>

      <div
        class={cn("flex min-w-0 min-h-0 overflow-hidden", !resizing() && "transition-[flex] duration-200 ease-[cubic-bezier(0.32,0.72,0,1)]")}
        style={{ flex: 1 - props.node.ratio }}
      >
        <PanelLayout
          node={props.node.second}
          focusedLeafId={props.focusedLeafId}
          canClose={props.canClose}
          onSplit={props.onSplit}
          onToggleFocus={props.onToggleFocus}
          onClose={props.onClose}
          onUpdateRatio={props.onUpdateRatio}
          getContent={props.getContent}
          onDrop={props.onDrop}
          onUpdateContent={props.onUpdateContent}
          onDropSplit={props.onDropSplit}
          onMovePanel={props.onMovePanel}
        />
      </div>
    </div>
  );
}
