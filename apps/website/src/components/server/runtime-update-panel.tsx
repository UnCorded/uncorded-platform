// Server Settings → Danger Zone → Runtime panel.
//
// Implements `update-ux.md` §4: state-driven contextual button, channel
// switcher, backup toggle, inline UPDATE confirmation, and the off-
// orchestrator / no-permission informational variants. Wire shape and copy
// come straight from §2.1, §4.4, and §6 of that doc — keep this file in
// sync if the spec moves.
//
// Phase 1 simplifications relative to §2.1 / §4.6:
//   - `pending-confirm` is a *local* UI flag (the inline confirm form). The
//     runtime is not POSTed a pending-confirm state; only the user clicking
//     Confirm actually triggers the orchestrator. Remote clients therefore
//     don't see "owner is confirming" today — that requires a wire-level
//     change and is deferred (the spec calls it out as polish, not core).
//   - The compose-user fallback (§4.9) is not yet implemented. The runtime
//     can't currently advertise "no orchestrator ever registered" state, so
//     this branch is left as a TODO that can light up when that signal exists.

import { createSignal, createMemo, createEffect, onCleanup, For, Show, Switch, Match } from "solid-js";
import { Loader2, RefreshCw, Rocket } from "lucide-solid";
import type { RuntimeUpdateChannel, RuntimeUpdateState } from "@uncorded/protocol";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ProgressChecklist,
  type ProgressChecklistRow,
} from "@/components/ui/progress-checklist";
import { runtimeUpdateStateFor } from "@/stores/runtime-update";
import { isAdmin } from "@/stores/membership";
import { isElectron, getElectron } from "@/lib/electron";
import { showInlineStatus } from "@/lib/feedback";
import { runCinematicClose } from "@/stores/cinematic";

const CONFIRM_PHRASE = "UPDATE";

// Per spec §6 copy register.
const COPY = {
  helperUpToDate: "You're on the latest version.",
  helperAvailable: "Update available. Click to begin.",
  helperPendingConfirmWarning:
    "Connected users will be disconnected during install. Auto-rollback engages on health check failure.",
  helperBackingUp: "Snapshotting state directory…",
  helperDownloading: "Pulling",
  helperDownloaded:
    "downloaded. Connected users will be notified before drain.",
  helperAwaitingRestart:
    "Update staged. Connected users will be disconnected during install. Auto-rollback engages on health check failure.",
  helperInstalling:
    "Draining connections, swapping container, booting new version.",
  helperRollingBack:
    "Post-update health check failed. Restoring previous version.",
  helperErrorRollback:
    "Manual recovery required. See logs and the recovery runbook. Container may be in a partial state.",
  panelOffOrchWithPermission:
    "Updates can only be installed from the orchestrator (currently: desktop app). Open this server's settings on the orchestrator device to install.",
  panelOffOrchNoPermission:
    "Update available. Ask the server owner or an admin to install.",
  confirmPlaceholder: "Type UPDATE to confirm",
  confirmButton: "Confirm",
  confirmCancel: "Cancel",
  backupLabel: "Snapshot state before update",
  backupHelper:
    "Restored automatically if the update fails. Adds ~5–30s to update duration.",
} as const;

function relativeTime(ms: number | null): string {
  if (ms === null) return "never";
  const diffMs = Date.now() - ms;
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 30) return "just now";
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}

// States during which the channel switcher and refresh button must be
// disabled — operator should not be able to change the rails mid-update.
function isInFlight(state: RuntimeUpdateState): boolean {
  switch (state.state) {
    case "checking":
    case "backing-up":
    case "downloading":
    // `awaiting-restart` is a hard pause, but the staged image is on disk
    // and the orchestrator will progress past it the moment the user clicks
    // Restart. Treat it as in-flight so the operator can't change the
    // channel or trigger a new check while a staged update is sitting.
    case "awaiting-restart":
    case "installing":
    case "rolling-back":
      return true;
    default:
      return false;
  }
}

// Friendly headline copy for each error context. The raw `errorMessage` from
// the runtime is never dumped inline — it lands inside the collapsible
// "Show details" disclosure so 404 JSON or stack traces don't bleed into
// the panel chrome.
function errorHeadline(state: RuntimeUpdateState): string {
  // Special-case the most common transient: GitHub Releases returns 404
  // when there's no published version on this channel yet. That isn't a
  // real failure for a fresh runtime — phrase it as such.
  const msg = state.errorMessage ?? "";
  if (state.errorContext === "check" && /\b404\b/.test(msg)) {
    return "No releases published yet for this channel.";
  }
  switch (state.errorContext) {
    case "check":
      return "Couldn't reach the update server.";
    case "backup":
      return "Snapshot before update failed.";
    case "download":
      return "Couldn't pull the new image.";
    case "install":
      return "Drain or swap failed.";
    case "rollback":
      return COPY.helperErrorRollback;
    default:
      return "Update failed.";
  }
}

// Sheet close animation duration in ms — must match `data-[closed]:duration-300`
// on the underlying Radix Dialog.Content in `components/ui/sheet.tsx`. We wait
// this long after `onBeforeRestart()` (which closes the sheet) before kicking
// off the cinematic, so the user sees: settings sheet slides closed → workspace
// CRT-collapses → loading overlay. Without the wait the cinematic starts under
// a still-visible sheet and the close looks chaotic.
const SHEET_CLOSE_DURATION_MS = 300;

export function RuntimeUpdatePanel(props: {
  serverId: string;
  /** Invoked when the user clicks "Restart to apply update". Lets the parent
   *  (typically the server-settings sheet) collapse its own UI before the
   *  cinematic fires, so the post-restart view is the clean Server UI rather
   *  than mid-sheet-close-mid-CRT-shutdown chrome. */
  onBeforeRestart?: () => void;
}) {
  const state = runtimeUpdateStateFor(props.serverId);

  // Orchestrator capability is per-runtime (desktop today). Web/mobile clients
  // never advertise it. We probe once on mount; the result is stable for the
  // session so a signal is fine.
  const [isOrch, setIsOrch] = createSignal(false);
  // Channel + backup prefs — the renderer reads channel from WS state but we
  // need an authoritative initial value for the orchestrator-side backup
  // toggle. Loaded once on mount; subsequent toggles round-trip through IPC.
  const [backupOn, setBackupOn] = createSignal(true);
  const [prefsLoaded, setPrefsLoaded] = createSignal(false);

  // Local UI flag for the inline UPDATE confirmation (§4.6). Not synced to
  // the runtime in Phase 1.
  const [confirming, setConfirming] = createSignal(false);
  const [confirmText, setConfirmText] = createSignal("");
  // Action-in-flight latch — covers the period between the user clicking
  // Confirm and the runtime broadcasting `backing-up`. Without this the
  // button momentarily reverts to "Update to vX.Y.Z" while the IPC awaits.
  const [submitting, setSubmitting] = createSignal(false);

  // Permission gate — D5: `core.runtime.update` defaults to admin (level 80).
  // Owner is admin too, so isAdmin() captures both.
  const hasPermission = isAdmin;

  // Cancellation flag for async work spawned from this component scope.
  let cancelled = false;
  onCleanup(() => { cancelled = true; });

  // Probe orchestrator capability + load prefs on mount. We re-run when the
  // server changes (panel re-renders with a new serverId).
  createEffect(() => {
    const id = props.serverId;
    if (!isElectron()) {
      setIsOrch(false);
      setPrefsLoaded(true);
      return;
    }
    const electron = getElectron();
    void (async () => {
      try {
        const orch = await electron.runtimeUpdate.isOrchestrator();
        if (cancelled) return;
        setIsOrch(orch);
      } catch (err) {
        console.warn("[runtime-update-panel] isOrchestrator failed", err);
      }
      try {
        const prefs = await electron.runtimeUpdate.getPreferences(id);
        if (cancelled) return;
        setBackupOn(prefs.backupBeforeUpdate);
      } catch (err) {
        console.warn("[runtime-update-panel] getPreferences failed", err);
      } finally {
        if (!cancelled) setPrefsLoaded(true);
      }
    })();
  });

  // Auto-clear the confirm form when state leaves `available` (e.g. another
  // client kicked off the update, or the orchestrator advanced).
  createEffect(() => {
    const s = state();
    if (!s) return;
    if (s.state !== "available" && confirming()) {
      setConfirming(false);
      setConfirmText("");
    }
  });

  const canAct = createMemo(() => isOrch() && hasPermission());

  async function onManualCheck(): Promise<void> {
    if (!isElectron()) return;
    try {
      const outcome = await getElectron().runtimeUpdate.checkForUpdate(props.serverId);
      // Runtime enforces 1/30s per server; surface the throttle so the user
      // isn't left wondering why the spinner did nothing. Anything else
      // resolves into a WS broadcast, which the panel renders directly.
      if (!outcome.ok && outcome.reason === "rate-limited") {
        showInlineStatus("Just checked — try again in a moment.", "info");
      }
    } catch (err) {
      console.error("[runtime-update-panel] checkForUpdate failed", err);
      showInlineStatus("Couldn't trigger update check.", "error");
    }
  }

  async function onChannelChange(next: RuntimeUpdateChannel): Promise<void> {
    if (!isElectron()) return;
    try {
      await getElectron().runtimeUpdate.setChannel(props.serverId, next);
    } catch (err) {
      console.error("[runtime-update-panel] setChannel failed", err);
      showInlineStatus("Couldn't change update channel.", "error");
    }
  }

  async function onBackupToggle(next: boolean): Promise<void> {
    if (!isElectron()) return;
    setBackupOn(next);
    try {
      await getElectron().runtimeUpdate.setBackupBeforeUpdate(props.serverId, next);
    } catch (err) {
      console.error("[runtime-update-panel] setBackupBeforeUpdate failed", err);
      // Revert optimistic toggle on failure — the registry write didn't land.
      setBackupOn(!next);
      showInlineStatus("Couldn't save backup preference.", "error");
    }
  }

  async function onConfirmInstall(): Promise<void> {
    if (!isElectron() || submitting()) return;
    setSubmitting(true);
    try {
      const outcome = await getElectron().runtimeUpdate.performUpdate(props.serverId);
      if (cancelled) return;
      if (outcome.ok) {
        showInlineStatus(`Updated to v${outcome.version}.`, "info");
      } else {
        showInlineStatus(
          `Update failed during ${outcome.phase}: ${outcome.reason}`,
          "error",
        );
      }
    } catch (err) {
      console.error("[runtime-update-panel] performUpdate failed", err);
      showInlineStatus("Couldn't start the update. See logs for details.", "error");
    } finally {
      if (!cancelled) {
        setSubmitting(false);
        setConfirming(false);
        setConfirmText("");
      }
    }
  }

  // "Restart to apply update" — runs in three serialized steps:
  //   1. Notify parent (typically server-settings sheet) to collapse, then
  //      wait for the sheet close animation. Without this the cinematic
  //      starts under a still-visible sheet and the user lands post-restart
  //      with the settings panel still hanging in the layout.
  //   2. Cinematic shutdown (CRT collapse, 750ms).
  //   3. Fire confirmRestart IPC, which flips the runtime to `installing`.
  //
  // Earlier we ran the IPC and the cinematic in parallel to avoid a dead-time
  // window, but the IPC + WS roundtrip (~150-400ms) is faster than the 750ms
  // shutdown, so the post-update overlay was fading in over a still-mid-
  // animation workspace. Re-serializing relies on the cinematic-backdrop
  // layer (z-150) — fully opaque by the end of the close — to paint the brief
  // gap between cinematic-settled and overlay-fade-in.
  //
  // CRITICAL: do NOT `if (cancelled) return` between user-commit and the IPC.
  // `onBeforeRestart` closes the parent sheet; Kobalte unmounts Dialog.Content
  // after its 300ms close animation, which fires onCleanup → cancelled=true.
  // Once the user has clicked Restart we MUST drive the IPC to completion or
  // the runtime never flips to `installing`, the WS broadcast never fires,
  // and the post-update overlay never mounts (observed live in v0.0.21:
  // sheet closed, screen collapsed, then nothing).
  async function onRestart(): Promise<void> {
    if (!isElectron()) return;
    const serverId = props.serverId;
    if (props.onBeforeRestart) {
      props.onBeforeRestart();
      await new Promise((r) => setTimeout(r, SHEET_CLOSE_DURATION_MS));
    }
    await runCinematicClose();
    try {
      await getElectron().runtimeUpdate.confirmRestart(serverId);
    } catch (err) {
      console.error("[runtime-update-panel] confirmRestart failed", err);
      // Panel may already be unmounted — Solid signals tolerate writes
      // after dispose (no-op), and the user won't see the inline status
      // anyway in that case. Logged either way for debugging.
      showInlineStatus("Couldn't apply the staged update.", "error");
    }
  }

  async function onRetry(): Promise<void> {
    const s = state();
    if (!s || s.state !== "error") return;
    if (s.errorContext === "rollback") return;
    // `check` errors restart the check; backup/download errors re-enter the
    // install path. The orchestrator's performUpdate handles backup +
    // download internally so reusing it is correct for both.
    if (s.errorContext === "check") {
      await onManualCheck();
    } else {
      await onConfirmInstall();
    }
  }

  return (
    <Show when={state()} fallback={<RuntimePanelLoading />}>
      {(s) => (
        <section class="space-y-2 rounded-lg border border-border/60 bg-card/40 p-2.5">
          <RuntimeHeader
            state={s()}
            disabled={isInFlight(s()) || !isElectron()}
            onRefresh={() => void onManualCheck()}
          />

          <UpdatePhaseChecklist state={s()} />

          <ActionSlot
            state={s()}
            canAct={canAct()}
            confirming={confirming()}
            confirmText={confirmText()}
            submitting={submitting()}
            onUpdate={() => {
              setConfirming(true);
              setConfirmText("");
            }}
            onConfirmTextChange={setConfirmText}
            onConfirm={() => void onConfirmInstall()}
            onCancel={() => {
              setConfirming(false);
              setConfirmText("");
            }}
            onInstall={() => void onConfirmInstall()}
            onRestart={() => void onRestart()}
            onRetry={() => void onRetry()}
          />

          <OffOrchestratorNotice
            state={s()}
            isOrchestrator={isOrch()}
            hasPermission={hasPermission()}
          />

          {/* Advanced disclosure — channel + backup toggle live behind a
            * twisty so the resting-state panel stays uncluttered. Operator
            * only opens it when they need to flip something. */}
          <Show when={canAct() && prefsLoaded()}>
            <details class="group rounded-md border border-border/40 bg-background/40">
              <summary class="cursor-pointer list-none px-2 py-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground">
                <span class="mr-1 inline-block transition-transform group-open:rotate-90">›</span>
                Advanced
              </summary>
              <div class="space-y-2 border-t border-border/40 p-2">
                <RuntimeChannel
                  state={s()}
                  disabled={isInFlight(s())}
                  onChange={(next) => void onChannelChange(next)}
                />
                <Show when={s().state === "available" || s().state === "up-to-date" || s().state === "idle"}>
                  <BackupToggleRow
                    checked={backupOn()}
                    onChange={(next) => void onBackupToggle(next)}
                  />
                </Show>
              </div>
            </details>
          </Show>
        </section>
      )}
    </Show>
  );
}

function RuntimePanelLoading() {
  return (
    <div class="flex items-center justify-center rounded-lg border border-border bg-card p-6">
      <Loader2 class="size-4 animate-spin text-muted-foreground" />
    </div>
  );
}

function RuntimeHeader(props: {
  state: RuntimeUpdateState;
  disabled: boolean;
  onRefresh: () => void;
}) {
  return (
    <div class="flex items-start justify-between gap-2">
      <div class="flex flex-col gap-0.5 min-w-0">
        <div class="flex items-center gap-1.5">
          <Rocket class="size-3.5 text-muted-foreground shrink-0" />
          <span class="text-sm font-semibold text-foreground">Runtime</span>
        </div>
        <code class="text-[11px] text-muted-foreground font-mono truncate" data-tooltip={props.state.currentVersion}>
          v{props.state.currentVersion}
        </code>
        <div class="flex items-center gap-1 text-[10px] text-muted-foreground/80">
          <span>Checked {relativeTime(props.state.lastCheckedAt)}</span>
          <button
            type="button"
            class="flex size-4 items-center justify-center rounded text-muted-foreground/70 transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
            onClick={() => props.onRefresh()}
            disabled={props.disabled}
            aria-label="Check for updates now"
            data-tooltip="Check for updates now"
          >
            <RefreshCw class="size-2.5" classList={{ "animate-spin": props.state.state === "checking" }} />
          </button>
        </div>
      </div>
      <span class="rounded-full border border-border bg-muted/50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground shrink-0">
        {props.state.channel}
      </span>
    </div>
  );
}

const CHANNELS: ReadonlyArray<{ value: RuntimeUpdateChannel; label: string }> = [
  { value: "stable", label: "Stable" },
  { value: "beta", label: "Beta" },
  { value: "dev", label: "Dev" },
];

function RuntimeChannel(props: {
  state: RuntimeUpdateState;
  disabled: boolean;
  onChange: (next: RuntimeUpdateChannel) => void;
}) {
  return (
    <div class="flex items-center gap-2">
      <label class="text-[11px] text-muted-foreground">Update channel</label>
      <select
        class="rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
        value={props.state.channel}
        disabled={props.disabled}
        onChange={(e) => {
          const next = e.currentTarget.value as RuntimeUpdateChannel;
          if (next !== props.state.channel) props.onChange(next);
        }}
      >
        <For each={CHANNELS}>
          {(c) => <option value={c.value}>{c.label}</option>}
        </For>
      </select>
    </div>
  );
}

function BackupToggleRow(props: {
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label class="flex cursor-pointer items-start gap-2 rounded-md border border-dashed border-border p-2">
      <input
        type="checkbox"
        class="mt-0.5 size-4 cursor-pointer"
        checked={props.checked}
        onChange={(e) => props.onChange(e.currentTarget.checked)}
      />
      <div class="flex flex-col gap-0.5">
        <span class="text-xs font-medium text-foreground">{COPY.backupLabel}</span>
        <span class="text-[11px] text-muted-foreground">{COPY.backupHelper}</span>
      </div>
    </label>
  );
}

// Phase checklist rendered above the call-to-action while an update is
// actively in flight. This is the *primary* surface for backup / download /
// downloaded — the post-update overlay only takes over once state reaches
// `installing` (the irreversible phase the user opted into). So the
// operator keeps the workspace usable while bytes come down and watches
// progress here.
//
// Row state derives from `state.state` alone: only the *current* phase is
// in_progress, prior phases are done, future phases are pending. Per spec
// the orchestrator may skip the backup row when the toggle is off, so we
// only render the backup row when the runtime is actually in `backing-up`.
// Once we move past it we can't reliably know whether backup happened, so
// we drop the row to avoid lying to the operator. The active row's
// `detail` is populated from `state.substep` when the runtime exposes one.
function UpdatePhaseChecklist(props: { state: RuntimeUpdateState }) {
  const rows = (): ProgressChecklistRow[] => {
    const s = props.state;
    const v = s.availableVersion ?? "?";
    // Optional one-line detail surfaced from the runtime; harmless
    // (undefined) on older runtimes that don't emit substeps.
    const sub = s.substep ?? undefined;
    const out: ProgressChecklistRow[] = [];
    switch (s.state) {
      case "backing-up":
        out.push({
          key: "backup",
          label: "Back up state",
          status: "in_progress",
          startedAt: s.updatedAt,
          detail: sub,
        });
        out.push({ key: "download", label: `Download v${v}`, status: "pending" });
        out.push({ key: "install", label: `Install v${v}`, status: "pending" });
        break;
      case "downloading":
        out.push({
          key: "download",
          label: `Download v${v}`,
          status: "in_progress",
          percent: s.progress !== null ? s.progress / 100 : null,
          startedAt: s.updatedAt,
          detail: sub,
        });
        out.push({ key: "install", label: `Install v${v}`, status: "pending" });
        break;
      case "downloaded":
        out.push({ key: "download", label: `Download v${v}`, status: "done" });
        out.push({ key: "install", label: `Install v${v}`, status: "pending" });
        break;
      case "awaiting-restart":
        out.push({ key: "download", label: `Download v${v}`, status: "done" });
        out.push({
          key: "install",
          label: `Install v${v}`,
          status: "pending",
          detail: sub ?? "Ready to restart",
        });
        break;
      case "installing":
        out.push({ key: "download", label: `Download v${v}`, status: "done" });
        out.push({
          key: "install",
          label: `Install v${v}`,
          status: "in_progress",
          startedAt: s.updatedAt,
          detail: sub,
        });
        break;
      case "rolling-back":
        out.push({
          key: "rollback",
          label: `Roll back to v${s.currentVersion}`,
          status: "in_progress",
          startedAt: s.updatedAt,
          detail: sub,
        });
        break;
      default:
        return [];
    }
    return out;
  };

  return (
    <Show when={rows().length > 0}>
      <ProgressChecklist rows={rows} />
    </Show>
  );
}

function ActionSlot(props: {
  state: RuntimeUpdateState;
  canAct: boolean;
  confirming: boolean;
  confirmText: string;
  submitting: boolean;
  onUpdate: () => void;
  onConfirmTextChange: (s: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
  onInstall: () => void;
  onRestart: () => void;
  onRetry: () => void;
}) {
  return (
    <div class="flex flex-col gap-1.5">
      <Switch>
        <Match when={props.state.state === "up-to-date"}>
          <p class="text-xs text-muted-foreground">{COPY.helperUpToDate}</p>
        </Match>

        <Match when={props.state.state === "available" && !props.confirming && props.canAct}>
          <Button
            size="sm"
            class="bg-amber-500 text-amber-50 hover:bg-amber-500/90"
            onClick={() => props.onUpdate()}
          >
            Update to v{props.state.availableVersion ?? "?"}
          </Button>
          <p class="text-[11px] text-muted-foreground">{COPY.helperAvailable}</p>
        </Match>

        <Match when={props.state.state === "available" && props.confirming && props.canAct}>
          <ConfirmForm
            text={props.confirmText}
            submitting={props.submitting}
            onTextChange={props.onConfirmTextChange}
            onConfirm={props.onConfirm}
            onCancel={props.onCancel}
          />
        </Match>

        <Match when={props.state.state === "backing-up"}>
          <Button size="sm" class="bg-sky-500 text-sky-50" disabled>
            Backing up…
          </Button>
          <p class="text-[11px] text-muted-foreground">{COPY.helperBackingUp}</p>
        </Match>

        <Match when={props.state.state === "downloading"}>
          <Button size="sm" class="bg-sky-500 text-sky-50" disabled>
            Downloading
            <Show when={props.state.progress !== null}>{` ${props.state.progress}%`}</Show>
            …
          </Button>
          <p class="text-[11px] text-muted-foreground">
            {COPY.helperDownloading} v{props.state.availableVersion ?? "?"}.
          </p>
        </Match>

        <Match when={props.state.state === "downloaded" && props.canAct}>
          <Button
            size="sm"
            class="bg-emerald-500 text-emerald-50 hover:bg-emerald-500/90"
            disabled={props.submitting}
            onClick={() => props.onInstall()}
          >
            {props.submitting ? "Installing…" : "Install now"}
          </Button>
          <p class="text-[11px] text-muted-foreground">
            v{props.state.availableVersion ?? "?"} {COPY.helperDownloaded}
          </p>
        </Match>

        <Match when={props.state.state === "awaiting-restart" && props.canAct}>
          {/* Hard-pause gate. Bytes are on disk + cosign-verified; the user
              clicks Restart to opt into the irreversible install phase. The
              click triggers the cinematic outside-in collapse, then resolves
              the orchestrator's pending Deferred so performUpdate progresses
              to `state: "installing"` (the dark overlay takes over from
              there). */}
          <Button
            size="sm"
            autofocus
            class="w-full bg-emerald-500 text-emerald-50 hover:bg-emerald-500/90"
            onClick={() => props.onRestart()}
          >
            Restart to apply update
          </Button>
          <p class="text-[11px] text-muted-foreground">{COPY.helperAwaitingRestart}</p>
        </Match>

        <Match when={props.state.state === "awaiting-restart" && !props.canAct}>
          <p class="text-xs text-muted-foreground">
            v{props.state.availableVersion ?? "?"} is staged. The orchestrator
            (desktop app) will apply it on Restart.
          </p>
        </Match>

        <Match when={props.state.state === "installing"}>
          <Button size="sm" class="bg-sky-500 text-sky-50" disabled>
            Installing…
          </Button>
          <p class="text-[11px] text-muted-foreground">{COPY.helperInstalling}</p>
        </Match>

        <Match when={props.state.state === "rolling-back"}>
          <Button size="sm" class="bg-red-500 text-red-50" disabled>
            Rolling back…
          </Button>
          <p class="text-[11px] text-muted-foreground">{COPY.helperRollingBack}</p>
        </Match>

        <Match when={props.state.state === "error" && props.state.errorContext === "rollback"}>
          <p class="text-xs text-destructive">{COPY.helperErrorRollback}</p>
          <ErrorDetails message={props.state.errorMessage} />
        </Match>

        <Match when={props.state.state === "error" && props.canAct}>
          <Button
            size="sm"
            variant="outline"
            class="border-amber-500/40 text-amber-700 hover:bg-amber-500/10 dark:text-amber-300"
            disabled={props.submitting}
            onClick={() => props.onRetry()}
          >
            <RefreshCw class="size-3" classList={{ "animate-spin": props.submitting }} />
            {props.submitting ? "Retrying…" : "Retry"}
          </Button>
          <p class="text-[11px] text-muted-foreground">{errorHeadline(props.state)}</p>
          <ErrorDetails message={props.state.errorMessage} />
        </Match>

        <Match when={props.state.state === "error" && !props.canAct}>
          <p class="text-xs text-muted-foreground">{errorHeadline(props.state)}</p>
          <ErrorDetails message={props.state.errorMessage} />
        </Match>
      </Switch>
    </div>
  );
}

function ConfirmForm(props: {
  text: string;
  submitting: boolean;
  onTextChange: (s: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const matches = () => props.text.trim() === CONFIRM_PHRASE;
  return (
    <div class="space-y-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-2.5">
      <p class="text-[11px] text-amber-700 dark:text-amber-300">
        {COPY.helperPendingConfirmWarning}
      </p>
      <Input
        type="text"
        autofocus
        class="h-7 text-xs"
        placeholder={COPY.confirmPlaceholder}
        value={props.text}
        onInput={(e) => props.onTextChange(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && matches() && !props.submitting) {
            e.preventDefault();
            props.onConfirm();
          }
        }}
        disabled={props.submitting}
      />
      <div class="flex gap-2">
        <Button
          size="sm"
          variant="outline"
          class="flex-1 h-7"
          disabled={props.submitting}
          onClick={() => props.onCancel()}
        >
          {COPY.confirmCancel}
        </Button>
        <Button
          size="sm"
          class="flex-1 h-7 min-w-0 bg-amber-500 text-amber-50 hover:bg-amber-500/90"
          disabled={!matches() || props.submitting}
          onClick={() => props.onConfirm()}
        >
          <span class="truncate">
            {props.submitting ? "Starting…" : `${COPY.confirmButton} install`}
          </span>
        </Button>
      </div>
    </div>
  );
}

// Collapsible "Show details" disclosure for the raw `errorMessage` from the
// runtime. The headline copy in `errorHeadline` is what the operator sees by
// default; the raw message (HTTP status, stack frame, docker pull output) is
// useful when filing a bug but would otherwise dump garbage into the panel
// chrome — we keep it tucked away.
function ErrorDetails(props: { message: string | null }) {
  return (
    <Show when={props.message && props.message.length > 0}>
      <details class="group">
        <summary class="cursor-pointer list-none text-[10px] font-medium text-muted-foreground/70 transition-colors hover:text-foreground">
          <span class="mr-1 inline-block transition-transform group-open:rotate-90">›</span>
          Show details
        </summary>
        <pre class="mt-1 max-h-32 overflow-auto rounded border border-border/40 bg-muted/30 px-2 py-1.5 text-[10px] font-mono text-muted-foreground whitespace-pre-wrap break-words">
          {props.message}
        </pre>
      </details>
    </Show>
  );
}

function OffOrchestratorNotice(props: {
  state: RuntimeUpdateState;
  isOrchestrator: boolean;
  hasPermission: boolean;
}) {
  // Only show the informational notice when there's something actionable to
  // talk about and the local user can't act. During clean states (idle,
  // up-to-date, checking) the panel header copy already covers it.
  const shouldShow = () => {
    const s = props.state.state;
    if (props.isOrchestrator && props.hasPermission) return false;
    return (
      s === "available" ||
      s === "downloaded" ||
      (s === "error" && props.state.errorContext !== "rollback")
    );
  };

  return (
    <Show when={shouldShow()}>
      <div class="rounded-md border border-border bg-muted/40 p-2">
        <p class="text-[11px] text-muted-foreground">
          {props.hasPermission
            ? COPY.panelOffOrchWithPermission
            : COPY.panelOffOrchNoPermission}
        </p>
      </div>
    </Show>
  );
}
