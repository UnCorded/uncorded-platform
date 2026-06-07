// Pure-helper coverage for the matrix coordinator (spec-22 Amendment B
// PR 5.1). Each helper is small but the contract is load-bearing — the
// optimistic UI relies on these for race + reconcile correctness.

import { describe, expect, it } from "bun:test";
import {
  collapseQueue,
  filterGroupsByQuery,
  rollbackKeysOf,
  shouldDropOverlay,
  shouldShowMatrixSearch,
  type PendingClick,
} from "./matrix-coordinator";

const click = (
  permission: string,
  next: PendingClick["next"],
  generation: number,
): PendingClick => ({ permission, next, generation });

describe("collapseQueue", () => {
  it("returns an empty array for an empty queue", () => {
    expect(collapseQueue([])).toEqual([]);
  });

  it("preserves a single click verbatim", () => {
    const c = click("plugin.x", "grant", 1);
    expect(collapseQueue([c])).toEqual([c]);
  });

  it("keeps the LAST click per key (last-write-wins)", () => {
    const out = collapseQueue([
      click("plugin.x", "grant", 1),
      click("plugin.y", "deny", 2),
      click("plugin.x", "deny", 3),
      click("plugin.x", "inherit", 4),
    ]);
    // plugin.x's value is the most recent (inherit, gen 4) but Map keeps
    // the original insertion slot — x stays first, y stays second.
    expect(out).toEqual([
      click("plugin.x", "inherit", 4),
      click("plugin.y", "deny", 2),
    ]);
  });

  it("preserves first-insertion order of keys (Map semantics)", () => {
    // a is added first, then b, then a is overwritten — a stays at index 0.
    const out = collapseQueue([
      click("a", "grant", 1),
      click("b", "grant", 2),
      click("a", "deny", 3),
    ]);
    expect(out.map((c) => c.permission)).toEqual(["a", "b"]);
  });
});

describe("shouldDropOverlay", () => {
  it("true when nothing is in flight, queue empty, and overlay non-empty", () => {
    expect(
      shouldDropOverlay({ inflight: false, queueLength: 0, pendingSize: 1 }),
    ).toBe(true);
  });

  it("false while a mutation is inflight (our own response will reconcile)", () => {
    expect(
      shouldDropOverlay({ inflight: true, queueLength: 0, pendingSize: 1 }),
    ).toBe(false);
  });

  it("false when the queue still has un-flushed clicks", () => {
    expect(
      shouldDropOverlay({ inflight: false, queueLength: 2, pendingSize: 3 }),
    ).toBe(false);
  });

  it("false when the overlay is already empty (nothing to drop)", () => {
    expect(
      shouldDropOverlay({ inflight: false, queueLength: 0, pendingSize: 0 }),
    ).toBe(false);
  });

  it("false when both inflight AND queued (defensive belt+suspenders)", () => {
    expect(
      shouldDropOverlay({ inflight: true, queueLength: 5, pendingSize: 9 }),
    ).toBe(false);
  });
});

describe("shouldShowMatrixSearch", () => {
  const group = (count: number) => ({
    perms: Array.from({ length: count }, (_, i) => ({ key: `p${i}` })),
  });

  it("false for an empty matrix", () => {
    expect(shouldShowMatrixSearch([])).toBe(false);
  });

  it("false when every group is at or below the threshold (25)", () => {
    expect(shouldShowMatrixSearch([group(10), group(25)])).toBe(false);
  });

  it("true when at least one group exceeds the threshold", () => {
    expect(shouldShowMatrixSearch([group(10), group(26)])).toBe(true);
  });

  it("threshold is overridable for tests", () => {
    expect(shouldShowMatrixSearch([group(5)], 4)).toBe(true);
    expect(shouldShowMatrixSearch([group(5)], 10)).toBe(false);
  });
});

describe("filterGroupsByQuery", () => {
  const groups = [
    {
      slug: "core",
      perms: [
        { key: "core.permissions.manage", description: "Manage roles" },
        { key: "core.categories.manage", description: "Manage categories" },
      ],
    },
    {
      slug: "gallery",
      perms: [
        { key: "gallery.upload", description: "Upload images" },
        { key: "gallery.delete", description: "Delete images" },
      ],
    },
  ];

  it("returns the input unchanged for an empty query", () => {
    expect(filterGroupsByQuery(groups, "")).toEqual(groups);
  });

  it("matches case-insensitively against permission keys", () => {
    const out = filterGroupsByQuery(groups, "GALLERY");
    expect(out.length).toBe(1);
    expect(out[0]!.slug).toBe("gallery");
    expect(out[0]!.perms.length).toBe(2);
  });

  it("matches against human descriptions too", () => {
    const out = filterGroupsByQuery(groups, "categories");
    expect(out.length).toBe(1);
    expect(out[0]!.perms[0]!.key).toBe("core.categories.manage");
  });

  it("drops groups that end up with zero matches (no empty headers)", () => {
    const out = filterGroupsByQuery(groups, "upload");
    expect(out.length).toBe(1);
    expect(out[0]!.slug).toBe("gallery");
    expect(out[0]!.perms.map((p) => p.key)).toEqual(["gallery.upload"]);
  });

  it("trims whitespace before matching", () => {
    const out = filterGroupsByQuery(groups, "   manage   ");
    // Both core perms have "manage" in key+description; gallery has "manage" nowhere.
    expect(out.length).toBe(1);
    expect(out[0]!.slug).toBe("core");
    expect(out[0]!.perms.length).toBe(2);
  });

  it("returns empty array when nothing matches", () => {
    expect(filterGroupsByQuery(groups, "zzzzz")).toEqual([]);
  });
});

describe("rollbackKeysOf", () => {
  it("returns an empty set for an all-applied response", () => {
    expect(rollbackKeysOf([])).toEqual(new Set());
  });

  it("extracts every skipped permission key", () => {
    const set = rollbackKeysOf([
      { permission: "plugin.x", code: "HIERARCHY_VIOLATION", message: "no" },
      { permission: "plugin.y", code: "FORBIDDEN", message: "nope" },
    ]);
    expect(set).toEqual(new Set(["plugin.x", "plugin.y"]));
  });

  it("dedupes if the runtime ever emits the same key twice (defensive)", () => {
    const set = rollbackKeysOf([
      { permission: "plugin.x", code: "X", message: "1" },
      { permission: "plugin.x", code: "X", message: "2" },
    ]);
    expect(set.size).toBe(1);
    expect(set.has("plugin.x")).toBe(true);
  });
});
