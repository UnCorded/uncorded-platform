import { describe, test, expect } from "bun:test";
import {
  hashPassword,
  verifyPassword,
  generateSessionToken,
  hashToken,
} from "./crypto";

describe("Argon2id", () => {
  test("hashes and verifies a password", async () => {
    const password = "test-password-123";
    const hashed = await hashPassword(password);

    expect(hashed).not.toBe(password);
    expect(hashed).toContain("argon2");

    const valid = await verifyPassword(hashed, password);
    expect(valid).toBe(true);
  });

  test("rejects wrong password", async () => {
    const hashed = await hashPassword("correct-password");
    const valid = await verifyPassword(hashed, "wrong-password");
    expect(valid).toBe(false);
  });
});

describe("session tokens", () => {
  test("generates a 64-char hex token", () => {
    const token = generateSessionToken();
    expect(token).toHaveLength(64);
    expect(/^[0-9a-f]+$/.test(token)).toBe(true);
  });

  test("generates unique tokens", () => {
    const a = generateSessionToken();
    const b = generateSessionToken();
    expect(a).not.toBe(b);
  });

  test("hashes token deterministically", async () => {
    const token = "deadbeef".repeat(8);
    const h1 = await hashToken(token);
    const h2 = await hashToken(token);
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(64); // SHA-256 hex
  });
});
