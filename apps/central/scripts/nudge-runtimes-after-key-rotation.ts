// One-shot recovery for runtimes stuck on dead JWKS after a SIGNING_KEY_SECRET
// rotation that pre-dates the bumpSyncForKeyChange fix in crypto.ts.
//
// Symptom: clients hit a runtime that returns 401 + AUTH_FAILED with
//          "No public key found for kid: <new-kid>" — even after they re-auth.
//          Central minted the token under the new kid; the runtime's heartbeat
//          cache still holds only old (now-expired) keys; Central's heartbeat
//          response is dirty=false because sync_version is unchanged, so the
//          runtime never refetches the JWKS.
//
// Fix: bump every server's sync_version by 1 and write a placeholder delta
//      at the new version. Next heartbeat from each runtime will see the
//      gap, return dirty=true with the current public_keys, and the kid
//      mismatch resolves itself within ~30 seconds.
//
// Run with:
//   cd apps/central && bun run scripts/dev-secrets.ts bun run scripts/nudge-runtimes-after-key-rotation.ts
//
// Idempotent — running twice just bumps sync_version twice. The runtime's
// cache treats both bumps as the same "fetch fresh keys" signal.

import { createDb } from "../src/db";

const sql = createDb({
  host: process.env["DB_HOST"] ?? "localhost",
  port: Number(process.env["DB_PORT"] ?? 5432),
  database: process.env["DB_NAME"] ?? "uncorded_central",
  username: process.env["DB_USER"] ?? "postgres",
  password: process.env["DB_PASSWORD"] ?? "postgres",
});

async function main(): Promise<void> {
  const before = await sql`SELECT server_id, sync_version FROM server_sync ORDER BY server_id`;
  process.stdout.write(`[nudge] ${String(before.length)} server_sync row(s) before bump\n`);
  for (const row of before) {
    process.stdout.write(`[nudge]   ${row.server_id as string} @ v${String(row.sync_version)}\n`);
  }

  if (before.length === 0) {
    process.stdout.write(`[nudge] no servers — nothing to do\n`);
    await sql.end();
    return;
  }

  await sql.begin(async (tx) => {
    await tx`UPDATE server_sync SET sync_version = sync_version + 1`;
    await tx`
      INSERT INTO server_deltas (server_id, sync_version, delta_type, payload)
      SELECT server_id, sync_version, 'public_keys_changed', '{}'::jsonb
      FROM server_sync
    `;
  });

  const after = await sql`SELECT server_id, sync_version FROM server_sync ORDER BY server_id`;
  process.stdout.write(`[nudge] bumped ${String(after.length)} server_sync row(s)\n`);
  for (const row of after) {
    process.stdout.write(`[nudge]   ${row.server_id as string} @ v${String(row.sync_version)}\n`);
  }
  process.stdout.write(`[nudge] runtimes will refetch JWKS on their next heartbeat (~30s)\n`);

  await sql.end();
}

main().catch((err: unknown) => {
  process.stderr.write(`\n[nudge] ERROR: ${err instanceof Error ? err.message : String(err)}\n\n`);
  process.exit(1);
});
