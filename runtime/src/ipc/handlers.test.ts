import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { RolesEngine } from "../roles/engine";
import type { FileListFn, FileReadFn } from "../migrations";
import type { IpcMessage, MessageHandler } from "./transport";
import type { PluginRegistry, PluginInfo } from "../http/types";
import type { PluginManifest } from "@uncorded/shared";
import { CapabilityChecker } from "../capabilities/checker";
import { buildCapabilityString } from "../ws/router";
import {
  handlePermissionsRegister,
  handlePermissionsCheck,
  handlePermissionsHasRole,
  handlePermissionsHasMinLevel,
  handlePermissionsGetRole,
  handleDataRead,
  handleDataSql,
  buildSelectQuery,
  PluginDbCache,
} from "./handlers";
import { mkdtempSync, mkdirSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

interface MockTransport {
  sent: IpcMessage[];
  send(msg: IpcMessage): void;
  onMessage(handler: MessageHandler): void;
  close(): void;
}

function mockTransport(): MockTransport {
  const sent: IpcMessage[] = [];
  return {
    sent,
    send(msg: IpcMessage) { sent.push(msg); },
    onMessage() {},
    close() {},
  };
}

function lastResponse(transport: MockTransport): IpcMessage {
  return transport.sent[transport.sent.length - 1]!;
}

function assignRole(engine: RolesEngine, userId: string, roleName: string): void {
  const role = engine.getRoleByName(roleName);
  if (!role) throw new Error(`Role ${roleName} not found`);
  engine.assignRole(userId, role.id, { userId: "owner-1", isOwner: true });
}

// ---------------------------------------------------------------------------
// permissions.register
// ---------------------------------------------------------------------------

describe("handlePermissionsRegister", () => {
  let engine: RolesEngine;
  let transport: MockTransport;

  beforeEach(() => {
    ({ engine } = makeEngine());
    transport = mockTransport();
  });

  test("registers a permission successfully", () => {
    const msg: IpcMessage = {
      type: "permissions.register",
      id: "req_1",
      key: "chat.send",
      description: "Send chat messages",
      default_level: 10,
    };

    handlePermissionsRegister("text-channels", msg, transport, engine);

    const resp = lastResponse(transport);
    expect(resp.type).toBe("response");
    expect(resp.id).toBe("req_1");
    expect(resp.result).toBe(true);

    const perms = engine.getPermissionsByPlugin("text-channels");
    expect(perms).toHaveLength(1);
    expect(perms[0]!.key).toBe("chat.send");
  });

  test("updates existing permission from same plugin", () => {
    handlePermissionsRegister("text-channels", {
      type: "permissions.register", id: "r1",
      key: "chat.send", description: "Old desc", default_level: 10,
    }, transport, engine);

    handlePermissionsRegister("text-channels", {
      type: "permissions.register", id: "r2",
      key: "chat.send", description: "New desc", default_level: 20,
    }, transport, engine);

    expect(lastResponse(transport).result).toBe(true);
    const perms = engine.getPermissionsByPlugin("text-channels");
    expect(perms[0]!.description).toBe("New desc");
    expect(perms[0]!.defaultLevel).toBe(20);
  });

  test("rejects registration from different plugin", () => {
    handlePermissionsRegister("text-channels", {
      type: "permissions.register", id: "r1",
      key: "chat.send", description: "Desc", default_level: 10,
    }, transport, engine);

    handlePermissionsRegister("reactions", {
      type: "permissions.register", id: "r2",
      key: "chat.send", description: "Desc", default_level: 10,
    }, transport, engine);

    const resp = lastResponse(transport);
    expect(resp.error).toBeDefined();
    expect((resp.error as { code: string }).code).toBe("PERMISSION_ALREADY_REGISTERED");
  });
});

// ---------------------------------------------------------------------------
// permissions.check
// ---------------------------------------------------------------------------

describe("handlePermissionsCheck", () => {
  let engine: RolesEngine;
  let transport: MockTransport;

  beforeEach(() => {
    ({ engine } = makeEngine());
    transport = mockTransport();
    // Register a permission that requires level 60 (moderator+)
    engine.registerPermission({
      key: "chat.delete",
      description: "Delete messages",
      defaultLevel: 60,
      pluginSlug: "text-channels",
    });
  });

  test("returns true when user has sufficient level", () => {
    assignRole(engine, "user_mod", "moderator");

    handlePermissionsCheck({
      type: "permissions.check", id: "c1",
      user_id: "user_mod", permission: "chat.delete",
    }, transport, engine, () => false);

    expect(lastResponse(transport).result).toBe(true);
  });

  test("returns false when user lacks permission", () => {
    // user_member has default member role (level 10)
    handlePermissionsCheck({
      type: "permissions.check", id: "c2",
      user_id: "user_member", permission: "chat.delete",
    }, transport, engine, () => false);

    expect(lastResponse(transport).result).toBe(false);
  });

  test("owner bypass returns true regardless of role", () => {
    // user_owner has member role but is the owner
    handlePermissionsCheck({
      type: "permissions.check", id: "c3",
      user_id: "user_owner", permission: "chat.delete",
    }, transport, engine, (uid) => uid === "user_owner");

    expect(lastResponse(transport).result).toBe(true);
  });

  test("returns false for unknown permission", () => {
    handlePermissionsCheck({
      type: "permissions.check", id: "c4",
      user_id: "user_1", permission: "nonexistent.perm",
    }, transport, engine, () => false);

    expect(lastResponse(transport).result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// permissions.has_role
// ---------------------------------------------------------------------------

describe("handlePermissionsHasRole", () => {
  let engine: RolesEngine;
  let transport: MockTransport;

  beforeEach(() => {
    ({ engine } = makeEngine());
    transport = mockTransport();
  });

  test("returns true when user has the role", () => {
    assignRole(engine, "user_admin", "admin");

    handlePermissionsHasRole({
      type: "permissions.has_role", id: "hr1",
      user_id: "user_admin", role_name: "admin",
    }, transport, engine);

    expect(lastResponse(transport).result).toBe(true);
  });

  test("returns false when user does not have the role", () => {
    handlePermissionsHasRole({
      type: "permissions.has_role", id: "hr2",
      user_id: "user_1", role_name: "admin",
    }, transport, engine);

    expect(lastResponse(transport).result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// permissions.has_min_level
// ---------------------------------------------------------------------------

describe("handlePermissionsHasMinLevel", () => {
  let engine: RolesEngine;
  let transport: MockTransport;

  beforeEach(() => {
    ({ engine } = makeEngine());
    transport = mockTransport();
  });

  test("returns true when user meets level", () => {
    assignRole(engine, "user_mod", "moderator"); // level 60

    handlePermissionsHasMinLevel({
      type: "permissions.has_min_level", id: "ml1",
      user_id: "user_mod", level: 50,
    }, transport, engine, () => false);

    expect(lastResponse(transport).result).toBe(true);
  });

  test("returns false when user below level", () => {
    // default member, level 10
    handlePermissionsHasMinLevel({
      type: "permissions.has_min_level", id: "ml2",
      user_id: "user_1", level: 50,
    }, transport, engine, () => false);

    expect(lastResponse(transport).result).toBe(false);
  });

  test("owner bypass returns true", () => {
    handlePermissionsHasMinLevel({
      type: "permissions.has_min_level", id: "ml3",
      user_id: "user_owner", level: 99,
    }, transport, engine, (uid) => uid === "user_owner");

    expect(lastResponse(transport).result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// permissions.get_role
// ---------------------------------------------------------------------------

describe("handlePermissionsGetRole", () => {
  let engine: RolesEngine;
  let transport: MockTransport;

  beforeEach(() => {
    ({ engine } = makeEngine());
    transport = mockTransport();
  });

  test("returns assigned role", () => {
    assignRole(engine, "user_admin", "admin");

    handlePermissionsGetRole({
      type: "permissions.get_role", id: "gr1",
      user_id: "user_admin",
    }, transport, engine);

    const resp = lastResponse(transport);
    expect(resp.result).toEqual({ name: "admin", level: 80 });
  });

  test("returns default member role for unassigned user", () => {
    handlePermissionsGetRole({
      type: "permissions.get_role", id: "gr2",
      user_id: "user_nobody",
    }, transport, engine);

    const resp = lastResponse(transport);
    expect(resp.result).toEqual({ name: "member", level: 10 });
  });
});

// ---------------------------------------------------------------------------
// buildSelectQuery
// ---------------------------------------------------------------------------

describe("buildSelectQuery", () => {
  const publicColumns = ["id", "channel_id", "author_id", "content", "created_at"];

  test("basic query with all public columns", () => {
    const { sql, params } = buildSelectQuery("messages", publicColumns);
    expect(sql).toBe('SELECT "id", "channel_id", "author_id", "content", "created_at" FROM "messages" LIMIT 100');
    expect(params).toEqual([]);
  });

  test("select specific columns", () => {
    const { sql } = buildSelectQuery("messages", publicColumns, ["id", "content"]);
    expect(sql).toBe('SELECT "id", "content" FROM "messages" LIMIT 100');
  });

  test("where clauses", () => {
    const { sql, params } = buildSelectQuery("messages", publicColumns, undefined, [
      { column: "channel_id", op: "=", value: "ch1" },
      { column: "author_id", op: "!=", value: "banned" },
    ]);
    expect(sql).toBe(
      'SELECT "id", "channel_id", "author_id", "content", "created_at" FROM "messages" WHERE "channel_id" = ? AND "author_id" != ? LIMIT 100',
    );
    expect(params).toEqual(["ch1", "banned"]);
  });

  test("order by", () => {
    const { sql } = buildSelectQuery("messages", publicColumns, undefined, undefined, [
      { column: "created_at", direction: "desc" },
    ]);
    expect(sql).toContain('ORDER BY "created_at" DESC');
  });

  test("custom limit", () => {
    const { sql } = buildSelectQuery("messages", publicColumns, undefined, undefined, undefined, 50);
    expect(sql).toContain("LIMIT 50");
  });

  test("limit capped at 10000", () => {
    const { sql } = buildSelectQuery("messages", publicColumns, undefined, undefined, undefined, 99999);
    expect(sql).toContain("LIMIT 10000");
  });

  test("full query", () => {
    const { sql, params } = buildSelectQuery(
      "messages",
      publicColumns,
      ["id", "content"],
      [{ column: "channel_id", op: "=", value: "ch1" }],
      [{ column: "created_at", direction: "desc" }],
      25,
    );
    expect(sql).toBe(
      'SELECT "id", "content" FROM "messages" WHERE "channel_id" = ? ORDER BY "created_at" DESC LIMIT 25',
    );
    expect(params).toEqual(["ch1"]);
  });
});

// ---------------------------------------------------------------------------
// handleDataRead
// ---------------------------------------------------------------------------

describe("handleDataRead", () => {
  let transport: MockTransport;
  let targetDb: Database;
  let registry: PluginRegistry;

  const targetManifest = {
    name: "text-channels",
    version: "1.0.0",
    api_version: "1",
    author: "test",
    description: "Test plugin",
    license: "MIT",
    type: "standalone" as const,
    permissions: [],
    public_schema: {
      messages: {
        columns: ["id", "channel_id", "author_id", "content", "created_at"],
        description: "All messages.",
      },
      channels: {
        columns: ["id", "name", "topic", "created_at"],
        description: "All channels.",
      },
    },
  } satisfies PluginManifest;

  beforeEach(() => {
    transport = mockTransport();

    // Create a real SQLite DB for the target plugin
    targetDb = new Database(":memory:");
    targetDb.run(`
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        author_id TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        internal_flags INTEGER DEFAULT 0
      )
    `);
    targetDb.run(
      "INSERT INTO messages (id, channel_id, author_id, content, created_at) VALUES (?, ?, ?, ?, ?)",
      ["m1", "ch1", "user1", "Hello", 1000],
    );
    targetDb.run(
      "INSERT INTO messages (id, channel_id, author_id, content, created_at) VALUES (?, ?, ?, ?, ?)",
      ["m2", "ch1", "user2", "World", 2000],
    );
    targetDb.run(
      "INSERT INTO messages (id, channel_id, author_id, content, created_at) VALUES (?, ?, ?, ?, ?)",
      ["m3", "ch2", "user1", "Other channel", 3000],
    );

    registry = {
      getPlugin(slug: string): PluginInfo | undefined {
        if (slug === "text-channels") {
          return {
            slug: "text-channels",
            manifest: targetManifest,
            dataDir: "/data/plugins/text-channels",
            frontendDir: null,
            authenticatedAssets: false,
            ready: true,
          };
        }
        return undefined;
      },
      getPluginCount() { return 1; },
      listPlugins() { return []; },
      setReady() {},
    };
  });

  // Helper that injects the target DB directly (avoids file system)
  function handleWithDb(msg: IpcMessage): void {
    handleDataRead("reactions", msg, transport, registry, () => targetDb);
  }

  test("returns rows for valid query", () => {
    handleWithDb({
      type: "data.read", id: "dr1",
      plugin: "text-channels", table: "messages",
      select: ["id", "content"],
      where: [{ column: "channel_id", op: "=", value: "ch1" }],
      order_by: [{ column: "created_at", direction: "desc" }],
    });

    const resp = lastResponse(transport);
    expect(resp.error).toBeUndefined();
    expect(resp.result).toEqual([
      { id: "m2", content: "World" },
      { id: "m1", content: "Hello" },
    ]);
  });

  test("returns all public columns when select is omitted", () => {
    handleWithDb({
      type: "data.read", id: "dr2",
      plugin: "text-channels", table: "messages",
      where: [{ column: "id", op: "=", value: "m1" }],
    });

    const resp = lastResponse(transport);
    const rows = resp.result as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]!).sort()).toEqual(
      ["author_id", "channel_id", "content", "created_at", "id"],
    );
    // internal_flags should NOT be present
    expect(rows[0]!["internal_flags"]).toBeUndefined();
  });

  test("error when target plugin not found", () => {
    handleWithDb({
      type: "data.read", id: "dr3",
      plugin: "nonexistent", table: "messages",
    });

    const resp = lastResponse(transport);
    expect((resp.error as { code: string }).code).toBe("PLUGIN_NOT_FOUND");
  });

  test("error when table not in public_schema", () => {
    handleWithDb({
      type: "data.read", id: "dr4",
      plugin: "text-channels", table: "internal_table",
    });

    const resp = lastResponse(transport);
    expect((resp.error as { code: string }).code).toBe("TABLE_NOT_PUBLIC");
  });

  test("error when select contains invalid column", () => {
    handleWithDb({
      type: "data.read", id: "dr5",
      plugin: "text-channels", table: "messages",
      select: ["id", "internal_flags"],
    });

    const resp = lastResponse(transport);
    expect((resp.error as { code: string }).code).toBe("COLUMN_NOT_PUBLIC");
  });

  test("error when where references invalid column", () => {
    handleWithDb({
      type: "data.read", id: "dr6",
      plugin: "text-channels", table: "messages",
      where: [{ column: "internal_flags", op: "=", value: 0 }],
    });

    const resp = lastResponse(transport);
    expect((resp.error as { code: string }).code).toBe("COLUMN_NOT_PUBLIC");
  });

  test("error when order_by references invalid column", () => {
    handleWithDb({
      type: "data.read", id: "dr7",
      plugin: "text-channels", table: "messages",
      order_by: [{ column: "internal_flags", direction: "asc" }],
    });

    const resp = lastResponse(transport);
    expect((resp.error as { code: string }).code).toBe("COLUMN_NOT_PUBLIC");
  });

  test("respects limit", () => {
    handleWithDb({
      type: "data.read", id: "dr8",
      plugin: "text-channels", table: "messages",
      limit: 1,
    });

    const resp = lastResponse(transport);
    expect(resp.result).toHaveLength(1);
  });

  test("error when plugin has no public_schema", () => {
    const noSchemaRegistry: PluginRegistry = {
      getPlugin(slug: string): PluginInfo | undefined {
        if (slug === "private-plugin") {
          return {
            slug: "private-plugin",
            manifest: {
              name: "private-plugin",
              version: targetManifest.version,
              api_version: targetManifest.api_version,
              author: targetManifest.author,
              description: targetManifest.description,
              license: targetManifest.license,
              type: targetManifest.type,
              permissions: targetManifest.permissions,
            },
            dataDir: "/data/plugins/private-plugin",
            frontendDir: null,
            authenticatedAssets: false,
            ready: true,
          };
        }
        return undefined;
      },
      getPluginCount() { return 1; },
      listPlugins() { return []; },
      setReady() {},
    };

    handleDataRead("reactions", {
      type: "data.read", id: "dr9",
      plugin: "private-plugin", table: "anything",
    }, transport, noSchemaRegistry, () => targetDb);

    const resp = lastResponse(transport);
    expect((resp.error as { code: string }).code).toBe("NO_PUBLIC_SCHEMA");
  });
});

// ---------------------------------------------------------------------------
// Cross-plugin data.read — capability gate integration
//
// These tests prove the full path: buildCapabilityString derives the required
// capability from the IPC message, CapabilityChecker enforces it, and
// handleDataRead executes the query only when the gate passes.
// ---------------------------------------------------------------------------

describe("cross-plugin data.read — capability gate integration", () => {
  let transport: MockTransport;
  let targetDb: Database;
  let registry: PluginRegistry;

  const targetManifest = {
    name: "text-channels",
    version: "1.0.0",
    api_version: "1",
    author: "test",
    description: "Test plugin",
    license: "MIT",
    type: "standalone" as const,
    permissions: [],
    public_schema: {
      messages: {
        columns: ["id", "channel_id", "content"],
        description: "Public messages.",
      },
    },
  } satisfies PluginManifest;

  beforeEach(() => {
    transport = mockTransport();

    targetDb = new Database(":memory:");
    targetDb.run(`
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        content TEXT NOT NULL
      )
    `);
    targetDb.run(
      "INSERT INTO messages (id, channel_id, content) VALUES (?, ?, ?)",
      ["m1", "ch1", "Hello world"],
    );

    registry = {
      getPlugin(slug: string): PluginInfo | undefined {
        if (slug === "text-channels") {
          return {
            slug: "text-channels",
            manifest: targetManifest,
            dataDir: "/data/plugins/text-channels",
            frontendDir: null,
            authenticatedAssets: false,
            ready: true,
          };
        }
        return undefined;
      },
      getPluginCount() { return 1; },
      listPlugins() { return []; },
      setReady() {},
    };
  });

  test("buildCapabilityString derives correct capability for data.read", () => {
    const msg: IpcMessage = {
      type: "data.read",
      id: "cap1",
      plugin: "text-channels",
      table: "messages",
    };
    const capability = buildCapabilityString(msg);
    expect(capability).toBe("data.read:text-channels.messages");
  });

  test("plugin with declared data.read capability can read target table", () => {
    const msg: IpcMessage = {
      type: "data.read",
      id: "int1",
      plugin: "text-channels",
      table: "messages",
      select: ["id", "content"],
    };

    // Simulate capability gate passing
    const checker = new CapabilityChecker("reactions", [
      "data.read:text-channels.messages",
    ]);
    const gateResult = checker.check(buildCapabilityString(msg)!);
    expect(gateResult.ok).toBe(true);

    // Handler executes the query when gate passes
    handleDataRead("reactions", msg, transport, registry, () => targetDb);

    const resp = lastResponse(transport);
    expect(resp.error).toBeUndefined();
    const rows = resp.result as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ id: "m1", content: "Hello world" });
  });

  test("plugin without data.read capability is denied by the gate", () => {
    const msg: IpcMessage = {
      type: "data.read",
      id: "int2",
      plugin: "text-channels",
      table: "messages",
    };

    // Plugin has no data.read permission at all
    const checker = new CapabilityChecker("reactions", [
      "data.sql:self",
    ]);
    const gateResult = checker.check(buildCapabilityString(msg)!);

    expect(gateResult.ok).toBe(false);
    if (!gateResult.ok) {
      expect(gateResult.code).toBe("CAPABILITY_DENIED");
      expect(gateResult.permission).toBe("data.read:text-channels.messages");
      expect(gateResult.plugin).toBe("reactions");
    }
  });

  test("plugin with data.read for a different table cannot read this table", () => {
    const msg: IpcMessage = {
      type: "data.read",
      id: "int3",
      plugin: "text-channels",
      table: "messages",
    };

    // Plugin only has access to text-channels.channels, not text-channels.messages
    const checker = new CapabilityChecker("reactions", [
      "data.read:text-channels.channels",
    ]);
    const gateResult = checker.check(buildCapabilityString(msg)!);

    expect(gateResult.ok).toBe(false);
    if (!gateResult.ok) {
      expect(gateResult.code).toBe("CAPABILITY_DENIED");
      expect(gateResult.permission).toBe("data.read:text-channels.messages");
    }
  });
});

// ---------------------------------------------------------------------------
// handleDataSql
// ---------------------------------------------------------------------------

describe("handleDataSql", () => {
  let transport: MockTransport;
  let db: Database;

  beforeEach(() => {
    transport = mockTransport();
    db = new Database(":memory:");
    db.run(`
      CREATE TABLE items (
        id   TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        val  INTEGER NOT NULL DEFAULT 0
      )
    `);
    db.run("INSERT INTO items (id, name, val) VALUES ('i1', 'alpha', 10)");
    db.run("INSERT INTO items (id, name, val) VALUES ('i2', 'beta', 20)");
  });

  function openDb(_slug: string): Database {
    return db;
  }

  test("run: executes SQL and returns changes + lastInsertRowid", () => {
    const msg: IpcMessage = {
      type: "data.sql",
      id: "sql1",
      method: "run",
      sql: "UPDATE items SET val = ? WHERE id = ?",
      params: [99, "i1"],
    };
    handleDataSql("myplugin", msg, transport, openDb);
    const resp = lastResponse(transport);
    expect(resp.error).toBeUndefined();
    const result = resp.result as { changes: number; lastInsertRowid: number | bigint };
    expect(result.changes).toBe(1);
  });

  test("query: returns rows as objects with named columns", () => {
    const msg: IpcMessage = {
      type: "data.sql",
      id: "sql2",
      method: "query",
      sql: "SELECT id, name FROM items ORDER BY name ASC",
    };
    handleDataSql("myplugin", msg, transport, openDb);
    const resp = lastResponse(transport);
    expect(resp.error).toBeUndefined();
    const rows = resp.result as Record<string, unknown>[];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ id: "i1", name: "alpha" });
    expect(rows[1]).toEqual({ id: "i2", name: "beta" });
  });

  test("exec: executes statement and returns null", () => {
    const msg: IpcMessage = {
      type: "data.sql",
      id: "sql3",
      method: "exec",
      sql: "DELETE FROM items",
    };
    handleDataSql("myplugin", msg, transport, openDb);
    const resp = lastResponse(transport);
    expect(resp.error).toBeUndefined();
    expect(resp.result).toBeNull();
  });

  test("transaction: executes statements atomically and returns RunResult array", () => {
    const msg: IpcMessage = {
      type: "data.sql",
      id: "sql4",
      method: "transaction",
      statements: [
        { sql: "UPDATE items SET val = ? WHERE id = ?", params: [55, "i1"] },
        { sql: "UPDATE items SET val = ? WHERE id = ?", params: [66, "i2"] },
      ],
    };
    handleDataSql("myplugin", msg, transport, openDb);
    const resp = lastResponse(transport);
    expect(resp.error).toBeUndefined();
    const results = resp.result as { changes: number; lastInsertRowid: number | bigint }[];
    expect(results).toHaveLength(2);
    expect(results[0]!.changes).toBe(1);
    expect(results[1]!.changes).toBe(1);
  });

  test("malformed method → INVALID_PARAMS", () => {
    const msg: IpcMessage = {
      type: "data.sql",
      id: "sql5",
      method: "NOTAMETHOD",
      sql: "SELECT 1",
    };
    handleDataSql("myplugin", msg, transport, openDb);
    const resp = lastResponse(transport);
    expect((resp.error as { code: string }).code).toBe("INVALID_PARAMS");
  });

  test("sql is not a string → INVALID_PARAMS", () => {
    const msg: IpcMessage = {
      type: "data.sql",
      id: "sql6",
      method: "run",
      sql: 42,
    };
    handleDataSql("myplugin", msg, transport, openDb);
    const resp = lastResponse(transport);
    expect((resp.error as { code: string }).code).toBe("INVALID_PARAMS");
  });

  test("params not an array → INVALID_PARAMS", () => {
    const msg: IpcMessage = {
      type: "data.sql",
      id: "sql7",
      method: "run",
      sql: "SELECT 1",
      params: "notanarray",
    };
    handleDataSql("myplugin", msg, transport, openDb);
    const resp = lastResponse(transport);
    expect((resp.error as { code: string }).code).toBe("INVALID_PARAMS");
  });

  test("params element is an object → INVALID_PARAMS", () => {
    const msg: IpcMessage = {
      type: "data.sql",
      id: "sql8",
      method: "run",
      sql: "SELECT ?",
      params: [{ foo: "bar" }],
    };
    handleDataSql("myplugin", msg, transport, openDb);
    const resp = lastResponse(transport);
    expect((resp.error as { code: string }).code).toBe("INVALID_PARAMS");
  });

  test("DATABASE_ERROR on bad SQL", () => {
    const msg: IpcMessage = {
      type: "data.sql",
      id: "sql9",
      method: "run",
      sql: "THIS IS NOT VALID SQL $$$$",
    };
    handleDataSql("myplugin", msg, transport, openDb);
    const resp = lastResponse(transport);
    expect((resp.error as { code: string }).code).toBe("DATABASE_ERROR");
  });

  test("data.sql capability string → data.sql:self", () => {
    const msg: IpcMessage = { type: "data.sql", id: "cap1", method: "query", sql: "SELECT 1" };
    const capability = buildCapabilityString(msg);
    expect(capability).toBe("data.sql:self");
  });

  test("data.sql:self in plugin manifest passes capability gate", () => {
    const checker = new CapabilityChecker("my-plugin", ["data.sql:self"]);
    const result = checker.check("data.sql:self");
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PluginDbCache.checkpointAll
// ---------------------------------------------------------------------------

describe("PluginDbCache.checkpointAll", () => {
  // The periodic checkpoint timer in main.ts calls this every 30 minutes (and
  // once at shutdown). The contract: never throw, return one entry per cached
  // DB, and TRUNCATE actually shrinks the on-disk -wal file so a long-running
  // plugin's WAL stays bounded.

  let tempDir: string;
  let cache: PluginDbCache;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "uc-pluginscache-"));
    cache = new PluginDbCache(tempDir);
  });

  function openSlug(slug: string) {
    mkdirSync(join(tempDir, slug), { recursive: true });
    return cache.get(slug);
  }

  function cleanup() {
    // Windows holds SQLite's -wal/-shm locks briefly after close; rmSync
    // can EBUSY transiently. Test value is the assertions; the temp dir
    // is the OS's anyway and will be reaped.
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }

  test("empty cache returns empty array", () => {
    expect(cache.checkpointAll()).toEqual([]);
    cleanup();
  });

  test("single open DB checkpoints OK", () => {
    const db = openSlug("a");
    db.exec("CREATE TABLE t (id INTEGER)");
    db.exec("INSERT INTO t (id) VALUES (1), (2), (3)");

    const results = cache.checkpointAll();
    expect(results.length).toBe(1);
    expect(results[0]?.slug).toBe("a");
    expect(results[0]?.ok).toBe(true);
    expect(results[0]?.err).toBeUndefined();

    cache.close("a");
    cleanup();
  });

  test("multiple open DBs each get one result entry", () => {
    openSlug("a").exec("CREATE TABLE x (id INTEGER)");
    openSlug("b").exec("CREATE TABLE y (id INTEGER)");
    openSlug("c").exec("CREATE TABLE z (id INTEGER)");

    const results = cache.checkpointAll();
    const slugs = results.map((r) => r.slug).sort();
    expect(slugs).toEqual(["a", "b", "c"]);
    expect(results.every((r) => r.ok)).toBe(true);

    cache.close("a");
    cache.close("b");
    cache.close("c");
    cleanup();
  });

  test("TRUNCATE shrinks the -wal file after a write burst", () => {
    // The whole point of this method: a plugin that writes steadily without
    // reading lets WAL grow. After TRUNCATE, the file should be back to its
    // header (32 bytes when empty / 0 bytes on some platforms) — definitely
    // smaller than the post-burst size.
    const db = openSlug("burst");
    db.exec("CREATE TABLE bytes (b BLOB)");
    const insert = db.prepare("INSERT INTO bytes (b) VALUES (?)");
    // 200 rows × 4KB = ~800KB of WAL pressure before checkpoint.
    const blob = new Uint8Array(4096);
    for (let i = 0; i < 200; i++) insert.run(blob);

    const walPath = join(tempDir, "burst", "burst.db-wal");
    expect(existsSync(walPath)).toBe(true);
    const beforeSize = statSync(walPath).size;
    expect(beforeSize).toBeGreaterThan(100_000);

    const results = cache.checkpointAll();
    expect(results[0]?.ok).toBe(true);

    // After TRUNCATE the WAL is reset — file may be 0 bytes or just the
    // 32-byte header. Either way, materially smaller than the pre-checkpoint
    // size.
    const afterSize = existsSync(walPath) ? statSync(walPath).size : 0;
    expect(afterSize).toBeLessThan(beforeSize);

    cache.close("burst");
    cleanup();
  });

  test("error on one DB does not block checkpoints on the others", () => {
    // Force a failure by closing one DB out from under the cache, leaving
    // the cache entry pointing at a closed handle. The error path captures
    // the exception per-slug instead of bubbling.
    const dbA = openSlug("good");
    dbA.exec("CREATE TABLE t (id INTEGER)");
    const dbB = openSlug("bad");
    dbB.exec("CREATE TABLE t (id INTEGER)");
    dbB.close();

    const results = cache.checkpointAll();
    const byKey = new Map(results.map((r) => [r.slug, r] as const));
    expect(byKey.get("good")?.ok).toBe(true);
    expect(byKey.get("bad")?.ok).toBe(false);
    expect(byKey.get("bad")?.err).toBeTruthy();

    cache.close("good");
    cleanup();
  });
});
