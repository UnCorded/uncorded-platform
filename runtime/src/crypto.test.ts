import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { encryptAtRest, decryptAtRest, generateRandomHex } from "./crypto";

const TEST_SECRET = "x".repeat(64);
let prevSecret: string | undefined;

beforeAll(() => {
  prevSecret = process.env["RUNTIME_ENCRYPTION_SECRET"];
  process.env["RUNTIME_ENCRYPTION_SECRET"] = TEST_SECRET;
});

afterAll(() => {
  if (prevSecret === undefined) {
    delete process.env["RUNTIME_ENCRYPTION_SECRET"];
  } else {
    process.env["RUNTIME_ENCRYPTION_SECRET"] = prevSecret;
  }
});

describe("encryptAtRest / decryptAtRest", () => {
  test("round-trips plaintext for the same purpose", async () => {
    const plaintext = "livekit-secret-deadbeef";
    const ct = await encryptAtRest(plaintext, "voice");
    const round = await decryptAtRest(ct, "voice");
    expect(round).toBe(plaintext);
  });

  test("two encryptions of the same plaintext produce different ciphertexts (random IV)", async () => {
    const a = await encryptAtRest("hello", "voice");
    const b = await encryptAtRest("hello", "voice");
    expect(a).not.toBe(b);
    // Both still decrypt back to the same plaintext.
    expect(await decryptAtRest(a, "voice")).toBe("hello");
    expect(await decryptAtRest(b, "voice")).toBe("hello");
  });

  test("decrypting with the wrong purpose fails (key separation)", async () => {
    const ct = await encryptAtRest("voice-only", "voice");
    let threw = false;
    try {
      await decryptAtRest(ct, "tokens");
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  test("decrypting tampered ciphertext fails (GCM auth tag)", async () => {
    const ct = await encryptAtRest("important", "voice");
    const [iv, body] = ct.split(":");
    // Flip a single bit in the body's first byte.
    const buf = Buffer.from(body!, "base64");
    buf[0]! ^= 0x01;
    const tampered = `${iv}:${buf.toString("base64")}`;
    let threw = false;
    try {
      await decryptAtRest(tampered, "voice");
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  test("invalid format rejected without doing crypto work", async () => {
    let threw = false;
    try {
      await decryptAtRest("not-a-valid-format", "voice");
    } catch (e) {
      threw = true;
      expect((e as Error).message).toContain("invalid format");
    }
    expect(threw).toBe(true);
  });

  test("encrypt fails fast if RUNTIME_ENCRYPTION_SECRET is missing", async () => {
    const saved = process.env["RUNTIME_ENCRYPTION_SECRET"];
    delete process.env["RUNTIME_ENCRYPTION_SECRET"];
    let threw = false;
    try {
      await encryptAtRest("oops", "voice");
    } catch (e) {
      threw = true;
      expect((e as Error).message).toContain("RUNTIME_ENCRYPTION_SECRET");
    } finally {
      if (saved !== undefined) process.env["RUNTIME_ENCRYPTION_SECRET"] = saved;
    }
    expect(threw).toBe(true);
  });

  test("encrypt fails fast if secret is too short (< 16 chars)", async () => {
    const saved = process.env["RUNTIME_ENCRYPTION_SECRET"];
    process.env["RUNTIME_ENCRYPTION_SECRET"] = "short";
    let threw = false;
    try {
      await encryptAtRest("oops", "voice");
    } catch {
      threw = true;
    } finally {
      process.env["RUNTIME_ENCRYPTION_SECRET"] = saved!;
    }
    expect(threw).toBe(true);
  });
});

describe("generateRandomHex", () => {
  test("returns hex of the requested byte length", () => {
    const hex = generateRandomHex(32);
    expect(hex).toHaveLength(64); // 32 bytes = 64 hex chars
    expect(/^[0-9a-f]+$/.test(hex)).toBe(true);
  });

  test("is non-deterministic across calls", () => {
    const a = generateRandomHex(16);
    const b = generateRandomHex(16);
    expect(a).not.toBe(b);
  });
});
