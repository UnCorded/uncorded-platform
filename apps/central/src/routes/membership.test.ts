import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  startTestServer,
  authHeaders,
  registerAndLogin,
  type TestServer,
} from "../test-helpers";
import { generateSessionToken, hashToken } from "../crypto";
import { MAX_OWNED_SERVERS } from "../membership";

let ts: TestServer;

beforeAll(async () => {
  ts = await startTestServer({ dbName: "uncorded_central_test_membership" });
});

afterAll(async () => {
  await ts.shutdown();
});

async function createServer(
  token: string,
  name: string,
): Promise<{ status: number; serverId: string | null; code: string | null }> {
  const res = await fetch(`${ts.url}/v1/servers`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(token) },
    body: JSON.stringify({ name }),
  });
  const body = (await res.json()) as {
    server_id?: string;
    error?: { code: string };
  };
  return {
    status: res.status,
    serverId: body.server_id ?? null,
    code: body.error?.code ?? null,
  };
}

describe("owner auto-join", () => {
  test("creating a server inserts an active owner member row", async () => {
    const owner = await registerAndLogin(ts, "memowner");
    const created = await createServer(owner.token, "Member Mirror");
    expect(created.status).toBe(201);

    const rows = await ts.sql`
      SELECT role, status FROM server_members
      WHERE server_id = ${created.serverId!} AND account_id = ${owner.accountId}
    `;
    expect(rows.length).toBe(1);
    expect(rows[0]!.role).toBe("owner");
    expect(rows[0]!.status).toBe("active");
  });

  test("delete drops member rows immediately; the owner mirror survives until purge", async () => {
    const owner = await registerAndLogin(ts, "memcascade");
    const joiner = await registerAndLogin(ts, "memcascadejoiner");
    const created = await createServer(owner.token, "Cascade Me");
    await ts.sql`
      INSERT INTO server_members (server_id, account_id, role, status)
      VALUES (${created.serverId!}, ${joiner.accountId}, 'member', 'active')
    `;

    const del = await fetch(`${ts.url}/v1/servers/${created.serverId}`, {
      method: "DELETE",
      headers: authHeaders(owner.token),
    });
    expect(del.status).toBe(202);

    // Members are released (their joined slots free) the moment deletion
    // starts; only the owner mirror remains with the held row.
    const rows = await ts.sql`
      SELECT role FROM server_members WHERE server_id = ${created.serverId!}
    `;
    expect(rows.length).toBe(1);
    expect(rows[0]!.role).toBe("owner");

    const confirm = await fetch(`${ts.url}/v1/servers/${created.serverId}/purge-confirm`, {
      method: "POST",
      headers: authHeaders(owner.token),
    });
    expect(confirm.status).toBe(204);

    const after = await ts.sql`
      SELECT 1 FROM server_members WHERE server_id = ${created.serverId!}
    `;
    expect(after.length).toBe(0);
  });
});

describe("owned-server quota", () => {
  test(`rejects the ${MAX_OWNED_SERVERS + 1}th owned server with QUOTA_EXCEEDED`, async () => {
    const owner = await registerAndLogin(ts, "memquota");

    for (let i = 0; i < MAX_OWNED_SERVERS; i++) {
      const created = await createServer(owner.token, `Quota ${i}`);
      expect(created.status).toBe(201);
    }

    const overflow = await createServer(owner.token, "One Too Many");
    expect(overflow.status).toBe(403);
    expect(overflow.code).toBe("QUOTA_EXCEEDED");

    // Two-phase delete: marking a server deleting does NOT free the slot —
    // only the confirmed purge does, so delete-recreate can't mint servers
    // while local volumes still hold the old data.
    const rows = await ts.sql`
      SELECT id FROM servers WHERE owner_id = ${owner.accountId} LIMIT 1
    `;
    const del = await fetch(`${ts.url}/v1/servers/${rows[0]!.id}`, {
      method: "DELETE",
      headers: authHeaders(owner.token),
    });
    expect(del.status).toBe(202);

    const stillHeld = await createServer(owner.token, "Still Blocked");
    expect(stillHeld.status).toBe(403);

    const confirm = await fetch(`${ts.url}/v1/servers/${rows[0]!.id}/purge-confirm`, {
      method: "POST",
      headers: authHeaders(owner.token),
    });
    expect(confirm.status).toBe(204);

    const retry = await createServer(owner.token, "Fits Again");
    expect(retry.status).toBe(201);
  });

  test("quota counts only servers you own, not ones you join", async () => {
    const other = await registerAndLogin(ts, "memquotaother");
    const created = await createServer(other.token, "Someone Elses");
    expect(created.status).toBe(201);

    const joiner = await registerAndLogin(ts, "memquotajoiner");
    await ts.sql`
      INSERT INTO server_members (server_id, account_id, role, status)
      VALUES (${created.serverId!}, ${joiner.accountId}, 'member', 'active')
    `;

    for (let i = 0; i < MAX_OWNED_SERVERS; i++) {
      const own = await createServer(joiner.token, `Joiner Own ${i}`);
      expect(own.status).toBe(201);
    }
  });
});

describe("ownership transfer keeps the member mirror in step", () => {
  test("recipient becomes role=owner, old owner demoted to member", async () => {
    const from = await registerAndLogin(ts, "memxferfrom");
    const to = await registerAndLogin(ts, "memxferto");
    const created = await createServer(from.token, "Handover");

    // Build the transfer row directly with raw tokens we control (the
    // initiate path only stores hashes; raw tokens travel via email).
    const fromRawToken = generateSessionToken();
    const toRawToken = generateSessionToken();
    const inserted = await ts.sql`
      INSERT INTO server_transfers (
        server_id, from_account_id, to_account_id,
        from_token_hash, to_token_hash, expires_at
      ) VALUES (
        ${created.serverId!}, ${from.accountId}, ${to.accountId},
        ${await hashToken(fromRawToken)}, ${await hashToken(toRawToken)},
        ${new Date(Date.now() + 60_000)}
      ) RETURNING id
    `;
    const transferId = inserted[0]!.id as string;

    for (const token of [fromRawToken, toRawToken]) {
      const res = await fetch(`${ts.url}/v1/server-transfers/${transferId}/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      expect(res.status).toBe(200);
    }

    const members = await ts.sql`
      SELECT account_id, role, status FROM server_members
      WHERE server_id = ${created.serverId!}
      ORDER BY role
    `;
    expect(members.length).toBe(2);
    const newOwner = members.find((m) => m.account_id === to.accountId);
    const oldOwner = members.find((m) => m.account_id === from.accountId);
    expect(newOwner?.role).toBe("owner");
    expect(newOwner?.status).toBe("active");
    expect(oldOwner?.role).toBe("member");
    expect(oldOwner?.status).toBe("active");
  });

  test("recipient who was already a member is upserted to owner, not duplicated", async () => {
    const from = await registerAndLogin(ts, "memxferfrom2");
    const to = await registerAndLogin(ts, "memxferto2");
    const created = await createServer(from.token, "Handover 2");

    await ts.sql`
      INSERT INTO server_members (server_id, account_id, role, status)
      VALUES (${created.serverId!}, ${to.accountId}, 'member', 'active')
    `;

    const fromRawToken = generateSessionToken();
    const toRawToken = generateSessionToken();
    const inserted = await ts.sql`
      INSERT INTO server_transfers (
        server_id, from_account_id, to_account_id,
        from_token_hash, to_token_hash, expires_at
      ) VALUES (
        ${created.serverId!}, ${from.accountId}, ${to.accountId},
        ${await hashToken(fromRawToken)}, ${await hashToken(toRawToken)},
        ${new Date(Date.now() + 60_000)}
      ) RETURNING id
    `;
    const transferId = inserted[0]!.id as string;

    for (const token of [fromRawToken, toRawToken]) {
      const res = await fetch(`${ts.url}/v1/server-transfers/${transferId}/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      expect(res.status).toBe(200);
    }

    const ownerRows = await ts.sql`
      SELECT account_id FROM server_members
      WHERE server_id = ${created.serverId!} AND role = 'owner'
    `;
    expect(ownerRows.length).toBe(1);
    expect(ownerRows[0]!.account_id).toBe(to.accountId);
  });
});
