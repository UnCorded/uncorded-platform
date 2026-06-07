import type { JwtPayload } from "@uncorded/protocol";
import type { RouteContext } from "../routes";
import { authenticate, RATE_SERVER_TOKEN } from "../middleware";
import { badRequest, notFound, rateLimited, internalError, forbidden } from "../errors";
import { getActiveSigningKey, signJwt } from "../crypto";

export async function handleServerToken(
  request: Request,
  ctx: RouteContext,
): Promise<Response> {
  const account = await authenticate(request, ctx.sql);
  if (account instanceof Response) return account;

  const { allowed, retryAfter } = ctx.rateLimiter.consume(
    `token:${account.id}`,
    RATE_SERVER_TOKEN,
  );
  if (!allowed) return rateLimited(retryAfter);

  let body: { server_id: unknown };
  try {
    body = (await request.json()) as { server_id: unknown };
  } catch {
    return badRequest("Invalid JSON body");
  }

  if (typeof body.server_id !== "string" || body.server_id.length === 0) {
    return badRequest("server_id is required");
  }

  const rows = await ctx.sql`
    SELECT id, owner_id, visibility FROM servers WHERE id = ${body.server_id}
  `;
  const server = rows[0];
  if (!server) return notFound("Server not found");

  // Public servers: any authenticated user may join.
  // Private servers: owner only until a members/invitations system exists.
  // TODO: expand to check server_members when invite/join system is added (Phase 2)
  if ((server.visibility as string) === 'private' && account.id !== (server.owner_id as string)) {
    return forbidden("You do not have access to this server");
  }

  const signingKey = await getActiveSigningKey(ctx.sql);
  if (!signingKey) return internalError("No signing key available");

  const now = Math.floor(Date.now() / 1000);
  const payload: JwtPayload = {
    sub: account.id,
    server_id: server.id as string,
    username: account.username,
    display_name: account.displayName,
    avatar_url: account.avatarUrl,
    is_owner: account.id === (server.owner_id as string),
    iat: now,
    exp: now + 600, // 10 minutes
    jti: crypto.randomUUID(),
  };

  const token = await signJwt(payload as unknown as Record<string, unknown>, signingKey);
  return Response.json({ token, expires_at: payload.exp });
}
