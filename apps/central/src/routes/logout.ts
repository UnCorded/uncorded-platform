import type { RouteContext } from "../routes";
import { hashToken } from "../crypto";
import { rateLimited, unauthorized } from "../errors";
import { RATE_LOGOUT, clearSessionCookie, getClientIp } from "../middleware";

export async function handleLogout(
  request: Request,
  ctx: RouteContext,
): Promise<Response> {
  // Keyed on client IP because the caller's session may already be gone
  // (double-click logout, expired cookie). Prevents a credential-stuffing
  // worker from using /logout as a zero-cost session-probe loop.
  const { allowed, retryAfter } = ctx.rateLimiter.consume(
    `logout:${getClientIp(request)}`,
    RATE_LOGOUT,
  );
  if (!allowed) return rateLimited(retryAfter);

  const cookie = request.headers.get("cookie");
  if (!cookie) return unauthorized();

  const token = parseCookie(cookie, "__Host-session");
  if (!token) return unauthorized();

  const tokenHash = await hashToken(token);

  // Delete session — if it doesn't exist, that's fine
  await ctx.sql`DELETE FROM sessions WHERE token_hash = ${tokenHash}`;

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": clearSessionCookie(),
    },
  });
}

function parseCookie(header: string, name: string): string | null {
  const prefix = `${name}=`;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(prefix)) {
      return trimmed.slice(prefix.length);
    }
  }
  return null;
}
