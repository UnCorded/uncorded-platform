import { type ComponentProps, splitProps } from "solid-js";
import { cn } from "@/lib/utils";

function Skeleton(props: ComponentProps<"div">) {
  const [local, others] = splitProps(props, ["class"]);
  return (
    <div
      class={cn("animate-pulse rounded-md bg-accent", local.class)}
      {...others}
    />
  );
}

export { Skeleton };
