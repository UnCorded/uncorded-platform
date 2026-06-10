import { describe, expect, test, beforeEach } from "bun:test";
import {
  proxyMounts$,
  register,
  update,
  unregister,
  unregisterForFrame,
  parseMountName,
  parseViewportRect,
  _resetForTest,
  type ViewportRect,
} from "./proxy-mount-manager";

// proxy-mount-manager is the shell-side registry of host-owned proxy surfaces.
// These tests cover the registry keying/lifecycle and the untrusted-payload
// validators in isolation — no DOM and no Solid root are required to read the
// signal's current value.

const RECT: ViewportRect = { x: 1, y: 2, width: 3, height: 4 };
const iframe = {} as unknown as HTMLIFrameElement;

function baseInput(over: Partial<Parameters<typeof register>[0]> = {}) {
  return {
    frameKey: "ws:panel:proxy-mount:srv-1:foundry-vtt:vtt",
    iframe,
    serverId: "srv-1",
    slug: "foundry-vtt",
    tunnelUrl: "https://srv-1.tunnel.example",
    mountName: "vtt",
    rect: RECT,
    ...over,
  };
}

beforeEach(() => {
  _resetForTest();
});

describe("register / proxyMounts$", () => {
  test("adds an entry and publishes it", () => {
    register(baseInput());
    const mounts = proxyMounts$();
    expect(mounts).toHaveLength(1);
    expect(mounts[0]).toMatchObject({ serverId: "srv-1", slug: "foundry-vtt", mountName: "vtt", rect: RECT });
  });

  test("keys by frameKey + mountName — distinct mounts coexist", () => {
    register(baseInput({ mountName: "vtt" }));
    register(baseInput({ mountName: "setup" }));
    expect(proxyMounts$()).toHaveLength(2);
  });

  test("re-register for the same key updates rect in place without a new entry", () => {
    register(baseInput());
    const first = proxyMounts$()[0];
    register(baseInput({ rect: { x: 9, y: 9, width: 9, height: 9 } }));
    const after = proxyMounts$();
    expect(after).toHaveLength(1);
    // Same entry object identity — a stable surface (no webview reload).
    expect(after[0]).toBe(first);
    expect(after[0]!.rect).toEqual({ x: 9, y: 9, width: 9, height: 9 });
  });
});

describe("update", () => {
  test("mutates the rect in place without publishing a new array", () => {
    register(baseInput());
    const arrayBefore = proxyMounts$();
    const entryBefore = arrayBefore[0]!;
    update({ frameKey: baseInput().frameKey, mountName: "vtt", rect: { x: 5, y: 6, width: 7, height: 8 } });
    // No publish on update — same array reference, same entry, mutated rect.
    expect(proxyMounts$()).toBe(arrayBefore);
    expect(entryBefore.rect).toEqual({ x: 5, y: 6, width: 7, height: 8 });
  });

  test("is a no-op for an unknown mount", () => {
    register(baseInput());
    update({ frameKey: "other", mountName: "vtt", rect: RECT });
    expect(proxyMounts$()[0]!.rect).toEqual(RECT);
  });
});

describe("unregister / unregisterForFrame", () => {
  test("unregister removes one mount and publishes", () => {
    register(baseInput({ mountName: "vtt" }));
    register(baseInput({ mountName: "setup" }));
    unregister({ frameKey: baseInput().frameKey, mountName: "vtt" });
    const mounts = proxyMounts$();
    expect(mounts).toHaveLength(1);
    expect(mounts[0]!.mountName).toBe("setup");
  });

  test("unregisterForFrame sweeps every mount owned by a frame", () => {
    register(baseInput({ frameKey: "frame-A", mountName: "vtt" }));
    register(baseInput({ frameKey: "frame-A", mountName: "setup" }));
    register(baseInput({ frameKey: "frame-B", mountName: "vtt" }));
    unregisterForFrame("frame-A");
    const mounts = proxyMounts$();
    expect(mounts).toHaveLength(1);
    expect(mounts[0]!.frameKey).toBe("frame-B");
  });

  test("unregisterForFrame with no matching frame leaves state untouched", () => {
    register(baseInput());
    const before = proxyMounts$();
    unregisterForFrame("nope");
    expect(proxyMounts$()).toBe(before);
  });
});

describe("parseMountName", () => {
  test("accepts a valid lowercase hyphenated name", () => {
    expect(parseMountName("foundry-vtt")).toBe("foundry-vtt");
    expect(parseMountName("vtt")).toBe("vtt");
    expect(parseMountName("a1-b2-c3")).toBe("a1-b2-c3");
  });

  test("rejects junk and traversal attempts", () => {
    for (const bad of [
      "",
      "  ",
      "Foundry", // uppercase
      "1abc", // leading digit
      "-abc", // leading hyphen
      "abc-", // trailing hyphen
      "a--b", // doubled hyphen
      "a/b", // slash (traversal)
      "../etc", // traversal
      "a.b", // dot
      "a b", // space
      123,
      null,
      undefined,
      {},
    ]) {
      expect(parseMountName(bad as unknown)).toBeNull();
    }
  });

  test("rejects an over-long name", () => {
    expect(parseMountName("a".repeat(129))).toBeNull();
  });
});

describe("parseViewportRect", () => {
  test("accepts a finite non-negative-size rect", () => {
    expect(parseViewportRect({ x: 1.5, y: -2, width: 3, height: 0 })).toEqual({
      x: 1.5,
      y: -2,
      width: 3,
      height: 0,
    });
  });

  test("rejects non-objects, missing/NaN/Infinite fields, and negative size", () => {
    for (const bad of [
      null,
      undefined,
      "rect",
      42,
      {},
      { x: 1, y: 2, width: 3 }, // missing height
      { x: 1, y: 2, width: 3, height: "4" }, // non-number
      { x: Number.NaN, y: 0, width: 1, height: 1 },
      { x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 1 },
      { x: 0, y: 0, width: -1, height: 1 }, // negative width
      { x: 0, y: 0, width: 1, height: -1 }, // negative height
    ]) {
      expect(parseViewportRect(bad as unknown)).toBeNull();
    }
  });
});
