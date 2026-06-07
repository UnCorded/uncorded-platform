// Privilege-escalation regression suite for `assertGrantSafe`.
//
// The vulnerability shape: an actor holding only `core.permissions.manage`
// could otherwise call `core.permissions.grant` to hand themselves any
// permission via a confederate role. The guard in core/permissions.ts:54
// blocks every grant/deny where the actor does not themselves hold the
// permission they are about to delegate. Hierarchy is enforced separately
// by the engine on the actual mutation (HIERARCHY_VIOLATION).

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

interface EngineState {
  /** Permissions the actor holds — used to satisfy assertGrantSafe. */
  actorHolds: Set<string>;
  /** Returns from grantPermission/denyPermission/removePermissionOverride. */
  mutationResult: { ok: true } | { ok: false; error: { code: string; message: string } };
  grantCalls: number;
  denyCalls: number;
  removeCalls: number;
}

function makeEngine(state: EngineState): RolesEngine {
  return {
    // assertGrantSafe + requirePermission both call check(); whichever
    // permission the test wants the actor to hold is in actorHolds.
    check: (_userId: string, key: string, caller: { isOwner: boolean }) => {
      if (caller.isOwner) return true;
      return state.actorHolds.has(key);
    },
    grantPermission: () => { state.grantCalls++; return state.mutationResult; },
    denyPermission: () => { state.denyCalls++; return state.mutationResult; },
    removePermissionOverride: () => { state.removeCalls++; return state.mutationResult; },
    recordPermissionAudit: () => {},
  } as unknown as RolesEngine;
}

interface CallOut {
  ok: boolean;
  code?: string;
  message?: string;
}

function call(
  action: "core.permissions.grant" | "core.permissions.deny" | "core.permissions.remove",
  state: EngineState,
  permission: string,
  isOwner = false,
): CallOut {
  const out: CallOut = { ok: false };
  handleCoreClientAction(
    action,
    { role_id: 7, permission },
    "actor",
    isOwner,
    makeModule(),
    makeEngine(state),
    () => { out.ok = true; },
    (code, message) => { out.code = code; out.message = message; },
  );
  return out;
}

function newState(overrides: Partial<EngineState> = {}): EngineState {
  return {
    actorHolds: new Set(["core.permissions.manage"]),
    mutationResult: { ok: true },
    grantCalls: 0,
    denyCalls: 0,
    removeCalls: 0,
    ...overrides,
  };
}

describe("assertGrantSafe escalation guard", () => {
  it("admin with only core.permissions.manage cannot grant a permission they do not hold", () => {
    const state = newState();
    const out = call("core.permissions.grant", state, "plugin.dangerous.feature");
    expect(out.code).toBe("FORBIDDEN");
    expect(out.message).toContain("cannot grant");
    expect(state.grantCalls).toBe(0);
  });

  it("admin with only core.permissions.manage cannot deny a permission they do not hold", () => {
    const state = newState();
    const out = call("core.permissions.deny", state, "plugin.dangerous.feature");
    expect(out.code).toBe("FORBIDDEN");
    expect(out.message).toContain("cannot deny");
    expect(state.denyCalls).toBe(0);
  });

  it("admin holding the target permission may delegate it", () => {
    const state = newState({
      actorHolds: new Set(["core.permissions.manage", "plugin.safe.feature"]),
    });
    const out = call("core.permissions.grant", state, "plugin.safe.feature");
    expect(out.ok).toBe(true);
    expect(state.grantCalls).toBe(1);
  });

  it("owner bypasses the guard entirely", () => {
    const state = newState({ actorHolds: new Set() });
    const out = call("core.permissions.grant", state, "anything.at.all", true);
    expect(out.ok).toBe(true);
    expect(state.grantCalls).toBe(1);
  });

  it("remove override does NOT require the actor to hold the permission (no escalation risk)", () => {
    // Removing an override only ever reduces or restores defaults; it
    // cannot grant a permission the actor doesn't have, so the guard
    // is intentionally not applied to `remove`.
    const state = newState();
    const out = call("core.permissions.remove", state, "plugin.dangerous.feature");
    expect(out.ok).toBe(true);
    expect(state.removeCalls).toBe(1);
  });

  it("guard message names the operation (grant vs deny) so the UI can tell them apart", () => {
    const state = newState();
    expect(call("core.permissions.grant", state, "p").message).toContain("grant");
    expect(call("core.permissions.deny", state, "p").message).toContain("deny");
  });
});
