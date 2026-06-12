import { For, Show, createEffect, createSignal, on } from "solid-js";
import {
  ClipboardCopy,
  FolderOpen,
  Play,
  Plus,
  Puzzle,
  Trash2,
  X,
} from "lucide-solid";
import type { DevPlugin } from "@uncorded/electron-bridge";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { isElectron } from "@/lib/electron";
import {
  agentDetection,
  copyDevPluginPrompt,
  detectAgent,
  devPlugins,
  launchDevPluginAgent,
  loadDevPlugins,
  openDevPluginFolder,
  removeDevPlugin,
} from "@/stores/plugin-dev";
import { NewPluginDialog } from "./new-plugin-dialog";
import { InstallPluginDialog } from "./install-plugin-dialog";

// Plugin Development Workspace sheet — the management surface for dev plugin
// folders under ~/.uncorded/plugin-dev/. Machine-global (not per-server),
// desktop-only; the sidebar only offers the entry point under isElectron().
// Explicitly NOT an IDE: list, create, hand off to an agent, deploy. The
// folder on disk is the source of truth — every open re-scans.

function manifestBadge(plugin: DevPlugin) {
  switch (plugin.manifestStatus) {
    case "ok":
      return null;
    case "invalid":
      return (
        <span class="rounded bg-destructive/15 px-1.5 py-0.5 text-[10px] font-medium text-destructive">
          manifest invalid
        </span>
      );
    case "missing":
      return (
        <span class="rounded bg-destructive/15 px-1.5 py-0.5 text-[10px] font-medium text-destructive">
          manifest missing
        </span>
      );
  }
}

function DevPluginRow(props: { plugin: DevPlugin; onInstall: (plugin: DevPlugin) => void }) {
  const [confirmingDelete, setConfirmingDelete] = createSignal(false);
  const [busy, setBusy] = createSignal(false);

  const run = async (action: () => Promise<unknown>) => {
    if (busy()) return;
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };

  const iconButton =
    "flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-50";

  return (
    <div class="rounded-lg border border-border px-3 py-2.5">
      <div class="flex items-center gap-2">
        <div class="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
          <Puzzle class="size-4" />
        </div>
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2">
            <p class="truncate text-sm font-medium text-foreground">{props.plugin.displayName}</p>
            {manifestBadge(props.plugin)}
          </div>
          <p class="truncate font-mono text-[11px] text-muted-foreground/70">{props.plugin.slug}</p>
        </div>
      </div>
      <Show when={props.plugin.description}>
        <p class="mt-1.5 line-clamp-2 text-xs text-muted-foreground">{props.plugin.description}</p>
      </Show>

      <div class="mt-2 flex items-center gap-1">
        <button
          type="button"
          class={iconButton}
          data-tooltip="Copy agent prompt"
          disabled={busy()}
          onClick={() => void run(() => copyDevPluginPrompt(props.plugin.slug))}
        >
          <ClipboardCopy class="size-3.5" />
        </button>
        <Show when={agentDetection().found}>
          <button
            type="button"
            class={iconButton}
            data-tooltip="Start agent"
            disabled={busy()}
            onClick={() => void run(() => launchDevPluginAgent(props.plugin.slug))}
          >
            <Play class="size-3.5" />
          </button>
        </Show>
        <button
          type="button"
          class={iconButton}
          data-tooltip="Open folder"
          disabled={busy()}
          onClick={() => void run(() => openDevPluginFolder(props.plugin.slug))}
        >
          <FolderOpen class="size-3.5" />
        </button>

        <button
          type="button"
          class="ml-1 inline-flex h-7 items-center gap-1 rounded-md border border-border px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
          disabled={busy() || props.plugin.manifestStatus !== "ok"}
          data-tooltip={
            props.plugin.manifestStatus !== "ok"
              ? "Fix manifest.json first"
              : "Copy into a server and restart it"
          }
          onClick={() => props.onInstall(props.plugin)}
        >
          Install into server
        </button>

        <div class="ml-auto">
          <Show
            when={confirmingDelete()}
            fallback={
              <button
                type="button"
                class={iconButton}
                data-tooltip="Delete (moves to Recycle Bin)"
                disabled={busy()}
                onClick={() => setConfirmingDelete(true)}
              >
                <Trash2 class="size-3.5" />
              </button>
            }
          >
            <div class="flex items-center gap-1">
              <button
                type="button"
                class="rounded-md bg-destructive px-2 py-1 text-xs font-medium text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
                disabled={busy()}
                onClick={() =>
                  void run(async () => {
                    await removeDevPlugin(props.plugin.slug);
                    setConfirmingDelete(false);
                  })
                }
              >
                Move to Recycle Bin
              </button>
              <button
                type="button"
                class="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent"
                onClick={() => setConfirmingDelete(false)}
              >
                Keep
              </button>
            </div>
          </Show>
        </div>
      </div>
    </div>
  );
}

export function PluginDevSheet(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [newPluginOpen, setNewPluginOpen] = createSignal(false);
  const [installTarget, setInstallTarget] = createSignal<DevPlugin | null>(null);

  // Re-scan + re-probe on every open: the disk is the source of truth and an
  // agent may have renamed/added folders since the last look.
  createEffect(
    on(
      () => props.open,
      (isOpen) => {
        if (!isOpen) return;
        void loadDevPlugins();
        void detectAgent();
      },
    ),
  );

  if (!isElectron()) return null;

  return (
    <>
      <Sheet open={props.open} onOpenChange={props.onOpenChange}>
        <SheetContent side="right" class="flex w-full flex-col gap-0 p-0 sm:max-w-md">
          <SheetHeader class="flex flex-row items-center justify-between gap-0 border-b border-border px-4 py-3">
            <SheetTitle class="text-sm font-semibold">Plugin Dev</SheetTitle>
            <SheetClose class="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground">
              <X class="size-3.5" />
            </SheetClose>
          </SheetHeader>

          <div class="flex items-center justify-between border-b border-border px-4 py-3">
            <p class="text-xs text-muted-foreground">
              Plugins here live on this machine and survive server deletion.
            </p>
            <Button size="sm" onClick={() => setNewPluginOpen(true)}>
              <Plus class="size-4" />
              New plugin
            </Button>
          </div>

          <div class="flex-1 overflow-y-auto px-4 py-3">
            <Show
              when={devPlugins().length > 0}
              fallback={
                <div class="flex flex-col items-center gap-2 px-4 py-10 text-center">
                  <Puzzle class="size-8 text-muted-foreground/40" />
                  <p class="text-sm font-medium text-foreground">No plugins yet</p>
                  <p class="max-w-[28ch] text-xs text-muted-foreground">
                    Describe a plugin and UnCorded scaffolds it with a
                    ready-to-go prompt for your coding agent.
                  </p>
                  <Button size="sm" class="mt-1" onClick={() => setNewPluginOpen(true)}>
                    <Plus class="size-4" />
                    New plugin
                  </Button>
                </div>
              }
            >
              <div class="flex flex-col gap-2">
                <For each={devPlugins()}>
                  {(plugin) => <DevPluginRow plugin={plugin} onInstall={setInstallTarget} />}
                </For>
              </div>
            </Show>
          </div>

          <div class="border-t border-border px-4 py-2.5">
            <p class="text-[11px] text-muted-foreground/60">
              Folders live in <span class="font-mono">~/.uncorded/plugin-dev</span>.
              Deleting moves to the Recycle Bin.
            </p>
          </div>
        </SheetContent>
      </Sheet>

      <NewPluginDialog open={newPluginOpen()} onOpenChange={setNewPluginOpen} />
      <InstallPluginDialog
        plugin={installTarget()}
        onOpenChange={(open) => {
          if (!open) setInstallTarget(null);
        }}
      />
    </>
  );
}
