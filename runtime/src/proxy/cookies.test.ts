import { describe, expect, test } from "bun:test";
import { buildUpstreamCookieHeader, rewriteSetCookie, rewriteSetCookies } from "./cookies";

const MOUNT = "/proxy/foundry/app";

describe("buildUpstreamCookieHeader", () => {
  test("returns null for empty / missing input", () => {
    expect(buildUpstreamCookieHeader(null)).toBeNull();
    expect(buildUpstreamCookieHeader(undefined)).toBeNull();
    expect(buildUpstreamCookieHeader("")).toBeNull();
  });

  test("drops proxy-session cookies (prod + dev prefixes) and keeps app cookies", () => {
    const inbound =
      "__Host-uncorded-proxy-foundry-app=sess1; uncorded-proxy-other-x=sess2; sid=keep; theme=dark";
    expect(buildUpstreamCookieHeader(inbound)).toBe("sid=keep; theme=dark");
  });

  test("returns null when only proxy-session cookies are present", () => {
    expect(buildUpstreamCookieHeader("uncorded-proxy-foundry-app=tok")).toBeNull();
  });

  test("preserves cookie values verbatim", () => {
    expect(buildUpstreamCookieHeader("a=1; b=v=al=ue")).toBe("a=1; b=v=al=ue");
  });
});

describe("rewriteSetCookie", () => {
  test("drops Domain and rewrites an absent Path to the mount path", () => {
    const out = rewriteSetCookie("sid=abc; HttpOnly; Secure", MOUNT);
    expect(out.toLowerCase()).not.toContain("domain=");
    expect(out).toContain("sid=abc");
    expect(out).toContain("HttpOnly");
    expect(out).toContain("Secure");
    expect(out).toContain(`Path=${MOUNT}`);
  });

  test("rewrites Path=/ to the mount path", () => {
    const out = rewriteSetCookie("sid=abc; Domain=evil.com; Path=/", MOUNT);
    expect(out.toLowerCase()).not.toContain("domain=");
    expect(out).toContain(`Path=${MOUNT}`);
  });

  test("contains a non-root Path under the mount path", () => {
    const out = rewriteSetCookie("sid=abc; Path=/settings/profile", MOUNT);
    expect(out).toContain(`Path=${MOUNT}/settings/profile`);
  });

  test("preserves SameSite, Max-Age, and Expires", () => {
    const out = rewriteSetCookie(
      "sid=abc; Path=/; SameSite=Lax; Max-Age=3600; Expires=Wed, 21 Oct 2099 07:28:00 GMT",
      MOUNT,
    );
    expect(out).toContain("SameSite=Lax");
    expect(out).toContain("Max-Age=3600");
    expect(out).toContain("Expires=Wed, 21 Oct 2099 07:28:00 GMT");
  });
});

describe("rewriteSetCookies", () => {
  test("rewrites every Set-Cookie in a response", () => {
    const headers = new Headers();
    headers.append("set-cookie", "a=1; Path=/");
    headers.append("set-cookie", "b=2; Path=/admin");
    const out = rewriteSetCookies(headers, MOUNT);
    expect(out).toHaveLength(2);
    expect(out[0]).toContain(`Path=${MOUNT}`);
    expect(out[1]).toContain(`Path=${MOUNT}/admin`);
  });
});
