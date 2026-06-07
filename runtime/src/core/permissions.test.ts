import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { RolesEngine } from "../roles/engine";
import type { FileListFn, FileReadFn } from "../migrations";
import { requirePermission, assertGrantSafe } from "./permissions";
import { CORE_PERMISSIONS, seedCorePermissions, CORE_PLUGIN_SLUG } from "./permission-seeds";

// ---------------------------------------------------------------------------
// Schema fixture: mirrors roles/migrations/{001..004}.sql so we don't depend
// on real fs in the test runner.
// ---------------------------------------------------------------------------

const MIGRATION_001 = `
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
`;

const MIGRATION_002 = `
CREATE TABLE plugin_settings (
  slug       TEXT PRIMARY KEY,
  disabled   INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE TABLE admin_audit_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            INTEGER NOT NULL,
  actor_user_id TEXT    NOT NULL,
  actor_role    TEXT    NOT NULL,
  action        TEXT    NOT NULL,
  target_type   TEXT,
  target_id     TEXT,
  payload_json  TEXT    NOT NULL
);
CREATE TABLE cascade_rules (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source_plugin TEXT NOT NULL,
  event_topic   TEXT NOT NULL,
  target_plugin TEXT NOT NULL,
  target_action TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
`;

const MIGRATION_003 = "SELECT 1;"; // no-op stub — fixture already uses post-rename name

const MIGRATION_004 = `
CREATE TABLE permission_audit (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ts             INTEGER NOT NULL,
  actor_user_id  TEXT    NOT NULL,
  target_role_id INTEGER,
  permission     TEXT    NOT NULL,
  action         TEXT    NOT NULL CHECK (action IN ('grant', 'deny', 'remove')),
  reason         TEXT
);
CREATE INDEX idx_permission_audit_ts ON permission_audit(ts DESC);
CREATE INDEX idx_permission_audit_role ON permission_audit(target_role_id);
`;

function mockFs(): { listFiles: FileListFn; readFile: FileReadFn } {
  return {
    listFiles: () => [
      "001_create_tables.sql",
      "002_admin_tables.sql",
      "003_rename_admin_audit_log.sql",
      "004_permission_audit.sql",
    ],
    readFile: (path: string) => {
      if (path.endsWith("004_permission_audit.sql")) return MIGRATION_004;
      if (path.endsWith("003_rename_admin_audit_log.sql")) return MIGRATION_003;
      if (path.endsWith("002_admin_tables.sql")) return MIGRATION_002;
      return MIGRATION_001;
    },
  };
}

function makeEngine(): { db: Database; engine: RolesEngine } {
  const db = new Database(":memory:");
  const fs = mockFs();
  const result = RolesEngine.initialize(db, "/migrations", fs.listFiles, fs.readFile);
  if (!result.ok) throw new Error(`Init failed: ${result.error.message}`);
  const engine = new RolesEngine(db);
  seedCorePermissions(db);
  return { db, engine };
}

function assignRole(engine: RolesEngine, userId: string, roleName: string): void {
  const role = engine.getRoleByName(roleName);
  if (!role) throw new Error(`Role ${roleName} missing`);
  engine.assignRole(userId, role.id, { userId: "owner-1", isOwner: true });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("seedCorePermissions", () => {
  test("seeds core.categories.manage at default_level 80", () => {
    const { engine } = makeEngine();
    const perms = engine.getPermissionsByPlugin(CORE_PLUGIN_SLUG);
    const mgr = perms.find((p) => p.key === "core.categories.manage");
    expect(mgr).toBeDefined();
    expect(mgr!.defaultLevel).toBe(CORE_PERMISSIONS["core.categories.manage"]!.default_level);
  });

  test("re-seed does not overwrite an admin override", () => {
    const { db, engine } = makeEngine();
    // Simulate an admin lowering the default after the fact.
    db.run(
      "UPDATE permissions SET default_level = ? WHERE key = ?",
      [50, "core.categories.manage"],
    );
    seedCorePermissions(db);
    const perm = engine.getPermissionsByPlugin(CORE_PLUGIN_SLUG)
      .find((p) => p.key === "core.categories.manage");
    expect(perm!.defaultLevel).toBe(50);
  });
});

describe("requirePermission", () => {
  test("owner bypass — returns true even without engine", () => {
    let errCalled = false;
    const ok = requirePermission(
      "core.categories.manage",
      "u1",
      true,
      undefined,
      () => { errCalled = true; },
    );
    expect(ok).toBe(true);
    expect(errCalled).toBe(false);
  });

  test("no engine + non-owner → FORBIDDEN", () => {
    let code = "";
    const ok = requirePermission(
      "core.categories.manage",
      "u1",
      false,
      undefined,
      (c) => { code = c; },
    );
    expect(ok).toBe(false);
    expect(code).toBe("FORBIDDEN");
  });

  test("level 50 user with explicit grant succeeds", () => {
    const { engine } = makeEngine();
    assignRole(engine, "u1", "moderator");
    const modRole = engine.getRoleByName("moderator")!;
    expect(modRole.level).toBe(60);

    // Grant the 80-level permission to the 60-level moderator role.
    const grant = engine.grantPermission(
      modRole.id,
      "core.categories.manage",
      { userId: "owner-1", isOwner: true },
    );
    expect(grant.ok).toBe(true);

    let errCalled = false;
    const ok = requirePermission(
      "core.categories.manage",
      "u1",
      false,
      engine,
      () => { errCalled = true; },
    );
    expect(ok).toBe(true);
    expect(errCalled).toBe(false);
  });

  test("level 90 user without grant fails (default_level 80, but explicit deny wins)", () => {
    const { engine } = makeEngine();
    // Create a custom level-90 role under the owner.
    const high = engine.createRole({ name: "high-mod", level: 90 }, { userId: "owner-1", isOwner: true });
    expect(high.ok).toBe(true);
    assignRole(engine, "u2", "high-mod");

    // Deny the permission for that role explicitly.
    const deny = engine.denyPermission(
      (high as { ok: true; value: { id: number } }).value.id,
      "core.categories.manage",
      { userId: "owner-1", isOwner: true },
    );
    expect(deny.ok).toBe(true);

    let code = "";
    const ok = requirePermission(
      "core.categories.manage",
      "u2",
      false,
      engine,
      (c) => { code = c; },
    );
    expect(ok).toBe(false);
    expect(code).toBe("FORBIDDEN");
  });

  test("level above default_level passes via fall-through (no override)", () => {
    const { engine } = makeEngine();
    const high = engine.createRole({ name: "high-mod", level: 90 }, { userId: "owner-1", isOwner: true });
    expect(high.ok).toBe(true);
    assignRole(engine, "u3", "high-mod");

    const ok = requirePermission(
      "core.categories.manage",
      "u3",
      false,
      engine,
      () => {},
    );
    expect(ok).toBe(true);
  });

  test("unknown permission key always denies non-owners", () => {
    const { engine } = makeEngine();
    let code = "";
    const ok = requirePermission(
      "core.does.not.exist",
      "u4",
      false,
      engine,
      (c) => { code = c; },
    );
    expect(ok).toBe(false);
    expect(code).toBe("FORBIDDEN");
  });
});

describe("assertGrantSafe", () => {
  test("owner always allowed", () => {
    const { engine } = makeEngine();
    const result = assertGrantSafe("core.categories.manage", "owner-1", true, engine);
    expect(result.ok).toBe(true);
  });

  test("non-owner without the permission cannot grant it", () => {
    const { engine } = makeEngine();
    assignRole(engine, "u1", "member");
    const result = assertGrantSafe("core.categories.manage", "u1", false, engine);
    expect(result.ok).toBe(false);
  });

  test("non-owner who holds the permission may grant it", () => {
    const { engine } = makeEngine();
    const high = engine.createRole({ name: "high-mod", level: 90 }, { userId: "owner-1", isOwner: true });
    expect(high.ok).toBe(true);
    assignRole(engine, "u1", "high-mod");
    const result = assertGrantSafe("core.categories.manage", "u1", false, engine);
    expect(result.ok).toBe(true);
  });
});

describe("RolesEngine.recordPermissionAudit + listPermissionAudit", () => {
  test("records grant and lists in DESC ts order", () => {
    const { engine } = makeEngine();
    engine.recordPermissionAudit("owner-1", 5, "core.categories.manage", "grant", "first");
    engine.recordPermissionAudit("owner-1", 5, "core.categories.manage", "deny", "second");
    const list = engine.listPermissionAudit(10, 0);
    expect(list).toHaveLength(2);
    expect(list[0]!.action).toBe("deny");
    expect(list[1]!.action).toBe("grant");
    expect(list[0]!.reason).toBe("second");
    expect(list[1]!.reason).toBe("first");
    expect(list[0]!.target_role_id).toBe(5);
  });

  test("rejects invalid action via CHECK constraint", () => {
    const { engine } = makeEngine();
    expect(() =>
      // @ts-expect-error — deliberately passing a bad action
      engine.recordPermissionAudit("owner-1", 1, "core.x", "noop", undefined),
    ).toThrow();
  });
});
