import { Image } from "@kobalte/core/image";
import { MicOff } from "lucide-solid";
import {
  type ComponentProps,
  type JSX,
  Show,
  splitProps,
  createMemo,
} from "solid-js";
import { getClientColor, getNameInitial } from "@uncorded/shared";
import { safeAvatarUrl } from "@/components/ui/avatar-stack-helpers";
import { cn } from "@/lib/utils";

export type AvatarStatus = "speaking" | "in-call" | "muted" | "idle";

const STATUS_RING: Record<AvatarStatus, string> = {
  // Match the convention from voice-indicator.tsx so the speaking pulse looks
  // identical wherever it appears (sidebar, popovers, embedded rosters).
  speaking: "ring-2 ring-primary/70 ring-offset-1 ring-offset-sidebar",
  "in-call": "ring-1 ring-primary/40",
  muted: "",
  idle: "",
};

type AvatarRootProps = ComponentProps<typeof Image> & {
  class?: string;
  /**
   * Stable client id. When set, the component auto-renders the Image+Fallback
   * structure: `src` is filtered through `safeAvatarUrl` and a colored disk
   * with the first grapheme of `name` is rendered when no usable URL exists.
   * Pass children-based composition instead if you need custom slots.
   */
  userId?: string;
  /** Display name — first grapheme becomes the initial. Pairs with `userId`. */
  name?: string;
  /** Optional avatar URL — only `http(s)://` is accepted. Pairs with `userId`. */
  src?: string | null;
  /** Optional presence decoration. Defaults to none. */
  status?: AvatarStatus;
};

function Avatar(props: AvatarRootProps): JSX.Element {
  const [local, others] = splitProps(props, [
    "class",
    "userId",
    "name",
    "src",
    "status",
    "children",
  ]);

  const status = () => local.status ?? "idle";
  const auto = () => typeof local.userId === "string";

  const safeUrl = createMemo(() => safeAvatarUrl(local.src));
  const color = createMemo(() =>
    local.userId ? getClientColor(local.userId) : null,
  );
  const initial = createMemo(() => getNameInitial(local.name));

  return (
    <Image
      class={cn(
        "relative flex size-8 shrink-0 rounded-full",
        // Auto mode handles its own clipping via the inner wrapper, so the
        // root can let presence overlays (mute pip, etc.) escape. Children
        // mode keeps the original overflow-hidden contract.
        auto() ? "overflow-visible" : "overflow-hidden",
        STATUS_RING[status()],
        local.class,
      )}
      {...others}
    >
      <Show
        when={auto()}
        fallback={local.children as JSX.Element}
      >
        <div class="relative size-full overflow-hidden rounded-full">
          <Show when={safeUrl() !== null}>
            <Image.Img
              src={safeUrl()!}
              alt={local.name ?? local.userId ?? ""}
              class="aspect-square size-full object-cover"
              loading="lazy"
              decoding="async"
            />
          </Show>
          <Image.Fallback
            class="flex size-full items-center justify-center rounded-full font-medium"
            style={
              color()
                ? {
                    "background-color": color()!.background,
                    color: color()!.foreground,
                  }
                : {}
            }
          >
            {initial()}
          </Image.Fallback>
        </div>
      </Show>
      <Show when={auto() && status() === "muted"}>
        <span
          class="absolute -bottom-0.5 -right-0.5 flex size-4 items-center justify-center rounded-full bg-background text-foreground ring-1 ring-border"
          aria-label="muted"
        >
          <MicOff class="size-2.5" />
        </span>
      </Show>
    </Image>
  );
}

type AvatarImageProps = ComponentProps<typeof Image.Img> & { class?: string };

function AvatarImage(props: AvatarImageProps) {
  const [local, others] = splitProps(props, ["class"]);
  return (
    <Image.Img
      class={cn("aspect-square size-full", local.class)}
      {...others}
    />
  );
}

type AvatarFallbackProps = ComponentProps<typeof Image.Fallback> & {
  class?: string;
  children?: JSX.Element;
};

function AvatarFallback(props: AvatarFallbackProps) {
  const [local, others] = splitProps(props, ["class"]);
  return (
    <Image.Fallback
      class={cn("flex size-full items-center justify-center rounded-full bg-muted", local.class)}
      {...others}
    />
  );
}

export { Avatar, AvatarImage, AvatarFallback };
