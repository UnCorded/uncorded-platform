import { describe, test, expect } from "bun:test";
import { MAX_PACKAGE_BYTES, validatePackageUpload, isTrustTier } from "./plugin-package";

function zipHeader(extraBytes = 0): Blob {
  const header = [0x50, 0x4b, 0x03, 0x04];
  const body = [...header, ...new Array(extraBytes).fill(0)];
  return new Blob([new Uint8Array(body)], { type: "application/zip" });
}

describe("validatePackageUpload", () => {
  test("accepts a minimal zip and returns size + sha256", async () => {
    const blob = zipHeader(4);
    const result = await validatePackageUpload(blob, null);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sizeBytes).toBe(8);
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.buffer.length).toBe(8);
  });

  test("rejects short body too small to contain zip magic", async () => {
    const blob = new Blob([new Uint8Array([0x50, 0x4b])], { type: "application/zip" });
    const result = await validatePackageUpload(blob, null);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("PACKAGE_INVALID_FORMAT");
  });

  test("rejects non-zip magic bytes", async () => {
    const blob = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00])], {
      type: "application/zip",
    });
    const result = await validatePackageUpload(blob, null);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("PACKAGE_INVALID_FORMAT");
  });

  test("rejects declared Content-Length over the cap without reading body", async () => {
    // Use a short body; only the declared length matters for this path.
    const blob = zipHeader(4);
    const oversize = String(MAX_PACKAGE_BYTES + 1);
    const result = await validatePackageUpload(blob, oversize);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("PACKAGE_TOO_LARGE");
  });

  test("rejects real body over the cap when Content-Length is honest", async () => {
    const payload = new Uint8Array(MAX_PACKAGE_BYTES + 1);
    payload[0] = 0x50;
    payload[1] = 0x4b;
    payload[2] = 0x03;
    payload[3] = 0x04;
    const blob = new Blob([payload], { type: "application/zip" });
    const result = await validatePackageUpload(blob, String(payload.byteLength));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("PACKAGE_TOO_LARGE");
  });

  test("hashes identical bodies to the same SHA-256", async () => {
    const a = await validatePackageUpload(zipHeader(16), null);
    const b = await validatePackageUpload(zipHeader(16), null);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.sha256).toBe(b.sha256);
  });
});

describe("isTrustTier", () => {
  test.each(["official", "verified", "community"] as const)("accepts %s", (tier) => {
    expect(isTrustTier(tier)).toBe(true);
  });

  test.each([null, undefined, 42, "", "admin", "root"])("rejects %p", (value) => {
    expect(isTrustTier(value)).toBe(false);
  });
});
