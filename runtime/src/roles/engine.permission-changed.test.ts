// Verifies the in-process `onPermissionChanged` listener contract.
// Subsystems (most notably Registered Terminals) subscribe to this stream
// to revoke open sessions in the same tick as a role/permission mutation —
// the public event bus is too slow for sub-second revocation.
//
// Per spec-22 Amendment B the event shape is:
//   - assignRole / removeRole       → { userId }
//   - grantPermission / denyPermission / removePermissionOverride
//                                   → { roleId, permissionKey }
//
// Failures must NOT emit (otherwise listeners would chase ghosts).

import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { RolesEngine, type PermissionChangedEvent } from "./engine";
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
  defaultLevel: 80,
  pluginSlug: "music",
};

interface Subscriber {
  events: PermissionChangedEvent[];
  unsubscribe: () => void;
}

function subscribe(engine: RolesEngine): Subscriber {
  const events: PermissionChangedEvent[] = [];
  const unsubscribe = engine.onPermissionChanged((e) => events.push(e));
  return { events, unsubscribe };
}

describe("onPermissionChanged emission contract", () => {
  let engine: RolesEngine;

  beforeEach(() => {
    engine = makeEngine();
    engine.registerPermission(PERM);
  });

  describe("user-scoped events (assignRole / removeRole)", () => {
    test("assignRole emits { userId } on success", () => {
      const sub = subscribe(engine);
      const member = engine.getRoleByName("member")!;
      engine.assignRole("u-1", member.id, owner);
      expect(sub.events).toEqual([{ userId: "u-1" }]);
    });

    test("removeRole emits { userId } on success", () => {
      const member = engine.getRoleByName("member")!;
      engine.assignRole("u-1", member.id, owner);
      const sub = subscribe(engine);
      engine.removeRole("u-1", owner);
      expect(sub.events).toEqual([{ userId: "u-1" }]);
    });

    test("failed assignRole emits NOTHING (HIERARCHY_VIOLATION)", () => {
      const sub = subscribe(engine);
      // Caller is a member trying to assign admin → HIERARCHY_VIOLATION.
      const adminRole = engine.getRoleByName("admin")!;
      engine.assignRole("caller", engine.getRoleByName("member")!.id, owner);
      const result = engine.assignRole("u-1", adminRole.id, { userId: "caller", isOwner: false });
      expect(result.ok).toBe(false);
      // The first emit was for the setup `engine.assignRole("caller", ...)`,
      // which used `owner` → that one fires. We snapshot AFTER setup.
      // Drop setup event:
      const after = sub.events.filter((e) => e.userId === "u-1");
      expect(after).toEqual([]);
    });

    test("failed removeRole emits NOTHING", () => {
      // Set "u-1" to admin level. Caller is a member → cannot demote admin.
      const adminRole = engine.getRoleByName("admin")!;
      engine.assignRole("u-1", adminRole.id, owner);
      const memberRole = engine.getRoleByName("member")!;
      engine.assignRole("caller", memberRole.id, owner);

      const sub = subscribe(engine);
      const result = engine.removeRole("u-1", { userId: "caller", isOwner: false });
      expect(result.ok).toBe(false);
      expect(sub.events).toEqual([]);
    });
  });

  describe("role-scoped events (grant / deny / removePermissionOverride)", () => {
    test("grantPermission emits { roleId, permissionKey } on success", () => {
      const sub = subscribe(engine);
      const mod = engine.getRoleByName("moderator")!;
      engine.grantPermission(mod.id, PERM.key, owner);
      expect(sub.events).toEqual([{ roleId: mod.id, permissionKey: PERM.key }]);
    });

    test("denyPermission emits { roleId, permissionKey } on success", () => {
      const sub = subscribe(engine);
      const mod = engine.getRoleByName("moderator")!;
      engine.denyPermission(mod.id, PERM.key, owner);
      expect(sub.events).toEqual([{ roleId: mod.id, permissionKey: PERM.key }]);
    });

    test("removePermissionOverride emits { roleId, permissionKey } on success", () => {
      const mod = engine.getRoleByName("moderator")!;
      engine.grantPermission(mod.id, PERM.key, owner);
      const sub = subscribe(engine);
      engine.removePermissionOverride(mod.id, PERM.key, owner);
      expect(sub.events).toEqual([{ roleId: mod.id, permissionKey: PERM.key }]);
    });

    test("failed grantPermission emits NOTHING (PERMISSION_NOT_FOUND)", () => {
      const sub = subscribe(engine);
      const mod = engine.getRoleByName("moderator")!;
      const result = engine.grantPermission(mod.id, "does.not.exist", owner);
      expect(result.ok).toBe(false);
      expect(sub.events).toEqual([]);
    });

    test("failed denyPermission emits NOTHING (ROLE_NOT_FOUND)", () => {
      const sub = subscribe(engine);
      const result = engine.denyPermission(9999, PERM.key, owner);
      expect(result.ok).toBe(false);
      expect(sub.events).toEqual([]);
    });

    test("failed removePermissionOverride emits NOTHING", () => {
      const sub = subscribe(engine);
      const result = engine.removePermissionOverride(9999, PERM.key, owner);
      expect(result.ok).toBe(false);
      expect(sub.events).toEqual([]);
    });
  });

  describe("listener lifecycle", () => {
    test("multiple subscribers all receive the same event", () => {
      const a = subscribe(engine);
      const b = subscribe(engine);
      const member = engine.getRoleByName("member")!;
      engine.assignRole("u-1", member.id, owner);
      expect(a.events).toEqual([{ userId: "u-1" }]);
      expect(b.events).toEqual([{ userId: "u-1" }]);
    });

    test("unsubscribe stops further events", () => {
      const sub = subscribe(engine);
      const member = engine.getRoleByName("member")!;
      engine.assignRole("u-1", member.id, owner);
      sub.unsubscribe();
      engine.assignRole("u-2", member.id, owner);
      expect(sub.events).toEqual([{ userId: "u-1" }]);
    });

    test("a throwing listener does not break siblings or engine state", () => {
      const sibling = subscribe(engine);
      const stop = engine.onPermissionChanged(() => {
        throw new Error("listener bug");
      });
      const member = engine.getRoleByName("member")!;
      // The mutation must still succeed end-to-end.
      const result = engine.assignRole("u-1", member.id, owner);
      expect(result.ok).toBe(true);
      // Sibling still received the event.
      expect(sibling.events).toEqual([{ userId: "u-1" }]);
      stop();
    });
  });

  describe("getUsersWithRole helper (cascade fan-out)", () => {
    test("returns user ids assigned to the given role", () => {
      const member = engine.getRoleByName("member")!;
      engine.assignRole("u-1", member.id, owner);
      engine.assignRole("u-2", member.id, owner);
      engine.assignRole("u-3", member.id, owner);
      const ids = engine.getUsersWithRole(member.id).sort();
      expect(ids).toEqual(["u-1", "u-2", "u-3"]);
    });

    test("returns empty array for a role with no users", () => {
      const admin = engine.getRoleByName("admin")!;
      expect(engine.getUsersWithRole(admin.id)).toEqual([]);
    });
  });
});
