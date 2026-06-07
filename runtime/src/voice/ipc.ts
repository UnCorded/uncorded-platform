// IPC handler for `sdk.voice.*` runtime methods. Capability gating runs upstream
// in ws/router.ts (`voice.tokens` → `voice.tokens:self`, `voice.moderation`
// → `voice.moderation:self`); this handler trusts that and only validates
// input shape, looks up credentials, and forwards.
//
// 4a ships `createJoinToken`. 6b adds `voice.moderation` with the
// `removeParticipant` method (admin "Stop their share" — kicks the offender
// from the LiveKit room via the existing room-service Twirp wrapper). Future
// PRs add more methods (`muteUser`, `MutePublishedTrack`, etc.) behind the
// same dispatch.

import { rootLogger } from "@uncorded/shared";
import type { IpcMessage, IpcTransport } from "../ipc/transport";
import { removeParticipant, type RoomServiceConfig } from "./room-service";
import {
  mintJoinToken,
  VALID_TRACK_SOURCES,
  type TokenGrants,
  type TrackSource,
} from "./tokens";

const log = rootLogger.child({ component: "ipc.voice" });

export interface VoiceIpcDeps {
  /** UnCorded server id — embedded in `video.room` and validated in the
   *  webhook handler (4b). Pulled from server.json at boot time. */
  serverId: string;
  /** Public LiveKit signaling URL — returned to clients so they can connect
   *  directly to the SFU. PR-3 doesn't expose this through config; entrypoint
   *  reads `LIVEKIT_PUBLIC_URL` and falls back to `ws://localhost:7880`. */
  livekitPublicUrl: string;
  /** Read the live LiveKit credentials. Resolves on every call so that a
   *  rotateSecret() between calls is reflected without a router restart. */
  getLiveKitCredentials: () => Promise<{ apiKey: string; apiSecret: string }>;
  /** Lookup the Core display_name for a user id, used as the LiveKit
   *  Participant.name. Synchronous because it reads the runtime's local
   *  SQLite. Returns null when the user is unknown — the mint then omits
   *  the JWT `name` claim and clients fall back to identity (= userId). */
  getUserDisplayName?: (userId: string) => string | null;
  /** Lookup the Core avatar_url for a user id, packed into the LiveKit
   *  `metadata` claim so voice rosters can render real PFPs instead of
   *  the deterministic-hue fallback disk. Returns null/empty when no
   *  avatar is set — the mint then omits the metadata claim. */
  getUserAvatarUrl?: (userId: string) => string | null;
  /** Room-service config for moderation calls (PR-6 §13: admin
   *  "Stop their share" → RemoveParticipant Twirp). Same shape the cascade
   *  subscriber uses; we share the credential thunk so a rotateSecret() is
   *  reflected for both paths without a router restart. Optional because
   *  pre-PR-6 entrypoints don't pass it; `voice.moderation` returns
   *  VOICE_BRIDGE_UNAVAILABLE when missing. */
  roomServiceConfig?: RoomServiceConfig;
}

function sendResult(transport: IpcTransport, id: string, result: unknown): void {
  transport.send({ type: "response", id, result } as IpcMessage);
}

function sendError(
  transport: IpcTransport,
  id: string,
  code: string,
  message: string,
): void {
  transport.send({ type: "response", id, error: { code, message } } as IpcMessage);
}

function requireString(msg: IpcMessage, field: string): string | null {
  const v = msg[field];
  return typeof v === "string" ? v : null;
}

/**
 * Pull the optional grants block off an IPC message. Returns `undefined` if the
 * field is missing (defaults applied downstream), the validated grants object
 * if every present field is boolean, or an error string describing the first
 * invalid field.
 */
function extractGrants(msg: IpcMessage): TokenGrants | undefined | string {
  const raw = msg["grants"];
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return "grants must be an object if provided";
  }
  const grants: TokenGrants = {};
  const obj = raw as Record<string, unknown>;
  for (const key of ["canPublish", "canSubscribe", "canPublishData"] as const) {
    const value = obj[key];
    if (value === undefined) continue;
    if (typeof value !== "boolean") {
      return `grants.${key} must be a boolean`;
    }
    grants[key] = value;
  }
  return grants;
}

/**
 * Validate `canPublishSources` shape only — no policy. PR-6 §14: the runtime
 * trusts the plugin handler upstream for who-gets-what; here we just enforce
 * "string[] from the allowlist". Returns `undefined` if the field is missing
 * (mint defaults to `["microphone"]`), the validated tuple if every entry is
 * known, or an error string describing the first invalid entry.
 */
function extractCanPublishSources(
  msg: IpcMessage,
): TrackSource[] | undefined | string {
  const raw = msg["canPublishSources"];
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    return "canPublishSources must be an array of strings if provided";
  }
  const out: TrackSource[] = [];
  for (let i = 0; i < raw.length; i++) {
    const v = raw[i];
    if (typeof v !== "string") {
      return `canPublishSources[${i}] must be a string`;
    }
    if (!VALID_TRACK_SOURCES.includes(v as TrackSource)) {
      return `canPublishSources[${i}] = "${v}" is not in the allowlist (${VALID_TRACK_SOURCES.join(", ")})`;
    }
    out.push(v as TrackSource);
  }
  return out;
}

/**
 * Dispatch a `voice.tokens` IPC message. Currently handles a single method,
 * `createJoinToken`. Future PRs add more methods behind the same dispatch.
 */
export async function handleVoiceTokensIpc(
  _slug: string,
  msg: IpcMessage,
  transport: IpcTransport,
  deps: VoiceIpcDeps,
): Promise<void> {
  const id = requireString(msg, "id");
  if (id === null) {
    log.warn("missing or non-string id", { method: "voice.tokens" });
    return;
  }

  const method = requireString(msg, "method");
  if (method === null) {
    sendError(transport, id, "INVALID_PARAMS", "method must be a string");
    return;
  }

  if (method !== "createJoinToken") {
    sendError(transport, id, "INVALID_PARAMS", `unknown voice.tokens method: ${method}`);
    return;
  }

  const channelId = requireString(msg, "channelId");
  if (channelId === null || channelId.length === 0) {
    sendError(transport, id, "INVALID_PARAMS", "channelId must be a non-empty string");
    return;
  }
  const userId = requireString(msg, "userId");
  if (userId === null || userId.length === 0) {
    sendError(transport, id, "INVALID_PARAMS", "userId must be a non-empty string");
    return;
  }

  const grantsResult = extractGrants(msg);
  if (typeof grantsResult === "string") {
    sendError(transport, id, "INVALID_PARAMS", grantsResult);
    return;
  }

  const sourcesResult = extractCanPublishSources(msg);
  if (typeof sourcesResult === "string") {
    sendError(transport, id, "INVALID_PARAMS", sourcesResult);
    return;
  }

  let creds: { apiKey: string; apiSecret: string };
  try {
    creds = await deps.getLiveKitCredentials();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendError(transport, id, "VOICE_CREDENTIALS_UNAVAILABLE", message);
    return;
  }

  const displayName = deps.getUserDisplayName?.(userId) ?? null;
  const avatarUrl = deps.getUserAvatarUrl?.(userId) ?? null;

  try {
    const minted = await mintJoinToken({
      apiKey: creds.apiKey,
      apiSecret: creds.apiSecret,
      serverId: deps.serverId,
      channelId,
      userId,
      ...(grantsResult !== undefined ? { grants: grantsResult } : {}),
      ...(sourcesResult !== undefined
        ? { canPublishSources: sourcesResult }
        : {}),
      ...(displayName !== null && displayName.length > 0
        ? { displayName }
        : {}),
      ...(avatarUrl !== null && avatarUrl.length > 0 ? { avatarUrl } : {}),
    });
    sendResult(transport, id, {
      token: minted.token,
      livekitUrl: deps.livekitPublicUrl,
      expiresAt: minted.expiresAt,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendError(transport, id, "TOKEN_MINT_FAILED", message);
  }
}

/**
 * Dispatch a `voice.moderation` IPC message. Shape validation only — the
 * upstream WS router has already verified the plugin holds
 * `voice.moderation:self`. Authorization for *which user* the plugin can
 * kick is the plugin's responsibility (PR-6 §14: plugin handler enforces
 * `voice.moderation.stop_share` ≥ default 80 before calling SDK
 * `voice.removeParticipant`).
 *
 * Today only handles `removeParticipant` — the full participant kick used by
 * admin "Stop their share". Track-level mute (`MutePublishedTrack`) is a
 * follow-up; LiveKit doesn't expose it on a per-source basis as of v2.x.
 */
export async function handleVoiceModerationIpc(
  _slug: string,
  msg: IpcMessage,
  transport: IpcTransport,
  deps: VoiceIpcDeps,
): Promise<void> {
  const id = requireString(msg, "id");
  if (id === null) {
    log.warn("missing or non-string id", { method: "voice.moderation" });
    return;
  }

  const method = requireString(msg, "method");
  if (method === null) {
    sendError(transport, id, "INVALID_PARAMS", "method must be a string");
    return;
  }

  if (method !== "removeParticipant") {
    sendError(
      transport,
      id,
      "INVALID_PARAMS",
      `unknown voice.moderation method: ${method}`,
    );
    return;
  }

  if (!deps.roomServiceConfig) {
    sendError(
      transport,
      id,
      "VOICE_BRIDGE_UNAVAILABLE",
      "voice room-service not configured — moderation is unavailable.",
    );
    return;
  }

  const channelId = requireString(msg, "channelId");
  if (channelId === null || channelId.length === 0) {
    sendError(transport, id, "INVALID_PARAMS", "channelId must be a non-empty string");
    return;
  }
  const userId = requireString(msg, "userId");
  if (userId === null || userId.length === 0) {
    sendError(transport, id, "INVALID_PARAMS", "userId must be a non-empty string");
    return;
  }
  const rawReason = msg["reason"];
  const reason =
    typeof rawReason === "string" && rawReason.length > 0
      ? rawReason.slice(0, 500)
      : undefined;

  try {
    const result = await removeParticipant(deps.roomServiceConfig, {
      serverId: deps.serverId,
      channelId,
      userId,
    });
    if (result.ok) {
      log.info("voice.moderation.removeParticipant ok", {
        plugin: _slug,
        channelId,
        userId,
        ...(reason !== undefined ? { reason } : {}),
      });
      sendResult(transport, id, { ok: true });
      return;
    }
    // Treat NOT_FOUND as success-equivalent: the offender is already gone.
    // The plugin handler's intent (stop the share) is satisfied either way,
    // and surfacing an error here would surface a confusing "user not found"
    // toast to the admin.
    if (result.code === "NOT_FOUND") {
      log.info("voice.moderation.removeParticipant idempotent (not in room)", {
        plugin: _slug,
        channelId,
        userId,
      });
      sendResult(transport, id, { ok: true });
      return;
    }
    log.warn("voice.moderation.removeParticipant failed", {
      plugin: _slug,
      channelId,
      userId,
      code: result.code,
      message: result.message,
    });
    sendError(
      transport,
      id,
      `VOICE_MODERATION_${result.code}`,
      result.message,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("voice.moderation.removeParticipant threw", {
      plugin: _slug,
      channelId,
      userId,
      err: message,
    });
    sendError(transport, id, "VOICE_MODERATION_UNEXPECTED", message);
  }
}
