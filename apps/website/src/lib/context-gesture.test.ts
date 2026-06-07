import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { createRoot } from "solid-js";
import { createContextGesture, type ContextGestureAnchor } from "./context-gesture";

// Bun's test runtime has no DOM. Stub Element so `target instanceof Element`
// inside drag-state's shouldIgnoreDragStart succeeds, and provide a minimal
// fake "current target" with getBoundingClientRect.

class FakeElement {
  closest(_sel: string): Element | null { return null; }
  getBoundingClientRect(): DOMRect {
    return {
      x: 0, y: 0, top: 0, left: 0, right: 100, bottom: 30,
      width: 100, height: 30, toJSON: () => ({}),
    } as DOMRect;
  }
}

const origElement = (globalThis as { Element?: unknown }).Element;

beforeEach(() => {
  (globalThis as unknown as { Element: typeof FakeElement }).Element = FakeElement;
});

afterEach(() => {
  if (origElement !== undefined) {
    (globalThis as { Element: typeof Element }).Element = origElement as typeof Element;
  } else {
    delete (globalThis as { Element?: unknown }).Element;
  }
});

interface FakePointerEvent {
  pointerId: number;
  pointerType: "mouse" | "touch" | "pen";
  button: number;
  clientX: number;
  clientY: number;
  target: FakeElement;
  currentTarget: FakeElement;
}

function pe(over: Partial<FakePointerEvent>): PointerEvent {
  const target = new FakeElement();
  return {
    pointerId: 1,
    pointerType: "touch",
    button: 0,
    clientX: 100,
    clientY: 50,
    target,
    currentTarget: target,
    ...over,
  } as unknown as PointerEvent;
}

interface FakeMouseEvent {
  clientX: number;
  clientY: number;
  target: FakeElement;
  currentTarget: FakeElement;
  preventDefault: () => void;
  stopPropagation: () => void;
}

function me(over: Partial<FakeMouseEvent> & { prevented?: { value: boolean } } = {}): MouseEvent {
  const target = over.currentTarget ?? new FakeElement();
  const prevented = over.prevented ?? { value: false };
  return {
    clientX: over.clientX ?? 100,
    clientY: over.clientY ?? 50,
    target,
    currentTarget: target,
    preventDefault: () => { prevented.value = true; },
    stopPropagation: () => {},
  } as unknown as MouseEvent;
}

function harness(longPressMs = 50, enabled?: () => boolean) {
  const opens: ContextGestureAnchor[] = [];
  let dispose = () => {};
  const handlers = createRoot((d) => {
    dispose = d;
    return createContextGesture({
      onOpen: (a) => opens.push(a),
      longPressMs,
      ...(enabled ? { enabled } : {}),
    });
  });
  return { handlers, opens, dispose };
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("createContextGesture — long-press", () => {
  test("touch pointerdown held past timer fires onOpen", async () => {
    const { handlers, opens, dispose } = harness(20);
    handlers.onPointerDown(pe({ pointerType: "touch", clientX: 200, clientY: 80 }));
    await wait(40);
    expect(opens.length).toBe(1);
    expect(opens[0]?.x).toBe(200);
    expect(opens[0]?.y).toBe(80);
    expect(opens[0]?.source).toBe("touch");
    expect(opens[0]?.rect).not.toBe(null);
    dispose();
  });

  test("pointer movement >6px before timer cancels long-press", async () => {
    const { handlers, opens, dispose } = harness(30);
    handlers.onPointerDown(pe({ pointerType: "touch", clientX: 100, clientY: 50 }));
    handlers.onPointerMove(pe({ pointerType: "touch", clientX: 110, clientY: 50 }));
    await wait(50);
    expect(opens.length).toBe(0);
    dispose();
  });

  test("tiny jitter (<6px) does NOT cancel long-press", async () => {
    const { handlers, opens, dispose } = harness(30);
    handlers.onPointerDown(pe({ pointerType: "touch", clientX: 100, clientY: 50 }));
    handlers.onPointerMove(pe({ pointerType: "touch", clientX: 103, clientY: 52 }));
    await wait(50);
    expect(opens.length).toBe(1);
    // Anchor uses the LAST pointer position so the menu opens under the
    // finger after micro-motion, not at the original press point.
    expect(opens[0]?.x).toBe(103);
    expect(opens[0]?.y).toBe(52);
    dispose();
  });

  test("pointerup before timer cancels (normal click path)", async () => {
    const { handlers, opens, dispose } = harness(30);
    handlers.onPointerDown(pe({ pointerType: "touch" }));
    handlers.onPointerUp(pe({ pointerType: "touch" }));
    await wait(50);
    expect(opens.length).toBe(0);
    dispose();
  });

  test("pointercancel cleans up", async () => {
    const { handlers, opens, dispose } = harness(30);
    handlers.onPointerDown(pe({ pointerType: "touch" }));
    handlers.onPointerCancel(pe({ pointerType: "touch" }));
    await wait(50);
    expect(opens.length).toBe(0);
    dispose();
  });

  test("mouse pointerdown does NOT arm long-press", async () => {
    const { handlers, opens, dispose } = harness(20);
    handlers.onPointerDown(pe({ pointerType: "mouse" }));
    await wait(40);
    expect(opens.length).toBe(0);
    dispose();
  });

  test("right-click (button !== 0) does NOT arm long-press", async () => {
    const { handlers, opens, dispose } = harness(20);
    handlers.onPointerDown(pe({ pointerType: "touch", button: 2 }));
    await wait(40);
    expect(opens.length).toBe(0);
    dispose();
  });

  test("pen long-press fires with source=pen", async () => {
    const { handlers, opens, dispose } = harness(20);
    handlers.onPointerDown(pe({ pointerType: "pen" }));
    await wait(40);
    expect(opens.length).toBe(1);
    expect(opens[0]?.source).toBe("pen");
    dispose();
  });
});

describe("createContextGesture — right-click (contextmenu)", () => {
  test("preventDefault always called, even when disabled", () => {
    const enabledRef = { value: false };
    const { handlers, opens, dispose } = harness(20, () => enabledRef.value);
    const prevented = { value: false };
    handlers.onContextMenu(me({ prevented }));
    expect(prevented.value).toBe(true);
    expect(opens.length).toBe(0);
    dispose();
  });

  test("opens with mouse source when not in a touch press", () => {
    const { handlers, opens, dispose } = harness();
    handlers.onContextMenu(me({ clientX: 250, clientY: 90 }));
    expect(opens.length).toBe(1);
    expect(opens[0]?.x).toBe(250);
    expect(opens[0]?.y).toBe(90);
    expect(opens[0]?.source).toBe("mouse");
    dispose();
  });

  test("synthetic contextmenu mid-touch-press is suppressed", async () => {
    const { handlers, opens, dispose } = harness(100);
    handlers.onPointerDown(pe({ pointerType: "touch" }));
    // Synthetic contextmenu fires from the OS during the press — should be
    // ignored so the timer is the single source of truth.
    handlers.onContextMenu(me());
    expect(opens.length).toBe(0);
    // Timer should still fire after the delay.
    await wait(140);
    expect(opens.length).toBe(1);
    expect(opens[0]?.source).toBe("touch");
    dispose();
  });

  test("synthetic contextmenu after long-press already fired is swallowed", async () => {
    const { handlers, opens, dispose } = harness(20);
    handlers.onPointerDown(pe({ pointerType: "touch" }));
    await wait(40);
    expect(opens.length).toBe(1);
    // OS-synthesized contextmenu arriving after our timer already opened
    // the menu must not fire onOpen a second time.
    handlers.onContextMenu(me());
    expect(opens.length).toBe(1);
    dispose();
  });
});

describe("createContextGesture — wrapClick", () => {
  test("forwards click when no recent long-press", () => {
    const { handlers, dispose } = harness();
    let clicks = 0;
    const wrapped = handlers.wrapClick(() => clicks++);
    wrapped(me());
    expect(clicks).toBe(1);
    dispose();
  });

  test("swallows click in suppression window after long-press fires", async () => {
    const { handlers, dispose } = harness(20);
    handlers.onPointerDown(pe({ pointerType: "touch" }));
    await wait(40);
    let clicks = 0;
    const wrapped = handlers.wrapClick(() => clicks++);
    wrapped(me());
    expect(clicks).toBe(0);
    dispose();
  });

  test("forwards click again once suppression window elapses", async () => {
    // Tighten suppression by firing long-press, then waiting past the
    // 600ms window. We can't easily inject SUPPRESS_CLICK_MS, so use a
    // real wait — keeps the test honest about the actual behavior.
    const { handlers, dispose } = harness(20);
    handlers.onPointerDown(pe({ pointerType: "touch" }));
    await wait(40);
    await wait(610);
    let clicks = 0;
    const wrapped = handlers.wrapClick(() => clicks++);
    wrapped(me());
    expect(clicks).toBe(1);
    dispose();
  }, 2000);
});

describe("createContextGesture — enabled gate", () => {
  test("disabled skips long-press timer", async () => {
    const { handlers, opens, dispose } = harness(20, () => false);
    handlers.onPointerDown(pe({ pointerType: "touch" }));
    await wait(40);
    expect(opens.length).toBe(0);
    dispose();
  });

  test("disabled still preventDefaults contextmenu without opening", () => {
    const { handlers, opens, dispose } = harness(20, () => false);
    const prevented = { value: false };
    handlers.onContextMenu(me({ prevented }));
    expect(prevented.value).toBe(true);
    expect(opens.length).toBe(0);
    dispose();
  });
});
