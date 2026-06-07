import type { RouteContext } from "../routes";
import { hashToken } from "../crypto";
import { createSession, sessionCookie, getClientIp, RATE_LOGIN } from "../middleware";
import { getPostLoginRedirect } from "../post-login";

// The verify-email link is clicked from a mail client, so every response is a
// browser-level redirect — never JSON. On success we set the session cookie
// and bounce to the website with `?verified=1` so the SPA can confirm the
// signed-in state and surface a welcome toast. On failure we bounce with an
// `error=` code so the auth page can render the right banner.

type VerifyError = "verify_failed" | "verify_rate_limited";

function redirectToWeb(error?: VerifyError, cookie?: string): Response {
  const base = getPostLoginRedirect();
  const url = error ? `${base}/?error=${error}` : `${base}/?verified=1`;
  const headers: Record<string, string> = { Location: url };
  if (cookie) headers["Set-Cookie"] = cookie;
  return new Response(null, { status: 302, headers });
}

export async function handleVerifyEmail(
  request: Request,
  ctx: RouteContext,
): Promise<Response> {
  const clientIp = getClientIp(request);
  const rateResult = ctx.rateLimiter.consume(`verify-email:${clientIp}`, RATE_LOGIN);
  if (!rateResult.allowed) return redirectToWeb("verify_rate_limited");

  const url = new URL(request.url);
  const rawToken = url.searchParams.get("token");
  if (!rawToken) return redirectToWeb("verify_failed");

  const tokenHash = await hashToken(rawToken);

  const rows = await ctx.sql`
    SELECT id, account_id
    FROM email_verifications
    WHERE token_hash = ${tokenHash}
      AND expires_at > now()
    LIMIT 1
  `;

  const row = rows[0];
  if (!row) return redirectToWeb("verify_failed");

  const verificationId = row.id as string;
  const accountId = row.account_id as string;

  // Guard the UPDATE on email_verified = false so a double-click on the
  // verification link doesn't redundantly bump updated_at on an already-verified
  // account. The DELETE is naturally idempotent.
  await ctx.sql`
    UPDATE accounts
    SET email_verified = true, updated_at = now()
    WHERE id = ${accountId} AND email_verified = false
  `;
  await ctx.sql`DELETE FROM email_verifications WHERE id = ${verificationId}`;

  const token = await createSession(ctx.sql, accountId);
  return redirectToWeb(undefined, sessionCookie(token));
}
