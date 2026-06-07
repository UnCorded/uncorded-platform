import type { RouteContext } from "../routes";
import { generateSessionToken, hashToken } from "../crypto";
import { badRequest, rateLimited, internalError } from "../errors";
import { authenticate, RATE_RESEND_VERIFICATION } from "../middleware";
import { sendVerificationEmail } from "../email";

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

export async function handleResendVerification(
  request: Request,
  ctx: RouteContext,
): Promise<Response> {
  const account = await authenticate(request, ctx.sql);
  if (account instanceof Response) return account;

  if (account.emailVerified) {
    return badRequest("Email already verified");
  }

  const rateResult = ctx.rateLimiter.consume(`resend-verification:${account.id}`, RATE_RESEND_VERIFICATION);
  if (!rateResult.allowed) return rateLimited(rateResult.retryAfter);

  // Delete any existing tokens for this account
  await ctx.sql`DELETE FROM email_verifications WHERE account_id = ${account.id}`;

  // Generate new token
  const rawToken = generateSessionToken();
  const tokenHash = await hashToken(rawToken);
  const expiresAt = new Date(Date.now() + TWENTY_FOUR_HOURS_MS);

  await ctx.sql`
    INSERT INTO email_verifications (account_id, token_hash, expires_at)
    VALUES (${account.id}, ${tokenHash}, ${expiresAt})
  `;

  const verificationUrl = `${ctx.appBaseUrl}/v1/auth/verify-email?token=${rawToken}`;
  if (ctx.emailClient === null) {
    ctx.logger.warn("verification email not sent — RESEND_API_KEY not set", {
      verificationUrl,
      accountId: account.id,
    });
  } else {
    try {
      await sendVerificationEmail(ctx.emailClient, account.email, verificationUrl);
    } catch (err: unknown) {
      ctx.logger.error("failed to send verification email", {
        err: err instanceof Error ? err.message : String(err),
        accountId: account.id,
      });
      return internalError("Failed to send verification email");
    }
  }

  return Response.json({ message: "Verification email sent" });
}
