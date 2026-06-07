// Voice bridge — wraps the runtime's `voice.tokens` and `voice.moderation`
// IPC types into a typed SDK surface. Capability gating runs upstream in
// ws/router.ts; this layer only forwards the call and validates the
// response shape.

import type { createRequestClient } from "./request";
import type { IpcMessage } from "./transport";
import type { VoiceApi, VoiceTokenGrants, VoiceTrackSource } from "./types";
import {
  VoiceCreateJoinTokenResult,
  VoiceRemoveParticipantResult,
} from "./schemas";

const VALID_TRACK_SOURCES: readonly VoiceTrackSource[] = [
  "microphone",
  "camera",
  "screen_share",
  "screen_share_audio",
];

export function createVoiceApi(client: ReturnType<typeof createRequestClient>): VoiceApi {
  return {
    async createJoinToken({ channelId, userId, grants, canPublishSources }) {
      const msg: IpcMessage = {
        type: "voice.tokens",
        method: "createJoinToken",
        channelId,
        userId,
      };
      if (grants !== undefined) {
        // Strip undefined fields — the runtime treats absent fields as
        // "use default" but rejects an explicit `undefined`.
        const cleaned: VoiceTokenGrants = {};
        if (grants.canPublish !== undefined) cleaned.canPublish = grants.canPublish;
        if (grants.canSubscribe !== undefined) cleaned.canSubscribe = grants.canSubscribe;
        if (grants.canPublishData !== undefined) cleaned.canPublishData = grants.canPublishData;
        msg["grants"] = cleaned;
      }
      if (canPublishSources !== undefined) {
        // Local sanity check — the runtime IPC validator and the token
        // minter both re-check, but failing fast here gives plugin authors
        // an immediate stack trace instead of an opaque INVALID_PARAMS reply.
        for (const src of canPublishSources) {
          if (!VALID_TRACK_SOURCES.includes(src)) {
            throw new Error(
              `voice.createJoinToken: canPublishSources contains invalid source "${String(src)}" (allowed: ${VALID_TRACK_SOURCES.join(", ")})`,
            );
          }
        }
        msg["canPublishSources"] = [...canPublishSources];
      }
      return client.sendAndWait(VoiceCreateJoinTokenResult, msg);
    },
    async removeParticipant({ channelId, userId, reason }) {
      const msg: IpcMessage = {
        type: "voice.moderation",
        method: "removeParticipant",
        channelId,
        userId,
      };
      if (typeof reason === "string" && reason.length > 0) {
        msg["reason"] = reason;
      }
      return client.sendAndWait(VoiceRemoveParticipantResult, msg);
    },
  };
}
