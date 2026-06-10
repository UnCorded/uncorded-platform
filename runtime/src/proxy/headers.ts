// Request/response header sanitizer for the HTTP forwarder.
//
// Policy (docs/reverse-proxy/plugin-reverse-proxy-plan.md §Header Policy):
//   request  — strip hop-by-hop, cookie, referer, and all client-supplied
//              x-forwarded-* / x-uncorded-* headers; force Accept-Encoding:
//              identity (the runtime decodes and rewrites bodies itself, so
//              asking upstream to compress only buys a header lie to undo);
//              set runtime-owned forwarded identity headers (including
//              x-forwarded-prefix, the public mount path); set Host to the
//              upstream host; attach only the reconstructed mount-scoped Cookie.
//              Authorization IS forwarded — see sanitizeRequestHeaders for why.
//
// Referer is stripped because a browser may carry a runtime-internal URL there
// (notably the /proxy-open handoff URL, which embeds a single-use session
// ticket); forwarding it would leak that ticket into the upstream app and its
// logs. A Referer pointing at the runtime origin is also useless to the upstream,
// which only ever sees same-origin requests through the proxy.
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
  /**
   * The public path the app is served under — `/proxy/:slug/:mount`, sent as
   * `x-forwarded-prefix`. A reverse-proxy-aware upstream can read this to emit
   * URLs under the mount path instead of root-absolute ones (which would escape
   * the mount). Apps that don't honor it must set their own route prefix to this
   * value. See docs/site/sdk/reverse-proxy.md.
   */
  forwardedPrefix: string;
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
    // The inbound Cookie is dropped; the mount-scoped jar is rebuilt below and
    // re-attached as a single trusted value.
    if (name === "cookie") continue;
    // Referer can carry the /proxy-open handoff URL (with its session ticket);
    // never forward it upstream. See module header.
    if (name === "referer") continue;
    if (name === "host") continue;
    // Normalize away inbound Accept-Encoding; we force `identity` below.
    if (name === "accept-encoding") continue;
    if (isForwardedIdentity(name)) continue;
    // Authorization is intentionally forwarded. On the /proxy/* data path it can
    // only have been set by the proxied app's own JS — browsers never auto-attach
    // Authorization (unlike cookies), and the UnCorded principal travels as the
    // proxy-session cookie + x-uncorded-user-id, not a Bearer. Forwarding it lets
    // token-auth apps reach their own backend out of the box. The bootstrap route
    // (POST /proxy-sessions, which carries the UnCorded Bearer) does not pass
    // through this sanitizer, so that token never reaches the upstream.
    out.append(rawName, value);
  }

  // Runtime-owned, trusted values — set AFTER the strip loop so nothing inbound
  // can survive.
  out.set("host", ctx.upstreamHost);
  out.set("x-forwarded-host", ctx.forwardedHost);
  out.set("x-forwarded-proto", ctx.forwardedProto);
  out.set("x-forwarded-for", ctx.forwardedFor);
  out.set("x-uncorded-user-id", ctx.userId);
  out.set("x-forwarded-prefix", ctx.forwardedPrefix);
  // The runtime reads/rewrites text bodies and Bun's fetch decodes compressed
  // responses itself, leaving the content-encoding/-length headers describing the
  // compressed bytes — a mismatch on the streamed passthrough. Asking upstream for
  // identity keeps the framing honest. See forwardToUpstream's streaming branch.
  out.set("accept-encoding", "identity");

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
