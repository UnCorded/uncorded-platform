// Adversarial AEAD behavior. Anything in this file that ever passes
// erroneously is a security regression.

import { describe, expect, test } from "bun:test";
import {
  DIRECTION_ATTACH_TO_HOST,
  DIRECTION_HOST_TO_ATTACH,
  ReplayDetectedError,
  decryptFrame,
  deriveSessionKey,
  encryptFrame,
  generateAttachKeypair,
  generateHostKeypair,
  generateSessionRandom,
  importHostPrivateKey,
} from "./session-cipher.js";

async function newSession(sessionId: string) {
  const host = await generateHostKeypair();
  const attach = await generateAttachKeypair();
  const hostPriv = await importHostPrivateKey(host.privateKeyJwk);
  return deriveSessionKey({
    ourPrivateKey: hostPriv,
    theirPublicKeyRaw: attach.publicKeyRaw,
    sessionId,
  });
}

describe("AEAD adversarial scenarios", () => {
  test("replay at same counter rejected with ReplayDetectedError", async () => {
    const sess = await newSession("adv-replay");
    const sr = generateSessionRandom();
    const enc = await encryptFrame({
      aesKey: sess.aesKey,
      counter: 100n,
      sessionRandom: sr,
      aadSessionPrefix: sess.aadSessionPrefix,
      direction: DIRECTION_HOST_TO_ATTACH,
      plaintext: new Uint8Array([1, 2, 3]),
    });

    // First decrypt is fine.
    const ok = await decryptFrame({
      aesKey: sess.aesKey,
      ciphertext: enc.ciphertext,
      nonce: enc.nonce,
      aadSessionPrefix: sess.aadSessionPrefix,
      direction: DIRECTION_HOST_TO_ATTACH,
      lastCounter: 99n,
    });
    expect(ok.counter).toBe(100n);

    // Replay (same nonce/ciphertext) at counter > 100 not possible by construction
    // — the counter is encoded in the nonce. The receiver state advances to 100,
    // and another submission of the same frame is checked against last_counter=100.
    await expect(
      decryptFrame({
        aesKey: sess.aesKey,
        ciphertext: enc.ciphertext,
        nonce: enc.nonce,
        aadSessionPrefix: sess.aadSessionPrefix,
        direction: DIRECTION_HOST_TO_ATTACH,
        lastCounter: 100n,
      }),
    ).rejects.toBeInstanceOf(ReplayDetectedError);
  });

  test("cross-session frame swap fails AEAD (different keys)", async () => {
    const sessA = await newSession("adv-cross-A");
    const sessB = await newSession("adv-cross-B");
    const sr = generateSessionRandom();
    const enc = await encryptFrame({
      aesKey: sessA.aesKey,
      counter: 0n,
      sessionRandom: sr,
      aadSessionPrefix: sessA.aadSessionPrefix,
      direction: DIRECTION_HOST_TO_ATTACH,
      plaintext: new Uint8Array([7]),
    });

    await expect(
      decryptFrame({
        aesKey: sessB.aesKey,
        ciphertext: enc.ciphertext,
        nonce: enc.nonce,
        aadSessionPrefix: sessB.aadSessionPrefix,
        direction: DIRECTION_HOST_TO_ATTACH,
        lastCounter: -1n,
      }),
    ).rejects.toThrow(); // OperationError / DOMException, not ReplayDetectedError
  });

  test("cross-direction swap fails AEAD (AAD differs)", async () => {
    const sess = await newSession("adv-direction");
    const sr = generateSessionRandom();
    const enc = await encryptFrame({
      aesKey: sess.aesKey,
      counter: 0n,
      sessionRandom: sr,
      aadSessionPrefix: sess.aadSessionPrefix,
      direction: DIRECTION_HOST_TO_ATTACH,
      plaintext: new Uint8Array([9]),
    });

    await expect(
      decryptFrame({
        aesKey: sess.aesKey,
        ciphertext: enc.ciphertext,
        nonce: enc.nonce,
        aadSessionPrefix: sess.aadSessionPrefix,
        direction: DIRECTION_ATTACH_TO_HOST, // wrong direction
        lastCounter: -1n,
      }),
    ).rejects.toThrow();
  });

  test("single-bit flip in payload fails AEAD", async () => {
    const sess = await newSession("adv-bitflip-pt");
    const sr = generateSessionRandom();
    const enc = await encryptFrame({
      aesKey: sess.aesKey,
      counter: 0n,
      sessionRandom: sr,
      aadSessionPrefix: sess.aadSessionPrefix,
      direction: DIRECTION_HOST_TO_ATTACH,
      plaintext: new Uint8Array([0xa5, 0x5a, 0xff, 0x00]),
    });

    const tampered = new Uint8Array(enc.ciphertext);
    tampered[0] = tampered[0]! ^ 0x01;
    await expect(
      decryptFrame({
        aesKey: sess.aesKey,
        ciphertext: tampered,
        nonce: enc.nonce,
        aadSessionPrefix: sess.aadSessionPrefix,
        direction: DIRECTION_HOST_TO_ATTACH,
        lastCounter: -1n,
      }),
    ).rejects.toThrow();
  });

  test("single-bit flip in nonce session_random fails AEAD", async () => {
    const sess = await newSession("adv-bitflip-nonce");
    const sr = generateSessionRandom();
    const enc = await encryptFrame({
      aesKey: sess.aesKey,
      counter: 5n,
      sessionRandom: sr,
      aadSessionPrefix: sess.aadSessionPrefix,
      direction: DIRECTION_HOST_TO_ATTACH,
      plaintext: new Uint8Array([42]),
    });

    const tamperedNonce = new Uint8Array(enc.nonce);
    tamperedNonce[10] = tamperedNonce[10]! ^ 0x01; // bit flip in session_random portion
    await expect(
      decryptFrame({
        aesKey: sess.aesKey,
        ciphertext: enc.ciphertext,
        nonce: tamperedNonce,
        aadSessionPrefix: sess.aadSessionPrefix,
        direction: DIRECTION_HOST_TO_ATTACH,
        lastCounter: -1n,
      }),
    ).rejects.toThrow();
  });

  test("AAD prefix tampering fails AEAD (binds frame to session)", async () => {
    const sess = await newSession("adv-aad");
    const sr = generateSessionRandom();
    const enc = await encryptFrame({
      aesKey: sess.aesKey,
      counter: 0n,
      sessionRandom: sr,
      aadSessionPrefix: sess.aadSessionPrefix,
      direction: DIRECTION_HOST_TO_ATTACH,
      plaintext: new Uint8Array([0]),
    });

    const tamperedPrefix = new Uint8Array(sess.aadSessionPrefix);
    tamperedPrefix[0] = tamperedPrefix[0]! ^ 0x01;
    await expect(
      decryptFrame({
        aesKey: sess.aesKey,
        ciphertext: enc.ciphertext,
        nonce: enc.nonce,
        aadSessionPrefix: tamperedPrefix,
        direction: DIRECTION_HOST_TO_ATTACH,
        lastCounter: -1n,
      }),
    ).rejects.toThrow();
  });

  test("truncated ciphertext (auth tag missing) fails AEAD", async () => {
    const sess = await newSession("adv-truncate");
    const sr = generateSessionRandom();
    const enc = await encryptFrame({
      aesKey: sess.aesKey,
      counter: 0n,
      sessionRandom: sr,
      aadSessionPrefix: sess.aadSessionPrefix,
      direction: DIRECTION_HOST_TO_ATTACH,
      plaintext: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
    });

    // Drop the last byte of the auth tag.
    const truncated = enc.ciphertext.slice(0, enc.ciphertext.length - 1);
    await expect(
      decryptFrame({
        aesKey: sess.aesKey,
        ciphertext: truncated,
        nonce: enc.nonce,
        aadSessionPrefix: sess.aadSessionPrefix,
        direction: DIRECTION_HOST_TO_ATTACH,
        lastCounter: -1n,
      }),
    ).rejects.toThrow();
  });
});
