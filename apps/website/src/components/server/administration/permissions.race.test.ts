// Two-actor race scenario for the permission matrix (spec-22 Amendment B
// PR 5.1). Models the exact sequence the plan calls out:
//
//   1. Actor A queues several flips and submits them as a grantMany.
//   2. Mid-flight, the runtime applies some and rejects others (e.g. a
//      role-edit by actor B raised a HIERARCHY_VIOLATION on one entry).
//   3. The matrix must roll back the failed keys from the optimistic
//      overlay while leaving the successful ones to be reconciled by the
//      authoritative refetch.
//
// We don't render SolidJS — we drive the same primitives the matrix uses
// (collapseQueue, rollbackKeysOf) with realistic state transitions.

import { describe, expect, it } from "bun:test";
import {
  collapseQueue,
  rollbackKeysOf,
  type PendingClick,
  type SkippedChange,
} from "./matrix-coordinator";
import { triFromOverride, type TriState } from "./matrix-state";

interface Overlay {
  // Mirrors the SolidJS Map<string, TriState> that holds the optimistic
  // tri-state per permission key.
  pending: Map<string, TriState>;
}

function applyClick(o: Overlay, c: PendingClick): void {
  o.pending.set(c.permission, c.next);
}

function applyRollback(o: Overlay, keys: Iterable<string>): void {
  for (const k of keys) o.pending.delete(k);
}

function applyClearOnSuccess(o: Overlay, keys: Iterable<string>): void {
  // The matrix clears every key that was *sent*; the keys still present
  // after this step are the ones whose mutation failed and stayed in the
  // overlay until the rollback step runs.
  for (const k of keys) o.pending.delete(k);
}

describe("race — partial-failure grantMany rolls back failed keys only", () => {
  it("succeeds for the applied keys, surfaces the failed key as overlay drop", () => {
    const overlay: Overlay = { pending: new Map() };

    // Actor A flips three permissions, then pauses. Two are safe but
    // `core.permissions.manage` will be rejected because actor A's own
    // level was just lowered by actor B.
    const queue: PendingClick[] = [
      { permission: "plugin.x", next: "grant", generation: 1 },
      { permission: "plugin.y", next: "deny", generation: 2 },
      { permission: "core.permissions.manage", next: "grant", generation: 3 },
    ];
    for (const c of queue) applyClick(overlay, c);
    expect(overlay.pending.size).toBe(3);

    // Flush — collapse + send.
    const sent = collapseQueue(queue);
    expect(sent.map((c) => c.permission)).toEqual([
      "plugin.x",
      "plugin.y",
      "core.permissions.manage",
    ]);

    // Runtime returns: applied=2, skipped=[manage].
    const skipped: SkippedChange[] = [
      {
        permission: "core.permissions.manage",
        code: "HIERARCHY_VIOLATION",
        message: "actor level not above target",
      },
    ];

    // Step 1 — clearPendingFor(rollbackKeysOf(skipped)) drops only the failed.
    applyRollback(overlay, rollbackKeysOf(skipped));
    expect(overlay.pending.has("core.permissions.manage")).toBe(false);
    expect(overlay.pending.has("plugin.x")).toBe(true);
    expect(overlay.pending.has("plugin.y")).toBe(true);

    // Step 2 — refetch arrives; matrix clears every key that was sent.
    // The successful x/y are reconciled against the new authoritative role.
    applyClearOnSuccess(overlay, sent.map((c) => c.permission));
    expect(overlay.pending.size).toBe(0);
  });

  it("collapses repeated clicks on the same key before sending", () => {
    // Actor A clicks plugin.x: grant → deny → inherit, all inside the
    // 250ms idle window. Only the final intent (inherit) should reach
    // the runtime.
    const queue: PendingClick[] = [
      { permission: "plugin.x", next: "grant", generation: 1 },
      { permission: "plugin.x", next: "deny", generation: 2 },
      { permission: "plugin.x", next: "inherit", generation: 3 },
    ];
    const sent = collapseQueue(queue);
    expect(sent).toEqual([
      { permission: "plugin.x", next: "inherit", generation: 3 },
    ]);
  });

  it("a third actor's mutation arriving mid-flight is reconciled by the upcoming refetch", () => {
    // Pre-flight: overlay says plugin.x → grant (actor A's optimistic flip).
    const overlay: Overlay = { pending: new Map([["plugin.x", "grant"]]) };

    // Mid-flight: actor C also touches plugin.x and the runtime broadcasts.
    // Because a mutation IS in flight, the matrix does NOT drop the overlay
    // (shouldDropOverlay returns false). Tested in
    // permissions.stale-event.test.ts; here we just verify the eventual
    // success path: when our flush returns OK, the overlay is cleared and
    // the *authoritative* role's overrides win.
    const sentKeys = ["plugin.x"];
    applyClearOnSuccess(overlay, sentKeys);
    expect(overlay.pending.size).toBe(0);

    // After refetch, the matrix reads triFromOverride on the new role. If
    // actor C set plugin.x to deny, the matrix must show deny — not the
    // grant we briefly held in the overlay.
    const newOverrides = [{ permission: "plugin.x", granted: false }];
    expect(triFromOverride("plugin.x", newOverrides)).toBe("deny");
  });
});
