// Bounded graceful shutdown for the runtime.
//
// The runtime's graceful `shutdown()` (main.ts) runs a sequence of best-effort
// teardown steps and is awaited by every exit path — the SIGTERM/SIGINT
// handler, the drain controller's `onDrainComplete`, the heartbeat
// "server deleted" handler, and entrypoint's fatal-error handler — each of
// which calls `process.exit()` only *after* the await resolves. Several of
// those steps await external work with no inherent bound:
//
//   • the final heartbeat POST to Central (`fetch`, no AbortSignal),
//   • stopping the Cloudflare tunnel subprocess,
//   • shutting down managed-service sidecars (LiveKit),
//   • the post-SIGKILL `await subprocess.exited` for a wedged plugin.
//
// If any of those never settles, `shutdown()` never resolves, `process.exit`
// is never reached, and the container hangs until the orchestrator SIGKILLs it
// after its own (longer) stop-grace window — turning a clean stop into an
// opaque hard kill.
//
// `withShutdownDeadline` guards that: it races a teardown thunk against a hard
// deadline and resolves exactly once. The graceful path is unchanged — when
// the work finishes in time the outcome is "completed" and nothing else
// happens. Only when the deadline fires first does it log a clear warning and
// resolve "deadline", abandoning the wedged work so the caller can exit.
//
// Kept as a pure, dependency-injected function so the stuck path can be
// unit-tested without spawning subprocesses, real timers, or `process.exit`.

/**
 * Hard upper bound on the *entire* graceful shutdown sequence. This is the
 * backstop that guarantees `shutdown()` always resolves even if a step hangs
 * in a way the per-step bounds below don't cover. Sized comfortably above the
 * sum of the per-step bounds so a normal (or singly-wedged) shutdown finishes
 * via the per-step path and never trips this.
 */
export const RUNTIME_SHUTDOWN_DEADLINE_MS = 30_000;

/**
 * Per-step bound applied to the individual external/async teardown steps
 * (stop plugins, shut down managed services, final heartbeat, stop tunnel).
 * Generous enough that a healthy step always finishes inside it — plugin
 * stop already self-bounds to a 5s SIGTERM→SIGKILL window, so this leaves
 * margin for the kill+reap — short enough that one wedged step doesn't starve
 * the later cleanup steps (DB close, WAL checkpoint).
 */
export const RUNTIME_SHUTDOWN_STEP_DEADLINE_MS = 6_000;

export interface ShutdownDeadlineLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
}

export type ShutdownOutcome = "completed" | "deadline";

export interface WithShutdownDeadlineOptions {
  /** Human-readable label used in the deadline / error log lines. */
  readonly label: string;
  /** Hard bound. When it fires first, `run` is abandoned and we resolve. */
  readonly deadlineMs: number;
  readonly logger: ShutdownDeadlineLogger;
  /** The teardown work. May hang or throw; both are handled. */
  readonly run: () => Promise<void> | void;
  /** Injectable timer for tests; defaults to the global `setTimeout`. */
  readonly setTimeoutFn?: ((callback: () => void, ms: number) => unknown) | undefined;
  /** Injectable timer for tests; defaults to the global `clearTimeout`. */
  readonly clearTimeoutFn?: ((handle: unknown) => void) | undefined;
}

/**
 * Run `opts.run()` but never block longer than `opts.deadlineMs`.
 *
 * Resolves with:
 *   - "completed" when the work finishes (or throws — a throwing best-effort
 *     teardown step is logged and still counts as finished), or
 *   - "deadline" when the timeout fires first. In that case the abandoned work
 *     keeps running in the background; the caller is expected to exit the
 *     process shortly after.
 *
 * Resolves exactly once and logs at most one line. Never rejects.
 */
export function withShutdownDeadline(
  opts: WithShutdownDeadlineOptions,
): Promise<ShutdownOutcome> {
  const setT = opts.setTimeoutFn ?? ((cb: () => void, ms: number) => setTimeout(cb, ms));
  const clearT =
    opts.clearTimeoutFn ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  return new Promise<ShutdownOutcome>((resolve) => {
    let settled = false;

    // Arm the deadline before kicking off the work so a synchronously hanging
    // `run` (one that never yields) still can't slip past it.
    const handle = setT(() => {
      if (settled) return;
      settled = true;
      opts.logger.warn(`${opts.label} exceeded deadline — abandoning remaining teardown`, {
        deadlineMs: opts.deadlineMs,
      });
      resolve("deadline");
    }, opts.deadlineMs);
    // The deadline must never itself keep the event loop alive once the
    // graceful path has finished and cleared it.
    (handle as { unref?: () => void } | undefined)?.unref?.();

    void (async () => {
      try {
        await opts.run();
      } catch (err) {
        if (settled) return;
        settled = true;
        clearT(handle);
        opts.logger.warn(`${opts.label} threw during teardown`, {
          err: err instanceof Error ? err.message : String(err),
        });
        resolve("completed");
        return;
      }
      if (settled) return;
      settled = true;
      clearT(handle);
      resolve("completed");
    })();
  });
}
