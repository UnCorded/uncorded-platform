import type { RouteContext } from "../routes";
import { hashPassword, generateSessionToken, hashToken } from "../crypto";
import { badRequest, conflict, rateLimited, internalError, errorResponse } from "../errors";
import { getClientIp, RATE_REGISTER, RATE_REGISTER_ASN } from "../middleware";
import { verifyCaptcha } from "../captcha";
import { lookupAsn } from "../asn";
import { sendVerificationEmail } from "../email";
import { validateUsername, type UsernameError } from "../usernames";

interface RegisterBody {
  email: unknown;
  username: unknown;
  password: unknown;
  display_name: unknown;
  captcha_token: unknown;
}

// Map a typed UsernameError into a stable error code for clients to switch
// on. Keeps the wire format identical to the validator's enum so the website
// can render per-error inline hints without parsing English strings.
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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

export async function handleRegister(
  request: Request,
  ctx: RouteContext,
): Promise<Response> {
  const clientIp = getClientIp(request);

  // IP rate limit
  const rateResult = ctx.rateLimiter.consume(`register:${clientIp}`, RATE_REGISTER);
  if (!rateResult.allowed) return rateLimited(rateResult.retryAfter);

  // ASN rate limit (best-effort — skipped if lookup fails)
  const asn = await lookupAsn(clientIp);
  if (asn !== null) {
    const asnRate = ctx.rateLimiter.consume(`register:asn:${asn}`, RATE_REGISTER_ASN);
    if (!asnRate.allowed) return rateLimited(asnRate.retryAfter);
  }

  let body: RegisterBody;
  try {
    body = (await request.json()) as RegisterBody;
  } catch {
    return badRequest("Invalid JSON body");
  }

  // Validate input
  if (typeof body.email !== "string" || !EMAIL_RE.test(body.email)) {
    return badRequest("A valid email address is required");
  }
  const usernameResult = validateUsername(body.username);
  if (!usernameResult.ok) {
    return usernameErrorResponse(usernameResult.error);
  }
  if (typeof body.password !== "string" || body.password.length < 8) {
    return badRequest("Password must be at least 8 characters");
  }
  // Cap enforced before Argon2id to prevent a hash-time DoS on an oversized
  // input. 128 characters is the OWASP ceiling and comfortably covers real
  // passphrases (NIST's floor is 64).
  if (body.password.length > 128) {
    return badRequest("Password must be 128 characters or fewer");
  }
  if (typeof body.display_name !== "string" || body.display_name.trim().length === 0) {
    return badRequest("Display name is required");
  }
  if (body.display_name.trim().length > 50) {
    return badRequest("Display name must be 50 characters or fewer");
  }

  // CAPTCHA validation
  const captchaToken = typeof body.captcha_token === "string" ? body.captcha_token : "";
  const captchaOk = await verifyCaptcha(captchaToken, clientIp);
  if (!captchaOk) {
    return errorResponse(400, "CAPTCHA_FAILED", "CAPTCHA verification failed");
  }

  const email = body.email.toLowerCase().trim();
  const username = usernameResult.username;
  const displayName = body.display_name.trim();
  const passwordHash = await hashPassword(body.password);

  // Insert account. The user-chosen username goes in with username_changed_at
  // = NULL — the cooldown clock starts on the FIRST rename, not on signup, so
  // a user who picks a name they regret has one free swap.
  let accountId: string;
  try {
    const rows = await ctx.sql`
      INSERT INTO accounts (email, username, password_hash, display_name)
      VALUES (${email}, ${username}, ${passwordHash}, ${displayName})
      RETURNING id
    `;
    accountId = rows[0]!.id as string;
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes("unique")) {
      // Distinguish email vs username collision — both columns carry a
      // unique index, so the client must know which field to highlight.
      if (err.message.includes("accounts_username_lower_idx") || err.message.toLowerCase().includes("username")) {
        return errorResponse(409, "USERNAME_TAKEN", "That username is already taken");
      }
      if (err.message.includes("email")) {
        return conflict("An account with this email already exists");
      }
    }
    ctx.logger.error("registration error", { err: err instanceof Error ? err.message : String(err) });
    return internalError();
  }

  // Generate verification token
  const rawToken = generateSessionToken();
  const tokenHash = await hashToken(rawToken);
  const expiresAt = new Date(Date.now() + TWENTY_FOUR_HOURS_MS);

  await ctx.sql`
    INSERT INTO email_verifications (account_id, token_hash, expires_at)
    VALUES (${accountId}, ${tokenHash}, ${expiresAt})
  `;

  // Send verification email (or log in dev mode)
  const verificationUrl = `${ctx.appBaseUrl}/v1/auth/verify-email?token=${rawToken}`;
  if (ctx.emailClient === null) {
    ctx.logger.warn("verification email not sent — RESEND_API_KEY not set", { verificationUrl, accountId });
  } else {
    try {
      await sendVerificationEmail(ctx.emailClient, email, verificationUrl);
    } catch (err: unknown) {
      ctx.logger.error("failed to send verification email", {
        err: err instanceof Error ? err.message : String(err),
        accountId,
      });
      // Don't fail registration — user can resend
    }
  }

  return Response.json(
    { message: "Check your email to verify your account" },
    { status: 202 },
  );
}
