// Boot-time assertion that every required table exists in core.db.
//
// Why fail-fast: SQLite happily proceeds when an INSERT targets a missing
// table — the migration just no-ops upstream and the failure surfaces as
// silently-dropped audit rows or permission writes hours later. We refuse
// to accept connections instead.
//
// Per spec-22-core-module.md Amendment B, "Fail-fast migration assertion".

import type { Database } from "bun:sqlite";

export interface MissingTablesError {
  code: "DB_MISSING_TABLES";
  message: string;
  missing: string[];
}

/**
 * Verify every name in `expected` exists as a table in the database.
 * Throws a typed error listing the missing tables on failure. Returns
 * the set of present tables on success (useful for tests).
 *
 * Excludes SQLite internal tables (`sqlite_*`) and migration-tracking
 * tables (`_*_migrations`).
 */
export function assertExpectedTables(
  db: Database,
  expected: readonly string[],
): Set<string> {
  const rows = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )
    .all();
  const present = new Set(rows.map((r) => r.name));

  const missing = expected.filter((name) => !present.has(name));
  if (missing.length > 0) {
    const err: MissingTablesError = {
      code: "DB_MISSING_TABLES",
      message: `core.db is missing ${missing.length} expected table(s): ${missing.join(", ")}. Refusing to start — a half-migrated server cannot silently lose audit or permission rows.`,
      missing,
    };
    throw err;
  }

  return present;
}
