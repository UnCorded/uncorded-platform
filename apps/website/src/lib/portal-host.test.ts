import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import * as portalHost from "./portal-host";

// portal-host is a singleton — give it a fresh root between every test.

// portal-host creates ONE shared observer lazily; capture its callback so
// tests can simulate an RO delivery and prove the sync is synchronous.
let roCallback: (() => void) | null = null;

class FakeResizeObserver {
  constructor(cb: () => void) {
    roCallback = cb;
  }
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
  // Stub window so the module's resize/scroll listeners no-op.
  (globalThis as unknown as { window: { addEventListener: () => void; innerWidth: number; innerHeight: number } }).window = {
    addEventListener: () => {},
    innerWidth: 1024,
    innerHeight: 768,
  };
  // rAF stub: never actually fire so poll loop doesn't leak state between tests.
  (globalThis as unknown as { requestAnimationFrame: () => number }).requestAnimationFrame = () => 0;
  roCallback = null;
  portalHost._resetForTests();
  const root = new FakeElement();
  portalHost.registerPortalRoot(root as unknown as HTMLElement);
});

afterEach(() => {
  portalHost._resetForTests();
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

describe("portal-host refcount", () => {
  test("second mount on same key keeps the original element", () => {
    const placeholder1 = new FakeElement();
    const first = new FakeElement();
    portalHost.mount({
      key: "k1",
      workspaceId: "ws",
      placeholder: placeholder1 as unknown as HTMLElement,
      element: first as unknown as HTMLElement,
    });

    const placeholder2 = new FakeElement();
    const second = new FakeElement();
    portalHost.mount({
      key: "k1",
      workspaceId: "ws",
      placeholder: placeholder2 as unknown as HTMLElement,
      element: second as unknown as HTMLElement,
    });

    // Original element is still the live mount; the second caller's element
    // was ignored (adoption).
    expect(portalHost.getMountElement("k1")).toBe(first as unknown as HTMLElement);
  });

  test("first unmount decrements refcount without hiding", () => {
    const placeholder = new FakeElement();
    const el = new FakeElement();
    portalHost.mount({
      key: "k2",
      workspaceId: "ws",
      placeholder: placeholder as unknown as HTMLElement,
      element: el as unknown as HTMLElement,
    });
    portalHost.mount({
      key: "k2",
      workspaceId: "ws",
      placeholder: placeholder as unknown as HTMLElement,
      element: new FakeElement() as unknown as HTMLElement,
    });

    portalHost.unmount("k2");
    expect(portalHost.hasMount("k2")).toBe(true);
    expect(portalHost.getMountElement("k2")).toBe(el as unknown as HTMLElement);
    // refCount > 0 after one unmount of two mounts — element stays visible.
    expect(el.style["display"]).not.toBe("none");
  });

  test("final unmount hides but preserves the mount", () => {
    const placeholder = new FakeElement();
    const el = new FakeElement();
    portalHost.mount({
      key: "k3",
      workspaceId: "ws",
      placeholder: placeholder as unknown as HTMLElement,
      element: el as unknown as HTMLElement,
    });

    portalHost.unmount("k3");
    // Hide-by-default: entry stays in the map, element stays in the portal,
    // ready for a future mount(key) to adopt it.
    expect(portalHost.hasMount("k3")).toBe(true);
    expect(portalHost.getMountElement("k3")).toBe(el as unknown as HTMLElement);
    expect(el.style["display"]).toBe("none");
  });

  test("re-mount after final unmount restores visibility (adoption)", () => {
    const placeholder = new FakeElement();
    const el = new FakeElement();
    portalHost.mount({
      key: "k3b",
      workspaceId: "ws",
      placeholder: placeholder as unknown as HTMLElement,
      element: el as unknown as HTMLElement,
    });

    portalHost.unmount("k3b");
    expect(el.style["display"]).toBe("none");

    portalHost.mount({
      key: "k3b",
      workspaceId: "ws",
      placeholder: new FakeElement() as unknown as HTMLElement,
      element: new FakeElement() as unknown as HTMLElement,
    });
    expect(portalHost.getMountElement("k3b")).toBe(el as unknown as HTMLElement);
    expect(el.style["display"]).toBe("");
  });

  test("onAttached fires only on fresh mount, not on adoption", () => {
    let attachedCalls = 0;
    const placeholder = new FakeElement();
    portalHost.mount({
      key: "k4",
      workspaceId: "ws",
      placeholder: placeholder as unknown as HTMLElement,
      element: new FakeElement() as unknown as HTMLElement,
      onAttached: () => {
        attachedCalls++;
      },
    });
    expect(attachedCalls).toBe(1);

    portalHost.mount({
      key: "k4",
      workspaceId: "ws",
      placeholder: placeholder as unknown as HTMLElement,
      element: new FakeElement() as unknown as HTMLElement,
      onAttached: () => {
        attachedCalls++;
      },
    });
    expect(attachedCalls).toBe(1);
  });

  test("swap race: unmount then mount on same key preserves element", () => {
    const placeholder1 = new FakeElement();
    const el = new FakeElement();
    portalHost.mount({
      key: "kswap",
      workspaceId: "ws",
      placeholder: placeholder1 as unknown as HTMLElement,
      element: el as unknown as HTMLElement,
    });

    // Unmount hides; the synchronous re-mount adopts the existing element.
    // Models the panel slot-swap batched-effect path.
    portalHost.unmount("kswap");
    portalHost.mount({
      key: "kswap",
      workspaceId: "ws",
      placeholder: new FakeElement() as unknown as HTMLElement,
      element: new FakeElement() as unknown as HTMLElement,
    });

    expect(portalHost.hasMount("kswap")).toBe(true);
    expect(portalHost.getMountElement("kswap")).toBe(el as unknown as HTMLElement);
    expect(el.style["display"]).toBe("");
  });

  test("rekey survives a cross-workspace transfer without destroying the element", () => {
    const srcPlaceholder = new FakeElement();
    const el = new FakeElement();
    portalHost.mount({
      key: "wsA:leafX:plugin",
      workspaceId: "wsA",
      placeholder: srcPlaceholder as unknown as HTMLElement,
      element: el as unknown as HTMLElement,
    });

    // Cross-workspace drag commit: source tree unmounts, rekey points the
    // entry at the destination key, then destination workspace mounts under
    // the new key — adopt path fires, display restored.
    portalHost.unmount("wsA:leafX:plugin");
    expect(portalHost.hasMount("wsA:leafX:plugin")).toBe(true);
    expect(el.style["display"]).toBe("none");

    portalHost.rekey("wsA:leafX:plugin", "wsB:leafY:plugin");
    expect(portalHost.hasMount("wsA:leafX:plugin")).toBe(false);
    expect(portalHost.hasMount("wsB:leafY:plugin")).toBe(true);

    const destPlaceholder = new FakeElement();
    portalHost.mount({
      key: "wsB:leafY:plugin",
      workspaceId: "wsB",
      placeholder: destPlaceholder as unknown as HTMLElement,
      element: new FakeElement() as unknown as HTMLElement,
    });
    expect(portalHost.getMountElement("wsB:leafY:plugin")).toBe(el as unknown as HTMLElement);
    expect(el.style["display"]).toBe("");
  });

  test("rekey collision throws rather than orphaning the existing entry", () => {
    portalHost.mount({
      key: "a",
      workspaceId: "ws",
      placeholder: new FakeElement() as unknown as HTMLElement,
      element: new FakeElement() as unknown as HTMLElement,
    });
    portalHost.mount({
      key: "b",
      workspaceId: "ws",
      placeholder: new FakeElement() as unknown as HTMLElement,
      element: new FakeElement() as unknown as HTMLElement,
    });
    expect(() => portalHost.rekey("a", "b")).toThrow();
    // Both entries still intact.
    expect(portalHost.hasMount("a")).toBe(true);
    expect(portalHost.hasMount("b")).toBe(true);
  });

  test("adoption repoints placeholder when it changes", () => {
    const originalPlaceholder = new FakeElement();
    const el = new FakeElement();
    portalHost.mount({
      key: "k5",
      workspaceId: "ws",
      placeholder: originalPlaceholder as unknown as HTMLElement,
      element: el as unknown as HTMLElement,
    });

    const newPlaceholder = new FakeElement();
    // Give the new placeholder a distinct rect so we can observe it took effect
    // when the next sync runs (syncRect is called inside mount's adopt path).
    newPlaceholder.getBoundingClientRect = () => ({ left: 50, top: 60, width: 200, height: 150 });
    portalHost.mount({
      key: "k5",
      workspaceId: "ws",
      placeholder: newPlaceholder as unknown as HTMLElement,
      element: new FakeElement() as unknown as HTMLElement,
    });

    expect(el.style["left"]).toBe("50px");
    expect(el.style["top"]).toBe("60px");
    expect(el.style["width"]).toBe("200px");
    expect(el.style["height"]).toBe("150px");
  });
});

describe("portal-host same-frame sync", () => {
  // The rAF stub never fires, so any rect that lands is proof the sync ran
  // synchronously — not on a later poll tick.

  function mountAt(key: string, rect: { left: number; top: number; width: number; height: number }) {
    const placeholder = new FakeElement();
    placeholder.getBoundingClientRect = () => rect;
    const el = new FakeElement();
    portalHost.mount({
      key,
      workspaceId: "ws",
      placeholder: placeholder as unknown as HTMLElement,
      element: el as unknown as HTMLElement,
    });
    return { placeholder, el };
  }

  test("requestSync applies a changed placeholder rect synchronously", () => {
    const { placeholder, el } = mountAt("s1", { left: 0, top: 0, width: 100, height: 100 });
    expect(el.style["width"]).toBe("100px");

    placeholder.getBoundingClientRect = () => ({ left: 10, top: 20, width: 300, height: 200 });
    portalHost.requestSync();

    expect(el.style["left"]).toBe("10px");
    expect(el.style["top"]).toBe("20px");
    expect(el.style["width"]).toBe("300px");
    expect(el.style["height"]).toBe("200px");
    expect(el.style["visibility"]).toBe("visible");
  });

  test("requestSync sweeps every changed mount in one call", () => {
    const a = mountAt("s2a", { left: 0, top: 0, width: 100, height: 100 });
    const b = mountAt("s2b", { left: 100, top: 0, width: 100, height: 100 });

    a.placeholder.getBoundingClientRect = () => ({ left: 0, top: 0, width: 150, height: 100 });
    b.placeholder.getBoundingClientRect = () => ({ left: 150, top: 0, width: 50, height: 100 });
    portalHost.requestSync();

    expect(a.el.style["width"]).toBe("150px");
    expect(b.el.style["left"]).toBe("150px");
    expect(b.el.style["width"]).toBe("50px");
  });

  test("ResizeObserver delivery syncs all mounts synchronously", () => {
    const a = mountAt("s3a", { left: 0, top: 0, width: 100, height: 100 });
    // A second mount that only MOVES (no resize) — the shared observer's
    // sweep must still pick it up off the back of the first mount's resize.
    const b = mountAt("s3b", { left: 100, top: 0, width: 100, height: 100 });

    a.placeholder.getBoundingClientRect = () => ({ left: 0, top: 0, width: 80, height: 100 });
    b.placeholder.getBoundingClientRect = () => ({ left: 80, top: 0, width: 100, height: 100 });
    expect(roCallback).not.toBeNull();
    roCallback!();

    expect(a.el.style["width"]).toBe("80px");
    expect(b.el.style["left"]).toBe("80px");
  });

  test("hidden mounts (refCount 0) are skipped by the sweep", () => {
    const { placeholder, el } = mountAt("s4", { left: 0, top: 0, width: 100, height: 100 });
    portalHost.unmount("s4");
    expect(el.style["display"]).toBe("none");

    placeholder.getBoundingClientRect = () => ({ left: 5, top: 5, width: 500, height: 500 });
    portalHost.requestSync();

    // Rect work skipped while hidden — stale styles are fine; adoption resyncs.
    expect(el.style["width"]).toBe("100px");
  });

  test("zero-size placeholder hides the element instead of painting 0×0", () => {
    const { placeholder, el } = mountAt("s5", { left: 0, top: 0, width: 100, height: 100 });
    placeholder.getBoundingClientRect = () => ({ left: 0, top: 0, width: 0, height: 0 });
    portalHost.requestSync();
    expect(el.style["visibility"]).toBe("hidden");
  });
});

describe("portal-host explicit destruction", () => {
  test("destroyByKey tears down the mount and runs onDestroy", () => {
    let destroyed = 0;
    const el = new FakeElement();
    portalHost.mount({
      key: "d1",
      workspaceId: "ws",
      placeholder: new FakeElement() as unknown as HTMLElement,
      element: el as unknown as HTMLElement,
      onDestroy: () => {
        destroyed++;
      },
    });
    expect(portalHost.hasMount("d1")).toBe(true);

    portalHost.destroyByKey("d1");
    expect(portalHost.hasMount("d1")).toBe(false);
    expect(portalHost.getMountElement("d1")).toBe(null);
    expect(el.parentElement).toBe(null);
    expect(destroyed).toBe(1);
  });

  test("destroyByKey on a hidden mount also runs onDestroy exactly once", () => {
    let destroyed = 0;
    portalHost.mount({
      key: "d1b",
      workspaceId: "ws",
      placeholder: new FakeElement() as unknown as HTMLElement,
      element: new FakeElement() as unknown as HTMLElement,
      onDestroy: () => {
        destroyed++;
      },
    });

    // Hide via unmount — onDestroy must NOT fire here.
    portalHost.unmount("d1b");
    expect(destroyed).toBe(0);
    expect(portalHost.hasMount("d1b")).toBe(true);

    portalHost.destroyByKey("d1b");
    expect(destroyed).toBe(1);
    expect(portalHost.hasMount("d1b")).toBe(false);
  });

  test("destroyByKey is a no-op on an unknown key", () => {
    expect(() => portalHost.destroyByKey("never-mounted")).not.toThrow();
  });

  test("destroyByWorkspace tears down only matching workspace", () => {
    let destroyedA = 0;
    let destroyedB = 0;
    portalHost.mount({
      key: "wsA:leaf1:p",
      workspaceId: "wsA",
      placeholder: new FakeElement() as unknown as HTMLElement,
      element: new FakeElement() as unknown as HTMLElement,
      onDestroy: () => {
        destroyedA++;
      },
    });
    portalHost.mount({
      key: "wsA:leaf2:p",
      workspaceId: "wsA",
      placeholder: new FakeElement() as unknown as HTMLElement,
      element: new FakeElement() as unknown as HTMLElement,
      onDestroy: () => {
        destroyedA++;
      },
    });
    portalHost.mount({
      key: "wsB:leaf1:p",
      workspaceId: "wsB",
      placeholder: new FakeElement() as unknown as HTMLElement,
      element: new FakeElement() as unknown as HTMLElement,
      onDestroy: () => {
        destroyedB++;
      },
    });

    portalHost.destroyByWorkspace("wsA");
    expect(destroyedA).toBe(2);
    expect(destroyedB).toBe(0);
    expect(portalHost.hasMount("wsA:leaf1:p")).toBe(false);
    expect(portalHost.hasMount("wsA:leaf2:p")).toBe(false);
    expect(portalHost.hasMount("wsB:leaf1:p")).toBe(true);
  });

  test("destroyAll tears down every mount", () => {
    let destroyed = 0;
    for (const key of ["wsA:l1:p", "wsB:l2:p", "wsC:l3:p"]) {
      portalHost.mount({
        key,
        workspaceId: key.split(":")[0]!,
        placeholder: new FakeElement() as unknown as HTMLElement,
        element: new FakeElement() as unknown as HTMLElement,
        onDestroy: () => {
          destroyed++;
        },
      });
    }
    expect(portalHost.liveMountKeys().length).toBe(3);

    portalHost.destroyAll();
    expect(destroyed).toBe(3);
    expect(portalHost.liveMountKeys().length).toBe(0);
  });

  test("onDestroy that throws is caught and does not abort teardown", () => {
    const el = new FakeElement();
    portalHost.mount({
      key: "throwy",
      workspaceId: "ws",
      placeholder: new FakeElement() as unknown as HTMLElement,
      element: el as unknown as HTMLElement,
      onDestroy: () => {
        throw new Error("boom");
      },
    });
    expect(() => portalHost.destroyByKey("throwy")).not.toThrow();
    expect(portalHost.hasMount("throwy")).toBe(false);
    expect(el.parentElement).toBe(null);
  });

  test("adoption does not replace the original onDestroy", () => {
    let originalDestroyed = 0;
    let adoptedDestroyed = 0;
    portalHost.mount({
      key: "adopt-destroy",
      workspaceId: "ws",
      placeholder: new FakeElement() as unknown as HTMLElement,
      element: new FakeElement() as unknown as HTMLElement,
      onDestroy: () => {
        originalDestroyed++;
      },
    });
    // Adopt: second mount's onDestroy is ignored — the original entry's
    // subscriptions are still valid since the iframe is unchanged.
    portalHost.mount({
      key: "adopt-destroy",
      workspaceId: "ws",
      placeholder: new FakeElement() as unknown as HTMLElement,
      element: new FakeElement() as unknown as HTMLElement,
      onDestroy: () => {
        adoptedDestroyed++;
      },
    });

    portalHost.destroyByKey("adopt-destroy");
    expect(originalDestroyed).toBe(1);
    expect(adoptedDestroyed).toBe(0);
  });
});
