// Dispatch handlers for Co-View Sessions lifecycle frames (spec-27 §Wire
// Protocol, §Authorization Model, §Audit Log).
//
// PR-CV1 scope: start / update / end / join / leave / kick — plus the
// host-disconnect-with-grace teardown path. State, event, cursor, and pen
// channels are PR-CV2+. Frame validation already happened at parseClientMessage
// in ws/router.ts; here we only enforce semantic + authorization rules.

import { RUNTIME_CO_VIEW_TOPICS } from "@uncorded/protocol";
import type {
  CoViewEndReason,
  CoViewMemberLeftReason,
  CoViewRedactions,
  CoViewSessionSummary,
  WsCoViewEndAck,
  WsCoViewEndReq,
  WsCoViewEnded,
  WsCoViewJoinAck,
  WsCoViewJoinNak,
  WsCoViewJoinReq,
  WsCoViewKickAck,
  WsCoViewKickNak,
  WsCoViewKickReq,
  WsCoViewLeaveAck,
  WsCoViewLeaveReq,
  WsCoViewListChanged,
  WsCoViewListReq,
  WsCoViewListRes,
  WsCoViewMemberJoined,
  WsCoViewMemberLeft,
  WsCoViewStartAck,
  WsCoViewStartNak,
  WsCoViewStartReq,
  WsCoViewUpdateAck,
  WsCoViewUpdateNak,
  WsCoViewUpdateReq,
} from "@uncorded/protocol";

import type { Logger } from "@uncorded/shared";

import { recordCoViewAudit } from "./audit";
import { pickMemberColor } from "./colors";
import {
  canHostCoView,
  canModerateCoView,
  isVisibleToUser,
} from "./permissions";
import { countViewers } from "./registry";
import type { CoViewRegistry } from "./registry";
import {
  CO_VIEW_LIMITS,
  CO_VIEW_PRESENCE_SLUG,
} from "./types";
import type {
  CoViewDeps,
  CoViewMemberInternal,
  CoViewRedactionsInternal,
  CoViewSessionInternal,
} from "./types";

// ---------------------------------------------------------------------------
// Handshake context — bundles deps + state for the per-frame handlers
// ---------------------------------------------------------------------------

export interface CoViewContext {
  deps: CoViewDeps;
  registry: CoViewRegistry;
  log: Logger;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer: (handle: ReturnType<typeof setTimeout>) => void;
  generateSessionId: () => string;
  /**
   * PR-CV5 — per-(server, connection) visible-set tracking. The runtime emits
   * `co-view.list.changed` only to subscribers whose visible-set is affected,
   * so a viewer who was never invited to a session never learns the session
   * existed even when it ends or its visibility shifts. See
   * `feedback-runtime-enforces-security` memory: client-side filtering is not
   * the integrity layer.
   *
   * Key shape: `serverId → connectionId → Set<sessionId>`.
   */
  listSubscribers: Map<string, Map<string, Set<string>>>;
}

// ---------------------------------------------------------------------------
// co-view.start.req
// ---------------------------------------------------------------------------

export function handleStart(
  ctx: CoViewContext,
  msg: WsCoViewStartReq,
  connectionId: string,
): void {
  const user = ctx.deps.getConnectedUser(connectionId);
  if (!user) {
    // Frame arrived from an unauthenticated socket — the WS layer normally
    // closes those before we'd see it. Treat as a silent drop; nothing
    // useful to nak to.
    return;
  }
  const isOwner = user.role === "owner";

  if (!canHostCoView(ctx.deps.rolesEngine, user.id, isOwner)) {
    sendStartNak(ctx, connectionId, "permission_denied", "You do not have permission to host Co-View sessions.");
    recordCoViewAudit(ctx.deps.db, {
      action: "co_view.permission_denied",
      targetId: user.id,
      actorUserId: user.id,
      actorRole: user.role,
      payload: { action: "start" },
    });
    return;
  }

  if (ctx.registry.getSessionHostedBy(connectionId) !== undefined) {
    sendStartNak(ctx, connectionId, "already_hosting", "This connection is already hosting a Co-View session.");
    return;
  }

  const payloadCheck = validateStartPayload(msg);
  if (!payloadCheck.ok) {
    sendStartNak(ctx, connectionId, "invalid_payload", payloadCheck.message);
    return;
  }

  const sessionId = ctx.generateSessionId();
  const createdAt = ctx.now();
  const hostColor = pickMemberColor(sessionId, user.id);

  const hostMember: CoViewMemberInternal = {
    userId: user.id,
    sessionId: connectionId,
    joinedAt: createdAt,
    color: hostColor,
    role: "host",
  };

  const session: CoViewSessionInternal = {
    id: sessionId,
    hostUserId: user.id,
    hostSessionId: connectionId,
    visibility: msg.visibility,
    whitelist: new Set(msg.whitelist),
    blacklist: new Set(msg.blacklist),
    renderMode: msg.render_mode,
    redactions: toInternalRedactions(msg.redactions),
    createdAt,
    members: new Map([[connectionId, hostMember]]),
    peakViewers: 0,
    paused: false,
    hostDisconnectedAt: null,
    hostDisconnectTimer: null,
    softCapWarned: false,
    lastSeq: -1,
    safeStateSnapshot: {},
    cursors: new Map(),
    rateLimits: {
      cursor: new Map(),
      penPoint: new Map(),
      penBegin: new Map(),
    },
    lastClearTs: new Map(),
  };

  ctx.registry.insertSession(session);

  // Presence-scope integration: join the host into co-view.session.<id> so
  // every subsequent join / leave produces a `runtime.presence.*` event the
  // shell + audit consumers already subscribe to.
  const presenceScope = `session.${sessionId}`;
  const presenceJoin = ctx.deps.presenceModule.join(
    CO_VIEW_PRESENCE_SLUG,
    presenceScope,
    user.id,
    connectionId,
    { role: "host", color: hostColor },
  );
  if (!presenceJoin.ok) {
    // Presence join failure is rare (session-gone, scope-invalid, rate). Roll
    // back the registry insert and surface the failure as invalid_payload —
    // the spec's nak codes do not include a presence-internal one. The log
    // line carries the underlying code so operators can diagnose.
    ctx.registry.deleteSession(sessionId);
    ctx.log.warn("co-view: presence join failed on start", {
      sessionId,
      code: presenceJoin.error.code,
      message: presenceJoin.error.message,
    });
    sendStartNak(ctx, connectionId, "invalid_payload", `presence join failed: ${presenceJoin.error.message}`);
    return;
  }

  recordCoViewAudit(ctx.deps.db, {
    action: "co_view.session_started",
    targetId: sessionId,
    actorUserId: user.id,
    actorRole: user.role,
    payload: {
      visibility: session.visibility,
      render_mode: session.renderMode,
    },
  });

  ctx.deps.eventBus.publishRuntime(RUNTIME_CO_VIEW_TOPICS.SESSION_STARTED, {
    session_id: sessionId,
    host_user_id: user.id,
    visibility: session.visibility,
    render_mode: session.renderMode,
    ts: createdAt,
  });

  const ack: WsCoViewStartAck = {
    type: "co-view.start.ack",
    session_id: sessionId,
    host_color: hostColor,
  };
  ctx.deps.sendToConnection(connectionId, ack);

  broadcastListChange(ctx, "added", session);
}

// ---------------------------------------------------------------------------
// co-view.update.req
// ---------------------------------------------------------------------------

export function handleUpdate(
  ctx: CoViewContext,
  msg: WsCoViewUpdateReq,
  connectionId: string,
): void {
  const user = ctx.deps.getConnectedUser(connectionId);
  if (!user) return;

  const session = ctx.registry.get(msg.session_id);
  if (!session) {
    sendUpdateNak(ctx, connectionId, msg.session_id, "session_not_found", "Session not found.");
    return;
  }
  if (session.hostSessionId !== connectionId) {
    sendUpdateNak(ctx, connectionId, msg.session_id, "not_host", "Only the session host may update a Co-View session.");
    return;
  }

  // The wire type already constrains optional fields' shapes, but visibility +
  // render_mode are open string unions in JSON-land; redactions need length
  // caps. Re-check the bits we touch.
  const fieldsChanged: string[] = [];

  if (msg.visibility !== undefined) {
    if (msg.visibility !== "public" && msg.visibility !== "private") {
      sendUpdateNak(ctx, connectionId, msg.session_id, "invalid_payload", `visibility must be "public" or "private".`);
      return;
    }
    if (session.visibility !== msg.visibility) {
      session.visibility = msg.visibility;
      fieldsChanged.push("visibility");
    }
  }
  if (msg.render_mode !== undefined) {
    if (msg.render_mode !== "as-host" && msg.render_mode !== "as-viewer") {
      sendUpdateNak(ctx, connectionId, msg.session_id, "invalid_payload", `render_mode must be "as-host" or "as-viewer".`);
      return;
    }
    if (session.renderMode !== msg.render_mode) {
      session.renderMode = msg.render_mode;
      fieldsChanged.push("render_mode");
    }
  }
  if (msg.whitelist !== undefined) {
    session.whitelist = new Set(msg.whitelist);
    fieldsChanged.push("whitelist");
  }
  if (msg.blacklist !== undefined) {
    session.blacklist = new Set(msg.blacklist);
    fieldsChanged.push("blacklist");
  }
  if (msg.redactions !== undefined) {
    const r = validateRedactions(msg.redactions);
    if (!r.ok) {
      sendUpdateNak(ctx, connectionId, msg.session_id, "invalid_payload", r.message);
      return;
    }
    session.redactions = toInternalRedactions(msg.redactions);
    fieldsChanged.push("redactions");
  }
  // PR-CV5: `paused` is now runtime-enforced. Setting `session.paused = true`
  // makes `state-handlers.ts` drop inbound state / event (non-pen) / cursor /
  // pen frames originating from the HOST connection. Control frames
  // (`co-view.update`, `co-view.end`) still pass — pause MUST be reversible
  // by the host. See `feedback-runtime-enforces-security` memory: a producer
  // gate alone is honest-client politeness, not a guarantee.
  if (msg.paused !== undefined && session.paused !== msg.paused) {
    session.paused = msg.paused;
    fieldsChanged.push("paused");
  }

  // Auto-kick any current member who no longer matches the visibility set
  // (whitelist removed / blacklist added). The spec calls these
  // `no_longer_invited` and `blacklisted_mid_session`.
  if (
    msg.whitelist !== undefined ||
    msg.blacklist !== undefined ||
    msg.visibility !== undefined
  ) {
    autoKickStaleMembers(ctx, session);
  }

  recordCoViewAudit(ctx.deps.db, {
    action: "co_view.update_applied",
    targetId: session.id,
    actorUserId: user.id,
    actorRole: user.role,
    payload: { fields_changed: fieldsChanged },
  });

  const ack: WsCoViewUpdateAck = {
    type: "co-view.update.ack",
    session_id: session.id,
  };
  ctx.deps.sendToConnection(connectionId, ack);

  // Roster broadcast — visibility downgrades, blacklist additions, pause
  // toggles, render-mode changes all affect the summary that subscribers
  // see. broadcastListChange handles the per-subscriber visible-set
  // bookkeeping (some subscribers may have lost visibility entirely and
  // need a `removed` instead of `updated`).
  if (fieldsChanged.length > 0) {
    broadcastListChange(ctx, "updated", session);
  }
}

// ---------------------------------------------------------------------------
// co-view.end.req
// ---------------------------------------------------------------------------

export function handleEnd(
  ctx: CoViewContext,
  msg: WsCoViewEndReq,
  connectionId: string,
): void {
  const user = ctx.deps.getConnectedUser(connectionId);
  if (!user) return;

  const session = ctx.registry.get(msg.session_id);
  if (!session) {
    // No nak frame for end (spec's wire table only defines `end.ack`). Silent
    // drop matches the principle that end-against-missing is idempotent from
    // the caller's view.
    return;
  }
  if (session.hostSessionId !== connectionId) {
    // The host is the only WS allowed to end. Silent drop for non-host
    // callers — they would not normally know the session_id without being a
    // member.
    return;
  }

  endSession(ctx, session, "host_ended");

  const ack: WsCoViewEndAck = {
    type: "co-view.end.ack",
    session_id: session.id,
  };
  ctx.deps.sendToConnection(connectionId, ack);
}

// ---------------------------------------------------------------------------
// co-view.join.req
// ---------------------------------------------------------------------------

export function handleJoin(
  ctx: CoViewContext,
  msg: WsCoViewJoinReq,
  connectionId: string,
): void {
  const user = ctx.deps.getConnectedUser(connectionId);
  if (!user) return;
  const isOwner = user.role === "owner";

  const session = ctx.registry.get(msg.session_id);
  if (!session) {
    sendJoinNak(ctx, connectionId, msg.session_id, "session_not_found", "Session not found.");
    return;
  }

  // The host's own re-join attempt is a no-op as far as wire frames go — the
  // host is already a member with `role: "host"`. We just send back an ack
  // so the host's SDK promise resolves.
  if (session.hostUserId === user.id && session.hostSessionId === connectionId) {
    sendJoinAckForExisting(ctx, connectionId, session, user.id);
    return;
  }

  const visibility = isVisibleToUser(
    session.visibility,
    session.whitelist,
    session.blacklist,
    user.id,
    isOwner,
  );
  if (!visibility.ok) {
    sendJoinNak(ctx, connectionId, session.id, visibility.reason, visibility.reason === "blacklisted"
      ? "You are on this session's blacklist."
      : "You are not invited to this session.");
    recordCoViewAudit(ctx.deps.db, {
      action: "co_view.permission_denied",
      targetId: session.id,
      actorUserId: user.id,
      actorRole: user.role,
      payload: { action: "join", reason: visibility.reason },
    });
    return;
  }

  // Hard cap rejects; soft cap warns + audits but still admits.
  const currentViewers = countViewers(session);
  if (currentViewers >= CO_VIEW_LIMITS.HARD_VIEWER_CAP) {
    sendJoinNak(ctx, connectionId, session.id, "session_full", "This Co-View session is at capacity.");
    return;
  }

  // Re-join from the same connection is idempotent — send an ack and skip the
  // member-joined broadcast. We honor the spec's clarification that a viewer
  // disconnect "re-joins fresh on reconnect"; that only applies when the WS
  // connection itself was new (different connectionId), which the registry
  // already keys on.
  const existing = session.members.get(connectionId);
  if (existing) {
    sendJoinAckForExisting(ctx, connectionId, session, user.id);
    return;
  }

  const joinedAt = ctx.now();
  const color = pickMemberColor(session.id, user.id);
  const viewer: CoViewMemberInternal = {
    userId: user.id,
    sessionId: connectionId,
    joinedAt,
    color,
    role: "viewer",
  };
  ctx.registry.addMember(session.id, viewer);

  const newCount = countViewers(session);
  if (
    !session.softCapWarned &&
    newCount > CO_VIEW_LIMITS.SOFT_VIEWER_CAP
  ) {
    session.softCapWarned = true;
    ctx.log.warn("co-view: session crossed soft viewer cap", {
      sessionId: session.id,
      viewers: newCount,
      softCap: CO_VIEW_LIMITS.SOFT_VIEWER_CAP,
    });
    recordCoViewAudit(ctx.deps.db, {
      action: "co_view.soft_cap_exceeded",
      targetId: session.id,
      actorUserId: session.hostUserId,
      payload: { viewers: newCount, cap: CO_VIEW_LIMITS.SOFT_VIEWER_CAP },
    });
  }

  // Presence integration — viewer joins the session scope.
  const presenceJoin = ctx.deps.presenceModule.join(
    CO_VIEW_PRESENCE_SLUG,
    `session.${session.id}`,
    user.id,
    connectionId,
    { role: "viewer", color },
  );
  if (!presenceJoin.ok) {
    // Roll back the member insert so the registry stays consistent with
    // presence; surface as session_not_found because the most likely cause
    // is the WS session having closed between message receipt and dispatch.
    ctx.registry.removeMember(session.id, connectionId);
    ctx.log.warn("co-view: presence join failed on viewer join", {
      sessionId: session.id,
      userId: user.id,
      code: presenceJoin.error.code,
    });
    sendJoinNak(ctx, connectionId, session.id, "session_not_found", `presence join failed: ${presenceJoin.error.message}`);
    return;
  }

  recordCoViewAudit(ctx.deps.db, {
    action: "co_view.member_joined",
    targetId: session.id,
    actorUserId: user.id,
    actorRole: user.role,
  });

  ctx.deps.eventBus.publishRuntime(RUNTIME_CO_VIEW_TOPICS.MEMBER_JOINED, {
    session_id: session.id,
    user_id: user.id,
    color,
    ts: joinedAt,
  });

  // Broadcast member.joined to every OTHER member (host + viewers).
  // `member_id = connectionId` matches the id the runtime stamps on
  // co-view.cursor + pen.* frames, so consumers can resolve color from a
  // single map keyed on member_id.
  const memberJoined: WsCoViewMemberJoined = {
    type: "co-view.member.joined",
    session_id: session.id,
    user_id: user.id,
    member_id: connectionId,
    color,
  };
  broadcastToOthers(ctx, session, connectionId, memberJoined);

  // Ack the joining viewer with the snapshot (PR-CV1: always null per spec).
  const ack: WsCoViewJoinAck = {
    type: "co-view.join.ack",
    session_id: session.id,
    host_user_id: session.hostUserId,
    render_mode: session.renderMode,
    viewer_color: color,
    current_state_snapshot: snapshotForJoinAck(session),
  };
  ctx.deps.sendToConnection(connectionId, ack);

  // Roster broadcast — viewer_count changed, surface to anyone watching
  // the active-sessions list for this server.
  broadcastListChange(ctx, "updated", session);
}

// ---------------------------------------------------------------------------
// co-view.leave.req
// ---------------------------------------------------------------------------

export function handleLeave(
  ctx: CoViewContext,
  msg: WsCoViewLeaveReq,
  connectionId: string,
): void {
  const user = ctx.deps.getConnectedUser(connectionId);
  if (!user) return;

  const session = ctx.registry.get(msg.session_id);
  if (!session) return;

  const member = session.members.get(connectionId);
  if (!member) return;

  // A host calling leave on their own session is treated as an explicit end.
  if (member.role === "host") {
    endSession(ctx, session, "host_ended");
    const ack: WsCoViewLeaveAck = {
      type: "co-view.leave.ack",
      session_id: session.id,
    };
    ctx.deps.sendToConnection(connectionId, ack);
    return;
  }

  removeMemberAndBroadcast(ctx, session, member, "explicit");

  const ack: WsCoViewLeaveAck = {
    type: "co-view.leave.ack",
    session_id: session.id,
  };
  ctx.deps.sendToConnection(connectionId, ack);
}

// ---------------------------------------------------------------------------
// co-view.kick.req
// ---------------------------------------------------------------------------

export function handleKick(
  ctx: CoViewContext,
  msg: WsCoViewKickReq,
  connectionId: string,
): void {
  const user = ctx.deps.getConnectedUser(connectionId);
  if (!user) return;
  const isOwner = user.role === "owner";

  const session = ctx.registry.get(msg.session_id);
  if (!session) {
    sendKickNak(ctx, connectionId, msg.session_id, "session_not_found", "Session not found.");
    return;
  }

  const isHost = session.hostSessionId === connectionId;
  const isModerator = canModerateCoView(ctx.deps.rolesEngine, user.id, isOwner);
  if (!isHost && !isModerator) {
    sendKickNak(ctx, connectionId, session.id, "not_host_or_moderator", "Only the host or a moderator may kick.");
    recordCoViewAudit(ctx.deps.db, {
      action: "co_view.permission_denied",
      targetId: session.id,
      actorUserId: user.id,
      actorRole: user.role,
      payload: { action: "kick" },
    });
    return;
  }

  const target = findMemberByUserId(session, msg.target_user_id);
  if (!target) {
    sendKickNak(ctx, connectionId, session.id, "target_not_in_session", "Target user is not in the session.");
    return;
  }

  // Kicking the host (via moderator) is equivalent to ending the session.
  if (target.role === "host") {
    endSession(ctx, session, "host_ended");
  } else {
    removeMemberAndBroadcast(ctx, session, target, "kicked");
  }

  recordCoViewAudit(ctx.deps.db, {
    action: "co_view.member_kicked",
    targetId: session.id,
    actorUserId: user.id,
    actorRole: user.role,
    payload: {
      target_user_id: msg.target_user_id,
      reason: msg.reason ?? null,
    },
  });

  const ack: WsCoViewKickAck = {
    type: "co-view.kick.ack",
    session_id: session.id,
    target_user_id: msg.target_user_id,
  };
  ctx.deps.sendToConnection(connectionId, ack);
}

// ---------------------------------------------------------------------------
// Connection-close path (called from MessageRouter.onConnectionRemoved → register.ts)
// ---------------------------------------------------------------------------

export function handleConnectionClose(
  ctx: CoViewContext,
  connectionId: string,
): void {
  // Always sweep list subscriptions, even when the connection wasn't a
  // session host/viewer — a viewer can be subscribed to the roster without
  // having joined any session yet.
  for (const subs of ctx.listSubscribers.values()) {
    subs.delete(connectionId);
  }

  const sessionIds = ctx.registry.sessionsForConnection(connectionId);
  if (sessionIds.length === 0) return;

  for (const sessionId of sessionIds) {
    const session = ctx.registry.get(sessionId);
    if (!session) continue;

    const member = session.members.get(connectionId);
    if (!member) continue;

    if (member.role === "host") {
      // Start the disconnect grace timer. Per spec §"Ephemeral in-memory
      // session state with reconnect grace": < 60s holds the session open;
      // longer ends it with reason "host_lost". PR-CV1 ships the timer;
      // the reconnect path that clears it lands in PR-CV2+.
      session.hostDisconnectedAt = ctx.now();
      // Defensive: if a previous grace timer is still scheduled (shouldn't
      // happen, since the host's own connection produced it), clear it.
      if (session.hostDisconnectTimer !== null) {
        ctx.clearTimer(session.hostDisconnectTimer);
      }
      session.hostDisconnectTimer = ctx.setTimer(() => {
        // Re-fetch in case the session was already ended through another
        // path while the timer was pending.
        const still = ctx.registry.get(sessionId);
        if (!still) return;
        endSession(ctx, still, "host_lost");
      }, CO_VIEW_LIMITS.HOST_DISCONNECT_GRACE_MS);
      ctx.log.info("co-view: host disconnected — grace timer armed", {
        sessionId,
        graceMs: CO_VIEW_LIMITS.HOST_DISCONNECT_GRACE_MS,
      });
      continue;
    }

    // Viewer disconnect: evict + broadcast left with reason "session_closed"
    // per the spec's failure-modes table ("Viewer disconnects briefly →
    // Viewer's session entry evicted; on reconnect, viewer must re-issue
    // join.req. No partial reconnect.").
    removeMemberAndBroadcast(ctx, session, member, "session_closed");
  }
}

// ---------------------------------------------------------------------------
// co-view.list.req — roster snapshot + implicit subscription
// ---------------------------------------------------------------------------

export function handleList(
  ctx: CoViewContext,
  msg: WsCoViewListReq,
  connectionId: string,
): void {
  const user = ctx.deps.getConnectedUser(connectionId);
  if (!user) {
    // Unauthenticated socket — WS layer normally closes these. No useful
    // request_id-routed reply path; silent drop.
    return;
  }

  // Server-id authorization: a runtime instance owns exactly one server, so
  // any list.req for a different server_id is a bug or a probe. Drop with an
  // empty reply addressed to the request_id so the client's request promise
  // resolves cleanly rather than timing out.
  if (msg.server_id !== ctx.deps.serverId) {
    ctx.log.warn("co-view: list.req for unknown server_id — dropped", {
      connectionId,
      requestedServerId: msg.server_id,
      runtimeServerId: ctx.deps.serverId,
    });
    const empty: WsCoViewListRes = {
      type: "co-view.list.res",
      request_id: msg.request_id,
      server_id: msg.server_id,
      sessions: [],
    };
    ctx.deps.sendToConnection(connectionId, empty);
    return;
  }

  const isOwner = user.role === "owner";
  const summaries: CoViewSessionSummary[] = [];
  const visibleSet = new Set<string>();

  for (const session of ctx.registry.list()) {
    const visibility = isVisibleToUser(
      session.visibility,
      session.whitelist,
      session.blacklist,
      user.id,
      isOwner,
    );
    if (!visibility.ok) continue;
    summaries.push(summarizeSession(ctx, session));
    visibleSet.add(session.id);
  }

  const res: WsCoViewListRes = {
    type: "co-view.list.res",
    request_id: msg.request_id,
    server_id: msg.server_id,
    sessions: summaries,
  };
  ctx.deps.sendToConnection(connectionId, res);

  // Register / replace the per-(server, connection) subscription. A second
  // list.req from the same connection on the same server REPLACES the prior
  // visible-set so the snapshot the client now holds matches what the
  // runtime tracks (no drift across reconnect/reauth).
  let bucket = ctx.listSubscribers.get(msg.server_id);
  if (!bucket) {
    bucket = new Map();
    ctx.listSubscribers.set(msg.server_id, bucket);
  }
  bucket.set(connectionId, visibleSet);
}

// ---------------------------------------------------------------------------
// Roster broadcast helpers — per-subscriber visible-set tracking so a
// `removed` push never leaks the existence of a session a viewer was never
// invited to. See `feedback-runtime-enforces-security` memory.
// ---------------------------------------------------------------------------

/**
 * Drive an `added` / `updated` broadcast. The session is still live; we
 * re-evaluate `isVisibleToUser` per subscriber and pick one of four
 * outcomes:
 *
 *   1. visible AND in set       → `updated` (no set change).
 *   2. visible AND NOT in set   → `added`   (set gains sessionId; visibility
 *                                            upgrade or freshly-started).
 *   3. NOT visible AND in set   → `removed` (set loses sessionId; visibility
 *                                            downgrade — they previously saw
 *                                            it, owe them the cleanup).
 *   4. NOT visible AND NOT set  → no-op    (don't leak existence).
 */
function broadcastListChange(
  ctx: CoViewContext,
  change: "added" | "updated",
  session: CoViewSessionInternal,
): void {
  const bucket = ctx.listSubscribers.get(ctx.deps.serverId);
  if (!bucket) return;

  for (const [connectionId, visibleSet] of bucket) {
    const subscriber = ctx.deps.getConnectedUser(connectionId);
    if (!subscriber) continue;
    const isOwner = subscriber.role === "owner";
    const visibility = isVisibleToUser(
      session.visibility,
      session.whitelist,
      session.blacklist,
      subscriber.id,
      isOwner,
    );
    const wasVisible = visibleSet.has(session.id);

    if (visibility.ok && wasVisible) {
      sendListChanged(ctx, connectionId, "updated", session);
    } else if (visibility.ok && !wasVisible) {
      visibleSet.add(session.id);
      sendListChanged(ctx, connectionId, "added", session);
      void change; // semantics from caller fold into the visible-set diff above
    } else if (!visibility.ok && wasVisible) {
      visibleSet.delete(session.id);
      sendListRemoved(ctx, connectionId, session.id);
    }
    // !visibility.ok && !wasVisible — silent.
  }
}

/**
 * Drive a `removed` broadcast for an ended (or otherwise gone) session.
 * Only subscribers whose visible-set actually contained this session id
 * receive a frame; everyone else learns nothing.
 */
function broadcastListRemoval(ctx: CoViewContext, sessionId: string): void {
  const bucket = ctx.listSubscribers.get(ctx.deps.serverId);
  if (!bucket) return;

  for (const [connectionId, visibleSet] of bucket) {
    if (!visibleSet.has(sessionId)) continue;
    visibleSet.delete(sessionId);
    sendListRemoved(ctx, connectionId, sessionId);
  }
}

function sendListChanged(
  ctx: CoViewContext,
  connectionId: string,
  change: "added" | "updated",
  session: CoViewSessionInternal,
): void {
  const frame: WsCoViewListChanged = {
    type: "co-view.list.changed",
    server_id: ctx.deps.serverId,
    change,
    session_id: session.id,
    session: summarizeSession(ctx, session),
  };
  ctx.deps.sendToConnection(connectionId, frame);
}

function sendListRemoved(
  ctx: CoViewContext,
  connectionId: string,
  sessionId: string,
): void {
  const frame: WsCoViewListChanged = {
    type: "co-view.list.changed",
    server_id: ctx.deps.serverId,
    change: "removed",
    session_id: sessionId,
  };
  ctx.deps.sendToConnection(connectionId, frame);
}

function summarizeSession(
  ctx: CoViewContext,
  session: CoViewSessionInternal,
): CoViewSessionSummary {
  const hostUser = findHostDisplayUser(ctx, session);
  return {
    session_id: session.id,
    server_id: ctx.deps.serverId,
    host_user_id: session.hostUserId,
    host_session_id: session.hostSessionId,
    host_display_name: hostUser?.displayName ?? session.hostUserId,
    visibility: session.visibility,
    render_mode: session.renderMode,
    started_at: session.createdAt,
    viewer_count: countViewers(session),
    paused: session.paused,
  };
}

function findHostDisplayUser(
  ctx: CoViewContext,
  session: CoViewSessionInternal,
): { displayName: string } | undefined {
  const connected = ctx.deps.getConnectedUser(session.hostSessionId);
  if (connected) return { displayName: connected.displayName };
  // Fall back to the core member directory — host may have temporarily
  // disconnected during the grace window.
  try {
    const members = ctx.deps.coreModule.getUsers([session.hostUserId]);
    const m = members[0];
    if (m && typeof m.display_name === "string") {
      return { displayName: m.display_name };
    }
  } catch {
    // Core module shape varies by build; fall through to undefined.
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function endSession(
  ctx: CoViewContext,
  session: CoViewSessionInternal,
  reason: CoViewEndReason,
): void {
  // Defensive: clear any pending grace timer so it can't fire post-teardown.
  if (session.hostDisconnectTimer !== null) {
    ctx.clearTimer(session.hostDisconnectTimer);
    session.hostDisconnectTimer = null;
  }

  // Snapshot member list before deletion — the registry index gets cleared
  // as we remove entries through presence-leave, and we still need to
  // broadcast `co-view.ended` to every original recipient.
  const recipients: string[] = [];
  for (const m of session.members.values()) {
    recipients.push(m.sessionId);
  }

  // Presence-leave every member under the session scope so downstream
  // `runtime.presence.left` subscribers see the wind-down.
  for (const m of session.members.values()) {
    ctx.deps.presenceModule.leave(
      CO_VIEW_PRESENCE_SLUG,
      `session.${session.id}`,
      m.userId,
      m.sessionId,
    );
  }

  const ts = ctx.now();
  const durationMs = ts - session.createdAt;

  const dropped = ctx.registry.deleteSession(session.id);
  if (!dropped) return; // Already gone — idempotent.

  recordCoViewAudit(ctx.deps.db, {
    action: "co_view.session_ended",
    targetId: session.id,
    // Host owns the session — natural actor even when the system tears it
    // down via grace timer. The `reason` field captures the trigger.
    actorUserId: session.hostUserId,
    payload: {
      reason,
      duration_ms: durationMs,
      peak_viewers: session.peakViewers,
    },
  });

  ctx.deps.eventBus.publishRuntime(RUNTIME_CO_VIEW_TOPICS.SESSION_ENDED, {
    session_id: session.id,
    reason,
    ts,
  });

  const ended: WsCoViewEnded = {
    type: "co-view.ended",
    session_id: session.id,
    reason,
  };
  for (const connectionId of recipients) {
    ctx.deps.sendToConnection(connectionId, ended);
  }

  // Roster broadcast — only subscribers who previously had this session in
  // their visible-set learn about the removal. Subscribers who never saw it
  // (e.g. a public viewer who was blacklisted before the session even
  // started) do NOT get a `removed`, which would otherwise leak the
  // existence of that session id.
  broadcastListRemoval(ctx, session.id);
}

function removeMemberAndBroadcast(
  ctx: CoViewContext,
  session: CoViewSessionInternal,
  member: CoViewMemberInternal,
  reason: CoViewMemberLeftReason,
): void {
  const removed = ctx.registry.removeMember(session.id, member.sessionId);
  if (!removed) return;

  ctx.deps.presenceModule.leave(
    CO_VIEW_PRESENCE_SLUG,
    `session.${session.id}`,
    member.userId,
    member.sessionId,
  );

  const ts = ctx.now();

  recordCoViewAudit(ctx.deps.db, {
    action: "co_view.member_left",
    targetId: session.id,
    actorUserId: member.userId,
    payload: {
      reason,
      duration_ms: ts - member.joinedAt,
    },
  });

  ctx.deps.eventBus.publishRuntime(RUNTIME_CO_VIEW_TOPICS.MEMBER_LEFT, {
    session_id: session.id,
    user_id: member.userId,
    reason,
    ts,
  });

  const left: WsCoViewMemberLeft = {
    type: "co-view.member.left",
    session_id: session.id,
    user_id: member.userId,
    member_id: member.sessionId,
    reason,
  };
  // Broadcast to remaining members, plus the leaver themselves only when the
  // departure was involuntary (kicked / no_longer_invited / blacklisted) so
  // their UI can react. "explicit" callers already got their leave.ack;
  // "session_closed" callers are by definition gone.
  for (const m of session.members.values()) {
    ctx.deps.sendToConnection(m.sessionId, left);
  }
  if (
    reason === "kicked" ||
    reason === "no_longer_invited" ||
    reason === "blacklisted_mid_session"
  ) {
    ctx.deps.sendToConnection(member.sessionId, left);
  }

  // Roster broadcast — viewer_count dropped, surface to subscribers.
  broadcastListChange(ctx, "updated", session);
}

function autoKickStaleMembers(
  ctx: CoViewContext,
  session: CoViewSessionInternal,
): void {
  const toKick: Array<{ member: CoViewMemberInternal; reason: CoViewMemberLeftReason }> = [];

  for (const member of session.members.values()) {
    if (member.role === "host") continue;
    if (session.visibility === "public") {
      if (session.blacklist.has(member.userId)) {
        toKick.push({ member, reason: "blacklisted_mid_session" });
      }
    } else if (!session.whitelist.has(member.userId)) {
      toKick.push({ member, reason: "no_longer_invited" });
    }
  }

  for (const { member, reason } of toKick) {
    removeMemberAndBroadcast(ctx, session, member, reason);
  }
}

function findMemberByUserId(
  session: CoViewSessionInternal,
  userId: string,
): CoViewMemberInternal | undefined {
  for (const m of session.members.values()) {
    if (m.userId === userId) return m;
  }
  return undefined;
}

function broadcastToOthers(
  ctx: CoViewContext,
  session: CoViewSessionInternal,
  excludeConnectionId: string,
  frame: unknown,
): void {
  for (const m of session.members.values()) {
    if (m.sessionId === excludeConnectionId) continue;
    ctx.deps.sendToConnection(m.sessionId, frame);
  }
}

function sendStartNak(
  ctx: CoViewContext,
  connectionId: string,
  code: WsCoViewStartNak["code"],
  message: string,
): void {
  const nak: WsCoViewStartNak = { type: "co-view.start.nak", code, message };
  ctx.deps.sendToConnection(connectionId, nak);
}

function sendUpdateNak(
  ctx: CoViewContext,
  connectionId: string,
  sessionId: string,
  code: WsCoViewUpdateNak["code"],
  message: string,
): void {
  const nak: WsCoViewUpdateNak = {
    type: "co-view.update.nak",
    session_id: sessionId,
    code,
    message,
  };
  ctx.deps.sendToConnection(connectionId, nak);
}

function sendJoinNak(
  ctx: CoViewContext,
  connectionId: string,
  sessionId: string,
  code: WsCoViewJoinNak["code"],
  message: string,
): void {
  const nak: WsCoViewJoinNak = {
    type: "co-view.join.nak",
    session_id: sessionId,
    code,
    message,
  };
  ctx.deps.sendToConnection(connectionId, nak);
}

function sendKickNak(
  ctx: CoViewContext,
  connectionId: string,
  sessionId: string,
  code: WsCoViewKickNak["code"],
  message: string,
): void {
  const nak: WsCoViewKickNak = {
    type: "co-view.kick.nak",
    session_id: sessionId,
    code,
    message,
  };
  ctx.deps.sendToConnection(connectionId, nak);
}

function sendJoinAckForExisting(
  ctx: CoViewContext,
  connectionId: string,
  session: CoViewSessionInternal,
  userId: string,
): void {
  const member = session.members.get(connectionId);
  const color = member?.color ?? pickMemberColor(session.id, userId);
  const ack: WsCoViewJoinAck = {
    type: "co-view.join.ack",
    session_id: session.id,
    host_user_id: session.hostUserId,
    render_mode: session.renderMode,
    viewer_color: color,
    current_state_snapshot: snapshotForJoinAck(session),
  };
  ctx.deps.sendToConnection(connectionId, ack);
}

// ---------------------------------------------------------------------------
// Payload validation helpers
// ---------------------------------------------------------------------------

function validateStartPayload(
  msg: WsCoViewStartReq,
): { ok: true } | { ok: false; message: string } {
  if (msg.visibility !== "public" && msg.visibility !== "private") {
    return { ok: false, message: `visibility must be "public" or "private".` };
  }
  if (msg.render_mode !== "as-host" && msg.render_mode !== "as-viewer") {
    return { ok: false, message: `render_mode must be "as-host" or "as-viewer".` };
  }
  if (!Array.isArray(msg.whitelist) || !msg.whitelist.every((s) => typeof s === "string")) {
    return { ok: false, message: "whitelist must be an array of user ids." };
  }
  if (!Array.isArray(msg.blacklist) || !msg.blacklist.every((s) => typeof s === "string")) {
    return { ok: false, message: "blacklist must be an array of user ids." };
  }
  const r = validateRedactions(msg.redactions);
  if (!r.ok) return r;
  return { ok: true };
}

function validateRedactions(
  redactions: CoViewRedactions,
): { ok: true } | { ok: false; message: string } {
  if (
    !redactions ||
    !Array.isArray(redactions.panel_ids) ||
    !Array.isArray(redactions.plugin_slugs) ||
    !Array.isArray(redactions.custom_selectors)
  ) {
    return {
      ok: false,
      message: "redactions must have panel_ids, plugin_slugs, custom_selectors arrays.",
    };
  }
  if (redactions.custom_selectors.length > CO_VIEW_LIMITS.CUSTOM_SELECTORS_MAX) {
    return {
      ok: false,
      message: `redactions.custom_selectors exceeds ${String(CO_VIEW_LIMITS.CUSTOM_SELECTORS_MAX)} entries.`,
    };
  }
  for (const sel of redactions.custom_selectors) {
    if (typeof sel !== "string") {
      return { ok: false, message: "redactions.custom_selectors entries must be strings." };
    }
    if (sel.length > CO_VIEW_LIMITS.CUSTOM_SELECTOR_LENGTH_MAX) {
      return {
        ok: false,
        message: `redactions.custom_selectors entry exceeds ${String(CO_VIEW_LIMITS.CUSTOM_SELECTOR_LENGTH_MAX)} chars.`,
      };
    }
  }
  return { ok: true };
}

function toInternalRedactions(
  r: CoViewRedactions,
): CoViewRedactionsInternal {
  return {
    panelIds: new Set(r.panel_ids),
    pluginSlugs: new Set(r.plugin_slugs),
    customSelectors: [...r.custom_selectors],
  };
}

/**
 * Project the session's cumulative safe-state snapshot into the
 * `join.ack.current_state_snapshot` field. Returns `null` (not `{}`) when
 * the host has not yet pushed any safe state — the viewer's consumer
 * differentiates "no snapshot yet, wait for first state frame" from
 * "snapshot exists but is empty" via this null sentinel (spec §Wire
 * Protocol → Snapshot — initial join).
 *
 * Returns a shallow copy so the wire frame is not aliased to the live
 * session object — subsequent diffs would otherwise mutate what the WS
 * codec is mid-encoding.
 */
function snapshotForJoinAck(
  session: CoViewSessionInternal,
): import("@uncorded/protocol").CoViewStateSnapshot | null {
  if (session.lastSeq < 0) return null;
  return { ...session.safeStateSnapshot };
}

