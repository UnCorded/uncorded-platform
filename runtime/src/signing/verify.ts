// Cosign signature verification for the runtime image (Phase 01 §10).
//
// The orchestrator (desktop today, hosted control plane tomorrow per D3) is
// the primary verifier — it `cosign verify`s the image before tagging it
// `:latest` and recreating the container. This module is the in-runtime
// **defense in depth** that catches a compromised orchestrator that swapped
// in a malicious image without re-running cosign verify.
//
// The orchestrator passes three pieces of material as ENV vars at container
// start (per spec-runtime-lifecycle.md §2.2 step 1):
//
//   - RUNTIME_IMAGE_DIGEST     sha256:<64hex> of the running image's manifest
//   - RUNTIME_IMAGE_PAYLOAD    cosign "simple signing" JSON payload, raw
//   - RUNTIME_IMAGE_SIGNATURE  base64 signature over the payload (algorithm
//                              determined by the embedded pubkey type)
//
// Verification:
//   1. Parse payload; assert `critical.type === "cosign container image signature"`.
//   2. Assert payload's `critical.image.docker-manifest-digest` equals the
//      orchestrator-supplied RUNTIME_IMAGE_DIGEST (catches mismatched payload).
//   3. Assert `critical.identity.docker-reference` starts with the expected
//      registry path (catches signed-image-from-different-product attacks).
//   4. crypto.verify the signature against the payload using the embedded
//      public key. The key type drives the algorithm: cosign's default
//      keypair is ECDSA P-256 (verify with sha256); `--key-type=ed25519`
//      keys verify with algorithm null (Ed25519's signature scheme is
//      implicit in the key type, OpenSSL refuses any digest argument).
//
// On any failure: caller exits 40 (per §6 exit-code table). The orchestrator
// detects this, restores `:previous`, and writes `state: error / install`
// per spec-runtime-lifecycle.md §9.

import { createPublicKey, verify as cryptoVerify, type KeyObject } from "node:crypto";

import { COSIGN_PUBKEY_PEM, isCosignPubkeyEmbedded } from "./cosign-pubkey";

export type VerifyFailureReason =
  | "pubkey-not-embedded"
  | "pubkey-invalid"
  | "payload-invalid-json"
  | "payload-wrong-shape"
  | "payload-wrong-type"
  | "digest-mismatch"
  | "reference-mismatch"
  | "signature-not-base64"
  | "signature-invalid";

export type VerifyResult =
  | { ok: true; digest: string; reference: string }
  | { ok: false; reason: VerifyFailureReason; detail?: string };

interface SimpleSigningPayload {
  critical: {
    identity: { "docker-reference": string };
    image: { "docker-manifest-digest": string };
    type: string;
  };
  optional?: Record<string, unknown>;
}

function parsePayload(json: string): SimpleSigningPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const root = parsed as Record<string, unknown>;
  const critical = root["critical"];
  if (!critical || typeof critical !== "object") return null;
  const c = critical as Record<string, unknown>;
  const identity = c["identity"];
  const image = c["image"];
  if (
    !identity ||
    typeof identity !== "object" ||
    !image ||
    typeof image !== "object" ||
    typeof c["type"] !== "string"
  ) {
    return null;
  }
  const id = identity as Record<string, unknown>;
  const im = image as Record<string, unknown>;
  if (
    typeof id["docker-reference"] !== "string" ||
    typeof im["docker-manifest-digest"] !== "string"
  ) {
    return null;
  }
  return {
    critical: {
      identity: { "docker-reference": id["docker-reference"] },
      image: { "docker-manifest-digest": im["docker-manifest-digest"] },
      type: c["type"],
    },
  };
}

export interface VerifyImageSignatureArgs {
  /** sha256:<64hex> — the digest the orchestrator claims this container is running. */
  imageDigest: string;
  /** Cosign simple-signing JSON payload — the bytes the signature was computed over. */
  payloadJson: string;
  /** Base64-encoded signature (algorithm matches the embedded pubkey type). */
  signatureB64: string;
  /** Expected registry+repo prefix; payload's docker-reference must start with this. */
  expectedReferencePrefix: string;
  /** Override the embedded pubkey (test-only). Production passes undefined. */
  pubkeyPemOverride?: string;
}

export function verifyImageSignature(args: VerifyImageSignatureArgs): VerifyResult {
  const pubkeyPem = args.pubkeyPemOverride ?? COSIGN_PUBKEY_PEM;
  if (pubkeyPem.trim().length === 0) {
    return { ok: false, reason: "pubkey-not-embedded" };
  }

  let pubkey: KeyObject;
  try {
    pubkey = createPublicKey({ key: pubkeyPem, format: "pem" });
  } catch (err) {
    return {
      ok: false,
      reason: "pubkey-invalid",
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  const payload = parsePayload(args.payloadJson);
  if (!payload) {
    return { ok: false, reason: "payload-invalid-json" };
  }
  if (payload.critical.type !== "cosign container image signature") {
    return {
      ok: false,
      reason: "payload-wrong-type",
      detail: payload.critical.type,
    };
  }

  const payloadDigest = payload.critical.image["docker-manifest-digest"];
  if (payloadDigest !== args.imageDigest) {
    return {
      ok: false,
      reason: "digest-mismatch",
      detail: `payload=${payloadDigest} env=${args.imageDigest}`,
    };
  }

  const reference = payload.critical.identity["docker-reference"];
  if (!reference.startsWith(args.expectedReferencePrefix)) {
    return {
      ok: false,
      reason: "reference-mismatch",
      detail: `payload=${reference} expected=${args.expectedReferencePrefix}*`,
    };
  }

  let sigBytes: Buffer;
  try {
    sigBytes = Buffer.from(args.signatureB64, "base64");
    if (sigBytes.length === 0) {
      return { ok: false, reason: "signature-not-base64" };
    }
  } catch {
    return { ok: false, reason: "signature-not-base64" };
  }

  // Algorithm depends on key type. Ed25519 requires null (the signature
  // scheme is implicit in the key type — OpenSSL throws NO_DEFAULT_DIGEST
  // if you try to pass a digest). ECDSA / RSA require an explicit digest;
  // cosign uses SHA-256 by default for both, which is what we get.
  const algorithm = pubkey.asymmetricKeyType === "ed25519" ? null : "sha256";
  const ok = cryptoVerify(
    algorithm,
    Buffer.from(args.payloadJson, "utf8"),
    pubkey,
    sigBytes,
  );
  if (!ok) {
    return { ok: false, reason: "signature-invalid" };
  }

  return { ok: true, digest: payloadDigest, reference };
}

export { isCosignPubkeyEmbedded };
