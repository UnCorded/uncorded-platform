// Browser "Recently opened" HTTP handlers.
// Two endpoints, both at member level (>= 10), sharing the workspace rate limit.
// Stores a single per-user history that the web/desktop browser panels read
// from on hydrate and write to whenever the user navigates somewhere new.

import type { BrowserRecentEntry } from "@uncorded/protocol";
import { extractAuth, requireMinLevel } from "./auth";
import { validateBrowserRecentArray } from "../core/layout";
import { MAX_GLOBAL_BROWSER_RECENT } from "../core/dao";
import { RATE_WORKSPACE } from "./workspace";
import type { HttpDependencies } from "./types";
import type { RateLimiter } from "./rate-limiter";

const MAX_RECENT_BYTES = 32 * 1024;

function rateLimitedResponse(retryAfterMs: number): Response {
  const retryAfterSec = Math.ceil(retryAfterMs / 1000);
  return Response.json(
    { error: { code: "RATE_LIMITED", message: "Too many requests.", retryAfter: retryAfterSec } },
    { status: 429, headers: { "Retry-After": String(retryAfterSec) } },
  );
}

function jsonError(code: string, message: string, status: number): Response {
  return Response.json({ error: { code, message } }, { status });
}

// ---------------------------------------------------------------------------
// GET /browser/recent
// ---------------------------------------------------------------------------

export async function handleGetBrowserRecent(
  request: Request,
  _params: Record<string, string>,
  deps: HttpDependencies,
  rateLimiter: RateLimiter,
): Promise<Response> {
  const authResult = await extractAuth(request, deps.tokenValidator);
  if (!authResult.ok) return authResult.response;

  const forbidden = requireMinLevel(authResult.user, 10, deps.rolesEngine);
  if (forbidden) return forbidden;

  const rateResult = rateLimiter.consume(`user:${authResult.user.id}:workspace`, RATE_WORKSPACE);
  if (!rateResult.allowed) return rateLimitedResponse(rateResult.retryAfterMs);

  const recent = deps.coreModule.getBrowserRecent(authResult.user.id);
  return Response.json({ recent });
}

// ---------------------------------------------------------------------------
// PUT /browser/recent
// ---------------------------------------------------------------------------

export async function handlePutBrowserRecent(
  request: Request,
  _params: Record<string, string>,
  deps: HttpDependencies,
  rateLimiter: RateLimiter,
): Promise<Response> {
  const authResult = await extractAuth(request, deps.tokenValidator);
  if (!authResult.ok) return authResult.response;

  const forbidden = requireMinLevel(authResult.user, 10, deps.rolesEngine);
  if (forbidden) return forbidden;

  const rateResult = rateLimiter.consume(`user:${authResult.user.id}:workspace`, RATE_WORKSPACE);
  if (!rateResult.allowed) return rateLimitedResponse(rateResult.retryAfterMs);

  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_RECENT_BYTES) {
    return jsonError(
      "BROWSER_RECENT_TOO_LARGE",
      `Request body must not exceed ${MAX_RECENT_BYTES} bytes.`,
      413,
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError("INVALID_JSON", "Request body must be valid JSON.", 400);
  }

  const b = body as Record<string, unknown>;
  const recent = b["recent"];
  const validation = validateBrowserRecentArray(recent, "recent", MAX_GLOBAL_BROWSER_RECENT);
  if (!validation.ok) {
    return jsonError(validation.error.code, validation.error.message, 400);
  }

  deps.coreModule.setBrowserRecent(authResult.user.id, recent as BrowserRecentEntry[]);

  // Echo the editor id so the saving tab can ignore its own broadcast (same
  // pattern as workspace:updated — prevents thrashing the panel state).
  const editorId = typeof b["editor_id"] === "string" ? b["editor_id"] : null;
  deps.broadcastEventToUser(
    authResult.user.id,
    "browser_recent:updated",
    { recent, editor_id: editorId },
  );

  return Response.json({ ok: true });
}
