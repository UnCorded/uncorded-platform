// Projected-frame store tests (CV-FOUND-6).
//
// The substance lives in the pure helpers (mirrors active-sessions-store.test.ts
// testing `reduceListFrame` rather than the live store). The thin Solid wrapper
// gets a light pass through its imperative surface — constructing it dials no
// socket (the observer buffers into ws.ts's pending set when no connection
// exists), so it is safe to exercise here.

import { describe, expect, test } from "bun:test";
import type {
  CoViewProjectedRenderFrame,
  WsCoViewRenderTreeFrame,
  WsCoViewRenderTreeProjected,
} from "@uncorded/protocol";

import {
  applyProjectedFrame,
  clearAllProjectedSessions,
  clearProjectedSession,
  createEmptyProjectedFrameStore,
  createProjectedFrameStore,
  getProjectedFrame,
  isProjectedFrameEnvelope,
} from "./projected-frame-store";

// --- fixtures --------------------------------------------------------------

function projectedFrame(surfaceId: string): CoViewProjectedRenderFrame {
  return {
    surfaceId,
    root: { id: "root", kind: "element", box: { x: 0, y: 0, width: 10, height: 10 } },
  };
}

function envelope(sessionId: string, surfaceId = sessionId): WsCoViewRenderTreeProjected {
  return {
    type: "co-view.render-tree.projected",
    session_id: sessionId,
    frame: projectedFrame(surfaceId),
  };
}

// A CANONICAL render frame — the thing the store must never hold. Typed as the
// projected envelope via `unknown` to model a wrong frame arriving at the helper.
function canonicalEnvelope(sessionId: string): WsCoViewRenderTreeProjected {
  const canonical: WsCoViewRenderTreeFrame = {
    type: "co-view.render-tree.frame",
    session_id: sessionId,
    frame: {
      surfaceId: sessionId,
      root: { id: "root", kind: "element", box: { x: 0, y: 0, width: 1, height: 1 } },
    },
  };
  return canonical as unknown as WsCoViewRenderTreeProjected;
}

// --- pure helpers ----------------------------------------------------------

describe("applyProjectedFrame / getProjectedFrame", () => {
  test("stores a projected frame for a session and retrieves it", () => {
    const env = envelope("A");
    const state = applyProjectedFrame(createEmptyProjectedFrameStore(), env);
    expect(getProjectedFrame(state, "A")).toEqual(env.frame);
  });

  test("a later frame for a session replaces the earlier one", () => {
    let state = applyProjectedFrame(createEmptyProjectedFrameStore(), envelope("A", "first"));
    const second = envelope("A", "second");
    state = applyProjectedFrame(state, second);
    expect(getProjectedFrame(state, "A")?.surfaceId).toBe("second");
    expect(Object.keys(state.bySession)).toEqual(["A"]);
  });

  test("frames for different sessions are isolated", () => {
    let state = applyProjectedFrame(createEmptyProjectedFrameStore(), envelope("A", "surf-A"));
    state = applyProjectedFrame(state, envelope("B", "surf-B"));
    expect(getProjectedFrame(state, "A")?.surfaceId).toBe("surf-A");
    expect(getProjectedFrame(state, "B")?.surfaceId).toBe("surf-B");
  });

  test("stores `frame.frame` referentially — introduces no copied/canonical bytes", () => {
    const env = envelope("A");
    const state = applyProjectedFrame(createEmptyProjectedFrameStore(), env);
    // Exact reference: the store never rebuilds the frame, so it cannot
    // synthesize values the projection withheld.
    expect(getProjectedFrame(state, "A")).toBe(env.frame);
  });
});

describe("applyProjectedFrame — fail-closed no-ops (same state reference)", () => {
  test("a canonical `co-view.render-tree.frame` envelope is rejected", () => {
    const state = createEmptyProjectedFrameStore();
    const next = applyProjectedFrame(state, canonicalEnvelope("A"));
    expect(next).toBe(state);
    expect(getProjectedFrame(next, "A")).toBeUndefined();
  });

  test("a wrong `type` is rejected", () => {
    const state = createEmptyProjectedFrameStore();
    const bad = { type: "co-view.state", session_id: "A", frame: projectedFrame("A") };
    const next = applyProjectedFrame(state, bad);
    expect(next).toBe(state);
  });

  test("a missing session_id is rejected", () => {
    const state = createEmptyProjectedFrameStore();
    const bad = { type: "co-view.render-tree.projected", frame: projectedFrame("A") };
    const next = applyProjectedFrame(state, bad);
    expect(next).toBe(state);
  });

  test("an empty session_id is rejected", () => {
    const state = createEmptyProjectedFrameStore();
    const next = applyProjectedFrame(state, envelope(""));
    expect(next).toBe(state);
  });

  test("a missing frame payload is rejected", () => {
    const state = createEmptyProjectedFrameStore();
    const bad = { type: "co-view.render-tree.projected", session_id: "A" };
    const next = applyProjectedFrame(state, bad);
    expect(next).toBe(state);
  });
});

describe("clearProjectedSession", () => {
  test("clearing one session does not clear another", () => {
    let state = applyProjectedFrame(createEmptyProjectedFrameStore(), envelope("A"));
    state = applyProjectedFrame(state, envelope("B"));
    state = clearProjectedSession(state, "A");
    expect(getProjectedFrame(state, "A")).toBeUndefined();
    expect(getProjectedFrame(state, "B")).toBeDefined();
  });

  test("clearing an unknown session is a no-op (same reference)", () => {
    const state = applyProjectedFrame(createEmptyProjectedFrameStore(), envelope("A"));
    expect(clearProjectedSession(state, "ghost")).toBe(state);
  });
});

describe("clearAllProjectedSessions", () => {
  test("empties the store", () => {
    let state = applyProjectedFrame(createEmptyProjectedFrameStore(), envelope("A"));
    state = applyProjectedFrame(state, envelope("B"));
    state = clearAllProjectedSessions(state);
    expect(Object.keys(state.bySession)).toEqual([]);
  });

  test("clearing an already-empty store is a no-op (same reference)", () => {
    const state = createEmptyProjectedFrameStore();
    expect(clearAllProjectedSessions(state)).toBe(state);
  });
});

describe("isProjectedFrameEnvelope", () => {
  test("accepts a well-formed projected envelope", () => {
    expect(isProjectedFrameEnvelope(envelope("A"))).toBe(true);
  });

  test("rejects non-objects, wrong types, and a canonical frame", () => {
    expect(isProjectedFrameEnvelope(null)).toBe(false);
    expect(isProjectedFrameEnvelope("co-view.render-tree.projected")).toBe(false);
    expect(isProjectedFrameEnvelope(canonicalEnvelope("A"))).toBe(false);
    expect(isProjectedFrameEnvelope({ type: "co-view.render-tree.projected", session_id: "A" })).toBe(false);
  });
});

// --- thin Solid wrapper ----------------------------------------------------

describe("createProjectedFrameStore", () => {
  test("apply makes a frame reactively retrievable; clear paths work; dispose is safe", () => {
    const store = createProjectedFrameStore("srv-projected-test");
    try {
      store.apply(envelope("A", "surf-A"));
      store.apply(envelope("B", "surf-B"));
      expect(store.frame("A")?.surfaceId).toBe("surf-A");
      expect(store.frame("B")?.surfaceId).toBe("surf-B");

      // A non-projected frame is ignored.
      store.apply(canonicalEnvelope("C"));
      expect(store.frame("C")).toBeUndefined();

      store.clearSession("A");
      expect(store.frame("A")).toBeUndefined();
      expect(store.frame("B")?.surfaceId).toBe("surf-B");

      store.clearAll();
      expect(store.frame("B")).toBeUndefined();
    } finally {
      store.dispose();
    }
  });
});
