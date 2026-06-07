// Stale-event scenario for the permission matrix (spec-22 Amendment B
// PR 5.1). When a `core.permission.changed` event arrives while we have
// our own mutation in flight or queued clicks pending, the overlay must
// NOT be dropped — our own response will reconcile. When the event is
// purely from a third actor (nothing in flight, no queued work) and our
// overlay is non-empty, the overlay must be cleared so the upcoming
// refetch wins.
//
// The truth table below pins this contract — it's the exact rule the
// matrix uses inside its onPluginMessage handler.

import { describe, expect, it } from "bun:test";
import { shouldDropOverlay } from "./matrix-coordinator";

interface MatrixSnapshot {
  inflight: boolean;
  queueLength: number;
  pendingSize: number;
  expected: boolean;
  reason: string;
}

const TRUTH_TABLE: MatrixSnapshot[] = [
  {
    inflight: false, queueLength: 0, pendingSize: 1,
    expected: true,
    reason: "third actor — overlay must drop, refetch wins",
  },
  {
    inflight: true, queueLength: 0, pendingSize: 1,
    expected: false,
    reason: "our mutation is round-tripping; success/error path will reconcile",
  },
  {
    inflight: false, queueLength: 3, pendingSize: 5,
    expected: false,
    reason: "user has clicked since last flush; the next flush reconciles",
  },
  {
    inflight: false, queueLength: 0, pendingSize: 0,
    expected: false,
    reason: "nothing to drop",
  },
  {
    inflight: true, queueLength: 7, pendingSize: 9,
    expected: false,
    reason: "both inflight AND queued — defensive belt+suspenders",
  },
];

describe("stale-event reconciliation truth table", () => {
  for (const row of TRUTH_TABLE) {
    it(`(inflight=${row.inflight}, queue=${row.queueLength}, pending=${row.pendingSize}) → ${row.expected} — ${row.reason}`, () => {
      expect(
        shouldDropOverlay({
          inflight: row.inflight,
          queueLength: row.queueLength,
          pendingSize: row.pendingSize,
        }),
      ).toBe(row.expected);
    });
  }
});

describe("stale-event scenario: third actor flips while overlay holds prior optimistic value", () => {
  it("drops overlay when our work is fully settled", () => {
    // Actor A flipped plugin.x → grant; the runtime accepted it; our overlay
    // is briefly stale because the refetch hasn't returned yet but the
    // optimistic value matches reality. A third-actor event then arrives
    // (perhaps actor C demoting actor A's role, which mass-changes overrides).
    // shouldDropOverlay returns true: we drop and accept the upcoming refetch.
    const drop = shouldDropOverlay({ inflight: false, queueLength: 0, pendingSize: 1 });
    expect(drop).toBe(true);
  });

  it("keeps overlay when our own mutation hasn't returned yet", () => {
    // Actor A clicked plugin.x; flush() is awaiting a grant() response.
    // A third actor's broadcast arrives. We must hold the overlay so the
    // user keeps seeing their intent until our await resolves.
    const drop = shouldDropOverlay({ inflight: true, queueLength: 0, pendingSize: 1 });
    expect(drop).toBe(false);
  });

  it("keeps overlay when the user is still actively clicking", () => {
    // Actor A is mid-burst of clicks; queue has un-flushed work; pending
    // overlay is non-empty. A third-actor broadcast arrives. The upcoming
    // flush will reconcile, so we hold.
    const drop = shouldDropOverlay({ inflight: false, queueLength: 4, pendingSize: 4 });
    expect(drop).toBe(false);
  });
});
