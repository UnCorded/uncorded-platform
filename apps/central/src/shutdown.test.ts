import { describe, test, expect } from "bun:test";
import { runShutdown, SHUTDOWN_DEADLINE_MS, type ShutdownLogger } from "./shutdown";

interface LogLine {
  level: "info" | "error";
  message: string;
  meta?: Record<string, unknown>;
}

function makeLogger(): { logger: ShutdownLogger; lines: LogLine[] } {
  const lines: LogLine[] = [];
  const logger: ShutdownLogger = {
    info: (message, meta) => lines.push({ level: "info", message, ...(meta ? { meta } : {}) }),
    error: (message, meta) => lines.push({ level: "error", message, ...(meta ? { meta } : {}) }),
  };
  return { logger, lines };
}

/** Resolve once `predicate()` is true or a short timeout elapses. */
function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("waitFor timed out"));
      setTimeout(tick, 5);
    };
    tick();
  });
}

describe("runShutdown", () => {
  test("graceful drain exits 0 before the deadline and never forces exit", async () => {
    const { logger, lines } = makeLogger();
    const exitCodes: number[] = [];
    let timersCleared = false;
    let serverStopped = false;

    runShutdown({
      logger,
      clearTimers: () => {
        timersCleared = true;
      },
      stopServer: () => {
        serverStopped = true;
      },
      endDb: () => Promise.resolve(),
      exit: (code) => exitCodes.push(code),
      // Generous deadline; the graceful path must win well before this.
      deadlineMs: 5000,
    });

    await waitFor(() => exitCodes.length > 0);

    expect(timersCleared).toBe(true);
    expect(serverStopped).toBe(true);
    expect(exitCodes).toEqual([0]);
    expect(lines.some((l) => l.message === "database connections closed")).toBe(true);
    expect(lines.some((l) => l.message.includes("deadline exceeded"))).toBe(false);
  });

  test("stuck drain hits the deadline and forces exit 1 with a clear log", async () => {
    const { logger, lines } = makeLogger();
    const exitCodes: number[] = [];

    runShutdown({
      logger,
      clearTimers: () => {},
      stopServer: () => {},
      // Never resolves — simulates a wedged Postgres pool drain.
      endDb: () => new Promise<void>(() => {}),
      exit: (code) => exitCodes.push(code),
      // Short deadline so the test is fast; this is the path that would
      // otherwise hang the real process forever.
      deadlineMs: 30,
    });

    await waitFor(() => exitCodes.length > 0);

    expect(exitCodes).toEqual([1]);
    const deadlineLog = lines.find((l) => l.message.includes("deadline exceeded"));
    expect(deadlineLog).toBeDefined();
    expect(deadlineLog?.level).toBe("error");
  });

  test("a rejected drain exits 1 without waiting for the deadline", async () => {
    const { logger, lines } = makeLogger();
    const exitCodes: number[] = [];

    runShutdown({
      logger,
      clearTimers: () => {},
      stopServer: () => {},
      endDb: () => Promise.reject(new Error("pool already destroyed")),
      exit: (code) => exitCodes.push(code),
      deadlineMs: 5000,
    });

    await waitFor(() => exitCodes.length > 0);

    expect(exitCodes).toEqual([1]);
    expect(lines.some((l) => l.message.includes("error closing database connections"))).toBe(true);
    expect(lines.some((l) => l.message.includes("deadline exceeded"))).toBe(false);
  });

  test("exit fires exactly once even if the drain settles after the deadline", async () => {
    const { logger } = makeLogger();
    const exitCodes: number[] = [];
    let resolveDrain: (() => void) | undefined;

    runShutdown({
      logger,
      clearTimers: () => {},
      stopServer: () => {},
      endDb: () =>
        new Promise<void>((resolve) => {
          resolveDrain = resolve;
        }),
      exit: (code) => exitCodes.push(code),
      deadlineMs: 20,
    });

    // Let the deadline fire first...
    await waitFor(() => exitCodes.length > 0);
    expect(exitCodes).toEqual([1]);

    // ...then the slow drain finally settles. It must not exit a second time.
    resolveDrain?.();
    await new Promise((r) => setTimeout(r, 20));
    expect(exitCodes).toEqual([1]);
  });

  test("exposes a conservative default deadline", () => {
    expect(SHUTDOWN_DEADLINE_MS).toBeGreaterThan(0);
    expect(SHUTDOWN_DEADLINE_MS).toBeLessThanOrEqual(10_000);
  });
});
