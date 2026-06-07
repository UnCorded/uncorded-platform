import { type ComponentProps, splitProps } from "solid-js";
import { cn } from "@/lib/utils";

type SeparatorProps = ComponentProps<"div"> & {
  orientation?: "horizontal" | "vertical";
  decorative?: boolean;
};

function Separator(props: SeparatorProps) {
  const [local, others] = splitProps(props, ["class", "orientation", "decorative"]);
  const orientation = () => local.orientation ?? "horizontal";
  return (
    <div
      role={local.decorative !== false ? "none" : "separator"}
      aria-orientation={local.decorative !== false ? undefined : orientation()}
      data-orientation={orientation()}
      class={cn(
        "shrink-0 bg-border",
        orientation() === "vertical" ? "h-full w-px" : "h-px w-full",
        local.class
      )}
      {...others}
    />
  );
}

export { Separator };
