import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  startTestServer,
  authHeaders,
  registerAndLogin,
  type TestServer,
} from "../test-helpers";
import { sweepStaleServers } from "./servers";

let ts: TestServer;
let ownerToken: string;
let ownerAccountId: string;
let otherToken: string;

beforeAll(async () => {
  ts = await startTestServer();
  const owner = await registerAndLogin(ts, "owner");
  ownerToken = owner.token;
  ownerAccountId = owner.accountId;
  const other = await registerAndLogin(ts, "other");
  otherToken = other.token;
});

afterAll(async () => {
  await ts.shutdown();
});

describe("POST /v1/servers", () => {
  test("creates a server and returns server_id + server_secret", async () => {
    const res = await fetch(`${ts.url}/v1/servers`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(ownerToken) },
      body: JSON.stringify({ name: "Test Server", description: "A test", visibility: "public" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.server_id).toBeDefined();
    expect(typeof body.server_id).toBe("string");
    expect(body.server_secret).toBeDefined();
    expect(body.server_secret.length).toBe(64); // 32 bytes hex

    // Verify server_sync record was created
    const sync = await ts.sql`SELECT sync_version FROM server_sync WHERE server_id = ${body.server_id}`;
    expect(sync.length).toBe(1);
    expect(sync[0]!.sync_version).toBe(1);
  });

  test("returns 400 for missing name", async () => {
    const res = await fetch(`${ts.url}/v1/servers`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(ownerToken) },
      body: JSON.stringify({ description: "no name" }),
    });
    expect(res.status).toBe(400);
  });

  test("returns 400 for invalid visibility", async () => {
    const res = await fetch(`${ts.url}/v1/servers`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(ownerToken) },
      body: JSON.stringify({ name: "Bad Vis", visibility: "secret" }),
    });
    expect(res.status).toBe(400);
  });

  test("returns 401 without session", async () => {
    const res = await fetch(`${ts.url}/v1/servers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "No Auth" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("GET /v1/servers", () => {
  let publicServerId: string;

  beforeAll(async () => {
    // Create a public server and mark it online
    const res = await fetch(`${ts.url}/v1/servers`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(ownerToken) },
      body: JSON.stringify({ name: "Public Online", visibility: "public" }),
    });
    const body = await res.json();
    publicServerId = body.server_id;
    // Directory listing now requires a fresh heartbeat AND a non-null tunnel_url
    // (see SERVER_STALE_INTERVAL hygiene filters), so a server marked online must
    // also carry both to be advertised.
    await ts.sql`
      UPDATE servers
      SET is_online = true,
          last_heartbeat_at = now(),
          tunnel_url = 'https://public-online.trycloudflare.com',
          tunnel_state = 'named'
      WHERE id = ${publicServerId}
    `;

    // Create a private server
    await fetch(`${ts.url}/v1/servers`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(ownerToken) },
      body: JSON.stringify({ name: "Private Hidden", visibility: "private" }),
    });
  });

  test("returns only public online servers", async () => {
    const res = await fetch(`${ts.url}/v1/servers`, {
      headers: authHeaders(ownerToken),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.servers).toBeDefined();
    expect(body.total).toBeGreaterThanOrEqual(1);

    const names = body.servers.map((s: { name: string }) => s.name);
    expect(names).toContain("Public Online");
    expect(names).not.toContain("Private Hidden");
  });

  test("search filters by name", async () => {
    const res = await fetch(`${ts.url}/v1/servers?search=Public`, {
      headers: authHeaders(ownerToken),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.servers.length).toBeGreaterThanOrEqual(1);
    for (const s of body.servers) {
      expect((s as { name: string }).name.toLowerCase()).toContain("public");
    }
  });

  test("returns 401 without session", async () => {
    const res = await fetch(`${ts.url}/v1/servers`);
    expect(res.status).toBe(401);
  });
});

describe("GET /v1/servers — directory hygiene", () => {
  // Helper: create a public server and force its liveness/tunnel columns to an
  // arbitrary state, bypassing the heartbeat path so each case is isolated.
  async function makeServer(
    name: string,
    cols: {
      is_online: boolean;
      heartbeatAgo: string; // SQL interval, e.g. "1 minute" / "31 minutes"
      tunnel_url: string | null;
      tunnel_state: string | null;
    },
  ): Promise<string> {
    const res = await fetch(`${ts.url}/v1/servers`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(ownerToken) },
      body: JSON.stringify({ name, visibility: "public" }),
    });
    const id = (await res.json()).server_id as string;
    await ts.sql`
      UPDATE servers
      SET is_online = ${cols.is_online},
          last_heartbeat_at = now() - ${cols.heartbeatAgo}::interval,
          tunnel_url = ${cols.tunnel_url},
          tunnel_state = ${cols.tunnel_state}
      WHERE id = ${id}
    `;
    return id;
  }

  async function directoryNames(): Promise<string[]> {
    const res = await fetch(`${ts.url}/v1/servers?per_page=100`, {
      headers: authHeaders(ownerToken),
    });
    const body = await res.json();
    return body.servers.map((s: { name: string }) => s.name);
  }

  test("excludes a server whose last heartbeat is older than the liveness window", async () => {
    const id = await makeServer("Stale Directory Server", {
      is_online: true,
      heartbeatAgo: "31 minutes",
      tunnel_url: "https://stale.trycloudflare.com",
      tunnel_state: "demo",
    });
    expect(await directoryNames()).not.toContain("Stale Directory Server");

    // And its detail view reports is_online=false (derived from staleness),
    // even though the stored column still says true.
    const detail = await fetch(`${ts.url}/v1/servers/${id}`, {
      headers: authHeaders(ownerToken),
    });
    expect((await detail.json()).is_online).toBe(false);
  });

  test("excludes a fresh server with a null tunnel_url", async () => {
    await makeServer("Null Tunnel Server", {
      is_online: true,
      heartbeatAgo: "1 minute",
      tunnel_url: null,
      tunnel_state: null,
    });
    expect(await directoryNames()).not.toContain("Null Tunnel Server");
  });

  test("excludes a fresh server whose tunnel_state is expired", async () => {
    await makeServer("Expired Tunnel Server", {
      is_online: true,
      heartbeatAgo: "1 minute",
      tunnel_url: "https://expired.trycloudflare.com",
      tunnel_state: "expired",
    });
    expect(await directoryNames()).not.toContain("Expired Tunnel Server");
  });

  test("includes a fresh, tunneled, non-expired server and surfaces tunnel_state", async () => {
    await makeServer("Healthy Directory Server", {
      is_online: true,
      heartbeatAgo: "1 minute",
      tunnel_url: "https://healthy.trycloudflare.com",
      tunnel_state: "demo",
    });
    const res = await fetch(`${ts.url}/v1/servers?per_page=100`, {
      headers: authHeaders(ownerToken),
    });
    const body = await res.json();
    const row = body.servers.find(
      (s: { name: string }) => s.name === "Healthy Directory Server",
    );
    expect(row).toBeDefined();
    expect(row.tunnel_state).toBe("demo");
    expect(row.is_online).toBe(true);
  });

  test("sweepStaleServers flips is_online=false for quiet servers and leaves fresh ones", async () => {
    const staleId = await makeServer("Sweep Stale", {
      is_online: true,
      heartbeatAgo: "31 minutes",
      tunnel_url: "https://sweep-stale.trycloudflare.com",
      tunnel_state: "demo",
    });
    const freshId = await makeServer("Sweep Fresh", {
      is_online: true,
      heartbeatAgo: "1 minute",
      tunnel_url: "https://sweep-fresh.trycloudflare.com",
      tunnel_state: "demo",
    });

    const swept = await sweepStaleServers(ts.sql);
    expect(swept).toBeGreaterThanOrEqual(1);

    const staleRow =
      await ts.sql`SELECT is_online FROM servers WHERE id = ${staleId}`;
    expect(staleRow[0]!.is_online).toBe(false);
    const freshRow =
      await ts.sql`SELECT is_online FROM servers WHERE id = ${freshId}`;
    expect(freshRow[0]!.is_online).toBe(true);
  });
});

describe("GET /v1/servers/:id", () => {
  let serverId: string;

  beforeAll(async () => {
    const res = await fetch(`${ts.url}/v1/servers`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(ownerToken) },
      body: JSON.stringify({ name: "Detail Server" }),
    });
    const body = await res.json();
    serverId = body.server_id;
  });

  test("returns server details", async () => {
    const res = await fetch(`${ts.url}/v1/servers/${serverId}`, {
      headers: authHeaders(ownerToken),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(serverId);
    expect(body.name).toBe("Detail Server");
    expect(body.owner_id).toBe(ownerAccountId);
    // Must not include server_secret_hash
    expect(body.server_secret_hash).toBeUndefined();
  });

  test("returns 404 for non-existent server", async () => {
    const res = await fetch(
      `${ts.url}/v1/servers/00000000-0000-0000-0000-000000000000`,
      { headers: authHeaders(ownerToken) },
    );
    expect(res.status).toBe(404);
  });
});

describe("PATCH /v1/servers/:id", () => {
  let serverId: string;

  beforeAll(async () => {
    const res = await fetch(`${ts.url}/v1/servers`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(ownerToken) },
      body: JSON.stringify({ name: "Patchable" }),
    });
    const body = await res.json();
    serverId = body.server_id;
  });

  test("owner can update name and visibility", async () => {
    const res = await fetch(`${ts.url}/v1/servers/${serverId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authHeaders(ownerToken) },
      body: JSON.stringify({ name: "Renamed", visibility: "public" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("Renamed");
    expect(body.visibility).toBe("public");
  });

  test("non-owner gets 403", async () => {
    const res = await fetch(`${ts.url}/v1/servers/${serverId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authHeaders(otherToken) },
      body: JSON.stringify({ name: "Hijacked" }),
    });
    expect(res.status).toBe(403);
  });

  test("returns 400 for empty update", async () => {
    const res = await fetch(`${ts.url}/v1/servers/${serverId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authHeaders(ownerToken) },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /v1/servers/:id", () => {
  let serverId: string;

  beforeAll(async () => {
    const res = await fetch(`${ts.url}/v1/servers`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(ownerToken) },
      body: JSON.stringify({ name: "Deletable" }),
    });
    const body = await res.json();
    serverId = body.server_id;
  });

  test("non-owner gets 403", async () => {
    const res = await fetch(`${ts.url}/v1/servers/${serverId}`, {
      method: "DELETE",
      headers: authHeaders(otherToken),
    });
    expect(res.status).toBe(403);
  });

  test("owner can delete, subsequent GET returns 404", async () => {
    const res = await fetch(`${ts.url}/v1/servers/${serverId}`, {
      method: "DELETE",
      headers: authHeaders(ownerToken),
    });
    expect(res.status).toBe(204);

    const getRes = await fetch(`${ts.url}/v1/servers/${serverId}`, {
      headers: authHeaders(ownerToken),
    });
    expect(getRes.status).toBe(404);
  });
});
