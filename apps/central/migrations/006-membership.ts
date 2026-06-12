// Migration 006 — server membership tables.
//
// One-shot, idempotent. Safe to re-run; the tableExists guards skip CREATEs
// for tables already present, and the owner backfill is ON CONFLICT DO
// NOTHING. Run with:
//
//   bun run apps/central/migrations/006-membership.ts
//
// or via the package script `bun run migrate:006` from apps/central/.
//
// Preconditions: servers and accounts tables already exist.
//
// What this does:
//   1. CREATE TABLE server_members — who belongs to which server.
//      servers.owner_id stays the single source of owner truth; this table
//      mirrors it with a role='owner' row so "all servers I belong to" is one
//      indexed query. status='banned' rows persist so bans survive leaving.
//   2. CREATE TABLE server_invitations — account-bound invites (no open
//      links in Phase 1). Partial unique index = one pending per
//      (server, invitee).
//   3. CREATE TABLE server_join_requests — user→owner requests for public
//      servers. One pending per (server, account).
//   4. Backfill: an active role='owner' member row for every existing server.

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
  process.stdout.write(`[migrate-006] ${line}\n`);
}

async function tableExists(table: string): Promise<boolean> {
  const rows = await sql`
    SELECT 1
    FROM information_schema.tables
    WHERE table_name = ${table} AND table_schema = 'public'
    LIMIT 1
  `;
  return rows.length > 0;
}

async function main(): Promise<void> {
  if (await tableExists("server_members")) {
    log("stage 1 create server_members", "skipped", "table already exists");
  } else {
    await sql`
      CREATE TABLE server_members (
        server_id UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
        account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'banned')),
        joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (server_id, account_id)
      )
    `;
    await sql`CREATE INDEX idx_server_members_account_id ON server_members(account_id)`;
    log("stage 1 create server_members", "applied");
  }

  if (await tableExists("server_invitations")) {
    log("stage 2 create server_invitations", "skipped", "table already exists");
  } else {
    await sql`
      CREATE TABLE server_invitations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        server_id UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
        invited_account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        invited_by UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'accepted', 'declined', 'revoked', 'expired')),
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;
    await sql`
      CREATE UNIQUE INDEX idx_server_invitations_one_pending
        ON server_invitations(server_id, invited_account_id) WHERE status = 'pending'
    `;
    await sql`
      CREATE INDEX idx_server_invitations_invitee_pending
        ON server_invitations(invited_account_id) WHERE status = 'pending'
    `;
    await sql`
      CREATE INDEX idx_server_invitations_server_pending
        ON server_invitations(server_id) WHERE status = 'pending'
    `;
    log("stage 2 create server_invitations", "applied");
  }

  if (await tableExists("server_join_requests")) {
    log("stage 3 create server_join_requests", "skipped", "table already exists");
  } else {
    await sql`
      CREATE TABLE server_join_requests (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        server_id UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
        account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'accepted', 'declined')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        resolved_at TIMESTAMPTZ
      )
    `;
    await sql`
      CREATE UNIQUE INDEX idx_server_join_requests_one_pending
        ON server_join_requests(server_id, account_id) WHERE status = 'pending'
    `;
    await sql`
      CREATE INDEX idx_server_join_requests_server_pending
        ON server_join_requests(server_id) WHERE status = 'pending'
    `;
    log("stage 3 create server_join_requests", "applied");
  }

  const backfilled = await sql`
    INSERT INTO server_members (server_id, account_id, role, status, joined_at)
    SELECT id, owner_id, 'owner', 'active', created_at FROM servers
    ON CONFLICT (server_id, account_id) DO NOTHING
  `;
  log("stage 4 backfill owner member rows", "applied", `${backfilled.count} rows inserted`);

  log("done", "info", "migration 006 complete");
}

try {
  await main();
} catch (err: unknown) {
  process.stderr.write(`[migrate-006] FAILED: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
} finally {
  await sql.end();
}
