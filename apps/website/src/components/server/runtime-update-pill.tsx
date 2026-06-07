// Per-server runtime update pill — surfaces the orchestrator-driven update
// state next to the active server in the sidebar. Per `update-ux.md` §3.4
// the pill is universal: it renders for every member regardless of role or
// orchestrator status. The action gating happens inside the Danger Zone
// panel (§4.5), not here.
//
// Rendering rules come straight from `update-ux.md` §2.1:
//   - Hidden for `disabled` | `idle` | `checking` | `up-to-date`
//   - Visible (with state-specific color/tooltip) for the seven action states
//
// Click navigates the user to Server Settings → Danger Zone where the panel
// (Stage 6d) renders state-driven UI. Today there's no `/servers/:id/settings`
// route yet — Stage 2.5 in plan.md — so the pill emits a settings-events
// request that the sidebar picks up to open the existing settings sheet on
// the danger tab. When the route ships, swap the emit for `useNavigate`.

import { Show } from "solid-js";
import { Rocket } from "lucide-solid";
import type { RuntimeUpdateState, RuntimeUpdateStatus } from "@uncorded/protocol";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { runtimeUpdateStateFor } from "@/stores/runtime-update";
import { emitServerSettingsOpen } from "@/lib/server-settings-events";

const HIDDEN_STATES: ReadonlySet<RuntimeUpdateStatus> = new Set([
  "disabled",
  "idle",
  "checking",
  "up-to-date",
]);

function shouldRender(state: RuntimeUpdateState | null): state is RuntimeUpdateState {
  if (!state) return false;
  return !HIDDEN_STATES.has(state.state);
}

// Reactive visibility predicate for callers that need to swap the pill for
// another indicator (e.g. the server-switcher dropdown hides the Wifi/WifiOff
// chip while the pill is showing). Wraps the per-server store accessor so the
// caller doesn't have to duplicate the HIDDEN_STATES list.
export function runtimeUpdatePillVisible(serverId: string): () => boolean {
  const state = runtimeUpdateStateFor(serverId);
  return () => shouldRender(state());
}

function tooltipLabel(state: RuntimeUpdateState): string {
  const v = state.availableVersion ?? "—";
  // Optional phase detail surfaced once Phase 2 of the runtime ships
  // substep instrumentation. Older runtimes leave this undefined/null and
  // the tooltip falls back to the bare phase copy below.
  const sub = state.substep ?? null;
  switch (state.state) {
    case "available":
      return `Update available — v${v}`;
    case "pending-confirm":
      return `Confirm to install v${v}`;
    case "backing-up":
      return sub ? `Backing up — ${sub}` : "Backing up before update…";
    case "downloading": {
      const pct = state.progress;
      const base =
        pct === null
          ? `Downloading v${v}…`
          : `Downloading v${v} — ${pct}%`;
      return sub ? `${base} (${sub})` : base;
    }
    case "downloaded":
      return `v${v} ready to install`;
    case "installing":
      return sub ? `Installing v${v} — ${sub}` : `Installing v${v}…`;
    case "rolling-back":
      return sub ? `Rolling back — ${sub}` : "Update failed — rolling back";
    case "error":
      switch (state.errorContext) {
        case "check":
          return "Couldn't check for updates. Click for details.";
        case "backup":
          return "Backup failed. Click for details.";
        case "download":
          return "Download failed. Click for details.";
        case "install":
          return "Install failed. Click for details.";
        case "rollback":
          return "Rollback failed — manual recovery required";
        default:
          return state.errorMessage ?? "Update error. Click for details.";
      }
    default:
      return "";
  }
}

// Color buckets per the `update-ux.md` §2.1 table. Returned as classList-ready
// keys so SolidJS can flip them reactively when the state changes.
function colorClasses(state: RuntimeUpdateState): Record<string, boolean> {
  const s = state.state;
  return {
    "text-amber-500 animate-update-pulse":
      s === "available" || s === "pending-confirm",
    "text-sky-400 animate-update-pulse":
      s === "backing-up" || s === "downloading" || s === "installing",
    "text-emerald-500": s === "downloaded",
    "text-red-400 animate-update-pulse": s === "rolling-back",
    "text-red-400":
      s === "error" &&
      (state.errorContext === "check" ||
        state.errorContext === "backup" ||
        state.errorContext === "download" ||
        state.errorContext === "install" ||
        state.errorContext === "rollback"),
  };
}

export function RuntimeUpdatePill(props: { serverId: string }) {
  const state = runtimeUpdateStateFor(props.serverId);

  return (
    <Show when={shouldRender(state()) ? state() : null}>
      {(s) => (
        <Tooltip>
          <TooltipTrigger
            type="button"
            class="flex size-5 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent"
            classList={colorClasses(s())}
            onClick={(e) => {
              // The pill lives inside an interactive container (e.g. the
              // server-switcher dropdown trigger). Stop propagation so the
              // click only opens settings — it shouldn't also expand the
              // dropdown menu it lives in.
              e.stopPropagation();
              emitServerSettingsOpen("danger");
            }}
            aria-label={tooltipLabel(s())}
          >
            <Rocket class="size-3" />
          </TooltipTrigger>
          <TooltipContent side="bottom">{tooltipLabel(s())}</TooltipContent>
        </Tooltip>
      )}
    </Show>
  );
}
