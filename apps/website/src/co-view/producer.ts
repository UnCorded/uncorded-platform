// Co-View host-side producer (spec-27 §Wire Protocol §State sync).
//
// Responsibilities:
//   - Watch a `getShellState()` accessor and emit `co-view.state` whenever it
//     changes, coalescing back-to-back updates within one tick into a single
//     diff frame.
//   - Maintain the cumulative safe-state snapshot the runtime mirrors for
//     join.ack — the producer is the source of truth; the runtime only sees
//     diffs flowing past.
//   - Feed every safe frame into the ring buffer so `co-view.snapshot.req`
//     from a viewer can be answered with a slice of diffs (or full_state when
//     the request is older than the buffer).
//   - Emit nav.* `co-view.event` frames for route + panel mount/unmount.
//     Per spec these are `replay: "unsafe"` — they describe transitions, not
//     terminal state, so a viewer that joins after the transition shouldn't
//     replay them.
//
// The producer is a plain factory — it accepts a `send(msg)` callback and a
// `getShellState()` accessor. It does NOT import from ws.ts, so the
// implementation is testable without a live socket.

import type {
  CoViewEventKind,
  CoViewStateSnapshot,
  WsCoViewEvent,
  WsCoViewSnapshotReq,
  WsCoViewSnapshotRes,
  WsCoViewState,
} from "@uncorded/protocol";

import { diffMergePatch } from "./merge-patch";
import { CoViewRingBuffer } from "./ring-buffer";
import { CO_VIEW_SHELL_STATE_KEYS, type CoViewShellState } from "./state-schema";

export interface ProducerDeps {
  sessionId: string;
  /** Send a frame upstream. Producer assumes the caller routes by sessionId. */
  send: (msg: WsCoViewState | WsCoViewEvent | WsCoViewSnapshotRes) => void;
  /** Read the current shell state. Called from a microtask after each notify(). */
  getShellState: () => CoViewShellState;
  /** Override the clock for tests. */
  now?: () => number;
  /**
   * Override the coalesce schedule. Defaults to `queueMicrotask` so multiple
   * synchronous changes within the same Solid tick collapse to one frame; tests
   * pass an explicit scheduler to make the timing deterministic.
   */
  schedule?: (run: () => void) => void;
}

export interface CoViewProducer {
  /** Mark state dirty — schedule a coalesced flush of the next diff. */
  notify: () => void;
  /** Emit a discrete `co-view.event` frame (replay defaults to "unsafe"). */
  emitEvent: <K extends CoViewEventKind>(
    kind: K,
    payload: Record<string, unknown>,
    replay?: "safe" | "unsafe",
  ) => void;
  /** Handle an incoming `co-view.snapshot.req` from the runtime. */
  handleSnapshotReq: (req: WsCoViewSnapshotReq) => void;
  /** Tear down internal state. Pending coalesce flushes become no-ops. */
  dispose: () => void;
  /** Test hook — current cumulative snapshot. */
  _snapshot: () => CoViewStateSnapshot;
  /** Test hook — current monotonic seq. -1 means no frame sent yet. */
  _seq: () => number;
}

export function createCoViewProducer(deps: ProducerDeps): CoViewProducer {
  const now = deps.now ?? Date.now;
  const schedule = deps.schedule ?? queueMicrotask;
  const ring = new CoViewRingBuffer();

  let snapshot: CoViewStateSnapshot = {};
  let seq = -1;
  let dirty = false;
  let scheduled = false;
  let disposed = false;

  function flush(): void {
    scheduled = false;
    if (disposed || !dirty) return;
    dirty = false;
    const next = sanitize(deps.getShellState());
    const diff = diffMergePatch(snapshot, next);
    if (diff === null) return; // no changes — don't bump seq

    seq += 1;
    snapshot = next;
    const frame: WsCoViewState = {
      type: "co-view.state",
      session_id: deps.sessionId,
      seq,
      diff,
      replay: "safe",
      ts: now(),
    };
    ring.push({ seq, replay: "safe", diff });
    deps.send(frame);
  }

  function notify(): void {
    dirty = true;
    if (scheduled || disposed) return;
    scheduled = true;
    schedule(flush);
  }

  function emitEvent<K extends CoViewEventKind>(
    kind: K,
    payload: Record<string, unknown>,
    replay: "safe" | "unsafe" = "unsafe",
  ): void {
    if (disposed) return;
    const frame: WsCoViewEvent = {
      type: "co-view.event",
      session_id: deps.sessionId,
      kind,
      payload,
      replay,
      ts: now(),
    };
    deps.send(frame);
  }

  function handleSnapshotReq(req: WsCoViewSnapshotReq): void {
    if (disposed) return;
    if (req.session_id !== deps.sessionId) return;
    if (typeof req.member_id !== "string" || req.member_id.length === 0) return;
    const resolved = ring.resolve(req.since_seq, snapshot, seq);
    const baseRes: WsCoViewSnapshotRes = {
      type: "co-view.snapshot.res",
      session_id: deps.sessionId,
      member_id: req.member_id,
      seq,
    };
    if (resolved.fullState !== null) {
      const res: WsCoViewSnapshotRes = {
        ...baseRes,
        seq: resolved.fullState.seq,
        full_state: { ...resolved.fullState.state },
      };
      deps.send(res);
      return;
    }
    if (resolved.diffs !== null) {
      const res: WsCoViewSnapshotRes = {
        ...baseRes,
        diffs: resolved.diffs.map<WsCoViewState>((entry) => ({
          type: "co-view.state",
          session_id: deps.sessionId,
          seq: entry.seq,
          diff: entry.diff,
          replay: "safe",
          ts: now(),
        })),
      };
      deps.send(res);
    }
  }

  function dispose(): void {
    disposed = true;
    ring.clear();
  }

  return {
    notify,
    emitEvent,
    handleSnapshotReq,
    dispose,
    _snapshot: () => snapshot,
    _seq: () => seq,
  };
}

const ALLOWED_KEYS = new Set<string>(CO_VIEW_SHELL_STATE_KEYS);

/**
 * Defensive copy + JSON-roundtrip-safe normalization. Strips undefined keys
 * (RFC 7396 has no tombstone for "unset" — the producer never emits a key it
 * doesn't want set), enforces the closed allowlist (spec §The Shell-State
 * Boundary), and clones nested objects so later host mutations of the
 * original tree don't retroactively rewrite the producer's last snapshot.
 */
function sanitize(state: CoViewShellState): CoViewStateSnapshot {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(state)) {
    if (v === undefined) continue;
    if (!ALLOWED_KEYS.has(k)) {
      // eslint-disable-next-line no-console
      console.warn("[co-view] producer dropped non-allowlisted shell-state key", { key: k });
      continue;
    }
    out[k] = clone(v);
  }
  return out;
}

function clone<T>(v: T): T {
  if (v === null) return v;
  if (typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(clone) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const [k, vv] of Object.entries(v as Record<string, unknown>)) {
    if (vv === undefined) continue;
    out[k] = clone(vv);
  }
  return out as T;
}
