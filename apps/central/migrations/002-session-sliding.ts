// Migration 002 — split sessions.expires_at into idle_expires_at + absolute_expires_at.
//
// One-shot, idempotent script. Safe to re-run; each step checks current
// schema state before acting. Run with:
//
//   bun run apps/central/migrations/002-session-sliding.ts
//
// or via the package script `bun run migrate:002` from apps/central/.
//
// Preconditions:
//   - DB env vars set (DB_HOST/PORT/NAME/USER/PASSWORD) — same vars index.ts reads.
//   - You've taken a backup. The script is conservative but session schema
//     changes can log every active user out if something goes wrong.
//
// What this does, in one transaction per stage:
//   1. ADD COLUMN idle_expires_at TIMESTAMPTZ (nullable).
//   2. ADD COLUMN absolute_expires_at TIMESTAMPTZ (nullable).
//   3. Backfill any rows where the new columns are NULL:
//        absolute_expires_at = expires_at  (existing sessions keep their cap)
//        idle_expires_at     = LEAST(expires_at, created_at + 7 days)
//      Sessions that are already older than 7 days idle stay capped at
//      expires_at and will simply expire on their original schedule.
//   4. Drop idx_sessions_expires_at; create idx_sessions_idle_expires_at.
//   5. Drop the old expires_at column.
//   6. ALTER both new columns SET NOT NULL.
//
// Each stage logs whether it ran or was skipped (already applied), so the
// script's exit output is the migration's audit trail.

import { createDb } from "../src/db";

const sql = createDb({
  host: process.env["DB_HOST"] ?? "localhost",
  port: Number(process.env["DB_PORT"] ?? 5432),
  database: process.env["DB_NAME"] ?? "uncorded_central",
  username: process.env["DB_USER"] ?? "postgres",
  password: process.env["DB_PASSWORD"] ?? "postgres",
});

function log(stage: string, status: "applied" | "skipped" | "info", detail?: string): void {
  const line = detail ? `${stage}: ${status} (${detail})` : `${stage}: ${status}`;
  process.stdout.write(`[migrate-002] ${line}\n`);
}

async function columnExists(table: string, column: string): Promise<boolean> {
  const rows = await sql`
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = ${table} AND column_name = ${column}
    LIMIT 1
  `;
  return rows.length > 0;
}

async function indexExists(name: string): Promise<boolean> {
  const rows = await sql`
    SELECT 1 FROM pg_indexes WHERE indexname = ${name} LIMIT 1
  `;
  return rows.length > 0;
}

async function columnIsNullable(table: string, column: string): Promise<boolean> {
  const rows = await sql`
    SELECT is_nullable
    FROM information_schema.columns
    WHERE table_name = ${table} AND column_name = ${column}
    LIMIT 1
  `;
  if (rows.length === 0) return false;
  return (rows[0] as { is_nullable: string }).is_nullable === "YES";
}

async function main(): Promise<void> {
  // Stage 1 — ADD COLUMN idle_expires_at
  if (await columnExists("sessions", "idle_expires_at")) {
    log("stage 1 add column idle_expires_at", "skipped", "column already exists");
  } else {
    await sql`ALTER TABLE sessions ADD COLUMN idle_expires_at TIMESTAMPTZ`;
    log("stage 1 add column idle_expires_at", "applied");
  }

  // Stage 2 — ADD COLUMN absolute_expires_at
  if (await columnExists("sessions", "absolute_expires_at")) {
    log("stage 2 add column absolute_expires_at", "skipped", "column already exists");
  } else {
    await sql`ALTER TABLE sessions ADD COLUMN absolute_expires_at TIMESTAMPTZ`;
    log("stage 2 add column absolute_expires_at", "applied");
  }

  // Stage 3 — backfill the new columns from the legacy expires_at column.
  // We only need to backfill if the legacy column still exists; once it's
  // dropped the new columns must already be populated.
  if (!(await columnExists("sessions", "expires_at"))) {
    log("stage 3 backfill", "skipped", "legacy expires_at already dropped");
  } else {
    const nullRows = await sql`
      SELECT count(*)::int AS c
      FROM sessions
      WHERE idle_expires_at IS NULL OR absolute_expires_at IS NULL
    `;
    const toBackfill = (nullRows[0] as { c: number } | undefined)?.c ?? 0;

    if (toBackfill === 0) {
      log("stage 3 backfill", "skipped", "no rows to backfill");
    } else {
      await sql`
        UPDATE sessions
        SET
          absolute_expires_at = COALESCE(absolute_expires_at, expires_at),
          idle_expires_at = COALESCE(
            idle_expires_at,
            LEAST(expires_at, created_at + INTERVAL '7 days')
          )
        WHERE idle_expires_at IS NULL OR absolute_expires_at IS NULL
      `;
      log("stage 3 backfill", "applied", `${String(toBackfill)} rows backfilled`);
    }
  }

  // Stage 4 — swap the index from expires_at to idle_expires_at. Idle is the
  // column we filter on every authenticate(), so it deserves the index.
  if (await indexExists("idx_sessions_idle_expires_at")) {
    log("stage 4a create idx_sessions_idle_expires_at", "skipped", "index already exists");
  } else {
    await sql`CREATE INDEX idx_sessions_idle_expires_at ON sessions(idle_expires_at)`;
    log("stage 4a create idx_sessions_idle_expires_at", "applied");
  }

  if (await indexExists("idx_sessions_expires_at")) {
    await sql`DROP INDEX idx_sessions_expires_at`;
    log("stage 4b drop idx_sessions_expires_at", "applied");
  } else {
    log("stage 4b drop idx_sessions_expires_at", "skipped", "index already gone");
  }

  // Stage 5 — drop the legacy column.
  if (await columnExists("sessions", "expires_at")) {
    await sql`ALTER TABLE sessions DROP COLUMN expires_at`;
    log("stage 5 drop column expires_at", "applied");
  } else {
    log("stage 5 drop column expires_at", "skipped", "column already gone");
  }

  // Stage 6 — set NOT NULL on both new columns. Done last so a partial
  // backfill can't leave the table half-migrated.
  if (await columnIsNullable("sessions", "idle_expires_at")) {
    await sql`ALTER TABLE sessions ALTER COLUMN idle_expires_at SET NOT NULL`;
    log("stage 6a idle_expires_at set not null", "applied");
  } else {
    log("stage 6a idle_expires_at set not null", "skipped", "column already non-nullable");
  }

  if (await columnIsNullable("sessions", "absolute_expires_at")) {
    await sql`ALTER TABLE sessions ALTER COLUMN absolute_expires_at SET NOT NULL`;
    log("stage 6b absolute_expires_at set not null", "applied");
  } else {
    log("stage 6b absolute_expires_at set not null", "skipped", "column already non-nullable");
  }

  log("done", "info", "migration 002 complete");
}

try {
  await main();
} catch (err: unknown) {
  process.stderr.write(`[migrate-002] FAILED: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
} finally {
  await sql.end();
}
