// Migration runner — step 3 of the 7-step plugin loading sequence.
// Opens/creates a plugin's SQLite database, discovers numbered SQL migration
// files, and executes pending ones in order inside transactions.

import { Database } from "bun:sqlite";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MigrationError {
  code: string;
  plugin: string;
  migration?: string;
  message: string;
}

export type MigrationResult =
  | { ok: true; applied: number }
  | { ok: false; error: MigrationError };

/** List filenames in a directory. Throw with `{ code: "ENOENT" }` if missing. */
export type FileListFn = (dir: string) => string[];

/** Read a file's UTF-8 content. */
export type FileReadFn = (path: string) => string;

interface ParsedMigration {
  number: number;
  filename: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIGRATION_RE = /^(\d+)_.+\.sql$/;

function createMigrationsTableSql(tableName: string): string {
  return `
    CREATE TABLE IF NOT EXISTS ${tableName} (
      number INTEGER PRIMARY KEY,
      filename TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    )
  `;
}

// ---------------------------------------------------------------------------
// Migration runner
// ---------------------------------------------------------------------------

/** Options for runMigrations. */
export interface MigrationOptions {
  /**
   * Name of the migrations tracking table.
   * Defaults to "_migrations". Use a distinct name when multiple modules
   * share the same database to avoid migration number collisions.
   */
  migrationsTable?: string | undefined;
}

/**
 * Run pending database migrations for a plugin.
 *
 * @param plugin       - Plugin slug (for error messages)
 * @param db           - Open SQLite Database instance
 * @param migrationsDir - Path to the plugin's migrations/ folder
 * @param listFiles    - Lists filenames in a directory
 * @param readFile     - Reads a file as UTF-8 string
 * @param options      - Optional configuration
 */
export function runMigrations(
  plugin: string,
  db: Database,
  migrationsDir: string,
  listFiles: FileListFn,
  readFile: FileReadFn,
  options?: MigrationOptions,
): MigrationResult {
  const migrationsTable = options?.migrationsTable ?? "_migrations";

  // Enable WAL mode
  try {
    db.run("PRAGMA journal_mode = WAL");
  } catch (err: unknown) {
    return {
      ok: false,
      error: {
        code: "DATABASE_ERROR",
        plugin,
        message: `${plugin}: failed to enable WAL mode — ${errorMessage(err)}.`,
      },
    };
  }

  // Create migrations tracking table
  try {
    db.run(createMigrationsTableSql(migrationsTable));
  } catch (err: unknown) {
    return {
      ok: false,
      error: {
        code: "DATABASE_ERROR",
        plugin,
        message: `${plugin}: failed to create ${migrationsTable} table — ${errorMessage(err)}.`,
      },
    };
  }

  // Get highest applied migration number
  const row = db
    .query<{ max_num: number | null }, []>(
      `SELECT MAX(number) as max_num FROM ${migrationsTable}`,
    )
    .get();
  const highestApplied = row?.max_num ?? 0;

  // List migration files
  let filenames: string[];
  try {
    filenames = listFiles(migrationsDir);
  } catch (err: unknown) {
    const errObj = err as Record<string, unknown> | null;
    if (errObj && errObj["code"] === "ENOENT") {
      // No migrations directory = no migrations to run
      return { ok: true, applied: 0 };
    }
    return {
      ok: false,
      error: {
        code: "MIGRATIONS_DIR_ERROR",
        plugin,
        message: `${plugin}: failed to list migrations directory — ${errorMessage(err)}.`,
      },
    };
  }

  // Parse and validate migration filenames
  const parsed: ParsedMigration[] = [];
  for (const filename of filenames) {
    const match = MIGRATION_RE.exec(filename);
    if (!match) {
      return {
        ok: false,
        error: {
          code: "INVALID_MIGRATION_FILENAME",
          plugin,
          migration: filename,
          message: `${plugin}: invalid migration filename "${filename}". Expected format: NNN_description.sql.`,
        },
      };
    }
    parsed.push({ number: Number(match[1]), filename });
  }

  // Sort by number
  parsed.sort((a, b) => a.number - b.number);

  // Validate sequential numbering starting from 1
  for (let i = 0; i < parsed.length; i++) {
    const expected = i + 1;
    const actual = parsed[i]!.number;
    if (actual !== expected) {
      return {
        ok: false,
        error: {
          code: "MIGRATION_GAP",
          plugin,
          migration: parsed[i]!.filename,
          message: `${plugin}: expected migration ${expected} but found ${actual} ("${parsed[i]!.filename}"). Migration numbers must be sequential with no gaps.`,
        },
      };
    }
  }

  // Filter to pending migrations
  const pending = parsed.filter((m) => m.number > highestApplied);

  if (pending.length === 0) {
    return { ok: true, applied: 0 };
  }

  // Apply each pending migration in a transaction
  const applyMigration = db.transaction(
    (sql: string, num: number, filename: string) => {
      db.run(sql);
      db.run(
        `INSERT INTO ${migrationsTable} (number, filename, applied_at) VALUES (?, ?, ?)`,
        [num, filename, Date.now()],
      );
    },
  );

  for (const migration of pending) {
    let sql: string;
    try {
      sql = readFile(`${migrationsDir}/${migration.filename}`);
    } catch (err: unknown) {
      return {
        ok: false,
        error: {
          code: "MIGRATION_READ_FAILED",
          plugin,
          migration: migration.filename,
          message: `${plugin}: failed to read migration file "${migration.filename}" — ${errorMessage(err)}.`,
        },
      };
    }

    try {
      applyMigration(sql, migration.number, migration.filename);
    } catch (err: unknown) {
      return {
        ok: false,
        error: {
          code: "MIGRATION_FAILED",
          plugin,
          migration: migration.filename,
          message: `${plugin}: migration "${migration.filename}" failed — ${errorMessage(err)}.`,
        },
      };
    }
  }

  return { ok: true, applied: pending.length };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err && typeof err.message === "string") {
    return err.message;
  }
  return "Unknown error";
}
