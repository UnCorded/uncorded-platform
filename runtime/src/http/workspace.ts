// Workspace layout HTTP handlers.
// Four endpoints, all require a valid JWT at member level (>= 10).
// PUT /workspace/default additionally requires admin level (>= 80).

import { extractAuth, requireMinLevel } from "./auth";
import type { HttpDependencies, RateLimitConfig } from "./types";
import type { RateLimiter } from "./rate-limiter";

function rateLimitedResponse(retryAfterMs: number): Response {
  const retryAfterSec = Math.ceil(retryAfterMs / 1000);
  return Response.json(
    { error: { code: "RATE_LIMITED", message: "Too many requests.", retryAfter: retryAfterSec } },
    { status: 429, headers: { "Retry-After": String(retryAfterSec) } },
  );
}

/** Layout JSON body size cap — 64 KB is generous for any reasonable split tree. */
const MAX_LAYOUT_BYTES = 64 * 1024;

/** All workspace endpoints share this rate limit (per user). */
export const RATE_WORKSPACE: RateLimitConfig = { tokens: 30, windowMs: 60_000 };

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function jsonError(code: string, message: string, status: number): Response {
  return Response.json({ error: { code, message } }, { status });
}

// ---------------------------------------------------------------------------
// GET /workspace/layout
// ---------------------------------------------------------------------------

export async function handleGetUserLayout(
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

  const layout = deps.coreModule.getUserLayout(authResult.user.id);
  return Response.json({ layout });
}

// ---------------------------------------------------------------------------
// PUT /workspace/layout
// ---------------------------------------------------------------------------

export async function handlePutUserLayout(
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
  if (contentLength > MAX_LAYOUT_BYTES) {
    return jsonError("LAYOUT_TOO_LARGE", `Request body must not exceed ${MAX_LAYOUT_BYTES} bytes.`, 413);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError("INVALID_JSON", "Request body must be valid JSON.", 400);
  }

  const layout = (body as Record<string, unknown>)["layout"];
  const validation = deps.coreModule.validateLayout(layout);
  if (!validation.ok) {
    return jsonError(validation.error.code, validation.error.message, 400);
  }

  deps.coreModule.setUserLayout(
    authResult.user.id,
    layout as import("@uncorded/protocol").WorkspaceLayout,
  );

  return Response.json({ ok: true });
}

// ---------------------------------------------------------------------------
// GET /workspace/default
// ---------------------------------------------------------------------------

export async function handleGetDefaultLayout(
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

  const layout = deps.coreModule.getDefaultLayout();
  return Response.json({ layout });
}

// ---------------------------------------------------------------------------
// GET /workspace/layouts
// ---------------------------------------------------------------------------

export async function handleGetUserLayouts(
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

  const layouts = deps.coreModule.getUserLayouts(authResult.user.id);
  return Response.json({ layouts });
}

// ---------------------------------------------------------------------------
// POST /workspace/layouts
// ---------------------------------------------------------------------------

export async function handlePostUserLayout(
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
  if (contentLength > MAX_LAYOUT_BYTES) {
    return jsonError("LAYOUT_TOO_LARGE", `Request body must not exceed ${MAX_LAYOUT_BYTES} bytes.`, 413);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError("INVALID_JSON", "Request body must be valid JSON.", 400);
  }

  const b = body as Record<string, unknown>;
  const name = b["name"] !== undefined
    ? (typeof b["name"] === "string" ? b["name"].trim().slice(0, 64) || null : null)
    : null;

  const layout = b["layout"];
  const validation = deps.coreModule.validateLayout(layout);
  if (!validation.ok) {
    return jsonError(validation.error.code, validation.error.message, 400);
  }

  const result = deps.coreModule.createUserLayout(
    authResult.user.id,
    name,
    layout as import("@uncorded/protocol").WorkspaceLayout,
  );

  if ("error" in result) {
    return jsonError("WORKSPACE_CAP_REACHED", "You have reached the maximum number of saved workspaces.", 409);
  }

  // Echo the client's editor id so the saving tab can ignore its own broadcast.
  // Without this, the saver re-applies the event, replacing its layout/panels
  // state with new object refs, which triggers a full iframe remount in every
  // panel — felt as plugin "instability" whenever auto-save fires.
  const editorId = typeof b["editor_id"] === "string" ? b["editor_id"] : null;
  deps.broadcastEventToUser(authResult.user.id, "workspace:updated", { savedId: result.id, editor_id: editorId });

  return Response.json({ layout: result }, { status: 201 });
}

// ---------------------------------------------------------------------------
// PUT /workspace/layouts/:id
// ---------------------------------------------------------------------------

export async function handlePutUserLayoutById(
  request: Request,
  params: Record<string, string>,
  deps: HttpDependencies,
  rateLimiter: RateLimiter,
): Promise<Response> {
  const authResult = await extractAuth(request, deps.tokenValidator);
  if (!authResult.ok) return authResult.response;

  const forbidden = requireMinLevel(authResult.user, 10, deps.rolesEngine);
  if (forbidden) return forbidden;

  const rateResult = rateLimiter.consume(`user:${authResult.user.id}:workspace`, RATE_WORKSPACE);
  if (!rateResult.allowed) return rateLimitedResponse(rateResult.retryAfterMs);

  const id = params["id"];
  if (!id) return jsonError("MISSING_ID", "Layout ID is required.", 400);

  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_LAYOUT_BYTES) {
    return jsonError("LAYOUT_TOO_LARGE", `Request body must not exceed ${MAX_LAYOUT_BYTES} bytes.`, 413);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError("INVALID_JSON", "Request body must be valid JSON.", 400);
  }

  const b = body as Record<string, unknown>;
  const patch: { name?: string | null; layout?: import("@uncorded/protocol").WorkspaceLayout } = {};

  if ("name" in b) {
    patch.name = typeof b["name"] === "string" ? b["name"].trim().slice(0, 64) || null : null;
  }

  if ("layout" in b) {
    const validation = deps.coreModule.validateLayout(b["layout"]);
    if (!validation.ok) {
      return jsonError(validation.error.code, validation.error.message, 400);
    }
    patch.layout = b["layout"] as import("@uncorded/protocol").WorkspaceLayout;
  }

  const updated = deps.coreModule.updateUserLayout(authResult.user.id, id, patch);
  if (!updated) return jsonError("NOT_FOUND", "Workspace not found.", 404);

  const editorId = typeof b["editor_id"] === "string" ? b["editor_id"] : null;
  deps.broadcastEventToUser(authResult.user.id, "workspace:updated", { savedId: id, editor_id: editorId });

  return Response.json({ ok: true });
}

// ---------------------------------------------------------------------------
// DELETE /workspace/layouts/:id
// ---------------------------------------------------------------------------

export async function handleDeleteUserLayout(
  request: Request,
  params: Record<string, string>,
  deps: HttpDependencies,
  rateLimiter: RateLimiter,
): Promise<Response> {
  const authResult = await extractAuth(request, deps.tokenValidator);
  if (!authResult.ok) return authResult.response;

  const forbidden = requireMinLevel(authResult.user, 10, deps.rolesEngine);
  if (forbidden) return forbidden;

  const rateResult = rateLimiter.consume(`user:${authResult.user.id}:workspace`, RATE_WORKSPACE);
  if (!rateResult.allowed) return rateLimitedResponse(rateResult.retryAfterMs);

  const id = params["id"];
  if (!id) return jsonError("MISSING_ID", "Layout ID is required.", 400);

  const deleted = deps.coreModule.deleteUserLayout(authResult.user.id, id);
  if (!deleted) return jsonError("NOT_FOUND", "Workspace not found.", 404);

  return Response.json({ ok: true });
}

// ---------------------------------------------------------------------------
// PUT /workspace/default
// ---------------------------------------------------------------------------

export async function handlePutDefaultLayout(
  request: Request,
  _params: Record<string, string>,
  deps: HttpDependencies,
  rateLimiter: RateLimiter,
): Promise<Response> {
  const authResult = await extractAuth(request, deps.tokenValidator);
  if (!authResult.ok) return authResult.response;

  // Admin only.
  const forbidden = requireMinLevel(authResult.user, 80, deps.rolesEngine);
  if (forbidden) return forbidden;

  const rateResult = rateLimiter.consume(`user:${authResult.user.id}:workspace`, RATE_WORKSPACE);
  if (!rateResult.allowed) return rateLimitedResponse(rateResult.retryAfterMs);

  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_LAYOUT_BYTES) {
    return jsonError("LAYOUT_TOO_LARGE", `Request body must not exceed ${MAX_LAYOUT_BYTES} bytes.`, 413);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError("INVALID_JSON", "Request body must be valid JSON.", 400);
  }

  const layout = (body as Record<string, unknown>)["layout"];
  const validation = deps.coreModule.validateLayout(layout);
  if (!validation.ok) {
    return jsonError(validation.error.code, validation.error.message, 400);
  }

  deps.coreModule.setDefaultLayout(
    layout as import("@uncorded/protocol").WorkspaceLayout,
    authResult.user.id,
  );

  return Response.json({ ok: true });
}
