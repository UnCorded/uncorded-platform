// Owner-only voice setup modal. Triggered when a user clicks a dimmed voice
// channel in the sidebar (or when a voice plugin frontend dispatches
// `platform.voice.request-setup`). Two cards:
//
//   - UnCorded Relay  — coming soon; managed signaling URL we hand out so
//     users don't have to touch DNS at all. Currently disabled.
//
//   - Cloudflare Tunnel — the working flow. Owner adds a Public Hostname on
//     their existing tunnel (voice.mygame.example.com → localhost:7880) and
//     pastes the hostname here. We persist it on the registry and rebuild
//     the runtime container with LIVEKIT_PUBLIC_URL=wss://<hostname>. The
//     tunnel carries WebSocket signaling + WS media fallback. For best
//     quality, owners also forward TCP 7881, UDP 50000, and UDP 3478 on
//     their router so LiveKit can use direct UDP/TCP-ICE instead of
//     WS-relay. (UDP 50000 is the LiveKit MUX media port — spec-24
//     Amendment B; UDP 3478 is the embedded TURN/STUN responder Central
//     probes for cold reachability — Amendment C.)
//
// After Apply we land on a Test/Continue gate: Continue stays disabled
// until a /health/voice probe against the new hostname returns
// status==="ready", so owners can't dismiss the dialog while the runtime
// is still spinning up or the tunnel hostname is misconfigured.
//
// Non-owners see a gentle "ask the owner" message — no setup affordance.

import { Show, createSignal, createEffect, createMemo, onCleanup } from "solid-js";
import { Lock, Cloud, Network, ExternalLink, CheckCircle2, AlertCircle } from "lucide-solid";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { servers } from "@/stores/servers";
import { isOwner } from "@/stores/membership";
import { voiceSetupServerId, closeVoiceSetup } from "@/stores/voice-setup";
import { isVoiceUnreachable } from "@/stores/voice-reachability";
import { runtimeFetch, errorFromResponse } from "@/api/runtime";
import { runDirectPathProbe, type DirectProbeOutcome } from "@/lib/voice-direct-probe";

type Step =
  | "choose"
  | "ports-form"
  | "ports-success"
  | "ports-error"
  | "reachability";

interface PortGroup {
  reachable: boolean;
  latencyMs: number | null;
  error: string | null;
}

interface ProbeResult {
  status: "ready" | "unreachable";
  checkedAt: string;
  wanIp: string;
  rtcTcp: PortGroup;
  rtcUdp: PortGroup;
}

export function VoiceSetupModal() {
  const open = createMemo(() => voiceSetupServerId() !== null);
  const server = createMemo(() => {
    const id = voiceSetupServerId();
    if (!id) return null;
    return servers().find((s) => s.id === id) ?? null;
  });

  const [step, setStep] = createSignal<Step>("choose");
  const [hostname, setHostname] = createSignal("");
  const [submitting, setSubmitting] = createSignal(false);
  const [errorMsg, setErrorMsg] = createSignal<string | null>(null);
  const [testState, setTestState] = createSignal<"idle" | "running" | "passed" | "failed">("idle");
  const [testMessage, setTestMessage] = createSignal<string | null>(null);
  const [probe, setProbe] = createSignal<ProbeResult | null>(null);
  const [probing, setProbing] = createSignal(false);
  const [probeError, setProbeError] = createSignal<string | null>(null);
  // Set to wall-clock ms when a Central cooldown rejection comes back.
  // Drives the countdown shown next to "Test again" — preferred over a
  // generic error string so the operator can see exactly when retest is safe.
  const [cooldownUntil, setCooldownUntil] = createSignal<number | null>(null);
  const [cooldownNow, setCooldownNow] = createSignal(Date.now());
  // Spec-24 Amendment C — owner-driven direct-path probe (UDP 50000). Stays
  // null until the owner clicks "Test direct path"; then we render the
  // classified outcome inline. Reset on modal close.
  const [directProbing, setDirectProbing] = createSignal(false);
  const [directOutcome, setDirectOutcome] = createSignal<DirectProbeOutcome | null>(null);
  const cooldownSecondsLeft = createMemo(() => {
    const until = cooldownUntil();
    if (until === null) return null;
    const remaining = Math.max(0, Math.ceil((until - cooldownNow()) / 1000));
    return remaining;
  });
  // Tick once per second while a cooldown is active so the countdown updates
  // without re-rendering the whole modal.
  createEffect(() => {
    if (cooldownUntil() === null) return;
    const id = window.setInterval(() => setCooldownNow(Date.now()), 1000);
    onCleanup(() => window.clearInterval(id));
  });
  createEffect(() => {
    const left = cooldownSecondsLeft();
    if (left === 0) setCooldownUntil(null);
  });

  function reset() {
    setStep("choose");
    setHostname("");
    setSubmitting(false);
    setErrorMsg(null);
    setTestState("idle");
    setTestMessage(null);
    setProbe(null);
    setProbing(false);
    setProbeError(null);
    setCooldownUntil(null);
    setDirectProbing(false);
    setDirectOutcome(null);
  }

  // Auto-route to the reachability diagnostics step when the modal opens for
  // a server that's provisioned-but-unreachable. Owner-only — non-owners fall
  // through to the existing fallback message in the render.
  createEffect(() => {
    const id = voiceSetupServerId();
    if (id === null) return;
    if (!isOwner()) return;
    if (!isVoiceUnreachable(id)) return;
    setStep("reachability");
    void loadAdminVoiceState(id);
  });

  async function loadAdminVoiceState(serverId: string) {
    const srv = servers().find((s) => s.id === serverId);
    if (!srv?.tunnel_url) {
      setProbeError("Server tunnel URL is unavailable.");
      return;
    }
    try {
      const res = await runtimeFetch(srv.tunnel_url, serverId, "/admin/api/voice/state");
      if (!res.ok) {
        setProbeError((await errorFromResponse(res, "Failed to load voice state")).message);
        return;
      }
      const body = (await res.json()) as { externalReachability?: unknown };
      const r = parseAdminReachability(body.externalReachability);
      if (r) {
        setProbe(r);
        setProbeError(null);
      }
    } catch (err) {
      setProbeError(err instanceof Error ? err.message : String(err));
    }
  }

  async function runReachabilityProbe() {
    const id = voiceSetupServerId();
    if (!id) return;
    const srv = servers().find((s) => s.id === id);
    if (!srv?.tunnel_url) {
      setProbeError("Server tunnel URL is unavailable.");
      return;
    }
    setProbing(true);
    setProbeError(null);
    setCooldownUntil(null);
    try {
      const res = await runtimeFetch(srv.tunnel_url, id, "/admin/api/voice/probe", {
        method: "POST",
      });
      if (!res.ok) {
        // Central enforces a 60s per-server probe cooldown. The runtime
        // forwards that as 429 + `Retry-After` + body.error.retryAfterMs.
        // Surface it as a countdown so the operator sees exactly when retest
        // is safe rather than a vague "fetch failed".
        const cooldownMs = await readCooldownRetryAfter(res);
        if (cooldownMs !== null) {
          setCooldownUntil(Date.now() + cooldownMs);
          return;
        }
        setProbeError((await errorFromResponse(res, "Probe failed")).message);
        return;
      }
      const body = (await res.json()) as { result?: unknown };
      const r = parseProbeResult(body.result);
      if (r) setProbe(r);
    } catch (err) {
      setProbeError(err instanceof Error ? err.message : String(err));
    } finally {
      setProbing(false);
    }
  }

  // Spec-24 Amendment C diagnostic. Asks the runtime for a 30s LiveKit JWT,
  // then runs a one-shot direct-path probe in the browser: connect, wait for
  // ICE, classify the candidate-pair, disconnect. Reports the actual UDP/TCP
  // path callers will end up on so the owner knows whether UDP 50000 is
  // really working (the cold-STUN probe on 3478 can't tell them that).
  async function runDirectProbe() {
    const id = voiceSetupServerId();
    if (!id) return;
    const srv = servers().find((s) => s.id === id);
    if (!srv?.tunnel_url) {
      setDirectOutcome({ kind: "error", reason: "Server tunnel URL is unavailable." });
      return;
    }
    setDirectProbing(true);
    setDirectOutcome(null);
    try {
      const res = await runtimeFetch(srv.tunnel_url, id, "/admin/api/voice/probe-direct-token", {
        method: "POST",
      });
      if (!res.ok) {
        const err = await errorFromResponse(res, "Failed to mint diagnostic token");
        setDirectOutcome({ kind: "error", reason: err.message });
        return;
      }
      const body = (await res.json()) as { token?: unknown; url?: unknown };
      if (typeof body.token !== "string" || typeof body.url !== "string") {
        setDirectOutcome({ kind: "error", reason: "Runtime returned an unexpected shape." });
        return;
      }
      const outcome = await runDirectPathProbe({ token: body.token, url: body.url });
      setDirectOutcome(outcome);
    } catch (err) {
      setDirectOutcome({
        kind: "error",
        reason: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setDirectProbing(false);
    }
  }

  // Verifies the new voice setup is actually working. Two probes:
  //
  //   1. Runtime `/health/voice` on the runtime's own tunnel URL — that
  //      route lives on the runtime (port 3000 inside the container), NOT
  //      on the voice hostname (which only forwards to LiveKit on 7880).
  //      Probing the voice hostname for `/health/voice` returns 404
  //      because LiveKit doesn't know that path.
  //
  //   2. Voice hostname reachability with `mode: "no-cors"` — LiveKit on
  //      7880 doesn't send CORS headers, so we can't read the body, but
  //      a non-network-error response confirms Cloudflare is routing the
  //      voice hostname to *something*. A network error here is the
  //      common "wrong hostname / route not saved" failure.
  //
  // Container restart can take a few seconds, so we don't auto-run this —
  // the owner clicks Test, and Continue stays disabled until both probes
  // pass.
  async function runTest() {
    const voiceHost = hostname().trim();
    if (!voiceHost) return;
    const srv = server();
    const runtimeUrl = srv?.tunnel_url;
    if (!runtimeUrl) {
      setTestState("failed");
      setTestMessage("No runtime URL on this server. Reload the app and try again.");
      return;
    }
    setTestState("running");
    setTestMessage(null);
    try {
      const res = await fetch(`${runtimeUrl}/health/voice`, {
        method: "GET",
        cache: "no-store",
      });
      const body = (await res.json().catch(() => null)) as
        | { status?: string; livekitVersion?: string | null }
        | null;
      const status = body?.status;
      if (status === "starting") {
        setTestState("failed");
        setTestMessage("Voice is still starting. Wait a few seconds and try again.");
        return;
      }
      if (status === "disabled") {
        setTestState("failed");
        setTestMessage(
          "Runtime says voice is disabled. The container may not have picked up the new hostname yet — try again in a moment.",
        );
        return;
      }
      if (status !== "ready") {
        setTestState("failed");
        setTestMessage(
          `Runtime reported ${status ?? "unknown"} (HTTP ${res.status}). Check the runtime logs.`,
        );
        return;
      }
    } catch (err) {
      setTestState("failed");
      const detail = err instanceof Error ? err.message : String(err);
      setTestMessage(
        `Couldn't reach the runtime at ${runtimeUrl}/health/voice — ${detail}. Is the server's tunnel route still pointing at this container?`,
      );
      return;
    }

    // Runtime is ready and serving LiveKit. Now confirm the voice hostname
    // itself routes — LiveKit doesn't return CORS headers so we use
    // no-cors and just check the request didn't network-fail.
    try {
      await fetch(`https://${voiceHost}/`, {
        method: "GET",
        mode: "no-cors",
        cache: "no-store",
      });
      setTestState("passed");
      setTestMessage(`Voice is live and ${voiceHost} is reachable.`);
    } catch (err) {
      setTestState("failed");
      const detail = err instanceof Error ? err.message : String(err);
      setTestMessage(
        `Runtime is healthy but ${voiceHost} isn't reachable — ${detail}. Double-check the Public Hostname route on Cloudflare.`,
      );
    }
  }

  function onOpenChange(next: boolean) {
    if (!next) {
      closeVoiceSetup();
      reset();
    }
  }

  async function submitPortsHostname(e: SubmitEvent) {
    e.preventDefault();
    const id = voiceSetupServerId();
    if (!id) return;
    const trimmed = hostname().trim();
    if (!trimmed) {
      setErrorMsg("Hostname is required.");
      return;
    }
    const bridge = window.electron?.voice;
    if (!bridge) {
      setErrorMsg("Voice setup is only available in the desktop app.");
      return;
    }
    setSubmitting(true);
    setErrorMsg(null);
    try {
      await bridge.setHostname(id, trimmed);
      setStep("ports-success");
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Failed to apply hostname.");
      setStep("ports-error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open()} onOpenChange={onOpenChange}>
      <DialogContent class="max-w-lg">
        <Show
          when={isOwner()}
          fallback={
            <>
              <DialogHeader class="p-6">
                <DialogTitle>Voice not configured</DialogTitle>
                <DialogDescription>
                  Voice channels for{" "}
                  <span class="font-medium text-foreground">{server()?.name ?? "this server"}</span>{" "}
                  haven't been set up yet. Ask the server owner to enable voice from this dialog.
                </DialogDescription>
              </DialogHeader>
              <div class="px-6 pb-6 flex justify-end">
                <Button variant="outline" onClick={() => onOpenChange(false)}>
                  Close
                </Button>
              </div>
              <DialogClose />
            </>
          }
        >
          <Show when={step() === "choose"}>
            <ChooseStep
              onPickPorts={() => setStep("ports-form")}
              serverName={server()?.name ?? "this server"}
            />
          </Show>
          <Show when={step() === "ports-form"}>
            <PortsForm
              serverName={server()?.name ?? "this server"}
              hostname={hostname()}
              onHostnameChange={setHostname}
              onBack={() => setStep("choose")}
              onSubmit={submitPortsHostname}
              submitting={submitting()}
              errorMsg={errorMsg()}
            />
          </Show>
          <Show when={step() === "ports-success"}>
            <PortsSuccess
              hostname={hostname()}
              testState={testState()}
              testMessage={testMessage()}
              onTest={runTest}
              onContinue={() => onOpenChange(false)}
            />
          </Show>
          <Show when={step() === "ports-error"}>
            <PortsError
              message={errorMsg() ?? "Unknown error"}
              onRetry={() => setStep("ports-form")}
              onClose={() => onOpenChange(false)}
            />
          </Show>
          <Show when={step() === "reachability"}>
            <ReachabilityStep
              probe={probe()}
              probing={probing()}
              error={probeError()}
              cooldownSecondsLeft={cooldownSecondsLeft()}
              directProbing={directProbing()}
              directOutcome={directOutcome()}
              onRetest={runReachabilityProbe}
              onDirectProbe={runDirectProbe}
              onClose={() => onOpenChange(false)}
            />
          </Show>
          <DialogClose />
        </Show>
      </DialogContent>
    </Dialog>
  );
}

function ChooseStep(props: { onPickPorts: () => void; serverName: string }) {
  return (
    <>
      <DialogHeader class="p-6 pb-2">
        <DialogTitle>Set up voice for {props.serverName}</DialogTitle>
        <DialogDescription>
          Voice runs over a real-time SFU baked into your runtime. Pick how clients
          should reach it.
        </DialogDescription>
      </DialogHeader>
      <div class="px-6 pb-6 grid gap-3">
        {/* UnCorded Relay — disabled until the managed offering ships. */}
        <div class="rounded-lg border border-border bg-muted/40 p-4 opacity-60">
          <div class="flex items-start gap-3">
            <Cloud class="size-5 text-muted-foreground shrink-0 mt-0.5" />
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2">
                <h3 class="text-sm font-semibold">UnCorded Relay</h3>
                <span class="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                  Coming soon
                </span>
              </div>
              <p class="text-xs text-muted-foreground mt-1">
                Hosted signaling URL. No DNS, no port forwarding — flip a switch and voice works.
              </p>
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={props.onPickPorts}
          class="text-left rounded-lg border border-border bg-card p-4 transition-colors hover:bg-accent hover:border-accent-foreground/20 cursor-pointer"
        >
          <div class="flex items-start gap-3">
            <Network class="size-5 text-foreground shrink-0 mt-0.5" />
            <div class="flex-1 min-w-0">
              <h3 class="text-sm font-semibold">Cloudflare Tunnel</h3>
              <p class="text-xs text-muted-foreground mt-1">
                Use your existing tunnel for signaling. Optionally forward a
                few UDP ports on your router for best voice quality. Traffic
                never touches our infrastructure.
              </p>
            </div>
          </div>
        </button>
      </div>
    </>
  );
}

function PortsForm(props: {
  serverName: string;
  hostname: string;
  onHostnameChange: (v: string) => void;
  onBack: () => void;
  onSubmit: (e: SubmitEvent) => void;
  submitting: boolean;
  errorMsg: string | null;
}) {
  return (
    <form onSubmit={props.onSubmit}>
      <DialogHeader class="p-6 pb-2">
        <DialogTitle>Cloudflare Tunnel</DialogTitle>
        <DialogDescription>
          Add a Public Hostname on your existing Cloudflare tunnel that points to the runtime's
          voice signaling port, then optionally open a few router ports for best media quality.
        </DialogDescription>
      </DialogHeader>
      <div class="px-6 pb-6 grid gap-4">
        <ol class="text-xs text-muted-foreground list-decimal pl-5 space-y-2">
          <li>
            Open Cloudflare Zero Trust → <span class="font-medium text-foreground/90">Networks → Tunnels</span>,
            click your tunnel, then the <span class="font-medium text-foreground/90">Public Hostname</span> tab
            (NOT "Published applications" — that's for Access SSO).
          </li>
          <li>
            Click <span class="font-medium text-foreground/90">Add a public hostname</span> and fill in:
            <ul class="mt-1 ml-2 list-disc pl-4 space-y-0.5 font-mono text-[11px] text-foreground/80">
              <li>Subdomain: <span>voice</span> (or anything)</li>
              <li>Domain: your domain</li>
              <li>Type: <span>HTTP</span></li>
              <li>URL: <span>localhost:7880</span></li>
            </ul>
          </li>
          <li>
            In your main Cloudflare dashboard (not Zero Trust), open the same domain and turn on
            <span class="font-medium text-foreground/90"> Network → WebSockets</span>. This is a
            zone-wide toggle — once on, every hostname in the zone gets WS.
          </li>
          <li>
            <span class="font-medium text-foreground/90">Optional but recommended</span> — forward
            these ports on your router to this machine's LAN IP for direct media (Cloudflare's free
            tunnel only carries TCP/WebSocket, so without forwarding, voice falls back to
            WS-relay — works, but higher latency):
            <ul class="mt-1 ml-2 list-disc pl-4 space-y-0.5 font-mono text-[11px] text-foreground/80">
              <li>TCP <span>7881</span> → ICE-TCP fallback (probed)</li>
              <li>UDP <span>3478</span> → TURN/STUN probe + relay (probed)</li>
              <li>UDP <span>50000</span> → LiveKit RTP media (recommended)</li>
            </ul>
            <span class="block mt-1 not-italic">
              No DNS needed for these — LiveKit auto-detects your public IP via STUN.
            </span>
          </li>
          <li>Paste the full hostname below (e.g. <span class="font-mono">voice.mygame.example.com</span>).</li>
        </ol>

        <a
          href="https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/routing-to-tunnel/dns/"
          target="_blank"
          rel="noopener noreferrer"
          class="text-xs inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
        >
          Cloudflare Public Hostname docs <ExternalLink class="size-3" />
        </a>

        <label class="grid gap-1.5">
          <span class="text-xs font-medium">Voice hostname</span>
          <input
            type="text"
            placeholder="voice.mygame.example.com"
            value={props.hostname}
            onInput={(e) => props.onHostnameChange(e.currentTarget.value)}
            class="rounded-md border border-border bg-background px-3 py-2 text-sm font-mono outline-none focus:ring-2 focus:ring-ring"
            disabled={props.submitting}
            autocomplete="off"
            spellcheck={false}
          />
          <span class="text-[11px] text-muted-foreground">
            Don't include https:// or wss:// — just the host.
          </span>
        </label>

        <Show when={props.errorMsg}>
          <div class="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {props.errorMsg}
          </div>
        </Show>

        <div class="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={props.onBack} disabled={props.submitting}>
            Back
          </Button>
          <Button type="submit" disabled={props.submitting || props.hostname.trim().length === 0}>
            {props.submitting ? "Applying…" : "Apply"}
          </Button>
        </div>
      </div>
    </form>
  );
}

function PortsSuccess(props: {
  hostname: string;
  testState: "idle" | "running" | "passed" | "failed";
  testMessage: string | null;
  onTest: () => void;
  onContinue: () => void;
}) {
  return (
    <>
      <DialogHeader class="p-6 pb-2">
        <DialogTitle>Verify the connection</DialogTitle>
        <DialogDescription>
          The runtime is restarting with{" "}
          <span class="font-mono text-foreground">{props.hostname}</span>. Click{" "}
          <span class="font-medium text-foreground">Test</span> once to confirm it's reachable —
          Continue stays disabled until the probe succeeds.
        </DialogDescription>
      </DialogHeader>
      <div class="px-6 pb-2 flex items-start gap-3">
        <Lock class="size-5 text-muted-foreground shrink-0 mt-0.5" />
        <p class="text-xs text-muted-foreground">
          Container restart usually takes 2-5 seconds. If the first test fails, wait a moment
          and try again before changing anything on Cloudflare.
        </p>
      </div>
      <Show when={props.testState === "passed"}>
        <div class="mx-6 mb-2 flex items-start gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300">
          <CheckCircle2 class="size-4 shrink-0 mt-0.5" />
          <span>{props.testMessage ?? "Voice is live."}</span>
        </div>
      </Show>
      <Show when={props.testState === "failed"}>
        <div class="mx-6 mb-2 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <AlertCircle class="size-4 shrink-0 mt-0.5" />
          <span>{props.testMessage ?? "Test failed."}</span>
        </div>
      </Show>
      <div class="px-6 pb-6 pt-2 flex justify-end gap-2">
        <Button
          variant="outline"
          onClick={props.onTest}
          disabled={props.testState === "running"}
        >
          {props.testState === "running"
            ? "Testing…"
            : props.testState === "passed"
              ? "Test again"
              : props.testState === "failed"
                ? "Retry test"
                : "Test"}
        </Button>
        <Button onClick={props.onContinue} disabled={props.testState !== "passed"}>
          Continue
        </Button>
      </div>
    </>
  );
}

function PortsError(props: { message: string; onRetry: () => void; onClose: () => void }) {
  return (
    <>
      <DialogHeader class="p-6 pb-2">
        <DialogTitle>Couldn't apply hostname</DialogTitle>
        <DialogDescription>{props.message}</DialogDescription>
      </DialogHeader>
      <div class="px-6 pb-6 flex justify-end gap-2">
        <Button variant="outline" onClick={props.onClose}>
          Cancel
        </Button>
        <Button onClick={props.onRetry}>Retry</Button>
      </div>
    </>
  );
}

// Owner-only diagnostics for the spec-24 Amendment A "voice signaling works
// but media doesn't" failure mode. Shown when /health/voice reports
// externalReachability.status === "unreachable". Surfaces wanIp + per-port
// results from /admin/api/voice/state and lets the owner manually re-probe
// (POST /admin/api/voice/probe — bypasses the 60s automatic-trigger cooldown).
function ReachabilityStep(props: {
  probe: ProbeResult | null;
  probing: boolean;
  error: string | null;
  cooldownSecondsLeft: number | null;
  directProbing: boolean;
  directOutcome: DirectProbeOutcome | null;
  onRetest: () => void;
  onDirectProbe: () => void;
  onClose: () => void;
}) {
  const overallReachable = createMemo(
    () => props.probe?.rtcTcp.reachable === true && props.probe?.rtcUdp.reachable === true,
  );
  const inCooldown = createMemo(() => {
    const left = props.cooldownSecondsLeft;
    return left !== null && left > 0;
  });
  return (
    <>
      <DialogHeader class="p-6 pb-2">
        <DialogTitle>Voice ports unreachable</DialogTitle>
        <DialogDescription>
          Signaling is working, but Central can't reach this server's RTC ports
          from the public internet, so call audio won't flow. Forward these ports
          on your router to this machine, then run the test again.
        </DialogDescription>
      </DialogHeader>
      <div class="px-6 pb-2 grid gap-3">
        <Show when={props.probe}>
          {(p) => (
            <>
              <div class="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs">
                <div class="text-muted-foreground">Public IP detected by Central</div>
                <div class="font-mono text-foreground mt-0.5">{p().wanIp}</div>
              </div>
              <PortRow label="TCP 7881 (ICE-TCP fallback)" group={p().rtcTcp} />
              <PortRow label="UDP 3478 (TURN/STUN probe)" group={p().rtcUdp} />
              <DirectPathRow
                probing={props.directProbing}
                outcome={props.directOutcome}
                onProbe={props.onDirectProbe}
              />
              <Show when={!overallReachable()}>
                <ol class="text-[11px] text-muted-foreground list-decimal pl-5 space-y-1">
                  <li>
                    Open your router admin and forward these ports to{" "}
                    <span class="font-mono text-foreground/80">{p().wanIp}</span> →
                    this machine's LAN IP.
                  </li>
                  <li>
                    Confirm the runtime container is binding the same ports
                    (defaults: TCP 7881, UDP 3478 for the probe, UDP 50000
                    for media).
                  </li>
                  <li>
                    Click <span class="font-medium text-foreground">Test again</span> below.
                  </li>
                </ol>
              </Show>
              <Show when={overallReachable()}>
                <div class="flex items-start gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300">
                  <CheckCircle2 class="size-4 shrink-0 mt-0.5" />
                  <span>Both port groups are reachable — voice should work end-to-end.</span>
                </div>
              </Show>
            </>
          )}
        </Show>
        <Show when={props.probe === null && !props.error}>
          <div class="text-xs text-muted-foreground">Loading current state…</div>
        </Show>
        <Show when={props.error}>
          <div class="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <AlertCircle class="size-4 shrink-0 mt-0.5" />
            <span>{props.error}</span>
          </div>
        </Show>
        <Show when={inCooldown()}>
          <div class="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            <AlertCircle class="size-4 shrink-0 mt-0.5" />
            <span>
              Wait {props.cooldownSecondsLeft}s for UnCorded Central to allow another probe
              (per-server cooldown to keep public-internet scans polite).
            </span>
          </div>
        </Show>
      </div>
      <div class="px-6 pb-6 pt-2 flex justify-end gap-2">
        <Button variant="outline" onClick={props.onClose}>
          Close
        </Button>
        <Button onClick={props.onRetest} disabled={props.probing || inCooldown()}>
          {props.probing
            ? "Testing…"
            : inCooldown()
              ? `Test again (${String(props.cooldownSecondsLeft)}s)`
              : "Test again"}
        </Button>
      </div>
    </>
  );
}

// Spec-24 Amendment C — UDP 50000 direct-path probe row. The cold-STUN probe
// on 3478 confirms voice will *work*, but cannot tell the owner whether each
// call ends up on the fast direct UDP path or the TURN/TCP fallback. This row
// runs a one-shot client-side ICE check and reports the actual path their
// callers will take (host/srflx UDP = direct, relay = TURN, TCP = fallback).
//
// Marked Recommended (not Required) because TURN/TCP fallbacks all work — UDP
// 50000 is purely a latency/quality optimization. Owners with the required
// pair (7881 + 3478) reachable will still have a working channel even if
// 50000 is blocked.
function DirectPathRow(props: {
  probing: boolean;
  outcome: DirectProbeOutcome | null;
  onProbe: () => void;
}) {
  const tone = createMemo(() => {
    const o = props.outcome;
    if (!o) return "idle";
    if (o.kind === "direct") return "good";
    if (o.kind === "relayed" || o.kind === "tcp") return "warn";
    return "bad";
  });
  const detail = createMemo(() => {
    const o = props.outcome;
    if (!o) return null;
    switch (o.kind) {
      case "direct":
        return `Direct UDP path negotiated (local port ${String(o.localPort)}). Callers will get the lowest-latency route.`;
      case "relayed":
        return `${o.reason}. Calls work but route through LiveKit's TURN relay — adds latency. Forward UDP 50000 on your router for the fast direct path.`;
      case "tcp":
        return "ICE fell back to TCP. Calls work but UDP is blocked end-to-end — forward UDP 50000 on your router for the fast direct path.";
      case "no-pair":
        return `${o.reason}. ICE didn't converge — voice may be unstable.`;
      case "error":
        return o.reason;
    }
  });
  return (
    <div class="rounded-md border border-border bg-card px-3 py-2 text-xs">
      <div class="flex items-start gap-2">
        <Show
          when={tone() === "good"}
          fallback={
            <Show
              when={tone() === "bad"}
              fallback={
                <Network
                  class={
                    tone() === "warn"
                      ? "size-4 shrink-0 mt-0.5 text-amber-500"
                      : "size-4 shrink-0 mt-0.5 text-muted-foreground"
                  }
                />
              }
            >
              <AlertCircle class="size-4 shrink-0 mt-0.5 text-destructive" />
            </Show>
          }
        >
          <CheckCircle2 class="size-4 shrink-0 mt-0.5 text-emerald-500" />
        </Show>
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2 flex-wrap">
            <span class="font-medium text-foreground">UDP 50000 (direct media path)</span>
            <span class="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
              Recommended
            </span>
          </div>
          <Show
            when={detail()}
            fallback={
              <div class="text-muted-foreground mt-0.5">
                Probe verifies calls take the fast direct UDP path instead of falling back to TURN/TCP.
              </div>
            }
          >
            <div
              class={
                tone() === "good"
                  ? "text-emerald-700 dark:text-emerald-300 mt-0.5"
                  : tone() === "warn"
                    ? "text-amber-700 dark:text-amber-300 mt-0.5"
                    : tone() === "bad"
                      ? "text-destructive mt-0.5"
                      : "text-muted-foreground mt-0.5"
              }
            >
              {detail()}
            </div>
          </Show>
        </div>
        <Button
          size="sm"
          variant="outline"
          class="shrink-0"
          onClick={props.onProbe}
          disabled={props.probing}
        >
          {props.probing ? "Testing…" : props.outcome ? "Re-test" : "Test direct path"}
        </Button>
      </div>
    </div>
  );
}

function PortRow(props: { label: string; group: PortGroup }) {
  return (
    <div class="flex items-start gap-2 rounded-md border border-border bg-card px-3 py-2 text-xs">
      <Show
        when={props.group.reachable}
        fallback={<AlertCircle class="size-4 shrink-0 mt-0.5 text-destructive" />}
      >
        <CheckCircle2 class="size-4 shrink-0 mt-0.5 text-emerald-500" />
      </Show>
      <div class="flex-1 min-w-0">
        <div class="font-medium text-foreground">{props.label}</div>
        <div class="text-muted-foreground mt-0.5">
          <Show
            when={props.group.reachable}
            fallback={
              <span>
                Unreachable
                {props.group.error ? ` — ${props.group.error}` : ""}
              </span>
            }
          >
            <span>
              Reachable
              {props.group.latencyMs !== null
                ? ` · ${String(Math.round(props.group.latencyMs))}ms`
                : ""}
            </span>
          </Show>
        </div>
      </div>
    </div>
  );
}

function isPortGroup(v: unknown): v is PortGroup {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o["reachable"] === "boolean" &&
    (typeof o["latencyMs"] === "number" || o["latencyMs"] === null) &&
    (typeof o["error"] === "string" || o["error"] === null)
  );
}

function parseProbeResult(raw: unknown): ProbeResult | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r["status"] !== "ready" && r["status"] !== "unreachable") return null;
  if (typeof r["checkedAt"] !== "string" || typeof r["wanIp"] !== "string") return null;
  if (!isPortGroup(r["rtcTcp"]) || !isPortGroup(r["rtcUdp"])) return null;
  return {
    status: r["status"],
    checkedAt: r["checkedAt"],
    wanIp: r["wanIp"],
    rtcTcp: r["rtcTcp"],
    rtcUdp: r["rtcUdp"],
  };
}

// Reads a cooldown duration from a 429 response. Prefers the body's
// `error.retryAfterMs` (millisecond precision) and falls back to the
// `Retry-After` header (RFC-spec seconds). Returns null when the response
// isn't a recognizable cooldown — caller should fall back to generic error
// rendering. Tolerates body re-read failure.
async function readCooldownRetryAfter(res: Response): Promise<number | null> {
  if (res.status !== 429) return null;
  try {
    const body = (await res.clone().json()) as {
      error?: { code?: string; retryAfterMs?: unknown };
    };
    if (body.error?.code === "VOICE_PROBE_COOLDOWN") {
      const ms = body.error.retryAfterMs;
      if (typeof ms === "number" && Number.isFinite(ms) && ms > 0) return ms;
    }
  } catch {
    // fall through to header
  }
  const header = res.headers.get("retry-after");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  }
  return null;
}

function parseAdminReachability(raw: unknown): ProbeResult | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o["status"] === "checking") return parseProbeResult(o["lastResult"]);
  if (o["status"] === "ready" || o["status"] === "unreachable") {
    return parseProbeResult(o["result"]);
  }
  return null;
}
