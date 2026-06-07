// Verifies that EVERY role.* and permissions.* surface is gated by the
// `core.permissions.manage` named permission (per spec-22 Amendment B).
// Previously the surface was gated by raw role level (LEVEL_ADMIN); the
// migration to named permissions allows owners to grant the manage
// capability to a custom role at any level.

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

function makeEngine(opts: { holds?: boolean } = {}): RolesEngine {
  return {
    check: (_userId: string, _key: string, caller: { isOwner: boolean }) => {
      if (caller.isOwner) return true;
      // For the gating test we want a "permitted" actor to clear both
      // requirePermission(core.permissions.manage) and the assertGrantSafe
      // escalation guard on grant/deny. The escalation guard is exercised
      // separately in ipc.assert-grant-safe.test.ts.
      return opts.holds === true;
    },
    hasMinLevel: () => true,
    getRoles: () => [],
    getRoleById: () => null,
    getRoleOverrides: () => [],
    getRoleMemberCounts: () => new Map<number, number>(),
    getPermissions: () => [],
    listPermissionAudit: () => [],
    createRole: () => ({ ok: true as const, value: { id: 9, name: "x", level: 50, isDefault: false, parentRole: null, createdAt: 0, updatedAt: 0 } }),
    updateRole: () => ({ ok: true as const, value: { id: 9, name: "x", level: 50, isDefault: false, parentRole: null, createdAt: 0, updatedAt: 0 } }),
    deleteRole: () => ({ ok: true as const }),
    assignRole: () => ({ ok: true as const }),
    removeRole: () => ({ ok: true as const }),
    grantPermission: () => ({ ok: true as const }),
    denyPermission: () => ({ ok: true as const }),
    removePermissionOverride: () => ({ ok: true as const }),
    recordPermissionAudit: () => {},
  } as unknown as RolesEngine;
}

const GATED_ACTIONS: Array<{ action: string; params: Record<string, unknown> }> = [
  { action: "core.role.list",            params: {} },
  { action: "core.role.create",          params: { name: "x", level: 50 } },
  { action: "core.role.update",          params: { role_id: 9, name: "y" } },
  { action: "core.role.delete",          params: { role_id: 9 } },
  { action: "core.role.assign",          params: { user_id: "u2", role_id: 9 } },
  { action: "core.role.remove",          params: { user_id: "u2" } },
  { action: "core.permissions.list",     params: {} },
  { action: "core.permissions.grant",    params: { role_id: 9, permission: "plugin.x" } },
  { action: "core.permissions.deny",     params: { role_id: 9, permission: "plugin.x" } },
  { action: "core.permissions.remove",   params: { role_id: 9, permission: "plugin.x" } },
  { action: "core.permissions.audit",    params: {} },
  { action: "core.permissions.grantMany", params: { role_id: 9, changes: [{ permission: "plugin.x", op: "grant" }] } },
];

interface CallOut { ok: boolean; code?: string }

function call(
  action: string,
  params: Record<string, unknown>,
  isOwner: boolean,
  engine: RolesEngine | undefined,
): CallOut {
  const out: CallOut = { ok: false };
  handleCoreClientAction(
    action,
    params,
    "actor",
    isOwner,
    makeModule(),
    engine,
    () => { out.ok = true; },
    (code) => { out.code = code; },
  );
  return out;
}

describe("core.permissions.manage gates every role.*/permissions.* action", () => {
  for (const { action, params } of GATED_ACTIONS) {
    it(`${action} — non-owner without the permission gets FORBIDDEN`, () => {
      const out = call(action, params, false, makeEngine({ holds: false }));
      expect(out.code).toBe("FORBIDDEN");
    });
  }

  for (const { action, params } of GATED_ACTIONS) {
    it(`${action} — non-owner WITH the permission proceeds past the gate`, () => {
      const out = call(action, params, false, makeEngine({ holds: true }));
      // Either ok=true OR a downstream error (not the gating error).
      expect(out.code === undefined || out.code !== "FORBIDDEN").toBe(true);
    });
  }

  for (const { action, params } of GATED_ACTIONS) {
    it(`${action} — missing rolesEngine returns CORE_UNAVAILABLE for non-owner`, () => {
      const out = call(action, params, false, undefined);
      expect(out.code).toBe("CORE_UNAVAILABLE");
    });
  }

  for (const { action, params } of GATED_ACTIONS) {
    it(`${action} — owner bypasses the gate without an engine present`, () => {
      // Some actions do still require the engine for behavior (e.g. role.list);
      // those return CORE_UNAVAILABLE. The point of this case is that the
      // failure mode is NOT FORBIDDEN — owner bypass is honored.
      const out = call(action, params, true, undefined);
      expect(out.code).not.toBe("FORBIDDEN");
    });
  }
});
