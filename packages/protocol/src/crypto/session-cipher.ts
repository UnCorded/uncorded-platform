// Per-attach-session cipher — single source of truth for nonce layout, AAD
// composition, and AEAD parameters. Imported by both the CLI host (Bun) and
// the browser attach client. Diverging by one byte between the two ends
// silently breaks decryption — `session-cipher.test.ts` and
// `adversarial.test.ts` are the safety net.
//
// Wire shape (Amendment J): { session_id, ciphertext, nonce(12) }.
// Crypto stack (Amendment K): X25519 ECDH → HKDF-SHA256 → AES-GCM-256.
// Replay protection (Amendment L): strict-monotonic uint64 counter per
// (session, direction); 4-byte per-direction local random in the nonce
// low-order bytes; AAD = sha256(session_id)[0..16] || direction_byte.

const HKDF_INFO = new TextEncoder().encode("uncorded.terminal.session.v1");
const KEY_BITS = 256;
const NONCE_LEN = 12;
const COUNTER_LEN = 8;
const SESSION_RANDOM_LEN = 4;
const AAD_PREFIX_LEN = 16;
const AES_TAG_LEN_BITS = 128;

export const DIRECTION_HOST_TO_ATTACH = 0x01 as const;
export const DIRECTION_ATTACH_TO_HOST = 0x02 as const;
export type Direction =
  | typeof DIRECTION_HOST_TO_ATTACH
  | typeof DIRECTION_ATTACH_TO_HOST;

export class ReplayDetectedError extends Error {
  readonly counter: bigint;
  readonly lastCounter: bigint;
  constructor(counter: bigint, lastCounter: bigint) {
    super(
      `replay detected: counter ${counter} <= last_counter ${lastCounter}`,
    );
    this.name = "ReplayDetectedError";
    this.counter = counter;
    this.lastCounter = lastCounter;
  }
}

export class FingerprintMismatchError extends Error {
  readonly expected: string;
  readonly actual: string;
  constructor(expected: string, actual: string) {
    super(`host fingerprint mismatch: expected ${expected}, got ${actual}`);
    this.name = "FingerprintMismatchError";
    this.expected = expected;
    this.actual = actual;
  }
}

// --- Key generation ---------------------------------------------------------

export interface HostKeypair {
  /** Raw 32-byte X25519 public key — broadcast in register.req. */
  publicKeyRaw: Uint8Array;
  /** JWK form of the private key — for OS secret-store persistence. */
  privateKeyJwk: JsonWebKey;
}

/** Long-lived host identity. Generated once per CLI install, persisted. */
export async function generateHostKeypair(): Promise<HostKeypair> {
  const pair = (await crypto.subtle.generateKey(
    { name: "X25519" },
    true,
    ["deriveBits"],
  )) as CryptoKeyPair;
  const [pubRaw, privJwk] = await Promise.all([
    crypto.subtle.exportKey("raw", pair.publicKey),
    crypto.subtle.exportKey("jwk", pair.privateKey),
  ]);
  return {
    publicKeyRaw: new Uint8Array(pubRaw),
    privateKeyJwk: privJwk,
  };
}

/** Re-import a stored host private JWK as a non-extractable CryptoKey. */
export async function importHostPrivateKey(
  jwk: JsonWebKey,
): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "X25519" },
    false,
    ["deriveBits"],
  );
}

export interface AttachKeypair {
  publicKeyRaw: Uint8Array;
  /** Non-extractable; lives only in browser memory for the session. */
  privateKey: CryptoKey;
}

/** Per-attach ephemeral keypair. Discarded on session end. */
export async function generateAttachKeypair(): Promise<AttachKeypair> {
  const pair = (await crypto.subtle.generateKey(
    { name: "X25519" },
    false,
    ["deriveBits"],
  )) as CryptoKeyPair;
  const pubRaw = await crypto.subtle.exportKey("raw", pair.publicKey);
  return {
    publicKeyRaw: new Uint8Array(pubRaw),
    privateKey: pair.privateKey,
  };
}

// --- Session-key derivation -------------------------------------------------

export interface SessionKeyMaterial {
  /** AES-GCM-256 key. extractable: false. */
  aesKey: CryptoKey;
  /** Precomputed sha256(session_id)[0..16] — concatenated with direction at frame time. */
  aadSessionPrefix: Uint8Array;
}

interface DeriveOpts {
  ourPrivateKey: CryptoKey;
  theirPublicKeyRaw: Uint8Array;
  sessionId: string;
}

export async function deriveSessionKey(
  opts: DeriveOpts,
): Promise<SessionKeyMaterial> {
  const theirPub = await crypto.subtle.importKey(
    "raw",
    bufferOf(opts.theirPublicKeyRaw),
    { name: "X25519" },
    true,
    [],
  );

  // ECDH → 256-bit shared secret.
  const ecdhBits = await crypto.subtle.deriveBits(
    { name: "X25519", public: theirPub },
    opts.ourPrivateKey,
    256,
  );

  // Import the ECDH output as an HKDF base key.
  const hkdfBase = await crypto.subtle.importKey(
    "raw",
    ecdhBits,
    "HKDF",
    false,
    ["deriveKey"],
  );

  // salt = sha256(session_id_utf8) — full 32 bytes per Amendment K.
  const sessionIdBytes = new TextEncoder().encode(opts.sessionId);
  const salt = new Uint8Array(
    await crypto.subtle.digest("SHA-256", bufferOf(sessionIdBytes)),
  );

  const aesKey = await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: bufferOf(salt),
      info: bufferOf(HKDF_INFO),
    },
    hkdfBase,
    { name: "AES-GCM", length: KEY_BITS },
    false,
    ["encrypt", "decrypt"],
  );

  const aadSessionPrefix = salt.slice(0, AAD_PREFIX_LEN);

  return { aesKey, aadSessionPrefix };
}

// --- Nonce + AAD helpers (pure, unit-testable without WebCrypto) ------------

/** Compose the 12-byte AES-GCM nonce: counter_be(8) || session_random(4). */
export function nonceFor(
  counter: bigint,
  sessionRandom: Uint8Array,
): Uint8Array {
  if (sessionRandom.length !== SESSION_RANDOM_LEN) {
    throw new Error(
      `session_random must be ${SESSION_RANDOM_LEN} bytes (got ${sessionRandom.length})`,
    );
  }
  if (counter < 0n) {
    throw new Error(`counter must be non-negative (got ${counter})`);
  }
  if (counter > 0xffff_ffff_ffff_ffffn) {
    throw new Error(`counter exceeds uint64 (got ${counter})`);
  }
  const out = new Uint8Array(NONCE_LEN);
  // Big-endian uint64.
  let c = counter;
  for (let i = COUNTER_LEN - 1; i >= 0; i--) {
    out[i] = Number(c & 0xffn);
    c >>= 8n;
  }
  out.set(sessionRandom, COUNTER_LEN);
  return out;
}

/** Extract the big-endian uint64 counter from a 12-byte nonce. */
export function counterFromNonce(nonce: Uint8Array): bigint {
  if (nonce.length !== NONCE_LEN) {
    throw new Error(`nonce must be ${NONCE_LEN} bytes (got ${nonce.length})`);
  }
  let c = 0n;
  for (let i = 0; i < COUNTER_LEN; i++) {
    c = (c << 8n) | BigInt(nonce[i]!);
  }
  return c;
}

/** Compose the AAD: aadSessionPrefix(16) || direction_byte(1). */
export function aadFor(
  prefix: Uint8Array,
  direction: Direction,
): Uint8Array {
  if (prefix.length !== AAD_PREFIX_LEN) {
    throw new Error(
      `AAD prefix must be ${AAD_PREFIX_LEN} bytes (got ${prefix.length})`,
    );
  }
  const out = new Uint8Array(AAD_PREFIX_LEN + 1);
  out.set(prefix, 0);
  out[AAD_PREFIX_LEN] = direction;
  return out;
}

/** Cryptographic random bytes for a per-direction session_random. */
export function generateSessionRandom(): Uint8Array {
  const r = new Uint8Array(SESSION_RANDOM_LEN);
  crypto.getRandomValues(r);
  return r;
}

// --- AEAD encrypt / decrypt -------------------------------------------------

interface EncryptOpts {
  aesKey: CryptoKey;
  counter: bigint;
  sessionRandom: Uint8Array;
  aadSessionPrefix: Uint8Array;
  direction: Direction;
  plaintext: Uint8Array;
}

export interface EncryptedFrame {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
}

export async function encryptFrame(opts: EncryptOpts): Promise<EncryptedFrame> {
  const nonce = nonceFor(opts.counter, opts.sessionRandom);
  const aad = aadFor(opts.aadSessionPrefix, opts.direction);
  const ct = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: bufferOf(nonce),
      additionalData: bufferOf(aad),
      tagLength: AES_TAG_LEN_BITS,
    },
    opts.aesKey,
    bufferOf(opts.plaintext),
  );
  return { ciphertext: new Uint8Array(ct), nonce };
}

interface DecryptOpts {
  aesKey: CryptoKey;
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  aadSessionPrefix: Uint8Array;
  direction: Direction;
  /** Strict-monotonic check: throws ReplayDetectedError if counter <= this. */
  lastCounter: bigint;
}

export interface DecryptedFrame {
  plaintext: Uint8Array;
  /** New last-seen counter — caller must persist this on success. */
  counter: bigint;
}

export async function decryptFrame(opts: DecryptOpts): Promise<DecryptedFrame> {
  const counter = counterFromNonce(opts.nonce);
  if (counter <= opts.lastCounter) {
    throw new ReplayDetectedError(counter, opts.lastCounter);
  }
  const aad = aadFor(opts.aadSessionPrefix, opts.direction);
  const pt = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: bufferOf(opts.nonce),
      additionalData: bufferOf(aad),
      tagLength: AES_TAG_LEN_BITS,
    },
    opts.aesKey,
    bufferOf(opts.ciphertext),
  );
  return { plaintext: new Uint8Array(pt), counter };
}

// SubtleCrypto's BufferSource type is picky about Uint8Array views over a
// shared ArrayBuffer (and Bun's WebCrypto rejects `SharedArrayBuffer`
// backings). Always hand it a freshly-allocated, view-aligned ArrayBuffer.
function bufferOf(bytes: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  return buf;
}
