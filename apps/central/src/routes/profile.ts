import type { RouteContext } from "../routes";
import { authenticate, type SessionAccount, type RateLimitConfig } from "../middleware";
import { badRequest, conflict, rateLimited, errorResponse, internalError, unauthorized } from "../errors";
import { hashPassword, verifyPassword, generateSessionToken, hashToken } from "../crypto";
import {
  validateUsername,
  USERNAME_CHANGE_COOLDOWN_MS,
  type UsernameError,
} from "../usernames";
import { sendVerificationEmail } from "../email";

const RATE_PROFILE_GET: RateLimitConfig = { maxTokens: 30, refillRate: 30 / 60 };
const RATE_PROFILE_UPDATE: RateLimitConfig = { maxTokens: 10, refillRate: 10 / 60 };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

interface ProfileResponse {
  id: string;
  email: string;
  username: string;
  username_changed_at: string | null;
  username_change_available_at: string | null;
  display_name: string;
  avatar_url: string | null;
  email_verified: boolean;
  phone_verified: boolean;
  providers?: string[];
}

function nextRenameAvailableAt(changedAt: Date | null): Date | null {
  if (changedAt === null) return null;
  const next = new Date(changedAt.getTime() + USERNAME_CHANGE_COOLDOWN_MS);
  return next.getTime() > Date.now() ? next : null;
}

function profileJson(account: SessionAccount, providers?: string[]): ProfileResponse {
  const next = nextRenameAvailableAt(account.usernameChangedAt);
  return {
    id: account.id,
    email: account.email,
    username: account.username,
    username_changed_at: account.usernameChangedAt?.toISOString() ?? null,
    username_change_available_at: next?.toISOString() ?? null,
    display_name: account.displayName,
    avatar_url: account.avatarUrl,
    email_verified: account.emailVerified,
    phone_verified: account.phoneVerified,
    ...(providers !== undefined ? { providers } : {}),
  };
}

function usernameErrorResponse(err: UsernameError): Response {
  const messages: Record<UsernameError, string> = {
    username_required: "Username is required",
    username_too_short: "Username must be at least 3 characters",
    username_too_long: "Username must be 20 characters or fewer",
    username_charset: "Username may only contain letters, numbers, and underscores",
    username_reserved: "That username is reserved",
  };
  return errorResponse(400, err.toUpperCase(), messages[err]);
}

export async function handleGetProfile(
  request: Request,
  ctx: RouteContext,
): Promise<Response> {
  const result = await authenticate(request, ctx.sql);
  if (result instanceof Response) return result;

  const { allowed, retryAfter } = ctx.rateLimiter.consume(
    `profile-get:${result.id}`,
    RATE_PROFILE_GET,
  );
  if (!allowed) return rateLimited(retryAfter);

  const providerRows = await ctx.sql`
    SELECT
      google_id IS NOT NULL AS has_google,
      discord_id IS NOT NULL AS has_discord,
      github_id IS NOT NULL AS has_github
    FROM accounts
    WHERE id = ${result.id}
    LIMIT 1
  `;
  const row = providerRows[0]!;
  const providers: string[] = [];
  if (row.has_google) providers.push("google");
  if (row.has_discord) providers.push("discord");
  if (row.has_github) providers.push("github");

  return Response.json(profileJson(result, providers));
}

interface PatchBody {
  username?: unknown;
  display_name?: unknown;
  avatar_url?: unknown;
  email?: unknown;
  current_password?: unknown;
  new_password?: unknown;
}

export async function handlePatchProfile(
  request: Request,
  ctx: RouteContext,
): Promise<Response> {
  const result = await authenticate(request, ctx.sql);
  if (result instanceof Response) return result;

  const { allowed: patchAllowed, retryAfter: patchRetryAfter } =
    ctx.rateLimiter.consume(`profile-update:${result.id}`, RATE_PROFILE_UPDATE);
  if (!patchAllowed) return rateLimited(patchRetryAfter);

  let body: PatchBody;
  try {
    body = (await request.json()) as PatchBody;
  } catch {
    return badRequest("Invalid JSON body");
  }

  // Each field is independent — the client may patch one or several at once.
  // We validate everything up-front so a partial update never lands when one
  // of the inputs is bad.

  // --- username ---
  let nextUsername: string | null = null;
  if (body.username !== undefined) {
    const v = validateUsername(body.username);
    if (!v.ok) return usernameErrorResponse(v.error);
    if (v.username !== result.username) {
      const next = nextRenameAvailableAt(result.usernameChangedAt);
      if (next !== null) {
        return errorResponse(
          429,
          "USERNAME_COOLDOWN",
          `You can change your username again on ${next.toUTCString()}`,
        );
      }
      nextUsername = v.username;
    }
  }

  // --- display_name ---
  let nextDisplayName: string | null = null;
  if (body.display_name !== undefined) {
    if (typeof body.display_name !== "string" || body.display_name.trim().length === 0) {
      return badRequest("Display name cannot be empty");
    }
    if (body.display_name.trim().length > 50) {
      return badRequest("Display name must be 50 characters or fewer");
    }
    nextDisplayName = body.display_name.trim();
  }

  // --- avatar_url ---
  let avatarFieldPresent = false;
  let nextAvatarUrl: string | null = null;
  if (body.avatar_url !== undefined) {
    avatarFieldPresent = true;
    if (body.avatar_url !== null) {
      if (typeof body.avatar_url !== "string") {
        return badRequest("avatar_url must be a string or null");
      }
      if (!body.avatar_url.startsWith("https://")) {
        return badRequest("avatar_url must be an https URL");
      }
      if (body.avatar_url.length > 512) {
        return badRequest("avatar_url must be 512 characters or fewer");
      }
      nextAvatarUrl = body.avatar_url;
    }
  }

  // --- email ---
  // Changing email re-arms the verification gate: the new address is stored
  // immediately but `email_verified` flips to false until they click the new
  // verification link. We require current_password for this branch — an
  // attacker with a stolen session cookie should not be able to redirect
  // recovery email to themselves.
  let nextEmail: string | null = null;
  if (body.email !== undefined) {
    if (typeof body.email !== "string" || !EMAIL_RE.test(body.email)) {
      return badRequest("A valid email address is required");
    }
    const candidate = body.email.toLowerCase().trim();
    if (candidate !== result.email) {
      // current_password gate
      if (typeof body.current_password !== "string" || body.current_password.length === 0) {
        return errorResponse(
          400,
          "CURRENT_PASSWORD_REQUIRED",
          "Confirm your current password to change your email",
        );
      }
      if (body.current_password.length > 128) {
        return badRequest("Password must be 128 characters or fewer");
      }
      const pwRows = await ctx.sql`SELECT password_hash FROM accounts WHERE id = ${result.id} LIMIT 1`;
      const pwHash = pwRows[0]?.password_hash as string | undefined;
      if (!pwHash) {
        return errorResponse(
          400,
          "PASSWORD_NOT_SET",
          "This account uses social sign-in. Set a password before changing email.",
        );
      }
      const ok = await verifyPassword(pwHash, body.current_password);
      if (!ok) return unauthorized("Current password is incorrect");
      nextEmail = candidate;
    }
  }

  // --- password change ---
  // Independent of email change: takes current_password + new_password.
  let nextPasswordHash: string | null = null;
  if (body.new_password !== undefined) {
    if (typeof body.new_password !== "string" || body.new_password.length < 8) {
      return badRequest("Password must be at least 8 characters");
    }
    if (body.new_password.length > 128) {
      return badRequest("Password must be 128 characters or fewer");
    }
    if (typeof body.current_password !== "string" || body.current_password.length === 0) {
      return errorResponse(
        400,
        "CURRENT_PASSWORD_REQUIRED",
        "Confirm your current password to set a new one",
      );
    }
    if (body.current_password.length > 128) {
      return badRequest("Password must be 128 characters or fewer");
    }
    const pwRows = await ctx.sql`SELECT password_hash FROM accounts WHERE id = ${result.id} LIMIT 1`;
    const pwHash = pwRows[0]?.password_hash as string | undefined;
    if (!pwHash) {
      return errorResponse(
        400,
        "PASSWORD_NOT_SET",
        "This account uses social sign-in. Use the link/unlink controls instead.",
      );
    }
    const ok = await verifyPassword(pwHash, body.current_password);
    if (!ok) return unauthorized("Current password is incorrect");
    nextPasswordHash = await hashPassword(body.new_password);
  }

  // Did the request actually carry any updates?
  const noop =
    nextUsername === null &&
    nextDisplayName === null &&
    !avatarFieldPresent &&
    nextEmail === null &&
    nextPasswordHash === null;
  if (noop) return badRequest("No fields to update");

  // Compute the final values that will be written. Anything the client did
  // not touch carries through unchanged.
  const finalUsername = nextUsername ?? result.username;
  const finalDisplayName = nextDisplayName ?? result.displayName;
  const finalAvatarUrl = avatarFieldPresent ? nextAvatarUrl : result.avatarUrl;
  const finalEmail = nextEmail ?? result.email;
  // username_changed_at: if we renamed, set to now(); else carry forward.
  const usernameChangedSql =
    nextUsername !== null ? new Date() : result.usernameChangedAt;
  const emailVerifiedSql = nextEmail !== null ? false : result.emailVerified;

  // Persist. We do password and verification-token writes inside a single
  // transaction so a verification-token insert failure rolls the password
  // change back too — otherwise a half-applied update could lock the user
  // out of their account.
  let verificationRawToken: string | null = null;
  try {
    await ctx.sql.begin(async (tx) => {
      if (nextPasswordHash !== null) {
        await tx`
          UPDATE accounts
          SET
            username = ${finalUsername},
            username_changed_at = ${usernameChangedSql},
            display_name = ${finalDisplayName},
            avatar_url = ${finalAvatarUrl},
            email = ${finalEmail},
            email_verified = ${emailVerifiedSql},
            password_hash = ${nextPasswordHash},
            updated_at = now()
          WHERE id = ${result.id}
        `;
        // Invalidate every other session — a password change is a "sign out
        // everywhere" event for security. We keep the current cookie alive
        // by minting a fresh session token below.
        await tx`DELETE FROM sessions WHERE account_id = ${result.id}`;
      } else {
        await tx`
          UPDATE accounts
          SET
            username = ${finalUsername},
            username_changed_at = ${usernameChangedSql},
            display_name = ${finalDisplayName},
            avatar_url = ${finalAvatarUrl},
            email = ${finalEmail},
            email_verified = ${emailVerifiedSql},
            updated_at = now()
          WHERE id = ${result.id}
        `;
      }

      if (nextEmail !== null) {
        // Drop any in-flight verification rows for this account before issuing
        // a new one — the previous URL must stop working immediately so an
        // attacker who scraped the old token can't ride it onto the new
        // address.
        await tx`DELETE FROM email_verifications WHERE account_id = ${result.id}`;
        verificationRawToken = generateSessionToken();
        const tokenHash = await hashToken(verificationRawToken);
        const expiresAt = new Date(Date.now() + TWENTY_FOUR_HOURS_MS);
        await tx`
          INSERT INTO email_verifications (account_id, token_hash, expires_at)
          VALUES (${result.id}, ${tokenHash}, ${expiresAt})
        `;
      }
    });
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes("unique")) {
      if (
        err.message.includes("accounts_username_lower_idx") ||
        err.message.toLowerCase().includes("username")
      ) {
        return errorResponse(409, "USERNAME_TAKEN", "That username is already taken");
      }
      if (err.message.includes("email")) {
        return conflict("An account with this email already exists");
      }
    }
    ctx.logger.error("profile update error", {
      err: err instanceof Error ? err.message : String(err),
      accountId: result.id,
    });
    return internalError();
  }

  // Send the verification email outside the transaction so a Resend outage
  // does not roll back the user's profile change. If sending fails, the user
  // can /v1/auth/resend-verification.
  if (nextEmail !== null && verificationRawToken !== null) {
    const verificationUrl = `${ctx.appBaseUrl}/v1/auth/verify-email?token=${verificationRawToken}`;
    if (ctx.emailClient === null) {
      ctx.logger.warn("verification email not sent — RESEND_API_KEY not set", {
        verificationUrl,
        accountId: result.id,
      });
    } else {
      try {
        await sendVerificationEmail(ctx.emailClient, finalEmail, verificationUrl);
      } catch (err: unknown) {
        ctx.logger.error("failed to send verification email after email change", {
          err: err instanceof Error ? err.message : String(err),
          accountId: result.id,
        });
      }
    }
  }

  // If we wiped sessions for a password change, mint a new one so the caller
  // stays signed in. (Anything else: the existing cookie is still valid.)
  let setCookieHeader: string | null = null;
  if (nextPasswordHash !== null) {
    const { createSession, sessionCookie } = await import("../middleware");
    const newToken = await createSession(ctx.sql, result.id);
    setCookieHeader = sessionCookie(newToken);
  }

  // Re-read providers so the response shape matches GET /profile exactly.
  const providerRows = await ctx.sql`
    SELECT
      google_id IS NOT NULL AS has_google,
      discord_id IS NOT NULL AS has_discord,
      github_id IS NOT NULL AS has_github
    FROM accounts
    WHERE id = ${result.id}
    LIMIT 1
  `;
  const prow = providerRows[0]!;
  const providers: string[] = [];
  if (prow.has_google) providers.push("google");
  if (prow.has_discord) providers.push("discord");
  if (prow.has_github) providers.push("github");

  const responseAccount: SessionAccount = {
    id: result.id,
    email: finalEmail,
    username: finalUsername,
    usernameChangedAt: usernameChangedSql,
    displayName: finalDisplayName,
    avatarUrl: finalAvatarUrl,
    emailVerified: emailVerifiedSql,
    phoneVerified: result.phoneVerified,
  };

  const response = Response.json(profileJson(responseAccount, providers));
  if (setCookieHeader !== null) response.headers.set("Set-Cookie", setCookieHeader);
  return response;
}
