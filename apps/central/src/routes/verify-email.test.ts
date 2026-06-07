import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  startTestServer,
  extractCookie,
  type TestServer,
} from "../test-helpers";
import { hashToken } from "../crypto";

let ts: TestServer;

const WEB_BASE = "http://localhost:5174";

beforeAll(async () => {
  // Pin the post-login redirect explicitly so this test isn't sensitive to
  // sibling test files (oauth.test.ts) that mutate POST_LOGIN_REDIRECT.
  process.env["POST_LOGIN_REDIRECT"] = WEB_BASE;
  ts = await startTestServer();
});

afterAll(async () => {
  delete process.env["POST_LOGIN_REDIRECT"];
  await ts.shutdown();
});

/** Register an unverified account and return its ID with a known raw token inserted. */
async function seedUnverifiedWithToken(
  email: string,
  rawToken: string,
  expired = false,
): Promise<string> {
  // Username charset is [a-z0-9_]; squash and pad short locals.
  const local = email.split("@")[0]!;
  const username = (local.toLowerCase().replace(/[^a-z0-9_]/g, "_") + "_x").slice(0, 20);
  await fetch(`${ts.url}/v1/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email,
      username,
      password: "password123",
      display_name: local,
    }),
  });

  const accountRows = await ts.sql`SELECT id FROM accounts WHERE email = ${email}`;
  const accountId = accountRows[0]!.id as string;

  // Replace the generated token with a known one for testing
  await ts.sql`DELETE FROM email_verifications WHERE account_id = ${accountId}`;
  const tokenHash = await hashToken(rawToken);
  const expiresAt = expired
    ? new Date(Date.now() - 1000) // already expired
    : new Date(Date.now() + 24 * 60 * 60 * 1000);
  await ts.sql`
    INSERT INTO email_verifications (account_id, token_hash, expires_at)
    VALUES (${accountId}, ${tokenHash}, ${expiresAt})
  `;

  return accountId;
}

describe("GET /v1/auth/verify-email", () => {
  test("valid token verifies account and returns 302 with session cookie", async () => {
    const rawToken = "valid-verification-token-abcdefghijklmnopqrstuvwxyz1234";
    const accountId = await seedUnverifiedWithToken("verify-ok@example.com", rawToken);

    const res = await fetch(
      `${ts.url}/v1/auth/verify-email?token=${rawToken}`,
      { redirect: "manual" },
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${WEB_BASE}/?verified=1`);

    const token = extractCookie(res, "__Host-session");
    expect(token).not.toBeNull();

    // Account should now be verified in DB
    const rows = await ts.sql`SELECT email_verified FROM accounts WHERE id = ${accountId}`;
    expect(rows[0]?.email_verified).toBe(true);
  });

  test("verification token is single-use", async () => {
    const rawToken = "single-use-token-abcdefghijklmnopqrstuvwxyz-12345678";
    await seedUnverifiedWithToken("verify-once@example.com", rawToken);

    // First use succeeds (302 to verified=1)
    const first = await fetch(`${ts.url}/v1/auth/verify-email?token=${rawToken}`, {
      redirect: "manual",
    });
    expect(first.status).toBe(302);
    expect(first.headers.get("location")).toBe(`${WEB_BASE}/?verified=1`);

    // Second use fails (302 to error=verify_failed, no cookie)
    const second = await fetch(`${ts.url}/v1/auth/verify-email?token=${rawToken}`, {
      redirect: "manual",
    });
    expect(second.status).toBe(302);
    expect(second.headers.get("location")).toBe(`${WEB_BASE}/?error=verify_failed`);
    expect(extractCookie(second, "__Host-session")).toBeNull();
  });

  test("expired token redirects with verify_failed", async () => {
    const rawToken = "expired-token-abcdefghijklmnopqrstuvwxyz-1234567890ab";
    await seedUnverifiedWithToken("verify-expired@example.com", rawToken, true);

    const res = await fetch(`${ts.url}/v1/auth/verify-email?token=${rawToken}`, {
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${WEB_BASE}/?error=verify_failed`);
    expect(extractCookie(res, "__Host-session")).toBeNull();
  });

  test("invalid token redirects with verify_failed", async () => {
    const res = await fetch(`${ts.url}/v1/auth/verify-email?token=completely-wrong-token`, {
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${WEB_BASE}/?error=verify_failed`);
  });

  test("missing token redirects with verify_failed", async () => {
    const res = await fetch(`${ts.url}/v1/auth/verify-email`, {
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${WEB_BASE}/?error=verify_failed`);
  });
});
