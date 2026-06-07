import type { RouteContext } from "../routes";
import { authenticate, RATE_MARKETPLACE_BROWSE } from "../middleware";
import { notFound, rateLimited, errorResponse } from "../errors";

/**
 * Returns a signed download URL plus the version's integrity hash. The
 * runtime MUST hash the downloaded bytes and match this SHA-256 before
 * unpacking or executing the plugin — the 302 redirect shape the endpoint
 * used before made that check impossible, which meant a compromised or
 * mis-served R2 object would be run as trusted plugin code.
 */
export async function handleDownloadPlugin(
  request: Request,
  ctx: RouteContext,
  slug: string,
): Promise<Response> {
  const account = await authenticate(request, ctx.sql);
  if (account instanceof Response) return account;

  const { allowed, retryAfter } = ctx.rateLimiter.consume(
    `marketplace:${account.id}`,
    RATE_MARKETPLACE_BROWSE,
  );
  if (!allowed) return rateLimited(retryAfter);

  if (ctx.r2 === null) {
    return errorResponse(503, "R2_UNAVAILABLE", "Object storage is not configured");
  }

  // Fetch latest non-revoked version for a listed plugin
  const rows = await ctx.sql`
    SELECT pv.version, pv.package_url, pv.package_size_bytes, pv.package_sha256
    FROM plugins p
    JOIN plugin_versions pv ON pv.plugin_id = p.id
    WHERE p.slug = ${slug}
      AND p.is_listed = true
      AND pv.is_revoked = false
    ORDER BY pv.created_at DESC
    LIMIT 1
  `;

  const row = rows[0] as {
    version: string;
    package_url: string | null;
    package_size_bytes: number | null;
    package_sha256: string | null;
  } | undefined;
  if (!row) return notFound("Plugin not found");
  if (!row.package_url) {
    return errorResponse(404, "PACKAGE_NOT_AVAILABLE", "No package available for this plugin");
  }

  const url = await ctx.r2.presignedGetUrl(row.package_url, 900);

  // Fire-and-forget install count increment
  ctx.sql`UPDATE plugins SET install_count = install_count + 1 WHERE slug = ${slug}`.catch(
    () => {},
  );

  return Response.json({
    version: row.version,
    url,
    sha256: row.package_sha256,
    size_bytes: row.package_size_bytes,
    expires_in: 900,
  });
}
