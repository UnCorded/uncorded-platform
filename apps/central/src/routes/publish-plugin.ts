import type { RouteContext } from "../routes";
import { authenticate, RATE_PLUGIN_PUBLISH } from "../middleware";
import { isAdmin } from "../admin";
import { validateManifest } from "@uncorded/shared";
import { badRequest, forbidden, conflict, errorResponse, isUniqueViolation, rateLimited } from "../errors";
import { isTrustTier, validatePackageUpload } from "../plugin-package";

const SLUG_RE = /^[a-z0-9-]{3,64}$/;

export async function handlePublishPlugin(
  request: Request,
  ctx: RouteContext,
): Promise<Response> {
  const account = await authenticate(request, ctx.sql);
  if (account instanceof Response) return account;

  if (!isAdmin(account.email)) return forbidden("Admin access required");

  // Admin rate limit runs AFTER auth+admin check so unauthenticated requests
  // can't exhaust an admin's bucket by keying on a guessed account id.
  const { allowed, retryAfter } = ctx.rateLimiter.consume(
    `plugin-publish:${account.id}`,
    RATE_PLUGIN_PUBLISH,
  );
  if (!allowed) return rateLimited(retryAfter);

  if (ctx.r2 === null) {
    return errorResponse(503, "R2_UNAVAILABLE", "Object storage is not configured");
  }

  const declaredLength = request.headers.get("content-length");

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return badRequest("Invalid multipart/form-data body");
  }

  const manifestRaw = form.get("manifest");
  const packageFile = form.get("package");
  const description = form.get("description");
  const longDescription = form.get("long_description");
  const category = form.get("category") ?? "general";
  const trustTierRaw = form.get("trust_tier");

  if (typeof manifestRaw !== "string" || manifestRaw.trim().length === 0) {
    return badRequest("manifest field is required");
  }
  if (!(packageFile instanceof Blob)) {
    return badRequest("package field is required");
  }
  if (typeof description !== "string" || description.trim().length === 0) {
    return badRequest("description field is required");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestRaw);
  } catch {
    return badRequest("manifest must be valid JSON");
  }

  const result = validateManifest(parsed);
  if (!result.ok) {
    return Response.json(
      { error: { code: "INVALID_MANIFEST", message: "Manifest validation failed", errors: result.errors } },
      { status: 400 },
    );
  }

  const manifest = result.manifest;
  const slug = manifest.name;
  const version = manifest.version;

  if (!SLUG_RE.test(slug)) {
    return badRequest("manifest.name must match ^[a-z0-9-]{3,64}$");
  }

  // Trust tier defaults to the schema default `community`. An admin can
  // explicitly promote a plugin to `verified` or `official` at publish time;
  // anything else falls back silently to the safe default.
  const trustTier = isTrustTier(trustTierRaw) ? trustTierRaw : "community";

  const packageCheck = await validatePackageUpload(packageFile, declaredLength);
  if (!packageCheck.ok) {
    return errorResponse(400, packageCheck.code, packageCheck.message);
  }

  const key = `plugins/${slug}/${version}/package.zip`;
  await ctx.r2.putObject(key, packageCheck.buffer, "application/zip");

  let pluginId: string;
  try {
    const pluginRows = await ctx.sql`
      INSERT INTO plugins (slug, name, description, long_description, category, trust_tier, publisher_id, latest_version, is_listed)
      VALUES (
        ${slug},
        ${manifest.name},
        ${description.trim()},
        ${typeof longDescription === "string" ? longDescription.trim() || null : null},
        ${typeof category === "string" ? category.trim() || "general" : "general"},
        ${trustTier},
        ${account.id},
        ${version},
        true
      )
      RETURNING id
    `;
    pluginId = (pluginRows[0] as { id: string }).id;

    await ctx.sql`
      INSERT INTO plugin_versions (plugin_id, version, api_version_range, package_url, package_size_bytes, package_sha256)
      VALUES (${pluginId}, ${version}, ${manifest.api_version}, ${key}, ${packageCheck.sizeBytes}, ${packageCheck.sha256})
    `;
  } catch (err) {
    // Best-effort cleanup — don't let this shadow the original error
    ctx.r2.deleteObject(key).catch(() => {});
    // SQLSTATE 23505 = unique_violation. Two concurrent publishes of the same
    // slug both pass an upfront SELECT and then race the INSERT — relying on
    // the unique constraint is the only TOCTOU-free way to detect the conflict.
    if (isUniqueViolation(err)) return conflict(`Plugin slug "${slug}" already exists`);
    throw err;
  }

  const pluginRows = await ctx.sql`
    SELECT id, slug, name, description, long_description, category, trust_tier, latest_version, install_count, created_at, updated_at
    FROM plugins WHERE id = ${pluginId} LIMIT 1
  `;
  const plugin = pluginRows[0] as {
    id: string; slug: string; name: string; description: string;
    long_description: string | null; category: string; trust_tier: string;
    latest_version: string | null; install_count: number;
    created_at: string; updated_at: string;
  };

  return Response.json(
    {
      id: plugin.id,
      slug: plugin.slug,
      name: plugin.name,
      description: plugin.description,
      long_description: plugin.long_description ?? null,
      category: plugin.category,
      trust_tier: plugin.trust_tier,
      latest_version: plugin.latest_version ?? null,
      install_count: plugin.install_count,
      created_at: plugin.created_at,
      updated_at: plugin.updated_at,
    },
    { status: 201 },
  );
}
