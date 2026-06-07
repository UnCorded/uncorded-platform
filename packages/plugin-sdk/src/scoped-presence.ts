// Scoped presence — sdk.presence.{join, leave, update, watch, list}.
// Per spec-23-scoped-presence.md.
//
// Design notes:
//   - join/leave/update infer the WS session from AsyncLocalStorage set by
//     handle.ts when invoking a request handler. Calls outside that context
//     throw PRESENCE_NO_SESSION_CONTEXT before any IPC.
//   - watch maintains one bus subscription per topic per process (3 total),
//     demultiplexed by scope to per-handler local caches. Per-handler
//     coalesce timers; per-handler unsubscribe just removes the handler from
//     the watcher (no IPC unsubscribe — other watchers may still need the
//     subscription).
//   - The subscribe-then-list race (an event arriving between subscription
//     ack and list response) is resolved by subscribing FIRST so applyJoined
//     captures any concurrent change, then merging list() results into the
//     cache with newer-wins semantics.

import {
  RUNTIME_PRESENCE_TOPICS,
  type IpcEventDeliverMessage,
  type PresenceEntry,
  type RuntimePresenceJoinedPayload,
  type RuntimePresenceLeftPayload,
  type RuntimePresenceUpdatedPayload,
} from "@uncorded/protocol";
import type { createRequestClient } from "./request";
import type { EventsApi } from "./types";
import type { IpcMessage } from "./transport";
import { getCurrentSession } from "./request-context";
import { SdkError } from "./errors";
import {
  PresenceJoinResult,
  PresenceListResult,
  unknownResult,
} from "./schemas";

const COALESCE_DEFAULT_MS = 50;
const COALESCE_MIN_MS = 0;
const COALESCE_MAX_MS = 500;

/**
 * Plugin slug — read once at SDK init from PLUGIN_SLUG (set by the runtime
 * subprocess spawner). Required so the SDK can fully-qualify scope names
 * locally for watcher caching without an extra round-trip per call.
 */
function readPluginSlug(envSlug: string | undefined): string {
  if (typeof envSlug !== "string" || envSlug.length === 0) {
    throw new SdkError(
      "missing_plugin_slug",
      "scoped-presence: PLUGIN_SLUG env var is empty. Plugins must be spawned by the UnCorded runtime — direct execution is unsupported.",
    );
  }
  return envSlug;
}

interface WatchHandler {
  cb: (entries: PresenceEntry[]) => void;
  coalesceMs: number;
  pendingTimer: ReturnType<typeof setTimeout> | null;
}

interface ScopeWatcher {
  scope: string;
  /** session_id → entry. */
  cache: Map<string, PresenceEntry>;
  handlers: Set<WatchHandler>;
}

export interface ScopedPresenceDeps {
  client: ReturnType<typeof createRequestClient>;
  events: Pick<EventsApi, "subscribe">;
  /** Defaults to process.env["PLUGIN_SLUG"]; injectable for tests. */
  pluginSlug?: string | undefined;
}

export interface ScopedPresenceApi {
  join(
    scope: string,
    userId: string,
    meta?: Record<string, unknown>,
  ): Promise<() => Promise<void>>;
  leave(scope: string, userId: string): Promise<void>;
  update(scope: string, userId: string, meta: Record<string, unknown>): Promise<void>;
  watch(
    scope: string,
    callback: (entries: PresenceEntry[]) => void,
    options?: { coalesceMs?: number },
  ): Promise<() => void>;
  list(scope: string): Promise<PresenceEntry[]>;
}

export function createScopedPresenceApi(deps: ScopedPresenceDeps): ScopedPresenceApi {
  const pluginSlug = readPluginSlug(deps.pluginSlug ?? process.env["PLUGIN_SLUG"]);
  const watchersByScope = new Map<string, ScopeWatcher>();
  let busSubscribed = false;
  let busSubscribePromise: Promise<void> | null = null;

  function fqScope(unprefixed: string): string {
    return `${pluginSlug}.${unprefixed}`;
  }

  function requireSession(): string {
    const sessionId = getCurrentSession();
    if (sessionId === undefined) {
      throw new SdkError(
        "PRESENCE_NO_SESSION_CONTEXT",
        "sdk.presence.join/leave/update can only be called inside a sdk.handle() handler. They infer the originating WS session from the active request context, which does not exist for sdk.schedule ticks or event handlers.",
      );
    }
    return sessionId;
  }

  // -------------------------------------------------------------------------
  // join / leave / update / list — IPC round-trips
  // -------------------------------------------------------------------------

  async function join(
    scope: string,
    userId: string,
    meta?: Record<string, unknown>,
  ): Promise<() => Promise<void>> {
    const sessionId = requireSession();
    const message: IpcMessage = {
      type: "presence.join",
      scope,
      user_id: userId,
      session_id: sessionId,
    };
    if (meta !== undefined) message["meta"] = meta;

    await deps.client.sendAndWait(PresenceJoinResult, message);

    let leftAlready = false;
    return async () => {
      if (leftAlready) return;
      leftAlready = true;
      // Use the same scope path the plugin passed; the runtime will re-prefix.
      // We swallow errors here because the leave function may run during a
      // teardown after the session is gone — surfacing PRESENCE_SESSION_GONE
      // back to a finally{} block would obscure the original error.
      try {
        await deps.client.sendAndWait(unknownResult, {
          type: "presence.leave",
          scope,
          user_id: userId,
          session_id: sessionId,
        });
      } catch {
        // best-effort
      }
    };
  }

  async function leave(scope: string, userId: string): Promise<void> {
    const sessionId = requireSession();
    await deps.client.sendAndWait(unknownResult, {
      type: "presence.leave",
      scope,
      user_id: userId,
      session_id: sessionId,
    });
  }

  async function update(
    scope: string,
    userId: string,
    meta: Record<string, unknown>,
  ): Promise<void> {
    const sessionId = requireSession();
    await deps.client.sendAndWait(unknownResult, {
      type: "presence.update",
      scope,
      user_id: userId,
      meta,
      session_id: sessionId,
    });
  }

  async function list(scope: string): Promise<PresenceEntry[]> {
    const result = await deps.client.sendAndWait(PresenceListResult, {
      type: "presence.list",
      scope,
    });
    if (!result) return [];
    return [...result];
  }

  // -------------------------------------------------------------------------
  // watch — bus subscription + per-handler coalescing
  // -------------------------------------------------------------------------

  async function ensureBusSubscribed(): Promise<void> {
    if (busSubscribed) return;
    if (busSubscribePromise) return busSubscribePromise;

    busSubscribePromise = (async () => {
      await deps.events.subscribe(RUNTIME_PRESENCE_TOPICS.JOINED, applyJoined);
      await deps.events.subscribe(RUNTIME_PRESENCE_TOPICS.UPDATED, applyUpdated);
      await deps.events.subscribe(RUNTIME_PRESENCE_TOPICS.LEFT, applyLeft);
      busSubscribed = true;
    })();
    return busSubscribePromise;
  }

  function applyJoined(msg: IpcEventDeliverMessage): void {
    const p = msg.payload as RuntimePresenceJoinedPayload | null;
    if (!p) return;
    const w = watchersByScope.get(p.scope);
    if (!w) return;
    w.cache.set(p.session_id, payloadToEntry(p));
    scheduleTick(w);
  }

  function applyUpdated(msg: IpcEventDeliverMessage): void {
    const p = msg.payload as RuntimePresenceUpdatedPayload | null;
    if (!p) return;
    const w = watchersByScope.get(p.scope);
    if (!w) return;
    const existing = w.cache.get(p.session_id);
    if (existing) {
      // Preserve original joined_at; only meta + updated_at flow from the event.
      w.cache.set(p.session_id, {
        ...existing,
        meta: p.meta,
        updated_at: p.ts,
      });
    } else {
      // Update for an entry we've never seen — synthesize a partial cache row
      // (joined_at unknown). The next list() seed will correct joined_at.
      w.cache.set(p.session_id, payloadToEntry(p));
    }
    scheduleTick(w);
  }

  function applyLeft(msg: IpcEventDeliverMessage): void {
    const p = msg.payload as RuntimePresenceLeftPayload | null;
    if (!p) return;
    const w = watchersByScope.get(p.scope);
    if (!w) return;
    w.cache.delete(p.session_id);
    scheduleTick(w);
  }

  function scheduleTick(w: ScopeWatcher): void {
    for (const h of w.handlers) {
      if (h.coalesceMs === 0) {
        deliver(h, w);
        continue;
      }
      if (h.pendingTimer !== null) continue;
      h.pendingTimer = setTimeout(() => {
        h.pendingTimer = null;
        deliver(h, w);
      }, h.coalesceMs);
    }
  }

  function deliver(h: WatchHandler, w: ScopeWatcher): void {
    try {
      h.cb([...w.cache.values()]);
    } catch {
      // Per spec, handler errors are isolated — they don't poison sibling handlers.
    }
  }

  async function watch(
    scope: string,
    callback: (entries: PresenceEntry[]) => void,
    options?: { coalesceMs?: number },
  ): Promise<() => void> {
    const fq = fqScope(scope);

    // Subscribe FIRST so any change between subscribe and list is captured
    // by the live applyJoined/applyUpdated/applyLeft writers into the cache.
    await ensureBusSubscribed();

    let watcher = watchersByScope.get(fq);
    if (!watcher) {
      watcher = { scope: fq, cache: new Map(), handlers: new Set() };
      watchersByScope.set(fq, watcher);
    }

    // Seed via list(); merge with newer-wins so any concurrent event already
    // applied to the cache wins over a stale list snapshot.
    const seed = await list(scope);
    for (const s of seed) {
      const existing = watcher.cache.get(s.session_id);
      if (!existing || existing.updated_at < s.updated_at) {
        watcher.cache.set(s.session_id, s);
      }
    }

    const coalesceMs = clamp(
      options?.coalesceMs ?? COALESCE_DEFAULT_MS,
      COALESCE_MIN_MS,
      COALESCE_MAX_MS,
    );
    const handler: WatchHandler = { cb: callback, coalesceMs, pendingTimer: null };
    watcher.handlers.add(handler);

    // Initial delivery — synchronous if coalesceMs === 0, otherwise schedules.
    scheduleTick(watcher);

    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      if (handler.pendingTimer !== null) {
        clearTimeout(handler.pendingTimer);
        handler.pendingTimer = null;
      }
      const w = watchersByScope.get(fq);
      if (!w) return;
      w.handlers.delete(handler);
      if (w.handlers.size === 0) {
        // Last handler — drop the cache. Bus subscriptions persist for any
        // future watcher on this or another scope.
        watchersByScope.delete(fq);
      }
    };
  }

  return { join, leave, update, watch, list };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function payloadToEntry(p: RuntimePresenceJoinedPayload): PresenceEntry {
  return {
    scope: p.scope,
    user_id: p.user_id,
    session_id: p.session_id,
    meta: p.meta,
    joined_at: p.ts,
    updated_at: p.ts,
  };
}

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
