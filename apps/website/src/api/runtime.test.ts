import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { bootstrapProxyMount } from "./runtime";
import { storeToken, clearAllTokens } from "../lib/tokens";
import { ApiError } from "./types";

// bootstrapProxyMount runs at the SHELL origin and calls the runtime over the
// tunnel. We stub global fetch to capture the request and shape the response,
// and seed a valid cached token so runtimeFetch never reaches Central.

type FetchCall = { url: string; init: RequestInit | undefined };

const originalFetch = globalThis.fetch;
let calls: FetchCall[] = [];

function stubFetch(handler: (call: FetchCall) => Response): void {
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const call = { url, init };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
}

const TUNNEL = "https://srv-1.tunnel.example";
const FAKE_TOKEN = "tok-abc";

// runtimeFetch resolves `getToken(id) ?? (await central.getServerToken(id)).token`.
// A sibling file (ws.test.ts) mocks @/api/central AND @/lib/tokens (storeToken→no-op)
// process-wide; Bun's mock.module leaks across files on Linux CI while isolating
// per-file on Windows (see memory: bun-mock-module-linux-leak). Under that leak our
// seeded token never lands — getToken() returns undefined and runtimeFetch falls
// through to ws.test.ts's poisoned getServerToken, failing every test here. Pin our
// own deterministic getServerToken so token resolution is hermetic regardless of file
// order; runtime.ts's live `import * as central` namespace access picks up the swap.
beforeAll(async () => {
  const central = await import("@/api/central");
  await mock.module("@/api/central", () => ({
    ...central,
    getServerToken: async () => ({ token: FAKE_TOKEN, expires_at: Date.now() / 1000 + 3600 }),
  }));
});

afterAll(async () => {
  // mock.module is sticky and process-wide. Leave central in a safe-reject state so a
  // leaked caller in a later file can't silently resolve our fake token — mirrors the
  // safe default ws.test.ts pins for exactly this reason.
  const central = await import("@/api/central");
  await mock.module("@/api/central", () => ({
    ...central,
    getServerToken: async () => {
      throw new ApiError("MOCK_DEFAULT", "getServerToken called after runtime.test.ts", 500);
    },
  }));
});

beforeEach(() => {
  // Far-future expiry so getToken() returns it and skips the Central round-trip on the
  // no-leak path; the beforeAll mock covers the Linux cross-file leak path.
  storeToken("srv-1", "tok-abc", Date.now() / 1000 + 3600, () => {});
});

afterEach(() => {
  clearAllTokens();
  globalThis.fetch = originalFetch;
});

describe("bootstrapProxyMount", () => {
  test("POSTs the proxy-sessions path with bearer + credentials include", async () => {
    stubFetch(() =>
      Response.json({ url: "/proxy/foundry/vtt/", openUrl: "/proxy-open/foundry/vtt?ticket=t1" }),
    );

    await bootstrapProxyMount(TUNNEL, "srv-1", "foundry", "vtt");

    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe(`${TUNNEL}/proxy-sessions/foundry/vtt`);
    expect(calls[0]!.init?.method).toBe("POST");
    expect(calls[0]!.init?.credentials).toBe("include");
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer tok-abc");
  });

  test("absolutizes relative url + openUrl against tunnelUrl", async () => {
    stubFetch(() =>
      Response.json({ url: "/proxy/foundry/vtt/", openUrl: "/proxy-open/foundry/vtt?ticket=t1" }),
    );

    const out = await bootstrapProxyMount(TUNNEL, "srv-1", "foundry", "vtt");

    expect(out.url).toBe(`${TUNNEL}/proxy/foundry/vtt/`);
    expect(out.openUrl).toBe(`${TUNNEL}/proxy-open/foundry/vtt?ticket=t1`);
  });

  test("url-encodes slug and mount in the request path", async () => {
    stubFetch(() => Response.json({ url: "/proxy/a/b/", openUrl: "/proxy-open/a/b?ticket=t" }));

    await bootstrapProxyMount(TUNNEL, "srv-1", "a b", "c/d");

    expect(calls[0]!.url).toBe(`${TUNNEL}/proxy-sessions/a%20b/c%2Fd`);
  });

  test("throws on non-OK response", async () => {
    stubFetch(
      () =>
        new Response(JSON.stringify({ error: { code: "PROXY_FORBIDDEN", message: "nope" } }), {
          status: 403,
        }),
    );

    await expect(bootstrapProxyMount(TUNNEL, "srv-1", "foundry", "vtt")).rejects.toThrow(
      /PROXY_FORBIDDEN/,
    );
  });

  test("throws MALFORMED_RESPONSE when url is missing", async () => {
    stubFetch(() => Response.json({ openUrl: "/proxy-open/foundry/vtt?ticket=t1" }));

    await expect(bootstrapProxyMount(TUNNEL, "srv-1", "foundry", "vtt")).rejects.toThrow(
      /MALFORMED_RESPONSE.*url/,
    );
  });

  test("throws MALFORMED_RESPONSE when openUrl is missing", async () => {
    stubFetch(() => Response.json({ url: "/proxy/foundry/vtt/" }));

    await expect(bootstrapProxyMount(TUNNEL, "srv-1", "foundry", "vtt")).rejects.toThrow(
      /MALFORMED_RESPONSE.*openUrl/,
    );
  });
});
