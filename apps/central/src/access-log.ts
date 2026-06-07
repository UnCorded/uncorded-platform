import type { Logger } from "@uncorded/shared";
import { getClientIp } from "./middleware";

export interface AccessLogOptions {
  readonly logger: Logger;
  // Injectable clock + reqId for tests; default to performance.now / randomUUID.
  readonly now?: () => number;
  readonly newReqId?: () => string;
}

// Wrap a fetch handler with one structured log line per HTTP request.
//
// Several Central routes carry tokens in the URL (verify-email, server-transfer
// confirm/decline, OAuth `state`), so values are stripped — only the sorted key
// list is logged. /health is logged at debug because LB probes hammer it; flip
// LOG_LEVEL=debug for triage. Account id is intentionally NOT extracted here:
// authenticate() touches the DB and we'd double the cost of every authed
// request. Handlers that want to attach an account id can do it themselves
// once we thread a request-scoped logger through ctx.
export function wrapWithAccessLog(
  inner: (request: Request) => Promise<Response>,
  opts: AccessLogOptions,
): (request: Request) => Promise<Response> {
  const { logger } = opts;
  const now = opts.now ?? (() => performance.now());
  const newReqId = opts.newReqId ?? (() => crypto.randomUUID());

  return async function accessLogged(request: Request): Promise<Response> {
    const start = now();
    const reqId = newReqId();

    let path = request.url;
    let queryKeys: string | undefined;
    try {
      const url = new URL(request.url);
      path = url.pathname;
      queryKeys = maskQueryKeys(url.search);
    } catch {
      // Malformed URL — keep raw `request.url` as the path so the access line
      // still names what came in. The inner handler will surface the error.
    }

    const response = await inner(request);
    const duration_ms = Math.round(now() - start);

    const fields: Record<string, unknown> = {
      reqId,
      method: request.method,
      path,
      status: response.status,
      duration_ms,
      ip: getClientIp(request),
    };
    if (queryKeys !== undefined) fields["queryKeys"] = queryKeys;

    if (path === "/health") {
      logger.debug("request", fields);
    } else {
      logger.info("request", fields);
    }
    return response;
  };
}

function maskQueryKeys(search: string): string | undefined {
  if (!search || search === "?") return undefined;
  const params = new URLSearchParams(search);
  const seen = new Set<string>();
  for (const k of params.keys()) seen.add(k);
  if (seen.size === 0) return undefined;
  return [...seen].sort().join(",");
}
