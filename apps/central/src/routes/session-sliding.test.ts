import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  startTestServer,
  authHeaders,
  registerAndLogin,
  type TestServer,
} from "../test-helpers";
import {
  SESSION_IDLE_MAX_AGE_MS,
  SESSION_ABSOLUTE_MAX_AGE_MS,
  SESSION_SLIDE_INTERVAL_MS,
} from "../middleware";
import { hashToken } from "../crypto";

let ts: TestServer;

beforeAll(async () => {
  ts = await startTestServer();
});

afterAll(async () => {
  await ts.shutdown();
});

async function getSessionRow(token: string): Promise<{
  idle_expires_at: Date;
  absolute_expires_at: Date;
} | null> {
  const tokenHash = await hashToken(token);
  const rows = await ts.sql`
    SELECT idle_expires_at, absolute_expires_at
    FROM sessions
    WHERE token_hash = ${tokenHash}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    idle_expires_at: row.idle_expires_at as Date,
    absolute_expires_at: row.absolute_expires_at as Date,
  };
}

describe("Sliding session window", () => {
  test("createSession sets idle ≈ now+7d and absolute ≈ now+30d", async () => {
    const { token } = await registerAndLogin(ts, "slide-create");
    const row = await getSessionRow(token);
    expect(row).not.toBeNull();

    const now = Date.now();
    const idleDelta = row!.idle_expires_at.getTime() - now;
    const absoluteDelta = row!.absolute_expires_at.getTime() - now;

    // 5-second tolerance for clock skew + setup latency.
    expect(idleDelta).toBeGreaterThan(SESSION_IDLE_MAX_AGE_MS - 5_000);
    expect(idleDelta).toBeLessThanOrEqual(SESSION_IDLE_MAX_AGE_MS);
    expect(absoluteDelta).toBeGreaterThan(SESSION_ABSOLUTE_MAX_AGE_MS - 5_000);
    expect(absoluteDelta).toBeLessThanOrEqual(SESSION_ABSOLUTE_MAX_AGE_MS);
  });

  test("authenticate does NOT bump idle within the slide interval", async () => {
    const { token } = await registerAndLogin(ts, "slide-noop");
    const before = await getSessionRow(token);
    expect(before).not.toBeNull();

    // Hit an authenticated endpoint immediately after login. The freshly
    // minted session has remaining ≈ 7d > 7d - 1h, so authenticate() must
    // NOT issue a write.
    const res = await fetch(`${ts.url}/v1/auth/profile`, { headers: authHeaders(token) });
    expect(res.status).toBe(200);

    const after = await getSessionRow(token);
    expect(after).not.toBeNull();
    expect(after!.idle_expires_at.getTime()).toBe(before!.idle_expires_at.getTime());
    // Absolute is set at create and must never move.
    expect(after!.absolute_expires_at.getTime()).toBe(before!.absolute_expires_at.getTime());
  });

  test("authenticate bumps idle once the slide interval has elapsed", async () => {
    const { token } = await registerAndLogin(ts, "slide-bump");
    const tokenHash = await hashToken(token);

    // Simulate the session having last bumped >1h ago by backdating
    // idle_expires_at to a value that triggers a bump on the next request.
    const staleIdle = new Date(
      Date.now() + (SESSION_IDLE_MAX_AGE_MS - SESSION_SLIDE_INTERVAL_MS) - 60_000,
    );
    await ts.sql`
      UPDATE sessions SET idle_expires_at = ${staleIdle}
      WHERE token_hash = ${tokenHash}
    `;

    const before = await getSessionRow(token);
    expect(before).not.toBeNull();

    const res = await fetch(`${ts.url}/v1/auth/profile`, { headers: authHeaders(token) });
    expect(res.status).toBe(200);

    const after = await getSessionRow(token);
    expect(after).not.toBeNull();
    // Idle moved forward by roughly SESSION_SLIDE_INTERVAL_MS + the 60s buffer.
    expect(after!.idle_expires_at.getTime()).toBeGreaterThan(before!.idle_expires_at.getTime());
    // Absolute did not move.
    expect(after!.absolute_expires_at.getTime()).toBe(before!.absolute_expires_at.getTime());
  });

  test("idle bump never extends past absolute_expires_at", async () => {
    const { token } = await registerAndLogin(ts, "slide-clamp");
    const tokenHash = await hashToken(token);

    // Pin absolute close to now so the bump's clamp kicks in.
    const tightAbsolute = new Date(Date.now() + 30 * 1000); // 30s
    const triggerIdle = new Date(Date.now() + 60 * 1000);   // 1m, well below 7d - 1h
    await ts.sql`
      UPDATE sessions
      SET absolute_expires_at = ${tightAbsolute}, idle_expires_at = ${triggerIdle}
      WHERE token_hash = ${tokenHash}
    `;

    const res = await fetch(`${ts.url}/v1/auth/profile`, { headers: authHeaders(token) });
    expect(res.status).toBe(200);

    const after = await getSessionRow(token);
    expect(after).not.toBeNull();
    // After the bump, idle should be clamped to absolute (LEAST in the UPDATE).
    expect(after!.idle_expires_at.getTime()).toBe(after!.absolute_expires_at.getTime());
  });

  test("expired idle window rejects the request", async () => {
    const { token } = await registerAndLogin(ts, "slide-idle-expired");
    const tokenHash = await hashToken(token);

    await ts.sql`
      UPDATE sessions SET idle_expires_at = now() - INTERVAL '1 second'
      WHERE token_hash = ${tokenHash}
    `;

    const res = await fetch(`${ts.url}/v1/auth/profile`, { headers: authHeaders(token) });
    expect(res.status).toBe(401);
  });

  test("expired absolute window rejects the request even if idle is fresh", async () => {
    const { token } = await registerAndLogin(ts, "slide-abs-expired");
    const tokenHash = await hashToken(token);

    // Idle is fine; absolute is not. The hard cap must win.
    await ts.sql`
      UPDATE sessions
      SET absolute_expires_at = now() - INTERVAL '1 second'
      WHERE token_hash = ${tokenHash}
    `;

    const res = await fetch(`${ts.url}/v1/auth/profile`, { headers: authHeaders(token) });
    expect(res.status).toBe(401);
  });

  test("session cookie Max-Age tracks the absolute window", async () => {
    const { token } = await registerAndLogin(ts, "slide-cookie");
    expect(token).toBeTruthy();

    const loginRes = await fetch(`${ts.url}/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "slide-cookie@example.com",
        password: "password123",
      }),
    });
    const setCookie = loginRes.headers.get("set-cookie") ?? "";
    const expectedMaxAge = `Max-Age=${SESSION_ABSOLUTE_MAX_AGE_MS / 1000}`;
    expect(setCookie).toContain(expectedMaxAge);
  });
});
