import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { probeChain } from "./check-frame";

const originalFetch = globalThis.fetch;
const originalDnsLookup = Bun.dns.lookup;

type DnsRecord = { address: string; family: number; ttl: number };

const noopLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as import("@uncorded/shared").Logger;

const ctx = { logger: noopLogger };

/** Mock handler receives the original hostname (from the pinned `Host` header)
 *  and a reconstructed `<protocol>//<hostname><pathname>` URL, so assertions
 *  stay readable even though the real fetch now dials a resolved IP with
 *  `Host: <hostname>` and `tls.serverName` overrides. */
function mockFetch(handler: (hostname: string, url: string, init: RequestInit) => Promise<Response>): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const urlObj = new URL(rawUrl);
    const hostHeader = init?.headers ? new Headers(init.headers).get("host") : null;
    const hostname = hostHeader ?? urlObj.hostname;
    const reconstructed = `${urlObj.protocol}//${hostname}${urlObj.pathname}${urlObj.search}`;
    return handler(hostname, reconstructed, init ?? {});
  }) as typeof fetch;
}

function mockDns(handler: (hostname: string) => DnsRecord[]): void {
  (Bun.dns as unknown as { lookup: (h: string) => Promise<DnsRecord[]> }).lookup =
    async (hostname: string) => handler(hostname);
}

beforeEach(() => {
  mockDns(() => [{ address: "93.184.216.34", family: 4, ttl: 60 }]);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  (Bun.dns as unknown as { lookup: typeof originalDnsLookup }).lookup = originalDnsLookup;
});

describe("probeChain", () => {
  test("returns true when target has no framing headers", async () => {
    mockFetch(async () => new Response(null, { status: 200 }));
    const result = await probeChain(new URL("https://example.com"), new AbortController().signal, ctx);
    expect(result).toBe(true);
  });

  test("returns false when X-Frame-Options=DENY", async () => {
    mockFetch(async () => new Response(null, { status: 200, headers: { "x-frame-options": "DENY" } }));
    const result = await probeChain(new URL("https://example.com"), new AbortController().signal, ctx);
    expect(result).toBe(false);
  });

  test("returns false when X-Frame-Options=SAMEORIGIN", async () => {
    mockFetch(async () => new Response(null, { status: 200, headers: { "x-frame-options": "SAMEORIGIN" } }));
    const result = await probeChain(new URL("https://example.com"), new AbortController().signal, ctx);
    expect(result).toBe(false);
  });

  test("returns false when CSP frame-ancestors is 'none'", async () => {
    mockFetch(async () => new Response(null, { status: 200, headers: { "content-security-policy": "frame-ancestors 'none'" } }));
    const result = await probeChain(new URL("https://example.com"), new AbortController().signal, ctx);
    expect(result).toBe(false);
  });

  test("returns false when CSP frame-ancestors is 'self'", async () => {
    mockFetch(async () => new Response(null, { status: 200, headers: { "content-security-policy": "default-src 'self'; frame-ancestors 'self'" } }));
    const result = await probeChain(new URL("https://example.com"), new AbortController().signal, ctx);
    expect(result).toBe(false);
  });

  test("returns true when CSP frame-ancestors is *", async () => {
    mockFetch(async () => new Response(null, { status: 200, headers: { "content-security-policy": "frame-ancestors *" } }));
    const result = await probeChain(new URL("https://example.com"), new AbortController().signal, ctx);
    expect(result).toBe(true);
  });

  test("follows redirect and reads framing headers from final response", async () => {
    // Regression: google.com 301s to www.google.com, which blocks framing.
    // Previously the probe stopped at the 301 and returned true.
    mockFetch(async (_hostname, url) => {
      if (url === "https://example.com/") {
        return new Response(null, { status: 301, headers: { location: "https://www.example.com/" } });
      }
      if (url === "https://www.example.com/") {
        return new Response(null, { status: 200, headers: { "x-frame-options": "SAMEORIGIN" } });
      }
      throw new Error(`unexpected url ${url}`);
    });
    const result = await probeChain(new URL("https://example.com"), new AbortController().signal, ctx);
    expect(result).toBe(false);
  });

  test("resolves relative redirect Location against current URL", async () => {
    mockFetch(async (_hostname, url) => {
      if (url === "https://example.com/a") {
        return new Response(null, { status: 302, headers: { location: "/b" } });
      }
      if (url === "https://example.com/b") {
        return new Response(null, { status: 200, headers: { "x-frame-options": "DENY" } });
      }
      throw new Error(`unexpected url ${url}`);
    });
    const result = await probeChain(new URL("https://example.com/a"), new AbortController().signal, ctx);
    expect(result).toBe(false);
  });

  test("blocks SSRF on redirect target (private IP)", async () => {
    mockDns((hostname) => {
      if (hostname === "example.com") return [{ address: "93.184.216.34", family: 4, ttl: 60 }];
      if (hostname === "internal.local") return [{ address: "10.0.0.5", family: 4, ttl: 60 }];
      return [];
    });
    mockFetch(async (_hostname, url) => {
      if (url === "https://example.com/") {
        return new Response(null, { status: 301, headers: { location: "https://internal.local/" } });
      }
      throw new Error(`unexpected url ${url}`);
    });
    const result = await probeChain(new URL("https://example.com"), new AbortController().signal, ctx);
    // Fails open — the private-IP hop aborts the chain.
    expect(result).toBe(true);
  });

  test("blocks SSRF on initial target (private IP)", async () => {
    mockDns(() => [{ address: "127.0.0.1", family: 4, ttl: 60 }]);
    mockFetch(async () => {
      throw new Error("fetch should not be called");
    });
    const result = await probeChain(new URL("https://localhost-alias.test"), new AbortController().signal, ctx);
    expect(result).toBe(true);
  });

  test("fails open when redirect chain exceeds MAX_REDIRECTS", async () => {
    mockFetch(async (_hostname, url) => {
      // Every request redirects — chain never terminates.
      const next = `${url}x`;
      return new Response(null, { status: 302, headers: { location: next } });
    });
    const result = await probeChain(new URL("https://example.com/"), new AbortController().signal, ctx);
    expect(result).toBe(true);
  });

  test("fails open when redirect has no Location header", async () => {
    mockFetch(async () => new Response(null, { status: 301 }));
    const result = await probeChain(new URL("https://example.com"), new AbortController().signal, ctx);
    expect(result).toBe(true);
  });

  test("fails open when redirect Location is non-http(s)", async () => {
    mockFetch(async () => new Response(null, { status: 301, headers: { location: "javascript:alert(1)" } }));
    const result = await probeChain(new URL("https://example.com"), new AbortController().signal, ctx);
    expect(result).toBe(true);
  });

  test("fails open on DNS lookup failure", async () => {
    mockDns(() => { throw new Error("ENOTFOUND"); });
    mockFetch(async () => new Response(null, { status: 200 }));
    const result = await probeChain(new URL("https://nonexistent.example"), new AbortController().signal, ctx);
    expect(result).toBe(true);
  });

  test("pins fetch to resolved IP and preserves hostname in Host header + SNI", async () => {
    // DNS-rebinding defense: after the SSRF IP check passes, the fetch must
    // dial the already-resolved IP rather than re-resolving, so an attacker
    // DNS server can't flip to a private address between the check and the
    // connection.
    mockDns(() => [{ address: "93.184.216.34", family: 4, ttl: 60 }]);
    const dialed: { url: string; init: RequestInit & { tls?: { serverName?: string } } } = {
      url: "",
      init: {},
    };
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      dialed.url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      dialed.init = (init ?? {}) as RequestInit & { tls?: { serverName?: string } };
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    const result = await probeChain(new URL("https://example.com/page"), new AbortController().signal, ctx);
    expect(result).toBe(true);

    // URL dialed uses the resolved IP, not the original hostname.
    expect(dialed.url).toBe("https://93.184.216.34/page");
    // Original hostname is preserved for virtual-host routing.
    expect(new Headers(dialed.init.headers).get("host")).toBe("example.com");
    // And for TLS SNI so certificate validation still succeeds.
    expect(dialed.init.tls?.serverName).toBe("example.com");
  });

  test("omits TLS serverName on http:// targets", async () => {
    mockDns(() => [{ address: "93.184.216.34", family: 4, ttl: 60 }]);
    const dialed: { init: RequestInit & { tls?: unknown } } = { init: {} };
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      dialed.init = (init ?? {}) as RequestInit & { tls?: unknown };
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    await probeChain(new URL("http://example.com/"), new AbortController().signal, ctx);
    expect(dialed.init.tls).toBeUndefined();
  });

  test("brackets IPv6 addresses in the pinned URL", async () => {
    mockDns(() => [{ address: "2606:2800:220:1:248:1893:25c8:1946", family: 6, ttl: 60 }]);
    const dialed = { url: "" };
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      dialed.url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    await probeChain(new URL("https://example.com/"), new AbortController().signal, ctx);
    expect(dialed.url).toBe("https://[2606:2800:220:1:248:1893:25c8:1946]/");
  });
});
