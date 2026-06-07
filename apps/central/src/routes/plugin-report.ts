import type { RouteContext } from "../routes";
import { authenticate, RATE_PLUGIN_REPORT } from "../middleware";
import { badRequest, notFound, rateLimited } from "../errors";

const VALID_REASONS = new Set([
  "malicious_code",
  "misleading_description",
  "broken_functionality",
  "inappropriate_content",
  "other",
]);

/** Cap on free-text fields stored from user input. 2 KB is plenty for a
 *  paragraph of context without letting a report body carry multi-MB payloads. */
const MAX_EVIDENCE_LENGTH = 2048;

interface ReportBody {
  reason: unknown;
  evidence?: unknown;
}

// --- POST /v1/plugins/:slug/report ---

export async function handlePluginReport(
  request: Request,
  ctx: RouteContext,
  slug: string,
): Promise<Response> {
  const account = await authenticate(request, ctx.sql);
  if (account instanceof Response) return account;

  const { allowed, retryAfter } = ctx.rateLimiter.consume(
    `plugin_report:${account.id}`,
    RATE_PLUGIN_REPORT,
  );
  if (!allowed) return rateLimited(retryAfter);

  let body: ReportBody;
  try {
    body = (await request.json()) as ReportBody;
  } catch {
    return badRequest("Invalid JSON body");
  }

  if (!body.reason || typeof body.reason !== "string") {
    return badRequest("reason is required");
  }
  if (!VALID_REASONS.has(body.reason)) {
    return badRequest(
      "reason must be one of: malicious_code, misleading_description, broken_functionality, inappropriate_content, other",
    );
  }

  if (body.evidence !== undefined && body.evidence !== null && typeof body.evidence !== "string") {
    return badRequest("evidence must be a string");
  }
  if (typeof body.evidence === "string" && body.evidence.length > MAX_EVIDENCE_LENGTH) {
    return badRequest(`evidence must be ${String(MAX_EVIDENCE_LENGTH)} characters or fewer`);
  }

  const evidence =
    typeof body.evidence === "string"
      ? body.evidence.trim() || null
      : null;

  const pluginRows = await ctx.sql`
    SELECT id FROM plugins WHERE slug = ${slug}
    LIMIT 1
  `;
  const plugin = pluginRows[0];
  if (!plugin) return notFound("Plugin not found");

  await ctx.sql`
    INSERT INTO reports (reporter_id, target_type, target_id, target_slug, reason, evidence)
    VALUES (
      ${account.id},
      'plugin',
      ${plugin.id as string},
      ${slug},
      ${body.reason},
      ${evidence}
    )
  `;

  return Response.json({ message: "Report submitted" }, { status: 201 });
}
