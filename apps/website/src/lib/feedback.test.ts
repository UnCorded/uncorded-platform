import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";

// Cache-bust the feedback import. server-purge.test.ts mocks "@/lib/feedback"
// with a no-op showInlineStatus to assert orchestration; Bun's mock.module is
// process-global and on Linux CI it does not reset between files, so a plain
// `import { showInlineStatus } from "./feedback"` here can freeze to that
// leaked no-op (its afterAll restore re-points the registry but cannot rebind
// an already-linked import) — showInlineStatus then adds no toast and this
// suite fails with toasts().length === 0. The `?fresh` query resolves to a
// distinct specifier that is never the mocked key, forcing a clean evaluation
// of the real module. Held in a variable so TypeScript doesn't try to resolve
// the suffixed path. (Windows isolates the registry per file, hence CI-only.)
const freshSpecifier = "./feedback?fresh";
let fb: typeof import("./feedback");

beforeAll(async () => {
  fb = (await import(freshSpecifier)) as typeof import("./feedback");
});

afterEach(() => {
  fb.clearToasts();
});

afterAll(() => {
  fb.clearToasts();
});

describe("feedback toasts", () => {
  test("showInlineStatus adds a visible toast", () => {
    fb.showInlineStatus("Saved", "info", 0);

    expect(fb.toasts()).toHaveLength(1);
    expect(fb.inlineStatus()?.message).toBe("Saved");
    expect(fb.inlineStatus()?.severity).toBe("info");
  });

  test("keeps multiple notifications instead of replacing the previous one", () => {
    fb.showToast("First", "info", { dismissMs: 0 });
    fb.showToast("Second", "warning", { dismissMs: 0 });

    expect(fb.toasts().map((toast) => toast.message)).toEqual(["Second", "First"]);
  });

  test("dedupes matching message and severity while refreshing its position", () => {
    const firstId = fb.showToast("Saved", "info", { dismissMs: 0 });
    fb.showToast("Other", "info", { dismissMs: 0 });
    const secondId = fb.showToast("Saved", "info", { dismissMs: 0 });

    expect(secondId).toBe(firstId);
    expect(fb.toasts().map((toast) => toast.message)).toEqual(["Saved", "Other"]);
  });

  test("caps the visible stack", () => {
    for (let i = 1; i <= 5; i += 1) {
      fb.showToast(`Toast ${String(i)}`, "info", { dismissMs: 0 });
    }

    expect(fb.toasts().map((toast) => toast.message)).toEqual([
      "Toast 5",
      "Toast 4",
      "Toast 3",
      "Toast 2",
    ]);
  });

  test("dismisses one toast or all legacy inline statuses", () => {
    const id = fb.showToast("One", "info", { dismissMs: 0 });
    fb.showToast("Two", "error", { dismissMs: 0 });

    fb.dismissToast(id);
    expect(fb.toasts().map((toast) => toast.message)).toEqual(["Two"]);

    fb.clearInlineStatus();
    expect(fb.toasts()).toEqual([]);
  });
});
