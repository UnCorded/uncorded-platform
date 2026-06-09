import { describe, expect, test } from "bun:test";
import {
  mintProxySession,
  verifyProxySession,
  proxyCookieName,
  buildProxySetCookie,
  readProxyCookie,
  type MintProxySessionInput,
} from "./session";

function claims(overrides: Partial<MintProxySessionInput> = {}): MintProxySessionInput {
  return {
    userId: "user-1",
    serverId: "server-1",
    slug: "foundry",
    mount: "app",
    approvalVersion: 1,
    ...overrides,
  };
}

const EXPECT = { slug: "foundry", mount: "app", serverId: "server-1" };

describe("proxy session sign/verify", () => {
  test("a freshly minted token verifies and returns its claims", () => {
    const token = mintProxySession(claims());
    const r = verifyProxySession(token, EXPECT);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.claims.userId).toBe("user-1");
      expect(r.claims.approvalVersion).toBe(1);
    }
  });

  test("missing token is rejected", () => {
    expect(verifyProxySession(null, EXPECT)).toEqual({ ok: false, reason: "missing" });
  });

  test("a tampered payload fails the signature check", () => {
    const token = mintProxySession(claims());
    const [payload, sig] = token.split(".");
    const forged = mintProxySession(claims({ approvalVersion: 99 })).split(".")[0];
    const r = verifyProxySession(`${forged}.${sig}`, EXPECT);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("bad-signature");
    expect(payload).toBeDefined();
  });

  test("an expired token is rejected", () => {
    const token = mintProxySession(claims(), -1);
    const r = verifyProxySession(token, EXPECT);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("expired");
  });

  test("a token for a different mount is rejected", () => {
    const token = mintProxySession(claims({ mount: "admin" }));
    const r = verifyProxySession(token, EXPECT);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("mismatch");
  });

  test("a token for a different plugin is rejected", () => {
    const token = mintProxySession(claims({ slug: "other" }));
    const r = verifyProxySession(token, EXPECT);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("mismatch");
  });

  test("a token bound to a different user is rejected when userId is expected", () => {
    const token = mintProxySession(claims({ userId: "user-2" }));
    const r = verifyProxySession(token, { ...EXPECT, userId: "user-1" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("mismatch");
  });

  test("a token bound to a different server is rejected", () => {
    const token = mintProxySession(claims({ serverId: "server-2" }));
    const r = verifyProxySession(token, EXPECT);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("mismatch");
  });

  test("garbage tokens are rejected as malformed", () => {
    expect(verifyProxySession("not-a-token", EXPECT).ok).toBe(false);
    expect(verifyProxySession("a.b.c", EXPECT).ok).toBe(false);
  });
});

describe("proxy cookie helpers", () => {
  test("production cookie name uses the __Host- prefix", () => {
    expect(proxyCookieName("foundry", "app", true)).toBe("__Host-uncorded-proxy-foundry-app");
  });

  test("dev cookie name drops the __Host- prefix", () => {
    expect(proxyCookieName("foundry", "app", false)).toBe("uncorded-proxy-foundry-app");
  });

  test("production Set-Cookie carries the locked attributes", () => {
    const c = buildProxySetCookie("foundry", "app", "TOKEN", true, 3600);
    expect(c).toContain("__Host-uncorded-proxy-foundry-app=TOKEN");
    expect(c).toContain("Secure");
    expect(c).toContain("HttpOnly");
    expect(c).toContain("Path=/");
    expect(c).toContain("SameSite=None");
    expect(c).toContain("Partitioned");
  });

  test("dev Set-Cookie omits Secure/Partitioned and uses Lax", () => {
    const c = buildProxySetCookie("foundry", "app", "TOKEN", false, 3600);
    expect(c).toContain("uncorded-proxy-foundry-app=TOKEN");
    expect(c).not.toContain("Secure");
    expect(c).not.toContain("Partitioned");
    expect(c).toContain("SameSite=Lax");
  });

  test("readProxyCookie finds the production cookie", () => {
    const header = `other=1; __Host-uncorded-proxy-foundry-app=TOKEN; another=2`;
    expect(readProxyCookie(header, "foundry", "app")).toBe("TOKEN");
  });

  test("readProxyCookie finds the dev cookie", () => {
    const header = `uncorded-proxy-foundry-app=DEVTOKEN`;
    expect(readProxyCookie(header, "foundry", "app")).toBe("DEVTOKEN");
  });

  test("readProxyCookie returns null when absent", () => {
    expect(readProxyCookie("a=1; b=2", "foundry", "app")).toBeNull();
    expect(readProxyCookie(null, "foundry", "app")).toBeNull();
  });
});
