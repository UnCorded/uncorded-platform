// Producer-side snapshot ring buffer (spec-27 §State sync).
//
// The host keeps the last N safe state frames so a viewer's `co-view.snapshot.req`
// can be answered with a slice of diffs instead of the full state. If the
// requested `since_seq` is older than the oldest entry, the producer responds
// with `full_state` — the runtime side strips and forwards either way.
//
// Capacity is a constant (64) per spec-27 §Bounds. At 30Hz coalesce, that's
// ~2 seconds of history — plenty for a viewer that briefly drops one frame on
// transient WS hiccups; longer gaps fall through to full_state which is the
// correct behavior.

import type {
  CoViewStateDiff,
  CoViewStateSnapshot,
} from "@uncorded/protocol";

export const RING_BUFFER_CAPACITY = 64;

export interface RingBufferEntry {
  seq: number;
  replay: "safe" | "unsafe";
  diff: CoViewStateDiff;
}

export interface SnapshotResponse {
  /** When non-empty, send these in order — viewer applies sequentially. */
  diffs: { seq: number; diff: CoViewStateDiff }[] | null;
  /** When set, send this and forget diffs — viewer replaces snapshot wholesale. */
  fullState: { seq: number; state: CoViewStateSnapshot } | null;
}

export class CoViewRingBuffer {
  private entries: RingBufferEntry[] = [];

  push(entry: RingBufferEntry): void {
    this.entries.push(entry);
    if (this.entries.length > RING_BUFFER_CAPACITY) {
      this.entries.shift();
    }
  }

  /**
   * Build a snapshot response for a viewer. `sinceSeq === -1` means "I have
   * nothing" — always served from the cumulative snapshot.
   */
  resolve(
    sinceSeq: number,
    cumulativeSnapshot: CoViewStateSnapshot,
    currentSeq: number,
  ): SnapshotResponse {
    if (sinceSeq < 0 || this.entries.length === 0) {
      return {
        diffs: null,
        fullState: { seq: currentSeq, state: { ...cumulativeSnapshot } },
      };
    }
    const oldestSeq = this.entries[0]!.seq;
    if (sinceSeq + 1 < oldestSeq) {
      return {
        diffs: null,
        fullState: { seq: currentSeq, state: { ...cumulativeSnapshot } },
      };
    }
    const slice: { seq: number; diff: CoViewStateDiff }[] = [];
    for (const e of this.entries) {
      if (e.seq <= sinceSeq) continue;
      if (e.replay !== "safe") continue;
      slice.push({ seq: e.seq, diff: e.diff });
    }
    return { diffs: slice, fullState: null };
  }

  clear(): void {
    this.entries = [];
  }

  size(): number {
    return this.entries.length;
  }
}
