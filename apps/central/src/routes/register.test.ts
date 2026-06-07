import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  startTestServer,
  extractCookie,
  type TestServer,
} from "../test-helpers";

let ts: TestServer;

beforeAll(async () => {
  ts = await startTestServer();
});

afterAll(async () => {
  await ts.shutdown();
});

describe("POST /v1/auth/register", () => {
  test("returns 202 and no session cookie (dev mode: no CAPTCHA key)", async () => {
    const res = await fetch(`${ts.url}/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "alice@example.com",
        username: "alice",
        password: "password123",
        display_name: "Alice",
      }),
    });

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.message).toBe("Check your email to verify your account");

    const token = extractCookie(res, "__Host-session");
    expect(token).toBeNull();
  });

  test("email_verified is false in DB after registration", async () => {
    await fetch(`${ts.url}/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "unverified@example.com",
        username: "unverified",
        password: "password123",
        display_name: "Unverified",
      }),
    });

    const rows = await ts.sql`
      SELECT email_verified FROM accounts WHERE email = 'unverified@example.com'
    `;
    expect(rows[0]?.email_verified).toBe(false);
  });

  test("creates email_verifications row after registration", async () => {
    await fetch(`${ts.url}/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "check-token@example.com",
        username: "checktoken",
        password: "password123",
        display_name: "CheckToken",
      }),
    });

    const accountRows = await ts.sql`SELECT id FROM accounts WHERE email = 'check-token@example.com'`;
    const accountId = accountRows[0]!.id as string;

    const tokenRows = await ts.sql`
      SELECT id FROM email_verifications WHERE account_id = ${accountId}
    `;
    expect(tokenRows.length).toBe(1);
  });

  test("rejects duplicate email", async () => {
    await fetch(`${ts.url}/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "dupe@example.com",
        username: "dupe_first",
        password: "password123",
        display_name: "First",
      }),
    });

    const res = await fetch(`${ts.url}/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "dupe@example.com",
        username: "dupe_second",
        password: "password456",
        display_name: "Second",
      }),
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("CONFLICT");
  });

  test("rejects duplicate username (case-insensitive)", async () => {
    await fetch(`${ts.url}/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "name-a@example.com",
        username: "sharedname",
        password: "password123",
        display_name: "A",
      }),
    });

    const res = await fetch(`${ts.url}/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "name-b@example.com",
        username: "SharedName",
        password: "password123",
        display_name: "B",
      }),
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("USERNAME_TAKEN");
  });

  test("rejects invalid username charset", async () => {
    const res = await fetch(`${ts.url}/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "bad-name@example.com",
        username: "Has Space",
        password: "password123",
        display_name: "Bad",
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("USERNAME_CHARSET");
  });

  test("rejects reserved username", async () => {
    const res = await fetch(`${ts.url}/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "admin@example.com",
        username: "admin",
        password: "password123",
        display_name: "Admin",
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("USERNAME_RESERVED");
  });

  test("rejects too-short username", async () => {
    const res = await fetch(`${ts.url}/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "short-name@example.com",
        username: "ab",
        password: "password123",
        display_name: "Short",
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("USERNAME_TOO_SHORT");
  });

  test("rejects short password", async () => {
    const res = await fetch(`${ts.url}/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "short@example.com",
        username: "shortpw",
        password: "1234567",
        display_name: "Short",
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toContain("8 characters");
  });

  test("rejects oversized password before hashing (DoS guard)", async () => {
    // 129 characters — one over the OWASP ceiling. The check must run before
    // Argon2id, otherwise a multi-megabyte password would block the event loop.
    const res = await fetch(`${ts.url}/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "long@example.com",
        username: "longpw",
        password: "x".repeat(129),
        display_name: "Long",
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toContain("128 characters");
  });

  test("rejects missing display name", async () => {
    const res = await fetch(`${ts.url}/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "noname@example.com",
        username: "noname",
        password: "password123",
        display_name: "",
      }),
    });

    expect(res.status).toBe(400);
  });

  test("rejects invalid email", async () => {
    const res = await fetch(`${ts.url}/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "not-an-email",
        username: "bademail",
        password: "password123",
        display_name: "Bad Email",
      }),
    });

    expect(res.status).toBe(400);
  });

  test("normalizes email to lowercase", async () => {
    const res = await fetch(`${ts.url}/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "UPPER@Example.COM",
        username: "upper",
        password: "password123",
        display_name: "Upper",
      }),
    });

    expect(res.status).toBe(202);
    const rows = await ts.sql`SELECT email FROM accounts WHERE email = 'upper@example.com'`;
    expect(rows.length).toBe(1);
  });

  test("rejects invalid CAPTCHA when TURNSTILE_SECRET_KEY is set", async () => {
    const original = process.env["TURNSTILE_SECRET_KEY"];
    process.env["TURNSTILE_SECRET_KEY"] = "test-secret";
    try {
      const res = await fetch(`${ts.url}/v1/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "captcha-fail@example.com",
          username: "captchafail",
          password: "password123",
          display_name: "CaptchaFail",
          captcha_token: "invalid-token",
        }),
      });
      // The server will attempt to call Turnstile — it will fail (network error or bad response)
      // Either 400 CAPTCHA_FAILED or a network-related error
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("CAPTCHA_FAILED");
    } finally {
      if (original === undefined) {
        delete process.env["TURNSTILE_SECRET_KEY"];
      } else {
        process.env["TURNSTILE_SECRET_KEY"] = original;
      }
    }
  });
});
