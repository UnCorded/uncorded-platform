// Shared plugin-package validation used by publish-plugin and publish-version.
// Enforces: declared Content-Length cap, zip magic bytes, real byte length cap
// (in case Content-Length lies), and computes SHA-256 for integrity lookup on
// download. Keeping these in one place means both publish routes reject
// the same shape of bad upload with the same error codes.

/** Max size of an uploaded plugin package. 10 MB covers every real plugin
 *  we've seen and keeps buffered uploads from evicting other Central work. */
export const MAX_PACKAGE_BYTES = 10 * 1024 * 1024;

/** Zip local-file-header magic: `PK\x03\x04`. Matches real zips and also
 *  matches empty zips (which the declared size check will reject anyway). */
const ZIP_MAGIC = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);

/** Allowed trust tiers. `publish-plugin` can accept this as a form field;
 *  falls back to the DB default `community` if omitted or unknown. */
export const TRUST_TIERS = ["official", "verified", "community"] as const;
export type TrustTier = (typeof TRUST_TIERS)[number];

export function isTrustTier(value: unknown): value is TrustTier {
  return typeof value === "string" && (TRUST_TIERS as readonly string[]).includes(value);
}

export interface PackageValidationFailure {
  ok: false;
  code: "PACKAGE_TOO_LARGE" | "PACKAGE_INVALID_FORMAT";
  message: string;
}

export interface PackageValidationSuccess {
  ok: true;
  buffer: Buffer;
  sizeBytes: number;
  sha256: string;
}

/** Validate an uploaded package Blob against the declared Content-Length
 *  (from the parent request), enforce the size cap on the real byte length,
 *  confirm the zip magic header, and return a buffered copy + SHA-256 for the
 *  caller to persist. Read the package exactly once. */
export async function validatePackageUpload(
  packageFile: Blob,
  declaredContentLength: string | null,
): Promise<PackageValidationSuccess | PackageValidationFailure> {
  // Early reject based on the request's Content-Length header before we
  // touch the body — catches honest clients and declared zip-bombs cheaply.
  if (declaredContentLength) {
    const parsed = Number.parseInt(declaredContentLength, 10);
    if (Number.isFinite(parsed) && parsed > MAX_PACKAGE_BYTES) {
      return {
        ok: false,
        code: "PACKAGE_TOO_LARGE",
        message: `Package must be ${String(MAX_PACKAGE_BYTES)} bytes or fewer`,
      };
    }
  }

  // Buffer the blob. `arrayBuffer()` reads the full body; we then enforce the
  // real cap against its length in case the declared Content-Length lied.
  const arrayBuffer = await packageFile.arrayBuffer();
  if (arrayBuffer.byteLength > MAX_PACKAGE_BYTES) {
    return {
      ok: false,
      code: "PACKAGE_TOO_LARGE",
      message: `Package must be ${String(MAX_PACKAGE_BYTES)} bytes or fewer`,
    };
  }

  if (arrayBuffer.byteLength < ZIP_MAGIC.length) {
    return {
      ok: false,
      code: "PACKAGE_INVALID_FORMAT",
      message: "Package is too short to be a valid zip archive",
    };
  }

  const header = new Uint8Array(arrayBuffer, 0, ZIP_MAGIC.length);
  for (let i = 0; i < ZIP_MAGIC.length; i++) {
    if (header[i] !== ZIP_MAGIC[i]) {
      return {
        ok: false,
        code: "PACKAGE_INVALID_FORMAT",
        message: "Package must be a zip archive",
      };
    }
  }

  const digest = await crypto.subtle.digest("SHA-256", arrayBuffer);
  const sha256 = Buffer.from(digest).toString("hex");

  return {
    ok: true,
    buffer: Buffer.from(arrayBuffer),
    sizeBytes: arrayBuffer.byteLength,
    sha256,
  };
}
