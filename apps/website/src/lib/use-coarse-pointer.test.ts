import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { createRoot } from "solid-js";
import { useCoarsePointer } from "./use-coarse-pointer";

// Bun's test runtime has no DOM, so window.matchMedia must be stubbed for
// each test. The hook reads matchMedia at call time and subscribes to a
// `change` event on the returned MQL — the fake mirrors that surface.

type Listener = (e: { matches: boolean }) => void;

interface FakeMQL {
  matches: boolean;
  addEventListener: (type: "change", l: Listener) => void;
  removeEventListener: (type: "change", l: Listener) => void;
  fire: (matches: boolean) => void;
  listenerCount: () => number;
}

function makeMQL(initial: boolean): FakeMQL {
  const listeners = new Set<Listener>();
  return {
    matches: initial,
    addEventListener: (_type, l) => { listeners.add(l); },
    removeEventListener: (_type, l) => { listeners.delete(l); },
    fire(matches: boolean) {
      this.matches = matches;
      for (const l of listeners) l({ matches });
    },
    listenerCount: () => listeners.size,
  };
}

const originalWindow = globalThis.window;

function installWindow(mql: FakeMQL | null): void {
  const fake: Partial<Window> = mql
    ? ({ matchMedia: (() => mql) as unknown as Window["matchMedia"] } as unknown as Window)
    : ({} as Window);
  (globalThis as { window?: Window }).window = fake as Window;
}

beforeEach(() => installWindow(makeMQL(false)));
afterEach(() => {
  if (originalWindow) (globalThis as { window?: Window }).window = originalWindow;
  else delete (globalThis as { window?: Window }).window;
});

describe("useCoarsePointer", () => {
  test("returns initial MQL.matches synchronously", () => {
    const mql = makeMQL(true);
    installWindow(mql);
    createRoot((dispose) => {
      const coarse = useCoarsePointer();
      expect(coarse()).toBe(true);
      dispose();
    });
  });

  test("returns false when matchMedia is unavailable", () => {
    installWindow(null);
    const coarse = useCoarsePointer();
    expect(coarse()).toBe(false);
  });

  test("returns false when window is undefined (SSR / bun:test default)", () => {
    delete (globalThis as { window?: Window }).window;
    const coarse = useCoarsePointer();
    expect(coarse()).toBe(false);
  });

  test("flips reactively when MQL fires `change`", () => {
    const mql = makeMQL(false);
    installWindow(mql);
    createRoot((dispose) => {
      const coarse = useCoarsePointer();
      expect(coarse()).toBe(false);
      mql.fire(true);
      expect(coarse()).toBe(true);
      mql.fire(false);
      expect(coarse()).toBe(false);
      dispose();
    });
  });

  test("unsubscribes from the MQL on root dispose (no listener leak)", () => {
    const mql = makeMQL(false);
    installWindow(mql);
    const dispose = createRoot((d) => {
      useCoarsePointer();
      return d;
    });
    expect(mql.listenerCount()).toBe(1);
    dispose();
    expect(mql.listenerCount()).toBe(0);
  });
});
