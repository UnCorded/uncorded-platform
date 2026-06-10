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
  mintProxyOpenTicket,
  verifyProxySession,
  buildProxySetCookie,
  readProxyCookie,
  PROXY_OPEN_TICKET_TTL_SECONDS,
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
  advisoryUpstreamWarning,
  type HostClassification,
  type UpstreamAdvisory,
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

// Text response types where path-prefix rewriting is safe and expected.
const REWRITEABLE_TEXT_TYPES = ["text/html", "application/xhtml+xml", "text/css"];

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

// ---------------------------------------------------------------------------
// Admin mount status + approval (Phase 4). The admin UI reads statuses to render
// the approval surface; approveMount is the SOLE writer of approval rows.
// ---------------------------------------------------------------------------

/**
 * The approval state of a mount relative to its live manifest/setting:
 *  - `approved`: a row exists and matches the current upstream + mount definition.
 *  - `pending`:  the upstream normalizes but no approval row exists yet.
 *  - `drifted`:  a row exists but the plugin version / mount hash / normalized
 *                upstream has since changed — needs re-approval.
 *  - `invalid`:  the backing setting is missing or its value doesn't normalize.
 */
export type ProxyMountApprovalStatus = "approved" | "pending" | "invalid" | "drifted";

/** Admin-facing status for a single proxy mount. */
export interface ProxyMountStatus {
  name: string;
  access: "members" | "owner";
  upstream_setting: string;
  /** Normalized origin + base path, or null when the setting is missing/invalid. */
  normalized_upstream: string | null;
  status: ProxyMountApprovalStatus;
  approved_by_user_id: string | null;
  approved_at: number | null;
  approved_address_class: string | null;
  /** Static "local/private target" advisory for the UI; null when none applies. */
  warning: UpstreamAdvisory | null;
}

/** Compute the admin status for one mount. Read-only. */
export function computeProxyMountStatus(
  deps: ProxyMountDeps,
  manifest: PluginManifest,
  slug: string,
  mount: ProxyMount,
): ProxyMountStatus {
  const approval = new ProxyApprovalStore(deps.coreDb).get(slug, mount.name);
  const setting = manifest.settings?.find((s) => s.key === mount.upstream_setting);

  let normalizedUpstream: string | null = null;
  let warning: UpstreamAdvisory | null = null;
  let status: ProxyMountApprovalStatus;

  if (!setting) {
    status = "invalid";
  } else {
    const normalized = normalizeUpstream(readUpstreamValue(deps, slug, setting));
    if (!normalized.ok) {
      status = "invalid";
    } else {
      const basePath = normalized.basePath === "/" ? "" : normalized.basePath;
      normalizedUpstream = `${normalized.origin}${basePath}`;
      warning = advisoryUpstreamWarning(hostnameFromOrigin(normalized.origin));
      if (!approval) {
        status = "pending";
      } else {
        const matches =
          approval.plugin_version === manifest.version &&
          approval.mount_definition_hash === mountDefinitionHash(mount) &&
          approval.normalized_upstream_origin === normalized.origin &&
          approval.normalized_upstream_base_path === normalized.basePath;
        status = matches ? "approved" : "drifted";
      }
    }
  }

  return {
    name: mount.name,
    access: mount.access ?? "members",
    upstream_setting: mount.upstream_setting,
    normalized_upstream: normalizedUpstream,
    status,
    approved_by_user_id: approval?.approved_by_user_id ?? null,
    approved_at: approval?.approved_at ?? null,
    approved_address_class: approval?.approved_address_class ?? null,
    warning,
  };
}

/** Compute admin statuses for every mount a plugin declares. */
export function computeProxyMountStatuses(
  deps: ProxyMountDeps,
  manifest: PluginManifest,
  slug: string,
): ProxyMountStatus[] {
  return (manifest.proxy_mounts ?? []).map((mount) =>
    computeProxyMountStatus(deps, manifest, slug, mount),
  );
}

export type ApproveMountResult =
  | { ok: true; row: ProxyApprovalRow; status: ProxyMountStatus }
  | { ok: false; response: Response };

/**
 * Approve (or re-approve) a mount's CURRENT normalized upstream. This is the only
 * code path that writes an approval row — config writes may only invalidate, and
 * resolveMount/the forwarder never create. Callers MUST gate on owner/admin
 * before invoking (handler.ts level-80 admin gate); identity is supplied here
 * purely to stamp `approved_by_user_id`.
 *
 * Re-approval bumps `approval_version` (via the store), so any previously-minted
 * proxy-session cookie stops validating. The upstream's connection-time address
 * class is recorded as the drift baseline; a resolution failure at approval time
 * is advisory (records a null baseline) rather than blocking — the upstream may
 * legitimately be offline while an owner sets things up.
 */
export async function approveMount(
  deps: ProxyMountDeps,
  slug: string,
  mountName: string,
  approvedByUserId: string,
): Promise<ApproveMountResult> {
  const plugin = deps.getInstalledPlugins().find((p) => p.slug === slug);
  if (!plugin) return { ok: false, response: proxyError("PLUGIN_NOT_FOUND") };

  const mount = plugin.manifest.proxy_mounts?.find((m) => m.name === mountName);
  if (!mount) return { ok: false, response: proxyError("MOUNT_NOT_FOUND") };

  const setting = plugin.manifest.settings?.find((s) => s.key === mount.upstream_setting);
  if (!setting) return { ok: false, response: proxyError("INVALID_UPSTREAM_SETTING") };

  const normalized = normalizeUpstream(readUpstreamValue(deps, slug, setting));
  if (!normalized.ok) return { ok: false, response: proxyError("INVALID_UPSTREAM") };

  // Record the live address class as the drift baseline. Resolution failure is
  // advisory at approval time — record null rather than block the owner.
  const hostname = hostnameFromOrigin(normalized.origin);
  let approvedAddressClass: string | null = null;
  try {
    approvedAddressClass = (await activeResolver()(hostname)).representative;
  } catch (err) {
    log.warn("proxy approve dns resolution failed", {
      slug,
      mount: mountName,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  const row = new ProxyApprovalStore(deps.coreDb).upsert({
    plugin_slug: slug,
    plugin_version: plugin.manifest.version,
    mount_name: mountName,
    mount_definition_hash: mountDefinitionHash(mount),
    upstream_setting_key: mount.upstream_setting,
    normalized_upstream_origin: normalized.origin,
    normalized_upstream_base_path: normalized.basePath,
    approved_by_user_id: approvedByUserId,
    approved_at: Date.now(),
    approved_address_class: approvedAddressClass,
  });

  return { ok: true, row, status: computeProxyMountStatus(deps, plugin.manifest, slug, mount) };
}

export function isSecureRequest(request: Request): boolean {
  const proto = request.headers.get("x-forwarded-proto");
  if (proto) return (proto.split(",")[0] ?? "").trim().toLowerCase() === "https";
  try {
    return new URL(request.url).protocol === "https:";
  } catch {
    return false;
  }
}

function isLocalhostRequest(request: Request): boolean {
  try {
    const host = new URL(request.url).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
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
  const claims = {
    userId: auth.user.id,
    serverId,
    slug,
    mount: mountName,
    approvalVersion: approval.approval_version,
  };
  const token = mintProxySession(claims, PROXY_SESSION_TTL_SECONDS);

  // First-party fallback (Phase 0 §4a): Safari/WebKit stores no cookie inside a
  // cross-site iframe, so the in-frame Set-Cookie below is dropped there. The
  // open ticket lets the client navigate top-level to /proxy-open/:slug/:mount,
  // which re-mints the cookie first-party (where Safari does store it) and
  // redirects into the mount. Generic to every mount, not Foundry-specific.
  const openTicket = mintProxyOpenTicket(claims, PROXY_OPEN_TICKET_TTL_SECONDS);
  const openUrl = `/proxy-open/${slug}/${mountName}?ticket=${encodeURIComponent(openTicket)}`;

  const secure = isSecureRequest(request);
  const localhostFramedCompat = !secure && isLocalhostRequest(request);
  const response = Response.json({ url: `/proxy/${slug}/${mountName}/`, openUrl });
  response.headers.append(
    "Set-Cookie",
    buildProxySetCookie(slug, mountName, token, secure, PROXY_SESSION_TTL_SECONDS, localhostFramedCompat),
  );
  return response;
}

// ---------------------------------------------------------------------------
// GET /proxy-open/:slug/:mount?ticket=… — first-party top-level handoff.
//
// The Safari/WebKit fallback (Phase 0 §4a). A top-level navigation to the
// runtime origin is first-party, so the Set-Cookie here is stored even under
// Safari ITP, unlike the in-frame bootstrap cookie. We verify the short-lived
// "open" ticket (minted by the Bearer-authed bootstrap), re-resolve the mount
// against the CURRENT approval, mint a fresh session cookie, and redirect into
// the mount. This is a user-facing navigation, so failures render HTML, not JSON.
// ---------------------------------------------------------------------------

export async function handleProxyOpen(
  request: Request,
  params: Record<string, string>,
  deps: HttpDependencies,
  _rateLimiter: RateLimiter,
  _clientIp: string,
): Promise<Response> {
  const slug = params["slug"] ?? "";
  const mountName = params["mount"] ?? "";

  const ticket = new URL(request.url).searchParams.get("ticket");
  const serverId = deps.getServerId?.() ?? "";

  // Verify the handoff ticket BEFORE touching mount state. The ticket proves the
  // bootstrap's Bearer auth + access gate already passed for this user/mount.
  const verified = verifyProxySession(ticket, {
    slug,
    mount: mountName,
    purpose: "open",
    serverId,
  });
  if (!verified.ok) {
    return proxyOpenErrorPage(
      "This link has expired or is invalid. Re-open the plugin panel and try again.",
    );
  }

  // Re-resolve against current state: the mount must still exist, be approved,
  // and have a valid upstream.
  const resolved = resolveMount(deps, slug, mountName);
  if (!resolved.ok) {
    return proxyOpenErrorPage(
      "This proxy mount is no longer available. Ask the server admin to approve it, then re-open the plugin.",
    );
  }
  const { approval } = resolved.value;

  // The ticket is bound to the approval version in effect when the bootstrap
  // owner/access gate passed. If the mount has been re-approved since (which
  // also covers an access-policy change to owner-only, since that drifts the
  // mount definition and forces re-approval), a stale ticket must NOT be
  // exchanged for a fresh live session — re-run the bootstrap instead. This
  // mirrors the forwarder's own stale-cookie check.
  if (verified.claims.approvalVersion !== approval.approval_version) {
    return proxyOpenErrorPage(
      "This link is no longer valid because the proxy mount changed. Re-open the plugin panel and try again.",
    );
  }

  const token = mintProxySession(
    {
      userId: verified.claims.userId,
      serverId,
      slug,
      mount: mountName,
      approvalVersion: approval.approval_version,
    },
    PROXY_SESSION_TTL_SECONDS,
  );

  const secure = isSecureRequest(request);
  const localhostFramedCompat = !secure && isLocalhostRequest(request);
  const response = new Response(null, {
    status: 302,
    headers: {
      Location: `/proxy/${slug}/${mountName}/`,
      // Keep the ticket URL (this request's URL) out of the Referer the browser
      // would otherwise attach to the redirected /proxy request. Belt-and-braces
      // with the forwarder stripping Referer; this stops the leak at the source.
      "Referrer-Policy": "no-referrer",
    },
  });
  response.headers.append(
    "Set-Cookie",
    buildProxySetCookie(slug, mountName, token, secure, PROXY_SESSION_TTL_SECONDS, localhostFramedCompat),
  );
  return response;
}

/** Minimal HTML error page for the top-level open handoff (no JSON on a nav). */
function proxyOpenErrorPage(message: string): Response {
  const safe = message.replace(/[&<>"]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;",
  );
  const body = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Can't open</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#16181d;color:#e8eaed;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:1.5rem}main{max-width:28rem;text-align:center}p{color:#9aa0a6;line-height:1.5}</style></head><body><main><h1>Couldn't open this content</h1><p>${safe}</p></main></body></html>`;
  return new Response(body, {
    status: 403,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
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
    forwardedPrefix: `/proxy/${slug}/${mountName}`,
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

  const rewriteKind = rewriteKindFor(outHeaders);
  if (rewriteKind !== null) {
    try {
      const rewritten = rewriteTextBody(await upstreamRes.text(), mountPath, rewriteKind);
      outHeaders.delete("content-length");
      outHeaders.delete("content-encoding");
      release();
      return new Response(rewritten, { status, headers: outHeaders });
    } catch (err) {
      release();
      log.warn("proxy response rewrite failed", {
        slug,
        mount: mountName,
        err: err instanceof Error ? err.message : String(err),
      });
      return proxyError("PROXY_UPSTREAM_ERROR");
    }
  }

  // Bun's fetch transparently decodes gzip/deflate/br/zstd bodies but leaves
  // content-encoding/-length describing the *compressed* bytes. We ask upstream
  // for identity (sanitizeRequestHeaders), so a compliant upstream sends neither;
  // but a non-compliant one may compress anyway. Drop the now-false framing so the
  // client doesn't try to re-decode already-plain bytes (the rewrite branch above
  // does the same after .text()).
  if (outHeaders.has("content-encoding")) {
    outHeaders.delete("content-encoding");
    outHeaders.delete("content-length");
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

export function safeHost(request: Request): string {
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

type RewriteKind = "html" | "css";

function rewriteKindFor(headers: Headers): RewriteKind | null {
  const raw = headers.get("content-type")?.toLowerCase() ?? "";
  if (!REWRITEABLE_TEXT_TYPES.some((type) => raw.includes(type))) return null;
  return raw.includes("css") ? "css" : "html";
}

function rewriteTextBody(body: string, mountPath: string, kind: RewriteKind): string {
  if (kind === "css") return rewriteCssUrls(body, mountPath);
  return rewriteHtmlUrls(rewriteCssUrls(body, mountPath), mountPath);
}

function mountAbsolutePath(path: string, mountPath: string): string {
  if (!path.startsWith("/") || path.startsWith("//")) return path;
  if (path === mountPath || path.startsWith(`${mountPath}/`) || path.startsWith("/proxy/")) return path;
  return `${mountPath}${path}`.replace(/\/{2,}/g, "/");
}

function rewriteHtmlUrls(html: string, mountPath: string): string {
  return html
    .replace(
      /\b(href|src|action|poster|data)=("|')\/(?!\/)([^"']*)\2/gi,
      (_all, attr: string, quote: string, rest: string) =>
        `${attr}=${quote}${mountAbsolutePath(`/${rest}`, mountPath)}${quote}`,
    )
    .replace(/\bsrcset=("|')([^"']*)\1/gi, (_all, quote: string, value: string) => {
      const rewritten = value
        .split(",")
        .map((candidate) => {
          const leading = candidate.match(/^\s*/)?.[0] ?? "";
          const trimmed = candidate.trimStart();
          if (!trimmed.startsWith("/") || trimmed.startsWith("//")) return candidate;
          const [urlPart, ...descriptor] = trimmed.split(/\s+/);
          return `${leading}${mountAbsolutePath(urlPart ?? "", mountPath)}${descriptor.length ? ` ${descriptor.join(" ")}` : ""}`;
        })
        .join(",");
      return `srcset=${quote}${rewritten}${quote}`;
    });
}

function rewriteCssUrls(css: string, mountPath: string): string {
  return css.replace(
    /url\(\s*(["']?)\/(?!\/)([^)"']*)\1\s*\)/gi,
    (_all, quote: string, rest: string) =>
      `url(${quote}${mountAbsolutePath(`/${rest}`, mountPath)}${quote})`,
  );
}
