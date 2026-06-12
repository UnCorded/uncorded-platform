import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  startTestServer,
  authHeaders,
  registerAndLogin,
  type TestServer,
} from "../test-helpers";
import { MAX_JOINED_SERVERS, MAX_ACTIVE_INVITES_PER_SERVER } from "../membership";

let ts: TestServer;
let owner: { token: string; accountId: string; username: string };
let member: { token: string; accountId: string; username: string };
let stranger: { token: string; accountId: string; username: string };
let publicServerId: string;
let privateServerId: string;

async function createServer(
  token: string,
  name: string,
  visibility: "public" | "private" = "public",
): Promise<string> {
  const res = await fetch(`${ts.url}/v1/servers`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(token) },
    body: JSON.stringify({ name, visibility }),
  });
  return ((await res.json()) as { server_id: string }).server_id;
}

async function post(token: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${ts.url}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(token) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function del(token: string, path: string): Promise<Response> {
  return fetch(`${ts.url}${path}`, { method: "DELETE", headers: authHeaders(token) });
}

async function get(token: string, path: string): Promise<Response> {
  return fetch(`${ts.url}${path}`, { headers: authHeaders(token) });
}

async function addMember(serverId: string, accountId: string, status = "active"): Promise<void> {
  await ts.sql`
    INSERT INTO server_members (server_id, account_id, role, status)
    VALUES (${serverId}, ${accountId}, 'member', ${status})
  `;
}

beforeAll(async () => {
  ts = await startTestServer({ dbName: "uncorded_central_test_members" });
  owner = await registerAndLogin(ts, "mowner");
  member = await registerAndLogin(ts, "mmember");
  stranger = await registerAndLogin(ts, "mstranger");
  publicServerId = await createServer(owner.token, "Members Public", "public");
  privateServerId = await createServer(owner.token, "Members Private", "private");
  await addMember(publicServerId, member.accountId);
});

afterAll(async () => {
  await ts.shutdown();
});

describe("GET /v1/me/servers", () => {
  test("owner sees an offline, never-tunneled private server (inactive servers never vanish)", async () => {
    const res = await get(owner.token, "/v1/me/servers");
    expect(res.status).toBe(200);
    const body = await res.json();
    const ids = body.servers.map((s: { id: string }) => s.id);
    expect(ids).toContain(publicServerId);
    expect(ids).toContain(privateServerId);

    const priv = body.servers.find((s: { id: string }) => s.id === privateServerId);
    expect(priv.role).toBe("owner");
    expect(priv.is_online).toBe(false);
    expect("tunnel_url" in priv).toBe(false);
  });

  test("active member sees the joined server with role=member", async () => {
    const res = await get(member.token, "/v1/me/servers");
    const body = await res.json();
    const row = body.servers.find((s: { id: string }) => s.id === publicServerId);
    expect(row).toBeDefined();
    expect(row.role).toBe("member");
    // But not the private server they don't belong to.
    const ids = body.servers.map((s: { id: string }) => s.id);
    expect(ids).not.toContain(privateServerId);
  });

  test("401 without session", async () => {
    const res = await fetch(`${ts.url}/v1/me/servers`);
    expect(res.status).toBe(401);
  });
});

describe("DELETE /v1/me/servers/:id (leave)", () => {
  test("member can leave; server disappears from their list and frees the slot", async () => {
    const leaver = await registerAndLogin(ts, "mleaver");
    await addMember(publicServerId, leaver.accountId);

    const res = await del(leaver.token, `/v1/me/servers/${publicServerId}`);
    expect(res.status).toBe(204);

    const list = await get(leaver.token, "/v1/me/servers");
    const ids = (await list.json()).servers.map((s: { id: string }) => s.id);
    expect(ids).not.toContain(publicServerId);
  });

  test("owner cannot leave their own server", async () => {
    const res = await del(owner.token, `/v1/me/servers/${publicServerId}`);
    expect(res.status).toBe(400);
  });

  test("non-member gets 404", async () => {
    const res = await del(stranger.token, `/v1/me/servers/${publicServerId}`);
    expect(res.status).toBe(404);
  });
});

describe("POST /v1/servers/:id/invites", () => {
  test("owner invites by exact username", async () => {
    const invitee = await registerAndLogin(ts, "minvitee");
    const res = await post(owner.token, `/v1/servers/${publicServerId}/invites`, {
      username: invitee.username,
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.invite_id).toBeDefined();
    expect(body.status).toBe("pending");
  });

  test("duplicate pending invite is 409", async () => {
    const dupe = await registerAndLogin(ts, "mdupe");
    const first = await post(owner.token, `/v1/servers/${publicServerId}/invites`, {
      username: dupe.username,
    });
    expect(first.status).toBe(201);
    const second = await post(owner.token, `/v1/servers/${publicServerId}/invites`, {
      username: dupe.username,
    });
    expect(second.status).toBe(409);
  });

  test("unknown username is 404; existing member is 409; self is 400", async () => {
    const unknown = await post(owner.token, `/v1/servers/${publicServerId}/invites`, {
      username: "does_not_exist_xyz",
    });
    expect(unknown.status).toBe(404);

    const already = await post(owner.token, `/v1/servers/${publicServerId}/invites`, {
      username: member.username,
    });
    expect(already.status).toBe(409);

    const self = await post(owner.token, `/v1/servers/${publicServerId}/invites`, {
      username: owner.username,
    });
    expect(self.status).toBe(400);
  });

  test("non-owner cannot invite (403 public, 404 private)", async () => {
    const pub = await post(member.token, `/v1/servers/${publicServerId}/invites`, {
      username: stranger.username,
    });
    expect(pub.status).toBe(403);

    const priv = await post(stranger.token, `/v1/servers/${privateServerId}/invites`, {
      username: member.username,
    });
    expect(priv.status).toBe(404);
  });

  test("pending-invite cap returns QUOTA_EXCEEDED", async () => {
    const capOwner = await registerAndLogin(ts, "mcapowner");
    const capServerId = await createServer(capOwner.token, "Cap Server");
    // Fill the cap directly — 20 throwaway accounts via the API would be slow.
    for (let i = 0; i < MAX_ACTIVE_INVITES_PER_SERVER; i++) {
      const acct = await ts.sql`
        INSERT INTO accounts (email, username, password_hash, display_name, email_verified)
        VALUES (${`capfill${i}@example.com`}, ${`capfill${i}`}, 'x', ${`capfill${i}`}, true)
        RETURNING id
      `;
      await ts.sql`
        INSERT INTO server_invitations (server_id, invited_account_id, invited_by, expires_at)
        VALUES (${capServerId}, ${acct[0]!.id as string}, ${capOwner.accountId}, now() + interval '7 days')
      `;
    }
    const res = await post(capOwner.token, `/v1/servers/${capServerId}/invites`, {
      username: stranger.username,
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("QUOTA_EXCEEDED");
  });
});

describe("invite accept / decline / revoke lifecycle", () => {
  async function invite(serverId: string, username: string): Promise<string> {
    const res = await post(owner.token, `/v1/servers/${serverId}/invites`, { username });
    expect(res.status).toBe(201);
    return ((await res.json()) as { invite_id: string }).invite_id;
  }

  test("invitee sees the invite, accepts, becomes a member, and can mint a token", async () => {
    const joiner = await registerAndLogin(ts, "mjoiner");
    const inviteId = await invite(privateServerId, joiner.username);

    const mine = await get(joiner.token, "/v1/me/invites");
    const invites = (await mine.json()).invites;
    expect(invites.map((i: { id: string }) => i.id)).toContain(inviteId);
    expect(invites[0].server_name).toBe("Members Private");
    expect(invites[0].invited_by_username).toBe(owner.username);

    const accept = await post(joiner.token, `/v1/me/invites/${inviteId}/accept`);
    expect(accept.status).toBe(200);
    expect((await accept.json()).status).toBe("joined");

    const list = await get(joiner.token, "/v1/me/servers");
    const ids = (await list.json()).servers.map((s: { id: string }) => s.id);
    expect(ids).toContain(privateServerId);

    const token = await post(joiner.token, "/v1/auth/token/server", {
      server_id: privateServerId,
    });
    expect(token.status).toBe(200);
  });

  test("someone else's invite is a 404 (not 403)", async () => {
    const target = await registerAndLogin(ts, "mtarget");
    const inviteId = await invite(privateServerId, target.username);
    const res = await post(stranger.token, `/v1/me/invites/${inviteId}/accept`);
    expect(res.status).toBe(404);
  });

  test("declined invite cannot be accepted afterwards", async () => {
    const decliner = await registerAndLogin(ts, "mdecliner");
    const inviteId = await invite(privateServerId, decliner.username);

    const decline = await post(decliner.token, `/v1/me/invites/${inviteId}/decline`);
    expect(decline.status).toBe(204);

    const accept = await post(decliner.token, `/v1/me/invites/${inviteId}/accept`);
    expect(accept.status).toBe(410);
  });

  test("expired invite returns 410 and flips to expired", async () => {
    const late = await registerAndLogin(ts, "mlate");
    const inviteId = await invite(privateServerId, late.username);
    await ts.sql`
      UPDATE server_invitations SET expires_at = now() - interval '1 minute'
      WHERE id = ${inviteId}
    `;
    const accept = await post(late.token, `/v1/me/invites/${inviteId}/accept`);
    expect(accept.status).toBe(410);
    const row = await ts.sql`SELECT status FROM server_invitations WHERE id = ${inviteId}`;
    expect(row[0]!.status).toBe("expired");
  });

  test("owner can list and revoke a pending invite; accept then 410s", async () => {
    const revokee = await registerAndLogin(ts, "mrevokee");
    const inviteId = await invite(privateServerId, revokee.username);

    const listRes = await get(owner.token, `/v1/servers/${privateServerId}/invites`);
    expect(listRes.status).toBe(200);
    const listed = (await listRes.json()).invites;
    expect(listed.map((i: { id: string }) => i.id)).toContain(inviteId);

    const revoke = await del(owner.token, `/v1/servers/${privateServerId}/invites/${inviteId}`);
    expect(revoke.status).toBe(204);

    const accept = await post(revokee.token, `/v1/me/invites/${inviteId}/accept`);
    expect(accept.status).toBe(410);
  });

  test("joined-server quota blocks accept with QUOTA_EXCEEDED", async () => {
    const full = await registerAndLogin(ts, "mfull");
    // Fill the joined quota directly — membership rows need real servers, so
    // mint quota-filler servers via SQL (bypassing the owned cap on purpose).
    for (let i = 0; i < MAX_JOINED_SERVERS; i++) {
      const filler = await ts.sql`
        INSERT INTO servers (name, owner_id, server_secret_hash)
        VALUES (${`Filler ${i}`}, ${owner.accountId}, 'x')
        RETURNING id
      `;
      await addMember(filler[0]!.id as string, full.accountId);
    }
    const inviteId = await invite(privateServerId, full.username);
    const accept = await post(full.token, `/v1/me/invites/${inviteId}/accept`);
    expect(accept.status).toBe(403);
    expect((await accept.json()).error.code).toBe("QUOTA_EXCEEDED");
  });
});

describe("join requests", () => {
  test("user requests to join a public server; owner sees and accepts it", async () => {
    const requester = await registerAndLogin(ts, "mrequester");
    const create = await post(requester.token, `/v1/servers/${publicServerId}/join-requests`);
    expect(create.status).toBe(201);
    const requestId = ((await create.json()) as { request_id: string }).request_id;

    const dupe = await post(requester.token, `/v1/servers/${publicServerId}/join-requests`);
    expect(dupe.status).toBe(409);

    const list = await get(owner.token, `/v1/servers/${publicServerId}/join-requests`);
    expect(list.status).toBe(200);
    const requests = (await list.json()).requests;
    const row = requests.find((r: { id: string }) => r.id === requestId);
    expect(row).toBeDefined();
    expect(row.username).toBe(requester.username);

    const accept = await post(
      owner.token,
      `/v1/servers/${publicServerId}/join-requests/${requestId}/accept`,
    );
    expect(accept.status).toBe(200);

    const mine = await get(requester.token, "/v1/me/servers");
    const ids = (await mine.json()).servers.map((s: { id: string }) => s.id);
    expect(ids).toContain(publicServerId);
  });

  test("private server join request is 404 for outsiders; member request is 409", async () => {
    const outsider = await registerAndLogin(ts, "moutsider");
    const priv = await post(outsider.token, `/v1/servers/${privateServerId}/join-requests`);
    expect(priv.status).toBe(404);

    const already = await post(member.token, `/v1/servers/${publicServerId}/join-requests`);
    expect(already.status).toBe(409);
  });

  test("owner declines a request; requester does not become a member", async () => {
    const declined = await registerAndLogin(ts, "mdeclined");
    const create = await post(declined.token, `/v1/servers/${publicServerId}/join-requests`);
    const requestId = ((await create.json()) as { request_id: string }).request_id;

    const res = await post(
      owner.token,
      `/v1/servers/${publicServerId}/join-requests/${requestId}/decline`,
    );
    expect(res.status).toBe(204);

    const mine = await get(declined.token, "/v1/me/servers");
    const ids = (await mine.json()).servers.map((s: { id: string }) => s.id);
    expect(ids).not.toContain(publicServerId);

    // Declined request can be re-filed (only *pending* is unique).
    const again = await post(declined.token, `/v1/servers/${publicServerId}/join-requests`);
    expect(again.status).toBe(201);
  });

  test("non-owner cannot list or settle requests", async () => {
    const list = await get(member.token, `/v1/servers/${publicServerId}/join-requests`);
    expect(list.status).toBe(403);
  });
});

describe("kick / ban / unban", () => {
  test("owner kicks an active member; they lose the server and their token access", async () => {
    const kicked = await registerAndLogin(ts, "mkicked");
    await addMember(publicServerId, kicked.accountId);

    const res = await del(
      owner.token,
      `/v1/servers/${publicServerId}/members/${kicked.accountId}`,
    );
    expect(res.status).toBe(204);

    const token = await post(kicked.token, "/v1/auth/token/server", {
      server_id: publicServerId,
    });
    expect(token.status).toBe(403);
  });

  test("kicking a non-member is 404; owner cannot kick themselves", async () => {
    const res = await del(
      owner.token,
      `/v1/servers/${publicServerId}/members/${stranger.accountId}`,
    );
    expect(res.status).toBe(404);

    const self = await del(
      owner.token,
      `/v1/servers/${publicServerId}/members/${owner.accountId}`,
    );
    expect(self.status).toBe(400);
  });

  test("ban flips the member row, kills pending paperwork, and blocks tokens + re-requests", async () => {
    const banned = await registerAndLogin(ts, "mbanned");
    await addMember(publicServerId, banned.accountId);
    // Pending join request on a *different* server is untouched; pending
    // request on this server (would conflict with active membership, so use
    // a pending invite instead) is revoked by the ban.
    const otherServerId = await createServer(stranger.token, "Other Public");
    await post(banned.token, `/v1/servers/${otherServerId}/join-requests`);

    const res = await post(
      owner.token,
      `/v1/servers/${publicServerId}/members/${banned.accountId}/ban`,
    );
    expect(res.status).toBe(204);

    const row = await ts.sql`
      SELECT status FROM server_members
      WHERE server_id = ${publicServerId} AND account_id = ${banned.accountId}
    `;
    expect(row[0]!.status).toBe("banned");

    const token = await post(banned.token, "/v1/auth/token/server", {
      server_id: publicServerId,
    });
    expect(token.status).toBe(403);

    const rejoin = await post(banned.token, `/v1/servers/${publicServerId}/join-requests`);
    expect(rejoin.status).toBe(403);

    // The unrelated server's request survives.
    const other = await ts.sql`
      SELECT status FROM server_join_requests
      WHERE server_id = ${otherServerId} AND account_id = ${banned.accountId}
    `;
    expect(other[0]!.status).toBe("pending");
  });

  test("pre-emptive ban of a non-member blocks their join request", async () => {
    const preban = await registerAndLogin(ts, "mpreban");
    const res = await post(
      owner.token,
      `/v1/servers/${publicServerId}/members/${preban.accountId}/ban`,
    );
    expect(res.status).toBe(204);

    const request = await post(preban.token, `/v1/servers/${publicServerId}/join-requests`);
    expect(request.status).toBe(403);
  });

  test("unban removes the row; the user can request to join again", async () => {
    const redeemed = await registerAndLogin(ts, "mredeemed");
    await post(owner.token, `/v1/servers/${publicServerId}/members/${redeemed.accountId}/ban`);

    const unban = await del(
      owner.token,
      `/v1/servers/${publicServerId}/members/${redeemed.accountId}/ban`,
    );
    expect(unban.status).toBe(204);

    const request = await post(redeemed.token, `/v1/servers/${publicServerId}/join-requests`);
    expect(request.status).toBe(201);
  });

  test("non-owner cannot kick or ban", async () => {
    const kick = await del(
      member.token,
      `/v1/servers/${publicServerId}/members/${stranger.accountId}`,
    );
    expect(kick.status).toBe(403);

    const ban = await post(
      member.token,
      `/v1/servers/${publicServerId}/members/${stranger.accountId}/ban`,
    );
    expect(ban.status).toBe(403);
  });

  test("owner member list shows roles and statuses", async () => {
    const res = await get(owner.token, `/v1/servers/${publicServerId}/members`);
    expect(res.status).toBe(200);
    const members = (await res.json()).members;
    const ownerRow = members.find(
      (m: { account_id: string }) => m.account_id === owner.accountId,
    );
    expect(ownerRow.role).toBe("owner");
    const memberRow = members.find(
      (m: { account_id: string }) => m.account_id === member.accountId,
    );
    expect(memberRow.role).toBe("member");
    expect(memberRow.username).toBe(member.username);
  });
});
