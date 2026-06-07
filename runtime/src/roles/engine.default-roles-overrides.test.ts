// Q2 lock from spec-22 Amendment B: default roles (member/moderator/admin/
// owner) accept permission overrides. Only their *level* and *name* are
// frozen — that's the meaning of `is_default = 1`.
//
// This was a contested design decision: an earlier draft proposed locking
// default roles entirely. We chose accept-overrides because admins routinely
// need to grant their `member` role a single plugin permission (e.g.
// "music.queue") without creating a parallel custom role. Q2 codifies that.

import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { RolesEngine } from "./engine";
import type { CallerContext } from "./types";
import type { FileListFn, FileReadFn } from "../migrations";

const MIGRATION_SQL = `
CREATE TABLE roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE,
  level INTEGER NOT NULL CHECK (level >= 1 AND level <= 100),
  is_default INTEGER NOT NULL DEFAULT 0,
  parent_role INTEGER REFERENCES roles(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE user_roles (
  user_id TEXT NOT NULL,
  role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_id)
);
CREATE TABLE permissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  default_level INTEGER NOT NULL CHECK (default_level >= 0 AND default_level <= 100),
  plugin_slug TEXT NOT NULL, registered_at INTEGER NOT NULL
);
CREATE TABLE role_permissions (
  role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id INTEGER NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  granted INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (role_id, permission_id)
);
`;

function mockFs(): { listFiles: FileListFn; readFile: FileReadFn } {
  return { listFiles: () => ["001_create_tables.sql"], readFile: () => MIGRATION_SQL };
}

function makeEngine(): RolesEngine {
  const db = new Database(":memory:");
  const fs = mockFs();
  RolesEngine.initialize(db, "/migrations", fs.listFiles, fs.readFile);
  return new RolesEngine(db);
}

const owner: CallerContext = { userId: "owner-1", isOwner: true };

const PERM = {
  key: "music.queue",
  description: "Queue songs",
  defaultLevel: 80, // higher than member(10), moderator(60); only admin(80) clears by default
  pluginSlug: "music",
};

describe("Q2: default roles accept permission overrides", () => {
  let engine: RolesEngine;

  beforeEach(() => {
    engine = makeEngine();
    engine.registerPermission(PERM);
  });

  describe("grant override", () => {
    test("granting on default member role succeeds", () => {
      const member = engine.getRoleByName("member")!;
      expect(member.isDefault).toBe(true);
      const result = engine.grantPermission(member.id, PERM.key, owner);
      expect(result.ok).toBe(true);
    });

    test("after grant on member, a member-level user passes the check", () => {
      const member = engine.getRoleByName("member")!;
      engine.grantPermission(member.id, PERM.key, owner);
      const caller: CallerContext = { userId: "u-1", isOwner: false };
      // Without the override, member(10) < default_level(80) → false.
      // With the grant override, the row wins → true.
      expect(engine.check("u-1", PERM.key, caller)).toBe(true);
    });

    test("granting on default moderator role succeeds", () => {
      const mod = engine.getRoleByName("moderator")!;
      expect(mod.isDefault).toBe(true);
      expect(engine.grantPermission(mod.id, PERM.key, owner).ok).toBe(true);
    });

    test("granting on default admin role succeeds (no-op semantically but row is written)", () => {
      const admin = engine.getRoleByName("admin")!;
      expect(admin.isDefault).toBe(true);
      expect(engine.grantPermission(admin.id, PERM.key, owner).ok).toBe(true);
    });
  });

  describe("deny override", () => {
    test("denying on default admin role succeeds", () => {
      const admin = engine.getRoleByName("admin")!;
      expect(engine.denyPermission(admin.id, PERM.key, owner).ok).toBe(true);
    });

    test("after deny on admin, an admin-level user FAILS the check", () => {
      const admin = engine.getRoleByName("admin")!;
      engine.assignRole("u-admin", admin.id, owner);
      engine.denyPermission(admin.id, PERM.key, owner);
      const caller: CallerContext = { userId: "u-admin", isOwner: false };
      // Without the override, admin(80) >= default_level(80) → true.
      // With the deny override, the row wins → false.
      expect(engine.check("u-admin", PERM.key, caller)).toBe(false);
    });
  });

  describe("remove override", () => {
    test("removing an override on a default role succeeds and restores default", () => {
      const member = engine.getRoleByName("member")!;
      engine.grantPermission(member.id, PERM.key, owner);
      const caller: CallerContext = { userId: "u-1", isOwner: false };
      expect(engine.check("u-1", PERM.key, caller)).toBe(true); // grant in effect

      const removed = engine.removePermissionOverride(member.id, PERM.key, owner);
      expect(removed.ok).toBe(true);
      expect(engine.check("u-1", PERM.key, caller)).toBe(false); // back to default rule
    });
  });

  describe("structural fields stay frozen", () => {
    test("renaming a default role still fails (level/name lock survives)", () => {
      const member = engine.getRoleByName("member")!;
      const result = engine.updateRole(member.id, { name: "renamed" }, owner);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("DEFAULT_ROLE_PROTECTED");
      }
    });

    test("changing the level of a default role still fails", () => {
      const member = engine.getRoleByName("member")!;
      const result = engine.updateRole(member.id, { level: 50 }, owner);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("DEFAULT_ROLE_PROTECTED");
      }
    });

    test("deleting a default role still fails", () => {
      const member = engine.getRoleByName("member")!;
      const result = engine.deleteRole(member.id, owner);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("DEFAULT_ROLE_PROTECTED");
      }
    });
  });
});
