import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  startTestServer,
  authHeaders,
  registerAndLogin,
  type TestServer,
} from "../test-helpers";
import { createRateLimiter } from "../middleware";
import { createRouter } from "../routes";
import { ensureSigningKey } from "../crypto";
import { createLogger } from "@uncorded/shared";

let ts: TestServer;
let userToken: string;
let publisherId: string;
let testPluginSlug: string;
let testPluginId: string;

beforeAll(async () => {
  ts = await startTestServer();
  const user = await registerAndLogin(ts, "reporter");
  userToken = user.token;
  publisherId = user.accountId;

  // Seed a plugin to report
  testPluginSlug = "reportable-plugin";
  const rows = await ts.sql`
    INSERT INTO plugins (slug, name, description, publisher_id)
    VALUES (${testPluginSlug}, 'Reportable Plugin', 'A plugin to report', ${publisherId})
    RETURNING id
  `;
  testPluginId = (rows[0] as { id: string }).id;
});

afterAll(async () => {
  await ts.shutdown();
});

describe("POST /v1/plugins/:slug/report", () => {
  test("returns 201 with valid reason", async () => {
    const res = await fetch(`${ts.url}/v1/plugins/${testPluginSlug}/report`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(userToken) },
      body: JSON.stringify({ reason: "malicious_code", evidence: "It phones home" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { message: string };
    expect(body.message).toBe("Report submitted");

    // Verify report was inserted
    const reports = await ts.sql`SELECT * FROM reports WHERE target_id = ${testPluginId}`;
    expect(reports.length).toBeGreaterThan(0);
  });

  test("returns 400 for invalid reason", async () => {
    const res = await fetch(`${ts.url}/v1/plugins/${testPluginSlug}/report`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(userToken) },
      body: JSON.stringify({ reason: "not_a_valid_reason" }),
    });
    expect(res.status).toBe(400);
  });

  test("returns 400 for missing reason", async () => {
    const res = await fetch(`${ts.url}/v1/plugins/${testPluginSlug}/report`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(userToken) },
      body: JSON.stringify({ evidence: "some evidence" }),
    });
    expect(res.status).toBe(400);
  });

  test("returns 400 for evidence exceeding length cap", async () => {
    const res = await fetch(`${ts.url}/v1/plugins/${testPluginSlug}/report`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(userToken) },
      body: JSON.stringify({
        reason: "other",
        evidence: "x".repeat(2049),
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain("2048 characters");
  });

  test("returns 404 for unknown slug", async () => {
    const res = await fetch(`${ts.url}/v1/plugins/no-such-plugin-xyz/report`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(userToken) },
      body: JSON.stringify({ reason: "other" }),
    });
    expect(res.status).toBe(404);
  });

  test("returns 401 without session", async () => {
    const res = await fetch(`${ts.url}/v1/plugins/${testPluginSlug}/report`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "other" }),
    });
    expect(res.status).toBe(401);
  });

  test("6th report from same account returns 429 (real rate limiter)", async () => {
    // Start a second server with the real rate limiter (not the permissive mock)
    const realRateLimiter = createRateLimiter();
    process.env["SIGNING_KEY_SECRET"] = "test-signing-key-secret-32chars!";
    await ensureSigningKey(ts.sql);

    const route = createRouter({
      sql: ts.sql,
      rateLimiter: realRateLimiter,
      logger: createLogger({ component: "test-rate-limit" }),
      emailClient: null,
      appBaseUrl: "http://localhost:4000",
      r2: null,
      bootInfo: { version: "test", commit: "test", startedAt: Date.now() },
    });

    const rateLimitServer = Bun.serve({ port: 0, fetch: route });
    const rateLimitUrl = `http://localhost:${rateLimitServer.port}`;

    try {
      // Register and login via the main ts URL (shares same DB)
      const rlUser = await registerAndLogin(ts, "rl-reporter");
      const rlToken = rlUser.token;

      // Seed a plugin to report (reuse existing or use a new one)
      const rlSlug = "rate-limit-test-plugin";
      const existing = await ts.sql`SELECT id FROM plugins WHERE slug = ${rlSlug}`;
      if (!existing[0]) {
        await ts.sql`
          INSERT INTO plugins (slug, name, description, publisher_id)
          VALUES (${rlSlug}, 'RL Test Plugin', 'desc', ${publisherId})
        `;
      }

      // 5 reports should succeed
      for (let i = 0; i < 5; i++) {
        const res = await fetch(`${rateLimitUrl}/v1/plugins/${rlSlug}/report`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders(rlToken) },
          body: JSON.stringify({ reason: "other" }),
        });
        expect(res.status).toBe(201);
      }

      // 6th should be rate limited
      const res6 = await fetch(`${rateLimitUrl}/v1/plugins/${rlSlug}/report`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders(rlToken) },
        body: JSON.stringify({ reason: "other" }),
      });
      expect(res6.status).toBe(429);
    } finally {
      rateLimitServer.stop();
    }
  });
});
