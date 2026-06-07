import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  startTestServer,
  authHeaders,
  registerAndLogin,
  type TestServer,
} from "../test-helpers";
import { generateSessionToken, hashToken } from "../crypto";

let ts: TestServer;
let ownerToken: string;
let ownerId: string;
let targetId: string;
let unrelatedToken: string;
let serverId: string;

beforeAll(async () => {
  ts = await startTestServer();

  const owner = await registerAndLogin(ts, "xferowner");
  ownerToken = owner.token;
  ownerId = owner.accountId;

  const target = await registerAndLogin(ts, "xfertarget");
  targetId = target.accountId;

  const unrelated = await registerAndLogin(ts, "xferunrelated");
  unrelatedToken = unrelated.token;

  const res = await fetch(`${ts.url}/v1/servers`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(ownerToken) },
    body: JSON.stringify({ name: "Transfer Server" }),
  });
  const body = await res.json();
  serverId = body.server_id;
});

afterAll(async () => {
  await ts.shutdown();
});

// Helper: insert a transfer row directly with raw tokens we control. The
// production initiate path only stores hashes (raw tokens travel via email),
// so tests have to construct rows directly to exercise confirm/decline.
async function insertTransfer(opts: {
  serverId: string;
  fromAccountId: string;
  toAccountId: string;
  expiresAt?: Date;
}): Promise<{
  transferId: string;
  fromRawToken: string;
  toRawToken: string;
}> {
  const fromRawToken = generateSessionToken();
  const toRawToken = generateSessionToken();
  const fromTokenHash = await hashToken(fromRawToken);
  const toTokenHash = await hashToken(toRawToken);
  const expiresAt = opts.expiresAt ?? new Date(Date.now() + 24 * 60 * 60 * 1000);
  const rows = await ts.sql`
    INSERT INTO server_transfers (
      server_id, from_account_id, to_account_id,
      from_token_hash, to_token_hash, expires_at
    ) VALUES (
      ${opts.serverId}, ${opts.fromAccountId}, ${opts.toAccountId},
      ${fromTokenHash}, ${toTokenHash}, ${expiresAt}
    ) RETURNING id
  `;
  return {
    transferId: rows[0]!.id as string,
    fromRawToken,
    toRawToken,
  };
}

describe("POST /v1/servers/:id/transfer (initiate)", () => {
  test("returns 401 without auth", async () => {
    const res = await fetch(`${ts.url}/v1/servers/${serverId}/transfer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target_account_id: targetId }),
    });
    expect(res.status).toBe(401);
  });

  test("returns 403 for non-owner", async () => {
    const res = await fetch(`${ts.url}/v1/servers/${serverId}/transfer`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(unrelatedToken),
      },
      body: JSON.stringify({ target_account_id: targetId }),
    });
    expect(res.status).toBe(403);
  });

  test("returns 404 for unknown server", async () => {
    const res = await fetch(
      `${ts.url}/v1/servers/00000000-0000-0000-0000-000000000000/transfer`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders(ownerToken),
        },
        body: JSON.stringify({ target_account_id: targetId }),
      },
    );
    expect(res.status).toBe(404);
  });

  test("returns 400 for missing target_account_id", async () => {
    const res = await fetch(`${ts.url}/v1/servers/${serverId}/transfer`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(ownerToken),
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  test("returns 400 when transferring to self", async () => {
    const res = await fetch(`${ts.url}/v1/servers/${serverId}/transfer`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(ownerToken),
      },
      body: JSON.stringify({ target_account_id: ownerId }),
    });
    expect(res.status).toBe(400);
  });

  test("returns 404 for non-existent target account", async () => {
    const res = await fetch(`${ts.url}/v1/servers/${serverId}/transfer`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(ownerToken),
      },
      body: JSON.stringify({
        target_account_id: "00000000-0000-0000-0000-000000000000",
      }),
    });
    expect(res.status).toBe(404);
  });

  test("returns 400 when target account is not email-verified", async () => {
    // Create a fresh unverified account, then attempt to transfer to it.
    const email = "xferunverified@example.com";
    await fetch(`${ts.url}/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        username: "xferunverified",
        password: "password123",
        display_name: "xferunverified",
      }),
    });
    const rows =
      await ts.sql`SELECT id FROM accounts WHERE email = ${email}`;
    const unverifiedId = rows[0]!.id as string;

    const res = await fetch(`${ts.url}/v1/servers/${serverId}/transfer`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(ownerToken),
      },
      body: JSON.stringify({ target_account_id: unverifiedId }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("TARGET_NOT_VERIFIED");
  });

  test("creates a pending transfer row and returns 202 with transfer_id", async () => {
    const res = await fetch(`${ts.url}/v1/servers/${serverId}/transfer`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(ownerToken),
      },
      body: JSON.stringify({ target_account_id: targetId }),
    });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(typeof body.transfer_id).toBe("string");
    expect(body.status).toBe("pending");

    const rows = await ts.sql`
      SELECT server_id, from_account_id, to_account_id, is_pending,
             from_confirmed_at, to_confirmed_at
      FROM server_transfers WHERE id = ${body.transfer_id}
    `;
    expect(rows.length).toBe(1);
    const row = rows[0]!;
    expect(row.server_id).toBe(serverId);
    expect(row.from_account_id).toBe(ownerId);
    expect(row.to_account_id).toBe(targetId);
    expect(row.is_pending).toBe(true);
    expect(row.from_confirmed_at).toBeNull();
    expect(row.to_confirmed_at).toBeNull();

    // Owner is unchanged — ownership only moves on dual confirm.
    const serverRows =
      await ts.sql`SELECT owner_id FROM servers WHERE id = ${serverId}`;
    expect(serverRows[0]!.owner_id).toBe(ownerId);

    // Cleanup so subsequent tests can re-initiate without 409.
    await ts.sql`DELETE FROM server_transfers WHERE id = ${body.transfer_id}`;
  });

  test("returns 409 when a live pending transfer already exists", async () => {
    const { transferId } = await insertTransfer({
      serverId,
      fromAccountId: ownerId,
      toAccountId: targetId,
    });

    const res = await fetch(`${ts.url}/v1/servers/${serverId}/transfer`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(ownerToken),
      },
      body: JSON.stringify({ target_account_id: targetId }),
    });
    expect(res.status).toBe(409);

    await ts.sql`DELETE FROM server_transfers WHERE id = ${transferId}`;
  });

  test("inline-sweeps an expired pending row before initiating", async () => {
    const { transferId: expiredId } = await insertTransfer({
      serverId,
      fromAccountId: ownerId,
      toAccountId: targetId,
      expiresAt: new Date(Date.now() - 1000),
    });

    const res = await fetch(`${ts.url}/v1/servers/${serverId}/transfer`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(ownerToken),
      },
      body: JSON.stringify({ target_account_id: targetId }),
    });
    expect(res.status).toBe(202);

    const expiredRow =
      await ts.sql`SELECT is_pending FROM server_transfers WHERE id = ${expiredId}`;
    expect(expiredRow[0]!.is_pending).toBe(false);

    // Cleanup the new pending row.
    await ts.sql`DELETE FROM server_transfers WHERE server_id = ${serverId} AND is_pending = true`;
  });
});

describe("POST /v1/server-transfers/:id/confirm", () => {
  test("returns 404 for unknown transfer", async () => {
    const res = await fetch(
      `${ts.url}/v1/server-transfers/00000000-0000-0000-0000-000000000000/confirm`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: "anything" }),
      },
    );
    expect(res.status).toBe(404);
  });

  test("returns 400 with INVALID_TOKEN for a wrong token", async () => {
    const { transferId } = await insertTransfer({
      serverId,
      fromAccountId: ownerId,
      toAccountId: targetId,
    });
    const res = await fetch(
      `${ts.url}/v1/server-transfers/${transferId}/confirm`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: "not-the-real-token" }),
      },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_TOKEN");
    await ts.sql`DELETE FROM server_transfers WHERE id = ${transferId}`;
  });

  test("returns 410 TRANSFER_EXPIRED when expiry has passed", async () => {
    const { transferId, fromRawToken } = await insertTransfer({
      serverId,
      fromAccountId: ownerId,
      toAccountId: targetId,
      expiresAt: new Date(Date.now() - 1000),
    });
    const res = await fetch(
      `${ts.url}/v1/server-transfers/${transferId}/confirm`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: fromRawToken }),
      },
    );
    expect(res.status).toBe(410);
    const body = await res.json();
    expect(body.error.code).toBe("TRANSFER_EXPIRED");
    await ts.sql`DELETE FROM server_transfers WHERE id = ${transferId}`;
  });

  test("first confirm marks side and leaves transfer pending", async () => {
    const { transferId, fromRawToken } = await insertTransfer({
      serverId,
      fromAccountId: ownerId,
      toAccountId: targetId,
    });
    const res = await fetch(
      `${ts.url}/v1/server-transfers/${transferId}/confirm`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: fromRawToken }),
      },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("waiting_for_other_party");

    // Owner unchanged.
    const serverRows =
      await ts.sql`SELECT owner_id FROM servers WHERE id = ${serverId}`;
    expect(serverRows[0]!.owner_id).toBe(ownerId);

    const tRows = await ts.sql`
      SELECT from_confirmed_at, to_confirmed_at, is_pending
      FROM server_transfers WHERE id = ${transferId}
    `;
    expect(tRows[0]!.from_confirmed_at).not.toBeNull();
    expect(tRows[0]!.to_confirmed_at).toBeNull();
    expect(tRows[0]!.is_pending).toBe(true);

    await ts.sql`DELETE FROM server_transfers WHERE id = ${transferId}`;
  });

  test("second confirm completes the transfer and moves owner_id", async () => {
    const { transferId, fromRawToken, toRawToken } = await insertTransfer({
      serverId,
      fromAccountId: ownerId,
      toAccountId: targetId,
    });

    // Owner side first.
    await fetch(`${ts.url}/v1/server-transfers/${transferId}/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: fromRawToken }),
    });
    // Recipient side completes it.
    const res = await fetch(
      `${ts.url}/v1/server-transfers/${transferId}/confirm`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: toRawToken }),
      },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("completed");

    const serverRows =
      await ts.sql`SELECT owner_id FROM servers WHERE id = ${serverId}`;
    expect(serverRows[0]!.owner_id).toBe(targetId);

    const tRows = await ts.sql`
      SELECT is_pending FROM server_transfers WHERE id = ${transferId}
    `;
    expect(tRows[0]!.is_pending).toBe(false);

    // Original owner can no longer touch the server.
    const denied = await fetch(`${ts.url}/v1/servers/${serverId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(ownerToken),
      },
      body: JSON.stringify({ name: "Reclaimed" }),
    });
    expect(denied.status).toBe(403);

    // Hand the server back so later test setup state stays clean.
    await ts.sql`UPDATE servers SET owner_id = ${ownerId} WHERE id = ${serverId}`;
    await ts.sql`DELETE FROM server_transfers WHERE id = ${transferId}`;
  });

  test("re-confirming a settled transfer returns 410 TRANSFER_SETTLED", async () => {
    const { transferId, fromRawToken, toRawToken } = await insertTransfer({
      serverId,
      fromAccountId: ownerId,
      toAccountId: targetId,
    });

    await fetch(`${ts.url}/v1/server-transfers/${transferId}/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: fromRawToken }),
    });
    await fetch(`${ts.url}/v1/server-transfers/${transferId}/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: toRawToken }),
    });

    const replay = await fetch(
      `${ts.url}/v1/server-transfers/${transferId}/confirm`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: fromRawToken }),
      },
    );
    expect(replay.status).toBe(410);
    const body = await replay.json();
    expect(body.error.code).toBe("TRANSFER_SETTLED");

    await ts.sql`UPDATE servers SET owner_id = ${ownerId} WHERE id = ${serverId}`;
    await ts.sql`DELETE FROM server_transfers WHERE id = ${transferId}`;
  });
});

describe("POST /v1/server-transfers/:id/decline", () => {
  test("declines a pending transfer with a valid token", async () => {
    const { transferId, toRawToken } = await insertTransfer({
      serverId,
      fromAccountId: ownerId,
      toAccountId: targetId,
    });

    const res = await fetch(
      `${ts.url}/v1/server-transfers/${transferId}/decline`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: toRawToken }),
      },
    );
    expect(res.status).toBe(204);

    const rows =
      await ts.sql`SELECT is_pending FROM server_transfers WHERE id = ${transferId}`;
    expect(rows[0]!.is_pending).toBe(false);

    // Owner unchanged.
    const serverRows =
      await ts.sql`SELECT owner_id FROM servers WHERE id = ${serverId}`;
    expect(serverRows[0]!.owner_id).toBe(ownerId);

    await ts.sql`DELETE FROM server_transfers WHERE id = ${transferId}`;
  });

  test("returns 400 INVALID_TOKEN for a wrong token", async () => {
    const { transferId } = await insertTransfer({
      serverId,
      fromAccountId: ownerId,
      toAccountId: targetId,
    });

    const res = await fetch(
      `${ts.url}/v1/server-transfers/${transferId}/decline`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: "wrong" }),
      },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_TOKEN");

    await ts.sql`DELETE FROM server_transfers WHERE id = ${transferId}`;
  });
});

describe("rate limits (real limiter)", () => {
  let rlTs: TestServer;
  let rlOwnerToken: string;
  let rlOwnerId: string;
  let rlTargetId: string;
  let rlServerId: string;

  beforeAll(async () => {
    rlTs = await startTestServer({
      realRateLimiter: true,
      dbName: "uncorded_central_test_rl",
    });
    const owner = await registerAndLogin(rlTs, "rlowner");
    rlOwnerToken = owner.token;
    rlOwnerId = owner.accountId;
    const target = await registerAndLogin(rlTs, "rltarget");
    rlTargetId = target.accountId;
    const created = await fetch(`${rlTs.url}/v1/servers`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(rlOwnerToken) },
      body: JSON.stringify({ name: "RL Server" }),
    });
    const body = await created.json();
    rlServerId = body.server_id;
  });

  afterAll(async () => {
    await rlTs.shutdown();
  });

  test("initiate is rate-limited per account after 5 attempts", async () => {
    // Bucket starts at maxTokens=5; the 6th attempt should be denied.
    // Each call hits the same conflict path (one pending row exists), but the
    // rate limiter is checked before that, so it still consumes a token.
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await fetch(`${rlTs.url}/v1/servers/${rlServerId}/transfer`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders(rlOwnerToken),
        },
        body: JSON.stringify({ target_account_id: rlTargetId }),
      });
      codes.push(res.status);
      // Drain body to release the connection.
      await res.text();
    }
    expect(codes[5]).toBe(429);
    // The first should NOT be 429.
    expect(codes[0]).not.toBe(429);

    // Cleanup any pending row so other suites don't see leftover state.
    await rlTs.sql`DELETE FROM server_transfers WHERE server_id = ${rlServerId}`;
  });

  test("confirm is rate-limited per IP after 10 attempts", async () => {
    // Insert a row directly so we have a real transfer to hit.
    const fromRawToken = generateSessionToken();
    const toRawToken = generateSessionToken();
    const fromTokenHash = await hashToken(fromRawToken);
    const toTokenHash = await hashToken(toRawToken);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const inserted = await rlTs.sql`
      INSERT INTO server_transfers (
        server_id, from_account_id, to_account_id,
        from_token_hash, to_token_hash, expires_at
      ) VALUES (
        ${rlServerId}, ${rlOwnerId}, ${rlTargetId},
        ${fromTokenHash}, ${toTokenHash}, ${expiresAt}
      ) RETURNING id
    `;
    const transferId = inserted[0]!.id as string;

    // Use intentionally-wrong tokens so we don't accidentally complete the
    // transfer mid-loop. Every call is INVALID_TOKEN (400) but still consumes
    // a rate-limit token. 10 allowed → 11th should be 429.
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await fetch(
        `${rlTs.url}/v1/server-transfers/${transferId}/confirm`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: "wrong" }),
        },
      );
      codes.push(res.status);
      await res.text();
    }
    expect(codes[10]).toBe(429);
    expect(codes[0]).not.toBe(429);

    await rlTs.sql`DELETE FROM server_transfers WHERE id = ${transferId}`;
  });
});
