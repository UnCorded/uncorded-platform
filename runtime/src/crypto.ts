// Encryption-at-rest helpers for the runtime.
//
// Mirrors the pattern in apps/central/src/crypto.ts: HKDF-derive an
// AES-256-GCM key from a long-lived per-server master secret, then
// encrypt each plaintext with a fresh random 12-byte nonce. The wire
// format is `${ivB64}:${ctB64}` so a single column can hold the whole
// thing.
//
// Why not roll-our-own: AES-GCM is authenticated, fast, and supported
// by Web Crypto out of the box. Keying by HKDF means the master secret
// can be a high-entropy string of any length without having to be
// pre-conditioned to 32 bytes.
//
// Master secret source: `RUNTIME_ENCRYPTION_SECRET` env var. The runtime
// container is provisioned with this at install (managed by the desktop
// installer / docker-compose). Loss of the secret = loss of all
// encrypted-at-rest values; rotation requires re-encrypting them all
// under the new secret.

const HKDF_INFO_PREFIX = "uncorded-runtime-aes-";

/**
 * Resolve the master secret used to derive AES keys. Throws if the env
 * var is missing — encryption is fail-closed; we never silently fall
 * back to a default secret.
 */
function getMasterSecret(): string {
  const secret = process.env["RUNTIME_ENCRYPTION_SECRET"];
  if (!secret || secret.length < 16) {
    throw new Error(
      "RUNTIME_ENCRYPTION_SECRET environment variable is required (min 16 chars) " +
      "for at-rest encryption.",
    );
  }
  return secret;
}

/**
 * Derive a context-specific AES-256-GCM key from the master secret using
 * HKDF with a per-purpose `info` string. Different purposes (e.g. "voice"
 * vs "tokens") get different keys so a leak in one ciphertext can't be
 * used as an oracle on the other.
 */
async function deriveAesKey(purpose: string): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const raw = await crypto.subtle.importKey(
    "raw",
    enc.encode(getMasterSecret()),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(32),
      info: enc.encode(HKDF_INFO_PREFIX + purpose),
    },
    raw,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Encrypt `plaintext` under the per-purpose key derived from the master
 * secret. Returns `${ivB64}:${ctB64}` — opaque to callers.
 */
export async function encryptAtRest(
  plaintext: string,
  purpose: string,
): Promise<string> {
  const key = await deriveAesKey(purpose);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  const ivB64 = Buffer.from(iv).toString("base64");
  const ctB64 = Buffer.from(ciphertext).toString("base64");
  return `${ivB64}:${ctB64}`;
}

/**
 * Decrypt an encrypted-at-rest value produced by `encryptAtRest`.
 * Throws if the format is invalid, the purpose is wrong, the master
 * secret has changed, or the ciphertext has been tampered with (GCM
 * auth-tag verification fails).
 */
export async function decryptAtRest(
  encrypted: string,
  purpose: string,
): Promise<string> {
  const [ivB64, ctB64] = encrypted.split(":");
  if (!ivB64 || !ctB64) {
    throw new Error("decryptAtRest: invalid format (expected `iv:ct`).");
  }
  const iv = Buffer.from(ivB64, "base64");
  const ct = Buffer.from(ctB64, "base64");
  const key = await deriveAesKey(purpose);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ct,
  );
  return new TextDecoder().decode(plaintext);
}

/**
 * Generate `byteLength` cryptographically-strong random bytes and return
 * as a hex string. Used for fresh API secrets, room nonces, etc.
 */
export function generateRandomHex(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return Buffer.from(bytes).toString("hex");
}
