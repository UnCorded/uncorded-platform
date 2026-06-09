// Structured proxy errors. One code → one status, member-facing messages that
// never leak the private upstream host (owner/admin diagnostics may include it,
// but those paths build their own responses). See
// docs/reverse-proxy/plugin-reverse-proxy-plan.md §Error Semantics.

export type ProxyErrorCode =
  | "PROXY_UNAUTHENTICATED"
  | "PROXY_FORBIDDEN"
  | "PLUGIN_NOT_FOUND"
  | "MOUNT_NOT_FOUND"
  | "PROXY_CAPABILITY_MISSING"
  | "INVALID_UPSTREAM_SETTING"
  | "INVALID_UPSTREAM"
  | "PROXY_NOT_APPROVED"
  | "PROXY_REAPPROVAL_REQUIRED"
  | "PROXY_REQUEST_HEADERS_TOO_LARGE"
  | "PROXY_RESPONSE_HEADERS_TOO_LARGE"
  | "PROXY_REDIRECT_BLOCKED"
  | "PROXY_TOO_MANY_CONNECTIONS"
  | "PROXY_UPSTREAM_ERROR"
  | "PROXY_UPSTREAM_TIMEOUT";

const STATUS: Record<ProxyErrorCode, number> = {
  PROXY_UNAUTHENTICATED: 401,
  PROXY_FORBIDDEN: 403,
  PLUGIN_NOT_FOUND: 404,
  MOUNT_NOT_FOUND: 404,
  PROXY_CAPABILITY_MISSING: 403,
  INVALID_UPSTREAM_SETTING: 422,
  INVALID_UPSTREAM: 422,
  PROXY_NOT_APPROVED: 409,
  PROXY_REAPPROVAL_REQUIRED: 409,
  PROXY_REQUEST_HEADERS_TOO_LARGE: 431,
  PROXY_RESPONSE_HEADERS_TOO_LARGE: 502,
  PROXY_REDIRECT_BLOCKED: 502,
  PROXY_TOO_MANY_CONNECTIONS: 503,
  PROXY_UPSTREAM_ERROR: 502,
  PROXY_UPSTREAM_TIMEOUT: 504,
};

const DEFAULT_MESSAGE: Record<ProxyErrorCode, string> = {
  PROXY_UNAUTHENTICATED: "A proxy session is required.",
  PROXY_FORBIDDEN: "Access to this proxy mount is not permitted.",
  PLUGIN_NOT_FOUND: "Not found.",
  MOUNT_NOT_FOUND: "Not found.",
  PROXY_CAPABILITY_MISSING: "Proxy is not permitted for this plugin.",
  INVALID_UPSTREAM_SETTING: "Upstream is not configured.",
  INVALID_UPSTREAM: "Upstream is not configured correctly.",
  PROXY_NOT_APPROVED: "This proxy mount has not been approved.",
  PROXY_REAPPROVAL_REQUIRED: "This proxy mount needs to be re-approved.",
  PROXY_REQUEST_HEADERS_TOO_LARGE: "Request headers are too large.",
  PROXY_RESPONSE_HEADERS_TOO_LARGE: "The upstream response headers are too large.",
  PROXY_REDIRECT_BLOCKED: "The upstream attempted a disallowed redirect.",
  PROXY_TOO_MANY_CONNECTIONS: "Too many active proxy connections.",
  PROXY_UPSTREAM_ERROR: "The upstream service could not be reached.",
  PROXY_UPSTREAM_TIMEOUT: "The upstream application did not respond in time.",
};

export function proxyErrorStatus(code: ProxyErrorCode): number {
  return STATUS[code];
}

/** Build a structured proxy error response. */
export function proxyError(code: ProxyErrorCode, message?: string): Response {
  const init: ResponseInit = { status: STATUS[code] };
  if (code === "PROXY_TOO_MANY_CONNECTIONS") {
    init.headers = { "Retry-After": "5" };
  }
  return Response.json({ error: { code, message: message ?? DEFAULT_MESSAGE[code] } }, init);
}
