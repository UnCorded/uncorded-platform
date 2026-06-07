import { afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const secrets = new Map<string, string>();
const mockGetSecret = mock((key: string) => secrets.get(key) ?? null);
const mockSetSecret = mock((key: string, value: string) => {
  secrets.set(key, value);
});
const mockDeleteSecret = mock((key: string) => {
  secrets.delete(key);
});

let userDataDir = "";
let cloudflareModule: typeof import("./cloudflare");

beforeAll(async () => {
  await mock.module("./electron-main-deps", () => ({
    app: {
      getPath(name: string) {
        if (name !== "userData") throw new Error(`unexpected path ${name}`);
        return userDataDir;
      },
    },
    // Stubbed to keep the module namespace shape intact — secret-store.ts
    // imports `safeStorage` and the namespace is sealed by the first mock.
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: (s: string) => Buffer.from(s, "utf8"),
      decryptString: (b: Buffer) => b.toString("utf8"),
    },
  }));

  // tunnelSecretKey + encryptionSecretKey are included so this mock survives
  // leaking into sibling test files (Bun's mock.module persists across files
  // in the same worker). provision.ts statically imports both.
  await mock.module("./desktop-secrets", () => ({
    getSecret: mockGetSecret,
    setSecret: mockSetSecret,
    deleteSecret: mockDeleteSecret,
    tunnelSecretKey: (serverId: string) => `tunnel:${serverId}`,
    encryptionSecretKey: (serverId: string) => `encryption:${serverId}`,
  }));

  cloudflareModule = await import("./cloudflare");
});

beforeEach(() => {
  secrets.clear();
  mockGetSecret.mockClear();
  mockSetSecret.mockClear();
  mockDeleteSecret.mockClear();
  userDataDir = mkdtempSync(path.join(tmpdir(), "uncorded-cloudflare-"));
  mkdirSync(path.join(userDataDir, "cloudflare"), { recursive: true });
});

afterEach(() => {
  rmSync(userDataDir, { recursive: true, force: true });
});

describe("Cloudflare connection state", () => {
  it("reports disconnected when no cert is stored", () => {
    expect(cloudflareModule.getCloudflareConnectionState()).toEqual({ connected: false });
  });

  it("stores and clears the connected account state", () => {
    cloudflareModule.storeCloudflareCertificate("pem-contents", "acct_123");

    expect(cloudflareModule.getCloudflareConnectionState()).toEqual({
      connected: true,
      accountTag: "acct_123",
    });

    cloudflareModule.signOutCloudflare();

    expect(cloudflareModule.getCloudflareConnectionState()).toEqual({ connected: false });
  });
});

describe("Cloudflare cert materialization", () => {
  it("imports a cert from disk", async () => {
    const certPath = path.join(userDataDir, "import.pem");
    writeFileSync(certPath, "imported-cert", "utf8");

    await cloudflareModule.importCloudflareCertificateFromPath(certPath, "acct_imported");

    expect(cloudflareModule.getStoredCloudflareCertificate()).toBe("imported-cert");
    expect(cloudflareModule.getCloudflareConnectionState()).toEqual({
      connected: true,
      accountTag: "acct_imported",
    });
  });

  it("writes a temporary cert file for one command and removes it afterwards", async () => {
    cloudflareModule.storeCloudflareCertificate("temporary-cert");

    let certPath = "";
    let certContents = "";
    await cloudflareModule.withCloudflareOrigincert(async (candidate) => {
      certPath = candidate;
      certContents = readFileSync(candidate, "utf8");
      expect(existsSync(candidate)).toBe(true);
      return undefined;
    });

    expect(certContents).toBe("temporary-cert");
    expect(certPath).not.toBe("");
    expect(existsSync(certPath)).toBe(false);
    expect(existsSync(path.dirname(certPath))).toBe(false);
  });
});
