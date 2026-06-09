// Reverse-proxy HTTP routes.
//
// Two routes live here:
//   POST /proxy-sessions/:slug/:mount  — Bearer-authed bootstrap. Validates the
//     plugin/mount/capability/access/approval, then mints a proxy-session cookie
//     and returns the proxied URL the client should load.
//   ALL  /proxy/:slug/:mount/*         — browser proxy traffic. Validated by the
//     proxy-session cookie ONLY (browsers can't set Authorization on iframe
//     doc-nav / sub-resources). Fails closed: no valid cookie ⇒ no upstream
//     connection.
//
// Phase 2 promotes the proxy route from a minimal passthrough to the production
// forwarder: streaming bodies, full request/response header sanitizer, upstream
// cookie rewriting, manual-redirect containment, connection-time DNS
// classification + drift re-approval, and limits/timeouts. See
// docs/reverse-proxy/plugin-reverse-proxy-plan.md §Phase 2.

import { CapabilityChecker } from "../capabilities/checker";
import { extractAuth } from "./auth";
import { RateLimiter, RATE_PROXY_SESSION } from "./rate-limiter";
import { ENSURE_CONFIG_TABLE_SQL, decodeConfigValue } from "../ipc/handlers";
import {
  ProxyApprovalStore,
  mountDefinitionHash,
  type ProxyApprovalRow,
} from "../proxy/approvals";
import { normalizeUpstream, type NormalizedUpstream } from "../proxy/upstream";
import {
  mintProxySession,
  verifyProxySession,
  buildProxySetCookie,
  readProxyCookie,
} from "../proxy/session";
import {
  sanitizeRequestHeaders,
  sanitizeResponseHeaders,
  measureHeaderBytes,
  type ForwardedContext,
} from "../proxy/headers";
import { buildUpstreamCookieHeader, rewriteSetCookies } from "../proxy/cookies";
import {
  hostnameFromOrigin,
  resolveHostClasses,
  requiresReapproval,
  type HostClassification,
} from "../proxy/dns";
import {
  PROXY_LIMITS,
  ProxyConnectionRegistry,
  withIdleTimeout,
  type ProxyLimits,
} from "../proxy/limits";
import { proxyError } from "../proxy/errors";
import type { HttpDependencies } from "./types";
import { rootLogger } from "@uncorded/shared";
import type { ProxyMount, PluginSetting, PluginManifest } from "@uncorded/shared";

const log = rootLogger.child({ component: "proxy" });

const PROXY_SESSION_TTL_SECONDS = 3600;

// Methods that never carry a request body — their body is not streamed upstream.
const BODYLESS_METHODS = new Set(["GET", "HEAD"]);

// Statuses that must not carry a response body (RFC 9110). HEAD is handled
// separately by method.
const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

// ---------------------------------------------------------------------------
// Test seams. The forwarder resolves real DNS and shares a process-wide
// connection registry; tests inject deterministic substitutes via these hooks.
// ---------------------------------------------------------------------------

interface ProxyTestOverrides {
  resolveHostClasses?: (hostname: string) => Promise<HostClassification>;
  connections?: ProxyConnectionRegistry;
  limits?: ProxyLimits;
}

let testOverrides: ProxyTestOverrides | null = null;
const defaultConnections = new ProxyConnectionRegistry();

/** @internal — test-only. Override DNS resolution, connection caps, or limits. */
export function __setProxyOverridesForTests(overrides: ProxyTestOverrides): void {
  testOverrides = overrides;
}

/** @internal — test-only. Clear any overrides set by __setProxyOverridesForTests. */
export function __resetProxyOverridesForTests(): void {
  testOverrides = null;
}

function activeLimits(): ProxyLimits {
  return testOverrides?.limits ?? PROXY_LIMITS;
}

function activeConnections(): ProxyConnectionRegistry {
  return testOverrides?.connections ?? defaultConnections;
}

function activeResolver(): (hostname: string) => Promise<HostClassification> {
  return testOverrides?.resolveHostClasses ?? resolveHostClasses;
}

// ---------------------------------------------------------------------------
// Small response helpers (handler.ts keeps its own private copies; the error
// shape { error: { code, message } } is the runtime-wide convention).
// ---------------------------------------------------------------------------

function rateLimited(retryAfterMs: number): Response {
  const retryAfterSec = Math.ceil(retryAfterMs / 1000);
  return Response.json(
    { error: { code: "RATE_LIMITED", message: "Too many requests.", retryAfter: retryAfterSec } },
    { status: 429, headers: { "Retry-After": String(retryAfterSec) } },
  );
}

// ---------------------------------------------------------------------------
// Mount resolution — shared by bootstrap + forwarder.
// ---------------------------------------------------------------------------

export interface ResolvedMount {
  manifest: PluginManifest;
  mount: ProxyMount;
  upstream: NormalizedUpstream;
  approval: ProxyApprovalRow;
}

export type ResolveResult =
  | { ok: true; value: ResolvedMount }
  | { ok: false; response: Response };

/** The transport capability a mount resolution gates on. */
export type ProxyTransportCapability = "proxy.http:self" | "proxy.websocket:self";

/**
 * The subset of {@link HttpDependencies} mount resolution needs. Narrowed so the
 * WebSocket proxy (which holds only a handful of closures, not the full HTTP
 * dependency bag) can reuse this resolver. `HttpDependencies` satisfies it
 * structurally, so existing callers pass unchanged.
 */
export type ProxyMountDeps = Pick<
  HttpDependencies,
  "getInstalledPlugins" | "coreDb" | "getPluginDb"
>;

/**
 * Resolve a proxy mount to its live upstream + current approval, applying every
 * fail-closed gate EXCEPT identity (cookie/bearer) and the owner access policy,
 * which the callers apply with the identity they hold.
 *
 * `capability` selects which transport permission the mount must declare — HTTP
 * callers pass `proxy.http:self` (the default), the WS upgrade path passes
 * `proxy.websocket:self`.
 *
 * Member-facing errors never include the private upstream hostname.
 */
export function resolveMount(
  deps: ProxyMountDeps,
  slug: string,
  mountName: string,
  capability: ProxyTransportCapability = "proxy.http:self",
): ResolveResult {
  const plugin = deps.getInstalledPlugins().find((p) => p.slug === slug);
  if (!plugin) {
    return { ok: false, response: proxyError("PLUGIN_NOT_FOUND") };
  }

  // A disabled plugin must not serve proxy traffic. Treat as not found so we
  // don't leak that the mount exists.
  const disabledRow = deps.coreDb
    .query<{ disabled: number }, [string]>("SELECT disabled FROM plugin_settings WHERE slug = ?")
    .get(slug);
  if (disabledRow?.disabled === 1) {
    return { ok: false, response: proxyError("PLUGIN_NOT_FOUND") };
  }

  const mount = plugin.manifest.proxy_mounts?.find((m) => m.name === mountName);
  if (!mount) {
    return { ok: false, response: proxyError("MOUNT_NOT_FOUND") };
  }

  // The requested transport capability must be declared by the plugin.
  const checker = new CapabilityChecker(slug, plugin.manifest.permissions);
  if (!checker.isAllowed(capability)) {
    return { ok: false, response: proxyError("PROXY_CAPABILITY_MISSING") };
  }

  // Resolve and validate the upstream from the backing setting.
  const setting = plugin.manifest.settings?.find((s) => s.key === mount.upstream_setting);
  if (!setting) {
    return { ok: false, response: proxyError("INVALID_UPSTREAM_SETTING") };
  }
  const rawUpstream = readUpstreamValue(deps, slug, setting);
  const normalized = normalizeUpstream(rawUpstream);
  if (!normalized.ok) {
    return { ok: false, response: proxyError("INVALID_UPSTREAM") };
  }

  // Approval: no row ⇒ disabled (fail closed). Any drift between the stored
  // approval and the live manifest/setting also fails closed.
  const store = new ProxyApprovalStore(deps.coreDb);
  const approval = store.get(slug, mountName);
  if (!approval) {
    return { ok: false, response: proxyError("PROXY_NOT_APPROVED") };
  }
  const mismatch =
    approval.plugin_version !== plugin.manifest.version ||
    approval.mount_definition_hash !== mountDefinitionHash(mount) ||
    approval.normalized_upstream_origin !== normalized.origin ||
    approval.normalized_upstream_base_path !== normalized.basePath;
  if (mismatch) {
    return { ok: false, response: proxyError("PROXY_NOT_APPROVED", "This proxy mount needs to be re-approved.") };
  }

  return {
    ok: true,
    value: { manifest: plugin.manifest, mount, upstream: { origin: normalized.origin, basePath: normalized.basePath }, approval },
  };
}

/** Read the upstream setting's current value, falling back to its manifest default. */
function readUpstreamValue(deps: ProxyMountDeps, slug: string, setting: PluginSetting): string | null {
  const db = deps.getPluginDb(slug);
  db.exec(ENSURE_CONFIG_TABLE_SQL);
  const row = db
    .query<{ value: string; type: string }, [string]>("SELECT value, type FROM _config WHERE key = ?")
    .get(setting.key);
  if (row) return String(decodeConfigValue(row.value, row.type as PluginSetting["type"]));
  if (setting.default !== undefined) return String(setting.default);
  return null;
}

function isSecureRequest(request: Request): boolean {
  const proto = request.headers.get("x-forwarded-proto");
  if (proto) return (proto.split(",")[0] ?? "").trim().toLowerCase() === "https";
  try {
    return new URL(request.url).protocol === "https:";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// POST /proxy-sessions/:slug/:mount — Bearer-authed bootstrap.
// ---------------------------------------------------------------------------

export async function handleProxySessionBootstrap(
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

  const rl = rateLimiter.consume(`user:${auth.user.id}`, RATE_PROXY_SESSION);
  if (!rl.allowed) return rateLimited(rl.retryAfterMs);

  const slug = params["slug"] ?? "";
  const mountName = params["mount"] ?? "";

  const resolved = resolveMount(deps, slug, mountName);
  if (!resolved.ok) return resolved.response;
  const { mount, approval } = resolved.value;

  // Access policy is enforced HERE, at mint time, against the Bearer identity.
  // "owner" mounts require the owner; the minted cookie then carries that grant.
  if ((mount.access ?? "members") === "owner" && auth.user.role !== "owner") {
    return proxyError("PROXY_FORBIDDEN", "Owner access is required for this proxy mount.");
  }

  const serverId = deps.getServerId?.() ?? "";
  const token = mintProxySession(
    {
      userId: auth.user.id,
      serverId,
      slug,
      mount: mountName,
      approvalVersion: approval.approval_version,
    },
    PROXY_SESSION_TTL_SECONDS,
  );

  const secure = isSecureRequest(request);
  const response = Response.json({ url: `/proxy/${slug}/${mountName}/` });
  response.headers.append("Set-Cookie", buildProxySetCookie(slug, mountName, token, secure, PROXY_SESSION_TTL_SECONDS));
  return response;
}

// ---------------------------------------------------------------------------
// ALL /proxy/:slug/:mount/* — cookie-validated production forwarder.
// ---------------------------------------------------------------------------

export async function handleProxyRequest(
  request: Request,
  params: Record<string, string>,
  deps: HttpDependencies,
  _rateLimiter: RateLimiter,
  clientIp: string,
): Promise<Response> {
  const slug = params["slug"] ?? "";
  const mountName = params["mount"] ?? "";
  const limits = activeLimits();

  // Reject oversized inbound header sets before doing any work.
  if (measureHeaderBytes(request.headers) > limits.maxRequestHeaderBytes) {
    return proxyError("PROXY_REQUEST_HEADERS_TOO_LARGE");
  }

  // Fail closed: a missing cookie means we never touch the upstream.
  const token = readProxyCookie(request.headers.get("cookie"), slug, mountName);
  if (!token) {
    return proxyError("PROXY_UNAUTHENTICATED");
  }

  const resolved = resolveMount(deps, slug, mountName);
  if (!resolved.ok) return resolved.response;
  const { upstream, approval } = resolved.value;

  const serverId = deps.getServerId?.() ?? "";
  const verified = verifyProxySession(token, { slug, mount: mountName, serverId });
  if (!verified.ok) {
    return proxyError("PROXY_UNAUTHENTICATED", "Invalid or expired proxy session.");
  }
  // The cookie is bound to a specific approval version; a re-approval (or
  // invalidation) since mint means this session is stale.
  if (verified.claims.approvalVersion !== approval.approval_version) {
    return proxyError("PROXY_NOT_APPROVED", "This proxy session is stale; re-open the plugin.");
  }
  const userId = verified.claims.userId;

  // Connection-time DNS classification. This is audit + drift defense, not a
  // hard SSRF guard (fetch re-resolves; see proxy/dns.ts). The hard controls
  // are redirect:"manual" + same-origin redirect rejection below.
  const hostname = hostnameFromOrigin(upstream.origin);
  let classification: HostClassification;
  try {
    classification = await activeResolver()(hostname);
  } catch (err) {
    log.warn("proxy upstream dns resolution failed", {
      slug,
      mount: mountName,
      err: err instanceof Error ? err.message : String(err),
    });
    return proxyError("PROXY_UPSTREAM_ERROR");
  }
  log.info("proxy upstream classified", {
    slug,
    mount: mountName,
    addressClass: classification.representative,
    classes: classification.classes,
  });
  if (requiresReapproval(hostname, approval.approved_address_class, classification.representative)) {
    log.warn("proxy upstream address class drift", {
      slug,
      mount: mountName,
      approved: approval.approved_address_class,
      live: classification.representative,
    });
    return proxyError("PROXY_REAPPROVAL_REQUIRED");
  }

  // Concurrency caps (global / per-user / per-mount).
  const acquired = activeConnections().acquire(userId, `${slug}/${mountName}`);
  if (!acquired.ok) {
    log.warn("proxy connection limit reached", { slug, mount: mountName, scope: acquired.scope });
    return proxyError("PROXY_TOO_MANY_CONNECTIONS");
  }

  try {
    return await forwardToUpstream({
      request,
      upstream,
      slug,
      mountName,
      userId,
      clientIp,
      limits,
      release: acquired.release,
      pathSuffix: params["path"] ?? "",
    });
  } catch (err) {
    acquired.release();
    log.warn("proxy forward failed", {
      slug,
      mount: mountName,
      err: err instanceof Error ? err.message : String(err),
    });
    return proxyError("PROXY_UPSTREAM_ERROR");
  }
}

interface ForwardArgs {
  request: Request;
  upstream: NormalizedUpstream;
  slug: string;
  mountName: string;
  userId: string;
  clientIp: string;
  limits: ProxyLimits;
  release: () => void;
  pathSuffix: string;
}

/**
 * Forward one request to the upstream and shape the response. Owns the connection
 * slot lifecycle: `release` is called on every terminal path, and for streamed
 * bodies it is deferred until the stream settles (onSettle in withIdleTimeout).
 */
async function forwardToUpstream(args: ForwardArgs): Promise<Response> {
  const { request, upstream, slug, mountName, userId, clientIp, limits, release, pathSuffix } = args;
  const target = buildUpstreamTarget(request, upstream, pathSuffix);

  const upstreamUrl = new URL(upstream.origin);
  const ctx: ForwardedContext = {
    upstreamHost: upstreamUrl.host,
    forwardedHost: request.headers.get("host") ?? safeHost(request),
    forwardedProto: isSecureRequest(request) ? "https" : "http",
    forwardedFor: clientIp,
    userId,
  };
  const upstreamCookie = buildUpstreamCookieHeader(request.headers.get("cookie"));
  const fwdHeaders = sanitizeRequestHeaders(request.headers, upstreamCookie, ctx);

  // duplex isn't in the lib RequestInit type yet; required to stream a body.
  const init: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers: fwdHeaders,
    redirect: "manual",
    signal: AbortSignal.timeout(limits.upstreamFirstByteTimeoutMs),
  };
  if (!BODYLESS_METHODS.has(request.method) && request.body) {
    init.body = request.body;
    init.duplex = "half";
  }

  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(target, init);
  } catch (err) {
    release();
    if (isTimeoutError(err)) {
      log.warn("proxy upstream timeout", { slug, mount: mountName });
      return proxyError("PROXY_UPSTREAM_TIMEOUT");
    }
    log.warn("proxy upstream fetch failed", {
      slug,
      mount: mountName,
      err: err instanceof Error ? err.message : String(err),
    });
    return proxyError("PROXY_UPSTREAM_ERROR");
  }

  const mountPath = `/proxy/${slug}/${mountName}`;

  // Redirect containment. We never stream a redirect body; cancel it to free the
  // socket, then either rewrite a same-origin Location back under the mount or
  // block a cross-origin one (covers SSRF redirects, e.g. 169.254.169.254).
  if (REDIRECT_STATUS.has(upstreamRes.status)) {
    void upstreamRes.body?.cancel();
    const location = upstreamRes.headers.get("location");
    const outHeaders = sanitizeResponseHeaders(upstreamRes.headers);
    outHeaders.delete("content-length");
    outHeaders.delete("content-encoding");
    for (const sc of rewriteSetCookies(upstreamRes.headers, mountPath)) outHeaders.append("set-cookie", sc);

    if (location) {
      const decision = rewriteRedirectLocation(location, upstream, slug, mountName, target);
      if (decision.kind === "blocked") {
        log.warn("proxy cross-origin redirect blocked", { slug, mount: mountName });
        release();
        return proxyError("PROXY_REDIRECT_BLOCKED");
      }
      outHeaders.set("location", decision.location);
    }
    release();
    return new Response(null, { status: upstreamRes.status, headers: outHeaders });
  }

  // Reject oversized upstream header sets.
  if (measureHeaderBytes(upstreamRes.headers) > limits.maxResponseHeaderBytes) {
    void upstreamRes.body?.cancel();
    release();
    return proxyError("PROXY_RESPONSE_HEADERS_TOO_LARGE");
  }

  const outHeaders = sanitizeResponseHeaders(upstreamRes.headers);
  for (const sc of rewriteSetCookies(upstreamRes.headers, mountPath)) outHeaders.append("set-cookie", sc);

  const status = upstreamRes.status;
  const bodyForbidden = request.method === "HEAD" || NULL_BODY_STATUS.has(status);
  if (bodyForbidden || upstreamRes.body === null) {
    void upstreamRes.body?.cancel();
    release();
    return new Response(null, { status, headers: outHeaders });
  }

  // Stream the body with an idle deadline; the connection slot is held until the
  // stream settles (close, error, or client cancel).
  const guarded = withIdleTimeout(upstreamRes.body, limits.idleStreamTimeoutMs, {
    onIdle: () => log.warn("proxy idle stream timeout", { slug, mount: mountName }),
    onSettle: release,
  });
  return new Response(guarded, { status, headers: outHeaders });
}

type RedirectDecision = { kind: "same-origin"; location: string } | { kind: "blocked" };

/**
 * Resolve an upstream Location against the request URL and decide whether it is
 * safe to follow. A same-origin redirect is rewritten back under the mount; any
 * cross-origin (or non-http) target is blocked — this is the SSRF backstop the
 * DNS classifier can't provide (e.g. a redirect to http://169.254.169.254/).
 */
function rewriteRedirectLocation(
  location: string,
  upstream: NormalizedUpstream,
  slug: string,
  mount: string,
  baseUrl: string,
): RedirectDecision {
  let resolved: URL;
  try {
    resolved = new URL(location, baseUrl);
  } catch {
    return { kind: "blocked" };
  }
  if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
    return { kind: "blocked" };
  }
  let upstreamUrl: URL;
  try {
    upstreamUrl = new URL(upstream.origin);
  } catch {
    return { kind: "blocked" };
  }
  if (
    resolved.protocol !== upstreamUrl.protocol ||
    resolved.host.toLowerCase() !== upstreamUrl.host.toLowerCase()
  ) {
    return { kind: "blocked" };
  }

  // Same origin — strip the approved base path and contain under the mount.
  const basePath = upstream.basePath === "/" ? "" : upstream.basePath;
  let p = resolved.pathname;
  if (basePath && (p === basePath || p.startsWith(`${basePath}/`))) {
    p = p.slice(basePath.length);
  }
  if (!p.startsWith("/")) p = `/${p}`;
  const pathPart = `/proxy/${slug}/${mount}${p}`.replace(/\/{2,}/g, "/");
  return { kind: "same-origin", location: `${pathPart}${resolved.search}` };
}

/** True for an AbortSignal.timeout firing or an aborted fetch. */
function isTimeoutError(err: unknown): boolean {
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}

function safeHost(request: Request): string {
  try {
    return new URL(request.url).host;
  } catch {
    return "";
  }
}

/** Compose origin + approved base path + request suffix + query. */
function buildUpstreamTarget(request: Request, upstream: NormalizedUpstream, suffix: string): string {
  const base = upstream.basePath === "/" ? "" : upstream.basePath;
  let path = `${base}/${suffix}`.replace(/\/{2,}/g, "/");
  if (!path.startsWith("/")) path = `/${path}`;
  let search = "";
  try {
    search = new URL(request.url).search;
  } catch {
    search = "";
  }
  return `${upstream.origin}${path}${search}`;
}
