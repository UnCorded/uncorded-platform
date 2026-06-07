// Runtime update-state — the wire shape for the orchestrator-driven update
// lifecycle (Phase 01 §8, §12 of runtime-lifecycle.md).
//
// The runtime is a passive store + broadcaster (per O8/D3 in decisions.md).
// It does not pull images, drive transitions, or validate state-machine
// edges — its job is to persist whatever the orchestrator POSTs and rebroadcast
// it over WS so every connected client sees the same pill.
//
// One canonical type used by:
//   - WS broadcast frames (`update_state_changed`)
//   - `GET /admin/api/update-state` response
//   - `POST /admin/api/update-state` request body (full or subset)
//   - on-disk format at /config/update-state.json

// Type definitions live in `@uncorded/protocol` so renderer + heartbeat +
// orchestrator share one source of truth. Re-exported here so existing
// runtime imports (`from "./types"`) keep working without churn.
export type {
  RuntimeUpdateStatus,
  RuntimeUpdateChannel,
  RuntimeUpdateErrorContext,
  RuntimeUpdateState,
} from "@uncorded/protocol";

import type { RuntimeUpdateState } from "@uncorded/protocol";

/** Default state used when /config/update-state.json is absent at boot — a
 *  fresh runtime with no orchestrator interaction yet. */
export function defaultUpdateState(currentVersion: string, now: number): RuntimeUpdateState {
  return {
    state: "idle",
    errorContext: null,
    currentVersion,
    availableVersion: null,
    channel: "stable",
    progress: null,
    lastCheckedAt: null,
    errorMessage: null,
    updatedAt: now,
  };
}
