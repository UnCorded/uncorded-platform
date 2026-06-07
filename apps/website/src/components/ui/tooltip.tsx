import { Tooltip as KTooltip } from "@kobalte/core/tooltip";
import { Portal } from "solid-js/web";
import {
  Show,
  createSignal,
  onCleanup,
  onMount,
  type ComponentProps,
  type JSX,
  splitProps,
} from "solid-js";
import { cn } from "@/lib/utils";

// Shared tooltip timing — both the Kobalte path and the lightweight
// data-tooltip hover layer must match so a user moving between buttons
// of either kind feels one consistent system. 180ms matches Linear/Vercel;
// 350ms was macOS-tier slow and made the UI feel sluggish.
const OPEN_DELAY_MS = 180;
const CLOSE_DELAY_MS = 80;
const SKIP_DELAY_MS = 300;

// Visual tokens shared by both paths. Keep these here so a designer touching
// the popover surface only edits one place.
const TOOLTIP_SURFACE =
  "z-50 max-w-[min(280px,calc(100vw-2rem))] flex items-center gap-2 whitespace-nowrap rounded-md border border-border/70 bg-popover/95 px-2.5 py-1.5 text-[11px] font-medium leading-4 text-popover-foreground shadow-xl backdrop-blur-sm will-change-[transform,opacity]";
const TOOLTIP_ENTER =
  "animate-in fade-in-0 zoom-in-95 duration-150 motion-reduce:animate-none";
const TOOLTIP_KOBALTE_ANIM =
  "data-[expanded]:animate-in data-[expanded]:fade-in-0 data-[expanded]:zoom-in-95 data-[expanded]:duration-150 " +
  "data-[closed]:animate-out data-[closed]:fade-out-0 data-[closed]:zoom-out-95 data-[closed]:duration-100 " +
  "motion-reduce:animate-none motion-reduce:transition-none";

// Keybind chip — small, mono, faintly bordered. Matches the JetBrains/Linear
// idiom: subtle enough to ignore when irrelevant, scannable when you're
// looking for it. Uppercase tracking pulls the eye to the keys.
const TOOLTIP_KBD =
  "inline-flex h-4 items-center justify-center rounded-[3px] border border-border/50 bg-muted/40 px-1 font-mono text-[10px] font-medium tracking-wide text-muted-foreground/90";

// Directional transform-origin so the scale-in animation appears to grow
// from the side of the trigger ("born from the button"). We compute the
// origin from the requested `side` rather than the resolved placement —
// Kobalte doesn't expose the runtime placement as a DOM attribute, so this
// stays slightly stale after an auto-flip. Acceptable: flips happen only
// near viewport edges where the discrepancy is barely perceptible.
function originForSide(side: "top" | "right" | "bottom" | "left"): string {
  switch (side) {
    case "bottom":
      return "50% 0%";
    case "left":
      return "100% 50%";
    case "right":
      return "0% 50%";
    case "top":
    default:
      return "50% 100%";
  }
}

function originForHover(
  placement: "top" | "bottom",
  align: "start" | "center" | "end",
): string {
  const x = align === "start" ? "0%" : align === "end" ? "100%" : "50%";
  const y = placement === "top" ? "100%" : "0%";
  return `${x} ${y}`;
}

function TooltipProvider(props: { children: JSX.Element }) {
  return <>{props.children}</>;
}

function Tooltip(props: ComponentProps<typeof KTooltip>) {
  return (
    <KTooltip
      openDelay={OPEN_DELAY_MS}
      closeDelay={CLOSE_DELAY_MS}
      skipDelayDuration={SKIP_DELAY_MS}
      {...props}
    />
  );
}

function TooltipTrigger(props: ComponentProps<typeof KTooltip.Trigger>) {
  return <KTooltip.Trigger {...props} />;
}

type TooltipContentProps = ComponentProps<typeof KTooltip.Content> & {
  class?: string;
  side?: "top" | "right" | "bottom" | "left";
  sideOffset?: number;
  /** Optional keybind chip rendered on the trailing side. */
  shortcut?: string;
};

function TooltipContent(props: TooltipContentProps) {
  const [local, others] = splitProps(props, [
    "class",
    "side",
    "sideOffset",
    "shortcut",
    "children",
  ]);
  const placement = () => local.side ?? "top";

  return (
    <KTooltip.Portal>
      <KTooltip.Content
        placement={placement()}
        gutter={local.sideOffset ?? 8}
        class={cn(TOOLTIP_SURFACE, TOOLTIP_KOBALTE_ANIM, local.class)}
        {...others}
        style={{ "transform-origin": originForSide(placement()) }}
      >
        <span class="min-w-0">{local.children}</span>
        <Show when={local.shortcut}>
          {(shortcut) => <kbd class={TOOLTIP_KBD}>{shortcut()}</kbd>}
        </Show>
      </KTooltip.Content>
    </KTooltip.Portal>
  );
}

type TooltipLabelProps = {
  label: JSX.Element | null | undefined;
  /** Optional keybind chip rendered on the trailing side. */
  shortcut?: string;
  children: JSX.Element;
  class?: string;
  side?: "top" | "right" | "bottom" | "left";
  sideOffset?: number;
  disabled?: boolean;
};

function TooltipLabel(props: TooltipLabelProps) {
  const enabled = () =>
    !props.disabled && props.label !== null && props.label !== undefined && props.label !== "";
  const contentProps = () => ({
    ...(props.side !== undefined ? { side: props.side } : {}),
    ...(props.sideOffset !== undefined ? { sideOffset: props.sideOffset } : {}),
    ...(props.shortcut !== undefined ? { shortcut: props.shortcut } : {}),
  });

  return (
    <Show when={enabled()} fallback={props.children}>
      <Tooltip>
        <TooltipTrigger as="span" class={cn("inline-flex min-w-0", props.class)}>
          {props.children}
        </TooltipTrigger>
        <TooltipContent {...contentProps()}>{props.label}</TooltipContent>
      </Tooltip>
    </Show>
  );
}

// ─── data-tooltip hover layer ──────────────────────────────────────────────
//
// Lightweight global tooltip layer driven by `[data-tooltip]` attributes.
// Mount once at the app root (rendered in a portal so it sits above any
// `overflow-hidden` ancestor and is unaffected by transforms on the layout).
//
// Behavior parity with the Kobalte path:
//   - 180ms open delay, 300ms skip-delay window: after a tooltip closes,
//     subsequent tooltips within 300ms open instantly. Matches Linear.
//   - Re-reads the trigger's `data-tooltip` text reactively while shown, so
//     toggle buttons whose label flips (e.g. Mute ↔ Unmute) update in place.
//   - Closes on pointerdown so it doesn't linger over a clicked menu.
//   - Suppressed on touch (`pointerType: "touch"`): tooltips are a hover-only
//     affordance and a tap is already the user committing to the action.
//     Keyboard-focus tooltips still fire so AT/keyboard users aren't cut off.
//   - Respects `prefers-reduced-motion` — the entrance animation collapses
//     to an opacity swap via Tailwind's `motion-reduce:animate-none`.
//
// API surface on the trigger:
//   data-tooltip="Label text"            — required to enable
//   data-tooltip-key="⌘W"                — optional keybind chip
//   data-tooltip-side="top"|"bottom"     — preferred side; flips if it'd clip
//   data-tooltip-disabled                — any non-empty value suppresses it

type HoverTooltipState = {
  label: string;
  shortcut: string | null;
  x: number;
  y: number;
  placement: "top" | "bottom";
  align: "start" | "center" | "end";
};

function tooltipTarget(node: EventTarget | null): HTMLElement | null {
  if (!(node instanceof Element)) return null;
  return node.closest<HTMLElement>("[data-tooltip]");
}

function labelOf(el: HTMLElement): string | null {
  if (el.dataset["tooltipDisabled"] !== undefined && el.dataset["tooltipDisabled"] !== "")
    return null;
  const label = el.dataset["tooltip"]?.trim();
  return label ? label : null;
}

function shortcutOf(el: HTMLElement): string | null {
  const k = el.dataset["tooltipKey"]?.trim();
  return k ? k : null;
}

function placementOf(el: HTMLElement): "top" | "bottom" {
  return el.dataset["tooltipSide"] === "bottom" ? "bottom" : "top";
}

function TooltipHoverLayer() {
  const [state, setState] = createSignal<HoverTooltipState | null>(null);
  let active: HTMLElement | null = null;
  let openTimer: ReturnType<typeof setTimeout> | null = null;
  let lastClosedAt = 0;
  let observer: MutationObserver | null = null;

  const clearOpenTimer = () => {
    if (openTimer === null) return;
    clearTimeout(openTimer);
    openTimer = null;
  };

  const stopObserving = () => {
    if (observer === null) return;
    observer.disconnect();
    observer = null;
  };

  const update = () => {
    if (active === null) return;
    const label = labelOf(active);
    if (label === null) {
      setState(null);
      return;
    }
    const rect = active.getBoundingClientRect();
    let placement = placementOf(active);
    // Flip if the preferred side would clip against the viewport edge.
    if (placement === "top" && rect.top < 36) placement = "bottom";
    if (placement === "bottom" && window.innerHeight - rect.bottom < 36) placement = "top";
    const cx = rect.left + rect.width / 2;
    // align "start" / "end" so the tooltip leans away from the nearest
    // viewport edge for triggers near the corners.
    const align = cx < 140 ? "start" : cx > window.innerWidth - 140 ? "end" : "center";
    setState({
      label,
      shortcut: shortcutOf(active),
      x: Math.min(Math.max(cx, 12), window.innerWidth - 12),
      y: placement === "bottom" ? rect.bottom + 8 : rect.top - 8,
      placement,
      align,
    });
  };

  const watchActive = (el: HTMLElement) => {
    stopObserving();
    observer = new MutationObserver(() => update());
    observer.observe(el, {
      attributes: true,
      attributeFilter: [
        "data-tooltip",
        "data-tooltip-key",
        "data-tooltip-side",
        "data-tooltip-disabled",
      ],
    });
  };

  const show = (el: HTMLElement) => {
    // Cursor moved within the same trigger — do NOT restart the timer or the
    // tooltip would never reach its open delay on continuously-moving cursors.
    if (active === el) return;
    active = el;
    clearOpenTimer();
    const delay = Date.now() - lastClosedAt < SKIP_DELAY_MS ? 0 : OPEN_DELAY_MS;
    openTimer = setTimeout(() => {
      openTimer = null;
      update();
      // Only attach the observer once the tooltip is actually visible — no
      // need to react to attribute mutations during the open delay.
      if (active !== null && state() !== null) watchActive(active);
    }, delay);
  };

  const hide = (el: HTMLElement | null) => {
    if (el !== null && active !== el) return;
    const wasOpen = state() !== null;
    active = null;
    clearOpenTimer();
    stopObserving();
    if (wasOpen) lastClosedAt = Date.now();
    setState(null);
  };

  onMount(() => {
    const onPointerOver = (event: PointerEvent) => {
      // Touch pointer events still fire `pointerover` on tap. Skip them —
      // tooltips are hover-only, and a tap is the user committing to the
      // action they'd otherwise be hovering. Mouse + pen still trigger.
      if (event.pointerType === "touch") return;
      const target = tooltipTarget(event.target);
      if (target === null) {
        if (active !== null) hide(active);
        return;
      }
      show(target);
    };
    const onPointerOut = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      const target = tooltipTarget(event.target);
      if (target === null) return;
      // Ignore moves between children of the same trigger.
      if (event.relatedTarget instanceof Node && target.contains(event.relatedTarget)) return;
      hide(target);
    };
    const onFocusIn = (event: FocusEvent) => {
      const target = tooltipTarget(event.target);
      if (target !== null) show(target);
    };
    const onFocusOut = (event: FocusEvent) => {
      const target = tooltipTarget(event.target);
      if (target !== null) hide(target);
    };
    const onPointerDown = () => hide(active);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") hide(active);
    };
    const onViewportChange = () => update();

    document.addEventListener("pointerover", onPointerOver, true);
    document.addEventListener("pointerout", onPointerOut, true);
    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener("focusout", onFocusOut, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("scroll", onViewportChange, true);
    window.addEventListener("resize", onViewportChange);

    onCleanup(() => {
      clearOpenTimer();
      stopObserving();
      document.removeEventListener("pointerover", onPointerOver, true);
      document.removeEventListener("pointerout", onPointerOut, true);
      document.removeEventListener("focusin", onFocusIn, true);
      document.removeEventListener("focusout", onFocusOut, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("scroll", onViewportChange, true);
      window.removeEventListener("resize", onViewportChange);
    });
  });

  return (
    <Portal>
      <Show when={state()}>
        {(tooltip) => (
          <div
            role="tooltip"
            class={cn("pointer-events-none fixed", TOOLTIP_SURFACE, TOOLTIP_ENTER)}
            style={{
              left: `${String(tooltip().x)}px`,
              top: `${String(tooltip().y)}px`,
              "transform-origin": originForHover(tooltip().placement, tooltip().align),
              transform:
                tooltip().placement === "bottom"
                  ? tooltip().align === "start"
                    ? "translate(0, 0)"
                    : tooltip().align === "end"
                      ? "translate(-100%, 0)"
                      : "translate(-50%, 0)"
                  : tooltip().align === "start"
                    ? "translate(0, -100%)"
                    : tooltip().align === "end"
                      ? "translate(-100%, -100%)"
                      : "translate(-50%, -100%)",
            }}
          >
            <span class="min-w-0">{tooltip().label}</span>
            <Show when={tooltip().shortcut}>
              {(shortcut) => <kbd class={TOOLTIP_KBD}>{shortcut()}</kbd>}
            </Show>
          </div>
        )}
      </Show>
    </Portal>
  );
}

export {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipHoverLayer,
  TooltipLabel,
  TooltipProvider,
};
