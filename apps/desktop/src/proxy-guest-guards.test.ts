import { describe, expect, test } from "bun:test";
import {
  isProxyNavAllowed,
  proxyPermissionDecision,
  PROXY_PROMPTABLE_PERMISSIONS,
  type ProxyMountRegistration,
} from "./proxy-guest-guards";

const MOUNT: ProxyMountRegistration = {
  partition: "persist:proxy:srv-1",
  mountOrigin: "https://srv-1.tunnel.example",
  mountPathPrefix: "/proxy/foundry-vtt/vtt/",
};

describe("isProxyNavAllowed", () => {
  test("allows the mount root and paths beneath it", () => {
    expect(isProxyNavAllowed("https://srv-1.tunnel.example/proxy/foundry-vtt/vtt/", MOUNT)).toBe(true);
    expect(isProxyNavAllowed("https://srv-1.tunnel.example/proxy/foundry-vtt/vtt/game", MOUNT)).toBe(true);
    expect(
      isProxyNavAllowed("https://srv-1.tunnel.example/proxy/foundry-vtt/vtt/join?id=1#frag", MOUNT),
    ).toBe(true);
  });

  test("allows the prefix without its trailing slash (redirect target)", () => {
    expect(isProxyNavAllowed("https://srv-1.tunnel.example/proxy/foundry-vtt/vtt", MOUNT)).toBe(true);
  });

  test("blocks a different origin even on the same path", () => {
    expect(isProxyNavAllowed("https://evil.example/proxy/foundry-vtt/vtt/", MOUNT)).toBe(false);
    // http vs https is a different origin too.
    expect(isProxyNavAllowed("http://srv-1.tunnel.example/proxy/foundry-vtt/vtt/", MOUNT)).toBe(false);
  });

  test("blocks a sibling mount that only shares a string prefix", () => {
    expect(isProxyNavAllowed("https://srv-1.tunnel.example/proxy/foundry-vtt/vtt2/", MOUNT)).toBe(false);
    expect(isProxyNavAllowed("https://srv-1.tunnel.example/proxy/foundry-vtt/other/", MOUNT)).toBe(false);
  });

  test("blocks an off-path navigation on the same origin", () => {
    expect(isProxyNavAllowed("https://srv-1.tunnel.example/admin", MOUNT)).toBe(false);
    expect(isProxyNavAllowed("https://srv-1.tunnel.example/", MOUNT)).toBe(false);
  });

  test("rejects malformed and non-http(s) URLs", () => {
    expect(isProxyNavAllowed("not a url", MOUNT)).toBe(false);
    expect(isProxyNavAllowed("javascript:alert(1)", MOUNT)).toBe(false);
    expect(isProxyNavAllowed("", MOUNT)).toBe(false);
  });

  test("rejects everything when the prefix is empty", () => {
    expect(
      isProxyNavAllowed("https://srv-1.tunnel.example/proxy/foundry-vtt/vtt/", {
        ...MOUNT,
        mountPathPrefix: "",
      }),
    ).toBe(false);
  });
});

describe("proxyPermissionDecision", () => {
  test("prompts for a promptable permission with no remembered decision", () => {
    for (const p of PROXY_PROMPTABLE_PERMISSIONS) {
      expect(proxyPermissionDecision(undefined, p)).toBe("prompt");
      expect(proxyPermissionDecision(null, p)).toBe("prompt");
    }
  });

  test("honors a remembered allow/deny without re-prompting", () => {
    expect(proxyPermissionDecision(true, "media")).toBe("allow");
    expect(proxyPermissionDecision(false, "media")).toBe("deny");
  });

  test("denies a non-promptable permission outright, even if 'remembered' allow", () => {
    expect(proxyPermissionDecision(undefined, "openExternal")).toBe("deny");
    expect(proxyPermissionDecision(true, "hid")).toBe("deny");
    expect(proxyPermissionDecision(true, "fullscreen")).toBe("deny");
  });

  test("never silently allows an un-remembered request", () => {
    for (const p of PROXY_PROMPTABLE_PERMISSIONS) {
      expect(proxyPermissionDecision(undefined, p)).not.toBe("allow");
    }
  });
});
