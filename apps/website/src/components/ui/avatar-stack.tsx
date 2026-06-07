import { For, Show, createMemo, type JSX } from "solid-js";
import { getClientColor, getNameInitial } from "@uncorded/shared";
import { TooltipLabel } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { buildOverflowLabel, safeAvatarUrl } from "./avatar-stack-helpers";

export { buildOverflowLabel, safeAvatarUrl };

export interface AvatarStackItem {
  /** Stable id — drives the deterministic color when no `src` is set. */
  id: string;
  /** Display name; first grapheme becomes the initial. */
  name?: string;
  /** Optional avatar URL. Falls back to colored disk + initial when absent. */
  src?: string | null;
  /** Optional click handler — wired onto each visible avatar. */
  onClick?: ((ev: MouseEvent) => void) | undefined;
}

export type AvatarStackSize = "xs" | "sm" | "md";

export interface AvatarStackProps {
  items: AvatarStackItem[];
  /** Maximum visible avatars before the overflow badge appears. Default 4. */
  max?: number;
  size?: AvatarStackSize;
  /** Wrapper class — append layout/padding here. */
  class?: string;
  /**
   * Outer ring color, applied to each avatar so they stack cleanly against the
   * surrounding surface. Defaults to `ring-sidebar`. Pass another token if the
   * stack is rendered against a different background.
   */
  ringClass?: string;
}

const SIZE_CLASS: Record<AvatarStackSize, string> = {
  xs: "size-5 text-[9px]",
  sm: "size-6 text-[10px]",
  md: "size-8 text-xs",
};

/**
 * Stacked-avatars primitive — extracted from `nav-sidebar-sections.tsx`'s
 * `ParticipantStack`. Renders up to `max` avatars in an overlapping row; any
 * surplus is summarised in a `+N` badge with a tooltip listing the remaining
 * names.
 */
export function AvatarStack(props: AvatarStackProps): JSX.Element {
  const max = () => props.max ?? 4;
  const size = () => props.size ?? "sm";
  const ring = () => props.ringClass ?? "ring-sidebar";

  const visible = createMemo(() => props.items.slice(0, max()));
  const hidden = createMemo(() => props.items.slice(max()));
  const overflow = createMemo(() => hidden().length);

  const overflowLabel = createMemo(() =>
    buildOverflowLabel(hidden(), overflow()),
  );

  return (
    <div class={cn("flex items-center", props.class)}>
      <div class="flex -space-x-2">
        <For each={visible()}>
          {(item) => (
            <AvatarStackItemView item={item} size={size()} ringClass={ring()} />
          )}
        </For>
        <Show when={overflow() > 0}>
          <TooltipLabel label={overflowLabel()} side="top">
            <div
              class={cn(
                "relative shrink-0 overflow-hidden rounded-full ring-2",
                "bg-muted text-muted-foreground flex items-center justify-center font-medium",
                SIZE_CLASS[size()],
                ring(),
              )}
              aria-label={`${String(overflow())} more`}
            >
              +{overflow()}
            </div>
          </TooltipLabel>
        </Show>
      </div>
    </div>
  );
}

function AvatarStackItemView(props: {
  item: AvatarStackItem;
  size: AvatarStackSize;
  ringClass: string;
}): JSX.Element {
  const safeUrl = createMemo(() => safeAvatarUrl(props.item.src));
  const color = createMemo(() => getClientColor(props.item.id));
  const initial = createMemo(() => getNameInitial(props.item.name));
  const label = () => props.item.name ?? props.item.id;

  return (
    <TooltipLabel label={label()} side="top">
      <button
        type="button"
        class={cn(
          "relative shrink-0 overflow-hidden rounded-full ring-2 transition-shadow",
          "flex items-center justify-center font-medium cursor-pointer",
          "hover:ring-sidebar-primary/40",
          SIZE_CLASS[props.size],
          props.ringClass,
        )}
        style={
          safeUrl() === null
            ? {
                "background-color": color().background,
                color: color().foreground,
              }
            : {}
        }
        onClick={props.item.onClick}
      >
        <Show
          when={safeUrl() !== null}
          fallback={<span>{initial()}</span>}
        >
          <img
            src={safeUrl()!}
            alt={label()}
            class="size-full object-cover"
            loading="lazy"
            decoding="async"
          />
        </Show>
      </button>
    </TooltipLabel>
  );
}

