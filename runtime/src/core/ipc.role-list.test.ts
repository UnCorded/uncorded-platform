// `core.role.list` returns every role joined with its `overrides` and
// `memberCount` fields (spec-22 Amendment B PR 4.5). The matrix UI
// depends on the join shape — both fields ship in one round-trip.
//
// We exercise this against a real `RolesEngine` (no fakes) because the
// JOIN logic and GROUP BY are the contract being verified.

import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { CoreModule } from "./module";
import { handleCoreClientAction } from "./ipc";
import { RolesEngine } from "../roles/engine";
import { createLogger } from "@uncorded/shared";
import type { EventBus } from "../events/bus";
import type { FileListFn, FileReadFn } from "../migrations";

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
  const init = RolesEngine.initialize(db, "/migrations", fs.listFiles, fs.readFile);
  if (!init.ok) throw new Error(`init failed: ${init.error.message}`);
  return { db, engine: new RolesEngine(db) };
}

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

interface RoleListResult {
  roles: Array<{
    id: number;
    name: string;
    level: number;
    isDefault: boolean;
    overrides: Array<{ permission: string; granted: boolean }>;
    memberCount: number;
  }>;
}

function callList(engine: RolesEngine): {
  result?: RoleListResult;
  error?: { code: string; message: string };
} {
  const out: { result?: RoleListResult; error?: { code: string; message: string } } = {};
  handleCoreClientAction(
    "core.role.list",
    {},
    "owner-1",
    true, // owner — bypasses permission gate
    makeModule(),
    engine,
    (r) => { out.result = r as RoleListResult; },
    (code, message) => { out.error = { code, message }; },
  );
  return out;
}

describe("core.role.list response shape", () => {
  it("returns each role with empty overrides + memberCount=0 on a fresh server", () => {
    const { engine } = makeEngine();
    const out = callList(engine);
    expect(out.error).toBeUndefined();
    expect(out.result).toBeDefined();
    for (const r of out.result!.roles) {
      expect(r.overrides).toEqual([]);
      expect(r.memberCount).toBe(0);
    }
  });

  it("orders roles by level descending (matches engine contract)", () => {
    const { engine } = makeEngine();
    const out = callList(engine);
    const levels = out.result!.roles.map((r) => r.level);
    const sorted = [...levels].sort((a, b) => b - a);
    expect(levels).toEqual(sorted);
  });

  it("hydrates memberCount from user_roles", () => {
    const { engine } = makeEngine();
    const owner = { userId: "owner-1", isOwner: true };
    const admin = engine.getRoleByName("admin")!;
    engine.assignRole("u1", admin.id, owner);
    engine.assignRole("u2", admin.id, owner);

    const out = callList(engine);
    const adminRow = out.result!.roles.find((r) => r.name === "admin")!;
    expect(adminRow.memberCount).toBe(2);

    const moderatorRow = out.result!.roles.find((r) => r.name === "moderator")!;
    expect(moderatorRow.memberCount).toBe(0);
  });

  it("hydrates overrides as { permission, granted: boolean }", () => {
    const { engine } = makeEngine();
    const owner = { userId: "owner-1", isOwner: true };
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
    engine.grantPermission(member.id, "gallery.upload", owner);
    engine.denyPermission(member.id, "gallery.delete", owner);

    const out = callList(engine);
    const memberRow = out.result!.roles.find((r) => r.name === "member")!;
    expect(memberRow.overrides.length).toBe(2);
    const map = Object.fromEntries(
      memberRow.overrides.map((o) => [o.permission, o.granted]),
    );
    expect(map).toEqual({
      "gallery.upload": true,
      "gallery.delete": false,
    });

    // Other roles must NOT inherit the member's overrides through the JOIN.
    const adminRow = out.result!.roles.find((r) => r.name === "admin")!;
    expect(adminRow.overrides).toEqual([]);
  });

  it("rejects non-owners without core.permissions.manage with FORBIDDEN", () => {
    const { engine } = makeEngine();
    const out: { result?: unknown; error?: { code: string; message: string } } = {};
    handleCoreClientAction(
      "core.role.list",
      {},
      "user-1",
      false,
      makeModule(),
      engine,
      (r) => { out.result = r; },
      (code, message) => { out.error = { code, message }; },
    );
    expect(out.error?.code).toBe("FORBIDDEN");
  });
});
