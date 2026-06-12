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
let otherAccountId: string;
let serverId: string;

beforeAll(async () => {
  ts = await startTestServer();
  const owner = await registerAndLogin(ts, "tokenowner");
  ownerToken = owner.token;
  ownerAccountId = owner.accountId;
  const other = await registerAndLogin(ts, "tokenother");
  otherToken = other.token;
  otherAccountId = other.accountId;

  // Create a public server so non-owner token tests can also get a token
  const res = await fetch(`${ts.url}/v1/servers`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(ownerToken) },
    body: JSON.stringify({ name: "Token Test Server", visibility: "public" }),
  });
  const body = await res.json();
  serverId = body.server_id;

  // Tokens are membership-gated, so the non-owner fixture joins as an active
  // member (directly — invite/accept endpoints live in routes/me.ts tests).
  await ts.sql`
    INSERT INTO server_members (server_id, account_id, role, status)
    VALUES (${serverId}, ${otherAccountId}, 'member', 'active')
  `;
});

afterAll(async () => {
  await ts.shutdown();
});

function decodeJwtPart(part: string): Record<string, unknown> {
  const padded = part.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(Buffer.from(padded, "base64").toString()) as Record<
    string,
    unknown
  >;
}

describe("POST /v1/auth/token/server", () => {
  test("issues a valid JWT for the server owner", async () => {
    const res = await fetch(`${ts.url}/v1/auth/token/server`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(ownerToken) },
      body: JSON.stringify({ server_id: serverId }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.token).toBe("string");

    // Decode JWT parts
    const parts = (body.token as string).split(".");
    expect(parts.length).toBe(3);

    const header = decodeJwtPart(parts[0]!);
    expect(header.alg).toBe("EdDSA");
    expect(header.kid).toBeDefined();

    const payload = decodeJwtPart(parts[1]!);
    expect(payload.sub).toBe(ownerAccountId);
    expect(payload.server_id).toBe(serverId);
    expect(payload.display_name).toBe("tokenowner");
    expect(payload.is_owner).toBe(true);
    expect(typeof payload.iat).toBe("number");
    expect(typeof payload.exp).toBe("number");
    expect((payload.exp as number) - (payload.iat as number)).toBe(600);
    expect(typeof payload.jti).toBe("string");
  });

  test("active member gets a token with is_owner=false", async () => {
    const res = await fetch(`${ts.url}/v1/auth/token/server`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(otherToken) },
      body: JSON.stringify({ server_id: serverId }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const parts = (body.token as string).split(".");
    const payload = decodeJwtPart(parts[1]!);
    expect(payload.sub).toBe(otherAccountId);
    expect(payload.is_owner).toBe(false);
  });

  test("bundles tunnel_url with the token (the only place Central reveals it)", async () => {
    await ts.sql`
      UPDATE servers SET tunnel_url = 'https://token-test.trycloudflare.com'
      WHERE id = ${serverId}
    `;
    const res = await fetch(`${ts.url}/v1/auth/token/server`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(otherToken) },
      body: JSON.stringify({ server_id: serverId }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tunnel_url).toBe("https://token-test.trycloudflare.com");
  });

  test("non-member of a public server gets 403 NOT_A_MEMBER", async () => {
    const stranger = await registerAndLogin(ts, "tokenstranger");
    const res = await fetch(`${ts.url}/v1/auth/token/server`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(stranger.token) },
      body: JSON.stringify({ server_id: serverId }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("NOT_A_MEMBER");
  });

  test("banned member of a public server gets 403 even though the server is public", async () => {
    const banned = await registerAndLogin(ts, "tokenbanned");
    await ts.sql`
      INSERT INTO server_members (server_id, account_id, role, status)
      VALUES (${serverId}, ${banned.accountId}, 'member', 'banned')
    `;
    const res = await fetch(`${ts.url}/v1/auth/token/server`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(banned.token) },
      body: JSON.stringify({ server_id: serverId }),
    });
    expect(res.status).toBe(403);
  });

  test("verifies JWT signature with public key", async () => {
    // Get the signing key's public key from the DB
    const keys = await ts.sql`
      SELECT id, public_key FROM signing_keys WHERE state = 'active' LIMIT 1
    `;
    const keyRow = keys[0]!;
    const publicJwk = JSON.parse(keyRow.public_key as string) as JsonWebKey;

    const publicKey = await crypto.subtle.importKey(
      "jwk",
      publicJwk,
      "Ed25519",
      false,
      ["verify"],
    );

    // Get a token
    const res = await fetch(`${ts.url}/v1/auth/token/server`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(ownerToken) },
      body: JSON.stringify({ server_id: serverId }),
    });
    const body = await res.json();
    const token = body.token as string;
    const parts = token.split(".");
    const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const sigB64 = parts[2]!.replace(/-/g, "+").replace(/_/g, "/");
    const signature = Buffer.from(sigB64, "base64");

    const valid = await crypto.subtle.verify("Ed25519", publicKey, signature, data);
    expect(valid).toBe(true);
  });

  test("non-member of a private server gets 404, not 403 (no existence leak)", async () => {
    const createRes = await fetch(`${ts.url}/v1/servers`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(ownerToken) },
      body: JSON.stringify({ name: "Private Server", visibility: "private" }),
    });
    const createBody = await createRes.json();
    const privateServerId = createBody.server_id as string;

    const res = await fetch(`${ts.url}/v1/auth/token/server`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(otherToken) },
      body: JSON.stringify({ server_id: privateServerId }),
    });
    expect(res.status).toBe(404);

    // An active member of the private server does get a token.
    await ts.sql`
      INSERT INTO server_members (server_id, account_id, role, status)
      VALUES (${privateServerId}, ${otherAccountId}, 'member', 'active')
    `;
    const memberRes = await fetch(`${ts.url}/v1/auth/token/server`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(otherToken) },
      body: JSON.stringify({ server_id: privateServerId }),
    });
    expect(memberRes.status).toBe(200);
  });

  test("returns 404 for non-existent server", async () => {
    const res = await fetch(`${ts.url}/v1/auth/token/server`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(ownerToken) },
      body: JSON.stringify({ server_id: "00000000-0000-0000-0000-000000000000" }),
    });
    expect(res.status).toBe(404);
  });

  test("returns 400 for missing server_id", async () => {
    const res = await fetch(`${ts.url}/v1/auth/token/server`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(ownerToken) },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  test("returns 401 without session", async () => {
    const res = await fetch(`${ts.url}/v1/auth/token/server`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ server_id: serverId }),
    });
    expect(res.status).toBe(401);
  });
});
