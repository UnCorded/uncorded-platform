import type { RouteContext } from "../routes";
import { authenticate, RATE_PLUGIN_PUBLISH } from "../middleware";
import { isAdmin } from "../admin";
import { parseSemver } from "@uncorded/shared";
import { badRequest, forbidden, notFound, conflict, errorResponse, isUniqueViolation, rateLimited } from "../errors";
import { validatePackageUpload } from "../plugin-package";

export async function handlePublishVersion(
  request: Request,
  ctx: RouteContext,
  slug: string,
): Promise<Response> {
  const account = await authenticate(request, ctx.sql);
  if (account instanceof Response) return account;

  if (!isAdmin(account.email)) return forbidden("Admin access required");

  // Share the publish bucket with /v1/plugins so a single admin can't publish
  // 5 new plugins + 5 new versions in the same hour — the slow cadence is the
  // whole point.
  const { allowed, retryAfter } = ctx.rateLimiter.consume(
    `plugin-publish:${account.id}`,
    RATE_PLUGIN_PUBLISH,
  );
  if (!allowed) return rateLimited(retryAfter);

  if (ctx.r2 === null) {
    return errorResponse(503, "R2_UNAVAILABLE", "Object storage is not configured");
  }

  // Look up plugin
  const pluginRows = await ctx.sql`
    SELECT id, latest_version FROM plugins WHERE slug = ${slug} LIMIT 1
  `;
  const plugin = pluginRows[0] as { id: string; latest_version: string | null } | undefined;
  if (!plugin) return notFound("Plugin not found");

  const declaredLength = request.headers.get("content-length");

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return badRequest("Invalid multipart/form-data body");
  }

  const versionRaw = form.get("version");
  const apiVersionRange = form.get("api_version_range");
  const changelog = form.get("changelog");
  const packageFile = form.get("package");

  if (typeof versionRaw !== "string" || versionRaw.trim().length === 0) {
    return badRequest("version field is required");
  }
  if (typeof apiVersionRange !== "string" || apiVersionRange.trim().length === 0) {
    return badRequest("api_version_range field is required");
  }
  if (!(packageFile instanceof Blob)) {
    return badRequest("package field is required");
  }

  const version = versionRaw.trim();
  if (!parseSemver(version)) {
    return badRequest("version must be a valid semver string (MAJOR.MINOR.PATCH)");
  }

  const packageCheck = await validatePackageUpload(packageFile, declaredLength);
  if (!packageCheck.ok) {
    return errorResponse(400, packageCheck.code, packageCheck.message);
  }

  const key = `plugins/${slug}/${version}/package.zip`;
  await ctx.r2.putObject(key, packageCheck.buffer, "application/zip");

  let versionId: string;
  try {
    const versionRows = await ctx.sql`
      INSERT INTO plugin_versions (plugin_id, version, api_version_range, changelog, package_url, package_size_bytes, package_sha256)
      VALUES (
        ${plugin.id},
        ${version},
        ${apiVersionRange.trim()},
        ${typeof changelog === "string" ? changelog.trim() || null : null},
        ${key},
        ${packageCheck.sizeBytes},
        ${packageCheck.sha256}
      )
      RETURNING id, version, api_version_range, changelog, package_url, package_size_bytes, created_at
    `;
    versionId = (versionRows[0] as { id: string }).id;

    // Update latest_version if this version is newer
    const currentLatest = plugin.latest_version ? parseSemver(plugin.latest_version) : null;
    const newParsed = parseSemver(version)!;
    const isNewer =
      !currentLatest ||
      newParsed.major > currentLatest.major ||
      (newParsed.major === currentLatest.major && newParsed.minor > currentLatest.minor) ||
      (newParsed.major === currentLatest.major &&
        newParsed.minor === currentLatest.minor &&
        newParsed.patch > currentLatest.patch);

    if (isNewer) {
      await ctx.sql`
        UPDATE plugins SET latest_version = ${version}, updated_at = now() WHERE id = ${plugin.id}
      `;
    }
  } catch (err) {
    ctx.r2.deleteObject(key).catch(() => {});
    // SQLSTATE 23505 = unique_violation on (plugin_id, version). Race-safe
    // detection via the constraint instead of a TOCTOU SELECT-then-INSERT.
    if (isUniqueViolation(err)) return conflict(`Version ${version} already exists for this plugin`);
    throw err;
  }

  const versionRows = await ctx.sql`
    SELECT id, version, api_version_range, changelog, package_url, package_size_bytes, created_at
    FROM plugin_versions WHERE id = ${versionId} LIMIT 1
  `;
  const v = versionRows[0] as {
    id: string; version: string; api_version_range: string;
    changelog: string | null; package_url: string | null;
    package_size_bytes: number | null; created_at: string;
  };

  return Response.json(
    {
      id: v.id,
      version: v.version,
      api_version_range: v.api_version_range,
      changelog: v.changelog ?? null,
      package_url: v.package_url ?? null,
      package_size_bytes: v.package_size_bytes ?? null,
      created_at: v.created_at,
    },
    { status: 201 },
  );
}
