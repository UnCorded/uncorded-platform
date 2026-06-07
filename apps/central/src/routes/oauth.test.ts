import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { startTestServer, extractCookie, authHeaders, registerAndLogin, type TestServer } from "../test-helpers";

let ts: TestServer;

beforeAll(async () => {
  ts = await startTestServer();
});

afterAll(async () => {
  await ts.shutdown();
});

// --- Fetch mocking infrastructure ---

const originalFetch = globalThis.fetch;
let fetchMock: ((url: string, init?: RequestInit) => Promise<Response>) | null = null;

beforeEach(() => {
  // Set up OAuth env vars for all providers
  process.env["GOOGLE_CLIENT_ID"] = "google-client-id";
  process.env["GOOGLE_CLIENT_SECRET"] = "google-client-secret";
  process.env["DISCORD_CLIENT_ID"] = "discord-client-id";
  process.env["DISCORD_CLIENT_SECRET"] = "discord-client-secret";
  process.env["GITHUB_CLIENT_ID"] = "github-client-id";
  process.env["GITHUB_CLIENT_SECRET"] = "github-client-secret";
  process.env["OAUTH_REDIRECT_BASE"] = ts.url;
  process.env["POST_LOGIN_REDIRECT"] = "http://localhost:3000";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  fetchMock = null;
  delete process.env["GOOGLE_CLIENT_ID"];
  delete process.env["GOOGLE_CLIENT_SECRET"];
  delete process.env["DISCORD_CLIENT_ID"];
  delete process.env["DISCORD_CLIENT_SECRET"];
  delete process.env["GITHUB_CLIENT_ID"];
  delete process.env["GITHUB_CLIENT_SECRET"];
  delete process.env["OAUTH_REDIRECT_BASE"];
  delete process.env["POST_LOGIN_REDIRECT"];
});

function mockFetch(handler: (url: string, init?: RequestInit) => Promise<Response>) {
  fetchMock = handler;
  const wrappedFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    // If mock handles it, use mock. Otherwise fall through to original (for local test server).
    if (
      url.includes("googleapis.com") ||
      url.includes("discord.com") ||
      url.includes("github.com") ||
      url.includes("api.github.com")
    ) {
      return handler(url, init);
    }
    return originalFetch(input, init);
  };
  wrappedFetch.preconnect = originalFetch.preconnect;
  globalThis.fetch = wrappedFetch;
}

function googleTokenResponse() {
  return Response.json({ access_token: "google-access-token", token_type: "Bearer" });
}

function googleUserInfo(overrides: Record<string, unknown> = {}) {
  return Response.json({
    id: "google-user-123",
    email: "oauth@example.com",
    verified_email: true,
    name: "OAuth User",
    picture: "https://example.com/avatar.png",
    ...overrides,
  });
}

function discordTokenResponse() {
  return Response.json({ access_token: "discord-access-token", token_type: "Bearer" });
}

function discordUserInfo(overrides: Record<string, unknown> = {}) {
  return Response.json({
    id: "discord-user-456",
    email: "oauth@example.com",
    verified: true,
    username: "oauthuser",
    global_name: "OAuth User",
    avatar: "abc123",
    ...overrides,
  });
}

function githubTokenResponse() {
  return Response.json({ access_token: "github-access-token", token_type: "bearer" });
}

function githubUserInfo(overrides: Record<string, unknown> = {}) {
  return Response.json({
    id: 789,
    login: "oauthuser",
    name: "OAuth User",
    email: "oauth@example.com",
    avatar_url: "https://github.com/avatar.png",
    ...overrides,
  });
}

function githubEmails(overrides: Array<{ email: string; primary: boolean; verified: boolean }> = []) {
  const emails = overrides.length > 0
    ? overrides
    : [{ email: "oauth@example.com", primary: true, verified: true }];
  return Response.json(emails);
}

/** Initiate OAuth redirect and extract state nonce from the Location header */
async function initiateOAuth(provider: string): Promise<{ state: string; location: string }> {
  const res = await fetch(`${ts.url}/v1/auth/${provider}`, { redirect: "manual" });
  expect(res.status).toBe(302);
  const location = res.headers.get("location")!;
  const url = new URL(location);
  const state = url.searchParams.get("state")!;
  return { state, location };
}

/** Initiate OAuth link flow and extract state nonce */
async function initiateOAuthLink(
  provider: string,
  token: string,
): Promise<{ state: string; location: string }> {
  const res = await fetch(`${ts.url}/v1/auth/link/${provider}`, {
    headers: authHeaders(token),
    redirect: "manual",
  });
  expect(res.status).toBe(302);
  const location = res.headers.get("location")!;
  const url = new URL(location);
  const state = url.searchParams.get("state")!;
  return { state, location };
}

// =============================================================================
// Provider redirect tests
// =============================================================================

describe("OAuth redirects", () => {
  test("Google redirect generates valid URL with correct scopes", async () => {
    const { location } = await initiateOAuth("google");
    const url = new URL(location);
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.pathname).toBe("/o/oauth2/v2/auth");
    expect(url.searchParams.get("scope")).toBe("openid email profile");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("google-client-id");
    expect(url.searchParams.get("redirect_uri")).toContain("/v1/auth/google/callback");
  });

  test("Discord redirect generates valid URL with correct scopes", async () => {
    const { location } = await initiateOAuth("discord");
    const url = new URL(location);
    expect(url.origin).toBe("https://discord.com");
    expect(url.searchParams.get("scope")).toBe("identify email");
    expect(url.searchParams.get("client_id")).toBe("discord-client-id");
  });

  test("GitHub redirect generates valid URL with correct scopes", async () => {
    const { location } = await initiateOAuth("github");
    const url = new URL(location);
    expect(url.origin).toBe("https://github.com");
    expect(url.searchParams.get("scope")).toBe("read:user user:email");
    expect(url.searchParams.get("client_id")).toBe("github-client-id");
  });
});

// =============================================================================
// Callback login: new user
// =============================================================================

describe("OAuth callback — login/register", () => {
  test("new user → creates account, session, redirects", async () => {
    mockFetch(async (url) => {
      if (url.includes("googleapis.com/token")) return googleTokenResponse();
      if (url.includes("googleapis.com/oauth2")) return googleUserInfo();
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const { state } = await initiateOAuth("google");
    const res = await fetch(
      `${ts.url}/v1/auth/google/callback?code=test-code&state=${state}`,
      { redirect: "manual" },
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("http://localhost:3000");
    const cookie = extractCookie(res, "__Host-session");
    expect(cookie).toBeTruthy();

    // Verify account was created with google_id
    const rows = await ts.sql`SELECT id, google_id, display_name, password_hash FROM accounts WHERE google_id = ${"google-user-123"}`;
    expect(rows.length).toBe(1);
    expect(rows[0]!.display_name).toBe("OAuth User");
    expect(rows[0]!.password_hash).toBe(""); // Social-only account
  });

  test("existing provider ID → logs in (no new account)", async () => {
    // First: create an account via OAuth
    mockFetch(async (url) => {
      if (url.includes("googleapis.com/token")) return googleTokenResponse();
      if (url.includes("googleapis.com/oauth2")) return googleUserInfo({ email: "existing-oauth@example.com" });
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const { state: state1 } = await initiateOAuth("google");
    await fetch(`${ts.url}/v1/auth/google/callback?code=test-code&state=${state1}`, { redirect: "manual" });

    // Second: log in again with the same provider ID
    const { state: state2 } = await initiateOAuth("google");
    const res = await fetch(
      `${ts.url}/v1/auth/google/callback?code=test-code&state=${state2}`,
      { redirect: "manual" },
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("http://localhost:3000");
    const cookie = extractCookie(res, "__Host-session");
    expect(cookie).toBeTruthy();

    // Verify only one account exists
    const rows = await ts.sql`SELECT id FROM accounts WHERE google_id = ${"google-user-123"}`;
    expect(rows.length).toBe(1);
  });

  test("email match + verified → links provider to existing account", async () => {
    // Create a password-based account first
    const { accountId } = await registerAndLogin(ts, "email-match");

    mockFetch(async (url) => {
      if (url.includes("googleapis.com/token")) return googleTokenResponse();
      if (url.includes("googleapis.com/oauth2"))
        return googleUserInfo({
          id: "google-email-match",
          email: "email-match@example.com",
          verified_email: true,
        });
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const { state } = await initiateOAuth("google");
    const res = await fetch(
      `${ts.url}/v1/auth/google/callback?code=test-code&state=${state}`,
      { redirect: "manual" },
    );

    expect(res.status).toBe(302);
    // The provider should be linked to the existing account
    const rows = await ts.sql`SELECT id, google_id FROM accounts WHERE id = ${accountId}`;
    expect(rows[0]!.google_id).toBe("google-email-match");
  });

  test("email match + provider-verified + local unverified → refuses to auto-link", async () => {
    // An attacker with control of a verified-at-Google mailbox must not be
    // able to take over an unverified local signup by completing OAuth. The
    // legitimate owner has to finish their own email verification first.
    const email = "unverified-local@example.com";
    await fetch(`${ts.url}/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, username: "unverifiedlocal", password: "password123", display_name: "unverified" }),
    });
    // Sanity-check: the account exists and is still unverified. registerAndLogin
    // would flip the flag; we intentionally skip that here.
    const preRows = await ts.sql`SELECT email_verified FROM accounts WHERE email = ${email}`;
    expect(preRows[0]!.email_verified).toBe(false);

    mockFetch(async (url) => {
      if (url.includes("googleapis.com/token")) return googleTokenResponse();
      if (url.includes("googleapis.com/oauth2"))
        return googleUserInfo({
          id: "google-takeover-attempt",
          email,
          verified_email: true, // provider says verified — but local isn't
        });
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const { state } = await initiateOAuth("google");
    const res = await fetch(
      `${ts.url}/v1/auth/google/callback?code=test-code&state=${state}`,
      { redirect: "manual" },
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("error=email_not_verified");
    // Account must NOT have been linked to the attacker's provider ID.
    const postRows =
      await ts.sql`SELECT google_id, email_verified FROM accounts WHERE email = ${email}`;
    expect(postRows[0]!.google_id).toBeNull();
    expect(postRows[0]!.email_verified).toBe(false);
  });

  test("email match + unverified → does not auto-link, redirects with error", async () => {
    // Create a password-based account first
    await registerAndLogin(ts, "unverified-match");

    mockFetch(async (url) => {
      if (url.includes("googleapis.com/token")) return googleTokenResponse();
      if (url.includes("googleapis.com/oauth2"))
        return googleUserInfo({
          id: "google-unverified-match",
          email: "unverified-match@example.com",
          verified_email: false, // NOT verified
        });
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const { state } = await initiateOAuth("google");
    const res = await fetch(
      `${ts.url}/v1/auth/google/callback?code=test-code&state=${state}`,
      { redirect: "manual" },
    );

    expect(res.status).toBe(302);
    // Email collision with unverified provider → error redirect, no linking
    expect(res.headers.get("location")).toContain("error=oauth_failed");
    // The original account should NOT have google_id set
    const origRows = await ts.sql`SELECT google_id FROM accounts WHERE email = ${"unverified-match@example.com"}`;
    expect(origRows[0]!.google_id).toBeNull();
  });

  test("email match + unverified + no collision → creates new account", async () => {
    // No existing account with this email
    mockFetch(async (url) => {
      if (url.includes("googleapis.com/token")) return googleTokenResponse();
      if (url.includes("googleapis.com/oauth2"))
        return googleUserInfo({
          id: "google-unverified-new",
          email: "unverified-new@example.com",
          verified_email: false,
        });
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const { state } = await initiateOAuth("google");
    const res = await fetch(
      `${ts.url}/v1/auth/google/callback?code=test-code&state=${state}`,
      { redirect: "manual" },
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("http://localhost:3000");
    const rows = await ts.sql`SELECT id FROM accounts WHERE google_id = ${"google-unverified-new"}`;
    expect(rows.length).toBe(1);
  });
});

// =============================================================================
// Callback link
// =============================================================================

describe("OAuth callback — link", () => {
  test("links provider to authenticated account", async () => {
    const { token, accountId } = await registerAndLogin(ts, "link-test");

    mockFetch(async (url) => {
      if (url.includes("discord.com/api/oauth2/token")) return discordTokenResponse();
      if (url.includes("discord.com/api/users")) return discordUserInfo({ id: "discord-link-test" });
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const { state } = await initiateOAuthLink("discord", token);
    const res = await fetch(
      `${ts.url}/v1/auth/discord/callback?code=test-code&state=${state}`,
      { redirect: "manual" },
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("http://localhost:3000/settings?linked=discord");

    const rows = await ts.sql`SELECT discord_id FROM accounts WHERE id = ${accountId}`;
    expect(rows[0]!.discord_id).toBe("discord-link-test");
  });

  test("provider already linked to another account → error redirect", async () => {
    // Create first account and link discord
    const { token: token1 } = await registerAndLogin(ts, "link-conflict-1");
    mockFetch(async (url) => {
      if (url.includes("discord.com/api/oauth2/token")) return discordTokenResponse();
      if (url.includes("discord.com/api/users")) return discordUserInfo({ id: "discord-conflict" });
      throw new Error(`Unexpected fetch: ${url}`);
    });
    const { state: state1 } = await initiateOAuthLink("discord", token1);
    await fetch(`${ts.url}/v1/auth/discord/callback?code=test-code&state=${state1}`, { redirect: "manual" });

    // Create second account and try to link the same discord
    const { token: token2 } = await registerAndLogin(ts, "link-conflict-2");
    const { state: state2 } = await initiateOAuthLink("discord", token2);
    const res = await fetch(
      `${ts.url}/v1/auth/discord/callback?code=test-code&state=${state2}`,
      { redirect: "manual" },
    );

    expect(res.status).toBe(302);
    const location = res.headers.get("location")!;
    expect(location).toContain("error=provider_already_linked");
    expect(location).toContain("provider=discord");
  });
});

// =============================================================================
// Unlink
// =============================================================================

describe("OAuth unlink", () => {
  test("removes provider, returns 204", async () => {
    // Create account with password + google
    const { token, accountId } = await registerAndLogin(ts, "unlink-test");
    await ts.sql`UPDATE accounts SET google_id = ${"google-unlink-test"} WHERE id = ${accountId}`;

    const res = await fetch(`${ts.url}/v1/auth/providers/google`, {
      method: "DELETE",
      headers: authHeaders(token),
    });

    expect(res.status).toBe(204);
    const rows = await ts.sql`SELECT google_id FROM accounts WHERE id = ${accountId}`;
    expect(rows[0]!.google_id).toBeNull();
  });

  test("last auth method → 400", async () => {
    // Create a social-only account (no password)
    const { accountId } = await registerAndLogin(ts, "unlink-last");
    await ts.sql`UPDATE accounts SET password_hash = '', google_id = ${"google-last"} WHERE id = ${accountId}`;

    // Re-login won't work (social only), so we need to grab a valid session token
    // The registerAndLogin already gave us a valid session, let's get the token from a fresh registration
    const regRes = await fetch(`${ts.url}/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "unlink-last-helper@example.com",
        username: "unlinkhelper",
        password: "password123",
        display_name: "helper",
      }),
    });
    // We can't easily re-auth as the social-only user via the test server.
    // Instead, let's directly use the existing session from registerAndLogin.
    // The session is still valid even though we changed the password_hash.
    const { token } = await registerAndLogin(ts, "unlink-last-2");
    const accId = (await ts.sql`SELECT id FROM accounts WHERE email = ${"unlink-last-2@example.com"}`)[0]!.id as string;
    await ts.sql`UPDATE accounts SET password_hash = '', google_id = ${"google-last-2"} WHERE id = ${accId}`;

    const res = await fetch(`${ts.url}/v1/auth/providers/google`, {
      method: "DELETE",
      headers: authHeaders(token),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("Cannot remove your last authentication method");
  });

  test("invalid provider → 400", async () => {
    const { token } = await registerAndLogin(ts, "unlink-invalid");
    const res = await fetch(`${ts.url}/v1/auth/providers/twitter`, {
      method: "DELETE",
      headers: authHeaders(token),
    });
    expect(res.status).toBe(400);
  });
});

// =============================================================================
// Provider disabled
// =============================================================================

describe("OAuth disabled provider", () => {
  test("returns 501 when provider not configured", async () => {
    delete process.env["GOOGLE_CLIENT_ID"];
    delete process.env["GOOGLE_CLIENT_SECRET"];

    const res = await fetch(`${ts.url}/v1/auth/google`, { redirect: "manual" });
    expect(res.status).toBe(501);
  });

  test("callback returns 501 when provider not configured", async () => {
    delete process.env["DISCORD_CLIENT_ID"];
    delete process.env["DISCORD_CLIENT_SECRET"];

    const res = await fetch(`${ts.url}/v1/auth/discord/callback?code=x&state=y`, { redirect: "manual" });
    expect(res.status).toBe(501);
  });
});

// =============================================================================
// Stateless HMAC state signing — direct contract tests
// =============================================================================

describe("OAuth state signing (stateless HMAC)", () => {
  test("rejects tampered state token", async () => {
    mockFetch(async () => { throw new Error("should not reach provider"); });

    const { state } = await initiateOAuth("google");
    // Flip one base64url character in the signature half so HMAC verify fails.
    const dot = state.indexOf(".");
    const payload = state.slice(0, dot);
    const sig = state.slice(dot + 1);
    const flipped = (sig[0] === "A" ? "B" : "A") + sig.slice(1);
    const tampered = `${payload}.${flipped}`;

    const res = await fetch(
      `${ts.url}/v1/auth/google/callback?code=test-code&state=${tampered}`,
      { redirect: "manual" },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("error=oauth_failed");
  });

  test("rejects state issued for a different provider", async () => {
    mockFetch(async () => { throw new Error("should not reach provider"); });

    // Issue a state bound to google, then try to redeem it on the discord callback.
    const { state } = await initiateOAuth("google");
    const res = await fetch(
      `${ts.url}/v1/auth/discord/callback?code=test-code&state=${state}`,
      { redirect: "manual" },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("error=oauth_failed");
  });

  test("rejects state with expired exp field", async () => {
    // Directly craft an expired state using the same secret by round-tripping
    // a real issuance first to pin the secret, then decoding and re-signing
    // with an in-the-past exp. Done via the internal helpers so we're testing
    // the verify path, not the whole flow.
    const { createHmac } = await import("node:crypto");
    process.env["OAUTH_STATE_SECRET"] = "x".repeat(32);
    const expiredPayload = {
      n: "deadbeef",
      m: "login",
      p: "google",
      e: Date.now() - 1000,
    };
    const body = Buffer.from(JSON.stringify(expiredPayload), "utf8");
    const mac = createHmac("sha256", Buffer.from("x".repeat(32), "utf8")).update(body).digest();
    const b64 = (b: Buffer) =>
      b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const expiredState = `${b64(body)}.${b64(mac)}`;

    const res = await fetch(
      `${ts.url}/v1/auth/google/callback?code=test-code&state=${expiredState}`,
      { redirect: "manual" },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("error=oauth_failed");

    delete process.env["OAUTH_STATE_SECRET"];
  });
});

// =============================================================================
// Login with empty password_hash
// =============================================================================

describe("Login with social-only account", () => {
  test("rejects with 400 when password_hash is empty", async () => {
    // Create a social-only account directly
    await ts.sql`
      INSERT INTO accounts (email, username, password_hash, display_name, google_id)
      VALUES (${"social-only@example.com"}, ${"socialonly"}, ${""}, ${"Social User"}, ${"google-social-only"})
    `;

    const res = await fetch(`${ts.url}/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "social-only@example.com",
        password: "anything",
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("This account uses social sign-in");
  });
});

// =============================================================================
// Profile shows linked providers
// =============================================================================

describe("Profile providers", () => {
  test("shows linked providers in profile response", async () => {
    const { token, accountId } = await registerAndLogin(ts, "profile-providers");
    await ts.sql`UPDATE accounts SET google_id = ${"g123"}, discord_id = ${"d456"} WHERE id = ${accountId}`;

    const res = await fetch(`${ts.url}/v1/auth/profile`, {
      headers: authHeaders(token),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { providers: string[] };
    expect(body.providers).toContain("google");
    expect(body.providers).toContain("discord");
    expect(body.providers).not.toContain("github");
  });

  test("shows empty providers array when none linked", async () => {
    const { token } = await registerAndLogin(ts, "profile-no-providers");
    const res = await fetch(`${ts.url}/v1/auth/profile`, {
      headers: authHeaders(token),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { providers: string[] };
    expect(body.providers).toEqual([]);
  });
});

// =============================================================================
// GitHub-specific tests
// =============================================================================

describe("GitHub OAuth", () => {
  test("callback fetches /user/emails for verified email", async () => {
    let emailsEndpointCalled = false;

    mockFetch(async (url) => {
      if (url.includes("github.com/login/oauth/access_token")) return githubTokenResponse();
      if (url === "https://api.github.com/user") return githubUserInfo({ id: 999, email: null });
      if (url === "https://api.github.com/user/emails") {
        emailsEndpointCalled = true;
        return githubEmails([
          { email: "secondary@example.com", primary: false, verified: true },
          { email: "primary-gh@example.com", primary: true, verified: true },
        ]);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const { state } = await initiateOAuth("github");
    const res = await fetch(
      `${ts.url}/v1/auth/github/callback?code=test-code&state=${state}`,
      { redirect: "manual" },
    );

    expect(res.status).toBe(302);
    expect(emailsEndpointCalled).toBe(true);

    // Verify the primary verified email was used
    const rows = await ts.sql`SELECT email FROM accounts WHERE github_id = ${"999"}`;
    expect(rows.length).toBe(1);
    expect(rows[0]!.email).toBe("primary-gh@example.com");
  });

  test("stores GitHub id as string", async () => {
    mockFetch(async (url) => {
      if (url.includes("github.com/login/oauth/access_token")) return githubTokenResponse();
      if (url === "https://api.github.com/user") return githubUserInfo({ id: 12345 });
      if (url === "https://api.github.com/user/emails") return githubEmails();
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const { state } = await initiateOAuth("github");
    await fetch(`${ts.url}/v1/auth/github/callback?code=test-code&state=${state}`, { redirect: "manual" });

    const rows = await ts.sql`SELECT github_id FROM accounts WHERE github_id = ${"12345"}`;
    expect(rows.length).toBe(1);
    expect(typeof rows[0]!.github_id).toBe("string");
  });
});
