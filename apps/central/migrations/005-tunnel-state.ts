// Migration 005 — add servers.tunnel_state to Central.
//
// One-shot, idempotent. Safe to re-run; the columnExists guard skips the ALTER
// if the column is already present. Run with:
//
//   bun run apps/central/migrations/005-tunnel-state.ts
//
// or via the package script `bun run migrate:005` from apps/central/.
//
// Preconditions: servers table already exists.
//
// What this does:
//   ADD COLUMN servers.tunnel_state TEXT.
//   The runtime heartbeat already carries tunnel_state (runtime side), but
//   Central was silently dropping it. This column persists it so the directory
//   can exclude 'expired' tunnels and clients can surface a temp-URL banner /
//   expired-restart gate. Values: 'demo' | 'named' | 'local' | 'expired'.
//   NULL until the first heartbeat that reports it.

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
  process.stdout.write(`[migrate-005] ${line}\n`);
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
  if (await columnExists("servers", "tunnel_state")) {
    log("stage 1 add servers.tunnel_state", "skipped", "column already exists");
  } else {
    await sql`ALTER TABLE servers ADD COLUMN tunnel_state TEXT`;
    log("stage 1 add servers.tunnel_state", "applied");
  }

  log("done", "info", "migration 005 complete");
}

try {
  await main();
} catch (err: unknown) {
  process.stderr.write(`[migrate-005] FAILED: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
} finally {
  await sql.end();
}
