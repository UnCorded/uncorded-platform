import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  startTestServer,
  authHeaders,
  registerAndLogin,
  type TestServer,
} from "../test-helpers";
import { sweepStaleServers, sweepAbandonedDeletes } from "./servers";

let ts: TestServer;
let ownerToken: string;
let otherToken: string;
// Second creator account for the detail/patch/delete describes — the owned
// quota (MAX_OWNED_SERVERS) caps creates per account, so this file spreads
// its fixture servers across accounts instead of piling them on one.
let crudToken: string;
let crudAccountId: string;

beforeAll(async () => {
  ts = await startTestServer();
  const owner = await registerAndLogin(ts, "owner");
  ownerToken = owner.token;
  const other = await registerAndLogin(ts, "other");
  otherToken = other.token;
  const crud = await registerAndLogin(ts, "crudowner");
  crudToken = crud.token;
  crudAccountId = crud.accountId;
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
  // Each server gets its own throwaway creator account so this describe can
  // grow without bumping into the per-account owned quota.
  let hygieneSeq = 0;
  async function makeServer(
    name: string,
    cols: {
      is_online: boolean;
      heartbeatAgo: string; // SQL interval, e.g. "1 minute" / "31 minutes"
      tunnel_url: string | null;
      tunnel_state: string | null;
    },
  ): Promise<string> {
    const creator = await registerAndLogin(ts, `hygiene${hygieneSeq++}`);
    const res = await fetch(`${ts.url}/v1/servers`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(creator.token) },
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
      headers: { "Content-Type": "application/json", ...authHeaders(crudToken) },
      body: JSON.stringify({ name: "Detail Server" }),
    });
    const body = await res.json();
    serverId = body.server_id;
  });

  test("returns server details", async () => {
    const res = await fetch(`${ts.url}/v1/servers/${serverId}`, {
      headers: authHeaders(crudToken),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(serverId);
    expect(body.name).toBe("Detail Server");
    expect(body.owner_id).toBe(crudAccountId);
    // Must not include server_secret_hash
    expect(body.server_secret_hash).toBeUndefined();
  });

  test("returns 404 for non-existent server", async () => {
    const res = await fetch(
      `${ts.url}/v1/servers/00000000-0000-0000-0000-000000000000`,
      { headers: authHeaders(crudToken) },
    );
    expect(res.status).toBe(404);
  });
});

describe("PATCH /v1/servers/:id", () => {
  let serverId: string;

  beforeAll(async () => {
    const res = await fetch(`${ts.url}/v1/servers`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(crudToken) },
      body: JSON.stringify({ name: "Patchable" }),
    });
    const body = await res.json();
    serverId = body.server_id;
  });

  test("owner can update name and visibility", async () => {
    const res = await fetch(`${ts.url}/v1/servers/${serverId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authHeaders(crudToken) },
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
      headers: { "Content-Type": "application/json", ...authHeaders(crudToken) },
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
      headers: { "Content-Type": "application/json", ...authHeaders(crudToken) },
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

  test("owner delete marks deleting (202); server reads as gone everywhere", async () => {
    const res = await fetch(`${ts.url}/v1/servers/${serverId}`, {
      method: "DELETE",
      headers: authHeaders(crudToken),
    });
    expect(res.status).toBe(202);
    expect((await res.json()).status).toBe("deleting");

    // The row survives (quota slot held) but every read path answers 404.
    const dbRow = await ts.sql`
      SELECT deleted_at FROM servers WHERE id = ${serverId}
    `;
    expect(dbRow.length).toBe(1);
    expect(dbRow[0]!.deleted_at).not.toBeNull();

    const getRes = await fetch(`${ts.url}/v1/servers/${serverId}`, {
      headers: authHeaders(crudToken),
    });
    expect(getRes.status).toBe(404);

    const tokenRes = await fetch(`${ts.url}/v1/auth/token/server`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(crudToken) },
      body: JSON.stringify({ server_id: serverId }),
    });
    expect(tokenRes.status).toBe(404);

    // Re-deleting is idempotent.
    const again = await fetch(`${ts.url}/v1/servers/${serverId}`, {
      method: "DELETE",
      headers: authHeaders(crudToken),
    });
    expect(again.status).toBe(202);
  });

  test("purge-confirm hard-deletes the row; repeat answers 404", async () => {
    const confirm = await fetch(`${ts.url}/v1/servers/${serverId}/purge-confirm`, {
      method: "POST",
      headers: authHeaders(crudToken),
    });
    expect(confirm.status).toBe(204);

    const dbRow = await ts.sql`SELECT 1 FROM servers WHERE id = ${serverId}`;
    expect(dbRow.length).toBe(0);

    const again = await fetch(`${ts.url}/v1/servers/${serverId}/purge-confirm`, {
      method: "POST",
      headers: authHeaders(crudToken),
    });
    expect(again.status).toBe(404);
  });

  test("purge-confirm on a live server is 409; non-owner is 403", async () => {
    const res = await fetch(`${ts.url}/v1/servers`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(crudToken) },
      body: JSON.stringify({ name: "Still Alive" }),
    });
    const liveId = (await res.json()).server_id as string;

    const live = await fetch(`${ts.url}/v1/servers/${liveId}/purge-confirm`, {
      method: "POST",
      headers: authHeaders(crudToken),
    });
    expect(live.status).toBe(409);

    await fetch(`${ts.url}/v1/servers/${liveId}`, {
      method: "DELETE",
      headers: authHeaders(crudToken),
    });
    const nonOwner = await fetch(`${ts.url}/v1/servers/${liveId}/purge-confirm`, {
      method: "POST",
      headers: authHeaders(otherToken),
    });
    expect(nonOwner.status).toBe(403);
  });

  test("abandoned-delete reaper frees rows past the handshake window", async () => {
    const res = await fetch(`${ts.url}/v1/servers`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(crudToken) },
      body: JSON.stringify({ name: "Abandoned" }),
    });
    const abandonedId = (await res.json()).server_id as string;
    await fetch(`${ts.url}/v1/servers/${abandonedId}`, {
      method: "DELETE",
      headers: authHeaders(crudToken),
    });
    await ts.sql`
      UPDATE servers SET deleted_at = now() - interval '8 days'
      WHERE id = ${abandonedId}
    `;

    const reaped = await sweepAbandonedDeletes(ts.sql);
    expect(reaped).toBeGreaterThanOrEqual(1);
    const gone = await ts.sql`SELECT 1 FROM servers WHERE id = ${abandonedId}`;
    expect(gone.length).toBe(0);
  });
});

describe("capability hardening — tunnel_url never leaves the directory", () => {
  let hardOwnerToken: string;
  let hardServerId: string;

  beforeAll(async () => {
    const owner = await registerAndLogin(ts, "hardowner");
    hardOwnerToken = owner.token;
    const res = await fetch(`${ts.url}/v1/servers`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(hardOwnerToken) },
      body: JSON.stringify({ name: "Capability Server", visibility: "public" }),
    });
    hardServerId = (await res.json()).server_id;
    await ts.sql`
      UPDATE servers
      SET is_online = true,
          last_heartbeat_at = now(),
          tunnel_url = 'https://secret-endpoint.trycloudflare.com',
          tunnel_state = 'named'
      WHERE id = ${hardServerId}
    `;
  });

  test("GET /v1/servers responses carry no tunnel_url (regression: URL leak)", async () => {
    const res = await fetch(`${ts.url}/v1/servers?per_page=100`, {
      headers: authHeaders(hardOwnerToken),
    });
    const body = await res.json();
    const row = body.servers.find(
      (s: { name: string }) => s.name === "Capability Server",
    );
    expect(row).toBeDefined();
    expect("tunnel_url" in row).toBe(false);
    expect(JSON.stringify(body)).not.toContain("secret-endpoint");
  });

  test("GET /v1/servers/:id carries no tunnel_url, even for the owner", async () => {
    const res = await fetch(`${ts.url}/v1/servers/${hardServerId}`, {
      headers: authHeaders(hardOwnerToken),
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect("tunnel_url" in body).toBe(false);
    // Status fields the owner needs are still present.
    expect(body.tunnel_state).toBe("named");
    expect(body.is_online).toBe(true);
  });

  test("PATCH /v1/servers/:id response carries no tunnel_url", async () => {
    const res = await fetch(`${ts.url}/v1/servers/${hardServerId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authHeaders(hardOwnerToken) },
      body: JSON.stringify({ description: "patched" }),
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect("tunnel_url" in body).toBe(false);
  });
});

describe("GET /v1/servers/:id — private servers are invisible to non-members", () => {
  let privOwnerToken: string;
  let privServerId: string;

  beforeAll(async () => {
    const owner = await registerAndLogin(ts, "privowner");
    privOwnerToken = owner.token;
    const res = await fetch(`${ts.url}/v1/servers`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(privOwnerToken) },
      body: JSON.stringify({ name: "Invisible Server", visibility: "private" }),
    });
    privServerId = (await res.json()).server_id;
  });

  test("non-member gets 404, not 403 (regression: existence leak)", async () => {
    const stranger = await registerAndLogin(ts, "privstranger");
    const res = await fetch(`${ts.url}/v1/servers/${privServerId}`, {
      headers: authHeaders(stranger.token),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("NOT_FOUND");
  });

  test("banned member gets 404 too", async () => {
    const banned = await registerAndLogin(ts, "privbanned");
    await ts.sql`
      INSERT INTO server_members (server_id, account_id, role, status)
      VALUES (${privServerId}, ${banned.accountId}, 'member', 'banned')
    `;
    const res = await fetch(`${ts.url}/v1/servers/${privServerId}`, {
      headers: authHeaders(banned.token),
    });
    expect(res.status).toBe(404);
  });

  test("active member and owner still see it", async () => {
    const member = await registerAndLogin(ts, "privmember");
    await ts.sql`
      INSERT INTO server_members (server_id, account_id, role, status)
      VALUES (${privServerId}, ${member.accountId}, 'member', 'active')
    `;
    const memberRes = await fetch(`${ts.url}/v1/servers/${privServerId}`, {
      headers: authHeaders(member.token),
    });
    expect(memberRes.status).toBe(200);

    const ownerRes = await fetch(`${ts.url}/v1/servers/${privServerId}`, {
      headers: authHeaders(privOwnerToken),
    });
    expect(ownerRes.status).toBe(200);
  });
});
