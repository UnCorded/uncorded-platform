// LiveKit room-service client — minimal Twirp-over-HTTP wrapper for the
// state-mutating calls the runtime needs. Today only RemoveParticipant
// (used by the 4c ban cascade); MutePublishedTrack and others land here
// when the moderation IPC surface lights up.
//
// LiveKit's room-service speaks Twirp over HTTP/JSON. The endpoint is
// `POST <baseUrl>/twirp/livekit.RoomService/<Method>` with a JSON body
// and an `Authorization: Bearer <admin-jwt>` header. Each call mints a
// fresh admin token scoped to the target room (see mintAdminToken).

import { mintAdminToken } from "./tokens";
import { buildRoomClaim } from "./tokens";

export interface RoomServiceConfig {
  /** Loopback signaling URL — typically `http://127.0.0.1:7880` (mirrors
   *  the LiveKit signaling port from the runtime port plan). The Twirp
   *  path is appended to this base. */
  baseUrl: string;
  /** Live LiveKit credentials. Resolved per-call so a rotateSecret() is
   *  reflected without a process restart. */
  getCredentials: () => Promise<{ apiKey: string; apiSecret: string }>;
  /** Injectable fetch — production uses globalThis.fetch; tests
   *  substitute a mock that records calls and yields canned responses. */
  fetch?: typeof globalThis.fetch;
  /** Per-request timeout in ms. Default 5s — LiveKit's room-service
   *  responds in milliseconds locally; anything beyond a few seconds
   *  means the SFU is unreachable. */
  timeoutMs?: number;
}

export interface RemoveParticipantInput {
  serverId: string;
  channelId: string;
  userId: string;
}

export type RoomServiceResult =
  | { ok: true }
  | { ok: false; code: "NOT_FOUND" | "TIMEOUT" | "AUTH_FAILED" | "UNREACHABLE" | "UNEXPECTED"; message: string };

const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Remove (kick) a participant from a voice room. The runtime calls this
 * when a user is banned: 4c stages the kick reason in a pending-kick
 * map, then dispatches one removeParticipant call per room the user is
 * tracked in. LiveKit emits a `participant_left` webhook on success
 * which the runtime maps to `runtime.voice.participant.left`.
 *
 * Returns a structured result rather than throwing — the caller (the
 * cascade subscriber) wants to log and continue rather than abort the
 * whole cascade if one room is wedged.
 */
export async function removeParticipant(
  config: RoomServiceConfig,
  input: RemoveParticipantInput,
): Promise<RoomServiceResult> {
  const room = buildRoomClaim(input.serverId, input.channelId);
  const fetchImpl = config.fetch ?? globalThis.fetch;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let creds: { apiKey: string; apiSecret: string };
  try {
    creds = await config.getCredentials();
  } catch (err) {
    return {
      ok: false,
      code: "AUTH_FAILED",
      message: err instanceof Error ? err.message : String(err),
    };
  }

  const token = await mintAdminToken({
    apiKey: creds.apiKey,
    apiSecret: creds.apiSecret,
    room,
  });

  const url = `${config.baseUrl.replace(/\/+$/, "")}/twirp/livekit.RoomService/RemoveParticipant`;
  const body = JSON.stringify({ room, identity: input.userId });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const message = err instanceof Error ? err.message : String(err);
    if (controller.signal.aborted) {
      return { ok: false, code: "TIMEOUT", message: `room-service timed out after ${timeoutMs}ms` };
    }
    return { ok: false, code: "UNREACHABLE", message };
  }
  clearTimeout(timer);

  if (response.ok) {
    // Twirp returns `{}` on success — drain to free the connection.
    try {
      await response.text();
    } catch {
      // Ignore — body drain is best-effort.
    }
    return { ok: true };
  }

  // Twirp error body shape: { code, msg }. LiveKit returns 404 for "user
  // not in room" — treat that as NOT_FOUND so the cascade subscriber can
  // distinguish "kick race lost" from "SFU broken".
  let bodyText = "";
  try {
    bodyText = await response.text();
  } catch {
    // Ignore.
  }
  if (response.status === 404) {
    return { ok: false, code: "NOT_FOUND", message: bodyText || "participant not in room" };
  }
  if (response.status === 401 || response.status === 403) {
    return { ok: false, code: "AUTH_FAILED", message: bodyText || `room-service rejected token (${response.status})` };
  }
  return {
    ok: false,
    code: "UNEXPECTED",
    message: `room-service returned ${response.status}: ${bodyText.slice(0, 200)}`,
  };
}
