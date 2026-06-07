import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUpdateLogStore } from "./log";
import type { UpdateLogEntry } from "./log";

let tmpDir: string;
let filePath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "update-log-test-"));
  filePath = join(tmpDir, "update-log.jsonl");
});

afterEach(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe("createUpdateLogStore", () => {
  test("returns an empty array when no file exists", () => {
    const store = createUpdateLogStore({ filePath });
    expect(store.getAll()).toEqual([]);
  });

  test("appends and persists entries; round-trips on reload", () => {
    const store = createUpdateLogStore({
      filePath,
      now: () => 1_700_000_001_000,
    });
    store.append({
      level: "info",
      state: "checking",
      errorContext: null,
      message: "transitioned to checking",
    });
    expect(store.getAll().length).toBe(1);
    expect(store.getAll()[0]?.ts).toBe(1_700_000_001_000);

    expect(existsSync(filePath)).toBe(true);
    const reloaded = createUpdateLogStore({ filePath });
    expect(reloaded.getAll().length).toBe(1);
    expect(reloaded.getAll()[0]?.message).toBe("transitioned to checking");
  });

  test("stamps ts from the injected clock, not from the caller", () => {
    let now = 1_700_000_000_000;
    const store = createUpdateLogStore({ filePath, now: () => now });
    now = 1_700_000_005_000;
    const stamped = store.append({
      level: "info",
      state: "idle",
      errorContext: null,
      message: "ok",
      ts: 1, // ignored
    } as Omit<UpdateLogEntry, "ts"> & { ts: number });
    expect(stamped.ts).toBe(1_700_000_005_000);
  });

  test("evicts oldest entries when capacity is exceeded", () => {
    const store = createUpdateLogStore({ filePath, now: () => 1 });
    for (let i = 0; i < 250; i++) {
      store.append({
        level: "info",
        state: "checking",
        errorContext: null,
        message: `entry-${String(i)}`,
      });
    }
    const all = store.getAll();
    expect(all.length).toBe(200);
    expect(all[0]?.message).toBe("entry-50");
    expect(all[all.length - 1]?.message).toBe("entry-249");
  });

  test("clear() drops all entries and persists empty file", () => {
    const store = createUpdateLogStore({ filePath, now: () => 1 });
    store.append({ level: "info", state: "idle", errorContext: null, message: "m" });
    store.clear();
    expect(store.getAll()).toEqual([]);

    const reloaded = createUpdateLogStore({ filePath });
    expect(reloaded.getAll()).toEqual([]);
  });

  test("ignores malformed JSONL lines on load", () => {
    writeFileSync(
      filePath,
      [
        JSON.stringify({ ts: 1, level: "info", state: "idle", errorContext: null, message: "good" }),
        "{not json",
        JSON.stringify({ ts: "wrong type" }),
        JSON.stringify({ ts: 2, level: "error", state: "error", errorContext: "check", message: "good2" }),
      ].join("\n"),
    );
    const store = createUpdateLogStore({ filePath });
    const all = store.getAll();
    expect(all.length).toBe(2);
    expect(all[0]?.message).toBe("good");
    expect(all[1]?.message).toBe("good2");
  });

  test("survives a missing file via fall-through", () => {
    rmSync(filePath, { force: true });
    const store = createUpdateLogStore({ filePath });
    expect(store.getAll()).toEqual([]);
  });

  test("rejects malformed level via type guard", () => {
    writeFileSync(
      filePath,
      JSON.stringify({ ts: 1, level: "warn", state: "idle", errorContext: null, message: "x" }),
    );
    // "warn" is not in the allowed level union — entry should be rejected.
    const store = createUpdateLogStore({ filePath });
    expect(store.getAll()).toEqual([]);
  });

  test("readFile failure falls back to empty (not throw)", () => {
    // Point at a directory — readFileSync will throw EISDIR.
    const dirAsFile = tmpDir;
    const store = createUpdateLogStore({ filePath: dirAsFile });
    expect(store.getAll()).toEqual([]);
  });
});
