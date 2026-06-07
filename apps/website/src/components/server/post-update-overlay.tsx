// Full-bleed dark overlay shown to every connected user when the active
// server's runtime is updating. Replaces the old `RuntimeInstallingToast`
// (`update-ux.md` §4.8) — instead of a small badge that leaves the broken
// intermediate UI (drained WS, empty sidebar, missing presence) visible
// underneath, this paints over the workspace entirely until the runtime
// settles.
//
// Two stages:
//   1. Active phase ({installing, rolling-back} only — the irreversible
//      install window the user opted into by clicking "Restart to apply
//      update"). Spinner card, no dismiss button. Backup + download stay
//      in the runtime panel (panel-only, workspace remains usable).
//   2. Resolution (success or failed) → status card with a Continue button.
//      Click re-asserts the active server (defensively — nothing currently
//      clears it across an update, but the snapshot is cheap insurance),
//      clears the ceremony slot, then triggers the inside-out cinematic
//      expand so the workspace reveals from the center.
//
// Lives at App root next to `RuntimeInstallingToast` did, so it stacks above
// portal iframes and survives the WS reconnect. Wires to the active-server
// signal so it follows focus.

import { Show, Switch, Match, createMemo, createEffect, createSignal, on } from "solid-js";
import { Loader2, CheckCircle2, AlertTriangle } from "lucide-solid";
import { activeServerId, setActiveServer } from "@/stores/servers";
import { runtimeUpdateStateFor } from "@/stores/runtime-update";
import {
  observeUpdateState,
  ceremonyPhaseFor,
  preUpdateVersionFor,
  dismissCeremony,
  type CeremonyPhase,
} from "@/stores/post-update-ceremony";
import { Button } from "@/components/ui/button";
import { runCinematicOpen } from "@/stores/cinematic";

// Length of the outer-overlay fade-in / fade-out, mirrored in the
// `duration-500` Tailwind class below. Kept as a constant so the unmount
// delay matches what the CSS transition is actually animating.
const FADE_DURATION_MS = 500;

export function PostUpdateOverlay() {
  // Re-derive the per-server accessor whenever the active server flips so
  // the overlay follows current focus.
  const state = createMemo(() => {
    const id = activeServerId();
    if (!id) return null;
    return runtimeUpdateStateFor(id)();
  });

  // Push every state change into the ceremony tracker so it can latch the
  // pre-update version snapshot the moment we enter an active phase.
  createEffect(() => {
    const id = activeServerId();
    if (!id) return;
    observeUpdateState(id, state());
  });

  const phase = createMemo<CeremonyPhase>(() => {
    const id = activeServerId();
    if (!id) return "none";
    return ceremonyPhaseFor(id, state());
  });

  // Two-stage visibility: `mounted` controls whether the DOM node exists,
  // `shown` controls the opacity class. The brief gap between mounted=true
  // and shown=true lets the browser paint the opacity-0 frame BEFORE we flip
  // to opacity-100, so the transition actually animates ("server shutting
  // down" feel). On dismiss we flip shown=false first, wait for the fade,
  // then unmount — keeps the success card visible during the fade-out.
  const [mounted, setMounted] = createSignal(false);
  const [shown, setShown] = createSignal(false);
  // `displayPhase` lags `phase()` by exactly the fade-out so the success /
  // failed card doesn't pop to "none" content mid-fade.
  const [displayPhase, setDisplayPhase] = createSignal<CeremonyPhase>("none");

  let unmountTimer: ReturnType<typeof setTimeout> | null = null;

  createEffect(on(phase, (next) => {
    if (next !== "none") {
      // Cancel any in-flight unmount — re-entered before fade-out finished.
      if (unmountTimer !== null) {
        clearTimeout(unmountTimer);
        unmountTimer = null;
      }
      setDisplayPhase(next);
      setMounted(true);
      // Defer the opacity flip one frame so the browser sees the opacity-0
      // initial paint before the opacity-100 target paint — required for
      // the CSS transition to fire on the very first mount.
      requestAnimationFrame(() => setShown(true));
      return;
    }
    // phase transitioned to "none" — fade out, then unmount. We keep
    // `displayPhase` at its previous value so the fading card still shows
    // the success / failed copy instead of flashing empty.
    setShown(false);
    unmountTimer = setTimeout(() => {
      setMounted(false);
      setDisplayPhase("none");
      unmountTimer = null;
    }, FADE_DURATION_MS);
  }));

  const targetVersion = (): string => {
    const s = state();
    return s?.currentVersion ?? "the latest version";
  };

  const fromVersion = (): string | null => {
    const id = activeServerId();
    if (!id) return null;
    return preUpdateVersionFor(id);
  };

  const handleContinue = async (): Promise<void> => {
    const id = activeServerId();
    if (!id) return;
    // Re-assert active server in case anything cleared it across the swap.
    // Idempotent — setActiveServer with the same id is a no-op write thanks
    // to the patcher's reference-equal guard.
    setActiveServer(id);
    dismissCeremony(id);
    // Run the overlay fade-out and the CRT bootup IN PARALLEL — overlay
    // fades from opacity 1 → 0 over FADE_DURATION_MS while the workspace
    // simultaneously powers back on (point → line → vertical expand →
    // stabilizing flicker). Sequential ordering left a visible 100-200ms
    // gap of "dark backdrop with no overlay and no workspace" between the
    // overlay disappearing and the cinematic starting; running them
    // concurrently makes the reveal feel like one continuous motion.
    // If the workspace was never collapsed (e.g. a remote client watching
    // the update), the cinematic store starts in `idle` and
    // runCinematicOpen() short-circuits — safe to always call.
    await Promise.all([
      new Promise<void>((resolve) => setTimeout(resolve, FADE_DURATION_MS)),
      runCinematicOpen(),
    ]);
  };

  return (
    <Show when={mounted()}>
      <div
        class="fixed inset-0 z-[200] flex items-center justify-center bg-background/95 backdrop-blur-sm transition-opacity duration-500 ease-out"
        classList={{
          "opacity-100 pointer-events-auto": shown(),
          "opacity-0 pointer-events-none": !shown(),
        }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="post-update-overlay-title"
      >
        <div
          class="mx-4 w-full max-w-md rounded-2xl border border-border bg-card p-8 shadow-2xl transition-all duration-500 ease-out"
          classList={{
            "opacity-100 translate-y-0 scale-100": shown(),
            "opacity-0 translate-y-2 scale-[0.98]": !shown(),
          }}
        >
          <Switch>
            <Match when={displayPhase() === "active"}>
              <div class="flex flex-col items-center text-center gap-4">
                <Loader2 class="size-10 text-primary animate-spin" />
                <div class="space-y-1">
                  <h2
                    id="post-update-overlay-title"
                    class="text-lg font-semibold text-foreground"
                  >
                    Updating server…
                  </h2>
                  <p class="text-sm text-muted-foreground">
                    Your server is finishing up. This usually takes under a minute.
                  </p>
                </div>
              </div>
            </Match>

            <Match when={displayPhase() === "success"}>
              <div class="flex flex-col items-center text-center gap-5">
                <div class="flex size-12 items-center justify-center rounded-full bg-emerald-500/10">
                  <CheckCircle2 class="size-7 text-emerald-500" />
                </div>
                <div class="space-y-1">
                  <h2
                    id="post-update-overlay-title"
                    class="text-lg font-semibold text-foreground"
                  >
                    Updated to v{targetVersion()}
                  </h2>
                  <p class="text-sm text-muted-foreground">
                    <Show
                      when={fromVersion() !== null}
                      fallback="All systems are back online."
                    >
                      Upgraded from v{fromVersion()}. All systems are back online.
                    </Show>
                  </p>
                </div>
                <Button
                  class="w-full"
                  size="lg"
                  onClick={() => void handleContinue()}
                  autofocus
                >
                  Continue to server
                </Button>
              </div>
            </Match>

            <Match when={displayPhase() === "failed"}>
              <div class="flex flex-col items-center text-center gap-5">
                <div class="flex size-12 items-center justify-center rounded-full bg-amber-500/10">
                  <AlertTriangle class="size-7 text-amber-500" />
                </div>
                <div class="space-y-1">
                  <h2
                    id="post-update-overlay-title"
                    class="text-lg font-semibold text-foreground"
                  >
                    Update didn't complete
                  </h2>
                  <p class="text-sm text-muted-foreground">
                    <Show
                      when={state()?.errorMessage}
                      fallback="Your server is back on the previous version. You can try again from server settings."
                    >
                      {(msg) => msg()}
                    </Show>
                  </p>
                </div>
                <Button
                  class="w-full"
                  size="lg"
                  variant="secondary"
                  onClick={() => void handleContinue()}
                  autofocus
                >
                  Continue to server
                </Button>
              </div>
            </Match>
          </Switch>
        </div>
      </div>
    </Show>
  );
}
