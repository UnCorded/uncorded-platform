import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { startTestServer, type TestServer } from "./test-helpers";

let ts: TestServer;

beforeAll(async () => {
  ts = await startTestServer();
});

afterAll(async () => {
  await ts.shutdown();
});

describe("GET /health", () => {
  test("returns ok status with boot identity and live db ping", async () => {
    const res = await fetch(`${ts.url}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(typeof body.version).toBe("string");
    expect(body.version.length).toBeGreaterThan(0);
    expect(typeof body.commit).toBe("string");
    expect(body.commit.length).toBeGreaterThan(0);
    expect(typeof body.uptime_s).toBe("number");
    expect(body.uptime_s).toBeGreaterThanOrEqual(0);
    expect(body.db.state).toBe("ok");
    expect(typeof body.db.latency_ms).toBe("number");
    expect(body.db.latency_ms).toBeGreaterThanOrEqual(0);
  });

  test("returns 503 degraded when db is unreachable", async () => {
    // Closing the pool makes every subsequent query throw immediately, which
    // is the cheapest way to exercise the failure branch without standing up
    // a second test server.
    const downTs = await startTestServer({ dbName: "uncorded_central_health_down" });
    await downTs.sql.end();
    const res = await fetch(`${downTs.url}/health`);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.status).toBe("degraded");
    expect(body.db.state).toBe("down");
    // Error envelope must not leak driver details — db.state is the only
    // structured signal callers should see for a down database.
    expect(JSON.stringify(body)).not.toMatch(/postgres|connection|ECONN|password/i);
    downTs.server.stop();
  });
});

describe("unknown routes", () => {
  test("returns 404 for unknown path", async () => {
    const res = await fetch(`${ts.url}/v1/nonexistent`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("NOT_FOUND");
  });
});
