/**
 * Full membership lifecycle integration test.
 *
 * Walks the complete social surface end-to-end against a real Postgres:
 *   create → invite → accept → token (URL rides with it) → leave → denied
 *   request → accept → token; ban → denied everywhere; unban → re-request
 *   delete → reads go dark, slot held → purge-confirm → slot freed
 *
 * Requires a real PostgreSQL connection. The suite is skipped unless the
 * DATABASE_URL environment variable is set (same gate as integration.test.ts).
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  startTestServer,
  authHeaders,
  registerAndLogin,
  type TestServer,
} from "../test-helpers";

const hasDatabase = !!process.env["DATABASE_URL"];

describe.skipIf(!hasDatabase)("Central API — membership lifecycle", () => {
  let ts: TestServer;
  let owner: { token: string; accountId: string; username: string };
  let alice: { token: string; accountId: string; username: string };
  let bob: { token: string; accountId: string; username: string };
  let serverId: string;
  let serverSecret: string;

  async function api(
    token: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    return fetch(`${ts.url}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...authHeaders(token) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }

  async function myServerIds(token: string): Promise<string[]> {
    const res = await api(token, "GET", "/v1/me/servers");
    const body = (await res.json()) as { servers: { id: string }[] };
    return body.servers.map((s) => s.id);
  }

  beforeAll(async () => {
    ts = await startTestServer({ dbName: "uncorded_central_test_mlc" });
    owner = await registerAndLogin(ts, "mlcowner");
    alice = await registerAndLogin(ts, "mlcalice");
    bob = await registerAndLogin(ts, "mlcbob");
  });

  afterAll(async () => {
    await ts.shutdown();
  });

  test("owner creates a public server; it lives in their memberships even offline", async () => {
    const res = await api(owner.token, "POST", "/v1/servers", {
      name: "Lifecycle Server",
      visibility: "public",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { server_id: string; server_secret: string };
    serverId = body.server_id;
    serverSecret = body.server_secret;

    // Never heartbeated — offline — yet present in /v1/me/servers. This is
    // the inactive-server guarantee the sidebar relies on.
    expect(await myServerIds(owner.token)).toContain(serverId);

    // And absent from the online-only public directory.
    const dir = await api(owner.token, "GET", "/v1/servers");
    const dirBody = (await dir.json()) as { servers: { id: string }[] };
    expect(dirBody.servers.map((s) => s.id)).not.toContain(serverId);
  });

  test("heartbeat brings it online; the tunnel URL is only revealed with the token", async () => {
    const hb = await fetch(`${ts.url}/v1/servers/${serverId}/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        server_secret: serverSecret,
        tunnel_url: "https://lifecycle.trycloudflare.com",
        tunnel_state: "demo",
        runtime_version: "0.1.0",
        connected_users: 0,
        plugin_count: 0,
      }),
    });
    expect(hb.status).toBe(200);

    const detail = await api(owner.token, "GET", `/v1/servers/${serverId}`);
    const detailBody = (await detail.json()) as Record<string, unknown>;
    expect(detailBody["is_online"]).toBe(true);
    expect("tunnel_url" in detailBody).toBe(false);

    const token = await api(owner.token, "POST", "/v1/auth/token/server", {
      server_id: serverId,
    });
    expect(token.status).toBe(200);
    const tokenBody = (await token.json()) as { tunnel_url: string | null };
    expect(tokenBody.tunnel_url).toBe("https://lifecycle.trycloudflare.com");
  });

  test("invite → accept → member token → leave → denied", async () => {
    const invite = await api(owner.token, "POST", `/v1/servers/${serverId}/invites`, {
      username: alice.username,
    });
    expect(invite.status).toBe(201);

    const mine = await api(alice.token, "GET", "/v1/me/invites");
    const myInvites = ((await mine.json()) as { invites: { id: string }[] }).invites;
    expect(myInvites.length).toBe(1);

    const accept = await api(alice.token, "POST", `/v1/me/invites/${myInvites[0]!.id}/accept`);
    expect(accept.status).toBe(200);
    expect(await myServerIds(alice.token)).toContain(serverId);

    const token = await api(alice.token, "POST", "/v1/auth/token/server", {
      server_id: serverId,
    });
    expect(token.status).toBe(200);
    const payload = JSON.parse(
      Buffer.from(
        ((await token.json()) as { token: string }).token.split(".")[1]!,
        "base64",
      ).toString(),
    ) as { is_owner: boolean };
    expect(payload.is_owner).toBe(false);

    const leave = await api(alice.token, "DELETE", `/v1/me/servers/${serverId}`);
    expect(leave.status).toBe(204);
    expect(await myServerIds(alice.token)).not.toContain(serverId);

    const denied = await api(alice.token, "POST", "/v1/auth/token/server", {
      server_id: serverId,
    });
    expect(denied.status).toBe(403);
  });

  test("request → accept → token; ban → denied everywhere; unban → re-request works", async () => {
    const request = await api(bob.token, "POST", `/v1/servers/${serverId}/join-requests`);
    expect(request.status).toBe(201);
    const requestId = ((await request.json()) as { request_id: string }).request_id;

    const list = await api(owner.token, "GET", `/v1/servers/${serverId}/join-requests`);
    const requests = ((await list.json()) as { requests: { id: string }[] }).requests;
    expect(requests.map((r) => r.id)).toContain(requestId);

    const accept = await api(
      owner.token,
      "POST",
      `/v1/servers/${serverId}/join-requests/${requestId}/accept`,
    );
    expect(accept.status).toBe(200);
    expect(await myServerIds(bob.token)).toContain(serverId);

    const token = await api(bob.token, "POST", "/v1/auth/token/server", {
      server_id: serverId,
    });
    expect(token.status).toBe(200);

    const ban = await api(
      owner.token,
      "POST",
      `/v1/servers/${serverId}/members/${bob.accountId}/ban`,
    );
    expect(ban.status).toBe(204);

    const deniedToken = await api(bob.token, "POST", "/v1/auth/token/server", {
      server_id: serverId,
    });
    expect(deniedToken.status).toBe(403);
    expect(await myServerIds(bob.token)).not.toContain(serverId);
    const deniedRequest = await api(bob.token, "POST", `/v1/servers/${serverId}/join-requests`);
    expect(deniedRequest.status).toBe(403);

    const unban = await api(
      owner.token,
      "DELETE",
      `/v1/servers/${serverId}/members/${bob.accountId}/ban`,
    );
    expect(unban.status).toBe(204);
    const retry = await api(bob.token, "POST", `/v1/servers/${serverId}/join-requests`);
    expect(retry.status).toBe(201);
  });

  test("two-phase delete: reads go dark immediately, slot frees only on purge-confirm", async () => {
    const del = await api(owner.token, "DELETE", `/v1/servers/${serverId}`);
    expect(del.status).toBe(202);

    // Gone from the owner's memberships and from heartbeat's point of view.
    expect(await myServerIds(owner.token)).not.toContain(serverId);
    const hb = await fetch(`${ts.url}/v1/servers/${serverId}/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ server_secret: serverSecret }),
    });
    expect(hb.status).toBe(404);

    // Bob's freshly re-filed join request died with the delete.
    const bobRequest = await api(bob.token, "POST", `/v1/servers/${serverId}/join-requests`);
    expect(bobRequest.status).toBe(404);

    const confirm = await api(owner.token, "POST", `/v1/servers/${serverId}/purge-confirm`);
    expect(confirm.status).toBe(204);

    const gone = await ts.sql`SELECT 1 FROM servers WHERE id = ${serverId}`;
    expect(gone.length).toBe(0);
  });
});
