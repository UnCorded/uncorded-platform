// Event bus types — envelopes, subscriptions, backpressure, dead-letter entries.

import type { StdioParentTransport } from "../ipc/transport";

// ---------------------------------------------------------------------------
// Event envelope
// ---------------------------------------------------------------------------

export interface EventEnvelope {
  topic: string;
  version: number;
  id: string;
  ts: number;
  source_plugin: string;
  payload: unknown;
}

// ---------------------------------------------------------------------------
// Backpressure
// ---------------------------------------------------------------------------

export type OverflowPolicy = "mark_unhealthy" | "drop_oldest" | "drop_newest";

// ---------------------------------------------------------------------------
// Subscription
// ---------------------------------------------------------------------------

export interface SubscriptionConfig {
  pluginSlug: string;
  topicPattern: string;
  overflowPolicy: OverflowPolicy;
  queueSize: number;
}

// ---------------------------------------------------------------------------
// Dead-letter entry
// ---------------------------------------------------------------------------

export interface DeadLetterEntry {
  event: EventEnvelope;
  subscriberPlugin: string;
  topicPattern: string;
  failedAt: number;
  error: string;
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type PublishResult =
  | { ok: true; eventId: string }
  | { ok: false; error: { code: string; message: string } };

export type SubscribeResult =
  | { ok: true }
  | { ok: false; error: { code: string; message: string } };

// ---------------------------------------------------------------------------
// Transport provider — abstraction so EventBus doesn't depend on SubprocessManager
// ---------------------------------------------------------------------------

export interface PluginTransportProvider {
  getTransport(slug: string): StdioParentTransport | undefined;
  isPluginAlive(slug: string): boolean;
}

// ---------------------------------------------------------------------------
// Bus options
// ---------------------------------------------------------------------------

export interface EventBusOptions {
  defaultQueueSize?: number | undefined;
  defaultOverflowPolicy?: OverflowPolicy | undefined;
  retrySchedule?: readonly number[] | undefined;
  maxConsecutiveFailures?: number | undefined;
  overflowCoalesceMs?: number | undefined;
  deadLetterMaxEntries?: number | undefined;
  deadLetterTtlMs?: number | undefined;
  cascade?: (sourcePlugin: string, topic: string, payload: unknown) => void | Promise<void>;
}
