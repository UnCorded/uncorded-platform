import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { RolesEngine } from "./engine";
import { DEFAULT_ROLES } from "./types";
import type {
  CallerContext,
  Role,
  RolesResult,
  VoidResult,
} from "./types";
import type { FileListFn, FileReadFn } from "../migrations";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
`;

function mockFs(): { listFiles: FileListFn; readFile: FileReadFn } {
  return {
    listFiles: () => ["001_create_tables.sql"],
    readFile: () => MIGRATION_SQL,
  };
}

function makeEngine(): { db: Database; engine: RolesEngine } {
  const db = new Database(":memory:");
  const fs = mockFs();
  const result = RolesEngine.initialize(db, "/migrations", fs.listFiles, fs.readFile);
  if (!result.ok) throw new Error(`Init failed: ${result.error.message}`);
  return { db, engine: new RolesEngine(db) };
}

function owner(userId = "owner-1"): CallerContext {
  return { userId, isOwner: true };
}

function callerAt(engine: RolesEngine, userId: string, roleName: string): CallerContext {
  const role = engine.getRoleByName(roleName);
  if (!role) throw new Error(`Role ${roleName} not found`);
  engine.assignRole(userId, role.id, owner());
  return { userId, isOwner: false };
}

function expectOk<T>(result: RolesResult<T>): T {
  expect(result.ok).toBe(true);
  return (result as { ok: true; value: T }).value;
}

function expectVoidOk(result: VoidResult): void {
  expect(result.ok).toBe(true);
}

function expectError(result: RolesResult<unknown> | VoidResult, code: string): void {
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error.code).toBe(code);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RolesEngine", () => {
  let db: Database;
  let engine: RolesEngine;

  beforeEach(() => {
    const setup = makeEngine();
    db = setup.db;
    engine = setup.engine;
  });

  // -----------------------------------------------------------------------
  // Initialization
  // -----------------------------------------------------------------------

  describe("initialization", () => {
    test("creates four default roles with correct levels", () => {
      const roles = engine.getRoles();
      expect(roles.length).toBe(4);

      const byName = new Map(roles.map((r) => [r.name, r]));
      expect(byName.get("owner")!.level).toBe(100);
      expect(byName.get("admin")!.level).toBe(80);
      expect(byName.get("moderator")!.level).toBe(60);
      expect(byName.get("member")!.level).toBe(10);
    });

    test("default roles have isDefault = true", () => {
      for (const role of engine.getRoles()) {
        expect(role.isDefault).toBe(true);
      }
    });

    test("re-running initialize is idempotent", () => {
      const fs = mockFs();
      const result = RolesEngine.initialize(db, "/migrations", fs.listFiles, fs.readFile);
      expect(result.ok).toBe(true);
      expect(engine.getRoles().length).toBe(4);
    });

    test("roles are ordered by level descending", () => {
      const roles = engine.getRoles();
      for (let i = 1; i < roles.length; i++) {
        expect(roles[i - 1]!.level).toBeGreaterThanOrEqual(roles[i]!.level);
      }
    });
  });

  // -----------------------------------------------------------------------
  // Role reads
  // -----------------------------------------------------------------------

  describe("getRoleById / getRoleByName", () => {
    test("getRoleById returns null for nonexistent ID", () => {
      expect(engine.getRoleById(9999)).toBeNull();
    });

    test("getRoleByName returns null for nonexistent name", () => {
      expect(engine.getRoleByName("nonexistent")).toBeNull();
    });

    test("getRoleByName is case-sensitive", () => {
      expect(engine.getRoleByName("Owner")).toBeNull();
      expect(engine.getRoleByName("owner")).not.toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // createRole
  // -----------------------------------------------------------------------

  describe("createRole", () => {
    test("owner can create a custom role with level 1-99", () => {
      const role = expectOk(engine.createRole({ name: "vip", level: 50 }, owner()));
      expect(role.name).toBe("vip");
      expect(role.level).toBe(50);
      expect(role.isDefault).toBe(false);
    });

    test("admin can create role with level < 80", () => {
      const admin = callerAt(engine, "admin-1", "admin");
      const role = expectOk(engine.createRole({ name: "helper", level: 30 }, admin));
      expect(role.level).toBe(30);
    });

    test("returns HIERARCHY_VIOLATION when level >= caller level", () => {
      const admin = callerAt(engine, "admin-1", "admin");
      expectError(engine.createRole({ name: "super", level: 80 }, admin), "HIERARCHY_VIOLATION");
      expectError(engine.createRole({ name: "super", level: 90 }, admin), "HIERARCHY_VIOLATION");
    });

    test("returns INVALID_LEVEL for level 0", () => {
      expectError(engine.createRole({ name: "zero", level: 0 }, owner()), "INVALID_LEVEL");
    });

    test("returns INVALID_LEVEL for level 100", () => {
      expectError(engine.createRole({ name: "hundred", level: 100 }, owner()), "INVALID_LEVEL");
    });

    test("returns INVALID_LEVEL for negative level", () => {
      expectError(engine.createRole({ name: "neg", level: -5 }, owner()), "INVALID_LEVEL");
    });

    test("returns INVALID_LEVEL for non-integer level", () => {
      expectError(engine.createRole({ name: "frac", level: 50.5 }, owner()), "INVALID_LEVEL");
    });

    test("returns ROLE_NAME_TAKEN for duplicate name", () => {
      expectOk(engine.createRole({ name: "vip", level: 50 }, owner()));
      expectError(engine.createRole({ name: "vip", level: 40 }, owner()), "ROLE_NAME_TAKEN");
    });

    test("created role appears in getRoles()", () => {
      expectOk(engine.createRole({ name: "vip", level: 50 }, owner()));
      const names = engine.getRoles().map((r) => r.name);
      expect(names).toContain("vip");
    });
  });

  // -----------------------------------------------------------------------
  // updateRole
  // -----------------------------------------------------------------------

  describe("updateRole", () => {
    test("owner can rename a custom role", () => {
      const role = expectOk(engine.createRole({ name: "vip", level: 50 }, owner()));
      const updated = expectOk(engine.updateRole(role.id, { name: "elite" }, owner()));
      expect(updated.name).toBe("elite");
    });

    test("owner can change a custom role level", () => {
      const role = expectOk(engine.createRole({ name: "vip", level: 50 }, owner()));
      const updated = expectOk(engine.updateRole(role.id, { level: 70 }, owner()));
      expect(updated.level).toBe(70);
    });

    test("returns ROLE_NOT_FOUND for nonexistent ID", () => {
      expectError(engine.updateRole(9999, { name: "x" }, owner()), "ROLE_NOT_FOUND");
    });

    test("returns DEFAULT_ROLE_PROTECTED when renaming a default role", () => {
      const member = engine.getRoleByName("member")!;
      expectError(engine.updateRole(member.id, { name: "peasant" }, owner()), "DEFAULT_ROLE_PROTECTED");
    });

    test("returns DEFAULT_ROLE_PROTECTED when changing default role level", () => {
      const admin = engine.getRoleByName("admin")!;
      expectError(engine.updateRole(admin.id, { level: 70 }, owner()), "DEFAULT_ROLE_PROTECTED");
    });

    test("returns HIERARCHY_VIOLATION when target role level >= caller level", () => {
      const admin = callerAt(engine, "admin-1", "admin");
      const ownerRole = engine.getRoleByName("owner")!;
      expectError(engine.updateRole(ownerRole.id, { name: "x" }, admin), "HIERARCHY_VIOLATION");
    });

    test("returns HIERARCHY_VIOLATION when new level >= caller level", () => {
      const admin = callerAt(engine, "admin-1", "admin");
      const role = expectOk(engine.createRole({ name: "vip", level: 50 }, owner()));
      expectError(engine.updateRole(role.id, { level: 80 }, admin), "HIERARCHY_VIOLATION");
    });

    test("returns ROLE_NAME_TAKEN for duplicate name", () => {
      expectOk(engine.createRole({ name: "vip", level: 50 }, owner()));
      const role2 = expectOk(engine.createRole({ name: "elite", level: 40 }, owner()));
      expectError(engine.updateRole(role2.id, { name: "vip" }, owner()), "ROLE_NAME_TAKEN");
    });
  });

  // -----------------------------------------------------------------------
  // deleteRole
  // -----------------------------------------------------------------------

  describe("deleteRole", () => {
    test("owner can delete a custom role", () => {
      const role = expectOk(engine.createRole({ name: "vip", level: 50 }, owner()));
      expectVoidOk(engine.deleteRole(role.id, owner()));
      expect(engine.getRoleById(role.id)).toBeNull();
    });

    test("users on deleted role are reassigned to member", () => {
      const role = expectOk(engine.createRole({ name: "vip", level: 50 }, owner()));
      expectVoidOk(engine.assignRole("user-1", role.id, owner()));
      expect(engine.getRole("user-1").name).toBe("vip");

      expectVoidOk(engine.deleteRole(role.id, owner()));
      expect(engine.getRole("user-1").name).toBe("member");
    });

    test("returns DEFAULT_ROLE_PROTECTED for default roles", () => {
      for (const name of Object.keys(DEFAULT_ROLES)) {
        const role = engine.getRoleByName(name)!;
        expectError(engine.deleteRole(role.id, owner()), "DEFAULT_ROLE_PROTECTED");
      }
    });

    test("returns ROLE_NOT_FOUND for nonexistent ID", () => {
      expectError(engine.deleteRole(9999, owner()), "ROLE_NOT_FOUND");
    });

    test("returns HIERARCHY_VIOLATION when role level >= caller level", () => {
      const mod = callerAt(engine, "mod-1", "moderator");
      const role = expectOk(engine.createRole({ name: "senior", level: 70 }, owner()));
      expectError(engine.deleteRole(role.id, mod), "HIERARCHY_VIOLATION");
    });
  });

  // -----------------------------------------------------------------------
  // User-role assignment
  // -----------------------------------------------------------------------

  describe("assignRole", () => {
    test("owner can assign any non-owner role", () => {
      const admin = engine.getRoleByName("admin")!;
      expectVoidOk(engine.assignRole("user-1", admin.id, owner()));
      expect(engine.getRole("user-1").name).toBe("admin");
    });

    test("admin can assign roles with level < 80", () => {
      const adminCaller = callerAt(engine, "admin-1", "admin");
      const mod = engine.getRoleByName("moderator")!;
      expectVoidOk(engine.assignRole("user-1", mod.id, adminCaller));
      expect(engine.getRole("user-1").name).toBe("moderator");
    });

    test("returns HIERARCHY_VIOLATION when assigning role at or above caller level", () => {
      const adminCaller = callerAt(engine, "admin-1", "admin");
      const adminRole = engine.getRoleByName("admin")!;
      expectError(engine.assignRole("user-1", adminRole.id, adminCaller), "HIERARCHY_VIOLATION");
    });

    test("returns HIERARCHY_VIOLATION when target user current role >= caller level", () => {
      // Make user-1 an admin
      const adminRole = engine.getRoleByName("admin")!;
      expectVoidOk(engine.assignRole("user-1", adminRole.id, owner()));

      // Another admin tries to demote user-1
      const adminCaller = callerAt(engine, "admin-2", "admin");
      const member = engine.getRoleByName("member")!;
      expectError(engine.assignRole("user-1", member.id, adminCaller), "HIERARCHY_VIOLATION");
    });

    test("replaces existing role (single-role model)", () => {
      const admin = engine.getRoleByName("admin")!;
      const mod = engine.getRoleByName("moderator")!;

      expectVoidOk(engine.assignRole("user-1", admin.id, owner()));
      expect(engine.getRole("user-1").name).toBe("admin");

      expectVoidOk(engine.assignRole("user-1", mod.id, owner()));
      expect(engine.getRole("user-1").name).toBe("moderator");
    });

    test("returns ROLE_NOT_FOUND for nonexistent role ID", () => {
      expectError(engine.assignRole("user-1", 9999, owner()), "ROLE_NOT_FOUND");
    });
  });

  // -----------------------------------------------------------------------
  // removeRole
  // -----------------------------------------------------------------------

  describe("removeRole", () => {
    test("resets user to member", () => {
      const admin = engine.getRoleByName("admin")!;
      expectVoidOk(engine.assignRole("user-1", admin.id, owner()));
      expectVoidOk(engine.removeRole("user-1", owner()));
      expect(engine.getRole("user-1").name).toBe("member");
    });

    test("returns HIERARCHY_VIOLATION when user current role >= caller level", () => {
      const admin = engine.getRoleByName("admin")!;
      expectVoidOk(engine.assignRole("user-1", admin.id, owner()));

      const modCaller = callerAt(engine, "mod-1", "moderator");
      expectError(engine.removeRole("user-1", modCaller), "HIERARCHY_VIOLATION");
    });
  });

  // -----------------------------------------------------------------------
  // getRole
  // -----------------------------------------------------------------------

  describe("getRole", () => {
    test("returns member for unknown/new users", () => {
      expect(engine.getRole("unknown-user").name).toBe("member");
    });

    test("returns assigned role for known users", () => {
      const admin = engine.getRoleByName("admin")!;
      expectVoidOk(engine.assignRole("user-1", admin.id, owner()));
      expect(engine.getRole("user-1").name).toBe("admin");
    });

    test("assign role to never-seen user (no existing user_roles row)", () => {
      const mod = engine.getRoleByName("moderator")!;
      // user-new has never been seen — no row in user_roles
      expectVoidOk(engine.assignRole("user-new", mod.id, owner()));
      expect(engine.getRole("user-new").name).toBe("moderator");
    });
  });

  // -----------------------------------------------------------------------
  // Permission registration
  // -----------------------------------------------------------------------

  describe("registerPermission", () => {
    test("registers a new permission", () => {
      expectVoidOk(engine.registerPermission({
        key: "gallery.upload",
        description: "Upload photos",
        defaultLevel: 10,
        pluginSlug: "photo-gallery",
      }));
      const perms = engine.getPermissions();
      expect(perms.length).toBe(1);
      expect(perms[0]!.key).toBe("gallery.upload");
    });

    test("idempotent for same plugin and same key", () => {
      const input = {
        key: "gallery.upload",
        description: "Upload photos",
        defaultLevel: 10,
        pluginSlug: "photo-gallery",
      };
      expectVoidOk(engine.registerPermission(input));
      expectVoidOk(engine.registerPermission({ ...input, description: "Updated desc", defaultLevel: 20 }));

      const perms = engine.getPermissions();
      expect(perms.length).toBe(1);
      expect(perms[0]!.description).toBe("Updated desc");
      expect(perms[0]!.defaultLevel).toBe(20);
    });

    test("returns PERMISSION_ALREADY_REGISTERED if different plugin owns the key", () => {
      expectVoidOk(engine.registerPermission({
        key: "gallery.upload",
        description: "Upload photos",
        defaultLevel: 10,
        pluginSlug: "photo-gallery",
      }));
      expectError(engine.registerPermission({
        key: "gallery.upload",
        description: "Also upload",
        defaultLevel: 10,
        pluginSlug: "other-plugin",
      }), "PERMISSION_ALREADY_REGISTERED");
    });
  });

  // -----------------------------------------------------------------------
  // unregisterPluginPermissions
  // -----------------------------------------------------------------------

  describe("unregisterPluginPermissions", () => {
    test("removes all permissions for a plugin slug", () => {
      expectVoidOk(engine.registerPermission({
        key: "gallery.upload",
        description: "Upload",
        defaultLevel: 10,
        pluginSlug: "photo-gallery",
      }));
      expectVoidOk(engine.registerPermission({
        key: "gallery.delete",
        description: "Delete",
        defaultLevel: 60,
        pluginSlug: "photo-gallery",
      }));
      expectVoidOk(engine.registerPermission({
        key: "chat.post",
        description: "Post",
        defaultLevel: 10,
        pluginSlug: "text-channels",
      }));

      const count = engine.unregisterPluginPermissions("photo-gallery");
      expect(count).toBe(2);
      expect(engine.getPermissions().length).toBe(1);
      expect(engine.getPermissions()[0]!.key).toBe("chat.post");
    });

    test("returns 0 when plugin has no permissions", () => {
      expect(engine.unregisterPluginPermissions("nonexistent")).toBe(0);
    });

    test("cascade-deletes role_permissions when permissions are removed", () => {
      expectVoidOk(engine.registerPermission({
        key: "gallery.upload",
        description: "Upload",
        defaultLevel: 60,
        pluginSlug: "photo-gallery",
      }));
      const memberRole = engine.getRoleByName("member")!;
      expectVoidOk(engine.grantPermission(memberRole.id, "gallery.upload", owner()));

      // Verify override exists
      const before = db
        .query<{ cnt: number }, []>("SELECT COUNT(*) as cnt FROM role_permissions")
        .get()!.cnt;
      expect(before).toBe(1);

      engine.unregisterPluginPermissions("photo-gallery");

      // role_permissions row should be cascade-deleted
      const after = db
        .query<{ cnt: number }, []>("SELECT COUNT(*) as cnt FROM role_permissions")
        .get()!.cnt;
      expect(after).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // grantPermission / denyPermission / removePermissionOverride
  // -----------------------------------------------------------------------

  describe("role-permission mapping", () => {
    let memberRole: Role;
    const permInput = {
      key: "gallery.upload",
      description: "Upload photos",
      defaultLevel: 60,
      pluginSlug: "photo-gallery",
    };

    beforeEach(() => {
      engine.registerPermission(permInput);
      memberRole = engine.getRoleByName("member")!;
    });

    test("owner can grant permission to a role", () => {
      expectVoidOk(engine.grantPermission(memberRole.id, "gallery.upload", owner()));
    });

    test("owner can deny permission on a role", () => {
      expectVoidOk(engine.denyPermission(memberRole.id, "gallery.upload", owner()));
    });

    test("removePermissionOverride removes the row", () => {
      expectVoidOk(engine.grantPermission(memberRole.id, "gallery.upload", owner()));
      expectVoidOk(engine.removePermissionOverride(memberRole.id, "gallery.upload", owner()));
    });

    test("returns PERMISSION_NOT_FOUND for unknown key", () => {
      expectError(engine.grantPermission(memberRole.id, "nonexistent", owner()), "PERMISSION_NOT_FOUND");
    });

    test("returns ROLE_NOT_FOUND for nonexistent role", () => {
      expectError(engine.grantPermission(9999, "gallery.upload", owner()), "ROLE_NOT_FOUND");
    });

    test("hierarchy enforcement on target role", () => {
      const modCaller = callerAt(engine, "mod-1", "moderator");
      const adminRole = engine.getRoleByName("admin")!;
      expectError(engine.grantPermission(adminRole.id, "gallery.upload", modCaller), "HIERARCHY_VIOLATION");
    });
  });

  // -----------------------------------------------------------------------
  // check
  // -----------------------------------------------------------------------

  describe("check", () => {
    const permInput = {
      key: "gallery.upload",
      description: "Upload photos",
      defaultLevel: 60,
      pluginSlug: "photo-gallery",
    };

    beforeEach(() => {
      engine.registerPermission(permInput);
    });

    test("owner always returns true regardless of permission", () => {
      expect(engine.check("owner-1", "gallery.upload", owner())).toBe(true);
    });

    test("owner returns true even for nonexistent permission", () => {
      expect(engine.check("owner-1", "nonexistent.perm", owner())).toBe(true);
    });

    test("user with explicit grant returns true", () => {
      const memberRole = engine.getRoleByName("member")!;
      engine.grantPermission(memberRole.id, "gallery.upload", owner());

      const memberCaller: CallerContext = { userId: "user-1", isOwner: false };
      expect(engine.check("user-1", "gallery.upload", memberCaller)).toBe(true);
    });

    test("user with explicit deny returns false", () => {
      const adminRole = engine.getRoleByName("admin")!;
      engine.assignRole("user-1", adminRole.id, owner());
      engine.denyPermission(adminRole.id, "gallery.upload", owner());

      const caller: CallerContext = { userId: "user-1", isOwner: false };
      expect(engine.check("user-1", "gallery.upload", caller)).toBe(false);
    });

    test("user with no override and role.level >= default_level returns true", () => {
      const adminRole = engine.getRoleByName("admin")!;
      engine.assignRole("user-1", adminRole.id, owner());

      const caller: CallerContext = { userId: "user-1", isOwner: false };
      // admin (80) >= default_level (60) → true
      expect(engine.check("user-1", "gallery.upload", caller)).toBe(true);
    });

    test("user with no override and role.level < default_level returns false", () => {
      // member (10) < default_level (60) → false
      const memberCaller: CallerContext = { userId: "user-1", isOwner: false };
      expect(engine.check("user-1", "gallery.upload", memberCaller)).toBe(false);
    });

    test("unknown user (no assignment) uses member level", () => {
      const caller: CallerContext = { userId: "nobody", isOwner: false };
      expect(engine.check("nobody", "gallery.upload", caller)).toBe(false);
    });

    test("unknown permission key returns false for non-owner", () => {
      const caller: CallerContext = { userId: "user-1", isOwner: false };
      expect(engine.check("user-1", "nonexistent.perm", caller)).toBe(false);
    });

    test("scope parameter is accepted without error", () => {
      const caller: CallerContext = { userId: "user-1", isOwner: false };
      // Scope not evaluated in Phase 1 but must not break
      expect(engine.check("user-1", "gallery.upload", caller, "channel-123")).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // hasRole
  // -----------------------------------------------------------------------

  describe("hasRole", () => {
    test("returns true when user has the named role", () => {
      const admin = engine.getRoleByName("admin")!;
      engine.assignRole("user-1", admin.id, owner());
      expect(engine.hasRole("user-1", "admin")).toBe(true);
    });

    test("returns false when user does not have the named role", () => {
      expect(engine.hasRole("user-1", "admin")).toBe(false);
    });

    test("unassigned user hasRole('member') returns true", () => {
      expect(engine.hasRole("unknown-user", "member")).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // hasMinLevel
  // -----------------------------------------------------------------------

  describe("hasMinLevel", () => {
    test("owner (isOwner=true) always passes any level check", () => {
      expect(engine.hasMinLevel("owner-1", 100, owner())).toBe(true);
    });

    test("admin (level 80) passes level 60", () => {
      const admin = engine.getRoleByName("admin")!;
      engine.assignRole("user-1", admin.id, owner());
      const caller: CallerContext = { userId: "user-1", isOwner: false };
      expect(engine.hasMinLevel("user-1", 60, caller)).toBe(true);
    });

    test("member (level 10) fails level 60", () => {
      const caller: CallerContext = { userId: "user-1", isOwner: false };
      expect(engine.hasMinLevel("user-1", 60, caller)).toBe(false);
    });

    test("unassigned user treated as member (level 10)", () => {
      const caller: CallerContext = { userId: "nobody", isOwner: false };
      expect(engine.hasMinLevel("nobody", 10, caller)).toBe(true);
      expect(engine.hasMinLevel("nobody", 11, caller)).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Hierarchy edge cases
  // -----------------------------------------------------------------------

  describe("hierarchy edge cases", () => {
    test("admin cannot manage another admin (same level)", () => {
      const adminRole = engine.getRoleByName("admin")!;
      engine.assignRole("admin-target", adminRole.id, owner());

      const adminCaller = callerAt(engine, "admin-caller", "admin");
      const memberRole = engine.getRoleByName("member")!;
      expectError(engine.assignRole("admin-target", memberRole.id, adminCaller), "HIERARCHY_VIOLATION");
    });

    test("moderator cannot assign admin role", () => {
      const modCaller = callerAt(engine, "mod-1", "moderator");
      const adminRole = engine.getRoleByName("admin")!;
      expectError(engine.assignRole("user-1", adminRole.id, modCaller), "HIERARCHY_VIOLATION");
    });

    test("owner can manage everything", () => {
      const adminRole = engine.getRoleByName("admin")!;
      expectVoidOk(engine.assignRole("user-1", adminRole.id, owner()));
      expectVoidOk(engine.removeRole("user-1", owner()));
    });

    test("custom role at level 79 can manage roles at 78 but not 79", () => {
      expectOk(engine.createRole({ name: "senior", level: 79 }, owner()));
      expectOk(engine.createRole({ name: "junior", level: 78 }, owner()));

      const seniorRole = engine.getRoleByName("senior")!;
      const seniorCaller: CallerContext = { userId: "senior-1", isOwner: false };
      engine.assignRole("senior-1", seniorRole.id, owner());

      const juniorRole = engine.getRoleByName("junior")!;
      expectVoidOk(engine.assignRole("user-1", juniorRole.id, seniorCaller));

      // Cannot create at same level
      expectError(engine.createRole({ name: "peer", level: 79 }, seniorCaller), "HIERARCHY_VIOLATION");
    });
  });

  // -----------------------------------------------------------------------
  // getRoleMemberCounts — used by core.role.list to render
  // "Applies to N members" on the matrix header (PR 4.5).
  // -----------------------------------------------------------------------

  describe("getRoleMemberCounts", () => {
    test("returns empty map when no users have explicit roles", () => {
      const counts = engine.getRoleMemberCounts();
      expect(counts.size).toBe(0);
    });

    test("counts explicit assignments per role", () => {
      const admin = engine.getRoleByName("admin")!;
      const mod = engine.getRoleByName("moderator")!;
      engine.assignRole("a-1", admin.id, owner());
      engine.assignRole("a-2", admin.id, owner());
      engine.assignRole("m-1", mod.id, owner());

      const counts = engine.getRoleMemberCounts();
      expect(counts.get(admin.id)).toBe(2);
      expect(counts.get(mod.id)).toBe(1);
    });

    test("does NOT count implicit member-fallback users", () => {
      // user-x has never been assigned → getRole() returns 'member', but
      // user_roles has no row for them, so the count is 0.
      expect(engine.getRole("user-x").name).toBe("member");
      const counts = engine.getRoleMemberCounts();
      const memberRole = engine.getRoleByName("member")!;
      expect(counts.get(memberRole.id) ?? 0).toBe(0);
    });

    test("decrements after a role.remove", () => {
      const admin = engine.getRoleByName("admin")!;
      engine.assignRole("a-1", admin.id, owner());
      expect(engine.getRoleMemberCounts().get(admin.id)).toBe(1);
      engine.removeRole("a-1", owner());
      expect(engine.getRoleMemberCounts().get(admin.id) ?? 0).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // getRoleOverrides — used by core.role.list to hydrate the matrix
  // tri-state (PR 4.5). Already exercised indirectly above; these tests
  // pin the wire-shape contract (key string, granted boolean).
  // -----------------------------------------------------------------------

  describe("getRoleOverrides", () => {
    test("returns empty array for a role with no overrides", () => {
      const member = engine.getRoleByName("member")!;
      expect(engine.getRoleOverrides(member.id)).toEqual([]);
    });

    test("returns one entry per row, with permission key + granted boolean", () => {
      engine.registerPermission({
        key: "gallery.upload",
        description: "Upload",
        defaultLevel: 60,
        pluginSlug: "gallery",
      });
      engine.registerPermission({
        key: "gallery.delete",
        description: "Delete",
        defaultLevel: 80,
        pluginSlug: "gallery",
      });
      const member = engine.getRoleByName("member")!;
      expectVoidOk(engine.grantPermission(member.id, "gallery.upload", owner()));
      expectVoidOk(engine.denyPermission(member.id, "gallery.delete", owner()));

      const overrides = engine.getRoleOverrides(member.id);
      const byKey = Object.fromEntries(overrides.map((o) => [o.permission, o.granted]));
      expect(byKey).toEqual({
        "gallery.upload": true,
        "gallery.delete": false,
      });
    });

    test("clears the entry after removePermissionOverride", () => {
      engine.registerPermission({
        key: "gallery.upload",
        description: "Upload",
        defaultLevel: 60,
        pluginSlug: "gallery",
      });
      const member = engine.getRoleByName("member")!;
      expectVoidOk(engine.grantPermission(member.id, "gallery.upload", owner()));
      expect(engine.getRoleOverrides(member.id).length).toBe(1);
      expectVoidOk(engine.removePermissionOverride(member.id, "gallery.upload", owner()));
      expect(engine.getRoleOverrides(member.id)).toEqual([]);
    });
  });
});

describe("getRoleIdsForUsers (bulk lookup for core.member.list)", () => {
  let engine: RolesEngine;

  beforeEach(() => {
    engine = makeEngine().engine;
  });

  test("returns empty map for an empty userId list", () => {
    expect(engine.getRoleIdsForUsers([])).toEqual(new Map());
  });

  test("returns the assigned role for a single user", () => {
    const mod = engine.getRoleByName("moderator")!;
    engine.assignRole("alice", mod.id, owner());
    const out = engine.getRoleIdsForUsers(["alice"]);
    expect(out.get("alice")).toBe(mod.id);
  });

  test("omits users with no row in user_roles (caller defaults to null)", () => {
    const out = engine.getRoleIdsForUsers(["never-assigned"]);
    expect(out.has("never-assigned")).toBe(false);
    expect(out.size).toBe(0);
  });

  test("mixes assigned + unassigned users in a single bulk call", () => {
    const mod = engine.getRoleByName("moderator")!;
    const admin = engine.getRoleByName("admin")!;
    engine.assignRole("alice", mod.id, owner());
    engine.assignRole("bob", admin.id, owner());
    const out = engine.getRoleIdsForUsers(["alice", "bob", "carol"]);
    expect(out.get("alice")).toBe(mod.id);
    expect(out.get("bob")).toBe(admin.id);
    expect(out.has("carol")).toBe(false);
  });

  test("scales to a 200-user page without collapsing into a SQL injection", () => {
    // Spot-check that the placeholder builder handles a realistic page size.
    const ids = Array.from({ length: 200 }, (_, i) => `u${i}`);
    const mod = engine.getRoleByName("moderator")!;
    engine.assignRole("u42", mod.id, owner());
    const out = engine.getRoleIdsForUsers(ids);
    expect(out.size).toBe(1);
    expect(out.get("u42")).toBe(mod.id);
  });
});
