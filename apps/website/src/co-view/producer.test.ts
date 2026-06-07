import { describe, expect, test } from "bun:test";
import type {
  WsCoViewEvent,
  WsCoViewSnapshotRes,
  WsCoViewState,
} from "@uncorded/protocol";

import { createCoViewProducer } from "./producer";
import type { CoViewShellState } from "./state-schema";

// `schedule: (run) => run()` makes coalescing synchronous so tests can assert
// frame emission immediately after notify(). queueMicrotask in production.
function makeImmediate() {
  const sends: (WsCoViewState | WsCoViewEvent | WsCoViewSnapshotRes)[] = [];
  return {
    sends,
    schedule: (run: () => void) => run(),
    send: (msg: WsCoViewState | WsCoViewEvent | WsCoViewSnapshotRes) => {
      sends.push(msg);
    },
  };
}

describe("producer — state coalesce + diff", () => {
  test("first notify emits a full-shape diff at seq=0 with replay=safe", () => {
    const harness = makeImmediate();
    let state: CoViewShellState = { route: { pathname: "/a" } };
    const p = createCoViewProducer({
      sessionId: "S",
      send: harness.send,
      getShellState: () => state,
      schedule: harness.schedule,
      now: () => 1000,
    });

    p.notify();

    expect(harness.sends).toHaveLength(1);
    const frame = harness.sends[0]! as WsCoViewState;
    expect(frame.type).toBe("co-view.state");
    expect(frame.seq).toBe(0);
    expect(frame.replay).toBe("safe");
    expect(frame.diff).toEqual({ route: { pathname: "/a" } });
    expect(p._seq()).toBe(0);
  });

  test("multiple notifies in same tick coalesce into one frame", () => {
    const harness = makeImmediate();
    let state: CoViewShellState = { route: { pathname: "/a" } };
    const p = createCoViewProducer({
      sessionId: "S",
      send: harness.send,
      getShellState: () => state,
      schedule: harness.schedule,
    });

    // simulate 3 rapid changes — but here our schedule fires immediately so
    // each notify flushes. Use real microtask coalescing test below; this one
    // verifies that a notify with no actual change doesn't bump seq.
    p.notify();
    state = { route: { pathname: "/a" } }; // structurally equal
    p.notify();

    expect(harness.sends).toHaveLength(1);
    expect(p._seq()).toBe(0);
  });

  test("subsequent change emits a minimal merge-patch diff", () => {
    const harness = makeImmediate();
    let state: CoViewShellState = {
      route: { pathname: "/a" },
      workspace: { activeId: "w1", layouts: {} },
    };
    const p = createCoViewProducer({
      sessionId: "S",
      send: harness.send,
      getShellState: () => state,
      schedule: harness.schedule,
    });
    p.notify();

    state = {
      route: { pathname: "/b" },
      workspace: { activeId: "w1", layouts: {} },
    };
    p.notify();

    expect(harness.sends).toHaveLength(2);
    const second = harness.sends[1]! as WsCoViewState;
    expect(second.seq).toBe(1);
    expect(second.diff).toEqual({ route: { pathname: "/b" } });
  });

  test("removing a key emits null in the diff (RFC 7396)", () => {
    const harness = makeImmediate();
    let state: CoViewShellState = {
      route: { pathname: "/a" },
      workspace: { activeId: "w1", layouts: {} },
    };
    const p = createCoViewProducer({
      sessionId: "S",
      send: harness.send,
      getShellState: () => state,
      schedule: harness.schedule,
    });
    p.notify();

    state = { route: { pathname: "/a" } };
    p.notify();

    const second = harness.sends[1]! as WsCoViewState;
    expect(second.diff).toEqual({ workspace: null });
  });

  test("snapshot is defensively cloned — host mutations don't rewrite history", () => {
    const harness = makeImmediate();
    const layouts: Record<string, unknown> = { w1: { type: "leaf", id: "L1" } };
    let state: CoViewShellState = {
      workspace: { activeId: "w1", layouts: layouts as never },
    };
    const p = createCoViewProducer({
      sessionId: "S",
      send: harness.send,
      getShellState: () => state,
      schedule: harness.schedule,
    });
    p.notify();
    const snapshotAfterFirst = JSON.parse(JSON.stringify(p._snapshot()));

    // Host mutates the original tree in place.
    layouts["w1"] = { type: "leaf", id: "MUTATED" };
    expect(p._snapshot()).toEqual(snapshotAfterFirst);
  });
});

describe("producer — emitEvent", () => {
  test("emits co-view.event with replay=unsafe by default", () => {
    const harness = makeImmediate();
    const p = createCoViewProducer({
      sessionId: "S",
      send: harness.send,
      getShellState: () => ({}),
      schedule: harness.schedule,
      now: () => 9000,
    });
    p.emitEvent("nav.route_change", { from: "/a", to: "/b" });
    expect(harness.sends).toHaveLength(1);
    const frame = harness.sends[0]! as WsCoViewEvent;
    expect(frame.type).toBe("co-view.event");
    expect(frame.kind).toBe("nav.route_change");
    expect(frame.payload).toEqual({ from: "/a", to: "/b" });
    expect(frame.replay).toBe("unsafe");
    expect(frame.ts).toBe(9000);
  });

  test("explicit replay=safe propagates", () => {
    const harness = makeImmediate();
    const p = createCoViewProducer({
      sessionId: "S",
      send: harness.send,
      getShellState: () => ({}),
      schedule: harness.schedule,
    });
    p.emitEvent("nav.panel_open", { panel_id: "L1" }, "safe");
    const frame = harness.sends[0]! as WsCoViewEvent;
    expect(frame.replay).toBe("safe");
  });
});

describe("producer — snapshot.req routing", () => {
  test("since_seq=-1 returns full_state", () => {
    const harness = makeImmediate();
    let state: CoViewShellState = { route: { pathname: "/a" } };
    const p = createCoViewProducer({
      sessionId: "S",
      send: harness.send,
      getShellState: () => state,
      schedule: harness.schedule,
    });
    p.notify();
    harness.sends.length = 0;

    p.handleSnapshotReq({
      type: "co-view.snapshot.req",
      session_id: "S",
      since_seq: -1,
      member_id: "c-viewer",
    });

    expect(harness.sends).toHaveLength(1);
    const res = harness.sends[0]! as WsCoViewSnapshotRes;
    expect(res.type).toBe("co-view.snapshot.res");
    expect(res.member_id).toBe("c-viewer");
    expect(res.full_state).toEqual({ route: { pathname: "/a" } });
    expect(res.diffs).toBeUndefined();
  });

  test("since_seq within ring returns diff slice as WsCoViewState[]", () => {
    const harness = makeImmediate();
    let state: CoViewShellState = { route: { pathname: "/a" } };
    const p = createCoViewProducer({
      sessionId: "S",
      send: harness.send,
      getShellState: () => state,
      schedule: harness.schedule,
    });
    p.notify(); // seq 0
    state = { route: { pathname: "/b" } };
    p.notify(); // seq 1
    state = { route: { pathname: "/c" } };
    p.notify(); // seq 2
    harness.sends.length = 0;

    p.handleSnapshotReq({
      type: "co-view.snapshot.req",
      session_id: "S",
      since_seq: 0,
      member_id: "c-viewer",
    });

    const res = harness.sends[0]! as WsCoViewSnapshotRes;
    expect(res.diffs).toBeDefined();
    expect(res.diffs!.length).toBe(2);
    expect(res.diffs!.map((d) => d.seq)).toEqual([1, 2]);
    expect(res.full_state).toBeUndefined();
  });

  test("session_id mismatch is dropped silently", () => {
    const harness = makeImmediate();
    const p = createCoViewProducer({
      sessionId: "S",
      send: harness.send,
      getShellState: () => ({ route: { pathname: "/a" } }),
      schedule: harness.schedule,
    });
    p.notify();
    harness.sends.length = 0;

    p.handleSnapshotReq({
      type: "co-view.snapshot.req",
      session_id: "OTHER",
      since_seq: -1,
      member_id: "c-viewer",
    });
    expect(harness.sends).toHaveLength(0);
  });

  test("missing member_id is dropped silently", () => {
    const harness = makeImmediate();
    const p = createCoViewProducer({
      sessionId: "S",
      send: harness.send,
      getShellState: () => ({ route: { pathname: "/a" } }),
      schedule: harness.schedule,
    });
    p.notify();
    harness.sends.length = 0;

    p.handleSnapshotReq({
      type: "co-view.snapshot.req",
      session_id: "S",
      since_seq: -1,
    });
    expect(harness.sends).toHaveLength(0);
  });
});

describe("producer — coalescing via real microtask", () => {
  test("multiple synchronous notifies collapse to one flush", async () => {
    const sends: WsCoViewState[] = [];
    let state: CoViewShellState = { route: { pathname: "/a" } };
    const p = createCoViewProducer({
      sessionId: "S",
      send: (m) => sends.push(m as WsCoViewState),
      getShellState: () => state,
    });

    state = { route: { pathname: "/a" } };
    p.notify();
    state = { route: { pathname: "/b" } };
    p.notify();
    state = { route: { pathname: "/c" } };
    p.notify();

    await new Promise<void>((r) => queueMicrotask(r));

    expect(sends).toHaveLength(1);
    expect(sends[0]!.diff).toEqual({ route: { pathname: "/c" } });
  });
});

describe("producer — shell-state allowlist (spec §The Shell-State Boundary)", () => {
  test("non-allowlisted top-level keys are dropped from the diff", () => {
    const harness = makeImmediate();
    // Cast through unknown so the test can simulate a producer being fed an
    // off-allowlist key (e.g. a misbehaving emitter shipping plugin data).
    let state = {
      route: { pathname: "/a" },
      messages: [{ id: "m1", body: "secret" }],
    } as unknown as CoViewShellState;
    const p = createCoViewProducer({
      sessionId: "S",
      send: harness.send,
      getShellState: () => state,
      schedule: harness.schedule,
    });
    p.notify();

    expect(harness.sends).toHaveLength(1);
    const frame = harness.sends[0]! as WsCoViewState;
    expect(frame.diff).toEqual({ route: { pathname: "/a" } });
    expect(frame.diff).not.toHaveProperty("messages");
  });

  test("allowlist accepts modal/popover/contextMenu/tabs/scrolls/inputs/panelMeta", () => {
    const harness = makeImmediate();
    const state: CoViewShellState = {
      route: { pathname: "/x" },
      modals: [{ id: "m1", title: "T", redacted: false }],
      popovers: [{ id: "p1", redacted: false }],
      contextMenus: [{ id: "c1" }],
      tabs: { tA: { activeId: "tab1" } },
      scrolls: { s1: { top: 100, left: 0 } },
      inputs: { i1: { caret: 0, valueRedacted: true } },
      panelMeta: { L1: { visibility: "skeleton" } },
    };
    const p = createCoViewProducer({
      sessionId: "S",
      send: harness.send,
      getShellState: () => state,
      schedule: harness.schedule,
    });
    p.notify();
    const frame = harness.sends[0]! as WsCoViewState;
    expect(Object.keys(frame.diff).sort()).toEqual(
      ["contextMenus", "inputs", "modals", "panelMeta", "popovers", "route", "scrolls", "tabs"],
    );
  });
});

describe("producer — dispose", () => {
  test("post-dispose notify and emitEvent are no-ops", () => {
    const harness = makeImmediate();
    const p = createCoViewProducer({
      sessionId: "S",
      send: harness.send,
      getShellState: () => ({ route: { pathname: "/a" } }),
      schedule: harness.schedule,
    });
    p.notify();
    expect(harness.sends).toHaveLength(1);
    p.dispose();
    p.notify();
    p.emitEvent("nav.route_change", { to: "/x" });
    expect(harness.sends).toHaveLength(1);
  });
});
