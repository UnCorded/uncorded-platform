// Bounded graceful shutdown for Central.
//
// The graceful path is: clear background timers, stop accepting new requests,
// then drain the Postgres pool (`sql.end()`) and exit 0. The failure mode this
// guards against is `sql.end()` never settling — a connection wedged mid-query,
// an unresponsive pool, a socket stuck in a half-open state — which would leave
// the process hanging forever and never exit. An orchestrator (Docker, systemd)
// would then have to SIGKILL it after its own, longer grace period.
//
// We arm a hard deadline alongside the graceful drain. Whichever resolves first
// wins, and exit happens exactly once. The graceful path is unchanged; the
// deadline only matters when the drain hangs.
//
// Kept as a pure, dependency-injected function so the stuck-drain path can be
// unit-tested without spawning a process or calling the real `process.exit`.

/**
 * Conservative default deadline. Long enough that a healthy pool always drains
 * inside it, short enough that a wedged shutdown can't outlast a typical
 * orchestrator stop-grace window (Docker's default is 10s; we exit on our own
 * terms first so logs make the cause clear instead of an opaque SIGKILL).
 */
export const SHUTDOWN_DEADLINE_MS = 8000;

export interface ShutdownLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface ShutdownOptions {
  readonly logger: ShutdownLogger;
  /** Stop background intervals (signing-key rotation, transfer sweep). */
  readonly clearTimers: () => void;
  /** Stop accepting new connections. */
  readonly stopServer: () => void;
  /** Drain the DB pool. May hang; that's exactly what the deadline guards. */
  readonly endDb: () => Promise<void>;
  /** Terminate the process. Injected so tests can observe without exiting. */
  readonly exit: (code: number) => void;
  /** Override the deadline (tests use a short value). */
  readonly deadlineMs?: number;
}

/**
 * Run the bounded shutdown sequence. Returns immediately; exit happens
 * asynchronously via `opts.exit` exactly once — either when the DB pool drains
 * (code 0) or when the deadline is hit first (code 1, with a clear log line).
 */
export function runShutdown(opts: ShutdownOptions): void {
  const deadlineMs = opts.deadlineMs ?? SHUTDOWN_DEADLINE_MS;

  let exited = false;
  const finish = (code: number): void => {
    if (exited) return;
    exited = true;
    clearTimeout(deadline);
    opts.exit(code);
  };

  opts.logger.info("shutting down", { deadlineMs });
  opts.clearTimers();
  opts.stopServer();

  // Arm the hard deadline before kicking off the drain so a synchronously
  // rejecting/hanging drain can't slip past it.
  const deadline = setTimeout(() => {
    opts.logger.error("shutdown deadline exceeded — forcing exit", { deadlineMs });
    finish(1);
  }, deadlineMs);
  // The deadline must never itself keep the event loop alive once the graceful
  // path has finished and cleared it.
  deadline.unref?.();

  opts.endDb().then(
    () => {
      opts.logger.info("database connections closed");
      finish(0);
    },
    (err: unknown) => {
      opts.logger.error("error closing database connections", {
        err: err instanceof Error ? err.message : String(err),
      });
      finish(1);
    },
  );
}
