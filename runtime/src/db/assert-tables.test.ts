import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { assertExpectedTables, type MissingTablesError } from "./assert-tables";

function makeDb(tables: string[]): Database {
  const db = new Database(":memory:");
  for (const name of tables) {
    db.run(`CREATE TABLE ${name} (id INTEGER PRIMARY KEY)`);
  }
  return db;
}

describe("assertExpectedTables", () => {
  test("passes when every expected table exists", () => {
    const db = makeDb(["users", "members", "roles"]);
    const present = assertExpectedTables(db, ["users", "members", "roles"]);
    expect(present.has("users")).toBe(true);
    expect(present.has("members")).toBe(true);
    expect(present.has("roles")).toBe(true);
    db.close();
  });

  test("throws DB_MISSING_TABLES naming each missing table", () => {
    const db = makeDb(["users"]);
    try {
      assertExpectedTables(db, ["users", "members", "permission_audit"]);
      throw new Error("expected assertion to throw");
    } catch (err) {
      const e = err as MissingTablesError;
      expect(e.code).toBe("DB_MISSING_TABLES");
      expect(e.missing).toEqual(["members", "permission_audit"]);
      expect(e.message).toContain("members");
      expect(e.message).toContain("permission_audit");
    }
    db.close();
  });

  test("ignores SQLite internal tables when computing presence", () => {
    // sqlite_sequence appears automatically when AUTOINCREMENT is used.
    const db = new Database(":memory:");
    db.run("CREATE TABLE roles (id INTEGER PRIMARY KEY AUTOINCREMENT)");
    // Trigger sqlite_sequence creation by inserting + reading.
    db.run("INSERT INTO roles (id) VALUES (1)");
    const present = assertExpectedTables(db, ["roles"]);
    expect(present.has("roles")).toBe(true);
    expect(present.has("sqlite_sequence")).toBe(false);
    db.close();
  });

  test("ignores tables not in the expected list (forward compatibility)", () => {
    // A future migration may add a table we don't yet know about; that
    // must not cause the assertion to fail.
    const db = makeDb(["users", "members", "future_table"]);
    expect(() =>
      assertExpectedTables(db, ["users", "members"]),
    ).not.toThrow();
    db.close();
  });

  test("reports a clear error message", () => {
    const db = makeDb([]);
    try {
      assertExpectedTables(db, ["roles", "permission_audit"]);
      throw new Error("expected throw");
    } catch (err) {
      const e = err as MissingTablesError;
      expect(e.message).toContain("missing 2 expected table(s)");
      expect(e.message).toContain("Refusing to start");
    }
    db.close();
  });
});
