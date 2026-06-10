import { describe, test, expect } from "bun:test";
import { createDemoExpiry, DEMO_TUNNEL_TTL_MS } from "./demo-expiry";

// A controllable fake timer: arm() captures the callback + delay instead of
// scheduling real time, so we can assert the TTL and fire it on demand without
// waiting 24h. Mirrors the (setTimer, clearTimer) injection points.
function fakeTimers() {
  let nextId = 1;
  const pending = new Map<number, { cb: () => void; ms: number }>();
  return {
    cleared: [] as number[],
    setTimer(cb: () => void, ms: number): ReturnType<typeof setTimeout> {
      const id = nextId++;
      pending.set(id, { cb, ms });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer(timer: ReturnType<typeof setTimeout>): void {
      const id = timer as unknown as number;
      this.cleared.push(id);
      pending.delete(id);
    },
    /** Number of timers still scheduled (not yet fired or cleared). */
    activeCount(): number {
      return pending.size;
    },
    /** Delay the most recently armed timer was scheduled with. */
    lastDelay(): number | undefined {
      const entries = [...pending.values()];
      return entries[entries.length - 1]?.ms;
    },
    /** Fire every pending timer (each fires at most once). */
    fireAll(): void {
      const cbs = [...pending.values()].map((e) => e.cb);
      pending.clear();
      for (const cb of cbs) cb();
    },
  };
}

describe("createDemoExpiry", () => {
  test("DEMO_TUNNEL_TTL_MS is 24 hours", () => {
    expect(DEMO_TUNNEL_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });

  test("arm() schedules onExpire at the configured TTL", () => {
    const timers = fakeTimers();
    let fired = 0;
    const expiry = createDemoExpiry({
      ttlMs: DEMO_TUNNEL_TTL_MS,
      onExpire: () => fired++,
      setTimer: timers.setTimer.bind(timers),
      clearTimer: timers.clearTimer.bind(timers),
    });

    expiry.arm();
    expect(timers.lastDelay()).toBe(DEMO_TUNNEL_TTL_MS);
    expect(fired).toBe(0); // not yet — TTL hasn't elapsed

    timers.fireAll();
    expect(fired).toBe(1);
  });

  test("models the demo -> expired transition the provider performs", () => {
    const timers = fakeTimers();
    // Stand-ins for the entrypoint provider's module state.
    let tunnelState: string | undefined;
    let currentUrl = "https://abc.trycloudflare.com";
    let killed = false;
    const LOCAL = "http://localhost:8080";

    const expiry = createDemoExpiry({
      ttlMs: 1000,
      onExpire: () => {
        killed = true;
        currentUrl = LOCAL;
        tunnelState = "expired";
      },
      setTimer: timers.setTimer.bind(timers),
      clearTimer: timers.clearTimer.bind(timers),
    });

    // Demo tunnel just came up.
    tunnelState = "demo";
    expiry.arm();
    expect(tunnelState).toBe("demo");
    expect(currentUrl).toBe("https://abc.trycloudflare.com");

    // 24h elapses.
    timers.fireAll();
    expect(tunnelState).toBe("expired");
    expect(currentUrl).toBe(LOCAL);
    expect(killed).toBe(true);
  });

  test("clear() cancels a pending timer so onExpire never runs", () => {
    const timers = fakeTimers();
    let fired = 0;
    const expiry = createDemoExpiry({
      ttlMs: 1000,
      onExpire: () => fired++,
      setTimer: timers.setTimer.bind(timers),
      clearTimer: timers.clearTimer.bind(timers),
    });

    expiry.arm();
    expect(timers.activeCount()).toBe(1);
    expiry.clear();
    expect(timers.activeCount()).toBe(0);

    timers.fireAll(); // nothing pending
    expect(fired).toBe(0);
  });

  test("clear() is idempotent and safe before arm or after fire", () => {
    const timers = fakeTimers();
    let fired = 0;
    const expiry = createDemoExpiry({
      ttlMs: 1000,
      onExpire: () => fired++,
      setTimer: timers.setTimer.bind(timers),
      clearTimer: timers.clearTimer.bind(timers),
    });

    expiry.clear(); // before any arm — no throw, nothing to cancel
    expiry.arm();
    timers.fireAll();
    expect(fired).toBe(1);
    expiry.clear(); // after fire — handle already dropped, no double-clear
    expect(fired).toBe(1);
  });

  test("re-arm cancels the prior timer so only one fire occurs", () => {
    const timers = fakeTimers();
    let fired = 0;
    const expiry = createDemoExpiry({
      ttlMs: 1000,
      onExpire: () => fired++,
      setTimer: timers.setTimer.bind(timers),
      clearTimer: timers.clearTimer.bind(timers),
    });

    expiry.arm();
    expiry.arm(); // restart — must not leave two timers racing
    expect(timers.activeCount()).toBe(1);

    timers.fireAll();
    expect(fired).toBe(1);
  });
});
