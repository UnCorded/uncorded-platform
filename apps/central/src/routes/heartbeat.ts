import { timingSafeEqual } from "node:crypto";
import type { RouteContext } from "../routes";
import { RATE_HEARTBEAT, getClientIp } from "../middleware";
import {
  badRequest,
  unauthorized,
  notFound,
  rateLimited,
} from "../errors";
import { hashToken, getPublicKeys } from "../crypto";

interface HeartbeatBody {
  server_secret: unknown;
  last_sync_version: unknown;
  tunnel_url: unknown;
  runtime_version: unknown;
  connected_users: unknown;
  plugin_count: unknown;
}

export async function handleHeartbeat(
  request: Request,
  ctx: RouteContext,
  serverId: string,
): Promise<Response> {
  // Rate limit keyed on server ID from URL path (servers don't have sessions)
  const { allowed, retryAfter } = ctx.rateLimiter.consume(
    `heartbeat:${serverId}`,
    RATE_HEARTBEAT,
  );
  if (!allowed) return rateLimited(retryAfter);

  let body: HeartbeatBody;
  try {
    body = (await request.json()) as HeartbeatBody;
  } catch {
    return badRequest("Invalid JSON body");
  }

  if (
    typeof body.server_secret !== "string" ||
    body.server_secret.length === 0
  ) {
    return badRequest("server_secret is required");
  }

  if (
    body.last_sync_version !== undefined &&
    typeof body.last_sync_version !== "number"
  ) {
    return badRequest("last_sync_version must be a number");
  }
  const lastSyncVersion =
    typeof body.last_sync_version === "number" ? body.last_sync_version : 0;

  // Look up server
  const serverRows = await ctx.sql`
    SELECT id, server_secret_hash FROM servers WHERE id = ${serverId}
  `;
  const server = serverRows[0];
  if (!server) return notFound("Server not found");

  // Verify server secret using constant-time comparison to prevent timing attacks
  const providedHash = await hashToken(body.server_secret);
  const a = Buffer.from(providedHash);
  const b = Buffer.from(server.server_secret_hash as string);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return unauthorized("Invalid server secret");
  }

  // Update server fields
  const tunnelUrl =
    typeof body.tunnel_url === "string" ? body.tunnel_url : null;
  const runtimeVersion =
    typeof body.runtime_version === "string" ? body.runtime_version : null;
  const connectedUsers =
    typeof body.connected_users === "number" ? body.connected_users : 0;
  const pluginCount =
    typeof body.plugin_count === "number" ? body.plugin_count : 0;

  // Capture the cf-connecting-ip / x-forwarded-for tail. Used as the probe
  // target for voice external-reachability (spec-24 Amendment A2). We write
  // it on the liveness UPDATE — it's expected to be stable across most
  // heartbeats, but writing every time avoids a separate read-then-update
  // dance and the column is small (one TEXT) so MVCC churn is acceptable.
  const wanIp = getClientIp(request);

  // Split into two UPDATEs:
  //   1. Always bump liveness — last_heartbeat_at and is_online change every
  //      heartbeat by definition.
  //   2. Only write state columns + updated_at when something meaningful
  //      changed. `updated_at` is "last state change", not "last ping", so
  //      it must not advance on every 30s poll (otherwise cache-busting
  //      consumers of updated_at churn needlessly and row MVCC bloat adds up
  //      across ~2880 heartbeats/day/server).
  await ctx.sql`
    UPDATE servers SET
      is_online = true,
      last_heartbeat_at = now(),
      last_heartbeat_ip = ${wanIp === "unknown" ? null : wanIp}
    WHERE id = ${serverId}
  `;

  await ctx.sql`
    UPDATE servers SET
      tunnel_url = ${tunnelUrl},
      runtime_version = ${runtimeVersion},
      connected_users = ${connectedUsers},
      plugin_count = ${pluginCount},
      updated_at = now()
    WHERE id = ${serverId}
      AND (
        tunnel_url IS DISTINCT FROM ${tunnelUrl}
        OR runtime_version IS DISTINCT FROM ${runtimeVersion}
        OR connected_users IS DISTINCT FROM ${connectedUsers}
        OR plugin_count IS DISTINCT FROM ${pluginCount}
      )
  `;

  // Check dirty flag
  const syncRows = await ctx.sql`
    SELECT sync_version FROM server_sync WHERE server_id = ${serverId}
  `;
  const currentSyncVersion = (syncRows[0]?.sync_version as number) ?? 0;

  // The runtime echoes wan_ip back to its reachability state machine so it
  // can detect WAN-IP changes (laptop-to-new-network, ISP lease renewal,
  // VPS migration) and re-probe voice without a container restart. Never
  // include "unknown" — the runtime treats undefined as "not learned yet".
  const wanIpEcho = wanIp === "unknown" ? undefined : wanIp;

  // A last_sync_version of 0 means the runtime is bootstrapping — it has no
  // cached public keys yet. Always fall through to the dirty response so the
  // runtime receives the current keys (even if no deltas exist). Otherwise
  // the runtime would get dirty=false, find its key cache empty, and fail
  // boot with "Central returned OK but no public keys".
  if (lastSyncVersion > 0 && currentSyncVersion <= lastSyncVersion) {
    return Response.json({
      dirty: false,
      ...(wanIpEcho !== undefined ? { wan_ip: wanIpEcho } : {}),
    });
  }

  // Dirty — fetch deltas and public keys
  const deltas = await ctx.sql`
    SELECT delta_type, payload, sync_version, created_at
    FROM server_deltas
    WHERE server_id = ${serverId}
      AND sync_version > ${lastSyncVersion}
      AND created_at > now() - interval '24 hours'
    ORDER BY sync_version ASC
  `;

  const publicKeys = await getPublicKeys(ctx.sql);

  // Empty deltas response. Two distinct cases:
  //   - Gap + no deltas: runtime fell too far behind (deltas expired > 24h),
  //     must force-disconnect all users for re-auth → full_snapshot: true.
  //   - No gap (lastSync === currentSync): bootstrap or quiet steady state,
  //     just deliver keys with empty deltas. Never set full_snapshot, or
  //     every heartbeat will kick every user.
  if (deltas.length === 0) {
    const hasGap = currentSyncVersion > lastSyncVersion;
    return Response.json({
      dirty: true,
      sync_version: currentSyncVersion,
      public_keys: publicKeys.map((k) => ({ id: k.id, public_key: k.publicKey })),
      deltas: [],
      ...(hasGap ? { full_snapshot: true } : {}),
      ...(wanIpEcho !== undefined ? { wan_ip: wanIpEcho } : {}),
    });
  }

  return Response.json({
    dirty: true,
    sync_version: currentSyncVersion,
    public_keys: publicKeys.map((k) => ({ id: k.id, public_key: k.publicKey })),
    ...(wanIpEcho !== undefined ? { wan_ip: wanIpEcho } : {}),
    deltas: deltas.map((d) => {
      // postgres.js returns jsonb columns as JSON strings, not parsed objects
      // (the driver leaves the cast to the caller). Fall back to a passthrough
      // if a future driver hands us an object directly.
      let payload: Record<string, unknown> = {};
      if (typeof d.payload === "string") {
        try {
          const parsed = JSON.parse(d.payload);
          if (parsed !== null && typeof parsed === "object") {
            payload = parsed as Record<string, unknown>;
          }
        } catch {
          // Malformed payload should never happen — schema accepts only valid
          // jsonb. If it does, drop the body and keep at least the type so the
          // runtime can log/skip it without us masking a write-side bug.
        }
      } else if (d.payload !== null && typeof d.payload === "object") {
        payload = d.payload as Record<string, unknown>;
      }
      return {
        type: d.delta_type as string,
        ...payload,
      };
    }),
  });
}
