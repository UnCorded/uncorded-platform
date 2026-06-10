// Unit tests for usePanelSurface. The helper composes portal-host with a
// per-component handle registry; we verify create-once / adopt-on-remount /
// destroy-on-real-teardown semantics across panel splits, cross-workspace
// drag (rekey), and mid-flight `<Show>` placeholder swaps.

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { createRoot } from "solid-js";
import type { PanelContent } from "@uncorded/protocol";
import * as portalHost from "./portal-host";
import { _resetForTests as resetPanelSurface, usePanelSurface } from "./use-panel-surface";

class FakeResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

class FakeElement {
  public style: Record<string, string> = {};
  public parentElement: FakeElement | null = null;
  public children: FakeElement[] = [];
  appendChild(child: FakeElement): FakeElement {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
  removeChild(child: FakeElement): FakeElement {
    const i = this.children.indexOf(child);
    if (i >= 0) this.children.splice(i, 1);
    child.parentElement = null;
    return child;
  }
  getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
    return { left: 0, top: 0, width: 100, height: 100 };
  }
}

const originalRO = globalThis.ResizeObserver;
const originalWindow = globalThis.window;
const originalRAF = globalThis.requestAnimationFrame;

beforeEach(() => {
  (globalThis as unknown as { ResizeObserver: typeof FakeResizeObserver }).ResizeObserver = FakeResizeObserver;
  (globalThis as unknown as { window: { addEventListener: () => void; innerWidth: number; innerHeight: number } }).window = {
    addEventListener: () => {},
    innerWidth: 1024,
    innerHeight: 768,
  };
  (globalThis as unknown as { requestAnimationFrame: () => number }).requestAnimationFrame = () => 0;
  portalHost._resetForTests();
  resetPanelSurface();
  const root = new FakeElement();
  portalHost.registerPortalRoot(root as unknown as HTMLElement);
});

afterEach(() => {
  portalHost._resetForTests();
  resetPanelSurface();
  if (originalRO !== undefined) {
    (globalThis as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver = originalRO;
  }
  if (originalWindow !== undefined) {
    (globalThis as { window: typeof window }).window = originalWindow;
  } else {
    delete (globalThis as { window?: unknown }).window;
  }
  if (originalRAF !== undefined) {
    globalThis.requestAnimationFrame = originalRAF;
  }
});

interface FakeHandle {
  id: number;
  destroyed: boolean;
  attached: boolean;
  adoptCount: number;
}

let nextId = 1;

function buildContent(slug: string): PanelContent {
  return {
    type: "plugin",
    serverId: "srv",
    slug,
    itemId: "item",
    itemLabel: "Test",
  };
}

interface MountResult {
  handle: () => FakeHandle | null;
  attachPlaceholder: (el: FakeElement) => void;
  dispose: () => void;
}

function mountInRoot(opts: {
  workspaceId: string;
  panelId: string;
  content: () => PanelContent;
  handles: FakeHandle[];
  initialPlaceholder?: FakeElement;
}): MountResult {
  let placeholderRef!: (el: HTMLDivElement) => void;
  let handleAccessor!: () => FakeHandle | null;
  const dispose = createRoot((d) => {
    const surface = usePanelSurface<FakeHandle>({
      workspaceId: () => opts.workspaceId,
      panelId: opts.panelId,
      content: opts.content,
      create: () => {
        const h: FakeHandle = {
          id: nextId++,
          destroyed: false,
          attached: false,
          adoptCount: 0,
        };
        opts.handles.push(h);
        const el = new FakeElement();
        return { element: el as unknown as HTMLElement, handle: h };
      },
      destroy: (h) => {
        h.destroyed = true;
      },
      onAttached: (h) => {
        h.attached = true;
      },
      onAdopt: (h) => {
        h.adoptCount++;
      },
    });
    placeholderRef = surface.placeholderRef;
    handleAccessor = surface.handle;
    return d;
  });

  if (opts.initialPlaceholder !== undefined) {
    placeholderRef(opts.initialPlaceholder as unknown as HTMLDivElement);
  }

  return {
    handle: handleAccessor,
    attachPlaceholder: (el) => placeholderRef(el as unknown as HTMLDivElement),
    dispose,
  };
}

describe("usePanelSurface", () => {
  test("first mount calls create and onAttached, registers with portal-host", () => {
    const handles: FakeHandle[] = [];
    const ph = new FakeElement();
    const m = mountInRoot({
      workspaceId: "ws",
      panelId: "p1",
      content: () => buildContent("term-a"),
      handles,
      initialPlaceholder: ph,
    });

    expect(handles).toHaveLength(1);
    expect(handles[0]!.attached).toBe(true);
    expect(handles[0]!.adoptCount).toBe(0);
    expect(portalHost.hasMount("ws:p1:plugin:srv:term-a")).toBe(true);
    expect(m.handle()).toBe(handles[0]!);

    m.dispose();
  });

  test("component unmount hides the surface but does NOT destroy it", () => {
    const handles: FakeHandle[] = [];
    const ph = new FakeElement();
    const m = mountInRoot({
      workspaceId: "ws",
      panelId: "p1",
      content: () => buildContent("term-a"),
      handles,
      initialPlaceholder: ph,
    });
    expect(handles[0]!.destroyed).toBe(false);

    m.dispose();

    // unmount-only — the handle is still alive in the registry, ready to
    // be re-adopted by a fresh component instance.
    expect(handles[0]!.destroyed).toBe(false);
    expect(portalHost.hasMount("ws:p1:plugin:srv:term-a")).toBe(true);
  });

  test("re-mount with same key adopts the existing surface (no second create)", () => {
    const handles: FakeHandle[] = [];
    const ph1 = new FakeElement();
    const m1 = mountInRoot({
      workspaceId: "ws",
      panelId: "p1",
      content: () => buildContent("term-a"),
      handles,
      initialPlaceholder: ph1,
    });
    m1.dispose();
    expect(handles).toHaveLength(1);
    const original = handles[0]!;

    // Fresh component instance for the same panel + content — simulates a
    // panel split unmounting then a new component mounting on the same leaf.
    const ph2 = new FakeElement();
    const m2 = mountInRoot({
      workspaceId: "ws",
      panelId: "p1",
      content: () => buildContent("term-a"),
      handles,
      initialPlaceholder: ph2,
    });

    expect(handles).toHaveLength(1); // No new handle.
    expect(original.adoptCount).toBe(1);
    expect(original.destroyed).toBe(false);
    expect(m2.handle()).toBe(original);

    m2.dispose();
  });

  test("destroyByKey runs the caller's destroy() exactly once", () => {
    const handles: FakeHandle[] = [];
    const ph = new FakeElement();
    const m = mountInRoot({
      workspaceId: "ws",
      panelId: "p1",
      content: () => buildContent("term-a"),
      handles,
      initialPlaceholder: ph,
    });

    portalHost.destroyByKey("ws:p1:plugin:srv:term-a");
    expect(handles[0]!.destroyed).toBe(true);

    m.dispose();
    // Disposing the component after destroy is a no-op for the destroy hook.
    expect(handles[0]!.destroyed).toBe(true);
  });

  test("destroyByWorkspace tears down every panel for that workspace", () => {
    const handles: FakeHandle[] = [];
    const phA = new FakeElement();
    const phB = new FakeElement();
    const mA = mountInRoot({
      workspaceId: "wsA",
      panelId: "p1",
      content: () => buildContent("term-a"),
      handles,
      initialPlaceholder: phA,
    });
    const mB = mountInRoot({
      workspaceId: "wsA",
      panelId: "p2",
      content: () => buildContent("term-b"),
      handles,
      initialPlaceholder: phB,
    });

    portalHost.destroyByWorkspace("wsA");
    expect(handles[0]!.destroyed).toBe(true);
    expect(handles[1]!.destroyed).toBe(true);

    mA.dispose();
    mB.dispose();
  });

  test("placeholder swap with same key rebinds the portal mount", () => {
    const handles: FakeHandle[] = [];
    const ph1 = new FakeElement();
    const m = mountInRoot({
      workspaceId: "ws",
      panelId: "p1",
      content: () => buildContent("term-a"),
      handles,
      initialPlaceholder: ph1,
    });

    // Swap to a new placeholder — same key, same handle.
    const ph2 = new FakeElement();
    m.attachPlaceholder(ph2);

    expect(handles).toHaveLength(1);
    expect(handles[0]!.adoptCount).toBe(0);
    expect(handles[0]!.destroyed).toBe(false);

    m.dispose();
  });
});
