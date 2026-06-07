// CenterDropOverlay — shown when a sidebar-item drag is dwelling on a leaf's
// center zone. Mounted at App root (alongside DragPill) rather than inside the
// panel tree because plugin iframes live in the portal container at z-40,
// which would otherwise occlude an in-tree overlay. Position: fixed + rect
// tracked from the target leaf puts it above the iframe at z-[46] while
// still hugging the leaf's bounds.
//
// Backdrop: heavy blur + dim on occupied leaves (user sees what they're
// replacing); gentle tint on empty leaves. Pointer-events off so hit-testing
// continues to resolve against the leaf underneath.

import { Show, createEffect, createMemo, createSignal, onCleanup, type Component } from "solid-js";
import { Dynamic } from "solid-js/web";
import { Hash, Users, Volume2, type LucideProps } from "lucide-solid";
import { dragContext, dropTarget, dwelling } from "@/lib/drag-state";
import { type PanelContent } from "@uncorded/protocol";
import { cn } from "@/lib/utils";

const ICON_MAP: Record<string, Component<LucideProps>> = {
  hash: Hash,
  users: Users,
  volume2: Volume2,
};

export function CenterDropOverlay(props: {
  getPanelContent: (leafId: string) => PanelContent | undefined;
}) {
  const active = createMemo(() => {
    const ctx = dragContext();
    const tgt = dropTarget();
    if (ctx?.kind !== "sidebar-item") return null;
    if (tgt === null || tgt.zone !== "center") return null;
    if (!dwelling()) return null;
    return {
      item: ctx.item,
      leafId: tgt.leafId,
      onOccupied: props.getPanelContent(tgt.leafId) !== undefined,
    };
  });

  const [rect, setRect] = createSignal<DOMRect | null>(null);

  createEffect(() => {
    const a = active();
    if (a === null) {
      setRect(null);
      return;
    }
    const leaf = document.querySelector<HTMLElement>(
      `[data-panel-leaf="${CSS.escape(a.leafId)}"]`,
    );
    if (leaf === null) return;
    const update = () => setRect(leaf.getBoundingClientRect());
    update();
    const ro = new ResizeObserver(update);
    ro.observe(leaf);
    window.addEventListener("resize", update);
    onCleanup(() => {
      ro.disconnect();
      window.removeEventListener("resize", update);
    });
  });

  return (
    <Show when={active()}>
      {(a) => (
        <Show when={rect()}>
          {(r) => (
            <div
              class={cn(
                "fixed flex flex-col items-center justify-center gap-3 pointer-events-none rounded-md",
                "animate-in fade-in-0 duration-150",
                a().onOccupied
                  ? "bg-background/55 backdrop-blur-sm"
                  : "bg-sidebar-primary/5",
              )}
              style={{
                left: `${r().left}px`,
                top: `${r().top}px`,
                width: `${r().width}px`,
                height: `${r().height}px`,
                "z-index": "46",
              }}
            >
              <div class="flex items-center gap-2 rounded-lg bg-background/95 px-3 py-2 shadow-lg ring-1 ring-sidebar-primary/40">
                <Dynamic
                  component={ICON_MAP[a().item.icon ?? "hash"] ?? Hash}
                  class="size-3.5 text-sidebar-primary shrink-0"
                />
                <span class="text-sm font-medium text-foreground">{a().item.label}</span>
              </div>
              <p class="text-xs text-sidebar-primary/70 select-none animate-in fade-in-0 slide-in-from-bottom-1 duration-300 delay-100 fill-mode-both">
                Release to open
              </p>
            </div>
          )}
        </Show>
      )}
    </Show>
  );
}
