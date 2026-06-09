import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUpdateStateStore } from "./store";
import type { RuntimeUpdateState } from "./types";

let tmpDir: string;
let filePath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "update-state-test-"));
  filePath = join(tmpDir, "update-state.json");
});

afterEach(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe("createUpdateStateStore", () => {
  test("returns the spec default state when no file exists", () => {
    const store = createUpdateStateStore({
      filePath,
      currentVersion: "1.0.0-test",
      now: () => 1_700_000_000_000,
    });
    const state = store.get();
    expect(state.state).toBe("idle");
    expect(state.errorContext).toBe(null);
    expect(state.currentVersion).toBe("1.0.0-test");
    expect(state.availableVersion).toBe(null);
    expect(state.channel).toBe("stable");
    expect(state.progress).toBe(null);
    expect(state.lastCheckedAt).toBe(null);
    expect(state.errorMessage).toBe(null);
    expect(state.updatedAt).toBe(1_700_000_000_000);
  });

  test("loads existing valid state from disk", () => {
    const persisted: RuntimeUpdateState = {
      state: "available",
      errorContext: null,
      currentVersion: "0.9.0-old", // should be overwritten with currentVersion option
      availableVersion: "1.1.0-test",
      channel: "test",
      progress: null,
      lastCheckedAt: 1_699_999_000_000,
      errorMessage: null,
      updatedAt: 1_699_999_000_000,
    };
    writeFileSync(filePath, JSON.stringify(persisted));

    const store = createUpdateStateStore({
      filePath,
      currentVersion: "1.0.0-test",
    });
    const state = store.get();
    expect(state.state).toBe("available");
    expect(state.availableVersion).toBe("1.1.0-test");
    expect(state.channel).toBe("test");
    // currentVersion always reflects THIS image, never what the file said.
    expect(state.currentVersion).toBe("1.0.0-test");
  });

  test("falls back to defaults when the file is malformed JSON", () => {
    writeFileSync(filePath, "{not json");
    const store = createUpdateStateStore({
      filePath,
      currentVersion: "1.0.0-test",
      now: () => 1_700_000_000_000,
    });
    expect(store.get().state).toBe("idle");
    expect(store.get().updatedAt).toBe(1_700_000_000_000);
  });

  test("falls back to defaults when the file is structurally invalid", () => {
    writeFileSync(filePath, JSON.stringify({ state: "idle" })); // missing required fields
    const store = createUpdateStateStore({
      filePath,
      currentVersion: "1.0.0-test",
      now: () => 1_700_000_000_000,
    });
    expect(store.get().state).toBe("idle");
    expect(store.get().currentVersion).toBe("1.0.0-test");
  });

  test("set persists the patch and stamps updatedAt", () => {
    let now = 1_700_000_000_000;
    const store = createUpdateStateStore({
      filePath,
      currentVersion: "1.0.0-test",
      now: () => now,
    });

    now = 1_700_000_001_000;
    const next = store.set({ state: "checking" });
    expect(next.state).toBe("checking");
    expect(next.updatedAt).toBe(1_700_000_001_000);

    // Round-trip: a fresh store loads the same state from disk
    expect(existsSync(filePath)).toBe(true);
    const onDisk = JSON.parse(readFileSync(filePath, "utf8")) as RuntimeUpdateState;
    expect(onDisk.state).toBe("checking");
    expect(onDisk.updatedAt).toBe(1_700_000_001_000);
  });

  test("set ignores caller-supplied updatedAt", () => {
    let now = 1_700_000_000_000;
    const store = createUpdateStateStore({
      filePath,
      currentVersion: "1.0.0-test",
      now: () => now,
    });
    now = 1_700_000_005_000;
    const result = store.set({ state: "idle", updatedAt: 1 } as Partial<RuntimeUpdateState>);
    expect(result.updatedAt).toBe(1_700_000_005_000);
  });

  test("subscribe fires after persistence; unsubscribe stops further notifications", () => {
    const store = createUpdateStateStore({
      filePath,
      currentVersion: "1.0.0-test",
      now: () => 1_700_000_000_000,
    });

    const events: RuntimeUpdateState[] = [];
    const unsubscribe = store.subscribe((s) => events.push(s));

    store.set({ state: "checking" });
    store.set({ state: "available", availableVersion: "1.2.0" });
    expect(events.length).toBe(2);
    expect(events[0]?.state).toBe("checking");
    expect(events[1]?.state).toBe("available");
    expect(events[1]?.availableVersion).toBe("1.2.0");

    unsubscribe();
    store.set({ state: "idle" });
    expect(events.length).toBe(2);
  });

  test("a throwing listener does not break subsequent listeners", () => {
    const store = createUpdateStateStore({
      filePath,
      currentVersion: "1.0.0-test",
    });
    let bCalled = 0;
    store.subscribe(() => {
      throw new Error("a is broken");
    });
    store.subscribe(() => {
      bCalled += 1;
    });
    store.set({ state: "checking" });
    expect(bCalled).toBe(1);
  });
});
