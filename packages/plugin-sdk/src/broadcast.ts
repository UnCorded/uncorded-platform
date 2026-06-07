// Broadcast API — push WS events directly to connected clients.
//
// Requires broadcast.clients in the plugin manifest permissions.
//
// Event names are automatically prefixed with the plugin slug by the runtime:
//   sdk.broadcast.toUser(userId, "status.update", payload)
//   → WS clients receive { type: "event", topic: "text-channels.status.update", payload }
//
// NOTE (G9): createPluginFrontend() in the frontend SDK is responsible for
// stripping the slug prefix so plugin authors write sdk.on("status.update", handler)
// rather than sdk.on("text-channels.status.update", handler).

import type { createRequestClient } from "./request";
import type { BroadcastApi } from "./types";
import { unknownResult } from "./schemas";

export function createBroadcastApi(client: ReturnType<typeof createRequestClient>): BroadcastApi {
  async function toUsers(userIds: string[], event: string, payload: unknown): Promise<void> {
    await client.sendAndWait(unknownResult, {
      type: "broadcast.toUsers",
      userIds,
      event,
      payload,
    });
  }

  return {
    toUsers,

    async toUser(userId: string, event: string, payload: unknown): Promise<void> {
      await toUsers([userId], event, payload);
    },

    async toAll(event: string, payload: unknown): Promise<void> {
      await client.sendAndWait(unknownResult, {
        type: "broadcast.toAll",
        event,
        payload,
      });
    },
  };
}
