// Presence hooks — sdk.presence
//
// Two surfaces composed into one namespace:
//
//   onConnected / onDisconnected
//     Server-wide session hooks backed by runtime.user.{connected,disconnected}
//     event-bus topics. No capability declaration required.
//
//   join / leave / update / watch / list  (spec-23 scoped presence)
//     Ephemeral, per-WS-session membership in arbitrary plugin-defined scopes.
//     Capability folded into broadcast.clients. See ./scoped-presence.ts.
//
// Multiple handlers can be registered per event. Each registration gets its
// own unsubscribe handle — calling it removes only that handler.

import { PRESENCE_TOPICS } from "@uncorded/protocol";
import type { IpcEventDeliverMessage } from "@uncorded/protocol";
import type { EventsApi, PresenceApi, PresenceHandler, PresenceUser } from "./types";
import type { createRequestClient } from "./request";
import { createScopedPresenceApi } from "./scoped-presence";

interface HandlerEntry {
  id: symbol;
  handler: PresenceHandler;
}

function makeDispatcher(
  eventsApi: Pick<EventsApi, "subscribe">,
  topic: string,
  handlers: HandlerEntry[],
): { ensureSubscribed(): void } {
  let subscribed = false;

  return {
    ensureSubscribed() {
      if (subscribed) return;
      subscribed = true;
      eventsApi.subscribe(topic, (msg: IpcEventDeliverMessage) => {
        const payload = msg.payload as Record<string, unknown> | null | undefined;
        const user = payload?.["user"] as PresenceUser | undefined;
        if (!user) return;
        for (const { handler } of [...handlers]) {
          try {
            void handler(user);
          } catch {
            // Individual handler errors don't affect other handlers.
          }
        }
      }).catch(() => {
        // Subscription failed — mark as not subscribed so the next
        // onConnected/onDisconnected call retries.
        subscribed = false;
      });
    },
  };
}

export interface PresenceApiDeps {
  events: Pick<EventsApi, "subscribe">;
  client: ReturnType<typeof createRequestClient>;
  /** Defaults to process.env["PLUGIN_SLUG"]; injectable for tests. */
  pluginSlug?: string | undefined;
}

export function createPresenceApi(deps: PresenceApiDeps): PresenceApi {
  const connectedHandlers: HandlerEntry[] = [];
  const disconnectedHandlers: HandlerEntry[] = [];

  const connectedDispatcher = makeDispatcher(
    deps.events,
    PRESENCE_TOPICS.USER_CONNECTED,
    connectedHandlers,
  );
  const disconnectedDispatcher = makeDispatcher(
    deps.events,
    PRESENCE_TOPICS.USER_DISCONNECTED,
    disconnectedHandlers,
  );

  const scoped = createScopedPresenceApi({
    client: deps.client,
    events: deps.events,
    pluginSlug: deps.pluginSlug,
  });

  return {
    onConnected(handler: PresenceHandler): () => void {
      const id = Symbol();
      connectedHandlers.push({ id, handler });
      connectedDispatcher.ensureSubscribed();
      return () => {
        const idx = connectedHandlers.findIndex((e) => e.id === id);
        if (idx !== -1) connectedHandlers.splice(idx, 1);
      };
    },

    onDisconnected(handler: PresenceHandler): () => void {
      const id = Symbol();
      disconnectedHandlers.push({ id, handler });
      disconnectedDispatcher.ensureSubscribed();
      return () => {
        const idx = disconnectedHandlers.findIndex((e) => e.id === id);
        if (idx !== -1) disconnectedHandlers.splice(idx, 1);
      };
    },

    join: scoped.join,
    leave: scoped.leave,
    update: scoped.update,
    watch: scoped.watch,
    list: scoped.list,
  };
}
