// Co-View Sessions client wrapper (spec-27 PR-CV5).
//
// Typed RPC over the existing WS layer. Three responsibilities:
//   1. Lifecycle one-shots — start / update / end / join / leave / kick.
//      Returns Promises that resolve on the matching `*.ack` and reject on
//      `*.nak`. Ack/nak frames are not standard `response` envelopes; they
//      arrive as their own typed frames with no `request_id` (only `list.req`
//      carries one), so correlation is by (frame type, session_id) — the
//      first matching ack/nak after a send settles its pending promise.
//   2. Roster — `list(serverId)` returns a snapshot of joinable sessions,
//      and `observeList(serverId, cb)` keeps it live by replaying the
//      snapshot then forwarding `co-view.list.changed` deltas. The runtime
//      treats `list.req` as both an immediate snapshot AND an implicit
//      subscription with per-subscriber visibility tracking — see spec-27
//      §Roster Push Semantics.
//   3. Per-session observation — `observeSession(serverId, sessionId, cb)`
//      filters the session push family (member.joined/left, ended, state,
//      event, cursor, snapshot.req/res) down to one session.
//
// One-host-per-connection and one-viewer-per-server constraints are enforced
// by the runtime; the wrapper surfaces failures via the rejection path
// rather than by gating sends. UI gates the buttons separately for hygiene.

import { createSignal, type Accessor } from "solid-js";
import type {
  CoViewRedactions,
  CoViewRenderMode,
  CoViewSessionSummary,
  CoViewStateSnapshot,
  CoViewVisibility,
  WsCoViewCursor,
  WsCoViewEvent,
  WsCoViewJoinAck,
  WsCoViewListChanged,
  WsCoViewRenderTreeProjected,
  WsCoViewSnapshotReq,
  WsCoViewSnapshotRes,
  WsCoViewState,
} from "@uncorded/protocol";

import {
  onCoViewAckMessage,
  onCoViewListMessage,
  onCoViewRenderTreeProjected,
  onCoViewSessionMessage,
  send as wsSend,
  type CoViewAckMessage,
  type CoViewSessionMessage,
} from "../lib/ws";

const DEFAULT_TIMEOUT_MS = 30_000;

/** Reasons a `start` call rejects (NAK code). */
export type CoViewStartNakReason =
  | "permission_denied"
  | "already_hosting"
  | "invalid_payload";

/** Reasons a `join` call rejects (NAK code). */
export type CoViewJoinNakReason =
  | "session_not_found"
  | "session_full"
  | "blacklisted"
  | "not_invited";

/** Reasons an `update` call rejects (NAK code). */
export type CoViewUpdateNakReason = "not_host" | "session_not_found" | "invalid_payload";

/** Reasons a `kick` call rejects (NAK code). */
export type CoViewKickNakReason =
  | "not_host_or_moderator"
  | "session_not_found"
  | "target_not_in_session";

/** Error thrown on NAK responses. `code` discriminates programmatic handling. */
export class CoViewError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "CoViewError";
    this.code = code;
  }
}

export interface CoViewStartOptions {
  visibility: CoViewVisibility;
  whitelist: string[];
  blacklist: string[];
  render_mode: CoViewRenderMode;
  redactions: CoViewRedactions;
}

export interface CoViewStartResult {
  session_id: string;
  host_color: string;
}

export interface CoViewUpdatePatch {
  visibility?: CoViewVisibility;
  whitelist?: string[];
  blacklist?: string[];
  render_mode?: CoViewRenderMode;
  redactions?: CoViewRedactions;
  paused?: boolean;
}

/** Slimmed per-session push envelope passed to `observeSession` callbacks. */
export type CoViewSessionPushFrame = CoViewSessionMessage;

/** Slimmed list-change envelope passed to `observeList` callbacks. */
export type CoViewListChangeFrame = WsCoViewListChanged;

interface PendingAckEntry {
  /** Set when the matching frame arrives or the timer fires. */
  resolve: (msg: CoViewAckMessage) => void;
  reject: (err: Error) => void;
  /** Timer handle so we can clear when the frame settles. */
  timer: ReturnType<typeof setTimeout>;
  /** Predicate matching the wire frame. First match wins, FIFO ordering. */
  match: (msg: CoViewAckMessage) => boolean;
}

/** Per-server pending-ack registry. Keyed by `serverId` because each WS
 *  carries its own ack stream and a stale entry from a torn-down server
 *  must never settle a fresh server's call. */
const pendingAcks = new Map<string, PendingAckEntry[]>();
/** Subscriber to the server's ack stream. Lazily attached on first call;
 *  detaches when the last pending entry is settled and no observers remain. */
const ackUnsubs = new Map<string, () => void>();

function ensureAckSubscription(serverId: string): void {
  if (ackUnsubs.has(serverId)) return;
  const unsub = onCoViewAckMessage(serverId, (msg) => {
    const queue = pendingAcks.get(serverId);
    if (!queue || queue.length === 0) return;
    // Walk the queue front-to-back; first match wins, then settles + removes.
    for (let i = 0; i < queue.length; i++) {
      const entry = queue[i];
      if (entry === undefined) continue;
      if (entry.match(msg)) {
        clearTimeout(entry.timer);
        queue.splice(i, 1);
        if (queue.length === 0) {
          pendingAcks.delete(serverId);
          ackUnsubs.get(serverId)?.();
          ackUnsubs.delete(serverId);
        }
        entry.resolve(msg);
        return;
      }
    }
  });
  ackUnsubs.set(serverId, unsub);
}

function awaitAck<T extends CoViewAckMessage>(
  serverId: string,
  match: (msg: CoViewAckMessage) => boolean,
  describe: string,
  timeoutMs: number,
): Promise<T> {
  ensureAckSubscription(serverId);
  return new Promise<T>((resolve, reject) => {
    const queue = pendingAcks.get(serverId) ?? [];
    const timer = setTimeout(() => {
      const q = pendingAcks.get(serverId);
      if (q) {
        const idx = q.indexOf(entry);
        if (idx >= 0) q.splice(idx, 1);
        if (q.length === 0) {
          pendingAcks.delete(serverId);
          ackUnsubs.get(serverId)?.();
          ackUnsubs.delete(serverId);
        }
      }
      reject(new Error(`co-view: ${describe} timed out`));
    }, timeoutMs);
    const entry: PendingAckEntry = {
      resolve: (msg) => resolve(msg as T),
      reject,
      timer,
      match,
    };
    queue.push(entry);
    pendingAcks.set(serverId, queue);
  });
}

/** Send `co-view.start.req` and resolve with the start.ack payload. Start has
 *  no `session_id` on the way out — a host runs at most ONE session per WS
 *  connection (runtime enforces via `byHostConnection`), so the first
 *  start.ack/nak after a start.req is unambiguously ours. Clients must not
 *  pipeline multiple start.reqs. */
export async function startCoView(
  serverId: string,
  opts: CoViewStartOptions,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<CoViewStartResult> {
  const settled = awaitAck<
    CoViewAckMessage & { type: "co-view.start.ack" | "co-view.start.nak" }
  >(
    serverId,
    (m) => m.type === "co-view.start.ack" || m.type === "co-view.start.nak",
    "start",
    timeoutMs,
  );
  wsSend(serverId, {
    type: "co-view.start.req",
    visibility: opts.visibility,
    whitelist: opts.whitelist,
    blacklist: opts.blacklist,
    render_mode: opts.render_mode,
    redactions: opts.redactions,
  });
  const result = await settled;
  if (result.type === "co-view.start.nak") {
    throw new CoViewError(result.code, result.message);
  }
  return { session_id: result.session_id, host_color: result.host_color };
}

/** Send `co-view.update.req` (host-only). Resolves on update.ack. */
export async function updateCoView(
  serverId: string,
  sessionId: string,
  patch: CoViewUpdatePatch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  const settled = awaitAck<CoViewAckMessage & { type: "co-view.update.ack" | "co-view.update.nak" }>(
    serverId,
    (m) =>
      (m.type === "co-view.update.ack" || m.type === "co-view.update.nak") &&
      m.session_id === sessionId,
    `update(${sessionId})`,
    timeoutMs,
  );
  wsSend(serverId, {
    type: "co-view.update.req",
    session_id: sessionId,
    visibility: patch.visibility,
    whitelist: patch.whitelist,
    blacklist: patch.blacklist,
    render_mode: patch.render_mode,
    redactions: patch.redactions,
    paused: patch.paused,
  });
  const result = await settled;
  if (result.type === "co-view.update.nak") {
    throw new CoViewError(result.code, result.message);
  }
}

/** Send `co-view.end.req`. Resolves on end.ack (no nak shape; end is idempotent). */
export async function endCoView(
  serverId: string,
  sessionId: string,
  reason?: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  const settled = awaitAck<CoViewAckMessage & { type: "co-view.end.ack" }>(
    serverId,
    (m) => m.type === "co-view.end.ack" && m.session_id === sessionId,
    `end(${sessionId})`,
    timeoutMs,
  );
  wsSend(serverId, {
    type: "co-view.end.req",
    session_id: sessionId,
    reason,
  });
  await settled;
}

/** Send `co-view.join.req`. Resolves with the join.ack payload (incl. snapshot). */
export async function joinCoView(
  serverId: string,
  sessionId: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<WsCoViewJoinAck> {
  const settled = awaitAck<CoViewAckMessage & { type: "co-view.join.ack" | "co-view.join.nak" }>(
    serverId,
    (m) =>
      (m.type === "co-view.join.ack" || m.type === "co-view.join.nak") &&
      m.session_id === sessionId,
    `join(${sessionId})`,
    timeoutMs,
  );
  wsSend(serverId, { type: "co-view.join.req", session_id: sessionId });
  const result = await settled;
  if (result.type === "co-view.join.nak") {
    throw new CoViewError(result.code, result.message);
  }
  return result;
}

/** Send `co-view.leave.req`. Resolves on leave.ack. */
export async function leaveCoView(
  serverId: string,
  sessionId: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  const settled = awaitAck<CoViewAckMessage & { type: "co-view.leave.ack" }>(
    serverId,
    (m) => m.type === "co-view.leave.ack" && m.session_id === sessionId,
    `leave(${sessionId})`,
    timeoutMs,
  );
  wsSend(serverId, { type: "co-view.leave.req", session_id: sessionId });
  await settled;
}

/** Send `co-view.kick.req` (host or moderator). Resolves on kick.ack. */
export async function kickCoView(
  serverId: string,
  sessionId: string,
  targetUserId: string,
  reason?: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  // Match by (type, session_id) only — kick.nak has no `target_user_id` field
  // so we can't tighten the predicate. Frames are FIFO on the WS, so back-to-
  // back kicks of different targets get their responses in send order; the
  // pending-ack queue's FIFO match settles them correctly.
  const settled = awaitAck<CoViewAckMessage & { type: "co-view.kick.ack" | "co-view.kick.nak" }>(
    serverId,
    (m) =>
      (m.type === "co-view.kick.ack" || m.type === "co-view.kick.nak") &&
      m.session_id === sessionId,
    `kick(${sessionId}/${targetUserId})`,
    timeoutMs,
  );
  wsSend(serverId, {
    type: "co-view.kick.req",
    session_id: sessionId,
    target_user_id: targetUserId,
    reason,
  });
  const result = await settled;
  if (result.type === "co-view.kick.nak") {
    throw new CoViewError(result.code, result.message);
  }
}

/** Snapshot of joinable sessions for a server. Establishes (or refreshes) the
 *  per-(connection, server) implicit subscription in the runtime. */
export async function listCoViewSessions(
  serverId: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<CoViewSessionSummary[]> {
  const requestId = crypto.randomUUID();
  const settled = awaitAck<CoViewAckMessage & { type: "co-view.list.res" }>(
    serverId,
    (m) => m.type === "co-view.list.res" && m.request_id === requestId,
    `list(${serverId})`,
    timeoutMs,
  );
  wsSend(serverId, {
    type: "co-view.list.req",
    request_id: requestId,
    server_id: serverId,
  });
  const res = await settled;
  return res.sessions;
}

/** Observe roster changes. Calls `list()` once for the seed snapshot, then
 *  forwards `co-view.list.changed` deltas. The seed callback is invoked first
 *  with `change="added"` for every session in the snapshot to keep the
 *  callback shape uniform. Returns an unsubscribe function. */
export function observeCoViewList(
  serverId: string,
  onChange: (frame: CoViewListChangeFrame) => void,
): () => void {
  let disposed = false;
  const unsub = onCoViewListMessage(serverId, (msg) => {
    if (disposed) return;
    onChange(msg);
  });
  // Seed by issuing a snapshot. Errors propagate via console — observers
  // typically render a "loading…" UI until the first delta arrives, so this
  // is a best-effort kickoff.
  void listCoViewSessions(serverId)
    .then((sessions) => {
      if (disposed) return;
      for (const session of sessions) {
        onChange({
          type: "co-view.list.changed",
          server_id: serverId,
          change: "added",
          session_id: session.session_id,
          session,
        });
      }
    })
    .catch((err) => {
      console.warn("[co-view] initial list snapshot failed", err);
    });
  return () => {
    disposed = true;
    unsub();
  };
}

/** Observe `co-view.render-tree.projected` frames for a server (CV-FOUND-6).
 *  Delivers every projected frame for the connection; the projected-frame store
 *  demuxes by `session_id`. Unlike `observeCoViewList` there is no seed snapshot
 *  — the runtime pushes a fresh projected frame on each host render. Returns an
 *  unsubscribe function. Dormant until a viewer surface subscribes
 *  (`CO_VIEW_PROJECTED_VIEWER_ENABLED` stays false this PR). */
export function observeCoViewRenderTreeProjected(
  serverId: string,
  onFrame: (frame: WsCoViewRenderTreeProjected) => void,
): () => void {
  let disposed = false;
  const unsub = onCoViewRenderTreeProjected(serverId, (msg) => {
    if (disposed) return;
    onFrame(msg);
  });
  return () => {
    disposed = true;
    unsub();
  };
}

/** Observe per-session push frames (member events, state, cursor, pen, etc.).
 *  Returns an unsubscribe function. */
export function observeCoViewSession(
  serverId: string,
  sessionId: string,
  onFrame: (frame: CoViewSessionPushFrame) => void,
): () => void {
  return onCoViewSessionMessage(
    serverId,
    (msg) => msg.session_id === sessionId,
    onFrame,
  );
}

/** Send a host-emitted `co-view.state` frame. Thin pass-through; the producer
 *  factory owns coalescing + ring-buffer maintenance. */
export function sendCoViewState(serverId: string, frame: WsCoViewState): void {
  wsSend(serverId, frame);
}

/** Send a host- or viewer-emitted `co-view.event` frame (nav.* or pen.*). */
export function sendCoViewEvent(serverId: string, frame: WsCoViewEvent): void {
  wsSend(serverId, frame);
}

/** Send a `co-view.cursor` frame. Lossy/volatile per spec — no ack. */
export function sendCoViewCursor(serverId: string, frame: WsCoViewCursor): void {
  wsSend(serverId, frame);
}

/** Viewer → server gap-recovery request. */
export function sendCoViewSnapshotReq(serverId: string, frame: WsCoViewSnapshotReq): void {
  wsSend(serverId, frame);
}

/** Host → server gap-recovery response. */
export function sendCoViewSnapshotRes(serverId: string, frame: WsCoViewSnapshotRes): void {
  wsSend(serverId, frame);
}

/** Re-export the snapshot type alias for consumers that thread it through. */
export type { CoViewStateSnapshot };

/** Convenience reactive accessor: signal that resolves to the current host's
 *  session_id for `serverId` (or null when not hosting). Tests build this
 *  themselves; ship the helper for App.tsx. */
export function createCoViewHostingSignal(): {
  hostingSessionId: Accessor<string | null>;
  setHostingSessionId: (id: string | null) => void;
} {
  const [hostingSessionId, setHostingSessionId] = createSignal<string | null>(null);
  return { hostingSessionId, setHostingSessionId };
}
