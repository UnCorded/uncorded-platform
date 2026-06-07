import type { RouteContext } from "../routes";
import { authenticate, RATE_MARKETPLACE_BROWSE } from "../middleware";
import { badRequest, notFound, rateLimited } from "../errors";

const VALID_TIERS = new Set(["official", "verified", "community"]);
const VALID_SORTS = new Set(["installs", "rating", "updated"]);

// --- GET /v1/plugins ---

export async function handleListPlugins(
  request: Request,
  ctx: RouteContext,
): Promise<Response> {
  const account = await authenticate(request, ctx.sql);
  if (account instanceof Response) return account;

  const { allowed, retryAfter } = ctx.rateLimiter.consume(
    `marketplace:${account.id}`,
    RATE_MARKETPLACE_BROWSE,
  );
  if (!allowed) return rateLimited(retryAfter);

  const url = new URL(request.url);
  const q = url.searchParams.get("q")?.trim() ?? "";
  const tier = url.searchParams.get("tier") ?? "";
  const sort = url.searchParams.get("sort") ?? "installs";
  const limitRaw = Number(url.searchParams.get("limit") ?? "20");
  const offsetRaw = Number(url.searchParams.get("offset") ?? "0");

  if (!Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > 100) {
    return badRequest("limit must be an integer between 1 and 100");
  }
  if (!Number.isInteger(offsetRaw) || offsetRaw < 0) {
    return badRequest("offset must be a non-negative integer");
  }
  if (tier && !VALID_TIERS.has(tier)) {
    return badRequest("tier must be official, verified, or community");
  }
  if (!VALID_SORTS.has(sort)) {
    return badRequest("sort must be installs, rating, or updated");
  }

  const limit = limitRaw;
  const offset = offsetRaw;

  const orderFrag =
    sort === "rating"
      ? ctx.sql.unsafe("r.avg_rating DESC NULLS LAST")
      : sort === "updated"
        ? ctx.sql.unsafe("p.updated_at DESC")
        : ctx.sql.unsafe("p.install_count DESC");

  const qFragment = q
    ? ctx.sql`AND (p.name ILIKE ${"%" + q + "%"} OR p.description ILIKE ${"%" + q + "%"})`
    : ctx.sql``;
  const tierFragment = tier ? ctx.sql`AND p.trust_tier = ${tier}` : ctx.sql``;

  const rows = await ctx.sql`
    SELECT
      p.slug,
      p.name,
      p.description,
      p.category,
      p.trust_tier,
      p.latest_version,
      p.install_count,
      p.price,
      p.updated_at,
      ROUND(r.avg_rating::numeric, 1) AS avg_rating,
      COALESCE(r.rating_count, 0)::int AS rating_count
    FROM plugins p
    LEFT JOIN (
      SELECT plugin_id,
             AVG(rating) AS avg_rating,
             COUNT(*) AS rating_count
      FROM plugin_ratings
      GROUP BY plugin_id
    ) r ON r.plugin_id = p.id
    WHERE p.is_listed = true
      ${qFragment}
      ${tierFragment}
    ORDER BY ${orderFrag}
    LIMIT ${limit} OFFSET ${offset}
  `;

  const countRows = await ctx.sql`
    SELECT COUNT(*)::int AS total
    FROM plugins p
    WHERE p.is_listed = true
      ${qFragment}
      ${tierFragment}
  `;

  const total = (countRows[0]?.total as number | undefined) ?? 0;

  return Response.json({
    plugins: rows.map((row) => ({
      slug: row.slug as string,
      name: row.name as string,
      description: row.description as string,
      category: row.category as string,
      trust_tier: row.trust_tier as string,
      latest_version: (row.latest_version as string | null) ?? null,
      install_count: row.install_count as number,
      avg_rating: row.avg_rating != null ? parseFloat(row.avg_rating as string) : null,
      rating_count: row.rating_count as number,
      price: null,
      updated_at: row.updated_at as string,
    })),
    total,
    limit,
    offset,
  });
}

// --- GET /v1/plugins/:slug ---

export async function handleGetPlugin(
  request: Request,
  ctx: RouteContext,
  slug: string,
): Promise<Response> {
  const account = await authenticate(request, ctx.sql);
  if (account instanceof Response) return account;

  const pluginRows = await ctx.sql`
    SELECT
      p.id,
      p.slug,
      p.name,
      p.description,
      p.long_description,
      p.category,
      p.trust_tier,
      p.publisher_id,
      p.latest_version,
      p.install_count,
      p.price,
      p.created_at,
      p.updated_at,
      ROUND(r.avg_rating::numeric, 1) AS avg_rating,
      COALESCE(r.rating_count, 0)::int AS rating_count
    FROM plugins p
    LEFT JOIN (
      SELECT plugin_id,
             AVG(rating) AS avg_rating,
             COUNT(*) AS rating_count
      FROM plugin_ratings
      GROUP BY plugin_id
    ) r ON r.plugin_id = p.id
    WHERE p.slug = ${slug} AND p.is_listed = true
    LIMIT 1
  `;

  const plugin = pluginRows[0];
  if (!plugin) return notFound("Plugin not found");

  const publisherRows = await ctx.sql`
    SELECT id, display_name, avatar_url
    FROM accounts
    WHERE id = ${plugin.publisher_id as string}
    LIMIT 1
  `;
  const publisher = publisherRows[0];

  const versions = await ctx.sql`
    SELECT id, version, api_version_range, changelog, package_url,
           package_size_bytes, created_at
    FROM plugin_versions
    WHERE plugin_id = ${plugin.id as string} AND is_revoked = false
    ORDER BY created_at DESC
  `;

  return Response.json({
    id: plugin.id as string,
    slug: plugin.slug as string,
    name: plugin.name as string,
    description: plugin.description as string,
    long_description: (plugin.long_description as string | null) ?? null,
    category: plugin.category as string,
    trust_tier: plugin.trust_tier as string,
    latest_version: (plugin.latest_version as string | null) ?? null,
    install_count: plugin.install_count as number,
    avg_rating: plugin.avg_rating != null ? parseFloat(plugin.avg_rating as string) : null,
    rating_count: plugin.rating_count as number,
    price: null,
    created_at: plugin.created_at as string,
    updated_at: plugin.updated_at as string,
    publisher: publisher
      ? {
          id: publisher.id as string,
          display_name: publisher.display_name as string,
          avatar_url: (publisher.avatar_url as string | null) ?? null,
        }
      : null,
    versions: versions.map((v) => ({
      id: v.id as string,
      version: v.version as string,
      api_version_range: v.api_version_range as string,
      changelog: (v.changelog as string | null) ?? null,
      package_url: (v.package_url as string | null) ?? null,
      package_size_bytes: (v.package_size_bytes as number | null) ?? null,
      created_at: v.created_at as string,
    })),
  });
}
