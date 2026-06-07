import { describe, expect, test } from "bun:test";
import {
  createDrainController,
  DRAIN_BROADCAST_TOPIC,
  WS_CLOSE_SERVICE_RESTART,
} from "./drain";
import { defaultUpdateState, type RuntimeUpdateState } from "./update-state/types";
import type { UpdateStateStore, UpdateStateListener } from "./update-state/store";

// ---------------------------------------------------------------------------
// In-memory fakes — drain controller has no I/O of its own; we exercise it
// against a tiny store + a tiny "router" exposing only the two methods it
// touches (broadcastEvent, disconnectAllUsers).
// ---------------------------------------------------------------------------

function makeFakeStore(initial?: Partial<RuntimeUpdateState>): UpdateStateStore {
  let state: RuntimeUpdateState = {
    ...defaultUpdateState("0.0.0-test", 0),
    ...initial,
  };
  const listeners = new Set<UpdateStateListener>();
  return {
    get: () => state,
    set(patch) {
      state = { ...state, ...patch, updatedAt: 1 };
      for (const l of listeners) l(state);
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

interface FakeRouter {
  broadcasts: Array<{ topic: string; payload: unknown }>;
  closes: Array<{ code?: number; reason?: string }>;
  broadcastEvent(topic: string, payload: unknown): void;
  disconnectAllUsers(code?: number, reason?: string): number;
}

function makeFakeRouter(opts?: {
  broadcastThrows?: boolean;
  closeThrows?: boolean;
  openCount?: number;
}): FakeRouter {
  const fake: FakeRouter = {
    broadcasts: [],
    closes: [],
    broadcastEvent(topic, payload) {
      if (opts?.broadcastThrows) throw new Error("broadcast boom");
      fake.broadcasts.push({ topic, payload });
    },
    disconnectAllUsers(code, reason) {
      if (opts?.closeThrows) throw new Error("close boom");
      const args: { code?: number; reason?: string } = {};
      if (code !== undefined) args.code = code;
      if (reason !== undefined) args.reason = reason;
      fake.closes.push(args);
      return opts?.openCount ?? 0;
    },
  };
  return fake;
}

// Manual timer harness — we control elapsed-ms ticks directly.
function makeManualTimer() {
  let pending: { cb: () => void; ms: number } | null = null;
  const setTimeoutFn = (cb: () => void, ms: number): unknown => {
    pending = { cb, ms };
    return Symbol("timer-handle");
  };
  return {
    setTimeoutFn,
    fire(): void {
      if (!pending) throw new Error("no pending timer to fire");
      const cb = pending.cb;
      pending = null;
      cb();
    },
    pendingMs(): number | null {
      return pending?.ms ?? null;
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createDrainController", () => {
  test("isDraining is false until the store transitions to installing", () => {
    const store = makeFakeStore();
    const router = makeFakeRouter();
    const controller = createDrainController({
      updateStateStore: store,
      // Type-narrowing: drain only touches broadcastEvent + disconnectAllUsers,
      // which the fake router exposes verbatim.
      router: router as unknown as Parameters<typeof createDrainController>[0]["router"],
      graceMs: 1,
      onDrainComplete: async () => {},
    });
    expect(controller.isDraining()).toBe(false);

    // Non-installing transitions must not arm drain.
    store.set({ state: "available", availableVersion: "1.1.0" });
    expect(controller.isDraining()).toBe(false);
    controller.dispose();
  });

  test("transition into installing flips isDraining and broadcasts grace_seconds", async () => {
    const store = makeFakeStore();
    const router = makeFakeRouter();
    const timer = makeManualTimer();
    let completed = false;

    const controller = createDrainController({
      updateStateStore: store,
      router: router as unknown as Parameters<typeof createDrainController>[0]["router"],
      graceMs: 30_000,
      setTimeoutFn: timer.setTimeoutFn,
      onDrainComplete: async () => {
        completed = true;
      },
    });

    store.set({ state: "installing" });
    // The flag flips synchronously inside the listener — broadcast is
    // synchronous too but the timer wait + onDrainComplete are async, so
    // give the event loop one tick.
    await Promise.resolve();
    expect(controller.isDraining()).toBe(true);
    expect(router.broadcasts).toHaveLength(1);
    expect(router.broadcasts[0]).toEqual({
      topic: DRAIN_BROADCAST_TOPIC,
      payload: { grace_seconds: 30 },
    });
    // Timer is armed at the configured grace; close-all hasn't fired yet.
    expect(timer.pendingMs()).toBe(30_000);
    expect(router.closes).toHaveLength(0);
    expect(completed).toBe(false);

    timer.fire();
    await controller.drain(); // resolves the in-flight promise

    expect(router.closes).toHaveLength(1);
    expect(router.closes[0]?.code).toBe(WS_CLOSE_SERVICE_RESTART);
    expect(router.closes[0]?.reason).toBe("service-restart");
    expect(completed).toBe(true);
  });

  test("multiple installing transitions trigger drain only once", async () => {
    const store = makeFakeStore();
    const router = makeFakeRouter();
    const timer = makeManualTimer();
    let completedCount = 0;

    const controller = createDrainController({
      updateStateStore: store,
      router: router as unknown as Parameters<typeof createDrainController>[0]["router"],
      graceMs: 100,
      setTimeoutFn: timer.setTimeoutFn,
      onDrainComplete: async () => {
        completedCount += 1;
      },
    });

    store.set({ state: "installing" });
    store.set({ state: "installing", progress: 50 });
    // Even a fresh `installing` write again should not re-arm. (In practice
    // the orchestrator never re-writes the same state, but the controller
    // is defensive.)
    store.set({ state: "available" });
    store.set({ state: "installing" });

    await Promise.resolve();
    expect(router.broadcasts).toHaveLength(1);
    timer.fire();
    await controller.drain();
    expect(router.closes).toHaveLength(1);
    expect(completedCount).toBe(1);
  });

  test("graceMs of 0 skips the timer wait", async () => {
    const store = makeFakeStore();
    const router = makeFakeRouter();
    let completed = false;

    const controller = createDrainController({
      updateStateStore: store,
      router: router as unknown as Parameters<typeof createDrainController>[0]["router"],
      graceMs: 0,
      // Setting setTimeoutFn to a throwing impl proves we never call it.
      setTimeoutFn: () => {
        throw new Error("timer must not be scheduled when graceMs = 0");
      },
      onDrainComplete: async () => {
        completed = true;
      },
    });

    store.set({ state: "installing" });
    await controller.drain();

    expect(router.broadcasts).toHaveLength(1);
    expect(router.broadcasts[0]?.payload).toEqual({ grace_seconds: 0 });
    expect(router.closes).toHaveLength(1);
    expect(completed).toBe(true);
  });

  test("broadcast failure does not stop the rest of the sequence", async () => {
    const store = makeFakeStore();
    const router = makeFakeRouter({ broadcastThrows: true });
    const timer = makeManualTimer();
    let completed = false;

    const controller = createDrainController({
      updateStateStore: store,
      router: router as unknown as Parameters<typeof createDrainController>[0]["router"],
      graceMs: 5_000,
      setTimeoutFn: timer.setTimeoutFn,
      onDrainComplete: async () => {
        completed = true;
      },
    });

    store.set({ state: "installing" });
    await Promise.resolve();
    expect(controller.isDraining()).toBe(true);
    timer.fire();
    await controller.drain();

    // Broadcast threw → no broadcasts recorded; close-all + onComplete still ran.
    expect(router.broadcasts).toHaveLength(0);
    expect(router.closes).toHaveLength(1);
    expect(completed).toBe(true);
  });

  test("close-all failure does not block onDrainComplete", async () => {
    const store = makeFakeStore();
    const router = makeFakeRouter({ closeThrows: true });
    const timer = makeManualTimer();
    let completed = false;

    const controller = createDrainController({
      updateStateStore: store,
      router: router as unknown as Parameters<typeof createDrainController>[0]["router"],
      graceMs: 5_000,
      setTimeoutFn: timer.setTimeoutFn,
      onDrainComplete: async () => {
        completed = true;
      },
    });

    store.set({ state: "installing" });
    await Promise.resolve();
    timer.fire();
    await controller.drain();

    expect(router.broadcasts).toHaveLength(1);
    expect(router.closes).toHaveLength(0);
    expect(completed).toBe(true);
  });

  test("calling drain() before any state change still triggers the sequence", async () => {
    // Intended for tests / manual recovery paths. Confirms the flag flips and
    // the sequence runs even without an `installing` transition having fired.
    const store = makeFakeStore();
    const router = makeFakeRouter();
    let completed = false;
    const timer = makeManualTimer();

    const controller = createDrainController({
      updateStateStore: store,
      router: router as unknown as Parameters<typeof createDrainController>[0]["router"],
      graceMs: 10,
      setTimeoutFn: timer.setTimeoutFn,
      onDrainComplete: async () => {
        completed = true;
      },
    });

    const drainPromise = controller.drain();
    expect(controller.isDraining()).toBe(true);
    timer.fire();
    await drainPromise;

    expect(router.broadcasts).toHaveLength(1);
    expect(router.closes).toHaveLength(1);
    expect(completed).toBe(true);
  });

  test("dispose unsubscribes the store listener — installing after dispose is a noop", () => {
    const store = makeFakeStore();
    const router = makeFakeRouter();
    const controller = createDrainController({
      updateStateStore: store,
      router: router as unknown as Parameters<typeof createDrainController>[0]["router"],
      graceMs: 1_000,
      setTimeoutFn: () => Symbol("never"),
      onDrainComplete: async () => {},
    });

    controller.dispose();
    store.set({ state: "installing" });

    expect(controller.isDraining()).toBe(false);
    expect(router.broadcasts).toHaveLength(0);
  });
});
