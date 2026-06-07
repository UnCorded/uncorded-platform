import { badRequest, rateLimited } from "../errors";
import { authenticate, RATE_CHECK_FRAME } from "../middleware";
import type { RouteContext } from "../routes";

const PROBE_TIMEOUT_MS = 5000;
/** Max redirects to follow before we give up and fail-open. Real public sites
 *  rarely chain more than one or two (apex → www, http → https). */
const MAX_REDIRECTS = 3;

/**
 * Returns true if the given IP address is private, loopback, link-local, or
 * otherwise unsuitable for outbound server-side probing.
 */
function isPrivateAddress(address: string): boolean {
  // IPv6 checks (lowercase for consistency)
  const lower = address.toLowerCase();
  if (lower === "::1") return true;              // IPv6 loopback
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // IPv6 ULA fc00::/7
  if (lower.startsWith("fe80")) return true;    // IPv6 link-local

  // IPv4 checks
  if (address === "0.0.0.0") return true;
  if (address.startsWith("127.")) return true;       // 127.0.0.0/8 loopback
  if (address.startsWith("10.")) return true;        // 10.0.0.0/8 private
  if (address.startsWith("192.168.")) return true;   // 192.168.0.0/16 private
  if (address.startsWith("169.254.")) return true;   // 169.254.0.0/16 link-local / metadata

  // 172.16.0.0/12 — covers 172.16.x.x through 172.31.x.x
  const parts = address.split(".");
  if (parts[0] === "172" && parts[1] !== undefined) {
    const second = parseInt(parts[1], 10);
    if (second >= 16 && second <= 31) return true;
  }

  return false;
}

/**
 * Returns whether the given URL's framing policy allows embedding.
 * Checks X-Frame-Options and CSP frame-ancestors.
 *
 * Assumes the embedding origin is not the same origin as the target
 * (which is always true for UnCorded's web/desktop clients vs external sites).
 */
function parseCanFrame(headers: Headers): boolean {
  // X-Frame-Options (legacy, widely supported)
  const xfo = headers.get("x-frame-options")?.toUpperCase().trim();
  if (xfo === "DENY") return false;
  if (xfo === "SAMEORIGIN") return false;
  // ALLOW-FROM is deprecated — treat as blocked since we can't verify the URI matches us.
  if (xfo?.startsWith("ALLOW-FROM")) return false;

  // Content-Security-Policy: frame-ancestors (overrides X-Frame-Options in modern browsers)
  const csp = headers.get("content-security-policy");
  if (csp) {
    // A CSP header may have multiple directives separated by semicolons.
    // Find the frame-ancestors directive if present.
    const directives = csp.split(";").map((d) => d.trim());
    for (const directive of directives) {
      if (!directive.toLowerCase().startsWith("frame-ancestors")) continue;

      const value = directive.slice("frame-ancestors".length).trim().toLowerCase();

      // 'none' — blocked everywhere
      if (value === "'none'") return false;

      // 'self' — blocked for cross-origin embedders
      if (value === "'self'") return false;

      // Wildcard — allowed everywhere
      if (value === "*") return true;

      // Specific origin list — we're not in it (we're a different origin), so blocked.
      // If we ever need to check against our own origin we could, but for the
      // foreseeable future any explicit whitelist excludes us.
      return false;
    }
  }

  return true;
}

export async function handleCheckFrame(
  request: Request,
  ctx: RouteContext,
): Promise<Response> {
  // Require a session cookie. Without auth, Central becomes a free outbound
  // HEAD-request scanner: rotating IPs trivially bypasses any per-IP cap, so
  // the rate limit must key on a stable identity. The shell calling this
  // already has `__Host-session`; an unauthenticated user has no legitimate
  // reason to probe arbitrary URLs through us.
  const account = await authenticate(request, ctx.sql);
  if (account instanceof Response) return account;

  const { allowed, retryAfter } = ctx.rateLimiter.consume(
    `check-frame:${account.id}`,
    RATE_CHECK_FRAME,
  );
  if (!allowed) return rateLimited(retryAfter);

  const url = new URL(request.url);
  const targetRaw = url.searchParams.get("url");

  if (!targetRaw) {
    return badRequest("url parameter is required");
  }

  let target: URL;
  try {
    target = new URL(targetRaw);
  } catch {
    return badRequest("url is not a valid URL");
  }

  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return badRequest("url must use http or https");
  }

  // One deadline covers the entire redirect chain so a slow or looping site
  // can't extend the 5s probe by bouncing through multiple hops.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

  let canFrame = true;
  try {
    canFrame = await probeChain(target, controller.signal, ctx);
  } catch {
    // Network error, timeout, or SSRF-style blocked request — fail open;
    // the client-side iframe will surface its own error if the site is
    // actually unreachable.
    canFrame = true;
  } finally {
    clearTimeout(timer);
  }

  ctx.logger.debug("check-frame probe", { url: target.hostname, canFrame });

  return Response.json({ canFrame });
}

/**
 * Rewrite `url` to dial the already-resolved `ip` directly, preserving the
 * original hostname in the `Host` header and (for HTTPS) in TLS SNI. This
 * closes the DNS-rebinding TOCTOU: `Bun.dns.lookup` sees a public IP, but
 * without IP-pinning the subsequent `fetch` re-resolves and a malicious
 * authoritative DNS can return a private IP the second time.
 */
function pinToResolvedIp(
  url: URL,
  ip: string,
  signal: AbortSignal,
): { pinnedUrl: string; init: RequestInit } {
  const hostname = url.hostname;
  const pinned = new URL(url.toString());
  // URL hostname setter requires brackets for IPv6; plain form for IPv4.
  pinned.hostname = ip.includes(":") ? `[${ip}]` : ip;

  // `tls.serverName` is a Bun-specific fetch option; the cast keeps us
  // compatible with the lib.dom RequestInit type without widening it globally.
  const init: RequestInit & { tls?: { serverName: string } } = {
    method: "HEAD",
    signal,
    headers: {
      Host: hostname,
      "User-Agent": "UnCorded-FrameCheck/1.0",
    },
    redirect: "manual",
  };
  if (url.protocol === "https:") {
    init.tls = { serverName: hostname };
  }
  return { pinnedUrl: pinned.toString(), init };
}

/**
 * HEAD-probe `target`, following up to MAX_REDIRECTS hops with an SSRF check
 * on every intermediate host. Returns whether the *final* (non-redirect)
 * response allows iframe embedding. Resolves `true` (fail open) if the
 * redirect chain exceeds the cap or any hop otherwise fails to resolve.
 */
export async function probeChain(
  start: URL,
  signal: AbortSignal,
  ctx: Pick<RouteContext, "logger">,
): Promise<boolean> {
  let current = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    // SSRF protection on every hop, including the initial target. A public
    // first-hop that 301s to a private internal host would otherwise be a
    // back door. We resolve once and pin the fetch to the resolved IP below
    // so a rebinding DNS server can't flip the address between our check
    // and the real connection.
    let resolvedIp: string;
    try {
      const records = await Bun.dns.lookup(current.hostname);
      if (records.length === 0) return true;
      for (const record of records) {
        if (isPrivateAddress(record.address)) {
          ctx.logger.debug("check-frame SSRF blocked", {
            hostname: current.hostname,
            address: record.address,
          });
          return true;
        }
      }
      // Every returned record is public; pin the connection to the first one.
      // Any multi-record set has already been validated above, so this choice
      // is safe regardless of which IP we dial.
      resolvedIp = records[0]!.address;
    } catch {
      return true;
    }

    const { pinnedUrl, init } = pinToResolvedIp(current, resolvedIp, signal);
    const res = await fetch(pinnedUrl, init);

    if (res.status < 300 || res.status >= 400) {
      // Terminal response — read framing headers from this response.
      return parseCanFrame(res.headers);
    }

    // 3xx redirect. Resolve the Location against the current URL so both
    // absolute ("https://www.example.com/") and relative ("/home") locations
    // work. A redirect without Location is malformed; treat as frameable.
    const location = res.headers.get("location");
    if (!location) return true;

    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      return true;
    }

    if (next.protocol !== "http:" && next.protocol !== "https:") {
      return true;
    }

    current = next;
  }

  // Max redirects exceeded — don't chase further; let the iframe try.
  return true;
}
