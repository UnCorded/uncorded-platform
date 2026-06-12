import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

const mockKeychainGet = mock<(key: string) => string | null>();
const mockKeychainSet = mock<(key: string, value: string) => void>();
const mockKeychainDelete = mock<(key: string) => void>();

let centralModule: typeof import("./central");
const originalFetch = globalThis.fetch;

beforeAll(async () => {
  // electron is stubbed globally by the test preload
  // (apps/desktop/test/preload-electron.ts), so no per-file electron mock is
  // needed here.

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

  centralModule = await import(`./central.ts?network-errors-${Date.now()}`) as typeof import("./central");
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

// Pure resolver — no electron / env dependency, so these can't be perturbed by
// a sibling file mutating the shared electron stub's app.isPackaged (which is
// exactly what made the earlier env-driven version flaky across file orders).
describe("resolveContainerCentralUrl", () => {
  test("explicit override wins verbatim", () => {
    expect(centralModule.resolveContainerCentralUrl({
      override: "https://my-tunnel.example.com",
      isPackaged: false,
      baseUrl: "http://localhost:4000",
    })).toBe("https://my-tunnel.example.com");
  });

  test("override wins even in dev with a loopback base", () => {
    expect(centralModule.resolveContainerCentralUrl({
      override: "https://staging.example.com",
      isPackaged: false,
      baseUrl: "http://localhost:4000",
    })).toBe("https://staging.example.com");
  });

  test("packaged builds always resolve to prod Central", () => {
    expect(centralModule.resolveContainerCentralUrl({
      override: undefined,
      isPackaged: true,
      baseUrl: "http://localhost:4000",
    })).toBe("https://central.uncorded.app");
  });

  test("dev: rewrites a localhost base to host.docker.internal so the bridged container can reach it", () => {
    expect(centralModule.resolveContainerCentralUrl({
      override: undefined,
      isPackaged: false,
      baseUrl: "http://localhost:4000",
    })).toBe("http://host.docker.internal:4000");
  });

  test("dev: rewrites 127.0.0.1 the same way", () => {
    expect(centralModule.resolveContainerCentralUrl({
      override: undefined,
      isPackaged: false,
      baseUrl: "http://127.0.0.1:4000",
    })).toBe("http://host.docker.internal:4000");
  });

  test("dev: rewrites the IPv6 loopback [::1] the same way", () => {
    expect(centralModule.resolveContainerCentralUrl({
      override: undefined,
      isPackaged: false,
      baseUrl: "http://[::1]:4000",
    })).toBe("http://host.docker.internal:4000");
  });

  test("dev: passes a routable base through untouched (e.g. web pointed at prod)", () => {
    expect(centralModule.resolveContainerCentralUrl({
      override: undefined,
      isPackaged: false,
      baseUrl: "https://central.uncorded.app",
    })).toBe("https://central.uncorded.app");
  });

  test("dev: falls back to prod Central when the base URL is unparseable", () => {
    expect(centralModule.resolveContainerCentralUrl({
      override: undefined,
      isPackaged: false,
      baseUrl: "not a url",
    })).toBe("https://central.uncorded.app");
  });
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
