import type { JwtPayload } from "@uncorded/protocol";
import type { RouteContext } from "../routes";
import { authenticate, RATE_SERVER_TOKEN } from "../middleware";
import { badRequest, errorResponse, notFound, rateLimited, internalError, forbidden } from "../errors";
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
    SELECT id, owner_id, visibility, tunnel_url FROM servers WHERE id = ${body.server_id}
  `;
  const server = rows[0];
  if (!server) return notFound("Server not found");

  // Membership gate: a token (and the tunnel_url bundled with it — the only
  // place Central reveals where a server lives) is minted only for the owner
  // or an active member. Banned members are refused even on public servers.
  // Private servers answer 404 to everyone else, matching GET /:id, so a
  // denied token request can't confirm the server exists.
  const isOwner = account.id === (server.owner_id as string);
  if (!isOwner) {
    const member = await ctx.sql`
      SELECT status FROM server_members
      WHERE server_id = ${server.id as string} AND account_id = ${account.id}
    `;
    const status = member[0]?.status as string | undefined;
    if (status !== "active") {
      if ((server.visibility as string) === "private") {
        return notFound("Server not found");
      }
      return status === "banned"
        ? forbidden("You are banned from this server")
        : errorResponse(403, "NOT_A_MEMBER", "Join this server before requesting a token");
    }
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
    is_owner: isOwner,
    iat: now,
    exp: now + 600, // 10 minutes
    jti: crypto.randomUUID(),
  };

  const token = await signJwt(payload as unknown as Record<string, unknown>, signingKey);
  // tunnel_url rides with the token: it's a capability granted by the same
  // membership check, not public directory metadata (see serverJson).
  return Response.json({
    token,
    expires_at: payload.exp,
    tunnel_url: (server.tunnel_url as string | null) ?? null,
  });
}
