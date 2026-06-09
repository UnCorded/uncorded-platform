// Phase 5 — Foundry plugin end-to-end verification against a Foundry-shaped
// stub upstream.
//
// No real Foundry install or license is required. We stand up a local HTTP+WS
// stub that mimics the shapes a Foundry server presents (an HTML document, a
// static asset, an app session cookie, a WebSocket endpoint, and a deep/reload
// path) and drive it through the REAL shipped `plugins/foundry-vtt/manifest.json`
// so the test proves the actual plugin — not a hand-rolled fixture — works
// through the runtime reverse proxy.
//
// A single Bun.serve composes both transports the way production does:
// createWsServer({ httpFetch: <HTTP handler>, proxyWebSocket: <WS bridge> }).
// Proxy HTTP (bootstrap + document + asset + cookie) and proxy WS share one
// port, one coreDb, and one pluginDb, so a cookie minted over HTTP validates on
// the WS upgrade exactly as a browser iframe would experience it.
//
// Proven here (per the Phase 5 acceptance list):
//   1. approve mount (the Phase 4 admin endpoint writes the approval row)
//   2. bootstrap cookie (Bearer POST mints the proxy-session cookie)
//   3. iframe loads proxied HTML (GET /proxy/.../ returns the upstream document)
//   4. static asset loads (GET /proxy/.../assets/app.js)
//   5. app cookie persists through proxy rewrite (Set-Cookie rewritten + replayed)
//   6. WebSocket connects through the proxy (echo round-trip)
//   7. "Open in browser" first-party handoff (the Safari/WebKit §4a path): the
//      bootstrap returns an `openUrl` (/proxy-open/...); navigating it top-level
//      with NO pre-existing cookie mints the session cookie first-party and 302s
//      into the mount, where the proxied Foundry HTML then loads. This is the
//      GENERIC runtime/SDK flow, not a Foundry-specific workaround.
//
// The frontend DOM-wiring ("set iframe src", "set Open-in-browser href") is
// proven separately and deterministically in
// plugins/foundry-vtt/__tests__/bootstrap.test.ts.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHttpHandler, type HttpHandlerHandle } from "./handler";
import { __setProxyOverridesForTests, __resetProxyOverridesForTests } from "./proxy";
import { createProxyWebSocket } from "./proxy-ws";
import { createWsServer, type WsServerHandle } from "../ws/server";
import { jsonCodec } from "../ws/codec";
import { SubprocessManager } from "../subprocess";
import { RateLimiter } from "./rate-limiter";
import { ENSURE_CONFIG_TABLE_SQL } from "../ipc/handlers";
import { ProxyApprovalStore } from "../proxy/approvals";
import type { HostClassification } from "../proxy/dns";
import { validateManifest, type PluginManifest } from "@uncorded/shared";
import type { HttpDependencies, PluginInfo, PluginRegistry } from "./types";
import type { TokenValidator, AuthenticatedUser, TokenValidationResult } from "../ws/types";
import type { RolesEngine } from "../roles/engine";
import { defaultUpdateState } from "../update-state/types";

// ---------------------------------------------------------------------------
// Identity fixtures
// ---------------------------------------------------------------------------

const SLUG = "foundry-vtt";
const MOUNT = "foundry";
const SERVER_ID = "srv-test";

const MEMBER: AuthenticatedUser = { id: "member-1", username: "m", displayName: "M", avatarUrl: "", role: "member" };
const OWNER: AuthenticatedUser = { id: "owner-1", username: "o", displayName: "O", avatarUrl: "", role: "owner" };
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

// Owner-only roles engine (matches proxy.handler.test.ts): only the owner clears
// the level-80 admin gate that fronts the approve endpoint.
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

// Deterministic loopback classifier — the stub upstream lives on localhost, so
// approve records a `loopback` baseline and live proxy requests match it. Avoids
// real DNS in tests.
const loopbackClasses = async (): Promise<HostClassification> => ({
  addresses: ["127.0.0.1"],
  classes: ["loopback"],
  representative: "loopback",
});

// ---------------------------------------------------------------------------
// Real manifest (loaded once, validated, then driven through the proxy)
// ---------------------------------------------------------------------------

let MANIFEST: PluginManifest;

beforeAll(() => {
  const manifestPath = resolve(import.meta.dir, "../../../plugins/foundry-vtt/manifest.json");
  const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
  const result = validateManifest(parsed);
  if (!result.ok) {
    throw new Error(`foundry-vtt manifest failed validation: ${JSON.stringify(result.errors)}`);
  }
  MANIFEST = result.manifest;
});

// ---------------------------------------------------------------------------
// Foundry-shaped stub upstream (HTTP + WebSocket)
// ---------------------------------------------------------------------------

const APP_COOKIE_NAME = "foundry_sid";
const APP_COOKIE_VALUE = "sess-abc123";

interface StubUpstream {
  server: ReturnType<typeof Bun.serve>;
  origin: string;
}

/**
 * Mimics the Foundry surfaces the proxy must carry:
 *   GET /                  → HTML document + Set-Cookie app session
 *   GET /assets/app.js     → static JS asset
 *   GET /game              → deep path / reload (another HTML document)
 *   GET /whoami            → echoes the Cookie header it received (proves cookie carriage)
 *   WS  /socket.io/        → echo frames (Foundry uses socket.io for live play)
 */
function startStubUpstream(): StubUpstream {
  const server = Bun.serve({
    port: 0,
    fetch(req, srv): Response | undefined {
      const url = new URL(req.url);

      // WebSocket upgrade (Foundry's live session channel).
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        if (srv.upgrade(req)) return undefined;
        return new Response("expected websocket", { status: 400 });
      }

      if (url.pathname === "/assets/app.js") {
        return new Response("globalThis.FOUNDRY = true;\n", {
          headers: { "content-type": "application/javascript" },
        });
      }

      if (url.pathname === "/whoami") {
        return Response.json({ cookie: req.headers.get("cookie") ?? "" });
      }

      if (url.pathname === "/game") {
        return new Response(
          "<!doctype html><html><body><main>Game View — reload OK</main></body></html>",
          { headers: { "content-type": "text/html" } },
        );
      }

      // Root document. Sets an app session cookie the way Foundry does, and
      // references the static asset by an absolute upstream path.
      const headers = new Headers({ "content-type": "text/html" });
      headers.append("set-cookie", `${APP_COOKIE_NAME}=${APP_COOKIE_VALUE}; Path=/; HttpOnly`);
      return new Response(
        '<!doctype html><html><head><title>Foundry Virtual Tabletop</title>' +
          '<script src="/assets/app.js"></script></head>' +
          "<body><main>Foundry Virtual Tabletop</main></body></html>",
        { headers },
      );
    },
    websocket: {
      message(ws, msg): void {
        ws.send(msg);
      },
    },
  });
  return { server, origin: `http://localhost:${server.port}` };
}

// ---------------------------------------------------------------------------
// Combined runtime harness — one port, HTTP proxy + WS proxy
// ---------------------------------------------------------------------------

interface Harness {
  handler: HttpHandlerHandle;
  ws: WsServerHandle;
  port: number;
  baseUrl: string;
  coreDb: Database;
  pluginDb: Database;
  approvals: ProxyApprovalStore;
  upstream: StubUpstream;
}

function setup(): Harness {
  const upstream = startStubUpstream();

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

  // The foundry mount reads `foundry_upstream_url`; point it at the live stub.
  const pluginDb = new Database(":memory:");
  pluginDb.exec(ENSURE_CONFIG_TABLE_SQL);
  pluginDb.run(
    "INSERT INTO _config (key, value, type, updated_at, updated_by_user_id) VALUES (?, ?, ?, ?, ?)",
    ["foundry_upstream_url", upstream.origin, "string", Date.now(), "owner-1"],
  );

  const plugins: PluginInfo[] = [
    { slug: SLUG, manifest: MANIFEST, dataDir: "", frontendDir: "", authenticatedAssets: false, ready: true },
  ];
  const approvals = new ProxyApprovalStore(coreDb);

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

  const proxyWebSocket = createProxyWebSocket({
    deps: {
      getInstalledPlugins: () => [{ slug: SLUG, manifest: MANIFEST }],
      coreDb,
      getPluginDb: () => pluginDb,
      getServerId: () => SERVER_ID,
    },
    rateLimiter: new RateLimiter(),
    resolveHostClasses: loopbackClasses,
  });

  const ws = createWsServer({
    port: 0,
    tokenValidator: tokenValidator(),
    subprocessManager: new SubprocessManager(),
    codec: jsonCodec,
    httpFetch: handler.fetch,
    proxyWebSocket,
  });

  const port = ws.server.port;
  if (port === undefined) throw new Error("server has no port");

  return {
    handler,
    ws,
    port,
    baseUrl: `http://localhost:${port}`,
    coreDb,
    pluginDb,
    approvals,
    upstream,
  };
}

let h: Harness;

afterEach(() => {
  __resetProxyOverridesForTests();
  // The manifest-only describe never calls setup(); nothing to tear down.
  if (!h) return;
  h.ws.stop();
  h.handler.dispose();
  h.upstream.server.stop(true);
  h.coreDb.close();
  h.pluginDb.close();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract `name=value` from a Set-Cookie header line for replay as a Cookie. */
function cookiePair(setCookie: string): string {
  return setCookie.split(";")[0] ?? "";
}

/** Approve the foundry mount through the Phase 4 admin endpoint (loopback DNS stubbed). */
async function approveFoundryMount(): Promise<Response> {
  __setProxyOverridesForTests({ resolveHostClasses: loopbackClasses });
  return fetch(`${h.baseUrl}/admin/api/plugins/${SLUG}/proxy-mounts/${MOUNT}/approve`, {
    method: "POST",
    headers: { Authorization: "Bearer owner-token" },
  });
}

/** Bootstrap a proxy session and return the response, replayable cookie pair, and URLs. */
async function bootstrap(
  token = "member-token",
): Promise<{ res: Response; cookie: string; url: string; openUrl: string }> {
  const res = await fetch(`${h.baseUrl}/proxy-sessions/${SLUG}/${MOUNT}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  const setCookie = res.headers.get("set-cookie");
  const body = res.ok
    ? ((await res.clone().json()) as { url: string; openUrl: string })
    : { url: "", openUrl: "" };
  return { res, cookie: setCookie ? cookiePair(setCookie) : "", url: body.url, openUrl: body.openUrl };
}

const wsProxyUrl = (suffix = ""): string => `ws://localhost:${h.port}/proxy/${SLUG}/${MOUNT}/${suffix}`;

type WsClientInit = { headers?: Record<string, string>; protocols?: string | string[] };
const WsClient = WebSocket as unknown as { new (url: string, init?: WsClientInit): WebSocket };

function waitOpen(ws: WebSocket, timeoutMs = 3000): Promise<void> {
  return new Promise((resolveP, reject) => {
    const t = setTimeout(() => reject(new Error("open timeout")), timeoutMs);
    ws.onopen = (): void => {
      clearTimeout(t);
      resolveP();
    };
    ws.onerror = (): void => {
      clearTimeout(t);
      reject(new Error("ws error before open"));
    };
  });
}

function nextFrame(ws: WebSocket, timeoutMs = 3000): Promise<string> {
  return new Promise((resolveP, reject) => {
    const t = setTimeout(() => reject(new Error("frame timeout")), timeoutMs);
    ws.onmessage = (ev: MessageEvent): void => {
      clearTimeout(t);
      resolveP(typeof ev.data === "string" ? ev.data : "<binary>");
    };
    ws.onerror = (): void => {
      clearTimeout(t);
      reject(new Error("ws error before frame"));
    };
  });
}

// ---------------------------------------------------------------------------
// The plugin's manifest is the real, shipped one.
// ---------------------------------------------------------------------------

describe("foundry-vtt manifest", () => {
  test("validates and declares the foundry mount with both proxy capabilities", () => {
    expect(MANIFEST.name).toBe(SLUG);
    expect(MANIFEST.permissions).toContain("proxy.http:self");
    expect(MANIFEST.permissions).toContain("proxy.websocket:self");
    const mount = (MANIFEST.proxy_mounts ?? []).find((m) => m.name === MOUNT);
    expect(mount).toBeDefined();
    expect(mount!.upstream_setting).toBe("foundry_upstream_url");
    expect((MANIFEST.settings ?? []).some((s) => s.key === "foundry_upstream_url")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Full loop against the Foundry-shaped stub.
// ---------------------------------------------------------------------------

describe("foundry-vtt proxy end-to-end (stub upstream)", () => {
  test("1. approve mount: the admin endpoint writes the approval row", async () => {
    h = setup();
    expect(h.approvals.get(SLUG, MOUNT)).toBeNull();

    const res = await approveFoundryMount();
    expect(res.status).toBe(200);

    const row = h.approvals.get(SLUG, MOUNT);
    expect(row).not.toBeNull();
    expect(row!.approved_by_user_id).toBe("owner-1");
    expect(row!.approved_address_class).toBe("loopback");
  });

  test("2. bootstrap cookie: Bearer POST mints the proxy-session cookie", async () => {
    h = setup();
    await approveFoundryMount();

    const { res, cookie, url, openUrl } = await bootstrap();
    expect(res.status).toBe(200);
    expect(cookie).toContain(`uncorded-proxy-${SLUG}-${MOUNT}=`);
    // The iframe URL is the proxied route, never the private upstream URL.
    expect(url).toBe(`/proxy/${SLUG}/${MOUNT}/`);
    expect(url.startsWith("/proxy/")).toBe(true);
    expect(url).not.toContain(h.upstream.origin);
    // And the first-party fallback handoff URL is returned alongside it (see test 7).
    expect(openUrl).toMatch(
      new RegExp(`^/proxy-open/${SLUG}/${MOUNT}\\?ticket=.+`),
    );
    expect(openUrl).not.toContain(h.upstream.origin);
  });

  test("3. iframe loads proxied HTML document", async () => {
    h = setup();
    await approveFoundryMount();
    const { cookie } = await bootstrap();

    const res = await fetch(`${h.baseUrl}/proxy/${SLUG}/${MOUNT}/`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("Foundry Virtual Tabletop");
  });

  test("4. static asset loads through the proxy", async () => {
    h = setup();
    await approveFoundryMount();
    const { cookie } = await bootstrap();

    const res = await fetch(`${h.baseUrl}/proxy/${SLUG}/${MOUNT}/assets/app.js`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    expect(await res.text()).toContain("FOUNDRY");
  });

  test("5. app cookie persists through the proxy rewrite and replays upstream", async () => {
    h = setup();
    await approveFoundryMount();
    const { cookie } = await bootstrap();

    // Load the document; the upstream sets its app session cookie.
    const docRes = await fetch(`${h.baseUrl}/proxy/${SLUG}/${MOUNT}/`, { headers: { Cookie: cookie } });
    expect(docRes.status).toBe(200);

    const appSetCookie = docRes.headers.getSetCookie().find((c) => c.startsWith(`${APP_COOKIE_NAME}=`));
    expect(appSetCookie).toBeDefined();
    // The rewrite scopes the cookie under the mount path so it cannot leak across
    // plugins/mounts, and drops any upstream Domain.
    expect(appSetCookie).toContain(`Path=/proxy/${SLUG}/${MOUNT}`);
    expect(appSetCookie!.toLowerCase()).not.toContain("domain=");

    // Replay the app cookie (as a browser would) alongside the proxy-session
    // cookie; the upstream must receive the app cookie and NOT the proxy-session.
    const appPair = cookiePair(appSetCookie!);
    const whoami = await fetch(`${h.baseUrl}/proxy/${SLUG}/${MOUNT}/whoami`, {
      headers: { Cookie: `${cookie}; ${appPair}` },
    });
    expect(whoami.status).toBe(200);
    const body = (await whoami.json()) as { cookie: string };
    expect(body.cookie).toContain(`${APP_COOKIE_NAME}=${APP_COOKIE_VALUE}`);
    expect(body.cookie).not.toContain(`uncorded-proxy-${SLUG}-${MOUNT}=`);
  });

  test("6. WebSocket connects through the proxy and echoes", async () => {
    h = setup();
    await approveFoundryMount();
    const { cookie } = await bootstrap();

    const ws = new WsClient(wsProxyUrl("socket.io/"), { headers: { Cookie: cookie } });
    await waitOpen(ws);
    ws.send("live-play");
    expect(await nextFrame(ws)).toBe("live-play");
    ws.close();
  });

  test("deep-path reload loads through the proxy", async () => {
    h = setup();
    await approveFoundryMount();
    const { cookie } = await bootstrap();

    const res = await fetch(`${h.baseUrl}/proxy/${SLUG}/${MOUNT}/game`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Game View");
  });

  test("7. open-in-browser first-party handoff mints the cookie and loads Foundry (Safari §4a)", async () => {
    h = setup();
    await approveFoundryMount();
    const { openUrl } = await bootstrap();

    // The Safari shape: the framed bootstrap Set-Cookie was blocked, so we arrive
    // at the handoff with NO proxy-session cookie. The top-level navigation must
    // mint it first-party and redirect into the mount.
    const handoff = await fetch(`${h.baseUrl}${openUrl}`, { redirect: "manual" });
    expect(handoff.status).toBe(302);
    expect(handoff.headers.get("location")).toBe(`/proxy/${SLUG}/${MOUNT}/`);
    const setCookie = handoff.headers.get("set-cookie");
    expect(setCookie).toContain(`uncorded-proxy-${SLUG}-${MOUNT}=`);

    // Following the redirect with the freshly-minted cookie loads the proxied
    // Foundry document — the same end state the framed path reaches elsewhere.
    const doc = await fetch(`${h.baseUrl}/proxy/${SLUG}/${MOUNT}/`, {
      headers: { Cookie: cookiePair(setCookie!) },
    });
    expect(doc.status).toBe(200);
    expect(doc.headers.get("content-type")).toContain("text/html");
    expect(await doc.text()).toContain("Foundry Virtual Tabletop");
  });

  test("fails closed: no proxy-session cookie ⇒ 401, never reaches upstream", async () => {
    h = setup();
    await approveFoundryMount();

    const res = await fetch(`${h.baseUrl}/proxy/${SLUG}/${MOUNT}/`);
    expect(res.status).toBe(401);
  });
});
