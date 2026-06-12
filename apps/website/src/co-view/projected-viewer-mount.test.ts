// CoView projected viewer mount tests (CV-FOUND-7).
//
// The mount path's testable substance lives in the controller
// (`createProjectedViewerMountController`); the thin `.tsx` component is a
// declarative wrapper covered by typecheck only (its element templates touch
// `document` at module load, and this repo has no DOM test environment - exactly
// why `render-tree-viewer-view.tsx` has no test either). These tests drive the
// controller with an injected fake store, so no socket is dialed and frame
// arrival is deterministic.
//
// Coverage:
//   - Dormant by default and when `enabled: false`: no store is constructed or
//     subscribed, and nothing mounts.
//   - Enabled via DI: constructs exactly one store, mounts the stored frame, and
//     reads the correct frame per `sessionId`.
//   - A missing frame reads `undefined` (the component shows its placeholder,
//     never stale content).
//   - Disposal tears down the store subscription.
//   - The mount path passes already-projected frames through untouched, so it
//     introduces no protected bytes (a withheld value stays a bytes-free
//     placeholder through the exact pipeline the view runs).

import { describe, expect, test } from "bun:test";
import type {
  CoViewProjectedRenderFrame,
  WsCoViewRenderTreeProjected,
} from "@uncorded/protocol";

import type { ProjectedFrameStore } from "./projected-frame-store";
import { isProjectedFrameEnvelope } from "./projected-frame-store";
import { createProjectedViewerMountController } from "./projected-viewer-mount";
import {
  CO_VIEW_PROJECTED_VIEWER_ENABLED,
  resolveProjectedFrame,
} from "./render-tree-viewer";

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

// A projected frame whose value is `withheld`: a real value exists on the host,
// but no bytes may reach this viewer - the value carries a placeholder, not data.
function withheldFrame(surfaceId: string): CoViewProjectedRenderFrame {
  return {
    surfaceId,
    root: {
      id: "root",
      kind: "text",
      box: { x: 0, y: 0, width: 10, height: 10 },
      value: { state: "withheld", placeholderShape: { mode: "synthetic" } },
    },
  };
}

// A fake projected-frame store: a plain map plus a dispose counter. It models
// "already-projected frames have landed here"; the controller's only job is to
// pass them through, so the fake never projects or copies anything.
interface FakeStore extends ProjectedFrameStore {
  disposed: number;
}

function fakeStore(): FakeStore {
  const bySession = new Map<string, CoViewProjectedRenderFrame>();
  const store: FakeStore = {
    disposed: 0,
    frame: (sessionId) => bySession.get(sessionId),
    apply: (frame) => {
      if (isProjectedFrameEnvelope(frame)) bySession.set(frame.session_id, frame.frame);
    },
    clearSession: (sessionId) => {
      bySession.delete(sessionId);
    },
    clearAll: () => {
      bySession.clear();
    },
    dispose: () => {
      store.disposed += 1;
    },
  };
  return store;
}

// A factory that hands back a given store and records how many times - and with
// what `serverId` - it was constructed.
function trackedFactory(store: ProjectedFrameStore) {
  const calls: string[] = [];
  return {
    factory: (serverId: string): ProjectedFrameStore => {
      calls.push(serverId);
      return store;
    },
    calls,
  };
}

// --- dormant path ----------------------------------------------------------

describe("createProjectedViewerMountController - dormant", () => {
  test("the viewer flag ships disabled (the path stays dormant by default)", () => {
    expect(CO_VIEW_PROJECTED_VIEWER_ENABLED).toBe(false);
  });

  test("default (no `enabled`) constructs no store and mounts nothing", () => {
    const store = fakeStore();
    const { factory, calls } = trackedFactory(store);
    const ctrl = createProjectedViewerMountController("srv", { createStore: factory });

    expect(ctrl.active).toBe(false);
    expect(calls).toEqual([]); // the dormant path never calls the factory
    expect(ctrl.frame("A")).toBeUndefined();
    expect(() => ctrl.dispose()).not.toThrow();
    expect(store.disposed).toBe(0);
  });

  test("`enabled: false` does not construct or subscribe to the store", () => {
    const store = fakeStore();
    const { factory, calls } = trackedFactory(store);
    const ctrl = createProjectedViewerMountController("srv", {
      enabled: false,
      createStore: factory,
    });

    expect(ctrl.active).toBe(false);
    expect(calls).toEqual([]);
    expect(ctrl.frame("A")).toBeUndefined();
  });
});

// --- live path -------------------------------------------------------------

describe("createProjectedViewerMountController - enabled (via DI)", () => {
  test("constructs exactly one store for the server", () => {
    const store = fakeStore();
    const { factory, calls } = trackedFactory(store);
    const ctrl = createProjectedViewerMountController("srv-1", {
      enabled: true,
      createStore: factory,
    });
    try {
      expect(ctrl.active).toBe(true);
      expect(calls).toEqual(["srv-1"]); // one store, for the requested server
    } finally {
      ctrl.dispose();
    }
  });

  test("mounts the stored frame and reads the correct one per sessionId", () => {
    const store = fakeStore();
    const ctrl = createProjectedViewerMountController("srv", {
      enabled: true,
      createStore: () => store,
    });
    try {
      // No frame yet -> undefined (the component shows its placeholder, not stale
      // content).
      expect(ctrl.frame("A")).toBeUndefined();

      store.apply(envelope("A", "surf-A"));
      store.apply(envelope("B", "surf-B"));

      // Switching sessionId reads that session's frame - never the other's.
      expect(ctrl.frame("A")?.surfaceId).toBe("surf-A");
      expect(ctrl.frame("B")?.surfaceId).toBe("surf-B");
      // An unknown session stays empty (placeholder, never stale).
      expect(ctrl.frame("ghost")).toBeUndefined();
    } finally {
      ctrl.dispose();
    }
  });

  test("dispose tears down the store subscription", () => {
    const store = fakeStore();
    const ctrl = createProjectedViewerMountController("srv", {
      enabled: true,
      createStore: () => store,
    });
    expect(store.disposed).toBe(0);
    ctrl.dispose();
    expect(store.disposed).toBe(1);
  });
});

// --- privacy: no protected bytes introduced by the mount path --------------

describe("createProjectedViewerMountController - introduces no protected bytes", () => {
  test("passes the already-projected frame through untouched (no copy/synthesis)", () => {
    const store = fakeStore();
    const ctrl = createProjectedViewerMountController("srv", {
      enabled: true,
      createStore: () => store,
    });
    try {
      const frame = withheldFrame("A");
      store.apply({
        type: "co-view.render-tree.projected",
        session_id: "A",
        frame,
      });

      // The controller hands the view the EXACT stored frame: it never rebuilds
      // a frame, so it cannot synthesize a value the projection withheld.
      const mounted = ctrl.frame("A");
      expect(mounted).toBe(frame);

      // And the exact pipeline the view runs (`resolveProjectedFrame`, inside
      // `CoViewProjectedFrameView`) keeps the withheld value a bytes-free
      // placeholder - no host bytes appear because none were ever present.
      const safe = resolveProjectedFrame(mounted!);
      expect(safe.root.content).toEqual({
        kind: "placeholder",
        placeholder: { reason: "withheld", mode: "synthetic" },
      });
    } finally {
      ctrl.dispose();
    }
  });
});
