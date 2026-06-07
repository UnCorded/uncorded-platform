// Verifies the strict-greater-than rule of `canActOn` per spec-22 Amendment B.
// `canActOn(actor, target)` is the standard precondition for moderator-style
// actions (kick, ban, demote). It must REJECT same-level peers — equal-rank
// admins cannot act on each other; otherwise the hierarchy collapses to
// "any admin can demote any other admin," and Q1 (self-demotion) loses meaning.

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
const nonOwner = (userId: string): CallerContext => ({ userId, isOwner: false });

describe("RolesEngine.canActOn", () => {
  let engine: RolesEngine;

  beforeEach(() => {
    engine = makeEngine();
  });

  test("owner can act on anyone (including peers)", () => {
    const adminRole = engine.getRoleByName("admin")!;
    engine.assignRole("u-target", adminRole.id, owner);
    expect(engine.canActOn("anyone", "u-target", owner)).toBe(true);
  });

  test("higher rank acts on lower (admin > member)", () => {
    const adminRole = engine.getRoleByName("admin")!;
    engine.assignRole("u-actor", adminRole.id, owner);
    // u-target stays as member (default)
    expect(engine.canActOn("u-actor", "u-target", nonOwner("u-actor"))).toBe(true);
  });

  test("equal rank CANNOT act (admin === admin)", () => {
    const adminRole = engine.getRoleByName("admin")!;
    engine.assignRole("u-actor", adminRole.id, owner);
    engine.assignRole("u-target", adminRole.id, owner);
    expect(engine.canActOn("u-actor", "u-target", nonOwner("u-actor"))).toBe(false);
  });

  test("lower rank CANNOT act on higher (member > admin)", () => {
    const adminRole = engine.getRoleByName("admin")!;
    engine.assignRole("u-target", adminRole.id, owner);
    // u-actor is unassigned → defaults to member
    expect(engine.canActOn("u-actor", "u-target", nonOwner("u-actor"))).toBe(false);
  });

  test("two unassigned users (both default member) — equal level, cannot act", () => {
    expect(engine.canActOn("u-actor", "u-target", nonOwner("u-actor"))).toBe(false);
  });

  test("self-targeting falls under equal-rank rule (cannot act on self)", () => {
    // Defense-in-depth: even without the IPC SELF_DEMOTION_BLOCKED guard,
    // canActOn returns false for self because actor.level === target.level.
    expect(engine.canActOn("u-self", "u-self", nonOwner("u-self"))).toBe(false);
  });

  test("strictly-greater holds at the boundary (level 11 > level 10)", () => {
    // Custom role at level 11 should outrank member (level 10).
    const custom = engine.createRole({ name: "trial-mod", level: 11 }, owner);
    expect(custom.ok).toBe(true);
    if (!custom.ok) return;
    engine.assignRole("u-actor", custom.value.id, owner);
    expect(engine.canActOn("u-actor", "u-target", nonOwner("u-actor"))).toBe(true);
  });
});
