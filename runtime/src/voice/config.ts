// Generates the LiveKit config file (livekit.yaml) from runtime
// credentials + port plan, and writes it to disk with mode 0600.
//
// Cache invariant: if the (apiKey, apiSecret, ports) tuple is unchanged
// since the last write, we don't rewrite — write-once at first
// activation, no churn during normal supervisor restarts. Rotation
// (rotateLiveKitCredentials) changes the secret and forces a rewrite
// on next ensureConfigWritten.
//
// File mode: 0600. The file contains the API secret in plaintext at
// runtime; non-runtime users on the host must not be able to read it.
// On Windows mode bits are advisory; the runtime container is the
// production target and runs Linux.

import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";

export interface VoicePortPlan {
  /** TCP signaling port (LiveKit default 7880). */
  signaling: number;
  /** TCP RTC fallback (LiveKit default 7881). */
  rtcTcp: number;
  /**
   * UDP MUX port — single UDP socket bound at LiveKit process start that
   * multiplexes every session via STUN-derived ICE candidate IDs (LiveKit's
   * `rtc.udp_port` mode). Replaces the prior 50000–50100 port range; see
   * spec-24 Amendment B for the rationale (cold reachability probes need a
   * port that's already bound, which port-range mode never has).
   *
   * NOTE: pion ICE drops cold STUN Binding Requests at this socket because
   * its USERNAME-based dispatch has no active session to map to. The probe
   * therefore targets `turnUdpPort` (LiveKit's embedded TURN STUN responder)
   * instead — see spec-24 Amendment C.
   */
  rtcUdpPort: number;
  /**
   * TURN/STUN port — LiveKit's embedded TURN server (RFC 5766) bound at
   * process start. Per RFC 5766 §6.5, TURN servers MUST respond to bare
   * STUN Binding Requests, so this is what Central probes from the public
   * internet to verify "media will reach the SFU".
   *
   * Defaults to IANA-registered 3478. Relocatable for owners whose router
   * blocks 3478 (rare but documented in spec-24 Amendment C).
   */
  turnUdpPort: number;
}

export const DEFAULT_PORT_PLAN: VoicePortPlan = {
  signaling: 7880,
  rtcTcp: 7881,
  rtcUdpPort: 50000,
  turnUdpPort: 3478,
};

// Loopback URL where LiveKit posts webhook events. Mirrors the runtime
// HTTP port (3000) and the path registered in main.ts:setupHttpRoutes.
// pr-4-voice-contract.md §5 fixes this as a contract-level constant —
// changes here must update the contract and the HTTP route together.
export const DEFAULT_WEBHOOK_URL = "http://127.0.0.1:3000/runtime/voice/webhook";

export interface ConfigInput {
  apiKey: string;
  apiSecret: string;
  ports: VoicePortPlan;
  /** Override the loopback webhook URL. Tests use this; production
   *  callers should leave it unset to inherit DEFAULT_WEBHOOK_URL. */
  webhookUrl?: string;
  /**
   * Host's primary RFC1918 LAN IPv4. When set, rendered as `rtc.node_ip`
   * so LiveKit advertises it as the host ICE candidate, letting on-LAN
   * peers reach the SFU directly without depending on the consumer
   * router's UDP hairpin support. Off-LAN peers continue to use the
   * STUN-discovered external IP via `use_external_ip: true`. Leave unset
   * for hosts where LAN-direct isn't useful — LiveKit will fall back to
   * STUN-only.
   *
   * Must NOT be confused with the v1.10-and-earlier `nat_1_to_1_ips`,
   * which was removed in v1.11.0 and is rejected by the YAML parser
   * (regression-tested in config.test.ts).
   */
  internalIp?: string;
}

/**
 * Render the LiveKit YAML config. Pure function — exported separately
 * so tests can assert the shape without going through disk.
 */
export function renderLiveKitYaml(input: ConfigInput): string {
  const { apiKey, apiSecret, ports, internalIp } = input;
  const webhookUrl = input.webhookUrl ?? DEFAULT_WEBHOOK_URL;
  const lines = [
    `port: ${ports.signaling}`,
    `bind_addresses:`,
    `  - ""`,
    `rtc:`,
    `  tcp_port: ${ports.rtcTcp}`,
    // udp_port (UDP MUX) instead of port_range_start/end — see spec-24
    // Amendment B. Port-range mode binds UDP sockets lazily per session, so
    // cold reachability probes from Central can never observe a bound
    // socket; UDP MUX binds at startup and stays bound.
    `  udp_port: ${ports.rtcUdpPort}`,
    `  use_external_ip: true`,
    ...(internalIp ? [`  node_ip: ${internalIp}`] : []),
    // Embedded TURN/STUN. Required for Amendment C reachability probes:
    // pion ICE's USERNAME-required STUN dispatch on the MUX socket drops
    // cold Binding Requests, so Central probes the TURN port instead
    // (RFC 5766 §6.5 — TURN servers MUST answer bare STUN Binding
    // Requests). Also serves as a media relay fallback for peers behind
    // restrictive NATs (cellular, symmetric NAT). UDP-only by default;
    // TLS is intentionally not configured because we have no cert plumbing
    // and the TLS port has its own reachability concerns.
    `turn:`,
    `  enabled: true`,
    `  udp_port: ${ports.turnUdpPort}`,
    `keys:`,
    `  ${apiKey}: ${apiSecret}`,
    `webhook:`,
    `  api_key: ${apiKey}`,
    `  urls:`,
    `    - ${webhookUrl}`,
    `log_level: info`,
    ``,
  ];
  return lines.join("\n");
}

/**
 * Hash the inputs that would change the rendered config. Used as the
 * cache key for the no-op-on-unchanged behavior.
 */
function fingerprint(input: ConfigInput): string {
  const h = createHash("sha256");
  h.update(input.apiKey);
  h.update("\0");
  h.update(input.apiSecret);
  h.update("\0");
  h.update(JSON.stringify(input.ports));
  h.update("\0");
  h.update(input.webhookUrl ?? DEFAULT_WEBHOOK_URL);
  h.update("\0");
  h.update(input.internalIp ?? "");
  return h.digest("hex");
}

/**
 * Write the config to `path` if (and only if) the rendered content
 * differs from what's already on disk. Returns `true` if the file was
 * written, `false` if the existing file matched.
 *
 * The implementation compares the actual rendered YAML rather than
 * tracking the fingerprint in memory — this way we self-heal if a
 * previous start crashed mid-write or someone hand-edited the file.
 */
export function ensureConfigWritten(input: ConfigInput, path: string): boolean {
  const rendered = renderLiveKitYaml(input);
  if (existsSync(path)) {
    try {
      const current = readFileSync(path, "utf8");
      if (current === rendered) return false;
    } catch {
      // Fall through and rewrite.
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  // mode 0o600 = owner read/write, no group, no other. Linux only —
  // ignored on Windows but harmless. The runtime container is Linux.
  writeFileSync(path, rendered, { mode: 0o600 });
  return true;
}

// Exported for tests that want to assert the cache key without writing.
export const __testHooks = { fingerprint };
