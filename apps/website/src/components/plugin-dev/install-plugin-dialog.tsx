import { For, Show, createEffect, createSignal, on, onCleanup } from "solid-js";
import { Check, Loader2, RefreshCw, TriangleAlert } from "lucide-solid";
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

// Install a dev plugin into THE server whose settings panel opened the
// Plugin Dev flow — no picker; the server is given by context. Consent to
// unsigned local plugins when the server hasn't opted in yet, watch the step
// stream, land on a result. The deploy restarts the server — the copy says
// so up front instead of surprising connected users.

interface ResultView {
  ok: boolean;
  heading: string;
  detail: string;
}

type Phase =
  | { kind: "confirm" }
  | { kind: "running" }
  | { kind: "result"; view: ResultView };

function humanizeCode(code: string): string {
  return code.replaceAll("_", " ").toLowerCase();
}

export function InstallPluginDialog(props: {
  plugin: DevPlugin | null;
  serverId: string;
  onOpenChange: (open: boolean) => void;
}) {
  // null = still loading; "not-local" = this server isn't hosted here.
  const [target, setTarget] = createSignal<DevPluginInstallTarget | "not-local" | null>(null);
  const [consent, setConsent] = createSignal(false);
  const [overwrite, setOverwrite] = createSignal(false);
  const [phase, setPhase] = createSignal<Phase>({ kind: "confirm" });
  const [steps, setSteps] = createSignal<DevPluginDeployProgress[]>([]);
  const [uninstallBusy, setUninstallBusy] = createSignal(false);

  const open = () => props.plugin !== null;
  const slug = () => props.plugin?.slug ?? "";
  const serverName = () => servers().find((s) => s.id === props.serverId)?.name ?? "this server";

  createEffect(
    on(
      () => props.plugin,
      (plugin) => {
        setTarget(null);
        setConsent(false);
        setOverwrite(false);
        setPhase({ kind: "confirm" });
        setSteps([]);
        if (plugin === null) return;
        void listInstallTargets(plugin.slug).then((list) => {
          setTarget(list.find((t) => t.serverId === props.serverId) ?? "not-local");
        });
      },
    ),
  );

  // Step stream — filtered to this dialog's deploy.
  const unsubscribe = onDevPluginDeployProgress((event) => {
    if (event.slug !== slug() || event.serverId !== props.serverId) return;
    setSteps((list) => {
      const next = list.filter((s) => s.step !== event.step);
      return [...next, event];
    });
  });
  onCleanup(unsubscribe);

  const localTarget = (): DevPluginInstallTarget | null => {
    const t = target();
    return t !== null && t !== "not-local" ? t : null;
  };
  const needsConsent = () => localTarget() !== null && !localTarget()!.allowUnsigned;
  const canInstall = () =>
    phase().kind === "confirm" && localTarget() !== null && (!needsConsent() || consent());

  const install = async () => {
    if (localTarget() === null) return;
    setSteps([]);
    setPhase({ kind: "running" });
    const result = await installDevPluginIntoServer(slug(), props.serverId, {
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
              ? "Couldn't confirm plugin status (Central unreachable) — check the plugins list."
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

  const uninstall = async () => {
    if (uninstallBusy()) return;
    setUninstallBusy(true);
    const result = await uninstallDevPluginFromServer(slug(), props.serverId, false);
    setUninstallBusy(false);
    setPhase({
      kind: "result",
      view: result.ok
        ? { ok: true, heading: "Uninstalled", detail: "The plugin's data was kept for a future reinstall." }
        : { ok: false, heading: humanizeCode(result.code), detail: result.message },
    });
  };

  return (
    <Dialog open={open()} onOpenChange={props.onOpenChange}>
      {/* p-5: DialogContent has no default padding (repo convention is
          consumer-owned, see avatar-crop-dialog). */}
      <DialogContent class="sm:max-w-lg p-5">
        <DialogHeader>
          <DialogTitle>
            Install "{props.plugin?.displayName ?? ""}" into {serverName()}
          </DialogTitle>
          <DialogDescription>
            Copies the plugin into the server and restarts it — connected users
            will be briefly disconnected. The dev folder stays the source of truth.
          </DialogDescription>
        </DialogHeader>

        <Show when={phase().kind === "confirm"}>
          <Show
            when={target() !== null}
            fallback={
              <div class="flex items-center gap-2 py-4 text-sm text-muted-foreground">
                <Loader2 class="size-4 animate-spin" /> Checking the server…
              </div>
            }
          >
            <Show
              when={target() !== "not-local"}
              fallback={
                <p class="py-3 text-sm text-muted-foreground">
                  This server isn't hosted on this machine, so the desktop app
                  can't install plugin files into it. Run the install from the
                  computer that hosts it.
                </p>
              }
            >
              <div class="mt-4 flex flex-col gap-3">
              <Show when={localTarget()?.deployed}>
                <p class="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
                  Already installed on this server — reinstalling replaces its
                  files with your latest dev version. Plugin data is kept.
                </p>
              </Show>

              <Show when={needsConsent()}>
                <label class="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-xs">
                  <input
                    type="checkbox"
                    class="mt-0.5 accent-primary"
                    checked={consent()}
                    onChange={(e) => setConsent(e.currentTarget.checked)}
                  />
                  <span class="text-muted-foreground">
                    <span class="font-medium text-foreground">
                      Allow unsigned local plugins on {serverName()}.
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
                <Show when={localTarget()?.deployed}>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={uninstallBusy()}
                    onClick={() => void uninstall()}
                  >
                    <Show when={uninstallBusy()}>
                      <Loader2 class="size-4 animate-spin" />
                    </Show>
                    Uninstall
                  </Button>
                </Show>
                <Button type="button" disabled={!canInstall()} onClick={() => void install()}>
                  {localTarget()?.deployed ? "Reinstall" : "Install"}
                </Button>
              </div>
              </div>
            </Show>
          </Show>
        </Show>

        <Show when={phase().kind === "running"}>
          <div class="mt-3 flex flex-col gap-1.5 py-2">
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
            <div class="mt-4 flex flex-col gap-3">
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
                  <Button type="button" variant="outline" onClick={() => setPhase({ kind: "confirm" })}>
                    <RefreshCw class="size-4" />
                    Try again
                  </Button>
                </Show>
                <Button type="button" onClick={() => props.onOpenChange(false)}>
                  Done
                </Button>
              </div>
            </div>
          )}
        </Show>
      </DialogContent>
    </Dialog>
  );
}
