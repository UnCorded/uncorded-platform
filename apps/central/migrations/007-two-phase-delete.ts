// Migration 007 — two-phase server delete.
//
// One-shot, idempotent. Safe to re-run; the columnExists guard skips the
// ALTER if the column is already present. Run with:
//
//   bun run apps/central/migrations/007-two-phase-delete.ts
//
// or via the package script `bun run migrate:007` from apps/central/.
//
// Preconditions: servers table already exists.
//
// What this does:
//   ADD COLUMN servers.deleted_at TIMESTAMPTZ (NULL = live) plus a partial
//   index over deleting rows. DELETE /v1/servers/:id now marks instead of
//   removing; the row is hard-deleted when the desktop confirms the local
//   data purge (POST /:id/purge-confirm) or the abandoned-delete reaper
//   times the handshake out. The owner's quota slot frees only at the hard
//   delete, so delete-recreate can't mint unlimited servers.

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
  process.stdout.write(`[migrate-007] ${line}\n`);
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

async function main(): Promise<void> {
  if (await columnExists("servers", "deleted_at")) {
    log("stage 1 add servers.deleted_at", "skipped", "column already exists");
  } else {
    await sql`ALTER TABLE servers ADD COLUMN deleted_at TIMESTAMPTZ`;
    await sql`
      CREATE INDEX idx_servers_deleting ON servers(deleted_at)
      WHERE deleted_at IS NOT NULL
    `;
    log("stage 1 add servers.deleted_at", "applied");
  }

  log("done", "info", "migration 007 complete");
}

try {
  await main();
} catch (err: unknown) {
  process.stderr.write(`[migrate-007] FAILED: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
} finally {
  await sql.end();
}
