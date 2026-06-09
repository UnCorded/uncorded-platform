// Request/response header sanitizer for the HTTP forwarder.
//
// Policy (docs/reverse-proxy/plugin-reverse-proxy-plan.md §Header Policy):
//   request  — strip hop-by-hop, authorization, cookie, and all client-supplied
//              x-forwarded-* / x-uncorded-* headers; set runtime-owned forwarded
//              identity headers; set Host to the upstream host; attach only the
//              reconstructed mount-scoped upstream Cookie.
//   response — strip hop-by-hop; drop Set-Cookie (rewritten separately); keep
//              everything else, INCLUDING content-security-policy and
//              x-frame-options (iframe policy belongs to the upstream app).

/** Hop-by-hop headers — never forwarded in either direction (RFC 7230 §6.1). */
export const HOP_BY_HOP: ReadonlySet<string> = new Set([
  "connection",
  "upgrade",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
]);

/** Runtime-owned forwarded-identity context set on every upstream request. */
export interface ForwardedContext {
  /** `host[:port]` of the upstream — becomes the upstream `Host` header. */
  upstreamHost: string;
  /** The runtime host the client addressed (for `x-forwarded-host`). */
  forwardedHost: string;
  /** `https` or `http` — the scheme the client used to reach the runtime. */
  forwardedProto: string;
  /** Client IP (for `x-forwarded-for`). */
  forwardedFor: string;
  /** Authenticated principal id (for `x-uncorded-user-id`). */
  userId: string;
}

/**
 * Header names that carry forwarded identity. Any inbound header whose
 * lowercased name equals one of these, or starts with `x-forwarded-` /
 * `x-uncorded-`, is dropped before the runtime sets its own trusted values —
 * a client must never be able to spoof its IP, user id, or scheme.
 */
function isForwardedIdentity(name: string): boolean {
  return name.startsWith("x-forwarded-") || name.startsWith("x-uncorded-");
}

/**
 * Parse the `Connection` header's token list. Each listed token names another
 * header that is hop-by-hop for this specific message and must also be dropped.
 */
function connectionTokens(inbound: Headers): Set<string> {
  const out = new Set<string>();
  const conn = inbound.get("connection");
  if (!conn) return out;
  for (const tok of conn.split(",")) {
    const t = tok.trim().toLowerCase();
    if (t) out.add(t);
  }
  return out;
}

/**
 * Build the sanitized upstream request headers.
 *
 * `upstreamCookie` is the already-reconstructed, mount-scoped Cookie value
 * (or null to send none). The inbound Cookie/Authorization are never forwarded.
 */
export function sanitizeRequestHeaders(
  inbound: Headers,
  upstreamCookie: string | null,
  ctx: ForwardedContext,
): Headers {
  const dynamicHopByHop = connectionTokens(inbound);
  const out = new Headers();

  for (const [rawName, value] of inbound) {
    const name = rawName.toLowerCase();
    if (HOP_BY_HOP.has(name)) continue;
    if (dynamicHopByHop.has(name)) continue;
    if (name === "authorization" || name === "cookie") continue;
    if (name === "host") continue;
    if (isForwardedIdentity(name)) continue;
    out.append(rawName, value);
  }

  // Runtime-owned, trusted values — set AFTER the strip loop so nothing inbound
  // can survive.
  out.set("host", ctx.upstreamHost);
  out.set("x-forwarded-host", ctx.forwardedHost);
  out.set("x-forwarded-proto", ctx.forwardedProto);
  out.set("x-forwarded-for", ctx.forwardedFor);
  out.set("x-uncorded-user-id", ctx.userId);

  if (upstreamCookie) out.set("cookie", upstreamCookie);

  return out;
}

/**
 * Build the sanitized downstream response headers. Drops hop-by-hop and
 * Set-Cookie (the caller re-adds rewritten cookies); preserves CSP /
 * X-Frame-Options and all other application headers verbatim.
 */
export function sanitizeResponseHeaders(upstream: Headers): Headers {
  const dynamicHopByHop = connectionTokens(upstream);
  const out = new Headers();

  for (const [rawName, value] of upstream) {
    const name = rawName.toLowerCase();
    if (HOP_BY_HOP.has(name)) continue;
    if (dynamicHopByHop.has(name)) continue;
    if (name === "set-cookie") continue;
    out.append(rawName, value);
  }

  return out;
}

/**
 * Approximate the wire byte size of a header set (name + ": " + value + CRLF
 * per field). Used to enforce the request/response header byte caps.
 */
export function measureHeaderBytes(headers: Headers): number {
  let total = 0;
  for (const [name, value] of headers) {
    // Set-Cookie is counted separately via getSetCookie() so multiple cookies
    // aren't collapsed into one comma-joined value.
    if (name.toLowerCase() === "set-cookie") continue;
    total += name.length + value.length + 4;
  }
  const setCookies = headers.getSetCookie?.() ?? [];
  for (const sc of setCookies) {
    total += "set-cookie".length + sc.length + 4;
  }
  return total;
}
