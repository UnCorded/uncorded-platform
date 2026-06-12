import type {
  Account,
  Server,
  Plugin,
  PluginDetail,
  AvatarUploadUrl,
  MyInvite,
  ServerInvite,
  JoinRequest,
  ServerMember,
} from "./types";
import { ApiError } from "./types";
import { getElectron, isElectron } from "../lib/electron";

export const BASE_URL = import.meta.env.DEV
  ? window.location.origin
  : import.meta.env.VITE_CENTRAL_URL ?? "https://central.uncorded.app";

function desktopCentral() {
  return isElectron() ? getElectron().central : null;
}

async function request<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      ...init,
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        ...init.headers,
      },
    });
  } catch (err) {
    throw new ApiError(
      "NETWORK_ERROR",
      err instanceof Error ? err.message : "Network request failed",
      0,
    );
  }

  if (!res.ok) {
    let code = "UNKNOWN";
    let message = `Request failed with status ${res.status}`;
    try {
      const body = (await res.json()) as {
        error?: { code?: string; message?: string };
      };
      if (body.error?.code) code = body.error.code;
      if (body.error?.message) message = body.error.message;
    } catch {
      // ignore parse errors
    }
    throw new ApiError(code, message, res.status);
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

// `identifier` is either an email address or a username. We pass it through to
// Central verbatim — Central decides which path to hit based on whether the
// string contains an "@".
export async function login(
  identifier: string,
  password: string,
): Promise<Account> {
  const desktop = desktopCentral();
  if (desktop) {
    return desktop.login(identifier, password);
  }
  return request<Account>("/v1/auth/login", {
    method: "POST",
    body: JSON.stringify({ identifier, password }),
  });
}

export async function startOAuth(
  provider: "google" | "discord" | "github",
): Promise<Account> {
  const desktop = desktopCentral();
  if (desktop) {
    return desktop.startOAuth(provider);
  }
  window.location.href = `${BASE_URL}/v1/auth/${provider}`;
  return new Promise<Account>(() => {});
}

export async function register(
  email: string,
  username: string,
  password: string,
  display_name: string,
  captcha_token: string,
): Promise<void> {
  const desktop = desktopCentral();
  if (desktop) {
    return desktop.register(email, username, password, display_name, captcha_token);
  }
  await request<void>("/v1/auth/register", {
    method: "POST",
    body: JSON.stringify({ email, username, password, display_name, captcha_token }),
  });
}

export async function logout(): Promise<void> {
  const desktop = desktopCentral();
  if (desktop) {
    return desktop.logout();
  }
  await request<void>("/v1/auth/logout", { method: "POST" });
}

export async function getProfile(): Promise<Account> {
  const desktop = desktopCentral();
  if (desktop) {
    return desktop.getProfile();
  }
  return request<Account>("/v1/auth/profile");
}

export async function patchProfile(patch: {
  username?: string;
  display_name?: string;
  avatar_url?: string | null;
  email?: string;
  current_password?: string;
  new_password?: string;
}): Promise<Account> {
  const desktop = desktopCentral();
  if (desktop) {
    return desktop.patchProfile(patch);
  }
  return request<Account>("/v1/auth/profile", {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export async function getAvatarUploadUrl(
  content_type: string,
): Promise<AvatarUploadUrl> {
  const desktop = desktopCentral();
  if (desktop) {
    return desktop.getAvatarUploadUrl(content_type);
  }
  return request<AvatarUploadUrl>("/v1/auth/avatar/upload-url", {
    method: "POST",
    body: JSON.stringify({ content_type }),
  });
}

export async function unlinkProvider(provider: "google" | "discord" | "github"): Promise<void> {
  await request<void>(`/v1/auth/providers/${provider}`, { method: "DELETE" });
}

// Sidebar source: the user's memberships (/v1/me/servers). Includes offline
// servers — membership is orthogonal to liveness, so an inactive server stays
// listed and one provisioning click from coming back. tunnel_url is absent in
// the payload (it travels only with the join token); the store preserves any
// already-hydrated URL across reloads.
export async function listMyServers(): Promise<Server[]> {
  const desktop = desktopCentral();
  if (desktop) {
    return desktop.listServers();
  }
  const res = await request<{ servers: Server[] }>("/v1/me/servers");
  return res.servers;
}

// Online-only public directory — the Explore surface.
export async function listPublicServers(): Promise<Server[]> {
  const desktop = desktopCentral();
  if (desktop) {
    return desktop.listPublicServers();
  }
  const res = await request<{
    servers: Server[];
    total: number;
    page: number;
    per_page: number;
  }>("/v1/servers");
  return res.servers;
}

export async function createServer(
  name: string,
  description: string | null,
  visibility: "public" | "private",
): Promise<{ id: string; server_secret: string }> {
  const desktop = desktopCentral();
  if (desktop) {
    return desktop.createServer(name, description, visibility);
  }
  const res = await request<{ server_id: string; server_secret: string }>("/v1/servers", {
    method: "POST",
    body: JSON.stringify({ name, description, visibility }),
  });
  return { id: res.server_id, server_secret: res.server_secret };
}

// Single-flight per server_id — multiple stores (sidebar, browser-recent,
// workspace, WS open, etc.) often request a token concurrently during cold
// start. Without coalescing, each one consumes a slot in Central's
// RATE_SERVER_TOKEN bucket (30/min) and the bucket drains quickly enough on
// retry storms that the user sees "Too many requests" before the runtime even
// finishes warming up.
const inFlightServerTokens = new Map<string, Promise<{ token: string; expires_at: number; tunnel_url: string | null }>>();

export async function getServerToken(
  server_id: string,
): Promise<{ token: string; expires_at: number; tunnel_url: string | null }> {
  const existing = inFlightServerTokens.get(server_id);
  if (existing) return existing;

  const promise = (async () => {
    const desktop = desktopCentral();
    if (desktop) {
      return desktop.getServerToken(server_id);
    }
    const res = await request<{ token: string; expires_at: number; tunnel_url?: string | null }>("/v1/auth/token/server", {
      method: "POST",
      body: JSON.stringify({ server_id }),
    });
    return { token: res.token, expires_at: res.expires_at, tunnel_url: res.tunnel_url ?? null };
  })().finally(() => {
    if (inFlightServerTokens.get(server_id) === promise) {
      inFlightServerTokens.delete(server_id);
    }
  });

  inFlightServerTokens.set(server_id, promise);
  return promise;
}

export async function listPlugins(params?: {
  q?: string;
  tier?: "official" | "verified" | "community";
  sort?: "installs" | "rating" | "updated";
  limit?: number;
  offset?: number;
}): Promise<{ plugins: Plugin[]; total: number }> {
  const qs = new URLSearchParams();
  if (params?.q) qs.set("q", params.q);
  if (params?.tier) qs.set("tier", params.tier);
  if (params?.sort) qs.set("sort", params.sort);
  if (params?.limit !== undefined) qs.set("limit", String(params.limit));
  if (params?.offset !== undefined) qs.set("offset", String(params.offset));
  const query = qs.toString() ? `?${qs.toString()}` : "";
  return request<{ plugins: Plugin[]; total: number; limit: number; offset: number }>(
    `/v1/plugins${query}`,
  );
}

export async function getPlugin(slug: string): Promise<PluginDetail> {
  return request<PluginDetail>(`/v1/plugins/${slug}`);
}

export async function patchServer(
  serverId: string,
  patch: { name?: string; description?: string | null; visibility?: "public" | "private" },
): Promise<Server> {
  return request<Server>(`/v1/servers/${serverId}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

// --- Membership: invites, join requests, access list ---
// Plain request() like patchServer — these are session-cookie endpoints with
// no desktop-IPC indirection needed.

export async function listMyInvites(): Promise<MyInvite[]> {
  const res = await request<{ invites: MyInvite[] }>("/v1/me/invites");
  return res.invites;
}

export async function acceptInvite(inviteId: string): Promise<{ server_id: string }> {
  return request<{ server_id: string; status: string }>(`/v1/me/invites/${inviteId}/accept`, {
    method: "POST",
  });
}

export async function declineInvite(inviteId: string): Promise<void> {
  await request<void>(`/v1/me/invites/${inviteId}/decline`, { method: "POST" });
}

export async function leaveServer(serverId: string): Promise<void> {
  await request<void>(`/v1/me/servers/${serverId}`, { method: "DELETE" });
}

export async function createInvite(
  serverId: string,
  username: string,
): Promise<{ invite_id: string; expires_at: string }> {
  return request<{ invite_id: string; expires_at: string; status: string }>(
    `/v1/servers/${serverId}/invites`,
    { method: "POST", body: JSON.stringify({ username }) },
  );
}

export async function listServerInvites(serverId: string): Promise<ServerInvite[]> {
  const res = await request<{ invites: ServerInvite[] }>(`/v1/servers/${serverId}/invites`);
  return res.invites;
}

export async function revokeInvite(serverId: string, inviteId: string): Promise<void> {
  await request<void>(`/v1/servers/${serverId}/invites/${inviteId}`, { method: "DELETE" });
}

export async function createJoinRequest(serverId: string): Promise<{ request_id: string }> {
  return request<{ request_id: string; status: string }>(
    `/v1/servers/${serverId}/join-requests`,
    { method: "POST" },
  );
}

export async function listJoinRequests(serverId: string): Promise<JoinRequest[]> {
  const res = await request<{ requests: JoinRequest[] }>(`/v1/servers/${serverId}/join-requests`);
  return res.requests;
}

export async function acceptJoinRequest(serverId: string, requestId: string): Promise<void> {
  await request<unknown>(`/v1/servers/${serverId}/join-requests/${requestId}/accept`, {
    method: "POST",
  });
}

export async function declineJoinRequest(serverId: string, requestId: string): Promise<void> {
  await request<void>(`/v1/servers/${serverId}/join-requests/${requestId}/decline`, {
    method: "POST",
  });
}

export async function listServerMembers(serverId: string): Promise<ServerMember[]> {
  const res = await request<{ members: ServerMember[] }>(`/v1/servers/${serverId}/members`);
  return res.members;
}

export async function kickMember(serverId: string, accountId: string): Promise<void> {
  await request<void>(`/v1/servers/${serverId}/members/${accountId}`, { method: "DELETE" });
}

export async function banMember(serverId: string, accountId: string): Promise<void> {
  await request<void>(`/v1/servers/${serverId}/members/${accountId}/ban`, { method: "POST" });
}

export async function unbanMember(serverId: string, accountId: string): Promise<void> {
  await request<void>(`/v1/servers/${serverId}/members/${accountId}/ban`, { method: "DELETE" });
}

export async function deleteServer(serverId: string): Promise<void> {
  const desktop = desktopCentral();
  if (desktop) {
    return desktop.deleteServer(serverId);
  }
  await request<void>(`/v1/servers/${serverId}`, { method: "DELETE" });
}

/**
 * Ask Central whether a URL's framing policy (X-Frame-Options / CSP frame-ancestors)
 * allows it to be embedded in an iframe. Central probes the URL server-side, which
 * avoids Chromium's inability to distinguish X-Frame-Options blocks from legitimate
 * cross-origin loads client-side.
 *
 * Returns true (can frame) on any error so the iframe can surface its own error state.
 */
export async function checkCanFrame(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/v1/check-frame?url=${encodeURIComponent(url)}`, {
      credentials: "include",
    });
    if (!res.ok) return true;
    const data = (await res.json()) as { canFrame: boolean };
    return data.canFrame === true;
  } catch {
    return true;
  }
}
