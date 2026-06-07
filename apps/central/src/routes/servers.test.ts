import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  startTestServer,
  authHeaders,
  registerAndLogin,
  type TestServer,
} from "../test-helpers";

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
    await ts.sql`UPDATE servers SET is_online = true WHERE id = ${publicServerId}`;

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
