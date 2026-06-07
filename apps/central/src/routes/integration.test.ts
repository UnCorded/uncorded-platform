/**
 * Full lifecycle integration test for UnCorded Central.
 *
 * Requires a real PostgreSQL connection. The suite is skipped unless the
 * DATABASE_URL environment variable is set.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  startTestServer,
  authHeaders,
  extractCookie,
  type TestServer,
} from "../test-helpers";
import { generateSessionToken, hashToken } from "../crypto";

const hasDatabase = !!process.env["DATABASE_URL"];

describe.skipIf(!hasDatabase)(
  "Central API — full lifecycle integration",
  () => {
    let ts: TestServer;

    // Account A state
    let tokenA: string;

    // Account B state
    let tokenB: string;
    let accountIdB: string;

    // Server state
    let serverId: string;
    let serverSecret: string;

    beforeAll(async () => {
      ts = await startTestServer();
    });

    afterAll(async () => {
      await ts.shutdown();
    });

    // ---- a. Register account A ----
    test("a. register account A → 202 (verification pending)", async () => {
      const res = await fetch(`${ts.url}/v1/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "alice@example.com",
          username: "alice",
          password: "password123",
          display_name: "Alice",
        }),
      });
      expect(res.status).toBe(202);
      const body = (await res.json()) as { message: string };
      expect(body.message).toBe("Check your email to verify your account");
    });

    // ---- b. Login as A ----
    test("b. login as A → session cookie", async () => {
      // Bypass email verification — mirrors the pattern in test-helpers.registerAndLogin
      await ts.sql`UPDATE accounts SET email_verified = true WHERE email = 'alice@example.com'`;
      const res = await fetch(`${ts.url}/v1/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "alice@example.com",
          password: "password123",
        }),
      });
      expect(res.status).toBe(200);
      const cookie = extractCookie(res, "__Host-session");
      expect(cookie).toBeTruthy();
      tokenA = cookie!;
    });

    // ---- c. GET profile ----
    test("c. GET profile → see display name", async () => {
      const res = await fetch(`${ts.url}/v1/auth/profile`, {
        headers: authHeaders(tokenA),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { display_name: string; email: string };
      expect(body.display_name).toBe("Alice");
      expect(body.email).toBe("alice@example.com");
    });

    // ---- d. PATCH profile ----
    test("d. PATCH profile → update display name", async () => {
      const res = await fetch(`${ts.url}/v1/auth/profile`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders(tokenA),
        },
        body: JSON.stringify({ display_name: "Alice Updated" }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { display_name: string };
      expect(body.display_name).toBe("Alice Updated");
    });

    // ---- e. Register server ----
    test("e. POST /v1/servers → register server", async () => {
      const res = await fetch(`${ts.url}/v1/servers`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders(tokenA),
        },
        body: JSON.stringify({
          name: "Alice's Server",
          visibility: "public",
        }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        server_id: string;
        server_secret: string;
      };
      serverId = body.server_id;
      serverSecret = body.server_secret;
      expect(typeof serverId).toBe("string");
      expect(typeof serverSecret).toBe("string");
    });

    // ---- f. List servers ----
    test("f. GET /v1/servers → list includes the new server after heartbeat", async () => {
      // Send a heartbeat to mark server online so it appears in the public list
      await fetch(`${ts.url}/v1/servers/${serverId}/heartbeat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          server_secret: serverSecret,
          last_sync_version: 0,
          tunnel_url: "https://alice.trycloudflare.com",
          runtime_version: "1.0.0",
          connected_users: 1,
          plugin_count: 2,
        }),
      });

      const res = await fetch(`${ts.url}/v1/servers`, {
        headers: authHeaders(tokenA),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        servers: Array<{ id: string }>;
        total: number;
      };
      const found = body.servers.find((s) => s.id === serverId);
      expect(found).toBeDefined();
    });

    // ---- g. Issue server JWT ----
    test("g. POST /v1/auth/token/server → get JWT for server", async () => {
      const res = await fetch(`${ts.url}/v1/auth/token/server`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders(tokenA),
        },
        body: JSON.stringify({ server_id: serverId }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { token: string };
      expect(typeof body.token).toBe("string");
      // EdDSA JWT is three dot-separated base64url segments
      expect(body.token.split(".").length).toBe(3);
    });

    // ---- h. Heartbeat with server_secret ----
    test("h. POST heartbeat with server_secret → succeeds", async () => {
      const res = await fetch(`${ts.url}/v1/servers/${serverId}/heartbeat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          server_secret: serverSecret,
          last_sync_version: 0,
          tunnel_url: "https://alice.trycloudflare.com",
          runtime_version: "1.0.0",
          connected_users: 3,
          plugin_count: 2,
        }),
      });
      expect(res.status).toBe(200);
    });

    // ---- i. Rotate server secret ----
    test("i. POST /v1/servers/:id/secret/rotate → get new secret", async () => {
      const res = await fetch(`${ts.url}/v1/servers/${serverId}/secret/rotate`, {
        method: "POST",
        headers: authHeaders(tokenA),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { server_secret: string };
      expect(typeof body.server_secret).toBe("string");
      expect(body.server_secret).not.toBe(serverSecret);
      serverSecret = body.server_secret;
    });

    // ---- j. Heartbeat with new / old secret ----
    test("j. heartbeat with new secret succeeds; old secret fails", async () => {
      const oldSecret = serverSecret;
      // Rotate once more to get a new secret while keeping the old one
      const rotateRes = await fetch(
        `${ts.url}/v1/servers/${serverId}/secret/rotate`,
        {
          method: "POST",
          headers: authHeaders(tokenA),
        },
      );
      const { server_secret: newerSecret } =
        (await rotateRes.json()) as { server_secret: string };

      // Old secret fails
      const oldRes = await fetch(`${ts.url}/v1/servers/${serverId}/heartbeat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ server_secret: oldSecret, last_sync_version: 0 }),
      });
      expect(oldRes.status).toBe(401);

      // New secret succeeds
      const newRes = await fetch(`${ts.url}/v1/servers/${serverId}/heartbeat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          server_secret: newerSecret,
          last_sync_version: 0,
          tunnel_url: "https://alice.trycloudflare.com",
          runtime_version: "1.0.0",
          connected_users: 0,
          plugin_count: 0,
        }),
      });
      expect(newRes.status).toBe(200);

      serverSecret = newerSecret;
    });

    // ---- k. Register account B ----
    test("k. register account B and login", async () => {
      const registerRes = await fetch(`${ts.url}/v1/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "bob@example.com",
          username: "bob",
          password: "password123",
          display_name: "Bob",
        }),
      });
      expect(registerRes.status).toBe(202);

      await ts.sql`UPDATE accounts SET email_verified = true WHERE email = 'bob@example.com'`;

      const loginRes = await fetch(`${ts.url}/v1/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "bob@example.com",
          password: "password123",
        }),
      });
      expect(loginRes.status).toBe(200);
      const loginBody = (await loginRes.json()) as { id: string };
      accountIdB = loginBody.id;
      tokenB = extractCookie(loginRes, "__Host-session")!;
      expect(tokenB).toBeTruthy();
    });

    // ---- l. Transfer server to B (two-sided flow) ----
    test("l. transfer server from A to B → 202 then both sides confirm → ownership moves", async () => {
      // Initiate — production stores hashed tokens; the response gives us the
      // transfer_id, but to confirm we need the raw tokens. To avoid plumbing
      // a test-only "leak the raw tokens" affordance into the API, we initiate
      // here for the real-rate-limit / DB row check, then overwrite the token
      // hashes with ones we know in the test DB and confirm with those.
      const initiate = await fetch(`${ts.url}/v1/servers/${serverId}/transfer`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders(tokenA),
        },
        body: JSON.stringify({ target_account_id: accountIdB }),
      });
      expect(initiate.status).toBe(202);
      const initBody = await initiate.json();
      const transferId = initBody.transfer_id as string;

      // Replace hashes with ones we know.
      const fromRaw = generateSessionToken();
      const toRaw = generateSessionToken();
      const fromHash = await hashToken(fromRaw);
      const toHash = await hashToken(toRaw);
      await ts.sql`
        UPDATE server_transfers
        SET from_token_hash = ${fromHash}, to_token_hash = ${toHash}
        WHERE id = ${transferId}
      `;

      // First side (owner).
      const firstConfirm = await fetch(
        `${ts.url}/v1/server-transfers/${transferId}/confirm`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: fromRaw }),
        },
      );
      expect(firstConfirm.status).toBe(200);
      expect((await firstConfirm.json()).status).toBe("waiting_for_other_party");

      // Owner not yet moved.
      const midState =
        await ts.sql`SELECT owner_id FROM servers WHERE id = ${serverId}`;
      expect(midState[0]!.owner_id).not.toBe(accountIdB);

      // Recipient confirms — completes.
      const secondConfirm = await fetch(
        `${ts.url}/v1/server-transfers/${transferId}/confirm`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: toRaw }),
        },
      );
      expect(secondConfirm.status).toBe(200);
      expect((await secondConfirm.json()).status).toBe("completed");

      const finalState =
        await ts.sql`SELECT owner_id FROM servers WHERE id = ${serverId}`;
      expect(finalState[0]!.owner_id).toBe(accountIdB);
    });

    // ---- m. A can no longer update the server ----
    test("m. A tries PATCH server → 403", async () => {
      const res = await fetch(`${ts.url}/v1/servers/${serverId}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders(tokenA),
        },
        body: JSON.stringify({ name: "Reclaimed by A" }),
      });
      expect(res.status).toBe(403);
    });

    // ---- n. Refresh session ----
    test("n. POST /v1/auth/token/refresh → new session cookie works", async () => {
      const refreshRes = await fetch(`${ts.url}/v1/auth/token/refresh`, {
        method: "POST",
        headers: authHeaders(tokenA),
      });
      expect(refreshRes.status).toBe(204);
      const newToken = extractCookie(refreshRes, "__Host-session")!;
      expect(newToken).toBeTruthy();
      expect(newToken).not.toBe(tokenA);

      // New token authenticates
      const profileRes = await fetch(`${ts.url}/v1/auth/profile`, {
        headers: authHeaders(newToken),
      });
      expect(profileRes.status).toBe(200);

      // Old token is invalidated
      const oldProfileRes = await fetch(`${ts.url}/v1/auth/profile`, {
        headers: authHeaders(tokenA),
      });
      expect(oldProfileRes.status).toBe(401);

      tokenA = newToken;
    });

    // ---- o. Logout ----
    test("o. POST /v1/auth/logout → session invalidated", async () => {
      const logoutRes = await fetch(`${ts.url}/v1/auth/logout`, {
        method: "POST",
        headers: authHeaders(tokenA),
      });
      expect(logoutRes.status).toBe(200);

      // Session is gone
      const profileRes = await fetch(`${ts.url}/v1/auth/profile`, {
        headers: authHeaders(tokenA),
      });
      expect(profileRes.status).toBe(401);
    });
  },
);
