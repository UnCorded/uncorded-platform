import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import * as _realNodeFs from "node:fs";
import path from "node:path";

// Snapshot real fs exports by value — `import * as` is a live binding, so
// reading from it after the mock applies returns the stubbed shape.
const realNodeFs = { ..._realNodeFs };

const mockExistsSync = mock((_: string) => false);

let packaged = false;
let appPath = "";
let cloudflaredBinModule: typeof import("./cloudflared-bin");
const originalResourcesPath = process.resourcesPath;

function expectedBinaryPath(root: string): string {
  const fileName = process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
  return path.join(root, "cloudflared", `${process.platform}-${process.arch}`, fileName);
}

beforeAll(async () => {
  await mock.module("node:fs", () => ({
    ...realNodeFs,
    existsSync: mockExistsSync,
  }));

  await mock.module("./electron-main-deps", () => ({
    app: {
      get isPackaged() {
        return packaged;
      },
      getAppPath() {
        return appPath;
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

  cloudflaredBinModule = await import("./cloudflared-bin");
});

beforeEach(() => {
  packaged = false;
  appPath = path.join("C:\\", "repo", "apps", "desktop");
  mockExistsSync.mockReset();
  mockExistsSync.mockReturnValue(false);
  Object.defineProperty(process, "resourcesPath", {
    configurable: true,
    value: path.join("C:\\", "Program Files", "UnCorded", "resources"),
  });
});

afterAll(async () => {
  Object.defineProperty(process, "resourcesPath", {
    configurable: true,
    value: originalResourcesPath,
  });
  await mock.module("node:fs", () => realNodeFs);
});

describe("getCloudflaredBinary", () => {
  it("returns the packaged bundled binary path", () => {
    packaged = true;
    const expected = expectedBinaryPath(process.resourcesPath);
    mockExistsSync.mockImplementation((candidate) => candidate === expected);

    expect(cloudflaredBinModule.getCloudflaredBinary()).toBe(expected);
  });

  it("prefers a repo-local bundled binary in dev", () => {
    const expected = expectedBinaryPath(path.join(appPath, "resources"));
    mockExistsSync.mockImplementation((candidate) => candidate === expected);

    expect(cloudflaredBinModule.getCloudflaredBinary()).toBe(expected);
  });

  it("falls back to PATH in dev when no bundled binary exists", () => {
    expect(cloudflaredBinModule.getCloudflaredBinary()).toBe("cloudflared");
  });
});
