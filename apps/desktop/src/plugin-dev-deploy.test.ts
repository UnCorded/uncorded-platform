import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { satisfiesRange } from "@uncorded/shared";

import {
  __resetDeployLocksForTests,
  caretSatisfies,
  deployDevPlugin,
  measureCopyBytes,
  undeployDevPlugin,
  type DeployDeps,
  type DeployProgressEvent,
} from "./plugin-dev-deploy";
import { releaseServerLifecycle, tryAcquireServerLifecycle } from "./server-lifecycle-lock";

const tmpRoot = mkdtempSync(join(tmpdir(), "uncorded-deploy-test-"));
let caseIdx = 0;
let workspaceDir: string;
let volumePath: string;

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function writePluginSource(slug: string, manifestOverrides: Record<string, unknown> = {}): string {
  const dir = join(workspaceDir, slug);
  mkdirSync(join(dir, "backend"), { recursive: true });
  mkdirSync(join(dir, "node_modules", "leftpad"), { recursive: true });
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      name: slug,
      version: "0.1.0",
      api_version: "^1.0",
      author: "t",
      description: "d",
      type: "standalone",
      backend: { entry: "backend/index.ts" },
      permissions: [],
      ...manifestOverrides,
    }),
    "utf8",
  );
  writeFileSync(join(dir, "backend", "index.ts"), "// entry", "utf8");
  writeFileSync(join(dir, "node_modules", "leftpad", "index.js"), "//", "utf8");
  writeFileSync(join(dir, "AGENTS.md"), "agent docs", "utf8");
  writeFileSync(join(dir, ".uncorded-dev.json"), "{}", "utf8");
  return dir;
}

function writeServerConfig(overrides: Record<string, unknown> = {}): void {
  mkdirSync(join(volumePath, "config"), { recursive: true });
  mkdirSync(join(volumePath, "plugins"), { recursive: true });
  writeFileSync(
    join(volumePath, "config", "server.json"),
    JSON.stringify({
      server_id: "srv-1",
      installed_plugins: ["text-channels"],
      settings: { allow_unsigned_plugins: false },
      ...overrides,
    }),
    "utf8",
  );
}

function readServerConfig(): { installed_plugins: string[]; settings: Record<string, unknown> } {
  return JSON.parse(readFileSync(join(volumePath, "config", "server.json"), "utf8")) as {
    installed_plugins: string[];
    settings: Record<string, unknown>;
  };
}

interface FakeWorld {
  deps: DeployDeps;
  events: DeployProgressEvent[];
  removed: string[];
  started: number;
  containerRunning: boolean;
}

function makeWorld(opts: {
  health?: Record<string, unknown> | null; // null = health never answers
  adminPlugins?: { slug: string; statusLabel: string }[] | null; // null = no token
  startThrows?: boolean;
} = {}): FakeWorld {
  const world: FakeWorld = {
    events: [],
    removed: [],
    started: 0,
    containerRunning: true,
    deps: undefined as unknown as DeployDeps,
  };
  const health = opts.health === undefined ? { status: "ok", plugin_api_version: "1.0.0" } : opts.health;
  world.deps = {
    resolveDevPluginPath: (slug) => {
      const p = join(workspaceDir, slug);
      return existsSync(p) ? p : null;
    },
    getServerRecord: (serverId) =>
      serverId === "srv-1" ? { containerId: "cont-old", volumePath, hostPort: 3000 } : null,
    getDockerStatus: async () => ({ installed: true, running: true }),
    removeContainer: async (id) => {
      world.removed.push(id);
      world.containerRunning = false;
    },
    startServerContainer: async () => {
      if (opts.startThrows) throw new Error("docker run failed");
      world.started += 1;
      world.containerRunning = true;
      return `cont-new-${String(world.started)}`;
    },
    getAdminToken: async () => (opts.adminPlugins === null ? null : "token"),
    onProgress: (e) => world.events.push(e),
    healthTimeoutMs: 200,
    healthPollIntervalMs: 10,
    fetchFn: (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/health")) {
        if (health === null || !world.containerRunning) throw new Error("ECONNREFUSED");
        return Response.json(health);
      }
      if (url.endsWith("/admin/api/plugins")) {
        const rows = opts.adminPlugins ?? [{ slug: "trip-planner", statusLabel: "ready" }];
        return Response.json({ plugins: rows });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch,
  };
  return world;
}

beforeEach(() => {
  caseIdx += 1;
  workspaceDir = join(tmpRoot, `ws-${String(caseIdx)}`);
  volumePath = join(tmpRoot, `vol-${String(caseIdx)}`);
  mkdirSync(workspaceDir, { recursive: true });
  mkdirSync(volumePath, { recursive: true });
});

afterEach(() => {
  __resetDeployLocksForTests();
});

describe("deployDevPlugin — happy path", () => {
  test("copies, registers, restarts, verifies", async () => {
    writePluginSource("trip-planner");
    writeServerConfig();
    const world = makeWorld();

    const result = await deployDevPlugin("trip-planner", "srv-1", { consentUnsigned: true }, world.deps);
    expect(result).toEqual({ ok: true, containerId: "cont-new-1", pluginStatus: "ready" });

    // Old container removed, new one started.
    expect(world.removed).toEqual(["cont-old"]);
    expect(world.started).toBe(1);

    // Files landed (node_modules included; desktop/agent files excluded).
    const target = join(volumePath, "plugins", "trip-planner");
    expect(existsSync(join(target, "manifest.json"))).toBe(true);
    expect(existsSync(join(target, "node_modules", "leftpad", "index.js"))).toBe(true);
    expect(existsSync(join(target, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(target, ".uncorded-dev.json"))).toBe(false);
    expect(existsSync(join(volumePath, "plugins", ".staging-trip-planner"))).toBe(false);

    // server.json mutated: slug registered, unsigned flag flipped (consented).
    const config = readServerConfig();
    expect(config.installed_plugins.sort()).toEqual(["text-channels", "trip-planner"]);
    expect(config.settings["allow_unsigned_plugins"]).toBe(true);

    expect(world.events.at(-1)).toMatchObject({ step: "done", status: "completed" });
  });

  test("redeploy replaces files without duplicating the registration", async () => {
    writePluginSource("trip-planner");
    writeServerConfig({ installed_plugins: ["trip-planner"], settings: { allow_unsigned_plugins: true } });
    mkdirSync(join(volumePath, "plugins", "trip-planner"), { recursive: true });
    writeFileSync(join(volumePath, "plugins", "trip-planner", "stale.txt"), "old", "utf8");

    const world = makeWorld();
    const result = await deployDevPlugin("trip-planner", "srv-1", {}, world.deps);
    expect(result.ok).toBe(true);
    expect(existsSync(join(volumePath, "plugins", "trip-planner", "stale.txt"))).toBe(false);
    expect(readServerConfig().installed_plugins).toEqual(["trip-planner"]);
  });

  test("verify degrades to unknown when Central is unreachable", async () => {
    writePluginSource("trip-planner");
    writeServerConfig({ settings: { allow_unsigned_plugins: true } });
    const world = makeWorld({ adminPlugins: null });
    const result = await deployDevPlugin("trip-planner", "srv-1", {}, world.deps);
    expect(result).toMatchObject({ ok: true, pluginStatus: "unknown" });
  });
});

describe("deployDevPlugin — preflight failures (no side effects)", () => {
  const PREFLIGHT_CASES: {
    name: string;
    setup: (world: FakeWorld) => { slug?: string; serverId?: string; world?: FakeWorld };
    code: string;
  }[] = [
    {
      name: "unknown workspace slug",
      setup: () => ({ slug: "nope" }),
      code: "WORKSPACE_NOT_FOUND",
    },
    {
      name: "manifest name != folder",
      setup: () => {
        writePluginSource("trip-planner", { name: "other-name" });
        return {};
      },
      code: "SLUG_MISMATCH",
    },
    {
      name: "reserved slug",
      setup: () => {
        writePluginSource("members");
        return { slug: "members" };
      },
      code: "SLUG_RESERVED",
    },
    {
      name: "unknown server",
      setup: () => {
        writePluginSource("trip-planner");
        return { serverId: "srv-404" };
      },
      code: "SERVER_NOT_FOUND",
    },
    {
      name: "no consent on a locked-down server",
      setup: () => {
        writePluginSource("trip-planner");
        return {};
      },
      code: "CONSENT_REQUIRED",
    },
  ];

  for (const c of PREFLIGHT_CASES) {
    test(c.name, async () => {
      const world = makeWorld();
      writeServerConfig();
      const over = c.setup(world);
      const result = await deployDevPlugin(
        over.slug ?? "trip-planner",
        over.serverId ?? "srv-1",
        c.code === "CONSENT_REQUIRED" ? {} : { consentUnsigned: true },
        world.deps,
      );
      expect(result).toMatchObject({ ok: false, code: c.code });
      // Preflight failures must not have touched the container.
      expect(world.removed).toEqual([]);
      expect(world.started).toBe(0);
    });
  }

  test("invalid manifest", async () => {
    const dir = join(workspaceDir, "trip-planner");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "manifest.json"), "{nope", "utf8");
    writeServerConfig();
    const world = makeWorld();
    const result = await deployDevPlugin("trip-planner", "srv-1", { consentUnsigned: true }, world.deps);
    expect(result).toMatchObject({ ok: false, code: "MANIFEST_INVALID" });
  });

  test("foreign /plugins folder without overwrite consent", async () => {
    writePluginSource("trip-planner");
    writeServerConfig({ settings: { allow_unsigned_plugins: true } });
    mkdirSync(join(volumePath, "plugins", "trip-planner"), { recursive: true });
    const world = makeWorld();
    const result = await deployDevPlugin("trip-planner", "srv-1", {}, world.deps);
    expect(result).toMatchObject({ ok: false, code: "SLUG_CONFLICT_EXISTING" });
    // With the flag it proceeds.
    const retry = await deployDevPlugin("trip-planner", "srv-1", { overwriteExisting: true }, world.deps);
    expect(retry.ok).toBe(true);
  });

  test("runtime without plugin_api_version is too old", async () => {
    writePluginSource("trip-planner");
    writeServerConfig({ settings: { allow_unsigned_plugins: true } });
    const world = makeWorld({ health: { status: "ok", version: "0.0.9" } });
    const result = await deployDevPlugin("trip-planner", "srv-1", {}, world.deps);
    expect(result).toMatchObject({ ok: false, code: "RUNTIME_TOO_OLD" });
  });

  test("api_version range the server can't satisfy", async () => {
    writePluginSource("trip-planner", { api_version: "^2.0" });
    writeServerConfig({ settings: { allow_unsigned_plugins: true } });
    const world = makeWorld();
    const result = await deployDevPlugin("trip-planner", "srv-1", {}, world.deps);
    expect(result).toMatchObject({ ok: false, code: "API_VERSION_INCOMPATIBLE" });
  });

  test("corrupt server.json fails closed without rewriting it", async () => {
    writePluginSource("trip-planner");
    mkdirSync(join(volumePath, "config"), { recursive: true });
    writeFileSync(join(volumePath, "config", "server.json"), "{nope", "utf8");
    const world = makeWorld();
    const result = await deployDevPlugin("trip-planner", "srv-1", { consentUnsigned: true }, world.deps);
    expect(result).toMatchObject({ ok: false, code: "CONFIG_READ_FAILED" });
    expect(readFileSync(join(volumePath, "config", "server.json"), "utf8")).toBe("{nope");
  });
});

describe("deployDevPlugin — failure after stop restarts the server", () => {
  test("container start failure surfaces CONTAINER_START_FAILED", async () => {
    writePluginSource("trip-planner");
    writeServerConfig({ settings: { allow_unsigned_plugins: true } });
    const world = makeWorld({ startThrows: true });
    const result = await deployDevPlugin("trip-planner", "srv-1", {}, world.deps);
    expect(result).toMatchObject({ ok: false, code: "CONTAINER_START_FAILED" });
  });

  test("plugin quarantined → PLUGIN_FAILED_TO_LOAD (server stays up)", async () => {
    writePluginSource("trip-planner");
    writeServerConfig({ settings: { allow_unsigned_plugins: true } });
    const world = makeWorld({ adminPlugins: [{ slug: "trip-planner", statusLabel: "quarantined" }] });
    const result = await deployDevPlugin("trip-planner", "srv-1", {}, world.deps);
    expect(result).toMatchObject({ ok: false, code: "PLUGIN_FAILED_TO_LOAD" });
    expect(world.started).toBe(1); // the server was NOT torn back down
  });
});

describe("deploy lock", () => {
  test("concurrent deploys to one server are rejected", async () => {
    writePluginSource("trip-planner");
    writeServerConfig({ settings: { allow_unsigned_plugins: true } });
    const world = makeWorld();
    const [first, second] = await Promise.all([
      deployDevPlugin("trip-planner", "srv-1", {}, world.deps),
      deployDevPlugin("trip-planner", "srv-1", {}, world.deps),
    ]);
    const codes = [first, second].map((r) => (r.ok ? "OK" : r.code)).sort();
    expect(codes).toEqual(["DEPLOY_IN_PROGRESS", "OK"]);
  });

  test("deploy is excluded by ANY holder of the shared lifecycle lock", async () => {
    // The lock is shared with runtime updates and voice rebuilds — a deploy
    // must refuse while any of them holds the server, not just other deploys.
    writePluginSource("trip-planner");
    writeServerConfig({ settings: { allow_unsigned_plugins: true } });
    const world = makeWorld();
    expect(tryAcquireServerLifecycle("srv-1")).toBe(true); // e.g. a runtime update
    try {
      const result = await deployDevPlugin("trip-planner", "srv-1", {}, world.deps);
      expect(result).toMatchObject({ ok: false, code: "DEPLOY_IN_PROGRESS" });
      expect(world.removed).toEqual([]);
    } finally {
      releaseServerLifecycle("srv-1");
    }
  });
});

describe("size guard (measureCopyBytes)", () => {
  test("counts only deployable bytes — excluded files don't count", () => {
    const dir = writePluginSource("trip-planner");
    writeFileSync(join(dir, "data.bin"), Buffer.alloc(4096));
    writeFileSync(join(dir, "AGENTS.md"), Buffer.alloc(100_000)); // excluded
    writeFileSync(join(dir, "stale.db"), Buffer.alloc(100_000)); // excluded
    const within = measureCopyBytes(dir, 1_000_000);
    expect(within.overBudget).toBe(false);
    expect(within.bytes).toBeGreaterThanOrEqual(4096);
    expect(within.bytes).toBeLessThan(100_000); // the big excluded files didn't count
  });

  test("trips the budget and short-circuits", () => {
    const dir = writePluginSource("trip-planner");
    writeFileSync(join(dir, "blob.bin"), Buffer.alloc(64 * 1024));
    expect(measureCopyBytes(dir, 1024).overBudget).toBe(true);
  });

  test("nested excluded basenames are skipped at any depth", () => {
    const dir = writePluginSource("trip-planner");
    mkdirSync(join(dir, "frontend", "assets"), { recursive: true });
    writeFileSync(join(dir, "frontend", "assets", "PROMPT.md"), Buffer.alloc(50_000)); // excluded name
    expect(measureCopyBytes(dir, 40_000).overBudget).toBe(false);
  });
});

describe("undeployDevPlugin", () => {
  test("removes files + registration, keeps data by default", async () => {
    writePluginSource("trip-planner");
    writeServerConfig({ installed_plugins: ["trip-planner"], settings: { allow_unsigned_plugins: true } });
    mkdirSync(join(volumePath, "plugins", "trip-planner"), { recursive: true });
    mkdirSync(join(volumePath, "data", "plugins", "trip-planner"), { recursive: true });
    writeFileSync(join(volumePath, "data", "plugins", "trip-planner", "trip-planner.db"), "db", "utf8");

    const world = makeWorld();
    const result = await undeployDevPlugin("trip-planner", "srv-1", { deleteData: false }, world.deps);
    expect(result).toMatchObject({ ok: true });
    expect(existsSync(join(volumePath, "plugins", "trip-planner"))).toBe(false);
    expect(readServerConfig().installed_plugins).toEqual([]);
    // Data survives so a redeploy keeps its state.
    expect(existsSync(join(volumePath, "data", "plugins", "trip-planner", "trip-planner.db"))).toBe(true);
    expect(world.started).toBe(1);
  });

  test("deleteData also clears the data dir", async () => {
    writePluginSource("trip-planner");
    writeServerConfig({ installed_plugins: ["trip-planner"], settings: { allow_unsigned_plugins: true } });
    mkdirSync(join(volumePath, "data", "plugins", "trip-planner"), { recursive: true });
    const world = makeWorld();
    const result = await undeployDevPlugin("trip-planner", "srv-1", { deleteData: true }, world.deps);
    expect(result).toMatchObject({ ok: true });
    expect(existsSync(join(volumePath, "data", "plugins", "trip-planner"))).toBe(false);
  });

  test("refuses core plugin slugs", async () => {
    writeServerConfig();
    const world = makeWorld();
    const result = await undeployDevPlugin("text-channels", "srv-1", { deleteData: false }, world.deps);
    expect(result).toMatchObject({ ok: false, code: "SLUG_RESERVED" });
  });
});

describe("caretSatisfies parity with @uncorded/shared satisfiesRange", () => {
  const CASES: [string, string][] = [
    ["1.0.0", "^1.0"],
    ["1.0.0", "^1.0.0"],
    ["1.2.3", "^1.0"],
    ["1.0.0", "^1.1"],
    ["2.0.0", "^1.0"],
    ["1.0.0", "^2.0"],
    ["1.1.0", "^1.1.1"],
    ["1.1.2", "^1.1.1"],
    ["1.0.0", "1.0"],
    ["1.0.0", "garbage"],
  ];
  for (const [version, range] of CASES) {
    test(`${version} vs ${range}`, () => {
      expect(caretSatisfies(version, range)).toBe(satisfiesRange(version, range));
    });
  }
});
