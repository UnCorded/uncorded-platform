import { describe, expect, test } from "bun:test";
import {
  HOP_BY_HOP,
  measureHeaderBytes,
  sanitizeRequestHeaders,
  sanitizeResponseHeaders,
  type ForwardedContext,
} from "./headers";

const CTX: ForwardedContext = {
  upstreamHost: "upstream.internal:30000",
  forwardedHost: "central.uncorded.app",
  forwardedProto: "https",
  forwardedFor: "203.0.113.7",
  userId: "user-42",
  forwardedPrefix: "/proxy/x/app",
};

describe("sanitizeRequestHeaders", () => {
  test("strips hop-by-hop, cookie, host, and forwarded-identity; forces identity encoding", () => {
    const inbound = new Headers();
    inbound.set("accept", "text/html");
    inbound.set("content-type", "application/json");
    inbound.set("cookie", "uncorded-proxy-x-app=tok; app=1");
    inbound.set("host", "central.uncorded.app");
    inbound.set("transfer-encoding", "chunked");
    inbound.set("accept-encoding", "gzip, br, zstd");
    inbound.set("referer", "https://central.uncorded.app/proxy-open/x/app?ticket=secret");
    inbound.set("x-forwarded-for", "1.2.3.4");
    inbound.set("x-uncorded-user-id", "attacker");
    inbound.set("x-forwarded-prefix", "/spoofed");

    const out = sanitizeRequestHeaders(inbound, null, CTX);

    expect(out.get("accept")).toBe("text/html");
    expect(out.get("content-type")).toBe("application/json");
    expect(out.get("transfer-encoding")).toBeNull();
    // Accept-Encoding is normalized to identity — the runtime decodes/rewrites
    // bodies itself, so upstream compression only buys a header lie to undo.
    expect(out.get("accept-encoding")).toBe("identity");
    // Referer is stripped — it can carry the /proxy-open handoff ticket.
    expect(out.get("referer")).toBeNull();

    // Forwarded identity is runtime-owned, not client-supplied.
    expect(out.get("host")).toBe("upstream.internal:30000");
    expect(out.get("x-forwarded-for")).toBe("203.0.113.7");
    expect(out.get("x-forwarded-host")).toBe("central.uncorded.app");
    expect(out.get("x-forwarded-proto")).toBe("https");
    expect(out.get("x-uncorded-user-id")).toBe("user-42");
    // The public mount path is runtime-owned; a client-supplied value is dropped.
    expect(out.get("x-forwarded-prefix")).toBe("/proxy/x/app");

    // No cookie supplied ⇒ none forwarded.
    expect(out.get("cookie")).toBeNull();
  });

  test("forwards the reconstructed upstream cookie when provided", () => {
    const out = sanitizeRequestHeaders(new Headers(), "app=1; pref=dark", CTX);
    expect(out.get("cookie")).toBe("app=1; pref=dark");
  });

  test("forwards the app's own Authorization so token-auth apps work", () => {
    const inbound = new Headers();
    inbound.set("authorization", "Bearer app-jwt-from-localStorage");
    const out = sanitizeRequestHeaders(inbound, null, CTX);
    expect(out.get("authorization")).toBe("Bearer app-jwt-from-localStorage");
  });

  test("drops headers named by the Connection token list", () => {
    const inbound = new Headers();
    inbound.set("connection", "x-custom, keep-alive");
    inbound.set("x-custom", "should-be-dropped");
    inbound.set("accept", "*/*");

    const out = sanitizeRequestHeaders(inbound, null, CTX);
    expect(out.get("x-custom")).toBeNull();
    expect(out.get("connection")).toBeNull();
    expect(out.get("accept")).toBe("*/*");
  });

  test("HOP_BY_HOP names are all stripped", () => {
    const inbound = new Headers();
    for (const name of HOP_BY_HOP) inbound.set(name, "v");
    inbound.set("accept", "*/*");
    const out = sanitizeRequestHeaders(inbound, null, CTX);
    for (const name of HOP_BY_HOP) expect(out.get(name)).toBeNull();
  });
});

describe("sanitizeResponseHeaders", () => {
  test("strips hop-by-hop and Set-Cookie but preserves CSP and X-Frame-Options", () => {
    const upstream = new Headers();
    upstream.set("content-type", "text/html");
    upstream.set("content-security-policy", "default-src 'self'");
    upstream.set("x-frame-options", "SAMEORIGIN");
    upstream.set("transfer-encoding", "chunked");
    upstream.append("set-cookie", "sid=1; Path=/");

    const out = sanitizeResponseHeaders(upstream);
    expect(out.get("content-type")).toBe("text/html");
    // Iframe-blocking headers are NOT stripped — that policy belongs to the app.
    expect(out.get("content-security-policy")).toBe("default-src 'self'");
    expect(out.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(out.get("transfer-encoding")).toBeNull();
    expect(out.getSetCookie()).toHaveLength(0);
  });
});

describe("measureHeaderBytes", () => {
  test("counts name + value + framing, including each Set-Cookie separately", () => {
    const base = new Headers();
    base.set("x-a", "b"); // 3 + 1 + 4 = 8
    expect(measureHeaderBytes(base)).toBe(8);

    base.append("set-cookie", "c=d"); // + 10 + 3 + 4 = 17
    expect(measureHeaderBytes(base)).toBe(25);
  });
});
