import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import * as ds from "./drag-state";

// drag-state is a module-level singleton. Reset between tests and stub only
// the DOM APIs we actually exercise (elementsFromPoint, setPointerCapture,
// addEventListener on document/window).

type Listener = (ev: unknown) => void;

interface FakeDoc {
  listeners: Map<string, Set<Listener>>;
  addEventListener: (type: string, fn: Listener) => void;
  removeEventListener: (type: string, fn: Listener) => void;
  elementsFromPoint: ((x: number, y: number) => Element[]) | undefined;
  elementFromPoint: ((x: number, y: number) => Element | null) | undefined;
}

let fakeDoc: FakeDoc;
let fakeWin: { addEventListener: (t: string, f: Listener) => void; removeEventListener: (t: string, f: Listener) => void; listeners: Map<string, Set<Listener>> };
const origDoc = globalThis.document;
const origWin = globalThis.window;
const origElement = (globalThis as { Element?: unknown }).Element;

// Bun's test runtime has no DOM — stub an Element base class so our
// POJO fakes can satisfy `target instanceof Element` inside drag-state.
class FakeElement {
  closest(_sel: string): Element | null { return null; }
}

function dispatch(target: FakeDoc | typeof fakeWin, type: string, ev: unknown): void {
  const set = target.listeners.get(type);
  if (!set) return;
  for (const fn of set) fn(ev);
}

function makeFakeDoc(): FakeDoc {
  const listeners = new Map<string, Set<Listener>>();
  return {
    listeners,
    addEventListener(type: string, fn: Listener) {
      let s = listeners.get(type);
      if (!s) { s = new Set(); listeners.set(type, s); }
      s.add(fn);
    },
    removeEventListener(type: string, fn: Listener) {
      listeners.get(type)?.delete(fn);
    },
    elementsFromPoint: () => [],
    elementFromPoint: () => null,
  };
}

beforeEach(() => {
  fakeDoc = makeFakeDoc();
  fakeWin = {
    listeners: new Map(),
    addEventListener(type: string, fn: Listener) {
      let s = fakeWin.listeners.get(type);
      if (!s) { s = new Set(); fakeWin.listeners.set(type, s); }
      s.add(fn);
    },
    removeEventListener(type: string, fn: Listener) {
      fakeWin.listeners.get(type)?.delete(fn);
    },
  };
  (globalThis as unknown as { document: FakeDoc }).document = fakeDoc;
  (globalThis as unknown as { window: typeof fakeWin }).window = fakeWin;
  (globalThis as unknown as { Element: typeof FakeElement }).Element = FakeElement;
  ds._resetForTests();
});

afterEach(() => {
  ds._resetForTests();
  if (origDoc !== undefined) {
    (globalThis as { document: typeof document }).document = origDoc;
  } else {
    delete (globalThis as { document?: unknown }).document;
  }
  if (origWin !== undefined) {
    (globalThis as { window: typeof window }).window = origWin;
  } else {
    delete (globalThis as { window?: unknown }).window;
  }
  if (origElement !== undefined) {
    (globalThis as { Element: typeof Element }).Element = origElement as typeof Element;
  } else {
    delete (globalThis as { Element?: unknown }).Element;
  }
});

function startPanelDrag(onCommit = (_t: ds.DropTarget) => {}, onCancel = () => {}) {
  const pd = { pointerId: 1, clientX: 100, clientY: 100 } as PointerEvent;
  ds.startPointerDrag({
    payload: { kind: "panel", sourceLeafId: "src", sourceWorkspaceId: "ws1" },
    pointerEvent: pd,
    onCommit,
    onCancel,
  });
}

describe("drag-state session lifecycle", () => {
  test("pointerup below threshold is a click: no commit, no cancel, session ends", () => {
    let commits = 0;
    let cancels = 0;
    startPanelDrag(() => commits++, () => cancels++);
    expect(ds.hasPendingPointerDrag()).toBe(true);
    // A 3px nudge stays under the 4px threshold → still a "click".
    dispatch(fakeDoc, "pointermove", { pointerId: 1, clientX: 102, clientY: 102 });
    // dragContext should still be null (threshold not crossed).
    expect(ds.dragContext()).toBe(null);
    dispatch(fakeDoc, "pointerup", { pointerId: 1, clientX: 102, clientY: 102 });
    expect(ds.hasPendingPointerDrag()).toBe(false);
    expect(commits).toBe(0);
    expect(cancels).toBe(0);
  });

  test("pointermove past threshold publishes dragContext", () => {
    startPanelDrag();
    dispatch(fakeDoc, "pointermove", { pointerId: 1, clientX: 110, clientY: 110 });
    const ctx = ds.dragContext();
    expect(ctx).not.toBe(null);
    expect(ctx?.kind).toBe("panel");
    expect((ctx as { kind: "panel"; sourceLeafId: string }).sourceLeafId).toBe("src");
  });

  test("escape key cancels an active drag", () => {
    let commits = 0;
    let cancels = 0;
    startPanelDrag(() => commits++, () => cancels++);
    dispatch(fakeDoc, "pointermove", { pointerId: 1, clientX: 110, clientY: 110 });
    dispatch(fakeDoc, "keydown", { key: "Escape" });
    expect(cancels).toBe(1);
    expect(commits).toBe(0);
    expect(ds.dragContext()).toBe(null);
    expect(ds.hasPendingPointerDrag()).toBe(false);
  });

  test("window blur cancels an active drag", () => {
    let cancels = 0;
    startPanelDrag(() => {}, () => cancels++);
    dispatch(fakeDoc, "pointermove", { pointerId: 1, clientX: 110, clientY: 110 });
    dispatch(fakeWin, "blur", {});
    expect(cancels).toBe(1);
    expect(ds.dragContext()).toBe(null);
  });

  test("pointercancel after threshold fires onCancel", () => {
    let cancels = 0;
    startPanelDrag(() => {}, () => cancels++);
    dispatch(fakeDoc, "pointermove", { pointerId: 1, clientX: 110, clientY: 110 });
    dispatch(fakeDoc, "pointercancel", { pointerId: 1 });
    expect(cancels).toBe(1);
  });

  test("pointerup with no drop target fires onCancel", () => {
    let commits = 0;
    let cancels = 0;
    startPanelDrag((_t) => commits++, () => cancels++);
    dispatch(fakeDoc, "pointermove", { pointerId: 1, clientX: 110, clientY: 110 });
    // elementsFromPoint returns [] so dropTarget stays null.
    dispatch(fakeDoc, "pointerup", { pointerId: 1, clientX: 110, clientY: 110 });
    expect(commits).toBe(0);
    expect(cancels).toBe(1);
  });

  test("pointerup with a leaf target fires onCommit with that target", () => {
    let lastTarget: ds.DropTarget | null = null;
    startPanelDrag((t) => { lastTarget = t; });

    // Fabricate a leaf element and wire elementsFromPoint to return it.
    const leaf = new FakeElement() as FakeElement & Record<string, unknown>;
    leaf.closest = (sel: string) => (sel === "[data-panel-leaf]" ? (leaf as unknown as Element) : null);
    leaf.getAttribute = (k: string) => (k === "data-panel-leaf" ? "target-leaf" : null);
    leaf.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 400 } as DOMRect);
    fakeDoc.elementsFromPoint = () => [leaf as unknown as Element];

    dispatch(fakeDoc, "pointermove", { pointerId: 1, clientX: 110, clientY: 110 });
    dispatch(fakeDoc, "pointerup", { pointerId: 1, clientX: 200, clientY: 200 });

    expect(lastTarget).not.toBe(null);
    expect((lastTarget as unknown as ds.DropTarget).leafId).toBe("target-leaf");
    expect((lastTarget as unknown as ds.DropTarget).zone).toBe("center");
  });

  test("hitTestAt classifies edge zones from position within rect", () => {
    const leaf = new FakeElement() as FakeElement & Record<string, unknown>;
    leaf.closest = (sel: string) => (sel === "[data-panel-leaf]" ? (leaf as unknown as Element) : null);
    leaf.getAttribute = (k: string) => (k === "data-panel-leaf" ? "L" : null);
    leaf.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100 } as DOMRect);
    fakeDoc.elementsFromPoint = () => [leaf as unknown as Element];

    expect(ds.hitTestAt(10, 50)?.zone).toBe("left");
    expect(ds.hitTestAt(90, 50)?.zone).toBe("right");
    expect(ds.hitTestAt(50, 10)?.zone).toBe("top");
    expect(ds.hitTestAt(50, 90)?.zone).toBe("bottom");
    expect(ds.hitTestAt(50, 50)?.zone).toBe("center");
  });
});

describe("drag-start exemption", () => {
  test("shouldIgnoreDragStart matches common interactive elements", () => {
    const btn = new FakeElement() as FakeElement & Record<string, unknown>;
    btn.closest = (s: string) => (s.includes("button") ? (btn as unknown as Element) : null);
    expect(ds.shouldIgnoreDragStart(btn as unknown as EventTarget)).toBe(true);
    const none = new FakeElement() as FakeElement & Record<string, unknown>;
    none.closest = () => null;
    expect(ds.shouldIgnoreDragStart(none as unknown as EventTarget)).toBe(false);
    expect(ds.shouldIgnoreDragStart(null)).toBe(false);
  });
});
