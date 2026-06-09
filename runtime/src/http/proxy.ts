// Reverse-proxy HTTP routes (Phase 1 — minimal, fail-closed).
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
// This is the Phase 1 PROOF, not the production forwarder. It deliberately omits
// the header sanitizer, cookie rewriting, redirect handling, DNS classification,
// and limits — all of that is Phase 2. See
// docs/reverse-proxy/plugin-reverse-proxy-plan.md §Phase 1.

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
import type { HttpDependencies } from "./types";
import { rootLogger } from "@uncorded/shared";
import type { ProxyMount, PluginSetting, PluginManifest } from "@uncorded/shared";

const log = rootLogger.child({ component: "proxy" });

const PROXY_SESSION_TTL_SECONDS = 3600;

// Methods the minimal passthrough accepts. Body-bearing methods are read into
// memory (Phase 2 switches to streaming).
const BODYLESS_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// ---------------------------------------------------------------------------
// Small response helpers (handler.ts keeps its own private copies; the error
// shape { error: { code, message } } is the runtime-wide convention).
// ---------------------------------------------------------------------------

function jsonError(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

function rateLimited(retryAfterMs: number): Response {
  const retryAfterSec = Math.ceil(retryAfterMs / 1000);
  return Response.json(
    { error: { code: "RATE_LIMITED", message: "Too many requests.", retryAfter: retryAfterSec } },
    { status: 429, headers: { "Retry-After": String(retryAfterSec) } },
  );
}

// ---------------------------------------------------------------------------
// Mount resolution — shared by bootstrap + passthrough.
// ---------------------------------------------------------------------------

interface ResolvedMount {
  manifest: PluginManifest;
  mount: ProxyMount;
  upstream: NormalizedUpstream;
  approval: ProxyApprovalRow;
}

type ResolveResult =
  | { ok: true; value: ResolvedMount }
  | { ok: false; response: Response };

/**
 * Resolve a proxy mount to its live upstream + current approval, applying every
 * fail-closed gate EXCEPT identity (cookie/bearer) and the owner access policy,
 * which the callers apply with the identity they hold.
 *
 * Member-facing errors never include the private upstream hostname.
 */
function resolveMount(deps: HttpDependencies, slug: string, mountName: string): ResolveResult {
  const plugin = deps.getInstalledPlugins().find((p) => p.slug === slug);
  if (!plugin) {
    return { ok: false, response: jsonError(404, "PLUGIN_NOT_FOUND", "Not found.") };
  }

  // A disabled plugin must not serve proxy traffic. Treat as not found so we
  // don't leak that the mount exists.
  const disabledRow = deps.coreDb
    .query<{ disabled: number }, [string]>("SELECT disabled FROM plugin_settings WHERE slug = ?")
    .get(slug);
  if (disabledRow?.disabled === 1) {
    return { ok: false, response: jsonError(404, "PLUGIN_NOT_FOUND", "Not found.") };
  }

  const mount = plugin.manifest.proxy_mounts?.find((m) => m.name === mountName);
  if (!mount) {
    return { ok: false, response: jsonError(404, "MOUNT_NOT_FOUND", "Not found.") };
  }

  // Phase 1 is HTTP-only; the HTTP transport capability is required.
  const checker = new CapabilityChecker(slug, plugin.manifest.permissions);
  if (!checker.isAllowed("proxy.http:self")) {
    return { ok: false, response: jsonError(403, "PROXY_CAPABILITY_MISSING", "Proxy is not permitted for this plugin.") };
  }

  // Resolve and validate the upstream from the backing setting.
  const setting = plugin.manifest.settings?.find((s) => s.key === mount.upstream_setting);
  if (!setting) {
    return { ok: false, response: jsonError(422, "INVALID_UPSTREAM_SETTING", "Upstream is not configured.") };
  }
  const rawUpstream = readUpstreamValue(deps, slug, setting);
  const normalized = normalizeUpstream(rawUpstream);
  if (!normalized.ok) {
    return { ok: false, response: jsonError(422, "INVALID_UPSTREAM", "Upstream is not configured correctly.") };
  }

  // Approval: no row ⇒ disabled (fail closed). Any drift between the stored
  // approval and the live manifest/setting also fails closed.
  const store = new ProxyApprovalStore(deps.coreDb);
  const approval = store.get(slug, mountName);
  if (!approval) {
    return { ok: false, response: jsonError(409, "PROXY_NOT_APPROVED", "This proxy mount has not been approved.") };
  }
  const mismatch =
    approval.plugin_version !== plugin.manifest.version ||
    approval.mount_definition_hash !== mountDefinitionHash(mount) ||
    approval.normalized_upstream_origin !== normalized.origin ||
    approval.normalized_upstream_base_path !== normalized.basePath;
  if (mismatch) {
    return { ok: false, response: jsonError(409, "PROXY_NOT_APPROVED", "This proxy mount needs to be re-approved.") };
  }

  return {
    ok: true,
    value: { manifest: plugin.manifest, mount, upstream: { origin: normalized.origin, basePath: normalized.basePath }, approval },
  };
}

/** Read the upstream setting's current value, falling back to its manifest default. */
function readUpstreamValue(deps: HttpDependencies, slug: string, setting: PluginSetting): string | null {
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
    return jsonError(403, "FORBIDDEN", "Owner access is required for this proxy mount.");
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
// ALL /proxy/:slug/:mount/* — cookie-validated minimal passthrough.
// ---------------------------------------------------------------------------

export async function handleProxyRequest(
  request: Request,
  params: Record<string, string>,
  deps: HttpDependencies,
): Promise<Response> {
  const slug = params["slug"] ?? "";
  const mountName = params["mount"] ?? "";

  // Fail closed: a missing cookie means we never touch the upstream.
  const token = readProxyCookie(request.headers.get("cookie"), slug, mountName);
  if (!token) {
    return jsonError(401, "PROXY_UNAUTHENTICATED", "A proxy session is required.");
  }

  const resolved = resolveMount(deps, slug, mountName);
  if (!resolved.ok) return resolved.response;
  const { upstream, approval } = resolved.value;

  const serverId = deps.getServerId?.() ?? "";
  const verified = verifyProxySession(token, { slug, mount: mountName, serverId });
  if (!verified.ok) {
    return jsonError(401, "PROXY_UNAUTHENTICATED", "Invalid or expired proxy session.");
  }
  // The cookie is bound to a specific approval version; a re-approval (or
  // invalidation) since mint means this session is stale.
  if (verified.claims.approvalVersion !== approval.approval_version) {
    return jsonError(409, "PROXY_NOT_APPROVED", "This proxy session is stale; re-open the plugin.");
  }

  const target = buildUpstreamTarget(request, upstream, params["path"] ?? "");

  // Minimal forward. NO header/cookie/redirect policy yet — Phase 2. We strip
  // the inbound cookie/authorization so plugin proxy traffic can't smuggle the
  // user's runtime credentials to the upstream.
  const fwdHeaders = new Headers();
  const accept = request.headers.get("accept");
  if (accept) fwdHeaders.set("accept", accept);
  const contentType = request.headers.get("content-type");
  if (contentType) fwdHeaders.set("content-type", contentType);

  const init: RequestInit = { method: request.method, headers: fwdHeaders, redirect: "manual" };
  if (!BODYLESS_METHODS.has(request.method)) {
    init.body = await request.arrayBuffer();
  }

  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(target, init);
  } catch (err) {
    log.warn("upstream fetch failed", {
      slug,
      mount: mountName,
      err: err instanceof Error ? err.message : String(err),
    });
    return jsonError(502, "PROXY_UPSTREAM_ERROR", "The upstream service could not be reached.");
  }

  // Minimal response passthrough: status + content-type only. Cookie rewriting
  // and full header policy are Phase 2; we deliberately drop Set-Cookie here.
  const outHeaders = new Headers();
  const upstreamContentType = upstreamRes.headers.get("content-type");
  if (upstreamContentType) outHeaders.set("content-type", upstreamContentType);
  return new Response(upstreamRes.body, { status: upstreamRes.status, headers: outHeaders });
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
