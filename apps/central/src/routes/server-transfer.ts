import type { RouteContext } from "../routes";
import {
  authenticate,
  getClientIp,
  RATE_SERVER_TRANSFER_INITIATE,
  RATE_SERVER_TRANSFER_CONFIRM,
} from "../middleware";
import {
  badRequest,
  conflict,
  errorResponse,
  forbidden,
  internalError,
  notFound,
  rateLimited,
} from "../errors";
import { generateSessionToken, hashToken } from "../crypto";
import {
  sendTransferInitiatedToOwner,
  sendTransferInitiatedToRecipient,
} from "../email";

const TRANSFER_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface InitiateBody {
  target_account_id: unknown;
}

interface ConfirmBody {
  token: unknown;
}

function transferLink(
  appBaseUrl: string,
  transferId: string,
  rawToken: string,
  action: "confirm" | "decline",
): string {
  // The clickable link in the email points at a frontend route (yet to be
  // wired) that POSTs the token to `/v1/server-transfers/:id/<action>`. We
  // deliberately do NOT expose a GET endpoint that consumes the token —
  // email-client link prefetch and browser pre-render would auto-confirm
  // ownership transfers, which is exactly the silent-takeover failure mode
  // this whole flow is designed to prevent.
  return `${appBaseUrl}/server-transfers/${transferId}?token=${rawToken}&action=${action}`;
}

// POST /v1/servers/:id/transfer
//
// Initiate a two-sided ownership transfer. Inserts a `server_transfers` row
// with two independently-hashed tokens and emails both parties their
// confirmation links. Ownership does NOT move here — that happens only in
// `handleConfirmServerTransfer` once both sides have confirmed.
export async function handleTransferServer(
  request: Request,
  ctx: RouteContext,
  serverId: string,
): Promise<Response> {
  const account = await authenticate(request, ctx.sql);
  if (account instanceof Response) return account;

  const { allowed, retryAfter } = ctx.rateLimiter.consume(
    `server-transfer-initiate:${account.id}`,
    RATE_SERVER_TRANSFER_INITIATE,
  );
  if (!allowed) return rateLimited(retryAfter);

  const serverRows = await ctx.sql`
    SELECT id, owner_id, name FROM servers WHERE id = ${serverId}
  `;
  if (serverRows.length === 0) return notFound("Server not found");
  const server = serverRows[0]!;
  if (server.owner_id !== account.id) return forbidden("Not the server owner");

  let body: InitiateBody;
  try {
    body = (await request.json()) as InitiateBody;
  } catch {
    return badRequest("Invalid JSON body");
  }

  if (
    typeof body.target_account_id !== "string" ||
    body.target_account_id.trim().length === 0
  ) {
    return badRequest("target_account_id is required");
  }
  const targetId = body.target_account_id.trim();
  if (targetId === account.id) {
    return badRequest("Cannot transfer a server to yourself");
  }

  const targetRows = await ctx.sql`
    SELECT id, email, display_name, email_verified
    FROM accounts WHERE id = ${targetId}
  `;
  if (targetRows.length === 0) return notFound("Target account not found");
  const target = targetRows[0]!;
  if (!(target.email_verified as boolean)) {
    // Phase 1: refuse to transfer to an unverified account so the owner can't
    // hand the server off to a domain-attacker. Pairs with the OAuth
    // verified-account gate in handleLoginCallback.
    return errorResponse(
      400,
      "TARGET_NOT_VERIFIED",
      "Target account has not verified its email address",
    );
  }

  // Sweep our own row if a prior pending transfer for this server has already
  // expired — the periodic sweep job runs hourly, but we don't want a freshly-
  // expired row to block a re-initiate for an hour.
  await ctx.sql`
    UPDATE server_transfers SET is_pending = false
    WHERE server_id = ${serverId}
      AND is_pending = true
      AND expires_at < now()
  `;

  // If a *live* pending transfer still exists for this server, refuse and
  // surface its id so the caller knows what to decline.
  const existingPending = await ctx.sql`
    SELECT id FROM server_transfers
    WHERE server_id = ${serverId} AND is_pending = true
    LIMIT 1
  `;
  if (existingPending.length > 0) {
    return conflict(
      `A transfer is already pending for this server (id=${existingPending[0]!.id}). Decline it before starting a new one.`,
    );
  }

  const fromRawToken = generateSessionToken();
  const toRawToken = generateSessionToken();
  const fromTokenHash = await hashToken(fromRawToken);
  const toTokenHash = await hashToken(toRawToken);
  const expiresAt = new Date(Date.now() + TRANSFER_TTL_MS);

  let transferId: string;
  try {
    const inserted = await ctx.sql`
      INSERT INTO server_transfers (
        server_id, from_account_id, to_account_id,
        from_token_hash, to_token_hash, expires_at
      ) VALUES (
        ${serverId}, ${account.id}, ${targetId},
        ${fromTokenHash}, ${toTokenHash}, ${expiresAt}
      ) RETURNING id
    `;
    transferId = inserted[0]!.id as string;
  } catch (err: unknown) {
    // Race with the sweep / a concurrent initiate landing the unique-index
    // row before us. Surface as conflict instead of a 500 — the operator's
    // intent is clear ("start a transfer") and the user can retry once they
    // see the conflicting row.
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("idx_server_transfers_one_pending_per_server") || msg.includes("unique")) {
      return conflict("A transfer is already pending for this server");
    }
    ctx.logger.error("server-transfer initiate failed", { err: msg, serverId });
    return internalError();
  }

  const confirmUrlForOwner = transferLink(ctx.appBaseUrl, transferId, fromRawToken, "confirm");
  const declineUrlForOwner = transferLink(ctx.appBaseUrl, transferId, fromRawToken, "decline");
  const confirmUrlForRecipient = transferLink(ctx.appBaseUrl, transferId, toRawToken, "confirm");
  const declineUrlForRecipient = transferLink(ctx.appBaseUrl, transferId, toRawToken, "decline");

  if (ctx.emailClient === null) {
    ctx.logger.warn("transfer emails not sent — RESEND_API_KEY not set", {
      transferId,
      ownerConfirmUrl: confirmUrlForOwner,
      ownerDeclineUrl: declineUrlForOwner,
      recipientConfirmUrl: confirmUrlForRecipient,
      recipientDeclineUrl: declineUrlForRecipient,
    });
  } else {
    const ownerEmailCtx = {
      serverName: server.name as string,
      ownerDisplayName: account.displayName,
      recipientDisplayName: target.display_name as string,
      confirmUrl: confirmUrlForOwner,
      declineUrl: declineUrlForOwner,
      expiresAt,
    };
    const recipientEmailCtx = {
      serverName: server.name as string,
      ownerDisplayName: account.displayName,
      recipientDisplayName: target.display_name as string,
      confirmUrl: confirmUrlForRecipient,
      declineUrl: declineUrlForRecipient,
      expiresAt,
    };
    try {
      await sendTransferInitiatedToOwner(ctx.emailClient, account.email, ownerEmailCtx);
      await sendTransferInitiatedToRecipient(
        ctx.emailClient,
        target.email as string,
        recipientEmailCtx,
      );
    } catch (err: unknown) {
      ctx.logger.error("failed to send transfer emails", {
        err: err instanceof Error ? err.message : String(err),
        transferId,
      });
      // Don't fail the request — the row is in the DB, the user can resend.
    }
  }

  return Response.json(
    { transfer_id: transferId, expires_at: expiresAt.toISOString(), status: "pending" },
    { status: 202 },
  );
}

// POST /v1/server-transfers/:id/confirm
//
// Token-bearer endpoint — either party POSTs their raw token. Marks the
// matching `*_confirmed_at`; when both are set, atomically moves owner_id
// and flips is_pending=false in a single transaction. The row is kept for
// audit; we never DELETE settled transfers.
export async function handleConfirmServerTransfer(
  request: Request,
  ctx: RouteContext,
  transferId: string,
): Promise<Response> {
  const ip = getClientIp(request);
  const { allowed, retryAfter } = ctx.rateLimiter.consume(
    `server-transfer-confirm:${ip}`,
    RATE_SERVER_TRANSFER_CONFIRM,
  );
  if (!allowed) return rateLimited(retryAfter);

  let body: ConfirmBody;
  try {
    body = (await request.json()) as ConfirmBody;
  } catch {
    return badRequest("Invalid JSON body");
  }
  if (typeof body.token !== "string" || body.token.trim().length === 0) {
    return badRequest("token is required");
  }
  const tokenHash = await hashToken(body.token.trim());

  const rows = await ctx.sql`
    SELECT id, server_id, from_account_id, to_account_id,
           from_token_hash, to_token_hash,
           from_confirmed_at, to_confirmed_at,
           is_pending, expires_at
    FROM server_transfers
    WHERE id = ${transferId}
    LIMIT 1
  `;
  if (rows.length === 0) return notFound("Transfer not found");
  const t = rows[0]!;

  if (!(t.is_pending as boolean)) {
    return errorResponse(410, "TRANSFER_SETTLED", "Transfer is no longer pending");
  }
  if (new Date(t.expires_at as string) < new Date()) {
    return errorResponse(410, "TRANSFER_EXPIRED", "Transfer link has expired");
  }

  const matchesFrom = tokenHash === (t.from_token_hash as string);
  const matchesTo = tokenHash === (t.to_token_hash as string);
  if (!matchesFrom && !matchesTo) {
    // Same code/message regardless of side so an attacker can't probe which
    // token they got wrong.
    return errorResponse(400, "INVALID_TOKEN", "Invalid token");
  }

  // Apply the confirm; if this is the second one, complete the transfer.
  // Done as a single transaction so a crash between "mark second confirm"
  // and "move owner_id" can't leave a half-completed state.
  let completed = false;
  await ctx.sql.begin(async (tx) => {
    if (matchesFrom) {
      await tx`
        UPDATE server_transfers SET from_confirmed_at = COALESCE(from_confirmed_at, now())
        WHERE id = ${transferId}
      `;
    } else {
      await tx`
        UPDATE server_transfers SET to_confirmed_at = COALESCE(to_confirmed_at, now())
        WHERE id = ${transferId}
      `;
    }

    const after = await tx`
      SELECT server_id, from_account_id, to_account_id,
             from_confirmed_at, to_confirmed_at
      FROM server_transfers
      WHERE id = ${transferId}
      LIMIT 1
    `;
    const row = after[0]!;
    if (row.from_confirmed_at !== null && row.to_confirmed_at !== null) {
      // Guard against the from-account having lost ownership in the meantime
      // (e.g., a separate manual SQL move). The WHERE clause makes the move
      // a no-op rather than silently overwriting a different owner.
      const moved = await tx`
        UPDATE servers
        SET owner_id = ${row.to_account_id as string}, updated_at = now()
        WHERE id = ${row.server_id as string}
          AND owner_id = ${row.from_account_id as string}
      `;
      if (moved.count > 0) {
        // Keep the server_members mirror in step with owner_id (the source
        // of truth): the recipient becomes the role='owner' row — upserted,
        // since they may already be a plain member — and the old owner stays
        // on as a regular member rather than being dropped from the server.
        await tx`
          INSERT INTO server_members (server_id, account_id, role, status)
          VALUES (${row.server_id as string}, ${row.to_account_id as string}, 'owner', 'active')
          ON CONFLICT (server_id, account_id)
          DO UPDATE SET role = 'owner', status = 'active'
        `;
        await tx`
          UPDATE server_members SET role = 'member'
          WHERE server_id = ${row.server_id as string}
            AND account_id = ${row.from_account_id as string}
        `;
      }
      await tx`
        UPDATE server_transfers SET is_pending = false WHERE id = ${transferId}
      `;
      completed = true;
    }
  });

  return Response.json({
    status: completed ? "completed" : "waiting_for_other_party",
  });
}

// POST /v1/server-transfers/:id/decline
//
// Either party can POST their token to cancel an in-flight transfer.
// Settled / already-declined transfers return 410 so the UI can show "this
// link no longer applies" instead of leaking it as a hard 404.
export async function handleDeclineServerTransfer(
  request: Request,
  ctx: RouteContext,
  transferId: string,
): Promise<Response> {
  const ip = getClientIp(request);
  const { allowed, retryAfter } = ctx.rateLimiter.consume(
    `server-transfer-confirm:${ip}`,
    RATE_SERVER_TRANSFER_CONFIRM,
  );
  if (!allowed) return rateLimited(retryAfter);

  let body: ConfirmBody;
  try {
    body = (await request.json()) as ConfirmBody;
  } catch {
    return badRequest("Invalid JSON body");
  }
  if (typeof body.token !== "string" || body.token.trim().length === 0) {
    return badRequest("token is required");
  }
  const tokenHash = await hashToken(body.token.trim());

  const rows = await ctx.sql`
    SELECT id, from_token_hash, to_token_hash, is_pending
    FROM server_transfers
    WHERE id = ${transferId}
    LIMIT 1
  `;
  if (rows.length === 0) return notFound("Transfer not found");
  const t = rows[0]!;

  if (!(t.is_pending as boolean)) {
    return errorResponse(410, "TRANSFER_SETTLED", "Transfer is no longer pending");
  }
  if (
    tokenHash !== (t.from_token_hash as string) &&
    tokenHash !== (t.to_token_hash as string)
  ) {
    return errorResponse(400, "INVALID_TOKEN", "Invalid token");
  }

  await ctx.sql`
    UPDATE server_transfers SET is_pending = false WHERE id = ${transferId}
  `;
  return new Response(null, { status: 204 });
}

// Periodic sweep: flip is_pending=false on rows whose expiry has passed.
// Called from index.ts on the same interval as signing-key rotation. The
// initiate endpoint also runs an inline sweep on its own row so users don't
// have to wait for the sweep to retry after an expired transfer.
export async function sweepExpiredTransfers(
  sql: import("../db").Sql,
): Promise<number> {
  const result = await sql`
    UPDATE server_transfers SET is_pending = false
    WHERE is_pending = true AND expires_at < now()
  `;
  return result.count;
}
