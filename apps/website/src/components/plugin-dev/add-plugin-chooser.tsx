import { Show } from "solid-js";
import { ChevronRight, Hammer, Store } from "lucide-solid";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { isElectron } from "@/lib/electron";

// The "Add Plugin" chooser — the overlay behind the Plugins panel's Add
// Plugin button. Two paths: Develop (the local Plugin Dev workspace,
// desktop-only) and Browse (the marketplace, not shipped yet). This is the
// ONLY entry point to Plugin Dev — it deliberately does not live in the
// sidebar.

export function AddPluginChooser(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDevelop: () => void;
}) {
  const desktop = isElectron();

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      {/* p-5: DialogContent has no default padding (repo convention is
          consumer-owned, see avatar-crop-dialog). */}
      <DialogContent class="sm:max-w-md p-5">
        <DialogHeader>
          <DialogTitle>Add a plugin</DialogTitle>
          <DialogDescription>
            Build one yourself, or install one from the marketplace.
          </DialogDescription>
        </DialogHeader>

        <div class="mt-4 flex flex-col gap-2">
          <button
            type="button"
            disabled={!desktop}
            data-tooltip={desktop ? undefined : "Plugin development requires the desktop app"}
            class="flex items-center gap-3 rounded-lg border border-border px-3 py-3 text-left transition-colors hover:bg-accent/50 disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => {
              props.onOpenChange(false);
              props.onDevelop();
            }}
          >
            <div class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
              <Hammer class="size-4" />
            </div>
            <div class="min-w-0 flex-1">
              <p class="text-sm font-medium text-foreground">Develop</p>
              <p class="text-xs text-muted-foreground">
                Describe a plugin, get a working scaffold, and hand it to your
                coding agent. Your work lives on this machine and survives
                server deletion.
              </p>
            </div>
            <Show when={desktop}>
              <ChevronRight class="size-4 shrink-0 text-muted-foreground" />
            </Show>
          </button>

          <button
            type="button"
            aria-disabled="true"
            data-tooltip="Plugin marketplace coming in a later update"
            class="flex cursor-not-allowed items-center gap-3 rounded-lg border border-border px-3 py-3 text-left opacity-60 transition-colors hover:bg-accent/30"
          >
            <div class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
              <Store class="size-4" />
            </div>
            <div class="min-w-0 flex-1">
              <p class="text-sm font-medium text-foreground">Browse</p>
              <p class="text-xs text-muted-foreground">
                Install community and verified plugins from the marketplace.
              </p>
            </div>
            <span class="shrink-0 text-[10px] uppercase tracking-wider text-muted-foreground/60">
              Soon
            </span>
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
