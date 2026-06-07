// Auth helpers for the HTTP layer — Bearer token extraction and role checks.
// These are pure functions that return Response objects on failure,
// letting route handlers compose them cleanly.

import type { TokenValidator, AuthenticatedUser } from "../ws/types";
import type { RolesEngine } from "../roles/engine";
import type { AuthResult } from "./types";

// ---------------------------------------------------------------------------
// Token extraction
// ---------------------------------------------------------------------------

/**
 * Extract and validate a Bearer token from the Authorization header.
 * Returns the authenticated user on success, or a pre-built 401 Response
 * on failure.
 */
export async function extractAuth(
  request: Request,
  tokenValidator: TokenValidator,
): Promise<AuthResult> {
  const header = request.headers.get("authorization");

  if (!header || !header.startsWith("Bearer ")) {
    return {
      ok: false,
      response: Response.json(
        { error: { code: "AUTH_REQUIRED", message: "Missing or malformed Authorization header." } },
        { status: 401 },
      ),
    };
  }

  const token = header.slice(7); // "Bearer ".length
  const result = await tokenValidator.validate(token);

  if (!result.ok) {
    return {
      ok: false,
      response: Response.json(
        { error: { code: "AUTH_FAILED", message: result.message } },
        { status: 401 },
      ),
    };
  }

  return { ok: true, user: result.user };
}

// ---------------------------------------------------------------------------
// Role level check
// ---------------------------------------------------------------------------

/**
 * Require a minimum role level. Call after extractAuth succeeds.
 *
 * Builds a CallerContext and calls rolesEngine.hasMinLevel() so the
 * owner bypass is handled by the engine (owner short-circuits to true
 * regardless of their DB row level).
 *
 * Returns null if authorized, or a 403 Response if not.
 */
export function requireMinLevel(
  user: AuthenticatedUser,
  minLevel: number,
  rolesEngine: RolesEngine,
): Response | null {
  const caller = { userId: user.id, isOwner: user.role === "owner" };
  const allowed = rolesEngine.hasMinLevel(user.id, minLevel, caller);

  if (!allowed) {
    return Response.json(
      { error: { code: "FORBIDDEN", message: "Insufficient permissions." } },
      { status: 403 },
    );
  }

  return null;
}
