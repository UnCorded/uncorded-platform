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
// Design mirrors runtime/src/signing/files.ts: a per-boot in-memory secret
// (never persisted), base64url payloads, constant-time signature comparison.

import { randomBytes, timingSafeEqual } from "node:crypto";

const SIGNING_SECRET = randomBytes(32);
const DEFAULT_TTL_SECONDS = 3600;

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

/** Claims carried by a proxy-session cookie. */
export interface ProxySessionClaims {
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

export type MintProxySessionInput = Omit<ProxySessionClaims, "exp">;

/** Mint a signed proxy-session token (the cookie value). */
export function mintProxySession(
  input: MintProxySessionInput,
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const claims: ProxySessionClaims = { ...input, exp };
  const payload = base64url(new Uint8Array(Buffer.from(JSON.stringify(claims))));
  const sig = base64url(hmac(payload));
  return `${payload}.${sig}`;
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
  /** When provided, the token's serverId must match. */
  serverId?: string;
  /** When provided, the token's userId must match. */
  userId?: string;
}

function isValidClaims(v: unknown): v is ProxySessionClaims {
  if (typeof v !== "object" || v === null) return false;
  const c = v as Record<string, unknown>;
  return (
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
