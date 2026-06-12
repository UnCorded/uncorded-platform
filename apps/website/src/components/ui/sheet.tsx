import { Dialog } from "@kobalte/core/dialog";
import { type ComponentProps, type JSX, splitProps } from "solid-js";
import { cn } from "@/lib/utils";
import { CoViewModalMount } from "@/co-view/primitives";
import { SuspendSurfacesWhileOpen } from "@/components/ui/surface-blocker";

const Sheet = Dialog;
const SheetTrigger = Dialog.Trigger;
const SheetClose = Dialog.CloseButton;

type SheetContentProps = ComponentProps<typeof Dialog.Content> & {
  side?: "top" | "right" | "bottom" | "left";
  class?: string;
  children?: JSX.Element;
  /** Optional Co-View modal title override; falls back to aria-labelledby. */
  coViewTitle?: string;
};

const sideVariants: Record<string, string> = {
  top: "inset-x-0 top-0 border-b data-[expanded]:slide-in-from-top-full data-[closed]:slide-out-to-top-full",
  bottom: "inset-x-0 bottom-0 border-t data-[expanded]:slide-in-from-bottom-full data-[closed]:slide-out-to-bottom-full",
  left: "inset-y-0 left-0 h-full w-3/4 border-r data-[expanded]:slide-in-from-left-full data-[closed]:slide-out-to-left-full sm:max-w-sm",
  right: "inset-y-0 right-0 h-full w-3/4 border-l data-[expanded]:slide-in-from-right-full data-[closed]:slide-out-to-right-full sm:max-w-sm",
};

function SheetContent(props: SheetContentProps) {
  const [local, others] = splitProps(props, ["class", "side", "children", "coViewTitle"]);
  const side = () => local.side ?? "right";
  let contentEl: HTMLElement | null = null;
  return (
    <Dialog.Portal>
      <Dialog.Overlay class="fixed inset-0 z-50 bg-black/80 data-[expanded]:animate-in data-[expanded]:fade-in-0 data-[closed]:animate-out data-[closed]:fade-out-0" />
      <Dialog.Content
        ref={(el) => (contentEl = el)}
        class={cn(
          "fixed z-50 flex flex-col gap-4 bg-background p-6 shadow-lg transition ease-in-out",
          "data-[expanded]:animate-in data-[closed]:animate-out data-[closed]:duration-300 data-[expanded]:duration-500",
          sideVariants[side()],
          local.class
        )}
        {...others}
      >
        {/* Suspend native panel views for the sheet's OPEN lifetime only. Must
            be a Content child — this wrapper's body runs eagerly when the Sheet
            root mounts (even closed), so a blocker pushed there pins suspension
            for every always-mounted <Sheet>. See dialog.tsx / surface-blocker.tsx. */}
        <SuspendSurfacesWhileOpen />
        <CoViewModalMount
          getEl={() => contentEl}
          title={() => local.coViewTitle}
        />
        {local.children}
      </Dialog.Content>
    </Dialog.Portal>
  );
}

function SheetHeader(props: ComponentProps<"div">) {
  const [local, others] = splitProps(props, ["class"]);
  return <div class={cn("flex flex-col gap-1.5", local.class)} {...others} />;
}

function SheetFooter(props: ComponentProps<"div">) {
  const [local, others] = splitProps(props, ["class"]);
  return (
    <div class={cn("flex flex-col gap-2 sm:flex-row sm:justify-end", local.class)} {...others} />
  );
}

function SheetTitle(props: ComponentProps<typeof Dialog.Title>) {
  const [local, others] = splitProps(props, ["class"]);
  return (
    <Dialog.Title class={cn("text-lg font-semibold text-foreground", local.class)} {...others} />
  );
}

function SheetDescription(props: ComponentProps<typeof Dialog.Description>) {
  const [local, others] = splitProps(props, ["class"]);
  return (
    <Dialog.Description
      class={cn("text-sm text-muted-foreground", local.class)}
      {...others}
    />
  );
}

export { Sheet, SheetTrigger, SheetClose, SheetContent, SheetHeader, SheetFooter, SheetTitle, SheetDescription };
