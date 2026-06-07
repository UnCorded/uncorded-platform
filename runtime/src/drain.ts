// Phase 01 §5.1 — graceful drain orchestration.
//
// Triggered when the orchestrator writes `state: "installing"` to the
// update-state store (see runtime-lifecycle.md §8.2 "Drain trigger"). The
// runtime is the passive party in the update lifecycle; receiving this
// state is what tells it to start negotiating with clients before the
// orchestrator stops the container.
//
// Sequence per spec §5.1:
//   1. Mark /ready 503 with reason: "draining" (HTTP layer reads
//      `isDraining()`; no plumbing here beyond flipping the flag).
//   2. Broadcast `runtime.server.draining` to every connected client with
//      the configured `grace_seconds`. Existing connections continue to
//      receive events for the duration of the grace window so in-flight
//      messages flush.
//   3. Stop accepting new WS connections — the WS server reads
//      `isDraining()` and returns 503 + Retry-After on `/ws` upgrade
//      attempts during drain.
//   4. Wait the grace period (default 30s, configurable via
//      RUNTIME_DRAIN_GRACE_SECONDS — see lifecycle §13).
//   5. Force-close remaining WS connections with code 1012 (Service
//      Restart). Web clients auto-reconnect after the swap; mobile/CLI
//      retry per their own policies.
//   6. Hand off to the rest of shutdown (plugin stop, final heartbeat,
//      tunnel teardown, exit 0). Owned by the caller — drain controller
//      doesn't know about plugins or process exit; main.ts wires
//      `onDrainComplete` to its existing `shutdown()` + `process.exit(0)`.
//
// The crash-drain path (`unhandledRejection` / `uncaughtException`) is a
// separate code path that skips this entirely (lifecycle §5.2). This
// controller only handles the orchestrator-driven graceful path.

import { rootLogger } from "@uncorded/shared";
import type { Logger } from "@uncorded/shared";
import type { MessageRouter } from "./ws/router";
import type { UpdateStateStore } from "./update-state/store";

const log: Logger = rootLogger.child({ component: "drain" });

/** Topic broadcast on phase 2. Mirrors the existing
 *  `runtime.server.shutting_down` naming convention. Payload:
 *  `{ grace_seconds: number }`. */
export const DRAIN_BROADCAST_TOPIC = "runtime.server.draining";

/** WS close code per RFC 6455. 1012 = Service Restart — clients are
 *  expected to retry shortly. Web shell already knows to reconnect on
 *  any close; this code communicates intent. */
export const WS_CLOSE_SERVICE_RESTART = 1012;

export interface DrainControllerOptions {
  updateStateStore: UpdateStateStore;
  router: MessageRouter;
  /** Grace window in milliseconds. Default mapping: env value × 1000. */
  graceMs: number;
  /** Called after the WS phase finishes. main.ts wires this to the
   *  existing graceful `shutdown()` + `process.exit(0)`. Drain controller
   *  is intentionally agnostic about how the process actually exits. */
  onDrainComplete: () => Promise<void>;
  /** Injectable timer for tests. */
  setTimeoutFn?: ((cb: () => void, ms: number) => unknown) | undefined;
  clearTimeoutFn?: ((handle: unknown) => void) | undefined;
}

export interface DrainController {
  /** True once the controller has flipped into draining state. Read by
   *  the HTTP `/ready` handler (returns 503) and the WS server's
   *  upgrade path (rejects new connections with 503 + Retry-After). */
  isDraining(): boolean;
  /** Manually trigger drain. Idempotent — repeated calls return the same
   *  in-flight promise. Used by tests; in prod the update-state
   *  subscriber triggers this via the `installing` transition. */
  drain(): Promise<void>;
  /** Detach the update-state subscriber. Safe to call after drain. */
  dispose(): void;
}

export function createDrainController(
  options: DrainControllerOptions,
): DrainController {
  const setTimeoutImpl = options.setTimeoutFn ?? setTimeout;
  let draining = false;
  let drainPromise: Promise<void> | null = null;

  function start(): Promise<void> {
    if (drainPromise) return drainPromise;
    draining = true;
    const graceSeconds = Math.max(0, Math.ceil(options.graceMs / 1000));
    log.info("drain start", { graceSeconds });

    drainPromise = (async () => {
      // Step 2: broadcast. Best-effort — a broadcast failure (e.g. router
      // already disposed) must not block the rest of the sequence.
      try {
        options.router.broadcastEvent(DRAIN_BROADCAST_TOPIC, {
          grace_seconds: graceSeconds,
        });
      } catch (err) {
        log.warn("drain broadcast failed", {
          err: err instanceof Error ? err.message : String(err),
        });
      }

      // Step 4: wait grace.
      if (options.graceMs > 0) {
        await new Promise<void>((resolve) => {
          setTimeoutImpl(() => resolve(), options.graceMs);
        });
      }

      // Step 5: force-close all WS connections. Best-effort for the same
      // reason as the broadcast.
      try {
        const closed = options.router.disconnectAllUsers(
          WS_CLOSE_SERVICE_RESTART,
          "service-restart",
        );
        log.info("drain close-all", { closed });
      } catch (err) {
        log.warn("drain close-all failed", {
          err: err instanceof Error ? err.message : String(err),
        });
      }

      // Step 6+: hand off to the rest of shutdown. Drain controller does
      // not know about plugins, tunnel, or process.exit — that's the
      // caller's job (main.ts). If onDrainComplete throws, propagate so
      // the caller can decide whether to crash or absorb.
      await options.onDrainComplete();
    })();

    return drainPromise;
  }

  const unsubscribe = options.updateStateStore.subscribe((next) => {
    // First-only trigger. The store's listener is called on every patch,
    // including no-op writes during grace; we must not re-arm.
    if (next.state === "installing" && !draining) {
      void start().catch((err) => {
        log.error("drain failed", {
          err: err instanceof Error ? err.message : String(err),
        });
      });
    }
  });

  return {
    isDraining: () => draining,
    drain: () => start(),
    dispose: () => {
      unsubscribe();
    },
  };
}
