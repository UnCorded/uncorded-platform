// Resolve the cosign binary that ships inside the desktop installer.
//
// Mirrors cloudflared-bin.ts: packaged builds expect a bundled binary under
// process.resourcesPath/cosign/<target>/, dev prefers a repo-local
// resources/cosign/<target>/ when present and otherwise falls back to PATH.
//
// CI downloads the per-platform cosign release into apps/desktop/resources/
// before electron-builder runs (see scripts/download-cosign.cjs +
// .github/workflows/release.yml). electron-builder.yml maps that into the
// packaged app via `extraResources`.

import { existsSync } from "node:fs";
import path from "node:path";
import { app } from "./electron-main-deps";

export type CosignTarget =
  | "darwin-arm64"
  | "darwin-x64"
  | "linux-x64"
  | "win32-x64";

export class CosignBinaryNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CosignBinaryNotFoundError";
  }
}

function currentTarget(): CosignTarget {
  const key = `${process.platform}-${process.arch}`;
  switch (key) {
    case "darwin-arm64":
    case "darwin-x64":
    case "linux-x64":
    case "win32-x64":
      return key;
    default:
      throw new CosignBinaryNotFoundError(
        `Unsupported cosign target ${process.platform}-${process.arch}`,
      );
  }
}

function binaryFileName(): string {
  return process.platform === "win32" ? "cosign.exe" : "cosign";
}

function packagedBinaryPath(): string {
  return path.join(
    process.resourcesPath,
    "cosign",
    currentTarget(),
    binaryFileName(),
  );
}

function devBundledBinaryPath(): string {
  return path.join(
    app.getAppPath(),
    "resources",
    "cosign",
    currentTarget(),
    binaryFileName(),
  );
}

/**
 * Resolve the cosign executable used for runtime-image signature verification.
 *
 * Packaged builds require a bundled binary in process.resourcesPath. Dev mode
 * prefers a repo-local bundled binary when present and otherwise falls back to
 * whatever `cosign` is available on PATH.
 */
export function getBundledCosignBinary(): string {
  if (app.isPackaged) {
    const bundled = packagedBinaryPath();
    if (!existsSync(bundled)) {
      throw new CosignBinaryNotFoundError(
        `Bundled cosign binary not found at ${bundled}`,
      );
    }
    return bundled;
  }

  const bundledDev = devBundledBinaryPath();
  if (existsSync(bundledDev)) {
    return bundledDev;
  }

  return process.platform === "win32" ? "cosign.exe" : "cosign";
}
