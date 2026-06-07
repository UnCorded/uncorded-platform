import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createLogger } from "@uncorded/shared";
import { CoreModule } from "../core/module";
import type { EventBus } from "../events/bus";
import type { RolesEngine } from "../roles/engine";
import { startVoiceCascade } from "./cascade";
import type { RoomServiceConfig } from "./room-service";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

function makeMockBus(): EventBus {
  return {
    publishRuntime() {
      return { ok: true as const, eventId: "mock" };
    },
    publish() {
      return { ok: true as const, eventId: "mock" };
    },
    subscribe() {
      return { ok: true as const };
    },
    unsubscribe() {
      return { ok: true as const };
    },
    getStats() {
      return {} as never;
    },
    getDeadLetters() {
      return [];
    },
    removePlugin() {},
  } as unknown as EventBus;
}

// Minimal RolesEngine mock — the cascade only calls `getRole(userId).name`.
// Synthetic actors with a `__` prefix never reach this method (cascade
// short-circuits to "system" before the lookup).
function mockRolesEngine(): RolesEngine {
  return {
    getRole(userId: string) {
      const roles: Record<string, { id: number; name: string; level: number; isDefault: boolean; parentRole: null; createdAt: number; updatedAt: number }> = {
        "admin-1": { id: 2, name: "admin", level: 80, isDefault: true, parentRole: null, createdAt: 0, updatedAt: 0 },
        "owner-1": { id: 1, name: "owner", level: 100, isDefault: true, parentRole: null, createdAt: 0, updatedAt: 0 },
      };
      return roles[userId] ?? { id: 4, name: "member", level: 10, isDefault: true, parentRole: null, createdAt: 0, updatedAt: 0 };
    },
  } as unknown as RolesEngine;
}

const TEST_API_KEY = "APItest";
const TEST_API_SECRET = "secret-bytes-at-least-32-characters-long-please";

interface FakeFetchCall {
  url: string;
  body: { room: string; identity: string };
}

// Bun's fetch type carries a static `preconnect` method that plain
// async functions don't satisfy. Tests cast through this alias.
type FetchLike = (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>;

function makeFakeFetch(opts: {
  /** Per-call response. Defaults to 200 {}.
   *  Returning Error throws (treated as UNREACHABLE by removeParticipant). */
  respond?: (call: FakeFetchCall, idx: number) => Response | Error;
  calls?: FakeFetchCall[];
}): FetchLike {
  const calls = opts.calls ?? [];
  return async (input, init) => {
    const url = String(input);
    const bodyStr = typeof init?.body === "string" ? init.body : "{}";
    const body = JSON.parse(bodyStr) as { room: string; identity: string };
    const call: FakeFetchCall = { url, body };
    calls.push(call);
    const response = opts.respond?.(call, calls.length - 1);
    if (response instanceof Error) throw response;
    return response ?? new Response("{}", { status: 200 });
  };
}

function ensureAdminAuditLog(db: Database): void {
  // Cascade rows live in admin_audit_log (per pr-4-voice-contract §7).
  // CoreModule.initialize doesn't create this table — it's owned by the
  // roles/admin migrations. For unit tests we materialize just the schema
  // the cascade writes against.
  db.run(`
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
  `);
}

function makeBootedModule() {
  const db = new Database(":memory:");
  const log = createLogger({ test: true });
  const mod = new CoreModule(db, makeMockBus(), log);
  mod.initialize();
  ensureAdminAuditLog(db);
  return { db, log, mod };
}

function makeRoomService(fetchImpl: FetchLike): RoomServiceConfig {
  return {
    baseUrl: "http://127.0.0.1:7880",
    fetch: fetchImpl as typeof globalThis.fetch,
    getCredentials: async () => ({ apiKey: TEST_API_KEY, apiSecret: TEST_API_SECRET }),
  };
}

interface CascadeAuditRow {
  action: string;
  actor_user_id: string;
  actor_role: string;
  target_type: string | null;
  target_id: string | null;
  payload_json: string;
}

function listCascadeAudit(db: Database): CascadeAuditRow[] {
  return db
    .query<CascadeAuditRow, []>(
      `SELECT action, actor_user_id, actor_role, target_type, target_id, payload_json
       FROM admin_audit_log
       WHERE action = 'voice.cascade.kick'
       ORDER BY id ASC`,
    )
    .all();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("startVoiceCascade", () => {
  test("ban with no tracked rooms is a no-op for the SFU", async () => {
    const { db, log, mod } = makeBootedModule();
    const calls: FakeFetchCall[] = [];
    const fetchImpl = makeFakeFetch({ calls });
    const cascade = startVoiceCascade({
      db,
      logger: log,
      coreModule: mod,
      rolesEngine: mockRolesEngine(),
      serverId: "srv-1",
      roomService: makeRoomService(fetchImpl),
    });

    mod.banUser("admin-1", "user-1", "spam");
    // Allow the async kick path to settle (it's empty here, but match the
    // production flow).
    await new Promise((r) => setTimeout(r, 5));
    expect(calls.length).toBe(0);

    // No cascade rows written when no rooms tracked.
    expect(listCascadeAudit(db)).toEqual([]);

    cascade.dispose();
  });

  test("ban kicks the user from every tracked room and audits each kick", async () => {
    const { db, log, mod } = makeBootedModule();
    const calls: FakeFetchCall[] = [];
    const fetchImpl = makeFakeFetch({ calls });
    const cascade = startVoiceCascade({
      db,
      logger: log,
      coreModule: mod,
      rolesEngine: mockRolesEngine(),
      serverId: "srv-1",
      roomService: makeRoomService(fetchImpl),
    });

    cascade.trackJoin("ch-a", "user-1");
    cascade.trackJoin("ch-b", "user-1");
    cascade.trackJoin("ch-a", "user-2"); // bystander, must not be kicked

    mod.banUser("admin-1", "user-1", "abuse");
    // Wait for parallel kicks to settle. Use polling rather than fixed
    // sleep to tolerate slower CI machines.
    for (let i = 0; i < 100 && calls.length < 2; i++) {
      await new Promise((r) => setTimeout(r, 2));
    }

    expect(calls.length).toBe(2);
    const rooms = calls.map((c) => c.body.room).sort();
    expect(rooms).toEqual(["server:srv-1:voice:ch-a", "server:srv-1:voice:ch-b"]);
    expect(calls.every((c) => c.body.identity === "user-1")).toBe(true);

    // Pending-kick map staged both rooms with reason="server_ban".
    expect(cascade.consumePendingKick("ch-a", "user-1")).toBe("server_ban");
    expect(cascade.consumePendingKick("ch-b", "user-1")).toBe("server_ban");
    // After consume the entries are gone.
    expect(cascade.consumePendingKick("ch-a", "user-1")).toBeNull();

    // One admin_audit_log row per disconnected room — per-row granularity
    // per contract §7.
    const cascadeRows = listCascadeAudit(db);
    expect(cascadeRows.length).toBe(2);
    const targetIds = cascadeRows.map((r) => r.target_id).sort();
    expect(targetIds).toEqual(["ch-a", "ch-b"]);
    for (const row of cascadeRows) {
      expect(row.action).toBe("voice.cascade.kick");
      expect(row.target_type).toBe("voice");
      expect(row.actor_user_id).toBe("admin-1");
      expect(row.actor_role).toBe("admin");
      const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
      expect(payload["banned_user_id"]).toBe("user-1");
      expect(payload["reason"]).toBe("server_ban");
      expect(payload["source_event"]).toBe("core.moderation.banned");
      expect(payload["outcome"]).toBe("kicked");
      expect(payload["error_code"]).toBeUndefined();
      expect(payload["error_message"]).toBeUndefined();
    }

    cascade.dispose();
  });

  test("non-OK kick records failed outcome with error code", async () => {
    const { db, log, mod } = makeBootedModule();
    const calls: FakeFetchCall[] = [];
    const fetchImpl = makeFakeFetch({
      calls,
      respond: () => new Response("{}", { status: 404 }),
    });
    const cascade = startVoiceCascade({
      db,
      logger: log,
      coreModule: mod,
      rolesEngine: mockRolesEngine(),
      serverId: "srv-1",
      roomService: makeRoomService(fetchImpl),
    });

    cascade.trackJoin("ch-a", "user-1");
    mod.banUser("admin-1", "user-1", "race");

    for (let i = 0; i < 100 && calls.length < 1; i++) {
      await new Promise((r) => setTimeout(r, 2));
    }

    const cascadeRows = listCascadeAudit(db);
    expect(cascadeRows.length).toBe(1);
    const row = cascadeRows[0]!;
    expect(row.target_type).toBe("voice");
    expect(row.target_id).toBe("ch-a");
    expect(row.actor_user_id).toBe("admin-1");
    const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    expect(payload["outcome"]).toBe("not_in_room");
    expect(payload["error_code"]).toBe("NOT_FOUND");
    expect(payload["error_message"]).toBeDefined();

    cascade.dispose();
  });

  test("unban cancels pending kicks across rooms before webhook arrival", async () => {
    const { db, log, mod } = makeBootedModule();
    // Use a fetch that never resolves so kicks stay in flight.
    type Resolver = (r: Response) => void;
    let resolveCall: Resolver | null = null;
    const fetchImpl: FetchLike = () =>
      new Promise<Response>((resolve: Resolver) => {
        resolveCall = resolve;
      });
    const cascade = startVoiceCascade({
      db,
      logger: log,
      coreModule: mod,
      rolesEngine: mockRolesEngine(),
      serverId: "srv-1",
      roomService: makeRoomService(fetchImpl),
    });

    cascade.trackJoin("ch-a", "user-1");
    cascade.trackJoin("ch-b", "user-1");
    mod.banUser("admin-1", "user-1", "mistake");

    // Both pending entries staged.
    expect(cascade.pendingSize()).toBe(2);

    mod.unbanUser("admin-1", "user-1");

    // cancelUser cleared every staged entry — webhook arrivals fall
    // through to "explicit".
    expect(cascade.consumePendingKick("ch-a", "user-1")).toBeNull();
    expect(cascade.consumePendingKick("ch-b", "user-1")).toBeNull();
    expect(cascade.pendingSize()).toBe(0);

    // Resolve the in-flight fetch so the cascade promise settles before
    // the test exits. Cast through `Resolver | null` because TS narrows
    // the assignment-in-callback to `never` otherwise.
    (resolveCall as Resolver | null)?.(new Response("{}", { status: 200 }));

    cascade.dispose();
  });

  test("dispose stops listening to ban events", async () => {
    const { db, log, mod } = makeBootedModule();
    const calls: FakeFetchCall[] = [];
    const fetchImpl = makeFakeFetch({ calls });
    const cascade = startVoiceCascade({
      db,
      logger: log,
      coreModule: mod,
      rolesEngine: mockRolesEngine(),
      serverId: "srv-1",
      roomService: makeRoomService(fetchImpl),
    });

    cascade.trackJoin("ch-a", "user-1");
    cascade.dispose();
    mod.banUser("admin-1", "user-1", "after dispose");

    await new Promise((r) => setTimeout(r, 10));
    expect(calls.length).toBe(0);
  });

  test("trackRoomDestroyed clears every member of the room", () => {
    const { db, log, mod } = makeBootedModule();
    const fetchImpl = makeFakeFetch({});
    const cascade = startVoiceCascade({
      db,
      logger: log,
      coreModule: mod,
      rolesEngine: mockRolesEngine(),
      serverId: "srv-1",
      roomService: makeRoomService(fetchImpl),
    });

    cascade.trackJoin("ch-a", "user-1");
    cascade.trackJoin("ch-a", "user-2");
    cascade.trackRoomDestroyed("ch-a");
    expect(cascade.channelsForUser("user-1")).toEqual([]);
    expect(cascade.channelsForUser("user-2")).toEqual([]);

    cascade.dispose();
  });
});
