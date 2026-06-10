import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { observeProxyViewport } from "./proxy-viewport";
import { ProxyError, createProxyClient } from "./proxy";

// observeProxyViewport watches a placeholder element and reports its rect to the
// shell, rAF-coalesced, via ResizeObserver + scroll/resize. bun's test runtime
// has no DOM, so we install controllable fakes: a manual rAF queue, a
// ResizeObserver whose callback we can fire, a window with listener tracking,
// and an element with a mutable rect.

let rafQueue: FrameRequestCallback[] = [];
let roCallbacks: Array<() => void> = [];
let scrollListeners: Array<() => void> = [];
let rect = { x: 10, y: 20, width: 100, height: 50 };

const el = {
  getBoundingClientRect: () => ({
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    top: rect.y,
    left: rect.x,
    right: rect.x + rect.width,
    bottom: rect.y + rect.height,
  }),
} as unknown as HTMLElement;

function flushRaf(): void {
  const q = rafQueue;
  rafQueue = [];
  for (const cb of q) cb(0);
}

function fireResize(): void {
  for (const cb of roCallbacks) cb();
}

const originals = {
  raf: globalThis.requestAnimationFrame,
  ro: globalThis.ResizeObserver,
  window: globalThis.window,
};

beforeEach(() => {
  rafQueue = [];
  roCallbacks = [];
  scrollListeners = [];
  rect = { x: 10, y: 20, width: 100, height: 50 };

  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    rafQueue.push(cb);
    return rafQueue.length;
  }) as typeof requestAnimationFrame;

  globalThis.ResizeObserver = class {
    constructor(cb: () => void) {
      roCallbacks.push(cb);
    }
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;

  (globalThis as { window?: unknown }).window = {
    addEventListener: (type: string, cb: () => void) => {
      if (type === "scroll" || type === "resize") scrollListeners.push(cb);
    },
    removeEventListener: () => {},
  };
});

afterEach(() => {
  globalThis.requestAnimationFrame = originals.raf;
  globalThis.ResizeObserver = originals.ro;
  if (originals.window) (globalThis as { window?: unknown }).window = originals.window;
  else delete (globalThis as { window?: unknown }).window;
});

describe("observeProxyViewport", () => {
  test("emits register-viewport with slug, mount, and rect on first frame", () => {
    const sent: unknown[] = [];
    observeProxyViewport({ send: (m) => sent.push(m) }, el, "foundry", "vtt");

    expect(sent).toHaveLength(0); // nothing until the rAF fires
    flushRaf();

    expect(sent).toEqual([
      {
        type: "platform.proxy.register-viewport",
        slug: "foundry",
        mountName: "vtt",
        rect: { x: 10, y: 20, width: 100, height: 50 },
      },
    ]);
  });

  test("emits update-viewport (no slug) when the rect changes", () => {
    const sent: Array<Record<string, unknown>> = [];
    observeProxyViewport({ send: (m) => sent.push(m as Record<string, unknown>) }, el, "foundry", "vtt");
    flushRaf();

    rect = { x: 0, y: 0, width: 200, height: 80 };
    fireResize();
    flushRaf();

    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual({
      type: "platform.proxy.update-viewport",
      mountName: "vtt",
      rect: { x: 0, y: 0, width: 200, height: 80 },
    });
  });

  test("coalesces — an unchanged rect produces no duplicate message", () => {
    const sent: unknown[] = [];
    observeProxyViewport({ send: (m) => sent.push(m) }, el, "foundry", "vtt");
    flushRaf();
    // Same rect, fire again.
    fireResize();
    flushRaf();
    expect(sent).toHaveLength(1);
  });

  test("dispose after register emits unregister-viewport once (idempotent)", () => {
    const sent: Array<Record<string, unknown>> = [];
    const dispose = observeProxyViewport(
      { send: (m) => sent.push(m as Record<string, unknown>) },
      el,
      "foundry",
      "vtt",
    );
    flushRaf();
    dispose();
    dispose(); // no-op

    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual({ type: "platform.proxy.unregister-viewport", mountName: "vtt" });
  });

  test("dispose before any register sends nothing (never registered)", () => {
    const sent: unknown[] = [];
    const dispose = observeProxyViewport({ send: (m) => sent.push(m) }, el, "foundry", "vtt");
    // No flushRaf — registration never happened.
    dispose();
    expect(sent).toHaveLength(0);
  });
});

describe("createProxyClient.reserveMount", () => {
  test("rejects an empty mount name before reserving", () => {
    const client = createProxyClient({
      slug: "foundry",
      token: "t",
      send: () => {},
    });
    expect(() => client.reserveMount("", el)).toThrow(ProxyError);
  });

  test("wires the SDK send into the viewport reporter", () => {
    const sent: Array<Record<string, unknown>> = [];
    const client = createProxyClient({
      slug: "foundry",
      token: "t",
      send: (m) => sent.push(m as Record<string, unknown>),
    });
    const dispose = client.reserveMount("vtt", el);
    flushRaf();
    expect(sent[0]).toMatchObject({ type: "platform.proxy.register-viewport", slug: "foundry", mountName: "vtt" });
    dispose();
  });
});
