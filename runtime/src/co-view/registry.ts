// CoViewRegistry — in-memory session store for spec-27 Co-View Sessions.
//
// Ephemeral, single-process. Nothing here persists across runtime restart;
// the spec mandates that explicitly (§Locked Decisions, §The Co-View Session
// Record). Three indexes are kept in lockstep so the WS-close path can
// answer "what does this connection drop?" in O(k) instead of scanning every
// session:
//
//   byId:                Map<sessionId, CoViewSessionInternal>
//   byHostConnection:    Map<hostConnectionId, sessionId>   (one host per WS)
//   bySessionConnection: Map<wsConnId, Set<sessionId>>      (viewers + host)
//
// Co-View piggybacks on scoped presence for membership broadcast (spec §"Co-
// View piggybacks on scoped presence"), but the registry still owns the
// authoritative session record — presence is downstream of these mutations.

import type {
  CoViewMemberInternal,
  CoViewSessionInternal,
} from "./types";

export class CoViewRegistry {
  private readonly byId = new Map<string, CoViewSessionInternal>();
  private readonly byHostConnection = new Map<string, string>();
  private readonly bySessionConnection = new Map<string, Set<string>>();

  size(): number {
    return this.byId.size;
  }

  has(sessionId: string): boolean {
    return this.byId.has(sessionId);
  }

  get(sessionId: string): CoViewSessionInternal | undefined {
    return this.byId.get(sessionId);
  }

  /** Snapshot of every session — defensive copy of values only (records mutable). */
  list(): CoViewSessionInternal[] {
    return [...this.byId.values()];
  }

  /** The session this WS connection currently hosts, if any. */
  getSessionHostedBy(connectionId: string): CoViewSessionInternal | undefined {
    const id = this.byHostConnection.get(connectionId);
    return id === undefined ? undefined : this.byId.get(id);
  }

  /** Every session this WS connection participates in (host or viewer). */
  sessionsForConnection(connectionId: string): readonly string[] {
    const set = this.bySessionConnection.get(connectionId);
    return set ? [...set] : [];
  }

  /**
   * Insert a freshly-started session. Caller must have already verified the
   * host is not already hosting another session via `getSessionHostedBy`.
   */
  insertSession(session: CoViewSessionInternal): void {
    this.byId.set(session.id, session);
    this.byHostConnection.set(session.hostSessionId, session.id);
    this.linkConnection(session.hostSessionId, session.id);
  }

  /**
   * Delete the session entirely. Returns the dropped session record so the
   * caller can drive teardown broadcasts. Idempotent — returns undefined if
   * the session was already gone.
   */
  deleteSession(sessionId: string): CoViewSessionInternal | undefined {
    const session = this.byId.get(sessionId);
    if (!session) return undefined;
    this.byId.delete(sessionId);
    this.byHostConnection.delete(session.hostSessionId);
    for (const member of session.members.values()) {
      this.unlinkConnection(member.sessionId, sessionId);
    }
    return session;
  }

  /**
   * Register the host's reconnection — moves the host connection mapping
   * onto a new WS connection id. Called when a returning host re-claims a
   * session during the grace window. Returns true if the move happened.
   *
   * NOTE: PR-CV1 does not yet implement host reconnection; the hook is here
   * so the index stays correct once PR-CV2+ wires the reconnect path. The
   * registry's only responsibility is keeping its indexes consistent.
   */
  rebindHostConnection(sessionId: string, newConnectionId: string): boolean {
    const session = this.byId.get(sessionId);
    if (!session) return false;
    const oldConn = session.hostSessionId;
    if (oldConn === newConnectionId) return false;
    this.byHostConnection.delete(oldConn);
    this.unlinkConnection(oldConn, sessionId);

    session.hostSessionId = newConnectionId;
    this.byHostConnection.set(newConnectionId, sessionId);
    this.linkConnection(newConnectionId, sessionId);

    // The host's member record is keyed by WS session_id — keep it in sync.
    const hostMember = [...session.members.values()].find((m) => m.role === "host");
    if (hostMember) {
      session.members.delete(hostMember.sessionId);
      hostMember.sessionId = newConnectionId;
      session.members.set(newConnectionId, hostMember);
    }
    return true;
  }

  /** Add a viewer to an existing session. No-op if already a member. */
  addMember(sessionId: string, member: CoViewMemberInternal): boolean {
    const session = this.byId.get(sessionId);
    if (!session) return false;
    if (session.members.has(member.sessionId)) return false;
    session.members.set(member.sessionId, member);
    if (member.role === "viewer") {
      const viewerCount = countViewers(session);
      if (viewerCount > session.peakViewers) {
        session.peakViewers = viewerCount;
      }
    }
    this.linkConnection(member.sessionId, sessionId);
    return true;
  }

  /**
   * Remove a member by WS session_id. Returns the removed member or
   * undefined if no match. Does NOT delete the session even when the host
   * is removed — the caller decides whether to tear down based on role.
   *
   * Also evicts the leaving member's entries from the cursor map and the
   * three rate-limit maps so they don't leak across long-lived sessions.
   * The clear-coalesce map is keyed by `${memberId}|${scope}` — we sweep all
   * matching prefixes since it's a small map and a leaving member's entries
   * are no longer load-bearing.
   */
  removeMember(
    sessionId: string,
    connectionId: string,
  ): CoViewMemberInternal | undefined {
    const session = this.byId.get(sessionId);
    if (!session) return undefined;
    const member = session.members.get(connectionId);
    if (!member) return undefined;
    session.members.delete(connectionId);
    session.cursors.delete(connectionId);
    session.rateLimits.cursor.delete(connectionId);
    session.rateLimits.penPoint.delete(connectionId);
    session.rateLimits.penBegin.delete(connectionId);
    const clearPrefix = `${connectionId}|`;
    for (const key of session.lastClearTs.keys()) {
      if (key.startsWith(clearPrefix)) session.lastClearTs.delete(key);
    }
    this.unlinkConnection(connectionId, sessionId);
    return member;
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private linkConnection(connectionId: string, sessionId: string): void {
    let set = this.bySessionConnection.get(connectionId);
    if (!set) {
      set = new Set();
      this.bySessionConnection.set(connectionId, set);
    }
    set.add(sessionId);
  }

  private unlinkConnection(connectionId: string, sessionId: string): void {
    const set = this.bySessionConnection.get(connectionId);
    if (!set) return;
    set.delete(sessionId);
    if (set.size === 0) this.bySessionConnection.delete(connectionId);
  }

  /** Read-only views for tests / observability. */
  asReadOnly(): {
    sessions: ReadonlyMap<string, CoViewSessionInternal>;
    sessionByHostConnection: ReadonlyMap<string, string>;
  } {
    return {
      sessions: this.byId,
      sessionByHostConnection: this.byHostConnection,
    };
  }
}

export function countViewers(session: CoViewSessionInternal): number {
  let n = 0;
  for (const m of session.members.values()) {
    if (m.role === "viewer") n += 1;
  }
  return n;
}
