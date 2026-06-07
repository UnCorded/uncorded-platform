// Boots Central with operational config in env vars. Secrets are pulled from
// Bitwarden at startup and stay in process memory — they never touch disk.
// Non-secret config (DB host, R2 account ID, OAuth Client IDs, public URLs)
// is committed below so the deployment is reproducible from a clean clone.
//
// This is the production startup path even when run on a developer machine:
// the cloudflared tunnel exposes the local Central process at
// central.uncorded.app, so NODE_ENV=production and APP_BASE_URL points at
// the public hostname.
//
// ----------------------------------------------------------------------------
// Setup (one-time, per machine)
// ----------------------------------------------------------------------------
//
// 1. Install the Bitwarden CLI (`winget install Bitwarden.CLI` on Windows;
//    `brew install bitwarden-cli` on macOS) and run `bw login` once.
//
// 2. For each secret listed in REQUIRED_SECRETS / OPTIONAL_SECRETS below,
//    create a *Login* item in Bitwarden named `uncorded/central/<ENV_VAR>`
//    with the secret value in the password field. Username can be empty.
//
// 3. Each terminal session, unlock the vault once:
//
//        export BW_SESSION=$(bw unlock --raw)
//
//    (Add an alias to ~/.bashrc — e.g. `alias bwopen='export
//    BW_SESSION=$(bw unlock --raw)'` — to keep the friction low.)
//
// 4. Run `bun run dev:vault` from apps/central/.
//
// ----------------------------------------------------------------------------
// Required vs optional secrets
// ----------------------------------------------------------------------------
//
// REQUIRED secrets must exist in Bitwarden or the script aborts. Today the
// only hard requirement is SIGNING_KEY_SECRET — Central refuses to mint
// server tokens without it.
//
// OPTIONAL secrets are fetched if present and silently skipped otherwise.
// Missing optional secrets disable the corresponding feature (no Resend key
// → emails log to stdout instead of being sent; no R2 keys → uploads return
// 503; no OAuth provider secret → that provider's login is skipped).
//
// To add a new secret, append it to REQUIRED_SECRETS or OPTIONAL_SECRETS and
// add the matching Bitwarden item. To add new non-secret config, edit
// NON_SECRET_CONFIG directly — it's checked into git deliberately.

import { resolve } from "node:path";
import { readdirSync } from "node:fs";

const REQUIRED_SECRETS = ["SIGNING_KEY_SECRET"] as const;

const OPTIONAL_SECRETS = [
  "OAUTH_STATE_SECRET",
  "DB_PASSWORD",
  "RESEND_API_KEY",
  "TURNSTILE_SECRET_KEY",
  "GOOGLE_CLIENT_SECRET",
  "DISCORD_CLIENT_SECRET",
  "GITHUB_CLIENT_SECRET",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
] as const;

// Non-secret operational config. Checked into git on purpose: account IDs
// and OAuth Client IDs are public (they appear in OAuth consent screens and
// public R2 URLs), bucket names and DB pointers are deployment metadata, and
// having them here means a fresh clone + `bw login` is enough to boot.
const NON_SECRET_CONFIG: Record<string, string> = {
  // Server
  NODE_ENV: "production",
  PORT: "4000",
  APP_BASE_URL: "https://central.uncorded.app",
  POST_LOGIN_REDIRECT: "https://uncorded.app",

  // Postgres pointer (DB_PASSWORD is fetched from Bitwarden)
  DB_HOST: "localhost",
  DB_PORT: "5432",
  DB_NAME: "uncorded_central",
  DB_USER: "postgres",

  // Email (RESEND_API_KEY is fetched from Bitwarden)
  RESEND_FROM_EMAIL: "noreply@uncorded.app",

  // Object storage (R2_ACCESS_KEY_ID + R2_SECRET_ACCESS_KEY from Bitwarden)
  R2_ACCOUNT_ID: "700d5d52cf32e2d221217e1fbf404f82",
  R2_BUCKET_NAME: "uncorded-central",
  R2_PUBLIC_URL: "https://assets.uncorded.app",

  // OAuth — Client IDs are public; CLIENT_SECRETs come from Bitwarden.
  // Both http://localhost:4000/v1/auth/<provider>/callback and
  // https://central.uncorded.app/v1/auth/<provider>/callback should be
  // registered with each provider so dev and prod both work.
  OAUTH_REDIRECT_BASE: "https://central.uncorded.app",
  GOOGLE_CLIENT_ID: "132482331479-4heeeng2b007uk95vk7g41dvqicn3g20.apps.googleusercontent.com",
  DISCORD_CLIENT_ID: "1499359540888469534",
  GITHUB_CLIENT_ID: "Ov23liAJM7BZx6MSK8KQ",

  // Admin allowlist (comma-separated emails)
  ADMIN_EMAILS: "itzdevoo.dev@gmail.com",
};

const APP_ROOT = resolve(import.meta.dir, "..");
const VAULT_PREFIX = "uncorded/central";

interface BwResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

async function bw(args: string[]): Promise<BwResult> {
  const proc = Bun.spawn(["bw", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout: stdout.trim(), stderr: stderr.trim(), code };
}

function fail(message: string): never {
  process.stderr.write(`\n  ✗ ${message}\n\n`);
  process.exit(1);
}

function refuseIfPlaintextEnv(): void {
  // Any leftover `.env*` file (other than the committed example) defeats the
  // whole point: dotenv would shadow our injected values, and the file would
  // re-introduce secrets-on-disk. Catch this loudly rather than silently
  // letting the old workflow keep working in parallel.
  const stray = readdirSync(APP_ROOT).filter(
    (f) => f.startsWith(".env") && f !== ".env.example",
  );
  if (stray.length > 0) {
    fail(
      `Stray env file(s) in apps/central/: ${stray.join(", ")}\n` +
        `    Move the values into Bitwarden as Login items named\n` +
        `    "${VAULT_PREFIX}/<NAME>" (password field) and delete the file(s).`,
    );
  }
}

async function ensureVaultUnlocked(): Promise<void> {
  const status = await bw(["status"]);
  if (status.code !== 0) {
    fail(
      `Could not run \`bw status\` (${status.stderr || status.stdout || "unknown error"}).\n` +
        `    Is the Bitwarden CLI installed and on PATH?`,
    );
  }
  let parsed: { status?: string };
  try {
    parsed = JSON.parse(status.stdout) as { status?: string };
  } catch {
    fail(`Unparseable \`bw status\` output: ${status.stdout}`);
  }
  if (parsed.status === "unauthenticated") {
    fail(`Bitwarden is not logged in. Run \`bw login\` first.`);
  }
  if (parsed.status !== "unlocked") {
    fail(
      `Bitwarden vault is locked. In this shell, run:\n\n` +
        `        export BW_SESSION=$(bw unlock --raw)\n\n` +
        `    then re-run \`bun run dev:vault\`.`,
    );
  }
}

async function fetchSecret(envName: string): Promise<string | null> {
  const result = await bw(["get", "password", `${VAULT_PREFIX}/${envName}`]);
  if (result.code === 0) return result.stdout;
  // `bw get` exits non-zero both for "not found" and for real errors. The
  // "not found" stderr is stable enough to distinguish, so we don't fail
  // hard on a missing optional secret.
  if (/not found/i.test(result.stderr)) return null;
  fail(
    `Failed to fetch ${envName} from Bitwarden:\n    ${result.stderr || result.stdout}`,
  );
}

async function loadSecrets(): Promise<Record<string, string>> {
  const secrets: Record<string, string> = {};

  for (const name of REQUIRED_SECRETS) {
    const value = await fetchSecret(name);
    if (value === null) {
      fail(
        `Required secret ${name} is missing.\n` +
          `    Add a Bitwarden Login item named "${VAULT_PREFIX}/${name}"\n` +
          `    with the value in the password field.`,
      );
    }
    secrets[name] = value;
  }

  let optionalLoaded = 0;
  for (const name of OPTIONAL_SECRETS) {
    const value = await fetchSecret(name);
    if (value !== null) {
      secrets[name] = value;
      optionalLoaded++;
    }
  }

  process.stderr.write(
    `  ✓ ${REQUIRED_SECRETS.length} required + ${optionalLoaded}/${OPTIONAL_SECRETS.length} optional secrets loaded\n`,
  );
  process.stderr.write(
    `  ✓ ${Object.keys(NON_SECRET_CONFIG).length} non-secret config values applied\n`,
  );
  return secrets;
}

async function main(): Promise<void> {
  refuseIfPlaintextEnv();
  await ensureVaultUnlocked();
  process.stderr.write("Loading Central secrets from Bitwarden...\n");
  const secrets = await loadSecrets();

  // Spawn the target command with config + secrets injected via env. By
  // default that's the dev server (`dev:vault`), but a script can pass an
  // alternate command as argv (e.g. `migrate:002:vault` runs a migration
  // through the same secret-loading path). Order matters: process.env first
  // (so the host shell can override anything), then NON_SECRET_CONFIG
  // (deployment defaults), then secrets (Bitwarden — never overridden by
  // the shell). Inheriting stdio means --watch reload output and Ctrl-C
  // work exactly as if the command had been invoked directly.
  const argv = Bun.argv.slice(2);
  const command = argv.length > 0 ? argv : ["bun", "run", "--watch", "src/index.ts"];
  const dev = Bun.spawn(command, {
    cwd: APP_ROOT,
    stdio: ["inherit", "inherit", "inherit"],
    env: { ...process.env, ...NON_SECRET_CONFIG, ...secrets },
  });

  const forward = (sig: NodeJS.Signals) => {
    try { dev.kill(sig); } catch { /* already exited */ }
  };
  process.on("SIGINT", () => forward("SIGINT"));
  process.on("SIGTERM", () => forward("SIGTERM"));

  process.exit(await dev.exited);
}

main().catch((err) => {
  process.stderr.write(`\n  ✗ ${err instanceof Error ? err.message : String(err)}\n\n`);
  process.exit(1);
});
