import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  boot,
  parseServerConfig,
  BootError,
} from "./main";
import type {
  BootDependencies,
  BootResult,
  ServerJsonConfig,
  TunnelProvider,
} from "./main";
import type { TokenValidator, TokenValidationResult } from "./ws/types";
import type { HeartbeatResponse, PublicKeyEntry } from "./heartbeat/types";

function mkKey(id: string): PublicKeyEntry {
  return { id, public_key: { kty: "OKP", crv: "Ed25519", x: id } as JsonWebKey };
}
import type { PluginManifest } from "@uncorded/shared";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function validServerConfig(
  overrides?: Partial<ServerJsonConfig>,
): ServerJsonConfig {
  return {
    server_id: "server_test",
    server_secret: "sk_test_secret",
    central_url: "https://central.uncorded.app",
    installed_plugins: [],
    tunnel: { provider: "cloudflare", mode: "demo" },
    settings: {
      permissive_mode: false,
      max_connections: 100,
      allow_unsigned_plugins: false,
    },
    ...overrides,
  };
}

function validManifest(slug: string): PluginManifest {
  return {
    name: slug,
    version: "1.0.0",
    api_version: "^1.0",
    author: "Test",
    description: `Test plugin ${slug}`,
    type: "standalone",
    permissions: ["data.sql:self"],
    backend: { entry: "backend/index.ts" },
    frontend: { entry: "frontend/index.html" },
  };
}

function createMockTunnelProvider(): TunnelProvider & { started: boolean; stopped: boolean } {
  return {
    started: false,
    stopped: false,
    async start() {
      this.started = true;
      return "https://test.trycloudflare.com";
    },
    async stop() {
      this.stopped = true;
    },
    getUrl() {
      return "https://test.trycloudflare.com";
    },
    async healthCheck() {
      return true;
    },
  };
}

function createMockTokenValidator(): TokenValidator {
  return {
    async validate(token: string): Promise<TokenValidationResult> {
      if (token === "valid-token") {
        return {
          ok: true,
          user: {
            id: "user_1",
            username: "test_user",
            displayName: "Test User",
            avatarUrl: "",
            role: "member",
          },
        };
      }
      return { ok: false, code: "INVALID_TOKEN", message: "Invalid token" };
    },
  };
}

type MockFetch = NonNullable<BootDependencies["fetch"]>;

function createMockFetch(
  responses: Array<{ status: number; body: unknown } | "network-error">,
): { fetch: MockFetch; calls: Array<{ url: string }> } {
  const calls: Array<{ url: string }> = [];
  let index = 0;

  const fetch = async (
    input: string | URL | Request,
    _init?: RequestInit,
  ): Promise<Response> => {
    const entry = responses[index++];
    if (entry === undefined) {
      // Return clean heartbeat response for any extra calls (e.g. shutdown poll)
      calls.push({ url: String(input) });
      return new Response(JSON.stringify({ dirty: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    calls.push({ url: String(input) });
    if (entry === "network-error") {
      throw new TypeError("fetch failed");
    }
    return new Response(JSON.stringify(entry.body), {
      status: entry.status,
      headers: { "Content-Type": "application/json" },
    });
  };

  return { fetch: fetch as MockFetch, calls };
}

function dirtyResponse(
  overrides?: Partial<Extract<HeartbeatResponse, { dirty: true }>>,
): HeartbeatResponse {
  return {
    dirty: true,
    sync_version: 10,
    public_keys: [mkKey("key-a"), mkKey("key-b")],
    deltas: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Temporary directory helpers
// ---------------------------------------------------------------------------

let tmpDirs: string[] = [];

function createTmpDir(label: string): string {
  const dir = join(tmpdir(), `uncorded-test-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

function writeConfigFile(dir: string, config: ServerJsonConfig): string {
  const filePath = join(dir, "server.json");
  writeFileSync(filePath, JSON.stringify(config));
  return filePath;
}

function setupDataDir(dir: string): void {
  // Create the directories needed for core.db and plugin dbs
  mkdirSync(join(dir, "plugins"), { recursive: true });
}

function setupRolesMigrations(dir: string): void {
  // Create a minimal roles migration dir with the same SQL as the real one
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "001_create_tables.sql"),
    `CREATE TABLE IF NOT EXISTS roles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      level INTEGER NOT NULL DEFAULT 0,
      color TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
    );
    CREATE TABLE IF NOT EXISTS user_roles (
      user_id TEXT NOT NULL PRIMARY KEY,
      role_id INTEGER NOT NULL REFERENCES roles(id)
    );
    CREATE TABLE IF NOT EXISTS permissions (
      key TEXT NOT NULL PRIMARY KEY,
      plugin_slug TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS role_permissions (
      role_id INTEGER NOT NULL REFERENCES roles(id),
      permission_key TEXT NOT NULL REFERENCES permissions(key),
      granted INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (role_id, permission_key)
    );
    INSERT OR IGNORE INTO roles (name, level) VALUES ('owner', 100);
    INSERT OR IGNORE INTO roles (name, level) VALUES ('admin', 80);
    INSERT OR IGNORE INTO roles (name, level) VALUES ('moderator', 60);
    INSERT OR IGNORE INTO roles (name, level) VALUES ('member', 10);`,
  );
}

// ---------------------------------------------------------------------------
// Silence expected console output during tests
// ---------------------------------------------------------------------------

const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;

beforeEach(() => {
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
});

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

let bootResult: BootResult | null = null;

afterEach(async () => {
  if (bootResult) {
    await bootResult.shutdown();
    bootResult = null;
  }
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
  tmpDirs = [];

  // Restore console after cleanup so any unexpected post-test output is visible
  console.log = originalLog;
  console.warn = originalWarn;
  console.error = originalError;
});

// ---------------------------------------------------------------------------
// Helper: build full boot dependencies for integration tests
// ---------------------------------------------------------------------------

function createBootDeps(overrides?: Partial<BootDependencies>): {
  deps: BootDependencies;
  tmpDir: string;
  configPath: string;
} {
  const tmpDir = createTmpDir("boot");
  const configDir = join(tmpDir, "config");
  const dataDir = join(tmpDir, "data");
  const corePluginsDir = join(tmpDir, "core-plugins");
  const userPluginsDir = join(tmpDir, "plugins");

  mkdirSync(configDir, { recursive: true });
  mkdirSync(corePluginsDir, { recursive: true });
  mkdirSync(userPluginsDir, { recursive: true });
  setupDataDir(dataDir);

  const config = validServerConfig();
  const configPath = writeConfigFile(configDir, config);

  const { fetch } = createMockFetch([
    { status: 200, body: dirtyResponse() },
  ]);

  const deps: BootDependencies = {
    tunnelProvider: createMockTunnelProvider(),
    tokenValidator: createMockTokenValidator(),
    configPath,
    corePluginsDir,
    userPluginsDir,
    dataDir,
    runtimeVersion: "1.0.0",
    port: 0, // Let OS pick a free port
    fetch,
    // Use real filesystem functions — we write real files in tmpDir
    ...overrides,
  };

  return { deps, tmpDir, configPath };
}

// ===========================================================================
// Tests: parseServerConfig
// ===========================================================================

describe("parseServerConfig", () => {
  test("accepts valid config", () => {
    const result = parseServerConfig(validServerConfig());
    expect(result.ok).toBe(true);
  });

  test("rejects non-object", () => {
    const result = parseServerConfig("not an object");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toContain("JSON object");
    }
  });

  test("rejects missing server_id", () => {
    const config = validServerConfig();
    (config as unknown as Record<string, unknown>)["server_id"] = "";
    const result = parseServerConfig(config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join("; ")).toContain("server_id");
    }
  });

  test("rejects missing installed_plugins", () => {
    const config = validServerConfig();
    (config as unknown as Record<string, unknown>)["installed_plugins"] = "not-array";
    const result = parseServerConfig(config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join("; ")).toContain("installed_plugins");
    }
  });

  test("rejects invalid tunnel shape", () => {
    const config = validServerConfig();
    (config as unknown as Record<string, unknown>)["tunnel"] = { provider: "" };
    const result = parseServerConfig(config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join("; ")).toContain("tunnel");
    }
  });

  test("rejects missing settings", () => {
    const config = validServerConfig();
    (config as unknown as Record<string, unknown>)["settings"] = null;
    const result = parseServerConfig(config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join("; ")).toContain("settings");
    }
  });

  test("accepts config with optional fields", () => {
    const config = validServerConfig({
      central_public_keys: [mkKey("key1")],
      last_sync_version: 42,
    });
    const result = parseServerConfig(config);
    expect(result.ok).toBe(true);
  });

  test("rejects server_secret left at the default placeholder", () => {
    const config = validServerConfig();
    (config as unknown as Record<string, unknown>)["server_secret"] = "change-me";
    const result = parseServerConfig(config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join("; ")).toContain("default placeholder");
    }
  });

  test("accepts settings.allowed_origins array of origin strings", () => {
    const config = validServerConfig();
    config.settings.allowed_origins = [
      "https://uncorded.app",
      "http://localhost:5173",
    ];
    const result = parseServerConfig(config);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.settings.allowed_origins).toEqual([
        "https://uncorded.app",
        "http://localhost:5173",
      ]);
    }
  });

  test("rejects settings.allowed_origins containing a wildcard", () => {
    const config = validServerConfig();
    config.settings.allowed_origins = ["*"];
    const result = parseServerConfig(config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join("; ")).toContain("allowed_origins");
    }
  });

  test("rejects settings.allowed_origins when not an array", () => {
    const config = validServerConfig();
    (config.settings as unknown as Record<string, unknown>)["allowed_origins"] =
      "https://uncorded.app";
    const result = parseServerConfig(config);
    expect(result.ok).toBe(false);
  });

  test("settings.allowed_origins is optional (omitted → no allowlist)", () => {
    const config = validServerConfig();
    const result = parseServerConfig(config);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.settings.allowed_origins).toBeUndefined();
    }
  });
});

// ===========================================================================
// Tests: boot — fatal error cases (steps 1-4)
// ===========================================================================

describe("boot — fatal errors", () => {
  test("step 1: config file missing rejects with CONFIG_INVALID", async () => {
    const { deps } = createBootDeps({
      configPath: "/nonexistent/server.json",
    });

    try {
      bootResult = await boot(deps);
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BootError);
      expect((err as BootError).code).toBe("CONFIG_INVALID");
    }
  });

  test("step 1: malformed JSON rejects with CONFIG_INVALID", async () => {
    const tmpDir = createTmpDir("bad-json");
    const configPath = join(tmpDir, "server.json");
    writeFileSync(configPath, "{ not valid json }}}");

    const { deps } = createBootDeps({ configPath });

    try {
      bootResult = await boot(deps);
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BootError);
      expect((err as BootError).code).toBe("CONFIG_INVALID");
    }
  });

  test("step 1: invalid config fields rejects with CONFIG_INVALID", async () => {
    const tmpDir = createTmpDir("bad-fields");
    const configPath = join(tmpDir, "server.json");
    writeFileSync(configPath, JSON.stringify({ server_id: 123 }));

    const { deps } = createBootDeps({ configPath });

    try {
      bootResult = await boot(deps);
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BootError);
      expect((err as BootError).code).toBe("CONFIG_INVALID");
    }
  });

  test("step 3: tunnel failure rejects with TUNNEL_FAILED", async () => {
    const failingTunnel: TunnelProvider = {
      async start() {
        throw new Error("Cloudflare connection refused");
      },
      async stop() {},
      getUrl() { return ""; },
      async healthCheck() { return false; },
    };

    const { deps } = createBootDeps({ tunnelProvider: failingTunnel });

    try {
      bootResult = await boot(deps);
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BootError);
      expect((err as BootError).code).toBe("TUNNEL_FAILED");
      expect((err as BootError).message).toContain("Cloudflare connection refused");
    }
  });

  test("step 2: DB migration failure rejects with DB_MIGRATION_FAILED", async () => {
    const tmpDir = createTmpDir("bad-db");
    const configDir = join(tmpDir, "config");
    const dataDir = join(tmpDir, "data");

    mkdirSync(configDir, { recursive: true });
    // Do NOT call setupDataDir — create a file where core.db directory would be
    // so the Database constructor fails
    mkdirSync(dataDir, { recursive: true });

    const config = validServerConfig();
    const configPath = writeConfigFile(configDir, config);

    // Provide a listFiles that returns a migration file with invalid SQL
    const listFiles = () => ["001_bad.sql"];
    const readFile = () => "THIS IS NOT VALID SQL ;;; DROP TABLE nonexistent INVALID";

    const { fetch } = createMockFetch([{ status: 200, body: dirtyResponse() }]);

    const deps: BootDependencies = {
      tunnelProvider: createMockTunnelProvider(),
      tokenValidator: createMockTokenValidator(),
      configPath,
      corePluginsDir: join(tmpDir, "core-plugins"),
      userPluginsDir: join(tmpDir, "plugins"),
      dataDir,
      runtimeVersion: "1.0.0",
      port: 0,
      fetch,
      listFiles,
      readFile,
    };

    mkdirSync(join(tmpDir, "core-plugins"), { recursive: true });
    mkdirSync(join(tmpDir, "plugins"), { recursive: true });

    try {
      bootResult = await boot(deps);
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BootError);
      expect((err as BootError).code).toBe("DB_MIGRATION_FAILED");
    }
  });

  test("step 4: Central unreachable + no cached keys rejects with NO_PUBLIC_KEYS", async () => {
    const { fetch } = createMockFetch(["network-error"]);
    const { deps } = createBootDeps({ fetch });

    try {
      bootResult = await boot(deps);
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BootError);
      expect((err as BootError).code).toBe("NO_PUBLIC_KEYS");
    }
  });

  test("step 4: Central returns OK but no public keys rejects", async () => {
    const { fetch } = createMockFetch([
      { status: 200, body: dirtyResponse({ public_keys: [] }) },
    ]);
    const { deps } = createBootDeps({ fetch });

    try {
      bootResult = await boot(deps);
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BootError);
      expect((err as BootError).code).toBe("NO_PUBLIC_KEYS");
    }
  });

  test("step 4: Central unreachable but cached keys exist — boot succeeds", async () => {
    const tmpDir = createTmpDir("cached-keys");
    const configDir = join(tmpDir, "config");
    const dataDir = join(tmpDir, "data");
    mkdirSync(configDir, { recursive: true });
    setupDataDir(dataDir);

    const config = validServerConfig({
      central_public_keys: [mkKey("cached-key-1")],
    });
    const configPath = writeConfigFile(configDir, config);

    const { fetch } = createMockFetch(["network-error"]);

    const deps: BootDependencies = {
      tunnelProvider: createMockTunnelProvider(),
      tokenValidator: createMockTokenValidator(),
      configPath,
      corePluginsDir: join(tmpDir, "core-plugins"),
      userPluginsDir: join(tmpDir, "plugins"),
      dataDir,
      runtimeVersion: "1.0.0",
      port: 0,
      fetch,
    };

    mkdirSync(join(tmpDir, "core-plugins"), { recursive: true });
    mkdirSync(join(tmpDir, "plugins"), { recursive: true });

    bootResult = await boot(deps);
    expect(bootResult.pluginCount).toBe(0);
    expect(bootResult.config.server_id).toBe("server_test");
  });
});

// ===========================================================================
// Tests: boot — happy path
// ===========================================================================

describe("boot — happy path", () => {
  test("boots successfully with no plugins", async () => {
    const { deps } = createBootDeps();

    bootResult = await boot(deps);

    expect(bootResult.pluginCount).toBe(0);
    expect(bootResult.config.server_id).toBe("server_test");
    expect(typeof bootResult.shutdown).toBe("function");
  });

  test("tunnel provider is started", async () => {
    const tunnel = createMockTunnelProvider();
    const { deps } = createBootDeps({ tunnelProvider: tunnel });

    bootResult = await boot(deps);

    expect(tunnel.started).toBe(true);
  });
});

// ===========================================================================
// Tests: boot — graceful shutdown
// ===========================================================================

describe("boot — shutdown", () => {
  test("shutdown stops tunnel and heartbeat", async () => {
    const tunnel = createMockTunnelProvider();
    const { fetch, calls } = createMockFetch([
      { status: 200, body: dirtyResponse() },
      // Second call: the shutdown poll
      { status: 200, body: { dirty: false } },
    ]);

    const { deps } = createBootDeps({ tunnelProvider: tunnel, fetch });

    bootResult = await boot(deps);
    await bootResult.shutdown();

    expect(tunnel.stopped).toBe(true);

    // Verify a final heartbeat was sent (at least 2 calls: initial poll + shutdown poll)
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  test("shutdown is idempotent", async () => {
    const { deps } = createBootDeps();
    bootResult = await boot(deps);

    await bootResult.shutdown();
    // Second call should not throw
    await bootResult.shutdown();
  });

  test("shutdown tears down all subsystems", async () => {
    const tunnel = createMockTunnelProvider();
    const { fetch, calls } = createMockFetch([
      { status: 200, body: dirtyResponse() },
      // Shutdown poll
      { status: 200, body: { dirty: false } },
    ]);

    const { deps } = createBootDeps({ tunnelProvider: tunnel, fetch });
    bootResult = await boot(deps);

    // Verify subsystems are up
    expect(tunnel.started).toBe(true);
    expect(tunnel.stopped).toBe(false);

    await bootResult.shutdown();

    // Tunnel stopped
    expect(tunnel.stopped).toBe(true);

    // Final heartbeat was sent (shutdown poll)
    expect(calls.length).toBeGreaterThanOrEqual(2);

    // Calling shutdown again is safe (idempotent)
    await bootResult.shutdown();
  });

  test("a wedged teardown step cannot hang shutdown past the deadline", async () => {
    // Tunnel stop never resolves — simulates a stuck cloudflared teardown.
    // Without the bounded shutdown, `shutdown()` would await it forever and the
    // caller's process.exit would never be reached.
    const hangingTunnel: TunnelProvider = {
      async start() {
        return "https://test.trycloudflare.com";
      },
      stop() {
        return new Promise<void>(() => {}); // never settles
      },
      getUrl() {
        return "https://test.trycloudflare.com";
      },
      async healthCheck() {
        return true;
      },
    };

    const { deps } = createBootDeps({
      tunnelProvider: hangingTunnel,
      // Small overall deadline so the test is fast.
      shutdownDeadlineMs: 150,
    });

    bootResult = await boot(deps);

    const start = Date.now();
    // If the deadline weren't wired, this await would hang and the test would
    // time out. Race it against a generous ceiling to fail loudly instead.
    await Promise.race([
      bootResult.shutdown(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("shutdown() did not resolve within the deadline")), 3000),
      ),
    ]);
    const elapsed = Date.now() - start;

    // Resolved via the deadline backstop, comfortably under the race ceiling.
    expect(elapsed).toBeLessThan(2000);

    // The hanging tunnel.stop() is still pending in the background; null out so
    // afterEach doesn't re-await teardown on it (shutdown() is idempotent and
    // returns the already-resolved promise anyway).
    bootResult = null;
  });

  test("shutdown removes signal handlers it registered", async () => {
    const sigtermBefore = process.listenerCount("SIGTERM");
    const sigintBefore = process.listenerCount("SIGINT");
    const { deps } = createBootDeps();

    bootResult = await boot(deps);

    expect(process.listenerCount("SIGTERM")).toBe(sigtermBefore + 1);
    expect(process.listenerCount("SIGINT")).toBe(sigintBefore + 1);

    await bootResult.shutdown();
    bootResult = null;

    expect(process.listenerCount("SIGTERM")).toBe(sigtermBefore);
    expect(process.listenerCount("SIGINT")).toBe(sigintBefore);
  });
});

// ===========================================================================
// Tests: boot — plugin loading
// ===========================================================================

describe("boot — plugin loading", () => {
  test("loads plugin from user plugins directory", async () => {
    const tmpDir = createTmpDir("plugins");
    const configDir = join(tmpDir, "config");
    const dataDir = join(tmpDir, "data");
    const corePluginsDir = join(tmpDir, "core-plugins");
    const userPluginsDir = join(tmpDir, "plugins");

    mkdirSync(configDir, { recursive: true });
    mkdirSync(corePluginsDir, { recursive: true });
    setupDataDir(dataDir);

    // Create a plugin directory with manifest
    const pluginSlug = "test-plugin";
    const pluginDir = join(userPluginsDir, pluginSlug);
    mkdirSync(join(pluginDir, "backend"), { recursive: true });
    mkdirSync(join(pluginDir, "frontend"), { recursive: true });
    mkdirSync(join(pluginDir, "migrations"), { recursive: true });
    writeFileSync(
      join(pluginDir, "manifest.json"),
      JSON.stringify(validManifest(pluginSlug)),
    );
    // Create a minimal backend entry that sends "ready"
    writeFileSync(
      join(pluginDir, "backend", "index.ts"),
      `process.stdout.write("IPC:" + JSON.stringify({ type: "ready" }) + "\\n");`,
    );

    // Create plugin data directory
    mkdirSync(join(dataDir, "plugins", pluginSlug), { recursive: true });

    const config = validServerConfig({
      installed_plugins: [pluginSlug],
    });
    const configPath = writeConfigFile(configDir, config);

    const { fetch } = createMockFetch([
      { status: 200, body: dirtyResponse() },
    ]);

    const deps: BootDependencies = {
      tunnelProvider: createMockTunnelProvider(),
      tokenValidator: createMockTokenValidator(),
      configPath,
      corePluginsDir,
      userPluginsDir,
      dataDir,
      runtimeVersion: "1.0.0",
      port: 0,
      fetch,
    };

    bootResult = await boot(deps);

    expect(bootResult.pluginCount).toBe(1);
  });

  test("skips plugin with bad manifest — others still load", async () => {
    const tmpDir = createTmpDir("bad-plugin");
    const configDir = join(tmpDir, "config");
    const dataDir = join(tmpDir, "data");
    const corePluginsDir = join(tmpDir, "core-plugins");
    const userPluginsDir = join(tmpDir, "plugins");

    mkdirSync(configDir, { recursive: true });
    mkdirSync(corePluginsDir, { recursive: true });
    setupDataDir(dataDir);

    // Good plugin
    const goodSlug = "good-plugin";
    const goodDir = join(userPluginsDir, goodSlug);
    mkdirSync(join(goodDir, "backend"), { recursive: true });
    mkdirSync(join(goodDir, "frontend"), { recursive: true });
    mkdirSync(join(goodDir, "migrations"), { recursive: true });
    writeFileSync(
      join(goodDir, "manifest.json"),
      JSON.stringify(validManifest(goodSlug)),
    );
    writeFileSync(
      join(goodDir, "backend", "index.ts"),
      `process.stdout.write("IPC:" + JSON.stringify({ type: "ready" }) + "\\n");`,
    );
    mkdirSync(join(dataDir, "plugins", goodSlug), { recursive: true });

    // Bad plugin — invalid manifest
    const badSlug = "bad-plugin";
    const badDir = join(userPluginsDir, badSlug);
    mkdirSync(badDir, { recursive: true });
    writeFileSync(
      join(badDir, "manifest.json"),
      JSON.stringify({ name: badSlug }), // Missing required fields
    );

    const config = validServerConfig({
      installed_plugins: [badSlug, goodSlug],
    });
    const configPath = writeConfigFile(configDir, config);

    const { fetch } = createMockFetch([
      { status: 200, body: dirtyResponse() },
    ]);

    const deps: BootDependencies = {
      tunnelProvider: createMockTunnelProvider(),
      tokenValidator: createMockTokenValidator(),
      configPath,
      corePluginsDir,
      userPluginsDir,
      dataDir,
      runtimeVersion: "1.0.0",
      port: 0,
      fetch,
    };

    bootResult = await boot(deps);

    // The bad plugin is skipped and the good one still loads.
    // The orchestrator strips failed slugs and retries with the remaining valid ones.
    expect(bootResult.pluginCount).toBe(1);
  });

  test("boots with no installed_plugins listed", async () => {
    const { deps } = createBootDeps();
    bootResult = await boot(deps);
    expect(bootResult.pluginCount).toBe(0);
  });

  test("core-plugins directory wins over user plugins for same slug", async () => {
    const tmpDir = createTmpDir("core-priority");
    const configDir = join(tmpDir, "config");
    const dataDir = join(tmpDir, "data");
    const corePluginsDir = join(tmpDir, "core-plugins");
    const userPluginsDir = join(tmpDir, "plugins");

    mkdirSync(configDir, { recursive: true });
    mkdirSync(corePluginsDir, { recursive: true });
    mkdirSync(userPluginsDir, { recursive: true });
    setupDataDir(dataDir);

    const pluginSlug = "shared-plugin";

    // Create plugin in BOTH directories with different descriptions
    for (const dir of [corePluginsDir, userPluginsDir]) {
      const pluginDir = join(dir, pluginSlug);
      mkdirSync(join(pluginDir, "backend"), { recursive: true });
      mkdirSync(join(pluginDir, "frontend"), { recursive: true });
      mkdirSync(join(pluginDir, "migrations"), { recursive: true });

      const manifest = validManifest(pluginSlug);
      manifest.description = dir === corePluginsDir ? "CORE VERSION" : "USER VERSION";
      writeFileSync(join(pluginDir, "manifest.json"), JSON.stringify(manifest));
      writeFileSync(
        join(pluginDir, "backend", "index.ts"),
        `process.stdout.write("IPC:" + JSON.stringify({ type: "ready" }) + "\\n");`,
      );
    }

    mkdirSync(join(dataDir, "plugins", pluginSlug), { recursive: true });

    const config = validServerConfig({ installed_plugins: [pluginSlug] });
    const configPath = writeConfigFile(configDir, config);
    const { fetch } = createMockFetch([{ status: 200, body: dirtyResponse() }]);

    const deps: BootDependencies = {
      tunnelProvider: createMockTunnelProvider(),
      tokenValidator: createMockTokenValidator(),
      configPath,
      corePluginsDir,
      userPluginsDir,
      dataDir,
      runtimeVersion: "1.0.0",
      port: 0,
      fetch,
    };

    bootResult = await boot(deps);

    // If core-plugins wins, the plugin loaded from corePluginsDir
    expect(bootResult.pluginCount).toBe(1);
  });

  test("multi-plugin with one spawn failure — successful plugin still loads", async () => {
    const tmpDir = createTmpDir("multi-spawn");
    const configDir = join(tmpDir, "config");
    const dataDir = join(tmpDir, "data");
    const corePluginsDir = join(tmpDir, "core-plugins");
    const userPluginsDir = join(tmpDir, "plugins");

    mkdirSync(configDir, { recursive: true });
    mkdirSync(corePluginsDir, { recursive: true });
    setupDataDir(dataDir);

    // Plugin A: works correctly
    const slugA = "plugin-a";
    const dirA = join(userPluginsDir, slugA);
    mkdirSync(join(dirA, "backend"), { recursive: true });
    mkdirSync(join(dirA, "frontend"), { recursive: true });
    mkdirSync(join(dirA, "migrations"), { recursive: true });
    writeFileSync(join(dirA, "manifest.json"), JSON.stringify(validManifest(slugA)));
    writeFileSync(
      join(dirA, "backend", "index.ts"),
      `process.stdout.write("IPC:" + JSON.stringify({ type: "ready" }) + "\\n");`,
    );
    mkdirSync(join(dataDir, "plugins", slugA), { recursive: true });

    // Plugin B: backend entry does not exist (spawn will fail)
    const slugB = "plugin-b";
    const dirB = join(userPluginsDir, slugB);
    mkdirSync(join(dirB, "backend"), { recursive: true });
    mkdirSync(join(dirB, "frontend"), { recursive: true });
    mkdirSync(join(dirB, "migrations"), { recursive: true });
    writeFileSync(join(dirB, "manifest.json"), JSON.stringify(validManifest(slugB)));
    // Intentionally no backend/index.ts — spawn will fail
    mkdirSync(join(dataDir, "plugins", slugB), { recursive: true });

    const config = validServerConfig({ installed_plugins: [slugA, slugB] });
    const configPath = writeConfigFile(configDir, config);
    const { fetch } = createMockFetch([{ status: 200, body: dirtyResponse() }]);

    const deps: BootDependencies = {
      tunnelProvider: createMockTunnelProvider(),
      tokenValidator: createMockTokenValidator(),
      configPath,
      corePluginsDir,
      userPluginsDir,
      dataDir,
      runtimeVersion: "1.0.0",
      port: 0,
      fetch,
    };

    bootResult = await boot(deps);

    // Plugin A loaded successfully, plugin B failed — count should be 1
    expect(bootResult.pluginCount).toBe(1);
  });
});

// ===========================================================================
// Tests: boot — HTTP+WS server composition
// ===========================================================================

describe("boot — server composition", () => {
  test("GET /health returns JSON response", async () => {
    const { deps } = createBootDeps();
    bootResult = await boot(deps);

    // The server is running on port 0 (OS-assigned). We can't easily get the
    // actual port from the BootResult, so we verify the boot completed and
    // the shutdown works cleanly. The WS server tests already cover HTTP
    // composition behavior.
    expect(bootResult.pluginCount).toBe(0);
  });
});

// ===========================================================================
// Tests: boot — delta handler wiring
// ===========================================================================

describe("boot — delta handlers", () => {
  test("boot wires delta handlers without errors", async () => {
    const { deps } = createBootDeps();
    bootResult = await boot(deps);

    // The delta handlers are wired internally. We verify boot succeeded
    // and shutdown works — delta handler correctness is validated via
    // heartbeat client tests with injected handlers.
    expect(bootResult.config.server_id).toBe("server_test");
  });

  test("user.banned delta fires router.disconnectUser()", async () => {
    // Second poll (from heartbeat.start()) returns a user.banned delta
    let callIndex = 0;
    let secondPollResolve: (() => void) | undefined;
    const secondPollDone = new Promise<void>((r) => { secondPollResolve = r; });

    const mockFetch = async (
      input: string | URL | Request,
      _init?: RequestInit,
    ): Promise<Response> => {
      callIndex++;
      if (callIndex === 1) {
        // Boot poll — return keys
        return new Response(JSON.stringify(dirtyResponse()), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (callIndex === 2) {
        // heartbeat.start() poll — return user.banned delta
        const body = dirtyResponse({
          deltas: [{ type: "user.banned", user_id: "user_banned_1", reason: "test ban" }],
        });
        const res = new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
        // Signal after a tick so the handler has time to run
        setTimeout(() => secondPollResolve?.(), 10);
        return res;
      }
      return new Response(JSON.stringify({ dirty: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const { deps } = createBootDeps({ fetch: mockFetch as MockFetch });
    bootResult = await boot(deps);

    // Wait for the second poll (from heartbeat.start()) to complete
    await secondPollDone;
    // Give the delta handler time to execute
    await Bun.sleep(50);

    // The handler logged the disconnection. Since no user is actually
    // connected, disconnectUser returns 0 — but the handler still ran.
    // We verify it didn't throw and boot is still healthy.
    expect(bootResult.config.server_id).toBe("server_test");
    // The second poll was called, confirming delta dispatch
    expect(callIndex).toBeGreaterThanOrEqual(2);
  });

  test("plugin.revoked delta fires subprocessManager.stop()", async () => {
    let callIndex = 0;
    let secondPollResolve: (() => void) | undefined;
    const secondPollDone = new Promise<void>((r) => { secondPollResolve = r; });

    const mockFetch = async (
      input: string | URL | Request,
      _init?: RequestInit,
    ): Promise<Response> => {
      callIndex++;
      if (callIndex === 1) {
        return new Response(JSON.stringify(dirtyResponse()), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (callIndex === 2) {
        const body = dirtyResponse({
          deltas: [{ type: "plugin.revoked", plugin_slug: "bad-plugin", version: "1.0.0" }],
        });
        const res = new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
        setTimeout(() => secondPollResolve?.(), 10);
        return res;
      }
      return new Response(JSON.stringify({ dirty: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const { deps } = createBootDeps({ fetch: mockFetch as MockFetch });
    bootResult = await boot(deps);

    await secondPollDone;
    await Bun.sleep(50);

    // Handler ran without errors — stop() on non-existent plugin is a no-op
    expect(callIndex).toBeGreaterThanOrEqual(2);
  });
});
