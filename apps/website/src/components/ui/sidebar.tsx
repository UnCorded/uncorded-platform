import {
  type Accessor,
  type ComponentProps,
  type JSX,
  type Setter,
  createContext,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  splitProps,
  useContext,
  Show,
} from "solid-js";
import { type VariantProps, cva } from "class-variance-authority";
import { PanelLeft } from "lucide-solid";
import { cn, mod } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

// ─── Constants ──────────────────────────────────────────────────────────────
const SIDEBAR_COOKIE_NAME = "sidebar_state";
const SIDEBAR_COOKIE_MAX_AGE = 60 * 60 * 24 * 7;
const SIDEBAR_WIDTH = "16rem";
const SIDEBAR_WIDTH_MOBILE = "18rem";
const SIDEBAR_WIDTH_ICON = "3rem";
const SIDEBAR_KEYBOARD_SHORTCUT = "b";

// ─── Context ─────────────────────────────────────────────────────────────────
type SidebarContextValue = {
  state: Accessor<"expanded" | "collapsed">;
  open: Accessor<boolean>;
  setOpen: (value: boolean | ((v: boolean) => boolean)) => void;
  openMobile: Accessor<boolean>;
  setOpenMobile: Setter<boolean>;
  isMobile: Accessor<boolean>;
  toggleSidebar: () => void;
};

const SidebarContext = createContext<SidebarContextValue>();

function useSidebar(): SidebarContextValue {
  const ctx = useContext(SidebarContext);
  if (!ctx) throw new Error("useSidebar must be used within a SidebarProvider.");
  return ctx;
}

// ─── Cookie helpers ───────────────────────────────────────────────────────────
function getCookieValue(name: string): string | undefined {
  if (typeof document === "undefined") return undefined;
  const match = document.cookie.split("; ").find((row) => row.startsWith(`${name}=`));
  return match?.split("=")[1];
}

// ─── SidebarProvider ─────────────────────────────────────────────────────────
type SidebarProviderProps = ComponentProps<"div"> & {
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

function SidebarProvider(props: SidebarProviderProps) {
  const [local, others] = splitProps(props, [
    "class",
    "style",
    "defaultOpen",
    "open",
    "onOpenChange",
    "children",
  ]);

  const cookieValue = getCookieValue(SIDEBAR_COOKIE_NAME);
  const resolvedDefault =
    local.defaultOpen ?? (cookieValue !== undefined ? cookieValue === "true" : true);

  const [_open, _setOpen] = createSignal(resolvedDefault);
  const [openMobile, setOpenMobile] = createSignal(false);
  const [isMobile, setIsMobile] = createSignal(
    typeof window !== "undefined" ? window.innerWidth < 768 : false
  );

  onMount(() => {
    const mql = window.matchMedia("(max-width: 767px)");
    const onChange = () => setIsMobile(window.innerWidth < 768);
    mql.addEventListener("change", onChange);
    onCleanup(() => mql.removeEventListener("change", onChange));
  });

  const open = createMemo(() => local.open ?? _open());
  const state = createMemo<"expanded" | "collapsed">(() => (open() ? "expanded" : "collapsed"));

  const setOpen = (value: boolean | ((v: boolean) => boolean)) => {
    const resolved = typeof value === "function" ? value(_open()) : value;
    if (local.onOpenChange) {
      local.onOpenChange(resolved);
    } else {
      _setOpen(resolved);
    }
    document.cookie = `${SIDEBAR_COOKIE_NAME}=${resolved}; path=/; max-age=${SIDEBAR_COOKIE_MAX_AGE}`;
  };

  const toggleSidebar = () => {
    if (isMobile()) {
      setOpenMobile((v) => !v);
    } else {
      setOpen(!open());
    }
  };

  onMount(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === SIDEBAR_KEYBOARD_SHORTCUT && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        toggleSidebar();
      }
    };
    document.addEventListener("keydown", handler);
    onCleanup(() => document.removeEventListener("keydown", handler));
  });

  const ctx: SidebarContextValue = {
    state,
    open,
    setOpen,
    openMobile,
    setOpenMobile,
    isMobile,
    toggleSidebar,
  };

  return (
    <SidebarContext.Provider value={ctx}>
      <TooltipProvider>
        <div
          style={{
            "--sidebar-width": SIDEBAR_WIDTH,
            "--sidebar-width-icon": SIDEBAR_WIDTH_ICON,
            ...(typeof local.style === "object" ? local.style : {}),
          }}
          class={cn(
            "group/sidebar-wrapper has-data-[variant=inset]:bg-sidebar flex h-svh w-full overflow-hidden",
            local.class
          )}
          data-slot="sidebar-wrapper"
          {...others}
        >
          {local.children}
        </div>
      </TooltipProvider>
    </SidebarContext.Provider>
  );
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────
type SidebarProps = ComponentProps<"div"> & {
  side?: "left" | "right";
  variant?: "sidebar" | "floating" | "inset";
  collapsible?: "offcanvas" | "icon" | "none";
};

function Sidebar(props: SidebarProps) {
  const [local, others] = splitProps(props, ["class", "side", "variant", "collapsible", "children"]);
  const ctx = useSidebar();
  const side = () => local.side ?? "left";
  const variant = () => local.variant ?? "sidebar";
  const collapsible = () => local.collapsible ?? "offcanvas";


  return (
    <Show
      when={collapsible() !== "none"}
      fallback={
        <div
          data-slot="sidebar"
          class={cn("flex h-full w-(--sidebar-width) flex-col bg-sidebar text-sidebar-foreground", local.class)}
          {...others}
        >
          {local.children}
        </div>
      }
    >
      <Show
        when={ctx.isMobile()}
        fallback={
          <div
            class="group peer hidden text-sidebar-foreground md:block"
            data-slot="sidebar"
            data-state={ctx.state()}
            data-collapsible={ctx.state() === "collapsed" ? collapsible() : ""}
            data-variant={variant()}
            data-side={side()}
          >
            <div
              class={cn(
                "relative w-(--sidebar-width) bg-transparent transition-[width] duration-200 ease-linear",
                "group-data-[collapsible=offcanvas]:w-0",
                "group-data-[side=right]:rotate-180",
                variant() === "floating" || variant() === "inset"
                  ? "group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)_+_--spacing(4))]"
                  : "group-data-[collapsible=icon]:w-(--sidebar-width-icon)"
              )}
            />
            <div
              class={cn(
                "fixed bottom-0 z-10 hidden top-[var(--titlebar-h,0px)] h-[calc(100svh-var(--titlebar-h,0px))] w-(--sidebar-width) flex-col transition-[left,right,width] duration-200 ease-linear md:flex",
                side() === "left"
                  ? "left-0 group-data-[collapsible=offcanvas]:left-[calc(var(--sidebar-width)*-1)]"
                  : "right-0 group-data-[collapsible=offcanvas]:right-[calc(var(--sidebar-width)*-1)]",
                variant() === "floating" || variant() === "inset"
                  ? "p-2 group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)_+_--spacing(4)_+2px)]"
                  : "group-data-[collapsible=icon]:w-(--sidebar-width-icon) group-data-[side=left]:border-r group-data-[side=right]:border-l",
                local.class
              )}
              {...others}
            >
              <div
                data-sidebar="sidebar"
                class="flex h-full w-full flex-col bg-sidebar group-data-[variant=floating]:rounded-lg group-data-[variant=floating]:border group-data-[variant=floating]:border-sidebar-border group-data-[variant=floating]:shadow-sm"
              >
                {local.children}
              </div>
            </div>
          </div>
        }
      >
        <Sheet open={ctx.openMobile()} onOpenChange={ctx.setOpenMobile}>
          <SheetContent
            data-sidebar="sidebar"
            data-mobile="true"
            class="w-(--sidebar-width) bg-sidebar p-0 text-sidebar-foreground [&>button]:hidden"
            style={{ "--sidebar-width": SIDEBAR_WIDTH_MOBILE } as JSX.CSSProperties}
            side="left"
          >
            <SheetHeader class="sr-only">
              <SheetTitle>Sidebar</SheetTitle>
              <SheetDescription>Navigation sidebar</SheetDescription>
            </SheetHeader>
            <div class="flex h-full w-full flex-col">{local.children}</div>
          </SheetContent>
        </Sheet>
      </Show>
    </Show>
  );
}

// ─── SidebarTrigger ───────────────────────────────────────────────────────────
function SidebarTrigger(props: ComponentProps<"button">) {
  const [local, others] = splitProps(props, ["class", "onClick"]);
  const ctx = useSidebar();
  return (
    <Button
      data-sidebar="trigger"
      data-slot="sidebar-trigger"
      data-tooltip="Toggle sidebar"
      data-tooltip-key={mod("B")}
      variant="ghost"
      size="icon"
      class={cn("size-7", local.class)}
      onClick={(e: MouseEvent) => {
        if (typeof local.onClick === "function") (local.onClick as (e: MouseEvent) => void)(e);
        ctx.toggleSidebar();
      }}
      {...others}
    >
      <PanelLeft class="size-4" />
      <span class="sr-only">Toggle Sidebar</span>
    </Button>
  );
}

// ─── SidebarRail ─────────────────────────────────────────────────────────────
function SidebarRail(props: ComponentProps<"button">) {
  const [local, others] = splitProps(props, ["class"]);
  const ctx = useSidebar();
  return (
    <button
      data-sidebar="rail"
      data-slot="sidebar-rail"
      aria-label="Toggle Sidebar"
      tabIndex={-1}
      onClick={ctx.toggleSidebar}
      class={cn(
        "hover:after:bg-sidebar-border absolute inset-y-0 z-20 hidden w-4 -translate-x-1/2 transition-all ease-linear after:absolute after:inset-y-0 after:left-1/2 after:w-[2px] group-data-[side=left]:-right-4 group-data-[side=right]:left-0 sm:flex",
        "in-data-[side=left]:cursor-w-resize in-data-[side=right]:cursor-e-resize",
        "group-data-[collapsible=offcanvas]:translate-x-0 group-data-[collapsible=offcanvas]:after:left-full group-data-[collapsible=offcanvas]:hover:bg-sidebar",
        "group-data-[side=left]:group-data-[collapsible=offcanvas]:-right-2",
        "group-data-[side=right]:group-data-[collapsible=offcanvas]:-left-2",
        local.class
      )}
      {...others}
    />
  );
}

// ─── SidebarInset ─────────────────────────────────────────────────────────────
function SidebarInset(props: ComponentProps<"main">) {
  const [local, others] = splitProps(props, ["class"]);
  return (
    <main
      data-slot="sidebar-inset"
      class={cn(
        "relative flex min-w-0 flex-1 flex-col bg-background overflow-hidden",
        "md:peer-data-[variant=inset]:m-2 md:peer-data-[variant=inset]:ml-0 md:peer-data-[variant=inset]:rounded-xl md:peer-data-[variant=inset]:shadow-sm",
        "md:peer-data-[variant=inset]:peer-data-[state=collapsed]:ml-2",
        local.class
      )}
      {...others}
    />
  );
}

// ─── SidebarHeader / Footer / Content ─────────────────────────────────────────
function SidebarHeader(props: ComponentProps<"div">) {
  const [local, others] = splitProps(props, ["class"]);
  return (
    <div
      data-sidebar="header"
      data-slot="sidebar-header"
      class={cn("flex flex-col gap-2 p-2", local.class)}
      {...others}
    />
  );
}

function SidebarFooter(props: ComponentProps<"div">) {
  const [local, others] = splitProps(props, ["class"]);
  return (
    <div
      data-sidebar="footer"
      data-slot="sidebar-footer"
      class={cn("flex flex-col gap-2 p-2", local.class)}
      {...others}
    />
  );
}

function SidebarContent(props: ComponentProps<"div">) {
  const [local, others] = splitProps(props, ["class"]);
  return (
    <div
      data-sidebar="content"
      data-slot="sidebar-content"
      class={cn(
        "flex min-h-0 flex-1 flex-col gap-2 overflow-auto group-data-[collapsible=icon]:overflow-hidden",
        local.class
      )}
      {...others}
    />
  );
}

// ─── SidebarGroup ─────────────────────────────────────────────────────────────
function SidebarGroup(props: ComponentProps<"div">) {
  const [local, others] = splitProps(props, ["class"]);
  return (
    <div
      data-sidebar="group"
      data-slot="sidebar-group"
      class={cn("relative flex w-full min-w-0 flex-col p-2", local.class)}
      {...others}
    />
  );
}

function SidebarGroupLabel(props: ComponentProps<"div">) {
  const [local, others] = splitProps(props, ["class"]);
  return (
    <div
      data-sidebar="group-label"
      data-slot="sidebar-group-label"
      class={cn(
        "duration-200 flex h-8 shrink-0 items-center rounded-md px-2 text-xs font-medium text-sidebar-foreground/70 outline-hidden ring-sidebar-ring transition-[margin,opacity] ease-linear focus-visible:ring-2 [&>svg]:size-4 [&>svg]:shrink-0",
        "group-data-[collapsible=icon]:-mt-8 group-data-[collapsible=icon]:opacity-0",
        local.class
      )}
      {...others}
    />
  );
}

function SidebarGroupAction(props: ComponentProps<"button"> & { showOnHover?: boolean }) {
  const [local, others] = splitProps(props, ["class", "showOnHover"]);
  return (
    <button
      data-sidebar="group-action"
      data-slot="sidebar-group-action"
      class={cn(
        "absolute right-3 top-3.5 flex aspect-square w-5 items-center justify-center rounded-md p-0 text-sidebar-foreground outline-hidden ring-sidebar-ring transition-transform hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 [&>svg]:size-4 [&>svg]:shrink-0",
        "after:absolute after:-inset-2 after:md:hidden",
        "group-data-[collapsible=icon]:hidden",
        local.showOnHover &&
          "group-focus-within/menu-item:opacity-100 group-hover/menu-item:opacity-100 data-[expanded]:opacity-100 peer-data-[active=true]/menu-button:text-sidebar-accent-foreground md:opacity-0",
        local.class
      )}
      {...others}
    />
  );
}

function SidebarGroupContent(props: ComponentProps<"div">) {
  const [local, others] = splitProps(props, ["class"]);
  return (
    <div
      data-sidebar="group-content"
      data-slot="sidebar-group-content"
      class={cn("w-full text-sm", local.class)}
      {...others}
    />
  );
}

// ─── SidebarSeparator ─────────────────────────────────────────────────────────
function SidebarSeparator(props: ComponentProps<"div">) {
  const [local, others] = splitProps(props, ["class"]);
  return (
    <Separator
      data-sidebar="separator"
      data-slot="sidebar-separator"
      class={cn("mx-2 w-auto bg-sidebar-border", local.class)}
      {...others}
    />
  );
}

// ─── SidebarMenu ──────────────────────────────────────────────────────────────
function SidebarMenu(props: ComponentProps<"ul">) {
  const [local, others] = splitProps(props, ["class"]);
  return (
    <ul
      data-sidebar="menu"
      data-slot="sidebar-menu"
      class={cn("flex w-full min-w-0 flex-col gap-1", local.class)}
      {...others}
    />
  );
}

function SidebarMenuItem(props: ComponentProps<"li">) {
  const [local, others] = splitProps(props, ["class"]);
  return (
    <li
      data-sidebar="menu-item"
      data-slot="sidebar-menu-item"
      class={cn("group/menu-item relative", local.class)}
      {...others}
    />
  );
}

// ─── SidebarMenuButton ────────────────────────────────────────────────────────
const sidebarMenuButtonVariants = cva(
  "peer/menu-button flex w-full items-center gap-2 overflow-hidden rounded-md p-2 text-left text-sm outline-hidden ring-sidebar-ring transition-[width,height,padding] group-has-data-[sidebar=menu-action]/menu-item:pr-8 group-data-[collapsible=icon]:size-8! group-data-[collapsible=icon]:p-2! hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 active:bg-sidebar-accent active:text-sidebar-accent-foreground disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 data-[active=true]:bg-sidebar-accent data-[active=true]:font-medium data-[active=true]:text-sidebar-accent-foreground data-[expanded]:hover:bg-sidebar-accent data-[expanded]:hover:text-sidebar-accent-foreground [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
        outline:
          "bg-background shadow-[0_0_0_1px_hsl(var(--sidebar-border))] hover:bg-sidebar-accent hover:text-sidebar-accent-foreground hover:shadow-[0_0_0_1px_hsl(var(--sidebar-accent))]",
      },
      size: {
        default: "h-8 text-sm",
        sm: "h-7 text-xs",
        lg: "h-12 text-sm group-data-[collapsible=icon]:p-0!",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

type SidebarMenuButtonProps = Omit<ComponentProps<"button">, "size"> &
  VariantProps<typeof sidebarMenuButtonVariants> & {
    as?: string;
    href?: string;
    isActive?: boolean;
    tooltip?: string | { children: JSX.Element };
  };

function SidebarMenuButton(props: SidebarMenuButtonProps) {
  const [local, others] = splitProps(props, [
    "class",
    "as",
    "href",
    "variant",
    "size",
    "isActive",
    "tooltip",
  ]);
  const ctx = useSidebar();

  const buttonClass = () =>
    cn(sidebarMenuButtonVariants({ variant: local.variant, size: local.size }), local.class);

  const tooltipLabel = () => {
    if (!local.tooltip) return null;
    return typeof local.tooltip === "string" ? local.tooltip : local.tooltip.children;
  };

  const isTooltipEnabled = () => !!local.tooltip && ctx.state() === "collapsed" && !ctx.isMobile();

  const tag = local.as ?? (local.href ? "a" : "button");

  const sharedAttrs = () => ({
    "data-sidebar": "menu-button" as const,
    "data-slot": "sidebar-menu-button" as const,
    "data-size": local.size ?? "default",
    "data-active": local.isActive || undefined,
    class: buttonClass(),
  });

  return (
    <Show
      when={!!local.tooltip}
      fallback={
        tag === "a" ? (
          <a href={local.href} {...sharedAttrs()} {...(others as ComponentProps<"a">)} />
        ) : tag === "div" ? (
          <div {...sharedAttrs()} {...(others as ComponentProps<"div">)} />
        ) : (
          <button {...sharedAttrs()} {...others} />
        )
      }
    >
      <Tooltip disabled={!isTooltipEnabled()}>
        <TooltipTrigger
          as={tag as "button"}
          {...(sharedAttrs() as any)}
          {...(others as any)}
        />
        <TooltipContent side="right" sideOffset={4}>
          {tooltipLabel()}
        </TooltipContent>
      </Tooltip>
    </Show>
  );
}

// ─── SidebarMenuAction ────────────────────────────────────────────────────────
function SidebarMenuAction(props: ComponentProps<"button"> & { showOnHover?: boolean }) {
  const [local, others] = splitProps(props, ["class", "showOnHover"]);
  return (
    <button
      data-sidebar="menu-action"
      data-slot="sidebar-menu-action"
      class={cn(
        "absolute right-1 flex aspect-square w-5 items-center justify-center rounded-md p-0 text-sidebar-foreground outline-hidden ring-sidebar-ring transition-transform hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 peer-hover/menu-button:text-sidebar-accent-foreground [&>svg]:size-4 [&>svg]:shrink-0",
        "after:absolute after:-inset-2 after:md:hidden",
        "group-data-[collapsible=icon]:hidden",
        "peer-data-[size=sm]/menu-button:top-1 peer-data-[size=default]/menu-button:top-1.5 peer-data-[size=lg]/menu-button:top-2.5",
        local.showOnHover &&
          "group-focus-within/menu-item:opacity-100 group-hover/menu-item:opacity-100 data-[expanded]:opacity-100 peer-data-[active=true]/menu-button:text-sidebar-accent-foreground md:opacity-0",
        local.class
      )}
      {...others}
    />
  );
}

// ─── SidebarMenuBadge ─────────────────────────────────────────────────────────
function SidebarMenuBadge(props: ComponentProps<"div">) {
  const [local, others] = splitProps(props, ["class"]);
  return (
    <div
      data-sidebar="menu-badge"
      data-slot="sidebar-menu-badge"
      class={cn(
        "absolute right-1 flex h-5 min-w-5 items-center justify-center rounded-md px-1 text-xs font-medium tabular-nums text-sidebar-foreground select-none pointer-events-none",
        "peer-hover/menu-button:text-sidebar-accent-foreground peer-data-[active=true]/menu-button:text-sidebar-accent-foreground",
        "peer-data-[size=sm]/menu-button:top-1 peer-data-[size=default]/menu-button:top-1.5 peer-data-[size=lg]/menu-button:top-2.5",
        local.class
      )}
      {...others}
    />
  );
}

// ─── SidebarMenuSkeleton ──────────────────────────────────────────────────────
function SidebarMenuSkeleton(props: ComponentProps<"div"> & { showIcon?: boolean }) {
  const [local, others] = splitProps(props, ["class", "showIcon"]);
  const width = createMemo(() => `${Math.floor(Math.random() * 40) + 50}%`);
  return (
    <div
      data-sidebar="menu-skeleton"
      data-slot="sidebar-menu-skeleton"
      class={cn("rounded-md h-8 flex gap-2 px-2 items-center", local.class)}
      {...others}
    >
      <Show when={local.showIcon}>
        <Skeleton class="size-4 rounded-md" data-sidebar="menu-skeleton-icon" />
      </Show>
      <Skeleton
        class="h-4 flex-1 max-w-(--skeleton-width)"
        data-sidebar="menu-skeleton-text"
        style={{ "--skeleton-width": width() } as JSX.CSSProperties}
      />
    </div>
  );
}

// ─── SidebarMenuSub ───────────────────────────────────────────────────────────
function SidebarMenuSub(props: ComponentProps<"ul">) {
  const [local, others] = splitProps(props, ["class"]);
  return (
    <ul
      data-sidebar="menu-sub"
      data-slot="sidebar-menu-sub"
      class={cn(
        "mx-3.5 flex min-w-0 translate-x-px flex-col gap-1 border-l border-sidebar-border px-2.5 py-0.5",
        "group-data-[collapsible=icon]:hidden",
        local.class
      )}
      {...others}
    />
  );
}

function SidebarMenuSubItem(props: ComponentProps<"li">) {
  const [local, others] = splitProps(props, ["class"]);
  return (
    <li
      data-sidebar="menu-sub-item"
      data-slot="sidebar-menu-sub-item"
      class={cn("group/menu-sub-item relative", local.class)}
      {...others}
    />
  );
}

function SidebarMenuSubButton(
  props: ComponentProps<"a"> & {
    as?: string;
    href?: string;
    size?: "sm" | "md";
    isActive?: boolean;
  }
) {
  const [local, others] = splitProps(props, ["class", "as", "href", "size", "isActive"]);
  const tag = local.as ?? (local.href ? "a" : "button");
  const cls = cn(
    "flex h-7 min-w-0 -translate-x-px items-center gap-2 overflow-hidden rounded-md px-2 text-sidebar-foreground outline-hidden ring-sidebar-ring hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 active:bg-sidebar-accent active:text-sidebar-accent-foreground disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-sidebar-accent-foreground",
    "group-data-[collapsible=icon]:hidden",
    local.size === "sm" && "text-xs",
    (!local.size || local.size === "md") && "text-sm",
    local.isActive && "bg-sidebar-accent font-medium text-sidebar-accent-foreground",
    local.class
  );

  if (tag === "a") {
    return (
      <a
        href={local.href}
        data-sidebar="menu-sub-button"
        data-slot="sidebar-menu-sub-button"
        data-active={local.isActive || undefined}
        class={cls}
        {...(others as ComponentProps<"a">)}
      />
    );
  }
  return (
    <button
      data-sidebar="menu-sub-button"
      data-slot="sidebar-menu-sub-button"
      data-active={local.isActive || undefined}
      class={cls}
      {...(others as ComponentProps<"button">)}
    />
  );
}

export {
  useSidebar,
  SidebarProvider,
  Sidebar,
  SidebarTrigger,
  SidebarRail,
  SidebarInset,
  SidebarHeader,
  SidebarFooter,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarSeparator,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuSkeleton,
  SidebarMenuSub,
  SidebarMenuSubItem,
  SidebarMenuSubButton,
};
