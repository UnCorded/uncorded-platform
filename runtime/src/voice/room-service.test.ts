import { describe, expect, test } from "bun:test";
import { removeParticipant, type RoomServiceConfig } from "./room-service";
import { decodeJwtPayloadUnverified } from "./tokens";

const TEST_API_KEY = "APIabc123";
const TEST_API_SECRET = "secret-bytes-at-least-32-characters-long-please";

// Bun's fetch type carries a static `preconnect` method that plain
// async functions don't satisfy. Tests cast through this alias to keep
// the helper signature ergonomic.
type FetchLike = (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>;

function buildConfig(fetchImpl: FetchLike, opts?: { timeoutMs?: number }): RoomServiceConfig {
  const config: RoomServiceConfig = {
    baseUrl: "http://127.0.0.1:7880",
    fetch: fetchImpl as typeof globalThis.fetch,
    getCredentials: async () => ({ apiKey: TEST_API_KEY, apiSecret: TEST_API_SECRET }),
  };
  if (opts?.timeoutMs !== undefined) config.timeoutMs = opts.timeoutMs;
  return config;
}

describe("removeParticipant", () => {
  test("posts to the Twirp RemoveParticipant endpoint with admin JWT and JSON body", async () => {
    let capturedUrl: string | undefined;
    let capturedAuth: string | undefined;
    let capturedBody: string | undefined;

    const fetchImpl: FetchLike = async (input, init) => {
      capturedUrl = String(input);
      const headers = new Headers((init?.headers ?? {}) as HeadersInit);
      capturedAuth = headers.get("authorization") ?? undefined;
      capturedBody = typeof init?.body === "string" ? init.body : "";
      return new Response("{}", { status: 200 });
    };

    const result = await removeParticipant(buildConfig(fetchImpl), {
      serverId: "srv-1",
      channelId: "ch-1",
      userId: "user-1",
    });

    expect(result.ok).toBe(true);
    expect(capturedUrl).toBe("http://127.0.0.1:7880/twirp/livekit.RoomService/RemoveParticipant");
    expect(capturedAuth?.startsWith("Bearer ")).toBe(true);

    // Verify the admin JWT carries the canonical room claim and roomAdmin grant.
    const token = capturedAuth!.slice("Bearer ".length);
    const payload = decodeJwtPayloadUnverified(token);
    expect(payload).not.toBeNull();
    expect(payload!["iss"]).toBe(TEST_API_KEY);
    const video = payload!["video"] as Record<string, unknown>;
    expect(video["room"]).toBe("server:srv-1:voice:ch-1");
    expect(video["roomAdmin"]).toBe(true);
    expect(video["roomJoin"]).toBeUndefined();

    // Body is JSON-encoded {room, identity}.
    const body = JSON.parse(capturedBody ?? "{}");
    expect(body).toEqual({ room: "server:srv-1:voice:ch-1", identity: "user-1" });
  });

  test("strips trailing slashes off baseUrl", async () => {
    let capturedUrl: string | undefined;
    const fetchImpl: FetchLike = async (input) => {
      capturedUrl = String(input);
      return new Response("{}", { status: 200 });
    };
    const config = buildConfig(fetchImpl);
    config.baseUrl = "http://127.0.0.1:7880///";

    await removeParticipant(config, { serverId: "s", channelId: "c", userId: "u" });
    expect(capturedUrl).toBe("http://127.0.0.1:7880/twirp/livekit.RoomService/RemoveParticipant");
  });

  test("maps 404 to NOT_FOUND", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ code: "not_found", msg: "no participant" }), { status: 404 });

    const result = await removeParticipant(buildConfig(fetchImpl), {
      serverId: "s",
      channelId: "c",
      userId: "u",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("NOT_FOUND");
    }
  });

  test("maps 401/403 to AUTH_FAILED", async () => {
    for (const status of [401, 403]) {
      const fetchImpl: FetchLike = async () =>
        new Response("denied", { status });
      const result = await removeParticipant(buildConfig(fetchImpl), {
        serverId: "s",
        channelId: "c",
        userId: "u",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("AUTH_FAILED");
    }
  });

  test("maps other non-2xx to UNEXPECTED with truncated body", async () => {
    const longBody = "x".repeat(1000);
    const fetchImpl: FetchLike = async () =>
      new Response(longBody, { status: 500 });
    const result = await removeParticipant(buildConfig(fetchImpl), {
      serverId: "s",
      channelId: "c",
      userId: "u",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("UNEXPECTED");
      expect(result.message).toContain("500");
      // Truncated to first 200 bytes.
      expect(result.message.length).toBeLessThan(longBody.length);
    }
  });

  test("maps fetch-level error to UNREACHABLE", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("ECONNREFUSED");
    };
    const result = await removeParticipant(buildConfig(fetchImpl), {
      serverId: "s",
      channelId: "c",
      userId: "u",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("UNREACHABLE");
      expect(result.message).toContain("ECONNREFUSED");
    }
  });

  test("maps abort-on-timeout to TIMEOUT", async () => {
    // fetch that never resolves until aborted.
    const fetchImpl: FetchLike = (_input, init) => {
      return new Promise((_resolve, reject) => {
        const signal = init?.signal as AbortSignal | undefined;
        signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    };

    const result = await removeParticipant(buildConfig(fetchImpl, { timeoutMs: 25 }), {
      serverId: "s",
      channelId: "c",
      userId: "u",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("TIMEOUT");
      expect(result.message).toContain("25");
    }
  });

  test("maps credential failure to AUTH_FAILED", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response("{}", { status: 200 });
    const result = await removeParticipant(
      {
        baseUrl: "http://127.0.0.1:7880",
        fetch: fetchImpl as typeof globalThis.fetch,
        getCredentials: async () => {
          throw new Error("vault sealed");
        },
      },
      { serverId: "s", channelId: "c", userId: "u" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("AUTH_FAILED");
      expect(result.message).toContain("vault sealed");
    }
  });
});
