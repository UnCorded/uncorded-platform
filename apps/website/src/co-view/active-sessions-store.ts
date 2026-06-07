// Reactive Solid store backing the Co-View sheet's active-sessions roster.
//
// One store per `serverId`. Internally calls `observeCoViewList(serverId, ...)`
// from client.ts, which: (1) issues a snapshot `list.req`, (2) replays each
// session in the snapshot via `change="added"`, then (3) forwards subsequent
// `co-view.list.changed` push frames. The store collapses those deltas into
// a flat reactive array consumed by the sheet UI.
//
// Spec-27 contract: the runtime sends `removed` only to subscribers whose
// per-subscriber visible-set previously included the session — so an
// `updated` for an unknown id is an indication of an upgrade race (the
// snapshot raced a visibility change), not a wire bug. Treat such frames as
// `added`. `removed` for an unknown id is a no-op (could happen on race
// during a replace-snapshot from a re-issued list.req).

import { createMemo, createSignal, type Accessor } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import type { CoViewSessionSummary } from "@uncorded/protocol";

import { observeCoViewList, type CoViewListChangeFrame } from "./client";

/**
 * Pure reducer over the sorted-roster array. Returns the same array reference
 * when the frame is a no-op so callers can short-circuit reconciliation.
 *
 * Per spec-27 §Roster Push Semantics:
 *   - `removed` for an unknown id → no-op (race after replace-snapshot).
 *   - `added` / `updated` MUST carry `session`; missing payload → warn + no-op.
 *   - `updated` for an unknown id → treat as `added` (visibility upgrade race).
 */
export function reduceListFrame(
  prev: CoViewSessionSummary[],
  frame: CoViewListChangeFrame,
): CoViewSessionSummary[] {
  const idx = prev.findIndex((s) => s.session_id === frame.session_id);
  if (frame.change === "removed") {
    if (idx < 0) return prev;
    const next = prev.slice();
    next.splice(idx, 1);
    return next;
  }
  if (frame.session === undefined) {
    console.warn("[co-view] list.changed missing session payload", frame);
    return prev;
  }
  const next = prev.slice();
  if (idx >= 0) next[idx] = frame.session;
  else next.push(frame.session);
  next.sort((a, b) => a.started_at - b.started_at);
  return next;
}

export interface ActiveSessionsStore {
  /** Accessor over the live roster, sorted by `started_at` ascending. */
  sessions: Accessor<CoViewSessionSummary[]>;
  /** True once the initial snapshot has resolved (success OR failure). */
  ready: Accessor<boolean>;
  /** Tear down the underlying subscription. */
  dispose: () => void;
}

export function createActiveSessionsStore(serverId: string): ActiveSessionsStore {
  const [sessions, setSessions] = createStore<{ items: CoViewSessionSummary[] }>({ items: [] });
  const [ready, setReady] = createSignal(false);

  const unsub = observeCoViewList(serverId, (frame: CoViewListChangeFrame) => {
    // First frame from the snapshot replay marks the store as ready. We
    // can't distinguish "snapshot done" from "first delta after snapshot"
    // on a single observer, but the UI just needs to know it has a real
    // baseline; once we've processed any frame, hide the loading skeleton.
    if (!ready()) setReady(true);
    applyFrame(frame);
  });

  // Failure-mode safety: if the snapshot listener never fires (Central down,
  // ws closed before snapshot returned, etc.), flip `ready` after a budget
  // so the empty state shows instead of an indefinite skeleton.
  const readyTimer = setTimeout(() => {
    if (!ready()) setReady(true);
  }, 5_000);

  function applyFrame(frame: CoViewListChangeFrame): void {
    const next = reduceListFrame(sessions.items, frame);
    if (next === sessions.items) return;
    setSessions("items", reconcile(next, { key: "session_id" }));
  }

  const sessionsAccessor = createMemo(() => sessions.items);

  return {
    sessions: sessionsAccessor,
    ready,
    dispose: () => {
      clearTimeout(readyTimer);
      unsub();
    },
  };
}
