// Fingerprint determinism + format. The CLI prints this string, the picker
// shows this string, and the attach client compares them — they must agree
// byte-for-byte across all three call sites.

import { describe, expect, test } from "bun:test";
import { FINGERPRINT_PLACEHOLDER, derive } from "./fingerprint.js";

describe("fingerprint.derive", () => {
  test("empty input returns the placeholder (plugin-source registrations)", async () => {
    expect(await derive(new Uint8Array(0))).toBe(FINGERPRINT_PLACEHOLDER);
  });

  test("32-byte zero pubkey produces a stable, non-placeholder fingerprint", async () => {
    // The Amendment M validation rejects zero-filled keys at register-time,
    // but the format function itself must still be deterministic on any input
    // shape. Confirm the value is consistent across calls.
    const a = await derive(new Uint8Array(32));
    const b = await derive(new Uint8Array(32));
    expect(a).toBe(b);
    expect(a).not.toBe(FINGERPRINT_PLACEHOLDER);
  });

  test("output uses base32 alphabet only (A-Z, 2-7) plus dashes", async () => {
    const fp = await derive(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]));
    expect(fp).toMatch(/^[A-Z2-7]+(-[A-Z2-7]+)*$/);
  });

  test("dashes group every 4 base32 chars", async () => {
    const fp = await derive(new Uint8Array(32).fill(0xff));
    const parts = fp.split("-");
    // 8-byte truncation → 13 base32 chars → groups [4, 4, 4, 1]
    expect(parts).toHaveLength(4);
    expect(parts[0]!.length).toBe(4);
    expect(parts[1]!.length).toBe(4);
    expect(parts[2]!.length).toBe(4);
    expect(parts[3]!.length).toBe(1);
  });

  test("distinct inputs produce distinct fingerprints", async () => {
    const a = await derive(new Uint8Array(32).fill(0x01));
    const b = await derive(new Uint8Array(32).fill(0x02));
    expect(a).not.toBe(b);
  });
});
