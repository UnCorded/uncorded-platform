import type { RouteContext } from "../routes";
import { authenticate, RATE_DIRECTORY_BROWSE, type RateLimitConfig } from "../middleware";
import { badRequest, forbidden, notFound, rateLimited } from "../errors";
import { generateServerSecret, hashToken } from "../crypto";

const RATE_SERVER_CREATE: RateLimitConfig = { maxTokens: 10, refillRate: 10 / 60 };
const RATE_SERVER_GET: RateLimitConfig = { maxTokens: 60, refillRate: 1 };
const RATE_SERVER_UPDATE: RateLimitConfig = { maxTokens: 20, refillRate: 20 / 60 };
const RATE_SERVER_DELETE: RateLimitConfig = { maxTokens: 10, refillRate: 10 / 60 };

// Liveness window. A server counts as online only if it heartbeat within this
// interval. Central never sets is_online=false on a missed heartbeat (nothing
// pushes; heartbeats stop silently), so the truthful online flag is *derived*
// from last_heartbeat_at at read time — correct even if the background sweeper
// is dead. 30 min = 60 missed 30s heartbeats: long enough to ride out a
// container/desktop restart or a brief network blip, short enough that dead
// servers drop from the directory fast (a stale listing erodes trust). This is
// the single source — the directory filter, the derived flag, and
// sweepStaleServers all reference it so they can't drift apart. Passed as a
// parameter cast to interval (`${SERVER_STALE_INTERVAL}::interval`).
const SERVER_STALE_INTERVAL = "30 minutes";

// --- Helpers ---

interface ServerRow {
  id: string;
  name: string;
  description: string | null;
  visibility: string;
  owner_id: string;
  tunnel_url: string | null;
  tunnel_state: string | null;
  runtime_version: string | null;
  connected_users: number;
  plugin_count: number;
  is_online: boolean;
  last_heartbeat_at: string | null;
  created_at: string;
  updated_at: string;
}

function serverJson(row: ServerRow) {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    visibility: row.visibility,
    owner_id: row.owner_id,
    tunnel_url: row.tunnel_url ?? null,
    tunnel_state: row.tunnel_state ?? null,
    runtime_version: row.runtime_version ?? null,
    connected_users: row.connected_users,
    plugin_count: row.plugin_count,
    is_online: row.is_online,
    last_heartbeat_at: row.last_heartbeat_at ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// Sweep servers that have gone quiet past the liveness window, flipping their
// stored is_online flag to false. This is column hygiene only — the directory
// and serverJson derive online-ness from last_heartbeat_at directly, so they're
// already correct without this. Runs on a short cadence (see index.ts) so the
// stored column doesn't lag far behind the derived truth. Returns the row count.
export async function sweepStaleServers(
  sql: RouteContext["sql"],
): Promise<number> {
  const result = await sql`
    UPDATE servers SET is_online = false
    WHERE is_online = true
      AND last_heartbeat_at < now() - ${SERVER_STALE_INTERVAL}::interval
  `;
  return result.count;
}

// --- POST /v1/servers ---

interface CreateBody {
  name: unknown;
  description: unknown;
  visibility: unknown;
}

export async function handleCreateServer(
  request: Request,
  ctx: RouteContext,
): Promise<Response> {
  const account = await authenticate(request, ctx.sql);
  if (account instanceof Response) return account;

  const { allowed: createAllowed, retryAfter: createRetryAfter } =
    ctx.rateLimiter.consume(`server-create:${account.id}`, RATE_SERVER_CREATE);
  if (!createAllowed) return rateLimited(createRetryAfter);

  let body: CreateBody;
  try {
    body = (await request.json()) as CreateBody;
  } catch {
    return badRequest("Invalid JSON body");
  }

  if (typeof body.name !== "string" || body.name.trim().length === 0) {
    return badRequest("Server name is required");
  }
  const name = body.name.trim();
  if (name.length > 100) {
    return badRequest("Server name must be 100 characters or fewer");
  }

  if (
    body.description !== undefined &&
    body.description !== null &&
    typeof body.description !== "string"
  ) {
    return badRequest("Description must be a string");
  }
  const description =
    typeof body.description === "string" ? body.description.trim() : null;
  if (description && description.length > 1000) {
    return badRequest("Description must be 1000 characters or fewer");
  }

  const visibility =
    body.visibility === undefined ? "private" : body.visibility;
  if (visibility !== "public" && visibility !== "private") {
    return badRequest('Visibility must be "public" or "private"');
  }

  const secret = generateServerSecret();
  const secretHash = await hashToken(secret);

  const rows = await ctx.sql.begin(async (tx) => {
    const inserted = await tx`
      INSERT INTO servers (name, description, visibility, owner_id, server_secret_hash)
      VALUES (${name}, ${description}, ${visibility}, ${account.id}, ${secretHash})
      RETURNING id
    `;
    const serverId = inserted[0]!.id as string;

    await tx`
      INSERT INTO server_sync (server_id, sync_version)
      VALUES (${serverId}, 1)
    `;

    return inserted;
  });

  return new Response(
    JSON.stringify({
      server_id: rows[0]!.id as string,
      server_secret: secret,
    }),
    { status: 201, headers: { "Content-Type": "application/json" } },
  );
}

// --- GET /v1/servers ---

export async function handleListServers(
  request: Request,
  ctx: RouteContext,
): Promise<Response> {
  const account = await authenticate(request, ctx.sql);
  if (account instanceof Response) return account;

  const { allowed, retryAfter } = ctx.rateLimiter.consume(
    `directory:${account.id}`,
    RATE_DIRECTORY_BROWSE,
  );
  if (!allowed) return rateLimited(retryAfter);

  const url = new URL(request.url);
  const search = url.searchParams.get("search") ?? "";
  const page = Math.max(1, Number(url.searchParams.get("page") ?? "1"));
  const perPage = Math.min(
    100,
    Math.max(1, Number(url.searchParams.get("per_page") ?? "20")),
  );
  const offset = (page - 1) * perPage;

  let servers;
  let countResult;

  // Directory hygiene: only list servers that are actually reachable right now.
  //   - is_online = true AND last_heartbeat_at within the liveness window —
  //     a server that heartbeat once then died must not linger as "available".
  //   - tunnel_url IS NOT NULL — a registered-but-never-tunneled server has no
  //     endpoint to join.
  //   - tunnel_state <> 'expired' — a demo tunnel past its 24h TTL was killed;
  //     don't advertise the dead public URL.
  // is_online is also re-derived in the SELECT so the returned flag is truthful
  // even in the (impossible-here, but cheap) case the filter and column diverge.
  if (search) {
    const pattern = `%${search}%`;
    servers = await ctx.sql`
      SELECT id, name, description, visibility, owner_id, tunnel_url, tunnel_state,
             runtime_version, connected_users, plugin_count,
             (is_online AND last_heartbeat_at > now() - ${SERVER_STALE_INTERVAL}::interval) AS is_online,
             last_heartbeat_at, created_at, updated_at
      FROM servers
      WHERE visibility = 'public' AND is_online = true
        AND last_heartbeat_at > now() - ${SERVER_STALE_INTERVAL}::interval
        AND tunnel_url IS NOT NULL
        AND tunnel_state IS DISTINCT FROM 'expired'
        AND name ILIKE ${pattern}
      ORDER BY connected_users DESC, name ASC
      LIMIT ${perPage} OFFSET ${offset}
    `;
    countResult = await ctx.sql`
      SELECT count(*)::int AS total FROM servers
      WHERE visibility = 'public' AND is_online = true
        AND last_heartbeat_at > now() - ${SERVER_STALE_INTERVAL}::interval
        AND tunnel_url IS NOT NULL
        AND tunnel_state IS DISTINCT FROM 'expired'
        AND name ILIKE ${pattern}
    `;
  } else {
    servers = await ctx.sql`
      SELECT id, name, description, visibility, owner_id, tunnel_url, tunnel_state,
             runtime_version, connected_users, plugin_count,
             (is_online AND last_heartbeat_at > now() - ${SERVER_STALE_INTERVAL}::interval) AS is_online,
             last_heartbeat_at, created_at, updated_at
      FROM servers
      WHERE visibility = 'public' AND is_online = true
        AND last_heartbeat_at > now() - ${SERVER_STALE_INTERVAL}::interval
        AND tunnel_url IS NOT NULL
        AND tunnel_state IS DISTINCT FROM 'expired'
      ORDER BY connected_users DESC, name ASC
      LIMIT ${perPage} OFFSET ${offset}
    `;
    countResult = await ctx.sql`
      SELECT count(*)::int AS total FROM servers
      WHERE visibility = 'public' AND is_online = true
        AND last_heartbeat_at > now() - ${SERVER_STALE_INTERVAL}::interval
        AND tunnel_url IS NOT NULL
        AND tunnel_state IS DISTINCT FROM 'expired'
    `;
  }

  return Response.json({
    servers: servers.map((row) => serverJson(row as unknown as ServerRow)),
    total: countResult[0]!.total as number,
    page,
    per_page: perPage,
  });
}

// --- GET /v1/servers/:id ---

export async function handleGetServer(
  request: Request,
  ctx: RouteContext,
  serverId: string,
): Promise<Response> {
  const account = await authenticate(request, ctx.sql);
  if (account instanceof Response) return account;

  const { allowed: getAllowed, retryAfter: getRetryAfter } =
    ctx.rateLimiter.consume(`server-get:${account.id}`, RATE_SERVER_GET);
  if (!getAllowed) return rateLimited(getRetryAfter);

  // Owner/detail view is NOT filtered out when stale — the owner still needs to
  // find their server to manage it — but its is_online reads truthfully (false
  // once heartbeats stop past the liveness window), derived the same way as the
  // directory so a stale server can't show a green dot.
  const rows = await ctx.sql`
    SELECT id, name, description, visibility, owner_id, tunnel_url, tunnel_state,
           runtime_version, connected_users, plugin_count,
           (is_online AND last_heartbeat_at > now() - ${SERVER_STALE_INTERVAL}::interval) AS is_online,
           last_heartbeat_at, created_at, updated_at
    FROM servers WHERE id = ${serverId}
  `;

  const row = rows[0];
  if (!row) return notFound("Server not found");

  return Response.json(serverJson(row as unknown as ServerRow));
}

// --- PATCH /v1/servers/:id ---

interface PatchBody {
  name: unknown;
  description: unknown;
  visibility: unknown;
}

export async function handleUpdateServer(
  request: Request,
  ctx: RouteContext,
  serverId: string,
): Promise<Response> {
  const account = await authenticate(request, ctx.sql);
  if (account instanceof Response) return account;

  const { allowed: updateAllowed, retryAfter: updateRetryAfter } =
    ctx.rateLimiter.consume(`server-update:${account.id}`, RATE_SERVER_UPDATE);
  if (!updateAllowed) return rateLimited(updateRetryAfter);

  const existing = await ctx.sql`
    SELECT id, owner_id FROM servers WHERE id = ${serverId}
  `;
  if (existing.length === 0) return notFound("Server not found");
  if (existing[0]!.owner_id !== account.id) return forbidden("Not the server owner");

  let body: PatchBody;
  try {
    body = (await request.json()) as PatchBody;
  } catch {
    return badRequest("Invalid JSON body");
  }

  const updates: Record<string, string | null> = {};

  if (body.name !== undefined) {
    if (typeof body.name !== "string" || body.name.trim().length === 0) {
      return badRequest("Server name cannot be empty");
    }
    if (body.name.trim().length > 100) {
      return badRequest("Server name must be 100 characters or fewer");
    }
    updates["name"] = body.name.trim();
  }

  if (body.description !== undefined) {
    if (body.description !== null && typeof body.description !== "string") {
      return badRequest("Description must be a string or null");
    }
    const trimmedDescription = typeof body.description === "string" ? body.description.trim() : null;
    if (trimmedDescription && trimmedDescription.length > 1000) {
      return badRequest("Description must be 1000 characters or fewer");
    }
    updates["description"] = trimmedDescription;
  }

  if (body.visibility !== undefined) {
    if (body.visibility !== "public" && body.visibility !== "private") {
      return badRequest('Visibility must be "public" or "private"');
    }
    updates["visibility"] = body.visibility as string;
  }

  if (Object.keys(updates).length === 0) {
    return badRequest("No fields to update");
  }

  // Build the update — use current values for unchanged fields
  const name = updates["name"] ?? undefined;
  const description =
    "description" in updates ? updates["description"] : undefined;
  const visibility = updates["visibility"] ?? undefined;

  const rows = await ctx.sql`
    UPDATE servers SET
      name = COALESCE(${name ?? null}, name),
      description = ${description !== undefined ? description : ctx.sql`description`},
      visibility = COALESCE(${visibility ?? null}, visibility),
      updated_at = now()
    WHERE id = ${serverId}
    RETURNING id, name, description, visibility, owner_id, tunnel_url, tunnel_state,
              runtime_version, connected_users, plugin_count,
              (is_online AND last_heartbeat_at > now() - ${SERVER_STALE_INTERVAL}::interval) AS is_online,
              last_heartbeat_at, created_at, updated_at
  `;

  return Response.json(serverJson(rows[0] as unknown as ServerRow));
}

// --- DELETE /v1/servers/:id ---

export async function handleDeleteServer(
  request: Request,
  ctx: RouteContext,
  serverId: string,
): Promise<Response> {
  const account = await authenticate(request, ctx.sql);
  if (account instanceof Response) return account;

  const { allowed: deleteAllowed, retryAfter: deleteRetryAfter } =
    ctx.rateLimiter.consume(`server-delete:${account.id}`, RATE_SERVER_DELETE);
  if (!deleteAllowed) return rateLimited(deleteRetryAfter);

  const existing = await ctx.sql`
    SELECT id, owner_id FROM servers WHERE id = ${serverId}
  `;
  if (existing.length === 0) return notFound("Server not found");
  if (existing[0]!.owner_id !== account.id) return forbidden("Not the server owner");

  await ctx.sql`DELETE FROM servers WHERE id = ${serverId}`;

  return new Response(null, { status: 204 });
}
