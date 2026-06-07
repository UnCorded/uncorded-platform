// Get-or-create + rotate the LiveKit API credentials, persisted to
// core.db with the secret encrypted at rest under the runtime master
// secret. The plaintext API secret never leaves this module — callers
// receive `{ apiKey, apiSecret }` and must not log/persist the secret
// anywhere except the supervisor's transient livekit.yaml at file mode
// 0600 (see config.ts).
//
// Why per-row encryption (vs encrypting the whole DB): the encryption
// boundary is the row, not the database, so a stray `core.db` file copy
// (backup snapshot, support tarball) doesn't leak the LiveKit secret
// without also leaking RUNTIME_ENCRYPTION_SECRET.

import type { Database } from "bun:sqlite";
import { encryptAtRest, decryptAtRest, generateRandomHex } from "../crypto";

const SLUG = "livekit";
const PURPOSE = "voice";

export interface LiveKitCredentials {
  apiKey: string;
  apiSecret: string;
}

interface VoiceConfigRow {
  api_key: string;
  secret_encrypted: string;
}

/**
 * Return the wall-clock timestamp of the most recent credential write
 * (initial create or rotate), or `null` if no credentials have been
 * persisted yet. Read-only — exposed for the admin state endpoint so
 * operators can see how recently the secret was rotated. Does not
 * decrypt the secret.
 */
export function getLiveKitSecretRotatedAt(db: Database): number | null {
  const row = db
    .prepare("SELECT updated_at FROM voice_config WHERE service_slug = ?")
    .get(SLUG) as { updated_at: number } | null;
  return row?.updated_at ?? null;
}

/**
 * Return the current LiveKit credentials, generating a fresh pair on
 * first call. Subsequent calls return the same pair until
 * `rotateLiveKitCredentials` is called.
 */
export async function getOrCreateLiveKitCredentials(
  db: Database,
): Promise<LiveKitCredentials> {
  const row = db
    .prepare("SELECT api_key, secret_encrypted FROM voice_config WHERE service_slug = ?")
    .get(SLUG) as VoiceConfigRow | null;

  if (row) {
    const apiSecret = await decryptAtRest(row.secret_encrypted, PURPOSE);
    return { apiKey: row.api_key, apiSecret };
  }

  return generateAndPersist(db);
}

/**
 * Generate a fresh API key/secret pair and replace the persisted row.
 * Existing LiveKit JWTs minted under the old secret become invalid; live
 * sessions must reconnect. Caller (supervisor.rotateSecret) is
 * responsible for restarting the LiveKit child so it picks up the new
 * config.
 */
export async function rotateLiveKitCredentials(
  db: Database,
): Promise<LiveKitCredentials> {
  return generateAndPersist(db);
}

async function generateAndPersist(db: Database): Promise<LiveKitCredentials> {
  // 16-byte (128-bit) key id, 32-byte (256-bit) signing secret. LiveKit
  // accepts any non-empty strings; sizes match the project convention
  // for non-secret/secret split.
  const apiKey = "uncorded-" + generateRandomHex(8); // 8 bytes = 16 hex chars
  const apiSecret = generateRandomHex(32);
  const encrypted = await encryptAtRest(apiSecret, PURPOSE);
  const now = Date.now();
  db.prepare(
    `INSERT INTO voice_config (service_slug, api_key, secret_encrypted, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(service_slug) DO UPDATE SET
       api_key = excluded.api_key,
       secret_encrypted = excluded.secret_encrypted,
       updated_at = excluded.updated_at`,
  ).run(SLUG, apiKey, encrypted, now, now);
  return { apiKey, apiSecret };
}
