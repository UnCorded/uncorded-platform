import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  startTestServer,
  authHeaders,
  registerAndLogin,
  type TestServer,
} from "../test-helpers";
import { createRateLimiter } from "../middleware";
import { createRouter } from "../routes";
import { createLogger } from "@uncorded/shared";

let ts: TestServer;

beforeAll(async () => {
  ts = await startTestServer();
});

afterAll(async () => {
  await ts.shutdown();
});

/** Register an unverified account and return the session token obtained by
 *  verifying the account, OR just the raw session via direct DB manipulation. */
async function seedUnverifiedSession(email: string): Promise<string> {
  // Register (unverified). Derive a deterministic, charset-safe username from
  // the email's local part so each call inside a test suite stays unique.
  const local = email.split("@")[0]!;
  const username = (local.toLowerCase().replace(/[^a-z0-9_]/g, "_") + "_x").slice(0, 20);
  await fetch(`${ts.url}/v1/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, username, password: "password123", display_name: "Tester" }),
  });

  // Create a session directly in DB (account is unverified — we need a session to test resend)
  const accountRows = await ts.sql`SELECT id FROM accounts WHERE email = ${email}`;
  const accountId = accountRows[0]!.id as string;

  // Insert a known session token
  const rawToken = `resend-session-${email.replace(/[@.]/g, "-")}`.slice(0, 64).padEnd(64, "x");
  const { hashToken } = await import("../crypto");
  const tokenHash = await hashToken(rawToken);
  const now = Date.now();
  const idleExpiresAt = new Date(now + 7 * 24 * 60 * 60 * 1000);
  const absoluteExpiresAt = new Date(now + 30 * 24 * 60 * 60 * 1000);
  await ts.sql`
    INSERT INTO sessions (account_id, token_hash, idle_expires_at, absolute_expires_at)
    VALUES (${accountId}, ${tokenHash}, ${idleExpiresAt}, ${absoluteExpiresAt})
  `;

  return rawToken;
}

describe("POST /v1/auth/resend-verification", () => {
  test("returns 401 when unauthenticated", async () => {
    const res = await fetch(`${ts.url}/v1/auth/resend-verification`, {
      method: "POST",
    });
    expect(res.status).toBe(401);
  });

  test("returns 400 if email already verified", async () => {
    const { token } = await registerAndLogin(ts, "resend-already-verified");

    const res = await fetch(`${ts.url}/v1/auth/resend-verification`, {
      method: "POST",
      headers: authHeaders(token),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain("already verified");
  });

  test("returns 200 and replaces existing token for unverified account", async () => {
    const email = "resend-unverified@example.com";
    const sessionToken = await seedUnverifiedSession(email);

    // Get initial token count
    const accountRows = await ts.sql`SELECT id FROM accounts WHERE email = ${email}`;
    const accountId = accountRows[0]!.id as string;
    const before = await ts.sql`SELECT id FROM email_verifications WHERE account_id = ${accountId}`;

    const res = await fetch(`${ts.url}/v1/auth/resend-verification`, {
      method: "POST",
      headers: authHeaders(sessionToken),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toBe("Verification email sent");

    // New token should be in DB
    const after = await ts.sql`SELECT id FROM email_verifications WHERE account_id = ${accountId}`;
    expect(after.length).toBe(1);

    // If there was a previous token, it should be replaced
    if (before.length > 0) {
      expect(after[0]!.id).not.toBe(before[0]!.id);
    }
  });

  test("rate limit: 4th attempt returns 429", async () => {
    // Spin up a second server on a random port with a real (non-permissive) rate limiter,
    // sharing the same DB as the main test server to avoid costly setupTestDb.
    const { hashToken } = await import("../crypto");
    const rateLimiter = createRateLimiter();
    const route = createRouter({
      sql: ts.sql,
      rateLimiter,
      logger: createLogger({ component: "test-rl" }),
      emailClient: null,
      appBaseUrl: "http://localhost:4000",
      r2: null,
      bootInfo: { version: "test", commit: "test", startedAt: Date.now() },
    });
    const rlServer = Bun.serve({ port: 0, fetch: route });
    const rlUrl = `http://localhost:${rlServer.port}`;

    try {
      // Register an unverified account via the real-RL server (shares main DB)
      await fetch(`${rlUrl}/v1/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "rl-resend@example.com", username: "rlresend", password: "password123", display_name: "RLTest" }),
      });

      const accountRows = await ts.sql`SELECT id FROM accounts WHERE email = 'rl-resend@example.com'`;
      const accountId = accountRows[0]!.id as string;

      // Insert a session directly in the shared DB
      const rawToken = "rl-resend-session-tok-abcdefghijklmnopqrstuvwxyz12";
      const tokenHash = await hashToken(rawToken);
      const sessionNow = Date.now();
      const idleExpiresAt = new Date(sessionNow + 7 * 24 * 60 * 60 * 1000);
      const absoluteExpiresAt = new Date(sessionNow + 30 * 24 * 60 * 60 * 1000);
      await ts.sql`
        INSERT INTO sessions (account_id, token_hash, idle_expires_at, absolute_expires_at)
        VALUES (${accountId}, ${tokenHash}, ${idleExpiresAt}, ${absoluteExpiresAt})
      `;

      const headers = { ...authHeaders(rawToken), "Content-Type": "application/json" };

      // First 3 should succeed (maxTokens = 3)
      for (let i = 0; i < 3; i++) {
        const res = await fetch(`${rlUrl}/v1/auth/resend-verification`, { method: "POST", headers });
        expect(res.status).toBe(200);
      }

      // 4th should be rate limited
      const res4 = await fetch(`${rlUrl}/v1/auth/resend-verification`, { method: "POST", headers });
      expect(res4.status).toBe(429);
    } finally {
      rlServer.stop();
    }
  });
});
