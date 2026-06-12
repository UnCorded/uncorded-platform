import { DropdownMenu as KDropdownMenu } from "@kobalte/core/dropdown-menu";
import { Check, Circle } from "lucide-solid";
import { type ComponentProps, type JSX, splitProps } from "solid-js";
import { cn } from "@/lib/utils";
import { CoViewPopoverMount } from "@/co-view/primitives";
import { SuspendSurfacesWhileOpen } from "@/components/ui/surface-blocker";

const DropdownMenu = KDropdownMenu;
const DropdownMenuTrigger = KDropdownMenu.Trigger;
const DropdownMenuPortal = KDropdownMenu.Portal;
const DropdownMenuSeparator = KDropdownMenu.Separator;
const DropdownMenuGroup = KDropdownMenu.Group;
const DropdownMenuGroupLabel = KDropdownMenu.GroupLabel;
const DropdownMenuSub = KDropdownMenu.Sub;
const DropdownMenuSubTrigger = KDropdownMenu.SubTrigger;
const DropdownMenuRadioGroup = KDropdownMenu.RadioGroup;
const DropdownMenuItemIndicator = KDropdownMenu.ItemIndicator;

type DropdownMenuContentProps = ComponentProps<typeof KDropdownMenu.Content> & {
  class?: string;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  sideOffset?: number;
};

function DropdownMenuContent(props: DropdownMenuContentProps) {
  const [local, others] = splitProps(props, ["class", "side", "align", "sideOffset", "children"]);
  const placement = () => {
    const s = local.side ?? "bottom";
    const a = local.align ?? "center";
    if (a === "center") return s;
    return `${s}-${a}` as const;
  };
  let contentEl: HTMLElement | null = null;
  return (
    <KDropdownMenu.Portal>
      <KDropdownMenu.Content
        ref={(el) => (contentEl = el)}
        placement={placement()}
        gutter={local.sideOffset ?? 4}
        class={cn(
          "z-50 min-w-[8rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md",
          "data-[expanded]:animate-in data-[expanded]:fade-in-0 data-[expanded]:zoom-in-95",
          "data-[closed]:animate-out data-[closed]:fade-out-0 data-[closed]:zoom-out-95",
          local.class
        )}
        {...others}
      >
        {/* The menu can open OVER a Web App panel's native view (paints above all
            DOM). Suspend native views for the menu's open lifetime so it isn't
            punched through. Rendered HERE (a Content child mounts only while open)
            rather than in the wrapper body, which never unmounts and would pin
            suspension — see surface-blocker.tsx. */}
        <SuspendSurfacesWhileOpen />
        <CoViewPopoverMount getEl={() => contentEl} />
        {local.children}
      </KDropdownMenu.Content>
    </KDropdownMenu.Portal>
  );
}

type DropdownMenuItemProps = ComponentProps<typeof KDropdownMenu.Item> & {
  class?: string;
  inset?: boolean;
  destructive?: boolean;
};

function DropdownMenuItem(props: DropdownMenuItemProps) {
  const [local, others] = splitProps(props, ["class", "inset", "destructive"]);
  return (
    <KDropdownMenu.Item
      class={cn(
        "relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none transition-colors focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
        local.inset && "pl-8",
        local.destructive && "text-destructive focus:text-destructive",
        local.class
      )}
      {...others}
    />
  );
}

type DropdownMenuCheckboxItemProps = ComponentProps<typeof KDropdownMenu.CheckboxItem> & {
  class?: string;
  children?: JSX.Element;
};

function DropdownMenuCheckboxItem(props: DropdownMenuCheckboxItemProps) {
  const [local, others] = splitProps(props, ["class", "children"]);
  return (
    <KDropdownMenu.CheckboxItem
      class={cn(
        "relative flex cursor-default select-none items-center gap-2 rounded-sm py-1.5 pl-8 pr-2 text-sm outline-none transition-colors focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        local.class
      )}
      {...others}
    >
      <span class="absolute left-2 flex size-3.5 items-center justify-center">
        <KDropdownMenu.ItemIndicator>
          <Check class="size-4" />
        </KDropdownMenu.ItemIndicator>
      </span>
      {local.children}
    </KDropdownMenu.CheckboxItem>
  );
}

type DropdownMenuRadioItemProps = ComponentProps<typeof KDropdownMenu.RadioItem> & {
  class?: string;
  children?: JSX.Element;
};

function DropdownMenuRadioItem(props: DropdownMenuRadioItemProps) {
  const [local, others] = splitProps(props, ["class", "children"]);
  return (
    <KDropdownMenu.RadioItem
      class={cn(
        "relative flex cursor-default select-none items-center gap-2 rounded-sm py-1.5 pl-8 pr-2 text-sm outline-none transition-colors focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        local.class
      )}
      {...others}
    >
      <span class="absolute left-2 flex size-3.5 items-center justify-center">
        <KDropdownMenu.ItemIndicator>
          <Circle class="size-2 fill-current" />
        </KDropdownMenu.ItemIndicator>
      </span>
      {local.children}
    </KDropdownMenu.RadioItem>
  );
}

function DropdownMenuLabel(
  props: ComponentProps<"div"> & { class?: string; inset?: boolean; children?: JSX.Element }
) {
  const [local, others] = splitProps(props, ["class", "inset"]);
  return (
    <div
      class={cn("px-2 py-1.5 text-sm font-semibold", local.inset && "pl-8", local.class)}
      {...others}
    />
  );
}

function DropdownMenuShortcut(props: ComponentProps<"span">) {
  const [local, others] = splitProps(props, ["class"]);
  return (
    <span class={cn("ml-auto text-xs tracking-widest opacity-60", local.class)} {...others} />
  );
}

type DropdownMenuSubContentProps = ComponentProps<typeof KDropdownMenu.SubContent> & {
  class?: string;
};

function DropdownMenuSubContent(props: DropdownMenuSubContentProps) {
  const [local, others] = splitProps(props, ["class"]);
  return (
    <KDropdownMenu.SubContent
      class={cn(
        "z-50 min-w-[8rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-lg",
        "data-[expanded]:animate-in data-[expanded]:fade-in-0 data-[expanded]:zoom-in-95",
        "data-[closed]:animate-out data-[closed]:fade-out-0 data-[closed]:zoom-out-95",
        local.class
      )}
      {...others}
    />
  );
}

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuPortal,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuGroup,
  DropdownMenuGroupLabel,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuRadioGroup,
  DropdownMenuItemIndicator,
};
