// End-to-end integration test for the permissions surface (spec-22
// Amendment B PR 5.2). Drives the IPC boundary against a REAL `RolesEngine`
// — no fakes — so the owner-bootstrap flow, the cascade emitter, and the
// FORBIDDEN gate behave as one system.
//
// Two scenarios:
//
//   1. Owner bootstrap. Owner grants `core.permissions.manage` to admin
//      role. A non-owner admin then performs grants successfully. Owner
//      revokes the override. The admin's next grant attempt errors
//      FORBIDDEN at the gate (not at the engine).
//
//   2. Cascade emitter. RolesEngine.onPermissionChanged fires with the
//      right discriminated payload for every mutation type
//      (grant/deny/remove/role.assign/role.remove). Subscribers (notably
//      the terminals subsystem) receive structured events synchronously.
//
// The fail-fast migration assertion is covered separately in
// `runtime/src/db/assert-tables.test.ts`; not duplicated here.

import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { CoreModule } from "./module";
import { handleCoreClientAction } from "./ipc";
import { seedCorePermissions, CORE_PERMISSIONS } from "./permission-seeds";
import { RolesEngine } from "../roles/engine";
import { createLogger } from "@uncorded/shared";
import type { EventBus } from "../events/bus";
import type { FileListFn, FileReadFn } from "../migrations";
import type { PermissionChangedEvent } from "../roles/engine";

const MIGRATION_SQL = `
CREATE TABLE roles (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL UNIQUE,
  level       INTEGER NOT NULL CHECK (level >= 1 AND level <= 100),
  is_default  INTEGER NOT NULL DEFAULT 0,
  parent_role INTEGER REFERENCES roles(id) ON DELETE SET NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE user_roles (
  user_id TEXT    NOT NULL,
  role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_id)
);

CREATE INDEX idx_user_roles_user ON user_roles(user_id);

CREATE TABLE permissions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  key           TEXT    NOT NULL UNIQUE,
  description   TEXT    NOT NULL DEFAULT '',
  default_level INTEGER NOT NULL CHECK (default_level >= 0 AND default_level <= 100),
  plugin_slug   TEXT    NOT NULL,
  registered_at INTEGER NOT NULL
);

CREATE TABLE role_permissions (
  role_id       INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id INTEGER NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  granted       INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE permission_audit (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        INTEGER NOT NULL,
  actor_user_id   TEXT    NOT NULL,
  target_role_id  INTEGER,
  permission      TEXT    NOT NULL,
  action          TEXT    NOT NULL,
  reason          TEXT
);
`;

function mockFs(): { listFiles: FileListFn; readFile: FileReadFn } {
  return {
    listFiles: () => ["001_create_tables.sql"],
    readFile: () => MIGRATION_SQL,
  };
}

function bootstrap(): {
  db: Database;
  engine: RolesEngine;
  module: CoreModule;
} {
  const db = new Database(":memory:");
  const fs = mockFs();
  const init = RolesEngine.initialize(db, "/migrations", fs.listFiles, fs.readFile);
  if (!init.ok) throw new Error(`init failed: ${init.error.message}`);
  const engine = new RolesEngine(db);
  // Seed core permissions so `core.permissions.manage` is registered with
  // its production default_level (100). The bootstrap test depends on the
  // owner-only default holding before the override is applied.
  seedCorePermissions(db);

  const bus: EventBus = {
    publishRuntime() { return { ok: true as const, eventId: "mock" }; },
    publish() { return { ok: true as const, eventId: "mock" }; },
    subscribe() { return { ok: true as const }; },
    unsubscribe() { return { ok: true as const }; },
    getStats() { return {} as never; },
    getDeadLetters() { return []; },
  } as unknown as EventBus;

  // CoreModule wants its own DB; for this test only the IPC handler shape
  // matters — the module's internal DAOs aren't exercised.
  const moduleDb = new Database(":memory:");
  const module = new CoreModule(moduleDb, bus, createLogger({ test: true }));
  module.initialize();
  return { db, engine, module };
}

interface CallResult {
  ok?: unknown;
  error?: { code: string; message: string };
}

function call(
  action: string,
  params: Record<string, unknown>,
  userId: string,
  isOwner: boolean,
  module: CoreModule,
  engine: RolesEngine,
): CallResult {
  const out: CallResult = {};
  handleCoreClientAction(
    action,
    params,
    userId,
    isOwner,
    module,
    engine,
    (r) => { out.ok = r; },
    (code, message) => { out.error = { code, message }; },
  );
  return out;
}

describe("permissions integration — owner bootstrap → admin delegation → revoke", () => {
  it("admin without override is FORBIDDEN; with override succeeds; after revoke FORBIDDEN again", () => {
    const { engine, module } = bootstrap();
    const owner = "owner-1";
    const admin = "admin-1";

    // Assign admin-1 to the seeded `admin` role (level 80). admin level
    // < default_level(100) for core.permissions.manage, so no UI bypass.
    const adminRole = engine.getRoleByName("admin")!;
    engine.assignRole(admin, adminRole.id, { userId: owner, isOwner: true });

    // Step 1 — admin attempts a grant before the override exists. The
    // `requirePermission(core.permissions.manage)` gate must FORBID.
    engine.registerPermission({
      key: "plugin.gallery.upload",
      description: "Upload to gallery",
      defaultLevel: 60,
      pluginSlug: "gallery",
    });
    const memberRole = engine.getRoleByName("member")!;
    const before = call(
      "core.permissions.grant",
      { role_id: memberRole.id, permission: "plugin.gallery.upload" },
      admin, false, module, engine,
    );
    expect(before.error?.code).toBe("FORBIDDEN");

    // Step 2 — owner grants `core.permissions.manage` to the admin role.
    // Note we use the IPC path (not engine direct) to confirm the gate
    // handler also performs the audit + cascade.
    const grant = call(
      "core.permissions.grant",
      { role_id: adminRole.id, permission: "core.permissions.manage" },
      owner, true, module, engine,
    );
    expect(grant.error).toBeUndefined();

    // Step 3 — admin retries the grant. Now their effective check passes
    // (override grants core.permissions.manage), and assertGrantSafe is
    // satisfied (admin level > member level + admin holds the granted
    // permission via override which is plugin.gallery.upload's required
    // level — admin level 80 > default 60).
    const after = call(
      "core.permissions.grant",
      { role_id: memberRole.id, permission: "plugin.gallery.upload" },
      admin, false, module, engine,
    );
    expect(after.error).toBeUndefined();

    // Step 4 — owner revokes the override.
    const revoke = call(
      "core.permissions.remove",
      { role_id: adminRole.id, permission: "core.permissions.manage" },
      owner, true, module, engine,
    );
    expect(revoke.error).toBeUndefined();

    // Step 5 — admin's next attempt is FORBIDDEN again.
    const afterRevoke = call(
      "core.permissions.grant",
      { role_id: memberRole.id, permission: "plugin.gallery.upload" },
      admin, false, module, engine,
    );
    expect(afterRevoke.error?.code).toBe("FORBIDDEN");
  });

  it("owner can grant the manage permission to a non-default custom role", () => {
    // Confirms there's no implicit "default-roles only" gating on the
    // manage permission grant — custom roles can be delegated too.
    const { engine, module } = bootstrap();
    const owner = "owner-1";

    const created = engine.createRole(
      { name: "ops", level: 90 },
      { userId: owner, isOwner: true },
    );
    if (!created.ok) throw new Error(`createRole failed: ${created.error.message}`);
    const ops = created.value;

    const grant = call(
      "core.permissions.grant",
      { role_id: ops.id, permission: "core.permissions.manage" },
      owner, true, module, engine,
    );
    expect(grant.error).toBeUndefined();

    // Confirm the override row exists and is granted=true.
    const roles = engine.getRoles();
    const opsRow = roles.find((r) => r.id === ops.id)!;
    const overrides = engine.getRoleOverrides(opsRow.id);
    expect(overrides).toEqual([{ permission: "core.permissions.manage", granted: true }]);
  });

  it("the seeded core.permissions.manage default_level is 100 (owner-only by default)", () => {
    // Pin: any change to the default level must be a deliberate spec
    // amendment, not an accidental drift.
    expect(CORE_PERMISSIONS["core.permissions.manage"]?.default_level).toBe(100);
  });
});

describe("permissions integration — cascade emitter (RolesEngine.onPermissionChanged)", () => {
  it("emits {roleId, permissionKey} for grant / deny / remove", () => {
    const { engine } = bootstrap();
    const owner = { userId: "owner-1", isOwner: true };
    engine.registerPermission({
      key: "plugin.x", description: "x", defaultLevel: 60, pluginSlug: "p",
    });
    const member = engine.getRoleByName("member")!;

    const events: PermissionChangedEvent[] = [];
    const unsub = engine.onPermissionChanged((e) => { events.push(e); });

    engine.grantPermission(member.id, "plugin.x", owner);
    engine.denyPermission(member.id, "plugin.x", owner);
    engine.removePermissionOverride(member.id, "plugin.x", owner);

    unsub();
    expect(events.length).toBe(3);
    for (const e of events) {
      // Tagged by mutation type — these three have roleId+permissionKey.
      expect("roleId" in e && "permissionKey" in e).toBe(true);
      const r = e as { roleId: number; permissionKey: string };
      expect(r.roleId).toBe(member.id);
      expect(r.permissionKey).toBe("plugin.x");
    }
  });

  it("emits {userId} for role.assign / role.remove", () => {
    const { engine } = bootstrap();
    const owner = { userId: "owner-1", isOwner: true };
    const adminRole = engine.getRoleByName("admin")!;

    const events: PermissionChangedEvent[] = [];
    const unsub = engine.onPermissionChanged((e) => { events.push(e); });

    engine.assignRole("u1", adminRole.id, owner);
    engine.removeRole("u1", owner);

    unsub();
    expect(events.length).toBe(2);
    for (const e of events) {
      expect("userId" in e).toBe(true);
      const r = e as { userId: string };
      expect(r.userId).toBe("u1");
    }
  });

  it("does NOT emit when a mutation fails (e.g. HIERARCHY_VIOLATION)", () => {
    const { engine } = bootstrap();
    const owner = { userId: "owner-1", isOwner: true };
    const adminRole = engine.getRoleByName("admin")!;

    // Set up a non-owner caller at level 60 (mod). Attempts to grant on
    // admin role must fail hierarchy — and emit nothing.
    const modActor = { userId: "mod-1", isOwner: false };
    const modRole = engine.getRoleByName("moderator")!;
    engine.assignRole("mod-1", modRole.id, owner);

    engine.registerPermission({
      key: "plugin.x", description: "x", defaultLevel: 60, pluginSlug: "p",
    });

    const events: PermissionChangedEvent[] = [];
    const unsub = engine.onPermissionChanged((e) => { events.push(e); });

    const res = engine.grantPermission(adminRole.id, "plugin.x", modActor);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("HIERARCHY_VIOLATION");
    }

    unsub();
    expect(events.length).toBe(0);
  });

  it("a throwing subscriber does not block sibling subscribers or corrupt engine state", () => {
    const { engine } = bootstrap();
    const owner = { userId: "owner-1", isOwner: true };
    engine.registerPermission({
      key: "plugin.x", description: "x", defaultLevel: 60, pluginSlug: "p",
    });
    const member = engine.getRoleByName("member")!;

    const goodEvents: PermissionChangedEvent[] = [];
    const unsub1 = engine.onPermissionChanged(() => {
      throw new Error("first listener intentionally throws");
    });
    const unsub2 = engine.onPermissionChanged((e) => { goodEvents.push(e); });

    // Suppress the noisy console.error from the throwing listener.
    const origErr = console.error;
    console.error = () => {};
    try {
      const res = engine.grantPermission(member.id, "plugin.x", owner);
      expect(res.ok).toBe(true);
    } finally {
      console.error = origErr;
    }

    unsub1();
    unsub2();
    expect(goodEvents.length).toBe(1);
  });
});
