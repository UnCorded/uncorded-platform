import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { createServer, type Server as TcpServer } from "node:net";
import { createSocket, type Socket as DgramSocket } from "node:dgram";
import {
  startTestServer,
  authHeaders,
  registerAndLogin,
  type TestServer,
} from "../test-helpers";

// Note: isPublicIPv4 unit tests live in voice-probe.unit.test.ts so they can
// run without a live Postgres connection. This file covers the full route
// lifecycle and requires the test-DB harness.

// ---------------------------------------------------------------------------
// Helpers — fake LiveKit endpoints
// ---------------------------------------------------------------------------

interface FakeTcpListener {
  port: number;
  close(): Promise<void>;
}

async function startFakeTcp(): Promise<FakeTcpListener> {
  return await new Promise((resolve) => {
    const server: TcpServer = createServer((socket) => {
      // Accept the connection and immediately close. The probe only needs
      // the handshake to complete.
      socket.end();
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("bad addr");
      resolve({
        port: addr.port,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res());
          }),
      });
    });
  });
}

interface FakeStunListener {
  port: number;
  close(): Promise<void>;
}

const STUN_BINDING_REQUEST = 0x0001;
const STUN_BINDING_RESPONSE = 0x0101;
const STUN_MAGIC_COOKIE = 0x2112_a442;

async function startFakeStun(opts?: { mode?: "respond" | "drop" }): Promise<FakeStunListener> {
  const mode = opts?.mode ?? "respond";
  return await new Promise((resolve) => {
    const sock: DgramSocket = createSocket("udp4");
    sock.on("message", (msg, rinfo) => {
      if (mode === "drop") return;
      if (msg.length < 20) return;
      if (msg.readUInt16BE(0) !== STUN_BINDING_REQUEST) return;
      if (msg.readUInt32BE(4) !== STUN_MAGIC_COOKIE) return;
      // Echo a minimal Binding Response with the same transaction ID,
      // zero attributes. The probe doesn't parse XOR-MAPPED-ADDRESS — a
      // valid header is sufficient.
      const reply = Buffer.alloc(20);
      reply.writeUInt16BE(STUN_BINDING_RESPONSE, 0);
      reply.writeUInt16BE(0, 2);
      reply.writeUInt32BE(STUN_MAGIC_COOKIE, 4);
      msg.copy(reply, 8, 8, 20); // copy 12-byte transaction ID
      sock.send(reply, rinfo.port, rinfo.address);
    });
    sock.bind(0, "127.0.0.1", () => {
      const addr = sock.address();
      resolve({
        port: addr.port,
        close: () =>
          new Promise<void>((res) => {
            sock.close(() => res());
          }),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// POST /v1/servers/:id/voice/probe — full route
// ---------------------------------------------------------------------------

let ts: TestServer;
let setupSucceeded = false;
let serverId: string;
let serverSecret: string;
let tcpListener: FakeTcpListener | null = null;
let stunListener: FakeStunListener | null = null;

async function setProbeTargets(opts: { tcp: boolean; udp: boolean }): Promise<void> {
  if (opts.tcp) {
    tcpListener = await startFakeTcp();
    process.env["VOICE_PROBE_TCP_PORT"] = String(tcpListener.port);
  } else {
    // Point at a port we know is closed — the kernel returns ECONNREFUSED quickly.
    delete process.env["VOICE_PROBE_TCP_PORT"];
    process.env["VOICE_PROBE_TCP_PORT"] = "1"; // privileged + closed — connect fails fast
  }
  if (opts.udp) {
    stunListener = await startFakeStun();
    process.env["VOICE_PROBE_UDP_PORT"] = String(stunListener.port);
  } else {
    // Use a closed UDP port — STUN probe times out (no response).
    process.env["VOICE_PROBE_UDP_PORT"] = "1";
  }
}

async function tearDownProbeTargets(): Promise<void> {
  if (tcpListener) { await tcpListener.close(); tcpListener = null; }
  if (stunListener) { await stunListener.close(); stunListener = null; }
}

beforeAll(async () => {
  // Allow probes to target 127.0.0.1 — the fake TCP/STUN listeners below
  // bind to loopback and isPublicIPv4 otherwise rejects the address.
  process.env["VOICE_PROBE_ALLOW_LOOPBACK"] = "1";
  ts = await startTestServer({ realRateLimiter: true });
  const owner = await registerAndLogin(ts, "vpowner");

  const res = await fetch(`${ts.url}/v1/servers`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(owner.token) },
    body: JSON.stringify({ name: "Voice Probe Server" }),
  });
  const body = await res.json();
  serverId = body.server_id;
  serverSecret = body.server_secret;
  setupSucceeded = true;
});

afterAll(async () => {
  await tearDownProbeTargets();
  delete process.env["VOICE_PROBE_TCP_PORT"];
  delete process.env["VOICE_PROBE_UDP_PORT"];
  delete process.env["VOICE_PROBE_ALLOW_LOOPBACK"];
  // Guarded so a beforeAll failure (e.g. Postgres unreachable) surfaces the
  // real error instead of crashing on `undefined.shutdown()`.
  if (setupSucceeded) await ts.shutdown();
});

beforeEach(async () => {
  // Reset cooldown + heartbeat IP before each test so they're independent.
  await ts.sql`
    UPDATE servers
    SET voice_reachability_checked_at = NULL,
        voice_reachability = NULL,
        last_heartbeat_ip = '127.0.0.1',
        last_heartbeat_at = now()
    WHERE id = ${serverId}
  `;
  // RATE_VOICE_PROBE is keyed by serverId and only refills 1/min — without
  // a bucket reset the 5-token cap drains across tests and later cases see
  // a 429 before any validation runs.
  ts.rateLimiter.resetForTests();
  await tearDownProbeTargets();
});

describe("POST /v1/servers/:id/voice/probe", () => {
  test("happy path — TCP + UDP both reachable → ready", async () => {
    await setProbeTargets({ tcp: true, udp: true });

    const res = await fetch(`${ts.url}/v1/servers/${serverId}/voice/probe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ server_secret: serverSecret }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ready");
    expect(body.wanIp).toBe("127.0.0.1");
    expect(body.rtcTcp.reachable).toBe(true);
    expect(body.rtcUdp.reachable).toBe(true);
    expect(typeof body.rtcTcp.latencyMs).toBe("number");
    expect(typeof body.rtcUdp.latencyMs).toBe("number");
    expect(body.rtcTcp.error).toBeNull();
    expect(body.rtcUdp.error).toBeNull();

    // Persisted to DB.
    const rows = await ts.sql`SELECT voice_reachability, voice_reachability_checked_at FROM servers WHERE id = ${serverId}`;
    expect(rows[0]!.voice_reachability).not.toBeNull();
    expect(rows[0]!.voice_reachability_checked_at).not.toBeNull();
  });

  // Partial reachability is classified as "unreachable" so the owner-facing
  // dim/diagnostic modal triggers; TCP-only paths break iOS WebRTC clients
  // even though calls technically establish on desktop.
  test("TCP only reachable → status unreachable, per-port detail preserved", async () => {
    await setProbeTargets({ tcp: true, udp: false });

    const res = await fetch(`${ts.url}/v1/servers/${serverId}/voice/probe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ server_secret: serverSecret }),
    });
    const body = await res.json();
    expect(body.status).toBe("unreachable");
    expect(body.rtcTcp.reachable).toBe(true);
    expect(body.rtcUdp.reachable).toBe(false);
    expect(body.rtcUdp.error).not.toBeNull();
  });

  test("UDP only reachable → status unreachable, per-port detail preserved", async () => {
    await setProbeTargets({ tcp: false, udp: true });

    const res = await fetch(`${ts.url}/v1/servers/${serverId}/voice/probe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ server_secret: serverSecret }),
    });
    const body = await res.json();
    expect(body.status).toBe("unreachable");
    expect(body.rtcTcp.reachable).toBe(false);
    expect(body.rtcTcp.error).not.toBeNull();
    expect(body.rtcUdp.reachable).toBe(true);
  });

  test("both fail → status unreachable", async () => {
    await setProbeTargets({ tcp: false, udp: false });

    const res = await fetch(`${ts.url}/v1/servers/${serverId}/voice/probe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ server_secret: serverSecret }),
    });
    const body = await res.json();
    expect(body.status).toBe("unreachable");
    expect(body.rtcTcp.reachable).toBe(false);
    expect(body.rtcUdp.reachable).toBe(false);
  }, 10_000);

  test("rejects RFC1918 last_heartbeat_ip", async () => {
    await setProbeTargets({ tcp: true, udp: true });
    await ts.sql`UPDATE servers SET last_heartbeat_ip = '192.168.1.50' WHERE id = ${serverId}`;

    const res = await fetch(`${ts.url}/v1/servers/${serverId}/voice/probe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ server_secret: serverSecret }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toBe("private_target");
  });

  test("rejects when no recent heartbeat IP", async () => {
    await ts.sql`UPDATE servers SET last_heartbeat_ip = NULL WHERE id = ${serverId}`;

    const res = await fetch(`${ts.url}/v1/servers/${serverId}/voice/probe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ server_secret: serverSecret }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toBe("no_recent_heartbeat");
  });

  test("rejects when last heartbeat older than 6 hours", async () => {
    await ts.sql`
      UPDATE servers
      SET last_heartbeat_ip = '127.0.0.1',
          last_heartbeat_at = now() - interval '7 hours'
      WHERE id = ${serverId}
    `;

    const res = await fetch(`${ts.url}/v1/servers/${serverId}/voice/probe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ server_secret: serverSecret }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toBe("no_recent_heartbeat");
  });

  test("60s per-server cooldown returns 429 with Retry-After", async () => {
    await setProbeTargets({ tcp: true, udp: true });

    // First probe — succeeds, sets cooldown.
    const r1 = await fetch(`${ts.url}/v1/servers/${serverId}/voice/probe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ server_secret: serverSecret }),
    });
    expect(r1.status).toBe(200);

    // Second probe within 60s — rate limited.
    const r2 = await fetch(`${ts.url}/v1/servers/${serverId}/voice/probe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ server_secret: serverSecret }),
    });
    expect(r2.status).toBe(429);
    expect(r2.headers.get("Retry-After")).not.toBeNull();
  });

  test("returns 401 for invalid server secret", async () => {
    await setProbeTargets({ tcp: true, udp: true });

    const res = await fetch(`${ts.url}/v1/servers/${serverId}/voice/probe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ server_secret: "wrong-secret" }),
    });
    expect(res.status).toBe(401);
  });

  test("returns 400 for missing server_secret", async () => {
    await setProbeTargets({ tcp: true, udp: true });

    const res = await fetch(`${ts.url}/v1/servers/${serverId}/voice/probe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  test("returns 404 for non-existent server", async () => {
    const res = await fetch(
      `${ts.url}/v1/servers/00000000-0000-0000-0000-000000000000/voice/probe`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ server_secret: serverSecret }),
      },
    );
    expect(res.status).toBe(404);
  });

  test("returns 400 for invalid JSON body", async () => {
    const res = await fetch(`${ts.url}/v1/servers/${serverId}/voice/probe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json{",
    });
    expect(res.status).toBe(400);
  });
});
