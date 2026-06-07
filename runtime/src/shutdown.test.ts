import { describe, test, expect } from "bun:test";
import {
  withShutdownDeadline,
  RUNTIME_SHUTDOWN_DEADLINE_MS,
  RUNTIME_SHUTDOWN_STEP_DEADLINE_MS,
  type ShutdownDeadlineLogger,
} from "./shutdown";

interface LogLine {
  message: string;
  meta?: Record<string, unknown>;
}

function makeLogger(): { logger: ShutdownDeadlineLogger; warns: LogLine[] } {
  const warns: LogLine[] = [];
  const logger: ShutdownDeadlineLogger = {
    warn: (message, meta) => warns.push({ message, ...(meta ? { meta } : {}) }),
  };
  return { logger, warns };
}

/**
 * A manually-fired timer the test controls explicitly. Using this instead of
 * the real `setTimeout` keeps every test deterministic and leaves no real
 * timer handles alive between tests — the deadline only "fires" when the test
 * calls `fire()`, and `clear()` simulates the timer being cancelled.
 */
function makeManualTimer() {
  let pending: (() => void) | null = null;
  let cleared = false;
  return {
    setTimeoutFn: (cb: () => void): unknown => {
      pending = cb;
      return { id: 1 };
    },
    clearTimeoutFn: (): void => {
      pending = null;
      cleared = true;
    },
    /** Fire the armed deadline callback, if any. No-op once cleared/fired. */
    fire: (): void => {
      const cb = pending;
      pending = null;
      cb?.();
    },
    get cleared(): boolean {
      return cleared;
    },
    get armed(): boolean {
      return pending !== null;
    },
  };
}

describe("withShutdownDeadline", () => {
  test("graceful run completes before the deadline and never warns", async () => {
    const { logger, warns } = makeLogger();
    const timer = makeManualTimer();
    let ran = false;

    const outcome = await withShutdownDeadline({
      label: "graceful shutdown",
      deadlineMs: 5000,
      logger,
      run: async () => {
        await Promise.resolve();
        ran = true;
      },
      setTimeoutFn: timer.setTimeoutFn,
      clearTimeoutFn: timer.clearTimeoutFn,
    });

    expect(ran).toBe(true);
    expect(outcome).toBe("completed");
    // The deadline timer must have been cleared, never fired.
    expect(timer.cleared).toBe(true);
    expect(timer.armed).toBe(false);
    expect(warns).toEqual([]);
  });

  test("a wedged run hits the deadline and resolves with a clear warning", async () => {
    const { logger, warns } = makeLogger();
    const timer = makeManualTimer();
    let resolveRun: (() => void) | undefined;

    const promise = withShutdownDeadline({
      label: "graceful shutdown",
      deadlineMs: 30,
      logger,
      // Never settles on its own — simulates a wedged final heartbeat /
      // tunnel stop. The deadline must win.
      run: () =>
        new Promise<void>((resolve) => {
          resolveRun = resolve;
        }),
      setTimeoutFn: timer.setTimeoutFn,
      clearTimeoutFn: timer.clearTimeoutFn,
    });

    // The work is wedged; trip the deadline.
    timer.fire();
    const outcome = await promise;

    expect(outcome).toBe("deadline");
    const line = warns.find((l) => l.message.includes("exceeded deadline"));
    expect(line).toBeDefined();
    expect(line?.meta?.["deadlineMs"]).toBe(30);

    // Release the dangling run so nothing lingers past the test.
    resolveRun?.();
  });

  test("resolves exactly once, with one log, even if run settles after the deadline", async () => {
    const { logger, warns } = makeLogger();
    const timer = makeManualTimer();
    let resolveRun: (() => void) | undefined;

    const promise = withShutdownDeadline({
      label: "graceful shutdown",
      deadlineMs: 20,
      logger,
      run: () =>
        new Promise<void>((resolve) => {
          resolveRun = resolve;
        }),
      setTimeoutFn: timer.setTimeoutFn,
      clearTimeoutFn: timer.clearTimeoutFn,
    });

    // The deadline wins first.
    timer.fire();
    const outcome = await promise;
    expect(outcome).toBe("deadline");
    expect(warns.length).toBe(1);

    // Now let the slow run finally settle — it must not produce a second
    // resolution or a second log line.
    resolveRun?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(warns.length).toBe(1);
  });

  test("a throwing run is logged and still counts as completed", async () => {
    const { logger, warns } = makeLogger();
    const timer = makeManualTimer();

    const outcome = await withShutdownDeadline({
      label: "stop tunnel",
      deadlineMs: 5000,
      logger,
      run: async () => {
        throw new Error("tunnel already dead");
      },
      setTimeoutFn: timer.setTimeoutFn,
      clearTimeoutFn: timer.clearTimeoutFn,
    });

    expect(outcome).toBe("completed");
    // A run that threw still cancels its deadline timer.
    expect(timer.cleared).toBe(true);
    const line = warns.find((l) => l.message.includes("threw during teardown"));
    expect(line).toBeDefined();
    expect(line?.meta?.["err"]).toContain("tunnel already dead");
  });

  test("a deadline that fires after completion is a no-op", async () => {
    const { logger, warns } = makeLogger();
    const timer = makeManualTimer();

    const outcome = await withShutdownDeadline({
      label: "graceful shutdown",
      deadlineMs: 1000,
      logger,
      run: async () => {},
      setTimeoutFn: timer.setTimeoutFn,
      clearTimeoutFn: timer.clearTimeoutFn,
    });

    expect(outcome).toBe("completed");
    expect(timer.cleared).toBe(true);

    // Even a stale deadline firing late must not log or change the outcome:
    // the timer was cleared, so `fire()` is a no-op, and `settled` guards it.
    timer.fire();
    expect(warns).toEqual([]);
  });

  test("exposes conservative default deadlines", () => {
    expect(RUNTIME_SHUTDOWN_DEADLINE_MS).toBeGreaterThan(0);
    expect(RUNTIME_SHUTDOWN_STEP_DEADLINE_MS).toBeGreaterThan(0);
    // The per-step bound must be smaller than the overall backstop so a
    // singly-wedged step finishes via its own deadline before the overall one.
    expect(RUNTIME_SHUTDOWN_STEP_DEADLINE_MS).toBeLessThan(RUNTIME_SHUTDOWN_DEADLINE_MS);
  });
});
