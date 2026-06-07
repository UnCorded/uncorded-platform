// Active-sessions-store reducer tests — spec-27 §Roster Push Semantics.
//
// We test the pure `reduceListFrame` reducer in isolation rather than the full
// store, because the store's WS subscription requires a real connection and
// the reducer is where the interesting behavior lives.

import { describe, expect, test } from "bun:test";
import type { CoViewSessionSummary } from "@uncorded/protocol";

import { reduceListFrame } from "./active-sessions-store";
import type { CoViewListChangeFrame } from "./client";

function summary(id: string, startedAt: number, paused = false): CoViewSessionSummary {
  return {
    session_id: id,
    server_id: "srv",
    host_user_id: `user-${id}`,
    host_session_id: `ws-${id}`,
    host_display_name: `Host ${id}`,
    visibility: "public",
    render_mode: "as-viewer",
    started_at: startedAt,
    viewer_count: 0,
    paused,
  };
}

function added(s: CoViewSessionSummary): CoViewListChangeFrame {
  return {
    type: "co-view.list.changed",
    server_id: "srv",
    change: "added",
    session_id: s.session_id,
    session: s,
  };
}

function updated(s: CoViewSessionSummary): CoViewListChangeFrame {
  return {
    type: "co-view.list.changed",
    server_id: "srv",
    change: "updated",
    session_id: s.session_id,
    session: s,
  };
}

function removed(id: string): CoViewListChangeFrame {
  return {
    type: "co-view.list.changed",
    server_id: "srv",
    change: "removed",
    session_id: id,
  };
}

describe("reduceListFrame", () => {
  test("added appends and sorts by started_at ascending", () => {
    let state: CoViewSessionSummary[] = [];
    state = reduceListFrame(state, added(summary("B", 200)));
    state = reduceListFrame(state, added(summary("A", 100)));
    state = reduceListFrame(state, added(summary("C", 300)));
    expect(state.map((s) => s.session_id)).toEqual(["A", "B", "C"]);
  });

  test("updated replaces in place by session_id and re-sorts", () => {
    let state: CoViewSessionSummary[] = [
      summary("A", 100),
      summary("B", 200),
    ];
    state = reduceListFrame(state, updated(summary("A", 100, true)));
    expect(state).toHaveLength(2);
    const a = state.find((s) => s.session_id === "A")!;
    expect(a.paused).toBe(true);
  });

  test("removed deletes the matching id", () => {
    let state: CoViewSessionSummary[] = [
      summary("A", 100),
      summary("B", 200),
    ];
    state = reduceListFrame(state, removed("A"));
    expect(state.map((s) => s.session_id)).toEqual(["B"]);
  });

  test("removed for an unknown id is a no-op (returns same reference)", () => {
    const state: CoViewSessionSummary[] = [summary("A", 100)];
    const next = reduceListFrame(state, removed("ghost"));
    expect(next).toBe(state);
  });

  test("updated for an unknown id is treated as added", () => {
    // Per spec: this covers a visibility-upgrade race where a snapshot raced
    // a perm change and the store missed the original `added`.
    let state: CoViewSessionSummary[] = [summary("A", 100)];
    state = reduceListFrame(state, updated(summary("Z", 50)));
    expect(state.map((s) => s.session_id)).toEqual(["Z", "A"]);
  });

  test("added/updated without a session payload is a no-op (defensive)", () => {
    const state: CoViewSessionSummary[] = [summary("A", 100)];
    const malformed: CoViewListChangeFrame = {
      type: "co-view.list.changed",
      server_id: "srv",
      change: "added",
      session_id: "B",
      // session intentionally omitted to model a wire bug
    };
    const next = reduceListFrame(state, malformed);
    expect(next).toBe(state);
  });
});
