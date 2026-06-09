import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { createHttpHandler } from "./handler";
import type { HttpHandlerHandle } from "./handler";
import { RateLimiter, BAN_THRESHOLD_SHORT, BAN_DURATION_SHORT_MS } from "./rate-limiter";
import type {
  HttpDependencies,
  PluginInfo,
  PluginRegistry,
  ServerConfig,
  FileUploadNotification,
} from "./types";
import { defaultUpdateState, type RuntimeUpdateState } from "../update-state/types";
import type { TokenValidator, AuthenticatedUser, TokenValidationResult } from "../ws/types";
import type { RolesEngine } from "../roles/engine";
import type { PluginManifest } from "@uncorded/shared";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function mockManifest(overrides?: Partial<PluginManifest>): PluginManifest {
  return {
    name: "test-plugin",
    version: "1.0.0",
    api_version: "^1.0",
    author: "Test",
    description: "Test plugin",
    type: "standalone",
    permissions: ["storage.file:self"],
    ...overrides,
  };
}

function mockPluginRegistry(plugins: PluginInfo[]): PluginRegistry {
  const map = new Map(plugins.map((p) => [p.slug, p]));
  return {
    getPlugin: (slug) => map.get(slug),
    getPluginCount: () => map.size,
    listPlugins: () => [...map.values()],
    setReady(slug, ready) {
      const existing = map.get(slug);
      if (existing === undefined) return;
      map.set(slug, { ...existing, ready });
    },
  };
}

function mockTokenValidator(validTokens: Map<string, AuthenticatedUser>): TokenValidator {
  return {
    async validate(token: string): Promise<TokenValidationResult> {
      const user = validTokens.get(token);
      if (user) return { ok: true, user };
      return { ok: false, code: "INVALID_TOKEN", message: "Token is invalid." };
    },
  };
}

const TEST_ADMIN: AuthenticatedUser = {
  id: "admin-1",
  username: "admin",
  displayName: "Admin",
  avatarUrl: "",
  role: "admin",
};

const TEST_MEMBER: AuthenticatedUser = {
  id: "member-1",
  username: "member",
  displayName: "Member",
  avatarUrl: "",
  role: "member",
};

const TEST_OWNER: AuthenticatedUser = {
  id: "owner-1",
  username: "owner",
  displayName: "Owner",
  avatarUrl: "",
  role: "owner",
};

function mockRolesEngine(grantedKeys?: Record<string, ReadonlySet<string>>): RolesEngine {
  // Minimal mock that implements hasMinLevel with owner bypass + named-permission
  // check(). `grantedKeys` is a per-userId allowlist; owner always passes.
  return {
    hasMinLevel(_userId: string, level: number, caller: { userId: string; isOwner: boolean }): boolean {
      if (caller.isOwner) return true;
      // For tests: admin = level 80, member = level 10, owner = level 100
      const levels: Record<string, number> = {
        "admin-1": 80,
        "member-1": 10,
        "owner-1": 100,
      };
      return (levels[caller.userId] ?? 10) >= level;
    },
    check(userId: string, key: string, caller: { userId: string; isOwner: boolean }): boolean {
      if (caller.isOwner) return true;
      return grantedKeys?.[userId]?.has(key) ?? false;
    },
    getRole(userId: string) {
      const roles: Record<string, { id: number; name: string; level: number; isDefault: boolean; parentRole: null; createdAt: number; updatedAt: number }> = {
        "admin-1": { id: 2, name: "admin", level: 80, isDefault: true, parentRole: null, createdAt: 0, updatedAt: 0 },
        "member-1": { id: 4, name: "member", level: 10, isDefault: true, parentRole: null, createdAt: 0, updatedAt: 0 },
        "owner-1": { id: 1, name: "owner", level: 100, isDefault: true, parentRole: null, createdAt: 0, updatedAt: 0 },
      };
      return roles[userId] ?? { id: 4, name: "member", level: 10, isDefault: true, parentRole: null, createdAt: 0, updatedAt: 0 };
    },
  } as unknown as RolesEngine;
}

function mockCrudRolesEngine(): RolesEngine {
  let nextId = 5;
  const now = Date.now();
  const roles = [
    { id: 1, name: "owner", level: 100, isDefault: true, parentRole: null, createdAt: now, updatedAt: now },
    { id: 2, name: "admin", level: 80, isDefault: true, parentRole: null, createdAt: now, updatedAt: now },
    { id: 4, name: "member", level: 10, isDefault: true, parentRole: null, createdAt: now, updatedAt: now },
  ];
  return {
    hasMinLevel(userId: string, level: number, caller: { userId: string; isOwner: boolean }): boolean {
      if (caller.isOwner) return true;
      const role = userId === "admin-1" ? roles.find((r) => r.name === "admin") : roles.find((r) => r.name === "member");
      return (role?.level ?? 10) >= level;
    },
    getRole(userId: string) {
      if (userId === "owner-1") return roles.find((r) => r.name === "owner")!;
      if (userId === "admin-1") return roles.find((r) => r.name === "admin")!;
      return roles.find((r) => r.name === "member")!;
    },
    getRoles() {
      return [...roles];
    },
    getPermissions() {
      return [];
    },
    createRole(input: { name: string; level: number }) {
      const role = {
        id: nextId++,
        name: input.name,
        level: input.level,
        isDefault: false,
        parentRole: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      roles.push(role);
      return { ok: true as const, value: role };
    },
    updateRole(id: number, input: { name?: string; level?: number }) {
      const role = roles.find((r) => r.id === id);
      if (!role) return { ok: false as const, error: { code: "ROLE_NOT_FOUND", message: "not found" } };
      if (input.name !== undefined) role.name = input.name;
      if (input.level !== undefined) role.level = input.level;
      role.updatedAt = Date.now();
      return { ok: true as const, value: role };
    },
    deleteRole(id: number) {
      const idx = roles.findIndex((r) => r.id === id);
      if (idx === -1) return { ok: false as const, error: { code: "ROLE_NOT_FOUND", message: "not found" } };
      roles.splice(idx, 1);
      return { ok: true as const };
    },
    grantPermission() { return { ok: true as const }; },
    denyPermission() { return { ok: true as const }; },
    removePermissionOverride() { return { ok: true as const }; },
  } as unknown as RolesEngine;
}

const DEFAULT_TOKENS = new Map<string, AuthenticatedUser>([
  ["valid-admin-token", TEST_ADMIN],
  ["valid-member-token", TEST_MEMBER],
  ["valid-owner-token", TEST_OWNER],
]);

function defaultConfig(): ServerConfig {
  return {
    isPrivate: false,
    maxUploadBytes: 1024 * 1024, // 1MB for tests
    startedAt: Date.now() - 60_000, // started 60s ago
    serverName: "Test Server",
    serverDescription: "",
  };
}

interface TestContext {
  handler: HttpHandlerHandle;
  server: ReturnType<typeof Bun.serve>;
  baseUrl: string;
  notifications: Array<{ slug: string; notification: FileUploadNotification }>;
  tmpDir: string;
  coreDb: Database;
}

const TEST_ALLOWED_ORIGINS: readonly string[] = [
  "http://localhost:5173",
  "https://mygaming.community",
];

function createTestContext(overrides?: {
  deps?: Partial<HttpDependencies>;
  plugins?: PluginInfo[];
  tokens?: Map<string, AuthenticatedUser>;
  config?: Partial<ServerConfig>;
}): TestContext {
  const tmpDir = join(tmpdir(), `uncorded-http-test-${crypto.randomUUID()}`);
  mkdirSync(tmpDir, { recursive: true });

  const notifications: Array<{ slug: string; notification: FileUploadNotification }> = [];
  const coreDb = new Database(":memory:");
  coreDb.exec(`
    CREATE TABLE IF NOT EXISTS roles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      level INTEGER NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0,
      parent_role INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS user_roles (
      user_id TEXT NOT NULL,
      role_id INTEGER NOT NULL,
      PRIMARY KEY (user_id, role_id)
    );
    CREATE TABLE IF NOT EXISTS plugin_settings (
      slug TEXT PRIMARY KEY,
      disabled INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS admin_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      actor_user_id TEXT NOT NULL,
      actor_role TEXT NOT NULL,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cascade_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_plugin TEXT NOT NULL,
      event_topic TEXT NOT NULL,
      target_plugin TEXT NOT NULL,
      target_action TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS permissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL DEFAULT '',
      default_level INTEGER NOT NULL DEFAULT 0,
      plugin_slug TEXT NOT NULL,
      registered_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS role_permissions (
      role_id INTEGER NOT NULL,
      permission_id INTEGER NOT NULL,
      granted INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (role_id, permission_id)
    );
  `);

  const deps: HttpDependencies = {
    tokenValidator: mockTokenValidator(overrides?.tokens ?? DEFAULT_TOKENS),
    rolesEngine: mockRolesEngine(),
    coreModule: null as unknown as import("../core").CoreModule,
    coreDb,
    pluginRegistry: mockPluginRegistry(overrides?.plugins ?? []),
    getInstalledPlugins() {
      return (overrides?.plugins ?? []).map((plugin) => ({
        slug: plugin.slug,
        manifest: plugin.manifest,
      }));
    },
    getPluginRuntimeState() {
      return undefined;
    },
    getPluginLogs() {
      return [];
    },
    stopPlugin() {
      return Promise.resolve();
    },
    config: { ...defaultConfig(), ...overrides?.config },
    notifyPlugin(slug, notification) {
      notifications.push({ slug, notification });
    },
    getPluginProcess() {
      return undefined;
    },
    getPluginDb() {
      throw new Error("getPluginDb not stubbed in this test");
    },
    getClientIp() {
      return "127.0.0.1";
    },
    broadcastEventToUser() {},
    broadcastEvent() {},
    areKeysStale: () => false,
    allowedOrigins: TEST_ALLOWED_ORIGINS,
    runtimeVersion: "1.0.0-test",
    getUpdateState: () => defaultUpdateState("1.0.0-test", 1_700_000_000_000),
    setUpdateState: (patch) => ({
      ...defaultUpdateState("1.0.0-test", 1_700_000_000_000),
      ...patch,
      updatedAt: 1_700_000_000_000,
    }),
    getUpdateLog: () => [],
    ...overrides?.deps,
  };

  const handler = createHttpHandler({ deps });

  const server = Bun.serve({
    port: 0,
    fetch: handler.fetch,
  });

  return {
    handler,
    server,
    baseUrl: `http://localhost:${server.port}`,
    notifications,
    tmpDir,
    coreDb,
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

let ctx: TestContext;

afterEach(() => {
  ctx.handler.dispose();
  ctx.server.stop(true);
  ctx.coreDb.close();
  try {
    rmSync(ctx.tmpDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
});

// ---------------------------------------------------------------------------
// GET /health
// ---------------------------------------------------------------------------

describe("GET /health", () => {
  test("returns status, plugin count, and uptime", () => {
    ctx = createTestContext({
      plugins: [
        { slug: "chat", manifest: mockManifest({ name: "chat" }), dataDir: "/tmp/d", frontendDir: null, authenticatedAssets: false, ready: true },
        { slug: "voice", manifest: mockManifest({ name: "voice" }), dataDir: "/tmp/d", frontendDir: null, authenticatedAssets: false, ready: true },
      ],
    });

    return fetch(`${ctx.baseUrl}/health`).then(async (res) => {
      expect(res.status).toBe(200);
      const body = await res.json() as { status: string; version: string; plugins: number; uptime: number };
      expect(body.status).toBe("ok");
      expect(body.version).toBe("1.0.0-test");
      expect(body.plugins).toBe(2);
      expect(body.uptime).toBeGreaterThanOrEqual(0);
    });
  });

  test("requires no auth", async () => {
    ctx = createTestContext();
    const res = await fetch(`${ctx.baseUrl}/health`);
    expect(res.status).toBe(200);
  });

  test("reports the runtime version baked at build time", async () => {
    // F3: Confirms the runtime version flows from HttpDependencies into the
    // /health body. Production wires this from process.env.RUNTIME_VERSION
    // (set by docker/Dockerfile build-arg). A regression here would mean the
    // update flow's currentVersion check has nothing to compare against.
    ctx = createTestContext({
      deps: { runtimeVersion: "9.9.9-feature.42" },
    });
    const res = await fetch(`${ctx.baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as { version: string };
    expect(body.version).toBe("9.9.9-feature.42");
  });

  test("liveness stays 200 even when public-key cache is stale", async () => {
    // /health is liveness only — Docker should not yank/restart the container
    // because Central is unreachable. Routing decisions live on /ready.
    ctx = createTestContext({
      deps: { areKeysStale: () => true },
    });
    const res = await fetch(`${ctx.baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string };
    expect(body.status).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// GET /ready
// ---------------------------------------------------------------------------

describe("GET /ready", () => {
  test("returns 200 ready when subsystems are healthy", async () => {
    ctx = createTestContext();
    const res = await fetch(`${ctx.baseUrl}/ready`);
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string; version: string; uptime: number };
    expect(body.status).toBe("ready");
    expect(body.version).toBe("1.0.0-test");
    expect(body.uptime).toBeGreaterThanOrEqual(0);
  });

  test("returns 503 degraded when public-key cache is stale", async () => {
    // Stale cache means Central may have rotated out keys we still accept —
    // we fail closed so Cloudflare/load-balancers stop routing auth'd traffic
    // here. Docker keeps the container alive (see /health liveness above).
    ctx = createTestContext({
      deps: { areKeysStale: () => true },
    });
    const res = await fetch(`${ctx.baseUrl}/ready`);
    expect(res.status).toBe(503);
    const body = await res.json() as { status: string; reason?: string };
    expect(body.status).toBe("degraded");
    expect(body.reason).toBe("public-key cache stale");
  });

  test("requires no auth", async () => {
    ctx = createTestContext();
    const res = await fetch(`${ctx.baseUrl}/ready`);
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// GET /admin/api/update-state
// ---------------------------------------------------------------------------

describe("GET /admin/api/update-state", () => {
  test("returns the current update state to authenticated members (D4)", async () => {
    // D4 visibility-universal: any authenticated user can poll the pill state.
    // Only the install action is gated by `core.runtime.update`.
    const state: RuntimeUpdateState = {
      state: "available",
      errorContext: null,
      currentVersion: "1.0.0-test",
      availableVersion: "1.1.0-test",
      channel: "stable",
      progress: null,
      lastCheckedAt: 1_700_000_000_000,
      errorMessage: null,
      updatedAt: 1_700_000_000_000,
    };
    ctx = createTestContext({
      tokens: new Map([["member-token", TEST_MEMBER]]),
      deps: { getUpdateState: () => state },
    });

    const res = await fetch(`${ctx.baseUrl}/admin/api/update-state`, {
      headers: { Authorization: "Bearer member-token" },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as RuntimeUpdateState;
    expect(body).toEqual(state);
  });

  test("rejects unauthenticated requests", async () => {
    ctx = createTestContext();
    const res = await fetch(`${ctx.baseUrl}/admin/api/update-state`);
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// POST /admin/api/update-state
// ---------------------------------------------------------------------------

describe("POST /admin/api/update-state", () => {
  test("owner is allowed and the patch is applied + persisted (D5 owner-bypass)", async () => {
    const received: Array<Partial<RuntimeUpdateState>> = [];
    ctx = createTestContext({
      tokens: new Map([["owner-token", TEST_OWNER]]),
      deps: {
        setUpdateState: (patch) => {
          received.push(patch);
          return {
            ...defaultUpdateState("1.0.0-test", 1_700_000_000_000),
            ...patch,
            updatedAt: 1_700_000_000_000,
          };
        },
      },
    });

    const res = await fetch(`${ctx.baseUrl}/admin/api/update-state`, {
      method: "POST",
      headers: {
        Authorization: "Bearer owner-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ state: "checking" }),
    });
    expect(res.status).toBe(200);
    expect(received).toEqual([{ state: "checking" }]);
    const body = await res.json() as RuntimeUpdateState;
    expect(body.state).toBe("checking");
  });

  test("admin holding core.runtime.update succeeds (D5)", async () => {
    let applied = false;
    ctx = createTestContext({
      tokens: new Map([["admin-token", TEST_ADMIN]]),
      deps: {
        rolesEngine: mockRolesEngine({
          "admin-1": new Set(["core.runtime.update"]),
        }),
        setUpdateState: (patch) => {
          applied = true;
          return {
            ...defaultUpdateState("1.0.0-test", 1_700_000_000_000),
            ...patch,
            updatedAt: 1_700_000_000_000,
          };
        },
      },
    });
    const res = await fetch(`${ctx.baseUrl}/admin/api/update-state`, {
      method: "POST",
      headers: { Authorization: "Bearer admin-token", "Content-Type": "application/json" },
      body: JSON.stringify({ state: "available", availableVersion: "1.1.0" }),
    });
    expect(res.status).toBe(200);
    expect(applied).toBe(true);
  });

  test("member without permission is forbidden (D5 default level 80)", async () => {
    let applied = false;
    ctx = createTestContext({
      tokens: new Map([["member-token", TEST_MEMBER]]),
      deps: {
        // mockRolesEngine() with no granted keys — only owners pass.
        setUpdateState: (patch) => {
          applied = true;
          return { ...defaultUpdateState("1.0.0-test", 1_700_000_000_000), ...patch };
        },
      },
    });
    const res = await fetch(`${ctx.baseUrl}/admin/api/update-state`, {
      method: "POST",
      headers: { Authorization: "Bearer member-token", "Content-Type": "application/json" },
      body: JSON.stringify({ state: "checking" }),
    });
    expect(res.status).toBe(403);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("FORBIDDEN");
    expect(applied).toBe(false);
  });

  test("rejects unauthenticated requests with 401", async () => {
    ctx = createTestContext();
    const res = await fetch(`${ctx.baseUrl}/admin/api/update-state`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: "checking" }),
    });
    expect(res.status).toBe(401);
  });

  test("rejects unknown state with 400 INVALID_BODY", async () => {
    ctx = createTestContext({
      tokens: new Map([["owner-token", TEST_OWNER]]),
    });
    const res = await fetch(`${ctx.baseUrl}/admin/api/update-state`, {
      method: "POST",
      headers: { Authorization: "Bearer owner-token", "Content-Type": "application/json" },
      body: JSON.stringify({ state: "not-a-real-state" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_BODY");
  });

  test("rejects out-of-range progress with 400 INVALID_BODY", async () => {
    ctx = createTestContext({
      tokens: new Map([["owner-token", TEST_OWNER]]),
    });
    const res = await fetch(`${ctx.baseUrl}/admin/api/update-state`, {
      method: "POST",
      headers: { Authorization: "Bearer owner-token", "Content-Type": "application/json" },
      body: JSON.stringify({ progress: 250 }),
    });
    expect(res.status).toBe(400);
  });

  test("ignores caller-supplied updatedAt (store always restamps)", async () => {
    const received: Array<Partial<RuntimeUpdateState>> = [];
    ctx = createTestContext({
      tokens: new Map([["owner-token", TEST_OWNER]]),
      deps: {
        setUpdateState: (patch) => {
          received.push(patch);
          return {
            ...defaultUpdateState("1.0.0-test", 1_700_000_000_000),
            ...patch,
            updatedAt: 1_700_000_000_000,
          };
        },
      },
    });
    await fetch(`${ctx.baseUrl}/admin/api/update-state`, {
      method: "POST",
      headers: { Authorization: "Bearer owner-token", "Content-Type": "application/json" },
      body: JSON.stringify({ state: "idle", updatedAt: 99 }),
    });
    expect(received).toEqual([{ state: "idle" }]);
    expect(received[0]).not.toHaveProperty("updatedAt");
  });

  test("writes an audit log row", async () => {
    ctx = createTestContext({
      tokens: new Map([["owner-token", TEST_OWNER]]),
    });
    await fetch(`${ctx.baseUrl}/admin/api/update-state`, {
      method: "POST",
      headers: { Authorization: "Bearer owner-token", "Content-Type": "application/json" },
      body: JSON.stringify({ state: "checking" }),
    });
    const row = ctx.coreDb
      .prepare("SELECT action, target_type, target_id FROM admin_audit_log WHERE action = ?")
      .get("runtime.update_state.set") as { action: string; target_type: string; target_id: string } | undefined;
    expect(row).toBeDefined();
    expect(row?.target_type).toBe("runtime");
    expect(row?.target_id).toBe("update-state");
  });

  test("accepts a substep string and forwards it to the store", async () => {
    const received: Array<Partial<RuntimeUpdateState>> = [];
    ctx = createTestContext({
      tokens: new Map([["owner-token", TEST_OWNER]]),
      deps: {
        setUpdateState: (patch) => {
          received.push(patch);
          return {
            ...defaultUpdateState("1.0.0-test", 1_700_000_000_000),
            ...patch,
            updatedAt: 1_700_000_000_000,
          };
        },
      },
    });
    const res = await fetch(`${ctx.baseUrl}/admin/api/update-state`, {
      method: "POST",
      headers: { Authorization: "Bearer owner-token", "Content-Type": "application/json" },
      body: JSON.stringify({ state: "installing", substep: "Draining traffic" }),
    });
    expect(res.status).toBe(200);
    expect(received).toEqual([{ state: "installing", substep: "Draining traffic" }]);
  });

  test("accepts substep: null to clear", async () => {
    const received: Array<Partial<RuntimeUpdateState>> = [];
    ctx = createTestContext({
      tokens: new Map([["owner-token", TEST_OWNER]]),
      deps: {
        setUpdateState: (patch) => {
          received.push(patch);
          return {
            ...defaultUpdateState("1.0.0-test", 1_700_000_000_000),
            ...patch,
            updatedAt: 1_700_000_000_000,
          };
        },
      },
    });
    const res = await fetch(`${ctx.baseUrl}/admin/api/update-state`, {
      method: "POST",
      headers: { Authorization: "Bearer owner-token", "Content-Type": "application/json" },
      body: JSON.stringify({ substep: null }),
    });
    expect(res.status).toBe(200);
    expect(received).toEqual([{ substep: null }]);
  });

  test("rejects non-string non-null substep with 400", async () => {
    ctx = createTestContext({
      tokens: new Map([["owner-token", TEST_OWNER]]),
    });
    const res = await fetch(`${ctx.baseUrl}/admin/api/update-state`, {
      method: "POST",
      headers: { Authorization: "Bearer owner-token", "Content-Type": "application/json" },
      body: JSON.stringify({ substep: 42 }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_BODY");
  });

  test("accepts state: 'awaiting-restart' (gate between download and install)", async () => {
    const received: Array<Partial<RuntimeUpdateState>> = [];
    ctx = createTestContext({
      tokens: new Map([["owner-token", TEST_OWNER]]),
      deps: {
        setUpdateState: (patch) => {
          received.push(patch);
          return {
            ...defaultUpdateState("1.0.0-test", 1_700_000_000_000),
            ...patch,
            updatedAt: 1_700_000_000_000,
          };
        },
      },
    });
    const res = await fetch(`${ctx.baseUrl}/admin/api/update-state`, {
      method: "POST",
      headers: { Authorization: "Bearer owner-token", "Content-Type": "application/json" },
      body: JSON.stringify({ state: "awaiting-restart", substep: "Ready to restart" }),
    });
    expect(res.status).toBe(200);
    expect(received).toEqual([{ state: "awaiting-restart", substep: "Ready to restart" }]);
  });

  test("truncates substep beyond 200 chars instead of rejecting", async () => {
    const received: Array<Partial<RuntimeUpdateState>> = [];
    ctx = createTestContext({
      tokens: new Map([["owner-token", TEST_OWNER]]),
      deps: {
        setUpdateState: (patch) => {
          received.push(patch);
          return {
            ...defaultUpdateState("1.0.0-test", 1_700_000_000_000),
            ...patch,
            updatedAt: 1_700_000_000_000,
          };
        },
      },
    });
    const oversized = "x".repeat(500);
    const res = await fetch(`${ctx.baseUrl}/admin/api/update-state`, {
      method: "POST",
      headers: { Authorization: "Bearer owner-token", "Content-Type": "application/json" },
      body: JSON.stringify({ substep: oversized }),
    });
    expect(res.status).toBe(200);
    expect(received[0]?.substep).toHaveLength(200);
  });
});

// ---------------------------------------------------------------------------
// POST /admin/api/check-update
// ---------------------------------------------------------------------------

describe("POST /admin/api/check-update", () => {
  test("owner: flips state to checking, stamps lastCheckedAt, clears error fields", async () => {
    const received: Array<Partial<RuntimeUpdateState>> = [];
    ctx = createTestContext({
      tokens: new Map([["owner-token", TEST_OWNER]]),
      deps: {
        setUpdateState: (patch) => {
          received.push(patch);
          return {
            ...defaultUpdateState("1.0.0-test", 1_700_000_000_000),
            ...patch,
            updatedAt: 1_700_000_000_000,
          };
        },
      },
    });

    const res = await fetch(`${ctx.baseUrl}/admin/api/check-update`, {
      method: "POST",
      headers: { Authorization: "Bearer owner-token" },
    });
    expect(res.status).toBe(200);
    expect(received.length).toBe(1);
    const patch = received[0]!;
    expect(patch.state).toBe("checking");
    expect(typeof patch.lastCheckedAt).toBe("number");
    expect(patch.errorContext).toBe(null);
    expect(patch.errorMessage).toBe(null);
  });

  test("admin holding core.runtime.update succeeds", async () => {
    let applied = false;
    ctx = createTestContext({
      tokens: new Map([["admin-token", TEST_ADMIN]]),
      deps: {
        rolesEngine: mockRolesEngine({
          "admin-1": new Set(["core.runtime.update"]),
        }),
        setUpdateState: (patch) => {
          applied = true;
          return {
            ...defaultUpdateState("1.0.0-test", 1_700_000_000_000),
            ...patch,
            updatedAt: 1_700_000_000_000,
          };
        },
      },
    });
    const res = await fetch(`${ctx.baseUrl}/admin/api/check-update`, {
      method: "POST",
      headers: { Authorization: "Bearer admin-token" },
    });
    expect(res.status).toBe(200);
    expect(applied).toBe(true);
  });

  test("member without permission is forbidden", async () => {
    let applied = false;
    ctx = createTestContext({
      tokens: new Map([["member-token", TEST_MEMBER]]),
      deps: {
        setUpdateState: (patch) => {
          applied = true;
          return { ...defaultUpdateState("1.0.0-test", 1_700_000_000_000), ...patch };
        },
      },
    });
    const res = await fetch(`${ctx.baseUrl}/admin/api/check-update`, {
      method: "POST",
      headers: { Authorization: "Bearer member-token" },
    });
    expect(res.status).toBe(403);
    expect(applied).toBe(false);
  });

  test("rejects unauthenticated requests with 401", async () => {
    ctx = createTestContext();
    const res = await fetch(`${ctx.baseUrl}/admin/api/check-update`, {
      method: "POST",
    });
    expect(res.status).toBe(401);
  });

  test("rate-limit: a second call within the 30s window returns 429", async () => {
    // RATE_CHECK_UPDATE = 1 token / 30s, keyed per-server. Two owners (or one
    // owner clicking twice) within the window must coalesce into one transition.
    ctx = createTestContext({
      tokens: new Map([["owner-token", TEST_OWNER]]),
    });

    const first = await fetch(`${ctx.baseUrl}/admin/api/check-update`, {
      method: "POST",
      headers: { Authorization: "Bearer owner-token" },
    });
    expect(first.status).toBe(200);

    const second = await fetch(`${ctx.baseUrl}/admin/api/check-update`, {
      method: "POST",
      headers: { Authorization: "Bearer owner-token" },
    });
    expect(second.status).toBe(429);
    expect(second.headers.get("Retry-After")).toBeTruthy();
  });

  test("writes a runtime.check_update audit row", async () => {
    ctx = createTestContext({
      tokens: new Map([["owner-token", TEST_OWNER]]),
    });
    await fetch(`${ctx.baseUrl}/admin/api/check-update`, {
      method: "POST",
      headers: { Authorization: "Bearer owner-token" },
    });
    const row = ctx.coreDb
      .prepare("SELECT action, target_type, target_id FROM admin_audit_log WHERE action = ?")
      .get("runtime.check_update") as { action: string; target_type: string; target_id: string } | undefined;
    expect(row).toBeDefined();
    expect(row?.target_type).toBe("runtime");
    expect(row?.target_id).toBe("update-state");
  });
});

// ---------------------------------------------------------------------------
// GET /admin/api/update-log
// ---------------------------------------------------------------------------

describe("GET /admin/api/update-log", () => {
  const sampleEntries = [
    { ts: 1_700_000_000_000, level: "info" as const, state: "checking" as const, errorContext: null, message: "transitioned to checking" },
    { ts: 1_700_000_001_000, level: "error" as const, state: "error" as const, errorContext: "check" as const, message: "version resolve failed" },
  ];

  test("owner: returns all entries from getUpdateLog (D5 owner-bypass)", async () => {
    ctx = createTestContext({
      tokens: new Map([["owner-token", TEST_OWNER]]),
      deps: {
        getUpdateLog: () => sampleEntries,
      },
    });
    const res = await fetch(`${ctx.baseUrl}/admin/api/update-log`, {
      headers: { Authorization: "Bearer owner-token" },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { entries: typeof sampleEntries };
    expect(body.entries).toEqual(sampleEntries);
  });

  test("admin holding core.runtime.update succeeds", async () => {
    ctx = createTestContext({
      tokens: new Map([["admin-token", TEST_ADMIN]]),
      deps: {
        rolesEngine: mockRolesEngine({
          "admin-1": new Set(["core.runtime.update"]),
        }),
        getUpdateLog: () => sampleEntries,
      },
    });
    const res = await fetch(`${ctx.baseUrl}/admin/api/update-log`, {
      headers: { Authorization: "Bearer admin-token" },
    });
    expect(res.status).toBe(200);
  });

  test("member without permission is forbidden", async () => {
    ctx = createTestContext({
      tokens: new Map([["member-token", TEST_MEMBER]]),
      deps: { getUpdateLog: () => sampleEntries },
    });
    const res = await fetch(`${ctx.baseUrl}/admin/api/update-log`, {
      headers: { Authorization: "Bearer member-token" },
    });
    expect(res.status).toBe(403);
  });

  test("rejects unauthenticated requests with 401", async () => {
    ctx = createTestContext();
    const res = await fetch(`${ctx.baseUrl}/admin/api/update-log`);
    expect(res.status).toBe(401);
  });

  test("returns an empty array when the log is empty", async () => {
    ctx = createTestContext({
      tokens: new Map([["owner-token", TEST_OWNER]]),
      deps: { getUpdateLog: () => [] },
    });
    const res = await fetch(`${ctx.baseUrl}/admin/api/update-log`, {
      headers: { Authorization: "Bearer owner-token" },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { entries: unknown[] };
    expect(body.entries).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// GET /
// ---------------------------------------------------------------------------

describe("GET /", () => {
  test("returns landing page HTML", async () => {
    ctx = createTestContext();
    const res = await fetch(`${ctx.baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const text = await res.text();
    expect(text).toContain("Test Server");
    expect(text).toContain("Join server");
  });
});

// ---------------------------------------------------------------------------
// 404
// ---------------------------------------------------------------------------

describe("Unknown routes", () => {
  test("returns 404 for unknown paths", async () => {
    ctx = createTestContext();
    const res = await fetch(`${ctx.baseUrl}/nonexistent`);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /admin/ and /admin/api/*
// ---------------------------------------------------------------------------

describe("Admin routes", () => {
  // Static admin assets are served without auth — auth happens via postMessage
  // handshake after the iframe loads. Security is enforced at /admin/api/*.
  test("returns HTML without auth (public static)", async () => {
    ctx = createTestContext();
    const res = await fetch(`${ctx.baseUrl}/admin/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  test("returns HTML for non-admin user (static, unprotected)", async () => {
    ctx = createTestContext();
    const res = await fetch(`${ctx.baseUrl}/admin/`, {
      headers: { Authorization: "Bearer valid-member-token" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  test("returns stub HTML for admin user", async () => {
    ctx = createTestContext();
    const res = await fetch(`${ctx.baseUrl}/admin/`, {
      headers: { Authorization: "Bearer valid-admin-token" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  test("owner can access admin panel", async () => {
    ctx = createTestContext();
    const res = await fetch(`${ctx.baseUrl}/admin/`, {
      headers: { Authorization: "Bearer valid-owner-token" },
    });
    expect(res.status).toBe(200);
  });

  test("/admin/api/bootstrap returns admin access signal", async () => {
    ctx = createTestContext();
    const res = await fetch(`${ctx.baseUrl}/admin/api/bootstrap`, {
      headers: { Authorization: "Bearer valid-admin-token" },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { adminAccess: boolean };
    expect(body.adminAccess).toBe(true);
  });

  test("/admin/api/bootstrap returns 401 without auth", async () => {
    ctx = createTestContext();
    const res = await fetch(`${ctx.baseUrl}/admin/api/bootstrap`);
    expect(res.status).toBe(401);
  });

  test("/admin/api/bootstrap preflight echoes allowlisted origin", async () => {
    ctx = createTestContext();
    const res = await fetch(`${ctx.baseUrl}/admin/api/bootstrap`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://mygaming.community",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "authorization",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://mygaming.community");
    expect(res.headers.get("Vary")).toContain("Origin");
  });

  test("/admin/api/bootstrap GET echoes allowlisted localhost origin", async () => {
    ctx = createTestContext();
    const res = await fetch(`${ctx.baseUrl}/admin/api/bootstrap`, {
      headers: {
        Authorization: "Bearer valid-admin-token",
        Origin: "http://localhost:5173",
      },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:5173");
  });

  test("/admin/api/bootstrap GET echoes allowlisted custom domain origin", async () => {
    ctx = createTestContext();
    const res = await fetch(`${ctx.baseUrl}/admin/api/bootstrap`, {
      headers: {
        Authorization: "Bearer valid-admin-token",
        Origin: "https://mygaming.community",
      },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://mygaming.community");
  });

  test("/admin/api/bootstrap preflight from unlisted origin gets no ACAO", async () => {
    ctx = createTestContext();
    const res = await fetch(`${ctx.baseUrl}/admin/api/bootstrap`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://attacker.example.com",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "authorization",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  test("/admin/api/bootstrap GET from unlisted origin gets no ACAO", async () => {
    ctx = createTestContext();
    const res = await fetch(`${ctx.baseUrl}/admin/api/bootstrap`, {
      headers: {
        Authorization: "Bearer valid-admin-token",
        Origin: "https://attacker.example.com",
      },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  test("/admin/api/icon OPTIONS preflight from allowlisted origin echoes it", async () => {
    ctx = createTestContext();
    const res = await fetch(`${ctx.baseUrl}/admin/api/icon`, {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:5173",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:5173");
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
  });
});

describe("Admin API endpoints", () => {
  test("role CRUD endpoints work", async () => {
    ctx = createTestContext({
      deps: { rolesEngine: mockCrudRolesEngine() },
    });

    const createRes = await fetch(`${ctx.baseUrl}/admin/api/roles`, {
      method: "POST",
      headers: {
        Authorization: "Bearer valid-admin-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "vip", level: 50 }),
    });
    expect(createRes.status).toBe(201);

    const listRes = await fetch(`${ctx.baseUrl}/admin/api/roles`, {
      headers: { Authorization: "Bearer valid-admin-token" },
    });
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json() as { roles: Array<{ id: number; name: string }> };
    const createdRole = listBody.roles.find((r) => r.name === "vip");
    expect(createdRole).toBeDefined();

    const patchRes = await fetch(`${ctx.baseUrl}/admin/api/roles/${createdRole!.id}`, {
      method: "PATCH",
      headers: {
        Authorization: "Bearer valid-admin-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "vip-updated", level: 55 }),
    });
    expect(patchRes.status).toBe(200);

    const deleteRes = await fetch(`${ctx.baseUrl}/admin/api/roles/${createdRole!.id}`, {
      method: "DELETE",
      headers: { Authorization: "Bearer valid-admin-token" },
    });
    expect(deleteRes.status).toBe(200);
  });

  test("plugin listing, patching, logs, audit, and cascade endpoints work", async () => {
    ctx = createTestContext({
      plugins: [
        { slug: "chat", manifest: mockManifest({ name: "chat" }), dataDir: "/tmp/d", frontendDir: null, authenticatedAssets: false, ready: true },
        { slug: "members", manifest: mockManifest({ name: "members" }), dataDir: "/tmp/d", frontendDir: null, authenticatedAssets: false, ready: true },
      ],
    });

    const listRes = await fetch(`${ctx.baseUrl}/admin/api/plugins`, {
      headers: { Authorization: "Bearer valid-admin-token" },
    });
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json() as { plugins: Array<{ slug: string; enabled: boolean }> };
    expect(listBody.plugins[0]?.slug).toBe("chat");

    const patchRes = await fetch(`${ctx.baseUrl}/admin/api/plugins/chat`, {
      method: "PATCH",
      headers: {
        Authorization: "Bearer valid-admin-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ enabled: false }),
    });
    expect(patchRes.status).toBe(200);
    const patchBody = await patchRes.json() as {
      slug: string;
      disabled: boolean;
      stopped: boolean;
    };
    expect(patchBody).toEqual({ slug: "chat", disabled: true, stopped: true });

    const logsRes = await fetch(`${ctx.baseUrl}/admin/api/plugins/chat/logs`, {
      headers: { Authorization: "Bearer valid-admin-token" },
    });
    expect(logsRes.status).toBe(200);

    const cascadeCreate = await fetch(`${ctx.baseUrl}/admin/api/cascade`, {
      method: "POST",
      headers: {
        Authorization: "Bearer valid-admin-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sourcePlugin: "chat",
        eventTopic: "chat.message.created",
        targetPlugin: "members",
        targetAction: "sync",
        enabled: true,
      }),
    });
    expect(cascadeCreate.status).toBe(201);

    const cascadeList = await fetch(`${ctx.baseUrl}/admin/api/cascade`, {
      headers: { Authorization: "Bearer valid-admin-token" },
    });
    expect(cascadeList.status).toBe(200);
    const cascadeBody = await cascadeList.json() as { rules: Array<{ id: number }> };
    expect(cascadeBody.rules.length).toBe(1);

    const cascadeDelete = await fetch(`${ctx.baseUrl}/admin/api/cascade/${cascadeBody.rules[0]!.id}`, {
      method: "DELETE",
      headers: { Authorization: "Bearer valid-admin-token" },
    });
    expect(cascadeDelete.status).toBe(200);

    const auditRes = await fetch(`${ctx.baseUrl}/admin/api/audit`, {
      headers: { Authorization: "Bearer valid-admin-token" },
    });
    expect(auditRes.status).toBe(200);
    const auditBody = await auditRes.json() as { events: unknown[] };
    expect(auditBody.events.length).toBeGreaterThan(0);
  });

  test("cascade create validates source and target plugins are installed", async () => {
    ctx = createTestContext({
      plugins: [
        { slug: "chat", manifest: mockManifest({ name: "chat" }), dataDir: "/tmp/d", frontendDir: null, authenticatedAssets: false, ready: true },
      ],
    });

    const res = await fetch(`${ctx.baseUrl}/admin/api/cascade`, {
      method: "POST",
      headers: {
        Authorization: "Bearer valid-admin-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sourcePlugin: "chat",
        eventTopic: "chat.message.created",
        targetPlugin: "missing-plugin",
        targetAction: "sync",
        enabled: true,
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("PLUGIN_NOT_INSTALLED");
  });

  test("disabling a plugin stops it immediately", async () => {
    const stopped: string[] = [];
    ctx = createTestContext({
      plugins: [
        { slug: "chat", manifest: mockManifest({ name: "chat" }), dataDir: "/tmp/d", frontendDir: null, authenticatedAssets: false, ready: true },
      ],
      deps: {
        stopPlugin(slug: string) {
          stopped.push(slug);
          return Promise.resolve();
        },
      },
    });

    const res = await fetch(`${ctx.baseUrl}/admin/api/plugins/chat`, {
      method: "PATCH",
      headers: {
        Authorization: "Bearer valid-admin-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ enabled: false }),
    });

    expect(res.status).toBe(200);
    expect(stopped).toEqual(["chat"]);
    const body = await res.json() as { slug: string; disabled: boolean; stopped: boolean };
    expect(body).toEqual({ slug: "chat", disabled: true, stopped: true });
  });
});

// ---------------------------------------------------------------------------
// GET /plugins
// ---------------------------------------------------------------------------

describe("GET /plugins", () => {
  // Regression: shell voice manager (PR-5 §1) reads `runtime_capabilities`
  // from this response to decide whether to honor `platform.voice.connect`
  // from a plugin iframe. A refactor that drops the field would make every
  // voice connect attempt fail with `voice_media_not_granted` even though
  // the manifest grants it. Pin both `client_capabilities` and
  // `runtime_capabilities` so the surface stays load-bearing.
  test("response surfaces client_capabilities and runtime_capabilities per plugin", async () => {
    ctx = createTestContext({
      plugins: [
        {
          slug: "voice-channels",
          manifest: mockManifest({
            name: "voice-channels",
            client_capabilities: ["client.browser"],
            runtime_capabilities: ["voice.media"],
          }),
          dataDir: "/tmp/d",
          frontendDir: null,
          authenticatedAssets: false,
          ready: true,
        },
        {
          slug: "text-channels",
          manifest: mockManifest({ name: "text-channels" }),
          dataDir: "/tmp/d",
          frontendDir: null,
          authenticatedAssets: false,
          ready: true,
        },
      ],
    });
    const res = await fetch(`${ctx.baseUrl}/plugins`);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      plugins: Array<{
        slug: string;
        client_capabilities: string[];
        runtime_capabilities: string[];
      }>;
    };
    const voice = body.plugins.find((p) => p.slug === "voice-channels");
    const text = body.plugins.find((p) => p.slug === "text-channels");
    expect(voice?.client_capabilities).toEqual(["client.browser"]);
    expect(voice?.runtime_capabilities).toEqual(["voice.media"]);
    // Plugin with neither field declared: must surface as empty arrays,
    // not `undefined` — the shell uses `Array.includes` directly.
    expect(text?.client_capabilities).toEqual([]);
    expect(text?.runtime_capabilities).toEqual([]);
  });

  // Two-stage handshake: the web sidebar reads `ready` to decide whether to
  // grey out a plugin's items with a loading spinner. Plugins that opt in via
  // `serve_ready_handshake: true` start as ready=false and flip to true once
  // their `serveReady()` IPC frame fires. A regression that drops this field
  // would silently regress the loading-state UX into the old "click → silent
  // failure" pattern this whole feature was built to prevent.
  test("response surfaces ready flag per plugin", async () => {
    ctx = createTestContext({
      plugins: [
        {
          slug: "fast-plugin",
          manifest: mockManifest({ name: "fast-plugin" }),
          dataDir: "/tmp/d",
          frontendDir: null,
          authenticatedAssets: false,
          ready: true,
        },
        {
          slug: "hydrating-plugin",
          manifest: mockManifest({ name: "hydrating-plugin" }),
          dataDir: "/tmp/d",
          frontendDir: null,
          authenticatedAssets: false,
          ready: false,
        },
      ],
    });
    const res = await fetch(`${ctx.baseUrl}/plugins`);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      plugins: Array<{ slug: string; ready: boolean }>;
    };
    const fast = body.plugins.find((p) => p.slug === "fast-plugin");
    const hydrating = body.plugins.find((p) => p.slug === "hydrating-plugin");
    expect(fast?.ready).toBe(true);
    expect(hydrating?.ready).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GET /plugins/:slug/manifest.json
// ---------------------------------------------------------------------------

describe("GET /plugins/:slug/manifest.json", () => {
  test("returns manifest for existing plugin", async () => {
    const manifest = mockManifest({ name: "chat" });
    ctx = createTestContext({
      plugins: [
        { slug: "chat", manifest, dataDir: "/tmp/d", frontendDir: null, authenticatedAssets: false, ready: true },
      ],
    });
    const res = await fetch(`${ctx.baseUrl}/plugins/chat/manifest.json`);
    expect(res.status).toBe(200);
    const body = await res.json() as PluginManifest;
    expect(body.name).toBe("chat");
  });

  test("returns 404 for unknown plugin", async () => {
    ctx = createTestContext();
    const res = await fetch(`${ctx.baseUrl}/plugins/unknown/manifest.json`);
    expect(res.status).toBe(404);
  });

  test("private server requires auth for manifest", async () => {
    ctx = createTestContext({
      plugins: [
        { slug: "chat", manifest: mockManifest({ name: "chat" }), dataDir: "/tmp/d", frontendDir: null, authenticatedAssets: false, ready: true },
      ],
      config: { isPrivate: true },
    });

    // Without auth
    const res1 = await fetch(`${ctx.baseUrl}/plugins/chat/manifest.json`);
    expect(res1.status).toBe(401);

    // With auth
    const res2 = await fetch(`${ctx.baseUrl}/plugins/chat/manifest.json`, {
      headers: { Authorization: "Bearer valid-member-token" },
    });
    expect(res2.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// GET /plugins/:slug/ui/*
// ---------------------------------------------------------------------------

describe("GET /plugins/:slug/ui/*", () => {
  test("serves static files from frontend directory", async () => {
    const tmpDir = join(tmpdir(), `uncorded-ui-test-${crypto.randomUUID()}`);
    const frontendDir = join(tmpDir, "frontend");
    mkdirSync(frontendDir, { recursive: true });
    writeFileSync(join(frontendDir, "index.html"), "<html>Hello</html>");
    writeFileSync(join(frontendDir, "app.js"), "console.log('hi')");

    ctx = createTestContext({
      plugins: [
        { slug: "chat", manifest: mockManifest({ name: "chat" }), dataDir: tmpDir, frontendDir, authenticatedAssets: false, ready: true },
      ],
    });

    // Default to index.html
    const res1 = await fetch(`${ctx.baseUrl}/plugins/chat/ui/`);
    expect(res1.status).toBe(200);
    const text = await res1.text();
    expect(text).toContain("Hello");

    // Serve specific file
    const res2 = await fetch(`${ctx.baseUrl}/plugins/chat/ui/app.js`);
    expect(res2.status).toBe(200);
    expect(res2.headers.get("Access-Control-Allow-Origin")).toBe("*");

    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns 404 for plugin without frontend", async () => {
    ctx = createTestContext({
      plugins: [
        { slug: "chat", manifest: mockManifest({ name: "chat" }), dataDir: "/tmp/d", frontendDir: null, authenticatedAssets: false, ready: true },
      ],
    });
    const res = await fetch(`${ctx.baseUrl}/plugins/chat/ui/`);
    expect(res.status).toBe(404);
  });

  test("returns 404 for nonexistent file", async () => {
    const tmpDir = join(tmpdir(), `uncorded-ui-test-${crypto.randomUUID()}`);
    const frontendDir = join(tmpDir, "frontend");
    mkdirSync(frontendDir, { recursive: true });

    ctx = createTestContext({
      plugins: [
        { slug: "chat", manifest: mockManifest({ name: "chat" }), dataDir: tmpDir, frontendDir, authenticatedAssets: false, ready: true },
      ],
    });

    const res = await fetch(`${ctx.baseUrl}/plugins/chat/ui/nonexistent.js`);
    expect(res.status).toBe(404);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("blocks path traversal with ..", async () => {
    const tmpDir = join(tmpdir(), `uncorded-ui-test-${crypto.randomUUID()}`);
    const frontendDir = join(tmpDir, "frontend");
    mkdirSync(frontendDir, { recursive: true });
    writeFileSync(join(tmpDir, "secret.txt"), "should not be readable");

    ctx = createTestContext({
      plugins: [
        { slug: "chat", manifest: mockManifest({ name: "chat" }), dataDir: tmpDir, frontendDir, authenticatedAssets: false, ready: true },
      ],
    });

    const res = await fetch(`${ctx.baseUrl}/plugins/chat/ui/../secret.txt`);
    // Should be 403 or 404, never 200 with the secret content
    expect(res.status).toBeGreaterThanOrEqual(400);
    const text = await res.text();
    expect(text).not.toContain("should not be readable");

    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("requires auth when authenticatedAssets is true", async () => {
    const tmpDir = join(tmpdir(), `uncorded-ui-test-${crypto.randomUUID()}`);
    const frontendDir = join(tmpDir, "frontend");
    mkdirSync(frontendDir, { recursive: true });
    writeFileSync(join(frontendDir, "index.html"), "<html>Private</html>");

    ctx = createTestContext({
      plugins: [
        { slug: "chat", manifest: mockManifest({ name: "chat" }), dataDir: tmpDir, frontendDir, authenticatedAssets: true, ready: true },
      ],
    });

    // Without auth
    const res1 = await fetch(`${ctx.baseUrl}/plugins/chat/ui/`);
    expect(res1.status).toBe(401);

    // With auth
    const res2 = await fetch(`${ctx.baseUrl}/plugins/chat/ui/`, {
      headers: { Authorization: "Bearer valid-member-token" },
    });
    expect(res2.status).toBe(200);

    rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// POST /upload
// ---------------------------------------------------------------------------

describe("POST /upload", () => {
  test("returns 401 without auth", async () => {
    ctx = createTestContext();
    const res = await fetch(`${ctx.baseUrl}/upload`, { method: "POST" });
    expect(res.status).toBe(401);
  });

  test("returns 400 without X-Plugin header", async () => {
    ctx = createTestContext();
    const res = await fetch(`${ctx.baseUrl}/upload`, {
      method: "POST",
      headers: {
        Authorization: "Bearer valid-member-token",
        "Content-Length": "4",
        "Content-Type": "text/plain",
      },
      body: "test",
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("MISSING_PLUGIN_HEADER");
  });

  test("returns 404 for unknown plugin", async () => {
    ctx = createTestContext();
    const res = await fetch(`${ctx.baseUrl}/upload`, {
      method: "POST",
      headers: {
        Authorization: "Bearer valid-member-token",
        "X-Plugin": "nonexistent",
        "Content-Length": "4",
        "Content-Type": "text/plain",
      },
      body: "test",
    });
    expect(res.status).toBe(404);
  });

  test("returns 403 when plugin lacks storage.file:self capability", async () => {
    ctx = createTestContext({
      plugins: [
        {
          slug: "no-storage",
          manifest: mockManifest({ name: "no-storage", permissions: ["data.sql:self"] }),
          dataDir: "/tmp/d",
          frontendDir: null,
          authenticatedAssets: false,
          ready: true,
        },
      ],
    });
    const res = await fetch(`${ctx.baseUrl}/upload`, {
      method: "POST",
      headers: {
        Authorization: "Bearer valid-member-token",
        "X-Plugin": "no-storage",
        "Content-Length": "4",
        "Content-Type": "text/plain",
      },
      body: "test",
    });
    expect(res.status).toBe(403);
  });

  test("successful upload writes file and notifies plugin", async () => {
    const tmpDir = join(tmpdir(), `uncorded-upload-test-${crypto.randomUUID()}`);
    mkdirSync(tmpDir, { recursive: true });

    ctx = createTestContext({
      plugins: [
        {
          slug: "gallery",
          manifest: mockManifest({ name: "gallery", permissions: ["storage.file:self"] }),
          dataDir: tmpDir,
          frontendDir: null,
          authenticatedAssets: false,
          ready: true,
        },
      ],
    });

    // Body starts with PNG magic bytes so the sniffer recognizes image/png.
    // The runtime never trusts the client-supplied Content-Type.
    const body = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const res = await fetch(`${ctx.baseUrl}/upload`, {
      method: "POST",
      headers: {
        Authorization: "Bearer valid-member-token",
        "X-Plugin": "gallery",
        "Content-Type": "application/octet-stream",
      },
      body,
    });

    expect(res.status).toBe(201);
    const json = await res.json() as { ok: boolean; filename: string; size: number; mime: string };
    expect(json.ok).toBe(true);
    expect(json.size).toBe(8);
    expect(json.mime).toBe("image/png");
    expect(json.filename).toMatch(/^[0-9a-f-]+\.png$/);

    // Verify notification
    expect(ctx.notifications).toHaveLength(1);
    expect(ctx.notifications[0]!.slug).toBe("gallery");
    expect(ctx.notifications[0]!.notification.type).toBe("file.uploaded");
    expect(ctx.notifications[0]!.notification.uploadedBy).toBe("member-1");

    // Verify file exists
    const file = Bun.file(join(tmpDir, "uploads", json.filename));
    expect(await file.exists()).toBe(true);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns 413 for oversized upload", async () => {
    ctx = createTestContext({
      plugins: [
        {
          slug: "gallery",
          manifest: mockManifest({ name: "gallery", permissions: ["storage.file:self"] }),
          dataDir: "/tmp/d",
          frontendDir: null,
          authenticatedAssets: false,
          ready: true,
        },
      ],
      config: { maxUploadBytes: 4 },
    });

    const body = new Uint8Array(10);
    const res = await fetch(`${ctx.baseUrl}/upload`, {
      method: "POST",
      headers: {
        Authorization: "Bearer valid-member-token",
        "X-Plugin": "gallery",
        "Content-Type": "application/octet-stream",
      },
      body,
    });
    expect(res.status).toBe(413);
  });

  test("Content-Length underflow — declares 1000 bytes, sends 5", async () => {
    const tmpDir = join(tmpdir(), `uncorded-upload-test-${crypto.randomUUID()}`);
    mkdirSync(tmpDir, { recursive: true });

    ctx = createTestContext({
      plugins: [
        {
          slug: "gallery",
          manifest: mockManifest({ name: "gallery", permissions: ["storage.file:self"] }),
          dataDir: tmpDir,
          frontendDir: null,
          authenticatedAssets: false,
          ready: true,
        },
      ],
    });

    // Declare 1000 bytes but only send 5
    const body = new Uint8Array([1, 2, 3, 4, 5]);
    const res = await fetch(`${ctx.baseUrl}/upload`, {
      method: "POST",
      headers: {
        Authorization: "Bearer valid-member-token",
        "X-Plugin": "gallery",
        "Content-Type": "application/octet-stream",
        "Content-Length": "1000",
      },
      body,
    });

    // Handler should still work — either saves the short file or rejects cleanly
    // The actual body received is 5 bytes (what was actually sent), not 1000
    expect([201, 400]).toContain(res.status);
    if (res.status === 201) {
      const json = await res.json() as { ok: boolean; size: number };
      expect(json.ok).toBe(true);
      expect(json.size).toBe(5);
    }

    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns 400 for empty body", async () => {
    const tmpDir = join(tmpdir(), `uncorded-upload-test-${crypto.randomUUID()}`);
    mkdirSync(tmpDir, { recursive: true });

    ctx = createTestContext({
      plugins: [
        {
          slug: "gallery",
          manifest: mockManifest({ name: "gallery", permissions: ["storage.file:self"] }),
          dataDir: tmpDir,
          frontendDir: null,
          authenticatedAssets: false,
          ready: true,
        },
      ],
    });

    const res = await fetch(`${ctx.baseUrl}/upload`, {
      method: "POST",
      headers: {
        Authorization: "Bearer valid-member-token",
        "X-Plugin": "gallery",
        "Content-Type": "text/plain",
        "Content-Length": "0",
      },
      body: "",
    });
    expect(res.status).toBe(400);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns 400 for malformed Content-Length", async () => {
    const tmpDir = join(tmpdir(), `uncorded-upload-test-${crypto.randomUUID()}`);
    mkdirSync(tmpDir, { recursive: true });

    ctx = createTestContext({
      plugins: [
        {
          slug: "gallery",
          manifest: mockManifest({ name: "gallery", permissions: ["storage.file:self"] }),
          dataDir: tmpDir,
          frontendDir: null,
          authenticatedAssets: false,
          ready: true,
        },
      ],
    });

    const request = new Request(`${ctx.baseUrl}/upload`, {
      method: "POST",
      headers: {
        Authorization: "Bearer valid-member-token",
        "X-Plugin": "gallery",
        "Content-Type": "text/plain",
        "Content-Length": "abc",
      },
      body: "test",
    });

    const res = await ctx.handler.fetch(request);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_CONTENT_LENGTH");

    rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

describe("Rate limiting", () => {
  test("/health returns 429 when rate limit exceeded", async () => {
    let time = 0;
    const rateLimiter = new RateLimiter(() => time);
    ctx = createTestContext();
    // Re-create with custom rate limiter
    ctx.handler.dispose();
    ctx.server.stop(true);
    const deps: HttpDependencies = {
      tokenValidator: mockTokenValidator(DEFAULT_TOKENS),
      rolesEngine: mockRolesEngine(),
      coreModule: null as unknown as import("../core").CoreModule,
      coreDb: ctx.coreDb,
      pluginRegistry: mockPluginRegistry([]),
      getInstalledPlugins() { return []; },
      getPluginRuntimeState() { return undefined; },
      getPluginLogs() { return []; },
      stopPlugin() { return Promise.resolve(); },
      config: defaultConfig(),
      notifyPlugin() {},
      getPluginProcess() { return undefined; },
      getPluginDb() { throw new Error("getPluginDb not stubbed in this test"); },
      getClientIp() { return "127.0.0.1"; },
      broadcastEventToUser() {},
      broadcastEvent() {},
      areKeysStale: () => false,
      allowedOrigins: TEST_ALLOWED_ORIGINS,
      runtimeVersion: "1.0.0-test",
      getUpdateState: () => defaultUpdateState("1.0.0-test", 1_700_000_000_000),
      setUpdateState: (patch) => ({
        ...defaultUpdateState("1.0.0-test", 1_700_000_000_000),
        ...patch,
        updatedAt: 1_700_000_000_000,
      }),
      getUpdateLog: () => [],
    };
    ctx.handler = createHttpHandler({ deps, rateLimiter });
    ctx.server = Bun.serve({ port: 0, fetch: ctx.handler.fetch });
    ctx.baseUrl = `http://localhost:${ctx.server.port}`;

    // Exhaust the 60/min limit
    for (let i = 0; i < 60; i++) {
      await fetch(`${ctx.baseUrl}/health`);
    }

    const res = await fetch(`${ctx.baseUrl}/health`);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// IP ban escalation
// ---------------------------------------------------------------------------

describe("IP ban escalation", () => {
  test("bans IP after consecutive auth failures", async () => {
    let time = 0;
    const rateLimiter = new RateLimiter(() => time);
    ctx = createTestContext();
    ctx.handler.dispose();
    ctx.server.stop(true);
    const deps: HttpDependencies = {
      tokenValidator: mockTokenValidator(DEFAULT_TOKENS),
      rolesEngine: mockRolesEngine(),
      coreModule: null as unknown as import("../core").CoreModule,
      coreDb: ctx.coreDb,
      pluginRegistry: mockPluginRegistry([]),
      getInstalledPlugins() { return []; },
      getPluginRuntimeState() { return undefined; },
      getPluginLogs() { return []; },
      stopPlugin() { return Promise.resolve(); },
      config: defaultConfig(),
      notifyPlugin() {},
      getPluginProcess() { return undefined; },
      getPluginDb() { throw new Error("getPluginDb not stubbed in this test"); },
      getClientIp() { return "10.0.0.1"; },
      broadcastEventToUser() {},
      broadcastEvent() {},
      areKeysStale: () => false,
      allowedOrigins: TEST_ALLOWED_ORIGINS,
      runtimeVersion: "1.0.0-test",
      getUpdateState: () => defaultUpdateState("1.0.0-test", 1_700_000_000_000),
      setUpdateState: (patch) => ({
        ...defaultUpdateState("1.0.0-test", 1_700_000_000_000),
        ...patch,
        updatedAt: 1_700_000_000_000,
      }),
      getUpdateLog: () => [],
    };
    ctx.handler = createHttpHandler({ deps, rateLimiter });
    ctx.server = Bun.serve({ port: 0, fetch: ctx.handler.fetch });
    ctx.baseUrl = `http://localhost:${ctx.server.port}`;

    // Send BAN_THRESHOLD_SHORT invalid auth attempts to an auth-gated endpoint
    for (let i = 0; i < BAN_THRESHOLD_SHORT; i++) {
      await fetch(`${ctx.baseUrl}/admin/api/bootstrap`, {
        headers: { Authorization: "Bearer invalid-token" },
      });
    }

    // Next request should be banned (even to an unauthed endpoint)
    const res = await fetch(`${ctx.baseUrl}/health`);
    expect(res.status).toBe(429);

    // After ban expires, requests should work again
    time = BAN_DURATION_SHORT_MS + 1;
    const res2 = await fetch(`${ctx.baseUrl}/health`);
    expect(res2.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Error boundary
// ---------------------------------------------------------------------------

describe("Error boundary", () => {
  test("returns 500 on unexpected error without leaking details", async () => {
    ctx = createTestContext({
      deps: {
        getClientIp() {
          throw new Error("Unexpected crash!");
        },
      },
    });

    const res = await fetch(`${ctx.baseUrl}/health`);
    expect(res.status).toBe(500);
    const body = await res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(body.error.message).not.toContain("Unexpected crash");
  });
});

// ---------------------------------------------------------------------------
// Voice routes (spec-24 §HTTP Surface)
//
// /health/voice is unauthenticated; /admin/api/voice/* requires level >= 80.
// We mock the LiveKitSupervisor surface so these tests don't spawn livekit-server
// (the CI smoke test exercises the real binary separately).
// ---------------------------------------------------------------------------

interface MockVoiceState {
  rotateCalls: number;
  restartCalls: number;
  rotateThrows?: Error | undefined;
  restartThrows?: Error | undefined;
  health: {
    status: "ready" | "starting" | "degraded" | "unhealthy" | "disabled";
    state: string;
    livekitVersion: string | null;
    uptimeMs: number | null;
    lastError: { code: string; message: string; ts: number } | null;
    activeRooms: number;
    activeParticipants: number;
  };
  claimers: number;
}

function mockVoiceSupervisor(state: MockVoiceState): import("../voice/supervisor").LiveKitSupervisor {
  const ports: import("../voice/config").VoicePortPlan = {
    signaling: 7880,
    rtcTcp: 7881,
    rtcUdpPort: 50000,
    turnUdpPort: 3478,
  };
  return {
    health: () => Promise.resolve(state.health),
    claimerCount: () => state.claimers,
    getPorts: () => ports,
    rotateSecret: () => {
      state.rotateCalls++;
      if (state.rotateThrows) return Promise.reject(state.rotateThrows);
      return Promise.resolve();
    },
    adminRestart: () => {
      state.restartCalls++;
      if (state.restartThrows) return Promise.reject(state.restartThrows);
      return Promise.resolve();
    },
  } as unknown as import("../voice/supervisor").LiveKitSupervisor;
}

function freshVoiceState(overrides?: Partial<MockVoiceState>): MockVoiceState {
  return {
    rotateCalls: 0,
    restartCalls: 0,
    health: {
      status: "ready",
      state: "running",
      livekitVersion: "1.7.2",
      uptimeMs: 5_000,
      lastError: null,
      activeRooms: 0,
      activeParticipants: 0,
    },
    claimers: 1,
    ...overrides,
  };
}

describe("GET /health/voice", () => {
  test("returns disabled shape with 200 when supervisor not wired", async () => {
    ctx = createTestContext();
    const res = await fetch(`${ctx.baseUrl}/health/voice`);
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string; livekitVersion: null; activeRooms: number };
    expect(body.status).toBe("disabled");
    expect(body.livekitVersion).toBeNull();
    expect(body.activeRooms).toBe(0);
  });

  test("returns 200 with health body when supervisor reports ready", async () => {
    const voice = freshVoiceState();
    ctx = createTestContext({
      deps: { getVoiceSupervisor: () => mockVoiceSupervisor(voice) },
    });
    const res = await fetch(`${ctx.baseUrl}/health/voice`);
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string; livekitVersion: string };
    expect(body.status).toBe("ready");
    expect(body.livekitVersion).toBe("1.7.2");
  });

  test("returns 503 when supervisor reports unhealthy", async () => {
    const voice = freshVoiceState({
      health: {
        status: "unhealthy",
        state: "failed",
        livekitVersion: "1.7.2",
        uptimeMs: null,
        lastError: { code: "SERVICE_START_FAILED", message: "spawn failed", ts: Date.now() },
        activeRooms: 0,
        activeParticipants: 0,
      },
    });
    ctx = createTestContext({
      deps: { getVoiceSupervisor: () => mockVoiceSupervisor(voice) },
    });
    const res = await fetch(`${ctx.baseUrl}/health/voice`);
    expect(res.status).toBe(503);
    const body = await res.json() as { status: string };
    expect(body.status).toBe("unhealthy");
  });

  test("redacts lastError.message from public response", async () => {
    // Public probe is unauthed — lastError.message can leak binary paths
    // (ENOENT) or port numbers (EADDRINUSE). Public surface keeps code+ts;
    // the full message remains on /admin/api/voice/state.
    const errTs = 1_700_000_000_000;
    const voice = freshVoiceState({
      health: {
        status: "unhealthy",
        state: "failed",
        livekitVersion: "1.7.2",
        uptimeMs: null,
        lastError: {
          code: "SERVICE_START_FAILED",
          message: "ENOENT: /opt/livekit/livekit-server",
          ts: errTs,
        },
        activeRooms: 0,
        activeParticipants: 0,
      },
    });
    ctx = createTestContext({
      deps: { getVoiceSupervisor: () => mockVoiceSupervisor(voice) },
    });
    const res = await fetch(`${ctx.baseUrl}/health/voice`);
    expect(res.status).toBe(503);
    const body = await res.json() as {
      lastError: { code: string; ts: number; message?: string } | null;
    };
    expect(body.lastError).not.toBeNull();
    expect(body.lastError?.code).toBe("SERVICE_START_FAILED");
    expect(body.lastError?.ts).toBe(errTs);
    expect(body.lastError?.message).toBeUndefined();
  });

  test("requires no auth", async () => {
    ctx = createTestContext();
    const res = await fetch(`${ctx.baseUrl}/health/voice`);
    expect(res.status).toBe(200);
  });
});

describe("GET /admin/api/voice/state", () => {
  test("returns disabled shape when supervisor not wired", async () => {
    ctx = createTestContext();
    const res = await fetch(`${ctx.baseUrl}/admin/api/voice/state`, {
      headers: { Authorization: "Bearer valid-admin-token" },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      activated: boolean;
      registered: boolean;
      relayMode: string;
      ports: unknown;
      health: { status: string };
    };
    expect(body.activated).toBe(false);
    expect(body.registered).toBe(false);
    expect(body.relayMode).toBe("self_host");
    expect(body.ports).toBeNull();
    expect(body.health.status).toBe("disabled");
  });

  test("returns activated state when supervisor has claimers", async () => {
    const voice = freshVoiceState({ claimers: 2 });
    ctx = createTestContext({
      deps: {
        getVoiceSupervisor: () => mockVoiceSupervisor(voice),
        getVoiceSecretRotatedAt: () => 1_700_000_000_000,
      },
    });
    const res = await fetch(`${ctx.baseUrl}/admin/api/voice/state`, {
      headers: { Authorization: "Bearer valid-admin-token" },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      activated: boolean;
      registered: boolean;
      secretRotatedAt: number | null;
      ports: { signaling: number; rtcTcp: number; rtcUdpPort: number; turnUdpPort: number };
      health: { status: string };
    };
    expect(body.activated).toBe(true);
    expect(body.registered).toBe(true);
    expect(body.secretRotatedAt).toBe(1_700_000_000_000);
    expect(body.ports.signaling).toBe(7880);
    expect(body.ports.rtcUdpPort).toBe(50000);
    // Amendment C: TURN/STUN port surfaces alongside the MUX port so the
    // owner UI can render both rows in the voice-setup modal.
    expect(body.ports.turnUdpPort).toBe(3478);
    expect(body.health.status).toBe("ready");
  });

  test("preserves lastError.message on admin surface", async () => {
    // Counterpart to /health/voice's redaction — the admin endpoint is
    // owner-only and intentionally exposes the full operator-side detail.
    const errTs = 1_700_000_002_000;
    const voice = freshVoiceState({
      health: {
        status: "unhealthy",
        state: "failed",
        livekitVersion: "1.7.2",
        uptimeMs: null,
        lastError: {
          code: "SERVICE_START_FAILED",
          message: "ENOENT: /opt/livekit/livekit-server",
          ts: errTs,
        },
        activeRooms: 0,
        activeParticipants: 0,
      },
    });
    ctx = createTestContext({
      deps: { getVoiceSupervisor: () => mockVoiceSupervisor(voice) },
    });
    const res = await fetch(`${ctx.baseUrl}/admin/api/voice/state`, {
      headers: { Authorization: "Bearer valid-admin-token" },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      health: { lastError: { code: string; message: string; ts: number } | null };
    };
    expect(body.health.lastError?.message).toBe("ENOENT: /opt/livekit/livekit-server");
    expect(body.health.lastError?.code).toBe("SERVICE_START_FAILED");
  });

  test("returns 401 without auth", async () => {
    ctx = createTestContext();
    const res = await fetch(`${ctx.baseUrl}/admin/api/voice/state`);
    expect(res.status).toBe(401);
  });

  test("returns 403 for non-admin (member) user", async () => {
    ctx = createTestContext();
    const res = await fetch(`${ctx.baseUrl}/admin/api/voice/state`, {
      headers: { Authorization: "Bearer valid-member-token" },
    });
    expect(res.status).toBe(403);
  });
});

describe("POST /admin/api/voice/rotate-secret", () => {
  test("calls rotateSecret, records audit, returns rotatedAt", async () => {
    const voice = freshVoiceState();
    ctx = createTestContext({
      deps: {
        getVoiceSupervisor: () => mockVoiceSupervisor(voice),
        getVoiceSecretRotatedAt: () => 1_700_000_001_000,
      },
    });
    const res = await fetch(`${ctx.baseUrl}/admin/api/voice/rotate-secret`, {
      method: "POST",
      headers: { Authorization: "Bearer valid-admin-token" },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; rotatedAt: number | null };
    expect(body.ok).toBe(true);
    expect(body.rotatedAt).toBe(1_700_000_001_000);
    expect(voice.rotateCalls).toBe(1);

    // Audit log entry is written through coreDb.
    const row = ctx.coreDb
      .prepare("SELECT action, target_type, target_id FROM admin_audit_log WHERE action = ?")
      .get("voice.rotate_secret") as { action: string; target_type: string; target_id: string } | null;
    expect(row?.action).toBe("voice.rotate_secret");
    expect(row?.target_type).toBe("voice");
    expect(row?.target_id).toBe("livekit");
  });

  test("returns 409 VOICE_DISABLED when supervisor not wired", async () => {
    ctx = createTestContext();
    const res = await fetch(`${ctx.baseUrl}/admin/api/voice/rotate-secret`, {
      method: "POST",
      headers: { Authorization: "Bearer valid-admin-token" },
    });
    expect(res.status).toBe(409);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("VOICE_DISABLED");
  });

  test("returns 500 VOICE_ROTATE_FAILED when rotateSecret throws", async () => {
    const voice = freshVoiceState({ rotateThrows: new Error("rotate boom") });
    ctx = createTestContext({
      deps: { getVoiceSupervisor: () => mockVoiceSupervisor(voice) },
    });
    const res = await fetch(`${ctx.baseUrl}/admin/api/voice/rotate-secret`, {
      method: "POST",
      headers: { Authorization: "Bearer valid-admin-token" },
    });
    expect(res.status).toBe(500);
    const body = await res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("VOICE_ROTATE_FAILED");
    expect(body.error.message).toBe("rotate boom");
  });

  test("returns 401 without auth", async () => {
    ctx = createTestContext();
    const res = await fetch(`${ctx.baseUrl}/admin/api/voice/rotate-secret`, {
      method: "POST",
    });
    expect(res.status).toBe(401);
  });

  test("returns 403 for member user", async () => {
    ctx = createTestContext();
    const res = await fetch(`${ctx.baseUrl}/admin/api/voice/rotate-secret`, {
      method: "POST",
      headers: { Authorization: "Bearer valid-member-token" },
    });
    expect(res.status).toBe(403);
  });
});

describe("POST /admin/api/voice/restart", () => {
  test("calls adminRestart, records audit, returns health", async () => {
    const voice = freshVoiceState();
    ctx = createTestContext({
      deps: { getVoiceSupervisor: () => mockVoiceSupervisor(voice) },
    });
    const res = await fetch(`${ctx.baseUrl}/admin/api/voice/restart`, {
      method: "POST",
      headers: { Authorization: "Bearer valid-admin-token" },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; health: { status: string } };
    expect(body.ok).toBe(true);
    expect(body.health.status).toBe("ready");
    expect(voice.restartCalls).toBe(1);

    const row = ctx.coreDb
      .prepare("SELECT action FROM admin_audit_log WHERE action = ?")
      .get("voice.restart") as { action: string } | null;
    expect(row?.action).toBe("voice.restart");
  });

  test("returns 409 VOICE_DISABLED when supervisor not wired", async () => {
    ctx = createTestContext();
    const res = await fetch(`${ctx.baseUrl}/admin/api/voice/restart`, {
      method: "POST",
      headers: { Authorization: "Bearer valid-admin-token" },
    });
    expect(res.status).toBe(409);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("VOICE_DISABLED");
  });

  test("returns 500 VOICE_RESTART_FAILED when adminRestart throws", async () => {
    const voice = freshVoiceState({ restartThrows: new Error("restart boom") });
    ctx = createTestContext({
      deps: { getVoiceSupervisor: () => mockVoiceSupervisor(voice) },
    });
    const res = await fetch(`${ctx.baseUrl}/admin/api/voice/restart`, {
      method: "POST",
      headers: { Authorization: "Bearer valid-admin-token" },
    });
    expect(res.status).toBe(500);
    const body = await res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("VOICE_RESTART_FAILED");
    expect(body.error.message).toBe("restart boom");
  });

  test("returns 401 without auth", async () => {
    ctx = createTestContext();
    const res = await fetch(`${ctx.baseUrl}/admin/api/voice/restart`, {
      method: "POST",
    });
    expect(res.status).toBe(401);
  });

  test("returns 403 for member user", async () => {
    ctx = createTestContext();
    const res = await fetch(`${ctx.baseUrl}/admin/api/voice/restart`, {
      method: "POST",
      headers: { Authorization: "Bearer valid-member-token" },
    });
    expect(res.status).toBe(403);
  });
});

describe("POST /admin/api/voice/probe-direct-token", () => {
  // Spec-24 Amendment C diagnostic — mints a 30s LiveKit JWT scoped to a
  // synthetic probe room so the browser can run a direct-UDP-50000 ICE test.
  test("returns ok+token when voice is provisioned, records audit", async () => {
    ctx = createTestContext({
      deps: {
        getLiveKitCredentials: () =>
          Promise.resolve({ apiKey: "lk_key", apiSecret: "lk_secret" }),
        getVoicePublicUrl: () => "wss://voice.example.com",
        getServerId: () => "srv-123",
      },
    });
    const res = await fetch(`${ctx.baseUrl}/admin/api/voice/probe-direct-token`, {
      method: "POST",
      headers: { Authorization: "Bearer valid-admin-token" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      token: string;
      url: string;
      room: string;
      expiresAt: number;
    };
    expect(body.ok).toBe(true);
    expect(body.url).toBe("wss://voice.example.com");
    expect(body.room).toBe("server:srv-123:voice:__diag_direct_probe__");
    expect(body.token.split(".").length).toBe(3);
    expect(body.expiresAt).toBeGreaterThan(Date.now());

    const row = ctx.coreDb
      .prepare("SELECT action, target_type, target_id FROM admin_audit_log WHERE action = ?")
      .get("voice.probe_direct_token") as { action: string; target_type: string; target_id: string } | null;
    expect(row?.action).toBe("voice.probe_direct_token");
    expect(row?.target_type).toBe("voice");
    expect(row?.target_id).toBe("livekit");
  });

  test("returns 409 VOICE_DISABLED when voice public URL is missing", async () => {
    ctx = createTestContext({
      deps: {
        getLiveKitCredentials: () =>
          Promise.resolve({ apiKey: "lk_key", apiSecret: "lk_secret" }),
        getVoicePublicUrl: () => undefined,
        getServerId: () => "srv-123",
      },
    });
    const res = await fetch(`${ctx.baseUrl}/admin/api/voice/probe-direct-token`, {
      method: "POST",
      headers: { Authorization: "Bearer valid-admin-token" },
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("VOICE_DISABLED");
  });

  test("returns 409 VOICE_DISABLED when credentials getter is unset", async () => {
    ctx = createTestContext();
    const res = await fetch(`${ctx.baseUrl}/admin/api/voice/probe-direct-token`, {
      method: "POST",
      headers: { Authorization: "Bearer valid-admin-token" },
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("VOICE_DISABLED");
  });

  test("returns 409 VOICE_DISABLED when credential read throws", async () => {
    ctx = createTestContext({
      deps: {
        getLiveKitCredentials: () => Promise.reject(new Error("vault locked")),
        getVoicePublicUrl: () => "wss://voice.example.com",
        getServerId: () => "srv-123",
      },
    });
    const res = await fetch(`${ctx.baseUrl}/admin/api/voice/probe-direct-token`, {
      method: "POST",
      headers: { Authorization: "Bearer valid-admin-token" },
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("VOICE_DISABLED");
  });

  test("returns 401 without auth", async () => {
    ctx = createTestContext();
    const res = await fetch(`${ctx.baseUrl}/admin/api/voice/probe-direct-token`, {
      method: "POST",
    });
    expect(res.status).toBe(401);
  });

  test("returns 403 for member user", async () => {
    ctx = createTestContext({
      deps: {
        getLiveKitCredentials: () =>
          Promise.resolve({ apiKey: "lk_key", apiSecret: "lk_secret" }),
        getVoicePublicUrl: () => "wss://voice.example.com",
        getServerId: () => "srv-123",
      },
    });
    const res = await fetch(`${ctx.baseUrl}/admin/api/voice/probe-direct-token`, {
      method: "POST",
      headers: { Authorization: "Bearer valid-member-token" },
    });
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// GET /files/:slug/:filename — signed URL serve (spec-26)
// ---------------------------------------------------------------------------

describe("GET /files/:slug/:filename", () => {
  let ctx: TestContext;

  afterEach(() => {
    ctx?.handler.dispose();
    ctx?.server.stop();
    if (ctx?.tmpDir) rmSync(ctx.tmpDir, { recursive: true, force: true });
  });

  function uploadFile(slug: string, dataDir: string, payload: Uint8Array): Promise<{
    filename: string;
  }> {
    return fetch(`${ctx.baseUrl}/upload`, {
      method: "POST",
      headers: {
        Authorization: "Bearer valid-member-token",
        "X-Plugin": slug,
        "Content-Type": "application/octet-stream",
        "Content-Length": String(payload.byteLength),
      },
      body: new Blob([payload as BlobPart]),
    })
      .then((r) => r.json() as Promise<{ filename: string }>)
      .then((j) => {
        void dataDir;
        return { filename: j.filename };
      });
  }

  test("returns 403 without signature", async () => {
    ctx = createTestContext({
      plugins: [
        {
          slug: "gallery",
          manifest: mockManifest({ name: "gallery", permissions: ["storage.file:self"] }),
          dataDir: join(tmpdir(), `uc-test-${crypto.randomUUID()}`),
          frontendDir: null,
          authenticatedAssets: false,
          ready: true,
        },
      ],
    });
    const res = await fetch(`${ctx.baseUrl}/files/gallery/anything.png`);
    expect(res.status).toBe(403);
  });

  test("serves uploaded file with valid signature", async () => {
    const tmpDir = join(tmpdir(), `uc-files-${crypto.randomUUID()}`);
    mkdirSync(tmpDir, { recursive: true });
    ctx = createTestContext({
      plugins: [
        {
          slug: "gallery",
          manifest: mockManifest({ name: "gallery", permissions: ["storage.file:self"] }),
          dataDir: tmpDir,
          frontendDir: null,
          authenticatedAssets: false,
          ready: true,
        },
      ],
    });

    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    ]);
    const { filename } = await uploadFile("gallery", tmpDir, png);

    const { signFilePath, formatSignedFileUrl } = await import("../signing/files");
    const path = `/files/gallery/${filename}`;
    const sig = signFilePath(path, "member-1");
    const url = `${ctx.baseUrl}${formatSignedFileUrl(path, sig)}`;

    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-disposition")).toBe("inline");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body.byteLength).toBe(png.byteLength);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("forces attachment disposition for non-inline-safe MIME", async () => {
    const tmpDir = join(tmpdir(), `uc-files-${crypto.randomUUID()}`);
    mkdirSync(tmpDir, { recursive: true });
    ctx = createTestContext({
      plugins: [
        {
          slug: "gallery",
          manifest: mockManifest({ name: "gallery", permissions: ["storage.file:self"] }),
          dataDir: tmpDir,
          frontendDir: null,
          authenticatedAssets: false,
          ready: true,
        },
      ],
    });

    // ZIP magic → not inline safe.
    const zip = new Uint8Array([
      0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00,
      0x08, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);
    const { filename } = await uploadFile("gallery", tmpDir, zip);

    const { signFilePath, formatSignedFileUrl } = await import("../signing/files");
    const path = `/files/gallery/${filename}`;
    const sig = signFilePath(path, "member-1");
    const url = `${ctx.baseUrl}${formatSignedFileUrl(path, sig)}`;

    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toBe("attachment");
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("?download=1 flips inline-safe MIME to attachment disposition", async () => {
    const tmpDir = join(tmpdir(), `uc-files-${crypto.randomUUID()}`);
    mkdirSync(tmpDir, { recursive: true });
    ctx = createTestContext({
      plugins: [
        {
          slug: "gallery",
          manifest: mockManifest({ name: "gallery", permissions: ["storage.file:self"] }),
          dataDir: tmpDir,
          frontendDir: null,
          authenticatedAssets: false,
          ready: true,
        },
      ],
    });

    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    ]);
    const { filename } = await uploadFile("gallery", tmpDir, png);

    const { signFilePath, formatSignedFileUrl } = await import("../signing/files");
    const path = `/files/gallery/${filename}`;
    const sig = signFilePath(path, "member-1");
    const url = `${ctx.baseUrl}${formatSignedFileUrl(path, sig)}&download=1`;

    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-disposition")).toBe("attachment");
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("?n=<name> includes filename in Content-Disposition (RFC 6266)", async () => {
    const tmpDir = join(tmpdir(), `uc-files-${crypto.randomUUID()}`);
    mkdirSync(tmpDir, { recursive: true });
    ctx = createTestContext({
      plugins: [
        {
          slug: "gallery",
          manifest: mockManifest({ name: "gallery", permissions: ["storage.file:self"] }),
          dataDir: tmpDir,
          frontendDir: null,
          authenticatedAssets: false,
          ready: true,
        },
      ],
    });

    const zip = new Uint8Array([
      0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00,
      0x08, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);
    const { filename } = await uploadFile("gallery", tmpDir, zip);

    const { signFilePath, formatSignedFileUrl } = await import("../signing/files");
    const path = `/files/gallery/${filename}`;
    const sig = signFilePath(path, "member-1");
    const url = `${ctx.baseUrl}${formatSignedFileUrl(path, sig)}&n=${encodeURIComponent("My Photos 2026.zip")}`;

    const res = await fetch(url);
    expect(res.status).toBe(200);
    const disposition = res.headers.get("content-disposition");
    expect(disposition).toBe(`attachment; filename="My Photos 2026.zip"; filename*=UTF-8''My%20Photos%202026.zip`);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("?n=<name> with header-injection chars is sanitized", async () => {
    const tmpDir = join(tmpdir(), `uc-files-${crypto.randomUUID()}`);
    mkdirSync(tmpDir, { recursive: true });
    ctx = createTestContext({
      plugins: [
        {
          slug: "gallery",
          manifest: mockManifest({ name: "gallery", permissions: ["storage.file:self"] }),
          dataDir: tmpDir,
          frontendDir: null,
          authenticatedAssets: false,
          ready: true,
        },
      ],
    });

    const zip = new Uint8Array([
      0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00,
      0x08, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);
    const { filename } = await uploadFile("gallery", tmpDir, zip);

    const { signFilePath, formatSignedFileUrl } = await import("../signing/files");
    const path = `/files/gallery/${filename}`;
    const sig = signFilePath(path, "member-1");
    // Inject CR/LF + quote + backslash — all must be stripped before reaching the header.
    const malicious = `evil\r\nX-Injected: 1"a\\.zip`;
    const url = `${ctx.baseUrl}${formatSignedFileUrl(path, sig)}&n=${encodeURIComponent(malicious)}`;

    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-injected")).toBeNull();
    const disposition = res.headers.get("content-disposition") ?? "";
    expect(disposition).not.toContain("\r");
    expect(disposition).not.toContain("\n");
    expect(disposition).toContain("evilX-Injected: 1a.zip");
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns 206 for valid Range request", async () => {
    const tmpDir = join(tmpdir(), `uc-files-${crypto.randomUUID()}`);
    mkdirSync(tmpDir, { recursive: true });
    ctx = createTestContext({
      plugins: [
        {
          slug: "gallery",
          manifest: mockManifest({ name: "gallery", permissions: ["storage.file:self"] }),
          dataDir: tmpDir,
          frontendDir: null,
          authenticatedAssets: false,
          ready: true,
        },
      ],
    });

    // 100 bytes starting with PNG magic so MIME is detected.
    const body = new Uint8Array(100);
    body[0] = 0x89; body[1] = 0x50; body[2] = 0x4e; body[3] = 0x47;
    body[4] = 0x0d; body[5] = 0x0a; body[6] = 0x1a; body[7] = 0x0a;
    for (let i = 8; i < 100; i++) body[i] = i;
    const { filename } = await uploadFile("gallery", tmpDir, body);

    const { signFilePath, formatSignedFileUrl } = await import("../signing/files");
    const path = `/files/gallery/${filename}`;
    const sig = signFilePath(path, "member-1");
    const url = `${ctx.baseUrl}${formatSignedFileUrl(path, sig)}`;

    const res = await fetch(url, { headers: { Range: "bytes=10-19" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 10-19/100");
    expect(res.headers.get("content-length")).toBe("10");
    const slice = new Uint8Array(await res.arrayBuffer());
    expect(slice.byteLength).toBe(10);
    expect(slice[0]).toBe(10);
    expect(slice[9]).toBe(19);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns 416 for unsatisfiable Range", async () => {
    const tmpDir = join(tmpdir(), `uc-files-${crypto.randomUUID()}`);
    mkdirSync(tmpDir, { recursive: true });
    ctx = createTestContext({
      plugins: [
        {
          slug: "gallery",
          manifest: mockManifest({ name: "gallery", permissions: ["storage.file:self"] }),
          dataDir: tmpDir,
          frontendDir: null,
          authenticatedAssets: false,
          ready: true,
        },
      ],
    });

    const body = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
    const { filename } = await uploadFile("gallery", tmpDir, body);

    const { signFilePath, formatSignedFileUrl } = await import("../signing/files");
    const path = `/files/gallery/${filename}`;
    const sig = signFilePath(path, "member-1");
    const url = `${ctx.baseUrl}${formatSignedFileUrl(path, sig)}`;

    const res = await fetch(url, { headers: { Range: "bytes=999-9999" } });
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe(`bytes */${body.byteLength}`);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns 404 for unknown filename", async () => {
    const tmpDir = join(tmpdir(), `uc-files-${crypto.randomUUID()}`);
    mkdirSync(tmpDir, { recursive: true });
    ctx = createTestContext({
      plugins: [
        {
          slug: "gallery",
          manifest: mockManifest({ name: "gallery", permissions: ["storage.file:self"] }),
          dataDir: tmpDir,
          frontendDir: null,
          authenticatedAssets: false,
          ready: true,
        },
      ],
    });

    const { signFilePath, formatSignedFileUrl } = await import("../signing/files");
    const path = `/files/gallery/missing.png`;
    const sig = signFilePath(path, "member-1");
    const url = `${ctx.baseUrl}${formatSignedFileUrl(path, sig)}`;

    const res = await fetch(url);
    expect(res.status).toBe(404);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("rejects path traversal in filename", async () => {
    ctx = createTestContext({
      plugins: [
        {
          slug: "gallery",
          manifest: mockManifest({ name: "gallery", permissions: ["storage.file:self"] }),
          dataDir: join(tmpdir(), `uc-traversal-${crypto.randomUUID()}`),
          frontendDir: null,
          authenticatedAssets: false,
          ready: true,
        },
      ],
    });
    // Bare encoded traversal — won't match the route regex, so 404 from router.
    const res = await fetch(`${ctx.baseUrl}/files/gallery/..%2F..%2Fetc%2Fpasswd`);
    expect(res.status).toBe(404);
  });

  test("HEAD returns headers without body", async () => {
    const tmpDir = join(tmpdir(), `uc-files-${crypto.randomUUID()}`);
    mkdirSync(tmpDir, { recursive: true });
    ctx = createTestContext({
      plugins: [
        {
          slug: "gallery",
          manifest: mockManifest({ name: "gallery", permissions: ["storage.file:self"] }),
          dataDir: tmpDir,
          frontendDir: null,
          authenticatedAssets: false,
          ready: true,
        },
      ],
    });
    const body = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const { filename } = await uploadFile("gallery", tmpDir, body);

    const { signFilePath, formatSignedFileUrl } = await import("../signing/files");
    const path = `/files/gallery/${filename}`;
    const sig = signFilePath(path, "member-1");
    const url = `${ctx.baseUrl}${formatSignedFileUrl(path, sig)}`;

    const res = await fetch(url, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe(String(body.byteLength));
    expect(res.headers.get("content-type")).toBe("image/png");
    const buf = await res.arrayBuffer();
    expect(buf.byteLength).toBe(0);
    rmSync(tmpDir, { recursive: true, force: true });
  });
});
