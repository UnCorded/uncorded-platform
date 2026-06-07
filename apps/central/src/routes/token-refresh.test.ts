import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  startTestServer,
  authHeaders,
  registerAndLogin,
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

describe("POST /v1/auth/token/refresh", () => {
  test("returns 401 without session cookie", async () => {
    const res = await fetch(`${ts.url}/v1/auth/token/refresh`, {
      method: "POST",
    });
    expect(res.status).toBe(401);
  });

  test("returns 204 with new session cookie", async () => {
    const { token } = await registerAndLogin(ts, "refresh1");

    const res = await fetch(`${ts.url}/v1/auth/token/refresh`, {
      method: "POST",
      headers: authHeaders(token),
    });

    expect(res.status).toBe(204);
    const newToken = extractCookie(res, "__Host-session");
    expect(newToken).toBeTruthy();
    expect(newToken).not.toBe(token);
  });

  test("old token no longer works after refresh", async () => {
    const { token } = await registerAndLogin(ts, "refresh2");

    await fetch(`${ts.url}/v1/auth/token/refresh`, {
      method: "POST",
      headers: authHeaders(token),
    });

    // Old token should be invalidated
    const profileRes = await fetch(`${ts.url}/v1/auth/profile`, {
      headers: authHeaders(token),
    });
    expect(profileRes.status).toBe(401);
  });

  test("new token works after refresh", async () => {
    const { token } = await registerAndLogin(ts, "refresh3");

    const refreshRes = await fetch(`${ts.url}/v1/auth/token/refresh`, {
      method: "POST",
      headers: authHeaders(token),
    });
    const newToken = extractCookie(refreshRes, "__Host-session")!;

    const profileRes = await fetch(`${ts.url}/v1/auth/profile`, {
      headers: authHeaders(newToken),
    });
    expect(profileRes.status).toBe(200);
  });

  test("new token has same cookie security attributes", async () => {
    const { token } = await registerAndLogin(ts, "refresh4");

    const res = await fetch(`${ts.url}/v1/auth/token/refresh`, {
      method: "POST",
      headers: authHeaders(token),
    });

    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Path=/");
  });
});
