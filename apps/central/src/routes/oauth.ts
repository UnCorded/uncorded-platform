import { createHmac, timingSafeEqual } from "node:crypto";
import type { RouteContext } from "../routes";
import { badRequest, notImplemented } from "../errors";
import {
  authenticate,
  createSession,
  sessionCookie,
  getClientIp,
  RATE_OAUTH_CALLBACK,
  RATE_OAUTH_LINK,
} from "../middleware";
import { rateLimited } from "../errors";
import { getPostLoginRedirect } from "../post-login";
import type { Sql } from "../db";
import {
  deriveUsernameFromEmail,
  validateUsername,
  USERNAME_MAX_LENGTH,
} from "../usernames";

// OAuth providers don't supply a username, so we derive one from the verified
// email address. We retry with `_2`, `_3`, … on collision and finally fall
// back to a UUID-prefixed `user<hex>` so this can never starve.
async function pickOAuthUsername(sql: Sql, email: string): Promise<string> {
  const base = deriveUsernameFromEmail(email);
  // If derivation failed or the result hits the reserved-name gate, build a
  // synthetic candidate from the eventual account id's namespace. We don't
  // know the account id yet, so use random hex; the caller checks uniqueness
  // again at INSERT time.
  let candidate: string;
  if (base !== null) {
    const v = validateUsername(base);
    candidate = v.ok ? v.username : "user" + crypto.getRandomValues(new Uint8Array(4)).reduce((s, b) => s + b.toString(16).padStart(2, "0"), "");
  } else {
    candidate = "user" + crypto.getRandomValues(new Uint8Array(4)).reduce((s, b) => s + b.toString(16).padStart(2, "0"), "");
  }

  // Query existing collisions in one shot, prefix-match style. Bounded by
  // USERNAME_MAX_LENGTH so it can't loop forever; the random-hex fallback
  // above guarantees the namespace is wide enough that this resolves
  // immediately on real traffic.
  const baseTrimmed = candidate.slice(0, USERNAME_MAX_LENGTH);
  for (let i = 0; i < 10000; i++) {
    const suffix = i === 0 ? "" : `_${i + 1}`;
    const room = USERNAME_MAX_LENGTH - suffix.length;
    const try_ = baseTrimmed.slice(0, room) + suffix;
    const v = validateUsername(try_);
    if (!v.ok) continue;
    const taken = await sql`
      SELECT 1 FROM accounts WHERE LOWER(username) = ${v.username} LIMIT 1
    `;
    if (taken.length === 0) return v.username;
  }
  // Last-resort: randomized hex, virtually no collision risk.
  const r = crypto.getRandomValues(new Uint8Array(8)).reduce((s, b) => s + b.toString(16).padStart(2, "0"), "");
  return `user${r}`.slice(0, USERNAME_MAX_LENGTH);
}

// --- Types ---

type ProviderName = "google" | "discord" | "github";

interface OAuthProvider {
  name: ProviderName;
  idColumn: string;
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
  scopes: string[];
  parseProfile: (data: unknown, accessToken: string) => Promise<{
    id: string;
    email: string;
    emailVerified: boolean;
    displayName: string;
    avatarUrl: string | null;
  }>;
}

interface OAuthState {
  nonce: string;
  mode: "login" | "link";
  accountId?: string;
  provider: string;
  desktop?: boolean;
  createdAt: number;
}

// --- Stateless HMAC-signed state ---
//
// Earlier versions kept pending OAuth flows in a Map; a Central restart
// between the provider redirect and the callback silently dropped every
// in-flight signup into `error=oauth_failed`. This version signs the state
// with HMAC-SHA256 so nothing needs to be remembered: the callback can
// independently verify authenticity, provider, and expiry.
//
// Format: `<payload_b64url>.<sig_b64url>` where payload is a compact JSON
// blob and sig is HMAC-SHA256 of the raw (pre-base64) payload bytes.

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes — matches the old in-memory TTL

/** Secret used to HMAC state tokens. Production deployments must set
 *  OAUTH_STATE_SECRET (>= 32 bytes) — boot-time enforcement in `index.ts`
 *  exits the process if it's missing, so by the time this function runs in
 *  prod the env var is guaranteed present. In dev/test the var may be unset;
 *  we fall back to a per-process random secret so local flows work without
 *  extra wiring. The dev fallback is the only state — env is read on every
 *  call, so a test that sets/clears OAUTH_STATE_SECRET sees the change
 *  immediately. */
let devFallbackSecret: Buffer | null = null;
function getStateSecret(): Buffer {
  const fromEnv = process.env["OAUTH_STATE_SECRET"];
  if (fromEnv && fromEnv.length >= 32) return Buffer.from(fromEnv, "utf8");
  if (!devFallbackSecret) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    devFallbackSecret = Buffer.from(bytes);
  }
  return devFallbackSecret;
}

interface SignedStatePayload {
  /** random nonce, identifies the flow in logs; not security-critical */
  n: string;
  m: "login" | "link";
  /** only set in link mode */
  a?: string;
  p: string;
  d?: boolean;
  /** expiry as Unix ms */
  e: number;
}

function base64urlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(s: string): Buffer | null {
  try {
    const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
    return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
  } catch {
    return null;
  }
}

function signState(payload: SignedStatePayload): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const mac = createHmac("sha256", getStateSecret()).update(body).digest();
  return `${base64urlEncode(body)}.${base64urlEncode(mac)}`;
}

function verifyState(
  token: string,
  expectedProvider: string,
): OAuthState | null {
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const bodyB64 = token.slice(0, dot);
  const macB64 = token.slice(dot + 1);

  const body = base64urlDecode(bodyB64);
  const providedMac = base64urlDecode(macB64);
  if (!body || !providedMac) return null;

  const expectedMac = createHmac("sha256", getStateSecret()).update(body).digest();
  if (expectedMac.length !== providedMac.length) return null;
  if (!timingSafeEqual(expectedMac, providedMac)) return null;

  let parsed: SignedStatePayload;
  try {
    parsed = JSON.parse(body.toString("utf8")) as SignedStatePayload;
  } catch {
    return null;
  }

  if (typeof parsed.e !== "number" || parsed.e < Date.now()) return null;
  if (parsed.p !== expectedProvider) return null;
  if (parsed.m !== "login" && parsed.m !== "link") return null;
  if (typeof parsed.n !== "string") return null;

  return {
    nonce: parsed.n,
    mode: parsed.m,
    ...(parsed.a !== undefined ? { accountId: parsed.a } : {}),
    provider: parsed.p,
    ...(parsed.d === true ? { desktop: true } : {}),
    createdAt: parsed.e - STATE_TTL_MS,
  };
}

interface DesktopOAuthCodePayload {
  a: string;
  e: number;
}

const DESKTOP_OAUTH_CODE_TTL_MS = 60 * 1000;

function signDesktopOAuthCode(accountId: string): string {
  const payload: DesktopOAuthCodePayload = {
    a: accountId,
    e: Date.now() + DESKTOP_OAUTH_CODE_TTL_MS,
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const mac = createHmac("sha256", getStateSecret()).update(body).digest();
  return `${base64urlEncode(body)}.${base64urlEncode(mac)}`;
}

function verifyDesktopOAuthCode(token: string): string | null {
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const body = base64urlDecode(token.slice(0, dot));
  const providedMac = base64urlDecode(token.slice(dot + 1));
  if (!body || !providedMac) return null;
  const expectedMac = createHmac("sha256", getStateSecret()).update(body).digest();
  if (expectedMac.length !== providedMac.length) return null;
  if (!timingSafeEqual(expectedMac, providedMac)) return null;
  let parsed: DesktopOAuthCodePayload;
  try {
    parsed = JSON.parse(body.toString("utf8")) as DesktopOAuthCodePayload;
  } catch {
    return null;
  }
  if (typeof parsed.a !== "string" || parsed.a.length === 0) return null;
  if (typeof parsed.e !== "number" || parsed.e < Date.now()) return null;
  return parsed.a;
}

function desktopOAuthRedirect(codeOrError: { code: string } | { error: string }): Response {
  const url = new URL("uncorded://auth/oauth");
  if ("code" in codeOrError) {
    url.searchParams.set("code", codeOrError.code);
  } else {
    url.searchParams.set("error", codeOrError.error);
  }
  return redirect(url.toString());
}

function generateNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Buffer.from(bytes).toString("hex");
}

// --- Environment helpers ---

function getRedirectBase(): string {
  return process.env["OAUTH_REDIRECT_BASE"] ?? "http://localhost:4000";
}

function callbackUrl(provider: ProviderName): string {
  return `${getRedirectBase()}/v1/auth/${provider}/callback`;
}

// --- Provider configs ---

function getGoogleProvider(): OAuthProvider | null {
  const clientId = process.env["GOOGLE_CLIENT_ID"];
  const clientSecret = process.env["GOOGLE_CLIENT_SECRET"];
  if (!clientId || !clientSecret) return null;
  return {
    name: "google",
    idColumn: "google_id",
    clientId,
    clientSecret,
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    userInfoUrl: "https://www.googleapis.com/oauth2/v2/userinfo",
    scopes: ["openid", "email", "profile"],
    async parseProfile(data: unknown) {
      const d = data as Record<string, unknown>;
      return {
        id: String(d["id"]),
        email: String(d["email"]),
        emailVerified: Boolean(d["verified_email"]),
        displayName: String(d["name"]),
        avatarUrl: d["picture"] ? String(d["picture"]) : null,
      };
    },
  };
}

function getDiscordProvider(): OAuthProvider | null {
  const clientId = process.env["DISCORD_CLIENT_ID"];
  const clientSecret = process.env["DISCORD_CLIENT_SECRET"];
  if (!clientId || !clientSecret) return null;
  return {
    name: "discord",
    idColumn: "discord_id",
    clientId,
    clientSecret,
    authorizeUrl: "https://discord.com/api/oauth2/authorize",
    tokenUrl: "https://discord.com/api/oauth2/token",
    userInfoUrl: "https://discord.com/api/users/@me",
    scopes: ["identify", "email"],
    async parseProfile(data: unknown) {
      const d = data as Record<string, unknown>;
      const id = String(d["id"]);
      const avatar = d["avatar"] ? `https://cdn.discordapp.com/avatars/${id}/${d["avatar"]}.png` : null;
      return {
        id,
        email: String(d["email"]),
        emailVerified: Boolean(d["verified"]),
        displayName: String(d["global_name"] ?? d["username"]),
        avatarUrl: avatar,
      };
    },
  };
}

function getGitHubProvider(): OAuthProvider | null {
  const clientId = process.env["GITHUB_CLIENT_ID"];
  const clientSecret = process.env["GITHUB_CLIENT_SECRET"];
  if (!clientId || !clientSecret) return null;
  return {
    name: "github",
    idColumn: "github_id",
    clientId,
    clientSecret,
    authorizeUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    userInfoUrl: "https://api.github.com/user",
    scopes: ["read:user", "user:email"],
    async parseProfile(data: unknown, accessToken: string) {
      const d = data as Record<string, unknown>;
      // GitHub may not return email in the user endpoint — fetch from /user/emails
      let email = "";
      let emailVerified = false;
      if (d["email"]) {
        email = String(d["email"]);
      }
      // Always fetch emails endpoint for verification status
      const emailsRes = await fetch("https://api.github.com/user/emails", {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "UnCorded-Central",
        },
      });
      if (emailsRes.ok) {
        const emails = (await emailsRes.json()) as Array<{
          email: string;
          primary: boolean;
          verified: boolean;
        }>;
        const primary = emails.find((e) => e.primary && e.verified);
        if (primary) {
          email = primary.email;
          emailVerified = primary.verified;
        }
      }
      return {
        id: String(d["id"]),
        email,
        emailVerified,
        displayName: String(d["name"] ?? d["login"]),
        avatarUrl: d["avatar_url"] ? String(d["avatar_url"]) : null,
      };
    },
  };
}

const providerFactories: Record<ProviderName, () => OAuthProvider | null> = {
  google: getGoogleProvider,
  discord: getDiscordProvider,
  github: getGitHubProvider,
};

function getProvider(name: ProviderName): OAuthProvider | null {
  return providerFactories[name]();
}

// --- Token exchange ---

async function exchangeCode(
  provider: OAuthProvider,
  code: string,
): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: callbackUrl(provider.name),
    client_id: provider.clientId,
    client_secret: provider.clientSecret,
  });

  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (provider.name === "github") {
    headers["Accept"] = "application/json";
  }

  const res = await fetch(provider.tokenUrl, {
    method: "POST",
    headers,
    body: body.toString(),
  });

  if (!res.ok) {
    throw new Error(`Token exchange failed: ${res.status}`);
  }

  const data = (await res.json()) as Record<string, unknown>;
  const accessToken = data["access_token"];
  if (typeof accessToken !== "string") {
    throw new Error("No access_token in token response");
  }
  return accessToken;
}

// --- Fetch user profile ---

async function fetchProfile(provider: OAuthProvider, accessToken: string) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
  };
  if (provider.name === "github") {
    headers["Accept"] = "application/vnd.github+json";
    headers["User-Agent"] = "UnCorded-Central";
  }

  const res = await fetch(provider.userInfoUrl, { headers });
  if (!res.ok) {
    throw new Error(`User info fetch failed: ${res.status}`);
  }
  const data: unknown = await res.json();
  return provider.parseProfile(data, accessToken);
}

// --- Route handlers ---

export function handleOAuthRedirect(
  providerName: ProviderName,
  request?: Request,
): Response {
  const provider = getProvider(providerName);
  if (!provider) {
    return notImplemented(`${providerName} OAuth is not configured`);
  }

  const desktop = request ? new URL(request.url).searchParams.get("desktop") === "1" : false;
  const stateToken = signState({
    n: generateNonce(),
    m: "login",
    p: providerName,
    ...(desktop ? { d: true } : {}),
    e: Date.now() + STATE_TTL_MS,
  });

  const params = new URLSearchParams({
    client_id: provider.clientId,
    redirect_uri: callbackUrl(providerName),
    response_type: "code",
    scope: provider.scopes.join(" "),
    state: stateToken,
  });

  return new Response(null, {
    status: 302,
    headers: { Location: `${provider.authorizeUrl}?${params.toString()}` },
  });
}

export async function handleOAuthCallback(
  providerName: ProviderName,
  request: Request,
  ctx: RouteContext,
): Promise<Response> {
  const provider = getProvider(providerName);
  if (!provider) {
    return notImplemented(`${providerName} OAuth is not configured`);
  }

  // Rate limit by IP
  const clientIp = getClientIp(request);
  const rateResult = ctx.rateLimiter.consume(
    `oauth_callback:${clientIp}`,
    RATE_OAUTH_CALLBACK,
  );
  if (!rateResult.allowed) return rateLimited(rateResult.retryAfter);

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const stateToken = url.searchParams.get("state");
  const postLogin = getPostLoginRedirect();

  if (!code || !stateToken) {
    return redirect(`${postLogin}?error=oauth_failed`);
  }

  const state = verifyState(stateToken, providerName);
  if (!state) {
    return redirect(`${postLogin}?error=oauth_failed`);
  }

  let accessToken: string;
  try {
    accessToken = await exchangeCode(provider, code);
  } catch {
    if (state.desktop === true) return desktopOAuthRedirect({ error: "oauth_failed" });
    return redirect(`${postLogin}?error=oauth_failed`);
  }

  let profile: Awaited<ReturnType<typeof fetchProfile>>;
  try {
    profile = await fetchProfile(provider, accessToken);
  } catch {
    if (state.desktop === true) return desktopOAuthRedirect({ error: "oauth_failed" });
    return redirect(`${postLogin}?error=oauth_failed`);
  }

  // --- Link mode ---
  if (state.mode === "link") {
    return handleLinkCallback(provider, profile, state, ctx, postLogin);
  }

  // --- Login/Register mode ---
  return handleLoginCallback(provider, profile, ctx, postLogin, state);
}

async function handleLoginCallback(
  provider: OAuthProvider,
  profile: { id: string; email: string; emailVerified: boolean; displayName: string; avatarUrl: string | null },
  ctx: RouteContext,
  postLogin: string,
  state: OAuthState,
): Promise<Response> {
  const { sql } = ctx;

  // Case 1: Existing account with this provider ID
  const existingByProvider = await sql`
    SELECT id FROM accounts WHERE ${sql(provider.idColumn)} = ${profile.id} LIMIT 1
  `;
  if (existingByProvider.length > 0) {
    const accountId = existingByProvider[0]!.id as string;
    if (state.desktop === true) {
      return desktopOAuthRedirect({ code: signDesktopOAuthCode(accountId) });
    }
    const token = await createSession(sql, accountId);
    return redirect(postLogin, sessionCookie(token));
  }

  // Case 2: Email match + provider-verified → link provider to existing
  // account, but only if the local account's own email is already verified.
  //
  // Without the local-side check, an attacker who controls a verified-at-the-
  // provider mailbox matching an unverified local signup can take over that
  // account just by completing OAuth. The local `email_verified` gate forces
  // the legitimate owner to complete their own verification first, proving
  // they actually control the inbox.
  if (profile.email && profile.emailVerified) {
    const existingByEmail = await sql`
      SELECT id, email_verified FROM accounts WHERE email = ${profile.email.toLowerCase().trim()} LIMIT 1
    `;
    if (existingByEmail.length > 0) {
      const row = existingByEmail[0]!;
      if (!(row.email_verified as boolean)) {
        if (state.desktop === true) return desktopOAuthRedirect({ error: "email_not_verified" });
        return redirect(`${postLogin}?error=email_not_verified`);
      }
      const accountId = row.id as string;
      await sql`
        UPDATE accounts SET ${sql(provider.idColumn)} = ${profile.id}, updated_at = now()
        WHERE id = ${accountId}
      `;
      if (state.desktop === true) {
        return desktopOAuthRedirect({ code: signDesktopOAuthCode(accountId) });
      }
      const token = await createSession(sql, accountId);
      return redirect(postLogin, sessionCookie(token));
    }
  }

  // CAPTCHA not applied to OAuth-originated accounts. OAuth providers require their own
  // account authentication, which provides equivalent bot protection in Phase 1.
  // Re-evaluate if automated OAuth abuse is observed in production.

  // Case 3: New account. OAuth doesn't carry a username field — derive one
  // from the verified email and pick the first non-colliding candidate.
  // Retry the INSERT once on a username collision so a race between two
  // concurrent OAuth signups picking the same suffix doesn't blow up the
  // login.
  const email = profile.email.toLowerCase().trim();
  let accountId: string | null = null;
  for (let attempt = 0; attempt < 3 && accountId === null; attempt++) {
    const username = await pickOAuthUsername(sql, email);
    try {
      const rows = await sql`
        INSERT INTO accounts (email, username, password_hash, display_name, avatar_url, ${sql(provider.idColumn)}, email_verified)
        VALUES (${email}, ${username}, ${""},  ${profile.displayName}, ${profile.avatarUrl}, ${profile.id}, ${profile.emailVerified})
        RETURNING id
      `;
      accountId = rows[0]!.id as string;
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes("unique")) {
        // username race: retry with a fresh suffix.
        if (
          err.message.includes("accounts_username_lower_idx") ||
          err.message.toLowerCase().includes("username")
        ) {
          continue;
        }
        // email already taken and provider email not verified — can't link
        if (state.desktop === true) return desktopOAuthRedirect({ error: "oauth_failed" });
        return redirect(`${postLogin}?error=oauth_failed`);
      }
      throw err;
    }
  }
  if (accountId === null) {
    if (state.desktop === true) return desktopOAuthRedirect({ error: "oauth_failed" });
    return redirect(`${postLogin}?error=oauth_failed`);
  }
  if (state.desktop === true) {
    return desktopOAuthRedirect({ code: signDesktopOAuthCode(accountId) });
  }
  const token = await createSession(sql, accountId);
  return redirect(postLogin, sessionCookie(token));
}

export async function handleDesktopOAuthExchange(
  request: Request,
  ctx: RouteContext,
): Promise<Response> {
  const clientIp = getClientIp(request);
  const rateResult = ctx.rateLimiter.consume(
    `desktop_oauth_exchange:${clientIp}`,
    RATE_OAUTH_CALLBACK,
  );
  if (!rateResult.allowed) return rateLimited(rateResult.retryAfter);

  let body: { code?: unknown };
  try {
    body = (await request.json()) as { code?: unknown };
  } catch {
    return badRequest("Invalid JSON body");
  }
  if (typeof body.code !== "string") return badRequest("Missing OAuth code");
  const accountId = verifyDesktopOAuthCode(body.code);
  if (!accountId) return badRequest("Invalid or expired OAuth code");
  const token = await createSession(ctx.sql, accountId);
  const response = Response.json({ ok: true });
  response.headers.set("Set-Cookie", sessionCookie(token));
  return response;
}

async function handleLinkCallback(
  provider: OAuthProvider,
  profile: { id: string; email: string; emailVerified: boolean; displayName: string; avatarUrl: string | null },
  state: OAuthState,
  ctx: RouteContext,
  postLogin: string,
): Promise<Response> {
  const { sql } = ctx;
  const accountId = state.accountId!;

  // Verify account still exists (session may have been invalidated)
  const accountRows = await sql`SELECT id FROM accounts WHERE id = ${accountId} LIMIT 1`;
  if (accountRows.length === 0) {
    return redirect(`${postLogin}?error=oauth_failed`);
  }

  // Check if this provider ID is already linked to a different account
  const existingLink = await sql`
    SELECT id FROM accounts WHERE ${sql(provider.idColumn)} = ${profile.id} LIMIT 1
  `;
  if (existingLink.length > 0 && (existingLink[0]!.id as string) !== accountId) {
    return redirect(
      `${postLogin}/settings?error=provider_already_linked&provider=${provider.name}`,
    );
  }

  // Link it
  await sql`
    UPDATE accounts SET ${sql(provider.idColumn)} = ${profile.id}, updated_at = now()
    WHERE id = ${accountId}
  `;

  return redirect(`${postLogin}/settings?linked=${provider.name}`);
}

export async function handleOAuthLinkStart(
  providerName: ProviderName,
  request: Request,
  ctx: RouteContext,
): Promise<Response> {
  const provider = getProvider(providerName);
  if (!provider) {
    return notImplemented(`${providerName} OAuth is not configured`);
  }

  const account = await authenticate(request, ctx.sql);
  if (account instanceof Response) return account;

  // Rate limit by account
  const rateResult = ctx.rateLimiter.consume(
    `oauth_link:${account.id}`,
    RATE_OAUTH_LINK,
  );
  if (!rateResult.allowed) return rateLimited(rateResult.retryAfter);

  const stateToken = signState({
    n: generateNonce(),
    m: "link",
    a: account.id,
    p: providerName,
    e: Date.now() + STATE_TTL_MS,
  });

  const params = new URLSearchParams({
    client_id: provider.clientId,
    redirect_uri: callbackUrl(providerName),
    response_type: "code",
    scope: provider.scopes.join(" "),
    state: stateToken,
  });

  return new Response(null, {
    status: 302,
    headers: { Location: `${provider.authorizeUrl}?${params.toString()}` },
  });
}

const VALID_PROVIDERS: ReadonlySet<string> = new Set(["google", "discord", "github"]);

export async function handleOAuthUnlink(
  provider: string,
  request: Request,
  ctx: RouteContext,
): Promise<Response> {
  if (!VALID_PROVIDERS.has(provider)) {
    return badRequest("Invalid provider");
  }

  const account = await authenticate(request, ctx.sql);
  if (account instanceof Response) return account;

  const idColumn = `${provider}_id`;

  // Check the user has at least one other auth method
  const rows = await ctx.sql`
    SELECT password_hash, google_id, discord_id, github_id
    FROM accounts WHERE id = ${account.id} LIMIT 1
  `;
  const row = rows[0]!;

  let authMethodCount = 0;
  if (row.password_hash as string) authMethodCount++;
  if (row.google_id !== null) authMethodCount++;
  if (row.discord_id !== null) authMethodCount++;
  if (row.github_id !== null) authMethodCount++;

  // The provider being removed counts as one, so we need at least 2 total
  if (authMethodCount < 2) {
    return badRequest("Cannot remove your last authentication method");
  }

  await ctx.sql`
    UPDATE accounts SET ${ctx.sql(idColumn)} = ${null}, updated_at = now()
    WHERE id = ${account.id}
  `;

  return new Response(null, { status: 204 });
}

// --- Helpers ---

function redirect(url: string, cookie?: string): Response {
  const headers: Record<string, string> = { Location: url };
  if (cookie) {
    headers["Set-Cookie"] = cookie;
  }
  return new Response(null, { status: 302, headers });
}

// Export for testing
export { type OAuthState, type ProviderName };
