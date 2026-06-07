import type { RouteContext } from "../routes";
import { RATE_ADMIN_OP, authenticate } from "../middleware";
import { badRequest, forbidden, notFound, rateLimited } from "../errors";
import { isAdmin } from "../admin";

const VALID_STATUSES = new Set(["pending", "reviewed", "actioned", "dismissed"]);
const VALID_TYPES = new Set(["plugin", "server"]);

/** Cap on reviewer_notes free-text field. Matches the MAX_EVIDENCE_LENGTH
 *  used on the user-facing report submission for consistency. */
const MAX_REVIEWER_NOTES_LENGTH = 2048;

// --- GET /v1/reports ---

export async function handleListReports(
  request: Request,
  ctx: RouteContext,
): Promise<Response> {
  const account = await authenticate(request, ctx.sql);
  if (account instanceof Response) return account;

  if (!isAdmin(account.email)) return forbidden("Admin access required");

  const { allowed, retryAfter } = ctx.rateLimiter.consume(
    `admin-op:${account.id}`,
    RATE_ADMIN_OP,
  );
  if (!allowed) return rateLimited(retryAfter);

  const url = new URL(request.url);
  const status = url.searchParams.get("status") ?? "pending";
  const type = url.searchParams.get("type") ?? "all";
  const limitRaw = Number(url.searchParams.get("limit") ?? "50");
  const offsetRaw = Number(url.searchParams.get("offset") ?? "0");

  if (status !== "all" && !VALID_STATUSES.has(status)) {
    return badRequest("status must be pending, reviewed, actioned, dismissed, or all");
  }
  if (type !== "all" && !VALID_TYPES.has(type)) {
    return badRequest("type must be plugin, server, or all");
  }
  if (!Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > 100) {
    return badRequest("limit must be an integer between 1 and 100");
  }
  if (!Number.isInteger(offsetRaw) || offsetRaw < 0) {
    return badRequest("offset must be a non-negative integer");
  }

  const limit = limitRaw;
  const offset = offsetRaw;

  const statusFragment = status !== "all" ? ctx.sql`AND r.status = ${status}` : ctx.sql``;
  const typeFragment = type !== "all" ? ctx.sql`AND r.target_type = ${type}` : ctx.sql``;

  const rows = await ctx.sql`
    SELECT
      r.id,
      r.target_type,
      r.target_slug,
      r.reason,
      r.evidence,
      r.status,
      r.created_at,
      a.id AS reporter_id,
      a.display_name AS reporter_display_name
    FROM reports r
    JOIN accounts a ON a.id = r.reporter_id
    WHERE 1=1
      ${statusFragment}
      ${typeFragment}
    ORDER BY r.created_at ASC
    LIMIT ${limit} OFFSET ${offset}
  `;

  const countRows = await ctx.sql`
    SELECT COUNT(*)::int AS total
    FROM reports r
    WHERE 1=1
      ${statusFragment}
      ${typeFragment}
  `;

  const total = (countRows[0]?.total as number | undefined) ?? 0;

  return Response.json({
    reports: rows.map((row) => ({
      id: row.id as string,
      target_type: row.target_type as string,
      target_slug: (row.target_slug as string | null) ?? null,
      reason: row.reason as string,
      evidence: (row.evidence as string | null) ?? null,
      status: row.status as string,
      reporter: {
        id: row.reporter_id as string,
        display_name: row.reporter_display_name as string,
      },
      created_at: row.created_at as string,
    })),
    total,
  });
}

// --- PATCH /v1/reports/:id ---

interface ResolveBody {
  status: unknown;
  reviewer_notes?: unknown;
}

export async function handleResolveReport(
  request: Request,
  ctx: RouteContext,
  reportId: string,
): Promise<Response> {
  const account = await authenticate(request, ctx.sql);
  if (account instanceof Response) return account;

  if (!isAdmin(account.email)) return forbidden("Admin access required");

  // Shares the admin-op bucket with GET /v1/reports on purpose — an admin
  // pager paging through the queue and an admin-triage session resolving
  // cases should count against the same budget so a stolen token can't
  // exfil+resolve in parallel at double the rate.
  const { allowed, retryAfter } = ctx.rateLimiter.consume(
    `admin-op:${account.id}`,
    RATE_ADMIN_OP,
  );
  if (!allowed) return rateLimited(retryAfter);

  let body: ResolveBody;
  try {
    body = (await request.json()) as ResolveBody;
  } catch {
    return badRequest("Invalid JSON body");
  }

  if (!body.status || typeof body.status !== "string") {
    return badRequest("status is required");
  }
  if (body.status === "pending") {
    return badRequest("status cannot be set back to pending");
  }
  if (!VALID_STATUSES.has(body.status) || body.status === "pending") {
    return badRequest("status must be reviewed, actioned, or dismissed");
  }

  if (body.reviewer_notes !== undefined && body.reviewer_notes !== null && typeof body.reviewer_notes !== "string") {
    return badRequest("reviewer_notes must be a string");
  }
  if (typeof body.reviewer_notes === "string" && body.reviewer_notes.length > MAX_REVIEWER_NOTES_LENGTH) {
    return badRequest(`reviewer_notes must be ${String(MAX_REVIEWER_NOTES_LENGTH)} characters or fewer`);
  }

  const reviewerNotes =
    typeof body.reviewer_notes === "string"
      ? body.reviewer_notes.trim() || null
      : null;

  const existing = await ctx.sql`
    SELECT id FROM reports WHERE id = ${reportId}
    LIMIT 1
  `;
  if (!existing[0]) return notFound("Report not found");

  const updated = await ctx.sql`
    UPDATE reports
    SET
      status = ${body.status},
      reviewer_id = ${account.id},
      reviewer_notes = ${reviewerNotes},
      reviewed_at = now(),
      updated_at = now()
    WHERE id = ${reportId}
    RETURNING
      id, target_type, target_slug, reason, evidence, status,
      reviewer_id, reviewer_notes, reviewed_at, created_at, updated_at
  `;

  return Response.json(updated[0]);
}
