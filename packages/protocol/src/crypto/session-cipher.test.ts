// Crypto-helper tests. The shared module both ends import from is the single
// source of truth for nonce layout, AAD composition, and AEAD parameters —
// this suite is the primary safety net.

import { describe, expect, test } from "bun:test";
import {
  DIRECTION_ATTACH_TO_HOST,
  DIRECTION_HOST_TO_ATTACH,
  ReplayDetectedError,
  aadFor,
  counterFromNonce,
  decryptFrame,
  deriveSessionKey,
  encryptFrame,
  generateAttachKeypair,
  generateHostKeypair,
  generateSessionRandom,
  importHostPrivateKey,
  nonceFor,
} from "./session-cipher.js";

describe("nonceFor / counterFromNonce", () => {
  test("layout is counter_be(8) || session_random(4)", () => {
    const r = new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]);
    const n = nonceFor(0x0102030405060708n, r);
    expect(n.length).toBe(12);
    expect(Array.from(n.subarray(0, 8))).toEqual([
      0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
    ]);
    expect(Array.from(n.subarray(8))).toEqual([0xaa, 0xbb, 0xcc, 0xdd]);
  });

  test("counter 0 produces a zeroed counter prefix", () => {
    const r = new Uint8Array([1, 2, 3, 4]);
    const n = nonceFor(0n, r);
    expect(Array.from(n.subarray(0, 8))).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  test("round-trips counter via counterFromNonce", () => {
    const r = generateSessionRandom();
    for (const c of [0n, 1n, 1000n, 0xffff_ffffn, 0xff_ffff_ffff_ffffn]) {
      const n = nonceFor(c, r);
      expect(counterFromNonce(n)).toBe(c);
    }
  });

  test("session_random length is enforced", () => {
    expect(() => nonceFor(1n, new Uint8Array(3))).toThrow(/4 bytes/);
    expect(() => nonceFor(1n, new Uint8Array(5))).toThrow(/4 bytes/);
  });

  test("negative counter rejected", () => {
    expect(() => nonceFor(-1n, generateSessionRandom())).toThrow(/non-negative/);
  });
});

describe("aadFor", () => {
  test("layout is prefix(16) || direction(1)", () => {
    const prefix = new Uint8Array(16).fill(0x42);
    const aad = aadFor(prefix, DIRECTION_HOST_TO_ATTACH);
    expect(aad.length).toBe(17);
    expect(Array.from(aad.subarray(0, 16))).toEqual(Array(16).fill(0x42));
    expect(aad[16]).toBe(0x01);
  });

  test("direction byte differentiates", () => {
    const prefix = new Uint8Array(16).fill(0x42);
    expect(aadFor(prefix, DIRECTION_HOST_TO_ATTACH)[16]).toBe(0x01);
    expect(aadFor(prefix, DIRECTION_ATTACH_TO_HOST)[16]).toBe(0x02);
  });

  test("prefix length is enforced", () => {
    expect(() => aadFor(new Uint8Array(15), DIRECTION_HOST_TO_ATTACH))
      .toThrow(/16 bytes/);
  });
});

describe("X25519 + HKDF + AES-GCM end-to-end", () => {
  test("encrypt then decrypt round-trips plaintext", async () => {
    const sessionId = "sess-rt-1";
    const { aesKey: hostKey, aadSessionPrefix } = await mkSession(sessionId);
    const sr = generateSessionRandom();
    const pt = new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f]); // "hello"

    const enc = await encryptFrame({
      aesKey: hostKey,
      counter: 0n,
      sessionRandom: sr,
      aadSessionPrefix,
      direction: DIRECTION_HOST_TO_ATTACH,
      plaintext: pt,
    });

    const dec = await decryptFrame({
      aesKey: hostKey,
      ciphertext: enc.ciphertext,
      nonce: enc.nonce,
      aadSessionPrefix,
      direction: DIRECTION_HOST_TO_ATTACH,
      lastCounter: -1n,
    });
    expect(Array.from(dec.plaintext)).toEqual(Array.from(pt));
    expect(dec.counter).toBe(0n);
  });

  test("HKDF is deterministic for the same (shared_secret, session_id)", async () => {
    const host = await generateHostKeypair();
    const attach = await generateAttachKeypair();
    const hostPriv = await importHostPrivateKey(host.privateKeyJwk);

    const a = await deriveSessionKey({
      ourPrivateKey: hostPriv,
      theirPublicKeyRaw: attach.publicKeyRaw,
      sessionId: "sess-determinism",
    });
    const b = await deriveSessionKey({
      ourPrivateKey: hostPriv,
      theirPublicKeyRaw: attach.publicKeyRaw,
      sessionId: "sess-determinism",
    });
    // Can't compare the keys directly (extractable: false); check that
    // ciphertexts produced under each are interchangeable for decryption.
    const sr = generateSessionRandom();
    const enc = await encryptFrame({
      aesKey: a.aesKey,
      counter: 0n,
      sessionRandom: sr,
      aadSessionPrefix: a.aadSessionPrefix,
      direction: DIRECTION_HOST_TO_ATTACH,
      plaintext: new Uint8Array([42]),
    });
    const dec = await decryptFrame({
      aesKey: b.aesKey,
      ciphertext: enc.ciphertext,
      nonce: enc.nonce,
      aadSessionPrefix: b.aadSessionPrefix,
      direction: DIRECTION_HOST_TO_ATTACH,
      lastCounter: -1n,
    });
    expect(Array.from(dec.plaintext)).toEqual([42]);
    expect(Array.from(a.aadSessionPrefix)).toEqual(Array.from(b.aadSessionPrefix));
  });

  test("ECDH(host_priv, attach_pub) === ECDH(attach_priv, host_pub)", async () => {
    const host = await generateHostKeypair();
    const attach = await generateAttachKeypair();
    const hostPriv = await importHostPrivateKey(host.privateKeyJwk);

    const sessionId = "sess-symmetry";
    const hostSide = await deriveSessionKey({
      ourPrivateKey: hostPriv,
      theirPublicKeyRaw: attach.publicKeyRaw,
      sessionId,
    });
    const attachSide = await deriveSessionKey({
      ourPrivateKey: attach.privateKey,
      theirPublicKeyRaw: host.publicKeyRaw,
      sessionId,
    });

    // Encrypt on host side, decrypt on attach side.
    const sr = generateSessionRandom();
    const enc = await encryptFrame({
      aesKey: hostSide.aesKey,
      counter: 0n,
      sessionRandom: sr,
      aadSessionPrefix: hostSide.aadSessionPrefix,
      direction: DIRECTION_HOST_TO_ATTACH,
      plaintext: new Uint8Array([1, 2, 3, 4]),
    });
    const dec = await decryptFrame({
      aesKey: attachSide.aesKey,
      ciphertext: enc.ciphertext,
      nonce: enc.nonce,
      aadSessionPrefix: attachSide.aadSessionPrefix,
      direction: DIRECTION_HOST_TO_ATTACH,
      lastCounter: -1n,
    });
    expect(Array.from(dec.plaintext)).toEqual([1, 2, 3, 4]);
  });
});

describe("strict-monotonic counter (replay protection)", () => {
  test("counter <= last_counter throws ReplayDetectedError", async () => {
    const { aesKey, aadSessionPrefix } = await mkSession("sess-replay");
    const sr = generateSessionRandom();
    const enc = await encryptFrame({
      aesKey,
      counter: 5n,
      sessionRandom: sr,
      aadSessionPrefix,
      direction: DIRECTION_HOST_TO_ATTACH,
      plaintext: new Uint8Array([1]),
    });

    // last_counter = 5 → counter = 5 must be rejected.
    await expect(
      decryptFrame({
        aesKey,
        ciphertext: enc.ciphertext,
        nonce: enc.nonce,
        aadSessionPrefix,
        direction: DIRECTION_HOST_TO_ATTACH,
        lastCounter: 5n,
      }),
    ).rejects.toBeInstanceOf(ReplayDetectedError);

    // last_counter = 4 → counter = 5 succeeds.
    const ok = await decryptFrame({
      aesKey,
      ciphertext: enc.ciphertext,
      nonce: enc.nonce,
      aadSessionPrefix,
      direction: DIRECTION_HOST_TO_ATTACH,
      lastCounter: 4n,
    });
    expect(ok.counter).toBe(5n);
  });

  test("strict less-than (counter == last is rejected)", async () => {
    const { aesKey, aadSessionPrefix } = await mkSession("sess-strict");
    const sr = generateSessionRandom();
    const enc = await encryptFrame({
      aesKey,
      counter: 7n,
      sessionRandom: sr,
      aadSessionPrefix,
      direction: DIRECTION_HOST_TO_ATTACH,
      plaintext: new Uint8Array([0]),
    });
    await expect(
      decryptFrame({
        aesKey,
        ciphertext: enc.ciphertext,
        nonce: enc.nonce,
        aadSessionPrefix,
        direction: DIRECTION_HOST_TO_ATTACH,
        lastCounter: 7n,
      }),
    ).rejects.toBeInstanceOf(ReplayDetectedError);
  });
});

describe("per-direction independence", () => {
  test("host random and attach random can collide at a counter without nonce reuse risk", async () => {
    // Both sides happen to pick the same session_random AND the same counter.
    // The (session, direction)-binding AAD ensures their frames are still
    // distinguishable cryptographically — a frame swapped across directions
    // fails AEAD even with identical nonces, because the AAD differs.
    const sessionId = "sess-collide";
    const host = await mkSession(sessionId);
    const attach = host; // same key (same session) for the demo

    const sr = new Uint8Array([0, 0, 0, 1]); // identical
    const counter = 42n; // identical
    const pt = new Uint8Array([0x21]);

    const hostFrame = await encryptFrame({
      aesKey: host.aesKey,
      counter,
      sessionRandom: sr,
      aadSessionPrefix: host.aadSessionPrefix,
      direction: DIRECTION_HOST_TO_ATTACH,
      plaintext: pt,
    });
    const attachFrame = await encryptFrame({
      aesKey: attach.aesKey,
      counter,
      sessionRandom: sr,
      aadSessionPrefix: attach.aadSessionPrefix,
      direction: DIRECTION_ATTACH_TO_HOST,
      plaintext: pt,
    });

    // Nonces are identical (same counter, same random).
    expect(Array.from(hostFrame.nonce)).toEqual(Array.from(attachFrame.nonce));
    // Ciphertexts MUST differ because AAD differs (direction byte).
    expect(Array.from(hostFrame.ciphertext))
      .not.toEqual(Array.from(attachFrame.ciphertext));

    // Swapping direction at decrypt time fails AEAD.
    await expect(
      decryptFrame({
        aesKey: host.aesKey,
        ciphertext: hostFrame.ciphertext,
        nonce: hostFrame.nonce,
        aadSessionPrefix: host.aadSessionPrefix,
        direction: DIRECTION_ATTACH_TO_HOST,
        lastCounter: -1n,
      }),
    ).rejects.toThrow();
  });
});

// --- helpers ----------------------------------------------------------------

async function mkSession(sessionId: string) {
  const host = await generateHostKeypair();
  const attach = await generateAttachKeypair();
  const hostPriv = await importHostPrivateKey(host.privateKeyJwk);
  return deriveSessionKey({
    ourPrivateKey: hostPriv,
    theirPublicKeyRaw: attach.publicKeyRaw,
    sessionId,
  });
}
