import { afterEach, describe, expect, test } from "bun:test";
import type { Logger } from "@uncorded/shared";
import { createHeartbeatClient } from "./client";
import type {
  CentralConnection,
  DeltaHandlers,
  HeartbeatClientOptions,
  HeartbeatDelta,
  HeartbeatResponse,
  PublicKeyEntry,
} from "./types";

interface CapturedLine {
  readonly level: "debug" | "info" | "warn" | "error";
  readonly msg: string;
  readonly ctx: Record<string, unknown>;
}

function makeCapturingLogger(): { logger: Logger; lines: CapturedLine[] } {
  const lines: CapturedLine[] = [];
  const make = (): Logger => ({
    debug: (msg, ctx) => { lines.push({ level: "debug", msg, ctx: ctx ?? {} }); },
    info:  (msg, ctx) => { lines.push({ level: "info",  msg, ctx: ctx ?? {} }); },
    warn:  (msg, ctx) => { lines.push({ level: "warn",  msg, ctx: ctx ?? {} }); },
    error: (msg, ctx) => { lines.push({ level: "error", msg, ctx: ctx ?? {} }); },
    child: () => make(),
  });
  return { logger: make(), lines };
}

/** Create a minimal PublicKeyEntry for tests (no real crypto needed). */
function mkKey(id: string): PublicKeyEntry {
  return { id, public_key: { kty: "OKP", crv: "Ed25519", x: id } as JsonWebKey };
}

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

type FetchFn = HeartbeatClientOptions["fetch"] & {};
type MockResponse = { status: number; body: unknown } | "network-error";

function createMockFetch(
  responses: MockResponse[],
): { fetch: FetchFn; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  let index = 0;

  const fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const entry = responses[index++];
    if (entry === undefined) {
      throw new Error("Mock fetch exhausted — no more responses");
    }
    calls.push({ url: String(input), init: init ?? {} });
    if (entry === "network-error") {
      throw new TypeError("fetch failed");
    }
    return new Response(JSON.stringify(entry.body), {
      status: entry.status,
      headers: { "Content-Type": "application/json" },
    });
  };

  return { fetch: fetch as FetchFn, calls };
}

function defaultOptions(
  overrides?: Partial<HeartbeatClientOptions>,
): HeartbeatClientOptions {
  return {
    centralUrl: "https://central.uncorded.app",
    serverId: "server_test",
    serverSecret: "sk_test_secret",
    runtimeVersion: "1.0.0",
    getTunnelUrl: () => "https://test.trycloudflare.com",
    getConnectedUsers: () => 5,
    getPluginCount: () => 3,
    deltaHandlers: {},
    intervalMs: 100,
    ...overrides,
  };
}

const CLEAN_RESPONSE: HeartbeatResponse = { dirty: false };

function dirtyResponse(
  overrides?: Partial<Extract<HeartbeatResponse, { dirty: true }>>,
): HeartbeatResponse {
  return {
    dirty: true,
    sync_version: 10,
    public_keys: [mkKey("key-a"), mkKey("key-b")],
    deltas: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let client: CentralConnection | null = null;

afterEach(() => {
  client?.stop();
  client = null;
});

// ---------------------------------------------------------------------------
// 1. Basic polling — happy path
// ---------------------------------------------------------------------------

describe("poll — happy path", () => {
  test("dirty: false returns ok with no deltas applied", async () => {
    const { fetch } = createMockFetch([{ status: 200, body: CLEAN_RESPONSE }]);
    client = createHeartbeatClient(defaultOptions({ fetch }));
    const result = await client.poll();
    expect(result).toEqual({ ok: true, dirty: false, deltasApplied: 0 });
  });

  test("dirty: true updates keys, advances sync version, reports delta count", async () => {
    const banned: Record<string, string> = {};
    const handlers: DeltaHandlers = {
      "user.banned": (d) => { banned[d.user_id] = d.reason; },
    };
    const { fetch } = createMockFetch([
      {
        status: 200,
        body: dirtyResponse({
          sync_version: 7,
          public_keys: [mkKey("new-key")],
          deltas: [{ type: "user.banned", user_id: "u1", reason: "spam" }],
        }),
      },
    ]);
    client = createHeartbeatClient(defaultOptions({ fetch, deltaHandlers: handlers }));
    const result = await client.poll();

    expect(result).toEqual({ ok: true, dirty: true, deltasApplied: 1 });
    expect(client.getPublicKeys()).toEqual([mkKey("new-key")]);
    expect(client.getSyncVersion()).toBe(7);
    expect(banned).toEqual({ u1: "spam" });
  });
});

// ---------------------------------------------------------------------------
// 2. Delta dispatch
// ---------------------------------------------------------------------------

describe("delta dispatch", () => {
  test("dispatches each delta type to its handler", async () => {
    const received: string[] = [];
    const handlers: DeltaHandlers = {
      "user.profile_changed": (d) => received.push(`profile:${d.user_id}`),
      "user.banned": (d) => received.push(`ban:${d.user_id}`),
      "token.revoked": (d) => received.push(`token:${d.jti}`),
      "plugin.revoked": (d) => received.push(`plugin:${d.plugin_slug}`),
      "ownership.transferred": (d) => received.push(`owner:${d.new_owner}`),
    };
    const { fetch } = createMockFetch([
      {
        status: 200,
        body: dirtyResponse({
          deltas: [
            { type: "user.profile_changed", user_id: "u1", username: "n_user", display_name: "N", avatar_url: "a" },
            { type: "user.banned", user_id: "u2", reason: "r" },
            { type: "token.revoked", jti: "tok1" },
            { type: "plugin.revoked", plugin_slug: "bad", version: "1.0" },
            { type: "ownership.transferred", new_owner: "u3" },
          ],
        }),
      },
    ]);
    client = createHeartbeatClient(defaultOptions({ fetch, deltaHandlers: handlers }));
    const result = await client.poll();

    expect(result).toEqual({ ok: true, dirty: true, deltasApplied: 5 });
    expect(received).toEqual([
      "profile:u1", "ban:u2", "token:tok1", "plugin:bad", "owner:u3",
    ]);
  });

  test("unknown delta type is skipped with warning", async () => {
    const warnings: string[] = [];
    const { fetch } = createMockFetch([
      {
        status: 200,
        body: dirtyResponse({
          deltas: [{ type: "future.new_thing" } as unknown as HeartbeatDelta],
        }),
      },
    ]);
    client = createHeartbeatClient(
      defaultOptions({ fetch, onWarn: (m) => warnings.push(m) }),
    );
    const result = await client.poll();

    expect(result).toEqual({ ok: true, dirty: true, deltasApplied: 0 });
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("future.new_thing");
  });

  test("handler that throws does not block subsequent deltas", async () => {
    const received: string[] = [];
    const warnings: string[] = [];
    const handlers: DeltaHandlers = {
      "user.banned": () => { throw new Error("handler boom"); },
      "token.revoked": (d) => received.push(d.jti),
    };
    const { fetch } = createMockFetch([
      {
        status: 200,
        body: dirtyResponse({
          deltas: [
            { type: "user.banned", user_id: "u1", reason: "r" },
            { type: "token.revoked", jti: "tok1" },
          ],
        }),
      },
    ]);
    client = createHeartbeatClient(
      defaultOptions({ fetch, deltaHandlers: handlers, onWarn: (m) => warnings.push(m) }),
    );
    const result = await client.poll();

    // banned handler threw so not counted, but token.revoked succeeded
    expect(result).toEqual({ ok: true, dirty: true, deltasApplied: 1 });
    expect(received).toEqual(["tok1"]);
    expect(warnings.some((w) => w.includes("handler boom"))).toBe(true);
  });

  test("empty deltas on dirty response still updates keys and version", async () => {
    const { fetch } = createMockFetch([
      { status: 200, body: dirtyResponse({ sync_version: 20, public_keys: [mkKey("k1")], deltas: [] }) },
    ]);
    client = createHeartbeatClient(defaultOptions({ fetch }));
    const result = await client.poll();

    expect(result).toEqual({ ok: true, dirty: true, deltasApplied: 0 });
    expect(client.getPublicKeys()).toEqual([mkKey("k1")]);
    expect(client.getSyncVersion()).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// 3. Public key caching
// ---------------------------------------------------------------------------

describe("public key caching", () => {
  test("starts empty when no cached keys provided", () => {
    const { fetch } = createMockFetch([]);
    client = createHeartbeatClient(defaultOptions({ fetch }));
    expect(client.getPublicKeys()).toEqual([]);
  });

  test("seeded from cachedPublicKeys before first poll", () => {
    const { fetch } = createMockFetch([]);
    client = createHeartbeatClient(
      defaultOptions({ fetch, cachedPublicKeys: [mkKey("seed-key")] }),
    );
    expect(client.getPublicKeys()).toEqual([mkKey("seed-key")]);
  });

  test("dirty response replaces all keys (not merge)", async () => {
    const { fetch } = createMockFetch([
      { status: 200, body: dirtyResponse({ public_keys: [mkKey("new-only")] }) },
    ]);
    client = createHeartbeatClient(
      defaultOptions({ fetch, cachedPublicKeys: [mkKey("old-key")] }),
    );
    await client.poll();
    expect(client.getPublicKeys()).toEqual([mkKey("new-only")]);
  });

  test("dirty: false does not change keys", async () => {
    const { fetch } = createMockFetch([{ status: 200, body: CLEAN_RESPONSE }]);
    client = createHeartbeatClient(
      defaultOptions({ fetch, cachedPublicKeys: [mkKey("stable-key")] }),
    );
    await client.poll();
    expect(client.getPublicKeys()).toEqual([mkKey("stable-key")]);
  });

  test("returned array is frozen (immutable)", () => {
    const { fetch } = createMockFetch([]);
    client = createHeartbeatClient(
      defaultOptions({ fetch, cachedPublicKeys: [mkKey("k")] }),
    );
    const keys = client.getPublicKeys();
    expect(Object.isFrozen(keys)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Central unreachable
// ---------------------------------------------------------------------------

describe("Central unreachable", () => {
  test("network error with no cached keys returns CENTRAL_UNREACHABLE", async () => {
    const { fetch } = createMockFetch(["network-error"]);
    client = createHeartbeatClient(defaultOptions({ fetch }));
    const result = await client.poll();

    expect(result).toEqual({
      ok: false,
      error: { code: "CENTRAL_UNREACHABLE", message: "Failed to reach Central" },
    });
  });

  test("network error with cached keys returns error and calls onWarn", async () => {
    const warnings: string[] = [];
    const { fetch } = createMockFetch(["network-error"]);
    client = createHeartbeatClient(
      defaultOptions({
        fetch,
        cachedPublicKeys: [mkKey("cached")],
        onWarn: (m) => warnings.push(m),
      }),
    );
    const result = await client.poll();

    expect(result.ok).toBe(false);
    expect(client.getPublicKeys()).toEqual([mkKey("cached")]);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("cached keys");
  });

  test("HTTP 500 returns HTTP_ERROR", async () => {
    const { fetch } = createMockFetch([{ status: 500, body: { error: "boom" } }]);
    client = createHeartbeatClient(defaultOptions({ fetch }));
    const result = await client.poll();

    expect(result).toEqual({
      ok: false,
      error: { code: "HTTP_ERROR", message: "Central returned 500" },
    });
  });

  test("HTTP 401 returns HTTP_ERROR", async () => {
    const { fetch } = createMockFetch([{ status: 401, body: { error: "unauthorized" } }]);
    client = createHeartbeatClient(defaultOptions({ fetch }));
    const result = await client.poll();

    expect(result).toEqual({
      ok: false,
      error: { code: "HTTP_ERROR", message: "Central returned 401" },
    });
  });
});

// ---------------------------------------------------------------------------
// Server-deleted detection (persistent 404)
// ---------------------------------------------------------------------------

describe("server deleted (persistent 404)", () => {
  let client: CentralConnection | null = null;
  afterEach(() => { client?.stop(); client = null; });

  test("single 404 returns SERVER_DELETED but does not fire callback", async () => {
    const { fetch } = createMockFetch([{ status: 404, body: { error: "not found" } }]);
    let fired = 0;
    client = createHeartbeatClient(
      defaultOptions({ fetch, onServerDeleted: () => { fired++; } }),
    );

    const result = await client.poll();

    expect(result).toEqual({
      ok: false,
      error: { code: "SERVER_DELETED", message: "Central returned 404 (1 consecutive)" },
    });
    expect(fired).toBe(0);
  });

  test("callback fires after N consecutive 404s", async () => {
    const { fetch } = createMockFetch([
      { status: 404, body: {} },
      { status: 404, body: {} },
      { status: 404, body: {} },
    ]);
    let fired = 0;
    client = createHeartbeatClient(
      defaultOptions({
        fetch,
        onServerDeleted: () => { fired++; },
        serverDeletedThreshold: 3,
      }),
    );

    await client.poll();
    expect(fired).toBe(0);
    await client.poll();
    expect(fired).toBe(0);
    await client.poll();
    expect(fired).toBe(1);
  });

  test("callback fires only once across many 404s", async () => {
    const { fetch } = createMockFetch(
      Array.from({ length: 6 }, () => ({ status: 404, body: {} })),
    );
    let fired = 0;
    client = createHeartbeatClient(
      defaultOptions({
        fetch,
        onServerDeleted: () => { fired++; },
        serverDeletedThreshold: 2,
      }),
    );

    for (let i = 0; i < 6; i++) await client.poll();
    expect(fired).toBe(1);
  });

  test("a successful poll resets the 404 counter", async () => {
    const { fetch } = createMockFetch([
      { status: 404, body: {} },
      { status: 404, body: {} },
      { status: 200, body: CLEAN_RESPONSE },
      { status: 404, body: {} },
      { status: 404, body: {} },
    ]);
    let fired = 0;
    client = createHeartbeatClient(
      defaultOptions({
        fetch,
        onServerDeleted: () => { fired++; },
        serverDeletedThreshold: 3,
      }),
    );

    // 2x 404 then one OK — counter resets
    await client.poll();
    await client.poll();
    await client.poll();
    expect(fired).toBe(0);
    // 2x 404 now — still under threshold (counter started from 0)
    await client.poll();
    await client.poll();
    expect(fired).toBe(0);
  });

  test("non-404 errors (500) do not count toward the threshold", async () => {
    const { fetch } = createMockFetch([
      { status: 500, body: {} },
      { status: 500, body: {} },
      { status: 500, body: {} },
    ]);
    let fired = 0;
    client = createHeartbeatClient(
      defaultOptions({
        fetch,
        onServerDeleted: () => { fired++; },
        serverDeletedThreshold: 2,
      }),
    );

    await client.poll();
    await client.poll();
    await client.poll();
    expect(fired).toBe(0);
  });

  test("callback throwing does not break subsequent polls", async () => {
    const { fetch } = createMockFetch([
      { status: 404, body: {} },
      { status: 404, body: {} },
      { status: 404, body: {} },
      { status: 404, body: {} },
    ]);
    const warnings: string[] = [];
    client = createHeartbeatClient(
      defaultOptions({
        fetch,
        serverDeletedThreshold: 2,
        onServerDeleted: () => { throw new Error("handler broke"); },
        onWarn: (m) => warnings.push(m),
      }),
    );

    await client.poll();
    const result = await client.poll();
    await client.poll();
    await client.poll();

    expect(result.ok).toBe(false);
    expect(warnings.some((w) => /onServerDeleted threw/.test(w))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. Malformed responses
// ---------------------------------------------------------------------------

describe("malformed responses", () => {
  test("non-JSON body returns INVALID_RESPONSE", async () => {
    const fetch = (async (): Promise<Response> =>
      new Response("not json", { status: 200 })) as unknown as FetchFn;
    client = createHeartbeatClient(
      defaultOptions({ fetch }),
    );
    const result = await client.poll();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_RESPONSE");
    }
  });

  test("missing dirty field returns INVALID_RESPONSE", async () => {
    const { fetch } = createMockFetch([{ status: 200, body: { something: "else" } }]);
    client = createHeartbeatClient(defaultOptions({ fetch }));
    const result = await client.poll();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_RESPONSE");
    }
  });

  test("dirty: true but missing sync_version returns INVALID_RESPONSE", async () => {
    const { fetch } = createMockFetch([
      { status: 200, body: { dirty: true, public_keys: [], deltas: [] } },
    ]);
    client = createHeartbeatClient(defaultOptions({ fetch }));
    const result = await client.poll();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_RESPONSE");
    }
  });

  test("dirty: true but deltas is not an array returns INVALID_RESPONSE", async () => {
    const { fetch } = createMockFetch([
      { status: 200, body: { dirty: true, sync_version: 1, public_keys: [], deltas: "not-array" } },
    ]);
    client = createHeartbeatClient(defaultOptions({ fetch }));
    const result = await client.poll();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_RESPONSE");
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Sync version tracking
// ---------------------------------------------------------------------------

describe("sync version tracking", () => {
  test("starts at 0 by default", () => {
    const { fetch } = createMockFetch([]);
    client = createHeartbeatClient(defaultOptions({ fetch }));
    expect(client.getSyncVersion()).toBe(0);
  });

  test("starts at cachedSyncVersion when provided", () => {
    const { fetch } = createMockFetch([]);
    client = createHeartbeatClient(defaultOptions({ fetch, cachedSyncVersion: 42 }));
    expect(client.getSyncVersion()).toBe(42);
  });

  test("advances only on dirty response", async () => {
    const { fetch } = createMockFetch([
      { status: 200, body: CLEAN_RESPONSE },
      { status: 200, body: dirtyResponse({ sync_version: 15 }) },
    ]);
    client = createHeartbeatClient(defaultOptions({ fetch }));

    await client.poll();
    expect(client.getSyncVersion()).toBe(0);

    await client.poll();
    expect(client.getSyncVersion()).toBe(15);
  });

  test("request payload includes current lastSyncVersion", async () => {
    const { fetch, calls } = createMockFetch([
      { status: 200, body: dirtyResponse({ sync_version: 5 }) },
      { status: 200, body: CLEAN_RESPONSE },
    ]);
    client = createHeartbeatClient(defaultOptions({ fetch, cachedSyncVersion: 3 }));

    await client.poll();
    const body1 = JSON.parse(calls[0]!.init.body as string) as { last_sync_version: number };
    expect(body1.last_sync_version).toBe(3);

    await client.poll();
    const body2 = JSON.parse(calls[1]!.init.body as string) as { last_sync_version: number };
    expect(body2.last_sync_version).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// 7. Dynamic stats providers
// ---------------------------------------------------------------------------

describe("dynamic stats providers", () => {
  test("getters are called fresh on each poll", async () => {
    let users = 1;
    let plugins = 2;
    let tunnel = "https://a.com";
    const { fetch, calls } = createMockFetch([
      { status: 200, body: CLEAN_RESPONSE },
      { status: 200, body: CLEAN_RESPONSE },
    ]);
    client = createHeartbeatClient(
      defaultOptions({
        fetch,
        getConnectedUsers: () => users,
        getPluginCount: () => plugins,
        getTunnelUrl: () => tunnel,
      }),
    );

    await client.poll();
    const body1 = JSON.parse(calls[0]!.init.body as string) as {
      connected_users: number;
      plugin_count: number;
      tunnel_url: string;
    };
    expect(body1.connected_users).toBe(1);
    expect(body1.plugin_count).toBe(2);
    expect(body1.tunnel_url).toBe("https://a.com");

    users = 10;
    plugins = 5;
    tunnel = "https://b.com";

    await client.poll();
    const body2 = JSON.parse(calls[1]!.init.body as string) as {
      connected_users: number;
      plugin_count: number;
      tunnel_url: string;
    };
    expect(body2.connected_users).toBe(10);
    expect(body2.plugin_count).toBe(5);
    expect(body2.tunnel_url).toBe("https://b.com");
  });
});

// ---------------------------------------------------------------------------
// 8. Polling loop (start/stop)
// ---------------------------------------------------------------------------

describe("polling loop", () => {
  test("start calls poll immediately then on interval", async () => {
    let pollCount = 0;
    const timers: { cb: () => void; ms: number }[] = [];
    const { fetch } = createMockFetch(
      Array.from({ length: 10 }, () => ({ status: 200, body: CLEAN_RESPONSE })),
    );

    // Track poll calls via fetch invocations
    const wrappedFetch: FetchFn = (async (...args: Parameters<typeof fetch>) => {
      pollCount++;
      return fetch(...args);
    }) as FetchFn;

    client = createHeartbeatClient(
      defaultOptions({
        fetch: wrappedFetch,
        intervalMs: 500,
        setInterval: (cb, ms) => {
          timers.push({ cb, ms });
          return 1;
        },
        clearInterval: () => {},
      }),
    );

    client.start();

    // Wait a tick for the immediate poll() to complete
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(pollCount).toBe(1); // Immediate poll
    expect(timers.length).toBe(1);
    expect(timers[0]!.ms).toBe(500);
  });

  test("double start is a no-op", () => {
    const intervals: number[] = [];
    const { fetch } = createMockFetch(
      Array.from({ length: 10 }, () => ({ status: 200, body: CLEAN_RESPONSE })),
    );
    client = createHeartbeatClient(
      defaultOptions({
        fetch,
        setInterval: (cb, ms) => {
          intervals.push(ms);
          return 1;
        },
        clearInterval: () => {},
      }),
    );

    client.start();
    client.start();

    expect(intervals.length).toBe(1);
  });

  test("stop clears the interval", () => {
    const cleared: unknown[] = [];
    const { fetch } = createMockFetch(
      Array.from({ length: 10 }, () => ({ status: 200, body: CLEAN_RESPONSE })),
    );
    client = createHeartbeatClient(
      defaultOptions({
        fetch,
        setInterval: (_cb, _ms) => 42,
        clearInterval: (id) => cleared.push(id),
      }),
    );

    client.start();
    client.stop();

    expect(cleared).toEqual([42]);
  });

  test("stop when not started is a no-op", () => {
    const { fetch } = createMockFetch([]);
    client = createHeartbeatClient(defaultOptions({ fetch }));
    // Should not throw
    client.stop();
  });

  test("start catches unexpected poll errors and reports them via onWarn", async () => {
    const warnings: string[] = [];
    client = createHeartbeatClient(
      defaultOptions({
        fetch: (async () => new Response(JSON.stringify(CLEAN_RESPONSE), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })) as unknown as FetchFn,
        getTunnelUrl: () => {
          throw new Error("tunnel lookup failed");
        },
        onWarn: (message) => {
          warnings.push(message);
        },
        setInterval: () => 1,
        clearInterval: () => {},
      }),
    );

    client.start();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(warnings.some((warning) => warning.includes("tunnel lookup failed"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 9. Request shape
// ---------------------------------------------------------------------------

describe("request shape", () => {
  test("sends POST to centralUrl + /v1/servers/:id/heartbeat", async () => {
    const { fetch, calls } = createMockFetch([{ status: 200, body: CLEAN_RESPONSE }]);
    client = createHeartbeatClient(
      defaultOptions({ fetch, centralUrl: "https://central.example.com" }),
    );
    await client.poll();

    expect(calls[0]!.url).toBe(
      "https://central.example.com/v1/servers/server_test/heartbeat",
    );
    expect(calls[0]!.init.method).toBe("POST");
  });

  test("strips trailing slash from centralUrl", async () => {
    const { fetch, calls } = createMockFetch([{ status: 200, body: CLEAN_RESPONSE }]);
    client = createHeartbeatClient(
      defaultOptions({ fetch, centralUrl: "https://central.example.com/" }),
    );
    await client.poll();

    expect(calls[0]!.url).toBe(
      "https://central.example.com/v1/servers/server_test/heartbeat",
    );
  });

  test("sends Content-Type application/json", async () => {
    const { fetch, calls } = createMockFetch([{ status: 200, body: CLEAN_RESPONSE }]);
    client = createHeartbeatClient(defaultOptions({ fetch }));
    await client.poll();

    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
  });

  test("body matches HeartbeatRequest with current values", async () => {
    const { fetch, calls } = createMockFetch([{ status: 200, body: CLEAN_RESPONSE }]);
    client = createHeartbeatClient(
      defaultOptions({
        fetch,
        serverId: "srv_1",
        serverSecret: "sk_abc",
        runtimeVersion: "2.0.0",
        cachedSyncVersion: 99,
        getTunnelUrl: () => "https://tunnel.example.com",
        getConnectedUsers: () => 42,
        getPluginCount: () => 7,
      }),
    );
    await client.poll();

    const body = JSON.parse(calls[0]!.init.body as string) as Record<string, unknown>;
    expect(body).toEqual({
      server_id: "srv_1",
      server_secret: "sk_abc",
      last_sync_version: 99,
      tunnel_url: "https://tunnel.example.com",
      runtime_version: "2.0.0",
      connected_users: 42,
      plugin_count: 7,
    });
  });

  test("body includes channel + update_state when getUpdateState is provided (§11.5)", async () => {
    const { fetch, calls } = createMockFetch([{ status: 200, body: CLEAN_RESPONSE }]);
    const updateState = {
      state: "available" as const,
      errorContext: null,
      currentVersion: "2.0.0",
      availableVersion: "2.1.0",
      channel: "test" as const,
      progress: null,
      lastCheckedAt: 1700000000000,
      errorMessage: null,
      updatedAt: 1700000005000,
    };
    client = createHeartbeatClient(
      defaultOptions({
        fetch,
        getUpdateState: () => updateState,
      }),
    );
    await client.poll();

    const body = JSON.parse(calls[0]!.init.body as string) as Record<string, unknown>;
    expect(body["channel"]).toBe("test");
    expect(body["update_state"]).toEqual(updateState);
  });

  test("body omits channel + update_state when getUpdateState is undefined", async () => {
    const { fetch, calls } = createMockFetch([{ status: 200, body: CLEAN_RESPONSE }]);
    client = createHeartbeatClient(defaultOptions({ fetch }));
    await client.poll();

    const body = JSON.parse(calls[0]!.init.body as string) as Record<string, unknown>;
    expect("channel" in body).toBe(false);
    expect("update_state" in body).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 10. Edge case: dirty:false with no keys on first boot
// ---------------------------------------------------------------------------

describe("first boot edge cases", () => {
  test("dirty:false with no cached keys leaves getPublicKeys empty", async () => {
    const { fetch } = createMockFetch([{ status: 200, body: CLEAN_RESPONSE }]);
    client = createHeartbeatClient(defaultOptions({ fetch }));

    const result = await client.poll();
    expect(result).toEqual({ ok: true, dirty: false, deltasApplied: 0 });
    // Keys are still empty — orchestrator must check this and treat as fatal
    expect(client.getPublicKeys()).toEqual([]);
  });

  test("sync version advances even when delta handler throws for all deltas", async () => {
    const handlers: DeltaHandlers = {
      "user.banned": () => { throw new Error("fail"); },
    };
    const { fetch } = createMockFetch([
      {
        status: 200,
        body: dirtyResponse({
          sync_version: 50,
          deltas: [{ type: "user.banned", user_id: "u1", reason: "r" }],
        }),
      },
    ]);
    client = createHeartbeatClient(
      defaultOptions({ fetch, deltaHandlers: handlers, onWarn: () => {} }),
    );
    await client.poll();

    // Version advanced despite handler failure — prevents re-delivery loop
    expect(client.getSyncVersion()).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// 11. full_snapshot handling
// ---------------------------------------------------------------------------

describe("full_snapshot handling", () => {
  test("full_snapshot: true invokes onFullSnapshot callback", async () => {
    let called = false;
    const { fetch } = createMockFetch([
      {
        status: 200,
        body: dirtyResponse({ sync_version: 30, deltas: [], full_snapshot: true }),
      },
    ]);
    client = createHeartbeatClient(
      defaultOptions({
        fetch,
        onFullSnapshot: () => { called = true; },
        onWarn: () => {},
      }),
    );
    await client.poll();

    expect(called).toBe(true);
  });

  test("full_snapshot: true still updates keys and sync version", async () => {
    const { fetch } = createMockFetch([
      {
        status: 200,
        body: dirtyResponse({
          sync_version: 55,
          public_keys: [mkKey("snapshot-key")],
          deltas: [],
          full_snapshot: true,
        }),
      },
    ]);
    client = createHeartbeatClient(
      defaultOptions({ fetch, onFullSnapshot: () => {}, onWarn: () => {} }),
    );
    await client.poll();

    expect(client.getSyncVersion()).toBe(55);
    expect(client.getPublicKeys()).toEqual([mkKey("snapshot-key")]);
  });

  test("full_snapshot: false or absent does NOT invoke onFullSnapshot", async () => {
    let called = false;
    const { fetch } = createMockFetch([
      { status: 200, body: dirtyResponse({ sync_version: 10, deltas: [] }) },
      { status: 200, body: dirtyResponse({ sync_version: 11, deltas: [], full_snapshot: false }) },
    ]);
    client = createHeartbeatClient(
      defaultOptions({
        fetch,
        onFullSnapshot: () => { called = true; },
      }),
    );
    await client.poll();
    await client.poll();

    expect(called).toBe(false);
  });

  test("onFullSnapshot error is caught and warned", async () => {
    const warnings: string[] = [];
    const { fetch } = createMockFetch([
      {
        status: 200,
        body: dirtyResponse({ sync_version: 30, deltas: [], full_snapshot: true }),
      },
    ]);
    client = createHeartbeatClient(
      defaultOptions({
        fetch,
        onFullSnapshot: () => { throw new Error("callback boom"); },
        onWarn: (m) => warnings.push(m),
      }),
    );
    const result = await client.poll();

    expect(result).toEqual({ ok: true, dirty: true, deltasApplied: 0 });
    expect(warnings.some((w) => w.includes("callback boom"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 12. onDirtySync persistence callback (I8)
// ---------------------------------------------------------------------------

describe("onDirtySync callback", () => {
  test("called with correct version and keys after dirty poll", async () => {
    const syncs: { version: number; keys: readonly PublicKeyEntry[] }[] = [];
    const { fetch } = createMockFetch([
      { status: 200, body: dirtyResponse({ sync_version: 42, public_keys: [mkKey("k1"), mkKey("k2")] }) },
    ]);
    client = createHeartbeatClient(
      defaultOptions({
        fetch,
        onDirtySync: (version, keys) => { syncs.push({ version, keys }); },
      }),
    );
    await client.poll();

    expect(syncs).toHaveLength(1);
    expect(syncs[0]!.version).toBe(42);
    expect(syncs[0]!.keys).toEqual([mkKey("k1"), mkKey("k2")]);
  });

  test("NOT called after clean (dirty: false) poll", async () => {
    let called = false;
    const { fetch } = createMockFetch([{ status: 200, body: CLEAN_RESPONSE }]);
    client = createHeartbeatClient(
      defaultOptions({
        fetch,
        onDirtySync: () => { called = true; },
      }),
    );
    await client.poll();

    expect(called).toBe(false);
  });

  test("onDirtySync error does not break the poll result", async () => {
    const warnings: string[] = [];
    const { fetch } = createMockFetch([
      { status: 200, body: dirtyResponse({ sync_version: 10 }) },
    ]);
    client = createHeartbeatClient(
      defaultOptions({
        fetch,
        onDirtySync: () => { throw new Error("disk full"); },
        onWarn: (m) => warnings.push(m),
      }),
    );
    const result = await client.poll();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(result).toEqual({ ok: true, dirty: true, deltasApplied: 0 });
    expect(warnings.some((w) => w.includes("disk full"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 13. Public-key cache staleness alarm
// ---------------------------------------------------------------------------

describe("key cache staleness", () => {
  test("getKeysAgeMs returns null before any successful poll", () => {
    const { fetch } = createMockFetch([]);
    client = createHeartbeatClient(
      defaultOptions({
        fetch,
        cachedPublicKeys: [mkKey("from-disk")],
      }),
    );
    // Keys loaded from server.json carry no freshness guarantee — age is
    // null until a live poll confirms them.
    expect(client.getKeysAgeMs()).toBeNull();
    expect(client.areKeysStale()).toBe(false);
  });

  test("clean poll resets the freshness timestamp", async () => {
    let time = 1_000_000;
    const { fetch } = createMockFetch([
      { status: 200, body: CLEAN_RESPONSE },
    ]);
    client = createHeartbeatClient(
      defaultOptions({
        fetch,
        now: () => time,
        keyRotationWindowMs: 1000,
      }),
    );
    await client.poll();
    time += 500;
    expect(client.getKeysAgeMs()).toBe(500);
    expect(client.areKeysStale()).toBe(false);
  });

  test("dirty poll resets freshness and clears a previously-stale flag", async () => {
    let time = 1_000_000;
    const { fetch } = createMockFetch([
      { status: 200, body: dirtyResponse({ sync_version: 1, public_keys: [mkKey("a")] }) },
      "network-error",
      { status: 200, body: dirtyResponse({ sync_version: 2, public_keys: [mkKey("b")] }) },
    ]);
    let stale = 0;
    client = createHeartbeatClient(
      defaultOptions({
        fetch,
        now: () => time,
        keyRotationWindowMs: 1000,
        onKeysStale: () => { stale++; },
        onWarn: () => {},
      }),
    );
    await client.poll();            // fresh at t=1_000_000
    time += 3000;                   // 3× rotation window elapses
    await client.poll();            // network error; checkStale fires
    expect(stale).toBe(1);
    expect(client.areKeysStale()).toBe(true);

    time += 10;
    await client.poll();            // success → resets freshness
    expect(client.areKeysStale()).toBe(false);
    // A subsequent stale episode should fire again.
    time += 5000;
    // Trigger a poll attempt that fails so checkStale runs.
    // (re-adding an error response requires a fresh mock — simpler: call internal via future poll)
  });

  test("onKeysStale fires once per stale episode, not per poll", async () => {
    let time = 1_000_000;
    const responses: MockResponse[] = [
      { status: 200, body: CLEAN_RESPONSE }, // initial success → fresh
      "network-error",
      "network-error",
      "network-error",
    ];
    const { fetch } = createMockFetch(responses);
    let stale = 0;
    client = createHeartbeatClient(
      defaultOptions({
        fetch,
        now: () => time,
        keyRotationWindowMs: 1000, // stale threshold = 2000ms
        onKeysStale: () => { stale++; },
        onWarn: () => {},
      }),
    );
    await client.poll();      // fresh
    time += 2500;             // push over threshold
    await client.poll();      // failure → fire once
    await client.poll();      // failure → must NOT re-fire
    await client.poll();      // failure → must NOT re-fire
    expect(stale).toBe(1);
  });

  test("no successful poll ever → onKeysStale never fires even with cached keys", async () => {
    let time = 1_000_000;
    const { fetch } = createMockFetch([
      "network-error",
      "network-error",
    ]);
    let stale = 0;
    client = createHeartbeatClient(
      defaultOptions({
        fetch,
        now: () => time,
        keyRotationWindowMs: 1000,
        cachedPublicKeys: [mkKey("stale-from-disk")],
        onKeysStale: () => { stale++; },
        onWarn: () => {},
      }),
    );
    await client.poll();
    time += 1_000_000;
    await client.poll();
    // We never confirmed keys live, so we don't have an anchor to measure
    // staleness against — the alarm rightly stays silent. The boot path
    // enforces "keys or die" separately in main.ts.
    expect(stale).toBe(0);
    expect(client.areKeysStale()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// forceRefresh — single-flight + throttle
// ---------------------------------------------------------------------------

describe("forceRefresh", () => {
  test("calls pollOnce once when invoked", async () => {
    let time = 1_000_000;
    const { fetch, calls } = createMockFetch([{ status: 200, body: CLEAN_RESPONSE }]);
    client = createHeartbeatClient(defaultOptions({ fetch, now: () => time }));
    await client.forceRefresh();
    expect(calls).toHaveLength(1);
  });

  test("single-flight: two concurrent calls share one HTTP request", async () => {
    let time = 1_000_000;
    let resolveFetch: ((res: Response) => void) | null = null;
    const calls: string[] = [];
    const fetch = ((input: string | URL | Request): Promise<Response> => {
      calls.push(String(input));
      return new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      });
    }) as FetchFn;
    client = createHeartbeatClient(defaultOptions({ fetch, now: () => time }));
    const a = client.forceRefresh();
    const b = client.forceRefresh();
    expect(calls).toHaveLength(1);
    expect(resolveFetch).not.toBeNull();
    (resolveFetch as unknown as (res: Response) => void)(
      new Response(JSON.stringify(CLEAN_RESPONSE), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await Promise.all([a, b]);
    expect(calls).toHaveLength(1);
  });

  test("throttle: a second call within 5s is a no-op", async () => {
    let time = 1_000_000;
    const { fetch, calls } = createMockFetch([
      { status: 200, body: CLEAN_RESPONSE },
      { status: 200, body: CLEAN_RESPONSE },
    ]);
    client = createHeartbeatClient(defaultOptions({ fetch, now: () => time }));
    await client.forceRefresh();
    expect(calls).toHaveLength(1);
    time += 1_000; // still within 5s window
    await client.forceRefresh();
    expect(calls).toHaveLength(1);
    time += 5_000; // past window
    await client.forceRefresh();
    expect(calls).toHaveLength(2);
  });

  test("failed refresh still updates throttle timestamp", async () => {
    let time = 1_000_000;
    const { fetch, calls } = createMockFetch([
      "network-error",
      { status: 200, body: CLEAN_RESPONSE },
    ]);
    client = createHeartbeatClient(
      defaultOptions({ fetch, now: () => time, onWarn: () => {} }),
    );
    await client.forceRefresh();
    expect(calls).toHaveLength(1);
    time += 1_000;
    await client.forceRefresh();
    expect(calls).toHaveLength(1); // still throttled
    time += 5_000;
    await client.forceRefresh();
    expect(calls).toHaveLength(2);
  });
});

describe("happy-path debug logging", () => {
  test("clean response emits one debug line with wanIp + connectedUsers", async () => {
    const { logger, lines } = makeCapturingLogger();
    const { fetch } = createMockFetch([{ status: 200, body: { ...CLEAN_RESPONSE, wan_ip: "1.2.3.4" } }]);
    const client = createHeartbeatClient(defaultOptions({ fetch, logger }));
    await client.poll();
    expect(lines.length).toBe(1);
    expect(lines[0]!.level).toBe("debug");
    expect(lines[0]!.msg).toBe("heartbeat ok");
    expect(lines[0]!.ctx["dirty"]).toBe(false);
    expect(lines[0]!.ctx["wanIp"]).toBe("1.2.3.4");
    expect(lines[0]!.ctx["connectedUsers"]).toBe(5);
  });

  test("dirty response emits debug with deltasApplied count", async () => {
    const { logger, lines } = makeCapturingLogger();
    const { fetch } = createMockFetch([
      { status: 200, body: dirtyResponse({ deltas: [{ type: "user.banned", user_id: "u1", reason: "spam" }] }) },
    ]);
    const handlers: DeltaHandlers = { "user.banned": () => {} };
    const client = createHeartbeatClient(defaultOptions({ fetch, logger, deltaHandlers: handlers }));
    await client.poll();
    expect(lines.length).toBe(1);
    expect(lines[0]!.level).toBe("debug");
    expect(lines[0]!.ctx["dirty"]).toBe(true);
    expect(lines[0]!.ctx["deltasApplied"]).toBe(1);
  });

  test("logger is optional — client works silently without it", async () => {
    const { fetch } = createMockFetch([{ status: 200, body: CLEAN_RESPONSE }]);
    const client = createHeartbeatClient(defaultOptions({ fetch }));
    const result = await client.poll();
    expect(result.ok).toBe(true);
  });

  test("network error path does NOT emit a debug 'heartbeat ok' line", async () => {
    const { logger, lines } = makeCapturingLogger();
    const { fetch } = createMockFetch(["network-error"]);
    const client = createHeartbeatClient(defaultOptions({ fetch, logger }));
    await client.poll();
    expect(lines.find((l) => l.msg === "heartbeat ok")).toBeUndefined();
  });
});
