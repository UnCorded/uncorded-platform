// Co-View viewer-side consumer (spec-27 §Wire Protocol §State sync, PR-CV4
// pen + cursor channels).
//
// Responsibilities:
//   - Apply inbound `co-view.state` frames to the local snapshot via RFC-7396
//     merge-patch. Track `lastSeq` to detect gaps.
//   - On gap detection, send `co-view.snapshot.req` with our last-known seq.
//   - Apply `co-view.cursor` frames to the per-member cursor map.
//   - Apply `pen.*` event frames to the strokes map with TTL eviction and a
//     stuck-stroke watchdog (the realtime transport is intentionally lossy;
//     consumer is the integrity layer — see spec-27 §Failure Modes).
//   - Maintain `memberMeta` (member_id → {name, color}) from
//     co-view.member.{joined,left}. Renderers read color from here, NEVER
//     from event payloads — that's what blocks color-spoofing.
//   - Buffer raw events for the debug panel.
//
// Pure factory — does NOT import from ws.ts. Caller wires `send` and feeds
// inbound frames in via the `apply*` methods.

import { batch, createSignal, type Accessor } from "solid-js";
import type {
  CoViewStateSnapshot,
  WsCoViewCursor,
  WsCoViewEvent,
  WsCoViewMemberJoined,
  WsCoViewMemberLeft,
  WsCoViewSnapshotReq,
  WsCoViewSnapshotRes,
  WsCoViewState,
} from "@uncorded/protocol";

import { applyMergePatch } from "./merge-patch";

const EVENT_BUFFER_CAP = 200;
/** Default per-stroke TTL after `completedAt` before the entry evicts. */
export const STROKE_TTL_MS = 4000;
/** Stuck-stroke watchdog — auto-end strokes that never received their `pen.stroke_end`. */
export const STROKE_STUCK_MS = 5000;
/** Cursor stale eviction — drop cursors that haven't moved this long. */
export const CURSOR_STALE_MS = 30_000;
/** Watchdog tick interval. Cheap — no work when the maps are empty. */
export const CONSUMER_TICK_MS = 1000;

export interface CursorEntry {
  x: number;
  y: number;
  state: WsCoViewCursor["state"];
  ts: number;
  /** Local receive timestamp, for stale eviction. */
  receivedAt: number;
}

export interface StrokePoint {
  x: number;
  y: number;
  p: number;
}

export interface StrokeEntry {
  id: string;
  memberId: string;
  points: StrokePoint[];
  /** Local Date.now() when stroke_end (or watchdog) closed the stroke. null while in-flight. */
  completedAt: number | null;
  /** Local Date.now() of the most recent activity on this stroke. */
  lastActivityTs: number;
}

export interface MemberMeta {
  name?: string;
  color: string;
}

export interface ConsumerDeps {
  sessionId: string;
  send: (msg: WsCoViewSnapshotReq) => void;
  seedSnapshot?: CoViewStateSnapshot | null;
  /** Override clock for tests. */
  now?: () => number;
  /** Override TTLs for tests. */
  strokeTtlMs?: number;
  strokeStuckMs?: number;
  cursorStaleMs?: number;
  /**
   * If false, the watchdog setInterval is not started. Tests drive ticks via
   * `_tick()`. Default true (production).
   */
  startWatchdog?: boolean;
}

export interface BufferedEvent {
  receivedAt: number;
  frame: WsCoViewEvent;
}

export interface CoViewConsumer {
  snapshot: Accessor<CoViewStateSnapshot>;
  lastSeq: Accessor<number>;
  events: Accessor<readonly BufferedEvent[]>;
  awaitingSnapshot: Accessor<boolean>;
  cursors: Accessor<ReadonlyMap<string, CursorEntry>>;
  strokes: Accessor<ReadonlyMap<string, StrokeEntry>>;
  memberMeta: Accessor<ReadonlyMap<string, MemberMeta>>;

  applyStateFrame: (frame: WsCoViewState) => void;
  applyEventFrame: (frame: WsCoViewEvent) => void;
  applySnapshotRes: (frame: WsCoViewSnapshotRes) => void;
  applyCursorFrame: (frame: WsCoViewCursor) => void;
  applyMemberJoined: (frame: WsCoViewMemberJoined) => void;
  applyMemberLeft: (frame: WsCoViewMemberLeft) => void;

  requestSnapshot: () => void;
  /** Test hook — run a single watchdog tick. */
  _tick: () => void;
  dispose: () => void;
}

export function createCoViewConsumer(deps: ConsumerDeps): CoViewConsumer {
  const seed = deps.seedSnapshot ?? {};
  const initial: CoViewStateSnapshot = { ...seed };
  const now = deps.now ?? Date.now;
  const strokeTtlMs = deps.strokeTtlMs ?? STROKE_TTL_MS;
  const strokeStuckMs = deps.strokeStuckMs ?? STROKE_STUCK_MS;
  const cursorStaleMs = deps.cursorStaleMs ?? CURSOR_STALE_MS;

  const [snapshot, setSnapshot] = createSignal<CoViewStateSnapshot>(initial, {
    equals: false,
  });
  const [lastSeq, setLastSeq] = createSignal(-1);
  const [events, setEvents] = createSignal<readonly BufferedEvent[]>([]);
  const [awaitingSnapshot, setAwaitingSnapshot] = createSignal(false);
  const [cursors, setCursors] = createSignal<ReadonlyMap<string, CursorEntry>>(
    new Map(),
    { equals: false },
  );
  const [strokes, setStrokes] = createSignal<ReadonlyMap<string, StrokeEntry>>(
    new Map(),
    { equals: false },
  );
  const [memberMeta, setMemberMeta] = createSignal<ReadonlyMap<string, MemberMeta>>(
    new Map(),
    { equals: false },
  );

  let disposed = false;
  let snapshotRef: CoViewStateSnapshot = initial;
  const cursorRef = new Map<string, CursorEntry>();
  const strokeRef = new Map<string, StrokeEntry>();
  const metaRef = new Map<string, MemberMeta>();

  function commitCursors(): void {
    setCursors(new Map(cursorRef));
  }
  function commitStrokes(): void {
    setStrokes(new Map(strokeRef));
  }
  function commitMeta(): void {
    setMemberMeta(new Map(metaRef));
  }

  function applyStateFrame(frame: WsCoViewState): void {
    if (disposed) return;
    if (frame.session_id !== deps.sessionId) return;
    const seen = lastSeq();
    if (frame.seq <= seen) return;
    if (frame.seq !== seen + 1) {
      requestSnapshotFor(seen);
      return;
    }
    if (frame.full_state !== undefined) {
      snapshotRef = { ...frame.full_state };
    } else {
      applyMergePatch(snapshotRef, frame.diff);
    }
    batch(() => {
      setSnapshot({ ...snapshotRef });
      setLastSeq(frame.seq);
    });
  }

  function applyEventFrame(frame: WsCoViewEvent): void {
    if (disposed) return;
    if (frame.session_id !== deps.sessionId) return;

    setEvents((prev) => {
      const next = prev.length >= EVENT_BUFFER_CAP
        ? prev.slice(prev.length - EVENT_BUFFER_CAP + 1)
        : prev.slice();
      next.push({ receivedAt: now(), frame });
      return next;
    });

    if (frame.kind.startsWith("pen.")) handlePenEvent(frame);
  }

  function handlePenEvent(frame: WsCoViewEvent): void {
    const memberId = typeof frame.member_id === "string" ? frame.member_id : null;
    const payload = frame.payload;
    switch (frame.kind) {
      case "pen.stroke_begin": {
        if (memberId === null) return;
        const sid = typeof payload["stroke_id"] === "string" ? payload["stroke_id"] : null;
        if (sid === null) return;
        // Reused id: replace (don't merge points). Color/anything else from
        // the payload is intentionally ignored — color is rendered from
        // memberMeta[memberId] only.
        strokeRef.set(sid, {
          id: sid,
          memberId,
          points: [],
          completedAt: null,
          lastActivityTs: now(),
        });
        commitStrokes();
        return;
      }
      case "pen.stroke_point": {
        const sid = typeof payload["stroke_id"] === "string" ? payload["stroke_id"] : null;
        if (sid === null) return;
        const incoming = Array.isArray(payload["points"]) ? payload["points"] : [];
        const points: StrokePoint[] = [];
        for (const raw of incoming) {
          if (raw && typeof raw === "object") {
            const r = raw as { x?: unknown; y?: unknown; p?: unknown };
            if (typeof r.x === "number" && typeof r.y === "number") {
              points.push({
                x: r.x,
                y: r.y,
                p: typeof r.p === "number" ? r.p : 0.5,
              });
            }
          }
        }
        if (points.length === 0) return;
        let entry = strokeRef.get(sid);
        if (!entry) {
          // point-before-begin: synthesize a begin so the points still render.
          // Skip if we have no member_id — without it we can't color the stroke
          // and the integrity tier (member identity) is lost.
          if (memberId === null) return;
          entry = {
            id: sid,
            memberId,
            points: [],
            completedAt: null,
            lastActivityTs: now(),
          };
          strokeRef.set(sid, entry);
        }
        // Late points after end are dropped (stroke is sealed).
        if (entry.completedAt !== null) return;
        entry.points.push(...points);
        entry.lastActivityTs = now();
        commitStrokes();
        return;
      }
      case "pen.stroke_end": {
        const sid = typeof payload["stroke_id"] === "string" ? payload["stroke_id"] : null;
        if (sid === null) return;
        const entry = strokeRef.get(sid);
        if (!entry) return; // idempotent: no-op if we never saw the begin
        if (entry.completedAt !== null) return; // idempotent duplicate
        entry.completedAt = now();
        entry.lastActivityTs = entry.completedAt;
        commitStrokes();
        return;
      }
      case "pen.clear": {
        const scope = payload["scope"];
        if (scope === "all") {
          if (strokeRef.size === 0) return;
          strokeRef.clear();
          commitStrokes();
          return;
        }
        if (scope === "mine") {
          if (memberId === null) return;
          let touched = false;
          for (const [sid, entry] of strokeRef) {
            if (entry.memberId === memberId) {
              strokeRef.delete(sid);
              touched = true;
            }
          }
          if (touched) commitStrokes();
          return;
        }
        return;
      }
      default:
        return;
    }
  }

  function applyCursorFrame(frame: WsCoViewCursor): void {
    if (disposed) return;
    if (frame.session_id !== deps.sessionId) return;
    if (typeof frame.member_id !== "string" || frame.member_id.length === 0) {
      // Server didn't stamp identity → not a trusted broadcast; drop.
      return;
    }
    cursorRef.set(frame.member_id, {
      x: frame.x,
      y: frame.y,
      state: frame.state,
      ts: frame.ts,
      receivedAt: now(),
    });
    commitCursors();
  }

  function applyMemberJoined(frame: WsCoViewMemberJoined): void {
    if (disposed) return;
    if (frame.session_id !== deps.sessionId) return;
    // Prefer member_id (PR-CV4+), fall back to user_id for forward-compat
    // with PR-CV2/CV3 broadcasts that didn't carry member_id.
    const key = frame.member_id ?? frame.user_id;
    metaRef.set(key, { color: frame.color });
    commitMeta();
  }

  function applyMemberLeft(frame: WsCoViewMemberLeft): void {
    if (disposed) return;
    if (frame.session_id !== deps.sessionId) return;
    const key = frame.member_id ?? frame.user_id;
    let touched = false;
    if (metaRef.delete(key)) touched = true;
    if (cursorRef.delete(key)) commitCursors();
    let strokesTouched = false;
    for (const [sid, entry] of strokeRef) {
      if (entry.memberId === key) {
        strokeRef.delete(sid);
        strokesTouched = true;
      }
    }
    if (strokesTouched) commitStrokes();
    if (touched) commitMeta();
  }

  function applySnapshotRes(frame: WsCoViewSnapshotRes): void {
    if (disposed) return;
    if (frame.session_id !== deps.sessionId) return;
    if (frame.full_state !== undefined) {
      snapshotRef = { ...frame.full_state };
      batch(() => {
        setSnapshot({ ...snapshotRef });
        setLastSeq(frame.seq);
        setAwaitingSnapshot(false);
      });
      return;
    }
    if (frame.diffs !== undefined) {
      let highest = lastSeq();
      for (const inner of frame.diffs) {
        if (inner.seq <= highest) continue;
        if (inner.full_state !== undefined) {
          snapshotRef = { ...inner.full_state };
        } else {
          applyMergePatch(snapshotRef, inner.diff);
        }
        highest = inner.seq;
      }
      batch(() => {
        setSnapshot({ ...snapshotRef });
        setLastSeq(highest);
        setAwaitingSnapshot(false);
      });
      return;
    }
  }

  function requestSnapshotFor(sinceSeq: number): void {
    if (awaitingSnapshot()) return;
    setAwaitingSnapshot(true);
    deps.send({
      type: "co-view.snapshot.req",
      session_id: deps.sessionId,
      since_seq: sinceSeq,
    });
  }

  function requestSnapshot(): void {
    if (disposed) return;
    requestSnapshotFor(lastSeq());
  }

  function tick(): void {
    if (disposed) return;
    const t = now();
    let strokesTouched = false;

    // 1) Stuck-stroke watchdog: in-flight strokes with no activity for
    // strokeStuckMs are auto-completed so TTL can evict them.
    for (const entry of strokeRef.values()) {
      if (entry.completedAt === null && t - entry.lastActivityTs >= strokeStuckMs) {
        entry.completedAt = t;
        strokesTouched = true;
      }
    }

    // 2) TTL eviction: completed strokes past completedAt + ttlMs.
    for (const [sid, entry] of strokeRef) {
      if (entry.completedAt !== null && t - entry.completedAt >= strokeTtlMs) {
        strokeRef.delete(sid);
        strokesTouched = true;
      }
    }
    if (strokesTouched) commitStrokes();

    // 3) Cursor stale eviction.
    let cursorsTouched = false;
    for (const [mid, entry] of cursorRef) {
      if (t - entry.receivedAt >= cursorStaleMs) {
        cursorRef.delete(mid);
        cursorsTouched = true;
      }
    }
    if (cursorsTouched) commitCursors();
  }

  let watchdog: ReturnType<typeof setInterval> | undefined;
  if (deps.startWatchdog !== false && typeof setInterval === "function") {
    watchdog = setInterval(tick, CONSUMER_TICK_MS);
  }

  function dispose(): void {
    disposed = true;
    if (watchdog !== undefined) {
      clearInterval(watchdog);
      watchdog = undefined;
    }
  }

  return {
    snapshot,
    lastSeq,
    events,
    awaitingSnapshot,
    cursors,
    strokes,
    memberMeta,
    applyStateFrame,
    applyEventFrame,
    applySnapshotRes,
    applyCursorFrame,
    applyMemberJoined,
    applyMemberLeft,
    requestSnapshot,
    _tick: tick,
    dispose,
  };
}
