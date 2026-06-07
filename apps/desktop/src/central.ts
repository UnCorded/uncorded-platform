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
type ServerTokenResponse = { token: string; expires_at: number };
type CreatedServerResponse = { server_id: string; server_secret: string };
type ServerRecord = {
  id: string;
  name: string;
  description: string | null;
  visibility: "public" | "private";
  owner_id: string;
  tunnel_url: string | null;
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

// Central URL written into a provisioned server's config. The desktop app can
// use localhost in dev, but containers can't reach localhost on the host — they
// must go through the public tunnel. Defaults to PROD_CENTRAL_URL; override via
// UNCORDED_CONTAINER_CENTRAL_URL for custom tunnel hostnames.
export function getContainerCentralUrl(): string {
  return process.env["UNCORDED_CONTAINER_CENTRAL_URL"] ?? PROD_CENTRAL_URL;
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

async function parseError(res: Response): Promise<Error> {
  let message = `Request failed with status ${res.status}`;
  try {
    const body = (await res.json()) as ApiErrorBody;
    if (body.error?.message) message = body.error.message;
  } catch {
    // ignore parse failures
  }
  return new Error(message);
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

export async function listServers(): Promise<unknown> {
  const res = await request<{
    servers: unknown[];
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
  return request<void>(`/v1/servers/${serverId}`, { method: "DELETE" });
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

export async function getServerToken(server_id: string): Promise<ServerTokenResponse> {
  const res = await request<{ token: string }>(
    "/v1/auth/token/server",
    { method: "POST" },
    { server_id },
  );

  return {
    token: res.token,
    expires_at: decodeJwtExpiration(res.token),
  };
}
