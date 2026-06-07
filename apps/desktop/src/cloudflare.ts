import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { app } from "./electron-main-deps";
import { deleteSecret, getSecret, setSecret } from "./desktop-secrets";

const CERT_SECRET_KEY = "cloudflare.cert";
const ACCOUNT_TAG_SECRET_KEY = "cloudflare.account.tag";

export interface CloudflareConnectionState {
  connected: boolean;
  accountTag?: string;
}

export class CloudflareNotConnectedError extends Error {
  constructor(message = "Cloudflare is not connected on this desktop") {
    super(message);
    this.name = "CloudflareNotConnectedError";
  }
}

function cloudflareUserDataDir(): string {
  return path.join(app.getPath("userData"), "cloudflare");
}

export function getCloudflareConnectionState(): CloudflareConnectionState {
  const cert = getSecret(CERT_SECRET_KEY);
  if (!cert) return { connected: false };
  const accountTag = getSecret(ACCOUNT_TAG_SECRET_KEY) ?? undefined;
  return accountTag ? { connected: true, accountTag } : { connected: true };
}

export function storeCloudflareCertificate(certPem: string, accountTag?: string): void {
  setSecret(CERT_SECRET_KEY, certPem);
  if (typeof accountTag === "string" && accountTag.trim().length > 0) {
    setSecret(ACCOUNT_TAG_SECRET_KEY, accountTag.trim());
  } else {
    deleteSecret(ACCOUNT_TAG_SECRET_KEY);
  }
}

export function getStoredCloudflareCertificate(): string | null {
  return getSecret(CERT_SECRET_KEY);
}

export async function importCloudflareCertificateFromPath(
  certPath: string,
  accountTag?: string,
): Promise<void> {
  const certPem = await readFile(certPath, "utf8");
  storeCloudflareCertificate(certPem, accountTag);
}

export function signOutCloudflare(): void {
  deleteSecret(CERT_SECRET_KEY);
  deleteSecret(ACCOUNT_TAG_SECRET_KEY);
}

/**
 * Materialize the stored Cloudflare origin certificate for one management
 * command, then remove it immediately after the callback finishes.
 */
export async function withCloudflareOrigincert<T>(
  callback: (certPath: string) => Promise<T>,
): Promise<T> {
  const certPem = getSecret(CERT_SECRET_KEY);
  if (!certPem) {
    throw new CloudflareNotConnectedError();
  }

  const baseDir = existsSync(cloudflareUserDataDir())
    ? cloudflareUserDataDir()
    : tmpdir();
  await mkdir(baseDir, { recursive: true });
  const tempDir = await mkdtemp(path.join(baseDir, "cf-cert-"));
  const certPath = path.join(tempDir, "cert.pem");
  await writeFile(certPath, certPem, "utf8");

  try {
    return await callback(certPath);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

