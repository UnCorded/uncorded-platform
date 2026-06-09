import { describe, expect, test } from "bun:test";
import { normalizeUpstream, type UpstreamErrorCode } from "./upstream";

describe("normalizeUpstream", () => {
  test("normalizes a simple https origin", () => {
    const r = normalizeUpstream("https://foundry.example.com");
    expect(r).toEqual({ ok: true, origin: "https://foundry.example.com", basePath: "/" });
  });

  test("preserves explicit port and lowercases host", () => {
    const r = normalizeUpstream("http://Foundry.Example.COM:30000/game");
    expect(r).toEqual({ ok: true, origin: "http://foundry.example.com:30000", basePath: "/game" });
  });

  test("strips a trailing slash from the base path", () => {
    const r = normalizeUpstream("http://host:8080/app/");
    expect(r).toEqual({ ok: true, origin: "http://host:8080", basePath: "/app" });
  });

  test("keeps the root base path as /", () => {
    const r = normalizeUpstream("http://host/");
    expect(r).toEqual({ ok: true, origin: "http://host", basePath: "/" });
  });

  test("accepts a bracketed IPv6 literal", () => {
    const r = normalizeUpstream("http://[2001:db8::1]:8080/x");
    expect(r).toEqual({ ok: true, origin: "http://[2001:db8::1]:8080", basePath: "/x" });
  });

  // ---- rejections ----

  const rejections: Array<[string, unknown, UpstreamErrorCode]> = [
    ["missing/empty", "   ", "UPSTREAM_MISSING"],
    ["non-string", 123, "UPSTREAM_MISSING"],
    ["relative URL", "/just/a/path", "UPSTREAM_NOT_ABSOLUTE"],
    ["non-http scheme", "ftp://host/x", "UPSTREAM_BAD_SCHEME"],
    ["file scheme", "file:///etc/passwd", "UPSTREAM_BAD_SCHEME"],
    ["userinfo", "http://user:pass@host/x", "UPSTREAM_HAS_USERINFO"],
    ["query string", "http://host/x?a=1", "UPSTREAM_HAS_QUERY"],
    ["fragment", "http://host/x#frag", "UPSTREAM_HAS_FRAGMENT"],
    ["unicode host", "http://exämple.com/", "UPSTREAM_BAD_HOST"],
    ["ipv6 zone id", "http://[fe80::1%25eth0]/", "UPSTREAM_MALFORMED"],
    ["out-of-range port", "http://host:99999/", "UPSTREAM_MALFORMED"],
  ];

  for (const [label, input, code] of rejections) {
    test(`rejects ${label}`, () => {
      const r = normalizeUpstream(input);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe(code);
    });
  }
});
