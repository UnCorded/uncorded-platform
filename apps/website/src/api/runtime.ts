// Runtime API — calls the server container's HTTP endpoints.
// All calls require a valid server token fetched from Central.

import type { BrowserRecentEntry, SavedWorkspace, WorkspaceLayout } from "@uncorded/protocol";
import * as central from "./central";
import { getToken, clearToken } from "../lib/tokens";

// Per-tab identity for workspace saves. The runtime echoes this back in the
// workspace:updated broadcast so the saving tab can ignore its own events.
// Without this filter, every auto-save triggered a sync loop that replaced
// `panelContents` in place — new object refs flipped the <Show keyed> in
// panel.tsx and every plugin iframe remounted from scratch on every save.
export const EDITOR_ID = crypto.randomUUID();

// Prefer the cached token populated by the WS layer — it owns the refresh
// schedule and avoids hammering Central's per-token rate limiter on every
// HTTP call. Cache miss only happens before the WS finishes its first
// handshake (cold start), in which case a single Central round-trip is
// unavoidable; getServerToken's single-flight coalesces concurrent callers.
//
// Auto re-mint on AUTH_FAILED: when Central's SIGNING_KEY_SECRET rotates,
// previously-minted tokens have a kid that no longer exists in Central's
// keys table. The runtime returns 401 + AUTH_FAILED on those. Rather than
// surfacing the failure all the way up to the user (who'd have to sign out
// and back in), evict the cached token, mint a fresh one under the new kid,
// and retry once. The single-retry guard prevents loops if the new token
// is also rejected — in that case the caller sees the real 401.
export async function runtimeFetch(
  tunnelUrl: string,
  serverId: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const token = getToken(serverId) ?? (await central.getServerToken(serverId)).token;
  const res = await fetch(`${tunnelUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
  });

  if (res.status !== 401) return res;
  if (!(await isAuthFailed(res))) return res;

  clearToken(serverId);
  const fresh = (await central.getServerToken(serverId)).token;
  return fetch(`${tunnelUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${fresh}`,
      ...(init.headers ?? {}),
    },
  });
}

// Clones the response so the body can still be read by errorFromResponse if
// this returns false. AUTH_FAILED is the runtime's specific signal for a
// validated-but-unrecognized token (kid not in JWKS, expired, malformed).
async function isAuthFailed(res: Response): Promise<boolean> {
  try {
    const body = (await res.clone().json()) as { error?: { code?: string } };
    return body.error?.code === "AUTH_FAILED";
  } catch {
    return false;
  }
}

export async function errorFromResponse(res: Response, defaultMsg: string): Promise<Error> {
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    const code = body.error?.code ?? String(res.status);
    const msg = body.error?.message ?? defaultMsg;
    return new Error(`${code}: ${msg}`);
  } catch {
    return new Error(`${defaultMsg} (${res.status})`);
  }
}

// Host-owned reverse-proxy mount bootstrap.
//
// Mints a proxy session for an approved mount and returns the two URLs the host
// needs to render the surface:
//   url     — the in-place mount URL (/proxy/<slug>/<mount>/) for the web
//             sandboxed-iframe surface; the proxy-session cookie this POST sets
//             (credentials below) authorizes it.
//   openUrl — the single-use first-party open ticket (/proxy-open/...) for the
//             desktop <webview>: navigating top-level mints the session cookie
//             inside the webview's partition jar, which a cross-site in-frame
//             Set-Cookie can't reach (Safari/WebKit, and partitioned jars).
//
// The runtime returns both as runtime-RELATIVE paths — it assumes it's called
// from inside the tunnel-origin iframe. The host runs at the shell origin, so we
// absolutize both against tunnelUrl before handing them to a surface element.
// `credentials: "include"` lets the browser store the proxy-session cookie this
// POST sets for the tunnel origin, exactly as the in-iframe SDK openMount does.
export async function bootstrapProxyMount(
  tunnelUrl: string,
  serverId: string,
  slug: string,
  mount: string,
): Promise<{ url: string; openUrl: string }> {
  const res = await runtimeFetch(
    tunnelUrl,
    serverId,
    `/proxy-sessions/${encodeURIComponent(slug)}/${encodeURIComponent(mount)}`,
    { method: "POST", credentials: "include" },
  );
  if (!res.ok) throw await errorFromResponse(res, "Failed to open proxy mount");
  const body = (await res.json()) as { url?: unknown; openUrl?: unknown };
  if (typeof body.url !== "string" || body.url.length === 0) {
    throw new Error("MALFORMED_RESPONSE: proxy bootstrap response is missing `url`");
  }
  if (typeof body.openUrl !== "string" || body.openUrl.length === 0) {
    throw new Error("MALFORMED_RESPONSE: proxy bootstrap response is missing `openUrl`");
  }
  return {
    url: new URL(body.url, tunnelUrl).toString(),
    openUrl: new URL(body.openUrl, tunnelUrl).toString(),
  };
}

export async function listWorkspaceLayouts(
  tunnelUrl: string,
  serverId: string,
): Promise<SavedWorkspace[]> {
  const res = await runtimeFetch(tunnelUrl, serverId, "/workspace/layouts");
  if (!res.ok) throw await errorFromResponse(res, "Failed to load workspaces");
  const body = await res.json() as { layouts: SavedWorkspace[] };
  return body.layouts;
}

export async function createWorkspaceLayout(
  tunnelUrl: string,
  serverId: string,
  name: string | null,
  layout: WorkspaceLayout,
): Promise<SavedWorkspace> {
  const res = await runtimeFetch(tunnelUrl, serverId, "/workspace/layouts", {
    method: "POST",
    body: JSON.stringify({ name, layout, editor_id: EDITOR_ID }),
  });
  if (!res.ok) throw await errorFromResponse(res, "Failed to save workspace");
  const body = await res.json() as { layout: SavedWorkspace };
  return body.layout;
}

export async function updateWorkspaceLayout(
  tunnelUrl: string,
  serverId: string,
  id: string,
  patch: { name?: string | null; layout?: WorkspaceLayout },
  signal?: AbortSignal,
): Promise<void> {
  // exactOptionalPropertyTypes: RequestInit.signal is `AbortSignal | null`,
  // not optional — so don't pass the key at all when signal is undefined
  // rather than feeding in `undefined`.
  const init: RequestInit = {
    method: "PUT",
    body: JSON.stringify({ ...patch, editor_id: EDITOR_ID }),
    ...(signal ? { signal } : {}),
  };
  const res = await runtimeFetch(tunnelUrl, serverId, `/workspace/layouts/${id}`, init);
  if (!res.ok) throw await errorFromResponse(res, "Failed to update workspace");
}

export async function deleteWorkspaceLayout(
  tunnelUrl: string,
  serverId: string,
  id: string,
): Promise<void> {
  const res = await runtimeFetch(tunnelUrl, serverId, `/workspace/layouts/${id}`, {
    method: "DELETE",
  });
  if (!res.ok) throw await errorFromResponse(res, "Failed to delete workspace");
}

export async function getBrowserRecent(
  tunnelUrl: string,
  serverId: string,
): Promise<BrowserRecentEntry[]> {
  const res = await runtimeFetch(tunnelUrl, serverId, "/browser/recent");
  if (!res.ok) throw await errorFromResponse(res, "Failed to load browser recents");
  const body = await res.json() as { recent: BrowserRecentEntry[] };
  return body.recent;
}

export async function updateBrowserRecent(
  tunnelUrl: string,
  serverId: string,
  recent: BrowserRecentEntry[],
  signal?: AbortSignal,
): Promise<void> {
  const init: RequestInit = {
    method: "PUT",
    body: JSON.stringify({ recent, editor_id: EDITOR_ID }),
    ...(signal ? { signal } : {}),
  };
  const res = await runtimeFetch(tunnelUrl, serverId, "/browser/recent", init);
  if (!res.ok) throw await errorFromResponse(res, "Failed to save browser recents");
}
