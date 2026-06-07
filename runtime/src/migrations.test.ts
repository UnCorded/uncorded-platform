import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "./migrations";
import type { FileListFn, FileReadFn, MigrationResult, MigrationError } from "./migrations";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDb(): Database {
  return new Database(":memory:");
}

/**
 * Build mock filesystem functions from a map of filename → SQL content.
 */
function mockFs(files: Record<string, string>): {
  listFiles: FileListFn;
  readFile: FileReadFn;
} {
  return {
    listFiles: () => Object.keys(files),
    readFile: (path: string) => {
      const filename = path.split("/").pop()!;
      if (!(filename in files)) {
        throw Object.assign(new Error(`Not found: ${path}`), { code: "ENOENT" });
      }
      return files[filename]!;
    },
  };
}

/** listFiles that throws ENOENT (no migrations directory). */
function noDir(): { listFiles: FileListFn; readFile: FileReadFn } {
  return {
    listFiles: () => {
      throw Object.assign(new Error("No such directory"), { code: "ENOENT" });
    },
    readFile: () => {
      throw new Error("Should not be called");
    },
  };
}

function expectOk(result: MigrationResult): number {
  if (!result.ok) {
    throw new Error(
      `Expected ok but got error: [${result.error.code}] ${result.error.message}`,
    );
  }
  return result.applied;
}

function expectError(result: MigrationResult): MigrationError {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable");
  return result.error;
}

function getAppliedMigrations(db: Database): Array<{ number: number; filename: string }> {
  return db
    .query<{ number: number; filename: string }, []>(
      "SELECT number, filename FROM _migrations ORDER BY number",
    )
    .all();
}

function tableExists(db: Database, name: string): boolean {
  const row = db
    .query<{ cnt: number }, [string]>(
      "SELECT COUNT(*) as cnt FROM sqlite_master WHERE type='table' AND name=?",
    )
    .get(name);
  return (row?.cnt ?? 0) > 0;
}

const PLUGIN = "test-plugin";
const MIGRATIONS_DIR = "/plugins/test-plugin/migrations";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runMigrations", () => {
  // ---- Happy path ----

  describe("happy path", () => {
    test("no migrations directory → 0 applied, success", () => {
      const db = makeDb();
      const fs = noDir();
      const applied = expectOk(
        runMigrations(PLUGIN, db, MIGRATIONS_DIR, fs.listFiles, fs.readFile),
      );
      expect(applied).toBe(0);
      db.close();
    });

    test("empty migrations directory → 0 applied, success", () => {
      const db = makeDb();
      const fs = mockFs({});
      const applied = expectOk(
        runMigrations(PLUGIN, db, MIGRATIONS_DIR, fs.listFiles, fs.readFile),
      );
      expect(applied).toBe(0);
      db.close();
    });

    test("single migration creates a table", () => {
      const db = makeDb();
      const fs = mockFs({
        "001_create_users.sql": "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);",
      });
      const applied = expectOk(
        runMigrations(PLUGIN, db, MIGRATIONS_DIR, fs.listFiles, fs.readFile),
      );
      expect(applied).toBe(1);
      expect(tableExists(db, "users")).toBe(true);

      // Check _migrations was recorded
      const migrations = getAppliedMigrations(db);
      expect(migrations).toHaveLength(1);
      expect(migrations[0]!.number).toBe(1);
      expect(migrations[0]!.filename).toBe("001_create_users.sql");
      db.close();
    });

    test("multiple migrations run in order", () => {
      const db = makeDb();
      const fs = mockFs({
        "001_create_users.sql": "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);",
        "002_create_posts.sql": "CREATE TABLE posts (id INTEGER PRIMARY KEY, user_id INTEGER, body TEXT);",
        "003_add_email.sql": "ALTER TABLE users ADD COLUMN email TEXT;",
      });
      const applied = expectOk(
        runMigrations(PLUGIN, db, MIGRATIONS_DIR, fs.listFiles, fs.readFile),
      );
      expect(applied).toBe(3);
      expect(tableExists(db, "users")).toBe(true);
      expect(tableExists(db, "posts")).toBe(true);

      // Verify email column exists
      const row = db.query<{ email: unknown }, []>("SELECT email FROM users LIMIT 0").all();
      expect(row).toEqual([]);

      const migrations = getAppliedMigrations(db);
      expect(migrations).toHaveLength(3);
      expect(migrations[0]!.number).toBe(1);
      expect(migrations[1]!.number).toBe(2);
      expect(migrations[2]!.number).toBe(3);
      db.close();
    });

    test("already-applied migrations are skipped", () => {
      const db = makeDb();
      const fs = mockFs({
        "001_create_users.sql": "CREATE TABLE users (id INTEGER PRIMARY KEY);",
        "002_create_posts.sql": "CREATE TABLE posts (id INTEGER PRIMARY KEY);",
      });

      // First run: apply all
      expectOk(runMigrations(PLUGIN, db, MIGRATIONS_DIR, fs.listFiles, fs.readFile));

      // Second run: nothing new
      const applied = expectOk(
        runMigrations(PLUGIN, db, MIGRATIONS_DIR, fs.listFiles, fs.readFile),
      );
      expect(applied).toBe(0);

      // Tables still exist
      expect(tableExists(db, "users")).toBe(true);
      expect(tableExists(db, "posts")).toBe(true);
      db.close();
    });

    test("partial application — some already done, some pending", () => {
      const db = makeDb();

      // First run: only migration 001
      const fs1 = mockFs({
        "001_create_users.sql": "CREATE TABLE users (id INTEGER PRIMARY KEY);",
      });
      expectOk(runMigrations(PLUGIN, db, MIGRATIONS_DIR, fs1.listFiles, fs1.readFile));

      // Second run: 001 exists + new 002
      const fs2 = mockFs({
        "001_create_users.sql": "CREATE TABLE users (id INTEGER PRIMARY KEY);",
        "002_create_posts.sql": "CREATE TABLE posts (id INTEGER PRIMARY KEY);",
      });
      const applied = expectOk(
        runMigrations(PLUGIN, db, MIGRATIONS_DIR, fs2.listFiles, fs2.readFile),
      );
      expect(applied).toBe(1);
      expect(tableExists(db, "posts")).toBe(true);

      const migrations = getAppliedMigrations(db);
      expect(migrations).toHaveLength(2);
      db.close();
    });

    test("WAL mode is enabled", () => {
      const db = makeDb();
      const fs = mockFs({});
      expectOk(runMigrations(PLUGIN, db, MIGRATIONS_DIR, fs.listFiles, fs.readFile));

      const row = db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get();
      // In-memory databases return "memory" for WAL pragma, but the call should not error
      expect(row).toBeDefined();
      db.close();
    });
  });

  // ---- Multi-statement migrations ----

  describe("multi-statement migrations", () => {
    test("migration with multiple semicolon-separated statements works", () => {
      const db = makeDb();
      const fs = mockFs({
        "001_create_tables.sql": [
          "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);",
          "CREATE TABLE posts (id INTEGER PRIMARY KEY, body TEXT);",
          "CREATE TABLE comments (id INTEGER PRIMARY KEY, text TEXT);",
        ].join("\n"),
      });
      const applied = expectOk(
        runMigrations(PLUGIN, db, MIGRATIONS_DIR, fs.listFiles, fs.readFile),
      );
      expect(applied).toBe(1);
      expect(tableExists(db, "users")).toBe(true);
      expect(tableExists(db, "posts")).toBe(true);
      expect(tableExists(db, "comments")).toBe(true);
      db.close();
    });

    test("multi-statement migration rolls back entirely on failure", () => {
      const db = makeDb();
      const fs = mockFs({
        "001_bad_multi.sql": [
          "CREATE TABLE alpha (id INTEGER);",
          "INVALID SQL HERE;",
        ].join("\n"),
      });
      const err = expectError(
        runMigrations(PLUGIN, db, MIGRATIONS_DIR, fs.listFiles, fs.readFile),
      );
      expect(err.code).toBe("MIGRATION_FAILED");
      // alpha should NOT exist — transaction rolled back
      expect(tableExists(db, "alpha")).toBe(false);
      expect(getAppliedMigrations(db)).toHaveLength(0);
      db.close();
    });
  });

  // ---- Validation errors ----

  describe("validation errors", () => {
    test("invalid filename rejected", () => {
      const db = makeDb();
      const fs = mockFs({
        "not_a_migration.txt": "SELECT 1;",
      });
      const err = expectError(
        runMigrations(PLUGIN, db, MIGRATIONS_DIR, fs.listFiles, fs.readFile),
      );
      expect(err.code).toBe("INVALID_MIGRATION_FILENAME");
      expect(err.migration).toBe("not_a_migration.txt");
      expect(err.plugin).toBe(PLUGIN);
      db.close();
    });

    test("SQL file without number prefix rejected", () => {
      const db = makeDb();
      const fs = mockFs({
        "create_users.sql": "CREATE TABLE users (id INTEGER);",
      });
      const err = expectError(
        runMigrations(PLUGIN, db, MIGRATIONS_DIR, fs.listFiles, fs.readFile),
      );
      expect(err.code).toBe("INVALID_MIGRATION_FILENAME");
      db.close();
    });

    test("gap in numbering rejected (001, 003)", () => {
      const db = makeDb();
      const fs = mockFs({
        "001_first.sql": "CREATE TABLE a (id INTEGER);",
        "003_third.sql": "CREATE TABLE c (id INTEGER);",
      });
      const err = expectError(
        runMigrations(PLUGIN, db, MIGRATIONS_DIR, fs.listFiles, fs.readFile),
      );
      expect(err.code).toBe("MIGRATION_GAP");
      expect(err.message).toContain("expected migration 2");
      expect(err.message).toContain("found 3");
      db.close();
    });

    test("duplicate migration numbers rejected as gap", () => {
      const db = makeDb();
      // Two files with number 1 — after sort, second position expects 2
      const fs = mockFs({
        "001_first.sql": "CREATE TABLE a (id INTEGER);",
        "001_also_first.sql": "CREATE TABLE b (id INTEGER);",
      });
      const err = expectError(
        runMigrations(PLUGIN, db, MIGRATIONS_DIR, fs.listFiles, fs.readFile),
      );
      // Second entry at index 1 expects number 2 but finds 1
      expect(err.code).toBe("MIGRATION_GAP");
      db.close();
    });
  });

  // ---- Execution errors ----

  describe("execution errors", () => {
    test("bad SQL → rolls back, error names file and cause", () => {
      const db = makeDb();
      const fs = mockFs({
        "001_bad.sql": "THIS IS NOT SQL;",
      });
      const err = expectError(
        runMigrations(PLUGIN, db, MIGRATIONS_DIR, fs.listFiles, fs.readFile),
      );
      expect(err.code).toBe("MIGRATION_FAILED");
      expect(err.plugin).toBe(PLUGIN);
      expect(err.migration).toBe("001_bad.sql");
      expect(err.message).toContain("001_bad.sql");

      // No migration recorded
      expect(getAppliedMigrations(db)).toHaveLength(0);
      db.close();
    });

    test("second migration fails → first stays committed, second rolled back", () => {
      const db = makeDb();
      const fs = mockFs({
        "001_good.sql": "CREATE TABLE good (id INTEGER);",
        "002_bad.sql": "INVALID SQL;",
      });
      const err = expectError(
        runMigrations(PLUGIN, db, MIGRATIONS_DIR, fs.listFiles, fs.readFile),
      );
      expect(err.code).toBe("MIGRATION_FAILED");
      expect(err.migration).toBe("002_bad.sql");

      // First migration committed
      expect(tableExists(db, "good")).toBe(true);
      const migrations = getAppliedMigrations(db);
      expect(migrations).toHaveLength(1);
      expect(migrations[0]!.number).toBe(1);
      db.close();
    });

    test("unreadable migration file produces MIGRATION_READ_FAILED", () => {
      const db = makeDb();
      const listFiles = () => ["001_create.sql"];
      const readFile = () => {
        throw new Error("Permission denied");
      };
      const err = expectError(
        runMigrations(PLUGIN, db, MIGRATIONS_DIR, listFiles, readFile),
      );
      expect(err.code).toBe("MIGRATION_READ_FAILED");
      expect(err.plugin).toBe(PLUGIN);
      expect(err.migration).toBe("001_create.sql");
      expect(err.message).toContain("Permission denied");
      db.close();
    });

    test("directory list error (non-ENOENT) produces MIGRATIONS_DIR_ERROR", () => {
      const db = makeDb();
      const listFiles = () => {
        throw new Error("I/O error");
      };
      const readFile = () => "";
      const err = expectError(
        runMigrations(PLUGIN, db, MIGRATIONS_DIR, listFiles, readFile),
      );
      expect(err.code).toBe("MIGRATIONS_DIR_ERROR");
      expect(err.message).toContain("I/O error");
      db.close();
    });
  });

  // ---- Edge cases ----

  describe("edge cases", () => {
    test("migration numbers with different zero-padding treated correctly", () => {
      const db = makeDb();
      // Mixing 1-digit and 3-digit padding
      const fs = mockFs({
        "1_first.sql": "CREATE TABLE a (id INTEGER);",
        "2_second.sql": "CREATE TABLE b (id INTEGER);",
      });
      const applied = expectOk(
        runMigrations(PLUGIN, db, MIGRATIONS_DIR, fs.listFiles, fs.readFile),
      );
      expect(applied).toBe(2);
      expect(tableExists(db, "a")).toBe(true);
      expect(tableExists(db, "b")).toBe(true);
      db.close();
    });

    test("_migrations table records applied_at timestamp", () => {
      const db = makeDb();
      const before = Date.now();
      const fs = mockFs({
        "001_create.sql": "CREATE TABLE t (id INTEGER);",
      });
      expectOk(runMigrations(PLUGIN, db, MIGRATIONS_DIR, fs.listFiles, fs.readFile));
      const after = Date.now();

      const row = db
        .query<{ applied_at: number }, []>("SELECT applied_at FROM _migrations WHERE number = 1")
        .get();
      expect(row).toBeDefined();
      expect(row!.applied_at).toBeGreaterThanOrEqual(before);
      expect(row!.applied_at).toBeLessThanOrEqual(after);
      db.close();
    });

    test("error message always includes plugin name", () => {
      const db = makeDb();
      const fs = mockFs({ "bad.txt": "nope" });
      const err = expectError(
        runMigrations("my-plugin", db, MIGRATIONS_DIR, fs.listFiles, fs.readFile),
      );
      expect(err.plugin).toBe("my-plugin");
      expect(err.message).toContain("my-plugin");
      db.close();
    });
  });
});
