// Event and broadcast client.
//
// sdk.subscribe(topic, handler) — full event bus topics (e.g. "text-channels.message.created").
//   Sends { type: "subscribe", plugin: slug, topic } to shell so the runtime delivers matching events.
//
// sdk.on(event, handler) — broadcast events from sdk.broadcast on the backend.
//   The runtime sends topic = `${slug}.${event}` to the WS client (e.g. "text-channels.status.update").
//   sdk.on registers a handler for the full prefixed topic locally, no subscribe message needed —
//   broadcast bypasses the subscription system and is delivered directly to the WS connection.
//
// Both return an unsubscribe function.

type AnyHandler = (payload: unknown) => void | Promise<void>;

interface HandlerEntry {
  id: symbol;
  handler: AnyHandler;
}

export function createEventsClient(
  send: (msg: unknown) => void,
  slug: string,
) {
  // Full topic string → handlers
  const subscribers = new Map<string, HandlerEntry[]>();

  function addHandler(topic: string, handler: AnyHandler): () => void {
    const id = Symbol();
    const existing = subscribers.get(topic);
    if (existing) {
      existing.push({ id, handler });
    } else {
      subscribers.set(topic, [{ id, handler }]);
    }
    return () => {
      const arr = subscribers.get(topic);
      if (!arr) return;
      const idx = arr.findIndex((e) => e.id === id);
      if (idx !== -1) arr.splice(idx, 1);
    };
  }

  /** Subscribe to a full event bus topic. Sends a subscribe message to the shell. */
  function subscribe<T = unknown>(
    topic: string,
    handler: (payload: T) => void | Promise<void>,
  ): () => void {
    send({ type: "subscribe", plugin: slug, topic });
    return addHandler(topic, handler as AnyHandler);
  }

  /**
   * Register a handler for broadcast events from the plugin backend.
   * The slug prefix is stripped: sdk.on("status.update") matches topic "text-channels.status.update".
   * No subscribe message is sent — broadcast is direct-to-WS, not routed through event subscriptions.
   */
  function on<T = unknown>(
    event: string,
    handler: (payload: T) => void | Promise<void>,
  ): () => void {
    // NOTE (G9): The runtime prefixes broadcast topics with the plugin slug.
    // createPluginFrontend() strips it here so plugin authors use unprefixed event names.
    const fullTopic = `${slug}.${event}`;
    return addHandler(fullTopic, handler as AnyHandler);
  }

  /** Dispatch an incoming event to matching handlers. Called by the message listener. */
  function handleEvent(topic: string, payload: unknown): void {
    const handlers = subscribers.get(topic);
    if (!handlers) return;
    for (const { handler } of [...handlers]) {
      try {
        void handler(payload);
      } catch {
        // Individual handler errors don't affect other handlers.
      }
    }
  }

  return { subscribe, on, handleEvent };
}
