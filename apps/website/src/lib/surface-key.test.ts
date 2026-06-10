import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import type { PanelContent } from "@uncorded/protocol";
import { surfaceKeyOf, proxyMountSurfaceKey } from "./surface-key";

// surfaceKeyOf reads isElectron() at call time, which checks window.electron.
// Stub window for each test so we exercise both the web and Electron branches
// deterministically under bun's non-DOM test runtime.

const originalWindow = globalThis.window;

function setElectron(on: boolean): void {
  const fake: Partial<Window> = on ? ({ electron: {} } as unknown as Window) : {};
  // bun tests run without a DOM; cast through unknown so the assignment type-checks.
  (globalThis as { window?: Window }).window = fake as Window;
}

beforeEach(() => setElectron(false));
afterEach(() => {
  if (originalWindow) (globalThis as { window?: Window }).window = originalWindow;
  else delete (globalThis as { window?: Window }).window;
});

const plugin = (overrides: Partial<Extract<PanelContent, { type: "plugin" }>> = {}): PanelContent => ({
  type: "plugin",
  serverId: "srv-1",
  tunnelUrl: "https://example.tunnel",
  slug: "text-channels",
  itemId: "item-1",
  itemLabel: "general",
  ...overrides,
});

const browser = (url = "https://example.com"): PanelContent => ({
  type: "browser",
  url,
  title: url,
});

describe("surfaceKeyOf (plugin)", () => {
  test("encodes server + slug", () => {
    expect(surfaceKeyOf(plugin())).toBe("plugin:srv-1:text-channels");
  });

  test("itemId does not affect key — same surface navigates", () => {
    const a = surfaceKeyOf(plugin({ itemId: "a" }));
    const b = surfaceKeyOf(plugin({ itemId: "b" }));
    expect(a).toBe(b);
  });

  test("itemLabel does not affect key", () => {
    const a = surfaceKeyOf(plugin({ itemLabel: "general" }));
    const b = surfaceKeyOf(plugin({ itemLabel: "random" }));
    expect(a).toBe(b);
  });

  test("itemIcon does not affect key", () => {
    const a = surfaceKeyOf(plugin({ itemIcon: "hash" }));
    const b = surfaceKeyOf(plugin());
    expect(a).toBe(b);
  });

  test("tunnelUrl does not affect key (host-level identity)", () => {
    const a = surfaceKeyOf(plugin({ tunnelUrl: "https://a.tunnel" }));
    const b = surfaceKeyOf(plugin({ tunnelUrl: "https://b.tunnel" }));
    expect(a).toBe(b);
  });

  test("different serverId ⇒ different key (separate mount)", () => {
    const a = surfaceKeyOf(plugin({ serverId: "srv-1" }));
    const b = surfaceKeyOf(plugin({ serverId: "srv-2" }));
    expect(a).not.toBe(b);
  });

  test("different slug ⇒ different key (separate mount)", () => {
    const a = surfaceKeyOf(plugin({ slug: "text-channels" }));
    const b = surfaceKeyOf(plugin({ slug: "members" }));
    expect(a).not.toBe(b);
  });
});

describe("surfaceKeyOf (browser)", () => {
  test("web → iframe kind", () => {
    setElectron(false);
    expect(surfaceKeyOf(browser())).toBe("browser:iframe");
  });

  test("Electron → webview kind", () => {
    setElectron(true);
    expect(surfaceKeyOf(browser())).toBe("browser:webview");
  });

  test("URL changes do not affect key — existing surface navigates", () => {
    setElectron(false);
    const a = surfaceKeyOf(browser("https://a.com"));
    const b = surfaceKeyOf(browser("https://b.com"));
    expect(a).toBe(b);
  });

  test("title does not affect key", () => {
    setElectron(false);
    const a = surfaceKeyOf({ type: "browser", url: "https://a.com", title: "A" });
    const b = surfaceKeyOf({ type: "browser", url: "https://a.com", title: "B" });
    expect(a).toBe(b);
  });

  test("Electron ↔ web swap ⇒ different key (rare remount)", () => {
    setElectron(false);
    const web = surfaceKeyOf(browser());
    setElectron(true);
    const electron = surfaceKeyOf(browser());
    expect(web).not.toBe(electron);
  });
});

describe("proxyMountSurfaceKey", () => {
  test("encodes server + slug + mount name", () => {
    expect(proxyMountSurfaceKey("srv-1", "foundry", "vtt")).toBe("proxy-mount:srv-1:foundry:vtt");
  });

  test("different serverId ⇒ different key (separate mount)", () => {
    expect(proxyMountSurfaceKey("srv-1", "foundry", "vtt")).not.toBe(
      proxyMountSurfaceKey("srv-2", "foundry", "vtt"),
    );
  });

  test("different slug ⇒ different key", () => {
    expect(proxyMountSurfaceKey("srv-1", "foundry", "vtt")).not.toBe(
      proxyMountSurfaceKey("srv-1", "grafana", "vtt"),
    );
  });

  test("different mount name ⇒ different key", () => {
    expect(proxyMountSurfaceKey("srv-1", "foundry", "vtt")).not.toBe(
      proxyMountSurfaceKey("srv-1", "foundry", "admin"),
    );
  });

  test("stable across calls and independent of platform (isElectron flip)", () => {
    setElectron(false);
    const web = proxyMountSurfaceKey("srv-1", "foundry", "vtt");
    setElectron(true);
    const electron = proxyMountSurfaceKey("srv-1", "foundry", "vtt");
    expect(web).toBe(electron);
    expect(web).toBe("proxy-mount:srv-1:foundry:vtt");
  });

  test("distinct from the plugin panel surface key for the same server/slug", () => {
    // The plugin iframe and the promoted proxy surface coexist — they must
    // never collide on one portal mount.
    expect(proxyMountSurfaceKey("srv-1", "foundry", "vtt")).not.toBe(
      surfaceKeyOf(plugin({ serverId: "srv-1", slug: "foundry" })),
    );
  });
});

describe("surfaceKeyOf (reconciliation matrix)", () => {
  test("plugin vs browser are always different surfaces", () => {
    expect(surfaceKeyOf(plugin())).not.toBe(surfaceKeyOf(browser()));
  });

  test("two plugins on the same server with different slugs are separate surfaces", () => {
    const a = surfaceKeyOf(plugin({ slug: "text-channels" }));
    const b = surfaceKeyOf(plugin({ slug: "members" }));
    expect(a).not.toBe(b);
  });

  test("two plugins with same slug on different servers are separate surfaces", () => {
    const a = surfaceKeyOf(plugin({ serverId: "srv-a" }));
    const b = surfaceKeyOf(plugin({ serverId: "srv-b" }));
    expect(a).not.toBe(b);
  });
});
