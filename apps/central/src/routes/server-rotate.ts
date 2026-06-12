import type { RouteContext } from "../routes";
import { authenticate, type RateLimitConfig } from "../middleware";
import { forbidden, notFound, rateLimited } from "../errors";
import { generateServerSecret, hashToken } from "../crypto";

const RATE_SERVER_ROTATE: RateLimitConfig = { maxTokens: 5, refillRate: 5 / 60 };

// POST /v1/servers/:id/secret/rotate
export async function handleRotateSecret(
  request: Request,
  ctx: RouteContext,
  serverId: string,
): Promise<Response> {
  const account = await authenticate(request, ctx.sql);
  if (account instanceof Response) return account;

  const { allowed, retryAfter } = ctx.rateLimiter.consume(
    `server-rotate:${account.id}`,
    RATE_SERVER_ROTATE,
  );
  if (!allowed) return rateLimited(retryAfter);

  const rows = await ctx.sql`
    SELECT id, owner_id FROM servers WHERE id = ${serverId} AND deleted_at IS NULL
  `;
  if (rows.length === 0) return notFound("Server not found");
  if (rows[0]!.owner_id !== account.id) return forbidden("Not the server owner");

  const newSecret = generateServerSecret();
  const newSecretHash = await hashToken(newSecret);

  await ctx.sql`
    UPDATE servers
    SET server_secret_hash = ${newSecretHash}, updated_at = now()
    WHERE id = ${serverId}
  `;

  return Response.json({ server_secret: newSecret });
}
