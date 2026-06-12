import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { app } from "electron";

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

describe("getContainerCentralUrl", () => {
  const ORIGINAL_OVERRIDE = process.env["UNCORDED_CONTAINER_CENTRAL_URL"];
  // getContainerCentralUrl reads app.isPackaged live. The electron stub is a
  // process-global mock.module shared by every desktop test in the worker, so a
  // sibling file can leave isPackaged flipped to true — which would send these
  // dev-path cases down the packaged=prod branch. Pin it to dev here (and
  // restore) so the suite is independent of file execution order.
  const appRef = app as unknown as { isPackaged: boolean };
  const ORIGINAL_IS_PACKAGED = appRef.isPackaged;
  beforeEach(() => {
    appRef.isPackaged = false;
  });
  afterEach(() => {
    appRef.isPackaged = ORIGINAL_IS_PACKAGED;
    if (ORIGINAL_OVERRIDE === undefined) delete process.env["UNCORDED_CONTAINER_CENTRAL_URL"];
    else process.env["UNCORDED_CONTAINER_CENTRAL_URL"] = ORIGINAL_OVERRIDE;
  });

  test("explicit UNCORDED_CONTAINER_CENTRAL_URL override wins verbatim", () => {
    process.env["UNCORDED_CONTAINER_CENTRAL_URL"] = "https://my-tunnel.example.com";
    expect(centralModule.getContainerCentralUrl()).toBe("https://my-tunnel.example.com");
  });

  test("dev: rewrites a localhost base to host.docker.internal so the bridged container can reach it", () => {
    delete process.env["UNCORDED_CONTAINER_CENTRAL_URL"];
    process.env["VITE_CENTRAL_URL"] = "http://localhost:4000";
    expect(centralModule.getContainerCentralUrl()).toBe("http://host.docker.internal:4000");
  });

  test("dev: rewrites 127.0.0.1 the same way", () => {
    delete process.env["UNCORDED_CONTAINER_CENTRAL_URL"];
    process.env["VITE_CENTRAL_URL"] = "http://127.0.0.1:4000";
    expect(centralModule.getContainerCentralUrl()).toBe("http://host.docker.internal:4000");
  });

  test("dev: passes a routable base through untouched (e.g. web pointed at prod)", () => {
    delete process.env["UNCORDED_CONTAINER_CENTRAL_URL"];
    process.env["VITE_CENTRAL_URL"] = "https://central.uncorded.app";
    expect(centralModule.getContainerCentralUrl()).toBe("https://central.uncorded.app");
  });

  test("dev: falls back to prod Central when the base URL is unparseable", () => {
    delete process.env["UNCORDED_CONTAINER_CENTRAL_URL"];
    process.env["VITE_CENTRAL_URL"] = "not a url";
    expect(centralModule.getContainerCentralUrl()).toBe("https://central.uncorded.app");
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
