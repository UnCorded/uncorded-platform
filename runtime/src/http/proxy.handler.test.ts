import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHttpHandler, type HttpHandlerHandle } from "./handler";
import { ENSURE_CONFIG_TABLE_SQL } from "../ipc/handlers";
import { ProxyApprovalStore, mountDefinitionHash } from "../proxy/approvals";
import { normalizeUpstream } from "../proxy/upstream";
import type { HttpDependencies, PluginInfo, PluginRegistry } from "./types";
import type { TokenValidator, AuthenticatedUser, TokenValidationResult } from "../ws/types";
import type { RolesEngine } from "../roles/engine";
import { defaultUpdateState } from "../update-state/types";
import type { PluginManifest, ProxyMount } from "@uncorded/shared";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MEMBER: AuthenticatedUser = { id: "member-1", username: "m", displayName: "M", avatarUrl: "", role: "member" };
const OWNER: AuthenticatedUser = { id: "owner-1", username: "o", displayName: "O", avatarUrl: "", role: "owner" };
const SERVER_ID = "srv-test";

const TOKENS = new Map<string, AuthenticatedUser>([
  ["member-token", MEMBER],
  ["owner-token", OWNER],
]);

function tokenValidator(): TokenValidator {
  return {
    async validate(token: string): Promise<TokenValidationResult> {
      const user = TOKENS.get(token);
      return user ? { ok: true, user } : { ok: false, code: "INVALID_TOKEN", message: "bad" };
    },
  };
}

function rolesEngine(): RolesEngine {
  return {
    hasMinLevel(_u: string, _l: number, caller: { isOwner: boolean }): boolean {
      return caller.isOwner;
    },
    check(_u: string, _k: string, caller: { isOwner: boolean }): boolean {
      return caller.isOwner;
    },
    getRole() {
      return { id: 1, name: "member", level: 10, isDefault: true, parentRole: null, createdAt: 0, updatedAt: 0 };
    },
  } as unknown as RolesEngine;
}

function pluginRegistry(plugins: PluginInfo[]): PluginRegistry {
  const map = new Map(plugins.map((p) => [p.slug, p]));
  return {
    getPlugin: (s) => map.get(s),
    getPluginCount: () => map.size,
    listPlugins: () => [...map.values()],
    setReady() {},
  };
}

function proxyManifest(mounts: ProxyMount[]): PluginManifest {
  return {
    name: "test-plugin",
    version: "1.0.0",
    api_version: "^1.0",
    author: "Test",
    description: "Test",
    type: "standalone",
    permissions: ["proxy.http:self"],
    settings: [{ key: "upstream_url", label: "Upstream", type: "string" }],
    proxy_mounts: mounts,
  };
}

interface Harness {
  handler: HttpHandlerHandle;
  server: ReturnType<typeof Bun.serve>;
  baseUrl: string;
  coreDb: Database;
  pluginDb: Database;
  approvals: ProxyApprovalStore;
  upstream: ReturnType<typeof Bun.serve>;
  upstreamOrigin: string;
}

const SLUG = "test-plugin";

function setup(options?: {
  mounts?: ProxyMount[];
  /** Override the upstream value written to the plugin's _config. Defaults to the live stub origin. */
  upstreamValue?: string;
  /** Skip seeding an approval row. */
  noApproval?: boolean;
}): Harness {
  const mounts = options?.mounts ?? [{ name: "app", upstream_setting: "upstream_url" }];

  // Stub upstream server.
  const upstream = Bun.serve({
    port: 0,
    fetch() {
      return new Response("<html><body>STUB UPSTREAM</body></html>", {
        headers: { "content-type": "text/html" },
      });
    },
  });
  const upstreamOrigin = `http://localhost:${upstream.port}`;
  const upstreamValue = options?.upstreamValue ?? upstreamOrigin;

  // Core DB.
  const coreDb = new Database(":memory:");
  coreDb.exec(`
    CREATE TABLE plugin_settings (slug TEXT PRIMARY KEY, disabled INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
    CREATE TABLE admin_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, actor_user_id TEXT NOT NULL,
      actor_role TEXT NOT NULL, action TEXT NOT NULL, target_type TEXT, target_id TEXT, payload_json TEXT NOT NULL
    );
    CREATE TABLE proxy_approvals (
      plugin_slug TEXT NOT NULL, plugin_version TEXT NOT NULL, mount_name TEXT NOT NULL,
      mount_definition_hash TEXT NOT NULL, upstream_setting_key TEXT NOT NULL,
      normalized_upstream_origin TEXT NOT NULL, normalized_upstream_base_path TEXT NOT NULL,
      approved_by_user_id TEXT NOT NULL, approved_at INTEGER NOT NULL, approval_version INTEGER NOT NULL,
      PRIMARY KEY (plugin_slug, mount_name)
    );
  `);

  // Plugin DB with the upstream setting written.
  const pluginDb = new Database(":memory:");
  pluginDb.exec(ENSURE_CONFIG_TABLE_SQL);
  pluginDb.run(
    "INSERT INTO _config (key, value, type, updated_at, updated_by_user_id) VALUES (?, ?, ?, ?, ?)",
    ["upstream_url", upstreamValue, "string", Date.now(), "owner-1"],
  );

  const manifest = proxyManifest(mounts);
  const plugins: PluginInfo[] = [
    { slug: SLUG, manifest, dataDir: "", frontendDir: "", authenticatedAssets: false, ready: true },
  ];

  const approvals = new ProxyApprovalStore(coreDb);
  if (!options?.noApproval) {
    const norm = normalizeUpstream(upstreamValue);
    if (!norm.ok) throw new Error("test upstream did not normalize");
    for (const mount of mounts) {
      approvals.upsert({
        plugin_slug: SLUG,
        plugin_version: manifest.version,
        mount_name: mount.name,
        mount_definition_hash: mountDefinitionHash(mount),
        upstream_setting_key: mount.upstream_setting,
        normalized_upstream_origin: norm.origin,
        normalized_upstream_base_path: norm.basePath,
        approved_by_user_id: "owner-1",
        approved_at: Date.now(),
      });
    }
  }

  const deps: HttpDependencies = {
    tokenValidator: tokenValidator(),
    rolesEngine: rolesEngine(),
    coreModule: null as unknown as import("../core").CoreModule,
    coreDb,
    pluginRegistry: pluginRegistry(plugins),
    getInstalledPlugins: () => plugins.map((p) => ({ slug: p.slug, manifest: p.manifest })),
    getPluginRuntimeState: () => undefined,
    getPluginLogs: () => [],
    stopPlugin: () => Promise.resolve(),
    config: {
      isPrivate: false,
      maxUploadBytes: 1024 * 1024,
      startedAt: Date.now() - 1000,
      serverName: "Test",
      serverDescription: "",
    },
    notifyPlugin: () => {},
    getPluginProcess: () => undefined,
    getPluginDb: () => pluginDb,
    getClientIp: () => "127.0.0.1",
    broadcastEventToUser: () => {},
    broadcastEvent: () => {},
    areKeysStale: () => false,
    allowedOrigins: [],
    runtimeVersion: "1.0.0-test",
    getServerId: () => SERVER_ID,
    getUpdateState: () => defaultUpdateState("1.0.0-test", 1_700_000_000_000),
    setUpdateState: (patch) => ({ ...defaultUpdateState("1.0.0-test", 1_700_000_000_000), ...patch, updatedAt: 1 }),
    getUpdateLog: () => [],
  };

  const handler = createHttpHandler({ deps });
  const server = Bun.serve({ port: 0, fetch: handler.fetch });

  return {
    handler,
    server,
    baseUrl: `http://localhost:${server.port}`,
    coreDb,
    pluginDb,
    approvals,
    upstream,
    upstreamOrigin,
  };
}

let h: Harness;

afterEach(() => {
  h.handler.dispose();
  h.server.stop(true);
  h.upstream.stop(true);
  h.coreDb.close();
  h.pluginDb.close();
});

/** Extract `name=value` from a Set-Cookie header for replay as a Cookie header. */
function cookiePair(setCookie: string | null): string {
  if (!setCookie) throw new Error("no Set-Cookie header");
  return setCookie.split(";")[0] ?? "";
}

// ---------------------------------------------------------------------------
// Bootstrap route
// ---------------------------------------------------------------------------

describe("POST /proxy-sessions/:slug/:mount", () => {
  test("rejects an unauthenticated request with 401", async () => {
    h = setup();
    const res = await fetch(`${h.baseUrl}/proxy-sessions/${SLUG}/app`, { method: "POST" });
    expect(res.status).toBe(401);
  });

  test("returns 404 for an unknown mount", async () => {
    h = setup();
    const res = await fetch(`${h.baseUrl}/proxy-sessions/${SLUG}/nope`, {
      method: "POST",
      headers: { Authorization: "Bearer member-token" },
    });
    expect(res.status).toBe(404);
  });

  test("returns 409 when the mount is not approved", async () => {
    h = setup({ noApproval: true });
    const res = await fetch(`${h.baseUrl}/proxy-sessions/${SLUG}/app`, {
      method: "POST",
      headers: { Authorization: "Bearer member-token" },
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PROXY_NOT_APPROVED");
  });

  test("mints a proxy-session cookie for an approved members mount", async () => {
    h = setup();
    const res = await fetch(`${h.baseUrl}/proxy-sessions/${SLUG}/app`, {
      method: "POST",
      headers: { Authorization: "Bearer member-token" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string };
    expect(body.url).toBe(`/proxy/${SLUG}/app/`);
    expect(res.headers.get("set-cookie")).toContain(`uncorded-proxy-${SLUG}-app=`);
  });

  test("owner-only mount forbids members but allows the owner", async () => {
    h = setup({ mounts: [{ name: "app", upstream_setting: "upstream_url", access: "owner" }] });

    const memberRes = await fetch(`${h.baseUrl}/proxy-sessions/${SLUG}/app`, {
      method: "POST",
      headers: { Authorization: "Bearer member-token" },
    });
    expect(memberRes.status).toBe(403);

    const ownerRes = await fetch(`${h.baseUrl}/proxy-sessions/${SLUG}/app`, {
      method: "POST",
      headers: { Authorization: "Bearer owner-token" },
    });
    expect(ownerRes.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Proxy passthrough route
// ---------------------------------------------------------------------------

describe("ALL /proxy/:slug/:mount/*", () => {
  test("fails closed with 401 when no cookie is present", async () => {
    h = setup();
    const res = await fetch(`${h.baseUrl}/proxy/${SLUG}/app/`);
    expect(res.status).toBe(401);
  });

  test("E2E: Bearer bootstrap → cookie → no-Authorization request loads stub upstream", async () => {
    h = setup();
    // 1. Bootstrap with Bearer.
    const boot = await fetch(`${h.baseUrl}/proxy-sessions/${SLUG}/app`, {
      method: "POST",
      headers: { Authorization: "Bearer member-token" },
    });
    expect(boot.status).toBe(200);
    const cookie = cookiePair(boot.headers.get("set-cookie"));

    // 2. Browser-style request: cookie only, NO Authorization header.
    const proxied = await fetch(`${h.baseUrl}/proxy/${SLUG}/app/`, {
      headers: { Cookie: cookie },
    });
    expect(proxied.status).toBe(200);
    expect(proxied.headers.get("content-type")).toContain("text/html");
    expect(await proxied.text()).toContain("STUB UPSTREAM");
  });

  test("rejects a stale approval version with 409", async () => {
    h = setup();
    // Mint a cookie at approval_version 1.
    const boot = await fetch(`${h.baseUrl}/proxy-sessions/${SLUG}/app`, {
      method: "POST",
      headers: { Authorization: "Bearer member-token" },
    });
    const cookie = cookiePair(boot.headers.get("set-cookie"));

    // Re-approve → approval_version becomes 2; the old cookie is now stale.
    const norm = normalizeUpstream(h.upstreamOrigin);
    if (!norm.ok) throw new Error("normalize failed");
    h.approvals.upsert({
      plugin_slug: SLUG,
      plugin_version: "1.0.0",
      mount_name: "app",
      mount_definition_hash: mountDefinitionHash({ name: "app", upstream_setting: "upstream_url" }),
      upstream_setting_key: "upstream_url",
      normalized_upstream_origin: norm.origin,
      normalized_upstream_base_path: norm.basePath,
      approved_by_user_id: "owner-1",
      approved_at: Date.now(),
    });

    const proxied = await fetch(`${h.baseUrl}/proxy/${SLUG}/app/`, { headers: { Cookie: cookie } });
    expect(proxied.status).toBe(409);
  });

  test("rejects a cookie minted for a different mount", async () => {
    h = setup({
      mounts: [
        { name: "app", upstream_setting: "upstream_url" },
        { name: "admin", upstream_setting: "upstream_url" },
      ],
    });
    const boot = await fetch(`${h.baseUrl}/proxy-sessions/${SLUG}/app`, {
      method: "POST",
      headers: { Authorization: "Bearer member-token" },
    });
    const appCookie = cookiePair(boot.headers.get("set-cookie"));
    // Replay the "app" cookie value under the "admin" cookie name → name/payload mismatch.
    const adminCookieName = appCookie.replace(`uncorded-proxy-${SLUG}-app=`, `uncorded-proxy-${SLUG}-admin=`);
    const res = await fetch(`${h.baseUrl}/proxy/${SLUG}/admin/`, { headers: { Cookie: adminCookieName } });
    expect(res.status).toBe(401);
  });

  test("returns 409 when the live upstream no longer matches the approval", async () => {
    h = setup();
    const boot = await fetch(`${h.baseUrl}/proxy-sessions/${SLUG}/app`, {
      method: "POST",
      headers: { Authorization: "Bearer member-token" },
    });
    const cookie = cookiePair(boot.headers.get("set-cookie"));

    // Change the upstream setting out from under the approval (no re-approval).
    h.pluginDb.run("UPDATE _config SET value = ? WHERE key = ?", ["http://evil.example.com", "upstream_url"]);

    const res = await fetch(`${h.baseUrl}/proxy/${SLUG}/app/`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// Invalidation hook (PATCH config → approval deleted)
// ---------------------------------------------------------------------------

describe("approval invalidation on config change", () => {
  test("PATCH config for a mount's upstream setting deletes the approval", async () => {
    h = setup();
    expect(h.approvals.get(SLUG, "app")).not.toBeNull();

    const res = await fetch(`${h.baseUrl}/admin/api/plugins/${SLUG}/config`, {
      method: "PATCH",
      headers: { Authorization: "Bearer owner-token", "content-type": "application/json" },
      body: JSON.stringify({ key: "upstream_url", value: "http://newhost:1234" }),
    });
    expect(res.status).toBe(200);
    expect(h.approvals.get(SLUG, "app")).toBeNull();
  });
});
