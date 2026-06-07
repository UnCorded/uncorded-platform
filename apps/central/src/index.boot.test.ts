import { describe, test, expect } from "bun:test";
import { spawn } from "bun";
import { resolve } from "path";

// Subprocess boot tests for the env-enforcement gate in `index.ts`.
//
// These spawn the real Central entrypoint with curated env, so they can't run
// inside the in-process `bun test` runner — they're excluded from the default
// suite via `bunfig.toml` and invoked separately via `bun run test:boot`.

const ENTRY = resolve(import.meta.dir, "index.ts");

const REQUIRED_VARS = [
  "SIGNING_KEY_SECRET",
  "OAUTH_STATE_SECRET",
  "APP_BASE_URL",
  "POST_LOGIN_REDIRECT",
  "RESEND_API_KEY",
  "TURNSTILE_SECRET_KEY",
  "DB_PASSWORD",
] as const;

function envWithAllRequired(): Record<string, string> {
  return {
    NODE_ENV: "production",
    SIGNING_KEY_SECRET: "test-signing-key-secret-32chars!",
    OAUTH_STATE_SECRET: "x".repeat(32),
    APP_BASE_URL: "http://localhost:4000",
    POST_LOGIN_REDIRECT: "http://localhost:5174",
    RESEND_API_KEY: "fake-resend-key",
    TURNSTILE_SECRET_KEY: "fake-turnstile-key",
    DB_PASSWORD: "postgres",
    // Point at an unreachable port so boot proceeds past env enforcement and
    // then fails on the DB connect — that's fine for the env-check happy path,
    // we just need the process to get past `requireInProd(...)` without
    // exiting on env. Without this the test would either hang or hit the real
    // dev DB if one happens to be running.
    DB_HOST: "127.0.0.1",
    DB_PORT: "1",
    PATH: process.env["PATH"] ?? "",
  };
}

interface BootResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

async function runBoot(env: Record<string, string>, timeoutMs = 8000): Promise<BootResult> {
  const proc = spawn({
    cmd: ["bun", "run", ENTRY],
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);

  const exitCode = await proc.exited;
  clearTimeout(timer);

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { exitCode, stdout, stderr, timedOut };
}

describe("boot env enforcement (production)", () => {
  for (const missing of REQUIRED_VARS) {
    test(`exits non-zero when ${missing} is missing`, async () => {
      const env = envWithAllRequired();
      delete env[missing];
      const { exitCode, stdout, timedOut } = await runBoot(env);
      expect(timedOut).toBe(false);
      expect(exitCode).not.toBe(0);
      // The error log must name the specific missing var so an operator can
      // tell which secret to wire up. If a future refactor breaks the helper
      // and reports a generic "missing env" without the name, this catches it.
      expect(stdout).toContain(missing);
    });
  }

  test("exits non-zero when OAUTH_STATE_SECRET is shorter than 32 bytes", async () => {
    const env = envWithAllRequired();
    env["OAUTH_STATE_SECRET"] = "too-short";
    const { exitCode, stdout, timedOut } = await runBoot(env);
    expect(timedOut).toBe(false);
    expect(exitCode).not.toBe(0);
    expect(stdout).toContain("OAUTH_STATE_SECRET");
  });

  test("exits non-zero when POST_LOGIN_REDIRECT is not on the allowlist", async () => {
    const env = envWithAllRequired();
    env["POST_LOGIN_REDIRECT"] = "https://attacker.com";
    const { exitCode, stdout, timedOut } = await runBoot(env);
    expect(timedOut).toBe(false);
    expect(exitCode).not.toBe(0);
    expect(stdout).toContain("POST_LOGIN_REDIRECT is not on the allowlist");
  });

  test("exits non-zero when POST_LOGIN_REDIRECT carries a query string", async () => {
    // The auth handlers append their own `?error=…` / `?verified=1`, so any
    // pre-existing query is both wrong and a smuggling vector.
    const env = envWithAllRequired();
    env["POST_LOGIN_REDIRECT"] = "https://uncorded.app/?next=evil";
    const { exitCode, timedOut } = await runBoot(env);
    expect(timedOut).toBe(false);
    expect(exitCode).not.toBe(0);
  });

  test("logs every required var as present and proceeds past env checks when all set", async () => {
    const { stdout } = await runBoot(envWithAllRequired());
    // Boot will eventually fail on the bogus DB_PORT — we don't assert on the
    // exit code or timeout. We only assert that the env-enforcement block
    // logged all six "env var present" lines before yielding to DB code.
    for (const v of REQUIRED_VARS) {
      expect(stdout).toContain(`"var":"${v}"`);
    }
  });
});

describe("boot env enforcement (dev mode)", () => {
  test("does not exit when required vars are missing in NODE_ENV=development", async () => {
    // In dev the env enforcement is intentionally permissive — the existing
    // per-subsystem warn + fallback behavior takes over. Boot should proceed
    // past the requireInProd() block and then (because DB_PORT is bogus) fail
    // on DB connect, not on env. We assert via the absence of the
    // "required env var missing" error log.
    const env: Record<string, string> = {
      NODE_ENV: "development",
      DB_HOST: "127.0.0.1",
      DB_PORT: "1",
      PATH: process.env["PATH"] ?? "",
    };
    const { stdout } = await runBoot(env);
    expect(stdout).not.toContain("required env var missing or too short in production");
  });

  test("does not exit when required vars are missing in NODE_ENV=test", async () => {
    // The test runner sets NODE_ENV=test; the boot guard treats it the same
    // as development so unit/integration tests don't need real secrets.
    const env: Record<string, string> = {
      NODE_ENV: "test",
      DB_HOST: "127.0.0.1",
      DB_PORT: "1",
      PATH: process.env["PATH"] ?? "",
    };
    const { stdout } = await runBoot(env);
    expect(stdout).not.toContain("required env var missing or too short in production");
  });
});

describe("boot env enforcement (secure default)", () => {
  // The boot guard is opt-out-of-production rather than opt-in. Anything that
  // isn't an explicit dev/test value — including unset, typos, and unrelated
  // tags like "staging" — must fail closed, otherwise a misconfigured deploy
  // silently falls through to dev fallbacks (verification-URL logging, etc.)
  // and leaks tokens to log aggregators.

  test("treats unset NODE_ENV as production (fails closed when RESEND_API_KEY missing)", async () => {
    const env: Record<string, string> = {
      // No NODE_ENV — simulates a deploy that forgot to set it.
      DB_HOST: "127.0.0.1",
      DB_PORT: "1",
      PATH: process.env["PATH"] ?? "",
    };
    const { exitCode, stdout, timedOut } = await runBoot(env);
    expect(timedOut).toBe(false);
    expect(exitCode).not.toBe(0);
    expect(stdout).toContain("required env var missing or too short in production");
  });

  test("treats NODE_ENV=prod (typo) as production", async () => {
    const env: Record<string, string> = {
      NODE_ENV: "prod",
      DB_HOST: "127.0.0.1",
      DB_PORT: "1",
      PATH: process.env["PATH"] ?? "",
    };
    const { exitCode, stdout, timedOut } = await runBoot(env);
    expect(timedOut).toBe(false);
    expect(exitCode).not.toBe(0);
    expect(stdout).toContain("required env var missing or too short in production");
  });

  test("treats NODE_ENV=staging as production", async () => {
    const env: Record<string, string> = {
      NODE_ENV: "staging",
      DB_HOST: "127.0.0.1",
      DB_PORT: "1",
      PATH: process.env["PATH"] ?? "",
    };
    const { exitCode, stdout, timedOut } = await runBoot(env);
    expect(timedOut).toBe(false);
    expect(exitCode).not.toBe(0);
    expect(stdout).toContain("required env var missing or too short in production");
  });
});
