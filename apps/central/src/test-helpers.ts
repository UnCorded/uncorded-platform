import postgres from "postgres";
import { createDb, type Sql } from "./db";
import { createRateLimiter, type RateLimiter } from "./middleware";
import type { R2Client } from "./r2";
import { createRouter } from "./routes";
import { ensureSigningKey } from "./crypto";
import { createLogger } from "@uncorded/shared";
import { readFileSync } from "fs";
import { resolve } from "path";

const DEFAULT_TEST_DB = "uncorded_central_test";

/** Create or reset the test database, return a connection to it.
 *  The DB name is parameterized so multiple in-process test servers can run
 *  side-by-side without dropping each other's data mid-test. */
export async function setupTestDb(dbName: string = DEFAULT_TEST_DB): Promise<Sql> {
  // Read the same env vars that apps/central/src/index.ts uses, with the same
  // fallbacks. Tests previously hard-coded postgres/postgres which broke
  // whenever the local Postgres password drifted from the literal "postgres"
  // (see memory feedback_db_password_drift). The fallbacks preserve the
  // postgres/postgres contract that CLAUDE.md documents for fresh CI machines.
  const dbHost = process.env["DB_HOST"] ?? "localhost";
  const dbPort = Number(process.env["DB_PORT"] ?? 5432);
  const dbUser = process.env["DB_USER"] ?? "postgres";
  const dbPassword = process.env["DB_PASSWORD"] ?? "postgres";

  // Connect to default 'postgres' database to create/reset the test DB
  const admin = postgres({
    host: dbHost,
    port: dbPort,
    database: "postgres",
    username: dbUser,
    password: dbPassword,
  });

  // Drop and recreate test database
  await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName}`);
  await admin.unsafe(`CREATE DATABASE ${dbName}`);
  await admin.end();

  // Connect to test database and run schema
  const sql = createDb({ host: dbHost, port: dbPort, database: dbName, username: dbUser, password: dbPassword });
  const schemaPath = resolve(import.meta.dir, "..", "schema.sql");
  const schema = readFileSync(schemaPath, "utf-8");
  await sql.unsafe(schema);

  return sql;
}

export interface TestServer {
  readonly url: string;
  readonly sql: Sql;
  readonly server: ReturnType<typeof Bun.serve>;
  readonly rateLimiter: RateLimiter;
  shutdown(): Promise<void>;
}

export function createMockR2(overrides?: Partial<R2Client>): R2Client {
  return {
    async putObject() {},
    async deleteObject() {},
    async presignedGetUrl() { return "https://r2.example.com/mock-get"; },
    async presignedPost(key, contentType, _maxBytes, _expiresIn) {
      return {
        url: "https://r2.example.com/mock-post",
        fields: { key, "Content-Type": contentType, policy: "mock-policy", signature: "mock-sig" },
      };
    },
    publicUrl(key) { return `https://r2.example.com/${key}`; },
    ...overrides,
  };
}

/** Start a test server on a random port. */
export async function startTestServer(opts?: {
  r2?: R2Client | null;
  /** When true, use the real token-bucket limiter so rate-limit tests work. */
  realRateLimiter?: boolean;
  /** Override the Postgres DB name so multiple test servers can coexist. */
  dbName?: string;
}): Promise<TestServer> {
  const sql = await setupTestDb(opts?.dbName);
  const rateLimiter: RateLimiter = opts?.realRateLimiter
    ? createRateLimiter()
    : {
        consume() { return { allowed: true, retryAfter: 0 }; },
        resetForTests() {},
      };
  // Ensure Ed25519 signing key exists for JWT tests
  process.env["SIGNING_KEY_SECRET"] = "test-signing-key-secret-32chars!";
  // Bun auto-loads .env which may contain a real TURNSTILE_SECRET_KEY. Tests
  // never include captcha tokens, so any real key would fail-close every
  // register call. Force the dev-bypass branch (verifyCaptcha returns true
  // when the secret is unset).
  delete process.env["TURNSTILE_SECRET_KEY"];
  await ensureSigningKey(sql);

  // r2 defaults to createMockR2(); pass { r2: null } to test 503 paths
  const r2 = opts !== undefined && "r2" in opts ? (opts.r2 ?? null) : createMockR2();

  const route = createRouter({
    sql,
    rateLimiter,
    logger: createLogger({ component: "test" }),
    emailClient: null,
    appBaseUrl: "http://localhost:4000",
    r2,
    bootInfo: { version: "test", commit: "test", startedAt: Date.now() },
  });

  const server = Bun.serve({
    port: 0, // random available port
    fetch: route,
  });

  const url = `http://localhost:${server.port}`;

  return {
    url,
    sql,
    server,
    rateLimiter,
    async shutdown() {
      server.stop();
      await sql.end();
    },
  };
}

/** Helper to extract a cookie value from a Set-Cookie header. */
export function extractCookie(
  response: Response,
  name: string,
): string | null {
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) return null;
  const prefix = `${name}=`;
  for (const part of setCookie.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(prefix)) {
      return trimmed.slice(prefix.length);
    }
  }
  return null;
}

/** Helper to make an authenticated request with a session cookie. */
export function authHeaders(token: string): HeadersInit {
  return { Cookie: `__Host-session=${token}` };
}

/** Register an account and return the session token + account ID.
 *  Bypasses email verification by updating the DB directly (test-only). */
export async function registerAndLogin(
  ts: TestServer,
  suffix: string,
): Promise<{ token: string; accountId: string; username: string }> {
  const email = `${suffix}@example.com`;
  // Username charset is [a-z0-9_]; squash hyphens/dots and pad to >=3 chars.
  const username = (suffix.toLowerCase().replace(/[^a-z0-9_]/g, "_") + "_x").slice(0, 20);
  await fetch(`${ts.url}/v1/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email,
      username,
      password: "password123",
      display_name: suffix,
    }),
  });
  // Bypass email verification — set flag directly in the test DB
  await ts.sql`UPDATE accounts SET email_verified = true WHERE email = ${email}`;
  // Login to obtain a session
  const loginRes = await fetch(`${ts.url}/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "password123" }),
  });
  const body = (await loginRes.json()) as { id: string };
  const token = extractCookie(loginRes, "__Host-session")!;
  return { token, accountId: body.id, username };
}
