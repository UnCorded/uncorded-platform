// Ed25519 JWT validator — verifies tokens against the runtime's cached public
// key bundle, enforces algorithm, claims, and server-binding.
//
// Extracted from entrypoint.ts so it can be unit-tested without pulling in the
// container's top-level filesystem side effects. The keys, server-id, and
// JWKS-refresh hook are injected — entrypoint owns the mutable state.

import type { PublicKeyEntry } from "../heartbeat/types";
import type { TokenValidator, TokenValidationResult } from "../ws/types";

export interface TokenValidatorDeps {
  /** Live getter for the runtime's cached Ed25519 public keys. Must reflect
   *  updates pushed by the heartbeat client (onPublicKeysUpdated). */
  getKeys: () => readonly PublicKeyEntry[];
  /** Live getter for the runtime's bound server id. Returns null until the
   *  first config read populates it. The validator fails closed in that
   *  window with SERVER_NOT_READY. */
  getServerId: () => string | null;
  /** Force the heartbeat client to poll Central immediately. Called once on
   *  UNKNOWN_KEY before the validator gives up — closes the cache-staleness
   *  window where Central minted a token with a key we haven't synced yet.
   *  Throttled + single-flight at the heartbeat layer. */
  refreshKeys: () => Promise<void>;
}

function base64urlDecode(b64url: string): Uint8Array {
  const padded = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (padded.length % 4)) % 4;
  const binary = atob(padded + "=".repeat(padLen));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function createTokenValidator(deps: TokenValidatorDeps): TokenValidator {
  return {
    async validate(token: string): Promise<TokenValidationResult> {
      try {
        const parts = token.split(".");
        if (parts.length !== 3) {
          return { ok: false, code: "INVALID_TOKEN", message: "Malformed JWT" };
        }
        const [headerB64, payloadB64, sigB64] = parts as [string, string, string];

        let header: Record<string, unknown>;
        try {
          header = JSON.parse(
            new TextDecoder().decode(base64urlDecode(headerB64)),
          ) as Record<string, unknown>;
        } catch {
          return { ok: false, code: "INVALID_TOKEN", message: "Failed to decode JWT header" };
        }

        const kid = typeof header["kid"] === "string" ? header["kid"] : null;
        if (!kid) {
          return { ok: false, code: "INVALID_TOKEN", message: "Missing kid in JWT header" };
        }

        const alg = typeof header["alg"] === "string" ? header["alg"] : null;
        if (alg !== "EdDSA") {
          return { ok: false, code: "INVALID_ALG", message: `Unsupported JWT algorithm: ${alg ?? "missing"}` };
        }

        // Find the matching public key. If the kid isn't cached, the key may
        // have been rotated by Central since our last heartbeat — trigger a
        // throttled JWKS refresh and retry exactly once before failing.
        // Without this, the 30s heartbeat staleness window translates into a
        // false "auth failed" close (4003), which the website then maps to a
        // bogus "you were removed from this server" banner.
        let keyEntry = deps.getKeys().find((k) => k.id === kid);
        if (!keyEntry) {
          await deps.refreshKeys();
          keyEntry = deps.getKeys().find((k) => k.id === kid);
        }
        if (!keyEntry) {
          return {
            ok: false,
            code: "UNKNOWN_KEY",
            message: `No public key found for kid: ${kid}`,
          };
        }

        let publicKey: CryptoKey;
        try {
          publicKey = await crypto.subtle.importKey(
            "jwk",
            keyEntry.public_key,
            "Ed25519",
            false,
            ["verify"],
          );
        } catch {
          return { ok: false, code: "KEY_ERROR", message: "Failed to import public key" };
        }

        const signedData = Buffer.from(`${headerB64}.${payloadB64}`);
        const signature = Buffer.from(base64urlDecode(sigB64));

        let valid: boolean;
        try {
          valid = await crypto.subtle.verify(
            "Ed25519",
            publicKey,
            signature,
            signedData,
          );
        } catch {
          return { ok: false, code: "VERIFY_ERROR", message: "Signature verification threw an error" };
        }

        if (!valid) {
          return { ok: false, code: "INVALID_SIGNATURE", message: "JWT signature is invalid" };
        }

        // See JwtPayload in @uncorded/protocol for the expected payload shape.
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(
            new TextDecoder().decode(base64urlDecode(payloadB64)),
          ) as Record<string, unknown>;
        } catch {
          return { ok: false, code: "INVALID_TOKEN", message: "Failed to decode JWT payload" };
        }

        // 30s clock skew tolerance on exp.
        const nowSecs = Math.floor(Date.now() / 1000);
        if (typeof payload["exp"] !== "number") {
          return { ok: false, code: "INVALID_TOKEN", message: "Missing exp claim" };
        }
        if (payload["exp"] < nowSecs - 30) {
          return { ok: false, code: "TOKEN_EXPIRED", message: "JWT has expired" };
        }

        if (typeof payload["iat"] !== "number") {
          return { ok: false, code: "INVALID_TOKEN", message: "Missing iat claim" };
        }
        if (payload["iat"] > nowSecs + 30) {
          return { ok: false, code: "INVALID_TOKEN", message: "JWT issued in the future" };
        }

        if (typeof payload["jti"] !== "string" || payload["jti"].length === 0) {
          return { ok: false, code: "INVALID_TOKEN", message: "Missing jti claim" };
        }
        const jti = payload["jti"];

        const serverId = deps.getServerId();
        if (!serverId) {
          return { ok: false, code: "SERVER_NOT_READY", message: "Server ID not yet available — retry after first heartbeat" };
        }
        if (payload["server_id"] !== serverId) {
          return { ok: false, code: "WRONG_SERVER", message: "Token is bound to a different server" };
        }

        const userId = typeof payload["sub"] === "string" ? payload["sub"] : "unknown";
        const username =
          typeof payload["username"] === "string" ? payload["username"] : "";
        const displayName =
          typeof payload["display_name"] === "string" ? payload["display_name"] : "Unknown User";
        const avatarUrl =
          typeof payload["avatar_url"] === "string" ? payload["avatar_url"] : "";
        const role = payload["is_owner"] === true ? "owner" : "member";

        return {
          ok: true,
          user: { id: userId, username, displayName, avatarUrl, role },
          jti,
          exp: payload["exp"] as number,
        };
      } catch {
        return { ok: false, code: "INVALID_TOKEN", message: "Token validation failed" };
      }
    },
  };
}
