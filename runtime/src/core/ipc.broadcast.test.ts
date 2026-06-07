// Verifies that every successful role.* / permissions.* mutation publishes
// the canonical `core.permission.changed` payload — and that failed
// mutations publish nothing. Wire shape per spec-22 Amendment B.

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

interface EngineOpts {
  succeed: boolean;
  /** Captures the engine method name actually invoked for the request. */
  invoked: string[];
}

function makeEngine(opts: EngineOpts): RolesEngine {
  const ok = { ok: true as const };
  const fail = { ok: false as const, error: { code: "HIERARCHY_VIOLATION", message: "no" } };
  const result = opts.succeed ? ok : fail;
  const role = { id: 7, name: "moderator", level: 60, isDefault: false, parentRole: null, createdAt: 0, updatedAt: 0 };
  return {
    check: () => true,
    hasMinLevel: () => true,
    getRoles: () => [role],
    getRoleById: () => role,
    getPermissions: () => [],
    listPermissionAudit: () => [],
    createRole: () => { opts.invoked.push("createRole"); return opts.succeed ? { ok: true as const, value: role } : fail; },
    updateRole: () => { opts.invoked.push("updateRole"); return opts.succeed ? { ok: true as const, value: role } : fail; },
    deleteRole: () => { opts.invoked.push("deleteRole"); return result; },
    assignRole: () => { opts.invoked.push("assignRole"); return result; },
    removeRole: () => { opts.invoked.push("removeRole"); return result; },
    grantPermission: () => { opts.invoked.push("grantPermission"); return result; },
    denyPermission: () => { opts.invoked.push("denyPermission"); return result; },
    removePermissionOverride: () => { opts.invoked.push("removePermissionOverride"); return result; },
    recordPermissionAudit: () => {},
  } as unknown as RolesEngine;
}

interface BroadcastEvent { topic: string; payload: Record<string, unknown> }

function call(
  action: string,
  params: Record<string, unknown>,
  succeed: boolean,
): BroadcastEvent[] {
  const events: BroadcastEvent[] = [];
  handleCoreClientAction(
    action,
    params,
    "owner-1",
    true, // owner so we don't tangle with permission gating
    makeModule(),
    makeEngine({ succeed, invoked: [] }),
    () => {},
    () => {},
    (topic, payload) => events.push({ topic, payload: payload as Record<string, unknown> }),
  );
  return events;
}

describe("core.permission.changed broadcast payloads (success path)", () => {
  it("core.role.create — { action, role_id }", () => {
    const events = call("core.role.create", { name: "x", level: 50 }, true);
    expect(events).toEqual([
      { topic: "core.permission.changed", payload: { action: "core.role.create", role_id: 7 } },
    ]);
  });

  it("core.role.update — { action, role_id }", () => {
    const events = call("core.role.update", { role_id: 7, level: 50 }, true);
    expect(events[0]).toEqual({
      topic: "core.permission.changed",
      payload: { action: "core.role.update", role_id: 7 },
    });
  });

  it("core.role.delete — { action, role_id }", () => {
    const events = call("core.role.delete", { role_id: 7 }, true);
    expect(events[0]).toEqual({
      topic: "core.permission.changed",
      payload: { action: "core.role.delete", role_id: 7 },
    });
  });

  it("core.role.assign — { action, user_id, role_id }", () => {
    const events = call("core.role.assign", { user_id: "u2", role_id: 7 }, true);
    expect(events[0]).toEqual({
      topic: "core.permission.changed",
      payload: { action: "core.role.assign", user_id: "u2", role_id: 7 },
    });
  });

  it("core.role.remove — { action, user_id }", () => {
    const events = call("core.role.remove", { user_id: "u2" }, true);
    expect(events[0]).toEqual({
      topic: "core.permission.changed",
      payload: { action: "core.role.remove", user_id: "u2" },
    });
  });

  it("core.permissions.grant — { action, role_id, permission }", () => {
    const events = call("core.permissions.grant", { role_id: 7, permission: "p.k" }, true);
    expect(events[0]).toEqual({
      topic: "core.permission.changed",
      payload: { action: "core.permissions.grant", role_id: 7, permission: "p.k" },
    });
  });

  it("core.permissions.deny — { action, role_id, permission }", () => {
    const events = call("core.permissions.deny", { role_id: 7, permission: "p.k" }, true);
    expect(events[0]).toEqual({
      topic: "core.permission.changed",
      payload: { action: "core.permissions.deny", role_id: 7, permission: "p.k" },
    });
  });

  it("core.permissions.remove — { action, role_id, permission }", () => {
    const events = call("core.permissions.remove", { role_id: 7, permission: "p.k" }, true);
    expect(events[0]).toEqual({
      topic: "core.permission.changed",
      payload: { action: "core.permissions.remove", role_id: 7, permission: "p.k" },
    });
  });
});

describe("core.permission.changed broadcast — failure path emits nothing", () => {
  const cases: Array<{ action: string; params: Record<string, unknown> }> = [
    { action: "core.role.create",          params: { name: "x", level: 50 } },
    { action: "core.role.update",          params: { role_id: 7, level: 50 } },
    { action: "core.role.delete",          params: { role_id: 7 } },
    { action: "core.role.assign",          params: { user_id: "u2", role_id: 7 } },
    { action: "core.role.remove",          params: { user_id: "u2" } },
    { action: "core.permissions.grant",    params: { role_id: 7, permission: "p.k" } },
    { action: "core.permissions.deny",     params: { role_id: 7, permission: "p.k" } },
    { action: "core.permissions.remove",   params: { role_id: 7, permission: "p.k" } },
  ];
  for (const { action, params } of cases) {
    it(`${action} — engine error emits no broadcast`, () => {
      const events = call(action, params, false);
      expect(events).toEqual([]);
    });
  }
});
