import { For, Show, createEffect, createSignal, on, onCleanup } from "solid-js";
import { Check, Loader2, RefreshCw, ServerCog, TriangleAlert } from "lucide-solid";
import type {
  DevPlugin,
  DevPluginDeployProgress,
  DevPluginInstallTarget,
} from "@uncorded/electron-bridge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { servers } from "@/stores/servers";
import {
  installDevPluginIntoServer,
  listInstallTargets,
  onDevPluginDeployProgress,
  uninstallDevPluginFromServer,
} from "@/stores/plugin-dev";

// Install-into-server dialog: pick a locally-hosted server, consent to
// unsigned local plugins when the server hasn't opted in yet, watch the
// step stream, land on a result. The deploy restarts the server — the copy
// says so up front instead of surprising connected users.

interface ResultView {
  ok: boolean;
  heading: string;
  detail: string;
}

type Phase =
  | { kind: "pick" }
  | { kind: "running" }
  | { kind: "result"; view: ResultView };

function humanizeCode(code: string): string {
  return code.replaceAll("_", " ").toLowerCase();
}

export function InstallPluginDialog(props: {
  plugin: DevPlugin | null;
  onOpenChange: (open: boolean) => void;
}) {
  const [targets, setTargets] = createSignal<DevPluginInstallTarget[] | null>(null);
  const [selectedId, setSelectedId] = createSignal<string | null>(null);
  const [consent, setConsent] = createSignal(false);
  const [overwrite, setOverwrite] = createSignal(false);
  const [phase, setPhase] = createSignal<Phase>({ kind: "pick" });
  const [steps, setSteps] = createSignal<DevPluginDeployProgress[]>([]);
  const [uninstallBusy, setUninstallBusy] = createSignal(false);

  const open = () => props.plugin !== null;
  const slug = () => props.plugin?.slug ?? "";

  createEffect(
    on(
      () => props.plugin,
      (plugin) => {
        setTargets(null);
        setSelectedId(null);
        setConsent(false);
        setOverwrite(false);
        setPhase({ kind: "pick" });
        setSteps([]);
        if (plugin === null) return;
        void listInstallTargets(plugin.slug).then((list) => {
          setTargets(list);
          if (list.length === 1) setSelectedId(list[0]!.serverId);
        });
      },
    ),
  );

  // Step stream — filtered to this dialog's deploy.
  const unsubscribe = onDevPluginDeployProgress((event) => {
    if (event.slug !== slug() || event.serverId !== selectedId()) return;
    setSteps((list) => {
      const next = list.filter((s) => s.step !== event.step);
      return [...next, event];
    });
  });
  onCleanup(unsubscribe);

  const serverName = (serverId: string) =>
    servers().find((s) => s.id === serverId)?.name ?? serverId;

  const selectedTarget = () => targets()?.find((t) => t.serverId === selectedId()) ?? null;
  const needsConsent = () => selectedTarget() !== null && !selectedTarget()!.allowUnsigned;

  const canInstall = () =>
    phase().kind === "pick" && selectedTarget() !== null && (!needsConsent() || consent());

  const install = async () => {
    const target = selectedTarget();
    if (target === null) return;
    setSteps([]);
    setPhase({ kind: "running" });
    const result = await installDevPluginIntoServer(slug(), target.serverId, {
      ...(consent() ? { consentUnsigned: true } : {}),
      ...(overwrite() ? { overwriteExisting: true } : {}),
    });
    if (result.ok) {
      setPhase({
        kind: "result",
        view: {
          ok: true,
          heading: "Installed",
          detail:
            result.pluginStatus === "unknown"
              ? "Couldn't confirm plugin status (Central unreachable) — check the server's plugin panel."
              : `The plugin is ${result.pluginStatus}.`,
        },
      });
      return;
    }
    if (result.code === "SLUG_CONFLICT_EXISTING") {
      // Surface the overwrite choice in place rather than burying it in an
      // error: flip the checkbox on and let the user re-run deliberately.
      setOverwrite(true);
    }
    setPhase({
      kind: "result",
      view: { ok: false, heading: humanizeCode(result.code), detail: result.message },
    });
  };

  const uninstall = async (serverId: string) => {
    if (uninstallBusy()) return;
    setUninstallBusy(true);
    const result = await uninstallDevPluginFromServer(slug(), serverId, false);
    setUninstallBusy(false);
    if (result.ok) {
      // Stay in the picker; the row's "installed" badge drops on refresh.
      setTargets(await listInstallTargets(slug()));
    } else {
      setPhase({
        kind: "result",
        view: { ok: false, heading: humanizeCode(result.code), detail: result.message },
      });
    }
  };

  return (
    <Dialog open={open()} onOpenChange={props.onOpenChange}>
      <DialogContent class="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Install "{props.plugin?.displayName ?? ""}" into a server</DialogTitle>
          <DialogDescription>
            Copies the plugin into the server and restarts it — connected users
            will be briefly disconnected. The dev folder stays the source of truth.
          </DialogDescription>
        </DialogHeader>

        <Show when={phase().kind === "pick"}>
          <Show
            when={targets() !== null}
            fallback={
              <div class="flex items-center gap-2 py-4 text-sm text-muted-foreground">
                <Loader2 class="size-4 animate-spin" /> Finding your servers…
              </div>
            }
          >
            <Show
              when={(targets() ?? []).length > 0}
              fallback={
                <p class="py-3 text-sm text-muted-foreground">
                  No servers are hosted on this machine. Create one first — the
                  plugin can be installed the moment it exists.
                </p>
              }
            >
              <div class="flex flex-col gap-1.5">
                <For each={targets()}>
                  {(target) => (
                    <label
                      class="flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 transition-colors"
                      classList={{
                        "border-primary bg-accent/40": selectedId() === target.serverId,
                        "border-border hover:bg-accent/20": selectedId() !== target.serverId,
                      }}
                    >
                      <input
                        type="radio"
                        name="plugin-dev-target"
                        class="accent-primary"
                        checked={selectedId() === target.serverId}
                        onChange={() => setSelectedId(target.serverId)}
                      />
                      <ServerCog class="size-4 shrink-0 text-muted-foreground" />
                      <span class="min-w-0 flex-1 truncate text-sm text-foreground">
                        {serverName(target.serverId)}
                      </span>
                      <Show when={target.deployed}>
                        <span class="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                          installed
                        </span>
                      </Show>
                      <Show when={target.deployed}>
                        <button
                          type="button"
                          class="text-[11px] text-muted-foreground underline-offset-2 hover:underline disabled:opacity-50"
                          disabled={uninstallBusy()}
                          onClick={(e) => {
                            e.preventDefault();
                            setSelectedId(target.serverId);
                            void uninstall(target.serverId);
                          }}
                        >
                          uninstall
                        </button>
                      </Show>
                    </label>
                  )}
                </For>
              </div>

              <Show when={needsConsent()}>
                <label class="mt-1 flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-xs">
                  <input
                    type="checkbox"
                    class="mt-0.5 accent-primary"
                    checked={consent()}
                    onChange={(e) => setConsent(e.currentTarget.checked)}
                  />
                  <span class="text-muted-foreground">
                    <span class="font-medium text-foreground">
                      Allow unsigned local plugins on {serverName(selectedId() ?? "")}.
                    </span>{" "}
                    This plugin was built on your machine, not reviewed by the
                    marketplace. Signed-only is the future default; this server
                    will keep accepting local plugins until you change it in
                    server.json.
                  </span>
                </label>
              </Show>

              <Show when={overwrite()}>
                <label class="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-xs">
                  <input
                    type="checkbox"
                    class="mt-0.5 accent-primary"
                    checked={overwrite()}
                    onChange={(e) => setOverwrite(e.currentTarget.checked)}
                  />
                  <span class="text-muted-foreground">
                    Replace the existing <span class="font-mono">{slug()}</span> folder
                    on the server (it wasn't installed by this flow).
                  </span>
                </label>
              </Show>

              <div class="flex justify-end gap-2 pt-1">
                <Button type="button" variant="ghost" onClick={() => props.onOpenChange(false)}>
                  Cancel
                </Button>
                <Button type="button" disabled={!canInstall()} onClick={() => void install()}>
                  {selectedTarget()?.deployed ? "Reinstall" : "Install"}
                </Button>
              </div>
            </Show>
          </Show>
        </Show>

        <Show when={phase().kind === "running"}>
          <div class="flex flex-col gap-1.5 py-2">
            <For each={steps()}>
              {(step) => (
                <div class="flex items-center gap-2 text-sm">
                  <Show
                    when={step.status === "running"}
                    fallback={
                      <Show
                        when={step.status === "completed"}
                        fallback={<TriangleAlert class="size-3.5 shrink-0 text-amber-500" />}
                      >
                        <Check class="size-3.5 shrink-0 text-green-500" />
                      </Show>
                    }
                  >
                    <Loader2 class="size-3.5 shrink-0 animate-spin text-muted-foreground" />
                  </Show>
                  <span
                    classList={{
                      "text-foreground": step.status === "running",
                      "text-muted-foreground": step.status !== "running",
                    }}
                  >
                    {step.message}
                  </span>
                </div>
              )}
            </For>
          </div>
        </Show>

        <Show when={phase().kind === "result" ? (phase() as Extract<Phase, { kind: "result" }>).view : null}>
          {(view) => (
            <>
              <Show
                when={view().ok}
                fallback={
                  <div class="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-sm">
                    <p class="font-medium text-destructive">{view().heading}</p>
                    <p class="mt-0.5 text-xs text-muted-foreground">{view().detail}</p>
                  </div>
                }
              >
                <div class="flex items-center gap-2 rounded-lg border border-green-500/30 bg-green-500/10 px-3 py-2.5 text-sm">
                  <Check class="size-4 shrink-0 text-green-500" />
                  <span class="text-foreground">
                    {view().heading} — {view().detail}
                  </span>
                </div>
              </Show>
              <div class="flex justify-end gap-2 pt-1">
                <Show when={!view().ok}>
                  <Button type="button" variant="outline" onClick={() => setPhase({ kind: "pick" })}>
                    <RefreshCw class="size-4" />
                    Try again
                  </Button>
                </Show>
                <Button type="button" onClick={() => props.onOpenChange(false)}>
                  Done
                </Button>
              </div>
            </>
          )}
        </Show>
      </DialogContent>
    </Dialog>
  );
}
