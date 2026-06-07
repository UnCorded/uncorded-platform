import { describe, test, expect } from "bun:test";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";

import { verifyImageSignature } from "./verify";

// cosign supports two keypair shapes that we need to verify against:
//   - ECDSA P-256 — what `cosign generate-key-pair` produces by default,
//     and what's currently embedded in cosign-pubkey.ts.
//   - Ed25519    — what `cosign generate-key-pair --key-type=ed25519`
//     produces. Kept in the matrix so a future rotation to Ed25519 doesn't
//     silently break verification.
type KeyKind = "ecdsa" | "ed25519";
function freshKeypair(kind: KeyKind = "ecdsa"): { pubPem: string; privPem: string } {
  const { publicKey, privateKey } =
    kind === "ed25519"
      ? generateKeyPairSync("ed25519")
      : generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    pubPem: publicKey.export({ format: "pem", type: "spki" }) as string,
    privPem: privateKey.export({ format: "pem", type: "pkcs8" }) as string,
  };
}

const DIGEST = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
const REFERENCE = "ghcr.io/uncorded/runtime";

function makePayload(args?: {
  digest?: string;
  reference?: string;
  type?: string;
}): string {
  return JSON.stringify({
    critical: {
      identity: { "docker-reference": args?.reference ?? REFERENCE },
      image: { "docker-manifest-digest": args?.digest ?? DIGEST },
      type: args?.type ?? "cosign container image signature",
    },
    optional: { creator: "test" },
  });
}

function signPayload(payloadJson: string, privPem: string): string {
  const { createPrivateKey } = require("node:crypto");
  const key = createPrivateKey({ key: privPem, format: "pem" });
  const algorithm = key.asymmetricKeyType === "ed25519" ? null : "sha256";
  return cryptoSign(algorithm, Buffer.from(payloadJson, "utf8"), key).toString("base64");
}

describe("verifyImageSignature", () => {
  test.each<KeyKind>(["ecdsa", "ed25519"])(
    "accepts a well-formed %s signature over a payload that matches the claimed digest",
    (kind) => {
      const { pubPem, privPem } = freshKeypair(kind);
      const payload = makePayload();
      const signature = signPayload(payload, privPem);

      const result = verifyImageSignature({
        imageDigest: DIGEST,
        payloadJson: payload,
        signatureB64: signature,
        expectedReferencePrefix: "ghcr.io/uncorded/runtime",
        pubkeyPemOverride: pubPem,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.digest).toBe(DIGEST);
        expect(result.reference).toBe(REFERENCE);
      }
    },
  );

  test("fails closed when the embedded pubkey is empty (pre-first-release seed state)", () => {
    const { privPem } = freshKeypair();
    const payload = makePayload();
    const signature = signPayload(payload, privPem);

    const result = verifyImageSignature({
      imageDigest: DIGEST,
      payloadJson: payload,
      signatureB64: signature,
      expectedReferencePrefix: REFERENCE,
      pubkeyPemOverride: "",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("pubkey-not-embedded");
  });

  test("rejects pubkey that is not a valid PEM", () => {
    const { privPem } = freshKeypair();
    const payload = makePayload();
    const signature = signPayload(payload, privPem);

    const result = verifyImageSignature({
      imageDigest: DIGEST,
      payloadJson: payload,
      signatureB64: signature,
      expectedReferencePrefix: REFERENCE,
      pubkeyPemOverride: "not-a-pem",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("pubkey-invalid");
  });

  test("rejects payload that isn't valid JSON", () => {
    const { pubPem } = freshKeypair();
    const result = verifyImageSignature({
      imageDigest: DIGEST,
      payloadJson: "{not json",
      signatureB64: "AAAA",
      expectedReferencePrefix: REFERENCE,
      pubkeyPemOverride: pubPem,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("payload-invalid-json");
  });

  test("rejects payload missing the critical.type assertion", () => {
    const { pubPem, privPem } = freshKeypair();
    const payload = makePayload({ type: "some other type" });
    const signature = signPayload(payload, privPem);

    const result = verifyImageSignature({
      imageDigest: DIGEST,
      payloadJson: payload,
      signatureB64: signature,
      expectedReferencePrefix: REFERENCE,
      pubkeyPemOverride: pubPem,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("payload-wrong-type");
  });

  test("rejects when payload digest does not match orchestrator-claimed digest", () => {
    const { pubPem, privPem } = freshKeypair();
    const payload = makePayload({
      digest: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
    });
    const signature = signPayload(payload, privPem);

    const result = verifyImageSignature({
      imageDigest: DIGEST,
      payloadJson: payload,
      signatureB64: signature,
      expectedReferencePrefix: REFERENCE,
      pubkeyPemOverride: pubPem,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("digest-mismatch");
  });

  test("rejects signed-image-from-different-product (docker-reference doesn't match)", () => {
    const { pubPem, privPem } = freshKeypair();
    const payload = makePayload({ reference: "ghcr.io/some-other/project" });
    const signature = signPayload(payload, privPem);

    const result = verifyImageSignature({
      imageDigest: DIGEST,
      payloadJson: payload,
      signatureB64: signature,
      expectedReferencePrefix: "ghcr.io/uncorded/runtime",
      pubkeyPemOverride: pubPem,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("reference-mismatch");
  });

  test("rejects signature signed by a different key", () => {
    const verifierKey = freshKeypair();
    const attackerKey = freshKeypair();
    const payload = makePayload();
    // Attacker signs with their own key but tries to pass it off against our pubkey.
    const signature = signPayload(payload, attackerKey.privPem);

    const result = verifyImageSignature({
      imageDigest: DIGEST,
      payloadJson: payload,
      signatureB64: signature,
      expectedReferencePrefix: REFERENCE,
      pubkeyPemOverride: verifierKey.pubPem,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("signature-invalid");
  });

  test("rejects signature over a tampered payload (same key, different content)", () => {
    const { pubPem, privPem } = freshKeypair();
    const honestPayload = makePayload();
    const signature = signPayload(honestPayload, privPem);

    // The wire payload has been swapped after signing.
    const tamperedPayload = makePayload({
      digest: "sha256:3333333333333333333333333333333333333333333333333333333333333333",
    });

    const result = verifyImageSignature({
      // imageDigest matches the tampered payload — first guard passes — but
      // the signature won't verify against the tampered bytes.
      imageDigest: "sha256:3333333333333333333333333333333333333333333333333333333333333333",
      payloadJson: tamperedPayload,
      signatureB64: signature,
      expectedReferencePrefix: REFERENCE,
      pubkeyPemOverride: pubPem,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("signature-invalid");
  });

  test("rejects empty signature", () => {
    const { pubPem } = freshKeypair();
    const result = verifyImageSignature({
      imageDigest: DIGEST,
      payloadJson: makePayload(),
      signatureB64: "",
      expectedReferencePrefix: REFERENCE,
      pubkeyPemOverride: pubPem,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("signature-not-base64");
  });
});
