import { hash, verify } from "@node-rs/argon2";
import type { Sql } from "./db";

// --- Argon2id password hashing ---

export async function hashPassword(password: string): Promise<string> {
  return hash(password, {
    memoryCost: 19456, // ~19 MiB
    timeCost: 2,
    outputLen: 32,
    parallelism: 1,
  });
}

export async function verifyPassword(
  hashed: string,
  password: string,
): Promise<boolean> {
  try {
    return await verify(hashed, password);
  } catch {
    return false;
  }
}

// --- Session token generation ---

export function generateSessionToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Buffer.from(bytes).toString("hex");
}

export async function hashToken(token: string): Promise<string> {
  const encoded = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return Buffer.from(digest).toString("hex");
}

// --- Ed25519 key management ---

export interface SigningKeyPair {
  id: string;
  publicKey: JsonWebKey;
  privateKey: JsonWebKey;
}

export interface PublicKeyInfo {
  id: string;
  publicKey: JsonWebKey;
}

async function deriveAesKey(secret: string): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const raw = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(32),
      info: enc.encode("uncorded-signing-key-encryption"),
    },
    raw,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function encryptPrivateKey(
  jwk: JsonWebKey,
  secret: string,
): Promise<string> {
  const aesKey = await deriveAesKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(jwk));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    aesKey,
    plaintext,
  );
  // Store as iv:ciphertext in base64
  const ivB64 = Buffer.from(iv).toString("base64");
  const ctB64 = Buffer.from(ciphertext).toString("base64");
  return `${ivB64}:${ctB64}`;
}

async function decryptPrivateKey(
  encrypted: string,
  secret: string,
): Promise<JsonWebKey> {
  const [ivB64, ctB64] = encrypted.split(":");
  if (!ivB64 || !ctB64) throw new Error("Invalid encrypted key format");
  const iv = Buffer.from(ivB64, "base64");
  const ciphertext = Buffer.from(ctB64, "base64");
  const aesKey = await deriveAesKey(secret);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    aesKey,
    ciphertext,
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as JsonWebKey;
}

function getSigningKeySecret(): string {
  const secret = process.env["SIGNING_KEY_SECRET"];
  if (!secret) {
    throw new Error(
      "SIGNING_KEY_SECRET environment variable is required for Ed25519 key encryption",
    );
  }
  return secret;
}

export async function ensureSigningKey(sql: Sql): Promise<void> {
  const existing =
    await sql`SELECT id, private_key_encrypted FROM signing_keys WHERE state = 'active' LIMIT 1`;
  if (existing.length > 0) {
    // Verify the existing key is actually decryptable with the current KDF.
    // If not (e.g. DB has keys from the old padEnd derivation, or
    // SIGNING_KEY_SECRET was rotated), fall through and create a fresh key
    // so the service can boot cleanly.
    const row = existing[0]!;
    try {
      const secret = getSigningKeySecret();
      await decryptPrivateKey(row.private_key_encrypted as string, secret);
      return;
    } catch {
      console.warn(
        "[crypto] Active signing key could not be decrypted — " +
          "likely encrypted with a different KDF. Creating a new active key.",
      );
      // Mark the undecryptable key as expired so it stops being returned.
      await sql`
        UPDATE signing_keys SET state = 'expired' WHERE state = 'active'
      `;
      // Fall through to create a new key.
    }
  }

  const keyPair = await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ]);

  const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  const privateJwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);

  const secret = getSigningKeySecret();
  const encryptedPrivate = await encryptPrivateKey(privateJwk, secret);

  await sql`
    INSERT INTO signing_keys (public_key, private_key_encrypted, state)
    VALUES (${JSON.stringify(publicJwk)}, ${encryptedPrivate}, 'active')
  `;

  // Force every running runtime to refetch JWKS on its next heartbeat. Without
  // this, the runtime's last_sync_version still matches Central's
  // currentSyncVersion → dirty=false response → public_keys are NOT delivered,
  // and tokens minted under the new kid 401 forever (kid not in runtime's
  // cached JWKS). See bumpSyncForKeyChange for the no-op-delta trick that
  // avoids triggering the full_snapshot user-disconnect path.
  await bumpSyncForKeyChange(sql);
}

// Bumps sync_version for every server AND writes a placeholder delta at the
// new version. The delta is intentionally an unknown type to the runtime
// (no handler registered) — it gets logged and skipped, but its presence
// makes deltas.length > 0 in heartbeat.ts so the empty-deltas branch (which
// sets full_snapshot=true and force-disconnects every user) doesn't fire.
// Net effect: dirty=true, fresh public_keys, no user disruption.
async function bumpSyncForKeyChange(sql: Sql): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`UPDATE server_sync SET sync_version = sync_version + 1`;
    await tx`
      INSERT INTO server_deltas (server_id, sync_version, delta_type, payload)
      SELECT server_id, sync_version, 'public_keys_changed', '{}'::jsonb
      FROM server_sync
    `;
  });
}

export async function getActiveSigningKey(
  sql: Sql,
): Promise<SigningKeyPair | null> {
  const rows = await sql`
    SELECT id, public_key, private_key_encrypted
    FROM signing_keys
    WHERE state = 'active'
    ORDER BY created_at DESC
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;

  const secret = getSigningKeySecret();
  const publicKey = JSON.parse(row.public_key as string) as JsonWebKey;
  const privateKey = await decryptPrivateKey(
    row.private_key_encrypted as string,
    secret,
  );

  return { id: row.id as string, publicKey, privateKey };
}

// --- Server secret generation ---

export function generateServerSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Buffer.from(bytes).toString("hex");
}

// --- JWT signing ---

function base64url(input: string | ArrayBuffer): string {
  const buf =
    typeof input === "string" ? Buffer.from(input) : Buffer.from(input);
  return buf.toString("base64url");
}

export async function signJwt(
  payload: Record<string, unknown>,
  signingKey: SigningKeyPair,
): Promise<string> {
  const header = { alg: "EdDSA", kid: signingKey.id };
  const headerB64 = base64url(JSON.stringify(header));
  const payloadB64 = base64url(JSON.stringify(payload));
  const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);

  const privateKey = await crypto.subtle.importKey(
    "jwk",
    signingKey.privateKey,
    "Ed25519",
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("Ed25519", privateKey, data);

  return `${headerB64}.${payloadB64}.${base64url(signature)}`;
}

// --- Public key retrieval ---

// 60s TTL cache. Keys rotate every 24h and new keys enter as 'pending' with a
// 60s promotion delay, so a 60s cache can never return a set that omits a
// currently-valid signing key. Cache is process-local; rotateSigningKey() busts
// it in-process, and on a multi-instance deployment each pod just takes up to
// 60s to notice the new key — acceptable given the 10-minute retiring overlap.
interface PublicKeyCacheEntry {
  keys: PublicKeyInfo[];
  cachedAt: number;
}
let publicKeyCache: PublicKeyCacheEntry | null = null;
const PUBLIC_KEY_CACHE_TTL_MS = 60_000;

export async function getPublicKeys(sql: Sql): Promise<PublicKeyInfo[]> {
  if (
    publicKeyCache !== null &&
    Date.now() - publicKeyCache.cachedAt < PUBLIC_KEY_CACHE_TTL_MS
  ) {
    return publicKeyCache.keys;
  }
  const rows = await sql`
    SELECT id, public_key
    FROM signing_keys
    WHERE state IN ('active', 'pending', 'retiring')
    ORDER BY created_at DESC
  `;
  const keys = rows.map((row) => ({
    id: row.id as string,
    publicKey: JSON.parse(row.public_key as string) as JsonWebKey,
  }));
  publicKeyCache = { keys, cachedAt: Date.now() };
  return keys;
}

// Exposed for tests so each case starts with a clean cache. Not for production
// callers — rotateSigningKey() already invalidates in-process.
export function __resetPublicKeyCacheForTests(): void {
  publicKeyCache = null;
}

/**
 * Rotate the active signing key. Idempotent at the row level — partial failure
 * rolls back the whole transaction.
 *
 * Steady-state cycle (per 24h):
 *   1. Expire any retiring keys past their grace window.
 *   2. Promote any matured pending key (>60s old) to active. The 60s wait
 *      gives runtimes time to fetch the new public key via the sync_version
 *      bump in step 5 before any token signed by it appears.
 *   3. Retire the *prior* actives — explicitly excluding the row just
 *      promoted in step 2 — with a 10-minute grace so already-issued tokens
 *      keep verifying.
 *   4. Insert a new pending row to be promoted on the next rotation cycle.
 *   5. Bump server_sync so every runtime refetches JWKS on next heartbeat.
 *
 * First-rotation guard: on the very first rotation after boot the database
 * contains a single active row (created by ensureSigningKey) and no pending.
 * Step 2 promotes nothing, so step 3 is skipped — retiring the only active
 * with no replacement would leave zero active keys until the next 24h cycle,
 * and `getActiveSigningKey` would return null for every token-mint request.
 * The freshly-inserted pending in step 4 ages into a promotable candidate by
 * the next rotation, restoring the steady-state cycle.
 */
export async function rotateSigningKey(sql: Sql): Promise<void> {
  const secret = getSigningKeySecret();

  const keyPair = await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ]);
  const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  const privateJwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);
  const encryptedPrivate = await encryptPrivateKey(privateJwk, secret);

  await sql.begin(async (tx) => {
    // 1. Expire old retiring keys past their grace window.
    await tx`UPDATE signing_keys SET state = 'expired' WHERE state = 'retiring' AND expires_at < now()`;

    // 2. Promote any matured pending → active. RETURNING captures the
    //    promoted row's id so step 3 can exclude it; without that exclusion
    //    the next UPDATE would retire the freshly-promoted key alongside
    //    the prior active, leaving zero active keys after rotation.
    const promoted = await tx`
      UPDATE signing_keys
      SET state = 'active'
      WHERE state = 'pending' AND created_at < now() - interval '60 seconds'
      RETURNING id
    `;

    // 3. Retire the prior actives — but only when a freshly-promoted key
    //    is taking over signing duty. On the first post-boot rotation
    //    `promoted` is empty and retiring would leave the system unable to
    //    mint tokens for 24h. Skipping is safe: the only impact is that the
    //    prior active key serves an extra rotation cycle, and the next
    //    cycle promotes the pending we insert in step 4.
    if (promoted.length > 0) {
      const promotedIds = promoted.map((r) => r.id as string);
      await tx`
        UPDATE signing_keys
        SET state = 'retiring', expires_at = now() + interval '10 minutes'
        WHERE state = 'active' AND id <> ALL(${promotedIds}::uuid[])
      `;
    }

    // 4. Insert next-cycle pending key. The 24h interval before promotion
    //    is far longer than the 60s minimum required for runtime JWKS
    //    propagation — gives every runtime ample time to fetch the new
    //    public key before tokens signed by it start appearing.
    await tx`INSERT INTO signing_keys (public_key, private_key_encrypted, state) VALUES (${JSON.stringify(publicJwk)}, ${encryptedPrivate}, 'pending')`;

    // 5. Bump sync_version so every runtime refetches JWKS on next heartbeat.
    //    Same transaction so a partial rotation can't leave runtimes pointing
    //    at retired-but-not-yet-replaced keys. See bumpSyncForKeyChange for
    //    why we write a placeholder delta instead of just bumping the version.
    await tx`UPDATE server_sync SET sync_version = sync_version + 1`;
    await tx`
      INSERT INTO server_deltas (server_id, sync_version, delta_type, payload)
      SELECT server_id, sync_version, 'public_keys_changed', '{}'::jsonb
      FROM server_sync
    `;
  });

  // Bust the TTL cache so the next getPublicKeys() call reflects the new
  // state set within the same process. Other instances will observe it at
  // most PUBLIC_KEY_CACHE_TTL_MS later, which is safe — the retiring overlap
  // covers that window.
  publicKeyCache = null;
}
