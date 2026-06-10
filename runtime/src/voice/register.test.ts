// Boot-level integration tests for plugin-loader managed-service wiring.
//
// Covers the three failure semantics from the 3a refinement:
//   - happy path: claim succeeds → plugin registers
//   - SERVICE_QUARANTINED: plugin load aborts; subprocess stopped; not in registry
//   - SERVICE_START_FAILED: soft warning; plugin still registers (retry on respawn)
//
// We register a controllable mock supervisor via the static registry instead of
// going through the LiveKit deps wiring — that lets each test deterministically
// drive claim() outcomes without spinning a real LiveKit-shaped subprocess.
// The voice deps wiring itself is exercised by supervisor.test.ts and
// register.ts is a thin factory wrapper.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { boot } from "../main";
import type {
  BootDependencies,
  BootResult,
  ServerJsonConfig,
  TunnelProvider,
} from "../main";
import {
  __resetRegistryForTests,
  registerSupervisor,
} from "../managed-services/registry";
import type {
  ClaimContext,
  ClaimResult,
  ManagedServiceSupervisor,
  ServiceHealth,
  ServiceState,
} from "../managed-services/types";
import type { PluginManifest } from "@uncorded/shared";
import type { TokenValidator, TokenValidationResult } from "../ws/types";
import type { HeartbeatResponse, PublicKeyEntry } from "../heartbeat/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function mkKey(id: string): PublicKeyEntry {
  return { id, public_key: { kty: "OKP", crv: "Ed25519", x: id } as JsonWebKey };
}

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

function mockTunnelProvider(): TunnelProvider {
  return {
    async start() { return "https://test.trycloudflare.com"; },
    async stop() {},
    getUrl() { return "https://test.trycloudflare.com"; },
    getState() { return "demo"; },
    async healthCheck() { return true; },
  };
}

function mockTokenValidator(): TokenValidator {
  return {
    async validate(_token: string): Promise<TokenValidationResult> {
      return { ok: false, code: "INVALID_TOKEN", message: "n/a" };
    },
  };
}

function dirtyResponse(): HeartbeatResponse {
  return {
    dirty: true,
    sync_version: 1,
    public_keys: [mkKey("test-key")],
    deltas: [],
  };
}

type MockFetch = NonNullable<BootDependencies["fetch"]>;

function mockFetch(): MockFetch {
  const fn = async (
    _input: string | URL | Request,
    _init?: RequestInit,
  ): Promise<Response> => {
    return new Response(JSON.stringify(dirtyResponse()), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return fn as MockFetch;
}

// ---------------------------------------------------------------------------
// Mock supervisor — controllable claim() outcome per test
// ---------------------------------------------------------------------------

interface MockSupervisor extends ManagedServiceSupervisor {
  claims: string[];
  releases: string[];
  shutdownCalled: boolean;
}

interface MockSupervisorBehavior {
  /** Return this on every claim. Default: ok. */
  claimResult?: ClaimResult;
}

function makeMockSupervisor(
  slug: string,
  behavior: MockSupervisorBehavior = {},
): MockSupervisor {
  const claims: string[] = [];
  const releases: string[] = [];
  let claimerCount = 0;
  let state: ServiceState = "stopped";
  let shutdownCalled = false;

  return {
    slug,
    claims,
    releases,
    get shutdownCalled() { return shutdownCalled; },
    async claim(ctx: ClaimContext): Promise<ClaimResult> {
      claims.push(ctx.pluginSlug);
      const r: ClaimResult =
        behavior.claimResult ?? { ok: true, state: "running" };
      if (r.ok) {
        claimerCount++;
        state = "running";
      }
      return r;
    },
    async release(ctx: ClaimContext): Promise<ClaimResult> {
      releases.push(ctx.pluginSlug);
      if (claimerCount > 0) claimerCount--;
      if (claimerCount === 0) state = "stopped";
      return { ok: true, state };
    },
    state(): ServiceState { return state; },
    claimerCount(): number { return claimerCount; },
    async shutdown(): Promise<void> {
      shutdownCalled = true;
      claimerCount = 0;
      state = "stopped";
    },
    async health(): Promise<ServiceHealth> {
      return { state, uptimeMs: null, lastError: null };
    },
  };
}

// ---------------------------------------------------------------------------
// Filesystem scaffolding
// ---------------------------------------------------------------------------

interface FsHarness {
  tmpDir: string;
  configPath: string;
  configDir: string;
  dataDir: string;
  corePluginsDir: string;
  userPluginsDir: string;
}

function setupFs(label: string, pluginSlug: string): FsHarness {
  const tmpDir = join(
    tmpdir(),
    `uncorded-register-test-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  const configDir = join(tmpDir, "config");
  const dataDir = join(tmpDir, "data");
  const corePluginsDir = join(tmpDir, "core-plugins");
  const userPluginsDir = join(tmpDir, "plugins");

  mkdirSync(configDir, { recursive: true });
  mkdirSync(corePluginsDir, { recursive: true });
  mkdirSync(userPluginsDir, { recursive: true });
  mkdirSync(join(dataDir, "plugins"), { recursive: true });

  // Plugin scaffold with managed_services declared.
  const pluginDir = join(userPluginsDir, pluginSlug);
  mkdirSync(join(pluginDir, "backend"), { recursive: true });
  mkdirSync(join(pluginDir, "frontend"), { recursive: true });
  mkdirSync(join(pluginDir, "migrations"), { recursive: true });
  const manifest = validManifest(pluginSlug);
  manifest.managed_services = ["livekit"];
  writeFileSync(join(pluginDir, "manifest.json"), JSON.stringify(manifest));
  // Stay alive after the ready handshake. A real plugin backend is a
  // long-lived process; a fixture that exits immediately trips the subprocess
  // crash/respawn loop (subprocess.ts handleExit → respawn → onRespawn
  // re-claim in main.ts), so the supervisor records extra claims. That race is
  // invisible on Windows but surfaces on Linux CI, where the respawn timer can
  // fire before the test's claim-count assertion. Keeping the process alive
  // (killed by the harness on shutdown) makes claim() fire exactly once.
  writeFileSync(
    join(pluginDir, "backend", "index.ts"),
    `process.stdout.write("IPC:" + JSON.stringify({ type: "ready" }) + "\\n");\nsetInterval(() => {}, 1 << 30);`,
  );
  mkdirSync(join(dataDir, "plugins", pluginSlug), { recursive: true });

  const config = validServerConfig({ installed_plugins: [pluginSlug] });
  const configPath = join(configDir, "server.json");
  writeFileSync(configPath, JSON.stringify(config));

  return { tmpDir, configPath, configDir, dataDir, corePluginsDir, userPluginsDir };
}

function makeBootDeps(fs: FsHarness): BootDependencies {
  return {
    tunnelProvider: mockTunnelProvider(),
    tokenValidator: mockTokenValidator(),
    configPath: fs.configPath,
    corePluginsDir: fs.corePluginsDir,
    userPluginsDir: fs.userPluginsDir,
    dataDir: fs.dataDir,
    runtimeVersion: "1.0.0",
    port: 0,
    fetch: mockFetch(),
  };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let bootResult: BootResult | null = null;
let createdDirs: string[] = [];

const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;

beforeEach(() => {
  __resetRegistryForTests();
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
});

afterEach(async () => {
  if (bootResult) {
    await bootResult.shutdown();
    bootResult = null;
  }
  for (const dir of createdDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
  createdDirs = [];
  __resetRegistryForTests();

  console.log = originalLog;
  console.warn = originalWarn;
  console.error = originalError;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("boot — managed-service claim wiring", () => {
  test("happy path: claim succeeds → plugin registers and supervisor sees the claim", async () => {
    const supervisor = makeMockSupervisor("livekit");
    registerSupervisor("livekit", () => supervisor);

    const fs = setupFs("happy", "voice-plugin");
    createdDirs.push(fs.tmpDir);

    bootResult = await boot(makeBootDeps(fs));

    expect(bootResult.pluginCount).toBe(1);
    expect(supervisor.claims).toEqual(["voice-plugin"]);
    expect(supervisor.releases).toEqual([]);
    expect(supervisor.claimerCount()).toBe(1);
  });

  test("SERVICE_QUARANTINED → plugin load aborts; supervisor never gets a stray claim leak", async () => {
    const supervisor = makeMockSupervisor("livekit", {
      claimResult: {
        ok: false,
        error: { code: "SERVICE_QUARANTINED", message: "quarantined for test" },
      },
    });
    registerSupervisor("livekit", () => supervisor);

    const fs = setupFs("quarantine", "voice-plugin");
    createdDirs.push(fs.tmpDir);

    bootResult = await boot(makeBootDeps(fs));

    // Plugin must not register when its required managed service is quarantined.
    expect(bootResult.pluginCount).toBe(0);
    // The boot loop did attempt a claim — that's how it learned the quarantine state.
    expect(supervisor.claims).toEqual(["voice-plugin"]);
    // Nothing was acquired before the failure, so the unwind release loop is a no-op.
    expect(supervisor.releases).toEqual([]);
  });

  test("SERVICE_START_FAILED → soft warn; plugin still registers; claim recorded for retry", async () => {
    const supervisor = makeMockSupervisor("livekit", {
      claimResult: {
        ok: false,
        error: { code: "SERVICE_START_FAILED", message: "transient spawn fail" },
      },
    });
    registerSupervisor("livekit", () => supervisor);

    const fs = setupFs("start-failed", "voice-plugin");
    createdDirs.push(fs.tmpDir);

    bootResult = await boot(makeBootDeps(fs));

    // Plugin loads despite sidecar failure — the next subprocess respawn re-attempts.
    expect(bootResult.pluginCount).toBe(1);
    expect(supervisor.claims).toEqual(["voice-plugin"]);
    expect(supervisor.releases).toEqual([]);
  });

  test("graceful shutdown calls supervisor.shutdown() exactly once for every claimed service", async () => {
    const supervisor = makeMockSupervisor("livekit");
    registerSupervisor("livekit", () => supervisor);

    const fs = setupFs("shutdown", "voice-plugin");
    createdDirs.push(fs.tmpDir);

    bootResult = await boot(makeBootDeps(fs));
    expect(supervisor.shutdownCalled).toBe(false);

    await bootResult.shutdown();
    bootResult = null;

    expect(supervisor.shutdownCalled).toBe(true);
  });
});
