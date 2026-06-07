/**
 * Regression tests for rotateSigningKey.
 *
 * The shipped rotation logic retired every active row including the row just
 * promoted from pending in the same transaction, leaving zero active keys
 * after every rotation cycle. Token minting (`getActiveSigningKey`) returned
 * null and the desktop client surfaced "No signing key available" until the
 * Central process was restarted, at which point ensureSigningKey seeded a
 * fresh active and the bug recurred 24h later.
 *
 * These tests pin down the contract: after every rotation, exactly one row
 * is `active`, and it is either the prior active (first-rotation guard) or
 * a freshly-promoted row whose id is NOT also retired in the same call.
 *
 * Requires Postgres on :5432 (postgres/postgres) — gated on DATABASE_URL the
 * same way integration.test.ts is, so a plain `bun test` skips cleanly.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { setupTestDb } from "./test-helpers";
import { ensureSigningKey, rotateSigningKey } from "./crypto";
import type { Sql } from "./db";

const hasDatabase = !!process.env["DATABASE_URL"];

interface KeyRow {
  id: string;
  state: "pending" | "active" | "retiring" | "expired";
  created_at: Date;
  expires_at: Date | null;
}

async function listKeys(sql: Sql): Promise<KeyRow[]> {
  const rows = await sql`
    SELECT id, state, created_at, expires_at
    FROM signing_keys
    ORDER BY created_at ASC
  `;
  return rows.map((r) => ({
    id: r.id as string,
    state: r.state as KeyRow["state"],
    created_at: r.created_at as Date,
    expires_at: (r.expires_at ?? null) as Date | null,
  }));
}

/** Backdate every pending row by 61 seconds so the next rotateSigningKey
 *  treats them as matured (the production gate is `created_at < now() - 60s`).
 *  Without this the test would have to sleep, which we never want in CI. */
async function maturePending(sql: Sql): Promise<void> {
  await sql`UPDATE signing_keys SET created_at = created_at - interval '61 seconds' WHERE state = 'pending'`;
}

describe.skipIf(!hasDatabase)("rotateSigningKey", () => {
  let sql: Sql;

  beforeAll(async () => {
    process.env["SIGNING_KEY_SECRET"] = "test-signing-key-secret-32chars!";
    sql = await setupTestDb("uncorded_central_rotation_test");
  });

  afterAll(async () => {
    await sql.end();
  });

  test("first rotation after boot keeps active key alive (no zero-active gap)", async () => {
    // Reset the signing_keys table so this test starts from a clean
    // boot-equivalent state regardless of suite ordering.
    await sql`DELETE FROM signing_keys`;
    await ensureSigningKey(sql);

    const beforeRotation = await listKeys(sql);
    expect(beforeRotation).toHaveLength(1);
    expect(beforeRotation[0]!.state).toBe("active");
    const k1Id = beforeRotation[0]!.id;

    // First rotation 24h after boot: no pending exists yet (ensureSigningKey
    // only inserts the active K1). The original bug retired K1 anyway,
    // leaving zero active keys until the next rotation cycle.
    await rotateSigningKey(sql);

    const afterRotation = await listKeys(sql);
    const active = afterRotation.filter((k) => k.state === "active");
    const pending = afterRotation.filter((k) => k.state === "pending");
    const retiring = afterRotation.filter((k) => k.state === "retiring");

    // Contract: at least one active key exists at all times. Anything else
    // means token minting silently breaks for the next 24h.
    expect(active).toHaveLength(1);
    expect(active[0]!.id).toBe(k1Id);
    expect(pending).toHaveLength(1);
    expect(retiring).toHaveLength(0);
  });

  test("second rotation promotes pending and retires prior active without retiring the promoted row", async () => {
    // Continues from previous test's end state: K1 active, K2 pending.
    const beforeRotation = await listKeys(sql);
    const k1 = beforeRotation.find((k) => k.state === "active")!;
    const k2 = beforeRotation.find((k) => k.state === "pending")!;
    expect(k1).toBeTruthy();
    expect(k2).toBeTruthy();

    // Mature K2 so it's eligible for promotion (production waits 24h; the
    // test backdates to avoid wall-clock sleep).
    await maturePending(sql);

    await rotateSigningKey(sql);

    const afterRotation = await listKeys(sql);
    const active = afterRotation.filter((k) => k.state === "active");
    const pending = afterRotation.filter((k) => k.state === "pending");
    const retiring = afterRotation.filter((k) => k.state === "retiring");

    // Pin every transition explicitly. The original bug failed this with
    // active.length === 0 because K2 was promoted then retired in the same
    // call.
    expect(active).toHaveLength(1);
    expect(active[0]!.id).toBe(k2.id);
    expect(retiring).toHaveLength(1);
    expect(retiring[0]!.id).toBe(k1.id);
    expect(retiring[0]!.expires_at).toBeTruthy();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.id).not.toBe(k1.id);
    expect(pending[0]!.id).not.toBe(k2.id);
  });

  test("steady state: ten rotations keep exactly one active key throughout", async () => {
    // Smoke test that the cycle is stable, not just correct on the first
    // two iterations. This is the test that would have caught the bug
    // immediately if it had ever existed.
    await sql`DELETE FROM signing_keys`;
    await ensureSigningKey(sql);

    for (let i = 0; i < 10; i++) {
      await maturePending(sql);
      await rotateSigningKey(sql);

      const keys = await listKeys(sql);
      const active = keys.filter((k) => k.state === "active");
      expect(active).toHaveLength(1);
    }
  });

  test("retiring key past its expires_at gets reaped on the next rotation", async () => {
    // Ensure the cleanup branch (step 1) actually fires. Without this every
    // rotation accumulates retiring rows forever, the JWKS payload bloats,
    // and runtimes pay verification cost on dead keys.
    await sql`DELETE FROM signing_keys`;
    await ensureSigningKey(sql);

    // Two rotations to put the original K1 into retiring with a future
    // expires_at.
    await maturePending(sql);
    await rotateSigningKey(sql); // K1 active, K2 pending → first-rotation guard
    await maturePending(sql);
    await rotateSigningKey(sql); // K1 retiring (expires_at = now + 10min), K2 active, K3 pending

    // Force K1's retiring window into the past so step 1 of the next
    // rotation expires it.
    await sql`UPDATE signing_keys SET expires_at = now() - interval '1 minute' WHERE state = 'retiring'`;

    await maturePending(sql);
    await rotateSigningKey(sql);

    const keys = await listKeys(sql);
    expect(keys.filter((k) => k.state === "expired")).toHaveLength(1);
    expect(keys.filter((k) => k.state === "active")).toHaveLength(1);
  });

  test("rotation bumps server_sync.sync_version exactly once per call", async () => {
    // The runtime side polls JWKS only when sync_version changes. A
    // rotation that didn't bump it would silently strand runtimes on stale
    // public keys until the cache TTL expired (10 min) — well past the new
    // pending key's 60s promotion window in production.
    await sql`DELETE FROM signing_keys`;
    await ensureSigningKey(sql);

    // server_sync.server_id has a FK into servers(id), which itself has a FK
    // into accounts(id). Seed both parents so the row insert is legal — the
    // assertion only cares about the version increment, but the schema still
    // has to be satisfied. Local-only deletions afterwards keep this test
    // hermetic regardless of suite ordering.
    const accountRows = await sql`
      INSERT INTO accounts (email, username, password_hash, display_name)
      VALUES ('crypto-rotation-test@example.com', 'cryptorotationtest', 'x', 'Crypto Rotation Test')
      RETURNING id
    `;
    const accountId = accountRows[0]!.id as string;

    const serverRows = await sql`
      INSERT INTO servers (name, owner_id, server_secret_hash)
      VALUES ('crypto-rotation-test', ${accountId}, 'x')
      RETURNING id
    `;
    const serverId = serverRows[0]!.id as string;

    await sql`INSERT INTO server_sync (server_id, sync_version) VALUES (${serverId}, 0)`;

    const before = await sql`SELECT sync_version FROM server_sync WHERE server_id = ${serverId}`;
    const startVersion = Number(before[0]!.sync_version);

    await maturePending(sql);
    await rotateSigningKey(sql);

    const after = await sql`SELECT sync_version FROM server_sync WHERE server_id = ${serverId}`;
    expect(Number(after[0]!.sync_version)).toBe(startVersion + 1);

    // Clean up so a re-run on the same DB (or a sibling test that also seeds
    // accounts) does not collide on the unique email/username.
    await sql`DELETE FROM servers WHERE id = ${serverId}`;
    await sql`DELETE FROM accounts WHERE id = ${accountId}`;
  });
});
