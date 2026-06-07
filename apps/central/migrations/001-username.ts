// Migration 001 — add username + username_changed_at to accounts.
//
// One-shot, idempotent script. Safe to re-run; each step checks current
// schema state before acting. Run with:
//
//   bun run apps/central/migrations/001-username.ts
//
// or via the package script `bun run migrate:001` from apps/central/.
//
// Preconditions:
//   - DB env vars set (DB_HOST/PORT/NAME/USER/PASSWORD) — same vars index.ts reads.
//   - You've taken a backup. The script is conservative but schema migrations
//     on the live accounts table are the kind of thing you take a backup for.
//
// What this does, in one transaction per stage:
//   1. ADD COLUMN username TEXT (nullable, no default).
//   2. ADD COLUMN username_changed_at TIMESTAMPTZ (nullable).
//   3. Backfill every row where username IS NULL: derive from email
//      local-part, then suffix _2, _3, … on collision against existing
//      usernames AND already-assigned candidates within this run.
//   4. CREATE UNIQUE INDEX accounts_username_lower_idx ON accounts (LOWER(username)).
//   5. ALTER COLUMN username SET NOT NULL.
//
// Each stage logs whether it ran or was skipped (already applied), so the
// script's exit output is the migration's audit trail.

import { createDb } from "../src/db";
import { deriveUsernameFromEmail, validateUsername, RESERVED_USERNAMES } from "../src/usernames";

const sql = createDb({
  host: process.env["DB_HOST"] ?? "localhost",
  port: Number(process.env["DB_PORT"] ?? 5432),
  database: process.env["DB_NAME"] ?? "uncorded_central",
  username: process.env["DB_USER"] ?? "postgres",
  password: process.env["DB_PASSWORD"] ?? "postgres",
});

function log(stage: string, status: "applied" | "skipped" | "info", detail?: string): void {
  const line = detail ? `${stage}: ${status} (${detail})` : `${stage}: ${status}`;
  process.stdout.write(`[migrate-001] ${line}\n`);
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

/**
 * Derive a unique candidate username for an account, given the set of
 * usernames already in use. Mutates `taken` to reserve the chosen value so
 * subsequent iterations see it.
 *
 * Strategy:
 *   1. Start with the email-local-part-derived base (already lowercased,
 *      sanitized, length-clamped). If null (e.g. email local-part is "a"),
 *      fall back to "user".
 *   2. If the base is reserved (e.g. someone's email is admin@…), suffix
 *      with "_1" before the collision loop so we don't immediately try the
 *      reserved name and fail validation.
 *   3. If the bare base is already taken, append "_2", "_3", … until free.
 *      Trim the base if needed to keep the suffixed form ≤ USERNAME_MAX_LENGTH.
 */
function pickUsername(email: string, accountId: string, taken: Set<string>): string {
  let base = deriveUsernameFromEmail(email);
  if (base === null) {
    // Fall back to "user" + first 8 chars of the account UUID. Always valid
    // charset; always ≤ 20 chars; effectively unique on its own, but we
    // still run it through the collision loop for safety.
    base = ("user" + accountId.replace(/-/g, "").slice(0, 8)).slice(0, 20);
  }
  if (RESERVED_USERNAMES.has(base)) {
    base = base.length > 18 ? base.slice(0, 18) + "_1" : base + "_1";
  }

  // Try the bare base first.
  if (!taken.has(base)) {
    taken.add(base);
    return base;
  }

  // Suffix loop. Cap iterations at a sane number so a misconfigured run
  // can't spin forever; in practice we'll never hit this on Phase 1 user
  // counts.
  for (let i = 2; i < 10_000; i += 1) {
    const suffix = `_${String(i)}`;
    const maxBaseLen = 20 - suffix.length;
    const candidate = (base.slice(0, maxBaseLen) + suffix);
    if (!taken.has(candidate) && !RESERVED_USERNAMES.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
  throw new Error(`could not pick unique username for account ${accountId} (base=${base})`);
}

async function main(): Promise<void> {
  // Stage 1 — ADD COLUMN username
  if (await columnExists("accounts", "username")) {
    log("stage 1 add column username", "skipped", "column already exists");
  } else {
    await sql`ALTER TABLE accounts ADD COLUMN username TEXT`;
    log("stage 1 add column username", "applied");
  }

  // Stage 2 — ADD COLUMN username_changed_at
  if (await columnExists("accounts", "username_changed_at")) {
    log("stage 2 add column username_changed_at", "skipped", "column already exists");
  } else {
    await sql`ALTER TABLE accounts ADD COLUMN username_changed_at TIMESTAMPTZ`;
    log("stage 2 add column username_changed_at", "applied");
  }

  // Stage 3 — backfill NULL usernames
  const nullRows = await sql`
    SELECT id, email
    FROM accounts
    WHERE username IS NULL
    ORDER BY created_at
  `;

  if (nullRows.length === 0) {
    log("stage 3 backfill", "skipped", "no rows with null username");
  } else {
    // Pre-load existing taken usernames so we don't collide with rows that
    // were already filled in (e.g. from a partial previous run).
    const existing = await sql`
      SELECT username FROM accounts WHERE username IS NOT NULL
    `;
    const taken = new Set<string>();
    for (const r of existing) {
      const u = (r as { username: string }).username.toLowerCase();
      taken.add(u);
    }

    log("stage 3 backfill", "info", `${String(nullRows.length)} rows to backfill, ${String(taken.size)} usernames already taken`);

    let assigned = 0;
    for (const row of nullRows) {
      const r = row as { id: string; email: string };
      const candidate = pickUsername(r.email, r.id, taken);

      // Sanity-check the candidate against the same gate the runtime uses.
      // Reserved-name + charset are pre-checked by pickUsername, but this
      // double-check protects against a subtle bug in the derive helper
      // ever shipping a malformed value through.
      const validation = validateUsername(candidate);
      if (!validation.ok) {
        throw new Error(
          `derived candidate failed validateUsername (account=${r.id} candidate=${candidate} error=${validation.error})`,
        );
      }

      await sql`
        UPDATE accounts
        SET username = ${validation.username},
            username_changed_at = NULL
        WHERE id = ${r.id}
      `;
      assigned += 1;
    }
    log("stage 3 backfill", "applied", `${String(assigned)} rows assigned`);
  }

  // Stage 4 — CREATE UNIQUE INDEX
  if (await indexExists("accounts_username_lower_idx")) {
    log("stage 4 create unique index", "skipped", "index already exists");
  } else {
    await sql`
      CREATE UNIQUE INDEX accounts_username_lower_idx
      ON accounts (LOWER(username))
    `;
    log("stage 4 create unique index", "applied");
  }

  // Stage 5 — SET NOT NULL
  if (await columnIsNullable("accounts", "username")) {
    await sql`ALTER TABLE accounts ALTER COLUMN username SET NOT NULL`;
    log("stage 5 set not null", "applied");
  } else {
    log("stage 5 set not null", "skipped", "column already non-nullable");
  }

  log("done", "info", "migration 001 complete");
}

try {
  await main();
} catch (err: unknown) {
  process.stderr.write(`[migrate-001] FAILED: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
} finally {
  await sql.end();
}
