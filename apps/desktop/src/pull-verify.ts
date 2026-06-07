// Pull a runtime image from its registry and (unless suppressed for the
// pre-first-release seed period) cosign-verify the bytes against the
// embedded public key. Used by:
//
//   - runtime-update.ts during the auto-update download phase
//   - provision.ts during first-boot server creation
//
// SECURITY INVARIANT
// ------------------
// Callers MUST NOT promote the pulled bytes (via `docker tag <sourceImage>
// <localTag>`) until pullAndVerify resolves successfully. Promoting before
// verify-success would let unverified bytes become the next `docker run`
// target, defeating the cosign chain entirely. Each call site enforces
// this by sequencing the tag call after the pullAndVerify await.
//
// ERROR MODEL
// -----------
// Pull failures throw {@link PullPhaseError}. Verify failures throw the
// underlying CosignError (typed `.code` field — see cosign-verify.ts).
// Callers discriminate via `instanceof PullPhaseError` to render the right
// operator copy ("Image pull failed: …" vs "Signature verification failed: …").

import type { CosignSignatureMaterial } from "./cosign-verify";

export interface PullAndVerifyArgs {
  /** Fully-qualified registry ref, e.g. ghcr.io/uncorded/runtime:0.1.0-dev.1 */
  sourceImage: string;
  /** When true, pull but skip cosign verification. Set by the caller when
   *  the embedded pubkey is empty (pre-first-release seed state — see
   *  runtime/src/signing/cosign-pubkey.ts). The returned `signature` is
   *  undefined in that mode and the caller must NOT forward
   *  RUNTIME_IMAGE_DIGEST/_PAYLOAD/_SIGNATURE envs to the container. */
  skipVerify?: boolean;
  /** Per-line `docker pull` stdout/stderr. Caller buckets / parses /
   *  surfaces in UI as it sees fit. */
  onPullProgress?: (line: string) => void;
}

export interface PullAndVerifyDeps {
  pullImage: (image: string, onProgress: (line: string) => void) => Promise<void>;
  verifyAndExtract: (image: string) => Promise<CosignSignatureMaterial>;
  /** Hook fired once the pull resolves and before verify starts.
   *  runtime-update uses it to POST `state: "downloaded"` to the runtime
   *  so the operator pill flips before the (~1-2s) cosign step runs.
   *  provision uses it to advance the wizard log from "Downloading" to
   *  "Verifying signature". */
  onPullComplete?: () => void | Promise<void>;
  log?: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

export interface PullAndVerifyResult {
  /** sha256:<hex> when verified, empty string when skipVerify. */
  digest: string;
  /** Forward to runServerContainer's RUNTIME_IMAGE_* envs for boot-time
   *  re-verification (defense-in-depth, §10). undefined when skipVerify. */
  signature: CosignSignatureMaterial | undefined;
}

/** Discriminator for callers that need to distinguish pull-phase failures
 *  from verify-phase failures (different operator copy, different metric
 *  bucket). Verify failures bubble up as the underlying CosignError. */
export class PullPhaseError extends Error {
  override readonly name = "PullPhaseError";
  constructor(
    message: string,
    public override readonly cause: unknown,
  ) {
    super(message);
  }
}

export async function pullAndVerify(
  args: PullAndVerifyArgs,
  deps: PullAndVerifyDeps,
): Promise<PullAndVerifyResult> {
  const onProgress = args.onPullProgress ?? noop;

  try {
    await deps.pullImage(args.sourceImage, onProgress);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new PullPhaseError(reason, err);
  }

  if (deps.onPullComplete) {
    await deps.onPullComplete();
  }

  if (args.skipVerify === true) {
    deps.log?.warn("cosign verification skipped (no embedded pubkey)", {
      image: args.sourceImage,
    });
    return { digest: "", signature: undefined };
  }

  const signature = await deps.verifyAndExtract(args.sourceImage);
  deps.log?.info("signature verified", {
    image: args.sourceImage,
    digest: signature.digest,
  });
  return { digest: signature.digest, signature };
}

function noop(_line: string): void {
  /* discard */
}
