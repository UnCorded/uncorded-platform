import type { RouteContext } from "../routes";
import {
  authenticate,
  sessionCookie,
  RATE_SESSION_REFRESH,
  SESSION_IDLE_MAX_AGE_MS,
  SESSION_ABSOLUTE_MAX_AGE_MS,
} from "../middleware";
import { rateLimited } from "../errors";
import { generateSessionToken, hashToken } from "../crypto";

function parseCookieValue(header: string, name: string): string | null {
  const prefix = `${name}=`;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(prefix)) return trimmed.slice(prefix.length);
  }
  return null;
}

// POST /v1/auth/token/refresh
export async function handleTokenRefresh(
  request: Request,
  ctx: RouteContext,
): Promise<Response> {
  const account = await authenticate(request, ctx.sql);
  if (account instanceof Response) return account;

  const { allowed, retryAfter } = ctx.rateLimiter.consume(
    `refresh:${account.id}`,
    RATE_SESSION_REFRESH,
  );
  if (!allowed) return rateLimited(retryAfter);

  const cookie = request.headers.get("cookie")!;
  const oldToken = parseCookieValue(cookie, "__Host-session")!;
  const oldTokenHash = await hashToken(oldToken);

  // Atomic rotation: delete old session, insert new one. Refresh resets BOTH
  // windows because the user proved possession of the cookie — the new
  // session is a freshly minted one with full lifetime, not a slide of the
  // old one.
  const newToken = generateSessionToken();
  const newTokenHash = await hashToken(newToken);
  const now = Date.now();
  const idleExpiresAt = new Date(now + SESSION_IDLE_MAX_AGE_MS);
  const absoluteExpiresAt = new Date(now + SESSION_ABSOLUTE_MAX_AGE_MS);

  await ctx.sql.begin(async (tx) => {
    await tx`DELETE FROM sessions WHERE token_hash = ${oldTokenHash}`;
    await tx`
      INSERT INTO sessions (account_id, token_hash, idle_expires_at, absolute_expires_at)
      VALUES (${account.id}, ${newTokenHash}, ${idleExpiresAt}, ${absoluteExpiresAt})
    `;
  });

  return new Response(null, {
    status: 204,
    headers: { "Set-Cookie": sessionCookie(newToken) },
  });
}
