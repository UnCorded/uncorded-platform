import { describe, expect, test } from "bun:test";
import type { WsCoViewCursor } from "@uncorded/protocol";

import {
  CURSOR_THROTTLE_MS,
  DRAG_THRESHOLD_PX,
  TYPING_RECENCY_MS,
  createCursorProducer,
} from "./cursor-producer";

// Minimal window/document fake — we record listeners by name and dispatch
// synthetic events via `fire(name, ev)`. The producer is duck-typed against
// `tagName` / `isContentEditable` / `matches` / `closest` so plain objects work.

interface FakeListener {
  type: string;
  fn: (ev: unknown) => void;
}

interface FakeSelection {
  isCollapsed: boolean;
  text: string;
}

function makeWindow() {
  const winListeners: FakeListener[] = [];
  const docListeners: FakeListener[] = [];
  let selection: FakeSelection = { isCollapsed: true, text: "" };

  const document = {
    addEventListener(type: string, fn: (ev: unknown) => void): void {
      docListeners.push({ type, fn });
    },
    removeEventListener(type: string, fn: (ev: unknown) => void): void {
      const i = docListeners.findIndex((l) => l.type === type && l.fn === fn);
      if (i >= 0) docListeners.splice(i, 1);
    },
    getSelection(): {
      isCollapsed: boolean;
      toString: () => string;
    } {
      return {
        isCollapsed: selection.isCollapsed,
        toString: () => selection.text,
      };
    },
  };

  const win = {
    document,
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
    const list = type === "selectionchange" ? docListeners : winListeners;
    for (const l of list.slice()) {
      if (l.type === type) l.fn(ev);
    }
  }

  function setSelection(text: string): void {
    selection = { isCollapsed: text.length === 0, text };
  }

  function listenerCount(type: string): number {
    return [...winListeners, ...docListeners].filter((l) => l.type === type)
      .length;
  }

  return { win, fire, setSelection, listenerCount };
}

function makeDiv(): Element {
  return {
    tagName: "DIV",
    matches: (_sel: string) => false,
    closest: (_sel: string) => null,
    contains: (_n: Node | null) => false,
  } as unknown as Element;
}

function makeButton(): Element {
  return {
    tagName: "BUTTON",
    matches: (sel: string) => sel.includes("button"),
    closest: (sel: string) => (sel.includes("button") ? makeButton() : null),
    contains: (_n: Node | null) => false,
  } as unknown as Element;
}

function makeInput(): Element {
  const el: { tagName: string; matches: (sel: string) => boolean; closest: (sel: string) => Element | null; contains: (n: Node | null) => boolean } = {
    tagName: "INPUT",
    matches: (sel: string) => sel.includes("input"),
    closest: (_sel: string) => null,
    contains: (n: Node | null) => (n as unknown) === el,
  };
  return el as unknown as Element;
}

function makeFrameSink() {
  const sends: WsCoViewCursor[] = [];
  return { sends, send: (f: WsCoViewCursor) => sends.push(f) };
}

describe("cursor-producer — basic emit + idle classification", () => {
  test("first pointermove emits a frame at seq=0 with state=idle", () => {
    const w = makeWindow();
    const sink = makeFrameSink();
    let t = 1000;
    const p = createCursorProducer({
      sessionId: "S",
      send: sink.send,
      window: w.win as unknown as Window & typeof globalThis,
      now: () => t,
    });

    w.fire("pointermove", { clientX: 100, clientY: 200, target: makeDiv() });

    expect(sink.sends).toHaveLength(1);
    expect(sink.sends[0]).toMatchObject({
      type: "co-view.cursor",
      session_id: "S",
      x: 100,
      y: 200,
      state: "idle",
      ts: 1000,
    });
    p.dispose();
  });

  test("identical (x, y, state) is coalesced — second move not re-emitted", () => {
    const w = makeWindow();
    const sink = makeFrameSink();
    let t = 1000;
    const p = createCursorProducer({
      sessionId: "S",
      send: sink.send,
      window: w.win as unknown as Window & typeof globalThis,
      now: () => t,
    });

    w.fire("pointermove", { clientX: 50, clientY: 50, target: makeDiv() });
    expect(sink.sends).toHaveLength(1);

    // Advance enough to clear throttle, but coords/state unchanged → no frame.
    t += 100;
    p._flush();
    expect(sink.sends).toHaveLength(1);
    p.dispose();
  });
});

describe("cursor-producer — throttle (33 ms leading-edge)", () => {
  test("rapid moves within 33 ms collapse to leading frame + trailing fire", async () => {
    const w = makeWindow();
    const sink = makeFrameSink();
    let t = 1000;
    const p = createCursorProducer({
      sessionId: "S",
      send: sink.send,
      window: w.win as unknown as Window & typeof globalThis,
      now: () => t,
    });

    // Leading-edge fire.
    w.fire("pointermove", { clientX: 10, clientY: 10, target: makeDiv() });
    expect(sink.sends).toHaveLength(1);
    expect(sink.sends[0]?.x).toBe(10);

    // Within 33 ms: schedule trailing flush, do NOT emit immediately.
    t += 5;
    w.fire("pointermove", { clientX: 20, clientY: 20, target: makeDiv() });
    expect(sink.sends).toHaveLength(1);

    t += 5;
    w.fire("pointermove", { clientX: 30, clientY: 30, target: makeDiv() });
    expect(sink.sends).toHaveLength(1);

    // Wait for trailing timer to fire — real setTimeout, real time.
    await new Promise((r) => setTimeout(r, CURSOR_THROTTLE_MS + 10));
    // Trailing flush uses the latest coords (30, 30).
    expect(sink.sends.length).toBeGreaterThanOrEqual(2);
    expect(sink.sends.at(-1)?.x).toBe(30);
    p.dispose();
  });
});

describe("cursor-producer — state classification", () => {
  test("hover when over an interactive element", () => {
    const w = makeWindow();
    const sink = makeFrameSink();
    const p = createCursorProducer({
      sessionId: "S",
      send: sink.send,
      window: w.win as unknown as Window & typeof globalThis,
      now: () => 1000,
    });

    w.fire("pointermove", { clientX: 1, clientY: 1, target: makeButton() });
    expect(sink.sends.at(-1)?.state).toBe("hover");
    p.dispose();
  });

  test("pressed → dragging → idle", () => {
    const w = makeWindow();
    const sink = makeFrameSink();
    let t = 1000;
    const p = createCursorProducer({
      sessionId: "S",
      send: sink.send,
      window: w.win as unknown as Window & typeof globalThis,
      now: () => t,
    });

    w.fire("pointermove", { clientX: 100, clientY: 100, target: makeDiv() });
    expect(sink.sends.at(-1)?.state).toBe("idle");

    t += 100;
    w.fire("pointerdown", { clientX: 100, clientY: 100, target: makeDiv() });
    expect(sink.sends.at(-1)?.state).toBe("pressed");

    // Move beyond DRAG_THRESHOLD_PX → dragging.
    t += 100;
    w.fire("pointermove", {
      clientX: 100 + DRAG_THRESHOLD_PX + 1,
      clientY: 100,
      target: makeDiv(),
    });
    expect(sink.sends.at(-1)?.state).toBe("dragging");

    t += 100;
    w.fire("pointerup", {
      clientX: 100 + DRAG_THRESHOLD_PX + 1,
      clientY: 100,
      target: makeDiv(),
    });
    expect(sink.sends.at(-1)?.state).toBe("idle");
    p.dispose();
  });

  test("typing activates on focus + recent keystroke; expires after TYPING_RECENCY_MS", () => {
    const w = makeWindow();
    const sink = makeFrameSink();
    let t = 0;
    const p = createCursorProducer({
      sessionId: "S",
      send: sink.send,
      window: w.win as unknown as Window & typeof globalThis,
      now: () => t,
    });

    const input = makeInput();
    // Get the cursor onto the page so havePoint=true for any future flush.
    t = 100;
    w.fire("pointermove", { clientX: 5, clientY: 5, target: makeDiv() });
    expect(sink.sends.at(-1)?.state).toBe("idle");

    t = 200;
    w.fire("focusin", { target: input });
    // Focus alone is not typing — last frame still idle (no new send because
    // coords/state unchanged).
    expect(sink.sends.at(-1)?.state).toBe("idle");

    t = 300;
    w.fire("keydown", { target: input });
    // Force flush: throttle window may still be open; advance time and call
    // _flush to confirm classification.
    t = 400;
    p._flush();
    expect(sink.sends.at(-1)?.state).toBe("typing");

    // After TYPING_RECENCY_MS elapses, classification falls back.
    t = 300 + TYPING_RECENCY_MS + 100;
    p._flush();
    expect(sink.sends.at(-1)?.state).toBe("idle");
    p.dispose();
  });

  test("selecting beats typing/hover", () => {
    const w = makeWindow();
    const sink = makeFrameSink();
    let t = 0;
    const p = createCursorProducer({
      sessionId: "S",
      send: sink.send,
      window: w.win as unknown as Window & typeof globalThis,
      now: () => t,
    });

    t = 100;
    w.fire("pointermove", { clientX: 5, clientY: 5, target: makeDiv() });
    w.setSelection("hello");
    t = 200;
    p._flush();
    expect(sink.sends.at(-1)?.state).toBe("selecting");
    p.dispose();
  });

  test("menu-open beats selecting/typing/hover", () => {
    const w = makeWindow();
    const sink = makeFrameSink();
    let menuOpen = false;
    let t = 0;
    const p = createCursorProducer({
      sessionId: "S",
      send: sink.send,
      window: w.win as unknown as Window & typeof globalThis,
      isMenuOpen: () => menuOpen,
      now: () => t,
    });

    t = 100;
    w.fire("pointermove", { clientX: 5, clientY: 5, target: makeButton() });
    expect(sink.sends.at(-1)?.state).toBe("hover");

    menuOpen = true;
    t = 200;
    p._flush();
    expect(sink.sends.at(-1)?.state).toBe("menu-open");

    menuOpen = false;
    t = 300;
    p._flush();
    expect(sink.sends.at(-1)?.state).toBe("hover");
    p.dispose();
  });

  test("pressed/dragging beats menu-open", () => {
    const w = makeWindow();
    const sink = makeFrameSink();
    let t = 0;
    const p = createCursorProducer({
      sessionId: "S",
      send: sink.send,
      window: w.win as unknown as Window & typeof globalThis,
      isMenuOpen: () => true,
      now: () => t,
    });

    t = 100;
    w.fire("pointerdown", { clientX: 50, clientY: 50, target: makeDiv() });
    expect(sink.sends.at(-1)?.state).toBe("pressed");
    p.dispose();
  });
});

describe("cursor-producer — coordinate translation", () => {
  test("identity transform passes clientX/Y through unchanged (host path)", () => {
    const w = makeWindow();
    const sink = makeFrameSink();
    const p = createCursorProducer({
      sessionId: "S",
      send: sink.send,
      window: w.win as unknown as Window & typeof globalThis,
      now: () => 0,
    });

    w.fire("pointermove", { clientX: 333, clientY: 444, target: makeDiv() });
    expect(sink.sends.at(-1)?.x).toBe(333);
    expect(sink.sends.at(-1)?.y).toBe(444);
    p.dispose();
  });

  test("scale=0.5 doubles the published coordinate (viewer path)", () => {
    const w = makeWindow();
    const sink = makeFrameSink();
    const p = createCursorProducer({
      sessionId: "S",
      send: sink.send,
      window: w.win as unknown as Window & typeof globalThis,
      getOverlayEl: () => null,
      getOverlayTransform: () => ({ scale: 0.5, offsetX: 0, offsetY: 0 }),
      now: () => 0,
    });

    w.fire("pointermove", { clientX: 100, clientY: 80, target: makeDiv() });
    expect(sink.sends.at(-1)?.x).toBe(200);
    expect(sink.sends.at(-1)?.y).toBe(160);
    p.dispose();
  });
});

describe("cursor-producer — never sends member_id", () => {
  test("frame omits member_id (server stamps on outbound)", () => {
    const w = makeWindow();
    const sink = makeFrameSink();
    const p = createCursorProducer({
      sessionId: "S",
      send: sink.send,
      window: w.win as unknown as Window & typeof globalThis,
      now: () => 1,
    });

    w.fire("pointermove", { clientX: 1, clientY: 1, target: makeDiv() });
    expect(sink.sends[0]?.member_id).toBeUndefined();
    p.dispose();
  });
});

describe("cursor-producer — dispose unbinds every listener", () => {
  test("dispose removes all window + document listeners", () => {
    const w = makeWindow();
    const p = createCursorProducer({
      sessionId: "S",
      send: () => {},
      window: w.win as unknown as Window & typeof globalThis,
      now: () => 0,
    });

    expect(w.listenerCount("pointermove")).toBe(1);
    expect(w.listenerCount("pointerdown")).toBe(1);
    expect(w.listenerCount("selectionchange")).toBe(1);

    p.dispose();
    expect(w.listenerCount("pointermove")).toBe(0);
    expect(w.listenerCount("pointerdown")).toBe(0);
    expect(w.listenerCount("selectionchange")).toBe(0);
  });
});
