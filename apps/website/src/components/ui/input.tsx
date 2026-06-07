import { type ComponentProps, splitProps } from "solid-js";
import { cn } from "@/lib/utils";
import { useCoViewInput } from "@/co-view/primitives";

type InputProps = ComponentProps<"input"> & {
  /**
   * Spec-27 §Privacy & Redaction: opt in to broadcasting raw value to Co-View
   * viewers. Default false (caret + valueRedacted shadow only). Set true on
   * inputs where the host actually wants viewers to see what's being typed
   * (e.g. the compose box in text-channels).
   */
  coViewShareValue?: boolean;
  coViewId?: string;
};

function Input(props: InputProps) {
  const [local, others] = splitProps(props, ["class", "coViewShareValue", "coViewId"]);
  let inputEl: HTMLInputElement | null = null;
  const inputProps: Parameters<typeof useCoViewInput>[0] = {
    getEl: () => inputEl,
    shareValue: () => local.coViewShareValue ?? false,
  };
  if (local.coViewId !== undefined) inputProps.idOverride = local.coViewId;
  useCoViewInput(inputProps);
  return (
    <input
      ref={(el) => (inputEl = el)}
      class={cn(
        "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:border-ring disabled:cursor-not-allowed disabled:opacity-50",
        local.class
      )}
      {...others}
    />
  );
}

export { Input };
export type { InputProps };
