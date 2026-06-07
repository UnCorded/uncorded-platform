// `core.member.role` returns the target user's current role row (spec-22
// Amendment B PR 3). Gated by `core.permissions.manage` because it
// reveals role-assignment state — anyone allowed to *change* a member's
// role can also see it. Owners bypass.

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

interface RoleStub {
  id: number;
  name: string;
  level: number;
  isDefault: boolean;
  parentRole: string | null;
  createdAt: number;
  updatedAt: number;
}

function makeEngine(opts: {
  holds?: boolean;
  roleByUser?: Record<string, RoleStub>;
} = {}): RolesEngine {
  const fallback: RoleStub = {
    id: 4,
    name: "member",
    level: 10,
    isDefault: true,
    parentRole: null,
    createdAt: 0,
    updatedAt: 0,
  };
  return {
    check: (_userId: string, _key: string, caller: { isOwner: boolean }) => {
      if (caller.isOwner) return true;
      return opts.holds === true;
    },
    getRole: (userId: string) => opts.roleByUser?.[userId] ?? fallback,
    hasMinLevel: () => true,
  } as unknown as RolesEngine;
}

interface CallOut {
  ok: boolean;
  result?: unknown;
  code?: string;
}

function call(
  isOwner: boolean,
  engine: RolesEngine | undefined,
  params: Record<string, unknown>,
): CallOut {
  const out: CallOut = { ok: false };
  handleCoreClientAction(
    "core.member.role",
    params,
    "actor",
    isOwner,
    makeModule(),
    engine,
    (result) => {
      out.ok = true;
      out.result = result;
    },
    (code) => {
      out.code = code;
    },
  );
  return out;
}

describe("core.member.role", () => {
  it("returns the role for a target user (owner caller)", () => {
    const targetRole: RoleStub = {
      id: 2,
      name: "admin",
      level: 80,
      isDefault: true,
      parentRole: null,
      createdAt: 0,
      updatedAt: 0,
    };
    const out = call(true, makeEngine({ roleByUser: { target_user: targetRole } }), {
      user_id: "target_user",
    });
    expect(out.ok).toBe(true);
    expect(out.result).toEqual({ role: targetRole });
  });

  it("returns FORBIDDEN for a non-owner without core.permissions.manage", () => {
    const out = call(false, makeEngine({ holds: false }), { user_id: "target_user" });
    expect(out.code).toBe("FORBIDDEN");
  });

  it("returns OK for a non-owner WITH core.permissions.manage", () => {
    const out = call(false, makeEngine({ holds: true }), { user_id: "target_user" });
    expect(out.ok).toBe(true);
  });

  it("returns CORE_UNAVAILABLE when no roles engine is initialized", () => {
    const out = call(true, undefined, { user_id: "target_user" });
    expect(out.code).toBe("CORE_UNAVAILABLE");
  });

  it("rejects an empty user_id with core/invalid_params", () => {
    const out = call(true, makeEngine(), { user_id: "" });
    expect(out.code).toBe("core/invalid_params");
  });

  it("rejects a non-string user_id with core/invalid_params", () => {
    const out = call(true, makeEngine(), { user_id: 42 });
    expect(out.code).toBe("core/invalid_params");
  });

  it("falls back to the default member role when target has no explicit assignment", () => {
    // makeEngine's fallback is { id: 4, name: "member", level: 10 } — that's
    // exactly what RolesEngine.getRole returns for unassigned users.
    const out = call(true, makeEngine(), { user_id: "stranger" });
    expect(out.ok).toBe(true);
    expect((out.result as { role: { name: string } }).role.name).toBe("member");
  });
});
