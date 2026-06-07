import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  startTestServer,
  authHeaders,
  registerAndLogin,
  type TestServer,
} from "../test-helpers";

let ts: TestServer;
let ownerToken: string;
let otherToken: string;
let serverId: string;
let serverSecret: string;

beforeAll(async () => {
  ts = await startTestServer();
  const owner = await registerAndLogin(ts, "rotateowner");
  ownerToken = owner.token;

  const other = await registerAndLogin(ts, "rotateother");
  otherToken = other.token;

  const res = await fetch(`${ts.url}/v1/servers`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(ownerToken) },
    body: JSON.stringify({ name: "Rotate Secret Server" }),
  });
  const body = await res.json();
  serverId = body.server_id;
  serverSecret = body.server_secret;
});

afterAll(async () => {
  await ts.shutdown();
});

describe("POST /v1/servers/:id/secret/rotate", () => {
  test("returns 401 without auth", async () => {
    const res = await fetch(`${ts.url}/v1/servers/${serverId}/secret/rotate`, {
      method: "POST",
    });
    expect(res.status).toBe(401);
  });

  test("returns 403 for non-owner", async () => {
    const res = await fetch(`${ts.url}/v1/servers/${serverId}/secret/rotate`, {
      method: "POST",
      headers: authHeaders(otherToken),
    });
    expect(res.status).toBe(403);
  });

  test("returns 404 for unknown server", async () => {
    const res = await fetch(
      `${ts.url}/v1/servers/00000000-0000-0000-0000-000000000000/secret/rotate`,
      {
        method: "POST",
        headers: authHeaders(ownerToken),
      },
    );
    expect(res.status).toBe(404);
  });

  test("returns new server_secret for owner", async () => {
    const res = await fetch(`${ts.url}/v1/servers/${serverId}/secret/rotate`, {
      method: "POST",
      headers: authHeaders(ownerToken),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.server_secret).toBe("string");
    expect(body.server_secret.length).toBeGreaterThan(0);
    expect(body.server_secret).not.toBe(serverSecret);
  });

  test("old secret no longer works for heartbeat after rotation", async () => {
    // Rotate secret
    const rotateRes = await fetch(
      `${ts.url}/v1/servers/${serverId}/secret/rotate`,
      {
        method: "POST",
        headers: authHeaders(ownerToken),
      },
    );
    const { server_secret: newSecret } = await rotateRes.json();

    // Old secret should fail
    const oldHeartbeat = await fetch(
      `${ts.url}/v1/servers/${serverId}/heartbeat`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ server_secret: serverSecret, last_sync_version: 0 }),
      },
    );
    expect(oldHeartbeat.status).toBe(401);

    // New secret should succeed
    const newHeartbeat = await fetch(
      `${ts.url}/v1/servers/${serverId}/heartbeat`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          server_secret: newSecret,
          last_sync_version: 0,
          tunnel_url: "https://test.example.com",
          runtime_version: "1.0.0",
          connected_users: 0,
          plugin_count: 0,
        }),
      },
    );
    expect(newHeartbeat.status).toBe(200);

    // Update serverSecret for later tests in case they use it
    serverSecret = newSecret as string;
  });
});
