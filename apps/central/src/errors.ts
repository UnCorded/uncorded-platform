/** Typed error response — every error has a code and human-readable message. */
export interface ErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
}

export function errorResponse(
  status: number,
  code: string,
  message: string,
): Response {
  const body: ErrorBody = { error: { code, message } };
  return Response.json(body, { status });
}

export function badRequest(message: string): Response {
  return errorResponse(400, "BAD_REQUEST", message);
}

export function unauthorized(message = "Authentication required"): Response {
  return errorResponse(401, "UNAUTHORIZED", message);
}

export function forbidden(message = "Forbidden"): Response {
  return errorResponse(403, "FORBIDDEN", message);
}

export function notFound(message = "Not found"): Response {
  return errorResponse(404, "NOT_FOUND", message);
}

export function conflict(message: string): Response {
  return errorResponse(409, "CONFLICT", message);
}

export function rateLimited(retryAfterSeconds: number): Response {
  const body: ErrorBody = {
    error: { code: "RATE_LIMITED", message: "Too many requests" },
  };
  return new Response(JSON.stringify(body), {
    status: 429,
    headers: {
      "Content-Type": "application/json",
      "Retry-After": String(retryAfterSeconds),
    },
  });
}

export function internalError(message = "Internal server error"): Response {
  return errorResponse(500, "INTERNAL_ERROR", message);
}

export function notImplemented(message = "Not implemented"): Response {
  return errorResponse(501, "NOT_IMPLEMENTED", message);
}

// Postgres SQLSTATE 23505 — unique_violation. The `postgres` driver surfaces
// the SQLSTATE on the thrown error's `code` property. Used by callers that
// rely on UNIQUE constraints (instead of TOCTOU-prone SELECT-then-INSERT) to
// turn a race-loser INSERT into a 409.
export function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "23505"
  );
}
