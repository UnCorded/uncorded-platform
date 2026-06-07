// Event bus — runtime-mediated publish/subscribe for cross-plugin communication.
//
// Plugins publish and subscribe via IPC. The bus enforces topic routing,
// per-(topic, subscriber) FIFO ordering, at-least-once delivery with retry,
// backpressure policies, and bounded dead-letter logging.

import { scopeMatches } from "../capabilities/checker";
import { BoundedQueue } from "./queue";
import { DeadLetterLog } from "./dead-letter";
import { rootLogger } from "@uncorded/shared";
import type {
  EventEnvelope,
  OverflowPolicy,
  SubscriptionConfig,
  DeadLetterEntry,
  PluginTransportProvider,
  EventBusOptions,
  PublishResult,
  SubscribeResult,
} from "./types";
import type { IpcEventDeliverMessage } from "@uncorded/protocol";

const log = rootLogger.child({ component: "events.bus" });

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_QUEUE_SIZE = 1024;
const DEFAULT_OVERFLOW_POLICY: OverflowPolicy = "mark_unhealthy";
const DEFAULT_RETRY_SCHEDULE = [1_000, 5_000, 30_000] as const;
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 5;
const DEFAULT_OVERFLOW_COALESCE_MS = 60_000;

// ---------------------------------------------------------------------------
// Internal subscriber state
// ---------------------------------------------------------------------------

interface SubscriberState {
  config: SubscriptionConfig;
  queue: BoundedQueue<EventEnvelope>;
  healthy: boolean;
  consecutiveFailures: number;
  processing: boolean;
  retrying: boolean;
  retryTimer: ReturnType<typeof setTimeout> | null;
}

interface OverflowTracker {
  lastEmittedAt: number;
  dropCount: number;
}

// ---------------------------------------------------------------------------
// EventBus stats (observability)
// ---------------------------------------------------------------------------

export interface EventBusStats {
  totalPublished: number;
  totalDelivered: number;
  totalDropped: number;
  totalDeadLettered: number;
  activeSubscriptions: number;
  unhealthySubscriptions: number;
}

// ---------------------------------------------------------------------------
// EventBus
// ---------------------------------------------------------------------------

export class EventBus {
  private readonly transportProvider: PluginTransportProvider;

  // Map<topicPattern, Map<pluginSlug, SubscriberState>>
  private readonly subscribers = new Map<string, Map<string, SubscriberState>>();
  private readonly deadLetters: DeadLetterLog;

  // Overflow coalescing: "plugin:eventType" → tracker
  private readonly overflowTrackers = new Map<string, OverflowTracker>();

  // Options
  private readonly defaultQueueSize: number;
  private readonly defaultOverflowPolicy: OverflowPolicy;
  private readonly retrySchedule: readonly number[];
  private readonly maxConsecutiveFailures: number;
  private readonly overflowCoalesceMs: number;
  private readonly cascade:
    | ((sourcePlugin: string, topic: string, payload: unknown) => void | Promise<void>)
    | undefined;

  // Stats
  private stats: EventBusStats = {
    totalPublished: 0,
    totalDelivered: 0,
    totalDropped: 0,
    totalDeadLettered: 0,
    activeSubscriptions: 0,
    unhealthySubscriptions: 0,
  };

  constructor(
    transportProvider: PluginTransportProvider,
    options?: EventBusOptions,
  ) {
    this.transportProvider = transportProvider;
    this.defaultQueueSize = options?.defaultQueueSize ?? DEFAULT_QUEUE_SIZE;
    this.defaultOverflowPolicy =
      options?.defaultOverflowPolicy ?? DEFAULT_OVERFLOW_POLICY;
    this.retrySchedule = options?.retrySchedule ?? DEFAULT_RETRY_SCHEDULE;
    this.maxConsecutiveFailures =
      options?.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES;
    this.overflowCoalesceMs =
      options?.overflowCoalesceMs ?? DEFAULT_OVERFLOW_COALESCE_MS;
    this.cascade = options?.cascade;
    this.deadLetters = new DeadLetterLog(
      options?.deadLetterMaxEntries,
      options?.deadLetterTtlMs,
    );
  }

  // -------------------------------------------------------------------------
  // Publish
  // -------------------------------------------------------------------------

  /**
   * Publish an event from a plugin. Rejects if the topic is in the
   * reserved `runtime.*` namespace.
   */
  publish(
    sourcePlugin: string,
    topic: string,
    payload: unknown,
    version?: number,
  ): PublishResult {
    // Runtime namespace guard
    if (topic.startsWith("runtime.")) {
      return {
        ok: false,
        error: {
          code: "RUNTIME_NAMESPACE_RESERVED",
          message: `Plugins cannot publish to the "runtime.*" namespace.`,
        },
      };
    }

    return this.publishInternal(sourcePlugin, topic, payload, version);
  }

  /**
   * Publish a runtime-originated event (e.g., `runtime.cascade.user.deleted`).
   * Bypasses the `runtime.*` namespace guard.
   */
  publishRuntime(
    topic: string,
    payload: unknown,
    version?: number,
  ): PublishResult {
    return this.publishInternal("__runtime__", topic, payload, version);
  }

  // -------------------------------------------------------------------------
  // Subscribe / Unsubscribe
  // -------------------------------------------------------------------------

  subscribe(config: SubscriptionConfig): SubscribeResult {
    const { pluginSlug, topicPattern, overflowPolicy, queueSize } = config;

    // Check if already subscribed to this pattern
    const patternMap = this.subscribers.get(topicPattern);
    if (patternMap?.has(pluginSlug)) {
      return {
        ok: false,
        error: {
          code: "ALREADY_SUBSCRIBED",
          message: `Plugin "${pluginSlug}" is already subscribed to "${topicPattern}".`,
        },
      };
    }

    const state: SubscriberState = {
      config,
      queue: new BoundedQueue<EventEnvelope>(queueSize),
      healthy: true,
      consecutiveFailures: 0,
      processing: false,
      retrying: false,
      retryTimer: null,
    };

    if (!patternMap) {
      this.subscribers.set(topicPattern, new Map([[pluginSlug, state]]));
    } else {
      patternMap.set(pluginSlug, state);
    }

    this.stats.activeSubscriptions++;
    return { ok: true };
  }

  unsubscribe(pluginSlug: string, topicPattern: string): boolean {
    const patternMap = this.subscribers.get(topicPattern);
    if (!patternMap) return false;

    const state = patternMap.get(pluginSlug);
    if (!state) return false;

    this.cleanupSubscriber(state);
    patternMap.delete(pluginSlug);
    if (patternMap.size === 0) {
      this.subscribers.delete(topicPattern);
    }

    this.stats.activeSubscriptions--;
    if (!state.healthy) this.stats.unhealthySubscriptions--;

    return true;
  }

  /** Remove all subscriptions for a plugin (e.g., on crash/unload). */
  removePlugin(pluginSlug: string): void {
    for (const [pattern, patternMap] of this.subscribers) {
      const state = patternMap.get(pluginSlug);
      if (state) {
        this.cleanupSubscriber(state);
        patternMap.delete(pluginSlug);
        this.stats.activeSubscriptions--;
        if (!state.healthy) this.stats.unhealthySubscriptions--;
      }
      if (patternMap.size === 0) {
        this.subscribers.delete(pattern);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Observability
  // -------------------------------------------------------------------------

  getDeadLetterLog(): readonly DeadLetterEntry[] {
    return this.deadLetters.getEntries();
  }

  getStats(): Readonly<EventBusStats> {
    return { ...this.stats };
  }

  /** Get all subscription patterns for a plugin. */
  getPluginSubscriptions(pluginSlug: string): readonly string[] {
    const patterns: string[] = [];
    for (const [pattern, patternMap] of this.subscribers) {
      if (patternMap.has(pluginSlug)) {
        patterns.push(pattern);
      }
    }
    return patterns;
  }

  // -------------------------------------------------------------------------
  // Internal: publish
  // -------------------------------------------------------------------------

  private publishInternal(
    sourcePlugin: string,
    topic: string,
    payload: unknown,
    version?: number,
  ): PublishResult {
    const envelope: EventEnvelope = {
      topic,
      version: version ?? 1,
      id: `evt_${crypto.randomUUID()}`,
      ts: Date.now(),
      source_plugin: sourcePlugin,
      payload,
    };

    this.stats.totalPublished++;

    if (this.cascade && sourcePlugin !== "__runtime__") {
      try {
        void Promise.resolve(this.cascade(sourcePlugin, topic, payload)).catch((error: unknown) => {
          log.warn("cascade dispatch failed", {
            sourcePlugin,
            topic,
            err: error instanceof Error ? error.message : String(error),
          });
        });
      } catch (error) {
        log.warn("cascade dispatch failed", {
          sourcePlugin,
          topic,
          err: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Route to all matching subscribers
    for (const [pattern, patternMap] of this.subscribers) {
      // scopeMatches(declared, requested): subscription pattern is "declared",
      // published topic is "requested"
      if (!scopeMatches(pattern, topic)) continue;

      for (const [slug, state] of patternMap) {
        // Don't deliver to the source plugin
        if (slug === sourcePlugin) continue;
        this.enqueueEvent(state, envelope);
      }
    }

    return { ok: true, eventId: envelope.id };
  }

  // -------------------------------------------------------------------------
  // Internal: enqueue + deliver
  // -------------------------------------------------------------------------

  private enqueueEvent(sub: SubscriberState, event: EventEnvelope): void {
    if (!sub.healthy) {
      // Unhealthy — route directly to dead-letter
      this.addToDeadLetter(sub, event, "Subscription is unhealthy");
      return;
    }

    const result = sub.queue.enqueue(event, sub.config.overflowPolicy);

    if (!result.accepted) {
      // mark_unhealthy policy: queue full, reject
      sub.healthy = false;
      this.stats.unhealthySubscriptions++;
      this.addToDeadLetter(sub, event, "Queue full — subscription marked unhealthy");
      // Emit runtime.subscriber.unhealthy (coalesced)
      this.emitOverflow(
        sub.config.pluginSlug,
        "runtime.subscriber.unhealthy",
        sub.config.topicPattern,
      );
      return;
    }

    if (result.dropped !== null) {
      // drop_oldest or drop_newest — event was dropped
      this.stats.totalDropped++;
      this.emitOverflow(
        sub.config.pluginSlug,
        "runtime.subscriber.overflow",
        sub.config.topicPattern,
      );
    }

    // Kick off delivery if not already processing or waiting on retry
    if (!sub.processing && !sub.retrying) {
      this.processQueue(sub);
    }
  }

  private processQueue(sub: SubscriberState): void {
    if (sub.processing || !sub.healthy) return;
    sub.processing = true;

    while (sub.queue.size > 0 && sub.healthy) {
      const event = sub.queue.peek();
      if (!event) break;

      try {
        this.deliverEvent(sub.config.pluginSlug, event);
        sub.queue.dequeue();
        sub.consecutiveFailures = 0;
        this.stats.totalDelivered++;
      } catch {
        sub.consecutiveFailures++;

        if (sub.consecutiveFailures >= this.maxConsecutiveFailures) {
          // Mark unhealthy — drain remaining queue to dead-letter
          sub.healthy = false;
          this.stats.unhealthySubscriptions++;
          this.drainToDeadLetter(sub, "Max consecutive failures exceeded");
          this.emitOverflow(
            sub.config.pluginSlug,
            "runtime.subscriber.unhealthy",
            sub.config.topicPattern,
          );
          break;
        }

        // Schedule retry with backoff — new events queue behind (FIFO)
        const backoffIndex = Math.min(
          sub.consecutiveFailures - 1,
          this.retrySchedule.length - 1,
        );
        const delay = this.retrySchedule[backoffIndex]!;
        sub.processing = false;
        sub.retrying = true;
        sub.retryTimer = setTimeout(() => {
          sub.retryTimer = null;
          sub.retrying = false;
          this.processQueue(sub);
        }, delay);
        return; // Exit — retry timer will resume
      }
    }

    sub.processing = false;
  }

  private deliverEvent(pluginSlug: string, event: EventEnvelope): void {
    const transport = this.transportProvider.getTransport(pluginSlug);
    if (!transport) {
      throw new Error(`No transport for plugin "${pluginSlug}"`);
    }

    const msg: IpcEventDeliverMessage = {
      type: "event.deliver",
      topic: event.topic,
      version: event.version,
      id: event.id,
      ts: event.ts,
      source_plugin: event.source_plugin,
      payload: event.payload,
    };

    // IpcEventDeliverMessage is structurally compatible with IpcMessage but
    // lacks the index signature, so an explicit cast is needed.
    transport.send(msg as unknown as import("../ipc/transport").IpcMessage);
  }

  // -------------------------------------------------------------------------
  // Internal: dead-letter
  // -------------------------------------------------------------------------

  private addToDeadLetter(
    sub: SubscriberState,
    event: EventEnvelope,
    error: string,
  ): void {
    this.deadLetters.add({
      event,
      subscriberPlugin: sub.config.pluginSlug,
      topicPattern: sub.config.topicPattern,
      failedAt: Date.now(),
      error,
    });
    this.stats.totalDeadLettered++;
  }

  private drainToDeadLetter(sub: SubscriberState, error: string): void {
    const remaining = sub.queue.drain();
    for (const event of remaining) {
      this.addToDeadLetter(sub, event, error);
    }
    // Emit runtime.dlq.overflow (coalesced, same as other overflow events)
    if (remaining.length > 0) {
      this.emitOverflow(
        sub.config.pluginSlug,
        "runtime.dlq.overflow",
        sub.config.topicPattern,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Internal: overflow coalescing
  // -------------------------------------------------------------------------

  private emitOverflow(
    pluginSlug: string,
    eventType: string,
    topicPattern: string,
  ): void {
    const key = `${pluginSlug}:${eventType}`;
    const tracker = this.overflowTrackers.get(key);
    const now = Date.now();

    if (!tracker) {
      this.overflowTrackers.set(key, { lastEmittedAt: now, dropCount: 1 });
      this.publishInternal("__runtime__", eventType, {
        plugin: pluginSlug,
        topic_pattern: topicPattern,
        drop_count: 1,
      });
      return;
    }

    tracker.dropCount++;

    if (now - tracker.lastEmittedAt >= this.overflowCoalesceMs) {
      const count = tracker.dropCount;
      tracker.lastEmittedAt = now;
      tracker.dropCount = 0;
      this.publishInternal("__runtime__", eventType, {
        plugin: pluginSlug,
        topic_pattern: topicPattern,
        drop_count: count,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Internal: cleanup
  // -------------------------------------------------------------------------

  private cleanupSubscriber(state: SubscriberState): void {
    if (state.retryTimer !== null) {
      clearTimeout(state.retryTimer);
      state.retryTimer = null;
    }
    state.retrying = false;
    state.queue.clear();
  }
}
