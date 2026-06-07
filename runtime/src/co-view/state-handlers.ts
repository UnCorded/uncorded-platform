// State-channel handlers for Co-View Sessions (spec-27 §Wire Protocol, PR-CV2).
//
// Producer-side coalesce + ring buffer live in the host's browser; the
// runtime's job here is to:
//   - Authenticate host-only producers (state, event) and member-only callers
//     (snapshot.req, snapshot.res).
//   - Track per-session `lastSeq` for monotonicity (regressions are dropped +
//     logged, not nak'd — duplicates after reconnect are routine).
//   - Enforce 16 KB diff cap on `co-view.state` and 4 KB payload cap on
//     `co-view.event` (spec §Bounds and Limits). Over-budget frames are
//     dropped with a structured warn; the host's SDK surfaces the rejection
//     locally via its own size check before send.
//   - Fold `replay: "safe"` frames into `session.safeStateSnapshot` via
//     RFC-7396 merge-patch so `join.ack.current_state_snapshot` can serve
//     mid-session joiners without a round trip.
//   - Forward state + event frames to all session members except the host.
//   - Route `snapshot.req` to the host with the requester's connection id
//     stamped into `member_id`; route `snapshot.res` back to the addressed
//     viewer using that same `member_id`.
//
// Spec-27 §Audit Log says audit is metadata-only — handlers here NEVER log
// the diff body, full_state, or event payload.

import type {
  WsCoViewCursor,
  WsCoViewEvent,
  WsCoViewSnapshotReq,
  WsCoViewSnapshotRes,
  WsCoViewState,
} from "@uncorded/protocol";

import { applyMergePatch } from "./merge-patch";
import type { CoViewContext } from "./handlers";
import { CO_VIEW_LIMITS } from "./types";
import type { CoViewSessionInternal } from "./types";

// ---------------------------------------------------------------------------
// co-view.state
// ---------------------------------------------------------------------------

export function handleState(
  ctx: CoViewContext,
  msg: WsCoViewState,
  connectionId: string,
): void {
  const session = ctx.registry.get(msg.session_id);
  if (!session) {
    // Frame for an unknown session — drop silently. The host's SDK should
    // have torn down its producer before this could happen; if it didn't,
    // the next end/leave will surface the inconsistency.
    return;
  }

  if (session.hostSessionId !== connectionId) {
    ctx.log.warn("co-view: non-host emitted state frame", {
      sessionId: session.id,
      connectionId,
      seq: msg.seq,
    });
    return;
  }

  // PR-CV5 pause gate: while the host has paused the session, drop inbound
  // state diffs at the runtime instead of trusting the host producer to
  // honor its own flag. A buggy or stale host client could otherwise keep
  // streaming. Control frames (`update`, `end`) flow through their own
  // handlers and are intentionally NEVER pause-gated.
  if (session.paused) {
    ctx.log.warn("co-view: state frame from paused host — dropped", {
      sessionId: session.id,
      seq: msg.seq,
    });
    return;
  }

  if (!Number.isInteger(msg.seq) || msg.seq < 0) {
    ctx.log.warn("co-view: state frame rejected — seq must be non-negative integer", {
      sessionId: session.id,
      seq: msg.seq,
    });
    return;
  }

  if (msg.seq <= session.lastSeq) {
    // Regression / duplicate — drop. A returning host after a brief
    // disconnect may legitimately resume with a seq earlier than its peak
    // (it doesn't know which frames the runtime got); the producer is
    // expected to re-seed from `lastSeq + 1`. We log so operators can spot
    // a misbehaving producer.
    ctx.log.warn("co-view: state frame seq regression — dropped", {
      sessionId: session.id,
      seq: msg.seq,
      lastSeq: session.lastSeq,
    });
    return;
  }

  const sizeBytes = approxJsonSize(msg.full_state !== undefined ? msg.full_state : msg.diff);
  if (sizeBytes > CO_VIEW_LIMITS.STATE_DIFF_BYTES_MAX) {
    ctx.log.warn("co-view: state frame rejected — exceeds size cap", {
      sessionId: session.id,
      seq: msg.seq,
      sizeBytes,
      capBytes: CO_VIEW_LIMITS.STATE_DIFF_BYTES_MAX,
    });
    return;
  }

  if (msg.replay !== "safe" && msg.replay !== "unsafe") {
    ctx.log.warn("co-view: state frame rejected — invalid replay tag", {
      sessionId: session.id,
      seq: msg.seq,
    });
    return;
  }

  // Fold safe frames into the cached snapshot. `full_state` replaces the
  // snapshot wholesale; otherwise merge-patch the diff. Unsafe frames never
  // touch the cache — that's the entire point of the replay tag.
  if (msg.replay === "safe") {
    if (msg.full_state !== undefined) {
      session.safeStateSnapshot = { ...msg.full_state };
    } else {
      applyMergePatch(session.safeStateSnapshot, msg.diff);
    }
  }

  session.lastSeq = msg.seq;

  broadcastToViewers(ctx, session, msg);
}

// ---------------------------------------------------------------------------
// co-view.event — branches on kind: pen.* allows any member with per-kind
// rate-limit policy; everything else stays host-only (PR-CV2 nav.* surface).
// ---------------------------------------------------------------------------

export function handleEvent(
  ctx: CoViewContext,
  msg: WsCoViewEvent,
  connectionId: string,
): void {
  const session = ctx.registry.get(msg.session_id);
  if (!session) return;

  if (msg.replay !== "safe" && msg.replay !== "unsafe") {
    ctx.log.warn("co-view: event frame rejected — invalid replay tag", {
      sessionId: session.id,
      kind: msg.kind,
    });
    return;
  }

  const sizeBytes = approxJsonSize(msg.payload);
  if (sizeBytes > CO_VIEW_LIMITS.EVENT_PAYLOAD_BYTES_MAX) {
    ctx.log.warn("co-view: event frame rejected — exceeds size cap", {
      sessionId: session.id,
      kind: msg.kind,
      sizeBytes,
      capBytes: CO_VIEW_LIMITS.EVENT_PAYLOAD_BYTES_MAX,
    });
    return;
  }

  if (msg.kind.startsWith("pen.")) {
    handlePenEvent(ctx, session, msg, connectionId);
    return;
  }

  // Non-pen events stay host-only — these are the auto-instrumented nav.*
  // and host.action_observed frames published by the shell.
  if (session.hostSessionId !== connectionId) {
    ctx.log.warn("co-view: non-host emitted event frame", {
      sessionId: session.id,
      connectionId,
      kind: msg.kind,
    });
    return;
  }

  // PR-CV5 pause gate: drop host-emitted nav/host.action_observed frames
  // while paused. Pen events from viewers fall through `handlePenEvent`
  // above; that path independently tolerates pause (viewers can still
  // annotate the frozen surface).
  if (session.paused) {
    ctx.log.warn("co-view: event frame from paused host — dropped", {
      sessionId: session.id,
      kind: msg.kind,
    });
    return;
  }

  // Host-emitted nav events keep their inbound shape (no member_id is needed
  // for routing — viewers know all nav events come from the host).
  broadcastToViewers(ctx, session, stripMemberId(msg));
}

// ---------------------------------------------------------------------------
// pen.* — per-kind authorization + rate-limit policy
//
// Critical invariants:
//  - `pen.stroke_end` and `pen.clear` MUST NEVER be silently dropped by rate
//    limiting. Dropping a terminal/clear frame leaves viewers stuck with
//    permanently in-flight strokes, breaking the TTL eviction promise.
//  - Color is server-derived from `member_id → membership color` on the
//    consumer. Any client-supplied `color` field is dropped here (we don't
//    explicitly strip it because we forward `payload` as-is, but the consumer
//    is required to ignore it — see WsCoViewEvent JSDoc).
//  - Client-supplied `member_id` on the inbound is overwritten by the server.
// ---------------------------------------------------------------------------

function handlePenEvent(
  ctx: CoViewContext,
  session: CoViewSessionInternal,
  msg: WsCoViewEvent,
  connectionId: string,
): void {
  const member = session.members.get(connectionId);
  if (!member) {
    ctx.log.warn("co-view: pen event from non-member dropped", {
      sessionId: session.id,
      connectionId,
      kind: msg.kind,
    });
    return;
  }

  // PR-CV5 pause gate (host only). While paused, the host's own pen strokes
  // are dropped so the surface viewers see truly stays frozen. Viewers can
  // still annotate (member.role === "viewer" passes through).
  if (session.paused && member.role === "host") {
    ctx.log.warn("co-view: pen event from paused host — dropped", {
      sessionId: session.id,
      kind: msg.kind,
    });
    return;
  }

  const now = ctx.now();

  switch (msg.kind) {
    case "pen.stroke_begin": {
      const last = session.rateLimits.penBegin.get(connectionId) ?? 0;
      if (now - last < 1000 / CO_VIEW_LIMITS.PEN_BEGIN_RATE_HZ) {
        // Anti-spam: silently drop. Excess begin frames mean the user can't
        // start strokes faster than the cap; no terminal-frame consequence.
        return;
      }
      session.rateLimits.penBegin.set(connectionId, now);
      break;
    }
    case "pen.stroke_point": {
      const last = session.rateLimits.penPoint.get(connectionId) ?? 0;
      if (now - last < 1000 / CO_VIEW_LIMITS.PEN_POINT_RATE_HZ) {
        // Points are coalescable visual data — dropping is fine, the next
        // accepted frame paints the visible state.
        return;
      }
      session.rateLimits.penPoint.set(connectionId, now);
      break;
    }
    case "pen.stroke_end": {
      // NEVER rate-limited. Terminal frames must always pass.
      break;
    }
    case "pen.clear": {
      const scope = String(msg.payload["scope"] ?? "");
      if (scope !== "mine" && scope !== "all") {
        ctx.log.warn("co-view: pen.clear rejected — invalid scope", {
          sessionId: session.id,
          connectionId,
          scope,
        });
        return;
      }
      if (scope === "all" && session.hostSessionId !== connectionId) {
        ctx.log.warn("co-view: pen.clear scope:all rejected — not host", {
          sessionId: session.id,
          connectionId,
        });
        return;
      }
      // Duplicate-coalesce: a second clear with the same (member, scope)
      // inside the window is dropped. One clear is idempotent and equivalent
      // to many — this denies broadcast amplification without losing
      // correctness. Per-(member, scope) key so member A's "mine" doesn't
      // block member B's "mine" in the same tick.
      const key = `${connectionId}|${scope}`;
      const lastClear = session.lastClearTs.get(key) ?? 0;
      if (now - lastClear < CO_VIEW_LIMITS.PEN_CLEAR_COALESCE_MS) {
        return;
      }
      session.lastClearTs.set(key, now);
      break;
    }
    default: {
      ctx.log.warn("co-view: unknown pen.* kind dropped", {
        sessionId: session.id,
        kind: msg.kind,
      });
      return;
    }
  }

  // Stamp member_id and broadcast. Excludes the original sender so they
  // don't see their own pen echo (their producer already painted locally).
  const stamped: WsCoViewEvent = {
    type: "co-view.event",
    session_id: session.id,
    kind: msg.kind,
    payload: msg.payload,
    replay: msg.replay,
    ts: msg.ts,
    member_id: connectionId,
  };
  broadcastToOtherMembers(ctx, session, stamped, connectionId);
}

// ---------------------------------------------------------------------------
// co-view.cursor — per-member, ≤30 Hz, drop-on-backpressure
// ---------------------------------------------------------------------------

export function handleCursor(
  ctx: CoViewContext,
  msg: WsCoViewCursor,
  connectionId: string,
): void {
  const session = ctx.registry.get(msg.session_id);
  if (!session) return;

  const member = session.members.get(connectionId);
  if (!member) {
    ctx.log.warn("co-view: cursor frame from non-member dropped", {
      sessionId: session.id,
      connectionId,
    });
    return;
  }

  // PR-CV5 pause gate (host only). Same reasoning as host pen above —
  // viewer cursors still pass so co-presence indication survives a pause.
  if (session.paused && member.role === "host") {
    return;
  }

  if (
    typeof msg.x !== "number" ||
    typeof msg.y !== "number" ||
    !Number.isFinite(msg.x) ||
    !Number.isFinite(msg.y)
  ) {
    ctx.log.warn("co-view: cursor frame rejected — invalid coordinates", {
      sessionId: session.id,
      connectionId,
    });
    return;
  }

  const now = ctx.now();

  // Coalesce identical (x, y, state) within the coalesce window. Distinct
  // from the rate limit because content-based: a stationary pointer doesn't
  // need re-broadcasting just because the time budget reset.
  const last = session.cursors.get(connectionId);
  if (
    last !== undefined &&
    last.x === msg.x &&
    last.y === msg.y &&
    last.state === msg.state &&
    now - last.ts < CO_VIEW_LIMITS.CURSOR_COALESCE_MS
  ) {
    return;
  }

  // Time-based rate limit — even if content changes faster than the cap, we
  // don't broadcast more than CURSOR_RATE_HZ Hz per member. Cursor frames
  // are safe to drop (visual continuity only).
  const lastAccepted = session.rateLimits.cursor.get(connectionId) ?? 0;
  if (now - lastAccepted < 1000 / CO_VIEW_LIMITS.CURSOR_RATE_HZ) {
    return;
  }
  session.rateLimits.cursor.set(connectionId, now);

  session.cursors.set(connectionId, {
    x: msg.x,
    y: msg.y,
    state: msg.state,
    ts: msg.ts,
  });

  const stamped: WsCoViewCursor = {
    type: "co-view.cursor",
    session_id: session.id,
    member_id: connectionId,
    x: msg.x,
    y: msg.y,
    state: msg.state,
    ts: msg.ts,
  };
  broadcastToOtherMembers(ctx, session, stamped, connectionId);
}

// ---------------------------------------------------------------------------
// co-view.snapshot.req — viewer → server → host
// ---------------------------------------------------------------------------

export function handleSnapshotReq(
  ctx: CoViewContext,
  msg: WsCoViewSnapshotReq,
  connectionId: string,
): void {
  const session = ctx.registry.get(msg.session_id);
  if (!session) return;

  // The caller must be a member (viewer OR host). The host asking themselves
  // for a snapshot is nonsensical but harmless to forward.
  const member = session.members.get(connectionId);
  if (!member) {
    ctx.log.warn("co-view: snapshot.req from non-member dropped", {
      sessionId: session.id,
      connectionId,
    });
    return;
  }

  if (!Number.isInteger(msg.since_seq) || msg.since_seq < -1) {
    ctx.log.warn("co-view: snapshot.req invalid since_seq", {
      sessionId: session.id,
      sinceSeq: msg.since_seq,
    });
    return;
  }

  // Stamp the requester's connection id and forward to the host. The host's
  // browser owns the ring buffer and decides between sending `diffs` vs
  // `full_state` in the response.
  const forwarded: WsCoViewSnapshotReq = {
    type: "co-view.snapshot.req",
    session_id: session.id,
    since_seq: msg.since_seq,
    member_id: connectionId,
  };
  ctx.deps.sendToConnection(session.hostSessionId, forwarded);
}

// ---------------------------------------------------------------------------
// co-view.snapshot.res — host → server → viewer
// ---------------------------------------------------------------------------

export function handleSnapshotRes(
  ctx: CoViewContext,
  msg: WsCoViewSnapshotRes,
  connectionId: string,
): void {
  const session = ctx.registry.get(msg.session_id);
  if (!session) return;

  if (session.hostSessionId !== connectionId) {
    ctx.log.warn("co-view: non-host emitted snapshot.res", {
      sessionId: session.id,
      connectionId,
    });
    return;
  }

  if (typeof msg.member_id !== "string" || msg.member_id.length === 0) {
    ctx.log.warn("co-view: snapshot.res missing member_id — dropped", {
      sessionId: session.id,
    });
    return;
  }

  if (msg.diffs === undefined && msg.full_state === undefined) {
    ctx.log.warn("co-view: snapshot.res must carry diffs OR full_state — dropped", {
      sessionId: session.id,
      memberId: msg.member_id,
    });
    return;
  }

  // The addressed viewer must still be in the session — if they left
  // between req and res, drop quietly. We don't broadcast to other viewers
  // because the snapshot was targeted.
  const target = session.members.get(msg.member_id);
  if (!target) {
    ctx.log.info("co-view: snapshot.res target no longer in session — dropped", {
      sessionId: session.id,
      memberId: msg.member_id,
    });
    return;
  }

  // Strip member_id on the outbound viewer hop — viewers don't need it and
  // its presence on viewer→viewer frames would be a small information leak.
  const forwarded: WsCoViewSnapshotRes = {
    type: "co-view.snapshot.res",
    session_id: session.id,
    seq: msg.seq,
  };
  if (msg.diffs !== undefined) forwarded.diffs = msg.diffs;
  if (msg.full_state !== undefined) forwarded.full_state = msg.full_state;

  ctx.deps.sendToConnection(target.sessionId, forwarded);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function broadcastToViewers(
  ctx: CoViewContext,
  session: CoViewSessionInternal,
  frame: WsCoViewState | WsCoViewEvent,
): void {
  for (const m of session.members.values()) {
    if (m.role === "host") continue;
    ctx.deps.sendToConnection(m.sessionId, frame);
  }
}

/**
 * Like broadcastToViewers but excludes one specific connection. Used by pen
 * + cursor channels where any member can be the sender — the sender already
 * painted locally and shouldn't see their own echo.
 */
function broadcastToOtherMembers(
  ctx: CoViewContext,
  session: CoViewSessionInternal,
  frame: WsCoViewEvent | WsCoViewCursor,
  excludeConnectionId: string,
): void {
  for (const m of session.members.values()) {
    if (m.sessionId === excludeConnectionId) continue;
    ctx.deps.sendToConnection(m.sessionId, frame);
  }
}

/** Strip any client-supplied member_id so non-pen frames don't leak it. */
function stripMemberId(msg: WsCoViewEvent): WsCoViewEvent {
  if (msg.member_id === undefined) return msg;
  return {
    type: msg.type,
    session_id: msg.session_id,
    kind: msg.kind,
    payload: msg.payload,
    replay: msg.replay,
    ts: msg.ts,
  };
}

/**
 * Approximate the serialized JSON byte length of an object without producing
 * the full string. Uses `JSON.stringify` because the runtime already accepts
 * the host's pre-serialized frame from the WS layer; if this becomes a hot
 * path, swap for a streaming estimator. Returns `Infinity` on circular refs
 * so callers cap-reject instead of crashing.
 */
function approxJsonSize(v: unknown): number {
  try {
    const s = JSON.stringify(v);
    return s === undefined ? 0 : s.length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}
