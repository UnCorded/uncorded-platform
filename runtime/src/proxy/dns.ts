// Connection-time DNS classification (plan §Upstream Validation / DNS).
//
// This is audit + re-approval defense, NOT a hard SSRF guard. fetch() resolves
// the hostname again internally, so there is a TOCTOU gap between our classify
// and fetch's connect — a rebinding attacker could return a different address to
// each. Hard DNS pinning would require connecting to the classified IP by hand
// while preserving Host/TLS, which is out of scope for V1. The hard controls are
// `redirect: "manual"` + same-origin redirect rejection (see proxy.ts); this
// module records what an address resolved to and forces re-approval when a
// previously-approved host drifts to a different address class.

import { lookup } from "node:dns/promises";

export type AddressClass =
  | "public"
  | "loopback"
  | "rfc1918"
  | "link-local"
  | "unique-local"
  | "cgnat"
  | "other";

/**
 * Hosts that are intentionally local and whose address class is allowed to be
 * private without forcing re-approval (plan: "unless the approved host is a
 * known local alias such as host.docker.internal").
 */
export const KNOWN_LOCAL_ALIASES: ReadonlySet<string> = new Set([
  "host.docker.internal",
  "gateway.docker.internal",
]);

/** Strip scheme/port/brackets from a normalized origin to get the bare host. */
export function hostnameFromOrigin(origin: string): string {
  try {
    const u = new URL(origin);
    // u.hostname strips the port; it keeps the [] around IPv6 literals, so peel
    // those off too — both classifyAddress and dns.lookup want the bare address.
    let host = u.hostname.toLowerCase();
    if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
    return host;
  } catch {
    return "";
  }
}

function classifyIpv4(ip: string): AddressClass {
  const parts = ip.split(".");
  if (parts.length !== 4) return "other";
  const octets = parts.map((p) => Number(p));
  if (octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return "other";
  const [a, b] = octets as [number, number, number, number];
  if (a === 127) return "loopback";
  if (a === 10) return "rfc1918";
  if (a === 172 && b >= 16 && b <= 31) return "rfc1918";
  if (a === 192 && b === 168) return "rfc1918";
  if (a === 169 && b === 254) return "link-local";
  if (a === 100 && b >= 64 && b <= 127) return "cgnat";
  if (a === 0) return "other";
  return "public";
}

/** Classify a single resolved IP literal into its address class. */
export function classifyAddress(ip: string): AddressClass {
  const addr = ip.trim().toLowerCase();
  if (addr === "") return "other";

  // IPv4-mapped/embedded IPv6 (::ffff:1.2.3.4) — classify the embedded v4.
  const mapped = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped?.[1]) return classifyIpv4(mapped[1]);

  if (addr.includes(":")) {
    // IPv6
    if (addr === "::1") return "loopback";
    if (addr === "::") return "other";
    if (addr.startsWith("fe80")) return "link-local";
    // Unique-local fc00::/7 → first byte 0xfc or 0xfd.
    if (addr.startsWith("fc") || addr.startsWith("fd")) return "unique-local";
    return "public";
  }

  if (/^\d+\.\d+\.\d+\.\d+$/.test(addr)) return classifyIpv4(addr);
  return "other";
}

export interface HostClassification {
  addresses: string[];
  classes: AddressClass[];
  /** The class of the first resolved address — the baseline drift comparand. */
  representative: AddressClass;
}

/**
 * Resolve a hostname and classify every address. IP-literal hosts resolve to
 * themselves. Throws if resolution fails (caller maps that to an upstream error).
 */
export async function resolveHostClasses(hostname: string): Promise<HostClassification> {
  const results = await lookup(hostname, { all: true });
  const addresses = results.map((r) => r.address);
  const classes = addresses.map((a) => classifyAddress(a));
  const representative = classes[0] ?? "other";
  return { addresses, classes, representative };
}

/**
 * Decide whether a live classification has drifted from the approved baseline
 * badly enough to require re-approval.
 *
 * - No stored baseline (null) ⇒ advisory only, never blocks (Phase 1-seeded
 *   rows have no class; the Phase 4 approve endpoint records it).
 * - Known local aliases are exempt (their resolution is expected to be private).
 * - Otherwise a representative-class change requires re-approval.
 */
export function requiresReapproval(
  hostname: string,
  approvedClass: string | null,
  live: AddressClass,
): boolean {
  if (approvedClass === null || approvedClass === "") return false;
  if (KNOWN_LOCAL_ALIASES.has(hostname.toLowerCase())) return false;
  return approvedClass !== live;
}

/**
 * Categories surfaced to the admin UI as a "this target is local/private" hint
 * when reviewing a mount for approval. `docker-internal` covers the known Docker
 * aliases; `mdns` covers `.local` names; the rest mirror {@link AddressClass}.
 */
export type UpstreamAdvisory =
  | "loopback"
  | "rfc1918"
  | "link-local"
  | "unique-local"
  | "cgnat"
  | "docker-internal"
  | "mdns";

/**
 * A synchronous, best-effort advisory for the approval UI — no DNS lookup. It
 * flags hostnames that are obviously local/private (literal IPs in private
 * ranges, `localhost`, Docker aliases, `.local` mDNS names). A public hostname
 * or one that only resolves privately at connect time returns null here; the
 * connection-time classifier (resolveHostClasses) is the runtime authority.
 */
export function advisoryUpstreamWarning(hostname: string): UpstreamAdvisory | null {
  const host = hostname.trim().toLowerCase();
  if (host === "") return null;
  if (host === "localhost") return "loopback";
  if (KNOWN_LOCAL_ALIASES.has(host)) return "docker-internal";
  if (host.endsWith(".local")) return "mdns";

  switch (classifyAddress(host)) {
    case "loopback":
      return "loopback";
    case "rfc1918":
      return "rfc1918";
    case "link-local":
      return "link-local";
    case "unique-local":
      return "unique-local";
    case "cgnat":
      return "cgnat";
    default:
      // "public", "other", or a non-IP hostname — no static warning.
      return null;
  }
}
