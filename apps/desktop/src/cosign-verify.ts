// Orchestrator-side cosign verification for the runtime image (Phase 01 §10, O4).
//
// The desktop is the **primary** verifier per spec-runtime-lifecycle.md §2.2:
// before tagging a freshly-pulled image as `:latest` and recreating the
// container, we shell out to `cosign verify` against the pubkey embedded in
// runtime/src/signing/cosign-pubkey.ts. If verification fails we never tag
// the image and never start the container — failure here surfaces in the
// update UX as "image rejected", not as a runtime crash loop.
//
// We then extract the signature material (manifest digest, the cosign
// "simple-signing" JSON payload, and the base64 signature bytes) and pass
// them to the runtime container as RUNTIME_IMAGE_DIGEST / _PAYLOAD /
// _SIGNATURE envs so the runtime can re-verify at boot. That second check
// is defense-in-depth against a compromised orchestrator that swapped in
// a malicious image without re-running cosign verify.
//
// Cosign binary resolution: packaged builds load a per-platform cosign from
// process.resourcesPath/cosign/<target>/ (downloaded by CI before
// electron-builder runs — see scripts/download-cosign.cjs). Dev mode prefers
// a repo-local resources/cosign/<target>/ when present, otherwise falls back
// to whatever `cosign` is on PATH. See cosign-bin.ts for the full resolver.

import { execFile } from "child_process";
import type { ExecFileOptions } from "child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { CosignBinaryNotFoundError, getBundledCosignBinary } from "./cosign-bin";

const DEFAULT_TIMEOUT_MS = 30_000;
const EXEC_MAX_BUFFER = 8 * 1024 * 1024;

export type CosignErrorCode =
  | "binary_not_found"
  | "verify_failed"
  | "no_signature"
  | "signature_unavailable"
  | "digest_unavailable"
  | "subprocess_failed"
  | "timeout"
  | "pubkey_not_embedded";

export class CosignError extends Error {
  constructor(
    public readonly code: CosignErrorCode,
    public readonly command: string,
    public readonly stderr: string,
    public readonly exitCode: number | null = null,
  ) {
    super(stderr.length > 0 ? stderr : `${command} failed (${code})`);
    this.name = "CosignError";
  }
}

export interface CosignSignatureMaterial {
  /** sha256:<64hex> — manifest digest the signature was computed over. */
  digest: string;
  /** Cosign simple-signing JSON payload, raw UTF-8 bytes. */
  payloadJson: string;
  /** Base64-encoded Ed25519 signature over `payloadJson`. */
  signatureB64: string;
}

/**
 * Resolve the cosign binary. Packaged builds use the bundled artifact under
 * process.resourcesPath/cosign/<target>/. Dev prefers a repo-local copy if
 * one exists, otherwise falls back to PATH. See cosign-bin.ts.
 */
export function getCosignBinary(): string {
  return getBundledCosignBinary();
}

function execFileAsync(
  file: string,
  args: string[],
  options: ExecFileOptions,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout, stderr }));
        return;
      }
      resolve({
        stdout: typeof stdout === "string" ? stdout : stdout.toString("utf8"),
        stderr: typeof stderr === "string" ? stderr : stderr.toString("utf8"),
      });
    });
  });
}

async function runCosign(
  args: string[],
  options?: { timeoutMs?: number },
): Promise<{ stdout: string; stderr: string }> {
  let binary: string;
  try {
    binary = getCosignBinary();
  } catch (err) {
    if (err instanceof CosignBinaryNotFoundError) {
      throw new CosignError("binary_not_found", args.join(" "), err.message, null);
    }
    throw err;
  }
  const command = [binary, ...args].join(" ");
  try {
    return await execFileAsync(binary, args, {
      timeout: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: EXEC_MAX_BUFFER,
      encoding: "utf8",
    });
  } catch (err) {
    const error = err as NodeJS.ErrnoException & {
      code?: string;
      killed?: boolean;
      signal?: NodeJS.Signals | null;
      stderr?: string;
      stdout?: string;
    };
    if (error.code === "ENOENT") {
      throw new CosignError("binary_not_found", command, error.message ?? "cosign not found", null);
    }
    if (error.killed || error.signal === "SIGTERM") {
      throw new CosignError("timeout", command, `${command} timed out`, null);
    }
    const stderr = typeof error.stderr === "string" ? error.stderr.trim() : "";
    throw new CosignError(
      "subprocess_failed",
      command,
      stderr.length > 0 ? stderr : error.message ?? `${command} failed`,
      typeof error.code === "number" ? error.code : null,
    );
  }
}

/**
 * Materialize the PEM to a temp file (cosign --key requires a file path),
 * run the callback with that path, then unlink. Used by verifyImage().
 */
async function withPubkeyFile<T>(
  pubkeyPem: string,
  callback: (keyPath: string) => Promise<T>,
): Promise<T> {
  if (pubkeyPem.trim().length === 0) {
    throw new CosignError(
      "pubkey_not_embedded",
      "withPubkeyFile",
      "Cosign pubkey is empty — cannot verify signatures (pre-first-release seed state).",
      null,
    );
  }
  const dir = await mkdtemp(path.join(tmpdir(), "uncorded-cosign-"));
  const keyPath = path.join(dir, "cosign.pub");
  try {
    await writeFile(keyPath, pubkeyPem, { encoding: "utf8", mode: 0o600 });
    return await callback(keyPath);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export interface VerifyImageArgs {
  /** Fully-qualified image reference (e.g. ghcr.io/uncorded/runtime:0.1.0 or @sha256:...). */
  imageRef: string;
  /** PEM-encoded cosign public key. Empty PEM throws pubkey_not_embedded. */
  pubkeyPem: string;
}

/**
 * Run `cosign verify --key <tmpfile> <imageRef>`. Throws CosignError on any
 * failure; resolves with the parsed verify-output array on success. Each
 * entry is one valid signature attached to the image — for our pipeline
 * we only sign once per image, so the array is length-1 in the happy path.
 */
export async function verifyImage(args: VerifyImageArgs): Promise<unknown[]> {
  return withPubkeyFile(args.pubkeyPem, async (keyPath) => {
    let result: { stdout: string; stderr: string };
    try {
      result = await runCosign(["verify", "--key", keyPath, "--output", "json", args.imageRef]);
    } catch (err) {
      if (err instanceof CosignError && err.code === "subprocess_failed") {
        const stderrLower = err.stderr.toLowerCase();
        if (
          stderrLower.includes("no signatures found") ||
          stderrLower.includes("no matching signatures")
        ) {
          throw new CosignError("no_signature", err.command, err.stderr, err.exitCode);
        }
        // cosign verify exits non-zero when the signature is structurally
        // present but cryptographically invalid — relabel as verify_failed.
        throw new CosignError("verify_failed", err.command, err.stderr, err.exitCode);
      }
      throw err;
    }
    try {
      const parsed = JSON.parse(result.stdout) as unknown;
      if (!Array.isArray(parsed)) {
        throw new CosignError(
          "verify_failed",
          `cosign verify ${args.imageRef}`,
          `Expected JSON array from cosign verify, got: ${result.stdout.slice(0, 200)}`,
          null,
        );
      }
      return parsed;
    } catch (err) {
      if (err instanceof CosignError) throw err;
      throw new CosignError(
        "verify_failed",
        `cosign verify ${args.imageRef}`,
        `cosign verify produced invalid JSON: ${(err as Error).message}`,
        null,
      );
    }
  });
}

/** Per-signature row from `cosign download signature`. cosign emits one JSON
 *  document per line (NDJSON), so callers must parse line-by-line. */
interface CosignDownloadedSignature {
  Base64Signature?: string;
  Payload?: string;
  Cert?: string | null;
  Chain?: string | null;
}

/**
 * Run `cosign download signature <imageRef>` and return the first signature
 * whose decoded payload claims the same `docker-manifest-digest` we computed
 * from `docker inspect`. Throws no_signature if there are no signatures and
 * signature_unavailable if no signature matches the expected digest (e.g.
 * the registry has stale signatures from a previous version).
 */
export async function getSignatureMaterial(args: {
  imageRef: string;
  expectedDigest: string;
}): Promise<CosignSignatureMaterial> {
  let result: { stdout: string; stderr: string };
  try {
    result = await runCosign(["download", "signature", args.imageRef]);
  } catch (err) {
    if (err instanceof CosignError && err.code === "subprocess_failed") {
      const stderrLower = err.stderr.toLowerCase();
      if (
        stderrLower.includes("no signatures found") ||
        stderrLower.includes("not found") ||
        stderrLower.includes("manifest unknown")
      ) {
        throw new CosignError("no_signature", err.command, err.stderr, err.exitCode);
      }
      throw new CosignError("signature_unavailable", err.command, err.stderr, err.exitCode);
    }
    throw err;
  }

  const lines = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    throw new CosignError(
      "no_signature",
      `cosign download signature ${args.imageRef}`,
      "cosign download signature returned no rows",
      null,
    );
  }

  for (const line of lines) {
    let row: CosignDownloadedSignature;
    try {
      row = JSON.parse(line) as CosignDownloadedSignature;
    } catch {
      // Skip malformed rows — cosign occasionally interleaves status text on
      // stdout. We only fail hard if no row parses to a valid match.
      continue;
    }
    if (typeof row.Base64Signature !== "string" || typeof row.Payload !== "string") {
      continue;
    }
    let payloadJson: string;
    try {
      payloadJson = Buffer.from(row.Payload, "base64").toString("utf8");
    } catch {
      continue;
    }
    let parsedPayload: { critical?: { image?: { "docker-manifest-digest"?: string } } };
    try {
      parsedPayload = JSON.parse(payloadJson) as typeof parsedPayload;
    } catch {
      continue;
    }
    const payloadDigest = parsedPayload.critical?.image?.["docker-manifest-digest"];
    if (payloadDigest === args.expectedDigest) {
      return {
        digest: args.expectedDigest,
        payloadJson,
        signatureB64: row.Base64Signature,
      };
    }
  }

  throw new CosignError(
    "signature_unavailable",
    `cosign download signature ${args.imageRef}`,
    `No signature matched expected digest ${args.expectedDigest}`,
    null,
  );
}

/**
 * Resolve the image's manifest digest via `docker inspect`. We read
 * RepoDigests[0] and split off the `<repo>@` prefix to recover the bare
 * sha256:<hex>. Required because cosign verify and the runtime both want
 * a canonical, immutable reference rather than the floating tag.
 */
export async function getImageDigest(imageRef: string): Promise<string> {
  let result: { stdout: string; stderr: string };
  try {
    result = await execFileAsync(
      process.platform === "win32" ? "docker.exe" : "docker",
      ["image", "inspect", "--format", "{{json .RepoDigests}}", imageRef],
      { timeout: 15_000, maxBuffer: 1 * 1024 * 1024, encoding: "utf8" },
    );
  } catch (err) {
    const error = err as NodeJS.ErrnoException & { stderr?: string };
    throw new CosignError(
      "digest_unavailable",
      `docker image inspect ${imageRef}`,
      typeof error.stderr === "string" ? error.stderr : (error.message ?? "docker inspect failed"),
      null,
    );
  }

  let repoDigests: unknown;
  try {
    repoDigests = JSON.parse(result.stdout.trim());
  } catch {
    throw new CosignError(
      "digest_unavailable",
      `docker image inspect ${imageRef}`,
      `docker inspect returned invalid JSON: ${result.stdout.slice(0, 200)}`,
      null,
    );
  }

  if (!Array.isArray(repoDigests) || repoDigests.length === 0) {
    throw new CosignError(
      "digest_unavailable",
      `docker image inspect ${imageRef}`,
      `Image ${imageRef} has no RepoDigests — was it pulled from a registry?`,
      null,
    );
  }

  for (const entry of repoDigests) {
    if (typeof entry !== "string") continue;
    const at = entry.lastIndexOf("@");
    if (at === -1) continue;
    const digest = entry.slice(at + 1);
    if (/^sha256:[0-9a-f]{64}$/i.test(digest)) {
      return digest;
    }
  }

  throw new CosignError(
    "digest_unavailable",
    `docker image inspect ${imageRef}`,
    `Image ${imageRef} RepoDigests contained no sha256:<hex> entry`,
    null,
  );
}

export interface VerifyAndExtractArgs {
  /** Image reference to verify. The :tag form is fine — cosign resolves it. */
  imageRef: string;
  /** PEM-encoded cosign public key (from runtime/src/signing/cosign-pubkey.ts). */
  pubkeyPem: string;
}

/**
 * Convenience wrapper: verify the image's signature, then resolve the
 * manifest digest and pull down the signature payload + bytes for handoff
 * to the runtime container as ENV vars.
 *
 * Order matters: verify FIRST so we never extract material from an image
 * that failed cryptographic checks. Only then do we fetch the digest +
 * signature bytes for the defense-in-depth handoff.
 */
export async function verifyAndExtractMaterial(
  args: VerifyAndExtractArgs,
): Promise<CosignSignatureMaterial> {
  await verifyImage({ imageRef: args.imageRef, pubkeyPem: args.pubkeyPem });
  const digest = await getImageDigest(args.imageRef);
  return getSignatureMaterial({ imageRef: args.imageRef, expectedDigest: digest });
}
