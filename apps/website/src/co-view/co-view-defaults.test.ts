// Per-account Co-View defaults — round-trip + tampering tolerance + key isolation.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  ALL_REDACTION_KEYS,
  REDACTION_LABELS,
  clearCoViewDefaults,
  getCoViewDefaults,
  getSpecCoViewDefaults,
  isAlwaysRedacted,
  redactionsForWire,
  setCoViewDefaults,
  type CoViewDefaults,
  type CoViewRedactionKey,
} from "./co-view-defaults";

// Bun runs in a Node-like environment. Stub localStorage so the tests can
// run without a DOM. The module reads window.localStorage at call time.
class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  key(i: number): string | null {
    return Array.from(this.map.keys())[i] ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

interface WindowShape {
  localStorage: Storage;
}
declare const globalThis: { window?: WindowShape } & Record<string, unknown>;

beforeEach(() => {
  globalThis.window = { localStorage: new MemoryStorage() };
});

afterEach(() => {
  delete globalThis.window;
});

describe("getCoViewDefaults", () => {
  test("returns spec defaults when no entry exists", () => {
    const d = getCoViewDefaults("acct-1");
    expect(d).toEqual(getSpecCoViewDefaults());
    expect(d.visibility).toBe("private");
    expect(d.renderMode).toBe("as-viewer");
    expect(d.redactions).toEqual(["account-settings"]);
  });

  test("round-trips set → get", () => {
    const wanted: CoViewDefaults = {
      visibility: "public",
      renderMode: "as-host",
      redactions: ["account-settings", "notifications"],
    };
    setCoViewDefaults("acct-1", wanted);
    expect(getCoViewDefaults("acct-1")).toEqual(wanted);
  });

  test("isolates accounts by id", () => {
    setCoViewDefaults("alice", {
      visibility: "public",
      renderMode: "as-host",
      redactions: ["account-settings"],
    });
    expect(getCoViewDefaults("bob")).toEqual(getSpecCoViewDefaults());
  });

  test("force-includes account-settings even if user removed it", () => {
    // Simulate a tampered localStorage entry that omitted account-settings.
    globalThis.window!.localStorage.setItem(
      "co-view.defaults.acct-tamper",
      JSON.stringify({
        visibility: "public",
        renderMode: "as-host",
        redactions: ["notifications"],
      }),
    );
    const d = getCoViewDefaults("acct-tamper");
    expect(d.redactions).toContain("account-settings");
    expect(d.redactions).toContain("notifications");
  });

  test("falls back to spec on malformed JSON", () => {
    globalThis.window!.localStorage.setItem(
      "co-view.defaults.acct-bad",
      "{not json",
    );
    expect(getCoViewDefaults("acct-bad")).toEqual(getSpecCoViewDefaults());
  });

  test("falls back to spec on wrong-type fields", () => {
    globalThis.window!.localStorage.setItem(
      "co-view.defaults.acct-bad-types",
      JSON.stringify({ visibility: 42, renderMode: null, redactions: "no" }),
    );
    const d = getCoViewDefaults("acct-bad-types");
    // Visibility + renderMode fall back to spec; redactions normalize to [account-settings].
    expect(d.visibility).toBe("private");
    expect(d.renderMode).toBe("as-viewer");
    expect(d.redactions).toEqual(["account-settings"]);
  });

  test("clearCoViewDefaults removes the entry", () => {
    setCoViewDefaults("acct-1", {
      visibility: "public",
      renderMode: "as-host",
      redactions: ["account-settings"],
    });
    clearCoViewDefaults("acct-1");
    expect(getCoViewDefaults("acct-1")).toEqual(getSpecCoViewDefaults());
  });

  test("setCoViewDefaults force-includes account-settings on write", () => {
    setCoViewDefaults("acct-1", {
      visibility: "public",
      renderMode: "as-host",
      // intentionally exclude account-settings from the call site
      redactions: ["notifications"] as CoViewRedactionKey[],
    });
    const d = getCoViewDefaults("acct-1");
    expect(d.redactions).toContain("account-settings");
    expect(d.redactions).toContain("notifications");
  });
});

describe("isAlwaysRedacted", () => {
  test("only account-settings is always-on", () => {
    expect(isAlwaysRedacted("account-settings")).toBe(true);
    expect(isAlwaysRedacted("notifications")).toBe(false);
    expect(isAlwaysRedacted("direct-messages")).toBe(false);
    expect(isAlwaysRedacted("personal-files")).toBe(false);
  });
});

describe("ALL_REDACTION_KEYS / REDACTION_LABELS", () => {
  test("every key has a label", () => {
    for (const k of ALL_REDACTION_KEYS) {
      expect(REDACTION_LABELS[k]).toBeDefined();
      expect(REDACTION_LABELS[k]).toBeString();
    }
  });
});

describe("redactionsForWire", () => {
  test("maps user keys to wire panel_ids; plugin/custom channels stay empty", () => {
    const wire = redactionsForWire(["account-settings", "notifications"]);
    expect(wire.panel_ids).toEqual(["account-settings", "notifications"]);
    expect(wire.plugin_slugs).toEqual([]);
    expect(wire.custom_selectors).toEqual([]);
  });

  test("empty input returns all-empty arrays", () => {
    expect(redactionsForWire([])).toEqual({
      panel_ids: [],
      plugin_slugs: [],
      custom_selectors: [],
    });
  });
});
