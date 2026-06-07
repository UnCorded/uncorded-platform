import { describe, expect, test, beforeEach, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { EventBus } from "./bus";
import type {
  PluginTransportProvider,
  EventBusOptions,
  SubscriptionConfig,
} from "./types";
import type { IpcMessage } from "../ipc/transport";
import type { IpcEventDeliverMessage } from "@uncorded/protocol";
import { sendPluginRequest } from "../ws/router";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Fake transport that records sent messages. */
function createMockTransport() {
  const sent: IpcMessage[] = [];
  let shouldThrow = false;

  return {
    sent,
    setShouldThrow(v: boolean) {
      shouldThrow = v;
    },
    transport: {
      send(msg: IpcMessage): void {
        if (shouldThrow) throw new Error("Transport closed");
        sent.push(msg);
      },
      onMessage(_handler: (msg: IpcMessage) => void): void {},
      close(): void {},
    },
  };
}

type MockTransportHandle = ReturnType<typeof createMockTransport>;

function createProvider(
  transports: Record<string, MockTransportHandle>,
): PluginTransportProvider {
  return {
    getTransport(slug: string) {
      return transports[slug]?.transport as ReturnType<
        PluginTransportProvider["getTransport"]
      >;
    },
    isPluginAlive(slug: string) {
      return slug in transports;
    },
  };
}

function defaultConfig(
  pluginSlug: string,
  topicPattern: string,
  overrides?: Partial<SubscriptionConfig>,
): SubscriptionConfig {
  return {
    pluginSlug,
    topicPattern,
    overflowPolicy: "mark_unhealthy",
    queueSize: 1024,
    ...overrides,
  };
}

// Short retry schedule for tests
const TEST_OPTIONS: EventBusOptions = {
  retrySchedule: [10, 20, 50],
  maxConsecutiveFailures: 5,
  overflowCoalesceMs: 60_000,
  defaultQueueSize: 1024,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("EventBus", () => {
  let transports: Record<string, MockTransportHandle>;
  let provider: PluginTransportProvider;
  let bus: EventBus;

  beforeEach(() => {
    transports = {
      "text-channels": createMockTransport(),
      members: createMockTransport(),
      moderation: createMockTransport(),
    };
    provider = createProvider(transports);
    bus = new EventBus(provider, TEST_OPTIONS);
  });

  // -----------------------------------------------------------------------
  // Basic publish/subscribe
  // -----------------------------------------------------------------------

  describe("publish and subscribe", () => {
    test("matching cascade rules invoke target plugin action", () => {
      const coreDb = new Database(":memory:");
      coreDb.exec(`
        CREATE TABLE cascade_rules (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source_plugin TEXT NOT NULL,
          event_topic TEXT NOT NULL,
          target_plugin TEXT NOT NULL,
          target_action TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
      const now = Date.now();
      coreDb.run(
        `INSERT INTO cascade_rules
         (source_plugin, event_topic, target_plugin, target_action, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          "text-channels",
          "text-channels.message.created",
          "members",
          "sync_message",
          1,
          now,
          now,
        ],
      );

      const busWithCascade = new EventBus(provider, {
        ...TEST_OPTIONS,
        cascade(sourcePlugin, topic, payload) {
          const rules = coreDb
            .query<{ target_plugin: string; target_action: string }, [string, string]>(
              `SELECT target_plugin, target_action
               FROM cascade_rules
               WHERE source_plugin = ?
                 AND event_topic = ?
                 AND enabled = 1`,
            )
            .all(sourcePlugin, topic);

          for (const rule of rules) {
            if (rule.target_plugin !== "members") continue;
            sendPluginRequest(
              {
                slug: rule.target_plugin,
                pid: 1,
                subprocess: {} as never,
                transport: transports["members"]!.transport as never,
                state: "ready",
                restarts: { crashes: [], backoffIndex: 0 },
              },
              rule.target_action,
              payload as Record<string, unknown>,
              {
                id: "__runtime__",
                displayName: "Runtime Cascade",
                avatarUrl: "",
                role: "system",
              },
            );
          }
        },
      });

      busWithCascade.publish(
        "text-channels",
        "text-channels.message.created",
        { messageId: "m1", channelId: "c1" },
      );

      expect(transports["members"]!.sent).toHaveLength(1);
      expect(transports["members"]!.sent[0]).toMatchObject({
        type: "request",
        action: "sync_message",
        params: { messageId: "m1", channelId: "c1" },
        user: {
          id: "__runtime__",
          displayName: "Runtime Cascade",
          avatarUrl: "",
          role: "system",
        },
      });

      coreDb.close();
    });

    test("subscriber receives published event via transport", () => {
      bus.subscribe(defaultConfig("members", "text-channels.message.created"));
      const result = bus.publish(
        "text-channels",
        "text-channels.message.created",
        { content: "hello" },
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.eventId).toMatch(/^evt_/);

      const sent = transports["members"]!.sent;
      expect(sent).toHaveLength(1);
      const msg = sent[0] as unknown as IpcEventDeliverMessage;
      expect(msg.type).toBe("event.deliver");
      expect(msg.topic).toBe("text-channels.message.created");
      expect(msg.source_plugin).toBe("text-channels");
      expect(msg.payload).toEqual({ content: "hello" });
      expect(msg.version).toBe(1);
      expect(msg.id).toMatch(/^evt_/);
      expect(msg.ts).toBeGreaterThan(0);
    });

    test("publish with no subscribers succeeds silently", () => {
      const result = bus.publish("text-channels", "text-channels.message.created", {});
      expect(result.ok).toBe(true);
    });

    test("multiple subscribers on same topic all receive event", () => {
      bus.subscribe(defaultConfig("members", "text-channels.message.created"));
      bus.subscribe(defaultConfig("moderation", "text-channels.message.created"));

      bus.publish("text-channels", "text-channels.message.created", { id: 1 });

      expect(transports["members"]!.sent).toHaveLength(1);
      expect(transports["moderation"]!.sent).toHaveLength(1);
    });

    test("subscriber on different topic does not receive event", () => {
      bus.subscribe(defaultConfig("members", "other.topic"));

      bus.publish("text-channels", "text-channels.message.created", {});

      expect(transports["members"]!.sent).toHaveLength(0);
    });

    test("publisher does not receive its own events", () => {
      bus.subscribe(
        defaultConfig("text-channels", "text-channels.message.created"),
      );

      bus.publish("text-channels", "text-channels.message.created", {});

      expect(transports["text-channels"]!.sent).toHaveLength(0);
    });

    test("duplicate subscription is rejected", () => {
      bus.subscribe(defaultConfig("members", "text-channels.*"));
      const result = bus.subscribe(defaultConfig("members", "text-channels.*"));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("ALREADY_SUBSCRIBED");
    });
  });

  // -----------------------------------------------------------------------
  // Wildcard subscriptions
  // -----------------------------------------------------------------------

  describe("wildcard subscriptions", () => {
    test("text-channels.* matches text-channels.message.created", () => {
      bus.subscribe(defaultConfig("members", "text-channels.*"));

      bus.publish("text-channels", "text-channels.message.created", {});

      expect(transports["members"]!.sent).toHaveLength(1);
    });

    test("text-channels.* does not match other.topic", () => {
      bus.subscribe(defaultConfig("members", "text-channels.*"));

      bus.publish("text-channels", "other.topic", {});

      expect(transports["members"]!.sent).toHaveLength(0);
    });

    test("exact topic match works", () => {
      bus.subscribe(
        defaultConfig("members", "text-channels.message.created"),
      );

      bus.publish("text-channels", "text-channels.message.created", {});
      bus.publish("text-channels", "text-channels.message.deleted", {});

      expect(transports["members"]!.sent).toHaveLength(1);
    });
  });

  // -----------------------------------------------------------------------
  // Event envelope
  // -----------------------------------------------------------------------

  describe("event envelope", () => {
    test("envelope has correct fields", () => {
      bus.subscribe(defaultConfig("members", "test.*"));

      const before = Date.now();
      bus.publish("text-channels", "test.created", { data: 42 }, 3);
      const after = Date.now();

      const msg = transports["members"]!.sent[0] as unknown as IpcEventDeliverMessage;
      expect(msg.id).toMatch(/^evt_/);
      expect(msg.ts).toBeGreaterThanOrEqual(before);
      expect(msg.ts).toBeLessThanOrEqual(after);
      expect(msg.source_plugin).toBe("text-channels");
      expect(msg.topic).toBe("test.created");
      expect(msg.version).toBe(3);
      expect(msg.payload).toEqual({ data: 42 });
    });

    test("default version is 1", () => {
      bus.subscribe(defaultConfig("members", "test.*"));

      bus.publish("text-channels", "test.created", {});

      const msg = transports["members"]!.sent[0] as unknown as IpcEventDeliverMessage;
      expect(msg.version).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // Runtime namespace guard
  // -----------------------------------------------------------------------

  describe("runtime namespace", () => {
    test("plugin cannot publish to runtime.*", () => {
      const result = bus.publish("text-channels", "runtime.cascade.user.deleted", {});
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("RUNTIME_NAMESPACE_RESERVED");
    });

    test("publishRuntime bypasses guard", () => {
      bus.subscribe(defaultConfig("members", "runtime.cascade.*"));

      const result = bus.publishRuntime("runtime.cascade.user.deleted", {
        userId: "u1",
      });

      expect(result.ok).toBe(true);
      expect(transports["members"]!.sent).toHaveLength(1);
    });
  });

  // -----------------------------------------------------------------------
  // Backpressure: mark_unhealthy
  // -----------------------------------------------------------------------

  describe("backpressure: mark_unhealthy", () => {
    test("queue full marks subscription unhealthy", () => {
      bus.subscribe(
        defaultConfig("members", "test.*", {
          queueSize: 2,
          overflowPolicy: "mark_unhealthy",
        }),
      );

      // Make transport throw so events queue up instead of being delivered
      transports["members"]!.setShouldThrow(true);

      bus.publish("text-channels", "test.a", {});
      bus.publish("text-channels", "test.b", {});
      // Queue is now full (2 items, first failed delivery stays in queue)
      // Third event should trigger mark_unhealthy
      bus.publish("text-channels", "test.c", {});

      const stats = bus.getStats();
      expect(stats.unhealthySubscriptions).toBeGreaterThanOrEqual(1);
    });

    test("unhealthy subscription routes events to dead-letter", () => {
      bus.subscribe(
        defaultConfig("members", "test.*", {
          queueSize: 1,
          overflowPolicy: "mark_unhealthy",
        }),
      );

      transports["members"]!.setShouldThrow(true);

      bus.publish("text-channels", "test.a", {});
      // Queue has 1 item (failed delivery), next publish overflows
      bus.publish("text-channels", "test.b", {});
      // Now marked unhealthy, this goes straight to DLQ
      bus.publish("text-channels", "test.c", {});

      const dlq = bus.getDeadLetterLog();
      expect(dlq.length).toBeGreaterThanOrEqual(1);
    });
  });

  // -----------------------------------------------------------------------
  // Backpressure: drop_oldest
  // -----------------------------------------------------------------------

  describe("backpressure: drop_oldest", () => {
    test("drops oldest event when queue is full", () => {
      bus.subscribe(
        defaultConfig("members", "test.*", {
          queueSize: 2,
          overflowPolicy: "drop_oldest",
        }),
      );

      transports["members"]!.setShouldThrow(true);

      bus.publish("text-channels", "test.a", { n: 1 });
      bus.publish("text-channels", "test.b", { n: 2 });
      bus.publish("text-channels", "test.c", { n: 3 });

      const stats = bus.getStats();
      expect(stats.totalDropped).toBeGreaterThanOrEqual(1);
    });
  });

  // -----------------------------------------------------------------------
  // Backpressure: drop_newest
  // -----------------------------------------------------------------------

  describe("backpressure: drop_newest", () => {
    test("drops incoming event when queue is full", () => {
      bus.subscribe(
        defaultConfig("members", "test.*", {
          queueSize: 2,
          overflowPolicy: "drop_newest",
        }),
      );

      transports["members"]!.setShouldThrow(true);

      bus.publish("text-channels", "test.a", { n: 1 });
      bus.publish("text-channels", "test.b", { n: 2 });
      bus.publish("text-channels", "test.c", { n: 3 });

      const stats = bus.getStats();
      expect(stats.totalDropped).toBeGreaterThanOrEqual(1);
    });
  });

  // -----------------------------------------------------------------------
  // Failure handling and retry
  // -----------------------------------------------------------------------

  describe("failure handling", () => {
    test("transport.send() failure schedules retry", async () => {
      bus.subscribe(defaultConfig("members", "test.*", { queueSize: 8 }));
      transports["members"]!.setShouldThrow(true);

      bus.publish("text-channels", "test.a", {});

      // Event is in queue, retry timer scheduled. No delivery yet.
      expect(transports["members"]!.sent).toHaveLength(0);

      // Fix transport and wait for retry
      transports["members"]!.setShouldThrow(false);
      await new Promise((r) => setTimeout(r, 50));

      expect(transports["members"]!.sent).toHaveLength(1);
    });

    test("5 consecutive failures marks subscription unhealthy", async () => {
      const bus2 = new EventBus(provider, {
        ...TEST_OPTIONS,
        retrySchedule: [0], // immediate retry for test speed
        maxConsecutiveFailures: 3,
      });

      bus2.subscribe(defaultConfig("members", "test.*", { queueSize: 16 }));
      transports["members"]!.setShouldThrow(true);

      // Publish an event — first attempt + retries exhaust maxConsecutiveFailures
      bus2.publish("text-channels", "test.a", {});

      // Wait for async retry timers to fire (retrySchedule: [0] = 0ms delay)
      await new Promise((r) => setTimeout(r, 50));

      const stats = bus2.getStats();
      expect(stats.unhealthySubscriptions).toBe(1);
    });

    test("successful send resets consecutive failure count", async () => {
      bus.subscribe(defaultConfig("members", "test.*", { queueSize: 16 }));

      // First publish fails
      transports["members"]!.setShouldThrow(true);
      bus.publish("text-channels", "test.a", {});

      // Fix transport, wait for retry
      transports["members"]!.setShouldThrow(false);
      await new Promise((r) => setTimeout(r, 50));

      // Should have recovered — publish more events
      bus.publish("text-channels", "test.b", {});
      bus.publish("text-channels", "test.c", {});

      expect(transports["members"]!.sent).toHaveLength(3);
      expect(bus.getStats().unhealthySubscriptions).toBe(0);
    });

    test("dead-letter receives events after max failures", async () => {
      const bus2 = new EventBus(provider, {
        ...TEST_OPTIONS,
        retrySchedule: [0],
        maxConsecutiveFailures: 2,
      });

      bus2.subscribe(defaultConfig("members", "test.*", { queueSize: 16 }));
      transports["members"]!.setShouldThrow(true);

      // Publish several events — they'll all fail delivery
      bus2.publish("text-channels", "test.a", {});
      bus2.publish("text-channels", "test.b", {});
      bus2.publish("text-channels", "test.c", {});

      // Wait for async retry timers to exhaust failures
      await new Promise((r) => setTimeout(r, 50));

      const dlq = bus2.getDeadLetterLog();
      expect(dlq.length).toBeGreaterThan(0);
      expect(dlq[0]!.subscriberPlugin).toBe("members");
    });

    test("runtime.dlq.overflow event is emitted when events drain to dead-letter", async () => {
      const bus2 = new EventBus(provider, {
        ...TEST_OPTIONS,
        retrySchedule: [0],
        maxConsecutiveFailures: 2,
      });

      // moderation subscribes to runtime.dlq.* to receive overflow notifications
      bus2.subscribe(defaultConfig("moderation", "runtime.dlq.*"));
      // members will fail delivery and get dead-lettered
      bus2.subscribe(defaultConfig("members", "test.*", { queueSize: 16 }));
      transports["members"]!.setShouldThrow(true);

      // Publish events — retries exhaust, events drain to DLQ
      bus2.publish("text-channels", "test.a", {});
      bus2.publish("text-channels", "test.b", {});

      // Wait for async retry timers to exhaust failures
      await new Promise((r) => setTimeout(r, 50));

      // moderation should have received a runtime.dlq.overflow event
      const overflowEvents = (transports["moderation"]!.sent as unknown as IpcEventDeliverMessage[]).filter(
        (m) => m.topic === "runtime.dlq.overflow",
      );
      expect(overflowEvents.length).toBeGreaterThanOrEqual(1);
      expect(overflowEvents[0]!.type).toBe("event.deliver");
    });
  });

  // -----------------------------------------------------------------------
  // Unsubscribe
  // -----------------------------------------------------------------------

  describe("unsubscribe", () => {
    test("unsubscribe stops event delivery", () => {
      bus.subscribe(defaultConfig("members", "test.*"));
      bus.publish("text-channels", "test.a", {});
      expect(transports["members"]!.sent).toHaveLength(1);

      bus.unsubscribe("members", "test.*");
      bus.publish("text-channels", "test.b", {});
      expect(transports["members"]!.sent).toHaveLength(1); // no new events
    });

    test("removePlugin removes all subscriptions", () => {
      bus.subscribe(defaultConfig("members", "test.*"));
      bus.subscribe(defaultConfig("members", "other.*"));

      bus.removePlugin("members");

      bus.publish("text-channels", "test.a", {});
      bus.publish("text-channels", "other.a", {});
      expect(transports["members"]!.sent).toHaveLength(0);
      expect(bus.getStats().activeSubscriptions).toBe(0);
    });

    test("unsubscribe returns false for non-existent subscription", () => {
      expect(bus.unsubscribe("members", "nonexistent")).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Per-(topic, subscriber) FIFO ordering
  // -----------------------------------------------------------------------

  describe("FIFO ordering", () => {
    test("events arrive in publication order", () => {
      bus.subscribe(defaultConfig("members", "test.*"));

      bus.publish("text-channels", "test.a", { seq: 1 });
      bus.publish("text-channels", "test.b", { seq: 2 });
      bus.publish("text-channels", "test.c", { seq: 3 });

      const sent = transports["members"]!.sent as unknown as IpcEventDeliverMessage[];
      expect(sent).toHaveLength(3);
      expect((sent[0]!.payload as Record<string, number>)["seq"]).toBe(1);
      expect((sent[1]!.payload as Record<string, number>)["seq"]).toBe(2);
      expect((sent[2]!.payload as Record<string, number>)["seq"]).toBe(3);
    });

    test("events published during retry backoff are delivered AFTER the retrying event", async () => {
      bus.subscribe(defaultConfig("members", "test.*", { queueSize: 16 }));

      // First event fails delivery → enters retry backoff
      transports["members"]!.setShouldThrow(true);
      bus.publish("text-channels", "test.a", { seq: 1 });

      // While retrying, publish more events — these must NOT jump ahead
      bus.publish("text-channels", "test.b", { seq: 2 });
      bus.publish("text-channels", "test.c", { seq: 3 });

      // Nothing delivered yet (transport is throwing)
      expect(transports["members"]!.sent).toHaveLength(0);

      // Fix transport and wait for retry timer to fire
      transports["members"]!.setShouldThrow(false);
      await new Promise((r) => setTimeout(r, 100));

      // All three should arrive in order: seq 1, 2, 3
      const sent = transports["members"]!.sent as unknown as IpcEventDeliverMessage[];
      expect(sent).toHaveLength(3);
      expect((sent[0]!.payload as Record<string, number>)["seq"]).toBe(1);
      expect((sent[1]!.payload as Record<string, number>)["seq"]).toBe(2);
      expect((sent[2]!.payload as Record<string, number>)["seq"]).toBe(3);
    });

    test("after max failures and dead-letter drain, re-subscribe works normally", async () => {
      const bus2 = new EventBus(provider, {
        ...TEST_OPTIONS,
        retrySchedule: [0],
        maxConsecutiveFailures: 2,
      });

      bus2.subscribe(defaultConfig("members", "test.*", { queueSize: 16 }));
      transports["members"]!.setShouldThrow(true);

      // Trigger max failures → unhealthy → dead-letter drain
      bus2.publish("text-channels", "test.a", { seq: 1 });
      bus2.publish("text-channels", "test.b", { seq: 2 });

      // Wait for async retry timers to exhaust failures
      await new Promise((r) => setTimeout(r, 50));

      expect(bus2.getStats().unhealthySubscriptions).toBe(1);

      // Unsubscribe and re-subscribe
      bus2.unsubscribe("members", "test.*");
      transports["members"]!.setShouldThrow(false);
      transports["members"]!.sent.length = 0;
      bus2.subscribe(defaultConfig("members", "test.*", { queueSize: 16 }));

      // New events should work
      bus2.publish("text-channels", "test.c", { seq: 3 });
      const sent = transports["members"]!.sent as unknown as IpcEventDeliverMessage[];
      expect(sent).toHaveLength(1);
      expect((sent[0]!.payload as Record<string, number>)["seq"]).toBe(3);
    });
  });

  // -----------------------------------------------------------------------
  // Overflow coalescing
  // -----------------------------------------------------------------------

  describe("overflow coalescing", () => {
    test("multiple overflows within coalesce window emit only one event", () => {
      // Subscribe a watcher for runtime events
      bus.subscribe(defaultConfig("moderation", "runtime.subscriber.*"));

      // Subscribe members with tiny queue and drop_oldest policy
      bus.subscribe(
        defaultConfig("members", "test.*", {
          queueSize: 1,
          overflowPolicy: "drop_oldest",
        }),
      );

      transports["members"]!.setShouldThrow(true);

      // Publish many events to trigger multiple overflows
      bus.publish("text-channels", "test.a", {});
      bus.publish("text-channels", "test.b", {});
      bus.publish("text-channels", "test.c", {});
      bus.publish("text-channels", "test.d", {});

      // The moderation plugin (subscribed to runtime.subscriber.*) should receive
      // at most 1 overflow event due to coalescing within 60s
      const overflowEvents = transports["moderation"]!.sent.filter(
        (m) => (m as unknown as IpcEventDeliverMessage).topic === "runtime.subscriber.overflow",
      );
      expect(overflowEvents.length).toBeLessThanOrEqual(1);
    });
  });

  // -----------------------------------------------------------------------
  // Stats
  // -----------------------------------------------------------------------

  describe("stats", () => {
    test("tracks published and delivered counts", () => {
      bus.subscribe(defaultConfig("members", "test.*"));

      bus.publish("text-channels", "test.a", {});
      bus.publish("text-channels", "test.b", {});

      const stats = bus.getStats();
      expect(stats.totalPublished).toBeGreaterThanOrEqual(2);
      expect(stats.totalDelivered).toBe(2);
    });

    test("tracks active subscriptions", () => {
      bus.subscribe(defaultConfig("members", "test.*"));
      bus.subscribe(defaultConfig("moderation", "test.*"));
      expect(bus.getStats().activeSubscriptions).toBe(2);

      bus.unsubscribe("members", "test.*");
      expect(bus.getStats().activeSubscriptions).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // Plugin subscription listing
  // -----------------------------------------------------------------------

  describe("getPluginSubscriptions", () => {
    test("returns all patterns for a plugin", () => {
      bus.subscribe(defaultConfig("members", "test.*"));
      bus.subscribe(defaultConfig("members", "other.topic"));

      const patterns = bus.getPluginSubscriptions("members");
      expect(patterns).toContain("test.*");
      expect(patterns).toContain("other.topic");
    });

    test("returns empty for unknown plugin", () => {
      expect(bus.getPluginSubscriptions("unknown")).toEqual([]);
    });
  });
});
