import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import * as _realNodeFs from "node:fs";
import path from "node:path";

// Snapshot real fs exports by value — `import * as` is a live binding, so
// reading from it after the mock applies returns the stubbed shape.
const realNodeFs = { ..._realNodeFs };

const mockExistsSync = mock((_: string) => false);

let packaged = false;
let appPath = "";
let cosignBinModule: typeof import("./cosign-bin");
const originalResourcesPath = process.resourcesPath;

function expectedBinaryPath(root: string): string {
  const fileName = process.platform === "win32" ? "cosign.exe" : "cosign";
  return path.join(root, "cosign", `${process.platform}-${process.arch}`, fileName);
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
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: (s: string) => Buffer.from(s, "utf8"),
      decryptString: (b: Buffer) => b.toString("utf8"),
    },
  }));

  cosignBinModule = await import("./cosign-bin");
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

describe("getBundledCosignBinary", () => {
  it("returns the packaged bundled binary path", () => {
    packaged = true;
    const expected = expectedBinaryPath(process.resourcesPath);
    mockExistsSync.mockImplementation((candidate) => candidate === expected);

    expect(cosignBinModule.getBundledCosignBinary()).toBe(expected);
  });

  it("throws CosignBinaryNotFoundError when packaged but binary missing", () => {
    packaged = true;
    mockExistsSync.mockReturnValue(false);

    expect(() => cosignBinModule.getBundledCosignBinary()).toThrow(
      cosignBinModule.CosignBinaryNotFoundError,
    );
  });

  it("prefers a repo-local bundled binary in dev", () => {
    const expected = expectedBinaryPath(path.join(appPath, "resources"));
    mockExistsSync.mockImplementation((candidate) => candidate === expected);

    expect(cosignBinModule.getBundledCosignBinary()).toBe(expected);
  });

  it("falls back to PATH in dev when no bundled binary exists", () => {
    const expected = process.platform === "win32" ? "cosign.exe" : "cosign";
    expect(cosignBinModule.getBundledCosignBinary()).toBe(expected);
  });
});
