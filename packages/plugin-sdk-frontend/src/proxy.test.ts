import { describe, expect, test } from "bun:test";
import { ProxyError, createProxyClient, type ProxyMountSession } from "./proxy";

// The proxy client takes an injectable `fetchImpl`, so these run without a
// browser or a live runtime. We model the bootstrap surface the client uses:
// POST /proxy-sessions/<slug>/<mount> with a Bearer header, returning the
// `{ url, openUrl }` envelope on success or a `{ error: { code, message } }`
// envelope on failure.

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

/** A fetch double that records the call and resolves with the given Response. */
function fetchReturning(response: Response, sink?: FetchCall[]): typeof fetch {
  return ((url: string | URL | Request, init?: RequestInit) => {
    sink?.push({ url: String(url), init });
    return Promise.resolve(response);
  }) as typeof fetch;
}

/** A fetch double that rejects (offline / DNS / CORS preflight failure). */
function fetchRejecting(err: Error): typeof fetch {
  return (() => Promise.reject(err)) as typeof fetch;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeClient(fetchImpl: typeof fetch, sink?: FetchCall[]) {
  // sink is captured by the closure passed to fetchReturning; kept in the
  // signature only for symmetry with callers that build their own fetch.
  void sink;
  return createProxyClient({ slug: "foundry-vtt", token: "tok-123", fetchImpl });
}

describe("createProxyClient.openMount", () => {
  test("POSTs the Bearer-authed bootstrap and returns { iframeUrl, openUrl }", async () => {
    const calls: FetchCall[] = [];
    const client = makeClient(
      fetchReturning(
        jsonResponse(200, {
          url: "/proxy/foundry-vtt/foundry/",
          openUrl: "/proxy-open/foundry-vtt/foundry?ticket=abc.def",
        }),
        calls,
      ),
    );

    const session: ProxyMountSession = await client.openMount("foundry");

    expect(session).toEqual({
      iframeUrl: "/proxy/foundry-vtt/foundry/",
      openUrl: "/proxy-open/foundry-vtt/foundry?ticket=abc.def",
    });

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe("/proxy-sessions/foundry-vtt/foundry");
    expect(call.init?.method).toBe("POST");
    expect(call.init?.credentials).toBe("include");
    const headers = call.init?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer tok-123");
  });

  test("URL-encodes the slug and mount in the bootstrap path", async () => {
    const calls: FetchCall[] = [];
    const client = createProxyClient({
      slug: "with space",
      token: "t",
      fetchImpl: fetchReturning(jsonResponse(200, { url: "/u", openUrl: "/o" }), calls),
    });
    await client.openMount("mount/evil");
    expect(calls[0]!.url).toBe("/proxy-sessions/with%20space/mount%2Fevil");
  });

  test("rejects an empty mount name before fetching", async () => {
    const calls: FetchCall[] = [];
    const client = makeClient(fetchReturning(jsonResponse(200, {}), calls));
    await expect(client.openMount("")).rejects.toMatchObject({
      name: "ProxyError",
      code: "INVALID_ARGUMENT",
    });
    expect(calls).toHaveLength(0);
  });

  test("maps a 409 to NOT_APPROVED, preferring the server error envelope", async () => {
    const client = makeClient(
      fetchReturning(
        jsonResponse(409, { error: { code: "NOT_APPROVED", message: "Awaiting admin approval." } }),
      ),
    );
    await expect(client.openMount("foundry")).rejects.toMatchObject({
      name: "ProxyError",
      code: "NOT_APPROVED",
      message: "Awaiting admin approval.",
      status: 409,
    });
  });

  test("falls back to a status-derived code when the error body isn't an envelope", async () => {
    const client = makeClient(fetchReturning(new Response("nope", { status: 401 })));
    await expect(client.openMount("foundry")).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      status: 401,
    });
  });

  test("maps a 429 to RATE_LIMITED", async () => {
    const client = makeClient(fetchReturning(new Response("", { status: 429 })));
    await expect(client.openMount("foundry")).rejects.toMatchObject({
      code: "RATE_LIMITED",
      status: 429,
    });
  });

  test("an unrecognized non-2xx status maps to BOOTSTRAP_FAILED", async () => {
    const client = makeClient(fetchReturning(new Response("", { status: 500 })));
    await expect(client.openMount("foundry")).rejects.toMatchObject({
      code: "BOOTSTRAP_FAILED",
      status: 500,
    });
  });

  test("a rejected fetch surfaces as NETWORK_ERROR", async () => {
    const client = makeClient(fetchRejecting(new Error("Failed to fetch")));
    await expect(client.openMount("foundry")).rejects.toMatchObject({
      name: "ProxyError",
      code: "NETWORK_ERROR",
    });
  });

  test("a 2xx body missing openUrl is MALFORMED_RESPONSE", async () => {
    const client = makeClient(fetchReturning(jsonResponse(200, { url: "/proxy/foundry-vtt/foundry/" })));
    await expect(client.openMount("foundry")).rejects.toMatchObject({
      code: "MALFORMED_RESPONSE",
      status: 200,
    });
  });

  test("a 2xx body missing url is MALFORMED_RESPONSE", async () => {
    const client = makeClient(fetchReturning(jsonResponse(200, { openUrl: "/proxy-open/x" })));
    await expect(client.openMount("foundry")).rejects.toMatchObject({
      code: "MALFORMED_RESPONSE",
    });
  });

  test("a non-JSON 2xx body is MALFORMED_RESPONSE", async () => {
    const client = makeClient(fetchReturning(new Response("<html>", { status: 200 })));
    await expect(client.openMount("foundry")).rejects.toMatchObject({
      code: "MALFORMED_RESPONSE",
    });
  });

  test("ProxyError exposes code/status fields and is an Error", () => {
    const err = new ProxyError("X", "y", 418);
    expect(err.code).toBe("X");
    expect(err.message).toBe("y");
    expect(err.status).toBe(418);
    expect(err instanceof Error).toBe(true);
  });
});
