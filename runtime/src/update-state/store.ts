// Disk-backed store for the runtime update-state.
//
// Single in-memory copy; every mutation writes through to disk synchronously
// so a crash mid-transition leaves the next boot with a coherent view of
// what the orchestrator last asked for. Sync I/O is acceptable here: writes
// happen at orchestrator-driven update transitions (≤ a dozen per update),
// not on a hot path.
//
// Listeners fire after the mutation has been persisted. The HTTP/WS layer
// subscribes to broadcast `update_state_changed` to all clients (D4: visibility
// is universal); the heartbeat client subscribes to fold the latest state into
// its next poll to Central (§11.5).
//
// Tolerant on read: a malformed or partially-written /config/update-state.json
// is logged and ignored — we fall back to the default state. Orchestrator-driven
// state is recoverable (it will POST again on next check); hard-failing boot
// over a corrupted state file would be a denial-of-service.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { rootLogger } from "@uncorded/shared";
import type { Logger } from "@uncorded/shared";
import { defaultUpdateState, type RuntimeUpdateState } from "./types";

const log: Logger = rootLogger.child({ component: "update-state" });

export type UpdateStateListener = (state: RuntimeUpdateState) => void;

export interface UpdateStateStore {
  /** Synchronous read of the current in-memory state. */
  get(): RuntimeUpdateState;
  /** Replace state with a partial patch; persists + notifies. Always sets
   *  `updatedAt` to `now()` regardless of caller-supplied value. */
  set(patch: Partial<RuntimeUpdateState>): RuntimeUpdateState;
  /** Subscribe to mutations. Returns an unsubscribe function. Listener errors
   *  are caught + logged so a bad subscriber can't wedge subsequent ones. */
  subscribe(listener: UpdateStateListener): () => void;
}

export interface CreateUpdateStateStoreOptions {
  /** Absolute path to the persist file (typically /config/update-state.json). */
  filePath: string;
  /** Sourced from process.env.RUNTIME_VERSION at boot. Stamped onto fresh
   *  state and refreshed onto loaded state so a swapped image always reports
   *  its own version regardless of what the prior version persisted. */
  currentVersion: string;
  /** Injectable wall clock — defaults to Date.now. */
  now?: () => number;
}

export function createUpdateStateStore(
  options: CreateUpdateStateStoreOptions,
): UpdateStateStore {
  const now = options.now ?? Date.now;
  const listeners = new Set<UpdateStateListener>();

  let state = loadOrDefault(options.filePath, options.currentVersion, now());

  function persist(): void {
    try {
      writeFileSync(options.filePath, JSON.stringify(state, null, 2));
    } catch (err) {
      // Persist failure is loud but non-fatal — the in-memory state still
      // serves /admin/api/update-state and the broadcast still fires. The
      // orchestrator will POST again on the next transition, giving us a
      // chance to retry. Do not throw — losing the WS broadcast because
      // disk is full would be worse than losing the on-disk record.
      log.error("update-state persist failed", {
        path: options.filePath,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  function notify(): void {
    for (const listener of listeners) {
      try {
        listener(state);
      } catch (err) {
        log.warn("update-state listener threw", {
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return {
    get(): RuntimeUpdateState {
      return state;
    },
    set(patch: Partial<RuntimeUpdateState>): RuntimeUpdateState {
      // Caller-supplied updatedAt is ignored — only the runtime stamps it,
      // so every persisted record carries a clock the local runtime trusts.
      const { updatedAt: _ignored, ...accepted } = patch;
      void _ignored;
      state = { ...state, ...accepted, updatedAt: now() };
      persist();
      notify();
      return state;
    },
    subscribe(listener: UpdateStateListener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

function loadOrDefault(
  filePath: string,
  currentVersion: string,
  nowMs: number,
): RuntimeUpdateState {
  if (!existsSync(filePath)) {
    return defaultUpdateState(currentVersion, nowMs);
  }
  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isRuntimeUpdateState(parsed)) {
      log.warn("update-state file is malformed — falling back to defaults", { path: filePath });
      return defaultUpdateState(currentVersion, nowMs);
    }
    // currentVersion always reflects THIS image's RUNTIME_VERSION, never the
    // version that wrote the file. After a successful swap the orchestrator
    // POSTs `state: "idle", currentVersion: <new>` — but if the runtime crashed
    // before that POST, the file still says `installing` from the prior image's
    // perspective. Stamping currentVersion fresh on load keeps /health and
    // /admin/api/update-state internally consistent with what's actually running.
    return { ...parsed, currentVersion };
  } catch (err) {
    log.warn("update-state file unreadable — falling back to defaults", {
      path: filePath,
      err: err instanceof Error ? err.message : String(err),
    });
    return defaultUpdateState(currentVersion, nowMs);
  }
}

function isRuntimeUpdateState(value: unknown): value is RuntimeUpdateState {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["state"] === "string" &&
    (v["errorContext"] === null || typeof v["errorContext"] === "string") &&
    typeof v["currentVersion"] === "string" &&
    (v["availableVersion"] === null || typeof v["availableVersion"] === "string") &&
    typeof v["channel"] === "string" &&
    (v["progress"] === null || typeof v["progress"] === "number") &&
    (v["lastCheckedAt"] === null || typeof v["lastCheckedAt"] === "number") &&
    (v["errorMessage"] === null || typeof v["errorMessage"] === "string") &&
    typeof v["updatedAt"] === "number"
  );
}
