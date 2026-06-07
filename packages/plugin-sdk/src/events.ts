// Event publishing and subscribing — wraps IPC event messages.

import type { IpcEventDeliverMessage } from "@uncorded/protocol";
import type { IpcTransport } from "./transport";
import type { createRequestClient } from "./request";
import type { EventsApi, EventHandler, SubscribeOptions } from "./types";
import { unknownResult } from "./schemas";

export function createEventsApi(
  transport: IpcTransport,
  client: ReturnType<typeof createRequestClient>,
): EventsApi {
  const subscribers = new Map<string, EventHandler[]>();

  function publish(topic: string, payload: unknown, version?: number): void {
    transport.send({
      type: "events.publish",
      topic,
      payload,
      ...(version !== undefined ? { version } : {}),
    });
  }

  async function subscribe(
    topic: string,
    handler: EventHandler,
    options?: SubscribeOptions,
  ): Promise<void> {
    // Send subscription request to runtime and wait for ack
    await client.sendAndWait(unknownResult, {
      type: "events.subscribe",
      topic,
      ...(options?.overflow_policy !== undefined ? { overflow_policy: options.overflow_policy } : {}),
      ...(options?.queue_size !== undefined ? { queue_size: options.queue_size } : {}),
    });

    // Register local handler
    const existing = subscribers.get(topic);
    if (existing) {
      existing.push(handler);
    } else {
      subscribers.set(topic, [handler]);
    }
  }

  async function unsubscribe(topic: string): Promise<void> {
    await client.sendAndWait(unknownResult, {
      type: "events.unsubscribe",
      topic,
    });
    subscribers.delete(topic);
  }

  /** Dispatch an incoming event delivery to matching subscribers. */
  function handleDelivery(msg: IpcEventDeliverMessage): void {
    const handlers = subscribers.get(msg.topic);
    if (!handlers) return;
    for (const handler of handlers) {
      let result: unknown;
      try {
        result = handler(msg);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Handler error";
        transport.send({ type: "event.deliver.error", id: msg.id, error: message });
        continue;
      }
      Promise.resolve(result).catch((err: unknown) => {
        // Report failure back to the runtime so it knows delivery failed
        const message = err instanceof Error ? err.message : "Handler error";
        transport.send({
          type: "event.deliver.error",
          id: msg.id,
          error: message,
        });
      });
    }
  }

  return Object.assign(
    { publish, subscribe, unsubscribe },
    { handleDelivery },
  );
}
