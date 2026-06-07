import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { CoreModule } from "./module";
import { handleCoreClientAction } from "./ipc";
import { createLogger } from "@uncorded/shared";
import type { EventBus } from "../events/bus";
import type { RolesEngine } from "../roles/engine";

// Minimal RolesEngine stub: only `hasMinLevel` is exercised by the
// `core.member.list` branch, so everything else can be left to throw if
// called by accident.
function makeMemberLevelEngine(): RolesEngine {
  return {
    hasMinLevel: () => true,
    getRoleIdsForUsers: () => new Map<string, number>(),
  } as unknown as RolesEngine;
}

function makeMockBus(): EventBus {
  return {
    publishRuntime() { return { ok: true as const, eventId: "mock" }; },
    publish() { return { ok: true as const, eventId: "mock" }; },
    subscribe() { return { ok: true as const }; },
    unsubscribe() { return { ok: true as const }; },
    getStats() { return {} as never; },
    getDeadLetters() { return []; },
  } as unknown as EventBus;
}

function makeModuleWithMembers(count: number): CoreModule {
  const db = new Database(":memory:");
  const mod = new CoreModule(db, makeMockBus(), createLogger({ test: true }));
  mod.initialize();
  // Insert in deterministic ascending join order so DESC paging is predictable.
  const base = 1_700_000_000_000;
  for (let i = 0; i < count; i++) {
    const userId = `u${i.toString().padStart(4, "0")}`;
    mod.onUserConnected(userId, userId, `User ${i}`, "");
    // Stamp joined_at directly so we control ordering precisely.
    db.run("INSERT OR REPLACE INTO members (id, joined_at) VALUES (?, ?)", [userId, base + i]);
  }
  return mod;
}

interface ListResult {
  members: Array<{ id: string; joined_at: number }>;
  total: number;
  next_cursor: string | null;
}

function callList(mod: CoreModule, params: Record<string, unknown>): ListResult {
  let captured: ListResult | null = null;
  let errCode: string | null = null;
  handleCoreClientAction(
    "core.member.list",
    params,
    "caller",
    false,
    mod,
    makeMemberLevelEngine(),
    (result) => { captured = result as ListResult; },
    (code) => { errCode = code; },
  );
  if (errCode) throw new Error(`expected ok, got error ${errCode}`);
  if (!captured) throw new Error("no response captured");
  return captured;
}

describe("core.member.list pagination", () => {
  it("returns the default page size (200) when no limit is supplied", () => {
    const mod = makeModuleWithMembers(250);
    const res = callList(mod, {});
    expect(res.members).toHaveLength(200);
    expect(res.total).toBe(250);
    expect(res.next_cursor).toBe("offset:200");
  });

  it("clamps a too-large limit down to the 500 maximum", () => {
    const mod = makeModuleWithMembers(600);
    const res = callList(mod, { limit: 10_000 });
    expect(res.members).toHaveLength(500);
    expect(res.total).toBe(600);
    expect(res.next_cursor).toBe("offset:500");
  });

  it("honors a custom limit within the cap", () => {
    const mod = makeModuleWithMembers(50);
    const res = callList(mod, { limit: 25 });
    expect(res.members).toHaveLength(25);
    expect(res.total).toBe(50);
    expect(res.next_cursor).toBe("offset:25");
  });

  it("returns next_cursor=null when the page exhausts the dataset", () => {
    const mod = makeModuleWithMembers(50);
    const res = callList(mod, { limit: 100 });
    expect(res.members).toHaveLength(50);
    expect(res.total).toBe(50);
    expect(res.next_cursor).toBeNull();
  });

  it("walks pages via cursor without overlap or gaps", () => {
    const mod = makeModuleWithMembers(7);
    const page1 = callList(mod, { limit: 3 });
    expect(page1.members).toHaveLength(3);
    expect(page1.next_cursor).toBe("offset:3");

    const page2 = callList(mod, { limit: 3, cursor: page1.next_cursor! });
    expect(page2.members).toHaveLength(3);
    expect(page2.next_cursor).toBe("offset:6");

    const page3 = callList(mod, { limit: 3, cursor: page2.next_cursor! });
    expect(page3.members).toHaveLength(1);
    expect(page3.next_cursor).toBeNull();

    const seen = new Set([
      ...page1.members.map((m) => m.id),
      ...page2.members.map((m) => m.id),
      ...page3.members.map((m) => m.id),
    ]);
    expect(seen.size).toBe(7);
  });

  it("falls back to offset=0 for malformed cursors instead of crashing", () => {
    const mod = makeModuleWithMembers(5);
    const res = callList(mod, { cursor: "not-a-real-cursor" });
    expect(res.members).toHaveLength(5);
    expect(res.next_cursor).toBeNull();
  });

  it("ignores negative or non-integer limits and falls back to default", () => {
    const mod = makeModuleWithMembers(220);
    const negative = callList(mod, { limit: -5 });
    expect(negative.members).toHaveLength(200);
    const fractional = callList(mod, { limit: 1.5 });
    expect(fractional.members).toHaveLength(200);
  });

  it("returns total=0 and next_cursor=null when the server has no members", () => {
    const mod = makeModuleWithMembers(0);
    const res = callList(mod, {});
    expect(res.members).toHaveLength(0);
    expect(res.total).toBe(0);
    expect(res.next_cursor).toBeNull();
  });

  it("orders members joined_at DESC (newest first)", () => {
    const mod = makeModuleWithMembers(3);
    const res = callList(mod, {});
    const joined = res.members.map((m) => m.joined_at);
    expect(joined).toEqual([...joined].sort((a, b) => b - a));
  });
});

// ---------------------------------------------------------------------------
// role_id enrichment — admin members panel inline role picker (PR follow-up).
// ---------------------------------------------------------------------------

interface EnrichedListResult {
  members: Array<{ id: string; role_id: number | null }>;
  total: number;
  next_cursor: string | null;
}

describe("core.member.list role_id enrichment", () => {
  it("returns role_id: null for every member when no engine assignments exist", () => {
    const mod = makeModuleWithMembers(3);
    const res = callList(mod, {}) as unknown as EnrichedListResult;
    for (const m of res.members) expect(m.role_id).toBeNull();
  });

  it("surfaces explicit assignments via the engine bulk lookup", () => {
    const mod = makeModuleWithMembers(3);
    // Stub returns role_id 7 for u0001 only — IPC handler must merge this in
    // and leave the other rows as null.
    const engine = {
      hasMinLevel: () => true,
      getRoleIdsForUsers: (ids: readonly string[]) => {
        const out = new Map<string, number>();
        if (ids.includes("u0001")) out.set("u0001", 7);
        return out;
      },
    } as unknown as RolesEngine;
    let captured: EnrichedListResult | null = null;
    handleCoreClientAction(
      "core.member.list",
      {},
      "caller",
      false,
      mod,
      engine,
      (result) => { captured = result as EnrichedListResult; },
      () => {},
    );
    expect(captured).not.toBeNull();
    const map = new Map(captured!.members.map((m) => [m.id, m.role_id]));
    expect(map.get("u0001")).toBe(7);
    expect(map.get("u0000")).toBeNull();
    expect(map.get("u0002")).toBeNull();
  });
});
