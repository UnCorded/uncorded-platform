import { Show } from "solid-js";
import { Rocket } from "lucide-solid";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { updateState, type UpdateState } from "@/stores/update-store";
import { getElectron, isElectron } from "@/lib/electron";

function tooltipLabel(state: UpdateState): string {
  switch (state.status) {
    case "available":
      return state.availableVersion
        ? `Update v${state.availableVersion} available — click to download`
        : "Update available — click to download";
    case "downloading":
      return state.downloadPercent === null
        ? "Downloading…"
        : `Downloading (${state.downloadPercent}%)`;
    case "downloaded":
      return state.downloadedVersion
        ? `Restart to install v${state.downloadedVersion}`
        : "Restart to install";
    case "error":
      return state.message
        ? `Update failed: ${state.message} — click to retry`
        : "Update failed — click to retry";
    default:
      return "";
  }
}

function shouldRender(state: UpdateState | null): state is UpdateState {
  if (!state) return false;
  if (!state.enabled) return false;
  switch (state.status) {
    case "available":
    case "downloading":
    case "downloaded":
      return true;
    case "error":
      return state.canRetry;
    default:
      return false;
  }
}

async function onClick(state: UpdateState): Promise<void> {
  const electron = getElectron();
  try {
    if (state.status === "available") {
      await electron.update.download();
    } else if (state.status === "downloaded") {
      await electron.update.install();
    } else if (state.status === "error" && state.canRetry) {
      // Dispatch by errorContext — a failure during the initial check should
      // re-check, not blindly call download() (which would silently no-op
      // because availableVersion is null).
      if (state.errorContext === "check") await electron.update.check();
      else if (state.errorContext === "download") await electron.update.download();
      else if (state.errorContext === "install") await electron.update.install();
    }
  } catch (err) {
    // The main-side reducer already transitions to `error` via
    // autoUpdater.on("error"), which the pill renders as red+retry.
    console.error("[update-pill] action failed", err);
  }
}

export function UpdatePill() {
  if (!isElectron()) return null;

  return (
    <Show when={shouldRender(updateState()) ? updateState() : null}>
      {(state) => (
        <div class="group-data-[collapsible=icon]:hidden">
          <Tooltip>
            <TooltipTrigger
              type="button"
              aria-disabled={state().status === "downloading"}
              class="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent aria-disabled:pointer-events-none"
              classList={{
                "text-amber-500 animate-update-pulse":
                  state().status === "available",
                "text-sky-400 animate-update-pulse":
                  state().status === "downloading",
                "text-emerald-500": state().status === "downloaded",
                "text-red-400":
                  state().status === "error" && state().canRetry,
              }}
              onClick={() => { void onClick(state()); }}
            >
              <Rocket class="size-4" />
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {tooltipLabel(state())}
            </TooltipContent>
          </Tooltip>
        </div>
      )}
    </Show>
  );
}
