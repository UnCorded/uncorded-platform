import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  startTestServer,
  extractCookie,
  type TestServer,
} from "../test-helpers";

let ts: TestServer;

beforeAll(async () => {
  ts = await startTestServer();

  // Seed a verified test account
  await fetch(`${ts.url}/v1/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "login-test@example.com",
      username: "logintester",
      password: "correct-password",
      display_name: "Login Tester",
    }),
  });
  // Mark as verified so login works
  await ts.sql`UPDATE accounts SET email_verified = true WHERE email = 'login-test@example.com'`;

  // Seed an unverified account for the EMAIL_NOT_VERIFIED test
  await fetch(`${ts.url}/v1/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "unverified-login@example.com",
      username: "unverifiedlogin",
      password: "correct-password",
      display_name: "Unverified",
    }),
  });
});

afterAll(async () => {
  await ts.shutdown();
});

describe("POST /v1/auth/login", () => {
  test("logs in with correct credentials and verified email (legacy `email` field)", async () => {
    const res = await fetch(`${ts.url}/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "login-test@example.com",
        password: "correct-password",
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.email).toBe("login-test@example.com");
    expect(body.username).toBe("logintester");
    expect(body.username_changed_at).toBeNull();
    expect(body.username_change_available_at).toBeNull();
    expect(body.display_name).toBe("Login Tester");

    const token = extractCookie(res, "__Host-session");
    expect(token).not.toBeNull();
  });

  test("logs in via `identifier` set to email", async () => {
    const res = await fetch(`${ts.url}/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        identifier: "login-test@example.com",
        password: "correct-password",
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.email).toBe("login-test@example.com");
    expect(body.username).toBe("logintester");
  });

  test("logs in via `identifier` set to username (case-insensitive)", async () => {
    const res = await fetch(`${ts.url}/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        identifier: "LoginTester",
        password: "correct-password",
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.email).toBe("login-test@example.com");
    expect(body.username).toBe("logintester");

    const token = extractCookie(res, "__Host-session");
    expect(token).not.toBeNull();
  });

  test("rejects unknown username with same generic message as email", async () => {
    const res = await fetch(`${ts.url}/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        identifier: "ghost_user",
        password: "correct-password",
      }),
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.message).toBe("Invalid email or password");
  });

  test("rejects login for unverified email", async () => {
    const res = await fetch(`${ts.url}/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "unverified-login@example.com",
        password: "correct-password",
      }),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("EMAIL_NOT_VERIFIED");
  });

  test("rejects wrong password", async () => {
    const res = await fetch(`${ts.url}/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "login-test@example.com",
        password: "wrong-password",
      }),
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.message).toBe("Invalid email or password");
  });

  test("rejects oversized password before hashing (DoS guard)", async () => {
    // 129 characters — any valid password is already way below this. The
    // check must short-circuit before verifyPassword so a multi-megabyte
    // login attempt can't tie up the event loop with Argon2id work.
    const res = await fetch(`${ts.url}/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "login-test@example.com",
        password: "x".repeat(129),
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toContain("128 characters");
  });

  test("rejects unknown email", async () => {
    const res = await fetch(`${ts.url}/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "nobody@example.com",
        password: "password123",
      }),
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    // Same generic message — don't leak whether email exists
    expect(body.error.message).toBe("Invalid email or password");
  });

  test("rejects missing fields", async () => {
    const res = await fetch(`${ts.url}/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "login-test@example.com" }),
    });

    expect(res.status).toBe(400);
  });
});
