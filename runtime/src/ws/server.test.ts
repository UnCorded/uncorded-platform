import { describe, expect, test, afterEach } from "bun:test";
import path from "path";
import { createWsServer } from "./server";
import type { WsServerHandle } from "./server";
import type { TokenValidator, TokenValidationResult, AuthenticatedUser } from "./types";
import { jsonCodec } from "./codec";
import { SubprocessManager } from "../subprocess";
import { JtiRevocationSet } from "./revocation";
import { RateLimiter, RATE_WS_CONNECT } from "../http/rate-limiter";
import type {
  AuthResultMessage,
  ResponseMessage,
} from "@uncorded/protocol";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXTURES_DIR = path.join(import.meta.dir, "__fixtures__");
const WS_ECHO_PLUGIN = path.join(FIXTURES_DIR, "ws-echo-plugin.ts");
const SLOW_PLUGIN = path.join(FIXTURES_DIR, "slow-plugin.ts");

const TEST_TOKEN = "valid-test-token";

const testUser: AuthenticatedUser = {
  id: "user_test",
  username: "test_user",
  displayName: "Test User",
  avatarUrl: "https://example.com/test.png",
  role: "admin",
};

function testTokenValidator(): TokenValidator {
  return {
    async validate(token: string): Promise<TokenValidationResult> {
      if (token === TEST_TOKEN) {
        return { ok: true, user: testUser };
      }
      return { ok: false, code: "INVALID_TOKEN", message: "Token is invalid" };
    },
  };
}

function waitFor<T>(
  fn: () => T | undefined,
  timeoutMs = 2000,
  intervalMs = 20,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      const result = fn();
      if (result !== undefined) {
        resolve(result);
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error("waitFor timed out"));
        return;
      }
      setTimeout(check, intervalMs);
    };
    check();
  });
}

/**
 * Connect to a WS server, send auth, wait for auth.result.
 * Returns the WebSocket and the auth result.
 */
async function connectAndAuth(
  port: number,
  token = TEST_TOKEN,
): Promise<{ ws: WebSocket; authResult: AuthResultMessage }> {
  const ws = new WebSocket(`ws://localhost:${port}/ws`);

  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = (e) => reject(e);
  });

  const authResultPromise = new Promise<AuthResultMessage>((resolve) => {
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data as string) as AuthResultMessage;
      resolve(msg);
    };
  });

  ws.send(JSON.stringify({ type: "auth", token }));

  const authResult = await authResultPromise;
  return { ws, authResult };
}

/**
 * Collect the next N messages from a WebSocket.
 */
function collectMessages(ws: WebSocket, count: number): Promise<unknown[]> {
  return new Promise((resolve) => {
    const messages: unknown[] = [];
    ws.onmessage = (event) => {
      messages.push(JSON.parse(event.data as string));
      if (messages.length >= count) {
        resolve(messages);
      }
    };
  });
}

/**
 * Wait for the next single message from a WebSocket.
 */
function nextMessage(ws: WebSocket, timeoutMs = 2000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("nextMessage timed out")),
      timeoutMs,
    );
    ws.onmessage = (event) => {
      clearTimeout(timer);
      resolve(JSON.parse(event.data as string));
    };
  });
}

// ---------------------------------------------------------------------------
// Test state management
// ---------------------------------------------------------------------------

let handles: WsServerHandle[] = [];
let managers: SubprocessManager[] = [];

afterEach(async () => {
  for (const h of handles) {
    h.stop();
  }
  handles = [];
  for (const m of managers) {
    await m.stopAll();
  }
  managers = [];
});

function getPort(handle: WsServerHandle): number {
  const { port } = handle.server;
  if (port === undefined) throw new Error("Server has no port");
  return port;
}

function createTestServer(
  overrides?: Partial<Parameters<typeof createWsServer>[0]>,
): WsServerHandle {
  const manager = overrides?.subprocessManager ?? new SubprocessManager();
  if (!overrides?.subprocessManager) {
    managers.push(manager);
  }

  // Tests use JSON helpers (JSON.stringify/JSON.parse), so pin to jsonCodec
  // explicitly — the production default is now msgpackCodec.
  const handle = createWsServer({
    port: 0, // random available port
    tokenValidator: testTokenValidator(),
    subprocessManager: manager,
    codec: jsonCodec,
    ...overrides,
  });

  handles.push(handle);
  return handle;
}

// ---------------------------------------------------------------------------
// Auth handshake
// ---------------------------------------------------------------------------

describe("auth handshake", () => {
  test("accepts valid token and returns auth.result ok", async () => {
    const handle = createTestServer();
    const { ws, authResult } = await connectAndAuth(getPort(handle));

    expect(authResult.type).toBe("auth.result");
    expect(authResult.ok).toBe(true);
    expect(authResult.error).toBeUndefined();

    ws.close();
  });

  test("rejects invalid token with auth.result error and closes", async () => {
    const handle = createTestServer();
    const { ws, authResult } = await connectAndAuth(
      getPort(handle),
      "bad-token",
    );

    expect(authResult.ok).toBe(false);
    expect(authResult.error).toBe("Token is invalid");

    // Connection should be closed by the server
    await new Promise<void>((resolve) => {
      ws.onclose = () => resolve();
      // If already closed
      if (ws.readyState === WebSocket.CLOSED) resolve();
    });
  });

  test("INVALID_TOKEN closes with 4003 (auth failed, not retryable)", async () => {
    const handle = createTestServer();
    const ws = new WebSocket(`ws://localhost:${getPort(handle)}/ws`);
    await new Promise<void>((resolve) => {
      ws.onopen = () => resolve();
    });
    const closePromise = new Promise<{ code: number }>((resolve) => {
      ws.onclose = (e) => resolve({ code: e.code });
    });
    ws.send(JSON.stringify({ type: "auth", token: "bad-token" }));
    const closeEvent = await closePromise;
    expect(closeEvent.code).toBe(4003);
  });

  test("UNKNOWN_KEY (stale JWKS cache) closes with 4004, not 4003", async () => {
    // The website maps 4003 to "you were banned" and purges the server.
    // A stale-cache miss is transient — must close with the retryable code
    // instead so the client reconnects rather than treating it as a ban.
    const validator: TokenValidator = {
      async validate(token: string): Promise<TokenValidationResult> {
        if (token === "stale-cache-token") {
          return { ok: false, code: "UNKNOWN_KEY", message: "No public key found for kid: x" };
        }
        return { ok: false, code: "INVALID_TOKEN", message: "Token is invalid" };
      },
    };
    const handle = createTestServer({ tokenValidator: validator });
    const ws = new WebSocket(`ws://localhost:${getPort(handle)}/ws`);
    await new Promise<void>((resolve) => {
      ws.onopen = () => resolve();
    });
    const closePromise = new Promise<{ code: number }>((resolve) => {
      ws.onclose = (e) => resolve({ code: e.code });
    });
    ws.send(JSON.stringify({ type: "auth", token: "stale-cache-token" }));
    const closeEvent = await closePromise;
    expect(closeEvent.code).toBe(4004);
  });

  test("SERVER_NOT_READY also closes with 4004 (transient init race)", async () => {
    const validator: TokenValidator = {
      async validate(): Promise<TokenValidationResult> {
        return { ok: false, code: "SERVER_NOT_READY", message: "Server ID not yet available" };
      },
    };
    const handle = createTestServer({ tokenValidator: validator });
    const ws = new WebSocket(`ws://localhost:${getPort(handle)}/ws`);
    await new Promise<void>((resolve) => {
      ws.onopen = () => resolve();
    });
    const closePromise = new Promise<{ code: number }>((resolve) => {
      ws.onclose = (e) => resolve({ code: e.code });
    });
    ws.send(JSON.stringify({ type: "auth", token: "any" }));
    const closeEvent = await closePromise;
    expect(closeEvent.code).toBe(4004);
  });

  test("closes connection on auth timeout", async () => {
    const handle = createTestServer({ authTimeoutMs: 200 });

    const ws = new WebSocket(`ws://localhost:${getPort(handle)}/ws`);
    await new Promise<void>((resolve) => {
      ws.onopen = () => resolve();
    });

    // Don't send auth — wait for timeout
    const closeEvent = await new Promise<{ code: number }>((resolve) => {
      ws.onclose = (e) => resolve({ code: e.code });
    });

    expect(closeEvent.code).toBe(4001);
  });

  test("closes connection when first message is not auth", async () => {
    const handle = createTestServer();

    const ws = new WebSocket(`ws://localhost:${getPort(handle)}/ws`);
    await new Promise<void>((resolve) => {
      ws.onopen = () => resolve();
    });

    ws.send(JSON.stringify({ type: "request", id: "1", plugin: "p", action: "a", params: {} }));

    const closeEvent = await new Promise<{ code: number }>((resolve) => {
      ws.onclose = (e) => resolve({ code: e.code });
    });

    expect(closeEvent.code).toBe(4002);
  });

  test("rejects upgrade with 503 once maxConnections is reached (G6)", async () => {
    const handle = createTestServer({ maxConnections: 2 });
    const port = getPort(handle);

    const c1 = await connectAndAuth(port);
    const c2 = await connectAndAuth(port);

    expect(c1.authResult.ok).toBe(true);
    expect(c2.authResult.ok).toBe(true);

    // Third upgrade should fail before the WebSocket connects.
    const res = await fetch(`http://localhost:${port}/ws`, {
      headers: {
        Upgrade: "websocket",
        Connection: "Upgrade",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
      },
    });
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("30");
    const body = await res.json() as { error: string };
    expect(body.error).toBe("MAX_CONNECTIONS");

    c1.ws.close();
    c2.ws.close();
  });

  test("rejects upgrade with 503 once per-IP cap is reached", async () => {
    // Pin every request to the same client IP so the per-IP counter trips
    // before the global maxConnections does.
    const handle = createTestServer({
      maxConnectionsPerIp: 2,
      getClientIp: () => "ip-cap-test",
    });
    const port = getPort(handle);

    const c1 = await connectAndAuth(port);
    const c2 = await connectAndAuth(port);
    expect(c1.authResult.ok).toBe(true);
    expect(c2.authResult.ok).toBe(true);

    const res = await fetch(`http://localhost:${port}/ws`, {
      headers: {
        Upgrade: "websocket",
        Connection: "Upgrade",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
      },
    });
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("30");
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("MAX_CONNECTIONS_PER_IP");

    c1.ws.close();
    c2.ws.close();
  });

  test("per-IP cap does not affect other IPs", async () => {
    // Use a mutable IP source: the first two upgrades come from "ip-A",
    // exhausting its slots; the third comes from "ip-B" and must succeed.
    let currentIp = "ip-A";
    const handle = createTestServer({
      maxConnectionsPerIp: 2,
      getClientIp: () => currentIp,
    });
    const port = getPort(handle);

    const a1 = await connectAndAuth(port);
    const a2 = await connectAndAuth(port);
    expect(a1.authResult.ok).toBe(true);
    expect(a2.authResult.ok).toBe(true);

    currentIp = "ip-B";
    const b1 = await connectAndAuth(port);
    expect(b1.authResult.ok).toBe(true);

    a1.ws.close();
    a2.ws.close();
    b1.ws.close();
  });

  test("fails closed when banChecker throws (G1)", async () => {
    // Corrupt-DB simulation: banChecker throws on every call.
    const handle = createTestServer({
      banChecker: () => {
        throw new Error("ban table unreadable");
      },
    });

    const { ws, authResult } = await connectAndAuth(getPort(handle));

    expect(authResult.ok).toBe(false);
    expect(authResult.error).toContain("Authentication service unavailable");

    await new Promise<void>((resolve) => {
      ws.onclose = () => resolve();
      if (ws.readyState === WebSocket.CLOSED) resolve();
    });
  });
});

// ---------------------------------------------------------------------------
// Request round-trip (with fixture plugin)
// ---------------------------------------------------------------------------

describe("request round-trip", () => {
  test("routes request to plugin and returns response", async () => {
    const manager = new SubprocessManager();
    managers.push(manager);

    const spawnResult = await manager.spawn(
      "echo",
      FIXTURES_DIR,
      WS_ECHO_PLUGIN,
      FIXTURES_DIR,
      "1.0.0",
      { handshakeTimeoutMs: 5000 },
    );

    expect(spawnResult.ok).toBe(true);
    if (!spawnResult.ok) return;

    const handle = createTestServer({ subprocessManager: manager });
    handle.router.attachPlugin("echo", spawnResult.process.transport);

    const { ws } = await connectAndAuth(getPort(handle));
    const responsePromise = nextMessage(ws);

    ws.send(
      JSON.stringify({
        type: "request",
        id: "req_42",
        plugin: "echo",
        action: "getItems",
        params: { foo: "bar" },
      }),
    );

    const response = (await responsePromise) as ResponseMessage;

    expect(response.type).toBe("response");
    expect(response.id).toBe("req_42");
    expect(response.result).toEqual({
      echo: true,
      action: "getItems",
      params: { foo: "bar" },
    });

    ws.close();
  });

  test("returns PLUGIN_NOT_FOUND for unknown plugin", async () => {
    const handle = createTestServer();
    const { ws } = await connectAndAuth(getPort(handle));
    const responsePromise = nextMessage(ws);

    ws.send(
      JSON.stringify({
        type: "request",
        id: "req_1",
        plugin: "nonexistent",
        action: "foo",
        params: {},
      }),
    );

    const response = (await responsePromise) as ResponseMessage;

    expect(response.type).toBe("response");
    expect(response.id).toBe("req_1");
    expect(response.error?.code).toBe("PLUGIN_NOT_FOUND");

    ws.close();
  });
});

// ---------------------------------------------------------------------------
// Health endpoint
// ---------------------------------------------------------------------------

describe("health endpoint", () => {
  test("returns ok with connection count", async () => {
    const handle = createTestServer();
    const response = await fetch(`http://localhost:${getPort(handle)}/health`);
    const body = (await response.json()) as { status: string; connections: number };

    expect(response.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.connections).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Presence events
// ---------------------------------------------------------------------------

describe("presence events", () => {
  test("fires connected and disconnected events", async () => {
    const events: Array<{ event: string; userId: string }> = [];
    const handle = createTestServer({
      onPresence(event, user) {
        events.push({ event, userId: user.id });
      },
    });

    const { ws } = await connectAndAuth(getPort(handle));

    // Wait for the connected event to be recorded
    await waitFor(() => (events.length >= 1 ? true : undefined));
    expect(events[0]).toEqual({
      event: "runtime.user.connected",
      userId: "user_test",
    });

    ws.close();

    // Wait for the disconnected event
    await waitFor(() => (events.length >= 2 ? true : undefined));
    expect(events[1]).toEqual({
      event: "runtime.user.disconnected",
      userId: "user_test",
    });
  });
});

// ---------------------------------------------------------------------------
// Concurrency: 50 parallel requests to a slow plugin, verify timeout cleanup
// ---------------------------------------------------------------------------

describe("concurrency and timeout cleanup", () => {
  test("50 parallel requests to slow plugin all receive timeout errors", async () => {
    const manager = new SubprocessManager();
    managers.push(manager);

    const spawnResult = await manager.spawn(
      "slow",
      FIXTURES_DIR,
      SLOW_PLUGIN,
      FIXTURES_DIR,
      "1.0.0",
      { handshakeTimeoutMs: 5000 },
    );

    expect(spawnResult.ok).toBe(true);
    if (!spawnResult.ok) return;

    // Short request timeout so we don't wait 30s in tests
    const REQUEST_TIMEOUT_MS = 300;

    const handle = createTestServer({
      subprocessManager: manager,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
    });
    handle.router.attachPlugin("slow", spawnResult.process.transport);

    const { ws } = await connectAndAuth(getPort(handle));

    const REQUEST_COUNT = 50;

    // Collect all responses
    const responsePromise = new Promise<ResponseMessage[]>((resolve) => {
      const responses: ResponseMessage[] = [];
      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data as string) as ResponseMessage;
        if (msg.type === "response") {
          responses.push(msg);
        }
        if (responses.length >= REQUEST_COUNT) {
          resolve(responses);
        }
      };
    });

    // Fire 50 requests in parallel — the slow plugin won't respond in time
    for (let i = 0; i < REQUEST_COUNT; i++) {
      ws.send(
        JSON.stringify({
          type: "request",
          id: `req_${i}`,
          plugin: "slow",
          action: "doSomething",
          params: { delay: 60_000 }, // 60s — way past the 300ms timeout
        }),
      );
    }

    // Pending requests should accumulate
    await waitFor(() =>
      handle.router.getPendingRequestCount() >= REQUEST_COUNT
        ? true
        : undefined,
    );
    expect(handle.router.getPendingRequestCount()).toBe(REQUEST_COUNT);

    // Wait for requests to become stale (exceed the timeout window)
    await new Promise((r) => setTimeout(r, REQUEST_TIMEOUT_MS + 50));

    // Manually trigger cleanup (instead of waiting for the 5s interval)
    const cleaned = handle.router.cleanupStaleRequests(REQUEST_TIMEOUT_MS);
    expect(cleaned).toBe(REQUEST_COUNT);

    // All pending requests should be gone
    expect(handle.router.getPendingRequestCount()).toBe(0);

    // All 50 clients should receive timeout errors
    const responses = await responsePromise;
    expect(responses).toHaveLength(REQUEST_COUNT);

    // Every response should be a timeout error with the correct request ID
    const seenIds = new Set<string>();
    for (const r of responses) {
      expect(r.type).toBe("response");
      expect(r.error?.code).toBe("REQUEST_TIMEOUT");
      seenIds.add(r.id);
    }

    // All 50 unique request IDs should be accounted for
    expect(seenIds.size).toBe(REQUEST_COUNT);
    for (let i = 0; i < REQUEST_COUNT; i++) {
      expect(seenIds.has(`req_${i}`)).toBe(true);
    }

    ws.close();
  });

  test("pending requests from disconnected client don't leak after cleanup", async () => {
    const manager = new SubprocessManager();
    managers.push(manager);

    const spawnResult = await manager.spawn(
      "slow",
      FIXTURES_DIR,
      SLOW_PLUGIN,
      FIXTURES_DIR,
      "1.0.0",
      { handshakeTimeoutMs: 5000 },
    );

    expect(spawnResult.ok).toBe(true);
    if (!spawnResult.ok) return;

    const handle = createTestServer({
      subprocessManager: manager,
      requestTimeoutMs: 300,
    });
    handle.router.attachPlugin("slow", spawnResult.process.transport);

    const { ws } = await connectAndAuth(getPort(handle));

    // Send 20 requests
    for (let i = 0; i < 20; i++) {
      ws.send(
        JSON.stringify({
          type: "request",
          id: `req_${i}`,
          plugin: "slow",
          action: "doSomething",
          params: { delay: 60_000 },
        }),
      );
    }

    await waitFor(() =>
      handle.router.getPendingRequestCount() >= 20 ? true : undefined,
    );

    // Disconnect — should clean up all pending requests immediately
    ws.close();

    await waitFor(() =>
      handle.router.getPendingRequestCount() === 0 ? true : undefined,
    );

    expect(handle.router.getPendingRequestCount()).toBe(0);
    expect(handle.router.getConnectionCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// JTI revocation
// ---------------------------------------------------------------------------

describe("JTI revocation", () => {
  test("rejects auth when JTI is in revocation set", async () => {
    const revocationSet = new JtiRevocationSet();
    revocationSet.add("revoked-jti-1");

    // Token validator returns a JTI
    const validator: TokenValidator = {
      async validate(token: string): Promise<TokenValidationResult> {
        if (token === TEST_TOKEN) {
          return { ok: true, user: testUser, jti: "revoked-jti-1" };
        }
        return { ok: false, code: "INVALID_TOKEN", message: "Invalid" };
      },
    };

    const handle = createTestServer({
      tokenValidator: validator,
      revocationSet,
    });

    const { ws, authResult } = await connectAndAuth(getPort(handle));

    expect(authResult.ok).toBe(false);
    expect(authResult.error).toBe("Token has been revoked");

    // Connection should be closed
    await new Promise<void>((resolve) => {
      ws.onclose = () => resolve();
      if (ws.readyState === WebSocket.CLOSED) resolve();
    });
  });

  test("accepts auth when JTI is not revoked", async () => {
    const revocationSet = new JtiRevocationSet();
    revocationSet.add("other-jti");

    const validator: TokenValidator = {
      async validate(token: string): Promise<TokenValidationResult> {
        if (token === TEST_TOKEN) {
          return { ok: true, user: testUser, jti: "clean-jti" };
        }
        return { ok: false, code: "INVALID_TOKEN", message: "Invalid" };
      },
    };

    const handle = createTestServer({
      tokenValidator: validator,
      revocationSet,
    });

    const { ws, authResult } = await connectAndAuth(getPort(handle));

    expect(authResult.ok).toBe(true);
    ws.close();
  });

  test("accepts auth when no revocation set is configured", async () => {
    // Default — no revocation set
    const handle = createTestServer();
    const { ws, authResult } = await connectAndAuth(getPort(handle));

    expect(authResult.ok).toBe(true);
    ws.close();
  });

  test("seenJtis is per-handle — sibling server does not see another's JTIs", async () => {
    // Regression for H6: when seenJtis was module-scoped, a JTI accepted on
    // one createWsServer() handle would falsely reject the same token's first
    // use on a second handle as "already used". Now that the map lives in
    // closure scope, two handles in the same process must be independent.
    const validator: TokenValidator = {
      async validate(token: string): Promise<TokenValidationResult> {
        if (token === TEST_TOKEN) {
          return { ok: true, user: testUser, jti: "shared-jti-across-handles" };
        }
        return { ok: false, code: "INVALID_TOKEN", message: "Invalid" };
      },
    };

    const handleA = createTestServer({ tokenValidator: validator });
    const handleB = createTestServer({ tokenValidator: validator });

    const { ws: wsA, authResult: authA } = await connectAndAuth(getPort(handleA));
    expect(authA.ok).toBe(true);
    wsA.close();

    const { ws: wsB, authResult: authB } = await connectAndAuth(getPort(handleB));
    expect(authB.ok).toBe(true);
    expect(authB.error).toBeUndefined();
    wsB.close();

    // And confirm replay protection still works within a single handle: a
    // second connection to handleA with the same JTI must be rejected.
    const { ws: wsAReplay, authResult: replayResult } = await connectAndAuth(getPort(handleA));
    expect(replayResult.ok).toBe(false);
    expect(replayResult.error).toBe("Token already used");
    wsAReplay.close();
  });
});

// ---------------------------------------------------------------------------
// WebSocket rate limiting (C4)
// ---------------------------------------------------------------------------

describe("WebSocket rate limiting", () => {
  test("rejects WS connection when connection rate limit exceeded", async () => {
    const rateLimiter = new RateLimiter();
    const handle = createTestServer({
      rateLimiter,
      getClientIp: () => "test-ip",
    });
    const port = getPort(handle);

    // Exhaust the connection rate limit (10/min)
    for (let i = 0; i < RATE_WS_CONNECT.tokens; i++) {
      rateLimiter.consume(`ws:connect:test-ip`, RATE_WS_CONNECT);
    }

    // Next connection attempt should be rejected with 429
    const response = await fetch(`http://localhost:${port}/ws`, {
      headers: { Upgrade: "websocket" },
    });

    expect(response.status).toBe(429);
    const body = (await response.json()) as { error: string; retry_after: number };
    expect(body.error).toBe("RATE_LIMITED");
    expect(body.retry_after).toBeGreaterThan(0);
  });

  test("rejects WS connection when IP is banned", async () => {
    const rateLimiter = new RateLimiter();
    const handle = createTestServer({
      rateLimiter,
      getClientIp: () => "banned-ip",
    });
    const port = getPort(handle);

    // Trigger a ban by recording auth failures
    for (let i = 0; i < 3; i++) {
      rateLimiter.recordAuthFailure("banned-ip");
    }

    // Connection attempt should be rejected
    const response = await fetch(`http://localhost:${port}/ws`, {
      headers: { Upgrade: "websocket" },
    });

    expect(response.status).toBe(429);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("IP_BANNED");
  });

  test("auth failure records in rate limiter", async () => {
    const rateLimiter = new RateLimiter();
    const handle = createTestServer({
      rateLimiter,
      getClientIp: () => "auth-fail-ip",
    });
    const port = getPort(handle);

    // Send invalid token — should record auth failure
    const { ws } = await connectAndAuth(port, "bad-token");

    // Wait for close
    await new Promise<void>((resolve) => {
      ws.onclose = () => resolve();
      if (ws.readyState === WebSocket.CLOSED) resolve();
    });

    // Check that the failure was recorded (isBanned won't be true yet — need 3 failures)
    // After 3 failures it should ban
    const { ws: ws2 } = await connectAndAuth(port, "bad-token");
    await new Promise<void>((resolve) => {
      ws2.onclose = () => resolve();
      if (ws2.readyState === WebSocket.CLOSED) resolve();
    });

    const { ws: ws3 } = await connectAndAuth(port, "bad-token");
    await new Promise<void>((resolve) => {
      ws3.onclose = () => resolve();
      if (ws3.readyState === WebSocket.CLOSED) resolve();
    });

    // Now the IP should be banned
    const banResult = rateLimiter.isBanned("auth-fail-ip");
    expect(banResult.banned).toBe(true);
  });

  test("auth success resets failure counter", async () => {
    const rateLimiter = new RateLimiter();
    const handle = createTestServer({
      rateLimiter,
      getClientIp: () => "reset-ip",
    });
    const port = getPort(handle);

    // Record 2 failures
    rateLimiter.recordAuthFailure("reset-ip");
    rateLimiter.recordAuthFailure("reset-ip");

    // Successful auth should reset
    const { ws } = await connectAndAuth(port, TEST_TOKEN);
    ws.close();

    // Wait for close to propagate
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    // Counter should be reset — not banned even after 2 prior failures
    const banResult = rateLimiter.isBanned("reset-ip");
    expect(banResult.banned).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Malformed message handling (M9)
// ---------------------------------------------------------------------------

describe("malformed message handling", () => {
  test("authenticated client sending parseable-but-invalid message receives error response", async () => {
    const handle = createTestServer();
    const { ws } = await connectAndAuth(getPort(handle));

    const errorPromise = nextMessage(ws);

    // Send a valid JSON object that is not a valid ClientMessage
    ws.send(JSON.stringify({ bad: true }));

    const response = (await errorPromise) as { type: string; message: string };

    expect(response.type).toBe("error");
    expect(response.message).toBe("Malformed message");

    // Connection stays open
    expect(ws.readyState).not.toBe(WebSocket.CLOSED);

    ws.close();
  });
});
