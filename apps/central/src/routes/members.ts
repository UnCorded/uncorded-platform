import type { RouteContext } from "../routes";
import { authenticate, type RateLimitConfig } from "../middleware";
import {
  badRequest,
  conflict,
  errorResponse,
  forbidden,
  isUniqueViolation,
  notFound,
  rateLimited,
} from "../errors";
import {
  SERVER_STALE_INTERVAL,
  serverJson,
  type ServerRow,
} from "./servers";
import { MAX_JOINED_SERVERS, MAX_ACTIVE_INVITES_PER_SERVER } from "../membership";

// Membership endpoints: the sidebar source (/v1/me/servers), account-bound
// invitations, join requests, kick/ban, and leave. Liveness is deliberately
// orthogonal to membership everywhere here — a server you belong to stays in
// your list however long its runtime has been offline, so an inactive server
// is always one provisioning click from coming back rather than vanishing.

const RATE_MEMBERSHIP_READ: RateLimitConfig = { maxTokens: 60, refillRate: 1 };
const RATE_INVITE_CREATE: RateLimitConfig = { maxTokens: 10, refillRate: 10 / 60 };
const RATE_MEMBERSHIP_MUTATE: RateLimitConfig = { maxTokens: 20, refillRate: 20 / 60 };

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// --- Helpers ---

interface OwnedServerCheck {
  ok: boolean;
  response?: Response;
  server?: { id: string; owner_id: string; visibility: string; name: string };
}

// Owner-only endpoints share this gate. Non-owners get 404 on private
// servers they aren't an active member of (no existence leak, matching
// GET /:id) and 403 otherwise.
async function requireOwnedServer(
  ctx: RouteContext,
  serverId: string,
  accountId: string,
): Promise<OwnedServerCheck> {
  const rows = await ctx.sql`
    SELECT id, owner_id, visibility, name FROM servers WHERE id = ${serverId}
  `;
  const server = rows[0];
  if (!server) return { ok: false, response: notFound("Server not found") };
  if ((server.owner_id as string) !== accountId) {
    if ((server.visibility as string) === "private") {
      const member = await ctx.sql`
        SELECT 1 FROM server_members
        WHERE server_id = ${serverId} AND account_id = ${accountId}
          AND status = 'active'
      `;
      if (member.length === 0) {
        return { ok: false, response: notFound("Server not found") };
      }
    }
    return { ok: false, response: forbidden("Not the server owner") };
  }
  return {
    ok: true,
    server: {
      id: server.id as string,
      owner_id: server.owner_id as string,
      visibility: server.visibility as string,
      name: server.name as string,
    },
  };
}

// Count of active non-owner memberships — the "joined" side of the quota.
async function joinedCount(
  sql: RouteContext["sql"],
  accountId: string,
): Promise<number> {
  const rows = await sql`
    SELECT count(*)::int AS total FROM server_members
    WHERE account_id = ${accountId} AND status = 'active' AND role = 'member'
  `;
  return rows[0]!.total as number;
}

// --- GET /v1/me/servers ---
//
// The sidebar's source of truth: every server you own or are an active member
// of, regardless of liveness. This is what keeps a long-inactive server
// visible and startable instead of silently dropping out of the client.
export async function handleListMyServers(
  request: Request,
  ctx: RouteContext,
): Promise<Response> {
  const account = await authenticate(request, ctx.sql);
  if (account instanceof Response) return account;

  const { allowed, retryAfter } = ctx.rateLimiter.consume(
    `me-servers:${account.id}`,
    RATE_MEMBERSHIP_READ,
  );
  if (!allowed) return rateLimited(retryAfter);

  const rows = await ctx.sql`
    SELECT s.id, s.name, s.description, s.visibility, s.owner_id, s.tunnel_state,
           s.runtime_version, s.connected_users, s.plugin_count,
           (s.is_online AND s.last_heartbeat_at > now() - ${SERVER_STALE_INTERVAL}::interval) AS is_online,
           s.last_heartbeat_at, s.created_at, s.updated_at,
           m.role, m.joined_at
    FROM server_members m
    JOIN servers s ON s.id = m.server_id
    WHERE m.account_id = ${account.id} AND m.status = 'active'
    ORDER BY m.joined_at ASC, s.name ASC
  `;

  return Response.json({
    servers: rows.map((row) => ({
      ...serverJson(row as unknown as ServerRow),
      role: row.role as string,
      joined_at: row.joined_at as string,
    })),
  });
}

// --- DELETE /v1/me/servers/:id (leave) ---

export async function handleLeaveServer(
  request: Request,
  ctx: RouteContext,
  serverId: string,
): Promise<Response> {
  const account = await authenticate(request, ctx.sql);
  if (account instanceof Response) return account;

  const { allowed, retryAfter } = ctx.rateLimiter.consume(
    `membership-mutate:${account.id}`,
    RATE_MEMBERSHIP_MUTATE,
  );
  if (!allowed) return rateLimited(retryAfter);

  const member = await ctx.sql`
    SELECT role FROM server_members
    WHERE server_id = ${serverId} AND account_id = ${account.id}
      AND status = 'active'
  `;
  if (member.length === 0) return notFound("You are not a member of this server");
  if ((member[0]!.role as string) === "owner") {
    return badRequest("Owners cannot leave their own server — transfer or delete it instead");
  }

  await ctx.sql`
    DELETE FROM server_members
    WHERE server_id = ${serverId} AND account_id = ${account.id}
      AND status = 'active'
  `;
  return new Response(null, { status: 204 });
}

// --- POST /v1/servers/:id/invites ---

export async function handleCreateInvite(
  request: Request,
  ctx: RouteContext,
  serverId: string,
): Promise<Response> {
  const account = await authenticate(request, ctx.sql);
  if (account instanceof Response) return account;

  const { allowed, retryAfter } = ctx.rateLimiter.consume(
    `invite-create:${account.id}`,
    RATE_INVITE_CREATE,
  );
  if (!allowed) return rateLimited(retryAfter);

  const check = await requireOwnedServer(ctx, serverId, account.id);
  if (!check.ok) return check.response!;

  let body: { username: unknown };
  try {
    body = (await request.json()) as { username: unknown };
  } catch {
    return badRequest("Invalid JSON body");
  }
  if (typeof body.username !== "string" || body.username.trim().length === 0) {
    return badRequest("username is required");
  }
  const username = body.username.trim();

  // Exact-match lookup only — no fuzzy search, so an owner can't enumerate
  // the account namespace through this endpoint.
  const targets = await ctx.sql`
    SELECT id FROM accounts WHERE LOWER(username) = LOWER(${username})
  `;
  const target = targets[0];
  if (!target) return notFound("No account with that username");
  const targetId = target.id as string;

  if (targetId === account.id) {
    return badRequest("You already own this server");
  }

  const existingMember = await ctx.sql`
    SELECT status FROM server_members
    WHERE server_id = ${serverId} AND account_id = ${targetId}
  `;
  if (existingMember.length > 0) {
    return (existingMember[0]!.status as string) === "banned"
      ? conflict("This user is banned from the server — unban them first")
      : conflict("This user is already a member");
  }

  // Inline-sweep a freshly-expired pending invite for this pair so the owner
  // doesn't have to wait for the periodic sweep to re-invite.
  await ctx.sql`
    UPDATE server_invitations SET status = 'expired'
    WHERE server_id = ${serverId} AND invited_account_id = ${targetId}
      AND status = 'pending' AND expires_at < now()
  `;

  const pendingCount = await ctx.sql`
    SELECT count(*)::int AS total FROM server_invitations
    WHERE server_id = ${serverId} AND status = 'pending'
  `;
  if ((pendingCount[0]!.total as number) >= MAX_ACTIVE_INVITES_PER_SERVER) {
    return errorResponse(
      403,
      "QUOTA_EXCEEDED",
      `A server can have at most ${MAX_ACTIVE_INVITES_PER_SERVER} pending invites`,
    );
  }

  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
  let inviteId: string;
  try {
    const inserted = await ctx.sql`
      INSERT INTO server_invitations (server_id, invited_account_id, invited_by, expires_at)
      VALUES (${serverId}, ${targetId}, ${account.id}, ${expiresAt})
      RETURNING id
    `;
    inviteId = inserted[0]!.id as string;
  } catch (err: unknown) {
    if (isUniqueViolation(err)) {
      return conflict("An invite is already pending for this user");
    }
    throw err;
  }

  return Response.json(
    { invite_id: inviteId, expires_at: expiresAt.toISOString(), status: "pending" },
    { status: 201 },
  );
}

// --- GET /v1/servers/:id/invites ---

export async function handleListServerInvites(
  request: Request,
  ctx: RouteContext,
  serverId: string,
): Promise<Response> {
  const account = await authenticate(request, ctx.sql);
  if (account instanceof Response) return account;

  const { allowed, retryAfter } = ctx.rateLimiter.consume(
    `me-servers:${account.id}`,
    RATE_MEMBERSHIP_READ,
  );
  if (!allowed) return rateLimited(retryAfter);

  const check = await requireOwnedServer(ctx, serverId, account.id);
  if (!check.ok) return check.response!;

  const rows = await ctx.sql`
    SELECT i.id, i.invited_account_id, a.username, a.display_name,
           i.created_at, i.expires_at
    FROM server_invitations i
    JOIN accounts a ON a.id = i.invited_account_id
    WHERE i.server_id = ${serverId} AND i.status = 'pending'
      AND i.expires_at > now()
    ORDER BY i.created_at DESC
  `;

  return Response.json({
    invites: rows.map((r) => ({
      id: r.id as string,
      invited_account_id: r.invited_account_id as string,
      username: r.username as string,
      display_name: r.display_name as string,
      created_at: r.created_at as string,
      expires_at: r.expires_at as string,
    })),
  });
}

// --- DELETE /v1/servers/:id/invites/:inviteId (revoke) ---

export async function handleRevokeInvite(
  request: Request,
  ctx: RouteContext,
  serverId: string,
  inviteId: string,
): Promise<Response> {
  const account = await authenticate(request, ctx.sql);
  if (account instanceof Response) return account;

  const { allowed, retryAfter } = ctx.rateLimiter.consume(
    `membership-mutate:${account.id}`,
    RATE_MEMBERSHIP_MUTATE,
  );
  if (!allowed) return rateLimited(retryAfter);

  const check = await requireOwnedServer(ctx, serverId, account.id);
  if (!check.ok) return check.response!;

  const updated = await ctx.sql`
    UPDATE server_invitations SET status = 'revoked'
    WHERE id = ${inviteId} AND server_id = ${serverId} AND status = 'pending'
  `;
  if (updated.count === 0) return notFound("No pending invite with that id");
  return new Response(null, { status: 204 });
}

// --- GET /v1/me/invites ---

export async function handleListMyInvites(
  request: Request,
  ctx: RouteContext,
): Promise<Response> {
  const account = await authenticate(request, ctx.sql);
  if (account instanceof Response) return account;

  const { allowed, retryAfter } = ctx.rateLimiter.consume(
    `me-servers:${account.id}`,
    RATE_MEMBERSHIP_READ,
  );
  if (!allowed) return rateLimited(retryAfter);

  const rows = await ctx.sql`
    SELECT i.id, i.server_id, s.name AS server_name, a.username AS invited_by_username,
           i.created_at, i.expires_at
    FROM server_invitations i
    JOIN servers s ON s.id = i.server_id
    JOIN accounts a ON a.id = i.invited_by
    WHERE i.invited_account_id = ${account.id} AND i.status = 'pending'
      AND i.expires_at > now()
    ORDER BY i.created_at DESC
  `;

  return Response.json({
    invites: rows.map((r) => ({
      id: r.id as string,
      server_id: r.server_id as string,
      server_name: r.server_name as string,
      invited_by_username: r.invited_by_username as string,
      created_at: r.created_at as string,
      expires_at: r.expires_at as string,
    })),
  });
}

// --- POST /v1/me/invites/:id/accept ---

export async function handleAcceptInvite(
  request: Request,
  ctx: RouteContext,
  inviteId: string,
): Promise<Response> {
  const account = await authenticate(request, ctx.sql);
  if (account instanceof Response) return account;

  const { allowed, retryAfter } = ctx.rateLimiter.consume(
    `membership-mutate:${account.id}`,
    RATE_MEMBERSHIP_MUTATE,
  );
  if (!allowed) return rateLimited(retryAfter);

  // Scoped to the invitee: anyone else gets 404, never confirmation that the
  // invite (or the private server behind it) exists.
  const rows = await ctx.sql`
    SELECT id, server_id, status, expires_at FROM server_invitations
    WHERE id = ${inviteId} AND invited_account_id = ${account.id}
  `;
  const invite = rows[0];
  if (!invite) return notFound("Invite not found");

  if ((invite.status as string) !== "pending") {
    return errorResponse(410, "INVITE_SETTLED", "Invite is no longer pending");
  }
  if (new Date(invite.expires_at as string) < new Date()) {
    await ctx.sql`
      UPDATE server_invitations SET status = 'expired' WHERE id = ${inviteId}
    `;
    return errorResponse(410, "INVITE_EXPIRED", "Invite has expired");
  }

  const result = await ctx.sql.begin(async (tx) => {
    // Serialize joins per account so concurrent accepts can't both pass the
    // joined-quota count (same pattern as the owned quota in create).
    await tx`SELECT id FROM accounts WHERE id = ${account.id} FOR UPDATE`;

    const banned = await tx`
      SELECT 1 FROM server_members
      WHERE server_id = ${invite.server_id as string} AND account_id = ${account.id}
        AND status = 'banned'
    `;
    if (banned.length > 0) return "banned" as const;

    const joined = await tx`
      SELECT count(*)::int AS total FROM server_members
      WHERE account_id = ${account.id} AND status = 'active' AND role = 'member'
    `;
    if ((joined[0]!.total as number) >= MAX_JOINED_SERVERS) {
      return "quota" as const;
    }

    await tx`
      INSERT INTO server_members (server_id, account_id, role, status)
      VALUES (${invite.server_id as string}, ${account.id}, 'member', 'active')
      ON CONFLICT (server_id, account_id) DO NOTHING
    `;
    await tx`
      UPDATE server_invitations SET status = 'accepted' WHERE id = ${inviteId}
    `;
    return "joined" as const;
  });

  if (result === "banned") return forbidden("You are banned from this server");
  if (result === "quota") {
    return errorResponse(
      403,
      "QUOTA_EXCEEDED",
      `You can join at most ${MAX_JOINED_SERVERS} servers`,
    );
  }
  return Response.json({ server_id: invite.server_id as string, status: "joined" });
}

// --- POST /v1/me/invites/:id/decline ---

export async function handleDeclineInvite(
  request: Request,
  ctx: RouteContext,
  inviteId: string,
): Promise<Response> {
  const account = await authenticate(request, ctx.sql);
  if (account instanceof Response) return account;

  const { allowed, retryAfter } = ctx.rateLimiter.consume(
    `membership-mutate:${account.id}`,
    RATE_MEMBERSHIP_MUTATE,
  );
  if (!allowed) return rateLimited(retryAfter);

  const updated = await ctx.sql`
    UPDATE server_invitations SET status = 'declined'
    WHERE id = ${inviteId} AND invited_account_id = ${account.id}
      AND status = 'pending'
  `;
  if (updated.count === 0) return notFound("Invite not found");
  return new Response(null, { status: 204 });
}

// --- POST /v1/servers/:id/join-requests ---

export async function handleCreateJoinRequest(
  request: Request,
  ctx: RouteContext,
  serverId: string,
): Promise<Response> {
  const account = await authenticate(request, ctx.sql);
  if (account instanceof Response) return account;

  const { allowed, retryAfter } = ctx.rateLimiter.consume(
    `membership-mutate:${account.id}`,
    RATE_MEMBERSHIP_MUTATE,
  );
  if (!allowed) return rateLimited(retryAfter);

  const rows = await ctx.sql`
    SELECT id, owner_id, visibility FROM servers WHERE id = ${serverId}
  `;
  const server = rows[0];
  if (!server) return notFound("Server not found");

  const member = await ctx.sql`
    SELECT status FROM server_members
    WHERE server_id = ${serverId} AND account_id = ${account.id}
  `;
  const memberStatus = member[0]?.status as string | undefined;
  if (memberStatus === "active" || (server.owner_id as string) === account.id) {
    return conflict("You are already a member of this server");
  }

  // Private servers are join-by-invite only and invisible to outsiders.
  if ((server.visibility as string) === "private") {
    return notFound("Server not found");
  }
  if (memberStatus === "banned") {
    return forbidden("You are banned from this server");
  }

  let requestId: string;
  try {
    const inserted = await ctx.sql`
      INSERT INTO server_join_requests (server_id, account_id)
      VALUES (${serverId}, ${account.id})
      RETURNING id
    `;
    requestId = inserted[0]!.id as string;
  } catch (err: unknown) {
    if (isUniqueViolation(err)) {
      return conflict("You already have a pending request for this server");
    }
    throw err;
  }

  return Response.json({ request_id: requestId, status: "pending" }, { status: 201 });
}

// --- GET /v1/servers/:id/join-requests ---

export async function handleListJoinRequests(
  request: Request,
  ctx: RouteContext,
  serverId: string,
): Promise<Response> {
  const account = await authenticate(request, ctx.sql);
  if (account instanceof Response) return account;

  const { allowed, retryAfter } = ctx.rateLimiter.consume(
    `me-servers:${account.id}`,
    RATE_MEMBERSHIP_READ,
  );
  if (!allowed) return rateLimited(retryAfter);

  const check = await requireOwnedServer(ctx, serverId, account.id);
  if (!check.ok) return check.response!;

  const rows = await ctx.sql`
    SELECT r.id, r.account_id, a.username, a.display_name, a.avatar_url, r.created_at
    FROM server_join_requests r
    JOIN accounts a ON a.id = r.account_id
    WHERE r.server_id = ${serverId} AND r.status = 'pending'
    ORDER BY r.created_at ASC
  `;

  return Response.json({
    requests: rows.map((r) => ({
      id: r.id as string,
      account_id: r.account_id as string,
      username: r.username as string,
      display_name: r.display_name as string,
      avatar_url: (r.avatar_url as string | null) ?? null,
      created_at: r.created_at as string,
    })),
  });
}

// --- POST /v1/servers/:id/join-requests/:requestId/accept ---

export async function handleAcceptJoinRequest(
  request: Request,
  ctx: RouteContext,
  serverId: string,
  requestId: string,
): Promise<Response> {
  const account = await authenticate(request, ctx.sql);
  if (account instanceof Response) return account;

  const { allowed, retryAfter } = ctx.rateLimiter.consume(
    `membership-mutate:${account.id}`,
    RATE_MEMBERSHIP_MUTATE,
  );
  if (!allowed) return rateLimited(retryAfter);

  const check = await requireOwnedServer(ctx, serverId, account.id);
  if (!check.ok) return check.response!;

  const rows = await ctx.sql`
    SELECT id, account_id, status FROM server_join_requests
    WHERE id = ${requestId} AND server_id = ${serverId}
  `;
  const joinRequest = rows[0];
  if (!joinRequest) return notFound("Join request not found");
  if ((joinRequest.status as string) !== "pending") {
    return errorResponse(410, "REQUEST_SETTLED", "Request is no longer pending");
  }
  const requesterId = joinRequest.account_id as string;

  const result = await ctx.sql.begin(async (tx) => {
    await tx`SELECT id FROM accounts WHERE id = ${requesterId} FOR UPDATE`;

    const banned = await tx`
      SELECT 1 FROM server_members
      WHERE server_id = ${serverId} AND account_id = ${requesterId}
        AND status = 'banned'
    `;
    if (banned.length > 0) return "banned" as const;

    const joined = await tx`
      SELECT count(*)::int AS total FROM server_members
      WHERE account_id = ${requesterId} AND status = 'active' AND role = 'member'
    `;
    if ((joined[0]!.total as number) >= MAX_JOINED_SERVERS) {
      return "quota" as const;
    }

    await tx`
      INSERT INTO server_members (server_id, account_id, role, status)
      VALUES (${serverId}, ${requesterId}, 'member', 'active')
      ON CONFLICT (server_id, account_id) DO NOTHING
    `;
    await tx`
      UPDATE server_join_requests SET status = 'accepted', resolved_at = now()
      WHERE id = ${requestId}
    `;
    return "joined" as const;
  });

  if (result === "banned") {
    return conflict("This user is banned from the server — unban them first");
  }
  if (result === "quota") {
    return errorResponse(
      403,
      "QUOTA_EXCEEDED",
      `This user has reached the ${MAX_JOINED_SERVERS}-server join limit`,
    );
  }
  return Response.json({ account_id: requesterId, status: "joined" });
}

// --- POST /v1/servers/:id/join-requests/:requestId/decline ---

export async function handleDeclineJoinRequest(
  request: Request,
  ctx: RouteContext,
  serverId: string,
  requestId: string,
): Promise<Response> {
  const account = await authenticate(request, ctx.sql);
  if (account instanceof Response) return account;

  const { allowed, retryAfter } = ctx.rateLimiter.consume(
    `membership-mutate:${account.id}`,
    RATE_MEMBERSHIP_MUTATE,
  );
  if (!allowed) return rateLimited(retryAfter);

  const check = await requireOwnedServer(ctx, serverId, account.id);
  if (!check.ok) return check.response!;

  const updated = await ctx.sql`
    UPDATE server_join_requests SET status = 'declined', resolved_at = now()
    WHERE id = ${requestId} AND server_id = ${serverId} AND status = 'pending'
  `;
  if (updated.count === 0) return notFound("Join request not found");
  return new Response(null, { status: 204 });
}

// --- GET /v1/servers/:id/members ---

export async function handleListMembers(
  request: Request,
  ctx: RouteContext,
  serverId: string,
): Promise<Response> {
  const account = await authenticate(request, ctx.sql);
  if (account instanceof Response) return account;

  const { allowed, retryAfter } = ctx.rateLimiter.consume(
    `me-servers:${account.id}`,
    RATE_MEMBERSHIP_READ,
  );
  if (!allowed) return rateLimited(retryAfter);

  const check = await requireOwnedServer(ctx, serverId, account.id);
  if (!check.ok) return check.response!;

  const rows = await ctx.sql`
    SELECT m.account_id, a.username, a.display_name, a.avatar_url,
           m.role, m.status, m.joined_at
    FROM server_members m
    JOIN accounts a ON a.id = m.account_id
    WHERE m.server_id = ${serverId}
    ORDER BY m.role DESC, m.joined_at ASC
  `;

  return Response.json({
    members: rows.map((r) => ({
      account_id: r.account_id as string,
      username: r.username as string,
      display_name: r.display_name as string,
      avatar_url: (r.avatar_url as string | null) ?? null,
      role: r.role as string,
      status: r.status as string,
      joined_at: r.joined_at as string,
    })),
  });
}

// --- DELETE /v1/servers/:id/members/:accountId (kick) ---

export async function handleKickMember(
  request: Request,
  ctx: RouteContext,
  serverId: string,
  memberAccountId: string,
): Promise<Response> {
  const account = await authenticate(request, ctx.sql);
  if (account instanceof Response) return account;

  const { allowed, retryAfter } = ctx.rateLimiter.consume(
    `membership-mutate:${account.id}`,
    RATE_MEMBERSHIP_MUTATE,
  );
  if (!allowed) return rateLimited(retryAfter);

  const check = await requireOwnedServer(ctx, serverId, account.id);
  if (!check.ok) return check.response!;

  if (memberAccountId === account.id) {
    return badRequest("Owners cannot kick themselves — transfer or delete the server instead");
  }

  const deleted = await ctx.sql`
    DELETE FROM server_members
    WHERE server_id = ${serverId} AND account_id = ${memberAccountId}
      AND status = 'active' AND role = 'member'
  `;
  if (deleted.count === 0) return notFound("Not an active member");
  return new Response(null, { status: 204 });
}

// --- POST /v1/servers/:id/members/:accountId/ban ---

export async function handleBanMember(
  request: Request,
  ctx: RouteContext,
  serverId: string,
  memberAccountId: string,
): Promise<Response> {
  const account = await authenticate(request, ctx.sql);
  if (account instanceof Response) return account;

  const { allowed, retryAfter } = ctx.rateLimiter.consume(
    `membership-mutate:${account.id}`,
    RATE_MEMBERSHIP_MUTATE,
  );
  if (!allowed) return rateLimited(retryAfter);

  const check = await requireOwnedServer(ctx, serverId, account.id);
  if (!check.ok) return check.response!;

  if (memberAccountId === account.id) {
    return badRequest("Owners cannot ban themselves");
  }

  const targets = await ctx.sql`
    SELECT id FROM accounts WHERE id = ${memberAccountId}
  `;
  if (targets.length === 0) return notFound("Account not found");

  // Bans work on non-members too (a pre-emptive ban blocks future join
  // requests), so this is an upsert rather than an update of an existing
  // member row. Pending paperwork from the banned user dies with the ban.
  await ctx.sql.begin(async (tx) => {
    await tx`
      INSERT INTO server_members (server_id, account_id, role, status)
      VALUES (${serverId}, ${memberAccountId}, 'member', 'banned')
      ON CONFLICT (server_id, account_id)
      DO UPDATE SET role = 'member', status = 'banned'
    `;
    await tx`
      UPDATE server_invitations SET status = 'revoked'
      WHERE server_id = ${serverId} AND invited_account_id = ${memberAccountId}
        AND status = 'pending'
    `;
    await tx`
      UPDATE server_join_requests SET status = 'declined', resolved_at = now()
      WHERE server_id = ${serverId} AND account_id = ${memberAccountId}
        AND status = 'pending'
    `;
  });

  return new Response(null, { status: 204 });
}

// --- DELETE /v1/servers/:id/members/:accountId/ban (unban) ---

export async function handleUnbanMember(
  request: Request,
  ctx: RouteContext,
  serverId: string,
  memberAccountId: string,
): Promise<Response> {
  const account = await authenticate(request, ctx.sql);
  if (account instanceof Response) return account;

  const { allowed, retryAfter } = ctx.rateLimiter.consume(
    `membership-mutate:${account.id}`,
    RATE_MEMBERSHIP_MUTATE,
  );
  if (!allowed) return rateLimited(retryAfter);

  const check = await requireOwnedServer(ctx, serverId, account.id);
  if (!check.ok) return check.response!;

  // Unban removes the row entirely — the user is no longer a member and can
  // be re-invited or request to join like anyone else.
  const deleted = await ctx.sql`
    DELETE FROM server_members
    WHERE server_id = ${serverId} AND account_id = ${memberAccountId}
      AND status = 'banned'
  `;
  if (deleted.count === 0) return notFound("This user is not banned");
  return new Response(null, { status: 204 });
}

// Periodic sweep: mark pending invitations whose expiry has passed. Column
// hygiene like sweepStaleServers — reads already filter on expires_at, this
// just keeps stored status from lagging the derived truth. Returns row count.
export async function sweepExpiredInvites(
  sql: RouteContext["sql"],
): Promise<number> {
  const result = await sql`
    UPDATE server_invitations SET status = 'expired'
    WHERE status = 'pending' AND expires_at < now()
  `;
  return result.count;
}
