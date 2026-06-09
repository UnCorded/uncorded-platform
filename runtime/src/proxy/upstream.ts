// Upstream URL validation + normalization for reverse-proxy mounts.
//
// The upstream value comes from a plugin setting (admin-controlled), so it is
// untrusted input. This module is the single chokepoint that decides whether a
// value is a usable upstream and reduces it to a canonical (origin, basePath)
// pair. The same normalization runs at approval time and on every proxy request
// so a setting that drifts from what was approved is detected (fail closed).
//
// DNS resolution / private-range classification is deliberately NOT done here —
// that is connection-time policy (Phase 2). This is pure URL hygiene.
// See docs/reverse-proxy/plugin-reverse-proxy-plan.md §Upstream Validation.

export type UpstreamErrorCode =
  | "UPSTREAM_MISSING"
  | "UPSTREAM_NOT_ABSOLUTE"
  | "UPSTREAM_BAD_SCHEME"
  | "UPSTREAM_HAS_USERINFO"
  | "UPSTREAM_EMPTY_HOST"
  | "UPSTREAM_BAD_HOST"
  | "UPSTREAM_HAS_QUERY"
  | "UPSTREAM_HAS_FRAGMENT"
  | "UPSTREAM_MALFORMED";

export type NormalizedUpstream = {
  /** scheme://host[:port], lowercased host, explicit port preserved. */
  origin: string;
  /** Path prefix with trailing slash stripped (except the root "/"). */
  basePath: string;
};

export type UpstreamResult =
  | ({ ok: true } & NormalizedUpstream)
  | { ok: false; code: UpstreamErrorCode };

const SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;
/** A plain (non-bracketed) DNS/IP host: ASCII letters, digits, dots, hyphens. */
const PLAIN_HOST_RE = /^[a-z0-9.-]+$/;
/** Contents of a bracketed IPv6 literal (no zone id). */
const IPV6_INNER_RE = /^[0-9a-f:.]+$/;

/**
 * Validate and normalize an upstream URL string. Returns the canonical origin
 * and base path on success, or a typed error code on failure. Never throws.
 */
export function normalizeUpstream(raw: unknown): UpstreamResult {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { ok: false, code: "UPSTREAM_MISSING" };
  }
  const value = raw.trim();

  // Reject any non-ASCII input outright: a homelab upstream is plain ASCII, and
  // refusing Unicode here sidesteps punycode/homograph host confusion.
  if (/[^\x20-\x7e]/.test(value)) {
    return { ok: false, code: "UPSTREAM_BAD_HOST" };
  }

  // Must be absolute with an http(s) scheme.
  const schemeMatch = SCHEME_RE.exec(value);
  if (!schemeMatch) {
    return { ok: false, code: "UPSTREAM_NOT_ABSOLUTE" };
  }
  const scheme = (schemeMatch[1] ?? "").toLowerCase();
  if (scheme !== "http" && scheme !== "https") {
    return { ok: false, code: "UPSTREAM_BAD_SCHEME" };
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    // Malformed authority, out-of-range port, etc.
    return { ok: false, code: "UPSTREAM_MALFORMED" };
  }

  if (url.username !== "" || url.password !== "") {
    return { ok: false, code: "UPSTREAM_HAS_USERINFO" };
  }
  if (url.hostname === "") {
    return { ok: false, code: "UPSTREAM_EMPTY_HOST" };
  }
  if (url.search !== "") {
    return { ok: false, code: "UPSTREAM_HAS_QUERY" };
  }
  if (url.hash !== "") {
    return { ok: false, code: "UPSTREAM_HAS_FRAGMENT" };
  }

  // Host hygiene. IPv6 literals arrive bracketed; reject zone ids (the "%").
  const host = url.hostname.toLowerCase();
  if (host.startsWith("[")) {
    if (!host.endsWith("]")) {
      return { ok: false, code: "UPSTREAM_BAD_HOST" };
    }
    const inner = host.slice(1, -1);
    if (inner.includes("%") || !IPV6_INNER_RE.test(inner)) {
      return { ok: false, code: "UPSTREAM_BAD_HOST" };
    }
  } else {
    if (
      host.includes("%") ||
      host.startsWith(".") ||
      host.endsWith(".") ||
      host.includes("..") ||
      !PLAIN_HOST_RE.test(host)
    ) {
      return { ok: false, code: "UPSTREAM_BAD_HOST" };
    }
  }

  const origin = `${url.protocol}//${url.host}`;
  let basePath = url.pathname; // WHATWG URL always yields a leading "/".
  if (basePath !== "/") {
    basePath = basePath.replace(/\/+$/, "");
    if (basePath === "") basePath = "/";
  }

  return { ok: true, origin, basePath };
}
