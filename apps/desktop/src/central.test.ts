import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

const mockKeychainGet = mock<(key: string) => string | null>();
const mockKeychainSet = mock<(key: string, value: string) => void>();
const mockKeychainDelete = mock<(key: string) => void>();

let centralModule: typeof import("./central");
const originalFetch = globalThis.fetch;

beforeAll(async () => {
  await mock.module("electron", () => ({
    app: {
      isPackaged: false,
    },
  }));

  // tunnelSecretKey + encryptionSecretKey are included so this mock survives
  // leaking into sibling test files (Bun's mock.module persists across files
  // in the same worker). provision.ts statically imports both; without these
  // entries the next file in the worker fails to parse.
  await mock.module("./desktop-secrets", () => ({
    getSecret: mockKeychainGet,
    setSecret: mockKeychainSet,
    deleteSecret: mockKeychainDelete,
    tunnelSecretKey: (serverId: string) => `tunnel:${serverId}`,
    encryptionSecretKey: (serverId: string) => `encryption:${serverId}`,
  }));

  centralModule = await import("./central");
});

beforeEach(() => {
  mockKeychainGet.mockReset();
  mockKeychainSet.mockReset();
  mockKeychainDelete.mockReset();
  mockKeychainGet.mockReturnValue(null);
  process.env["VITE_CENTRAL_URL"] = "https://central.test";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("desktop central network errors", () => {
  test("request surfaces explicit network failure message", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("socket hang up");
    }) as unknown as typeof globalThis.fetch;

    await expect(centralModule.getProfile()).rejects.toThrow(
      "Central request failed: socket hang up",
    );
  });

  test("login surfaces explicit network failure message", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("connection refused");
    }) as unknown as typeof globalThis.fetch;

    await expect(centralModule.login("test@example.com", "password")).rejects.toThrow(
      "Central login failed: connection refused",
    );
  });
});
