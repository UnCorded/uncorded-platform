-- Stores per-managed-service secrets (currently just LiveKit) encrypted
-- at rest. Keyed by service slug so adding a second managed service
-- (e.g. a future TURN provider) doesn't need a new table.
--
-- secret_encrypted is opaque: produced by runtime/src/crypto.ts
-- encryptAtRest("…", "voice"). Loss of RUNTIME_ENCRYPTION_SECRET makes
-- this column unrecoverable; rotation requires re-encrypting under the
-- new key.
--
-- api_key is stored in plaintext: it's a non-secret identifier that
-- LiveKit pairs with the secret. Keeping them split means a leak of the
-- DB row alone (without the encryption secret) yields the key but not
-- the signing material.
CREATE TABLE IF NOT EXISTS voice_config (
  service_slug     TEXT    NOT NULL PRIMARY KEY,
  api_key          TEXT    NOT NULL,
  secret_encrypted TEXT    NOT NULL,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
