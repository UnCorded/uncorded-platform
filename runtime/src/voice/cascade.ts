// Voice cascade subscriber — bridges core moderation events to LiveKit
// disconnects.
//
// Wiring:
//   • CoreModule.onBanned   → kickUserAcrossRooms(reason="server_ban")
//   • CoreModule.onUnbanned → PendingKickMap.cancelUser (short-circuits
//                             any in-flight kick for the user)
//   • Webhook handler       → trackJoin / trackLeave / trackRoomDestroyed
//                             feed the participant tracker; consumePendingKick
//                             promotes a `participant_left` reason to the
//                             staged value.
//
// Per pr-4-voice-contract.md §4 *Cascade reason resolution*: the kick
// reason is staged into PendingKickMap before issuing removeParticipant
// so the eventual LiveKit `participant_left` webhook can be promoted to
// the canonical reason. A miss falls through to "explicit" — which only
// happens if (a) the runtime restarted between stage() and webhook
// arrival, or (b) the participant left voluntarily before the kick
// landed. Both are tolerable: the audit row inserted here carries the
// canonical reason regardless.

import type { Database } from "bun:sqlite";
import type { Logger } from "@uncorded/shared";
import type { CoreModule, BanEvent, UnbanEvent } from "../core/module";
import type { RolesEngine } from "../roles/engine";
import { ParticipantTracker, PendingKickMap, type CascadeReason } from "./cascade-state";
import { removeParticipant, type RoomServiceConfig, type RoomServiceResult } from "./room-service";

export interface VoiceCascadeDeps {
  db: Database;
  logger: Logger;
  coreModule: CoreModule;
  rolesEngine: RolesEngine;
  serverId: string;
  roomService: RoomServiceConfig;
  /** Override the default tracker (test injection). */
  tracker?: ParticipantTracker;
  /** Override the default pending-kick map (test injection). */
  pendingKicks?: PendingKickMap;
}

export interface VoiceCascadeHandle {
  /** Stop listening for moderation events. Idempotent. */
  dispose(): void;
  // Hooks the webhook handler consumes — exposed via the same interface
  // so main.ts can wire them in one place.
  trackJoin(channelId: string, userId: string): void;
  trackLeave(channelId: string, userId: string): void;
  trackRoomDestroyed(channelId: string): void;
  consumePendingKick(channelId: string, userId: string): CascadeReason | null;
  // Test/observability hooks.
  channelsForUser(userId: string): string[];
  pendingSize(): number;
}

/**
 * Bind the cascade to CoreModule moderation events. Returns a handle the
 * caller stores until shutdown.
 *
 * Implementation invariant — handle methods MUST remain unbound. `main.ts`
 * extracts `trackJoin` / `trackLeave` / `consumePendingKick` as bare method
 * references when wiring `getVoiceWebhookDeps`; refactoring this factory to
 * return a class instance would mean those references arrive without `this`
 * and TypeError at the next webhook delivery. The methods below close over
 * `tracker`/`pendingKicks` directly, never via `this`, so plain function
 * references survive the extraction. Don't add `this`-dependent state.
 */
export function startVoiceCascade(deps: VoiceCascadeDeps): VoiceCascadeHandle {
  const log = deps.logger.child({ component: "voice.cascade" });
  const tracker = deps.tracker ?? new ParticipantTracker();
  const pendingKicks = deps.pendingKicks ?? new PendingKickMap();

  const offBanned = deps.coreModule.onBanned((event) => {
    void kickUserAcrossRooms({
      event,
      reason: "server_ban",
      tracker,
      pendingKicks,
      roomService: deps.roomService,
      serverId: deps.serverId,
      db: deps.db,
      rolesEngine: deps.rolesEngine,
      log,
    });
  });

  const offUnbanned = deps.coreModule.onUnbanned((event: UnbanEvent) => {
    // Drop any staged kicks for this user — if the unban races a pending
    // disconnect, no webhook delivery should be promoted to server_ban.
    pendingKicks.cancelUser(event.userId);
    log.info("voice cascade: unban observed, pending kicks cancelled", {
      userId: event.userId,
      actorId: event.actorId,
    });
  });

  return {
    dispose() {
      offBanned();
      offUnbanned();
    },
    trackJoin(channelId, userId) {
      tracker.add(channelId, userId);
    },
    trackLeave(channelId, userId) {
      tracker.remove(channelId, userId);
    },
    trackRoomDestroyed(channelId) {
      tracker.removeRoom(channelId);
    },
    consumePendingKick(channelId, userId) {
      return pendingKicks.consume(channelId, userId);
    },
    channelsForUser(userId) {
      return tracker.channelsForUser(userId);
    },
    pendingSize() {
      return pendingKicks.size();
    },
  };
}

interface KickContext {
  event: BanEvent;
  reason: CascadeReason;
  tracker: ParticipantTracker;
  pendingKicks: PendingKickMap;
  roomService: RoomServiceConfig;
  serverId: string;
  db: Database;
  rolesEngine: RolesEngine;
  log: Logger;
}

async function kickUserAcrossRooms(ctx: KickContext): Promise<void> {
  const channels = ctx.tracker.channelsForUser(ctx.event.userId);
  if (channels.length === 0) {
    // User wasn't in any voice room — nothing to do. Common case for
    // bans on offline users.
    return;
  }

  // Stage every entry up-front so that even if removeParticipant calls
  // race with each other, the webhook handler sees the staged reason
  // regardless of which room's webhook lands first.
  for (const channelId of channels) {
    ctx.pendingKicks.stage(channelId, ctx.event.userId, ctx.reason);
  }

  // Fire kicks in parallel — LiveKit handles per-room state independently
  // and a wedged room shouldn't block the others.
  const kicks = channels.map(async (channelId) => {
    const result = await removeParticipant(ctx.roomService, {
      serverId: ctx.serverId,
      channelId,
      userId: ctx.event.userId,
    });
    recordKickAudit(ctx, channelId, result);
    return { channelId, result };
  });

  const settled = await Promise.allSettled(kicks);
  for (const s of settled) {
    if (s.status === "rejected") {
      // recordKickAudit handles the result-shaped failures; a rejection
      // here is an unexpected throw from removeParticipant. Log only —
      // never surface back to the moderator since the ban itself
      // succeeded.
      ctx.log.error("voice cascade: removeParticipant threw", {
        userId: ctx.event.userId,
        error: s.reason instanceof Error ? s.reason.message : String(s.reason),
      });
    }
  }
}

function recordKickAudit(
  ctx: KickContext,
  channelId: string,
  result: RoomServiceResult,
): void {
  // Per pr-4-voice-contract.md §7. The action goes to admin_audit_log
  // (recordAudit's table), not the legacy core audit_log: the admin UI
  // reads admin_audit_log, and 4d will need cascade rows visible there.
  //
  // Actor: ctx.event.actorId is "__central__" for delta-driven bans or
  // the moderator's real user id for IPC bans. Both are valuable for
  // actor-keyed audit queries — never collapse to a constant. Synthetic
  // actors (the `__` prefix) bypass the role lookup and record
  // actor_role="system"; the contract reserves "system:cascade" for
  // future system-initiated cascades with no attributable actor at all.
  const actorUserId = ctx.event.actorId;
  const actorRole = isSyntheticActor(actorUserId)
    ? "system"
    : ctx.rolesEngine.getRole(actorUserId).name;

  const payload: Record<string, unknown> = {
    banned_user_id: ctx.event.userId,
    reason: ctx.reason,
    source_event: "core.moderation.banned",
  };
  if (result.ok) {
    payload["outcome"] = "kicked";
  } else {
    payload["outcome"] = result.code === "NOT_FOUND" ? "not_in_room" : "failed";
    payload["error_code"] = result.code;
    payload["error_message"] = result.message;
  }

  ctx.db.run(
    `INSERT INTO admin_audit_log
     (ts, actor_user_id, actor_role, action, target_type, target_id, payload_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      Date.now(),
      actorUserId,
      actorRole,
      "voice.cascade.kick",
      "voice",
      channelId,
      JSON.stringify(payload),
    ],
  );

  if (result.ok) {
    ctx.log.info("voice cascade: kick dispatched", {
      channelId,
      userId: ctx.event.userId,
      reason: ctx.reason,
    });
  } else {
    ctx.log.warn("voice cascade: kick result", {
      channelId,
      userId: ctx.event.userId,
      reason: ctx.reason,
      code: result.code,
      message: result.message,
    });
  }
}

/** Synthetic actor sentinels are prefixed with `__` (e.g. `__central__`)
 *  to keep them out of the user-id namespace. They must not be looked
 *  up in user_roles. */
function isSyntheticActor(actorId: string): boolean {
  return actorId.startsWith("__");
}
