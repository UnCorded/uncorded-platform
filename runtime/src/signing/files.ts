// File URL signing — short-lived HMAC-SHA256 query-param signatures for
// authenticated file fetches (spec-26 §4).
//
// Browsers can't set Authorization on <img>/<video> requests, so signed
// query-param URLs are the only viable mechanism for inline media previews.
//
// Design properties:
//
//   - Secret is generated once per runtime boot (32 random bytes, hex). Held
//     in-memory only. NEVER persisted: a stolen secret would let an attacker
//     mint URLs at will across the runtime's lifetime, and there's no
//     legitimate need for sigs to outlive the process.
//
//   - Payload: "<path>|<exp>|<user_id>" where path is the URL pathname
//     (e.g. "/files/<slug>/<filename>"), exp is unix-seconds, user_id is the
//     bound principal. Binding user_id prevents URL sharing across accounts
//     and gives audit logs a clear identity.
//
//   - TTL: 1 hour (3600s). Long enough that a chat scrollback session won't
//     keep refetching; short enough that leaked URLs (e.g. via Referer
//     header to an external site) expire quickly. Clients re-mint via
//     storage.file:signUrl when they need fresh URLs.
//
//   - Constant-time signature comparison via timingSafeEqual — prevents
//     timing oracles that could leak whether a forged signature has a
//     correct prefix.

import { randomBytes, timingSafeEqual } from "node:crypto";

const SIGNING_SECRET = randomBytes(32);
const DEFAULT_TTL_SECONDS = 3600;

function base64url(buf: Uint8Array): string {
  // Bun's Buffer supports base64url directly.
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

export interface SignedFileQuery {
  /** Unix-seconds expiry. */
  exp: number;
  /** Bound principal id. */
  u: string;
  /** base64url-encoded HMAC. */
  t: string;
}

/**
 * Mint a short-lived signature for a given URL path + user_id binding.
 * Returns the three query params the caller appends as `?t=...&exp=...&u=...`.
 */
export function signFilePath(
  path: string,
  userId: string,
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
): SignedFileQuery {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const t = base64url(hmac(`${path}|${exp}|${userId}`));
  return { exp, u: userId, t };
}

export type VerifyFileSigResult =
  | { ok: true; userId: string }
  | { ok: false; reason: "missing" | "malformed" | "expired" | "bad-signature" };

/**
 * Verify a file URL signature. `path` MUST be the URL pathname (no query).
 * `query` is the parsed query (URLSearchParams or equivalent record).
 */
export function verifyFileSig(
  path: string,
  query: URLSearchParams,
): VerifyFileSigResult {
  const t = query.get("t");
  const expStr = query.get("exp");
  const u = query.get("u");
  if (!t || !expStr || !u) {
    return { ok: false, reason: "missing" };
  }
  const exp = Number.parseInt(expStr, 10);
  if (!Number.isFinite(exp) || exp <= 0) {
    return { ok: false, reason: "malformed" };
  }
  if (Math.floor(Date.now() / 1000) >= exp) {
    return { ok: false, reason: "expired" };
  }
  const provided = base64urlDecode(t);
  if (!provided) {
    return { ok: false, reason: "malformed" };
  }
  const expected = hmac(`${path}|${exp}|${u}`);
  if (provided.length !== expected.length) {
    return { ok: false, reason: "bad-signature" };
  }
  if (!timingSafeEqual(provided, expected)) {
    return { ok: false, reason: "bad-signature" };
  }
  return { ok: true, userId: u };
}

/** Format a signed file URL path (path + query). Host is appended by the client. */
export function formatSignedFileUrl(path: string, sig: SignedFileQuery): string {
  const qs = new URLSearchParams({ t: sig.t, exp: String(sig.exp), u: sig.u });
  return `${path}?${qs.toString()}`;
}
