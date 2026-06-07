// Permission-audit log: every grant/deny/remove emits an immutable row in
// the `permission_audit` table. UI surfaces a 90-day window via
// `core.permissions.audit`. Ordering is reverse-chronological (newest first)
// with a stable id tiebreaker — same-ms inserts must not jitter in the UI.

import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { RolesEngine } from "./engine";
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
CREATE TABLE permission_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  actor_user_id TEXT NOT NULL,
  target_role_id INTEGER,
  permission TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('grant','deny','remove')),
  reason TEXT
);
CREATE INDEX idx_permission_audit_ts ON permission_audit(ts DESC, id DESC);
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

describe("recordPermissionAudit + listPermissionAudit", () => {
  let engine: RolesEngine;

  beforeEach(() => {
    engine = makeEngine();
  });

  test("a single record round-trips with all fields", () => {
    engine.recordPermissionAudit("actor-1", 7, "music.queue", "grant", "promoted DJ");
    const rows = engine.listPermissionAudit(10, 0);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.actor_user_id).toBe("actor-1");
    expect(row.target_role_id).toBe(7);
    expect(row.permission).toBe("music.queue");
    expect(row.action).toBe("grant");
    expect(row.reason).toBe("promoted DJ");
    expect(typeof row.ts).toBe("number");
  });

  test("reason is optional and stored as null when omitted", () => {
    engine.recordPermissionAudit("actor-1", 7, "music.queue", "deny");
    const row = engine.listPermissionAudit(10, 0)[0]!;
    expect(row.reason).toBeNull();
  });

  test("target_role_id can be null (for non-role-scoped audits)", () => {
    engine.recordPermissionAudit("actor-1", null, "music.queue", "remove");
    const row = engine.listPermissionAudit(10, 0)[0]!;
    expect(row.target_role_id).toBeNull();
  });

  test("listing returns rows in DESC ts order (newest first)", async () => {
    engine.recordPermissionAudit("actor-1", 1, "p.a", "grant");
    // Force a measurable timestamp gap so the order is unambiguous even on
    // sub-millisecond clocks.
    await new Promise((r) => setTimeout(r, 5));
    engine.recordPermissionAudit("actor-1", 2, "p.b", "grant");
    await new Promise((r) => setTimeout(r, 5));
    engine.recordPermissionAudit("actor-1", 3, "p.c", "grant");

    const rows = engine.listPermissionAudit(10, 0);
    expect(rows.map((r) => r.permission)).toEqual(["p.c", "p.b", "p.a"]);
  });

  test("stable id tiebreaker for same-ts inserts (DESC by id)", () => {
    // Three inserts in the same millisecond — id is the tiebreaker.
    // Without the secondary `id DESC` sort, UI would jitter.
    engine.recordPermissionAudit("actor-1", 1, "p.a", "grant");
    engine.recordPermissionAudit("actor-1", 1, "p.b", "grant");
    engine.recordPermissionAudit("actor-1", 1, "p.c", "grant");

    const rows = engine.listPermissionAudit(10, 0);
    // Newest insert (highest id) appears first.
    expect(rows[0]!.permission).toBe("p.c");
    expect(rows[1]!.permission).toBe("p.b");
    expect(rows[2]!.permission).toBe("p.a");
    // ids strictly descending
    expect(rows[0]!.id).toBeGreaterThan(rows[1]!.id);
    expect(rows[1]!.id).toBeGreaterThan(rows[2]!.id);
  });

  test("limit caps the page size", () => {
    for (let i = 0; i < 25; i++) {
      engine.recordPermissionAudit("actor-1", i, `p.${i}`, "grant");
    }
    expect(engine.listPermissionAudit(10, 0)).toHaveLength(10);
    expect(engine.listPermissionAudit(5, 0)).toHaveLength(5);
  });

  test("offset paginates correctly", () => {
    for (let i = 0; i < 25; i++) {
      engine.recordPermissionAudit("actor-1", i, `p.${i}`, "grant");
    }
    const page1 = engine.listPermissionAudit(10, 0);
    const page2 = engine.listPermissionAudit(10, 10);
    const page3 = engine.listPermissionAudit(10, 20);
    expect(page2.length).toBe(10);
    expect(page3.length).toBe(5);
    // No overlap between page1 and page2.
    const ids1 = new Set(page1.map((r) => r.id));
    for (const r of page2) expect(ids1.has(r.id)).toBe(false);
  });

  test("empty table returns empty array", () => {
    expect(engine.listPermissionAudit(10, 0)).toEqual([]);
  });

  test("each action type round-trips ('grant' | 'deny' | 'remove')", () => {
    engine.recordPermissionAudit("a", 1, "p.x", "grant");
    engine.recordPermissionAudit("a", 1, "p.x", "deny");
    engine.recordPermissionAudit("a", 1, "p.x", "remove");
    const actions = engine.listPermissionAudit(10, 0).map((r) => r.action).sort();
    expect(actions).toEqual(["deny", "grant", "remove"]);
  });
});
