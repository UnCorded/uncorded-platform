// Per-server tracker for the post-update ceremony overlay. Replaces the old
// `RuntimeInstallingToast` (`update-ux.md` §4.8) with a full-bleed flow that
// hides the broken intermediate UI (drained WS, empty sidebar, missing
// presence) behind a dark backdrop while the runtime swaps, then surfaces a
// success card that re-asserts active server context on dismiss.
//
// Phases (per server):
//   none     — no update in flight, or the update is in a non-irreversible
//              phase (backup / download / awaiting-restart) where the inline
//              runtime panel is the right surface. Overlay hidden.
//   active   — runtime state ∈ {installing, rolling-back}. Only the truly
//              irreversible phases trigger the dark backdrop — the user
//              opted in by clicking "Restart to apply" (or starts here for
//              older runtimes that auto-progress past `downloaded`).
//   success  — state returned to `idle` AND `currentVersion` advanced past
//              the snapshotted pre-update version. Overlay shows the success
//              card with a Continue button.
//   failed   — state returned to `idle` AND `currentVersion` did NOT advance
//              (rollback to prior bytes), OR state is `error`. Overlay shows
//              the failure card with a Continue button.
//   dismissed — user clicked Continue. The slot is cleared; subsequent
//              updates start a fresh cycle.
//
// A per-server `preUpdateVersion` snapshot is taken the first time state
// enters an active phase. We need this because the runtime broadcasts the
// final `idle` with the new currentVersion all in one frame; we have to
// remember what it was before to know the update actually happened (vs. an
// idle-write from `update-state` cycling for an unrelated reason).

import { createSignal } from "solid-js";
import type { RuntimeUpdateState } from "@uncorded/protocol";

export type CeremonyPhase = "none" | "active" | "success" | "failed";

interface CeremonySlot {
  /** Version the runtime reported the first time state entered an active
   *  phase. Used to detect "did the update actually advance?". */
  preUpdateVersion: string;
  /** Most recent active phase observed. Sticky once active, so a same-frame
   *  active → idle transition still resolves to success/failed. */
  sawActive: boolean;
  /** Whether the user clicked Continue on success/failed. Cleared on next
   *  active transition. */
  dismissed: boolean;
}

// Only the truly irreversible phases trigger the overlay. Backup + download
// + awaiting-restart stay in the runtime panel where the user can see the
// rest of the workspace (sidebar, channels, presence) and keep using it
// while bytes come down. The user opts into the blackout by clicking
// "Restart to apply update" — at which point state goes to `installing`
// and the overlay takes over.
const ACTIVE_STATES = new Set<RuntimeUpdateState["state"]>([
  "installing",
  "rolling-back",
]);

const [slots, setSlots] = createSignal<Record<string, CeremonySlot>>({});

/**
 * Drive the ceremony state machine from the runtime-update store. Call this
 * inside an effect that subscribes to `runtimeUpdateStateFor(serverId)`.
 * No-op when `state` is null (initial fetch hasn't landed). Idempotent.
 */
export function observeUpdateState(
  serverId: string,
  state: RuntimeUpdateState | null,
): void {
  if (state === null) return;

  const isActive = ACTIVE_STATES.has(state.state);

  setSlots((prev) => {
    const cur = prev[serverId];

    if (isActive) {
      if (cur && cur.sawActive && !cur.dismissed) {
        // Already tracking — keep the original snapshot. We do NOT update
        // preUpdateVersion or `dismissed` while an active phase is sustained.
        return prev;
      }
      // Either no slot yet, or the slot was dismissed (next update cycle).
      return {
        ...prev,
        [serverId]: {
          preUpdateVersion: state.currentVersion,
          sawActive: true,
          dismissed: false,
        },
      };
    }

    // Inactive states (idle / available / up-to-date / checking / error /
    // pending-confirm). Only relevant if we'd previously seen an active
    // phase; otherwise nothing to do.
    if (!cur || !cur.sawActive) return prev;
    return prev;
  });
}

/** Phase for the given server. Pure derivation from `slots()` + the latest
 *  `state` snapshot the caller passes in. The component calls this from a
 *  reactive context so `slots()` triggers re-derivation. */
export function ceremonyPhaseFor(
  serverId: string,
  state: RuntimeUpdateState | null,
): CeremonyPhase {
  const slot = slots()[serverId];
  if (!slot) return "none";
  if (slot.dismissed) return "none";

  // Hard error from the runtime — show failure regardless of what
  // currentVersion ended up at.
  if (state?.state === "error") return "failed";

  if (state && ACTIVE_STATES.has(state.state)) return "active";

  // Inactive state with a slot → resolution time.
  if (!slot.sawActive) return "none";

  // currentVersion advanced ⇒ success; otherwise rollback / no-op.
  if (state && state.currentVersion !== slot.preUpdateVersion) return "success";
  return "failed";
}

/** Pre-update version snapshot for the given server, if any. Used by the
 *  overlay's success copy ("Updated from vX → vY"). */
export function preUpdateVersionFor(serverId: string): string | null {
  return slots()[serverId]?.preUpdateVersion ?? null;
}

/** Mark the ceremony as dismissed for this server. Called by the overlay's
 *  Continue button. Subsequent active transitions reset `dismissed` to false
 *  via `observeUpdateState`. */
export function dismissCeremony(serverId: string): void {
  setSlots((prev) => {
    const cur = prev[serverId];
    if (!cur) return prev;
    if (cur.dismissed) return prev;
    return { ...prev, [serverId]: { ...cur, dismissed: true } };
  });
}

// ---------------------------------------------------------------------------
// Test seam — clears all in-memory state. Used by unit tests to isolate
// scenarios. Not exported from the package barrel; do not call in app code.
// ---------------------------------------------------------------------------

export function _resetCeremonyForTests(): void {
  setSlots({});
}
