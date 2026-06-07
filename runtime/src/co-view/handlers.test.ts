import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { rootLogger } from "@uncorded/shared";
import { EventBus } from "../events/bus";
import { RateLimiter } from "../http/rate-limiter";
import { ScopedPresenceModule } from "../presence";
import type { PluginTransportProvider } from "../events/types";
import type { IpcMessage } from "../ipc/transport";
import type { CoreModule } from "../core";
import type { RolesEngine } from "../roles/engine";
import type { AuthenticatedUser } from "../ws/types";
import type {
  WsCoViewEndAck,
  WsCoViewEnded,
  WsCoViewEvent,
  WsCoViewJoinAck,
  WsCoViewJoinNak,
  WsCoViewKickAck,
  WsCoViewKickNak,
  WsCoViewLeaveAck,
  WsCoViewMemberJoined,
  WsCoViewMemberLeft,
  WsCoViewSnapshotReq,
  WsCoViewSnapshotRes,
  WsCoViewStartAck,
  WsCoViewStartNak,
  WsCoViewState,
  WsCoViewUpdateAck,
  WsCoViewUpdateNak,
  WsCoViewStartReq,
  WsCoViewUpdateReq,
  WsCoViewEndReq,
  WsCoViewJoinReq,
  WsCoViewLeaveReq,
  WsCoViewKickReq,
} from "@uncorded/protocol";
import { startCoView } from "./register";
import { CO_VIEW_LIMITS } from "./types";
import type { CoViewClientMessage, CoViewDeps, CoViewHandle } from "./types";

// ---------------------------------------------------------------------------
// Schema — inline so the tests are self-contained (mirrors the terminals
// test harness pattern).
// ---------------------------------------------------------------------------

// Mirrors runtime/src/roles/migrations/002_admin_tables.sql exactly so the
// NOT NULL constraints in production are exercised in tests too. An earlier
// version of this schema let actor_user_id be NULL; that drift hid a bug
// where the host-disconnect grace path wrote `null` and crashed the runtime
// in prod.
const SCHEMA_AUDIT = `
  CREATE TABLE IF NOT EXISTS admin_audit_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    ts            INTEGER NOT NULL,
    actor_user_id TEXT    NOT NULL,
    actor_role    TEXT    NOT NULL,
    action        TEXT    NOT NULL,
    target_type   TEXT,
    target_id     TEXT,
    payload_json  TEXT    NOT NULL
  );
`;

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

interface Sent {
  to: string;
  msg: { type: string } & Record<string, unknown>;
}

interface PendingTimer {
  id: number;
  fn: () => void;
  ms: number;
  fireAt: number;
  canceled: boolean;
}

interface VirtualClock {
  now: () => number;
  advance: (ms: number) => void;
  setTimer: (fn: () => void, ms: number) => PendingTimer;
  clearTimer: (handle: PendingTimer) => void;
  pending: () => PendingTimer[];
}

function makeClock(): VirtualClock {
  let t = 1_000;
  let nextId = 1;
  const timers = new Set<PendingTimer>();
  return {
    now: () => t,
    advance(ms) {
      t += ms;
      const due = [...timers].filter((p) => !p.canceled && p.fireAt <= t);
      due.sort((a, b) => a.fireAt - b.fireAt);
      for (const p of due) {
        timers.delete(p);
        if (!p.canceled) p.fn();
      }
    },
    setTimer(fn, ms) {
      const p: PendingTimer = {
        id: nextId++,
        fn,
        ms,
        fireAt: t + ms,
        canceled: false,
      };
      timers.add(p);
      return p;
    },
    clearTimer(handle) {
      handle.canceled = true;
      timers.delete(handle);
    },
    pending: () => [...timers].filter((p) => !p.canceled),
  };
}

interface HarnessOpts {
  /** Permissions check default — true unless overridden via setPermission. */
  defaultAllow?: boolean;
}

interface Harness {
  handle: CoViewHandle;
  db: Database;
  sent: Sent[];
  clock: VirtualClock;
  presence: ScopedPresenceModule;
  publishedRuntime: Array<{ topic: string; payload: unknown }>;
  setUser: (connId: string, user: AuthenticatedUser) => void;
  setPermission: (userId: string, key: string, allow: boolean) => void;
  setSessionIdSequence: (ids: string[]) => void;
  dispose: () => void;
}

function makeUser(id: string, role = "member"): AuthenticatedUser {
  return { id, username: id, displayName: id, avatarUrl: "", role };
}

function makeHarness(opts: HarnessOpts = {}): Harness {
  const db = new Database(":memory:");
  db.run(SCHEMA_AUDIT);

  const sent: Sent[] = [];
  const users = new Map<string, AuthenticatedUser>();
  const perms = new Map<string, boolean>();
  const log = rootLogger.child({ test: "co-view" });
  const clock = makeClock();

  // Build a real event bus + presence module — verifying the presence-scope
  // integration is part of PR-CV1's acceptance.
  const sentByPlugin = new Map<string, IpcMessage[]>();
  const transportProvider: PluginTransportProvider = {
    getTransport(slug: string) {
      let arr = sentByPlugin.get(slug);
      if (!arr) {
        arr = [];
        sentByPlugin.set(slug, arr);
      }
      return {
        send(msg: IpcMessage) {
          arr!.push(msg);
        },
        onMessage() {},
        close() {},
      } as unknown as ReturnType<PluginTransportProvider["getTransport"]>;
    },
    isPluginAlive: () => true,
  };
  const eventBus = new EventBus(transportProvider);
  const publishedRuntime: Array<{ topic: string; payload: unknown }> = [];
  const origPublish = eventBus.publishRuntime.bind(eventBus);
  eventBus.publishRuntime = (topic: string, payload: unknown, version?: number) => {
    publishedRuntime.push({ topic, payload });
    return origPublish(topic, payload, version);
  };

  const rateLimiter = new RateLimiter(clock.now);
  const presence = new ScopedPresenceModule(eventBus, rateLimiter, log, {
    installedSlugs: () => new Set<string>(),
    now: clock.now,
  });

  const rolesEngine: RolesEngine = {
    check: (userId: string, key: string, caller: { isOwner: boolean }) => {
      if (caller.isOwner) return true;
      const explicit = perms.get(`${userId}|${key}`);
      if (explicit !== undefined) return explicit;
      return opts.defaultAllow ?? true;
    },
    getRole: () => ({ name: "member", level: 0 }),
  } as unknown as RolesEngine;

  let sessionIdSeq: string[] = [];
  let sessionIdIdx = 0;

  const deps: CoViewDeps = {
    db,
    logger: log,
    eventBus,
    coreModule: {} as unknown as CoreModule,
    rolesEngine,
    presenceModule: presence,
    serverId: "srv-test",
    sendToConnection: (connectionId, msg) =>
      sent.push({ to: connectionId, msg: msg as Sent["msg"] }),
    getConnectedUser: (connectionId) => users.get(connectionId),
    now: clock.now,
    setTimeout: (fn, ms) => clock.setTimer(fn, ms) as unknown as ReturnType<typeof setTimeout>,
    clearTimeout: (h) => clock.clearTimer(h as unknown as PendingTimer),
    generateSessionId: () => {
      if (sessionIdIdx < sessionIdSeq.length) {
        return sessionIdSeq[sessionIdIdx++]!;
      }
      return `sess-${String(sessionIdIdx++)}`;
    },
  };

  const handle = startCoView(deps);

  return {
    handle,
    db,
    sent,
    clock,
    presence,
    publishedRuntime,
    setUser: (connId, user) => {
      users.set(connId, user);
      presence.registerSession(connId);
    },
    setPermission: (userId, key, allow) => {
      perms.set(`${userId}|${key}`, allow);
    },
    setSessionIdSequence: (ids) => {
      sessionIdSeq = ids;
      sessionIdIdx = 0;
    },
    dispose: () => {
      handle.dispose();
      db.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Frame builders
// ---------------------------------------------------------------------------

function startReq(opts: Partial<WsCoViewStartReq> = {}): WsCoViewStartReq {
  return {
    type: "co-view.start.req",
    visibility: opts.visibility ?? "private",
    whitelist: opts.whitelist ?? [],
    blacklist: opts.blacklist ?? [],
    render_mode: opts.render_mode ?? "as-host",
    redactions: opts.redactions ?? {
      panel_ids: [],
      plugin_slugs: [],
      custom_selectors: [],
    },
  };
}

function joinReq(sessionId: string): WsCoViewJoinReq {
  return { type: "co-view.join.req", session_id: sessionId };
}

function leaveReq(sessionId: string): WsCoViewLeaveReq {
  return { type: "co-view.leave.req", session_id: sessionId };
}

function endReq(sessionId: string): WsCoViewEndReq {
  return { type: "co-view.end.req", session_id: sessionId };
}

function kickReq(sessionId: string, targetUserId: string): WsCoViewKickReq {
  return {
    type: "co-view.kick.req",
    session_id: sessionId,
    target_user_id: targetUserId,
  };
}

function updateReq(
  sessionId: string,
  patch: Partial<WsCoViewUpdateReq> = {},
): WsCoViewUpdateReq {
  return {
    type: "co-view.update.req",
    session_id: sessionId,
    ...patch,
  };
}

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

function findFirst<T extends { type: string }>(
  sent: Sent[],
  type: T["type"],
  to?: string,
): T | undefined {
  for (const s of sent) {
    if (s.msg.type === type && (to === undefined || s.to === to)) {
      return s.msg as unknown as T;
    }
  }
  return undefined;
}

function findAll<T extends { type: string }>(
  sent: Sent[],
  type: T["type"],
  to?: string,
): T[] {
  const out: T[] = [];
  for (const s of sent) {
    if (s.msg.type === type && (to === undefined || s.to === to)) {
      out.push(s.msg as unknown as T);
    }
  }
  return out;
}

function auditActions(db: Database): string[] {
  return db
    .query<{ action: string }, []>("SELECT action FROM admin_audit_log ORDER BY id ASC")
    .all()
    .map((r) => r.action);
}

async function dispatch(
  harness: Harness,
  connectionId: string,
  msg: CoViewClientMessage,
): Promise<void> {
  await harness.handle.dispatch(connectionId, msg);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let h: Harness;

beforeEach(() => {
  h = makeHarness();
});

afterEach(() => {
  h.dispose();
});

// ---------------------------------------------------------------------------
// start.req
// ---------------------------------------------------------------------------

describe("co-view.start.req", () => {
  test("happy path: ack + presence join + audit + runtime event", async () => {
    h.setUser("c-host", makeUser("u-host"));
    h.setSessionIdSequence(["sess-A"]);

    await dispatch(h, "c-host", startReq({ visibility: "public" }));

    const ack = findFirst<WsCoViewStartAck>(h.sent, "co-view.start.ack", "c-host");
    expect(ack).toBeDefined();
    expect(ack!.session_id).toBe("sess-A");
    expect(typeof ack!.host_color).toBe("string");

    // Audit
    expect(auditActions(h.db)).toContain("co_view.session_started");

    // Runtime event published
    expect(h.publishedRuntime.some((e) => e.topic === "runtime.co-view.session.started")).toBe(true);

    // Presence: host now present in co-view.session.sess-A
    const list = h.presence.list("co-view", "session.sess-A");
    expect(list.ok).toBe(true);
    if (list.ok) {
      expect(list.value).toHaveLength(1);
      expect(list.value[0]!.user_id).toBe("u-host");
    }
  });

  test("permission_denied when canHostCoView returns false", async () => {
    h.setUser("c-host", makeUser("u-host"));
    h.setPermission("u-host", "co-view.host", false);

    await dispatch(h, "c-host", startReq());

    const nak = findFirst<WsCoViewStartNak>(h.sent, "co-view.start.nak", "c-host");
    expect(nak?.code).toBe("permission_denied");
    expect(findFirst(h.sent, "co-view.start.ack")).toBeUndefined();
    expect(auditActions(h.db)).toContain("co_view.permission_denied");
  });

  test("already_hosting if this connection started a session", async () => {
    h.setUser("c-host", makeUser("u-host"));
    h.setSessionIdSequence(["sess-A", "sess-B"]);

    await dispatch(h, "c-host", startReq());
    await dispatch(h, "c-host", startReq());

    const naks = findAll<WsCoViewStartNak>(h.sent, "co-view.start.nak", "c-host");
    expect(naks).toHaveLength(1);
    expect(naks[0]!.code).toBe("already_hosting");
  });

  test("invalid_payload on bad visibility", async () => {
    h.setUser("c-host", makeUser("u-host"));
    const bad = { ...startReq(), visibility: "secret" } as unknown as WsCoViewStartReq;
    await dispatch(h, "c-host", bad);
    const nak = findFirst<WsCoViewStartNak>(h.sent, "co-view.start.nak", "c-host");
    expect(nak?.code).toBe("invalid_payload");
  });

  test("invalid_payload when custom_selectors exceeds cap", async () => {
    h.setUser("c-host", makeUser("u-host"));
    const tooMany = Array.from({ length: CO_VIEW_LIMITS.CUSTOM_SELECTORS_MAX + 1 }, (_, i) => `#x${String(i)}`);
    await dispatch(
      h,
      "c-host",
      startReq({
        redactions: {
          panel_ids: [],
          plugin_slugs: [],
          custom_selectors: tooMany,
        },
      }),
    );
    const nak = findFirst<WsCoViewStartNak>(h.sent, "co-view.start.nak", "c-host");
    expect(nak?.code).toBe("invalid_payload");
  });

  test("owner bypass: owner role hosts without explicit permission", async () => {
    h.setUser("c-host", makeUser("u-owner", "owner"));
    h.setPermission("u-owner", "co-view.host", false);
    h.setSessionIdSequence(["sess-O"]);
    await dispatch(h, "c-host", startReq());
    expect(findFirst(h.sent, "co-view.start.ack", "c-host")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// join.req
// ---------------------------------------------------------------------------

describe("co-view.join.req", () => {
  async function hostStart(opts: {
    visibility?: "public" | "private";
    whitelist?: string[];
    blacklist?: string[];
  } = {}): Promise<string> {
    h.setUser("c-host", makeUser("u-host"));
    h.setSessionIdSequence(["sess-J"]);
    await dispatch(h, "c-host", startReq(opts));
    return "sess-J";
  }

  test("session_not_found when session id is unknown", async () => {
    h.setUser("c-v", makeUser("u-v"));
    await dispatch(h, "c-v", joinReq("nope"));
    const nak = findFirst<WsCoViewJoinNak>(h.sent, "co-view.join.nak", "c-v");
    expect(nak?.code).toBe("session_not_found");
  });

  test("private + whitelist: only whitelisted users join", async () => {
    const sid = await hostStart({ visibility: "private", whitelist: ["u-good"] });

    h.setUser("c-good", makeUser("u-good"));
    h.setUser("c-bad", makeUser("u-bad"));

    await dispatch(h, "c-good", joinReq(sid));
    await dispatch(h, "c-bad", joinReq(sid));

    const goodAck = findFirst<WsCoViewJoinAck>(h.sent, "co-view.join.ack", "c-good");
    expect(goodAck?.host_user_id).toBe("u-host");
    expect(goodAck?.current_state_snapshot).toBeNull();

    const badNak = findFirst<WsCoViewJoinNak>(h.sent, "co-view.join.nak", "c-bad");
    expect(badNak?.code).toBe("not_invited");
  });

  test("public + blacklist: blacklisted user rejected", async () => {
    const sid = await hostStart({ visibility: "public", blacklist: ["u-bad"] });

    h.setUser("c-bad", makeUser("u-bad"));
    await dispatch(h, "c-bad", joinReq(sid));

    const nak = findFirst<WsCoViewJoinNak>(h.sent, "co-view.join.nak", "c-bad");
    expect(nak?.code).toBe("blacklisted");
  });

  test("broadcasts member.joined to other members but not the joiner", async () => {
    const sid = await hostStart({ visibility: "public" });
    h.setUser("c-v1", makeUser("u-v1"));
    h.setUser("c-v2", makeUser("u-v2"));

    await dispatch(h, "c-v1", joinReq(sid));
    h.sent.length = 0;
    await dispatch(h, "c-v2", joinReq(sid));

    // u-v2 should receive their own join.ack (not member.joined).
    expect(findFirst(h.sent, "co-view.member.joined", "c-v2")).toBeUndefined();
    // u-host and u-v1 should each receive member.joined for u-v2.
    expect(findFirst<WsCoViewMemberJoined>(h.sent, "co-view.member.joined", "c-host")?.user_id).toBe("u-v2");
    expect(findFirst<WsCoViewMemberJoined>(h.sent, "co-view.member.joined", "c-v1")?.user_id).toBe("u-v2");
  });

  test("hard cap rejects at HARD_VIEWER_CAP", async () => {
    const sid = await hostStart({ visibility: "public" });
    // Pre-populate to capacity. Inject viewers directly via the registry would
    // bypass handlers; the simpler path is to drive joins.
    for (let i = 0; i < CO_VIEW_LIMITS.HARD_VIEWER_CAP; i++) {
      const cid = `c-v${String(i)}`;
      h.setUser(cid, makeUser(`u-v${String(i)}`));
      await dispatch(h, cid, joinReq(sid));
    }
    h.sent.length = 0;

    h.setUser("c-overflow", makeUser("u-overflow"));
    await dispatch(h, "c-overflow", joinReq(sid));

    const nak = findFirst<WsCoViewJoinNak>(h.sent, "co-view.join.nak", "c-overflow");
    expect(nak?.code).toBe("session_full");
  });

  test("soft cap: warning audited once after crossing SOFT_VIEWER_CAP", async () => {
    const sid = await hostStart({ visibility: "public" });
    for (let i = 0; i < CO_VIEW_LIMITS.SOFT_VIEWER_CAP + 1; i++) {
      const cid = `c-soft${String(i)}`;
      h.setUser(cid, makeUser(`u-soft${String(i)}`));
      await dispatch(h, cid, joinReq(sid));
    }
    expect(auditActions(h.db).filter((a) => a === "co_view.soft_cap_exceeded")).toHaveLength(1);

    // One more join should NOT re-audit the warning.
    h.setUser("c-soft-extra", makeUser("u-soft-extra"));
    await dispatch(h, "c-soft-extra", joinReq(sid));
    expect(auditActions(h.db).filter((a) => a === "co_view.soft_cap_exceeded")).toHaveLength(1);
  });

  test("host re-joining own session is idempotent ack", async () => {
    const sid = await hostStart();
    h.sent.length = 0;
    await dispatch(h, "c-host", joinReq(sid));
    const ack = findFirst<WsCoViewJoinAck>(h.sent, "co-view.join.ack", "c-host");
    expect(ack?.session_id).toBe(sid);
    // No member.joined broadcast was emitted for the host.
    expect(findAll(h.sent, "co-view.member.joined")).toHaveLength(0);
  });

  test("owner bypasses private whitelist", async () => {
    const sid = await hostStart({ visibility: "private", whitelist: [] });
    h.setUser("c-owner", makeUser("u-owner", "owner"));
    await dispatch(h, "c-owner", joinReq(sid));
    expect(findFirst<WsCoViewJoinAck>(h.sent, "co-view.join.ack", "c-owner")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// leave.req
// ---------------------------------------------------------------------------

describe("co-view.leave.req", () => {
  test("viewer leave: ack + member.left broadcast to remaining", async () => {
    h.setUser("c-host", makeUser("u-host"));
    h.setSessionIdSequence(["sess-L"]);
    await dispatch(h, "c-host", startReq({ visibility: "public" }));

    h.setUser("c-v", makeUser("u-v"));
    await dispatch(h, "c-v", joinReq("sess-L"));
    h.sent.length = 0;

    await dispatch(h, "c-v", leaveReq("sess-L"));

    expect(findFirst<WsCoViewLeaveAck>(h.sent, "co-view.leave.ack", "c-v")).toBeDefined();
    // Host should be notified that the viewer left.
    const left = findFirst<WsCoViewMemberLeft>(h.sent, "co-view.member.left", "c-host");
    expect(left?.user_id).toBe("u-v");
    expect(left?.reason).toBe("explicit");
    // Leaver does NOT get a member.left for an explicit leave (they got the ack).
    expect(findFirst(h.sent, "co-view.member.left", "c-v")).toBeUndefined();
  });

  test("host leave = ends session and broadcasts co-view.ended", async () => {
    h.setUser("c-host", makeUser("u-host"));
    h.setSessionIdSequence(["sess-HL"]);
    await dispatch(h, "c-host", startReq({ visibility: "public" }));
    h.setUser("c-v", makeUser("u-v"));
    await dispatch(h, "c-v", joinReq("sess-HL"));
    h.sent.length = 0;

    await dispatch(h, "c-host", leaveReq("sess-HL"));

    expect(findFirst<WsCoViewLeaveAck>(h.sent, "co-view.leave.ack", "c-host")).toBeDefined();
    expect(findFirst<WsCoViewEnded>(h.sent, "co-view.ended", "c-v")?.reason).toBe("host_ended");
    expect(h.handle._internals().sessions.has("sess-HL")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// end.req
// ---------------------------------------------------------------------------

describe("co-view.end.req", () => {
  test("host ends: end.ack + presence-leave + co-view.ended broadcast", async () => {
    h.setUser("c-host", makeUser("u-host"));
    h.setSessionIdSequence(["sess-E"]);
    await dispatch(h, "c-host", startReq({ visibility: "public" }));
    h.setUser("c-v", makeUser("u-v"));
    await dispatch(h, "c-v", joinReq("sess-E"));
    h.sent.length = 0;

    await dispatch(h, "c-host", endReq("sess-E"));

    expect(findFirst<WsCoViewEndAck>(h.sent, "co-view.end.ack", "c-host")).toBeDefined();
    expect(findFirst<WsCoViewEnded>(h.sent, "co-view.ended", "c-host")?.reason).toBe("host_ended");
    expect(findFirst<WsCoViewEnded>(h.sent, "co-view.ended", "c-v")?.reason).toBe("host_ended");

    // Presence cleared.
    const list = h.presence.list("co-view", "session.sess-E");
    expect(list.ok).toBe(true);
    if (list.ok) expect(list.value).toHaveLength(0);
  });

  test("non-host end is silently dropped", async () => {
    h.setUser("c-host", makeUser("u-host"));
    h.setSessionIdSequence(["sess-DROP"]);
    await dispatch(h, "c-host", startReq({ visibility: "public" }));
    h.setUser("c-v", makeUser("u-v"));
    await dispatch(h, "c-v", joinReq("sess-DROP"));
    h.sent.length = 0;

    await dispatch(h, "c-v", endReq("sess-DROP"));

    expect(findFirst(h.sent, "co-view.end.ack")).toBeUndefined();
    expect(findFirst(h.sent, "co-view.ended")).toBeUndefined();
    expect(h.handle._internals().sessions.has("sess-DROP")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// kick.req
// ---------------------------------------------------------------------------

describe("co-view.kick.req", () => {
  test("host kicks a viewer: ack + member.left(kicked) to remaining + leaver", async () => {
    h.setUser("c-host", makeUser("u-host"));
    h.setSessionIdSequence(["sess-K"]);
    await dispatch(h, "c-host", startReq({ visibility: "public" }));
    h.setUser("c-v", makeUser("u-v"));
    await dispatch(h, "c-v", joinReq("sess-K"));
    h.sent.length = 0;

    await dispatch(h, "c-host", kickReq("sess-K", "u-v"));

    expect(findFirst<WsCoViewKickAck>(h.sent, "co-view.kick.ack", "c-host")).toBeDefined();
    // Leaver gets notified for involuntary departure.
    expect(findFirst<WsCoViewMemberLeft>(h.sent, "co-view.member.left", "c-v")?.reason).toBe("kicked");
    expect(auditActions(h.db)).toContain("co_view.member_kicked");
  });

  test("non-host without moderate permission: not_host_or_moderator", async () => {
    h.setUser("c-host", makeUser("u-host"));
    h.setSessionIdSequence(["sess-K2"]);
    await dispatch(h, "c-host", startReq({ visibility: "public" }));
    h.setUser("c-v1", makeUser("u-v1"));
    h.setUser("c-v2", makeUser("u-v2"));
    h.setPermission("u-v1", "co-view.moderate", false);
    await dispatch(h, "c-v1", joinReq("sess-K2"));
    await dispatch(h, "c-v2", joinReq("sess-K2"));
    h.sent.length = 0;

    await dispatch(h, "c-v1", kickReq("sess-K2", "u-v2"));
    const nak = findFirst<WsCoViewKickNak>(h.sent, "co-view.kick.nak", "c-v1");
    expect(nak?.code).toBe("not_host_or_moderator");
  });

  test("target_not_in_session when target is absent", async () => {
    h.setUser("c-host", makeUser("u-host"));
    h.setSessionIdSequence(["sess-K3"]);
    await dispatch(h, "c-host", startReq({ visibility: "public" }));
    h.sent.length = 0;
    await dispatch(h, "c-host", kickReq("sess-K3", "u-ghost"));
    const nak = findFirst<WsCoViewKickNak>(h.sent, "co-view.kick.nak", "c-host");
    expect(nak?.code).toBe("target_not_in_session");
  });

  test("moderator kicking the host ends the session", async () => {
    h.setUser("c-host", makeUser("u-host"));
    h.setSessionIdSequence(["sess-K4"]);
    await dispatch(h, "c-host", startReq({ visibility: "public" }));
    h.setUser("c-mod", makeUser("u-mod"));
    h.setPermission("u-mod", "co-view.moderate", true);
    await dispatch(h, "c-mod", joinReq("sess-K4"));
    h.sent.length = 0;

    await dispatch(h, "c-mod", kickReq("sess-K4", "u-host"));

    expect(findFirst<WsCoViewEnded>(h.sent, "co-view.ended", "c-host")?.reason).toBe("host_ended");
    expect(h.handle._internals().sessions.has("sess-K4")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// update.req
// ---------------------------------------------------------------------------

describe("co-view.update.req", () => {
  test("non-host update: not_host", async () => {
    h.setUser("c-host", makeUser("u-host"));
    h.setSessionIdSequence(["sess-U"]);
    await dispatch(h, "c-host", startReq({ visibility: "public" }));
    h.setUser("c-v", makeUser("u-v"));
    await dispatch(h, "c-v", joinReq("sess-U"));
    h.sent.length = 0;

    await dispatch(h, "c-v", updateReq("sess-U", { render_mode: "as-viewer" }));
    const nak = findFirst<WsCoViewUpdateNak>(h.sent, "co-view.update.nak", "c-v");
    expect(nak?.code).toBe("not_host");
  });

  test("auto-kicks members no longer matching new whitelist", async () => {
    h.setUser("c-host", makeUser("u-host"));
    h.setSessionIdSequence(["sess-AK"]);
    await dispatch(h, "c-host", startReq({ visibility: "private", whitelist: ["u-good", "u-cut"] }));

    h.setUser("c-good", makeUser("u-good"));
    h.setUser("c-cut", makeUser("u-cut"));
    await dispatch(h, "c-good", joinReq("sess-AK"));
    await dispatch(h, "c-cut", joinReq("sess-AK"));
    h.sent.length = 0;

    await dispatch(h, "c-host", updateReq("sess-AK", { whitelist: ["u-good"] }));

    // u-cut should be evicted with reason "no_longer_invited" and notified.
    const cutNotice = findFirst<WsCoViewMemberLeft>(h.sent, "co-view.member.left", "c-cut");
    expect(cutNotice?.reason).toBe("no_longer_invited");
    expect(findFirst<WsCoViewUpdateAck>(h.sent, "co-view.update.ack", "c-host")).toBeDefined();

    // Session still alive, u-good still a member.
    const internals = h.handle._internals();
    const sess = internals.sessions.get("sess-AK")!;
    expect([...sess.members.values()].some((m) => m.userId === "u-good")).toBe(true);
    expect([...sess.members.values()].some((m) => m.userId === "u-cut")).toBe(false);
  });

  test("auto-kicks blacklisted member mid-session on public", async () => {
    h.setUser("c-host", makeUser("u-host"));
    h.setSessionIdSequence(["sess-BL"]);
    await dispatch(h, "c-host", startReq({ visibility: "public" }));
    h.setUser("c-bad", makeUser("u-bad"));
    await dispatch(h, "c-bad", joinReq("sess-BL"));
    h.sent.length = 0;

    await dispatch(h, "c-host", updateReq("sess-BL", { blacklist: ["u-bad"] }));

    const notice = findFirst<WsCoViewMemberLeft>(h.sent, "co-view.member.left", "c-bad");
    expect(notice?.reason).toBe("blacklisted_mid_session");
  });
});

// ---------------------------------------------------------------------------
// Connection close
// ---------------------------------------------------------------------------

describe("onConnectionClose", () => {
  test("viewer disconnect: removed + member.left(session_closed) broadcast", async () => {
    h.setUser("c-host", makeUser("u-host"));
    h.setSessionIdSequence(["sess-C"]);
    await dispatch(h, "c-host", startReq({ visibility: "public" }));
    h.setUser("c-v", makeUser("u-v"));
    await dispatch(h, "c-v", joinReq("sess-C"));
    h.sent.length = 0;

    h.handle.onConnectionClose("c-v");

    const left = findFirst<WsCoViewMemberLeft>(h.sent, "co-view.member.left", "c-host");
    expect(left?.user_id).toBe("u-v");
    expect(left?.reason).toBe("session_closed");

    const sess = h.handle._internals().sessions.get("sess-C")!;
    expect([...sess.members.values()].some((m) => m.userId === "u-v")).toBe(false);
  });

  test("host disconnect arms grace timer; expiry ends session as host_lost", async () => {
    h.setUser("c-host", makeUser("u-host"));
    h.setSessionIdSequence(["sess-G"]);
    await dispatch(h, "c-host", startReq({ visibility: "public" }));
    h.setUser("c-v", makeUser("u-v"));
    await dispatch(h, "c-v", joinReq("sess-G"));
    h.sent.length = 0;

    h.handle.onConnectionClose("c-host");

    // Session still alive immediately after disconnect — grace window open.
    expect(h.handle._internals().sessions.has("sess-G")).toBe(true);
    expect(h.clock.pending()).toHaveLength(1);

    // Advance just before grace expiry — still alive.
    h.clock.advance(CO_VIEW_LIMITS.HOST_DISCONNECT_GRACE_MS - 1);
    expect(h.handle._internals().sessions.has("sess-G")).toBe(true);

    // Cross the boundary — timer fires, session ends as host_lost.
    h.clock.advance(2);
    expect(h.handle._internals().sessions.has("sess-G")).toBe(false);
    expect(findFirst<WsCoViewEnded>(h.sent, "co-view.ended", "c-v")?.reason).toBe("host_lost");

    // Regression: the grace-timer end path must record an audit row with a
    // non-null actor (the host). Earlier code passed `actorUserId: null`,
    // which crashed prod with NOT NULL constraint failed because the test
    // schema permissively allowed NULL while the migration did not.
    const endedRow = h.db
      .query<{ actor_user_id: string }, [string]>(
        "SELECT actor_user_id FROM admin_audit_log WHERE action = ? ORDER BY id DESC LIMIT 1",
      )
      .get("co_view.session_ended");
    expect(endedRow?.actor_user_id).toBe("u-host");
  });

  test("dispose clears pending grace timers", async () => {
    h.setUser("c-host", makeUser("u-host"));
    h.setSessionIdSequence(["sess-D"]);
    await dispatch(h, "c-host", startReq({ visibility: "public" }));

    h.handle.onConnectionClose("c-host");
    expect(h.clock.pending()).toHaveLength(1);

    h.handle.dispose();
    // Timer cleared — advancing past the grace window must not fire it.
    h.clock.advance(CO_VIEW_LIMITS.HOST_DISCONNECT_GRACE_MS + 1);
    expect(h.clock.pending()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// PR-CV2 — co-view.state / co-view.event / co-view.snapshot.{req,res}
// ---------------------------------------------------------------------------

function stateFrame(
  sessionId: string,
  patch: Partial<WsCoViewState> = {},
): WsCoViewState {
  return {
    type: "co-view.state",
    session_id: sessionId,
    seq: patch.seq ?? 0,
    diff: patch.diff ?? {},
    replay: patch.replay ?? "safe",
    ts: patch.ts ?? 0,
    ...(patch.full_state !== undefined ? { full_state: patch.full_state } : {}),
  };
}

function eventFrame(
  sessionId: string,
  patch: Partial<WsCoViewEvent> = {},
): WsCoViewEvent {
  return {
    type: "co-view.event",
    session_id: sessionId,
    kind: patch.kind ?? "nav.route_change",
    payload: patch.payload ?? {},
    replay: patch.replay ?? "unsafe",
    ts: patch.ts ?? 0,
  };
}

function snapshotReq(
  sessionId: string,
  sinceSeq: number,
): WsCoViewSnapshotReq {
  return {
    type: "co-view.snapshot.req",
    session_id: sessionId,
    since_seq: sinceSeq,
  };
}

function snapshotRes(
  sessionId: string,
  memberId: string,
  patch: Partial<WsCoViewSnapshotRes> = {},
): WsCoViewSnapshotRes {
  return {
    type: "co-view.snapshot.res",
    session_id: sessionId,
    member_id: memberId,
    seq: patch.seq ?? 0,
    ...(patch.diffs !== undefined ? { diffs: patch.diffs } : {}),
    ...(patch.full_state !== undefined ? { full_state: patch.full_state } : {}),
  };
}

/**
 * Boot a session with one host (`c-host`/`u-host`) and one viewer
 * (`c-viewer`/`u-viewer`) joined. Returns the session id and clears `sent`.
 */
async function bootHostAndViewer(harness: Harness): Promise<string> {
  harness.setUser("c-host", makeUser("u-host"));
  harness.setUser("c-viewer", makeUser("u-viewer"));
  harness.setSessionIdSequence(["sess-S"]);
  await dispatch(
    harness,
    "c-host",
    startReq({ visibility: "private", whitelist: ["u-viewer"] }),
  );
  await dispatch(harness, "c-viewer", joinReq("sess-S"));
  harness.sent.length = 0;
  return "sess-S";
}

describe("co-view.state — host → server → viewers", () => {
  test("safe diff forwards to viewers, not host, and updates cached snapshot", async () => {
    const sid = await bootHostAndViewer(h);

    await dispatch(
      h,
      "c-host",
      stateFrame(sid, { seq: 0, diff: { route: "/server/foo" }, replay: "safe" }),
    );

    expect(findFirst<WsCoViewState>(h.sent, "co-view.state", "c-viewer")).toBeDefined();
    expect(findFirst<WsCoViewState>(h.sent, "co-view.state", "c-host")).toBeUndefined();

    const internals = h.handle._internals();
    const sess = internals.sessions.get(sid)!;
    expect(sess.lastSeq).toBe(0);
    expect(sess.safeStateSnapshot).toEqual({ route: "/server/foo" });
  });

  test("unsafe frame forwards but does NOT touch the cached snapshot", async () => {
    const sid = await bootHostAndViewer(h);

    await dispatch(
      h,
      "c-host",
      stateFrame(sid, { seq: 0, diff: { typing: { ch1: true } }, replay: "unsafe" }),
    );

    expect(findFirst<WsCoViewState>(h.sent, "co-view.state", "c-viewer")).toBeDefined();
    const sess = h.handle._internals().sessions.get(sid)!;
    // lastSeq tracks all accepted frames; snapshot only sees safe ones.
    expect(sess.lastSeq).toBe(0);
    expect(sess.safeStateSnapshot).toEqual({});
  });

  test("safe diff merges into cached snapshot — null deletes keys (RFC 7396)", async () => {
    const sid = await bootHostAndViewer(h);

    await dispatch(h, "c-host", stateFrame(sid, { seq: 0, diff: { route: "/a", panels: { p1: { kind: "channel" } } } }));
    await dispatch(h, "c-host", stateFrame(sid, { seq: 1, diff: { panels: { p2: { kind: "browser" } } } }));
    await dispatch(h, "c-host", stateFrame(sid, { seq: 2, diff: { panels: { p1: null } } }));

    const sess = h.handle._internals().sessions.get(sid)!;
    expect(sess.safeStateSnapshot).toEqual({
      route: "/a",
      panels: { p2: { kind: "browser" } },
    });
  });

  test("full_state replaces the cached snapshot wholesale", async () => {
    const sid = await bootHostAndViewer(h);
    await dispatch(h, "c-host", stateFrame(sid, { seq: 0, diff: { keep: 1 } }));
    await dispatch(
      h,
      "c-host",
      stateFrame(sid, {
        seq: 1,
        diff: {},
        full_state: { route: "/reset", panels: {} },
        replay: "safe",
      }),
    );
    const sess = h.handle._internals().sessions.get(sid)!;
    expect(sess.safeStateSnapshot).toEqual({ route: "/reset", panels: {} });
    expect(sess.safeStateSnapshot["keep"]).toBeUndefined();
  });

  test("non-host emitter dropped — viewer cannot inject state", async () => {
    const sid = await bootHostAndViewer(h);
    await dispatch(h, "c-viewer", stateFrame(sid, { seq: 0, diff: { route: "/evil" } }));
    expect(findAll<WsCoViewState>(h.sent, "co-view.state")).toHaveLength(0);
    expect(h.handle._internals().sessions.get(sid)!.safeStateSnapshot).toEqual({});
  });

  test("seq regression dropped — frame ignored, snapshot unchanged", async () => {
    const sid = await bootHostAndViewer(h);
    await dispatch(h, "c-host", stateFrame(sid, { seq: 5, diff: { route: "/keep" } }));
    h.sent.length = 0;
    await dispatch(h, "c-host", stateFrame(sid, { seq: 3, diff: { route: "/clobber" } }));
    expect(findAll<WsCoViewState>(h.sent, "co-view.state")).toHaveLength(0);
    expect(h.handle._internals().sessions.get(sid)!.safeStateSnapshot).toEqual({
      route: "/keep",
    });
  });

  test("oversize diff (>16 KB) rejected without forwarding", async () => {
    const sid = await bootHostAndViewer(h);
    const huge = "x".repeat(CO_VIEW_LIMITS.STATE_DIFF_BYTES_MAX + 16);
    await dispatch(h, "c-host", stateFrame(sid, { seq: 0, diff: { blob: huge } }));
    expect(findAll<WsCoViewState>(h.sent, "co-view.state")).toHaveLength(0);
  });
});

describe("co-view.event — host → server → viewers", () => {
  test("nav.route_change forwards to viewers, not host", async () => {
    const sid = await bootHostAndViewer(h);
    await dispatch(
      h,
      "c-host",
      eventFrame(sid, {
        kind: "nav.route_change",
        payload: { from: "/", to: "/server/foo" },
        replay: "unsafe",
      }),
    );
    expect(findFirst<WsCoViewEvent>(h.sent, "co-view.event", "c-viewer")).toBeDefined();
    expect(findFirst<WsCoViewEvent>(h.sent, "co-view.event", "c-host")).toBeUndefined();
  });

  test("non-host emitter dropped", async () => {
    const sid = await bootHostAndViewer(h);
    await dispatch(h, "c-viewer", eventFrame(sid, { kind: "nav.route_change", payload: { from: "/", to: "/x" } }));
    expect(findAll<WsCoViewEvent>(h.sent, "co-view.event")).toHaveLength(0);
  });

  test("oversize payload (>4 KB) rejected without forwarding", async () => {
    const sid = await bootHostAndViewer(h);
    const huge = "x".repeat(CO_VIEW_LIMITS.EVENT_PAYLOAD_BYTES_MAX + 16);
    await dispatch(h, "c-host", eventFrame(sid, { kind: "nav.route_change", payload: { blob: huge } }));
    expect(findAll<WsCoViewEvent>(h.sent, "co-view.event")).toHaveLength(0);
  });
});

describe("join.ack — current_state_snapshot", () => {
  test("first viewer gets null when host has not pushed any safe state", async () => {
    h.setUser("c-host", makeUser("u-host"));
    h.setUser("c-viewer", makeUser("u-viewer"));
    h.setSessionIdSequence(["sess-Z"]);
    await dispatch(h, "c-host", startReq({ visibility: "private", whitelist: ["u-viewer"] }));
    await dispatch(h, "c-viewer", joinReq("sess-Z"));
    const ack = findFirst<WsCoViewJoinAck>(h.sent, "co-view.join.ack", "c-viewer");
    expect(ack).toBeDefined();
    expect(ack!.current_state_snapshot).toBeNull();
  });

  test("second viewer joining mid-session sees the cached snapshot", async () => {
    const sid = await bootHostAndViewer(h);
    await dispatch(h, "c-host", stateFrame(sid, { seq: 0, diff: { route: "/cached" } }));
    h.sent.length = 0;

    h.setUser("c-viewer-2", makeUser("u-viewer-2"));
    await dispatch(h, "c-host", updateReq(sid, { whitelist: ["u-viewer", "u-viewer-2"] }));
    h.sent.length = 0;
    await dispatch(h, "c-viewer-2", joinReq(sid));

    const ack = findFirst<WsCoViewJoinAck>(h.sent, "co-view.join.ack", "c-viewer-2");
    expect(ack).toBeDefined();
    expect(ack!.current_state_snapshot).toEqual({ route: "/cached" });
  });

  test("snapshot copied — later mutations do not retro-aliasing the join.ack frame", async () => {
    const sid = await bootHostAndViewer(h);
    await dispatch(h, "c-host", stateFrame(sid, { seq: 0, diff: { route: "/v1" } }));
    h.setUser("c-viewer-2", makeUser("u-viewer-2"));
    await dispatch(h, "c-host", updateReq(sid, { whitelist: ["u-viewer", "u-viewer-2"] }));
    h.sent.length = 0;
    await dispatch(h, "c-viewer-2", joinReq(sid));
    const ack = findFirst<WsCoViewJoinAck>(h.sent, "co-view.join.ack", "c-viewer-2")!;
    const snapshotAtJoin = ack.current_state_snapshot;

    await dispatch(h, "c-host", stateFrame(sid, { seq: 1, diff: { route: "/v2" } }));
    expect(snapshotAtJoin).toEqual({ route: "/v1" });
  });
});

describe("co-view.snapshot.req / .res routing", () => {
  test("viewer's snapshot.req forwards to host with member_id stamped", async () => {
    const sid = await bootHostAndViewer(h);
    await dispatch(h, "c-viewer", snapshotReq(sid, 5));
    const fwd = findFirst<WsCoViewSnapshotReq>(h.sent, "co-view.snapshot.req", "c-host");
    expect(fwd).toBeDefined();
    expect(fwd!.session_id).toBe(sid);
    expect(fwd!.since_seq).toBe(5);
    expect(fwd!.member_id).toBe("c-viewer");
  });

  test("non-member's snapshot.req dropped", async () => {
    const sid = await bootHostAndViewer(h);
    h.setUser("c-stranger", makeUser("u-stranger"));
    await dispatch(h, "c-stranger", snapshotReq(sid, 0));
    expect(findAll<WsCoViewSnapshotReq>(h.sent, "co-view.snapshot.req")).toHaveLength(0);
  });

  test("host's snapshot.res addressed to viewer via member_id, member_id stripped on viewer hop", async () => {
    const sid = await bootHostAndViewer(h);
    await dispatch(
      h,
      "c-host",
      snapshotRes(sid, "c-viewer", { seq: 7, full_state: { route: "/r" } }),
    );
    const out = findFirst<WsCoViewSnapshotRes>(h.sent, "co-view.snapshot.res", "c-viewer");
    expect(out).toBeDefined();
    expect(out!.seq).toBe(7);
    expect(out!.full_state).toEqual({ route: "/r" });
    expect(out!.member_id).toBeUndefined();
  });

  test("non-host's snapshot.res dropped", async () => {
    const sid = await bootHostAndViewer(h);
    await dispatch(
      h,
      "c-viewer",
      snapshotRes(sid, "c-viewer", { seq: 1, full_state: { evil: true } }),
    );
    expect(findAll<WsCoViewSnapshotRes>(h.sent, "co-view.snapshot.res")).toHaveLength(0);
  });

  test("snapshot.res for a viewer who already left dropped silently", async () => {
    const sid = await bootHostAndViewer(h);
    await dispatch(h, "c-viewer", leaveReq(sid));
    h.sent.length = 0;
    await dispatch(
      h,
      "c-host",
      snapshotRes(sid, "c-viewer", { seq: 1, full_state: {} }),
    );
    expect(findAll<WsCoViewSnapshotRes>(h.sent, "co-view.snapshot.res")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// PR-CV4 — co-view.cursor / pen.* event handling
// ---------------------------------------------------------------------------

import type { CoViewCursorState, WsCoViewCursor } from "@uncorded/protocol";

function cursorFrame(
  sessionId: string,
  patch: Partial<WsCoViewCursor> = {},
): WsCoViewCursor {
  return {
    type: "co-view.cursor",
    session_id: sessionId,
    x: patch.x ?? 100,
    y: patch.y ?? 100,
    state: patch.state ?? ("idle" as CoViewCursorState),
    ts: patch.ts ?? 0,
    ...(patch.member_id !== undefined ? { member_id: patch.member_id } : {}),
  };
}

function penEvent(
  sessionId: string,
  kind: "pen.stroke_begin" | "pen.stroke_point" | "pen.stroke_end" | "pen.clear",
  payload: Record<string, unknown> = {},
): WsCoViewEvent {
  return {
    type: "co-view.event",
    session_id: sessionId,
    kind,
    payload,
    replay: "unsafe",
    ts: 0,
  };
}

describe("co-view.cursor — routing + auth + rate limit", () => {
  test("routes to all OTHER members, never the sender", async () => {
    const sid = await bootHostAndViewer(h);
    await dispatch(h, "c-viewer", cursorFrame(sid, { x: 10, y: 20 }));
    expect(findFirst<WsCoViewCursor>(h.sent, "co-view.cursor", "c-host")).toBeDefined();
    expect(findFirst<WsCoViewCursor>(h.sent, "co-view.cursor", "c-viewer")).toBeUndefined();
  });

  test("server-stamps member_id; client-supplied value is overwritten", async () => {
    const sid = await bootHostAndViewer(h);
    await dispatch(
      h,
      "c-viewer",
      cursorFrame(sid, { x: 10, y: 20, member_id: "spoofed-host" }),
    );
    const out = findFirst<WsCoViewCursor>(h.sent, "co-view.cursor", "c-host");
    expect(out?.member_id).toBe("c-viewer");
  });

  test("non-member sender dropped with warn", async () => {
    const sid = await bootHostAndViewer(h);
    h.setUser("c-stranger", makeUser("u-stranger"));
    await dispatch(h, "c-stranger", cursorFrame(sid));
    expect(findAll<WsCoViewCursor>(h.sent, "co-view.cursor")).toHaveLength(0);
  });

  test("identical (x, y, state) within coalesce window is dropped", async () => {
    const sid = await bootHostAndViewer(h);
    await dispatch(h, "c-viewer", cursorFrame(sid, { x: 1, y: 1, state: "hover" }));
    h.sent.length = 0;
    // No clock advance — same timestamp window.
    await dispatch(h, "c-viewer", cursorFrame(sid, { x: 1, y: 1, state: "hover" }));
    expect(findAll<WsCoViewCursor>(h.sent, "co-view.cursor")).toHaveLength(0);
  });

  test("rate-limit drops excess frames at >30 Hz", async () => {
    const sid = await bootHostAndViewer(h);
    // First frame accepted at clock t=1000.
    await dispatch(h, "c-viewer", cursorFrame(sid, { x: 0, y: 0, state: "hover" }));
    expect(findAll<WsCoViewCursor>(h.sent, "co-view.cursor")).toHaveLength(1);
    h.sent.length = 0;
    // Advance only 10ms (less than 1000/30 = ~33ms) — second frame rate-limited.
    h.clock.advance(10);
    await dispatch(h, "c-viewer", cursorFrame(sid, { x: 5, y: 5, state: "hover" }));
    expect(findAll<WsCoViewCursor>(h.sent, "co-view.cursor")).toHaveLength(0);
    // Advance past the rate window — next frame accepted.
    h.clock.advance(30);
    await dispatch(h, "c-viewer", cursorFrame(sid, { x: 9, y: 9, state: "hover" }));
    expect(findAll<WsCoViewCursor>(h.sent, "co-view.cursor")).toHaveLength(1);
  });

  test("invalid coordinates rejected", async () => {
    const sid = await bootHostAndViewer(h);
    await dispatch(
      h,
      "c-viewer",
      cursorFrame(sid, { x: Number.NaN, y: 10 }),
    );
    expect(findAll<WsCoViewCursor>(h.sent, "co-view.cursor")).toHaveLength(0);
  });

  test("cursors map populated; member departure evicts entry", async () => {
    const sid = await bootHostAndViewer(h);
    await dispatch(h, "c-viewer", cursorFrame(sid, { x: 7, y: 8 }));
    let sess = h.handle._internals().sessions.get(sid)!;
    expect(sess.cursors.has("c-viewer")).toBe(true);

    await dispatch(h, "c-viewer", leaveReq(sid));
    sess = h.handle._internals().sessions.get(sid)!;
    expect(sess.cursors.has("c-viewer")).toBe(false);
    expect(sess.rateLimits.cursor.has("c-viewer")).toBe(false);
  });
});

describe("co-view.event — pen.* per-kind policy", () => {
  test("pen.stroke_begin from a viewer is accepted, member_id stamped, broadcast to OTHER members", async () => {
    const sid = await bootHostAndViewer(h);
    await dispatch(
      h,
      "c-viewer",
      penEvent(sid, "pen.stroke_begin", { stroke_id: "s1" }),
    );
    const out = findFirst<WsCoViewEvent>(h.sent, "co-view.event", "c-host");
    expect(out?.kind).toBe("pen.stroke_begin");
    expect(out?.member_id).toBe("c-viewer");
    // Sender excluded.
    expect(findFirst<WsCoViewEvent>(h.sent, "co-view.event", "c-viewer")).toBeUndefined();
  });

  test("pen.stroke_begin client-supplied member_id is overwritten", async () => {
    const sid = await bootHostAndViewer(h);
    const frame = penEvent(sid, "pen.stroke_begin", { stroke_id: "s1" });
    frame.member_id = "spoofed-host";
    await dispatch(h, "c-viewer", frame);
    const out = findFirst<WsCoViewEvent>(h.sent, "co-view.event", "c-host");
    expect(out?.member_id).toBe("c-viewer");
  });

  test("pen.stroke_end is NEVER rate-limited — 100 rapid frames all forward", async () => {
    const sid = await bootHostAndViewer(h);
    // Send 100 stroke_end frames at the same clock — none should drop.
    for (let i = 0; i < 100; i++) {
      await dispatch(
        h,
        "c-viewer",
        penEvent(sid, "pen.stroke_end", { stroke_id: `s${String(i)}` }),
      );
    }
    expect(findAll<WsCoViewEvent>(h.sent, "co-view.event", "c-host")).toHaveLength(100);
  });

  test("pen.stroke_point rate-limit at 60 Hz drops excess", async () => {
    const sid = await bootHostAndViewer(h);
    // First frame accepted.
    await dispatch(
      h,
      "c-viewer",
      penEvent(sid, "pen.stroke_point", { stroke_id: "s1", points: [] }),
    );
    expect(findAll<WsCoViewEvent>(h.sent, "co-view.event", "c-host")).toHaveLength(1);
    h.sent.length = 0;
    // Advance only 5ms (< 1000/60 = ~16.6ms) — second frame dropped.
    h.clock.advance(5);
    await dispatch(
      h,
      "c-viewer",
      penEvent(sid, "pen.stroke_point", { stroke_id: "s1", points: [] }),
    );
    expect(findAll<WsCoViewEvent>(h.sent, "co-view.event", "c-host")).toHaveLength(0);
    // Past the window — accepted.
    h.clock.advance(15);
    await dispatch(
      h,
      "c-viewer",
      penEvent(sid, "pen.stroke_point", { stroke_id: "s1", points: [] }),
    );
    expect(findAll<WsCoViewEvent>(h.sent, "co-view.event", "c-host")).toHaveLength(1);
  });

  test("pen.stroke_begin rate-limit at 5 Hz drops excess", async () => {
    const sid = await bootHostAndViewer(h);
    await dispatch(h, "c-viewer", penEvent(sid, "pen.stroke_begin", { stroke_id: "s1" }));
    expect(findAll<WsCoViewEvent>(h.sent, "co-view.event", "c-host")).toHaveLength(1);
    h.sent.length = 0;
    // Within 200ms window — second begin dropped.
    h.clock.advance(50);
    await dispatch(h, "c-viewer", penEvent(sid, "pen.stroke_begin", { stroke_id: "s2" }));
    expect(findAll<WsCoViewEvent>(h.sent, "co-view.event", "c-host")).toHaveLength(0);
    // Past 200ms — accepted.
    h.clock.advance(160);
    await dispatch(h, "c-viewer", penEvent(sid, "pen.stroke_begin", { stroke_id: "s3" }));
    expect(findAll<WsCoViewEvent>(h.sent, "co-view.event", "c-host")).toHaveLength(1);
  });

  test("pen.clear scope:'all' from a non-host viewer is dropped + warned", async () => {
    const sid = await bootHostAndViewer(h);
    await dispatch(h, "c-viewer", penEvent(sid, "pen.clear", { scope: "all" }));
    expect(findAll<WsCoViewEvent>(h.sent, "co-view.event")).toHaveLength(0);
  });

  test("pen.clear scope:'all' from the host is accepted", async () => {
    const sid = await bootHostAndViewer(h);
    await dispatch(h, "c-host", penEvent(sid, "pen.clear", { scope: "all" }));
    expect(findFirst<WsCoViewEvent>(h.sent, "co-view.event", "c-viewer")).toBeDefined();
  });

  test("pen.clear scope:'mine' from any viewer is accepted", async () => {
    const sid = await bootHostAndViewer(h);
    await dispatch(h, "c-viewer", penEvent(sid, "pen.clear", { scope: "mine" }));
    const out = findFirst<WsCoViewEvent>(h.sent, "co-view.event", "c-host");
    expect(out?.member_id).toBe("c-viewer");
  });

  test("100 rapid pen.clear scope:'mine' from same member coalesces to 1 frame", async () => {
    const sid = await bootHostAndViewer(h);
    for (let i = 0; i < 100; i++) {
      await dispatch(h, "c-viewer", penEvent(sid, "pen.clear", { scope: "mine" }));
    }
    expect(findAll<WsCoViewEvent>(h.sent, "co-view.event", "c-host")).toHaveLength(1);
  });

  test("pen.clear coalesce is per-(member, scope) — different members not blocked", async () => {
    // Boot host + 2 viewers so we have multiple members able to clear.
    h.setUser("c-host", makeUser("u-host"));
    h.setUser("c-v1", makeUser("u-v1"));
    h.setUser("c-v2", makeUser("u-v2"));
    h.setSessionIdSequence(["sess-MC"]);
    await dispatch(h, "c-host", startReq({ visibility: "public" }));
    await dispatch(h, "c-v1", joinReq("sess-MC"));
    await dispatch(h, "c-v2", joinReq("sess-MC"));
    h.sent.length = 0;

    // Both viewers clear at the same clock — both should forward (per-member coalesce).
    await dispatch(h, "c-v1", penEvent("sess-MC", "pen.clear", { scope: "mine" }));
    await dispatch(h, "c-v2", penEvent("sess-MC", "pen.clear", { scope: "mine" }));
    // Each clear broadcasts to two other members (e.g. v1's clear → host + v2),
    // so two distinct senders produce 4 outbound frames.
    const all = findAll<WsCoViewEvent>(h.sent, "co-view.event");
    expect(all.length).toBe(4);
    const senders = new Set(all.map((f) => f.member_id));
    expect(senders.has("c-v1")).toBe(true);
    expect(senders.has("c-v2")).toBe(true);
  });

  test("pen.clear coalesce window expires — second forward after PEN_CLEAR_COALESCE_MS", async () => {
    const sid = await bootHostAndViewer(h);
    await dispatch(h, "c-viewer", penEvent(sid, "pen.clear", { scope: "mine" }));
    h.clock.advance(50);
    await dispatch(h, "c-viewer", penEvent(sid, "pen.clear", { scope: "mine" }));
    expect(findAll<WsCoViewEvent>(h.sent, "co-view.event", "c-host")).toHaveLength(1);
    // Advance past the window.
    h.clock.advance(60);
    await dispatch(h, "c-viewer", penEvent(sid, "pen.clear", { scope: "mine" }));
    expect(findAll<WsCoViewEvent>(h.sent, "co-view.event", "c-host")).toHaveLength(2);
  });

  test("pen.clear with invalid scope dropped", async () => {
    const sid = await bootHostAndViewer(h);
    await dispatch(h, "c-viewer", penEvent(sid, "pen.clear", { scope: "bogus" }));
    expect(findAll<WsCoViewEvent>(h.sent, "co-view.event")).toHaveLength(0);
  });

  test("pen event from non-member dropped", async () => {
    const sid = await bootHostAndViewer(h);
    h.setUser("c-stranger", makeUser("u-stranger"));
    await dispatch(
      h,
      "c-stranger",
      penEvent(sid, "pen.stroke_begin", { stroke_id: "s1" }),
    );
    expect(findAll<WsCoViewEvent>(h.sent, "co-view.event")).toHaveLength(0);
  });

  test("pen event payload size cap still applies", async () => {
    const sid = await bootHostAndViewer(h);
    const huge = "x".repeat(CO_VIEW_LIMITS.EVENT_PAYLOAD_BYTES_MAX + 16);
    await dispatch(
      h,
      "c-viewer",
      penEvent(sid, "pen.stroke_point", { stroke_id: "s1", blob: huge }),
    );
    expect(findAll<WsCoViewEvent>(h.sent, "co-view.event")).toHaveLength(0);
  });

  test("connection close evicts cursor + all rate-limit + clear-coalesce entries", async () => {
    const sid = await bootHostAndViewer(h);
    // Populate every map for c-viewer.
    await dispatch(h, "c-viewer", cursorFrame(sid));
    h.clock.advance(40);
    await dispatch(h, "c-viewer", penEvent(sid, "pen.stroke_begin", { stroke_id: "s1" }));
    h.clock.advance(20);
    await dispatch(h, "c-viewer", penEvent(sid, "pen.stroke_point", { stroke_id: "s1", points: [] }));
    await dispatch(h, "c-viewer", penEvent(sid, "pen.clear", { scope: "mine" }));

    let sess = h.handle._internals().sessions.get(sid)!;
    expect(sess.cursors.has("c-viewer")).toBe(true);
    expect(sess.rateLimits.cursor.has("c-viewer")).toBe(true);
    expect(sess.rateLimits.penBegin.has("c-viewer")).toBe(true);
    expect(sess.rateLimits.penPoint.has("c-viewer")).toBe(true);
    expect([...sess.lastClearTs.keys()].some((k) => k.startsWith("c-viewer|"))).toBe(true);

    h.handle.onConnectionClose("c-viewer");
    sess = h.handle._internals().sessions.get(sid)!;
    expect(sess.cursors.has("c-viewer")).toBe(false);
    expect(sess.rateLimits.cursor.has("c-viewer")).toBe(false);
    expect(sess.rateLimits.penBegin.has("c-viewer")).toBe(false);
    expect(sess.rateLimits.penPoint.has("c-viewer")).toBe(false);
    expect([...sess.lastClearTs.keys()].some((k) => k.startsWith("c-viewer|"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PR-CV5 — list endpoint, per-subscriber visible-set, pause enforcement
// ---------------------------------------------------------------------------

import type {
  WsCoViewListReq,
  WsCoViewListRes,
  WsCoViewListChanged,
} from "@uncorded/protocol";

function listReq(serverId: string, requestId = "rq-1"): WsCoViewListReq {
  return {
    type: "co-view.list.req",
    request_id: requestId,
    server_id: serverId,
  };
}

describe("co-view.list.req — visibility filter + auth", () => {
  test("returns only sessions the requesting user can actually see", async () => {
    // Two hosts: one public, one private with a whitelist not including the
    // requester. The requester (u-stranger) should only see the public one.
    h.setUser("c-host-pub", makeUser("u-host-pub"));
    h.setUser("c-host-priv", makeUser("u-host-priv"));
    h.setUser("c-stranger", makeUser("u-stranger"));
    h.setSessionIdSequence(["sess-pub", "sess-priv"]);

    await dispatch(h, "c-host-pub", startReq({ visibility: "public" }));
    await dispatch(
      h,
      "c-host-priv",
      startReq({ visibility: "private", whitelist: ["u-other"] }),
    );
    h.sent.length = 0;

    await dispatch(h, "c-stranger", listReq("srv-test"));

    const res = findFirst<WsCoViewListRes>(h.sent, "co-view.list.res", "c-stranger");
    expect(res).toBeDefined();
    expect(res!.sessions.map((s) => s.session_id).sort()).toEqual(["sess-pub"]);
    expect(res!.request_id).toBe("rq-1");
    expect(res!.server_id).toBe("srv-test");
  });

  test("owner sees every session regardless of visibility", async () => {
    h.setUser("c-host-priv", makeUser("u-host"));
    h.setUser("c-owner", makeUser("u-owner", "owner"));
    h.setSessionIdSequence(["sess-priv"]);

    await dispatch(
      h,
      "c-host-priv",
      startReq({ visibility: "private", whitelist: ["u-noone"] }),
    );
    h.sent.length = 0;

    await dispatch(h, "c-owner", listReq("srv-test"));
    const res = findFirst<WsCoViewListRes>(h.sent, "co-view.list.res", "c-owner");
    expect(res!.sessions).toHaveLength(1);
  });

  test("list.req for an unknown server_id replies with empty sessions", async () => {
    h.setUser("c-host", makeUser("u-host"));
    h.setSessionIdSequence(["sess-A"]);
    await dispatch(h, "c-host", startReq({ visibility: "public" }));
    h.sent.length = 0;

    await dispatch(h, "c-host", listReq("srv-other"));
    const res = findFirst<WsCoViewListRes>(h.sent, "co-view.list.res", "c-host");
    expect(res).toBeDefined();
    expect(res!.sessions).toEqual([]);
  });

  test("summary carries paused, viewer_count, render_mode, started_at", async () => {
    h.setUser("c-host", makeUser("u-host"));
    h.setUser("c-viewer", makeUser("u-viewer"));
    h.setSessionIdSequence(["sess-A"]);
    await dispatch(
      h,
      "c-host",
      startReq({
        visibility: "public",
        render_mode: "as-viewer",
      }),
    );
    await dispatch(h, "c-viewer", joinReq("sess-A"));
    await dispatch(h, "c-host", updateReq("sess-A", { paused: true }));
    h.sent.length = 0;

    await dispatch(h, "c-host", listReq("srv-test"));
    const res = findFirst<WsCoViewListRes>(h.sent, "co-view.list.res", "c-host")!;
    const summary = res.sessions[0]!;
    expect(summary.paused).toBe(true);
    expect(summary.viewer_count).toBe(1);
    expect(summary.render_mode).toBe("as-viewer");
    expect(summary.visibility).toBe("public");
    expect(summary.host_user_id).toBe("u-host");
    expect(summary.started_at).toBe(1_000); // virtual clock starts at 1000
    expect(summary.host_session_id).toBe("c-host");
  });
});

describe("co-view.list.changed — per-subscriber visible-set tracking", () => {
  test("subscriber receives `added` when a new visible session starts", async () => {
    h.setUser("c-sub", makeUser("u-sub"));
    h.setUser("c-host", makeUser("u-host"));
    await dispatch(h, "c-sub", listReq("srv-test"));
    h.sent.length = 0;

    h.setSessionIdSequence(["sess-new"]);
    await dispatch(h, "c-host", startReq({ visibility: "public" }));

    const change = findFirst<WsCoViewListChanged>(
      h.sent,
      "co-view.list.changed",
      "c-sub",
    );
    expect(change).toBeDefined();
    expect(change!.change).toBe("added");
    expect(change!.session_id).toBe("sess-new");
    expect(change!.session?.session_id).toBe("sess-new");
  });

  test("subscriber who never saw a private session does NOT get a `removed` on end", async () => {
    h.setUser("c-stranger", makeUser("u-stranger"));
    h.setUser("c-host", makeUser("u-host"));
    h.setSessionIdSequence(["sess-private"]);
    await dispatch(
      h,
      "c-host",
      startReq({ visibility: "private", whitelist: ["u-other"] }),
    );

    // Stranger subscribes — gets empty list because the private session isn't
    // visible to them. Their visible-set is therefore empty.
    await dispatch(h, "c-stranger", listReq("srv-test"));
    h.sent.length = 0;

    await dispatch(h, "c-host", endReq("sess-private"));

    const leak = findFirst<WsCoViewListChanged>(
      h.sent,
      "co-view.list.changed",
      "c-stranger",
    );
    expect(leak).toBeUndefined();
  });

  test("subscriber who saw a public session gets `removed` on end", async () => {
    h.setUser("c-sub", makeUser("u-sub"));
    h.setUser("c-host", makeUser("u-host"));
    h.setSessionIdSequence(["sess-A"]);
    await dispatch(h, "c-host", startReq({ visibility: "public" }));
    await dispatch(h, "c-sub", listReq("srv-test"));
    h.sent.length = 0;

    await dispatch(h, "c-host", endReq("sess-A"));

    const change = findFirst<WsCoViewListChanged>(
      h.sent,
      "co-view.list.changed",
      "c-sub",
    );
    expect(change).toBeDefined();
    expect(change!.change).toBe("removed");
    expect(change!.session_id).toBe("sess-A");
    expect(change!.session).toBeUndefined();
  });

  test("visibility downgrade evicts AND emits `removed` to the previously-visible subscriber", async () => {
    h.setUser("c-sub", makeUser("u-sub"));
    h.setUser("c-host", makeUser("u-host"));
    h.setSessionIdSequence(["sess-A"]);
    await dispatch(h, "c-host", startReq({ visibility: "public" }));
    await dispatch(h, "c-sub", listReq("srv-test"));
    // Sub joined as a viewer too, so eviction has something to broadcast.
    await dispatch(h, "c-sub", joinReq("sess-A"));
    h.sent.length = 0;

    // Host downgrades to private with no whitelist.
    await dispatch(
      h,
      "c-host",
      updateReq("sess-A", { visibility: "private", whitelist: [] }),
    );

    // 1) Sub got a `removed` (was previously visible).
    const removed = findFirst<WsCoViewListChanged>(
      h.sent,
      "co-view.list.changed",
      "c-sub",
    );
    expect(removed?.change).toBe("removed");

    // 2) Sub was auto-evicted as a viewer — member-left was broadcast to host.
    const left = findFirst<WsCoViewMemberLeft>(
      h.sent,
      "co-view.member.left",
      "c-host",
    );
    expect(left?.user_id).toBe("u-sub");
    expect(left?.reason).toBe("no_longer_invited");
  });

  test("visibility upgrade emits `added` to the now-visible subscriber", async () => {
    h.setUser("c-sub", makeUser("u-sub"));
    h.setUser("c-host", makeUser("u-host"));
    h.setSessionIdSequence(["sess-A"]);
    await dispatch(
      h,
      "c-host",
      startReq({ visibility: "private", whitelist: ["u-other"] }),
    );
    await dispatch(h, "c-sub", listReq("srv-test"));
    h.sent.length = 0;

    // Host adds u-sub to the whitelist.
    await dispatch(h, "c-host", updateReq("sess-A", { whitelist: ["u-other", "u-sub"] }));

    const added = findFirst<WsCoViewListChanged>(
      h.sent,
      "co-view.list.changed",
      "c-sub",
    );
    expect(added?.change).toBe("added");
    expect(added?.session?.session_id).toBe("sess-A");
  });

  test("second list.req replaces the prior visible-set", async () => {
    h.setUser("c-sub", makeUser("u-sub"));
    h.setUser("c-host", makeUser("u-host"));
    h.setSessionIdSequence(["sess-A"]);
    await dispatch(h, "c-host", startReq({ visibility: "public" }));
    await dispatch(h, "c-sub", listReq("srv-test"));

    // Re-snapshot via a second list.req — must not generate a duplicate added.
    h.sent.length = 0;
    await dispatch(h, "c-sub", listReq("srv-test", "rq-2"));

    const res = findFirst<WsCoViewListRes>(h.sent, "co-view.list.res", "c-sub");
    expect(res!.request_id).toBe("rq-2");
    expect(res!.sessions).toHaveLength(1);

    // Now end the session — sub still gets the `removed` because the new
    // visible-set was re-seeded with sess-A.
    h.sent.length = 0;
    await dispatch(h, "c-host", endReq("sess-A"));
    const removed = findFirst<WsCoViewListChanged>(
      h.sent,
      "co-view.list.changed",
      "c-sub",
    );
    expect(removed?.change).toBe("removed");
  });

  test("connection close sweeps subscriber from every server bucket", async () => {
    h.setUser("c-sub", makeUser("u-sub"));
    h.setUser("c-host", makeUser("u-host"));
    h.setSessionIdSequence(["sess-A"]);
    await dispatch(h, "c-host", startReq({ visibility: "public" }));
    await dispatch(h, "c-sub", listReq("srv-test"));
    h.sent.length = 0;

    h.handle.onConnectionClose("c-sub");

    // After close, lifecycle changes don't reach c-sub.
    await dispatch(h, "c-host", endReq("sess-A"));
    const leak = findAll<WsCoViewListChanged>(
      h.sent,
      "co-view.list.changed",
      "c-sub",
    );
    expect(leak).toHaveLength(0);
  });

  test("viewer_count change broadcasts `updated` to subscribers", async () => {
    h.setUser("c-sub", makeUser("u-sub"));
    h.setUser("c-host", makeUser("u-host"));
    h.setUser("c-viewer", makeUser("u-viewer"));
    h.setSessionIdSequence(["sess-A"]);
    await dispatch(h, "c-host", startReq({ visibility: "public" }));
    await dispatch(h, "c-sub", listReq("srv-test"));
    h.sent.length = 0;

    await dispatch(h, "c-viewer", joinReq("sess-A"));

    const change = findFirst<WsCoViewListChanged>(
      h.sent,
      "co-view.list.changed",
      "c-sub",
    );
    expect(change?.change).toBe("updated");
    expect(change?.session?.viewer_count).toBe(1);
  });
});

describe("PR-CV5 — runtime-enforced pause", () => {
  test("paused host's state frame is dropped at the runtime", async () => {
    const sid = await bootHostAndViewer(h);
    await dispatch(h, "c-host", updateReq(sid, { paused: true }));
    h.sent.length = 0;

    await dispatch(
      h,
      "c-host",
      stateFrame(sid, { seq: 0, diff: { foo: 1 }, replay: "safe" }),
    );

    expect(findFirst<WsCoViewState>(h.sent, "co-view.state", "c-viewer")).toBeUndefined();
  });

  test("paused host's nav event is dropped", async () => {
    const sid = await bootHostAndViewer(h);
    await dispatch(h, "c-host", updateReq(sid, { paused: true }));
    h.sent.length = 0;

    await dispatch(h, "c-host", {
      type: "co-view.event",
      session_id: sid,
      kind: "nav.route_change",
      payload: { to: "/foo" },
      replay: "safe",
      ts: 0,
    } as WsCoViewEvent);

    expect(findAll<WsCoViewEvent>(h.sent, "co-view.event")).toHaveLength(0);
  });

  test("paused host's pen frame is dropped; viewer pen frame still passes", async () => {
    const sid = await bootHostAndViewer(h);
    await dispatch(h, "c-host", updateReq(sid, { paused: true }));
    h.sent.length = 0;

    // Host's pen — dropped.
    await dispatch(
      h,
      "c-host",
      penEvent(sid, "pen.stroke_begin", { stroke_id: "s-host" }),
    );
    expect(
      findAll<WsCoViewEvent>(h.sent, "co-view.event").filter(
        (e) => (e.payload as { stroke_id?: string }).stroke_id === "s-host",
      ),
    ).toHaveLength(0);

    // Viewer's pen — still flows to host so they can see annotations.
    await dispatch(
      h,
      "c-viewer",
      penEvent(sid, "pen.stroke_begin", { stroke_id: "s-viewer" }),
    );
    const out = findFirst<WsCoViewEvent>(h.sent, "co-view.event", "c-host");
    expect(out?.payload).toMatchObject({ stroke_id: "s-viewer" });
  });

  test("paused host's cursor frame dropped; viewer cursor still passes", async () => {
    const sid = await bootHostAndViewer(h);
    await dispatch(h, "c-host", updateReq(sid, { paused: true }));
    h.sent.length = 0;

    await dispatch(h, "c-host", cursorFrame(sid, { x: 10, y: 10 }));
    expect(findAll<WsCoViewCursor>(h.sent, "co-view.cursor")).toHaveLength(0);

    await dispatch(h, "c-viewer", cursorFrame(sid, { x: 20, y: 20 }));
    expect(findFirst<WsCoViewCursor>(h.sent, "co-view.cursor", "c-host")).toBeDefined();
  });

  test("paused host can still send update + end (control frames bypass the gate)", async () => {
    const sid = await bootHostAndViewer(h);
    await dispatch(h, "c-host", updateReq(sid, { paused: true }));
    h.sent.length = 0;

    // Resume.
    await dispatch(h, "c-host", updateReq(sid, { paused: false }));
    expect(
      findFirst<WsCoViewUpdateAck>(h.sent, "co-view.update.ack", "c-host"),
    ).toBeDefined();

    // Pause again, then end.
    await dispatch(h, "c-host", updateReq(sid, { paused: true }));
    h.sent.length = 0;
    await dispatch(h, "c-host", endReq(sid));
    expect(findFirst<WsCoViewEndAck>(h.sent, "co-view.end.ack", "c-host")).toBeDefined();
  });

  test("pause toggle triggers list.changed `updated` to subscribers", async () => {
    h.setUser("c-host", makeUser("u-host"));
    h.setUser("c-sub", makeUser("u-sub"));
    h.setSessionIdSequence(["sess-A"]);
    await dispatch(h, "c-host", startReq({ visibility: "public" }));
    await dispatch(h, "c-sub", listReq("srv-test"));
    h.sent.length = 0;

    await dispatch(h, "c-host", updateReq("sess-A", { paused: true }));

    const change = findFirst<WsCoViewListChanged>(
      h.sent,
      "co-view.list.changed",
      "c-sub",
    );
    expect(change?.change).toBe("updated");
    expect(change?.session?.paused).toBe(true);
  });

  test("session.paused defaults to false on start", async () => {
    h.setUser("c-host", makeUser("u-host"));
    h.setSessionIdSequence(["sess-A"]);
    await dispatch(h, "c-host", startReq({ visibility: "public" }));
    const sess = h.handle._internals().sessions.get("sess-A")!;
    expect(sess.paused).toBe(false);
  });
});
