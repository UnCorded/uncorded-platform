import { describe, expect, test } from "bun:test";
import { createTrailingDebouncer, type DebouncerHooks } from "./trailing-debounce";

interface FakeClock {
  now: number;
  setTimer: DebouncerHooks["setTimer"];
  clearTimer: DebouncerHooks["clearTimer"];
  advance(ms: number): void;
}

function fakeClock(): FakeClock {
  let next = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: FakeClock = {
    now: 0,
    setTimer(fn, ms) {
      const id = next++;
      timers.set(id, { at: clock.now + ms, fn });
      return id;
    },
    clearTimer(h) {
      timers.delete(h as number);
    },
    advance(ms) {
      clock.now += ms;
      for (const [id, t] of [...timers]) {
        if (t.at <= clock.now) {
          timers.delete(id);
          t.fn();
        }
      }
    },
  };
  return clock;
}

describe("createTrailingDebouncer", () => {
  test("fires once after the trailing edge regardless of how many fires happen inside the window", () => {
    const clock = fakeClock();
    const calls: number[] = [];
    const d = createTrailingDebouncer<[number]>((x) => calls.push(x), 100, clock);
    d.fire(1);
    clock.advance(20);
    d.fire(2);
    clock.advance(20);
    d.fire(3);
    expect(calls).toEqual([]); // none yet — still inside the trailing window
    clock.advance(99);
    expect(calls).toEqual([]); // still 1ms shy of the trailing edge
    clock.advance(1);
    expect(calls).toEqual([3]); // exactly one frame, with the latest args
  });

  test("subsequent quiet emits no further frames", () => {
    const clock = fakeClock();
    const calls: number[] = [];
    const d = createTrailingDebouncer<[number]>((x) => calls.push(x), 100, clock);
    d.fire(1);
    clock.advance(100);
    expect(calls).toEqual([1]);
    clock.advance(10_000);
    expect(calls).toEqual([1]);
  });

  test("flush emits the pending args immediately and clears the timer", () => {
    const clock = fakeClock();
    const calls: number[] = [];
    const d = createTrailingDebouncer<[number]>((x) => calls.push(x), 100, clock);
    d.fire(42);
    d.flush();
    expect(calls).toEqual([42]);
    clock.advance(1000);
    expect(calls).toEqual([42]); // no late firing after flush
  });

  test("cancel drops the pending args without firing", () => {
    const clock = fakeClock();
    const calls: number[] = [];
    const d = createTrailingDebouncer<[number]>((x) => calls.push(x), 100, clock);
    d.fire(7);
    d.cancel();
    clock.advance(1000);
    expect(calls).toEqual([]);
  });

  test("each new fire restarts the trailing window with the latest args", () => {
    const clock = fakeClock();
    const calls: string[] = [];
    const d = createTrailingDebouncer<[string]>((x) => calls.push(x), 100, clock);
    d.fire("a");
    clock.advance(99);
    d.fire("b"); // resets the timer
    clock.advance(99);
    expect(calls).toEqual([]);
    clock.advance(1);
    expect(calls).toEqual(["b"]);
  });
});
