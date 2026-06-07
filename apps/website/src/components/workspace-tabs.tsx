import { createSignal, For, Show, Switch, Match, onMount, onCleanup } from "solid-js";
import { Bookmark, Plus, SquarePlus, X } from "lucide-solid";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { TooltipLabel } from "@/components/ui/tooltip";
import { tabDwellTarget, tabDwellProgress } from "@/lib/drag-state";
import { useCoViewTabs } from "@/co-view/primitives";

// Sentinel id for the "+" button treated as a drag-dwell target. When a user
// dwells on the plus during a panel drag, App.tsx interprets this as "create
// a new workspace and switch to it" — same 600ms progress animation as real
// tabs.
export const NEW_WORKSPACE_TAB_ID = "__new_workspace__";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SyncState = "local" | "saved" | "dirty" | "saving" | "error";

export type Workspace = {
  id: string;
  name: string;
  savedId: string | null;
  syncState: SyncState;
};

type WorkspaceTabsProps = {
  workspaces: Workspace[];
  activeId: string;
  onActivate: (id: string) => void;
  onAdd: () => void;
  onClose: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onSave: (id: string, name: string | null) => void;
  onUnsave: (id: string) => void;
};

// ---------------------------------------------------------------------------
// Bookmark icon
// ---------------------------------------------------------------------------

function BookmarkIcon(props: { syncState: SyncState }) {
  return (
    <Switch>
      <Match when={props.syncState === "saving"}>
        <div class="size-4 shrink-0 animate-spin rounded-full border border-primary border-t-transparent" />
      </Match>
      <Match when={props.syncState === "saved"}>
        <Bookmark class="size-4 shrink-0 fill-primary stroke-primary" />
      </Match>
      <Match when={props.syncState === "dirty"}>
        <Bookmark class="size-4 shrink-0 fill-primary/50 stroke-primary/50 animate-pulse" />
      </Match>
      <Match when={props.syncState === "error"}>
        <Bookmark class="size-4 shrink-0 stroke-destructive" />
      </Match>
      <Match when={props.syncState === "local"}>
        <Bookmark class="size-4 shrink-0 opacity-40" />
      </Match>
    </Switch>
  );
}

// ---------------------------------------------------------------------------
// WorkspaceTabs
// ---------------------------------------------------------------------------

export function WorkspaceTabs(props: WorkspaceTabsProps) {
  useCoViewTabs({
    controlId: "workspace-tabs",
    activeId: () => props.activeId,
  });
  const [isOverflowing, setIsOverflowing] = createSignal(false);
  const [editingId, setEditingId] = createSignal<string | null>(null);
  const [editingMode, setEditingMode] = createSignal<"rename" | "save">("rename");

  let scrollRef: HTMLDivElement | undefined;

  const checkOverflow = () => {
    if (scrollRef) setIsOverflowing(scrollRef.scrollWidth > scrollRef.clientWidth);
  };

  onMount(() => {
    if (!scrollRef) return;
    const ro = new ResizeObserver(checkOverflow);
    ro.observe(scrollRef);
    onCleanup(() => ro.disconnect());
  });

  // Recheck overflow when workspaces change
  let prevLen = props.workspaces.length;
  const intervalCheck = setInterval(() => {
    if (props.workspaces.length !== prevLen) {
      prevLen = props.workspaces.length;
      queueMicrotask(checkOverflow);
    }
  }, 100);
  onCleanup(() => clearInterval(intervalCheck));

  // Drag-to-scroll
  let isDragging = false;
  let dragStartX = 0;
  let dragScrollLeft = 0;
  let didDrag = false;

  const onMouseDown = (e: MouseEvent) => {
    if (e.button !== 0 || !scrollRef) return;
    isDragging = true;
    didDrag = false;
    dragStartX = e.clientX;
    dragScrollLeft = scrollRef.scrollLeft;
    scrollRef.style.cursor = "grabbing";
    e.preventDefault();
  };

  const onMouseMove = (e: MouseEvent) => {
    if (!isDragging || !scrollRef) return;
    const dx = e.clientX - dragStartX;
    if (Math.abs(dx) > 4) didDrag = true;
    scrollRef.scrollLeft = dragScrollLeft - dx;
  };

  const onMouseUp = () => {
    if (!scrollRef) return;
    isDragging = false;
    scrollRef.style.cursor = "";
  };

  const startEdit = (id: string, mode: "rename" | "save") => {
    setEditingMode(mode);
    setEditingId(id);
  };

  const commitEdit = (id: string, value: string) => {
    const trimmed = value.trim();
    if (editingMode() === "save") {
      props.onSave(id, trimmed || null);
    } else {
      if (trimmed) props.onRename(id, trimmed);
    }
    setEditingId(null);
  };

  const cancelEdit = () => setEditingId(null);

  return (
    <div
      ref={scrollRef}
      class="flex items-stretch flex-1 overflow-x-auto min-w-0 cursor-default"
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseUp}
    >
      <For each={props.workspaces}>
        {(workspace) => {
          const isActive = () => props.activeId === workspace.id;
          const canClose = () => props.workspaces.length > 1;
          const isEditing = () => editingId() === workspace.id;
          const isSaved = () =>
            workspace.syncState === "saved" ||
            workspace.syncState === "dirty" ||
            workspace.syncState === "saving";

          return (
            <div
              data-workspace-tab={workspace.id}
              class={cn(
                "group relative flex h-full min-w-0 max-w-48 shrink-0 items-center gap-1.5 border-b-2 px-3 text-sm cursor-pointer select-none",
                "transition-colors duration-100",
                isActive()
                  ? "border-b-sidebar-primary bg-muted/20 text-foreground"
                  : "border-b-transparent text-muted-foreground hover:bg-muted/10 hover:text-foreground"
              )}
              onClick={() => {
                if (!didDrag && !isEditing()) props.onActivate(workspace.id);
              }}
              onDblClick={(e) => {
                if (isEditing()) return;
                e.preventDefault();
                startEdit(workspace.id, "rename");
              }}
            >
                {/* Tab-dwell progress overlay during cross-workspace drag. The
                 * background tint grows with progress; a bottom bar fills to
                 * show the 600ms countdown. Using opacity+width (not transform)
                 * so we don't fight any CSS transitions on the tab itself. */}
                <Show when={tabDwellTarget() === workspace.id}>
                  <div
                    class="pointer-events-none absolute inset-0 bg-sidebar-primary/10 animate-in fade-in-0 duration-150"
                    style={{ opacity: String(0.3 + tabDwellProgress() * 0.7) }}
                  />
                  <div class="pointer-events-none absolute bottom-0 left-0 right-0 h-0.5 overflow-hidden">
                    <div
                      class="h-full bg-sidebar-primary"
                      style={{ width: `${tabDwellProgress() * 100}%` }}
                    />
                  </div>
                </Show>
                {/* Bookmark icon. For "saved"/"dirty"/"error" workspaces
                 * it's always visible (the sync indicator is meaningful).
                 *
                 * For "local" (unsaved) workspaces the bookmark is a "save
                 * this" affordance. Desktop keeps the hover-slide reveal on
                 * every tab — clean and consistent regardless of active
                 * state. Touch devices (where `hover: none` matches) have no
                 * hover, so we always show the bookmark on the active tab
                 * only, to keep the narrow mobile tab row uncluttered. */}
                <span
                  class={cn(
                    "shrink-0 overflow-hidden transition-all duration-150",
                    workspace.syncState === "local"
                      ? cn(
                          "max-w-0 group-hover:max-w-7",
                          isActive() && "[@media(hover:none)]:max-w-7",
                        )
                      : "max-w-7"
                  )}
                >
                  <TooltipLabel label={isSaved() ? "Unsave workspace" : "Save workspace"} side="bottom">
                    <button
                      class="flex size-5 items-center justify-center rounded transition-colors hover:bg-muted"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (workspace.syncState === "local" || workspace.syncState === "error") {
                          props.onActivate(workspace.id);
                          startEdit(workspace.id, "save");
                        } else if (workspace.syncState === "saved" || workspace.syncState === "dirty") {
                          props.onUnsave(workspace.id);
                        }
                      }}
                    >
                      <BookmarkIcon syncState={workspace.syncState} />
                    </button>
                  </TooltipLabel>
                </span>

                {/* Name — inline input when editing, plain text otherwise.
                 *  Save mode (bookmark click): empty input + "Name workspace"
                 *  placeholder + Save button — telegraphs the next step so
                 *  first-time users see what to do. Rename mode (double-click
                 *  on tab): prefilled with current name, Enter or blur commits.
                 *  Both: Escape cancels. Empty save commits with null name and
                 *  the workspace keeps its auto-generated name. */}
                <Show
                  when={isEditing()}
                  fallback={<span class="truncate flex-1">{workspace.name}</span>}
                >
                  {(() => {
                    let committed = false;
                    let inputRef: HTMLInputElement | undefined;
                    const isSaveMode = () => editingMode() === "save";
                    return (
                      <>
                        <input
                          class="flex-1 min-w-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground/60"
                          value={isSaveMode() ? "" : workspace.name}
                          placeholder={isSaveMode() ? "Name workspace" : undefined}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") { committed = true; commitEdit(workspace.id, e.currentTarget.value); }
                            if (e.key === "Escape") { committed = true; cancelEdit(); }
                            e.stopPropagation();
                          }}
                          onBlur={(e) => { if (!committed) commitEdit(workspace.id, e.currentTarget.value); }}
                          onClick={(e) => e.stopPropagation()}
                          onMouseDown={(e) => e.stopPropagation()}
                          ref={(el) => {
                            inputRef = el;
                            // Rename pre-selects so retyping replaces the name.
                            // Save starts empty, so just focus.
                            setTimeout(() => { el.focus(); if (!isSaveMode()) el.select(); }, 0);
                          }}
                        />
                        <Show when={isSaveMode()}>
                          {/* pointerdown + preventDefault keeps focus on the
                           *  input so onBlur doesn't race with our explicit
                           *  commit. The committed flag also short-circuits
                           *  onBlur if focus does move (e.g. tab-away). */}
                          <button
                            type="button"
                            class="shrink-0 rounded-sm bg-primary px-1.5 py-0.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90"
                            onPointerDown={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              committed = true;
                              commitEdit(workspace.id, inputRef?.value ?? "");
                            }}
                          >
                            Save
                          </button>
                        </Show>
                      </>
                    );
                  })()}
                </Show>

                {/* Close button */}
                <Show when={canClose() && !isEditing()}>
                  <button
                    class={cn(
                      "shrink-0 rounded p-0.5 transition-opacity",
                      "text-muted-foreground hover:bg-muted hover:text-foreground",
                      isActive()
                        ? "opacity-60 group-hover:opacity-100"
                        : "opacity-0 group-hover:opacity-60 group-hover:hover:opacity-100"
                    )}
                    aria-label="Close workspace"
                    data-tooltip="Close workspace"
                    data-tooltip-side="bottom"
                    onClick={(e) => {
                      e.stopPropagation();
                      props.onClose(workspace.id);
                    }}
                  >
                    <X class="size-3" />
                  </button>
                </Show>

            </div>
          );
        }}
      </For>

      <div class="sticky right-0 flex items-stretch shrink-0 bg-background">
        <Show
          when={isOverflowing()}
          fallback={
            <TooltipLabel label="New workspace" side="bottom" class="h-full">
              <button
                data-workspace-tab={NEW_WORKSPACE_TAB_ID}
                class="relative flex h-full w-9 items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/10 transition-colors"
                onClick={props.onAdd}
              >
                <Plus class="size-4" />
                <Show when={tabDwellTarget() === NEW_WORKSPACE_TAB_ID}>
                  <div
                    class="pointer-events-none absolute inset-0 bg-sidebar-primary/10 animate-in fade-in-0 duration-150"
                    style={{ opacity: String(0.3 + tabDwellProgress() * 0.7) }}
                  />
                  <div class="pointer-events-none absolute bottom-0 left-0 right-0 h-0.5 overflow-hidden">
                    <div
                      class="h-full bg-sidebar-primary"
                      style={{ width: `${tabDwellProgress() * 100}%` }}
                    />
                  </div>
                </Show>
              </button>
            </TooltipLabel>
          }
        >
          <div class="flex items-center gap-2 px-2">
            <Separator orientation="vertical" class="data-[orientation=vertical]:h-4" />
            <TooltipLabel label="New workspace" side="bottom">
              <Button
                data-workspace-tab={NEW_WORKSPACE_TAB_ID}
                variant="ghost"
                size="icon"
                class="relative size-7"
                onClick={props.onAdd}
              >
                <SquarePlus class="size-4" />
                <Show when={tabDwellTarget() === NEW_WORKSPACE_TAB_ID}>
                  <div
                    class="pointer-events-none absolute inset-0 rounded-md bg-sidebar-primary/10 animate-in fade-in-0 duration-150"
                    style={{ opacity: String(0.3 + tabDwellProgress() * 0.7) }}
                  />
                  <div class="pointer-events-none absolute bottom-0 left-0 right-0 h-0.5 overflow-hidden">
                    <div
                      class="h-full bg-sidebar-primary"
                      style={{ width: `${tabDwellProgress() * 100}%` }}
                    />
                  </div>
                </Show>
              </Button>
            </TooltipLabel>
          </div>
        </Show>
      </div>
    </div>
  );
}
