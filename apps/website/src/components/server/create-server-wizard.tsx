import {
  createSignal,
  Show,
  Switch,
  Match,
  For,
  createEffect,
  createResource,
  onCleanup,
} from "solid-js";
import { Monitor, Check, AlertTriangle, RefreshCw } from "lucide-solid";
import {
  Dialog,
  DialogContent,
  DialogClose,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ProgressChecklist,
  type ProgressChecklistRow,
} from "@/components/ui/progress-checklist";
import { formatElapsed } from "@/lib/now-signal";
import { isElectron, getElectron } from "@/lib/electron";
import { loadServers, setActiveServer, servers, bumpServerIconVersion } from "@/stores/servers";
import * as central from "@/api/central";
import { retry } from "@/lib/retry";
import { forceReconnect } from "@/lib/ws";
import { bootTrace } from "@/lib/boot-trace";
import type { RuntimeUpdateChannel } from "@uncorded/protocol";
import type { ProvisionProgressEvent } from "@uncorded/electron-bridge";

// Wizard's own background probe budget for the "tunnel stalled" case. The
// desktop probe (PR-TR3) already burned 60s; this is the upper bound on how
// long we'll keep the wizard's "Verifying…" UI alive before forcing the user
// to either switch-anyway or close-check-later. 5 min × the 60s desktop
// budget = 6 minutes total of bounded waiting. Per spec-10 Amendment A R2.
const WIZARD_BACKGROUND_PROBE_MAX_MS = 5 * 60_000;
// Cadence between background probe attempts while stalled — short enough that
// a tunnel that propagates inside the 5-min window auto-recovers without the
// user clicking anything, long enough that battery cost stays negligible.
const WIZARD_BACKGROUND_PROBE_INTERVAL_MS = 3_000;
const WIZARD_BACKGROUND_PROBE_TIMEOUT_MS = 2_500;

interface CreateServerWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type Step = 1 | 2 | 3 | 4 | 5 | 6;

const STEP_LABELS: Record<Step, string> = {
  1: "Identity",
  2: "Visibility",
  3: "Plugins",
  4: "Runtime",
  5: "Tunnel",
  6: "Review",
};

const STEP_TITLES: Record<Step, string> = {
  1: "Name your server",
  2: "Who can join?",
  3: "Choose plugins",
  4: "Pick a runtime channel",
  5: "Set up your tunnel",
  6: "Review & create",
};

const TOTAL_STEPS: Step = 6;

export function CreateServerWizard(props: CreateServerWizardProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent class="max-w-lg p-0 h-[min(640px,85dvh)] flex flex-col overflow-hidden">
        <Show
          when={isElectron()}
          fallback={<BrowserOnlyNotice onClose={() => props.onOpenChange(false)} />}
        >
          <WizardSteps onClose={() => props.onOpenChange(false)} />
        </Show>
      </DialogContent>
    </Dialog>
  );
}

function BrowserOnlyNotice(props: { onClose: () => void }) {
  return (
    <div class="flex flex-col items-center gap-6 px-8 py-10 text-center">
      <div class="flex size-14 items-center justify-center rounded-2xl bg-muted border border-border">
        <Monitor class="size-6 text-muted-foreground" />
      </div>
      <div class="space-y-2">
        <DialogTitle>Desktop app required</DialogTitle>
        <DialogDescription class="leading-relaxed">
          Server creation requires the UnCorded desktop app. It manages Docker
          containers and sets up the Cloudflare tunnel on your hardware.
        </DialogDescription>
      </div>
      <div class="w-full rounded-lg border border-dashed border-border bg-muted/30 px-4 py-3">
        <p class="text-sm text-muted-foreground">
          Download the desktop app to create and manage your own servers.
        </p>
      </div>
      <Button class="w-full" onClick={props.onClose}>
        Close
      </Button>
    </div>
  );
}

interface WizardState {
  name: string;
  description: string;
  iconFile: File | null;
  visibility: "public" | "private";
  selectedPlugins: string[];
  channel: RuntimeUpdateChannel;
  tunnelMode: "cloudflare" | "demo";
  cloudflare_tunnel_token: string;
  cloudflare_public_hostname: string;
}

type StatePatch = Partial<WizardState>;

interface FailureSnapshot {
  errorCode?: string;
  message: string;
  step?: string;
}

interface PendingHandoff {
  readonly serverId: string;
  readonly tunnelUrl: string | null;
  readonly iconFile: File | null;
}

type PublicTunnelStatus = "pending" | "verified" | "stalled";

function WizardSteps(props: { onClose: () => void }) {
  const [step, setStep] = createSignal<Step>(1);
  const [state, setState] = createSignal<WizardState>({
    name: "",
    description: "",
    iconFile: null,
    visibility: "private",
    selectedPlugins: ["text-channels"],
    // TODO(0.1.0-stable): flip default to "stable" once a non-suffixed
    // runtime release exists. Today only 0.1.0-dev.1 is published, so a
    // "stable" default would resolve to null and block first-boot users.
    channel: "dev",
    tunnelMode: "cloudflare",
    cloudflare_tunnel_token: "",
    cloudflare_public_hostname: "",
  });
  const [submitting, setSubmitting] = createSignal(false);
  const [sessionId, setSessionId] = createSignal<string | null>(null);
  const [progressEvents, setProgressEvents] = createSignal<ProvisionProgressEvent[]>([]);
  const [failure, setFailure] = createSignal<FailureSnapshot | null>(null);

  // Spec-10 Amendment A — public tunnel handoff gate.
  // `pending` until the desktop emits wait-public-tunnel; `verified` when the
  // probe (desktop or wizard background) returns 200; `stalled` when the
  // desktop's 60s budget expired and the wizard's own probe loop is running.
  const [publicTunnelStatus, setPublicTunnelStatus] =
    createSignal<PublicTunnelStatus>("pending");
  const [stalledElapsedMs, setStalledElapsedMs] = createSignal(0);
  const [pendingHandoff, setPendingHandoff] = createSignal<PendingHandoff | null>(null);
  // One AbortController for the wizard's background probe loop. Aborted on
  // verified, switch-anyway, close-check-later, and on wizard cleanup so a
  // closed-but-still-mounted wizard never leaks polling fetches.
  let backgroundProbeController: AbortController | null = null;
  let stalledTickHandle: ReturnType<typeof setInterval> | null = null;

  function abortBackgroundProbe(): void {
    backgroundProbeController?.abort();
    backgroundProbeController = null;
    if (stalledTickHandle !== null) {
      clearInterval(stalledTickHandle);
      stalledTickHandle = null;
    }
  }

  function finalizeAndClose(handoff: PendingHandoff): void {
    bootTrace("wizard.finalizeAndClose", { serverId: handoff.serverId, hasIcon: Boolean(handoff.iconFile) });
    abortBackgroundProbe();
    bootTrace("wizard.loadServers.start");
    void loadServers().then(() => {
      bootTrace("wizard.loadServers.done");
      setActiveServer(handoff.serverId);
      bootTrace("wizard.setActiveServer", { serverId: handoff.serverId });
      // Force an immediate WS open instead of waiting out any pending
      // exponential-backoff timer — the sidebar shouldn't sit empty after
      // a successful tunnel probe just because the WS layer is mid-wait.
      const server = servers().find((s) => s.id === handoff.serverId);
      if (server) {
        bootTrace("wizard.forceReconnect.call", { serverId: server.id, tunnelUrl: server.tunnel_url });
        void forceReconnect(server)
          .then(() => bootTrace("wizard.forceReconnect.resolved", { serverId: server.id }))
          .catch((err) => bootTrace("wizard.forceReconnect.error", { error: String(err) }));
      } else {
        bootTrace("wizard.forceReconnect.serverMissing", { serverId: handoff.serverId });
      }
    }).catch((err) => bootTrace("wizard.loadServers.error", { error: String(err) }));
    const iconFile = handoff.iconFile;
    const tunnelUrl = handoff.tunnelUrl;
    props.onClose();
    if (iconFile && tunnelUrl) {
      void (async () => {
        try {
          const { token } = await central.getServerToken(handoff.serverId);
          const formData = new FormData();
          formData.append("icon", iconFile);
          // Retry rides out the same propagation flakes the sidebar fetch
          // hits — server may have just gone live and the first POST sees a
          // 502 from a cold edge.
          const res = await retry(
            () => fetch(`${tunnelUrl}/admin/api/icon`, {
              method: "POST",
              headers: { Authorization: `Bearer ${token}` },
              body: formData,
            }),
            { attempts: 4, backoffMs: [500, 1500, 3000] },
          );
          if (!res.ok) throw new Error(`icon upload ${String(res.status)}`);
          // Bump the uploader's local cache buster directly. The runtime
          // also broadcasts `runtime.icon.changed`, but the uploader is
          // racing the WS subscription registration in mountSidebarStore —
          // if the broadcast lands before `__icon_changed__` is wired, it's
          // dropped silently and the uploader stays on letter-avatar until
          // hard refresh. Bumping here makes the uploader independent of
          // the broadcast race; other viewers still rely on the broadcast.
          let updatedAt = Date.now();
          try {
            const body = (await res.json()) as { updatedAt?: number };
            if (typeof body.updatedAt === "number") updatedAt = body.updatedAt;
          } catch {
            // Body parse failure is fine — fall back to client clock.
          }
          bumpServerIconVersion(handoff.serverId, updatedAt);
        } catch {
          // Non-blocking — user can set the icon from the admin panel later.
        }
      })();
    }
  }

  function startWizardBackgroundProbe(tunnelUrl: string): void {
    abortBackgroundProbe();
    const ctrl = new AbortController();
    backgroundProbeController = ctrl;
    const start = Date.now();
    setStalledElapsedMs(0);
    stalledTickHandle = setInterval(() => {
      if (ctrl.signal.aborted) return;
      setStalledElapsedMs(Date.now() - start);
    }, 1_000);

    const url = `${tunnelUrl.replace(/\/$/, "")}/ready`;
    void (async () => {
      while (!ctrl.signal.aborted && Date.now() - start < WIZARD_BACKGROUND_PROBE_MAX_MS) {
        try {
          const attemptSignal = AbortSignal.any([
            ctrl.signal,
            AbortSignal.timeout(WIZARD_BACKGROUND_PROBE_TIMEOUT_MS),
          ]);
          const res = await fetch(url, {
            method: "GET",
            credentials: "omit",
            cache: "no-store",
            signal: attemptSignal,
          });
          if (ctrl.signal.aborted) return;
          if (res.ok) {
            const handoff = pendingHandoff();
            setPublicTunnelStatus("verified");
            if (handoff) finalizeAndClose(handoff);
            return;
          }
        } catch {
          // Network error / timeout — keep polling until budget or abort.
          if (ctrl.signal.aborted) return;
        }
        try {
          await new Promise<void>((resolve, reject) => {
            const t = setTimeout(resolve, WIZARD_BACKGROUND_PROBE_INTERVAL_MS);
            ctrl.signal.addEventListener("abort", () => {
              clearTimeout(t);
              reject(new Error("aborted"));
            }, { once: true });
          });
        } catch {
          return;
        }
      }
      // Budget exhausted — keep the wizard's UI in "stalled" so the user
      // still sees the switch-anyway / close-check-later choice. We stop
      // polling (battery) but don't auto-close.
      abortBackgroundProbe();
    })();
  }

  createEffect(() => {
    if (!isElectron()) return;
    const electron = getElectron();

    const offProgress = electron.serverProvisioning.onProgress((event) => {
      if (event.sessionId !== sessionId()) return;
      setProgressEvents((items) => [...items, event]);
    });

    const offDone = electron.serverProvisioning.onDone((event) => {
      if (event.sessionId !== sessionId()) return;
      setSubmitting(false);
      setSessionId(null);

      const handoff: PendingHandoff = {
        serverId: event.serverId,
        tunnelUrl: event.tunnelUrl,
        iconFile: state().iconFile,
      };

      // Did the desktop's public-tunnel probe succeed, stall, or run at all?
      // Absent probe events ⇒ legacy/skipped (e.g. demo mode with no tunnel
      // URL) ⇒ treat as verified, the wizard has no better signal.
      let lastProbe: ProvisionProgressEvent | null = null;
      for (const ev of progressEvents()) {
        if (ev.step === "wait-public-tunnel") lastProbe = ev;
      }
      const stalled = lastProbe?.status === "warning";

      if (!stalled) {
        setPublicTunnelStatus("verified");
        setPendingHandoff(null);
        finalizeAndClose(handoff);
        return;
      }

      // Stalled: keep wizard open, start background probe, show switch-anyway UI.
      setPublicTunnelStatus("stalled");
      setPendingHandoff(handoff);
      if (event.tunnelUrl) startWizardBackgroundProbe(event.tunnelUrl);
    });

    const offError = electron.serverProvisioning.onError((event) => {
      if (event.sessionId !== sessionId()) return;
      setSubmitting(false);
      setSessionId(null);
      const lastWarning = [...progressEvents()].reverse().find((e) => e.status === "warning");
      setFailure({
        message: event.message,
        ...(event.errorCode ? { errorCode: event.errorCode } : {}),
        ...(lastWarning?.step ? { step: lastWarning.step } : {}),
      });
    });

    onCleanup(() => {
      offProgress();
      offDone();
      offError();
      // Abort any background probe so it doesn't keep polling after the
      // wizard unmounts (e.g. dialog closed mid-stall).
      abortBackgroundProbe();
    });
  });

  async function startProvisioning(): Promise<void> {
    const current = state();
    const name = current.name.trim();
    if (!name) return;

    setSubmitting(true);
    setProgressEvents([]);
    setFailure(null);
    try {
      const result = await getElectron().serverProvisioning.start({
        name,
        description: current.description.trim() || null,
        visibility: current.visibility,
        selectedPlugins: current.selectedPlugins,
        channel: current.channel,
        tunnelMode: current.tunnelMode,
        cloudflare_tunnel_token: current.cloudflare_tunnel_token.trim() || undefined,
        cloudflare_public_hostname: current.cloudflare_public_hostname.trim() || undefined,
      });
      setSessionId(result.sessionId);
    } catch (err) {
      setSubmitting(false);
      setFailure({
        message: err instanceof Error ? err.message : "Failed to start server creation",
      });
    }
  }

  async function handleNext(): Promise<void> {
    if (submitting()) return;
    if (step() < TOTAL_STEPS) {
      setStep((s) => (s + 1) as Step);
      return;
    }
    await startProvisioning();
  }

  return (
    <div class="flex flex-col h-full min-h-0">
      {/* Header (sticky) */}
      <div class="relative flex items-start justify-between gap-4 border-b border-border px-6 py-5 shrink-0">
        <div>
          <p class="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
            Server setup — Step {step()} of {TOTAL_STEPS}
          </p>
          <DialogTitle class="mt-1 text-xl">{STEP_TITLES[step()]}</DialogTitle>
        </div>
        <DialogClose class="mt-1" />
      </div>

      {/* Step track (sticky) */}
      <div class="px-6 pt-4 shrink-0">
        <StepTrack currentStep={step()} />
      </div>

      {/* Step content (scrollable) */}
      <div class="flex-1 overflow-y-auto px-6 py-5 min-h-0">
        <Switch>
          <Match when={step() === 1}>
            <Step1 state={state()} onChange={(p) => setState((s) => ({ ...s, ...p }))} />
          </Match>
          <Match when={step() === 2}>
            <Step2 state={state()} onChange={(p) => setState((s) => ({ ...s, ...p }))} />
          </Match>
          <Match when={step() === 3}>
            <Step3 state={state()} onChange={(p) => setState((s) => ({ ...s, ...p }))} />
          </Match>
          <Match when={step() === 4}>
            <Step4Runtime state={state()} onChange={(p) => setState((s) => ({ ...s, ...p }))} />
          </Match>
          <Match when={step() === 5}>
            <Step5Tunnel state={state()} onChange={(p) => setState((s) => ({ ...s, ...p }))} />
          </Match>
          <Match when={step() === 6}>
            <Step6Review
              state={state()}
              submitting={submitting()}
              progressEvents={progressEvents()}
            />
          </Match>
        </Switch>

        <Show when={failure()}>
          {(snap) => (
            <ProvisionFailureCard
              failure={snap()}
              onRetry={() => {
                if (submitting()) return;
                void startProvisioning();
              }}
              onCancel={() => setFailure(null)}
              onBootedDocker={() => {
                if (submitting()) return;
                setFailure(null);
                void startProvisioning();
              }}
            />
          )}
        </Show>

        <Show when={publicTunnelStatus() === "stalled" && pendingHandoff()}>
          {(handoff) => (
            <TunnelStalledCard
              elapsedMs={stalledElapsedMs()}
              budgetMs={WIZARD_BACKGROUND_PROBE_MAX_MS}
              onSwitchAnyway={() => {
                const h = handoff();
                finalizeAndClose(h);
              }}
              onCloseAndCheckLater={() => {
                abortBackgroundProbe();
                setPendingHandoff(null);
                // Server already exists in user's Central registry; sidebar
                // resilience (PR-TR5) handles a later click on that entry.
                props.onClose();
              }}
            />
          )}
        </Show>
      </div>

      {/* Footer (sticky) */}
      <div class="flex items-center justify-between gap-2 border-t border-border px-6 py-4 shrink-0">
        <Button
          variant="ghost"
          disabled={submitting()}
          onClick={() => {
            if (step() === 1) props.onClose();
            else setStep((s) => (s - 1) as Step);
          }}
        >
          {step() === 1 ? "Cancel" : "Back"}
        </Button>
        <Button
          disabled={submitting() || (step() === 1 && !state().name.trim())}
          onClick={() => void handleNext()}
        >
          {submitting()
            ? "Creating…"
            : step() === TOTAL_STEPS
              ? "Create server"
              : "Continue"}
        </Button>
      </div>
    </div>
  );
}

function StepTrack(props: { currentStep: Step }) {
  const steps = [1, 2, 3, 4, 5, 6] as Step[];
  return (
    <div class="flex items-center gap-0 mb-2">
      <For each={steps}>
        {(s, i) => {
          const done = () => s < props.currentStep;
          const active = () => s === props.currentStep;
          return (
            <>
              <div class="flex flex-col items-center gap-1.5 shrink-0">
                <div
                  class="size-7 rounded-full flex items-center justify-center text-xs font-medium transition-all duration-200"
                  classList={{
                    "bg-primary text-primary-foreground": done(),
                    "border-2 border-primary bg-primary/10 text-primary": active(),
                    "border border-border bg-muted text-muted-foreground": !done() && !active(),
                  }}
                >
                  <Show when={done()} fallback={<span>{s}</span>}>
                    <Check class="size-3.5" />
                  </Show>
                </div>
                <p
                  class="text-[9px] font-semibold uppercase tracking-widest text-center"
                  classList={{
                    "text-foreground": active(),
                    "text-muted-foreground": !active(),
                  }}
                >
                  {STEP_LABELS[s]}
                </p>
              </div>
              <Show when={i() < steps.length - 1}>
                <div
                  class="flex-1 h-px mb-4 mx-1 transition-all duration-300"
                  classList={{
                    "bg-primary": done(),
                    "bg-border": !done(),
                  }}
                />
              </Show>
            </>
          );
        }}
      </For>
    </div>
  );
}

// ── Step 1: Identity ────────────────────────────────────────────────────────

function Step1(props: { state: WizardState; onChange: (p: StatePatch) => void }) {
  const [iconPreview, setIconPreview] = createSignal<string | null>(null);
  const inputId = "server-icon-file-input";

  function handleIconSelect(e: Event) {
    const file = (e.currentTarget as HTMLInputElement).files?.[0] ?? null;
    if (!file) return;
    const prev = iconPreview();
    if (prev) URL.revokeObjectURL(prev);
    setIconPreview(URL.createObjectURL(file));
    props.onChange({ iconFile: file });
  }

  return (
    <div class="space-y-5">
      {/* Icon picker */}
      <div class="flex items-center gap-4">
        <label
          for={inputId}
          class="relative size-16 shrink-0 overflow-hidden rounded-xl border-2 border-dashed border-border bg-muted transition-colors hover:border-muted-foreground/50 cursor-pointer group"
          aria-label="Upload server icon"
        >
          <Show
            when={iconPreview()}
            fallback={
              <span class="flex size-full items-center justify-center text-2xl font-bold text-muted-foreground select-none">
                {props.state.name.trim()[0]?.toUpperCase() ?? "?"}
              </span>
            }
          >
            <img
              src={iconPreview()!}
              alt="Server icon preview"
              class="size-full object-cover"
            />
          </Show>
          <div class="absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity rounded-xl">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" x2="12" y1="3" y2="15" />
            </svg>
          </div>
        </label>
        <input
          id={inputId}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          class="sr-only"
          onChange={handleIconSelect}
        />
        <div class="space-y-1 min-w-0">
          <p class="text-xs font-medium text-muted-foreground">Server icon</p>
          <p class="text-xs text-muted-foreground/70 leading-relaxed">
            PNG, JPEG, WebP, or GIF. Optional — you can set it after creation in the admin panel.
          </p>
          <Show when={props.state.iconFile}>
            <button
              type="button"
              class="text-[10px] font-medium text-destructive hover:underline cursor-pointer"
              onClick={() => {
                const prev = iconPreview();
                if (prev) URL.revokeObjectURL(prev);
                setIconPreview(null);
                props.onChange({ iconFile: null });
                const el = document.getElementById(inputId) as HTMLInputElement | null;
                if (el) el.value = "";
              }}
            >
              Remove
            </button>
          </Show>
        </div>
      </div>

      <div class="space-y-1.5">
        <label class="text-xs font-medium text-muted-foreground">
          Server name <span class="text-destructive">*</span>
        </label>
        <Input
          placeholder="My awesome server"
          value={props.state.name}
          onInput={(e) => props.onChange({ name: e.currentTarget.value })}
          autofocus
        />
      </div>

      <div class="space-y-1.5">
        <label class="text-xs font-medium text-muted-foreground">Description</label>
        <Input
          placeholder="What's this server for?"
          value={props.state.description}
          onInput={(e) => props.onChange({ description: e.currentTarget.value })}
        />
      </div>
    </div>
  );
}

// ── Step 2: Visibility ──────────────────────────────────────────────────────

function Step2(props: { state: WizardState; onChange: (p: StatePatch) => void }) {
  return (
    <div class="space-y-3">
      <p class="text-sm text-muted-foreground">
        Who can discover and join this server?
      </p>
      <For each={["private", "public"] as const}>
        {(v) => {
          const selected = () => props.state.visibility === v;
          return (
            <button
              class="w-full flex items-start gap-3 rounded-xl p-4 text-left transition-all duration-150 cursor-pointer border focus:outline-none"
              classList={{
                "border-primary/30 bg-primary/5": selected(),
                "border-border bg-muted/30 hover:bg-muted/50": !selected(),
              }}
              onClick={() => props.onChange({ visibility: v })}
            >
              <div
                class="size-4 mt-0.5 rounded-full border-2 shrink-0 flex items-center justify-center transition-colors"
                classList={{
                  "border-primary": selected(),
                  "border-muted-foreground/40": !selected(),
                }}
              >
                <Show when={selected()}>
                  <div class="size-2 rounded-full bg-primary" />
                </Show>
              </div>
              <div>
                <p class="text-sm font-semibold capitalize">{v}</p>
                <p class="mt-0.5 text-xs text-muted-foreground">
                  {v === "private"
                    ? "Only people with an invite can join."
                    : "Anyone can find and join this server."}
                </p>
              </div>
            </button>
          );
        }}
      </For>
    </div>
  );
}

// ── Step 3: Plugins ─────────────────────────────────────────────────────────

function Step3(props: { state: WizardState; onChange: (p: StatePatch) => void }) {
  const BUNDLED_PLUGINS = ["text-channels", "voice-channels"];

  function togglePlugin(slug: string) {
    const current = props.state.selectedPlugins;
    const next = current.includes(slug)
      ? current.filter((s) => s !== slug)
      : [...current, slug];
    props.onChange({ selectedPlugins: next });
  }

  return (
    <div class="space-y-4">
      <p class="text-sm text-muted-foreground">
        Choose which plugins to install on your server.
      </p>

      <div class="space-y-2">
        <p class="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
          Bundled
        </p>
        <For each={BUNDLED_PLUGINS}>
          {(slug) => (
            <PluginRow
              slug={slug}
              checked={props.state.selectedPlugins.includes(slug)}
              onToggle={() => togglePlugin(slug)}
            />
          )}
        </For>
      </div>

      <div class="space-y-2">
        <p class="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
          Marketplace
        </p>
        <div class="rounded-lg border border-border bg-muted/30 px-3 py-3">
          <p class="text-xs text-muted-foreground">
            Marketplace plugins will appear here once the package registry is live.
          </p>
        </div>
      </div>
    </div>
  );
}

function PluginRow(props: {
  slug: string;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      class="w-full flex items-center gap-3 rounded-lg p-3 text-left transition-all duration-150 cursor-pointer border focus:outline-none"
      classList={{
        "border-primary/25 bg-primary/5": props.checked,
        "border-border bg-muted/30 hover:bg-muted/50": !props.checked,
      }}
      onClick={props.onToggle}
    >
      <div
        class="size-4 rounded flex items-center justify-center shrink-0 transition-all"
        classList={{
          "bg-primary": props.checked,
          "border border-muted-foreground/40 bg-transparent": !props.checked,
        }}
      >
        <Show when={props.checked}>
          <Check class="size-3 text-primary-foreground" />
        </Show>
      </div>
      <span class="flex-1 text-sm font-medium capitalize">
        {props.slug.replace(/-/g, " ")}
      </span>
    </button>
  );
}

// ── Step 4: Runtime channel ─────────────────────────────────────────────────

interface ChannelDescriptor {
  value: RuntimeUpdateChannel;
  label: string;
  blurb: string;
}

const CHANNELS: ReadonlyArray<ChannelDescriptor> = [
  { value: "stable", label: "Stable", blurb: "Production-ready releases. Recommended for daily use." },
  { value: "beta", label: "Beta", blurb: "Release candidates. New features sooner; some rough edges." },
  { value: "dev", label: "Dev", blurb: "Bleeding-edge dev builds. Updates frequently." },
];

function Step4Runtime(props: { state: WizardState; onChange: (p: StatePatch) => void }) {
  return (
    <div class="space-y-4">
      <p class="text-sm text-muted-foreground">
        Pick which runtime channel this server pulls from. You can change it
        later in the runtime panel.
      </p>

      <div class="space-y-2">
        <For each={CHANNELS}>
          {(channel) => (
            <ChannelCard
              channel={channel}
              selected={props.state.channel === channel.value}
              onSelect={() => props.onChange({ channel: channel.value })}
            />
          )}
        </For>
      </div>
    </div>
  );
}

function ChannelCard(props: {
  channel: ChannelDescriptor;
  selected: boolean;
  onSelect: () => void;
}) {
  // resolveLatest is debounced naturally by the IPC roundtrip + GitHub
  // releases response time. We key on the channel value so each card runs
  // independently and the renderer doesn't have to thread one shared resource.
  const [resolved] = createResource(
    () => props.channel.value,
    async (channel) => {
      if (!isElectron()) return null;
      try {
        return await getElectron().runtimeReleases.resolveLatest(channel);
      } catch {
        return null;
      }
    },
  );
  const unavailable = () => resolved.state === "ready" && resolved() === null;

  return (
    <button
      class="w-full flex items-start gap-3 rounded-xl p-4 text-left transition-all duration-150 cursor-pointer border focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed"
      classList={{
        "border-primary/30 bg-primary/5": props.selected && !unavailable(),
        "border-border bg-muted/30 hover:bg-muted/50": !props.selected || unavailable(),
      }}
      disabled={unavailable()}
      onClick={() => {
        if (unavailable()) return;
        props.onSelect();
      }}
      data-tooltip={unavailable() ? `No ${props.channel.label.toLowerCase()} release published yet.` : undefined}
    >
      <div
        class="size-4 mt-0.5 rounded-full border-2 shrink-0 flex items-center justify-center transition-colors"
        classList={{
          "border-primary": props.selected && !unavailable(),
          "border-muted-foreground/40": !props.selected || unavailable(),
        }}
      >
        <Show when={props.selected && !unavailable()}>
          <div class="size-2 rounded-full bg-primary" />
        </Show>
      </div>
      <div class="flex-1 space-y-0.5 min-w-0">
        <div class="flex items-center gap-2">
          <p class="text-sm font-semibold">{props.channel.label}</p>
          <Show when={props.channel.value === "dev"}>
            <span class="text-[10px] font-semibold uppercase tracking-widest rounded-full border border-blue-500/30 bg-blue-500/10 px-2 py-0.5 text-blue-600 dark:text-blue-400">
              Default
            </span>
          </Show>
        </div>
        <p class="text-xs text-muted-foreground">{props.channel.blurb}</p>
        <p class="text-[11px] font-mono text-muted-foreground/80 pt-1">
          <Switch>
            <Match when={resolved.loading}>
              <span class="text-muted-foreground/50">Looking up latest version…</span>
            </Match>
            <Match when={resolved.state === "ready" && resolved()}>
              <>Will install runtime <span class="font-semibold text-foreground">{resolved()}</span></>
            </Match>
            <Match when={unavailable()}>
              <span class="text-muted-foreground/60">No release published yet.</span>
            </Match>
          </Switch>
        </p>
      </div>
    </button>
  );
}

// ── Step 5: Tunnel ──────────────────────────────────────────────────────────

function Step5Tunnel(props: { state: WizardState; onChange: (p: StatePatch) => void }) {
  return (
    <div class="space-y-3">
      <p class="text-sm text-muted-foreground">
        How should your server be reachable from the internet?
      </p>

      <For each={["cloudflare", "demo"] as const}>
        {(v) => {
          const selected = () => props.state.tunnelMode === v;
          return (
            <button
              class="w-full flex items-start gap-3 rounded-xl p-4 text-left transition-all duration-150 cursor-pointer border focus:outline-none"
              classList={{
                "border-primary/30 bg-primary/5": selected(),
                "border-border bg-muted/30 hover:bg-muted/50": !selected(),
              }}
              onClick={() => props.onChange({ tunnelMode: v })}
            >
              <div
                class="size-4 mt-0.5 rounded-full border-2 shrink-0 flex items-center justify-center transition-colors"
                classList={{
                  "border-primary": selected(),
                  "border-muted-foreground/40": !selected(),
                }}
              >
                <Show when={selected()}>
                  <div class="size-2 rounded-full bg-primary" />
                </Show>
              </div>
              <div class="space-y-0.5">
                <div class="flex items-center gap-2">
                  <p class="text-sm font-semibold">
                    {v === "cloudflare" ? "Cloudflare Tunnel" : "Demo / temporary"}
                  </p>
                  <Show when={v === "cloudflare"}>
                    <span class="text-[10px] font-semibold uppercase tracking-widest rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-emerald-600 dark:text-emerald-400">
                      Recommended
                    </span>
                  </Show>
                </div>
                <p class="text-xs text-muted-foreground">
                  {v === "cloudflare"
                    ? "Stable public URL via Cloudflare. Best for production servers."
                    : "Temporary URL for testing. Expires when the container stops."}
                </p>
              </div>
            </button>
          );
        }}
      </For>

      <Show when={props.state.tunnelMode === "cloudflare"}>
        <div class="space-y-3 pt-1">
          <div class="space-y-1.5">
            <div class="flex items-center justify-between">
              <label class="text-xs font-medium text-muted-foreground">Tunnel token</label>
              <span class="text-[10px] text-muted-foreground/60">optional</span>
            </div>
            <Input
              placeholder="eyJhIjoiMT..."
              type="password"
              value={props.state.cloudflare_tunnel_token}
              onInput={(e) => props.onChange({ cloudflare_tunnel_token: e.currentTarget.value })}
            />
            <p class="text-xs text-muted-foreground/70 leading-relaxed">
              Cloudflare Zero Trust → Networks → Tunnels → Create a tunnel → Docker.
              Leave blank to use a temporary demo URL.
            </p>
          </div>

          <div class="space-y-1.5">
            <label class="text-xs font-medium text-muted-foreground">Public hostname</label>
            <Input
              placeholder="uncorded.yourdomain.com"
              value={props.state.cloudflare_public_hostname}
              onInput={(e) => props.onChange({ cloudflare_public_hostname: e.currentTarget.value })}
            />
            <p class="text-xs text-muted-foreground/70">
              The hostname configured in the tunnel's Public Hostname tab.
            </p>
          </div>
        </div>
      </Show>
    </div>
  );
}

// ── Step 6: Review + live progress ─────────────────────────────────────────

function Step6Review(props: {
  state: WizardState;
  submitting: boolean;
  progressEvents: ProvisionProgressEvent[];
}) {
  return (
    <div class="space-y-4">
      <Show when={!props.submitting && props.progressEvents.length === 0}>
        <div class="rounded-xl overflow-hidden border border-border">
          <ReviewRow label="Name" value={props.state.name} first />
          <ReviewRow label="Description" value={props.state.description || "—"} />
          <ReviewRow
            label="Icon"
            value={props.state.iconFile ? props.state.iconFile.name : "Default (initial letter)"}
          />
          <ReviewRow label="Visibility" value={props.state.visibility} />
          <ReviewRow label="Plugins" value={props.state.selectedPlugins.join(", ")} />
          <ReviewRow label="Runtime channel" value={props.state.channel} />
          <ReviewRow label="Tunnel" value={props.state.tunnelMode} />
        </div>

        <div class="rounded-xl border border-dashed border-border bg-muted/30 p-4">
          <p class="text-sm font-medium mb-1">What happens next</p>
          <p class="text-xs text-muted-foreground leading-relaxed">
            We pull the runtime image from GitHub Container Registry, verify
            its cosign signature, register the server with Central, and bring
            up your container. The progress log appears here as it runs.
          </p>
        </div>
      </Show>

      <Show when={props.submitting || props.progressEvents.length > 0}>
        <ProgressLog events={props.progressEvents} state={props.state} />
      </Show>
    </div>
  );
}

function ReviewRow(props: { label: string; value: string; first?: boolean }) {
  return (
    <div
      class="flex items-center justify-between px-4 py-3"
      classList={{ "border-t border-border": !props.first }}
    >
      <span class="text-xs font-medium text-muted-foreground">{props.label}</span>
      <span class="text-sm font-medium text-right max-w-[60%] truncate">{props.value}</span>
    </div>
  );
}

// ── Live-progress checklist ────────────────────────────────────────────────
//
// Persistent checklist UX: every step the provision flow can emit is rendered
// upfront as a row with state pending → in_progress → done (or warning /
// skipped). Steps that fire faster than a human can read still leave a
// satisfying check behind, and the user can see what's left without
// scrolling. The previous chronological log produced two rows per step
// (running + completed) which doubled the visible noise and made fast
// post-download steps look like the wizard had stalled.

type StepStatus = "pending" | "in_progress" | "done" | "warning" | "skipped";

interface ChecklistStep {
  key: ProvisionProgressEvent["step"];
  label: string;
}

function buildExpectedSteps(state: WizardState): ChecklistStep[] {
  return [
    { key: "check-environment", label: "Check Docker" },
    { key: "register", label: "Register with Central" },
    { key: "resolve-version", label: `Look up ${state.channel} runtime` },
    { key: "download-runtime", label: "Download runtime image" },
    { key: "verify-signature", label: "Verify signature" },
    { key: "prepare-volumes", label: "Prepare server volumes" },
    { key: "install-plugins", label: "Install plugins" },
    { key: "write-config", label: "Write configuration" },
    { key: "start-container", label: "Start server container" },
    { key: "wait-health", label: "Wait for health" },
    { key: "set-channel", label: "Set update channel" },
    { key: "wait-heartbeat", label: "Wait for first heartbeat" },
    { key: "wait-public-tunnel", label: "Verify public tunnel" },
  ];
}

function ProgressLog(props: { events: ProvisionProgressEvent[]; state: WizardState }) {
  const expected = buildExpectedSteps(props.state);

  // Per-step "first time we saw this step running" — captured the first
  // tick the row leaves `pending`. Powers the elapsed-time chip, so a row
  // that sits in `in_progress` for 30s clearly shows the user the wizard
  // hasn't frozen.
  const firstSeenAt = new Map<string, number>();

  // Latest event per step key — `running`/`progress`/`completed`/`warning`
  // arrive in order, so the last one wins.
  const latestByStep = (): Map<string, ProvisionProgressEvent> => {
    const m = new Map<string, ProvisionProgressEvent>();
    for (const ev of props.events) {
      m.set(ev.step, ev);
      if (!firstSeenAt.has(ev.step)) {
        firstSeenAt.set(ev.step, Date.now());
      }
    }
    return m;
  };

  // Highest expected-step index any event has touched. Anything pending
  // *before* this index is treated as "skipped" (e.g. dev-mode skips
  // resolve-version + verify-signature + set-channel — those rows render
  // with a faint dash instead of a dim dot).
  const highestTouchedIndex = (): number => {
    let highest = -1;
    for (const ev of props.events) {
      const idx = expected.findIndex((s) => s.key === ev.step);
      if (idx > highest) highest = idx;
    }
    return highest;
  };

  function rowStatus(step: ChecklistStep, idx: number): StepStatus {
    const ev = latestByStep().get(step.key);
    if (ev) {
      if (ev.status === "completed") return "done";
      if (ev.status === "warning") return "warning";
      return "in_progress";
    }
    return idx < highestTouchedIndex() ? "skipped" : "pending";
  }

  const rows = (): ProgressChecklistRow[] => {
    const map = latestByStep();
    return expected.map((step, idx) => {
      const ev = map.get(step.key);
      const status = rowStatus(step, idx);
      const detail =
        status === "warning"
          ? ev?.detail ?? ev?.message
          : status === "in_progress"
            ? ev?.detail
            : undefined;
      const percent =
        step.key === "download-runtime" && typeof ev?.percent === "number"
          ? ev.percent
          : null;
      const startedAt = firstSeenAt.get(step.key);
      return {
        key: step.key,
        label: step.label,
        status,
        detail,
        percent,
        startedAt,
      } satisfies ProgressChecklistRow;
    });
  };

  return <ProgressChecklist rows={rows} title="Live progress" />;
}

// ── Tunnel-stalled handoff UX ───────────────────────────────────────────────

function TunnelStalledCard(props: {
  elapsedMs: number;
  budgetMs: number;
  onSwitchAnyway: () => void;
  onCloseAndCheckLater: () => void;
}) {
  return (
    <div class="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 space-y-3">
      <div class="flex items-start gap-3">
        <RefreshCw class="size-5 shrink-0 text-amber-600 mt-0.5 animate-spin" />
        <div class="flex-1 space-y-1 min-w-0">
          <p class="text-sm font-semibold text-amber-700 dark:text-amber-400">
            Tunnel is still propagating
          </p>
          <p class="text-xs text-foreground/80 leading-relaxed">
            Your server is up — Cloudflare is still pushing the route to its
            edge. We'll switch you over automatically as soon as it's reachable.
          </p>
          <p class="mt-1 font-mono text-[10px] text-muted-foreground">
            Verifying… {formatElapsed(props.elapsedMs)} / {formatElapsed(props.budgetMs)}
          </p>
        </div>
      </div>
      <div class="flex flex-col gap-2 sm:flex-row sm:justify-end">
        <Button
          variant="ghost"
          size="sm"
          onClick={props.onCloseAndCheckLater}
        >
          Close and check later
        </Button>
        <Button
          variant="default"
          size="sm"
          onClick={props.onSwitchAnyway}
        >
          Switch to server anyway
        </Button>
      </div>
    </div>
  );
}

// ── Failure UX ──────────────────────────────────────────────────────────────

const FAILURE_COPY: Record<string, { title: string; body: string }> = {
  docker_not_installed: {
    title: "Docker isn't installed",
    body: "UnCorded servers run in Docker containers. Install Docker Desktop, then try again.",
  },
  docker_not_running: {
    title: "Docker isn't running",
    body: "Start Docker Desktop and wait for it to finish initializing, then try again.",
  },
  pull_failed: {
    title: "Couldn't download the runtime image",
    body: "Check your internet connection and try again. If you're on a metered network, the pull may have been blocked.",
  },
  cosign_no_signature: {
    title: "Runtime image isn't signed",
    body: "This image has no cosign signature attached. Refusing to install for safety. Try a different channel.",
  },
  cosign_verify_failed: {
    title: "Signature verification failed",
    body: "The runtime image signature didn't match the embedded public key. Refusing to install — the image may be tampered with.",
  },
  cosign_binary_not_found: {
    title: "Cosign isn't available",
    body: "The bundled cosign binary couldn't be found. Reinstall the desktop app to restore it.",
  },
  no_release_for_channel: {
    title: "No runtime release on this channel",
    body: "There's no published release on the channel you picked. Try a different channel.",
  },
};

function ProvisionFailureCard(props: {
  failure: FailureSnapshot;
  onRetry: () => void;
  onCancel: () => void;
  /** Called after Docker Desktop has been launched and `docker info` answers.
   *  The parent re-runs the provisioning flow so the user doesn't have to
   *  click Try again themselves. */
  onBootedDocker: () => void;
}) {
  const [showDetails, setShowDetails] = createSignal(false);
  const friendly = () => {
    const code = props.failure.errorCode;
    if (code && FAILURE_COPY[code]) return FAILURE_COPY[code]!;
    return {
      title: props.failure.step
        ? `Provisioning failed at "${props.failure.step}"`
        : "Provisioning failed",
      body: props.failure.message,
    };
  };

  return (
    <div class="mt-4 rounded-xl border border-destructive/30 bg-destructive/5 p-4 space-y-3">
      <div class="flex items-start gap-3">
        <AlertTriangle class="size-5 shrink-0 text-destructive mt-0.5" />
        <div class="flex-1 space-y-1 min-w-0">
          <p class="text-sm font-semibold text-destructive">{friendly().title}</p>
          <p class="text-xs text-foreground/80 leading-relaxed">{friendly().body}</p>
        </div>
      </div>

      <Show when={props.failure.errorCode === "docker_not_running"}>
        <DockerBootRow onBooted={props.onBootedDocker} />
      </Show>

      <div class="space-y-2">
        <button
          type="button"
          class="text-[11px] font-medium text-muted-foreground hover:text-foreground hover:underline cursor-pointer"
          onClick={() => setShowDetails((s) => !s)}
        >
          {showDetails() ? "Hide" : "Show"} technical details
        </button>
        <Show when={showDetails()}>
          <pre class="rounded-lg border border-border bg-muted/40 p-2 text-[10px] font-mono text-muted-foreground whitespace-pre-wrap break-words">{props.failure.message}</pre>
        </Show>
      </div>

      <div class="flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={props.onCancel}>
          Dismiss
        </Button>
        <Button size="sm" onClick={props.onRetry}>
          <RefreshCw class="size-3.5 mr-1.5" />
          Try again
        </Button>
      </div>
    </div>
  );
}

// ── Docker boot recovery (rendered only when errorCode === docker_not_running) ─

type DockerBootState =
  | { kind: "checking" }
  | { kind: "not-found" }
  | { kind: "ready"; path: string }
  | { kind: "starting" }
  | { kind: "waiting" }
  | { kind: "failed"; reason: string };

function DockerBootRow(props: { onBooted: () => void }) {
  const [boot, setBoot] = createSignal<DockerBootState>({ kind: "checking" });

  // One-shot probe: does Docker Desktop exist on disk? Drives whether we
  // show the launch button at all. Linux always returns not-found by design
  // (dockerd is a system service, not a launchable bundle).
  createEffect(() => {
    if (!isElectron()) {
      setBoot({ kind: "not-found" });
      return;
    }
    void getElectron()
      .docker.findDesktop()
      .then((res) => {
        if (res.found && res.path) {
          setBoot({ kind: "ready", path: res.path });
        } else {
          setBoot({ kind: "not-found" });
        }
      })
      .catch(() => {
        setBoot({ kind: "not-found" });
      });
  });

  async function handleStart(): Promise<void> {
    setBoot({ kind: "starting" });
    try {
      await getElectron().docker.startDesktop();
    } catch (err) {
      setBoot({
        kind: "failed",
        reason: err instanceof Error ? err.message : "Couldn't launch Docker Desktop",
      });
      return;
    }
    setBoot({ kind: "waiting" });
    let running = false;
    try {
      // Default 120s budget on the main side; we don't pass an override so
      // a renderer compromise can't make the IPC handler block forever.
      running = await getElectron().docker.waitForRunning();
    } catch (err) {
      setBoot({
        kind: "failed",
        reason: err instanceof Error ? err.message : "Lost contact with Docker Desktop",
      });
      return;
    }
    if (!running) {
      setBoot({
        kind: "failed",
        reason: "Docker Desktop didn't finish starting in time. Check its tray icon, then try again.",
      });
      return;
    }
    props.onBooted();
  }

  return (
    <Show when={boot().kind !== "not-found"}>
      <div class="rounded-lg border border-border bg-background/60 px-3 py-2.5 space-y-2">
        <p class="text-xs font-medium text-foreground/90">
          We found Docker Desktop on this machine.
        </p>
        <Switch>
          <Match when={boot().kind === "checking"}>
            <p class="text-[11px] text-muted-foreground">Looking for Docker Desktop…</p>
          </Match>
          <Match when={boot().kind === "ready"}>
            <Button size="sm" onClick={() => void handleStart()}>
              Start Docker Desktop & retry
            </Button>
          </Match>
          <Match when={boot().kind === "starting"}>
            <div class="flex items-center gap-2 text-[11px] text-muted-foreground">
              <div class="size-3 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-foreground" />
              Launching Docker Desktop…
            </div>
          </Match>
          <Match when={boot().kind === "waiting"}>
            <div class="flex items-center gap-2 text-[11px] text-muted-foreground">
              <div class="size-3 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-foreground" />
              Waiting for Docker to finish booting (this can take a minute)…
            </div>
          </Match>
          <Match when={boot().kind === "failed" ? (boot() as Extract<DockerBootState, { kind: "failed" }>) : null}>
            {(state) => (
              <div class="space-y-2">
                <p class="text-[11px] text-destructive">{state().reason}</p>
                <Button size="sm" variant="outline" onClick={() => void handleStart()}>
                  Try launching again
                </Button>
              </div>
            )}
          </Match>
        </Switch>
      </div>
    </Show>
  );
}
