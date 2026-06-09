// HTTP handler — the runtime's HTTP surface, exported as a fetch function.
// The startup orchestrator composes this with the WebSocket layer into
// a single Bun.serve() call. This module does NOT start its own server.

import { join, resolve, normalize, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, rename, unlink, readdir, stat } from "node:fs/promises";
import { CapabilityChecker } from "../capabilities/checker";
import { sniffMime, extensionForMime, INLINE_SAFE_MIMES } from "./mime-sniff";
import { verifyFileSig } from "../signing/files";
import { extractAuth, requireMinLevel } from "./auth";
import { RateLimiter, RATE_HEALTH, RATE_UPLOAD, RATE_UPLOAD_CHUNK, RATE_ADMIN, RATE_STATIC, RATE_MANIFEST, RATE_VOICE_WEBHOOK, RATE_CHECK_UPDATE, RATE_PROXY_HTTP, RATE_PROXY_SESSION } from "./rate-limiter";
import { handleProxySessionBootstrap, handleProxyRequest } from "./proxy";
import { ProxyApprovalStore } from "../proxy/approvals";
import {
  handleUploadInit,
  handleUploadStatus,
  handleUploadPatch,
  handleUploadFinalize,
  handleUploadCancel,
  handleUploadSessionPreflight,
} from "./upload-session";
import { handleVoiceWebhook } from "../voice/webhook";
import { mintJoinToken } from "../voice/tokens";
import type {
  VoiceReachabilityState,
  VoiceProbeResult,
} from "../voice/reachability";
import {
  handleGetUserLayout,
  handlePutUserLayout,
  handleGetDefaultLayout,
  handlePutDefaultLayout,
  handleGetUserLayouts,
  handlePostUserLayout,
  handlePutUserLayoutById,
  handleDeleteUserLayout,
  RATE_WORKSPACE,
} from "./workspace";
import {
  handleGetBrowserRecent,
  handlePutBrowserRecent,
} from "./browser-recent";
import type {
  RateLimitConfig,
  HttpDependencies,
  FileUploadNotification,
  InstalledPluginInfo,
  PluginRegistry,
} from "./types";
import type {
  RuntimeUpdateChannel,
  RuntimeUpdateErrorContext,
  RuntimeUpdateState,
  RuntimeUpdateStatus,
} from "../update-state/types";
import type { AuthenticatedUser } from "../ws/types";
import type { PluginProcess, PluginState } from "../subprocess";
import type { SidebarItem, SidebarAction } from "@uncorded/protocol";
import { rootLogger } from "@uncorded/shared";
import type { PluginSetting } from "@uncorded/shared";
import {
  ENSURE_CONFIG_TABLE_SQL,
  encodeConfigValue,
  mergeConfigWithDefaults,
} from "../ipc/handlers";

const log = rootLogger.child({ component: "http" });

// ---------------------------------------------------------------------------
// Route matching
// ---------------------------------------------------------------------------

const MANIFEST_RE = /^\/plugins\/([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\/manifest\.json$/;
const PLUGIN_SIDEBAR_RE = /^\/plugins\/([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\/sidebar$/;
const PLUGIN_UI_RE = /^\/plugins\/([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\/ui(\/.*)?$/;
const ADMIN_API_RE = /^\/admin\/api(?:\/(.*))?$/;

const ADMIN_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "admin",
);

interface RouteMatch {
  handler: RouteHandler;
  params: Record<string, string>;
  rateConfig: RateLimitConfig | null;
  /** "ip" = rate-limit by IP before auth; "user" = rate-limit by user after auth */
  rateScope: "ip" | "user";
  /** Public read-only endpoint — add Access-Control-Allow-Origin: * (wildcard
   *  is safe because no user data is exposed). */
  cors?: boolean;
  /** Authenticated endpoint that needs cross-origin access from specific
   *  shell/admin origins. The dispatcher echoes the request's Origin in
   *  Access-Control-Allow-Origin only if it matches deps.allowedOrigins. */
  corsAuth?: boolean;
}

type RouteHandler = (
  request: Request,
  params: Record<string, string>,
  deps: HttpDependencies,
  rateLimiter: RateLimiter,
  clientIp: string,
) => Promise<Response> | Response;

function matchRoute(method: string, pathname: string): RouteMatch | null {
  if (method === "GET" && pathname === "/health") {
    return { handler: handleHealth, params: {}, rateConfig: RATE_HEALTH, rateScope: "ip", cors: true };
  }

  if (method === "GET" && pathname === "/ready") {
    return { handler: handleReady, params: {}, rateConfig: RATE_HEALTH, rateScope: "ip", cors: true };
  }

  // /health/voice — public, unauthenticated. Per spec-24 §HTTP Surface this
  // is deliberately separate from /health so a flapping voice subsystem
  // does not fail the runtime probe (and therefore does not pull the
  // container out of rotation).
  if (method === "GET" && pathname === "/health/voice") {
    return { handler: handleVoiceHealth, params: {}, rateConfig: RATE_HEALTH, rateScope: "ip", cors: true };
  }

  // /runtime/voice/webhook — LiveKit posts events here. Auth is the JWT
  // in the Authorization header (verified inside the handler with the
  // same apiSecret the SFU was given), not a user token. The path lives
  // under /runtime/ to keep it out of plugin/admin route trees, and rate
  // limiting is by IP because the source is loopback (single peer).
  if (method === "POST" && pathname === "/runtime/voice/webhook") {
    return { handler: handleVoiceWebhookRoute, params: {}, rateConfig: RATE_VOICE_WEBHOOK, rateScope: "ip" };
  }

  if (method === "GET" && pathname === "/plugins") {
    return { handler: handlePluginList, params: {}, rateConfig: RATE_STATIC, rateScope: "ip", cors: true };
  }

  if (method === "GET" && pathname === "/icon") {
    return { handler: handleIcon, params: {}, rateConfig: RATE_STATIC, rateScope: "ip" };
  }

  if (method === "GET" && pathname === "/sdk/plugin-frontend.js") {
    return { handler: handleSdkBundle, params: {}, rateConfig: RATE_STATIC, rateScope: "ip", cors: true };
  }

  if (method === "OPTIONS" && pathname === "/upload") {
    return { handler: handleUploadPreflight, params: {}, rateConfig: RATE_STATIC, rateScope: "ip", cors: true };
  }
  if (method === "POST" && pathname === "/upload") {
    return { handler: handleUpload, params: {}, rateConfig: RATE_UPLOAD, rateScope: "user", cors: true };
  }

  // Chunked / resumable upload protocol — spec-26 Amendment A.
  // POST /upload/init reserves an upload_id; subsequent ops bind to it.
  if (method === "OPTIONS" && pathname === "/upload/init") {
    return { handler: handleUploadSessionPreflight, params: {}, rateConfig: RATE_STATIC, rateScope: "ip", cors: true };
  }
  if (method === "POST" && pathname === "/upload/init") {
    return { handler: handleUploadInit, params: {}, rateConfig: RATE_UPLOAD, rateScope: "user", cors: true };
  }
  const uploadSessionMatch = /^\/upload\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\/finalize)?$/.exec(pathname);
  if (uploadSessionMatch?.[1]) {
    const id = uploadSessionMatch[1];
    const isFinalize = uploadSessionMatch[2] === "/finalize";
    if (method === "OPTIONS") {
      return { handler: handleUploadSessionPreflight, params: { id }, rateConfig: RATE_STATIC, rateScope: "ip", cors: true };
    }
    if (isFinalize) {
      if (method === "POST") {
        return { handler: handleUploadFinalize, params: { id }, rateConfig: RATE_UPLOAD, rateScope: "user", cors: true };
      }
    } else {
      if (method === "GET") {
        return { handler: handleUploadStatus, params: { id }, rateConfig: RATE_UPLOAD, rateScope: "user", cors: true };
      }
      if (method === "PATCH") {
        return { handler: handleUploadPatch, params: { id }, rateConfig: RATE_UPLOAD_CHUNK, rateScope: "user", cors: true };
      }
      if (method === "DELETE") {
        return { handler: handleUploadCancel, params: { id }, rateConfig: RATE_UPLOAD, rateScope: "user", cors: true };
      }
    }
  }

  // GET /files/:slug/:filename — signed URL serve. Auth is the query-string
  // HMAC, NOT the bearer token (browsers can't set Authorization on <img>/<video>).
  // The signature binds the path and the requesting user_id with a 1h TTL.
  const fileMatch = /^\/files\/([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\/([a-zA-Z0-9_.-]+)$/.exec(pathname);
  if ((method === "GET" || method === "HEAD") && fileMatch?.[1] && fileMatch[2]) {
    return {
      handler: handleFileGet,
      params: { slug: fileMatch[1], filename: fileMatch[2] },
      rateConfig: RATE_STATIC,
      rateScope: "ip",
    };
  }

  const manifestMatch = pathname.match(MANIFEST_RE);
  if (method === "GET" && manifestMatch?.[1]) {
    return {
      handler: handlePluginManifest,
      params: { slug: manifestMatch[1] },
      rateConfig: RATE_MANIFEST,
      rateScope: "ip",
      cors: true,
    };
  }

  const sidebarMatch = pathname.match(PLUGIN_SIDEBAR_RE);
  if (method === "GET" && sidebarMatch?.[1]) {
    return {
      handler: handlePluginSidebar,
      params: { slug: sidebarMatch[1] },
      rateConfig: RATE_ADMIN,
      rateScope: "user",
      corsAuth: true,
    };
  }

  const uiMatch = pathname.match(PLUGIN_UI_RE);
  if (method === "GET" && uiMatch?.[1]) {
    return {
      handler: handlePluginUi,
      params: { slug: uiMatch[1], path: uiMatch[2]?.slice(1) ?? "" },
      rateConfig: RATE_STATIC,
      rateScope: "ip",
    };
  }

  // OPTIONS preflight for any admin API path — must be matched before the
  // user-scoped branch below so preflights aren't blocked by rate limiting.
  const adminApiPreflightMatch = method === "OPTIONS" && pathname.match(ADMIN_API_RE);
  if (adminApiPreflightMatch) {
    return {
      handler: handleAdminApi,
      params: { path: adminApiPreflightMatch[1] ?? "" },
      rateConfig: RATE_STATIC,
      rateScope: "ip",
      corsAuth: true,
    };
  }

  const adminApiMatch = pathname.match(ADMIN_API_RE);
  if (adminApiMatch) {
    return {
      handler: handleAdminApi,
      params: { path: adminApiMatch[1] ?? "" },
      rateConfig: RATE_ADMIN,
      rateScope: "user",
      corsAuth: true,
    };
  }

  if (pathname === "/admin" || pathname.startsWith("/admin/")) {
    const path = pathname === "/admin" ? "" : pathname.slice("/admin/".length);
    // Static admin assets are public (auth happens via postMessage handshake).
    // API calls under /admin/api/* are caught by the earlier ADMIN_API_RE branch.
    return {
      handler: handleAdmin,
      params: { path },
      rateConfig: RATE_STATIC,
      rateScope: "ip",
    };
  }

  if (method === "GET" && pathname === "/") {
    return { handler: handleLanding, params: {}, rateConfig: RATE_STATIC, rateScope: "ip" };
  }

  // OPTIONS preflight for workspace endpoints
  if (method === "OPTIONS" && pathname.startsWith("/workspace/")) {
    return { handler: handleWorkspacePreflight, params: {}, rateConfig: RATE_STATIC, rateScope: "ip", corsAuth: true };
  }

  // Workspace layout endpoints (Core Module)
  if (method === "GET" && pathname === "/workspace/layout") {
    return { handler: handleGetUserLayout, params: {}, rateConfig: RATE_WORKSPACE, rateScope: "user", corsAuth: true };
  }
  if (method === "PUT" && pathname === "/workspace/layout") {
    return { handler: handlePutUserLayout, params: {}, rateConfig: RATE_WORKSPACE, rateScope: "user", corsAuth: true };
  }
  if (method === "GET" && pathname === "/workspace/default") {
    return { handler: handleGetDefaultLayout, params: {}, rateConfig: RATE_WORKSPACE, rateScope: "user", corsAuth: true };
  }
  if (method === "PUT" && pathname === "/workspace/default") {
    return { handler: handlePutDefaultLayout, params: {}, rateConfig: RATE_WORKSPACE, rateScope: "user", corsAuth: true };
  }

  // Saved workspaces (multi-layout bookmarks)
  if (method === "GET" && pathname === "/workspace/layouts") {
    return { handler: handleGetUserLayouts, params: {}, rateConfig: RATE_WORKSPACE, rateScope: "user", corsAuth: true };
  }
  if (method === "POST" && pathname === "/workspace/layouts") {
    return { handler: handlePostUserLayout, params: {}, rateConfig: RATE_WORKSPACE, rateScope: "user", corsAuth: true };
  }
  const layoutsMatch = /^\/workspace\/layouts\/([^/]+)$/.exec(pathname);
  if (layoutsMatch?.[1]) {
    const id = layoutsMatch[1];
    if (method === "PUT") {
      return { handler: handlePutUserLayoutById, params: { id }, rateConfig: RATE_WORKSPACE, rateScope: "user", corsAuth: true };
    }
    if (method === "DELETE") {
      return { handler: handleDeleteUserLayout, params: { id }, rateConfig: RATE_WORKSPACE, rateScope: "user", corsAuth: true };
    }
  }

  // OPTIONS preflight for /browser/* endpoints. Reuses the workspace preflight
  // since CORS negotiation is identical.
  if (method === "OPTIONS" && pathname.startsWith("/browser/")) {
    return { handler: handleWorkspacePreflight, params: {}, rateConfig: RATE_STATIC, rateScope: "ip", corsAuth: true };
  }

  // Browser "Recently opened" — single per-user list, app-wide.
  if (method === "GET" && pathname === "/browser/recent") {
    return { handler: handleGetBrowserRecent, params: {}, rateConfig: RATE_WORKSPACE, rateScope: "user", corsAuth: true };
  }
  if (method === "PUT" && pathname === "/browser/recent") {
    return { handler: handlePutBrowserRecent, params: {}, rateConfig: RATE_WORKSPACE, rateScope: "user", corsAuth: true };
  }

  // Reverse-proxy session bootstrap — Bearer-authed, mints the proxy-session
  // cookie. Same-origin call from the plugin UI; corsAuth covers the shell.
  const proxySessionMatch = /^\/proxy-sessions\/([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\/([a-z][a-z0-9]*(?:-[a-z0-9]+)*)$/.exec(pathname);
  if (method === "POST" && proxySessionMatch?.[1] && proxySessionMatch[2]) {
    return {
      handler: handleProxySessionBootstrap,
      params: { slug: proxySessionMatch[1], mount: proxySessionMatch[2] },
      rateConfig: RATE_PROXY_SESSION,
      rateScope: "user",
      corsAuth: true,
    };
  }

  // Reverse-proxy passthrough — browser traffic, validated by the proxy-session
  // cookie only. IP-scoped pre-auth rate limit; the handler fails closed.
  const proxyMatch = /^\/proxy\/([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\/([a-z][a-z0-9]*(?:-[a-z0-9]+)*)(?:\/(.*))?$/.exec(pathname);
  if (proxyMatch?.[1] && proxyMatch[2] && PROXY_METHODS.has(method)) {
    return {
      handler: handleProxyRequest,
      params: { slug: proxyMatch[1], mount: proxyMatch[2], path: proxyMatch[3] ?? "" },
      rateConfig: RATE_PROXY_HTTP,
      rateScope: "ip",
    };
  }

  return null;
}

/** HTTP methods the reverse-proxy passthrough forwards. */
const PROXY_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

export interface HttpHandlerOptions {
  deps: HttpDependencies;
  rateLimiter?: RateLimiter | undefined;
  // Used by the fallback RateLimiter when `rateLimiter` is not injected,
  // so deny + ban events surface in the runtime log stream. Ignored when
  // the caller passes its own limiter.
  logger?: import("@uncorded/shared").Logger | undefined;
}

export interface HttpHandlerHandle {
  fetch: (request: Request) => Promise<Response>;
  rateLimiter: RateLimiter;
  dispose: () => void;
}

export function createHttpHandler(options: HttpHandlerOptions): HttpHandlerHandle {
  const { deps } = options;
  const rateLimiter = options.rateLimiter ?? new RateLimiter(undefined, options.logger);

  async function fetch(request: Request): Promise<Response> {
    try {
      const clientIp = deps.getClientIp(request);

      // Check IP ban before anything else
      const banCheck = rateLimiter.isBanned(clientIp);
      if (banCheck.banned) {
        return rateLimitedResponse(banCheck.retryAfterMs);
      }

      const url = new URL(request.url);
      const route = matchRoute(request.method, url.pathname);

      if (!route) {
        return Response.json(
          { error: { code: "NOT_FOUND", message: "Not found." } },
          { status: 404 },
        );
      }

      // Apply pre-auth rate limiting for IP-scoped routes
      if (route.rateConfig && route.rateScope === "ip") {
        const result = rateLimiter.consume(`ip:${clientIp}`, route.rateConfig);
        if (!result.allowed) {
          return rateLimitedResponse(result.retryAfterMs);
        }
      }

      const response = await route.handler(request, route.params, deps, rateLimiter, clientIp);
      if (route.cors) {
        response.headers.set("Access-Control-Allow-Origin", "*");
      } else if (route.corsAuth) {
        const allowedOrigin = resolveAllowedOrigin(request.headers.get("Origin"), deps.allowedOrigins);
        if (allowedOrigin !== null) {
          response.headers.set("Access-Control-Allow-Origin", allowedOrigin);
          response.headers.append("Vary", "Origin");
        }
      }
      return response;
    } catch (err) {
      log.error("http handler failed", {
        method: request.method,
        url: request.url,
        err: err instanceof Error ? err.message : String(err),
      });
      return Response.json(
        { error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred." } },
        { status: 500 },
      );
    }
  }

  return {
    fetch,
    rateLimiter,
    dispose() {
      rateLimiter.dispose();
    },
  };
}

// ---------------------------------------------------------------------------
// 429 helper
// ---------------------------------------------------------------------------

function rateLimitedResponse(retryAfterMs: number): Response {
  const retryAfterSec = Math.ceil(retryAfterMs / 1000);
  return Response.json(
    { error: { code: "RATE_LIMITED", message: "Too many requests.", retryAfter: retryAfterSec } },
    {
      status: 429,
      headers: { "Retry-After": String(retryAfterSec) },
    },
  );
}

// Exact-match origin allowlist. Wildcard is deliberately not supported — a
// request whose Origin isn't in the configured list gets no ACAO header and the
// browser blocks the cross-origin read.
function resolveAllowedOrigin(
  requestOrigin: string | null,
  allowlist: readonly string[],
): string | null {
  if (!requestOrigin) return null;
  return allowlist.includes(requestOrigin) ? requestOrigin : null;
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

// GET /health
// GET /health — pure liveness. Returns 200 unconditionally if the process
// can respond. Used by Docker HEALTHCHECK — restarting the container because
// Central is unreachable for a few minutes is counterproductive (the new
// container won't be able to reach Central either, and we'd thrash the
// auth-cache window on every restart). Subsystem-level "should we route
// traffic here?" lives on /ready.
function handleHealth(
  _request: Request,
  _params: Record<string, string>,
  deps: HttpDependencies,
): Response {
  const uptimeSeconds = Math.floor((Date.now() - deps.config.startedAt) / 1000);
  return Response.json({
    status: "ok",
    version: deps.runtimeVersion,
    plugins: deps.pluginRegistry.getPluginCount(),
    uptime: uptimeSeconds,
  });
}

// GET /ready — readiness probe. 200 only when subsystem state is good enough
// to serve real traffic; 503 + `status: "degraded"` otherwise. Orchestrators
// (Cloudflare Tunnel, load balancers) should consult /ready, not /health, to
// decide whether to route requests.
//
// Today the only gate is public-key cache freshness — once it goes stale (≥ 2×
// Central rotation window), we can no longer trust our cached keys to match
// Central's live set, so we fail closed on auth'd traffic. As more subsystems
// land their own readiness signals (tunnel, voice, etc.), each gets folded in
// here.
function handleReady(
  _request: Request,
  _params: Record<string, string>,
  deps: HttpDependencies,
): Response {
  const uptimeSeconds = Math.floor((Date.now() - deps.config.startedAt) / 1000);
  // Drain takes precedence over key-staleness: an old-version container in
  // the middle of a swap is "not ready" regardless of any other signal,
  // and the orchestrator's post-swap /ready poll uses 503 here as the gate
  // that decides commit-vs-rollback (lifecycle §8.1).
  const draining = deps.isDraining?.() ?? false;
  if (draining) {
    return Response.json(
      {
        status: "draining",
        version: deps.runtimeVersion,
        plugins: deps.pluginRegistry.getPluginCount(),
        uptime: uptimeSeconds,
        reason: "draining",
      },
      { status: 503 },
    );
  }
  const keysStale = deps.areKeysStale();
  const body = {
    status: keysStale ? "degraded" : "ready",
    version: deps.runtimeVersion,
    plugins: deps.pluginRegistry.getPluginCount(),
    uptime: uptimeSeconds,
    ...(keysStale && { reason: "public-key cache stale" }),
  };
  return Response.json(body, { status: keysStale ? 503 : 200 });
}

// GET /plugins
function handlePluginList(
  _request: Request,
  _params: Record<string, string>,
  deps: HttpDependencies,
): Response {
  const plugins = deps.pluginRegistry.listPlugins().map((p) => ({
    slug: p.slug,
    name: p.manifest.name,
    sidebar: p.manifest.sidebar ?? null,
    client_capabilities: p.manifest.client_capabilities ?? [],
    runtime_capabilities: p.manifest.runtime_capabilities ?? [],
    // Two-stage handshake state. Older clients ignore this field; newer ones
    // grey out sidebar items when false.
    ready: p.ready,
  }));
  return Response.json({ plugins });
}

// GET /sdk/plugin-frontend.js
// Pre-built ES module bundle of @uncorded/plugin-sdk-frontend.
// Built at image build time into runtime/public/sdk/plugin-frontend.js.
const SDK_BUNDLE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "public",
  "sdk",
  "plugin-frontend.js",
);

async function handleSdkBundle(
  _request: Request,
  _params: Record<string, string>,
): Promise<Response> {
  const file = Bun.file(SDK_BUNDLE_PATH);
  if (!(await file.exists())) {
    return new Response("Frontend SDK bundle not found. Was the image built correctly?", {
      status: 404,
      headers: { "Content-Type": "text/plain" },
    });
  }
  return new Response(file, {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      // `no-cache` forces revalidation against the runtime on every request
      // (304 when unchanged). The bundle is tiny (~7 KB) so the cost is
      // trivial, and it pairs with the iframe index.html cache header so a
      // runtime image rebuild can never serve a fresh iframe HTML against a
      // stale SDK bundle. That mismatch produced "avatarHtml is not a
      // function" failures and prevented voice plugin state from ever
      // wiring up in the iframe.
      "Cache-Control": "no-cache",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

// GET /icon
const ICON_PATH = "/config/server-icon";
const ICON_TYPE_PATH = "/config/server-icon.type";

async function handleIcon(
  _request: Request,
  _params: Record<string, string>,
  deps: HttpDependencies,
): Promise<Response> {
  // Server icons are public-by-design (parity with avatars) and reachable
  // from any origin — wildcard CORS so cross-origin viewers (the web client
  // hitting the runtime over the tunnel) can render them, and the same
  // short max-age the web client reinforces with a `?v=<version>` cache
  // buster driven by the `runtime.icon.changed` WS event.
  if (await Bun.file(ICON_PATH).exists() && await Bun.file(ICON_TYPE_PATH).exists()) {
    const contentType = (await Bun.file(ICON_TYPE_PATH).text()).trim();
    return new Response(Bun.file(ICON_PATH), {
      headers: {
        "Content-Type": contentType,
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=60",
      },
    });
  }

  // SVG fallback — letter avatar matching server name initial
  const initial = esc(deps.config.serverName.trim()[0]?.toUpperCase() ?? "U");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">` +
    `<defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">` +
    `<stop offset="0%" stop-color="oklch(0.70 0.20 185 / 0.6)"/>` +
    `<stop offset="100%" stop-color="oklch(0.64 0.18 295 / 0.5)"/>` +
    `</linearGradient></defs>` +
    `<rect width="100" height="100" fill="url(#g)"/>` +
    `<text x="50" y="66" text-anchor="middle" dominant-baseline="middle" ` +
    `font-size="48" font-weight="700" font-family="system-ui,sans-serif" fill="white">${initial}</text>` +
    `</svg>`;

  return new Response(svg, {
    headers: {
      "Content-Type": "image/svg+xml",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

// GET /
function handleLanding(
  _request: Request,
  _params: Record<string, string>,
  deps: HttpDependencies,
): Response {
  const { serverName, serverDescription, isPrivate } = deps.config;
  const joinLabel = isPrivate ? "Request to join" : "Join server";

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${esc(serverName)}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: oklch(0.13 0.013 220);
      color: oklch(0.88 0.010 220);
      min-height: 100dvh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 24px 16px;
      gap: 32px;
    }
    .card {
      width: 100%;
      max-width: 420px;
      background: oklch(0.17 0.012 220 / 0.9);
      border: 1px solid oklch(0.28 0.014 220 / 0.6);
      border-radius: 20px;
      padding: 32px 28px;
      display: flex;
      flex-direction: column;
      gap: 24px;
    }
    .server-header { display: flex; align-items: center; gap: 16px; }
    .avatar {
      width: 52px; height: 52px; border-radius: 14px; flex-shrink: 0;
      overflow: hidden;
      border: 1px solid oklch(0.70 0.20 185 / 0.25);
    }
    .avatar img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .server-name {
      font-size: 20px; font-weight: 700; letter-spacing: -0.3px;
      color: oklch(0.95 0.010 220); line-height: 1.2;
    }
    .server-meta {
      font-size: 12px; color: oklch(0.55 0.010 220); margin-top: 3px;
      display: flex; align-items: center; gap: 6px;
    }
    .badge {
      display: inline-flex; align-items: center; gap: 4px;
      padding: 2px 8px; border-radius: 99px; font-size: 10px; font-weight: 600;
      letter-spacing: 0.04em; text-transform: uppercase;
    }
    .badge-private {
      background: oklch(0.65 0.18 30 / 0.12);
      border: 1px solid oklch(0.65 0.18 30 / 0.30);
      color: oklch(0.75 0.18 30);
    }
    .badge-public {
      background: oklch(0.70 0.20 185 / 0.10);
      border: 1px solid oklch(0.70 0.20 185 / 0.28);
      color: oklch(0.72 0.18 185);
    }
    .description {
      font-size: 13px; color: oklch(0.62 0.010 220); line-height: 1.6;
    }
    .divider {
      height: 1px; background: oklch(0.26 0.012 220 / 0.6);
    }
    .actions { display: flex; flex-direction: column; gap: 10px; }
    .btn {
      width: 100%; padding: 11px 16px; border-radius: 12px;
      font-size: 14px; font-weight: 600; cursor: pointer;
      border: none; outline: none; transition: opacity 0.15s;
      display: flex; align-items: center; justify-content: center; gap: 8px;
    }
    .btn:hover { opacity: 0.85; }
    .btn-primary {
      background: oklch(0.70 0.20 185); color: oklch(0.12 0.014 220);
      box-shadow: 0 0 20px oklch(0.70 0.20 185 / 0.25);
    }
    .btn-secondary {
      background: oklch(0.20 0.011 220 / 0.7);
      border: 1px solid oklch(0.30 0.014 220 / 0.7);
      color: oklch(0.80 0.010 220);
    }
    .auth-row {
      display: flex; align-items: center; justify-content: center;
      gap: 6px; font-size: 12px; color: oklch(0.50 0.010 220);
    }
    .auth-row a {
      color: oklch(0.70 0.20 185); text-decoration: none; font-weight: 500;
    }
    .auth-row a:hover { text-decoration: underline; }
    .wordmark {
      font-size: 11px; font-weight: 600; letter-spacing: 0.05em;
      color: oklch(0.38 0.010 220); text-transform: uppercase;
      text-align: center;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="server-header">
      <div class="avatar"><img src="/icon" alt="${esc(serverName)}" /></div>
      <div>
        <div class="server-name">${esc(serverName)}</div>
        <div class="server-meta">
          <span class="badge ${isPrivate ? "badge-private" : "badge-public"}">
            ${isPrivate ? "Private" : "Public"}
          </span>
        </div>
      </div>
    </div>

    ${serverDescription ? `<p class="description">${esc(serverDescription)}</p>` : ""}

    <div class="divider"></div>

    <div class="actions">
      <button class="btn btn-primary" disabled>${esc(joinLabel)}</button>
      <div class="auth-row">
        Already a member? <a href="#">Sign in</a>
      </div>
    </div>
  </div>

  <div class="wordmark">Powered by UnCorded</div>
</body>
</html>`;

  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// GET /admin/*
// Static assets (HTML, CSS, JS) are served without auth — the iframe cannot
// load index.html to perform the postMessage handshake if we gate it behind
// auth. Security is enforced exclusively at /admin/api/* (handleAdminApi).
async function handleAdmin(
  _request: Request,
  params: Record<string, string>,
  _deps: HttpDependencies,
  _rateLimiter: RateLimiter,
  _clientIp: string,
): Promise<Response> {
  const requestedPath = params["path"] && params["path"].length > 0
    ? params["path"]
    : "index.html";

  if (requestedPath.includes("\0")) {
    return Response.json(
      { error: { code: "FORBIDDEN", message: "Invalid path." } },
      { status: 403 },
    );
  }

  const normalizedAdminDir = normalize(ADMIN_DIR);
  const resolved = resolve(normalizedAdminDir, requestedPath);
  if (!resolved.startsWith(normalizedAdminDir)) {
    return Response.json(
      { error: { code: "FORBIDDEN", message: "Invalid path." } },
      { status: 403 },
    );
  }

  const file = Bun.file(resolved);
  const exists = await file.exists();
  if (!exists) {
    return Response.json(
      { error: { code: "NOT_FOUND", message: "File not found." } },
      { status: 404 },
    );
  }

  return new Response(file, {
    headers: {
      "Content-Type": file.type || "application/octet-stream",
      "Cache-Control": requestedPath === "index.html"
        ? "no-cache"
        : "public, max-age=3600",
      "Content-Security-Policy": "frame-ancestors 'self' http://localhost:* https://localhost:* http://127.0.0.1:* https://uncorded.app https://*.uncorded.app",
    },
  });
}

// POST /runtime/voice/webhook — LiveKit webhook receiver. Returns 503 when
// voice was not wired at boot so a misconfigured deployment is loud rather
// than silently dropping events.
async function handleVoiceWebhookRoute(
  request: Request,
  _params: Record<string, string>,
  deps: HttpDependencies,
): Promise<Response> {
  const webhookDeps = deps.getVoiceWebhookDeps?.();
  if (!webhookDeps) {
    return Response.json(
      { error: "voice subsystem not configured" },
      { status: 503 },
    );
  }
  const rawBody = await request.text();
  const auth = request.headers.get("authorization");
  const result = await handleVoiceWebhook(rawBody, auth, webhookDeps);
  return new Response(result.body, {
    status: result.status,
    headers: { "Content-Type": "application/json" },
  });
}

// GET /health/voice — public voice subsystem health.
//
// Spec-24 keeps this on its own URL (not folded into /health) so a flapping
// LiveKit subprocess never fails the runtime probe. Returns the spec-24
// VoiceHealth shape; HTTP status mirrors the body's `status` field so a
// shallow probe (status code only) still reflects voice readiness.
async function handleVoiceHealth(
  _request: Request,
  _params: Record<string, string>,
  deps: HttpDependencies,
): Promise<Response> {
  const sup = deps.getVoiceSupervisor?.();
  if (!sup) {
    // Voice was never wired at boot (no LIVEKIT_BIN_PATH / deps.voice).
    // Return the spec shape with status="disabled" so callers can branch
    // without parsing an error envelope.
    return Response.json(
      {
        status: "disabled" as const,
        livekitVersion: null,
        uptimeMs: null,
        lastError: null,
        activeRooms: 0,
        activeParticipants: 0,
        externalReachability: null,
      },
      { status: 200 },
    );
  }
  const health = await sup.health();
  // 200 for ready/starting/disabled (transient or expected), 503 for the
  // operator-actionable states. The body always carries the precise label.
  const httpStatus = health.status === "unhealthy" || health.status === "degraded" ? 503 : 200;
  // Public surface — lastError.message can leak operator-side detail
  // (binary path on ENOENT, port number on bind failure). Keep the code
  // and timestamp so probes can correlate; the full message is available
  // to the owner via /admin/api/voice/state.
  //
  // externalReachability is also redacted on the public endpoint per
  // spec-24 Amendment A1: wanIp → null, error strings on rtcTcp/rtcUdp
  // → kept as code only (the existing PortGroupResult.error contract
  // already mandates a short error code, not a message).
  const reachability = deps.getReachability?.()?.getState() ?? null;
  const publicBody = {
    ...health,
    lastError: health.lastError
      ? { code: health.lastError.code, ts: health.lastError.ts }
      : null,
    externalReachability: redactReachabilityForPublic(reachability),
  };
  return Response.json(publicBody, { status: httpStatus });
}

/**
 * Strip wanIp from any VoiceProbeResult exposed via /health/voice. The
 * unredacted result is owner-only on /admin/api/voice/state.
 */
function redactReachabilityForPublic(
  state: VoiceReachabilityState | null,
): unknown {
  if (state === null) return null;
  const stripResult = (r: VoiceProbeResult): unknown => {
    const { wanIp: _wanIp, ...rest } = r;
    return { ...rest, wanIp: null };
  };
  if (state.status === "checking") {
    return {
      status: "checking",
      lastResult: state.lastResult ? stripResult(state.lastResult) : null,
    };
  }
  return { status: state.status, result: stripResult(state.result) };
}

// GET /admin/api/voice/state
//
// Reports activation status, relay mode, secret rotation timestamp, and
// configured port bindings. Owner-only — caller is already gated by the
// requireMinLevel(80) check in handleAdminApi.
async function handleAdminVoiceState(deps: HttpDependencies): Promise<Response> {
  const sup = deps.getVoiceSupervisor?.();
  if (!sup) {
    return Response.json({
      activated: false,
      registered: false,
      // Phase 2 ships only self-host; relay_mode is desktop-side activation
      // state per spec-24 and surfaced here for parity.
      relayMode: "self_host" as const,
      secretRotatedAt: null,
      ports: null,
      health: {
        status: "disabled" as const,
        livekitVersion: null,
        uptimeMs: null,
        lastError: null,
        activeRooms: 0,
        activeParticipants: 0,
      },
      externalReachability: null,
    });
  }
  const health = await sup.health();
  const ports = sup.getPorts();
  const secretRotatedAt = deps.getVoiceSecretRotatedAt?.() ?? null;
  // Owner-only endpoint — surface the unredacted reachability state
  // (wanIp included). Public consumers see the redacted form on
  // /health/voice.
  const externalReachability = deps.getReachability?.()?.getState() ?? null;
  return Response.json({
    // "activated" tracks whether at least one plugin is currently claiming
    // the supervisor — the runtime's local view of activation. Desktop-side
    // activation state (the consent flow) is held in the server registry.
    activated: sup.claimerCount() > 0,
    registered: true,
    relayMode: "self_host" as const,
    secretRotatedAt,
    ports: {
      signaling: ports.signaling,
      rtcTcp: ports.rtcTcp,
      rtcUdpPort: ports.rtcUdpPort,
      // Amendment C: TURN/STUN port that Central probes from the public
      // internet. Owner UI surfaces this in the voice setup modal so the
      // user knows which port to forward.
      turnUdpPort: ports.turnUdpPort,
    },
    health,
    externalReachability,
  });
}

// POST /admin/api/voice/probe
//
// Owner-driven manual reachability probe. Bypasses the 60s post-probe
// cooldown that gates the three automatic triggers (boot/wan_change/
// ice_cluster). Returns the fresh VoiceProbeResult on success.
async function handleAdminVoiceProbe(
  deps: HttpDependencies,
  user: AuthenticatedUser,
): Promise<Response> {
  const reachability = deps.getReachability?.();
  if (!reachability) {
    return Response.json(
      { error: { code: "VOICE_DISABLED", message: "Voice is not activated on this server." } },
      { status: 409 },
    );
  }
  const result = await reachability.requestProbe("manual");
  if (result.ok) {
    recordAudit(deps, user, "voice.probe", "voice", "reachability", {
      status: result.result.status,
    });
    return Response.json({ ok: true, result: result.result });
  }
  // Manual bypasses the runtime-side cooldown, but Central enforces its own
  // 60s per-server cooldown — that surfaces as `code: "cooldown"` here. An
  // in-flight probe is also distinct so the UI can wait rather than retry-spam.
  const httpStatus =
    result.code === "in_flight" ? 409 : result.code === "cooldown" ? 429 : 502;
  const headers: Record<string, string> = {};
  if (result.code === "cooldown" && result.retryAfterMs !== undefined) {
    headers["Retry-After"] = String(Math.ceil(result.retryAfterMs / 1000));
  }
  return Response.json(
    {
      error: {
        code:
          result.code === "in_flight"
            ? "VOICE_PROBE_IN_FLIGHT"
            : result.code === "cooldown"
              ? "VOICE_PROBE_COOLDOWN"
              : "VOICE_PROBE_FAILED",
        message: result.message,
        ...(result.retryAfterMs !== undefined ? { retryAfterMs: result.retryAfterMs } : {}),
      },
    },
    { status: httpStatus, headers },
  );
}

// POST /admin/api/voice/probe-direct-token
//
// Spec-24 Amendment C diagnostic. Mints a short-lived (30s) LiveKit join token
// scoped to a synthetic `__diag_direct_probe__` channel so the browser can run
// a direct-UDP-50000 path test: connect to LiveKit, read the negotiated ICE
// candidate-pair via `RTCPeerConnection.getStats()`, then disconnect.
//
// canPublishData stays true so the publisher PeerConnection is actually
// created during connect() — without it LiveKit may skip ICE negotiation
// entirely (no tracks, no data channel = no PC), and the candidate-pair
// classifier would have nothing to read. Audio/video publish + subscribe
// are both off; this token can only open the data channel which we never
// write to. Owner-only — locked behind the same level≥80 gate as the other
// voice admin routes.
//
// Returns 409 VOICE_DISABLED when voice isn't provisioned (no public URL or
// no credentials persisted yet) — the modal renders this as "voice not set
// up yet" rather than the probe-failed state.
async function handleAdminVoiceProbeDirectToken(
  deps: HttpDependencies,
  user: AuthenticatedUser,
): Promise<Response> {
  const getCreds = deps.getLiveKitCredentials;
  const getUrl = deps.getVoicePublicUrl;
  const getServerId = deps.getServerId;
  const url = getUrl?.();
  if (!getCreds || !getUrl || !getServerId || !url) {
    return Response.json(
      { error: { code: "VOICE_DISABLED", message: "Voice is not activated on this server." } },
      { status: 409 },
    );
  }
  let creds: { apiKey: string; apiSecret: string };
  try {
    creds = await getCreds();
  } catch (err) {
    log.warn("voice probe-direct-token: credential read failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return Response.json(
      { error: { code: "VOICE_DISABLED", message: "Voice credentials are not available." } },
      { status: 409 },
    );
  }
  const minted = await mintJoinToken({
    apiKey: creds.apiKey,
    apiSecret: creds.apiSecret,
    serverId: getServerId(),
    channelId: "__diag_direct_probe__",
    userId: user.id,
    ttlSeconds: 30,
    grants: { canPublish: false, canSubscribe: false, canPublishData: true },
    canPublishSources: ["microphone"],
  });
  recordAudit(deps, user, "voice.probe_direct_token", "voice", "livekit", {
    room: minted.room,
  });
  return Response.json({
    ok: true,
    token: minted.token,
    url,
    room: minted.room,
    expiresAt: minted.expiresAt,
  });
}

// POST /admin/api/voice/rotate-secret
//
// Generate a fresh LiveKit API secret, persist encrypted, and bounce the
// supervisor so live JWTs minted under the previous secret are rejected.
async function handleAdminVoiceRotateSecret(
  deps: HttpDependencies,
  user: AuthenticatedUser,
): Promise<Response> {
  const sup = deps.getVoiceSupervisor?.();
  if (!sup) {
    return Response.json(
      { error: { code: "VOICE_DISABLED", message: "Voice is not activated on this server." } },
      { status: 409 },
    );
  }
  try {
    await sup.rotateSecret();
  } catch (err) {
    return Response.json(
      {
        error: {
          code: "VOICE_ROTATE_FAILED",
          message: err instanceof Error ? err.message : String(err),
        },
      },
      { status: 500 },
    );
  }
  recordAudit(deps, user, "voice.rotate_secret", "voice", "livekit", {});
  const rotatedAt = deps.getVoiceSecretRotatedAt?.() ?? null;
  return Response.json({ ok: true, rotatedAt });
}

// POST /admin/api/voice/restart
//
// Forcibly bounce the LiveKit child process. Goes through the supervisor's
// serialized op queue so a concurrent claim/release can't interleave.
async function handleAdminVoiceRestart(
  deps: HttpDependencies,
  user: AuthenticatedUser,
): Promise<Response> {
  const sup = deps.getVoiceSupervisor?.();
  if (!sup) {
    return Response.json(
      { error: { code: "VOICE_DISABLED", message: "Voice is not activated on this server." } },
      { status: 409 },
    );
  }
  try {
    await sup.adminRestart();
  } catch (err) {
    return Response.json(
      {
        error: {
          code: "VOICE_RESTART_FAILED",
          message: err instanceof Error ? err.message : String(err),
        },
      },
      { status: 500 },
    );
  }
  recordAudit(deps, user, "voice.restart", "voice", "livekit", {});
  const health = await sup.health();
  return Response.json({ ok: true, health });
}

// /admin/api/*
async function handleAdminApi(
  request: Request,
  params: Record<string, string>,
  deps: HttpDependencies,
  rateLimiter: RateLimiter,
  clientIp: string,
): Promise<Response> {
  const path = params["path"] ?? "";

  // Preflight for any admin API path. ACAO is attached by the dispatcher when
  // the request's Origin matches deps.allowedOrigins; browsers then complete
  // the preflight. Unlisted origins receive no ACAO and the preflight fails.
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: adminApiCorsHeaders(),
    });
  }

  // Bootstrap is intentionally auth-only so the web shell can discover access.
  if (request.method === "GET" && path === "bootstrap") {
    const auth = await extractAuth(request, deps.tokenValidator);
    if (!auth.ok) {
      rateLimiter.recordAuthFailure(clientIp);
      return auth.response;
    }
    rateLimiter.recordAuthSuccess(clientIp);

    const rateResult = rateLimiter.consume(`user:${auth.user.id}`, RATE_ADMIN);
    if (!rateResult.allowed) {
      return rateLimitedResponse(rateResult.retryAfterMs);
    }

    const adminAccess = requireMinLevel(auth.user, 80, deps.rolesEngine) === null;
    // ACAO is attached by the dispatcher (route.corsAuth). Method/header
    // negotiation lives on the OPTIONS preflight; GET responses only need ACAO.
    return Response.json({
      adminAccess,
      user: {
        id: auth.user.id,
        role: auth.user.role,
      },
    });
  }

  // Update-state read is auth-only — D4 in decisions.md: every connected client
  // sees the pill, only the install action is gated by `core.runtime.update`.
  // Sits before the admin gate so non-admin members can still poll on reload.
  if (request.method === "GET" && path === "update-state") {
    const auth = await extractAuth(request, deps.tokenValidator);
    if (!auth.ok) {
      rateLimiter.recordAuthFailure(clientIp);
      return auth.response;
    }
    rateLimiter.recordAuthSuccess(clientIp);

    const rateResult = rateLimiter.consume(`user:${auth.user.id}`, RATE_ADMIN);
    if (!rateResult.allowed) {
      return rateLimitedResponse(rateResult.retryAfterMs);
    }

    return Response.json(deps.getUpdateState());
  }

  // Update-state write is the orchestrator's path into the runtime — gated by
  // the named `core.runtime.update` permission (D5: default level 80 = owner +
  // admin, but explicitly grantable down to a trusted ops role). Skips the
  // generic level-80 admin gate because the named permission *is* the gate.
  if (request.method === "POST" && path === "update-state") {
    const auth = await extractAuth(request, deps.tokenValidator);
    if (!auth.ok) {
      rateLimiter.recordAuthFailure(clientIp);
      return auth.response;
    }
    rateLimiter.recordAuthSuccess(clientIp);

    const rateResult = rateLimiter.consume(`user:${auth.user.id}`, RATE_ADMIN);
    if (!rateResult.allowed) {
      return rateLimitedResponse(rateResult.retryAfterMs);
    }

    const allowed = deps.rolesEngine.check(auth.user.id, "core.runtime.update", {
      userId: auth.user.id,
      isOwner: auth.user.role === "owner",
    });
    if (!allowed) {
      return Response.json(
        { error: { code: "FORBIDDEN", message: "core.runtime.update permission required." } },
        { status: 403 },
      );
    }

    const body = await parseJsonBody<Record<string, unknown>>(request);
    if (!body.ok) return body.response;

    const patch = parseUpdateStatePatch(body.value);
    if (!patch.ok) {
      return badRequest("INVALID_BODY", patch.error);
    }

    const next = deps.setUpdateState(patch.value);
    recordAudit(deps, auth.user, "runtime.update_state.set", "runtime", "update-state", {
      // Audit captures only the patch keys + their values — the full state is
      // already on /admin/api/update-state so duplicating it here would just
      // bloat the audit log.
      patch: patch.value,
    });
    return Response.json(next);
  }

  // Phase 01 §11.3: orchestrator-driven update-check trigger. The runtime
  // doesn't *do* the check — it flips state to "checking" and fires the WS
  // broadcast; the orchestrator is the actor that resolves the next image and
  // pushes the resulting state back via POST /admin/api/update-state.
  // Per-server token bucket (1/30s) prevents the UI from flickering and keeps
  // the orchestrator's image-resolution path from being spammed.
  if (request.method === "POST" && path === "check-update") {
    const auth = await extractAuth(request, deps.tokenValidator);
    if (!auth.ok) {
      rateLimiter.recordAuthFailure(clientIp);
      return auth.response;
    }
    rateLimiter.recordAuthSuccess(clientIp);

    const allowed = deps.rolesEngine.check(auth.user.id, "core.runtime.update", {
      userId: auth.user.id,
      isOwner: auth.user.role === "owner",
    });
    if (!allowed) {
      return Response.json(
        { error: { code: "FORBIDDEN", message: "core.runtime.update permission required." } },
        { status: 403 },
      );
    }

    // Single shared bucket per server — every authenticated caller draws from
    // the same well, so two admins clicking "check" in the same window only
    // produces one transition instead of two.
    const rateResult = rateLimiter.consume("runtime:check-update", RATE_CHECK_UPDATE);
    if (!rateResult.allowed) {
      return rateLimitedResponse(rateResult.retryAfterMs);
    }

    const next = deps.setUpdateState({
      state: "checking",
      lastCheckedAt: Date.now(),
      errorContext: null,
      errorMessage: null,
    });
    recordAudit(deps, auth.user, "runtime.check_update", "runtime", "update-state", {});
    return Response.json(next);
  }

  // Phase 01 §11.4: structured update log for the runtime panel's "logs" link
  // off error states. Auth + `core.runtime.update` (D5) — viewing the log is
  // only useful to the operator who can act on it. Rate-limited under the
  // shared admin bucket since this is poll-friendly UI traffic.
  if (request.method === "GET" && path === "update-log") {
    const auth = await extractAuth(request, deps.tokenValidator);
    if (!auth.ok) {
      rateLimiter.recordAuthFailure(clientIp);
      return auth.response;
    }
    rateLimiter.recordAuthSuccess(clientIp);

    const rateResult = rateLimiter.consume(`user:${auth.user.id}`, RATE_ADMIN);
    if (!rateResult.allowed) {
      return rateLimitedResponse(rateResult.retryAfterMs);
    }

    const allowed = deps.rolesEngine.check(auth.user.id, "core.runtime.update", {
      userId: auth.user.id,
      isOwner: auth.user.role === "owner",
    });
    if (!allowed) {
      return Response.json(
        { error: { code: "FORBIDDEN", message: "core.runtime.update permission required." } },
        { status: 403 },
      );
    }

    return Response.json({ entries: deps.getUpdateLog() });
  }

  const adminAuth = await requireAdminAuth(request, deps, rateLimiter, clientIp);
  if (!adminAuth.ok) return adminAuth.response;
  const user = adminAuth.user;

  const forbidden = requireMinLevel(user, 80, deps.rolesEngine);
  if (forbidden) return forbidden;

  if (request.method === "GET" && path === "roles") {
    return Response.json(getRolesPayload(deps));
  }

  if (request.method === "POST" && path === "roles") {
    const body = await parseJsonBody<{
      name?: string;
      level?: number;
      permissions?: Record<string, boolean | null>;
    }>(request);
    if (!body.ok) return body.response;
    if (typeof body.value.name !== "string" || typeof body.value.level !== "number") {
      return badRequest("INVALID_BODY", "name and level are required.");
    }

    const caller = { userId: user.id, isOwner: user.role === "owner" };
    const created = deps.rolesEngine.createRole(
      { name: body.value.name, level: body.value.level },
      caller,
    );
    if (!created.ok) {
      return Response.json({ error: created.error }, { status: 400 });
    }

    const permResult = applyRolePermissionOverrides(
      deps,
      created.value.id,
      body.value.permissions,
      caller,
    );
    if (!permResult.ok) return permResult.response;

    recordAudit(deps, user, "role.create", "role", String(created.value.id), {
      name: created.value.name,
      level: created.value.level,
      permissions: body.value.permissions ?? {},
    });
    return Response.json({ role: created.value }, { status: 201 });
  }

  const roleMatch = path.match(/^roles\/(\d+)$/);
  if (roleMatch) {
    const roleId = Number(roleMatch[1]);
    if (request.method === "PATCH") {
      const body = await parseJsonBody<{
        name?: string;
        level?: number;
        permissions?: Record<string, boolean | null>;
      }>(request);
      if (!body.ok) return body.response;
      const caller = { userId: user.id, isOwner: user.role === "owner" };
      const updateInput: { name?: string; level?: number } = {};
      if (body.value.name !== undefined) updateInput.name = body.value.name;
      if (body.value.level !== undefined) updateInput.level = body.value.level;
      const updated = deps.rolesEngine.updateRole(roleId, {
        ...updateInput,
      }, caller);
      if (!updated.ok) {
        return Response.json({ error: updated.error }, { status: 400 });
      }
      const permResult = applyRolePermissionOverrides(
        deps,
        roleId,
        body.value.permissions,
        caller,
      );
      if (!permResult.ok) return permResult.response;

      recordAudit(deps, user, "role.update", "role", String(roleId), body.value);
      return Response.json({ role: updated.value });
    }

    if (request.method === "DELETE") {
      const caller = { userId: user.id, isOwner: user.role === "owner" };
      const deleted = deps.rolesEngine.deleteRole(roleId, caller);
      if (!deleted.ok) {
        return Response.json({ error: deleted.error }, { status: 400 });
      }
      recordAudit(deps, user, "role.delete", "role", String(roleId), {});
      return Response.json({ ok: true });
    }
  }

  if (request.method === "GET" && path === "plugins") {
    const plugins = deps
      .getInstalledPlugins()
      .map((plugin) => serializeAdminPlugin(plugin, deps))
      .sort((a, b) => a.slug.localeCompare(b.slug));
    return Response.json({ plugins });
  }

  const pluginPatchMatch = path.match(/^plugins\/([a-z][a-z0-9]*(?:-[a-z0-9]+)*)$/);
  if (pluginPatchMatch && request.method === "PATCH") {
    const slug = pluginPatchMatch[1]!;
    const pluginExists = deps.getInstalledPlugins().some((p) => p.slug === slug);
    if (!pluginExists) {
      return Response.json(
        { error: { code: "PLUGIN_NOT_FOUND", message: `Plugin "${slug}" not found.` } },
        { status: 404 },
      );
    }

    const body = await parseJsonBody<{ enabled?: boolean }>(request);
    if (!body.ok) return body.response;
    if (typeof body.value.enabled !== "boolean") {
      return badRequest("INVALID_BODY", "enabled boolean is required.");
    }

    const now = Date.now();
    deps.coreDb.run(
      `INSERT INTO plugin_settings (slug, disabled, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT (slug) DO UPDATE SET disabled = excluded.disabled, updated_at = excluded.updated_at`,
      [slug, body.value.enabled ? 0 : 1, now],
    );

    if (!body.value.enabled) {
      await deps.stopPlugin(slug);
      recordAudit(deps, user, "plugin.set_enabled", "plugin", slug, {
        enabled: false,
        stopped: true,
      });

      return Response.json({
        slug,
        disabled: true,
        stopped: true,
      });
    }

    recordAudit(deps, user, "plugin.set_enabled", "plugin", slug, {
      enabled: true,
      requiresRestart: true,
    });

    return Response.json({
      slug,
      enabled: true,
      requiresRestart: true,
    });
  }

  const pluginConfigMatch = path.match(/^plugins\/([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\/config$/);
  if (pluginConfigMatch && (request.method === "GET" || request.method === "PATCH")) {
    const slug = pluginConfigMatch[1]!;
    const plugin = deps.getInstalledPlugins().find((p) => p.slug === slug);
    if (!plugin) {
      return Response.json(
        { error: { code: "PLUGIN_NOT_FOUND", message: `Plugin "${slug}" not found.` } },
        { status: 404 },
      );
    }

    const settings: PluginSetting[] = plugin.manifest.settings ?? [];

    if (request.method === "GET") {
      const db = deps.getPluginDb(slug);
      db.exec(ENSURE_CONFIG_TABLE_SQL);
      const rows = db
        .query<{ key: string; value: string; type: string }, []>(
          "SELECT key, value, type FROM _config",
        )
        .all();
      const merged = mergeConfigWithDefaults(settings, rows);
      // Mask secrets for the admin response — store keeps the real value.
      for (const setting of settings) {
        if (setting.type !== "secret") continue;
        const stored = rows.find((r) => r.key === setting.key);
        merged[setting.key] = stored && stored.value.length > 0 ? "__redacted__" : "";
      }
      return Response.json({ slug, settings, values: merged });
    }

    // PATCH — validate and persist a single key/value.
    const body = await parseJsonBody<{ key?: unknown; value?: unknown }>(request);
    if (!body.ok) return body.response;
    const { key, value } = body.value;
    if (typeof key !== "string" || key.length === 0) {
      return badRequest("INVALID_KEY", "key must be a non-empty string.");
    }
    const setting = settings.find((s) => s.key === key);
    if (!setting) {
      return badRequest("UNKNOWN_SETTING", `Setting "${key}" is not declared in the plugin manifest.`);
    }

    const validation = validateSettingValue(setting, value);
    if (!validation.ok) return badRequest(validation.code, validation.message);
    const typedValue = validation.value;

    // Secret guard: reject the literal mask sentinel — UI must never round-trip it.
    if (setting.type === "secret" && typedValue === "__redacted__") {
      return badRequest("INVALID_VALUE", "The literal mask sentinel cannot be used as a secret value.");
    }

    const db = deps.getPluginDb(slug);
    db.exec(ENSURE_CONFIG_TABLE_SQL);
    const now = Date.now();
    const encoded = encodeConfigValue(typedValue, setting.type);
    db.run(
      `INSERT INTO _config (key, value, type, updated_at, updated_by_user_id)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET
         value = excluded.value,
         type = excluded.type,
         updated_at = excluded.updated_at,
         updated_by_user_id = excluded.updated_by_user_id`,
      [key, encoded, setting.type, now, user.id],
    );

    // Invalidate any proxy approval backed by this setting. Changing a mount's
    // upstream setting disables the mount until an owner re-approves (Phase 4) —
    // config writes may only invalidate, never create. The runtime also
    // re-checks the normalized upstream against the approval on every proxy
    // request, so this is defense-in-depth, not the sole guarantee.
    if (plugin.manifest.proxy_mounts?.some((m) => m.upstream_setting === key)) {
      const removed = new ProxyApprovalStore(deps.coreDb).invalidateBySettingKey(slug, key);
      if (removed > 0) {
        recordAudit(deps, user, "proxy.approval_invalidated", "plugin", slug, { upstream_setting: key, mounts: removed });
      }
    }

    // Push core.plugin.config_changed to the live plugin process (if any).
    const proc = deps.getPluginProcess(slug);
    if (proc?.state === "ready") {
      proc.transport.send({
        type: "core.plugin.config_changed",
        key,
        value: typedValue,
        changed_by_user_id: user.id,
        ts: now,
      } as unknown as import("../ipc/transport").IpcMessage);
    }

    // Audit — secrets carry only `{ key, set: true }`; non-secrets include the value.
    const auditPayload: Record<string, unknown> =
      setting.type === "secret"
        ? { key, set: typeof typedValue === "string" && typedValue.length > 0 }
        : { key, value: typedValue };
    recordAudit(deps, user, "plugin.config_set", "plugin", slug, auditPayload);

    // Echo non-secret values; for secrets return the mask state.
    const responseValue =
      setting.type === "secret"
        ? typeof typedValue === "string" && typedValue.length > 0
          ? "__redacted__"
          : ""
        : typedValue;
    return Response.json({ ok: true, key, value: responseValue });
  }

  const pluginLogsMatch = path.match(/^plugins\/([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\/logs$/);
  if (pluginLogsMatch && request.method === "GET") {
    const slug = pluginLogsMatch[1]!;
    const pluginExists = deps.getInstalledPlugins().some((p) => p.slug === slug);
    if (!pluginExists) {
      return Response.json(
        { error: { code: "PLUGIN_NOT_FOUND", message: `Plugin "${slug}" not found.` } },
        { status: 404 },
      );
    }

    const url = new URL(request.url);
    const limit = boundedInt(url.searchParams.get("limit"), 200, 1, 1000);
    const logs = deps.getPluginLogs(slug, limit);
    return Response.json({ slug, logs });
  }

  if (request.method === "GET" && path === "audit") {
    const url = new URL(request.url);
    const limit = boundedInt(url.searchParams.get("limit"), 200, 1, 1000);
    const rows = deps.coreDb
      .query<{
        id: number;
        ts: number;
        actor_user_id: string;
        actor_role: string;
        action: string;
        target_type: string | null;
        target_id: string | null;
        payload_json: string;
      }, [number]>(
        `SELECT id, ts, actor_user_id, actor_role, action, target_type, target_id, payload_json
         FROM admin_audit_log
         ORDER BY id DESC
         LIMIT ?`,
      )
      .all(limit)
      .map((row) => ({
        id: row.id,
        ts: row.ts,
        actorUserId: row.actor_user_id,
        actorRole: row.actor_role,
        action: row.action,
        targetType: row.target_type,
        targetId: row.target_id,
        payload: safeParseJson(row.payload_json),
      }));
    return Response.json({ events: rows });
  }

  if (path === "cascade" && request.method === "GET") {
    const rows = deps.coreDb
      .query<{
        id: number;
        source_plugin: string;
        event_topic: string;
        target_plugin: string;
        target_action: string;
        enabled: number;
        created_at: number;
        updated_at: number;
      }, []>(
        `SELECT id, source_plugin, event_topic, target_plugin, target_action, enabled, created_at, updated_at
         FROM cascade_rules
         ORDER BY id DESC`,
      )
      .all()
      .map((row) => ({
        id: row.id,
        sourcePlugin: row.source_plugin,
        eventTopic: row.event_topic,
        targetPlugin: row.target_plugin,
        targetAction: row.target_action,
        enabled: row.enabled === 1,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
    return Response.json({ rules: rows });
  }

  if (path === "cascade" && request.method === "POST") {
    const body = await parseJsonBody<{
      sourcePlugin?: string;
      eventTopic?: string;
      targetPlugin?: string;
      targetAction?: string;
      enabled?: boolean;
    }>(request);
    if (!body.ok) return body.response;

    const sourcePlugin = body.value.sourcePlugin?.trim();
    const eventTopic = body.value.eventTopic?.trim();
    const targetPlugin = body.value.targetPlugin?.trim();
    const targetAction = body.value.targetAction?.trim();
    const enabled = body.value.enabled ?? true;
    if (!sourcePlugin || !eventTopic || !targetPlugin || !targetAction) {
      return badRequest(
        "INVALID_BODY",
        "sourcePlugin, eventTopic, targetPlugin, and targetAction are required.",
      );
    }
    const installed = new Set(deps.getInstalledPlugins().map((plugin) => plugin.slug));
    if (!installed.has(sourcePlugin)) {
      return badRequest(
        "PLUGIN_NOT_INSTALLED",
        `sourcePlugin "${sourcePlugin}" is not installed on this server.`,
      );
    }
    if (!installed.has(targetPlugin)) {
      return badRequest(
        "PLUGIN_NOT_INSTALLED",
        `targetPlugin "${targetPlugin}" is not installed on this server.`,
      );
    }

    const now = Date.now();
    try {
      deps.coreDb.run(
        `INSERT INTO cascade_rules
         (source_plugin, event_topic, target_plugin, target_action, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [sourcePlugin, eventTopic, targetPlugin, targetAction, enabled ? 1 : 0, now, now],
      );
    } catch {
      return Response.json(
        { error: { code: "CASCADE_RULE_CONFLICT", message: "Rule already exists." } },
        { status: 409 },
      );
    }

    const id = deps.coreDb.query<{ id: number }, []>("SELECT last_insert_rowid() as id").get()!.id;
    recordAudit(deps, user, "cascade.create", "cascade_rule", String(id), {
      sourcePlugin,
      eventTopic,
      targetPlugin,
      targetAction,
      enabled,
    });
    return Response.json({ ok: true, id }, { status: 201 });
  }

  const cascadeDeleteMatch = path.match(/^cascade\/(\d+)$/);
  if (cascadeDeleteMatch && request.method === "DELETE") {
    const id = Number(cascadeDeleteMatch[1]);
    const result = deps.coreDb.run("DELETE FROM cascade_rules WHERE id = ?", [id]);
    if (result.changes === 0) {
      return Response.json(
        { error: { code: "NOT_FOUND", message: "Cascade rule not found." } },
        { status: 404 },
      );
    }
    recordAudit(deps, user, "cascade.delete", "cascade_rule", String(id), {});
    return Response.json({ ok: true });
  }

  if (path === "icon" && request.method === "POST") {
    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return Response.json(
        { error: { code: "BAD_REQUEST", message: "Expected multipart form data." } },
        { status: 400 },
      );
    }
    const file = formData.get("icon");
    if (!(file instanceof File)) {
      return Response.json(
        { error: { code: "BAD_REQUEST", message: "Missing 'icon' file field." } },
        { status: 400 },
      );
    }
    const allowed = ["image/png", "image/jpeg", "image/webp", "image/gif"];
    if (!allowed.includes(file.type)) {
      return Response.json(
        { error: { code: "BAD_REQUEST", message: "Icon must be PNG, JPEG, WebP, or GIF." } },
        { status: 400 },
      );
    }
    const bytes = await file.arrayBuffer();
    await Bun.write(ICON_PATH, bytes);
    await Bun.write(ICON_TYPE_PATH, file.type);
    recordAudit(deps, user, "settings.icon_updated", "server", "icon", {});
    // Tell every connected client the icon changed so they re-fetch with a
    // fresh cache buster. Without this, a viewer who joined before the owner
    // uploaded would stay on the SVG letter-avatar fallback (200 response,
    // not an error) until they hard-refresh.
    const updatedAt = Date.now();
    deps.broadcastEvent("runtime.icon.changed", { updatedAt });
    return Response.json({ ok: true, updatedAt });
  }

  // ---------------------------------------------------------------------
  // /admin/api/voice/* — owner-gated voice subsystem control
  // ---------------------------------------------------------------------

  if (path === "voice/state" && request.method === "GET") {
    return handleAdminVoiceState(deps);
  }

  if (path === "voice/rotate-secret" && request.method === "POST") {
    return handleAdminVoiceRotateSecret(deps, user);
  }

  if (path === "voice/restart" && request.method === "POST") {
    return handleAdminVoiceRestart(deps, user);
  }

  if (path === "voice/probe" && request.method === "POST") {
    return handleAdminVoiceProbe(deps, user);
  }

  if (path === "voice/probe-direct-token" && request.method === "POST") {
    return handleAdminVoiceProbeDirectToken(deps, user);
  }

  return Response.json(
    { error: { code: "NOT_FOUND", message: "Unknown admin API route." } },
    { status: 404 },
  );
}

function serializeAdminPlugin(
  plugin: InstalledPluginInfo,
  deps: HttpDependencies,
): {
  slug: string;
  manifest: InstalledPluginInfo["manifest"];
  state: PluginState | null;
  statusLabel: "ready" | "starting" | "stopped" | "quarantined";
  enabled: boolean;
  hasSettings: boolean;
} {
  const row = deps.coreDb
    .query<{ disabled: number }, [string]>(
      "SELECT disabled FROM plugin_settings WHERE slug = ?",
    )
    .get(plugin.slug);
  const enabled = (row?.disabled ?? 0) === 0;
  const state = deps.getPluginRuntimeState(plugin.slug) ?? null;
  return {
    slug: plugin.slug,
    manifest: plugin.manifest,
    state,
    statusLabel: toStatusLabel(state),
    enabled,
    hasSettings: (plugin.manifest.settings?.length ?? 0) > 0,
  };
}

/**
 * Validates a `PATCH /admin/api/plugins/:slug/config` value against the
 * manifest schema. Returns the typed value on success or a `{ code, message }`
 * pair the route turns into a 400.
 */
type SettingValidation =
  | { ok: true; value: string | number | boolean }
  | { ok: false; code: string; message: string };

function validateSettingValue(setting: PluginSetting, raw: unknown): SettingValidation {
  if (setting.type === "boolean") {
    if (typeof raw !== "boolean") {
      return { ok: false, code: "TYPE_MISMATCH", message: `Setting "${setting.key}" requires a boolean.` };
    }
    return { ok: true, value: raw };
  }
  if (setting.type === "number") {
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      return { ok: false, code: "TYPE_MISMATCH", message: `Setting "${setting.key}" requires a finite number.` };
    }
    if (setting.min !== undefined && raw < setting.min) {
      return { ok: false, code: "OUT_OF_RANGE", message: `Setting "${setting.key}" must be >= ${setting.min}.` };
    }
    if (setting.max !== undefined && raw > setting.max) {
      return { ok: false, code: "OUT_OF_RANGE", message: `Setting "${setting.key}" must be <= ${setting.max}.` };
    }
    return { ok: true, value: raw };
  }
  // string | secret
  if (typeof raw !== "string") {
    return { ok: false, code: "TYPE_MISMATCH", message: `Setting "${setting.key}" requires a string.` };
  }
  if (setting.max_length !== undefined && raw.length > setting.max_length) {
    return {
      ok: false,
      code: "TOO_LONG",
      message: `Setting "${setting.key}" exceeds max length ${setting.max_length}.`,
    };
  }
  if (setting.type === "string" && setting.enum && setting.enum.length > 0) {
    if (!setting.enum.includes(raw)) {
      return {
        ok: false,
        code: "INVALID_ENUM",
        message: `Setting "${setting.key}" must be one of: ${setting.enum.join(", ")}.`,
      };
    }
  }
  return { ok: true, value: raw };
}

function toStatusLabel(state: PluginState | null): "ready" | "starting" | "stopped" | "quarantined" {
  if (state === "ready") return "ready";
  if (state === "starting") return "starting";
  if (state === "quarantined") return "quarantined";
  return "stopped";
}

function getRolesPayload(deps: HttpDependencies): {
  roles: Array<{
    id: number;
    name: string;
    level: number;
    isDefault: boolean;
    parentRole: number | null;
    createdAt: number;
    updatedAt: number;
    permissions: Record<string, boolean>;
  }>;
  permissions: Array<{
    id: number;
    key: string;
    description: string;
    defaultLevel: number;
    pluginSlug: string;
    registeredAt: number;
  }>;
} {
  const roles = deps.rolesEngine.getRoles();
  const permissions = deps.rolesEngine.getPermissions();
  const overrideRows = deps.coreDb
    .query<{ role_id: number; key: string; granted: number }, []>(
      `SELECT rp.role_id, p.key, rp.granted
       FROM role_permissions rp
       JOIN permissions p ON p.id = rp.permission_id`,
    )
    .all();
  const overrideMap = new Map<number, Record<string, boolean>>();
  for (const row of overrideRows) {
    const entry = overrideMap.get(row.role_id) ?? {};
    entry[row.key] = row.granted === 1;
    overrideMap.set(row.role_id, entry);
  }

  return {
    roles: roles.map((role) => ({
      ...role,
      permissions: overrideMap.get(role.id) ?? {},
    })),
    permissions,
  };
}

function applyRolePermissionOverrides(
  deps: HttpDependencies,
  roleId: number,
  overrides: Record<string, boolean | null> | undefined,
  caller: { userId: string; isOwner: boolean },
): { ok: true } | { ok: false; response: Response } {
  if (!overrides) return { ok: true };
  for (const [key, value] of Object.entries(overrides)) {
    const result = value === null
      ? deps.rolesEngine.removePermissionOverride(roleId, key, caller)
      : value
        ? deps.rolesEngine.grantPermission(roleId, key, caller)
        : deps.rolesEngine.denyPermission(roleId, key, caller);
    if (!result.ok) {
      return { ok: false, response: Response.json({ error: result.error }, { status: 400 }) };
    }
  }
  return { ok: true };
}

function recordAudit(
  deps: HttpDependencies,
  user: AuthenticatedUser,
  action: string,
  targetType: string | null,
  targetId: string | null,
  payload: Record<string, unknown>,
): void {
  deps.coreDb.run(
    `INSERT INTO admin_audit_log
     (ts, actor_user_id, actor_role, action, target_type, target_id, payload_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      Date.now(),
      user.id,
      user.role,
      action,
      targetType,
      targetId,
      JSON.stringify(payload),
    ],
  );
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function boundedInt(value: string | null, fallback: number, min: number, max: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function badRequest(code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status: 400 });
}

async function parseJsonBody<T>(
  request: Request,
): Promise<{ ok: true; value: T } | { ok: false; response: Response }> {
  try {
    const body = await request.json() as T;
    return { ok: true, value: body };
  } catch {
    return {
      ok: false,
      response: badRequest("INVALID_JSON", "Request body must be valid JSON."),
    };
  }
}

// Validator for POST /admin/api/update-state payloads. The orchestrator may
// send a full or partial state patch (Phase 01 §11) — every field is optional
// here, but every present field is structurally checked. We don't validate
// state-machine edges (e.g. checking → installing must precede → idle): per
// O8/D3 the runtime is a passive store, not a state-machine arbiter.
const VALID_UPDATE_STATUS = new Set<RuntimeUpdateStatus>([
  "disabled", "idle", "checking", "up-to-date", "available",
  "pending-confirm", "backing-up", "downloading", "downloaded",
  "awaiting-restart", "installing", "rolling-back", "error",
]);
const VALID_UPDATE_CHANNEL = new Set<RuntimeUpdateChannel>(["stable", "beta", "dev"]);
const VALID_UPDATE_ERROR_CONTEXT = new Set<Exclude<RuntimeUpdateErrorContext, null>>([
  "check", "backup", "download", "install", "rollback",
]);

function parseUpdateStatePatch(
  body: Record<string, unknown>,
): { ok: true; value: Partial<RuntimeUpdateState> } | { ok: false; error: string } {
  const out: Partial<RuntimeUpdateState> = {};

  if ("state" in body) {
    const v = body["state"];
    if (typeof v !== "string" || !VALID_UPDATE_STATUS.has(v as RuntimeUpdateStatus)) {
      return { ok: false, error: `Invalid state: ${String(v)}.` };
    }
    out.state = v as RuntimeUpdateStatus;
  }

  if ("errorContext" in body) {
    const v = body["errorContext"];
    if (v !== null && (typeof v !== "string" || !VALID_UPDATE_ERROR_CONTEXT.has(v as Exclude<RuntimeUpdateErrorContext, null>))) {
      return { ok: false, error: `Invalid errorContext: ${String(v)}.` };
    }
    out.errorContext = v as RuntimeUpdateErrorContext;
  }

  if ("currentVersion" in body) {
    const v = body["currentVersion"];
    if (typeof v !== "string") return { ok: false, error: "currentVersion must be a string." };
    out.currentVersion = v;
  }

  if ("availableVersion" in body) {
    const v = body["availableVersion"];
    if (v !== null && typeof v !== "string") {
      return { ok: false, error: "availableVersion must be a string or null." };
    }
    out.availableVersion = v;
  }

  if ("channel" in body) {
    const v = body["channel"];
    if (typeof v !== "string" || !VALID_UPDATE_CHANNEL.has(v as RuntimeUpdateChannel)) {
      return { ok: false, error: `Invalid channel: ${String(v)}.` };
    }
    out.channel = v as RuntimeUpdateChannel;
  }

  if ("progress" in body) {
    const v = body["progress"];
    if (v !== null && (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 100)) {
      return { ok: false, error: "progress must be 0..100 or null." };
    }
    out.progress = v;
  }

  if ("lastCheckedAt" in body) {
    const v = body["lastCheckedAt"];
    if (v !== null && (typeof v !== "number" || !Number.isFinite(v))) {
      return { ok: false, error: "lastCheckedAt must be a number or null." };
    }
    out.lastCheckedAt = v;
  }

  if ("errorMessage" in body) {
    const v = body["errorMessage"];
    if (v !== null && typeof v !== "string") {
      return { ok: false, error: "errorMessage must be a string or null." };
    }
    out.errorMessage = v;
  }

  if ("substep" in body) {
    const v = body["substep"];
    if (v !== null && typeof v !== "string") {
      return { ok: false, error: "substep must be a string or null." };
    }
    // 200-char cap is defense-in-depth — orchestrator is trusted, but a
    // runaway log line accidentally piped into substep should not bloat the
    // WS broadcast. Truncate rather than reject; a partial substep is
    // strictly more useful than no substep.
    out.substep = typeof v === "string" && v.length > 200 ? v.slice(0, 200) : v;
  }

  // updatedAt is intentionally NOT accepted — the store always restamps it
  // with the local clock. See store.ts: caller-supplied updatedAt is dropped.

  return { ok: true, value: out };
}

async function requireAdminAuth(
  request: Request,
  deps: HttpDependencies,
  rateLimiter: RateLimiter,
  clientIp: string,
): Promise<{ ok: true; user: AuthenticatedUser } | { ok: false; response: Response }> {
  const auth = await extractAuth(request, deps.tokenValidator);
  if (!auth.ok) {
    rateLimiter.recordAuthFailure(clientIp);
    return { ok: false, response: auth.response };
  }
  rateLimiter.recordAuthSuccess(clientIp);

  const rateResult = rateLimiter.consume(`user:${auth.user.id}`, RATE_ADMIN);
  if (!rateResult.allowed) {
    return { ok: false, response: rateLimitedResponse(rateResult.retryAfterMs) };
  }
  return { ok: true, user: auth.user };
}

// OPTIONS preflight for /workspace/* endpoints.
async function handleWorkspacePreflight(): Promise<Response> {
  return new Response(null, {
    status: 204,
    headers: workspaceCorsHeaders(),
  });
}

// Preflight CORS headers for /workspace/* endpoints. The dispatcher appends
// Access-Control-Allow-Origin based on deps.allowedOrigins — this helper only
// returns method/header negotiation.
function workspaceCorsHeaders(): Headers {
  return new Headers({
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "600",
  });
}

// Preflight CORS headers for /admin/api/*. ACAO is applied by the dispatcher
// from the configured allowlist; this helper only negotiates methods/headers.
function adminApiCorsHeaders(): Headers {
  return new Headers({
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "600",
  });
}

// GET /plugins/:slug/sidebar
async function handlePluginSidebar(
  request: Request,
  params: Record<string, string>,
  deps: HttpDependencies,
  rateLimiter: RateLimiter,
  clientIp: string,
): Promise<Response> {
  const auth = await extractAuth(request, deps.tokenValidator);
  if (!auth.ok) {
    rateLimiter.recordAuthFailure(clientIp);
    return auth.response;
  }
  rateLimiter.recordAuthSuccess(clientIp);

  // Per-user rate limiting
  const rl = rateLimiter.consume(`user:${auth.user.id}:sidebar`, RATE_ADMIN);
  if (!rl.allowed) {
    return rateLimitedResponse(rl.retryAfterMs);
  }

  const slug = params["slug"]!;
  const plugin = deps.pluginRegistry.getPlugin(slug);
  if (!plugin) {
    return Response.json(
      { error: { code: "NOT_FOUND", message: "Plugin not found." } },
      { status: 404 },
    );
  }

  // Plugin must declare sidebar.contributes = true
  if (!plugin.manifest.sidebar?.contributes) {
    return Response.json({ items: [] });
  }

  const proc = deps.getPluginProcess(slug);
  if (!proc || proc.state !== "ready") {
    return Response.json({ items: [] });
  }

  const { items, adminActions } = await requestSidebarItems(proc, auth.user);
  // G13 — apply manifest-level default section when the item omits its own.
  // The manifest's `sidebar.section` groups this plugin's items under a named
  // section so plugin authors don't have to repeat it in every sidebar.items
  // response.
  const defaultSection = plugin.manifest.sidebar?.section;
  const decoratedItems =
    defaultSection === undefined
      ? items
      : items.map((item) => (item.section === undefined ? { ...item, section: defaultSection } : item));
  // Section-scoped adminActions (e.g. create-channel) ride alongside items so
  // a fresh server with zero items still surfaces the create button. Older
  // plugins that return a bare array continue to work — adminActions is just
  // omitted in that case.
  const body: { items: SidebarItem[]; adminActions?: SidebarAction[] } = { items: decoratedItems };
  if (adminActions) body.adminActions = adminActions;
  return Response.json(body);
}

async function requestSidebarItems(
  proc: PluginProcess,
  user: AuthenticatedUser,
): Promise<{ items: SidebarItem[]; adminActions?: SidebarAction[] }> {
  return new Promise((resolve) => {
    let settled = false;
    const corrId = crypto.randomUUID();

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.transport.offMessage(listener);
      resolve({ items: [] });
    }, 5_000);

    const listener = (msg: Record<string, unknown>) => {
      if (msg["id"] !== corrId) return;
      if (msg["type"] !== "response" && msg["type"] !== "error") return;
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.transport.offMessage(listener);
      const result = msg["result"];
      // Two accepted plugin response shapes:
      //   - bare SidebarItem[] (legacy)
      //   - { items: SidebarItem[], adminActions?: SidebarAction[] } (lifts
      //     create actions to section scope so they persist with zero items)
      if (Array.isArray(result)) {
        resolve({ items: result as SidebarItem[] });
        return;
      }
      if (result !== null && typeof result === "object") {
        const obj = result as { items?: unknown; adminActions?: unknown };
        const items = Array.isArray(obj.items) ? (obj.items as SidebarItem[]) : [];
        const adminActions = Array.isArray(obj.adminActions)
          ? (obj.adminActions as SidebarAction[])
          : undefined;
        resolve(adminActions ? { items, adminActions } : { items });
        return;
      }
      resolve({ items: [] });
    };
    proc.transport.onMessage(listener);

    proc.transport.send({
      type: "request",
      id: corrId,
      action: "sidebar.items",
      params: {},
      user: { id: user.id, displayName: user.displayName, role: user.role },
    });
  });
}

// GET /plugins/:slug/manifest.json
async function handlePluginManifest(
  request: Request,
  params: Record<string, string>,
  deps: HttpDependencies,
  rateLimiter: RateLimiter,
  clientIp: string,
): Promise<Response> {
  const slug = params["slug"]!;
  const plugin = deps.pluginRegistry.getPlugin(slug);
  if (!plugin) {
    return Response.json(
      { error: { code: "PLUGIN_NOT_FOUND", message: `Plugin "${slug}" not found.` } },
      { status: 404 },
    );
  }

  // Private servers require auth to view manifests
  if (deps.config.isPrivate) {
    const auth = await extractAuth(request, deps.tokenValidator);
    if (!auth.ok) {
      rateLimiter.recordAuthFailure(clientIp);
      return auth.response;
    }
    rateLimiter.recordAuthSuccess(clientIp);
  }

  return Response.json(plugin.manifest);
}

// GET /plugins/:slug/ui/*
async function handlePluginUi(
  request: Request,
  params: Record<string, string>,
  deps: HttpDependencies,
  rateLimiter: RateLimiter,
  clientIp: string,
): Promise<Response> {
  const slug = params["slug"]!;
  const plugin = deps.pluginRegistry.getPlugin(slug);
  if (!plugin || !plugin.frontendDir) {
    return Response.json(
      { error: { code: "NOT_FOUND", message: "Plugin or frontend not found." } },
      { status: 404 },
    );
  }

  // Optional auth for plugins that require it
  if (plugin.authenticatedAssets) {
    const auth = await extractAuth(request, deps.tokenValidator);
    if (!auth.ok) {
      rateLimiter.recordAuthFailure(clientIp);
      return auth.response;
    }
    rateLimiter.recordAuthSuccess(clientIp);
  }

  // Default to index.html
  const requestedPath = params["path"] || "index.html";

  // Path traversal guard: reject null bytes
  if (requestedPath.includes("\0")) {
    return Response.json(
      { error: { code: "FORBIDDEN", message: "Invalid path." } },
      { status: 403 },
    );
  }

  // Resolve and verify the path stays within frontendDir
  const normalizedFrontend = normalize(plugin.frontendDir);
  const resolved = resolve(normalizedFrontend, requestedPath);

  if (!resolved.startsWith(normalizedFrontend)) {
    return Response.json(
      { error: { code: "FORBIDDEN", message: "Invalid path." } },
      { status: 403 },
    );
  }

  const file = Bun.file(resolved);
  const exists = await file.exists();
  if (!exists) {
    return Response.json(
      { error: { code: "NOT_FOUND", message: "File not found." } },
      { status: 404 },
    );
  }

  return new Response(file, {
    headers: {
      "Content-Type": file.type || "application/octet-stream",
      "Cache-Control": requestedPath === "index.html"
        ? "no-cache"
        : "public, max-age=3600",
    },
  });
}

// POST /upload — single-shot streaming upload with magic-byte MIME sniff.
//
// Hard ceiling (5 GiB) is enforced both pre-body (Content-Length) and during
// the read loop (counter check on every chunk). The per-server config cap
// (`deps.config.maxUploadBytes`) is applied identically — plugins may impose
// stricter caps in their own sendMessage path; rejected files become orphans
// that the plugin's hourly GC sweep removes.
//
// Streaming pattern: `request.body.getReader()` → `Bun.file(tmp).writer()`
// → `fs.rename` to final path. We never hold the full body in memory, so a
// 5 GiB upload occupies a streaming buffer's worth of RAM (~64 KiB chunks).
//
// The chunked / resumable protocol lives in upload-session.ts (spec-26
// Amendment A) — the SDK switches to that path above SINGLE_SHOT_THRESHOLD
// (50 MiB). The single-shot endpoint stays available at any size below the
// ceiling so legacy clients keep working.
const HARD_UPLOAD_CEILING = 5 * 1024 * 1024 * 1024; // 5 GiB absolute ceiling (spec-26 Amendment A)

// OPTIONS /upload — preflight for sandboxed iframes (Origin: null). The
// dispatcher applies wildcard ACAO via `cors: true`; this handler returns the
// method/header negotiation the browser needs before sending the POST.
function handleUploadPreflight(): Response {
  return new Response(null, {
    status: 204,
    headers: new Headers({
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers":
        "Authorization, Content-Type, Content-Length, X-Plugin, X-Filename",
      "Access-Control-Max-Age": "600",
    }),
  });
}

async function handleUpload(
  request: Request,
  _params: Record<string, string>,
  deps: HttpDependencies,
  rateLimiter: RateLimiter,
  clientIp: string,
): Promise<Response> {
  // Auth first
  const auth = await extractAuth(request, deps.tokenValidator);
  if (!auth.ok) {
    rateLimiter.recordAuthFailure(clientIp);
    return auth.response;
  }
  rateLimiter.recordAuthSuccess(clientIp);

  // Rate limit per user
  const rateResult = rateLimiter.consume(`user:${auth.user.id}`, RATE_UPLOAD);
  if (!rateResult.allowed) {
    return rateLimitedResponse(rateResult.retryAfterMs);
  }

  // Validate X-Plugin header
  const pluginSlug = request.headers.get("x-plugin");
  if (!pluginSlug) {
    return Response.json(
      { error: { code: "MISSING_PLUGIN_HEADER", message: "X-Plugin header is required." } },
      { status: 400 },
    );
  }

  // Look up plugin
  const plugin = deps.pluginRegistry.getPlugin(pluginSlug);
  if (!plugin) {
    return Response.json(
      { error: { code: "PLUGIN_NOT_FOUND", message: `Plugin "${pluginSlug}" not found.` } },
      { status: 404 },
    );
  }

  // Check storage.file:self capability
  const checker = new CapabilityChecker(pluginSlug, plugin.manifest.permissions);
  const capCheck = checker.check("storage.file:self");
  if (!capCheck.ok) {
    return Response.json(
      { error: { code: capCheck.code, message: capCheck.message } },
      { status: 403 },
    );
  }

  // Effective ceiling: the lower of HARD_UPLOAD_CEILING and the server config.
  // We always enforce HARD_UPLOAD_CEILING regardless of config (defense in
  // depth against a misconfigured server).
  const effectiveCeiling = Math.min(HARD_UPLOAD_CEILING, deps.config.maxUploadBytes);

  // Pre-flight Content-Length check (cheap rejection).
  const contentLengthRaw = request.headers.get("content-length");
  if (contentLengthRaw === null) {
    return Response.json(
      { error: { code: "LENGTH_REQUIRED", message: "Content-Length header is required." } },
      { status: 411 },
    );
  }
  const declaredSize = parseInt(contentLengthRaw, 10);
  if (!Number.isFinite(declaredSize) || declaredSize < 0) {
    return Response.json(
      { error: { code: "INVALID_CONTENT_LENGTH", message: "Content-Length must be a non-negative integer." } },
      { status: 400 },
    );
  }
  if (declaredSize === 0) {
    return Response.json(
      { error: { code: "EMPTY_BODY", message: "Upload body is empty." } },
      { status: 400 },
    );
  }
  if (declaredSize > effectiveCeiling) {
    return Response.json(
      { error: { code: "PAYLOAD_TOO_LARGE", message: `File exceeds maximum size of ${effectiveCeiling} bytes.` } },
      { status: 413 },
    );
  }

  const body = request.body;
  if (!body) {
    return Response.json(
      { error: { code: "EMPTY_BODY", message: "Upload body is empty." } },
      { status: 400 },
    );
  }

  // Original filename — sent URL-encoded in X-Filename so unicode survives
  // header transport. Cap it at a reasonable length; this is purely metadata
  // for the plugin's DB and never used as a path component on disk.
  const rawFilenameHeader = request.headers.get("x-filename") ?? "";
  let originalName = "";
  try {
    originalName = decodeURIComponent(rawFilenameHeader).slice(0, 255);
  } catch {
    originalName = "";
  }

  // Stream into a .tmp file; rename on success. Atomic-rename prevents a
  // partial write from being served if the upload is cut short.
  const uploadsDir = join(plugin.dataDir, "uploads");
  try {
    await mkdir(uploadsDir, { recursive: true });
  } catch (err) {
    log.error("failed to create uploads dir", { slug: pluginSlug, err: errMsg(err) });
    return Response.json(
      { error: { code: "INTERNAL_ERROR", message: "Failed to prepare storage." } },
      { status: 500 },
    );
  }

  const tmpId = crypto.randomUUID();
  const tmpPath = join(uploadsDir, `${tmpId}.tmp`);
  const writer = Bun.file(tmpPath).writer();
  const reader = body.getReader();

  let bytesWritten = 0;
  // Accumulate the first up-to-64 bytes so we can sniff regardless of how
  // the runtime chunks the stream (first chunk could be a single TLS record
  // of 16 bytes).
  let sniffHead: Uint8Array | null = null;

  const cleanup = async (): Promise<void> => {
    try { await writer.end(); } catch { /* ignore */ }
    try { await unlink(tmpPath); } catch { /* ignore */ }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;

      bytesWritten += value.byteLength;
      if (bytesWritten > effectiveCeiling) {
        try { await reader.cancel(); } catch { /* ignore */ }
        await cleanup();
        return Response.json(
          { error: { code: "PAYLOAD_TOO_LARGE", message: `File exceeds maximum size of ${effectiveCeiling} bytes.` } },
          { status: 413 },
        );
      }
      if (bytesWritten > declaredSize) {
        // Client lied about Content-Length — reject.
        try { await reader.cancel(); } catch { /* ignore */ }
        await cleanup();
        return Response.json(
          { error: { code: "LENGTH_MISMATCH", message: "Body exceeded declared Content-Length." } },
          { status: 400 },
        );
      }

      // Gather first 64 bytes for sniffing.
      if (sniffHead === null) {
        sniffHead = value.subarray(0, Math.min(value.byteLength, 64));
      } else if (sniffHead.length < 64) {
        const head: Uint8Array = sniffHead;
        const need = 64 - head.length;
        const extra = value.subarray(0, Math.min(value.byteLength, need));
        const merged: Uint8Array = new Uint8Array(head.length + extra.length);
        merged.set(head, 0);
        merged.set(extra, head.length);
        sniffHead = merged;
      }

      writer.write(value);
    }
    await writer.end();
  } catch (err) {
    log.error("upload stream failed", { slug: pluginSlug, err: errMsg(err) });
    await cleanup();
    return Response.json(
      { error: { code: "UPLOAD_FAILED", message: "Upload was interrupted." } },
      { status: 500 },
    );
  }

  if (bytesWritten === 0) {
    await cleanup();
    return Response.json(
      { error: { code: "EMPTY_BODY", message: "Upload body is empty." } },
      { status: 400 },
    );
  }

  // Sniff MIME and pick a server-controlled filename. Untrusted client
  // Content-Type header is NEVER reused.
  const sniffed = sniffHead ? sniffMime(sniffHead) : "application/octet-stream";
  const ext = extensionForMime(sniffed);
  const safeFilename = ext ? `${tmpId}.${ext}` : tmpId;
  const finalPath = join(uploadsDir, safeFilename);

  try {
    await rename(tmpPath, finalPath);
  } catch (err) {
    log.error("failed to commit upload", { slug: pluginSlug, err: errMsg(err) });
    await unlink(tmpPath).catch(() => {});
    return Response.json(
      { error: { code: "INTERNAL_ERROR", message: "Failed to commit upload." } },
      { status: 500 },
    );
  }

  const notification: FileUploadNotification = {
    type: "file.uploaded",
    filename: safeFilename,
    path: finalPath,
    size: bytesWritten,
    mimeType: sniffed,
    uploadedBy: auth.user.id,
    uploadedAt: Date.now(),
  };
  deps.notifyPlugin(pluginSlug, notification);

  return Response.json(
    {
      ok: true,
      filename: safeFilename,
      size: bytesWritten,
      mime: sniffed,
      originalName,
    },
    { status: 201 },
  );
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// GET /files/:slug/:filename — signed-URL serve with Range support.
//
// Auth: the URL must carry valid HMAC query params (`t`, `exp`, `u`).
// Bearer tokens are intentionally NOT honored — browsers can't set
// Authorization on <img>/<video> elements, so signed URLs are the only
// viable mechanism for inline media previews.
//
// MIME: we re-sniff the first 64 bytes on every serve so a file flipped on
// disk (out-of-band edit, etc.) can't change the served Content-Type out
// from under nosniff. Only INLINE_SAFE_MIMES are served with `inline`
// disposition; everything else gets `attachment` so a browser won't render
// arbitrary content under the runtime origin.
//
// Per spec-26 §"Serve Response": `?download=1` flips inline → attachment so
// dedicated download buttons work even for previewable types (PDF, image,
// audio, video). The `?n=<urlencoded original_name>` query carries the
// user-facing filename — the on-disk name is a server-generated UUID, so
// without `n` the browser falls back to that UUID. Plugins know the original
// name from their message DB and append it at link-render time.
function buildContentDisposition(inline: boolean, providedName: string | null): string {
  const type = inline ? "inline" : "attachment";
  if (!providedName) return type;
  // Strip header-injection chars (CR/LF), quotes, and backslashes; cap length.
  const safe = providedName.replace(/[\r\n"\\]/g, "").slice(0, 255);
  if (safe.length === 0) return type;
  // RFC 6266: emit both `filename=` (ASCII fallback) and `filename*=UTF-8''`
  // so non-ASCII names survive while old clients still get something usable.
  const asciiFallback = safe.replace(/[^\x20-\x7E]/g, "_");
  return `${type}; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}

async function handleFileGet(
  request: Request,
  params: Record<string, string>,
  deps: HttpDependencies,
  rateLimiter: RateLimiter,
  _clientIp: string,
): Promise<Response> {
  const slug = params["slug"]!;
  const filename = params["filename"]!;

  const url = new URL(request.url);
  const sigResult = verifyFileSig(url.pathname, url.searchParams);
  if (!sigResult.ok) {
    return Response.json(
      { error: { code: "INVALID_SIGNATURE", message: `Signature ${sigResult.reason}.` } },
      { status: 403 },
    );
  }

  // Apply user-scoped rate limit AFTER signature verification (the user id
  // is authoritative once the HMAC checks out).
  const rateResult = rateLimiter.consume(`user:${sigResult.userId}`, RATE_STATIC);
  if (!rateResult.allowed) {
    return rateLimitedResponse(rateResult.retryAfterMs);
  }

  // Filename sanity (matches route regex but defense in depth).
  if (filename.includes("..") || filename.includes("/") || filename.includes("\\") || filename.includes("\0")) {
    return Response.json({ error: { code: "NOT_FOUND", message: "Not found." } }, { status: 404 });
  }

  const plugin = deps.pluginRegistry.getPlugin(slug);
  if (!plugin) {
    return Response.json({ error: { code: "NOT_FOUND", message: "Not found." } }, { status: 404 });
  }

  const uploadsDir = resolve(plugin.dataDir, "uploads");
  const filePath = resolve(uploadsDir, filename);
  // Path-traversal defense: resolved path must remain under uploadsDir.
  if (filePath !== uploadsDir && !filePath.startsWith(uploadsDir + sep)) {
    return Response.json({ error: { code: "NOT_FOUND", message: "Not found." } }, { status: 404 });
  }
  // Refuse to serve .tmp files (in-flight uploads).
  if (filename.endsWith(".tmp")) {
    return Response.json({ error: { code: "NOT_FOUND", message: "Not found." } }, { status: 404 });
  }

  const file = Bun.file(filePath);
  const exists = await file.exists();
  if (!exists) {
    return Response.json({ error: { code: "NOT_FOUND", message: "Not found." } }, { status: 404 });
  }
  const totalSize = file.size;

  // Re-sniff on every serve. Cheap (we only read up to 64 bytes).
  let sniffed = "application/octet-stream";
  if (totalSize > 0) {
    const head = await file.slice(0, Math.min(64, totalSize)).arrayBuffer();
    sniffed = sniffMime(new Uint8Array(head));
  }
  const forceDownload = url.searchParams.get("download") === "1";
  const inline = INLINE_SAFE_MIMES.has(sniffed) && !forceDownload;
  const disposition = buildContentDisposition(inline, url.searchParams.get("n"));

  const headers: Record<string, string> = {
    "Content-Type": sniffed,
    "Content-Disposition": disposition,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, max-age=3600, immutable",
    "Accept-Ranges": "bytes",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Access-Control-Allow-Origin": "*",
  };

  // HEAD: return headers only.
  if (request.method === "HEAD") {
    headers["Content-Length"] = String(totalSize);
    return new Response(null, { status: 200, headers });
  }

  // Range request handling — required for video seeking on large files.
  const rangeHeader = request.headers.get("range");
  if (rangeHeader !== null) {
    // We only support a single byte-range. `bytes=START-END?`
    const m = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader.trim());
    if (!m) {
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${totalSize}`, "Accept-Ranges": "bytes" },
      });
    }
    const start = Number.parseInt(m[1]!, 10);
    const endStr = m[2];
    const end = endStr && endStr.length > 0 ? Number.parseInt(endStr, 10) : totalSize - 1;
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < 0 ||
      end < start ||
      start >= totalSize
    ) {
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${totalSize}`, "Accept-Ranges": "bytes" },
      });
    }
    const clampedEnd = Math.min(end, totalSize - 1);
    headers["Content-Range"] = `bytes ${start}-${clampedEnd}/${totalSize}`;
    headers["Content-Length"] = String(clampedEnd - start + 1);
    return new Response(file.slice(start, clampedEnd + 1), { status: 206, headers });
  }

  headers["Content-Length"] = String(totalSize);
  return new Response(file, { status: 200, headers });
}

// ---------------------------------------------------------------------------
// Startup sweep of stale `.tmp` files (incomplete uploads from a prior boot).
// Called once at runtime startup before listening on the HTTP port.
// ---------------------------------------------------------------------------

const TMP_STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

export async function sweepStaleUploadTmps(
  pluginRegistry: PluginRegistry,
  now: number = Date.now(),
): Promise<{ scanned: number; removed: number }> {
  let scanned = 0;
  let removed = 0;
  for (const plugin of pluginRegistry.listPlugins()) {
    const dir = join(plugin.dataDir, "uploads");
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue; // dir may not exist yet
    }
    for (const name of entries) {
      if (!name.endsWith(".tmp")) continue;
      scanned++;
      const p = join(dir, name);
      try {
        const s = await stat(p);
        if (now - s.mtimeMs > TMP_STALE_THRESHOLD_MS) {
          await unlink(p);
          removed++;
        }
      } catch {
        // best-effort — keep going
      }
    }
  }
  return { scanned, removed };
}
