import { Dialog as KobalteDialog } from "@kobalte/core/dialog";
import { type ComponentProps, type JSX, splitProps } from "solid-js";
import { X } from "lucide-solid";
import { cn } from "@/lib/utils";
import { CoViewModalMount } from "@/co-view/primitives";

const Dialog = KobalteDialog;
const DialogTrigger = KobalteDialog.Trigger;

function DialogClose(props: ComponentProps<typeof KobalteDialog.CloseButton>) {
  const [local, others] = splitProps(props, ["class", "children"]);
  return (
    <KobalteDialog.CloseButton
      class={cn(
        "absolute right-4 top-4 flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus:outline-none disabled:pointer-events-none",
        local.class,
      )}
      {...others}
    >
      {local.children ?? <X class="size-3.5" />}
    </KobalteDialog.CloseButton>
  );
}

type DialogContentProps = ComponentProps<typeof KobalteDialog.Content> & {
  class?: string;
  children?: JSX.Element;
  /** Optional Co-View modal title override; falls back to aria-labelledby. */
  coViewTitle?: string;
};

function DialogContent(props: DialogContentProps) {
  const [local, others] = splitProps(props, ["class", "children", "coViewTitle"]);
  let contentEl: HTMLElement | null = null;
  return (
    <KobalteDialog.Portal>
      <KobalteDialog.Overlay class="fixed inset-0 z-50 bg-black/60 data-[expanded]:animate-in data-[expanded]:fade-in-0 data-[closed]:animate-out data-[closed]:fade-out-0" />
      <KobalteDialog.Content
        ref={(el) => (contentEl = el)}
        class={cn(
          "fixed left-1/2 top-1/2 z-50 w-full -translate-x-1/2 -translate-y-1/2",
          "max-h-[90vh] overflow-y-auto rounded-xl border border-border bg-background shadow-xl",
          "data-[expanded]:animate-in data-[expanded]:fade-in-0 data-[expanded]:zoom-in-95",
          "data-[closed]:animate-out data-[closed]:fade-out-0 data-[closed]:zoom-out-95",
          local.class,
        )}
        {...others}
      >
        <CoViewModalMount
          getEl={() => contentEl}
          title={() => local.coViewTitle}
        />
        {local.children}
      </KobalteDialog.Content>
    </KobalteDialog.Portal>
  );
}

function DialogHeader(props: ComponentProps<"div">) {
  const [local, others] = splitProps(props, ["class"]);
  return (
    <div class={cn("flex flex-col gap-1.5", local.class)} {...others} />
  );
}

function DialogTitle(props: ComponentProps<typeof KobalteDialog.Title>) {
  const [local, others] = splitProps(props, ["class"]);
  return (
    <KobalteDialog.Title
      class={cn("text-lg font-semibold leading-none tracking-tight", local.class)}
      {...others}
    />
  );
}

function DialogDescription(props: ComponentProps<typeof KobalteDialog.Description>) {
  const [local, others] = splitProps(props, ["class"]);
  return (
    <KobalteDialog.Description
      class={cn("text-sm text-muted-foreground", local.class)}
      {...others}
    />
  );
}

export { Dialog, DialogTrigger, DialogClose, DialogContent, DialogHeader, DialogTitle, DialogDescription };
