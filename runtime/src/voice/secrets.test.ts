import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { getOrCreateLiveKitCredentials, rotateLiveKitCredentials } from "./secrets";

const TEST_SECRET = "x".repeat(64);
let prevSecret: string | undefined;

beforeAll(() => {
  prevSecret = process.env["RUNTIME_ENCRYPTION_SECRET"];
  process.env["RUNTIME_ENCRYPTION_SECRET"] = TEST_SECRET;
});

afterAll(() => {
  if (prevSecret === undefined) delete process.env["RUNTIME_ENCRYPTION_SECRET"];
  else process.env["RUNTIME_ENCRYPTION_SECRET"] = prevSecret;
});

function makeDb(): Database {
  const db = new Database(":memory:");
  // Apply only the migration this test cares about.
  db.exec(`
    CREATE TABLE IF NOT EXISTS voice_config (
      service_slug     TEXT    NOT NULL PRIMARY KEY,
      api_key          TEXT    NOT NULL,
      secret_encrypted TEXT    NOT NULL,
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL
    );
  `);
  return db;
}

describe("voice secrets", () => {
  let db: Database;

  beforeEach(() => {
    db = makeDb();
  });

  test("first call generates and persists fresh credentials", async () => {
    const creds = await getOrCreateLiveKitCredentials(db);
    expect(creds.apiKey).toMatch(/^uncorded-[0-9a-f]{16}$/);
    expect(creds.apiSecret).toHaveLength(64); // 32 bytes hex
    const row = db
      .prepare("SELECT api_key, secret_encrypted FROM voice_config WHERE service_slug = 'livekit'")
      .get() as { api_key: string; secret_encrypted: string };
    expect(row.api_key).toBe(creds.apiKey);
    // Secret column is NOT plaintext.
    expect(row.secret_encrypted).not.toBe(creds.apiSecret);
    expect(row.secret_encrypted).toContain(":"); // iv:ct format
  });

  test("subsequent get returns the same credentials", async () => {
    const a = await getOrCreateLiveKitCredentials(db);
    const b = await getOrCreateLiveKitCredentials(db);
    expect(b).toEqual(a);
  });

  test("rotate replaces the persisted credentials", async () => {
    const before = await getOrCreateLiveKitCredentials(db);
    const after = await rotateLiveKitCredentials(db);
    expect(after.apiKey).not.toBe(before.apiKey);
    expect(after.apiSecret).not.toBe(before.apiSecret);
    // Subsequent get returns the rotated pair, not the original.
    const get = await getOrCreateLiveKitCredentials(db);
    expect(get).toEqual(after);
  });

  test("rotation updates updated_at", async () => {
    await getOrCreateLiveKitCredentials(db);
    const beforeRow = db.prepare("SELECT updated_at FROM voice_config").get() as { updated_at: number };
    // Sleep a hair to guarantee a different ms tick.
    await new Promise((r) => setTimeout(r, 5));
    await rotateLiveKitCredentials(db);
    const afterRow = db.prepare("SELECT updated_at FROM voice_config").get() as { updated_at: number };
    expect(afterRow.updated_at).toBeGreaterThan(beforeRow.updated_at);
  });
});
