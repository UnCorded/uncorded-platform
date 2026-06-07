// Migration 004 — add voice external-reachability columns to servers.
//
// One-shot, idempotent. Safe to re-run; each ALTER uses IF NOT EXISTS.
// Run with:
//
//   bun run apps/central/migrations/004-voice-reachability.ts
//
// or via the package script `bun run migrate:004` from apps/central/.
//
// Preconditions: servers table already exists.
//
// What this does:
//   1. ADD COLUMN servers.last_heartbeat_ip TEXT.
//      Captured from cf-connecting-ip in routes/heartbeat.ts; used as the
//      probe target so clients cannot direct Central to probe arbitrary IPs.
//   2. ADD COLUMN servers.voice_reachability JSONB.
//      Last VoiceProbeResult snapshot. NULL until first probe completes.
//   3. ADD COLUMN servers.voice_reachability_checked_at TIMESTAMPTZ.
//      Drives the 60s per-server probe cooldown.

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
  process.stdout.write(`[migrate-004] ${line}\n`);
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
  if (await columnExists("servers", "last_heartbeat_ip")) {
    log("stage 1 add servers.last_heartbeat_ip", "skipped", "column already exists");
  } else {
    await sql`ALTER TABLE servers ADD COLUMN last_heartbeat_ip TEXT`;
    log("stage 1 add servers.last_heartbeat_ip", "applied");
  }

  if (await columnExists("servers", "voice_reachability")) {
    log("stage 2 add servers.voice_reachability", "skipped", "column already exists");
  } else {
    await sql`ALTER TABLE servers ADD COLUMN voice_reachability JSONB`;
    log("stage 2 add servers.voice_reachability", "applied");
  }

  if (await columnExists("servers", "voice_reachability_checked_at")) {
    log("stage 3 add servers.voice_reachability_checked_at", "skipped", "column already exists");
  } else {
    await sql`ALTER TABLE servers ADD COLUMN voice_reachability_checked_at TIMESTAMPTZ`;
    log("stage 3 add servers.voice_reachability_checked_at", "applied");
  }

  log("done", "info", "migration 004 complete");
}

try {
  await main();
} catch (err: unknown) {
  process.stderr.write(`[migrate-004] FAILED: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
} finally {
  await sql.end();
}
