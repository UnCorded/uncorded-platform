import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  startTestServer,
  authHeaders,
  registerAndLogin,
  type TestServer,
} from "../test-helpers";

let ts: TestServer;
let serverId: string;
let serverSecret: string;

beforeAll(async () => {
  ts = await startTestServer();
  const owner = await registerAndLogin(ts, "hbowner");

  // Create a server
  const res = await fetch(`${ts.url}/v1/servers`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(owner.token),
    },
    body: JSON.stringify({ name: "Heartbeat Server" }),
  });
  const body = await res.json();
  serverId = body.server_id;
  serverSecret = body.server_secret;
});

afterAll(async () => {
  await ts.shutdown();
});

describe("POST /v1/servers/:id/heartbeat", () => {
  test("bootstrap heartbeat (last_sync_version=0) returns dirty with public keys", async () => {
    const res = await fetch(`${ts.url}/v1/servers/${serverId}/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        server_secret: serverSecret,
        last_sync_version: 0,
        tunnel_url: "https://abc.trycloudflare.com",
        runtime_version: "1.0.0",
        connected_users: 5,
        plugin_count: 3,
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.dirty).toBe(true);
    expect(Array.isArray(body.public_keys)).toBe(true);
  });

  test("steady-state heartbeat (last_sync_version matches) returns dirty=false", async () => {
    const res = await fetch(`${ts.url}/v1/servers/${serverId}/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        server_secret: serverSecret,
        last_sync_version: 999,
        tunnel_url: "https://abc.trycloudflare.com",
        runtime_version: "1.0.0",
        connected_users: 5,
        plugin_count: 3,
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.dirty).toBe(false);
  });

  test("updates server fields in database", async () => {
    await fetch(`${ts.url}/v1/servers/${serverId}/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        server_secret: serverSecret,
        last_sync_version: 0,
        tunnel_url: "https://updated.trycloudflare.com",
        tunnel_state: "demo",
        runtime_version: "1.1.0",
        connected_users: 12,
        plugin_count: 7,
      }),
    });

    const rows =
      await ts.sql`SELECT tunnel_url, tunnel_state, runtime_version, connected_users, plugin_count, is_online FROM servers WHERE id = ${serverId}`;
    const server = rows[0]!;
    expect(server.tunnel_url).toBe("https://updated.trycloudflare.com");
    expect(server.tunnel_state).toBe("demo");
    expect(server.runtime_version).toBe("1.1.0");
    expect(server.connected_users).toBe(12);
    expect(server.plugin_count).toBe(7);
    expect(server.is_online).toBe(true);
  });

  test("persists a changed tunnel_state and bumps updated_at; an unchanged one does not", async () => {
    // Land a known baseline state.
    await fetch(`${ts.url}/v1/servers/${serverId}/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        server_secret: serverSecret,
        last_sync_version: 0,
        tunnel_url: "https://state-test.trycloudflare.com",
        tunnel_state: "demo",
        runtime_version: "1.1.0",
        connected_users: 0,
        plugin_count: 0,
      }),
    });
    const before =
      await ts.sql`SELECT tunnel_state, updated_at FROM servers WHERE id = ${serverId}`;
    expect(before[0]!.tunnel_state).toBe("demo");
    const baselineUpdatedAt = before[0]!.updated_at;

    // A change to "expired" must persist and advance updated_at (it's the only
    // changed column — every other field is identical to the baseline above).
    await fetch(`${ts.url}/v1/servers/${serverId}/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        server_secret: serverSecret,
        last_sync_version: 0,
        tunnel_url: "https://state-test.trycloudflare.com",
        tunnel_state: "expired",
        runtime_version: "1.1.0",
        connected_users: 0,
        plugin_count: 0,
      }),
    });
    const afterChange =
      await ts.sql`SELECT tunnel_state, updated_at FROM servers WHERE id = ${serverId}`;
    expect(afterChange[0]!.tunnel_state).toBe("expired");
    expect(new Date(afterChange[0]!.updated_at as string).getTime()).toBeGreaterThan(
      new Date(baselineUpdatedAt as string).getTime(),
    );
    const changedUpdatedAt = afterChange[0]!.updated_at;

    // Re-sending the identical state must NOT advance updated_at — the state
    // UPDATE is gated by the IS DISTINCT FROM chain, so a no-op heartbeat is a
    // no-op write.
    await fetch(`${ts.url}/v1/servers/${serverId}/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        server_secret: serverSecret,
        last_sync_version: 0,
        tunnel_url: "https://state-test.trycloudflare.com",
        tunnel_state: "expired",
        runtime_version: "1.1.0",
        connected_users: 0,
        plugin_count: 0,
      }),
    });
    const afterNoop =
      await ts.sql`SELECT updated_at FROM servers WHERE id = ${serverId}`;
    expect(new Date(afterNoop[0]!.updated_at as string).getTime()).toBe(
      new Date(changedUpdatedAt as string).getTime(),
    );
  });

  test("returns 401 for invalid secret", async () => {
    const res = await fetch(`${ts.url}/v1/servers/${serverId}/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        server_secret: "wrong-secret",
        last_sync_version: 0,
      }),
    });
    expect(res.status).toBe(401);
  });

  test("returns 400 for missing secret", async () => {
    const res = await fetch(`${ts.url}/v1/servers/${serverId}/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ last_sync_version: 0 }),
    });
    expect(res.status).toBe(400);
  });

  test("returns 404 for non-existent server", async () => {
    const res = await fetch(
      `${ts.url}/v1/servers/00000000-0000-0000-0000-000000000000/heartbeat`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          server_secret: serverSecret,
          last_sync_version: 0,
        }),
      },
    );
    expect(res.status).toBe(404);
  });

  test("returns dirty=true with deltas when sync version is ahead", async () => {
    // Manually insert a delta and bump sync version
    await ts.sql`UPDATE server_sync SET sync_version = 2 WHERE server_id = ${serverId}`;
    await ts.sql`
      INSERT INTO server_deltas (server_id, sync_version, delta_type, payload)
      VALUES
        (${serverId}, 1, 'user.profile_changed', ${'{"user_id":"u1","username":"newuser","display_name":"New"}'}::jsonb),
        (${serverId}, 2, 'user.banned', ${'{"user_id":"u2","reason":"spam"}'}::jsonb)
    `;

    const res = await fetch(`${ts.url}/v1/servers/${serverId}/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        server_secret: serverSecret,
        last_sync_version: 0,
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.dirty).toBe(true);
    expect(body.sync_version).toBe(2);
    expect(body.deltas.length).toBe(2);
    expect(body.deltas[0].type).toBe("user.profile_changed");
    expect(body.deltas[0].username).toBe("newuser");
    expect(body.deltas[0].display_name).toBe("New");
    expect(body.deltas[1].type).toBe("user.banned");
    expect(body.public_keys).toBeDefined();
    expect(body.public_keys.length).toBeGreaterThanOrEqual(1);
  });

  test("captures cf-connecting-ip into servers.last_heartbeat_ip", async () => {
    await fetch(`${ts.url}/v1/servers/${serverId}/heartbeat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "CF-Connecting-IP": "203.0.113.42",
      },
      body: JSON.stringify({
        server_secret: serverSecret,
        last_sync_version: 0,
      }),
    });

    const rows = await ts.sql`SELECT last_heartbeat_ip FROM servers WHERE id = ${serverId}`;
    expect(rows[0]!.last_heartbeat_ip).toBe("203.0.113.42");
  });

  test("echoes wan_ip in dirty response", async () => {
    const res = await fetch(`${ts.url}/v1/servers/${serverId}/heartbeat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "CF-Connecting-IP": "198.51.100.7",
      },
      body: JSON.stringify({
        server_secret: serverSecret,
        last_sync_version: 0,
      }),
    });
    const body = await res.json();
    expect(body.dirty).toBe(true);
    expect(body.wan_ip).toBe("198.51.100.7");
  });

  test("echoes wan_ip in dirty=false response", async () => {
    // Bring server up-to-date.
    const r1 = await fetch(`${ts.url}/v1/servers/${serverId}/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.99" },
      body: JSON.stringify({ server_secret: serverSecret, last_sync_version: 0 }),
    });
    const b1 = await r1.json();
    const synced = b1.sync_version ?? 0;

    const res = await fetch(`${ts.url}/v1/servers/${serverId}/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.99" },
      body: JSON.stringify({
        server_secret: serverSecret,
        last_sync_version: synced + 1000, // ahead → dirty=false branch
      }),
    });
    const body = await res.json();
    expect(body.dirty).toBe(false);
    expect(body.wan_ip).toBe("203.0.113.99");
  });

  test("omits wan_ip when client IP is unknown (direct dev request)", async () => {
    // No CF header, no XFF — getClientIp returns "unknown" → response omits wan_ip.
    const res = await fetch(`${ts.url}/v1/servers/${serverId}/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ server_secret: serverSecret, last_sync_version: 0 }),
    });
    const body = await res.json();
    expect(body.wan_ip).toBeUndefined();
  });

  test("returns full_snapshot=true when deltas are stale", async () => {
    // Bump sync version but make all deltas older than 24h
    await ts.sql`UPDATE server_sync SET sync_version = 10 WHERE server_id = ${serverId}`;
    await ts.sql`DELETE FROM server_deltas WHERE server_id = ${serverId}`;
    await ts.sql`
      INSERT INTO server_deltas (server_id, sync_version, delta_type, payload, created_at)
      VALUES (${serverId}, 5, 'user.banned', ${'{"user_id":"old"}'}::jsonb, now() - interval '48 hours')
    `;

    const res = await fetch(`${ts.url}/v1/servers/${serverId}/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        server_secret: serverSecret,
        last_sync_version: 0,
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.dirty).toBe(true);
    expect(body.sync_version).toBe(10);
    expect(body.full_snapshot).toBe(true);
    expect(body.deltas).toEqual([]);
  });
});
