// One-shot recovery: re-set the local Postgres `postgres` user's password to
// match Bitwarden's `uncorded/central/DB_PASSWORD`. Needed once after the
// password has drifted (e.g. after a Docker volume reset, or a manual
// `ALTER USER` for tests). Reads from Bitwarden via the user's existing
// BW_SESSION; never prints or persists the value.
//
// Run from `apps/central/`:  `bun run scripts/restore-db-password.ts`

const VAULT_KEY = "uncorded/central/DB_PASSWORD";
const CONTAINER = "uncorded-pg";

interface ProcResult { stdout: string; stderr: string; code: number }

async function run(cmd: string[], opts: { stdin?: string } = {}): Promise<ProcResult> {
  const proc = Bun.spawn(cmd, {
    stdout: "pipe",
    stderr: "pipe",
    stdin: opts.stdin !== undefined ? "pipe" : "inherit",
  });
  if (opts.stdin !== undefined && proc.stdin) {
    proc.stdin.write(opts.stdin);
    await proc.stdin.end();
  }
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout: stdout.trim(), stderr: stderr.trim(), code };
}

function fail(msg: string): never {
  process.stderr.write(`\n  ✗ ${msg}\n\n`);
  process.exit(1);
}

const status = await run(["bw", "status"]);
if (status.code !== 0) fail(`bw status failed: ${status.stderr || status.stdout}`);
let parsed: { status?: string };
try { parsed = JSON.parse(status.stdout) as { status?: string }; }
catch { fail(`Unparseable bw status: ${status.stdout}`); }
if (parsed.status !== "unlocked") {
  fail(
    "Bitwarden vault is locked.\n    Run `$env:BW_SESSION=(bw unlock --raw)` first.",
  );
}

const fetched = await run(["bw", "get", "password", VAULT_KEY]);
if (fetched.code !== 0) fail(`Could not fetch ${VAULT_KEY}: ${fetched.stderr || fetched.stdout}`);
const password = fetched.stdout;
if (password.length === 0) fail("Bitwarden returned an empty password.");
if (/'/.test(password)) {
  fail(
    "Stored password contains a single quote, which would break the SQL\n" +
    "    statement. Update the Bitwarden item to a quote-free value, or\n" +
    "    edit this script to use psql variable binding.",
  );
}

const sql = `ALTER USER postgres WITH PASSWORD '${password}';`;
const psql = await run(
  ["docker", "exec", "-i", CONTAINER, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1"],
  { stdin: sql + "\n" },
);
if (psql.code !== 0) fail(`psql failed: ${psql.stderr || psql.stdout}`);

process.stdout.write("  ✓ Restored postgres user password from Bitwarden.\n");
