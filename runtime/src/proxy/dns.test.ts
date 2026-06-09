import { describe, expect, test } from "bun:test";
import {
  advisoryUpstreamWarning,
  classifyAddress,
  hostnameFromOrigin,
  requiresReapproval,
  resolveHostClasses,
} from "./dns";

describe("classifyAddress", () => {
  test("classifies IPv4 ranges", () => {
    expect(classifyAddress("127.0.0.1")).toBe("loopback");
    expect(classifyAddress("10.0.0.5")).toBe("rfc1918");
    expect(classifyAddress("172.16.0.1")).toBe("rfc1918");
    expect(classifyAddress("172.31.255.255")).toBe("rfc1918");
    expect(classifyAddress("172.32.0.1")).toBe("public");
    expect(classifyAddress("192.168.1.1")).toBe("rfc1918");
    expect(classifyAddress("169.254.169.254")).toBe("link-local");
    expect(classifyAddress("100.64.0.1")).toBe("cgnat");
    expect(classifyAddress("8.8.8.8")).toBe("public");
    expect(classifyAddress("0.0.0.0")).toBe("other");
  });

  test("classifies IPv6 ranges", () => {
    expect(classifyAddress("::1")).toBe("loopback");
    expect(classifyAddress("fe80::1")).toBe("link-local");
    expect(classifyAddress("fc00::1")).toBe("unique-local");
    expect(classifyAddress("fd12:3456::1")).toBe("unique-local");
    expect(classifyAddress("2606:4700:4700::1111")).toBe("public");
  });

  test("classifies IPv4-mapped IPv6 by the embedded v4", () => {
    expect(classifyAddress("::ffff:127.0.0.1")).toBe("loopback");
    expect(classifyAddress("::ffff:8.8.8.8")).toBe("public");
  });

  test("returns other for garbage", () => {
    expect(classifyAddress("")).toBe("other");
    expect(classifyAddress("not-an-ip")).toBe("other");
    expect(classifyAddress("999.1.1.1")).toBe("other");
  });
});

describe("hostnameFromOrigin", () => {
  test("strips scheme, port, and IPv6 brackets", () => {
    expect(hostnameFromOrigin("http://Host.Example:30000")).toBe("host.example");
    expect(hostnameFromOrigin("http://[::1]:8080")).toBe("::1");
  });

  test("returns empty string for an unparseable origin", () => {
    expect(hostnameFromOrigin("not a url")).toBe("");
  });
});

describe("resolveHostClasses", () => {
  test("classifies an IP literal as itself", async () => {
    const c = await resolveHostClasses("127.0.0.1");
    expect(c.addresses).toContain("127.0.0.1");
    expect(c.representative).toBe("loopback");
  });
});

describe("requiresReapproval", () => {
  test("never blocks when the baseline is null or empty (advisory)", () => {
    expect(requiresReapproval("foo.example", null, "public")).toBe(false);
    expect(requiresReapproval("foo.example", "", "public")).toBe(false);
  });

  test("exempts known local aliases", () => {
    expect(requiresReapproval("host.docker.internal", "public", "rfc1918")).toBe(false);
    expect(requiresReapproval("gateway.docker.internal", "loopback", "rfc1918")).toBe(false);
  });

  test("requires re-approval on a class change, allows a matching class", () => {
    expect(requiresReapproval("foo.example", "loopback", "public")).toBe(true);
    expect(requiresReapproval("foo.example", "public", "public")).toBe(false);
  });
});

describe("advisoryUpstreamWarning", () => {
  test("flags localhost, docker aliases, and .local names", () => {
    expect(advisoryUpstreamWarning("localhost")).toBe("loopback");
    expect(advisoryUpstreamWarning("host.docker.internal")).toBe("docker-internal");
    expect(advisoryUpstreamWarning("gateway.docker.internal")).toBe("docker-internal");
    expect(advisoryUpstreamWarning("myhost.local")).toBe("mdns");
  });

  test("flags private IP literals", () => {
    expect(advisoryUpstreamWarning("127.0.0.1")).toBe("loopback");
    expect(advisoryUpstreamWarning("10.0.0.5")).toBe("rfc1918");
    expect(advisoryUpstreamWarning("192.168.1.1")).toBe("rfc1918");
    expect(advisoryUpstreamWarning("169.254.0.1")).toBe("link-local");
    expect(advisoryUpstreamWarning("fc00::1")).toBe("unique-local");
    expect(advisoryUpstreamWarning("100.64.0.1")).toBe("cgnat");
  });

  test("returns null for public hosts and ordinary hostnames", () => {
    expect(advisoryUpstreamWarning("8.8.8.8")).toBeNull();
    expect(advisoryUpstreamWarning("foundry.example.com")).toBeNull();
    expect(advisoryUpstreamWarning("")).toBeNull();
  });
});
