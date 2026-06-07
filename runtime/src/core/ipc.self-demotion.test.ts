// Q1 lock from spec-22 Amendment B: a caller cannot mutate their own
// role through `core.role.assign` or `core.role.remove`, even as owner.
// Ownership transfer goes through Central.

import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { CoreModule } from "./module";
import { handleCoreClientAction } from "./ipc";
import { createLogger } from "@uncorded/shared";
import type { EventBus } from "../events/bus";
import type { RolesEngine } from "../roles/engine";

function makeBus(): EventBus {
  return {
    publishRuntime() { return { ok: true as const, eventId: "mock" }; },
    publish() { return { ok: true as const, eventId: "mock" }; },
    subscribe() { return { ok: true as const }; },
    unsubscribe() { return { ok: true as const }; },
    getStats() { return {} as never; },
    getDeadLetters() { return []; },
  } as unknown as EventBus;
}

function makeModule(): CoreModule {
  const db = new Database(":memory:");
  const mod = new CoreModule(db, makeBus(), createLogger({ test: true }));
  mod.initialize();
  return mod;
}

interface EngineSpy {
  assignCalls: number;
  removeCalls: number;
}

function makeEngine(spy: EngineSpy): RolesEngine {
  return {
    check: () => true, // owner-or-permitted; gating tested elsewhere
    hasMinLevel: () => true,
    getRoleById: (id: number) => ({
      id,
      name: id === 1 ? "owner" : "admin",
      level: id === 1 ? 100 : 80,
      isDefault: id === 1,
      parentRole: null,
      createdAt: 0,
      updatedAt: 0,
    }),
    assignRole: () => { spy.assignCalls++; return { ok: true as const }; },
    removeRole: () => { spy.removeCalls++; return { ok: true as const }; },
  } as unknown as RolesEngine;
}

function call(action: string, params: Record<string, unknown>, userId: string, isOwner: boolean) {
  const spy: EngineSpy = { assignCalls: 0, removeCalls: 0 };
  let result: { code?: string; message?: string; ok?: boolean } = {};
  handleCoreClientAction(
    action,
    params,
    userId,
    isOwner,
    makeModule(),
    makeEngine(spy),
    () => { result = { ok: true }; },
    (code, message) => { result = { code, message }; },
  );
  return { result, spy };
}

describe("self-demotion guard (Q1 lock)", () => {
  it("core.role.assign refuses when target is the caller (non-owner)", () => {
    const { result, spy } = call("core.role.assign", { user_id: "u1", role_id: 3 }, "u1", false);
    expect(result.code).toBe("SELF_DEMOTION_BLOCKED");
    expect(spy.assignCalls).toBe(0);
  });

  it("core.role.assign refuses when target is the caller (owner cannot bypass)", () => {
    const { result, spy } = call("core.role.assign", { user_id: "owner-1", role_id: 3 }, "owner-1", true);
    expect(result.code).toBe("SELF_DEMOTION_BLOCKED");
    expect(spy.assignCalls).toBe(0);
  });

  it("core.role.remove refuses when target is the caller (non-owner)", () => {
    const { result, spy } = call("core.role.remove", { user_id: "u1" }, "u1", false);
    expect(result.code).toBe("SELF_DEMOTION_BLOCKED");
    expect(spy.removeCalls).toBe(0);
  });

  it("core.role.remove refuses when target is the caller (owner cannot bypass)", () => {
    const { result, spy } = call("core.role.remove", { user_id: "owner-1" }, "owner-1", true);
    expect(result.code).toBe("SELF_DEMOTION_BLOCKED");
    expect(spy.removeCalls).toBe(0);
  });

  it("core.role.assign proceeds normally when target is someone else", () => {
    const { result, spy } = call("core.role.assign", { user_id: "u2", role_id: 3 }, "u1", true);
    expect(result.ok).toBe(true);
    expect(spy.assignCalls).toBe(1);
  });

  it("core.role.remove proceeds normally when target is someone else", () => {
    const { result, spy } = call("core.role.remove", { user_id: "u2" }, "u1", true);
    expect(result.ok).toBe(true);
    expect(spy.removeCalls).toBe(1);
  });
});

describe("owner role non-assignability", () => {
  it("core.role.assign refuses when target role is the default owner role", () => {
    const { result, spy } = call("core.role.assign", { user_id: "u2", role_id: 1 }, "owner-1", true);
    expect(result.code).toBe("OWNER_ROLE_NOT_ASSIGNABLE");
    expect(spy.assignCalls).toBe(0);
  });

  it("core.role.assign succeeds for non-owner default role IDs", () => {
    // Engine stub returns name='admin' isDefault=false for any id != 1.
    const { result, spy } = call("core.role.assign", { user_id: "u2", role_id: 2 }, "owner-1", true);
    expect(result.ok).toBe(true);
    expect(spy.assignCalls).toBe(1);
  });
});
