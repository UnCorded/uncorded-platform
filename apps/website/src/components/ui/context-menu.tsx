import { ContextMenu as KContextMenu } from "@kobalte/core/context-menu";
import { type ComponentProps, splitProps } from "solid-js";
import { cn } from "@/lib/utils";
import { CoViewContextMenuMount } from "@/co-view/primitives";

const ContextMenu = KContextMenu;
const ContextMenuTrigger = KContextMenu.Trigger;
const ContextMenuPortal = KContextMenu.Portal;
const ContextMenuSeparator = KContextMenu.Separator;

type ContextMenuContentProps = ComponentProps<typeof KContextMenu.Content> & {
  class?: string;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  sideOffset?: number;
};

function ContextMenuContent(props: ContextMenuContentProps) {
  const [local, others] = splitProps(props, ["class", "side", "align", "sideOffset"]);
  const placement = () => {
    const side = local.side ?? "bottom";
    const align = local.align ?? "center";
    if (align === "center") return side;
    return `${side}-${align}` as const;
  };

  let contentEl: HTMLElement | null = null;

  return (
    <KContextMenu.Portal>
      <KContextMenu.Content
        ref={(el) => (contentEl = el)}
        placement={placement()}
        gutter={local.sideOffset ?? 4}
        class={cn(
          "z-50 min-w-[10rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md",
          "data-[expanded]:animate-in data-[expanded]:fade-in-0 data-[expanded]:zoom-in-95",
          "data-[closed]:animate-out data-[closed]:fade-out-0 data-[closed]:zoom-out-95",
          local.class
        )}
        {...others}
      >
        <CoViewContextMenuMount
          getEl={() => contentEl}
          position={() => {
            if (!contentEl) return undefined;
            const r = contentEl.getBoundingClientRect();
            return { x: r.left, y: r.top };
          }}
        />
      </KContextMenu.Content>
    </KContextMenu.Portal>
  );
}

type ContextMenuItemProps = ComponentProps<typeof KContextMenu.Item> & {
  class?: string;
};

function ContextMenuItem(props: ContextMenuItemProps) {
  const [local, others] = splitProps(props, ["class"]);
  return (
    <KContextMenu.Item
      class={cn(
        "relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none transition-colors focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
        local.class
      )}
      {...others}
    />
  );
}

export {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuPortal,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
};
