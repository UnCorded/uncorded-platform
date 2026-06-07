// POST /v1/servers/:id/voice/probe — spec-24 Amendment A2 (UDP target
// updated by Amendments B and C).
//
// Triggers a Central → runtime WAN reachability check on TCP 7881 (LiveKit
// RTC fallback) and UDP 3478 (LiveKit's embedded TURN/STUN responder; see
// spec-24 Amendment C). The LiveKit UDP MUX socket on 50000 is the path
// real call media flows over, but pion ICE drops cold STUN Binding Requests
// at that socket — its USERNAME-based dispatch has no active session to map
// to — so a probe there always times out even when the port is forwarded.
// LiveKit's embedded TURN server, on the other hand, MUST answer bare STUN
// Binding Requests per RFC 5766 §6.5, which makes it the right cold-probe
// target. UDP 3478 reachability is a strong proxy for "media will flow"
// because it's the same protocol/transport class as the MUX path.
//
// Probe target IP is the cf-connecting-ip Central recorded on the server's
// most recent heartbeat — clients cannot direct Central to probe arbitrary
// IPs.
//
// Auth: server-bound, body-carried `server_secret`, matching heartbeat. The
// runtime owns the secret; no per-account JWT is required for this call.
//
// Rate limits:
//   - In-process token bucket (RATE_VOICE_PROBE) — defends Central from
//     burst spam by a misbehaving runtime.
//   - DB-backed 60s per-server cooldown — defends the *remote* runtime from
//     repeated probe storms across Central restarts/replicas.

import { timingSafeEqual } from "node:crypto";
import type { RouteContext } from "../routes";
import { RATE_VOICE_PROBE } from "../middleware";
import {
  badRequest,
  unauthorized,
  notFound,
  rateLimited,
} from "../errors";
import { hashToken } from "../crypto";
import { tcpProbe } from "../probe/tcp-probe";
import { stunProbe } from "../probe/stun-probe";
import type { VoiceProbeResult } from "../probe/types";

const DEFAULT_TCP_PORT = 7881;
// LiveKit's embedded TURN STUN port (IANA-registered 3478). Amendment B
// made the MUX port (50000) the only UDP media socket but Amendment C then
// observed that pion ICE's USERNAME-required STUN dispatch drops cold
// Binding Requests at that socket — so a Central probe of 50000 looks
// unreachable even on a perfectly forwarded router. RFC 5766 §6.5 requires
// TURN servers to answer bare STUN Binding Requests, so probing 3478
// gives Central a deterministic, production-grade reachability signal
// without any auth handshake. The MUX socket on 50000 is still where real
// media flows; we just don't probe it.
const DEFAULT_UDP_PORT = 3478;
const PROBE_BUDGET_MS = 5000;          // per-probe (TCP, UDP) — they run in parallel; total wall-clock ≤ 5s
const COOLDOWN_MS = 60 * 1000;
const HEARTBEAT_FRESHNESS_MS = 6 * 60 * 60 * 1000;

interface VoiceProbeBody {
  server_secret: unknown;
}

/**
 * Read the configured TCP/UDP target ports. Tests override via env vars so
 * they can stand up loopback listeners on ephemeral ports without a global
 * mutable hook on the route module. Production never sets these.
 */
function getProbePorts(): { tcpPort: number; udpPort: number } {
  const tcpEnv = process.env["VOICE_PROBE_TCP_PORT"];
  const udpEnv = process.env["VOICE_PROBE_UDP_PORT"];
  return {
    tcpPort: tcpEnv ? Number(tcpEnv) : DEFAULT_TCP_PORT,
    udpPort: udpEnv ? Number(udpEnv) : DEFAULT_UDP_PORT,
  };
}

/** Reject IPs that should never legitimately be a server's WAN address. */
export function isPublicIPv4(ip: string): { ok: true } | { ok: false; reason: string } {
  // Reject IPv6 — Phase 1 deployments are IPv4 (CF tunnel + home routers).
  // IPv6 support is future work; rejecting here is preferable to probing a
  // mistakenly-recorded loopback IPv6 address like "::1".
  if (ip.includes(":")) return { ok: false, reason: "ipv6_unsupported" };

  const parts = ip.split(".");
  if (parts.length !== 4) return { ok: false, reason: "invalid_target" };
  const octets = parts.map((p) => Number(p));
  for (const o of octets) {
    if (!Number.isInteger(o) || o < 0 || o > 255) return { ok: false, reason: "invalid_target" };
  }
  const [a, b] = octets as [number, number, number, number];

  if (a === 0) return { ok: false, reason: "private_target" };                   // unspecified
  if (a === 127) return { ok: false, reason: "private_target" };                 // loopback
  if (a === 10) return { ok: false, reason: "private_target" };                  // RFC1918
  if (a === 172 && b >= 16 && b <= 31) return { ok: false, reason: "private_target" }; // RFC1918
  if (a === 192 && b === 168) return { ok: false, reason: "private_target" };    // RFC1918
  if (a === 169 && b === 254) return { ok: false, reason: "private_target" };    // link-local
  if (a === 100 && b >= 64 && b <= 127) return { ok: false, reason: "private_target" }; // CGNAT
  if (a >= 224) return { ok: false, reason: "private_target" };                  // multicast + reserved

  return { ok: true };
}

export async function handleVoiceProbe(
  request: Request,
  ctx: RouteContext,
  serverId: string,
): Promise<Response> {
  // Per-server bucket — the spam target is Central's CPU + the runtime's
  // bandwidth, both keyed to the server, not to the requesting account.
  const { allowed, retryAfter } = ctx.rateLimiter.consume(
    `voice-probe:${serverId}`,
    RATE_VOICE_PROBE,
  );
  if (!allowed) return rateLimited(retryAfter);

  let body: VoiceProbeBody;
  try {
    body = (await request.json()) as VoiceProbeBody;
  } catch {
    return badRequest("Invalid JSON body");
  }

  if (typeof body.server_secret !== "string" || body.server_secret.length === 0) {
    return badRequest("server_secret is required");
  }

  const rows = await ctx.sql`
    SELECT
      id,
      server_secret_hash,
      last_heartbeat_ip,
      last_heartbeat_at,
      voice_reachability_checked_at
    FROM servers
    WHERE id = ${serverId}
  `;
  const server = rows[0];
  if (!server) return notFound("Server not found");

  const providedHash = await hashToken(body.server_secret);
  const a = Buffer.from(providedHash);
  const b = Buffer.from(server.server_secret_hash as string);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return unauthorized("Invalid server secret");
  }

  // Cooldown — DB-backed so it survives Central restarts and parallel replicas.
  const lastChecked = server.voice_reachability_checked_at as Date | null;
  if (lastChecked) {
    const elapsed = Date.now() - new Date(lastChecked).getTime();
    if (elapsed < COOLDOWN_MS) {
      const retrySeconds = Math.ceil((COOLDOWN_MS - elapsed) / 1000);
      return rateLimited(retrySeconds);
    }
  }

  // Target-IP validation. Refuse before opening sockets — bad data should
  // never make Central probe a private address.
  const lastHeartbeatIp = server.last_heartbeat_ip as string | null;
  const lastHeartbeatAt = server.last_heartbeat_at as Date | null;
  if (!lastHeartbeatIp || !lastHeartbeatAt) {
    return badRequest("no_recent_heartbeat");
  }
  const heartbeatAgeMs = Date.now() - new Date(lastHeartbeatAt).getTime();
  if (heartbeatAgeMs > HEARTBEAT_FRESHNESS_MS) {
    return badRequest("no_recent_heartbeat");
  }
  const targetCheck = isPublicIPv4(lastHeartbeatIp);
  if (!targetCheck.ok) {
    // Tests bind fake LiveKit listeners to 127.0.0.1 and need the route to
    // reach the probe stage with a loopback target. Mirrors the existing
    // VOICE_PROBE_TCP_PORT/UDP_PORT escape hatch — production never sets
    // this. Only the loopback case is permitted; RFC1918 / link-local /
    // CGNAT / multicast remain hard rejects.
    const allowLoopback =
      process.env["VOICE_PROBE_ALLOW_LOOPBACK"] === "1" &&
      targetCheck.reason === "private_target" &&
      lastHeartbeatIp.startsWith("127.");
    if (!allowLoopback) {
      return badRequest(targetCheck.reason);
    }
  }

  const { tcpPort, udpPort } = getProbePorts();

  // Run both probes in parallel — total wall-clock ≤ PROBE_BUDGET_MS.
  const [rtcTcp, rtcUdp] = await Promise.all([
    tcpProbe({ host: lastHeartbeatIp, port: tcpPort, timeoutMs: PROBE_BUDGET_MS }),
    stunProbe({ host: lastHeartbeatIp, port: udpPort, timeoutMs: PROBE_BUDGET_MS }),
  ]);

  // "ready" requires BOTH ports reachable. UDP carries RTP (the actual media);
  // TCP-only reachability lets calls limp via ICE-TCP fallback, but iOS Safari
  // and other strict-NAT clients still fail to establish PeerConnection. We
  // surface partial reachability as "unreachable" so the owner-facing modal
  // opens with per-port detail, instead of un-dimming channels and letting
  // users hit silent connection failures.
  const result: VoiceProbeResult = {
    version: 1,
    status: rtcTcp.reachable && rtcUdp.reachable ? "ready" : "unreachable",
    checkedAt: new Date().toISOString(),
    wanIp: lastHeartbeatIp,
    rtcTcp,
    rtcUdp,
  };

  await ctx.sql`
    UPDATE servers
    SET
      voice_reachability = ${JSON.stringify(result)}::jsonb,
      voice_reachability_checked_at = now()
    WHERE id = ${serverId}
  `;

  return Response.json(result);
}
