import { afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const osSecrets = new Map<string, string>();
let packaged = false;
let userDataDir = "";
let keyringAvailable = true;

class MockEntry {
  private service: string;
  private name: string;

  constructor(service: string, name: string) {
    if (!keyringAvailable) {
      throw new Error("keyring unavailable");
    }
    this.service = service;
    this.name = name;
  }

  getPassword(): string | null {
    return osSecrets.get(`${this.service}:${this.name}`) ?? null;
  }

  setPassword(password: string): void {
    osSecrets.set(`${this.service}:${this.name}`, password);
  }

  deletePassword(): void {
    osSecrets.delete(`${this.service}:${this.name}`);
  }
}

let secretStoreModule: typeof import("./secret-store");
let scratchRoot = "";

beforeAll(async () => {
  await mock.module("./electron-main-deps", () => ({
    app: {
      get isPackaged() {
        return packaged;
      },
      getPath(name: string) {
        if (name !== "userData") throw new Error(`unexpected path ${name}`);
        return userDataDir;
      },
    },
    safeStorage: {
      encryptString(value: string) {
        return Buffer.from(`enc:${value}`, "utf8");
      },
      decryptString(buf: Buffer) {
        const decoded = buf.toString("utf8");
        if (!decoded.startsWith("enc:")) throw new Error("invalid blob");
        return decoded.slice(4);
      },
    },
  }));

  await mock.module("@napi-rs/keyring", () => ({
    Entry: MockEntry,
  }));

  secretStoreModule = await import("./secret-store");
});

beforeEach(() => {
  packaged = false;
  keyringAvailable = true;
  osSecrets.clear();
  scratchRoot = mkdtempSync(path.join(tmpdir(), "uncorded-secret-store-"));
  userDataDir = scratchRoot;
});

afterEach(() => {
  rmSync(scratchRoot, { recursive: true, force: true });
});

describe("secret store backend selection", () => {
  it("uses the OS keyring in packaged builds", () => {
    packaged = true;

    const status = secretStoreModule.getSecretStoreStatus();

    expect(status.backend).toBe("os-keyring");
    expect(status.durableAcrossReinstall).toBe(true);
  });

  it("falls back to the local safeStorage file in dev when keyring is unavailable", () => {
    keyringAvailable = false;

    const status = secretStoreModule.getSecretStoreStatus();

    expect(status.backend).toBe("file-safe-storage");
    expect(status.durableAcrossReinstall).toBe(false);
  });

  it("fails closed in packaged builds when no OS keyring is available", () => {
    packaged = true;
    keyringAvailable = false;

    expect(() => secretStoreModule.setSecret("central.session", "token")).toThrow(
      "Packaged desktop builds require an OS-backed secret store",
    );
  });
});

describe("secret migrations", () => {
  it("migrates legacy file-backed secrets into the OS keyring and removes the file", () => {
    packaged = true;
    const legacyPath = path.join(userDataDir, "keychain.json");
    writeFileSync(
      legacyPath,
      JSON.stringify({
        "central.session": Buffer.from("enc:session-token", "utf8").toString("base64"),
        "tunnel:srv_123": Buffer.from("enc:tunnel-token", "utf8").toString("base64"),
      }),
      "utf8",
    );

    secretStoreModule.migrateSecrets();

    expect(secretStoreModule.getSecret("central.session")).toBe("session-token");
    expect(secretStoreModule.getSecret("tunnel:srv_123")).toBe("tunnel-token");
    expect(existsSync(legacyPath)).toBe(false);
  });

  it("migrates legacy tunnel.json files into the current store", () => {
    packaged = true;
    const homeDir = path.join(scratchRoot, "home");
    const volumePath = path.join(homeDir, ".uncorded", "servers", "alpha");
    mkdirSync(path.join(volumePath, "config"), { recursive: true });
    writeFileSync(
      path.join(homeDir, ".uncorded", "registry.json"),
      JSON.stringify({
        "srv_abc": { volumePath },
      }),
      "utf8",
    );
    writeFileSync(
      path.join(volumePath, "config", "tunnel.json"),
      JSON.stringify({ tunnel_token: "legacy-token" }),
      "utf8",
    );

    const originalHome = process.env["HOME"];
    const originalUserProfile = process.env["USERPROFILE"];
    process.env["HOME"] = homeDir;
    process.env["USERPROFILE"] = homeDir;
    try {
      secretStoreModule.migrateSecrets();
    } finally {
      if (originalHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = originalHome;
      if (originalUserProfile === undefined) delete process.env["USERPROFILE"];
      else process.env["USERPROFILE"] = originalUserProfile;
    }

    expect(secretStoreModule.getSecret("tunnel:srv_abc")).toBe("legacy-token");
    expect(existsSync(path.join(volumePath, "config", "tunnel.json"))).toBe(false);
  });
});
