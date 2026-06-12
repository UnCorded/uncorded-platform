import { app } from "electron";
import { deleteSecret, getSecret, setSecret } from "./desktop-secrets";

const SESSION_KEY = "central.session";
const DEV_CENTRAL_URL = "http://localhost:4000";
const PROD_CENTRAL_URL = "https://central.uncorded.app";

interface ApiErrorBody {
  error?: {
    code?: string;
    message?: string;
  };
}

type JsonBody = Record<string, unknown> | undefined;
type ServerTokenResponse = { token: string; expires_at: number; tunnel_url: string | null };
type CreatedServerResponse = { server_id: string; server_secret: string };
type ServerRecord = {
  id: string;
  name: string;
  description: string | null;
  visibility: "public" | "private";
  owner_id: string;
  // tunnel_url is deliberately absent — Central returns it only from the
  // token endpoint (capability, not metadata). tunnel_state still rides on
  // reads so callers can tell when a public tunnel is up.
  tunnel_state: string | null;
  runtime_version: string | null;
  connected_users: number;
  plugin_count: number;
  is_online: boolean;
  last_heartbeat_at: string | null;
  created_at: string;
  updated_at: string;
};

export function getBaseUrl(): string {
  return process.env["VITE_CENTRAL_URL"]
    ?? (app.isPackaged ? PROD_CENTRAL_URL : DEV_CENTRAL_URL);
}

// Docker's host-gateway alias. Docker Desktop resolves this automatically, but
// native-Linux Docker only resolves it when the container is started with
// `--add-host host.docker.internal:host-gateway` — which runServerContainer
// adds in dev so the rewrite below works on every platform.
const HOST_GATEWAY_ALIAS = "host.docker.internal";

// Rewrite a host-loopback Central URL into one a bridged container can reach.
// The runtime container runs on Docker's bridge network with published ports
// (see server-runtime.ts), so inside it `localhost` is the container itself,
// not the host. Routable hosts (a real tunnel, or prod) pass through untouched.
function toContainerReachableUrl(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    // Unparseable base (e.g. a malformed VITE_CENTRAL_URL) — fail safe to prod
    // rather than handing the runtime a central_url it would reject at boot.
    return PROD_CENTRAL_URL;
  }
  const host = url.hostname.toLowerCase();
  const isLoopback =
    host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  if (!isLoopback) return baseUrl;
  url.hostname = HOST_GATEWAY_ALIAS;
  // Origin only, no trailing slash — match the PROD_CENTRAL_URL shape the
  // runtime expects when it joins request paths onto central_url.
  return `${url.protocol}//${url.host}`;
}

// Pure resolution of the container's central_url from explicit inputs. Split
// out from getContainerCentralUrl so it's unit-testable without the
// process-global electron stub or env vars — whose shared, mutable state across
// the test worker made order-dependent tests flaky.
//
// Resolution order:
//   1. override (UNCORDED_CONTAINER_CENTRAL_URL) — explicit, for custom tunnel
//      hostnames or a staging Central.
//   2. Packaged builds — always production Central. (The web origin can be
//      repointed via VITE_CENTRAL_URL for testing; the container's Central is
//      deliberately not, to avoid a packaged app silently heartbeating to a
//      dev box.)
//   3. Dev — the desktop's own base URL, rewritten so a bridged container can
//      reach a Central on the host loopback (localhost → host.docker.internal).
export function resolveContainerCentralUrl(opts: {
  override: string | undefined;
  isPackaged: boolean;
  baseUrl: string;
}): string {
  if (opts.override) return opts.override;
  if (opts.isPackaged) return PROD_CENTRAL_URL;
  return toContainerReachableUrl(opts.baseUrl);
}

// Central URL written into a provisioned server's config (server.json), used by
// the runtime for heartbeats and for fetching Central's JWT-signing public
// keys. MUST resolve to the same Central instance the desktop registered the
// server against (getBaseUrl) — otherwise Central never sees the heartbeat and
// the provision wizard soft-warns on every run while the server is in fact
// healthy.
export function getContainerCentralUrl(): string {
  return resolveContainerCentralUrl({
    override: process.env["UNCORDED_CONTAINER_CENTRAL_URL"],
    isPackaged: app.isPackaged,
    baseUrl: getBaseUrl(),
  });
}

function getSessionToken(): string | null {
  return getSecret(SESSION_KEY);
}

function setSessionToken(token: string): void {
  setSecret(SESSION_KEY, token);
}

function clearSessionToken(): void {
  deleteSecret(SESSION_KEY);
}

function extractSessionToken(res: Response): string | null {
  const getSetCookie = (res.headers as Headers & {
    getSetCookie?: () => string[];
  }).getSetCookie;

  const cookieHeaders = typeof getSetCookie === "function"
    ? getSetCookie.call(res.headers)
    : [res.headers.get("set-cookie")].filter(
        (value): value is string => typeof value === "string" && value.length > 0,
      );

  for (const cookie of cookieHeaders) {
    for (const part of cookie.split(/,(?=\s*__Host-session=)/)) {
      const match = /^__Host-session=([^;]+)/.exec(part.trim());
      if (match?.[1]) return match[1];
    }
  }

  return null;
}

// Typed HTTP error so callers can branch on status/code instead of regexing
// message text (e.g. the delete handler's idempotent-404 path).
export class CentralHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
  ) {
    super(message);
    this.name = "CentralHttpError";
  }
}

export function isCentralNotFound(err: unknown): boolean {
  return err instanceof CentralHttpError && err.status === 404;
}

async function parseError(res: Response): Promise<Error> {
  let message = `Request failed with status ${res.status}`;
  let code = "UNKNOWN";
  try {
    const body = (await res.json()) as ApiErrorBody;
    if (body.error?.message) message = body.error.message;
    if (body.error?.code) code = body.error.code;
  } catch {
    // ignore parse failures
  }
  return new CentralHttpError(message, res.status, code);
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  body?: JsonBody,
): Promise<T> {
  const headers = new Headers(init.headers);
  if (body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const sessionToken = getSessionToken();
  if (sessionToken) {
    headers.set("Cookie", `__Host-session=${sessionToken}`);
  }

  const requestInit: RequestInit = {
    ...init,
    headers,
  };

  if (body !== undefined) {
    requestInit.body = JSON.stringify(body);
  } else if (init.body !== undefined) {
    requestInit.body = init.body;
  }

  let res: Response;
  try {
    res = await fetch(`${getBaseUrl()}${path}`, requestInit);
  } catch (err) {
    throw new Error(`Central request failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!res.ok) {
    if (res.status === 401) {
      clearSessionToken();
    }
    throw await parseError(res);
  }

  if (res.status === 204) {
    return undefined as T;
  }

  return res.json() as Promise<T>;
}

export async function register(
  email: string,
  username: string,
  password: string,
  display_name: string,
  captcha_token: string,
): Promise<void> {
  return request<void>(
    "/v1/auth/register",
    { method: "POST" },
    { email, username, password, display_name, captcha_token },
  );
}

// `identifier` may be either an email address or a username — Central decides
// which by checking for an `@`. We forward the field name verbatim so a user
// who typed their username doesn't appear in server logs as an "email".
export async function login(identifier: string, password: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${getBaseUrl()}/v1/auth/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ identifier, password }),
    });
  } catch (err) {
    throw new Error(`Central login failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!res.ok) {
    throw await parseError(res);
  }

  const sessionToken = extractSessionToken(res);
  if (!sessionToken) {
    throw new Error("Central login succeeded without a session cookie");
  }

  setSessionToken(sessionToken);
  return res.json() as Promise<unknown>;
}

export async function exchangeDesktopOAuthCode(code: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${getBaseUrl()}/v1/auth/desktop-oauth/exchange`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ code }),
    });
  } catch (err) {
    throw new Error(`Central OAuth exchange failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!res.ok) {
    throw await parseError(res);
  }

  const sessionToken = extractSessionToken(res);
  if (!sessionToken) {
    throw new Error("Central OAuth exchange succeeded without a session cookie");
  }

  setSessionToken(sessionToken);
}

export async function logout(): Promise<void> {
  try {
    await request<void>("/v1/auth/logout", { method: "POST" });
  } finally {
    clearSessionToken();
  }
}

export async function getProfile(): Promise<unknown> {
  return request("/v1/auth/profile");
}

export async function patchProfile(patch: {
  username?: string;
  display_name?: string;
  avatar_url?: string | null;
  email?: string;
  current_password?: string;
  new_password?: string;
}): Promise<unknown> {
  return request("/v1/auth/profile", { method: "PATCH" }, patch);
}

export async function getAvatarUploadUrl(
  content_type: string,
): Promise<unknown> {
  return request(
    "/v1/auth/avatar/upload-url",
    { method: "POST" },
    { content_type },
  );
}

// Sidebar source: every server the user owns or belongs to, regardless of
// liveness — an inactive server stays listed and startable. The public
// directory (listPublicServers) is a separate, online-only surface.
export async function listServers(): Promise<unknown> {
  const res = await request<{ servers: Record<string, unknown>[] }>("/v1/me/servers");
  // Central omits tunnel_url (it travels only with the join token); the
  // bridge contract says string | null, so pin it before crossing the
  // preload boundary instead of leaking undefined.
  return res.servers.map((s) => ({ ...s, tunnel_url: s["tunnel_url"] ?? null }));
}

export async function listPublicServers(): Promise<unknown> {
  const res = await request<{
    servers: unknown[];
    total: number;
    page: number;
    per_page: number;
  }>("/v1/servers");
  return res.servers.map((s) => ({
    ...(s as Record<string, unknown>),
    tunnel_url: (s as Record<string, unknown>)["tunnel_url"] ?? null,
  }));
}

export async function createServer(
  name: string,
  description: string | null,
  visibility: "public" | "private",
): Promise<{ id: string; server_secret: string }> {
  const res = await request<CreatedServerResponse>(
    "/v1/servers",
    { method: "POST" },
    { name, description, visibility },
  );

  return {
    id: res.server_id,
    server_secret: res.server_secret,
  };
}

export async function getServer(serverId: string): Promise<ServerRecord> {
  return request<ServerRecord>(`/v1/servers/${serverId}`);
}

export async function deleteServer(serverId: string): Promise<void> {
  await request<unknown>(`/v1/servers/${serverId}`, { method: "DELETE" });
}

// Phase 2 of the two-phase delete: tell Central the local container/volume
// teardown finished so it can hard-delete the row and free the owned-quota
// slot. 404 = already purged (success); anything else is the caller's to log
// — the abandoned-delete reaper backstops a lost confirm.
export async function confirmServerPurge(serverId: string): Promise<void> {
  return request<void>(`/v1/servers/${serverId}/purge-confirm`, { method: "POST" });
}

function decodeJwtExpiration(token: string): number {
  const parts = token.split(".");
  const payloadPart = parts[1];
  const fallback = Math.floor(Date.now() / 1000) + 600;
  if (!payloadPart) return fallback;

  try {
    const normalized = payloadPart.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const payload = JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as {
      exp?: number;
    };
    return typeof payload.exp === "number" ? payload.exp : fallback;
  } catch {
    return fallback;
  }
}

// Generic authed passthrough for the renderer. The renderer's own fetch()
// carries no session inside Electron (the session token lives in the OS
// keychain, not a cookie jar), so every plain /v1 call the web code makes is
// proxied through here with the Cookie header attached. Returns raw
// status+body without throwing so the renderer can rebuild its typed
// ApiError (withAuthGate and the join surfaces branch on err.status).
export async function rendererRequest(
  method: string,
  path: string,
  bodyJson?: string,
): Promise<{ status: number; body: unknown }> {
  const headers = new Headers();
  if (bodyJson !== undefined) headers.set("Content-Type", "application/json");
  const sessionToken = getSessionToken();
  if (sessionToken) headers.set("Cookie", `__Host-session=${sessionToken}`);

  const init: RequestInit = { method, headers };
  if (bodyJson !== undefined) init.body = bodyJson;

  let res: Response;
  try {
    res = await fetch(`${getBaseUrl()}${path}`, init);
  } catch (err) {
    throw new Error(`Central request failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Same semantic as request(): a 401 with a token present means the session
  // is dead — drop it so the renderer lands on AuthPage instead of looping.
  if (res.status === 401 && sessionToken) {
    clearSessionToken();
  }

  let parsed: unknown = null;
  if (res.status !== 204) {
    try {
      parsed = await res.json();
    } catch {
      parsed = null;
    }
  }
  return { status: res.status, body: parsed };
}

export async function getServerToken(server_id: string): Promise<ServerTokenResponse> {
  const res = await request<{ token: string; tunnel_url?: string | null }>(
    "/v1/auth/token/server",
    { method: "POST" },
    { server_id },
  );

  return {
    token: res.token,
    expires_at: decodeJwtExpiration(res.token),
    tunnel_url: res.tunnel_url ?? null,
  };
}

// The only place Central reveals where a server lives. Owners use this during
// provisioning to learn the cloudflared URL the runtime reported via
// heartbeat (the desktop can't know a quick-tunnel URL any other way).
export async function fetchTunnelUrl(serverId: string): Promise<string | null> {
  const res = await getServerToken(serverId);
  return res.tunnel_url;
}
