// Phase 3 — reverse-proxy WebSocket bridge tests.
//
// These exercise the real composition: createWsServer() with a createProxyWebSocket()
// bridge wired in, fronting a local upstream WS echo server. We connect a real
// browser-style WebSocket client through the runtime to the upstream and assert
// the bridge behavior end to end.

import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createWsServer, type WsServerHandle } from "../ws/server";
import { createProxyWebSocket } from "./proxy-ws";
import { jsonCodec } from "../ws/codec";
import { SubprocessManager } from "../subprocess";
import { RateLimiter } from "./rate-limiter";
import { ENSURE_CONFIG_TABLE_SQL } from "../ipc/handlers";
import { ProxyApprovalStore, mountDefinitionHash } from "../proxy/approvals";
import { normalizeUpstream } from "../proxy/upstream";
import { mintProxySession } from "../proxy/session";
import type { HostClassification } from "../proxy/dns";
import type { AuthenticatedUser, TokenValidator, TokenValidationResult } from "../ws/types";
import type { PluginManifest, ProxyMount } from "@uncorded/shared";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SLUG = "test-plugin";
const SERVER_ID = "srv-test";
const MEMBER: AuthenticatedUser = {
  id: "member-1",
  username: "m",
  displayName: "M",
  avatarUrl: "",
  role: "member",
};

const TOKENS = new Map<string, AuthenticatedUser>([["member-token", MEMBER]]);

function tokenValidator(): TokenValidator {
  return {
    async validate(token: string): Promise<TokenValidationResult> {
      const user = TOKENS.get(token);
      return user ? { ok: true, user } : { ok: false, code: "INVALID_TOKEN", message: "bad" };
    },
  };
}

function proxyManifest(opts?: { permissions?: string[]; mounts?: ProxyMount[] }): PluginManifest {
  return {
    name: SLUG,
    version: "1.0.0",
    api_version: "^1.0",
    author: "Test",
    description: "Test",
    type: "standalone",
    permissions: opts?.permissions ?? ["proxy.websocket:self"],
    settings: [{ key: "upstream_url", label: "Upstream", type: "string" }],
    proxy_mounts: opts?.mounts ?? [{ name: "app", upstream_setting: "upstream_url" }],
  };
}

// Loopback classifier — deterministic, avoids real DNS for `localhost`.
const loopbackClasses = async (): Promise<HostClassification> => ({
  addresses: ["127.0.0.1"],
  classes: ["loopback"],
  representative: "loopback",
});

// Bun's WebSocket client accepts a non-standard init with `headers`/`protocols`.
// The DOM lib type doesn't model it, so narrow through a typed shim (no `any`).
type WsClientInit = { headers?: Record<string, string>; protocols?: string | string[] };
const WsClient = WebSocket as unknown as { new (url: string, init?: WsClientInit): WebSocket };

// ---------------------------------------------------------------------------
// Upstream WS echo server
// ---------------------------------------------------------------------------

interface Upstream {
  server: ReturnType<typeof Bun.serve>;
  origin: string; // http(s) origin written to the plugin's upstream setting
}

/**
 * Local upstream WS server. Echoes text/binary frames. Two control messages:
 *   - "BYE"  → close with code 4001 (tests close propagation)
 *   - others → echoed verbatim
 */
function startUpstream(): Upstream {
  const server = Bun.serve({
    port: 0,
    fetch(req, srv): Response | undefined {
      if (srv.upgrade(req)) return undefined;
      return new Response("expected websocket", { status: 400 });
    },
    websocket: {
      message(ws, msg): void {
        if (msg === "BYE") {
          ws.close(4001, "upstream-bye");
          return;
        }
        ws.send(msg);
      },
    },
  });
  return { server, origin: `http://localhost:${server.port}` };
}

// ---------------------------------------------------------------------------
// Runtime harness
// ---------------------------------------------------------------------------

interface RuntimeHarness {
  handle: WsServerHandle;
  port: number;
  coreDb: Database;
  pluginDb: Database;
  /** Router dispatch counter — proves proxy frames never reach the router. */
  routerCalls: () => number;
  /** A valid dev-name proxy cookie header for the given mount + version. */
  cookieFor(mount: string, approvalVersion: number): string;
  approvalVersion(mount: string): number;
}

interface SetupOptions {
  permissions?: string[];
  mounts?: ProxyMount[];
  /** Skip seeding the approval row. */
  noApproval?: boolean;
  /** Override the upstream connector (tests inject a fake non-opening socket). */
  connectUpstream?: (url: string, protocols: string[], headers?: Record<string, string>) => WebSocket;
  /** Per-direction bounded-buffer cap override. */
  maxBufferBytes?: number;
}

const upstreams: Upstream[] = [];
const handles: WsServerHandle[] = [];
const managers: SubprocessManager[] = [];
const dbs: Database[] = [];

function setupRuntime(upstreamOrigin: string, options?: SetupOptions): RuntimeHarness {
  const manifest = proxyManifest({
    ...(options?.permissions !== undefined ? { permissions: options.permissions } : {}),
    ...(options?.mounts !== undefined ? { mounts: options.mounts } : {}),
  });
  const mounts = manifest.proxy_mounts ?? [];

  const coreDb = new Database(":memory:");
  coreDb.exec(`
    CREATE TABLE plugin_settings (slug TEXT PRIMARY KEY, disabled INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
    CREATE TABLE proxy_approvals (
      plugin_slug TEXT NOT NULL, plugin_version TEXT NOT NULL, mount_name TEXT NOT NULL,
      mount_definition_hash TEXT NOT NULL, upstream_setting_key TEXT NOT NULL,
      normalized_upstream_origin TEXT NOT NULL, normalized_upstream_base_path TEXT NOT NULL,
      approved_by_user_id TEXT NOT NULL, approved_at INTEGER NOT NULL, approval_version INTEGER NOT NULL,
      approved_address_class TEXT,
      PRIMARY KEY (plugin_slug, mount_name)
    );
  `);

  const pluginDb = new Database(":memory:");
  pluginDb.exec(ENSURE_CONFIG_TABLE_SQL);
  pluginDb.run(
    "INSERT INTO _config (key, value, type, updated_at, updated_by_user_id) VALUES (?, ?, ?, ?, ?)",
    ["upstream_url", upstreamOrigin, "string", Date.now(), "owner-1"],
  );
  dbs.push(coreDb, pluginDb);

  const approvals = new ProxyApprovalStore(coreDb);
  if (!options?.noApproval) {
    const norm = normalizeUpstream(upstreamOrigin);
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

  const proxyWebSocket = createProxyWebSocket({
    deps: {
      getInstalledPlugins: () => [{ slug: SLUG, manifest }],
      coreDb,
      getPluginDb: () => pluginDb,
      getServerId: () => SERVER_ID,
    },
    rateLimiter: new RateLimiter(),
    resolveHostClasses: loopbackClasses,
    ...(options?.connectUpstream !== undefined ? { connectUpstream: options.connectUpstream } : {}),
    ...(options?.maxBufferBytes !== undefined ? { maxBufferBytes: options.maxBufferBytes } : {}),
  });

  const manager = new SubprocessManager();
  managers.push(manager);

  const handle = createWsServer({
    port: 0,
    tokenValidator: tokenValidator(),
    subprocessManager: manager,
    codec: jsonCodec,
    proxyWebSocket,
  });
  handles.push(handle);

  // Spy on the router so we can assert proxy frames never reach it.
  let calls = 0;
  const origHandle = handle.router.handleMessage.bind(handle.router);
  handle.router.handleMessage = (id, msg): void => {
    calls += 1;
    origHandle(id, msg);
  };

  const port = handle.server.port;
  if (port === undefined) throw new Error("server has no port");

  return {
    handle,
    port,
    coreDb,
    pluginDb,
    routerCalls: () => calls,
    approvalVersion(mount: string): number {
      const row = approvals.get(SLUG, mount);
      if (!row) throw new Error(`no approval for ${mount}`);
      return row.approval_version;
    },
    cookieFor(mount: string, approvalVersion: number): string {
      const token = mintProxySession({
        userId: MEMBER.id,
        serverId: SERVER_ID,
        slug: SLUG,
        mount,
        approvalVersion,
      });
      return `uncorded-proxy-${SLUG}-${mount}=${token}`;
    },
  };
}

afterEach(() => {
  for (const h of handles) h.stop();
  handles.length = 0;
  for (const u of upstreams) u.server.stop(true);
  upstreams.length = 0;
  for (const m of managers) void m.stopAll();
  managers.length = 0;
  for (const db of dbs) db.close();
  dbs.length = 0;
});

function newUpstream(): Upstream {
  const u = startUpstream();
  upstreams.push(u);
  return u;
}

// ---------------------------------------------------------------------------
// Promise helpers
// ---------------------------------------------------------------------------

function waitOpen(ws: WebSocket, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("open timeout")), timeoutMs);
    ws.onopen = (): void => {
      clearTimeout(t);
      resolve();
    };
    ws.onerror = (): void => {
      clearTimeout(t);
      reject(new Error("ws error before open"));
    };
  });
}

function nextFrame(ws: WebSocket, timeoutMs = 3000): Promise<string> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("frame timeout")), timeoutMs);
    ws.onmessage = (ev: MessageEvent): void => {
      clearTimeout(t);
      resolve(typeof ev.data === "string" ? ev.data : "<binary>");
    };
    ws.onerror = (): void => {
      clearTimeout(t);
      reject(new Error("ws error before frame"));
    };
  });
}

function nextClose(ws: WebSocket, timeoutMs = 4000): Promise<CloseEvent> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("close timeout")), timeoutMs);
    ws.onclose = (ev: CloseEvent): void => {
      clearTimeout(t);
      resolve(ev);
    };
  });
}

/** Resolves "rejected" if the upgrade fails (error/close before open), else "opened". */
function upgradeOutcome(ws: WebSocket, timeoutMs = 3000): Promise<"opened" | "rejected"> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("outcome timeout")), timeoutMs);
    let done = false;
    const settle = (v: "opened" | "rejected"): void => {
      if (done) return;
      done = true;
      clearTimeout(t);
      resolve(v);
    };
    ws.onopen = (): void => settle("opened");
    ws.onerror = (): void => settle("rejected");
    ws.onclose = (): void => settle("rejected");
  });
}

const wsUrl = (port: number, mount = "app", suffix = ""): string =>
  `ws://localhost:${port}/proxy/${SLUG}/${mount}/${suffix}`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("proxy WebSocket bridge", () => {
  test("echoes frames through the proxy to the upstream and back", async () => {
    const up = newUpstream();
    const rt = setupRuntime(up.origin);
    const cookie = rt.cookieFor("app", rt.approvalVersion("app"));

    const ws = new WsClient(wsUrl(rt.port), { headers: { Cookie: cookie } });
    await waitOpen(ws);

    ws.send("hello upstream");
    expect(await nextFrame(ws)).toBe("hello upstream");

    ws.send("second");
    expect(await nextFrame(ws)).toBe("second");

    // Proxy frames must never enter the runtime message router.
    expect(rt.routerCalls()).toBe(0);
    ws.close();
  });

  test("rejects the upgrade when no proxy-session cookie is present", async () => {
    const up = newUpstream();
    const rt = setupRuntime(up.origin);

    const ws = new WsClient(wsUrl(rt.port)); // no Cookie header
    expect(await upgradeOutcome(ws)).toBe("rejected");
  });

  test("rejects the upgrade when the cookie is invalid", async () => {
    const up = newUpstream();
    const rt = setupRuntime(up.origin);

    const ws = new WsClient(wsUrl(rt.port), {
      headers: { Cookie: `uncorded-proxy-${SLUG}-app=not-a-valid-token` },
    });
    expect(await upgradeOutcome(ws)).toBe("rejected");
  });

  test("rejects the upgrade when the mount lacks proxy.websocket:self", async () => {
    const up = newUpstream();
    // Declares only the HTTP capability — WS upgrade must be refused.
    const rt = setupRuntime(up.origin, { permissions: ["proxy.http:self"] });
    const cookie = rt.cookieFor("app", rt.approvalVersion("app"));

    const ws = new WsClient(wsUrl(rt.port), { headers: { Cookie: cookie } });
    expect(await upgradeOutcome(ws)).toBe("rejected");
  });

  test("closes with 1009 when a client frame exceeds the shared frame cap", async () => {
    const up = newUpstream();
    const rt = setupRuntime(up.origin);
    const cookie = rt.cookieFor("app", rt.approvalVersion("app"));

    const ws = new WsClient(wsUrl(rt.port), { headers: { Cookie: cookie } });
    await waitOpen(ws);

    // 70 KiB > the 64 KiB shared MAX_WS_FRAME_BYTES cap.
    ws.send("x".repeat(70 * 1024));
    const close = await nextClose(ws);
    expect(close.code).toBe(1009);
    expect(rt.routerCalls()).toBe(0);
  });

  test("propagates an upstream close (code) to the client", async () => {
    const up = newUpstream();
    const rt = setupRuntime(up.origin);
    const cookie = rt.cookieFor("app", rt.approvalVersion("app"));

    const ws = new WsClient(wsUrl(rt.port), { headers: { Cookie: cookie } });
    await waitOpen(ws);

    ws.send("BYE"); // upstream replies by closing with 4001
    const close = await nextClose(ws);
    expect(close.code).toBe(4001);
  });

  test("preserves a safe client-requested subprotocol", async () => {
    const up = newUpstream();
    const rt = setupRuntime(up.origin);
    const cookie = rt.cookieFor("app", rt.approvalVersion("app"));

    const ws = new WsClient(wsUrl(rt.port), {
      headers: { Cookie: cookie },
      protocols: ["chat", "v2"],
    });
    await waitOpen(ws);
    expect(ws.protocol).toBe("chat");
    ws.close();
  });

  test("forwards upstream app cookies on the handshake, stripping the proxy-session cookie", async () => {
    // Regression: cookie-authenticated realtime apps (Foundry et al.) authenticate
    // their socket by session cookie. The HTTP forwarder carries app cookies; the
    // WS handshake must too, or the upstream sees no session and reload-loops.
    const up = newUpstream();
    let captured: Record<string, string> | undefined;
    const capturing = (
      url: string,
      protocols: string[],
      headers?: Record<string, string>,
    ): WebSocket => {
      captured = headers;
      return new WebSocket(url, protocols);
    };
    const rt = setupRuntime(up.origin, { connectUpstream: capturing });
    const sessionCookie = rt.cookieFor("app", rt.approvalVersion("app"));

    // The browser replays BOTH the runtime proxy-session cookie (Path=/) and the
    // app's own mount-scoped cookies on the upgrade request.
    const ws = new WsClient(wsUrl(rt.port), {
      headers: { Cookie: `${sessionCookie}; foundry_session=xyz; sid=42` },
    });
    await waitOpen(ws);

    // Upstream sees the app cookies, never the runtime's proxy-session cookie.
    expect(captured?.cookie).toBe("foundry_session=xyz; sid=42");
    expect(captured?.cookie ?? "").not.toContain("uncorded-proxy-");
    ws.close();
  });

  test("omits the cookie header but still forwards identity context when only the proxy-session cookie is present", async () => {
    const up = newUpstream();
    let captured: Record<string, string> | undefined;
    const capturing = (
      url: string,
      protocols: string[],
      headers?: Record<string, string>,
    ): WebSocket => {
      captured = headers;
      return new WebSocket(url, protocols);
    };
    const rt = setupRuntime(up.origin, { connectUpstream: capturing });
    const sessionCookie = rt.cookieFor("app", rt.approvalVersion("app"));

    const ws = new WsClient(wsUrl(rt.port), { headers: { Cookie: sessionCookie } });
    await waitOpen(ws);

    // No app cookies ⇒ no cookie header, but the forwarded identity is still sent.
    expect(captured?.cookie).toBeUndefined();
    expect(captured?.["x-uncorded-user-id"]).toBe(MEMBER.id);
    ws.close();
  });

  test("forwards x-forwarded-* identity and the mount path as x-forwarded-prefix", async () => {
    const up = newUpstream();
    let captured: Record<string, string> | undefined;
    const capturing = (
      url: string,
      protocols: string[],
      headers?: Record<string, string>,
    ): WebSocket => {
      captured = headers;
      return new WebSocket(url, protocols);
    };
    const rt = setupRuntime(up.origin, { connectUpstream: capturing });
    const cookie = rt.cookieFor("app", rt.approvalVersion("app"));

    const ws = new WsClient(wsUrl(rt.port), { headers: { Cookie: cookie } });
    await waitOpen(ws);

    // The handshake carries the same forwarded identity as the HTTP path, plus
    // the public mount path so a prefix-aware upstream emits correct URLs.
    expect(captured?.["x-forwarded-prefix"]).toBe(`/proxy/${SLUG}/app`);
    expect(captured?.["x-uncorded-user-id"]).toBe(MEMBER.id);
    expect(captured?.["x-forwarded-proto"]).toBe("http");
    expect(captured?.["x-forwarded-host"]).toContain("localhost");
    ws.close();
  });

  test("bounds the client→upstream buffer and closes 1011 on overflow", async () => {
    const up = newUpstream();
    // Inject an upstream socket that never opens, so client frames pile into the
    // bounded buffer until it overflows the (tiny) cap → bridge closes 1011.
    const neverOpens = (): WebSocket => {
      const fake = {
        binaryType: "arraybuffer",
        bufferedAmount: 0,
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
        send(): void {},
        close(): void {},
      };
      return fake as unknown as WebSocket;
    };
    const rt = setupRuntime(up.origin, { connectUpstream: neverOpens, maxBufferBytes: 4096 });
    const cookie = rt.cookieFor("app", rt.approvalVersion("app"));

    const ws = new WsClient(wsUrl(rt.port), { headers: { Cookie: cookie } });
    await waitOpen(ws);

    // Each frame is buffered (upstream never opens). Send past the 4 KiB cap.
    for (let i = 0; i < 4; i++) ws.send("y".repeat(2048));
    const close = await nextClose(ws);
    expect(close.code).toBe(1011);
  });
});

// ---------------------------------------------------------------------------
// Runtime /ws regression — proxy wiring must not disturb the protocol socket.
// ---------------------------------------------------------------------------

describe("runtime /ws coexistence", () => {
  test("a /ws connection still authenticates and routes to the message router", async () => {
    const up = newUpstream();
    const rt = setupRuntime(up.origin);

    const ws = new WsClient(`ws://localhost:${rt.port}/ws`);
    await waitOpen(ws);

    const authResult = nextFrame(ws);
    ws.send(JSON.stringify({ type: "auth", token: "member-token" }));
    const parsed = JSON.parse(await authResult) as { type: string; ok: boolean };
    expect(parsed.type).toBe("auth.result");
    expect(parsed.ok).toBe(true);

    // An authenticated protocol message reaches the router (proving the spy works
    // and that runtime frames take the non-proxy branch).
    const before = rt.routerCalls();
    ws.send(JSON.stringify({ type: "request", id: "r1", plugin: "nope", action: "x", params: {} }));
    await Bun.sleep(50);
    expect(rt.routerCalls()).toBeGreaterThan(before);
    ws.close();
  });
});
