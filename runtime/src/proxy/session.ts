// Proxy-session cookie: short-lived HMAC-signed token that authorizes browser
// proxy traffic for one mount.
//
// Browser-loaded proxy requests (iframe doc nav, sub-resources, WS upgrade)
// cannot carry an Authorization header, so a cookie is the only viable carrier.
// The admin/bootstrap routes use Bearer auth; this cookie is minted by the
// bootstrap route after a Bearer-authenticated check and then rides on the
// browser's proxy requests.
//
// Cookie topology is LOCKED by the Phase 0 spike
// (docs/reverse-proxy/phase-0-cookie-topology-decision.md):
//   production: __Host-uncorded-proxy-<slug>-<mount>
//               Secure; HttpOnly; Path=/; SameSite=None; Partitioned
//   dev (http localhost fallback): uncorded-proxy-<slug>-<mount>
//               HttpOnly; Path=/; SameSite=Lax
//
// The signed value binds user id, server id, plugin slug, mount name, and the
// approval version, plus an expiry. Mount binding lives in BOTH the cookie name
// and the signed payload, so a cookie can never be replayed against another
// mount even if two names happen to collide.
//
// A `purpose` tag separates the two token shapes that share this signing scheme:
//   "session" — the cookie the forwarder validates on every proxy request.
//   "open"    — a short-lived handoff ticket carried in the first-party
//               `GET /proxy-open/:slug/:mount` URL (the Safari/top-level fallback,
//               Phase 0 §4a). The open endpoint exchanges it for a fresh session
//               cookie minted in a first-party context. Tagging keeps an open
//               ticket from being replayed as a cookie and vice versa.
//
// Design mirrors runtime/src/signing/files.ts: a per-boot in-memory secret
// (never persisted), base64url payloads, constant-time signature comparison.

import { randomBytes, timingSafeEqual } from "node:crypto";

const SIGNING_SECRET = randomBytes(32);
const DEFAULT_TTL_SECONDS = 3600;

/** TTL for the first-party "open" handoff ticket. Short — it is consumed the
 * moment the user clicks "Open in browser", which in the Safari case happens
 * within seconds of the framed load failing closed. */
export const PROXY_OPEN_TICKET_TTL_SECONDS = 300;

const PROD_COOKIE_PREFIX = "__Host-uncorded-proxy-";
const DEV_COOKIE_PREFIX = "uncorded-proxy-";

function base64url(buf: Uint8Array): string {
  return Buffer.from(buf).toString("base64url");
}

function base64urlDecode(s: string): Uint8Array | null {
  try {
    return new Uint8Array(Buffer.from(s, "base64url"));
  } catch {
    return null;
  }
}

function hmac(payload: string): Uint8Array {
  const h = new Bun.CryptoHasher("sha256", SIGNING_SECRET);
  h.update(payload);
  return new Uint8Array(h.digest());
}

/** Which token shape a signed payload represents. See module header. */
export type ProxyTokenPurpose = "session" | "open";

/** Claims carried by a proxy-session cookie or open-handoff ticket. */
export interface ProxySessionClaims {
  /** Distinguishes the cookie ("session") from the handoff ticket ("open"). */
  purpose: ProxyTokenPurpose;
  /** Bound principal id (audit + future per-user checks). */
  userId: string;
  /** Server id this session is valid on. */
  serverId: string;
  /** Plugin slug the session authorizes. */
  slug: string;
  /** Mount name the session authorizes. */
  mount: string;
  /** Approval version this session was minted against. */
  approvalVersion: number;
  /** Unix-seconds expiry. */
  exp: number;
}

export type MintProxySessionInput = Omit<ProxySessionClaims, "exp" | "purpose">;

function mint(purpose: ProxyTokenPurpose, input: MintProxySessionInput, ttlSeconds: number): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const claims: ProxySessionClaims = { ...input, purpose, exp };
  const payload = base64url(new Uint8Array(Buffer.from(JSON.stringify(claims))));
  const sig = base64url(hmac(payload));
  return `${payload}.${sig}`;
}

/** Mint a signed proxy-session token (the cookie value). */
export function mintProxySession(
  input: MintProxySessionInput,
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
): string {
  return mint("session", input, ttlSeconds);
}

/**
 * Mint a short-lived "open" handoff ticket carried in the first-party
 * `GET /proxy-open/:slug/:mount?ticket=` URL. The open endpoint verifies it and
 * exchanges it for a fresh session cookie minted top-level (Phase 0 §4a).
 */
export function mintProxyOpenTicket(
  input: MintProxySessionInput,
  ttlSeconds: number = PROXY_OPEN_TICKET_TTL_SECONDS,
): string {
  return mint("open", input, ttlSeconds);
}

export type ProxySessionReason =
  | "missing"
  | "malformed"
  | "bad-signature"
  | "expired"
  | "mismatch";

export type VerifyProxySessionResult =
  | { ok: true; claims: ProxySessionClaims }
  | { ok: false; reason: ProxySessionReason };

/** Bindings the caller requires the token to match. slug/mount are mandatory. */
export interface ProxySessionExpectation {
  slug: string;
  mount: string;
  /** Required token purpose. Defaults to "session" (the cookie). */
  purpose?: ProxyTokenPurpose;
  /** When provided, the token's serverId must match. */
  serverId?: string;
  /** When provided, the token's userId must match. */
  userId?: string;
}

function isValidClaims(v: unknown): v is ProxySessionClaims {
  if (typeof v !== "object" || v === null) return false;
  const c = v as Record<string, unknown>;
  return (
    (c["purpose"] === "session" || c["purpose"] === "open") &&
    typeof c["userId"] === "string" &&
    typeof c["serverId"] === "string" &&
    typeof c["slug"] === "string" &&
    typeof c["mount"] === "string" &&
    typeof c["approvalVersion"] === "number" &&
    typeof c["exp"] === "number"
  );
}

/** Verify a proxy-session token and its bindings. Never throws. */
export function verifyProxySession(
  token: string | null | undefined,
  expected: ProxySessionExpectation,
): VerifyProxySessionResult {
  if (!token) return { ok: false, reason: "missing" };
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return { ok: false, reason: "malformed" };

  const payloadPart = token.slice(0, dot);
  const sigPart = token.slice(dot + 1);

  const providedSig = base64urlDecode(sigPart);
  if (!providedSig) return { ok: false, reason: "malformed" };
  const expectedSig = hmac(payloadPart);
  if (providedSig.length !== expectedSig.length) return { ok: false, reason: "bad-signature" };
  if (!timingSafeEqual(providedSig, expectedSig)) return { ok: false, reason: "bad-signature" };

  const rawPayload = base64urlDecode(payloadPart);
  if (!rawPayload) return { ok: false, reason: "malformed" };
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(rawPayload).toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!isValidClaims(claims)) return { ok: false, reason: "malformed" };

  if (Math.floor(Date.now() / 1000) >= claims.exp) return { ok: false, reason: "expired" };

  if (claims.purpose !== (expected.purpose ?? "session")) {
    return { ok: false, reason: "mismatch" };
  }
  if (claims.slug !== expected.slug || claims.mount !== expected.mount) {
    return { ok: false, reason: "mismatch" };
  }
  if (expected.serverId !== undefined && claims.serverId !== expected.serverId) {
    return { ok: false, reason: "mismatch" };
  }
  if (expected.userId !== undefined && claims.userId !== expected.userId) {
    return { ok: false, reason: "mismatch" };
  }

  return { ok: true, claims };
}

/** Cookie name for a mount. Production uses the host-locked `__Host-` prefix. */
export function proxyCookieName(slug: string, mount: string, secure: boolean): string {
  return `${secure ? PROD_COOKIE_PREFIX : DEV_COOKIE_PREFIX}${slug}-${mount}`;
}

/** Build the Set-Cookie header value carrying a freshly minted proxy session. */
export function buildProxySetCookie(
  slug: string,
  mount: string,
  token: string,
  secure: boolean,
  maxAgeSeconds: number = DEFAULT_TTL_SECONDS,
): string {
  const name = proxyCookieName(slug, mount, secure);
  if (secure) {
    // LOCKED production attributes (Phase 0 decision).
    return `${name}=${token}; Secure; HttpOnly; Path=/; SameSite=None; Partitioned; Max-Age=${maxAgeSeconds}`;
  }
  // Dev localhost fallback: no Secure/Partitioned (http origin), first-party Lax.
  return `${name}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

/**
 * Extract the proxy-session token for a mount from a Cookie header. Tries the
 * production (`__Host-`) name first, then the dev name, since the proxy route
 * cannot know which the browser stored.
 */
export function readProxyCookie(
  cookieHeader: string | null | undefined,
  slug: string,
  mount: string,
): string | null {
  if (!cookieHeader) return null;
  const wanted = [proxyCookieName(slug, mount, true), proxyCookieName(slug, mount, false)];
  const jar = new Map<string, string>();
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!jar.has(name)) jar.set(name, value);
  }
  for (const name of wanted) {
    const v = jar.get(name);
    if (v !== undefined && v !== "") return v;
  }
  return null;
}
