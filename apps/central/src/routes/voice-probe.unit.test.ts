// Unit tests for pure helpers in voice-probe.ts. No Postgres dependency.
// The full route lifecycle is exercised in voice-probe.test.ts (which needs
// the local test DB).

import { describe, test, expect } from "bun:test";
import { isPublicIPv4 } from "./voice-probe";
import { tcpProbe } from "../probe/tcp-probe";
import { stunProbe } from "../probe/stun-probe";
import { createServer, type Server as TcpServer } from "node:net";
import { createSocket, type Socket as DgramSocket } from "node:dgram";

describe("isPublicIPv4", () => {
  test("rejects RFC1918, loopback, link-local, CGNAT, multicast, unspecified", () => {
    const cases = [
      "10.0.0.1",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "127.0.0.1",
      "169.254.169.254",
      "100.64.0.1",
      "100.127.255.255",
      "224.0.0.1",
      "239.255.255.255",
      "0.0.0.0",
    ];
    for (const ip of cases) {
      const result = isPublicIPv4(ip);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("private_target");
    }
  });

  test("accepts public IPv4", () => {
    const cases = ["8.8.8.8", "1.1.1.1", "172.32.0.1", "100.63.255.255", "100.128.0.1"];
    for (const ip of cases) {
      expect(isPublicIPv4(ip).ok).toBe(true);
    }
  });

  test("rejects malformed and IPv6", () => {
    expect(isPublicIPv4("not-an-ip").ok).toBe(false);
    expect(isPublicIPv4("256.0.0.1").ok).toBe(false);
    expect(isPublicIPv4("1.2.3").ok).toBe(false);
    const ipv6 = isPublicIPv4("::1");
    expect(ipv6.ok).toBe(false);
    if (!ipv6.ok) expect(ipv6.reason).toBe("ipv6_unsupported");
  });
});

describe("tcpProbe", () => {
  test("succeeds against an open TCP listener", async () => {
    let server: TcpServer | null = null;
    const port = await new Promise<number>((resolve) => {
      server = createServer((s) => s.end());
      server.listen(0, "127.0.0.1", () => {
        const addr = server!.address();
        if (!addr || typeof addr === "string") throw new Error("bad addr");
        resolve(addr.port);
      });
    });

    try {
      const result = await tcpProbe({ host: "127.0.0.1", port, timeoutMs: 1000 });
      expect(result.reachable).toBe(true);
      expect(result.error).toBeNull();
      expect(typeof result.latencyMs).toBe("number");
    } finally {
      await new Promise<void>((res) => server!.close(() => res()));
    }
  });

  test("fails fast against a closed TCP port", async () => {
    // Port 1 on loopback is closed → ECONNREFUSED on most systems.
    const result = await tcpProbe({ host: "127.0.0.1", port: 1, timeoutMs: 1000 });
    expect(result.reachable).toBe(false);
    expect(result.error).not.toBeNull();
  });

  test("times out cleanly", async () => {
    // Use a non-routable address (TEST-NET-1) to force timeout vs. immediate refusal.
    const result = await tcpProbe({ host: "192.0.2.1", port: 7881, timeoutMs: 200 });
    expect(result.reachable).toBe(false);
    expect(result.error).toBe("ETIMEDOUT");
    expect(result.latencyMs).toBeNull();
  });
});

describe("stunProbe", () => {
  const STUN_BINDING_REQUEST = 0x0001;
  const STUN_BINDING_RESPONSE = 0x0101;
  const STUN_MAGIC_COOKIE = 0x2112_a442;

  test("succeeds against a STUN responder", async () => {
    let sock: DgramSocket | null = null;
    const port = await new Promise<number>((resolve) => {
      sock = createSocket("udp4");
      sock.on("message", (msg, rinfo) => {
        if (msg.length < 20) return;
        if (msg.readUInt16BE(0) !== STUN_BINDING_REQUEST) return;
        if (msg.readUInt32BE(4) !== STUN_MAGIC_COOKIE) return;
        const reply = Buffer.alloc(20);
        reply.writeUInt16BE(STUN_BINDING_RESPONSE, 0);
        reply.writeUInt16BE(0, 2);
        reply.writeUInt32BE(STUN_MAGIC_COOKIE, 4);
        msg.copy(reply, 8, 8, 20);
        sock!.send(reply, rinfo.port, rinfo.address);
      });
      sock.bind(0, "127.0.0.1", () => {
        const addr = sock!.address();
        resolve(addr.port);
      });
    });

    try {
      const result = await stunProbe({ host: "127.0.0.1", port, timeoutMs: 1500, retries: 2 });
      expect(result.reachable).toBe(true);
      expect(result.error).toBeNull();
      expect(typeof result.latencyMs).toBe("number");
    } finally {
      await new Promise<void>((res) => sock!.close(() => res()));
    }
  });

  test("times out against a silent UDP port", async () => {
    // Bind a UDP socket that drops every packet — any unused port works.
    let sock: DgramSocket | null = null;
    const port = await new Promise<number>((resolve) => {
      sock = createSocket("udp4");
      sock.bind(0, "127.0.0.1", () => {
        const addr = sock!.address();
        resolve(addr.port);
      });
    });

    try {
      const result = await stunProbe({ host: "127.0.0.1", port, timeoutMs: 300, retries: 2 });
      expect(result.reachable).toBe(false);
      expect(result.error).not.toBeNull();
    } finally {
      await new Promise<void>((res) => sock!.close(() => res()));
    }
  });
});
