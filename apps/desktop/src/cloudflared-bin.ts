import { existsSync } from "node:fs";
import path from "node:path";
import { app } from "./electron-main-deps";

export type CloudflaredTarget =
  | "darwin-arm64"
  | "darwin-x64"
  | "linux-x64"
  | "win32-x64";

export class CloudflaredBinaryNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloudflaredBinaryNotFoundError";
  }
}

function currentTarget(): CloudflaredTarget {
  const key = `${process.platform}-${process.arch}`;
  switch (key) {
    case "darwin-arm64":
    case "darwin-x64":
    case "linux-x64":
    case "win32-x64":
      return key;
    default:
      throw new CloudflaredBinaryNotFoundError(
        `Unsupported cloudflared target ${process.platform}-${process.arch}`,
      );
  }
}

function binaryFileName(): string {
  return process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
}

function packagedBinaryPath(): string {
  return path.join(
    process.resourcesPath,
    "cloudflared",
    currentTarget(),
    binaryFileName(),
  );
}

function devBundledBinaryPath(): string {
  return path.join(
    app.getAppPath(),
    "resources",
    "cloudflared",
    currentTarget(),
    binaryFileName(),
  );
}

/**
 * Resolve the host cloudflared executable.
 *
 * Packaged builds require a bundled binary in process.resourcesPath. Dev mode
 * prefers a repo-local bundled binary when present and otherwise falls back to
 * whatever `cloudflared` is available on PATH.
 */
export function getCloudflaredBinary(): string {
  if (app.isPackaged) {
    const bundled = packagedBinaryPath();
    if (!existsSync(bundled)) {
      throw new CloudflaredBinaryNotFoundError(
        `Bundled cloudflared binary not found at ${bundled}`,
      );
    }
    return bundled;
  }

  const bundledDev = devBundledBinaryPath();
  if (existsSync(bundledDev)) {
    return bundledDev;
  }

  return "cloudflared";
}

