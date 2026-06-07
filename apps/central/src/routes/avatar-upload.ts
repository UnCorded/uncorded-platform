import type { RouteContext } from "../routes";
import { RATE_AVATAR_UPLOAD, authenticate } from "../middleware";
import { badRequest, errorResponse, rateLimited } from "../errors";

const ALLOWED_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

/** R2 enforces this via the presigned POST policy. A typical avatar is well
 *  under 1 MB; 5 MB leaves headroom for full-quality PNG crops without giving
 *  a leaked URL holder room to dump multi-GB blobs into the bucket. */
const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
const PRESIGN_EXPIRES_SECONDS = 300;

export async function handleAvatarUploadUrl(
  request: Request,
  ctx: RouteContext,
): Promise<Response> {
  const account = await authenticate(request, ctx.sql);
  if (account instanceof Response) return account;

  const { allowed, retryAfter } = ctx.rateLimiter.consume(
    `avatar-upload:${account.id}`,
    RATE_AVATAR_UPLOAD,
  );
  if (!allowed) return rateLimited(retryAfter);

  if (ctx.r2 === null) {
    return errorResponse(503, "R2_UNAVAILABLE", "Object storage is not configured");
  }

  let body: { content_type?: unknown };
  try {
    body = (await request.json()) as { content_type?: unknown };
  } catch {
    return badRequest("Invalid JSON body");
  }

  const contentType = body.content_type;
  if (typeof contentType !== "string" || !ALLOWED_CONTENT_TYPES.has(contentType)) {
    return errorResponse(
      400,
      "INVALID_CONTENT_TYPE",
      "content_type must be one of: image/jpeg, image/png, image/webp, image/gif",
    );
  }

  const key = `avatars/${account.id}`;
  const { url, fields } = await ctx.r2.presignedPost(
    key,
    contentType,
    MAX_AVATAR_BYTES,
    PRESIGN_EXPIRES_SECONDS,
  );
  const finalUrl = ctx.r2.publicUrl(key);

  return Response.json({
    upload_url: url,
    upload_fields: fields,
    final_url: finalUrl,
    expires_in: PRESIGN_EXPIRES_SECONDS,
    max_bytes: MAX_AVATAR_BYTES,
  });
}
