import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { CoreModule } from "./module";
import { handleCoreClientAction } from "./ipc";
import { createLogger } from "@uncorded/shared";
import type { EventBus } from "../events/bus";
import type { RolesEngine } from "../roles/engine";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

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

interface FakeEngineState {
  /** Permission keys the engine knows about (with default level 80). */
  knownPermissions: Set<string>;
  /** Per-role granted overrides — `${roleId}|${perm}` strings. */
  granted: Set<string>;
  /** Per-role denied overrides. */
  denied: Set<string>;
  /** Raw audit rows captured. */
  audits: Array<{ actor: string; roleId: number | null; perm: string; action: string; reason?: string }>;
  /** Engine errors to inject for specific (roleId, perm) tuples. */
  failOn: Map<string, { code: string; message: string }>;
}

function makeFakeEngine(state: FakeEngineState): RolesEngine {
  const stub: Partial<RolesEngine> = {
    check(_userId, key, caller) {
      if (caller.isOwner) return true;
      // Owner-only manage permission for tests; everything else falls
      // through depending on `granted`.
      if (key === "core.permissions.manage") return false;
      return state.knownPermissions.has(key);
    },
    grantPermission(roleId, key) {
      const failKey = `${roleId}|${key}`;
      const failure = state.failOn.get(failKey);
      if (failure) return { ok: false as const, error: failure };
      state.granted.add(failKey);
      state.denied.delete(failKey);
      return { ok: true as const };
    },
    denyPermission(roleId, key) {
      const failKey = `${roleId}|${key}`;
      const failure = state.failOn.get(failKey);
      if (failure) return { ok: false as const, error: failure };
      state.denied.add(failKey);
      state.granted.delete(failKey);
      return { ok: true as const };
    },
    removePermissionOverride(roleId, key) {
      const failKey = `${roleId}|${key}`;
      state.granted.delete(failKey);
      state.denied.delete(failKey);
      return { ok: true as const };
    },
    recordPermissionAudit(actor, roleId, perm, action, reason) {
      const entry: { actor: string; roleId: number | null; perm: string; action: string; reason?: string } =
        { actor, roleId, perm, action };
      if (reason !== undefined) entry.reason = reason;
      state.audits.push(entry);
    },
  };
  return stub as unknown as RolesEngine;
}

function newState(opts: { knownPermissions?: string[] } = {}): FakeEngineState {
  return {
    knownPermissions: new Set(opts.knownPermissions ?? ["plugin.foo", "plugin.bar", "plugin.baz"]),
    granted: new Set(),
    denied: new Set(),
    audits: [],
    failOn: new Map(),
  };
}

interface BulkResult {
  applied: number;
  skipped: Array<{ permission: string; code: string; message: string }>;
}

function callBulk(
  engine: RolesEngine,
  params: Record<string, unknown>,
  opts: { isOwner?: boolean; broadcast?: (topic: string, payload: unknown) => void } = {},
): { result?: BulkResult; error?: { code: string; message: string } } {
  const out: { result?: BulkResult; error?: { code: string; message: string } } = {};
  handleCoreClientAction(
    "core.permissions.grantMany",
    params,
    "actor",
    opts.isOwner ?? true, // owner by default — we test gating separately
    makeModule(),
    engine,
    (r) => { out.result = r as BulkResult; },
    (code, message) => { out.error = { code, message }; },
    opts.broadcast,
  );
  return out;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("core.permissions.grantMany", () => {
  it("applies a mix of grant/deny/remove and reports applied count", () => {
    const state = newState();
    state.granted.add("7|plugin.baz"); // pre-existing override removed below
    const events: Array<{ topic: string; payload: unknown }> = [];
    const out = callBulk(makeFakeEngine(state), {
      role_id: 7,
      changes: [
        { permission: "plugin.foo", op: "grant" },
        { permission: "plugin.bar", op: "deny", reason: "anti-spam" },
        { permission: "plugin.baz", op: "remove" },
      ],
    }, { broadcast: (topic, payload) => events.push({ topic, payload }) });

    expect(out.error).toBeUndefined();
    expect(out.result?.applied).toBe(3);
    expect(out.result?.skipped).toEqual([]);
    expect(state.granted.has("7|plugin.foo")).toBe(true);
    expect(state.denied.has("7|plugin.bar")).toBe(true);
    expect(state.granted.has("7|plugin.baz")).toBe(false);
    // One broadcast per successful change.
    expect(events).toHaveLength(3);
    expect(events[0]!.topic).toBe("core.permission.changed");
  });

  it("partial-failure: engine error on one change surfaces in `skipped`, others apply", () => {
    const state = newState();
    state.failOn.set("7|plugin.bar", { code: "ROLE_NOT_FOUND", message: "no such role" });
    const out = callBulk(makeFakeEngine(state), {
      role_id: 7,
      changes: [
        { permission: "plugin.foo", op: "grant" },
        { permission: "plugin.bar", op: "grant" },
        { permission: "plugin.baz", op: "grant" },
      ],
    });
    expect(out.result?.applied).toBe(2);
    expect(out.result?.skipped).toEqual([
      { permission: "plugin.bar", code: "ROLE_NOT_FOUND", message: "no such role" },
    ]);
  });

  it("malformed individual entries are skipped, not fatal", () => {
    const out = callBulk(makeFakeEngine(newState()), {
      role_id: 7,
      changes: [
        { permission: "plugin.foo", op: "grant" },
        { permission: "", op: "grant" },                  // empty key
        { permission: "plugin.bar", op: "nuke" },         // invalid op
        { permission: "plugin.baz", op: "grant", reason: 123 }, // bad reason type
        { permission: "plugin.foo", op: "deny", reason: "x".repeat(513) }, // reason too long
      ],
    });
    expect(out.result?.applied).toBe(1);
    expect(out.result?.skipped.map((s) => s.code)).toEqual([
      "core/invalid_params",
      "core/invalid_params",
      "core/invalid_params",
      "core/invalid_params",
    ]);
  });

  it("rejects the whole batch when role_id is missing or invalid", () => {
    const out = callBulk(makeFakeEngine(newState()), {
      changes: [{ permission: "plugin.foo", op: "grant" }],
    });
    expect(out.error?.code).toBe("core/invalid_params");
    expect(out.error?.message).toContain("role_id");
  });

  it("rejects the whole batch when changes is missing or non-array", () => {
    const noChanges = callBulk(makeFakeEngine(newState()), { role_id: 1 });
    expect(noChanges.error?.code).toBe("core/invalid_params");

    const stringChanges = callBulk(makeFakeEngine(newState()), { role_id: 1, changes: "all" });
    expect(stringChanges.error?.code).toBe("core/invalid_params");
  });

  it("rejects the whole batch when changes is empty", () => {
    const out = callBulk(makeFakeEngine(newState()), { role_id: 1, changes: [] });
    expect(out.error?.code).toBe("core/invalid_params");
    expect(out.error?.message).toContain("at least one");
  });

  it("rejects the whole batch above the 50-change cap", () => {
    const changes = Array.from({ length: 51 }, (_, i) => ({
      permission: `plugin.p${i}`,
      op: "grant" as const,
    }));
    const out = callBulk(makeFakeEngine(newState({ knownPermissions: changes.map((c) => c.permission) })), {
      role_id: 1,
      changes,
    });
    expect(out.error?.code).toBe("core/invalid_params");
    expect(out.error?.message).toContain("50");
  });

  it("non-owner without core.permissions.manage is FORBIDDEN before any change applies", () => {
    const state = newState();
    const out = callBulk(makeFakeEngine(state), {
      role_id: 7,
      changes: [{ permission: "plugin.foo", op: "grant" }],
    }, { isOwner: false });
    expect(out.error?.code).toBe("FORBIDDEN");
    expect(state.granted.size).toBe(0);
    expect(state.audits).toHaveLength(0);
  });

  it("audit row is written per applied change, none for skipped", () => {
    const state = newState();
    state.failOn.set("7|plugin.bar", { code: "ROLE_NOT_FOUND", message: "x" });
    callBulk(makeFakeEngine(state), {
      role_id: 7,
      changes: [
        { permission: "plugin.foo", op: "grant", reason: "promoted" },
        { permission: "plugin.bar", op: "deny" }, // engine fails this one
      ],
    });
    expect(state.audits).toEqual([
      { actor: "actor", roleId: 7, perm: "plugin.foo", action: "grant", reason: "promoted" },
    ]);
  });

  it("emits exactly one broadcast per successful change, with per-op action label", () => {
    const events: Array<{ topic: string; payload: Record<string, unknown> }> = [];
    callBulk(makeFakeEngine(newState()), {
      role_id: 9,
      changes: [
        { permission: "plugin.foo", op: "grant" },
        { permission: "plugin.bar", op: "deny" },
        { permission: "plugin.baz", op: "remove" },
      ],
    }, { broadcast: (topic, payload) => events.push({ topic, payload: payload as Record<string, unknown> }) });
    expect(events.map((e) => e.payload["action"])).toEqual([
      "core.permissions.grant",
      "core.permissions.deny",
      "core.permissions.remove",
    ]);
    for (const e of events) {
      expect(e.payload["role_id"]).toBe(9);
    }
  });
});
