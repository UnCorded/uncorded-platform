import { afterEach, describe, expect, test } from "bun:test";
import {
  clearInlineStatus,
  clearToasts,
  dismissToast,
  inlineStatus,
  showInlineStatus,
  showToast,
  toasts,
} from "./feedback";

afterEach(() => {
  clearToasts();
});

describe("feedback toasts", () => {
  test("showInlineStatus adds a visible toast", () => {
    showInlineStatus("Saved", "info", 0);

    expect(toasts()).toHaveLength(1);
    expect(inlineStatus()?.message).toBe("Saved");
    expect(inlineStatus()?.severity).toBe("info");
  });

  test("keeps multiple notifications instead of replacing the previous one", () => {
    showToast("First", "info", { dismissMs: 0 });
    showToast("Second", "warning", { dismissMs: 0 });

    expect(toasts().map((toast) => toast.message)).toEqual(["Second", "First"]);
  });

  test("dedupes matching message and severity while refreshing its position", () => {
    const firstId = showToast("Saved", "info", { dismissMs: 0 });
    showToast("Other", "info", { dismissMs: 0 });
    const secondId = showToast("Saved", "info", { dismissMs: 0 });

    expect(secondId).toBe(firstId);
    expect(toasts().map((toast) => toast.message)).toEqual(["Saved", "Other"]);
  });

  test("caps the visible stack", () => {
    for (let i = 1; i <= 5; i += 1) {
      showToast(`Toast ${String(i)}`, "info", { dismissMs: 0 });
    }

    expect(toasts().map((toast) => toast.message)).toEqual([
      "Toast 5",
      "Toast 4",
      "Toast 3",
      "Toast 2",
    ]);
  });

  test("dismisses one toast or all legacy inline statuses", () => {
    const id = showToast("One", "info", { dismissMs: 0 });
    showToast("Two", "error", { dismissMs: 0 });

    dismissToast(id);
    expect(toasts().map((toast) => toast.message)).toEqual(["Two"]);

    clearInlineStatus();
    expect(toasts()).toEqual([]);
  });
});
