import { describe, expect, test } from "bun:test";
import { createRoot } from "solid-js";
import type {
  WsCoViewCursor,
  WsCoViewEvent,
  WsCoViewMemberJoined,
  WsCoViewMemberLeft,
  WsCoViewSnapshotReq,
  WsCoViewSnapshotRes,
  WsCoViewState,
} from "@uncorded/protocol";

import { createCoViewConsumer } from "./consumer";

function stateFrame(seq: number, diff: Record<string, unknown>): WsCoViewState {
  return {
    type: "co-view.state",
    session_id: "S",
    seq,
    diff,
    replay: "safe",
    ts: 0,
  };
}

describe("consumer — apply state frames in order", () => {
  test("applies sequential frames cumulatively", () => {
    createRoot((dispose) => {
      const sends: WsCoViewSnapshotReq[] = [];
      const c = createCoViewConsumer({
        sessionId: "S",
        send: (m) => sends.push(m),
      });

      c.applyStateFrame(stateFrame(0, { route: { pathname: "/a" } }));
      c.applyStateFrame(stateFrame(1, { workspace: { activeId: "w1" } }));
      c.applyStateFrame(stateFrame(2, { route: { pathname: "/b" } }));

      expect(c.lastSeq()).toBe(2);
      expect(c.snapshot()).toEqual({
        route: { pathname: "/b" },
        workspace: { activeId: "w1" },
      });
      expect(sends).toHaveLength(0);
      dispose();
    });
  });

  test("RFC 7396 null deletes a key", () => {
    createRoot((dispose) => {
      const c = createCoViewConsumer({ sessionId: "S", send: () => {} });
      c.applyStateFrame(
        stateFrame(0, { route: { pathname: "/a" }, workspace: { activeId: "w1" } }),
      );
      c.applyStateFrame(stateFrame(1, { workspace: null }));
      expect(c.snapshot()).toEqual({ route: { pathname: "/a" } });
      dispose();
    });
  });

  test("regression / duplicate seq is ignored", () => {
    createRoot((dispose) => {
      const c = createCoViewConsumer({ sessionId: "S", send: () => {} });
      c.applyStateFrame(stateFrame(0, { route: { pathname: "/a" } }));
      c.applyStateFrame(stateFrame(1, { route: { pathname: "/b" } }));
      c.applyStateFrame(stateFrame(0, { route: { pathname: "/STALE" } }));
      c.applyStateFrame(stateFrame(1, { route: { pathname: "/STALE" } }));
      expect(c.snapshot()).toEqual({ route: { pathname: "/b" } });
      expect(c.lastSeq()).toBe(1);
      dispose();
    });
  });

  test("session_id mismatch is dropped", () => {
    createRoot((dispose) => {
      const c = createCoViewConsumer({ sessionId: "S", send: () => {} });
      const stray: WsCoViewState = { ...stateFrame(0, { x: 1 }), session_id: "OTHER" };
      c.applyStateFrame(stray);
      expect(c.lastSeq()).toBe(-1);
      expect(c.snapshot()).toEqual({});
      dispose();
    });
  });

  test("full_state in a state frame replaces snapshot wholesale", () => {
    createRoot((dispose) => {
      const c = createCoViewConsumer({ sessionId: "S", send: () => {} });
      c.applyStateFrame(stateFrame(0, { route: { pathname: "/a" } }));
      const fullFrame: WsCoViewState = {
        type: "co-view.state",
        session_id: "S",
        seq: 1,
        diff: {},
        full_state: { workspace: { activeId: "w2" } },
        replay: "safe",
        ts: 0,
      };
      c.applyStateFrame(fullFrame);
      expect(c.snapshot()).toEqual({ workspace: { activeId: "w2" } });
      expect(c.lastSeq()).toBe(1);
      dispose();
    });
  });
});

describe("consumer — gap detection", () => {
  test("seq gap triggers snapshot.req at last-known seq", () => {
    createRoot((dispose) => {
      const sends: WsCoViewSnapshotReq[] = [];
      const c = createCoViewConsumer({
        sessionId: "S",
        send: (m) => sends.push(m),
      });
      c.applyStateFrame(stateFrame(0, { route: { pathname: "/a" } }));
      // skip seq=1
      c.applyStateFrame(stateFrame(2, { route: { pathname: "/c" } }));

      expect(c.awaitingSnapshot()).toBe(true);
      expect(sends).toHaveLength(1);
      expect(sends[0]).toMatchObject({
        type: "co-view.snapshot.req",
        session_id: "S",
        since_seq: 0,
      });
      // The gap-triggering frame was NOT applied — snapshot still at seq 0.
      expect(c.lastSeq()).toBe(0);
      dispose();
    });
  });

  test("multiple gaps don't fire repeated snapshot.req while awaiting", () => {
    createRoot((dispose) => {
      const sends: WsCoViewSnapshotReq[] = [];
      const c = createCoViewConsumer({
        sessionId: "S",
        send: (m) => sends.push(m),
      });
      c.applyStateFrame(stateFrame(0, { x: 1 }));
      c.applyStateFrame(stateFrame(2, { x: 2 }));
      c.applyStateFrame(stateFrame(4, { x: 3 }));
      c.applyStateFrame(stateFrame(7, { x: 4 }));
      expect(sends).toHaveLength(1);
      dispose();
    });
  });

  test("requestSnapshot() forces a req even without a gap", () => {
    createRoot((dispose) => {
      const sends: WsCoViewSnapshotReq[] = [];
      const c = createCoViewConsumer({
        sessionId: "S",
        send: (m) => sends.push(m),
      });
      c.applyStateFrame(stateFrame(0, { x: 1 }));
      c.requestSnapshot();
      expect(sends).toHaveLength(1);
      expect(sends[0]!.since_seq).toBe(0);
      dispose();
    });
  });
});

describe("consumer — snapshot.res application", () => {
  test("full_state response resets snapshot + lastSeq + clears awaiting", () => {
    createRoot((dispose) => {
      const sends: WsCoViewSnapshotReq[] = [];
      const c = createCoViewConsumer({
        sessionId: "S",
        send: (m) => sends.push(m),
      });
      c.applyStateFrame(stateFrame(0, { x: 1 }));
      c.applyStateFrame(stateFrame(5, { x: 9 })); // gap → request
      expect(c.awaitingSnapshot()).toBe(true);

      const res: WsCoViewSnapshotRes = {
        type: "co-view.snapshot.res",
        session_id: "S",
        seq: 7,
        full_state: { route: { pathname: "/zzz" } },
      };
      c.applySnapshotRes(res);

      expect(c.awaitingSnapshot()).toBe(false);
      expect(c.lastSeq()).toBe(7);
      expect(c.snapshot()).toEqual({ route: { pathname: "/zzz" } });
      dispose();
    });
  });

  test("diffs response applies in order, skips already-seen seqs", () => {
    createRoot((dispose) => {
      const c = createCoViewConsumer({ sessionId: "S", send: () => {} });
      c.applyStateFrame(stateFrame(0, { route: { pathname: "/a" } }));
      c.applyStateFrame(stateFrame(3, {})); // gap → request

      const res: WsCoViewSnapshotRes = {
        type: "co-view.snapshot.res",
        session_id: "S",
        seq: 3,
        diffs: [
          stateFrame(0, { stale: true }),
          stateFrame(1, { workspace: { activeId: "w1" } }),
          stateFrame(2, { workspace: { activeId: "w2" } }),
          stateFrame(3, { route: { pathname: "/d" } }),
        ],
      };
      c.applySnapshotRes(res);

      expect(c.lastSeq()).toBe(3);
      expect(c.snapshot()).toEqual({
        route: { pathname: "/d" },
        workspace: { activeId: "w2" },
      });
      dispose();
    });
  });
});

describe("consumer — events buffer", () => {
  test("buffers events and exposes them in order", () => {
    createRoot((dispose) => {
      const c = createCoViewConsumer({ sessionId: "S", send: () => {} });
      const ev: WsCoViewEvent = {
        type: "co-view.event",
        session_id: "S",
        kind: "nav.route_change",
        payload: { from: "/", to: "/a" },
        replay: "unsafe",
        ts: 0,
      };
      c.applyEventFrame(ev);
      c.applyEventFrame({ ...ev, payload: { from: "/a", to: "/b" } });
      const buf = c.events();
      expect(buf).toHaveLength(2);
      expect(buf[0]!.frame.payload).toEqual({ from: "/", to: "/a" });
      expect(buf[1]!.frame.payload).toEqual({ from: "/a", to: "/b" });
      dispose();
    });
  });

  test("session_id mismatch is dropped", () => {
    createRoot((dispose) => {
      const c = createCoViewConsumer({ sessionId: "S", send: () => {} });
      c.applyEventFrame({
        type: "co-view.event",
        session_id: "OTHER",
        kind: "nav.route_change",
        payload: {},
        replay: "unsafe",
        ts: 0,
      });
      expect(c.events()).toHaveLength(0);
      dispose();
    });
  });
});

describe("consumer — seedSnapshot", () => {
  test("seedSnapshot from join.ack populates initial state without bumping seq", () => {
    createRoot((dispose) => {
      const c = createCoViewConsumer({
        sessionId: "S",
        send: () => {},
        seedSnapshot: { route: { pathname: "/seed" } },
      });
      expect(c.snapshot()).toEqual({ route: { pathname: "/seed" } });
      expect(c.lastSeq()).toBe(-1);
      dispose();
    });
  });
});

// ============================================================================
// PR-CV4: cursor channel + member metadata
// ============================================================================

function cursorFrame(
  member_id: string | undefined,
  x: number,
  y: number,
  state: WsCoViewCursor["state"] = "idle",
  ts = 0,
): WsCoViewCursor {
  const f: WsCoViewCursor = { type: "co-view.cursor", session_id: "S", x, y, state, ts };
  if (member_id !== undefined) f.member_id = member_id;
  return f;
}

function memberJoined(opts: {
  user_id: string;
  member_id?: string;
  color?: string;
}): WsCoViewMemberJoined {
  const out: WsCoViewMemberJoined = {
    type: "co-view.member.joined",
    session_id: "S",
    user_id: opts.user_id,
    color: opts.color ?? "hsl(0, 75%, 45%)",
  };
  if (opts.member_id !== undefined) out.member_id = opts.member_id;
  return out;
}

function memberLeft(opts: {
  user_id: string;
  member_id?: string;
}): WsCoViewMemberLeft {
  const out: WsCoViewMemberLeft = {
    type: "co-view.member.left",
    session_id: "S",
    user_id: opts.user_id,
    reason: "explicit",
  };
  if (opts.member_id !== undefined) out.member_id = opts.member_id;
  return out;
}

describe("consumer — cursor frames", () => {
  test("applyCursorFrame stores per-member entry", () => {
    createRoot((dispose) => {
      const c = createCoViewConsumer({
        sessionId: "S",
        send: () => {},
        startWatchdog: false,
      });
      c.applyCursorFrame(cursorFrame("m1", 100, 200, "hover", 5));
      const map = c.cursors();
      expect(map.size).toBe(1);
      expect(map.get("m1")).toMatchObject({ x: 100, y: 200, state: "hover" });
      dispose();
    });
  });

  test("frames missing member_id are dropped (untrusted, server didn't stamp)", () => {
    createRoot((dispose) => {
      const c = createCoViewConsumer({
        sessionId: "S",
        send: () => {},
        startWatchdog: false,
      });
      c.applyCursorFrame(cursorFrame(undefined, 1, 1));
      expect(c.cursors().size).toBe(0);
      dispose();
    });
  });

  test("wrong session_id is dropped", () => {
    createRoot((dispose) => {
      const c = createCoViewConsumer({
        sessionId: "S",
        send: () => {},
        startWatchdog: false,
      });
      const f = cursorFrame("m1", 1, 1);
      f.session_id = "OTHER";
      c.applyCursorFrame(f);
      expect(c.cursors().size).toBe(0);
      dispose();
    });
  });
});

describe("consumer — pen event integrity (lossy-transport guardrails)", () => {
  function evt(kind: WsCoViewEvent["kind"], member: string | undefined, payload: Record<string, unknown>): WsCoViewEvent {
    const f: WsCoViewEvent = {
      type: "co-view.event",
      session_id: "S",
      kind,
      payload,
      replay: "unsafe",
      ts: 0,
    };
    if (member !== undefined) f.member_id = member;
    return f;
  }

  test("begin → point → end builds and seals a stroke", () => {
    createRoot((dispose) => {
      const c = createCoViewConsumer({
        sessionId: "S",
        send: () => {},
        startWatchdog: false,
        now: () => 100,
      });
      c.applyEventFrame(evt("pen.stroke_begin", "m1", { stroke_id: "k1" }));
      c.applyEventFrame(
        evt("pen.stroke_point", "m1", {
          stroke_id: "k1",
          points: [{ x: 1, y: 1, p: 0.5 }],
        }),
      );
      c.applyEventFrame(evt("pen.stroke_end", "m1", { stroke_id: "k1" }));
      const stroke = c.strokes().get("k1");
      expect(stroke?.memberId).toBe("m1");
      expect(stroke?.points).toHaveLength(1);
      expect(stroke?.completedAt).toBe(100);
      dispose();
    });
  });

  test("point-before-begin synthesizes a begin and accepts the points", () => {
    createRoot((dispose) => {
      const c = createCoViewConsumer({
        sessionId: "S",
        send: () => {},
        startWatchdog: false,
      });
      c.applyEventFrame(
        evt("pen.stroke_point", "m1", {
          stroke_id: "k2",
          points: [{ x: 5, y: 5 }],
        }),
      );
      const stroke = c.strokes().get("k2");
      expect(stroke?.memberId).toBe("m1");
      expect(stroke?.points).toHaveLength(1);
      expect(stroke?.completedAt).toBeNull();
      dispose();
    });
  });

  test("duplicate stroke_end is idempotent (no double-effect)", () => {
    createRoot((dispose) => {
      let t = 1000;
      const c = createCoViewConsumer({
        sessionId: "S",
        send: () => {},
        startWatchdog: false,
        now: () => t,
      });
      c.applyEventFrame(evt("pen.stroke_begin", "m1", { stroke_id: "k3" }));
      t = 2000;
      c.applyEventFrame(evt("pen.stroke_end", "m1", { stroke_id: "k3" }));
      const firstCompleted = c.strokes().get("k3")?.completedAt;
      t = 3000;
      c.applyEventFrame(evt("pen.stroke_end", "m1", { stroke_id: "k3" }));
      // completedAt frozen at first end's clock; duplicate end is a no-op.
      expect(c.strokes().get("k3")?.completedAt).toBe(firstCompleted!);
      expect(firstCompleted).toBe(2000);
      dispose();
    });
  });

  test("reused stroke_id (begin → end → begin) replaces, doesn't merge points", () => {
    createRoot((dispose) => {
      const c = createCoViewConsumer({
        sessionId: "S",
        send: () => {},
        startWatchdog: false,
      });
      c.applyEventFrame(evt("pen.stroke_begin", "m1", { stroke_id: "k4" }));
      c.applyEventFrame(
        evt("pen.stroke_point", "m1", {
          stroke_id: "k4",
          points: [{ x: 1, y: 1 }, { x: 2, y: 2 }],
        }),
      );
      c.applyEventFrame(evt("pen.stroke_end", "m1", { stroke_id: "k4" }));
      // New stroke with the same id wipes the old one.
      c.applyEventFrame(evt("pen.stroke_begin", "m1", { stroke_id: "k4" }));
      const stroke = c.strokes().get("k4");
      expect(stroke?.points).toHaveLength(0);
      expect(stroke?.completedAt).toBeNull();
      dispose();
    });
  });

  test("late stroke_point after stroke_end is dropped", () => {
    createRoot((dispose) => {
      const c = createCoViewConsumer({
        sessionId: "S",
        send: () => {},
        startWatchdog: false,
      });
      c.applyEventFrame(evt("pen.stroke_begin", "m1", { stroke_id: "k5" }));
      c.applyEventFrame(
        evt("pen.stroke_point", "m1", { stroke_id: "k5", points: [{ x: 1, y: 1 }] }),
      );
      c.applyEventFrame(evt("pen.stroke_end", "m1", { stroke_id: "k5" }));
      const sealedLength = c.strokes().get("k5")?.points.length;
      c.applyEventFrame(
        evt("pen.stroke_point", "m1", { stroke_id: "k5", points: [{ x: 99, y: 99 }] }),
      );
      expect(c.strokes().get("k5")?.points.length).toBe(sealedLength);
      dispose();
    });
  });

  test("stuck-stroke watchdog auto-ends in-flight strokes after STROKE_STUCK_MS", () => {
    createRoot((dispose) => {
      let t = 1000;
      const c = createCoViewConsumer({
        sessionId: "S",
        send: () => {},
        startWatchdog: false,
        strokeStuckMs: 5000,
        strokeTtlMs: 4000,
        now: () => t,
      });
      c.applyEventFrame(evt("pen.stroke_begin", "m1", { stroke_id: "k6" }));
      c.applyEventFrame(
        evt("pen.stroke_point", "m1", { stroke_id: "k6", points: [{ x: 1, y: 1 }] }),
      );
      // Jump past the stuck threshold.
      t = 1000 + 5000 + 1;
      c._tick();
      expect(c.strokes().get("k6")?.completedAt).not.toBeNull();
      dispose();
    });
  });

  test("color-spoofing rejected: client-supplied color in payload is not stored", () => {
    createRoot((dispose) => {
      const c = createCoViewConsumer({
        sessionId: "S",
        send: () => {},
        startWatchdog: false,
      });
      c.applyEventFrame(
        evt("pen.stroke_begin", "m1", {
          stroke_id: "k7",
          color: "#ff0000",
        }),
      );
      const stroke = c.strokes().get("k7");
      expect(stroke).toBeDefined();
      // The stored stroke entry has no color field — color is resolved at render
      // time from memberMeta[memberId], not from the inbound payload.
      expect((stroke as unknown as Record<string, unknown>)["color"])
        .toBeUndefined();
      dispose();
    });
  });

  test("pen.clear { scope: 'mine' } removes only that member's strokes", () => {
    createRoot((dispose) => {
      const c = createCoViewConsumer({
        sessionId: "S",
        send: () => {},
        startWatchdog: false,
      });
      c.applyEventFrame(evt("pen.stroke_begin", "m1", { stroke_id: "kA" }));
      c.applyEventFrame(evt("pen.stroke_begin", "m2", { stroke_id: "kB" }));
      c.applyEventFrame(evt("pen.clear", "m1", { scope: "mine" }));
      expect(c.strokes().has("kA")).toBe(false);
      expect(c.strokes().has("kB")).toBe(true);
      dispose();
    });
  });

  test("pen.clear { scope: 'all' } clears every stroke", () => {
    createRoot((dispose) => {
      const c = createCoViewConsumer({
        sessionId: "S",
        send: () => {},
        startWatchdog: false,
      });
      c.applyEventFrame(evt("pen.stroke_begin", "m1", { stroke_id: "kA" }));
      c.applyEventFrame(evt("pen.stroke_begin", "m2", { stroke_id: "kB" }));
      // Server stamps the host's member_id on the broadcast.
      c.applyEventFrame(evt("pen.clear", "host", { scope: "all" }));
      expect(c.strokes().size).toBe(0);
      dispose();
    });
  });

  test("TTL eviction removes completed strokes after completedAt + ttlMs", () => {
    createRoot((dispose) => {
      let t = 0;
      const c = createCoViewConsumer({
        sessionId: "S",
        send: () => {},
        startWatchdog: false,
        strokeTtlMs: 4000,
        strokeStuckMs: 60_000,
        now: () => t,
      });
      t = 1000;
      c.applyEventFrame(evt("pen.stroke_begin", "m1", { stroke_id: "k8" }));
      c.applyEventFrame(evt("pen.stroke_end", "m1", { stroke_id: "k8" }));
      expect(c.strokes().has("k8")).toBe(true);
      t = 1000 + 4000 + 1;
      c._tick();
      expect(c.strokes().has("k8")).toBe(false);
      dispose();
    });
  });
});

describe("consumer — member metadata + leave eviction", () => {
  test("applyMemberJoined keys memberMeta by member_id when present", () => {
    createRoot((dispose) => {
      const c = createCoViewConsumer({
        sessionId: "S",
        send: () => {},
        startWatchdog: false,
      });
      c.applyMemberJoined(
        memberJoined({ user_id: "u1", member_id: "conn-1", color: "hsl(180, 75%, 45%)" }),
      );
      expect(c.memberMeta().get("conn-1")?.color).toBe("hsl(180, 75%, 45%)");
      dispose();
    });
  });

  test("applyMemberJoined falls back to user_id when member_id absent", () => {
    createRoot((dispose) => {
      const c = createCoViewConsumer({
        sessionId: "S",
        send: () => {},
        startWatchdog: false,
      });
      c.applyMemberJoined(memberJoined({ user_id: "u1" }));
      expect(c.memberMeta().has("u1")).toBe(true);
      dispose();
    });
  });

  test("applyMemberLeft evicts memberMeta + cursor + strokes for that member", () => {
    createRoot((dispose) => {
      const c = createCoViewConsumer({
        sessionId: "S",
        send: () => {},
        startWatchdog: false,
      });
      c.applyMemberJoined(memberJoined({ user_id: "u1", member_id: "m1" }));
      c.applyCursorFrame(cursorFrame("m1", 1, 1));
      c.applyEventFrame({
        type: "co-view.event",
        session_id: "S",
        kind: "pen.stroke_begin",
        payload: { stroke_id: "kX" },
        replay: "unsafe",
        ts: 0,
        member_id: "m1",
      });

      c.applyMemberLeft(memberLeft({ user_id: "u1", member_id: "m1" }));

      expect(c.memberMeta().has("m1")).toBe(false);
      expect(c.cursors().has("m1")).toBe(false);
      expect(c.strokes().has("kX")).toBe(false);
      dispose();
    });
  });
});

describe("consumer — cursor stale eviction", () => {
  test("cursor entries older than CURSOR_STALE_MS are evicted on tick", () => {
    createRoot((dispose) => {
      let t = 0;
      const c = createCoViewConsumer({
        sessionId: "S",
        send: () => {},
        startWatchdog: false,
        cursorStaleMs: 10_000,
        now: () => t,
      });
      t = 1000;
      c.applyCursorFrame(cursorFrame("m1", 1, 1));
      expect(c.cursors().has("m1")).toBe(true);

      t = 1000 + 10_000 + 1;
      c._tick();
      expect(c.cursors().has("m1")).toBe(false);
      dispose();
    });
  });
});
