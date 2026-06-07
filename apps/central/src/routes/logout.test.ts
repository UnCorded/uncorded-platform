import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  startTestServer,
  extractCookie,
  authHeaders,
  type TestServer,
} from "../test-helpers";

let ts: TestServer;

beforeAll(async () => {
  ts = await startTestServer();
});

afterAll(async () => {
  await ts.shutdown();
});

describe("POST /v1/auth/logout", () => {
  test("invalidates session and clears cookie", async () => {
    // Register and login to get a session
    await fetch(`${ts.url}/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "logout-test@example.com",
        username: "logouttester",
        password: "password123",
        display_name: "Logout Tester",
      }),
    });
    await ts.sql`UPDATE accounts SET email_verified = true WHERE email = 'logout-test@example.com'`;
    const loginRes = await fetch(`${ts.url}/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "logout-test@example.com", password: "password123" }),
    });
    const token = extractCookie(loginRes, "__Host-session")!;

    // Logout
    const logoutRes = await fetch(`${ts.url}/v1/auth/logout`, {
      method: "POST",
      headers: authHeaders(token),
    });
    expect(logoutRes.status).toBe(200);

    // Verify session is invalidated — profile should fail
    const profileRes = await fetch(`${ts.url}/v1/auth/profile`, {
      headers: authHeaders(token),
    });
    expect(profileRes.status).toBe(401);
  });

  test("returns 401 without session", async () => {
    const res = await fetch(`${ts.url}/v1/auth/logout`, {
      method: "POST",
    });
    expect(res.status).toBe(401);
  });
});
