import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { CoreModule } from "./module";
import { handleCoreIpc, handleCoreClientAction } from "./ipc";
import { createLogger } from "@uncorded/shared";
import type { IpcMessage } from "@uncorded/protocol";
import type { StdioParentTransport } from "../ipc/transport";
import type { EventBus } from "../events/bus";
import type { RolesEngine } from "../roles/engine";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function makeModule() {
  const db = new Database(":memory:");
  const mod = new CoreModule(db, makeMockBus(), createLogger({ test: true }));
  mod.initialize();
  return mod;
}

function makeTransport(): StdioParentTransport & { sent: IpcMessage[] } {
  const sent: IpcMessage[] = [];
  return {
    sent,
    send(msg: IpcMessage) { sent.push(msg); },
    onMessage() {},
    close() {},
  } as unknown as StdioParentTransport & { sent: IpcMessage[] };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("handleCoreIpc", () => {
  it("core.user.get — returns null for unknown user", () => {
    const mod = makeModule();
    const transport = makeTransport();
    handleCoreIpc({ type: "core.user.get", id: "r1", userId: "unknown" }, transport, mod);
    expect(transport.sent).toHaveLength(1);
    const reply = transport.sent[0] as Record<string, unknown>;
    expect(reply["type"]).toBe("response");
    expect(reply["id"]).toBe("r1");
    expect((reply["result"] as Record<string, unknown>)["user"]).toBeNull();
  });

  it("core.user.get — returns user after connect", () => {
    const mod = makeModule();
    const transport = makeTransport();
    mod.onUserConnected("u1", "alice", "Alice", "");
    handleCoreIpc({ type: "core.user.get", id: "r2", userId: "u1" }, transport, mod);
    const reply = transport.sent[0] as Record<string, unknown>;
    const user = (reply["result"] as Record<string, unknown>)["user"] as Record<string, unknown>;
    expect(user["display_name"]).toBe("Alice");
    expect(user["is_online"]).toBe(true);
  });

  it("core.user.getMany — batches by ids", () => {
    const mod = makeModule();
    const transport = makeTransport();
    mod.onUserConnected("u1", "alice", "Alice", "");
    mod.onUserConnected("u2", "bob", "Bob", "");
    handleCoreIpc({ type: "core.user.getMany", id: "r3", userIds: ["u1", "u2"] }, transport, mod);
    const reply = transport.sent[0] as Record<string, unknown>;
    const users = (reply["result"] as Record<string, unknown>)["users"] as unknown[];
    expect(users).toHaveLength(2);
  });

  it("core.user.getOnline — returns only online users", () => {
    const mod = makeModule();
    const transport = makeTransport();
    mod.onUserConnected("u1", "alice", "Alice", "");
    mod.onUserConnected("u2", "bob", "Bob", "");
    mod.onUserDisconnected("u2");
    handleCoreIpc({ type: "core.user.getOnline", id: "r4" }, transport, mod);
    const reply = transport.sent[0] as Record<string, unknown>;
    const users = (reply["result"] as Record<string, unknown>)["users"] as unknown[];
    expect(users).toHaveLength(1);
  });

  it("unknown core.* action returns error", () => {
    const mod = makeModule();
    const transport = makeTransport();
    handleCoreIpc({ type: "core.user.doesNotExist", id: "r5" }, transport, mod);
    const reply = transport.sent[0] as Record<string, unknown>;
    expect((reply["error"] as Record<string, unknown>)["code"]).toBe("core/unknown_action");
  });

  it("invalid params returns error", () => {
    const mod = makeModule();
    const transport = makeTransport();
    handleCoreIpc({ type: "core.user.get", id: "r6", userId: 123 }, transport, mod);
    const reply = transport.sent[0] as Record<string, unknown>;
    expect((reply["error"] as Record<string, unknown>)["code"]).toBe("core/invalid_params");
  });

  it("message without id is silently discarded", () => {
    const mod = makeModule();
    const transport = makeTransport();
    handleCoreIpc({ type: "core.user.getOnline" }, transport, mod);
    expect(transport.sent).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// handleCoreClientAction — covers the new named-permission gating and
// the owner-only core.permissions.* surface.
// ---------------------------------------------------------------------------

interface FakeRolesEngine {
  granted: Set<string>; // `${roleId}|${permKey}`
  permissions: Map<string, { defaultLevel: number }>;
  userLevel: Map<string, number>;
  audits: Array<{ actor: string; roleId: number | null; perm: string; action: string; reason?: string }>;
  grantCalls: Array<{ roleId: number; perm: string }>;
  roles: Array<{ id: number; name: string; level: number; isDefault: boolean; parentRole: number | null; createdAt: number; updatedAt: number }>;
  assigned: Array<{ userId: string; roleId: number }>;
}

function makeFakeEngine(opts: {
  permissions?: Record<string, number>;
  userLevels?: Record<string, number>;
  granted?: Array<[number, string]>;
} = {}): FakeRolesEngine & RolesEngine {
  const fake: FakeRolesEngine = {
    granted: new Set((opts.granted ?? []).map(([r, p]) => `${r}|${p}`)),
    permissions: new Map(
      Object.entries(opts.permissions ?? {}).map(([k, v]) => [k, { defaultLevel: v }]),
    ),
    userLevel: new Map(Object.entries(opts.userLevels ?? {})),
    audits: [],
    grantCalls: [],
    roles: [
      { id: 1, name: "owner", level: 100, isDefault: true, parentRole: null, createdAt: 0, updatedAt: 0 },
      { id: 2, name: "admin", level: 80, isDefault: true, parentRole: null, createdAt: 0, updatedAt: 0 },
      { id: 3, name: "moderator", level: 60, isDefault: true, parentRole: null, createdAt: 0, updatedAt: 0 },
      { id: 4, name: "member", level: 10, isDefault: true, parentRole: null, createdAt: 0, updatedAt: 0 },
    ],
    assigned: [],
  };

  const stub: Partial<RolesEngine> = {
    check(userId: string, key: string, caller: { isOwner: boolean }): boolean {
      if (caller.isOwner) return true;
      const level = fake.userLevel.get(userId) ?? 10;
      const perm = fake.permissions.get(key);
      if (!perm) return false;
      if (fake.granted.has(`${getRoleIdForUser(userId)}|${key}`)) return true;
      return level >= perm.defaultLevel;
    },
    hasMinLevel(userId: string, level: number, caller: { isOwner: boolean }): boolean {
      if (caller.isOwner) return true;
      return (fake.userLevel.get(userId) ?? 10) >= level;
    },
    getRole(userId: string) {
      return {
        id: getRoleIdForUser(userId),
        name: `lvl${fake.userLevel.get(userId) ?? 10}`,
        level: fake.userLevel.get(userId) ?? 10,
        isDefault: false,
        parentRole: null,
        createdAt: 0,
        updatedAt: 0,
      };
    },
    getPermissions() {
      return [...fake.permissions.entries()].map(([key, v], i) => ({
        id: i + 1,
        key,
        description: "",
        defaultLevel: v.defaultLevel,
        pluginSlug: "core",
        registeredAt: 0,
      }));
    },
    getRoles() {
      return fake.roles;
    },
    getRoleById(id: number) {
      return fake.roles.find((r) => r.id === id) ?? null;
    },
    createRole(input, caller) {
      const callerLevel = caller.isOwner ? 100 : (fake.userLevel.get(caller.userId) ?? 10);
      if (input.level >= callerLevel) {
        return { ok: false as const, error: { code: "HIERARCHY_VIOLATION", message: "no" } };
      }
      const role = {
        id: fake.roles.length + 1,
        name: input.name,
        level: input.level,
        isDefault: false,
        parentRole: null,
        createdAt: 0,
        updatedAt: 0,
      };
      fake.roles.push(role);
      return { ok: true as const, value: role };
    },
    updateRole(id, input) {
      const role = fake.roles.find((r) => r.id === id);
      if (!role) return { ok: false as const, error: { code: "ROLE_NOT_FOUND", message: "missing" } };
      const updated = { ...role, ...input };
      fake.roles = fake.roles.map((r) => (r.id === id ? updated : r));
      return { ok: true as const, value: updated };
    },
    deleteRole(id) {
      fake.roles = fake.roles.filter((r) => r.id !== id);
      return { ok: true as const };
    },
    assignRole(userId, roleId) {
      fake.assigned.push({ userId, roleId });
      return { ok: true as const };
    },
    removeRole(userId) {
      fake.assigned = fake.assigned.filter((a) => a.userId !== userId);
      return { ok: true as const };
    },
    canActOn() { return true; },
    grantPermission(roleId: number, key: string) {
      fake.grantCalls.push({ roleId, perm: key });
      fake.granted.add(`${roleId}|${key}`);
      return { ok: true as const };
    },
    denyPermission() { return { ok: true as const }; },
    removePermissionOverride() { return { ok: true as const }; },
    listPermissionAudit() {
      return fake.audits.map((a, i) => ({
        id: i + 1,
        ts: i,
        actor_user_id: a.actor,
        target_role_id: a.roleId,
        permission: a.perm,
        action: a.action,
        reason: a.reason ?? null,
      }));
    },
    recordPermissionAudit(actor, roleId, perm, action, reason) {
      const entry: { actor: string; roleId: number | null; perm: string; action: string; reason?: string } =
        { actor, roleId, perm, action };
      if (reason !== undefined) entry.reason = reason;
      fake.audits.push(entry);
    },
  };

  return Object.assign(stub, fake) as FakeRolesEngine & RolesEngine;
}

function getRoleIdForUser(userId: string): number {
  // Deterministic synthetic role-id per user — fine for unit tests.
  let h = 0;
  for (let i = 0; i < userId.length; i++) h = (h * 31 + userId.charCodeAt(i)) >>> 0;
  return (h % 1000) + 1;
}

function captureClient() {
  const calls: Array<{ kind: "ok" | "err"; payload: unknown }> = [];
  return {
    calls,
    onOk(result: unknown) { calls.push({ kind: "ok", payload: result }); },
    onErr(code: string, msg: string) { calls.push({ kind: "err", payload: { code, msg } }); },
  };
}

describe("handleCoreClientAction — named-permission gating", () => {
  it("level 50 user with grant on core.categories.manage may create a category", () => {
    const mod = makeModule();
    const engine = makeFakeEngine({
      permissions: { "core.categories.manage": 80 },
      userLevels: { u50: 50 },
      granted: [[getRoleIdForUser("u50"), "core.categories.manage"]],
    });
    const c = captureClient();
    handleCoreClientAction(
      "core.categories.create",
      { name: "General" },
      "u50",
      false,
      mod,
      engine,
      c.onOk,
      c.onErr,
    );
    expect(c.calls).toHaveLength(1);
    expect(c.calls[0]!.kind).toBe("ok");
  });

  it("level 90 user without grant fails when default_level=80 is overridden by deny", () => {
    const mod = makeModule();
    const engine = makeFakeEngine({
      permissions: { "core.categories.manage": 80 },
      userLevels: { u90: 90 },
      // explicitly NOT granted; check() falls through to level 90 ≥ 80 → would pass.
      // To assert the deny path we have to deny by removing default-level fall-through.
    });
    // Force check() to return false for this user/permission.
    const original = engine.check.bind(engine);
    engine.check = (userId, key, caller) => {
      if (userId === "u90" && key === "core.categories.manage") return false;
      return original(userId, key, caller);
    };
    const c = captureClient();
    handleCoreClientAction(
      "core.categories.create",
      { name: "General" },
      "u90",
      false,
      mod,
      engine,
      c.onOk,
      c.onErr,
    );
    expect(c.calls).toHaveLength(1);
    expect(c.calls[0]!.kind).toBe("err");
    expect((c.calls[0]!.payload as { code: string }).code).toBe("FORBIDDEN");
  });

  it("missing rolesEngine fails closed for non-owner on category create", () => {
    const mod = makeModule();
    const c = captureClient();
    handleCoreClientAction(
      "core.categories.create",
      { name: "General" },
      "u1",
      false,
      mod,
      undefined,
      c.onOk,
      c.onErr,
    );
    expect(c.calls[0]!.kind).toBe("err");
    expect((c.calls[0]!.payload as { code: string }).code).toBe("FORBIDDEN");
  });

  it("owner bypass — category create succeeds without rolesEngine", () => {
    const mod = makeModule();
    const c = captureClient();
    handleCoreClientAction(
      "core.categories.create",
      { name: "General" },
      "owner-1",
      true,
      mod,
      undefined,
      c.onOk,
      c.onErr,
    );
    expect(c.calls[0]!.kind).toBe("ok");
  });
});

describe("handleCoreClientAction — core.role.* and core.permissions.* management", () => {
  it("non-owner cannot list", () => {
    const mod = makeModule();
    const engine = makeFakeEngine({ permissions: { "core.categories.manage": 80 } });
    const c = captureClient();
    handleCoreClientAction(
      "core.permissions.list",
      {},
      "u1",
      false,
      mod,
      engine,
      c.onOk,
      c.onErr,
    );
    expect(c.calls[0]!.kind).toBe("err");
    expect((c.calls[0]!.payload as { code: string }).code).toBe("FORBIDDEN");
  });

  it("owner can list and gets seeded permissions", () => {
    const mod = makeModule();
    const engine = makeFakeEngine({ permissions: { "core.categories.manage": 80 } });
    const c = captureClient();
    handleCoreClientAction(
      "core.permissions.list",
      {},
      "owner-1",
      true,
      mod,
      engine,
      c.onOk,
      c.onErr,
    );
    expect(c.calls[0]!.kind).toBe("ok");
    const result = c.calls[0]!.payload as { permissions: Array<{ key: string }> };
    expect(result.permissions.some((p) => p.key === "core.categories.manage")).toBe(true);
  });

  it("admin with core.permissions.manage can list permissions", () => {
    const mod = makeModule();
    const engine = makeFakeEngine({
      permissions: {
        "core.categories.manage": 80,
        "core.permissions.manage": 100,
      },
      userLevels: { admin1: 80 },
      granted: [[getRoleIdForUser("admin1"), "core.permissions.manage"]],
    });
    const c = captureClient();
    handleCoreClientAction(
      "core.permissions.list",
      {},
      "admin1",
      false,
      mod,
      engine,
      c.onOk,
      c.onErr,
    );
    expect(c.calls[0]!.kind).toBe("ok");
    const result = c.calls[0]!.payload as { permissions: Array<{ key: string }> };
    expect(result.permissions.some((p) => p.key === "core.permissions.manage")).toBe(true);
  });

  it("admin with manage permission can create a lower role and broadcasts invalidation", () => {
    const mod = makeModule();
    const engine = makeFakeEngine({
      permissions: { "core.permissions.manage": 100 },
      userLevels: { admin1: 80 },
      granted: [[getRoleIdForUser("admin1"), "core.permissions.manage"]],
    });
    const c = captureClient();
    const events: Array<{ topic: string; payload: unknown }> = [];
    handleCoreClientAction(
      "core.role.create",
      { name: "helper", level: 40 },
      "admin1",
      false,
      mod,
      engine,
      c.onOk,
      c.onErr,
      (topic, payload) => events.push({ topic, payload }),
    );
    expect(c.calls[0]!.kind).toBe("ok");
    expect((c.calls[0]!.payload as { role: { name: string } }).role.name).toBe("helper");
    expect(events[0]!.topic).toBe("core.permission.changed");
  });

  it("admin cannot create a peer role even with manage permission", () => {
    const mod = makeModule();
    const engine = makeFakeEngine({
      permissions: { "core.permissions.manage": 100 },
      userLevels: { admin1: 80 },
      granted: [[getRoleIdForUser("admin1"), "core.permissions.manage"]],
    });
    const c = captureClient();
    handleCoreClientAction(
      "core.role.create",
      { name: "peer", level: 80 },
      "admin1",
      false,
      mod,
      engine,
      c.onOk,
      c.onErr,
    );
    expect(c.calls[0]!.kind).toBe("err");
    expect((c.calls[0]!.payload as { code: string }).code).toBe("HIERARCHY_VIOLATION");
  });

  it("role assign replaces the target user's role", () => {
    const mod = makeModule();
    const engine = makeFakeEngine({
      permissions: { "core.permissions.manage": 100 },
      userLevels: { admin1: 80 },
      granted: [[getRoleIdForUser("admin1"), "core.permissions.manage"]],
    });
    const c = captureClient();
    handleCoreClientAction(
      "core.role.assign",
      { user_id: "u2", role_id: 3 },
      "admin1",
      false,
      mod,
      engine,
      c.onOk,
      c.onErr,
    );
    expect(c.calls[0]!.kind).toBe("ok");
    expect(engine.assigned).toEqual([{ userId: "u2", roleId: 3 }]);
  });

  it("owner grant records an audit row", () => {
    const mod = makeModule();
    const engine = makeFakeEngine({ permissions: { "core.categories.manage": 80 } });
    const c = captureClient();
    handleCoreClientAction(
      "core.permissions.grant",
      { role_id: 7, permission: "core.categories.manage", reason: "promoting" },
      "owner-1",
      true,
      mod,
      engine,
      c.onOk,
      c.onErr,
    );
    expect(c.calls[0]!.kind).toBe("ok");
    expect(engine.audits).toHaveLength(1);
    expect(engine.audits[0]!.action).toBe("grant");
    expect(engine.audits[0]!.reason).toBe("promoting");
    expect(engine.grantCalls).toHaveLength(1);
  });

  it("grant rejects bad role_id", () => {
    const mod = makeModule();
    const engine = makeFakeEngine({ permissions: { "core.categories.manage": 80 } });
    const c = captureClient();
    handleCoreClientAction(
      "core.permissions.grant",
      { role_id: 0, permission: "core.categories.manage" },
      "owner-1",
      true,
      mod,
      engine,
      c.onOk,
      c.onErr,
    );
    expect(c.calls[0]!.kind).toBe("err");
    expect((c.calls[0]!.payload as { code: string }).code).toBe("core/invalid_params");
  });

  it("grant rejects oversize reason", () => {
    const mod = makeModule();
    const engine = makeFakeEngine({ permissions: { "core.categories.manage": 80 } });
    const c = captureClient();
    handleCoreClientAction(
      "core.permissions.grant",
      { role_id: 7, permission: "core.categories.manage", reason: "x".repeat(513) },
      "owner-1",
      true,
      mod,
      engine,
      c.onOk,
      c.onErr,
    );
    expect(c.calls[0]!.kind).toBe("err");
    expect((c.calls[0]!.payload as { code: string }).code).toBe("core/invalid_params");
  });
});
