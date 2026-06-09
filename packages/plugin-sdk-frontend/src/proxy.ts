// Reverse-proxy client — iframe-side helper for plugins that embed a proxied
// upstream web app (e.g. a self-hosted tool) behind a manifest `proxy_mounts`
// entry. It replaces the hand-rolled `POST /proxy-sessions/:slug/:mount` +
// `iframe.src = /proxy/:slug/:mount/` dance every proxy plugin would otherwise
// copy.
//
// `openMount(mount)`:
//   1. POSTs the Bearer-authed bootstrap, which mints the proxy-session cookie
//      and returns the proxied URL plus a first-party fallback URL.
//   2. Returns `{ iframeUrl, openUrl }`:
//        * iframeUrl — set as the panel iframe `src`. The bootstrap call already
//          set the proxy-session cookie, so the framed load is authenticated on
//          Chromium/Firefox.
//        * openUrl — the "Open in browser" / top-level fallback. Navigating here
//          (a new tab / top-level nav) re-mints the cookie FIRST-PARTY, which is
//          the only path that works under Safari/WebKit ITP — Safari stores no
//          cookie set inside a cross-site iframe (Phase 0 §4a). Generic to every
//          mount; the iframe and the fallback always go through this helper.
//
// Auth is the iframe's bearer token (issued at handshake). The bootstrap is a
// same-origin request — the iframe is loaded directly from the runtime origin,
// the same origin that serves `/proxy-sessions/*` — so `credentials:
// "same-origin"` lets the response `Set-Cookie` be stored.

/** Resolved proxy mount session returned by `sdk.proxy.openMount()`. */
export interface ProxyMountSession {
  /** Proxied URL to set as the panel iframe `src`. Cookie already minted. */
  iframeUrl: string;
  /**
   * Top-level "Open in browser" / Safari fallback URL. Navigating here
   * (new tab / top-level) re-mints the proxy-session cookie first-party, then
   * redirects into the mount. Required wherever the framed cookie is blocked.
   */
  openUrl: string;
}

/** Structured proxy failure. `.code` mirrors the bootstrap error envelope.
 *
 *   - `INVALID_ARGUMENT` — bad mount name passed to openMount()
 *   - `UNAUTHORIZED`     — 401 (missing/expired session token)
 *   - `FORBIDDEN`        — 403 (owner-only mount, capability missing)
 *   - `NOT_FOUND`        — 404 (plugin/mount not declared)
 *   - `NOT_APPROVED`     — 409 (mount not approved by the server admin)
 *   - `RATE_LIMITED`     — 429
 *   - `NETWORK_ERROR`    — fetch rejected (offline / CORS / DNS)
 *   - `MALFORMED_RESPONSE` — 2xx body missing url/openUrl
 *   - `BOOTSTRAP_FAILED` — any other non-2xx status
 */
export class ProxyError extends Error {
  readonly code: string;
  readonly status: number | null;
  constructor(code: string, message: string, status: number | null = null) {
    super(message);
    this.name = "ProxyError";
    this.code = code;
    this.status = status;
  }
}

/** Public API surface exposed as `sdk.proxy`. */
export interface ProxyPluginApi {
  /**
   * Bootstrap a proxy-session for one of this plugin's declared `proxy_mounts`
   * and return the URLs to drive the panel. Set `iframeUrl` as the iframe `src`
   * and wire `openUrl` to an "Open in browser" affordance (required for Safari,
   * harmless elsewhere).
   *
   * Throws `ProxyError` on any failure — see the `ProxyError` doc-comment.
   */
  openMount(mount: string): Promise<ProxyMountSession>;
}

interface ProxyClientDeps {
  /** Plugin slug — bound at handshake. */
  slug: string;
  /** Bearer token to authenticate the bootstrap. */
  token: string;
  /** fetch implementation. Injected so unit tests can stub it. */
  fetchImpl?: typeof fetch;
}

/**
 * Build the proxy helper bound to a single iframe session. The plugin SDK
 * factory wires this in and exposes it as `sdk.proxy`.
 */
export function createProxyClient(deps: ProxyClientDeps): ProxyPluginApi {
  return {
    openMount(mount) {
      return openMount(mount, deps);
    },
  };
}

function statusToCode(status: number): string {
  switch (status) {
    case 401:
      return "UNAUTHORIZED";
    case 403:
      return "FORBIDDEN";
    case 404:
      return "NOT_FOUND";
    case 409:
      return "NOT_APPROVED";
    case 429:
      return "RATE_LIMITED";
    default:
      return "BOOTSTRAP_FAILED";
  }
}

async function openMount(mount: string, deps: ProxyClientDeps): Promise<ProxyMountSession> {
  if (typeof mount !== "string" || mount.length === 0) {
    throw new ProxyError("INVALID_ARGUMENT", "openMount() requires a non-empty mount name.");
  }
  const doFetch = deps.fetchImpl ?? fetch;
  const path = `/proxy-sessions/${encodeURIComponent(deps.slug)}/${encodeURIComponent(mount)}`;

  let res: Response;
  try {
    res = await doFetch(path, {
      method: "POST",
      headers: { Authorization: `Bearer ${deps.token}` },
      // Same-origin request (iframe is served from the runtime origin); lets the
      // response Set-Cookie be stored for the framed proxy load.
      credentials: "same-origin",
    });
  } catch (err) {
    throw new ProxyError(
      "NETWORK_ERROR",
      err instanceof Error ? err.message : "Failed to reach the runtime.",
    );
  }

  if (!res.ok) {
    // Prefer the server's typed error code when present.
    let code = statusToCode(res.status);
    let message = `Proxy bootstrap failed (HTTP ${String(res.status)}).`;
    try {
      const body = (await res.json()) as { error?: { code?: unknown; message?: unknown } };
      if (typeof body.error?.code === "string") code = body.error.code;
      if (typeof body.error?.message === "string") message = body.error.message;
    } catch {
      // Non-JSON error body — keep the status-derived code/message.
    }
    throw new ProxyError(code, message, res.status);
  }

  let body: { url?: unknown; openUrl?: unknown };
  try {
    body = (await res.json()) as { url?: unknown; openUrl?: unknown };
  } catch {
    throw new ProxyError("MALFORMED_RESPONSE", "Proxy bootstrap returned a non-JSON body.", res.status);
  }
  if (typeof body.url !== "string" || body.url.length === 0) {
    throw new ProxyError("MALFORMED_RESPONSE", "Proxy bootstrap response is missing `url`.", res.status);
  }
  if (typeof body.openUrl !== "string" || body.openUrl.length === 0) {
    throw new ProxyError("MALFORMED_RESPONSE", "Proxy bootstrap response is missing `openUrl`.", res.status);
  }

  return { iframeUrl: body.url, openUrl: body.openUrl };
}
