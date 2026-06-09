// Cookie rewriting for the HTTP forwarder.
//
// Two cookie classes share the runtime origin (plan §Cookie Policy):
//   1. proxy-session cookies — runtime auth for /proxy/:slug/:mount/*. Path=/,
//      so the browser sends them to proxy routes. They must NEVER reach upstream.
//   2. upstream application cookies — set by the proxied app. We rewrite them so
//      they bind to the runtime host and are Path-scoped to this one mount, which
//      is what keeps them from leaking across plugins/mounts.
//
// Because every upstream cookie is rewritten to Path=/proxy/:slug/:mount, the
// browser only replays a mount's cookies on that mount's requests. A request to
// /proxy/:slug/:mount/* therefore carries: the (Path=/) proxy-session cookies
// plus this mount's app cookies. We strip the proxy-session cookies by name
// prefix and forward the remainder verbatim.

/** Name prefixes the runtime uses for proxy-session cookies (prod + dev). */
const PROXY_SESSION_PREFIXES = ["__Host-uncorded-proxy-", "uncorded-proxy-"];

function isProxySessionCookieName(name: string): boolean {
  return PROXY_SESSION_PREFIXES.some((p) => name.startsWith(p));
}

/**
 * Reconstruct the upstream `Cookie` header from the inbound one: drop every
 * proxy-session cookie (this mount's and any other's — they all sit at Path=/),
 * forward the rest with names/values preserved exactly. Returns null when there
 * is nothing to forward.
 */
export function buildUpstreamCookieHeader(
  inboundCookie: string | null | undefined,
): string | null {
  if (!inboundCookie) return null;
  const kept: string[] = [];
  for (const part of inboundCookie.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    const name = (eq === -1 ? trimmed : trimmed.slice(0, eq)).trim();
    if (!name || isProxySessionCookieName(name)) continue;
    kept.push(trimmed);
  }
  return kept.length > 0 ? kept.join("; ") : null;
}

/** Extract upstream Set-Cookie headers individually (never comma-collapsed). */
export function getUpstreamSetCookies(headers: Headers): string[] {
  return headers.getSetCookie?.() ?? [];
}

/**
 * Rewrite one upstream `Set-Cookie` so it binds to the runtime host and stays
 * scoped to this mount:
 *   - drop `Domain` (cookie binds to the runtime host it was served from)
 *   - rewrite `Path`: absent or `/` ⇒ the mount path; any other path ⇒ the mount
 *     path with the original path appended, so the app's own scoping is preserved
 *     but contained under /proxy/:slug/:mount (no cross-mount leakage)
 *   - preserve name=value and every other attribute (HttpOnly, Secure, SameSite,
 *     Expires, Max-Age, …) exactly and in order.
 *
 * `mountPath` is `/proxy/:slug/:mount` (no trailing slash).
 */
export function rewriteSetCookie(setCookie: string, mountPath: string): string {
  const segments = setCookie.split(";");
  const nameValue = segments[0] ?? "";
  const attrs = segments.slice(1);

  const out: string[] = [nameValue.trim()];
  let sawPath = false;

  for (const seg of attrs) {
    const trimmed = seg.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    const attrName = (eq === -1 ? trimmed : trimmed.slice(0, eq)).trim().toLowerCase();
    const attrValue = eq === -1 ? "" : trimmed.slice(eq + 1).trim();

    if (attrName === "domain") {
      // Drop entirely — the cookie should bind to the runtime host.
      continue;
    }
    if (attrName === "path") {
      sawPath = true;
      out.push(`Path=${scopePath(attrValue, mountPath)}`);
      continue;
    }
    // Preserve everything else verbatim.
    out.push(trimmed);
  }

  if (!sawPath) {
    out.push(`Path=${mountPath}`);
  }

  return out.join("; ");
}

/** Contain an upstream cookie path under the mount path. */
function scopePath(originalPath: string, mountPath: string): string {
  if (originalPath === "" || originalPath === "/") return mountPath;
  const suffix = originalPath.startsWith("/") ? originalPath : `/${originalPath}`;
  return `${mountPath}${suffix}`.replace(/\/{2,}/g, "/");
}

/** Convenience: rewrite all of an upstream response's Set-Cookie headers. */
export function rewriteSetCookies(headers: Headers, mountPath: string): string[] {
  return getUpstreamSetCookies(headers).map((sc) => rewriteSetCookie(sc, mountPath));
}
