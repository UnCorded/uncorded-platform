import type { RouteContext } from "../routes";
import { verifyPassword } from "../crypto";
import { badRequest, unauthorized, rateLimited, errorResponse } from "../errors";
import {
  createSession,
  sessionCookie,
  getClientIp,
  RATE_LOGIN,
} from "../middleware";
import { USERNAME_CHANGE_COOLDOWN_MS } from "../usernames";

function nextRenameAvailableAt(changedAt: Date | null): Date | null {
  if (changedAt === null) return null;
  const next = new Date(changedAt.getTime() + USERNAME_CHANGE_COOLDOWN_MS);
  return next.getTime() > Date.now() ? next : null;
}

interface LoginBody {
  // Accepts an email OR a username. We preserve `email` as a legacy alias so
  // existing clients that haven't shipped the rename keep working through the
  // upgrade window — newer clients should send `identifier`.
  identifier: unknown;
  email: unknown;
  password: unknown;
}

export async function handleLogin(
  request: Request,
  ctx: RouteContext,
): Promise<Response> {
  // Rate limit by IP
  const clientIp = getClientIp(request);
  const rateResult = ctx.rateLimiter.consume(`login:${clientIp}`, RATE_LOGIN);
  if (!rateResult.allowed) return rateLimited(rateResult.retryAfter);

  let body: LoginBody;
  try {
    body = (await request.json()) as LoginBody;
  } catch {
    return badRequest("Invalid JSON body");
  }

  const rawIdentifier =
    typeof body.identifier === "string" ? body.identifier
    : typeof body.email === "string" ? body.email
    : null;
  if (rawIdentifier === null || typeof body.password !== "string") {
    return badRequest("Email or username and password are required");
  }
  // Same 128-character ceiling as registration. A valid password can never
  // exceed this; anything larger is a hash-time DoS attempt.
  if (body.password.length > 128) {
    return badRequest("Password must be 128 characters or fewer");
  }

  const identifier = rawIdentifier.trim().toLowerCase();
  if (identifier.length === 0) {
    return badRequest("Email or username and password are required");
  }
  // Cap the identifier so a giant string can't pin a query plan or pad the
  // log line. Real emails fit in 254; usernames in 20. 256 covers both with
  // headroom and rejects garbage early.
  if (identifier.length > 256) {
    return unauthorized("Invalid email or password");
  }

  const isEmail = identifier.includes("@");

  // Look up by whichever column the identifier looks like. Username uniqueness
  // is enforced case-insensitively via accounts_username_lower_idx, so we
  // compare on LOWER(username) too. Generic error message either way to avoid
  // leaking which column matched.
  const rows = isEmail
    ? await ctx.sql`
        SELECT id, email, username, username_changed_at, password_hash, display_name, avatar_url, email_verified, phone_verified
        FROM accounts
        WHERE email = ${identifier}
        LIMIT 1
      `
    : await ctx.sql`
        SELECT id, email, username, username_changed_at, password_hash, display_name, avatar_url, email_verified, phone_verified
        FROM accounts
        WHERE LOWER(username) = ${identifier}
        LIMIT 1
      `;

  const account = rows[0];
  if (!account) {
    return unauthorized("Invalid email or password");
  }

  if (!(account.password_hash as string)) {
    return badRequest("This account uses social sign-in");
  }

  const valid = await verifyPassword(account.password_hash as string, body.password);
  if (!valid) {
    return unauthorized("Invalid email or password");
  }

  if (!(account.email_verified as boolean)) {
    return errorResponse(
      403,
      "EMAIL_NOT_VERIFIED",
      "Please verify your email address before logging in. Check your inbox or request a new verification email.",
    );
  }

  const accountId = account.id as string;
  const token = await createSession(ctx.sql, accountId);

  const usernameChangedAt = (account.username_changed_at as Date | null) ?? null;
  const nextAvailable = nextRenameAvailableAt(usernameChangedAt);

  return new Response(
    JSON.stringify({
      id: accountId,
      email: account.email,
      username: account.username,
      username_changed_at: usernameChangedAt?.toISOString() ?? null,
      username_change_available_at: nextAvailable?.toISOString() ?? null,
      display_name: account.display_name,
      avatar_url: account.avatar_url ?? null,
      email_verified: account.email_verified,
      phone_verified: account.phone_verified,
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Set-Cookie": sessionCookie(token),
      },
    },
  );
}
