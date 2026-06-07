import { describe, expect, test } from "bun:test";
import type { WsCoViewEvent } from "@uncorded/protocol";

import {
  PEN_POINT_BATCH_MAX,
  PEN_POINT_BATCH_MS,
  createPenProducer,
} from "./pen-producer";

interface FakeListener {
  type: string;
  fn: (ev: unknown) => void;
}

function makeWindow() {
  const winListeners: FakeListener[] = [];
  const win = {
    document: {} as Document,
    addEventListener(
      type: string,
      fn: (ev: unknown) => void,
      _opts?: AddEventListenerOptions | boolean,
    ): void {
      winListeners.push({ type, fn });
    },
    removeEventListener(type: string, fn: (ev: unknown) => void): void {
      const i = winListeners.findIndex((l) => l.type === type && l.fn === fn);
      if (i >= 0) winListeners.splice(i, 1);
    },
  };
  function fire(type: string, ev: unknown): void {
    for (const l of winListeners.slice()) {
      if (l.type === type) l.fn(ev);
    }
  }
  function listenerCount(type: string): number {
    return winListeners.filter((l) => l.type === type).length;
  }
  return { win, fire, listenerCount };
}

function makeSink() {
  const sends: WsCoViewEvent[] = [];
  return { sends, send: (f: WsCoViewEvent) => sends.push(f) };
}

let strokeIdSeq = 0;
function nextStrokeId(): string {
  strokeIdSeq += 1;
  return `stroke-${strokeIdSeq}`;
}

describe("pen-producer — Alt+P toggle and isActive", () => {
  test("inactive by default; Alt+P toggles", () => {
    const w = makeWindow();
    const sink = makeSink();
    const p = createPenProducer({
      sessionId: "S",
      send: sink.send,
      window: w.win as unknown as Window & typeof globalThis,
      generateStrokeId: nextStrokeId,
      now: () => 0,
    });

    expect(p.isActive()).toBe(false);
    w.fire("keydown", { altKey: true, key: "p" });
    expect(p.isActive()).toBe(true);
    w.fire("keydown", { altKey: true, key: "P" });
    expect(p.isActive()).toBe(false);
    p.dispose();
  });

  test("pointer events do nothing while inactive", () => {
    const w = makeWindow();
    const sink = makeSink();
    const p = createPenProducer({
      sessionId: "S",
      send: sink.send,
      window: w.win as unknown as Window & typeof globalThis,
      generateStrokeId: nextStrokeId,
      now: () => 0,
    });

    w.fire("pointerdown", { clientX: 10, clientY: 10, pressure: 0.5 });
    w.fire("pointermove", { clientX: 20, clientY: 20, pressure: 0.5 });
    w.fire("pointerup", { clientX: 20, clientY: 20, pressure: 0 });
    expect(sink.sends).toHaveLength(0);
    p.dispose();
  });
});

describe("pen-producer — stroke lifecycle", () => {
  test("down → move*N → up emits begin → point → end", async () => {
    const w = makeWindow();
    const sink = makeSink();
    let t = 0;
    const p = createPenProducer({
      sessionId: "S",
      send: sink.send,
      window: w.win as unknown as Window & typeof globalThis,
      generateStrokeId: () => "S1",
      now: () => t,
    });
    p.toggle(); // active

    t = 100;
    w.fire("pointerdown", { clientX: 10, clientY: 10, pressure: 0.5 });
    // begin + first point buffered (no flush yet — only 1 point and < 33ms).
    expect(sink.sends).toHaveLength(1);
    expect(sink.sends[0]).toMatchObject({
      kind: "pen.stroke_begin",
      payload: { stroke_id: "S1" },
    });
    expect(sink.sends[0]?.payload["color"]).toBeUndefined();

    t = 110;
    w.fire("pointermove", { clientX: 20, clientY: 20, pressure: 0.6 });
    t = 120;
    w.fire("pointermove", { clientX: 30, clientY: 30, pressure: 0.7 });
    expect(sink.sends).toHaveLength(1); // still buffered

    t = 200;
    w.fire("pointerup", { clientX: 30, clientY: 30, pressure: 0 });
    // pointerup → flushPoints → end
    expect(sink.sends.length).toBeGreaterThanOrEqual(3);
    const kinds = sink.sends.map((f) => f.kind);
    expect(kinds[0]).toBe("pen.stroke_begin");
    expect(kinds.at(-2)).toBe("pen.stroke_point");
    expect(kinds.at(-1)).toBe("pen.stroke_end");

    const pointFrame = sink.sends[sink.sends.length - 2];
    expect(pointFrame?.payload["stroke_id"]).toBe("S1");
    expect(Array.isArray(pointFrame?.payload["points"])).toBe(true);
    p.dispose();
  });

  test("16 points trigger an immediate batch flush (no waiting for trailing timer)", () => {
    const w = makeWindow();
    const sink = makeSink();
    let t = 0;
    const p = createPenProducer({
      sessionId: "S",
      send: sink.send,
      window: w.win as unknown as Window & typeof globalThis,
      generateStrokeId: () => "S2",
      now: () => t,
    });
    p.toggle();

    w.fire("pointerdown", { clientX: 0, clientY: 0, pressure: 0.5 });
    // Already 1 point buffered. Add 15 more → 16 total, triggers flush.
    for (let i = 1; i < PEN_POINT_BATCH_MAX; i++) {
      t += 1;
      w.fire("pointermove", { clientX: i, clientY: i, pressure: 0.5 });
    }
    // Should now have begin + at least one point flush.
    const points = sink.sends.filter((f) => f.kind === "pen.stroke_point");
    expect(points.length).toBeGreaterThanOrEqual(1);
    const firstBatch = points[0];
    if (firstBatch === undefined) throw new Error("expected first batch");
    expect((firstBatch.payload["points"] as unknown[]).length).toBe(
      PEN_POINT_BATCH_MAX,
    );
    p.dispose();
  });

  test("trailing 33 ms timer flushes a partial batch", async () => {
    const w = makeWindow();
    const sink = makeSink();
    let t = 0;
    const p = createPenProducer({
      sessionId: "S",
      send: sink.send,
      window: w.win as unknown as Window & typeof globalThis,
      generateStrokeId: () => "S3",
      now: () => t,
    });
    p.toggle();

    w.fire("pointerdown", { clientX: 0, clientY: 0, pressure: 0.5 });
    t += 5;
    w.fire("pointermove", { clientX: 1, clientY: 1, pressure: 0.5 });
    expect(sink.sends.filter((f) => f.kind === "pen.stroke_point")).toHaveLength(0);

    await new Promise((r) => setTimeout(r, PEN_POINT_BATCH_MS + 10));
    expect(sink.sends.filter((f) => f.kind === "pen.stroke_point").length)
      .toBeGreaterThanOrEqual(1);
    p.dispose();
  });

  test("Esc mid-stroke emits pen.stroke_end", () => {
    const w = makeWindow();
    const sink = makeSink();
    const p = createPenProducer({
      sessionId: "S",
      send: sink.send,
      window: w.win as unknown as Window & typeof globalThis,
      generateStrokeId: () => "S4",
      now: () => 0,
    });
    p.toggle();

    w.fire("pointerdown", { clientX: 0, clientY: 0, pressure: 0.5 });
    w.fire("keydown", { key: "Escape" });
    const kinds = sink.sends.map((f) => f.kind);
    expect(kinds.at(-1)).toBe("pen.stroke_end");
    p.dispose();
  });

  test("toggle off mid-stroke emits pen.stroke_end", () => {
    const w = makeWindow();
    const sink = makeSink();
    const p = createPenProducer({
      sessionId: "S",
      send: sink.send,
      window: w.win as unknown as Window & typeof globalThis,
      generateStrokeId: () => "S5",
      now: () => 0,
    });
    p.toggle();
    w.fire("pointerdown", { clientX: 0, clientY: 0, pressure: 0.5 });
    p.toggle(); // back to inactive — should end the stroke
    expect(sink.sends.at(-1)?.kind).toBe("pen.stroke_end");
    p.dispose();
  });
});

describe("pen-producer — clearMine + clearAll", () => {
  test("clearMine emits scope: 'mine' regardless of host", () => {
    const w = makeWindow();
    const sink = makeSink();
    const p = createPenProducer({
      sessionId: "S",
      send: sink.send,
      window: w.win as unknown as Window & typeof globalThis,
      isHost: () => false,
      now: () => 0,
    });
    p.clearMine();
    expect(sink.sends).toEqual([
      {
        type: "co-view.event",
        session_id: "S",
        kind: "pen.clear",
        payload: { scope: "mine" },
        replay: "unsafe",
        ts: 0,
      },
    ]);
    p.dispose();
  });

  test("clearAll emits when host", () => {
    const w = makeWindow();
    const sink = makeSink();
    const p = createPenProducer({
      sessionId: "S",
      send: sink.send,
      window: w.win as unknown as Window & typeof globalThis,
      isHost: () => true,
      now: () => 0,
    });
    p.clearAll();
    expect(sink.sends).toHaveLength(1);
    expect(sink.sends[0]?.payload).toEqual({ scope: "all" });
    p.dispose();
  });

  test("clearAll silently no-ops when not host (UI also hides the button)", () => {
    const w = makeWindow();
    const sink = makeSink();
    const p = createPenProducer({
      sessionId: "S",
      send: sink.send,
      window: w.win as unknown as Window & typeof globalThis,
      isHost: () => false,
      now: () => 0,
    });
    p.clearAll();
    expect(sink.sends).toHaveLength(0);
    p.dispose();
  });
});

describe("pen-producer — color is never sent", () => {
  test("no frame includes a 'color' field", () => {
    const w = makeWindow();
    const sink = makeSink();
    const p = createPenProducer({
      sessionId: "S",
      send: sink.send,
      window: w.win as unknown as Window & typeof globalThis,
      generateStrokeId: () => "S6",
      isHost: () => true,
      now: () => 0,
    });
    p.toggle();
    w.fire("pointerdown", { clientX: 0, clientY: 0, pressure: 0.5 });
    w.fire("pointerup", { clientX: 0, clientY: 0, pressure: 0 });
    p.clearMine();
    p.clearAll();
    for (const f of sink.sends) {
      expect("color" in f.payload).toBe(false);
    }
    p.dispose();
  });
});

describe("pen-producer — coords go through translator", () => {
  test("scale=0.5 doubles each point coordinate", () => {
    const w = makeWindow();
    const sink = makeSink();
    let t = 0;
    const p = createPenProducer({
      sessionId: "S",
      send: sink.send,
      window: w.win as unknown as Window & typeof globalThis,
      generateStrokeId: () => "S7",
      getOverlayTransform: () => ({ scale: 0.5, offsetX: 0, offsetY: 0 }),
      now: () => t,
    });
    p.toggle();

    t = 10;
    w.fire("pointerdown", { clientX: 100, clientY: 80, pressure: 0.5 });
    t = 20;
    w.fire("pointerup", { clientX: 100, clientY: 80, pressure: 0 });

    const point = sink.sends.find((f) => f.kind === "pen.stroke_point");
    expect(point).toBeTruthy();
    const pts = point?.payload["points"] as { x: number; y: number; p?: number }[];
    expect(pts[0]).toEqual({ x: 200, y: 160, p: 0.5 });
    p.dispose();
  });
});

describe("pen-producer — dispose", () => {
  test("dispose ends any in-flight stroke and unbinds listeners", () => {
    const w = makeWindow();
    const sink = makeSink();
    const p = createPenProducer({
      sessionId: "S",
      send: sink.send,
      window: w.win as unknown as Window & typeof globalThis,
      generateStrokeId: () => "S8",
      now: () => 0,
    });
    p.toggle();
    w.fire("pointerdown", { clientX: 0, clientY: 0, pressure: 0.5 });
    expect(w.listenerCount("pointermove")).toBe(1);

    p.dispose();
    expect(sink.sends.at(-1)?.kind).toBe("pen.stroke_end");
    expect(w.listenerCount("pointermove")).toBe(0);
    expect(w.listenerCount("keydown")).toBe(0);
  });
});
