import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { createRoot } from "solid-js";
import { useNow, formatElapsed } from "./now-signal";

describe("formatElapsed", () => {
  test("zero ms → 0:00", () => {
    expect(formatElapsed(0)).toBe("0:00");
  });

  test("under a second still shows 0:00", () => {
    expect(formatElapsed(450)).toBe("0:00");
  });

  test("8 seconds → 0:08 (zero-padded)", () => {
    expect(formatElapsed(8_000)).toBe("0:08");
  });

  test("59 seconds → 0:59", () => {
    expect(formatElapsed(59_000)).toBe("0:59");
  });

  test("1 minute exact → 1:00", () => {
    expect(formatElapsed(60_000)).toBe("1:00");
  });

  test("9:09 minutes → 9:09", () => {
    expect(formatElapsed(9 * 60_000 + 9_000)).toBe("9:09");
  });

  test("12:34 minutes → 12:34", () => {
    expect(formatElapsed(12 * 60_000 + 34_000)).toBe("12:34");
  });

  test("negative input clamps to 0:00", () => {
    expect(formatElapsed(-500)).toBe("0:00");
  });
});

// useNow ref-counts a single module-level setInterval so multiple consumers
// share one tick. We verify both that the interval is created exactly once
// for N consumers and that it's torn down only after the *last* consumer
// disposes.

const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;

let setIntervalCalls = 0;
let clearIntervalCalls = 0;
let activeHandle: unknown = null;
// The most recent callback handed to setInterval, captured so a test can fire
// a tick deterministically instead of waiting on the real timer/wall clock.
let lastIntervalFn: (() => void) | null = null;

beforeEach(() => {
  setIntervalCalls = 0;
  clearIntervalCalls = 0;
  activeHandle = null;
  lastIntervalFn = null;
  globalThis.setInterval = ((fn: () => void, ms?: number) => {
    setIntervalCalls++;
    lastIntervalFn = fn;
    const handle = realSetInterval(fn, ms);
    activeHandle = handle;
    return handle;
  }) as typeof setInterval;
  globalThis.clearInterval = ((handle: unknown) => {
    clearIntervalCalls++;
    realClearInterval(handle as ReturnType<typeof setInterval>);
  }) as typeof clearInterval;
});

afterEach(() => {
  globalThis.setInterval = realSetInterval;
  globalThis.clearInterval = realClearInterval;
  if (activeHandle !== null) {
    realClearInterval(activeHandle as ReturnType<typeof setInterval>);
  }
});

describe("useNow", () => {
  test("creates exactly one interval for two simultaneous consumers", () => {
    const dispose1 = createRoot((d) => {
      useNow();
      return d;
    });
    const dispose2 = createRoot((d) => {
      useNow();
      return d;
    });
    expect(setIntervalCalls).toBe(1);
    dispose1();
    dispose2();
  });

  test("clears the interval only when the last consumer disposes", () => {
    const dispose1 = createRoot((d) => {
      useNow();
      return d;
    });
    const dispose2 = createRoot((d) => {
      useNow();
      return d;
    });
    dispose1();
    expect(clearIntervalCalls).toBe(0);
    dispose2();
    expect(clearIntervalCalls).toBe(1);
  });

  test("returns an accessor that reflects the clock at the latest tick", () => {
    const realDateNow = Date.now;
    try {
      createRoot((dispose) => {
        const now = useNow();
        expect(typeof now()).toBe("number");
        // Pin the clock and fire the shared tick directly rather than diffing
        // against a live Date.now() reading (which flakes when the suite runs
        // more than the old 50ms tolerance after module import). Asserting the
        // accessor equals the pinned value tests the real contract — now()
        // tracks the ticked clock — deterministically.
        const fixed = 1_900_000_000_000;
        Date.now = () => fixed;
        expect(lastIntervalFn).not.toBeNull();
        lastIntervalFn?.();
        expect(now()).toBe(fixed);
        dispose();
      });
    } finally {
      Date.now = realDateNow;
    }
  });

  test("re-creates the interval after a full teardown + new consumer", () => {
    const dispose1 = createRoot((d) => {
      useNow();
      return d;
    });
    dispose1();
    const dispose2 = createRoot((d) => {
      useNow();
      return d;
    });
    expect(setIntervalCalls).toBe(2);
    dispose2();
  });
});
