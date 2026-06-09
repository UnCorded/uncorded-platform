import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHttpHandler, type HttpHandlerHandle } from "./handler";
import { __setProxyOverridesForTests, __resetProxyOverridesForTests } from "./proxy";
import { ENSURE_CONFIG_TABLE_SQL } from "../ipc/handlers";
import { ProxyApprovalStore, mountDefinitionHash } from "../proxy/approvals";
import { normalizeUpstream } from "../proxy/upstream";
import { ProxyConnectionRegistry, PROXY_LIMITS } from "../proxy/limits";
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
  /** Custom stub-upstream handler (receives the forwarded Request). */
  upstreamFetch?: (req: Request) => Response | Promise<Response>;
  /** Baseline address class to seed on the approval row (enables DNS drift checks). */
  approvedAddressClass?: string;
}): Harness {
  const mounts = options?.mounts ?? [{ name: "app", upstream_setting: "upstream_url" }];

  // Stub upstream server.
  const defaultUpstreamFetch = (): Response =>
    new Response("<html><body>STUB UPSTREAM</body></html>", {
      headers: { "content-type": "text/html" },
    });
  const upstreamFetch = options?.upstreamFetch ?? defaultUpstreamFetch;
  const upstream = Bun.serve({
    port: 0,
    fetch: (req) => upstreamFetch(req),
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
      approved_address_class TEXT,
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
        ...(options?.approvedAddressClass !== undefined
          ? { approved_address_class: options.approvedAddressClass }
          : {}),
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
  __resetProxyOverridesForTests();
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

/** Bootstrap a proxy session and return the replayable Cookie pair. */
async function bootstrapCookie(mount = "app", token = "member-token"): Promise<string> {
  const boot = await fetch(`${h.baseUrl}/proxy-sessions/${SLUG}/${mount}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (boot.status !== 200) throw new Error(`bootstrap failed: ${boot.status}`);
  return cookiePair(boot.headers.get("set-cookie"));
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
    const body = (await res.json()) as { url: string; openUrl: string };
    expect(body.url).toBe(`/proxy/${SLUG}/app/`);
    // The first-party fallback (Safari §4a) is returned alongside the iframe URL.
    expect(body.openUrl).toMatch(
      new RegExp(`^/proxy-open/${SLUG}/app\\?ticket=.+`),
    );
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
// First-party open handoff route (Safari/WebKit §4a)
// ---------------------------------------------------------------------------

/** Bootstrap and return the `openUrl` (the first-party handoff path + ticket). */
async function bootstrapOpenUrl(mount = "app", token = "member-token"): Promise<string> {
  const boot = await fetch(`${h.baseUrl}/proxy-sessions/${SLUG}/${mount}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (boot.status !== 200) throw new Error(`bootstrap failed: ${boot.status}`);
  const body = (await boot.json()) as { openUrl: string };
  return body.openUrl;
}

describe("GET /proxy-open/:slug/:mount", () => {
  test("a valid ticket 302s into the mount and sets the session cookie first-party", async () => {
    h = setup();
    const openUrl = await bootstrapOpenUrl();

    // The Safari shape: NO pre-existing proxy cookie — the framed bootstrap
    // Set-Cookie was blocked, so this top-level nav must mint it fresh.
    const res = await fetch(`${h.baseUrl}${openUrl}`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/proxy/${SLUG}/app/`);
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toContain(`uncorded-proxy-${SLUG}-app=`);

    // The minted cookie actually authenticates the forwarder.
    const proxied = await fetch(`${h.baseUrl}/proxy/${SLUG}/app/`, {
      headers: { Cookie: cookiePair(setCookie) },
    });
    expect(proxied.status).toBe(200);
    expect(await proxied.text()).toContain("STUB UPSTREAM");
  });

  test("a missing ticket renders an HTML error page (not JSON)", async () => {
    h = setup();
    const res = await fetch(`${h.baseUrl}/proxy-open/${SLUG}/app`, { redirect: "manual" });
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("expired or is invalid");
  });

  test("a garbage ticket renders the HTML error page", async () => {
    h = setup();
    const res = await fetch(`${h.baseUrl}/proxy-open/${SLUG}/app?ticket=not-a-real-ticket`, {
      redirect: "manual",
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  test("a session cookie value cannot be replayed as an open ticket", async () => {
    h = setup();
    // Pull the raw session-token value out of the bootstrap Set-Cookie and try
    // to use it as a handoff ticket — purpose-binding must reject it.
    const boot = await fetch(`${h.baseUrl}/proxy-sessions/${SLUG}/app`, {
      method: "POST",
      headers: { Authorization: "Bearer member-token" },
    });
    const pair = cookiePair(boot.headers.get("set-cookie"));
    const sessionToken = pair.split("=").slice(1).join("=");

    const res = await fetch(
      `${h.baseUrl}/proxy-open/${SLUG}/app?ticket=${encodeURIComponent(sessionToken)}`,
      { redirect: "manual" },
    );
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  test("the open ticket reflects the LIVE approval version after re-approval", async () => {
    h = setup();
    const openUrl = await bootstrapOpenUrl();

    // Re-approve → approval_version becomes 2. A cookie minted by the handoff
    // must carry the NEW version (resolveMount re-reads it), so it still works.
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

    const res = await fetch(`${h.baseUrl}${openUrl}`, { redirect: "manual" });
    expect(res.status).toBe(302);
    const proxied = await fetch(`${h.baseUrl}/proxy/${SLUG}/app/`, {
      headers: { Cookie: cookiePair(res.headers.get("set-cookie")) },
    });
    // Fresh cookie carries approval_version 2 → not stale.
    expect(proxied.status).toBe(200);
  });

  test("renders the HTML error page when the mount is no longer approved", async () => {
    h = setup();
    const openUrl = await bootstrapOpenUrl();
    // Drop the approval out from under the ticket.
    h.coreDb.run("DELETE FROM proxy_approvals WHERE plugin_slug = ? AND mount_name = ?", [SLUG, "app"]);

    const res = await fetch(`${h.baseUrl}${openUrl}`, { redirect: "manual" });
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("no longer available");
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

// ---------------------------------------------------------------------------
// Phase 2 — production forwarder: header policy, cookies, redirects, DNS,
// limits, streaming.
// ---------------------------------------------------------------------------

/** An upstream that echoes the forwarded request's headers, method, and body. */
function echoUpstream() {
  return async (req: Request): Promise<Response> => {
    const headers: Record<string, string> = {};
    for (const [k, v] of req.headers) headers[k.toLowerCase()] = v;
    const body = await req.text();
    return Response.json({ headers, method: req.method, body });
  };
}

interface EchoBody {
  headers: Record<string, string>;
  method: string;
  body: string;
}

describe("Phase 2: request header policy", () => {
  test("strips authorization, proxy-session cookie, and client-spoofed forwarded headers; sets runtime identity", async () => {
    h = setup({ upstreamFetch: echoUpstream() });
    const cookie = await bootstrapCookie();

    const res = await fetch(`${h.baseUrl}/proxy/${SLUG}/app/`, {
      headers: {
        Cookie: `${cookie}; app_session=keepme`,
        Authorization: "Bearer member-token",
        "x-forwarded-for": "1.2.3.4",
        "x-forwarded-proto": "https",
        "x-uncorded-user-id": "attacker",
        connection: "x-secret",
        "x-secret": "leak",
      },
    });
    expect(res.status).toBe(200);
    const echo = (await res.json()) as EchoBody;

    // Runtime credentials never reach the upstream.
    expect(echo.headers["authorization"]).toBeUndefined();
    // Connection-listed token is dropped as dynamic hop-by-hop. (The transport's
    // own `connection` header is re-added by the fetch client on the upstream
    // hop and is not one of ours.)
    expect(echo.headers["x-secret"]).toBeUndefined();

    // Client-spoofed forwarded identity is replaced with runtime-trusted values.
    expect(echo.headers["x-forwarded-for"]).toBe("127.0.0.1");
    expect(echo.headers["x-uncorded-user-id"]).toBe("member-1");

    // The proxy-session cookie is stripped; the app cookie survives.
    expect(echo.headers["cookie"]).toBe("app_session=keepme");
  });

  test("rejects an oversized inbound header set with 431", async () => {
    h = setup({ upstreamFetch: echoUpstream() });
    __setProxyOverridesForTests({ limits: { ...PROXY_LIMITS, maxRequestHeaderBytes: 8 } });
    const res = await fetch(`${h.baseUrl}/proxy/${SLUG}/app/`);
    expect(res.status).toBe(431);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PROXY_REQUEST_HEADERS_TOO_LARGE");
  });
});

describe("Phase 2: response cookie rewriting", () => {
  test("drops Domain and scopes Set-Cookie Path under the mount", async () => {
    h = setup({
      upstreamFetch: () => {
        const headers = new Headers({ "content-type": "text/html" });
        headers.append("set-cookie", "sid=abc; Domain=evil.example.com; Path=/; HttpOnly; Secure");
        headers.append("set-cookie", "pref=dark; Path=/settings");
        return new Response("ok", { headers });
      },
    });
    const cookie = await bootstrapCookie();

    const res = await fetch(`${h.baseUrl}/proxy/${SLUG}/app/`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const setCookies = res.headers.getSetCookie();

    const sid = setCookies.find((c) => c.startsWith("sid="));
    const pref = setCookies.find((c) => c.startsWith("pref="));
    expect(sid).toBeDefined();
    expect(pref).toBeDefined();
    expect(sid!.toLowerCase()).not.toContain("domain=");
    expect(sid).toContain(`Path=/proxy/${SLUG}/app`);
    expect(sid).toContain("HttpOnly");
    expect(sid).toContain("Secure");
    expect(pref).toContain(`Path=/proxy/${SLUG}/app/settings`);
  });
});

describe("Phase 2: redirect policy", () => {
  test("blocks a cross-origin redirect (SSRF to 169.254.169.254) with 502", async () => {
    h = setup({
      upstreamFetch: () =>
        new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } }),
    });
    const cookie = await bootstrapCookie();

    const res = await fetch(`${h.baseUrl}/proxy/${SLUG}/app/`, {
      headers: { Cookie: cookie },
      redirect: "manual",
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PROXY_REDIRECT_BLOCKED");
  });

  test("contains a same-origin redirect under the mount path", async () => {
    let location = "";
    h = setup({
      upstreamFetch: () => new Response(null, { status: 302, headers: { location } }),
    });
    // Build the absolute same-origin Location now that the upstream port is known.
    location = `${h.upstreamOrigin}/dashboard?tab=1`;
    const cookie = await bootstrapCookie();

    const res = await fetch(`${h.baseUrl}/proxy/${SLUG}/app/`, {
      headers: { Cookie: cookie },
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/proxy/${SLUG}/app/dashboard?tab=1`);
  });
});

describe("Phase 2: streaming body", () => {
  test("round-trips a POST request body to the upstream", async () => {
    h = setup({ upstreamFetch: echoUpstream() });
    const cookie = await bootstrapCookie();

    const res = await fetch(`${h.baseUrl}/proxy/${SLUG}/app/submit`, {
      method: "POST",
      headers: { Cookie: cookie, "content-type": "text/plain" },
      body: "hello upstream",
    });
    expect(res.status).toBe(200);
    const echo = (await res.json()) as EchoBody;
    expect(echo.method).toBe("POST");
    expect(echo.body).toBe("hello upstream");
  });
});

describe("Phase 2: concurrency caps", () => {
  test("returns 503 when the per-user connection cap is exhausted", async () => {
    h = setup({ upstreamFetch: echoUpstream() });
    const registry = new ProxyConnectionRegistry({ ...PROXY_LIMITS, maxConcurrentPerUser: 1 });
    // Pre-occupy member-1's only slot for this mount.
    const held = registry.acquire("member-1", `${SLUG}/app`);
    expect(held.ok).toBe(true);
    __setProxyOverridesForTests({ connections: registry });

    const cookie = await bootstrapCookie();
    const res = await fetch(`${h.baseUrl}/proxy/${SLUG}/app/`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("5");
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PROXY_TOO_MANY_CONNECTIONS");
  });
});

describe("Phase 2: DNS classification & drift", () => {
  test("requires re-approval when the live address class drifts from the baseline", async () => {
    h = setup({ upstreamFetch: echoUpstream(), approvedAddressClass: "loopback" });
    __setProxyOverridesForTests({
      resolveHostClasses: async () => ({ addresses: ["8.8.8.8"], classes: ["public"], representative: "public" }),
    });
    const cookie = await bootstrapCookie();

    const res = await fetch(`${h.baseUrl}/proxy/${SLUG}/app/`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PROXY_REAPPROVAL_REQUIRED");
  });

  test("allows traffic when the live class matches the baseline", async () => {
    h = setup({ upstreamFetch: echoUpstream(), approvedAddressClass: "loopback" });
    __setProxyOverridesForTests({
      resolveHostClasses: async () => ({ addresses: ["127.0.0.1"], classes: ["loopback"], representative: "loopback" }),
    });
    const cookie = await bootstrapCookie();

    const res = await fetch(`${h.baseUrl}/proxy/${SLUG}/app/`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
  });

  test("treats a null baseline as advisory only (never blocks)", async () => {
    h = setup({ upstreamFetch: echoUpstream() }); // no approvedAddressClass ⇒ null baseline
    __setProxyOverridesForTests({
      resolveHostClasses: async () => ({ addresses: ["8.8.8.8"], classes: ["public"], representative: "public" }),
    });
    const cookie = await bootstrapCookie();

    const res = await fetch(`${h.baseUrl}/proxy/${SLUG}/app/`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Phase 4 — admin approve endpoint + mount status
// ---------------------------------------------------------------------------

const APPROVE_PATH = (mount = "app") =>
  `/admin/api/plugins/${SLUG}/proxy-mounts/${mount}/approve`;

// Deterministic DNS for approve (records the address-class baseline) without
// hitting the network.
function stubLoopbackDns(): void {
  __setProxyOverridesForTests({
    resolveHostClasses: async () => ({ addresses: ["127.0.0.1"], classes: ["loopback"], representative: "loopback" }),
  });
}

describe("Phase 4: POST proxy-mounts/:mount/approve", () => {
  test("creates an approval row for a pending mount (owner)", async () => {
    h = setup({ noApproval: true });
    stubLoopbackDns();
    expect(h.approvals.get(SLUG, "app")).toBeNull();

    const res = await fetch(`${h.baseUrl}${APPROVE_PATH()}`, {
      method: "POST",
      headers: { Authorization: "Bearer owner-token" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mount: { status: string; approved_by_user_id: string | null } };
    expect(body.mount.status).toBe("approved");
    expect(body.mount.approved_by_user_id).toBe("owner-1");

    const row = h.approvals.get(SLUG, "app");
    expect(row).not.toBeNull();
    expect(row!.approval_version).toBe(1);
    expect(row!.approved_by_user_id).toBe("owner-1");
    expect(row!.approved_address_class).toBe("loopback");
  });

  test("re-approval bumps approval_version", async () => {
    h = setup(); // seeds approval_version 1
    stubLoopbackDns();
    expect(h.approvals.get(SLUG, "app")!.approval_version).toBe(1);

    const res = await fetch(`${h.baseUrl}${APPROVE_PATH()}`, {
      method: "POST",
      headers: { Authorization: "Bearer owner-token" },
    });
    expect(res.status).toBe(200);
    expect(h.approvals.get(SLUG, "app")!.approval_version).toBe(2);
  });

  test("an ordinary member cannot approve (403) and writes no row", async () => {
    h = setup({ noApproval: true });
    stubLoopbackDns();

    const res = await fetch(`${h.baseUrl}${APPROVE_PATH()}`, {
      method: "POST",
      headers: { Authorization: "Bearer member-token" },
    });
    expect(res.status).toBe(403);
    expect(h.approvals.get(SLUG, "app")).toBeNull();
  });

  test("returns 404 for an unknown mount", async () => {
    h = setup();
    stubLoopbackDns();
    const res = await fetch(`${h.baseUrl}${APPROVE_PATH("nope")}`, {
      method: "POST",
      headers: { Authorization: "Bearer owner-token" },
    });
    expect(res.status).toBe(404);
  });

  test("records an audit entry on approval", async () => {
    h = setup({ noApproval: true });
    stubLoopbackDns();
    await fetch(`${h.baseUrl}${APPROVE_PATH()}`, {
      method: "POST",
      headers: { Authorization: "Bearer owner-token" },
    });
    const audit = h.coreDb
      .query<{ action: string }, []>("SELECT action FROM admin_audit_log")
      .all();
    expect(audit.some((a) => a.action === "proxy.mount_approved")).toBe(true);
  });
});

describe("Phase 4: settings save never approves", () => {
  test("PATCH config does not create an approval row", async () => {
    h = setup({ noApproval: true });
    expect(h.approvals.get(SLUG, "app")).toBeNull();

    const res = await fetch(`${h.baseUrl}/admin/api/plugins/${SLUG}/config`, {
      method: "PATCH",
      headers: { Authorization: "Bearer owner-token", "content-type": "application/json" },
      body: JSON.stringify({ key: "upstream_url", value: "http://newhost:1234" }),
    });
    expect(res.status).toBe(200);
    // Saving a setting must never silently approve.
    expect(h.approvals.get(SLUG, "app")).toBeNull();
  });
});

interface ConfigStatusBody {
  proxy_mounts?: Array<{
    name: string;
    access: string;
    normalized_upstream: string | null;
    status: string;
    approved_by_user_id: string | null;
    warning: string | null;
  }>;
}

describe("Phase 4: GET config proxy mount status", () => {
  test("reports an approved mount with normalized upstream, access, and warning", async () => {
    h = setup(); // approved, upstream is http://localhost:<port>
    const res = await fetch(`${h.baseUrl}/admin/api/plugins/${SLUG}/config`, {
      headers: { Authorization: "Bearer owner-token" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ConfigStatusBody;
    expect(body.proxy_mounts).toHaveLength(1);
    const mount = body.proxy_mounts![0]!;
    expect(mount.name).toBe("app");
    expect(mount.access).toBe("members");
    expect(mount.status).toBe("approved");
    expect(mount.normalized_upstream).toBe(h.upstreamOrigin);
    expect(mount.approved_by_user_id).toBe("owner-1");
    // localhost upstream ⇒ loopback advisory.
    expect(mount.warning).toBe("loopback");
  });

  test("reports a pending mount when no approval exists", async () => {
    h = setup({ noApproval: true });
    const res = await fetch(`${h.baseUrl}/admin/api/plugins/${SLUG}/config`, {
      headers: { Authorization: "Bearer owner-token" },
    });
    const body = (await res.json()) as ConfigStatusBody;
    expect(body.proxy_mounts![0]!.status).toBe("pending");
    expect(body.proxy_mounts![0]!.approved_by_user_id).toBeNull();
  });

  test("reports an invalid mount when the upstream does not normalize", async () => {
    h = setup({ noApproval: true, upstreamValue: "not a url" });
    const res = await fetch(`${h.baseUrl}/admin/api/plugins/${SLUG}/config`, {
      headers: { Authorization: "Bearer owner-token" },
    });
    const body = (await res.json()) as ConfigStatusBody;
    expect(body.proxy_mounts![0]!.status).toBe("invalid");
    expect(body.proxy_mounts![0]!.normalized_upstream).toBeNull();
  });

  test("reports a drifted mount when the live upstream changed since approval", async () => {
    h = setup(); // approved against the live stub origin
    // Change the upstream out from under the approval (no re-approval).
    h.pluginDb.run("UPDATE _config SET value = ? WHERE key = ?", ["http://otherhost:9999", "upstream_url"]);
    const res = await fetch(`${h.baseUrl}/admin/api/plugins/${SLUG}/config`, {
      headers: { Authorization: "Bearer owner-token" },
    });
    const body = (await res.json()) as ConfigStatusBody;
    expect(body.proxy_mounts![0]!.status).toBe("drifted");
  });
});
