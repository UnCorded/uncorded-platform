// One WebSocket connection per active server.
// Auth handshake: first message sent is { type: "auth", token }.
// Incoming messages are routed to registered plugin iframe handlers.
// Reconnects with exponential backoff on transient failures.
//
// WS path is /ws — confirmed from runtime/src/ws/server.ts:102.
//
// Response routing: ResponseMessage has no `plugin` field, so we track
// requestId → slug in pendingRequests and demux by ID on the way back.
// Events are broadcast to all registered plugin handlers.
//
// Race fix: handlers registered before the connection resolves (during
// getServerToken await) are buffered in pendingHandlers and flushed on open.

import { encode as msgpackEncode, decode as msgpackDecode } from "@msgpack/msgpack";
import type {
  ClientMessage,
  ServerMessage,
  WsCoViewListChanged,
} from "@uncorded/protocol";
import { ServerMessageSchema } from "@uncorded/protocol-schemas";
import * as central from "../api/central";
import { storeToken, clearToken, getCachedToken } from "./tokens";
import { bootTrace } from "./boot-trace";
import { ApiError } from "../api/types";
import type { Server } from "../api/types";
import { serverById, patchServer as patchServerStore } from "../stores/servers";

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_PENDING_REQUESTS = 100;

type MessageHandler = (data: unknown) => void;

// Co-View Sessions (spec-27 PR-CV5): subscriber API. Two distinct subscription
// axes:
//   1. `coViewListSubscribers` — fan-out for `co-view.list.changed` push frames
//      (the server-pushed delta on the active-sessions roster). One subscriber
//      per Co-View sheet in the workspace; usually zero or one per server.
//   2. `coViewSessionSubscribers` — fan-out for the per-session push family
//      (`member.joined/left`, `ended`, `state`, `event`, `cursor`,
//      `snapshot.res`). Each subscriber filters by `session_id` via its
//      predicate so a single workspace can have separate viewer + host
//      consumers without crosstalk. Predicate exceptions are caught so one
//      buggy consumer can't poison delivery to siblings.
// `*.ack/nak` and `co-view.list.res` flow through the existing request_id
// path (`pendingRequests` / `__req:<id>` handlers) — not these subscriber
// sets.
export type CoViewListMessage = WsCoViewListChanged;
export type CoViewListHandler = (msg: CoViewListMessage) => void;

// Projected render-tree frames (CV-FOUND-6) ride their own dedicated subscriber
// set — NOT the legacy `coViewSessionSubscribers` family — so the gated,
// sanitized-viewer feature stays isolated from the live state/cursor/pen
// consumers. The frame already passes `ServerMessageSchema`; this set is the
// website-side receive path that lands it in the projected-frame store. Dormant
// until a viewer surface subscribes (`CO_VIEW_PROJECTED_VIEWER_ENABLED`).
export type CoViewRenderTreeProjectedMessage = Extract<
  ServerMessage,
  { type: "co-view.render-tree.projected" }
>;
export type CoViewRenderTreeProjectedHandler = (
  msg: CoViewRenderTreeProjectedMessage,
) => void;

export type CoViewSessionMessage = Extract<
  ServerMessage,
  {
    type:
      | "co-view.member.joined"
      | "co-view.member.left"
      | "co-view.ended"
      | "co-view.state"
      | "co-view.event"
      | "co-view.cursor"
      | "co-view.snapshot.req"
      | "co-view.snapshot.res";
  }
>;
export type CoViewSessionPredicate = (msg: CoViewSessionMessage) => boolean;
export type CoViewSessionHandler = (msg: CoViewSessionMessage) => void;
interface CoViewSessionSubscription {
  predicate: CoViewSessionPredicate;
  handler: CoViewSessionHandler;
}

// Lifecycle ack/nak + list.res frames ride a dedicated subscriber set rather
// than the standard `response` envelope: their wire shape is a typed frame
// keyed by `session_id` (or `request_id` for list.res), not a `{type:
// "response", id}` envelope. The Co-View client wrapper subscribes once and
// demuxes by frame `type` + `session_id` to settle the matching pending
// promise. Keeping this separate from the session push family avoids fanning
// transient one-shot replies out to every viewer overlay.
export type CoViewAckMessage = Extract<
  ServerMessage,
  {
    type:
      | "co-view.start.ack"
      | "co-view.start.nak"
      | "co-view.update.ack"
      | "co-view.update.nak"
      | "co-view.end.ack"
      | "co-view.join.ack"
      | "co-view.join.nak"
      | "co-view.leave.ack"
      | "co-view.kick.ack"
      | "co-view.kick.nak"
      | "co-view.list.res";
  }
>;
export type CoViewAckHandler = (msg: CoViewAckMessage) => void;

interface PendingRequest {
  handlerKey: string;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

interface Connection {
  ws: WebSocket;
  serverId: string;
  /** slug → handler for inbound message dispatch */
  handlers: Map<string, MessageHandler>;
  /** clientRequestId → pending request entry for response demux */
  pendingRequests: Map<string, PendingRequest>;
  /** Active co-view.list.changed subscribers (this server's roster). */
  coViewListSubscribers: Set<CoViewListHandler>;
  /** Active co-view session push subscribers; predicate filters by session_id. */
  coViewSessionSubscribers: Set<CoViewSessionSubscription>;
  /** Active co-view ack/nak/list.res subscribers (lifecycle one-shot replies). */
  coViewAckSubscribers: Set<CoViewAckHandler>;
  /** Active co-view.render-tree.projected subscribers (CV-FOUND-6 receive path). */
  coViewRenderTreeProjectedSubscribers: Set<CoViewRenderTreeProjectedHandler>;
  backoff: number;
  dead: boolean;
  /** Set true when the server confirms the auth handshake (auth.result ok:true).
   *  The runtime records the JWT's JTI in its replay-prevention map at that
   *  moment, so the cached token is one-shot from there on. onclose uses this
   *  flag to decide whether the cached token must be discarded for the next
   *  reconnect. */
  authenticated: boolean;
}

const connections = new Map<string, Connection>();
/** Handlers registered before the WS connection resolves; flushed on open. */
const pendingHandlers = new Map<string, Map<string, MessageHandler>>();
/** Co-view list subscribers registered before the WS connection resolves. */
const pendingCoViewListSubscribers = new Map<string, Set<CoViewListHandler>>();
/** Co-view session subscribers registered before the WS connection resolves. */
const pendingCoViewSessionSubscribers = new Map<string, Set<CoViewSessionSubscription>>();
/** Co-view ack/nak subscribers registered before the WS connection resolves. */
const pendingCoViewAckSubscribers = new Map<string, Set<CoViewAckHandler>>();
/** Co-view projected-frame subscribers registered before the WS connection resolves. */
const pendingCoViewRenderTreeProjectedSubscribers = new Map<
  string,
  Set<CoViewRenderTreeProjectedHandler>
>();
/** Messages sent before the WS connection resolves; flushed on open.
 *  Plugin iframes can mount and fire getMessages before the WS finishes its
 *  auth handshake (workspace layouts load over HTTP, independent of WS), so
 *  without this queue those initial requests would silently vanish and the
 *  iframe would sit at "Loading…" until its 30s timeout. */
const pendingSends = new Map<string, Array<{ msg: ClientMessage; handlerKey?: string | undefined; queuedAt: number }>>();
const MAX_PENDING_SEND_QUEUE = 50;
// Queued messages that still haven't flushed after this long are dropped.
// Aligned with REQUEST_TIMEOUT_MS and the plugin SDK's 30s caller budget so
// that cold-start (runtime container warming up, can take 10-25s before WS
// upgrades succeed) doesn't drop sidebar/membership/getMessages requests
// before the caller's own timeout fires. Ghost-delivery risk for mutating
// requests is bounded by the same 30s caller window — if a queued mutation
// flushes after the caller has rejected, the server still processes it, but
// no shell write path issues mutations during the cold-start window (those
// require user interaction post-load).
const PENDING_SEND_TTL_MS = 30_000;

/** Callbacks fired whenever a new connection is successfully opened (after auth sent). */
const reconnectCallbacks = new Set<(serverId: string) => void>();
const disconnectCallbacks = new Set<(serverId: string) => void>();
/** Callbacks fired on WS open (true) — but NOT on close, since the server may still be up. */
const connectCallbacks = new Set<(serverId: string) => void>();

/** Pending scheduled reconnect timers by serverId. A setTimeout closure can't
 *  see a future `dead` flag flip — the only safe cancellation is clearTimeout.
 *  Without this, a scheduled reconnect set BEFORE disconnect runs fires AFTER
 *  disconnect has emptied `connections`, and the callback's `!connections.has`
 *  guard becomes TRUE — re-opening a socket we just tore down. */
const reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** In-flight openConnection promises per server-id. Both sidebar.ts and
 * membership.ts run a createEffect that calls connect(server) when the
 * active server changes — those effects fire on the same tick. Without
 * this dedupe, both pass connect()'s `connections.get(id)` short-circuit
 * (the entry isn't registered until AFTER getServerToken resolves), each
 * mints its own JWT, and opens its own WebSocket. The duplicate sockets
 * race the runtime's async-message auth handler: Bun fires `async message`
 * handlers concurrently, so a frame queued behind the auth frame on the
 * second socket arrives before `ws.data.authenticated` flips true and the
 * runtime closes it with 4002 "First message must be auth". The orphan
 * onclose then deletes the OTHER (live) conn from `connections` and
 * clearTokens — leaving the cached JWT's JTI recorded in the runtime
 * `seenJtis` map. The next reconnect reuses the cached token and gets
 * 4001 "Token already used". */
const openInFlight = new Map<string, Promise<void>>();

/** Cancel any pending scheduled reconnect for this server. Called by disconnect
 *  (to stop a pending reconnect from resurrecting a torn-down connection) and
 *  by purgeServer before disconnect (same reason, explicit). */
export function abortReconnect(serverId: string): void {
  const timer = reconnectTimers.get(serverId);
  if (timer !== undefined) {
    clearTimeout(timer);
    reconnectTimers.delete(serverId);
  }
}

export function onReconnect(cb: (serverId: string) => void): () => void {
  reconnectCallbacks.add(cb);
  return () => { reconnectCallbacks.delete(cb); };
}

/** Fires once per successful WS open (after the auth handshake delay). */
export function onConnect(cb: (serverId: string) => void): () => void {
  connectCallbacks.add(cb);
  return () => { connectCallbacks.delete(cb); };
}

/** True if the WS for this server is open AND has completed its auth handshake. */
export function isAuthenticated(serverId: string): boolean {
  const conn = connections.get(serverId);
  if (!conn) return false;
  return conn.ws.readyState === WebSocket.OPEN && conn.authenticated;
}

/** Fires when the WS for a server transitions to closed (intentional or not). */
export function onDisconnect(cb: (serverId: string) => void): () => void {
  disconnectCallbacks.add(cb);
  return () => { disconnectCallbacks.delete(cb); };
}

// Register a handler for messages destined for a specific plugin on a server.
// handlerKey defaults to slug but can be overridden (e.g. panelId:slug for multi-panel).
export function onPluginMessage(
  serverId: string,
  slug: string,
  handler: MessageHandler,
  handlerKey?: string,
): () => void {
  const key = handlerKey ?? slug;
  const conn = connections.get(serverId);
  if (conn) {
    conn.handlers.set(key, handler);
  } else {
    // WS not open yet — buffer until openConnection flushes it
    let pending = pendingHandlers.get(serverId);
    if (!pending) {
      pending = new Map();
      pendingHandlers.set(serverId, pending);
    }
    pending.set(key, handler);
  }
  return () => {
    // Identity-check delete. During a panel swap the same handlerKey is
    // register→register→unregister→unregister across two PluginFrames: the new
    // one overwrites the entry, then the old one's cleanup runs and would
    // evict the new handler if we deleted unconditionally. Only delete if the
    // current entry is still ours.
    const c = connections.get(serverId);
    if (c && c.handlers.get(key) === handler) c.handlers.delete(key);
    const p = pendingHandlers.get(serverId);
    if (p && p.get(key) === handler) p.delete(key);
  };
}

// Subscribe to inbound `co-view.list.changed` frames for the given server.
// Returns an unsubscribe function. Safe to call before the WS is open — the
// subscription is buffered and flushed by openConnection.
export function onCoViewListMessage(
  serverId: string,
  handler: CoViewListHandler,
): () => void {
  const conn = connections.get(serverId);
  if (conn) {
    conn.coViewListSubscribers.add(handler);
  } else {
    let pending = pendingCoViewListSubscribers.get(serverId);
    if (!pending) {
      pending = new Set();
      pendingCoViewListSubscribers.set(serverId, pending);
    }
    pending.add(handler);
  }
  return () => {
    const c = connections.get(serverId);
    c?.coViewListSubscribers.delete(handler);
    pendingCoViewListSubscribers.get(serverId)?.delete(handler);
  };
}

// Subscribe to inbound `co-view.<session-push>` frames for the given server.
// `predicate` typically filters by `session_id`. Same buffer-and-flush model
// as the other subscriber sets.
export function onCoViewSessionMessage(
  serverId: string,
  predicate: CoViewSessionPredicate,
  handler: CoViewSessionHandler,
): () => void {
  const sub: CoViewSessionSubscription = { predicate, handler };
  const conn = connections.get(serverId);
  if (conn) {
    conn.coViewSessionSubscribers.add(sub);
  } else {
    let pending = pendingCoViewSessionSubscribers.get(serverId);
    if (!pending) {
      pending = new Set();
      pendingCoViewSessionSubscribers.set(serverId, pending);
    }
    pending.add(sub);
  }
  return () => {
    const c = connections.get(serverId);
    c?.coViewSessionSubscribers.delete(sub);
    pendingCoViewSessionSubscribers.get(serverId)?.delete(sub);
  };
}

// Subscribe to inbound co-view ack/nak/list.res frames. The Co-View client
// wrapper is the only intended subscriber here; it demuxes by frame type +
// session_id (or request_id for list.res) and resolves the matching pending
// promise.
export function onCoViewAckMessage(
  serverId: string,
  handler: CoViewAckHandler,
): () => void {
  const conn = connections.get(serverId);
  if (conn) {
    conn.coViewAckSubscribers.add(handler);
  } else {
    let pending = pendingCoViewAckSubscribers.get(serverId);
    if (!pending) {
      pending = new Set();
      pendingCoViewAckSubscribers.set(serverId, pending);
    }
    pending.add(handler);
  }
  return () => {
    const c = connections.get(serverId);
    c?.coViewAckSubscribers.delete(handler);
    pendingCoViewAckSubscribers.get(serverId)?.delete(handler);
  };
}

// Subscribe to inbound `co-view.render-tree.projected` frames for the given
// server (CV-FOUND-6). Same buffer-and-flush model as the other subscriber
// sets. The projected-frame store is the intended subscriber; it demuxes by
// `session_id` internally. Returns an unsubscribe function.
export function onCoViewRenderTreeProjected(
  serverId: string,
  handler: CoViewRenderTreeProjectedHandler,
): () => void {
  const conn = connections.get(serverId);
  if (conn) {
    conn.coViewRenderTreeProjectedSubscribers.add(handler);
  } else {
    let pending = pendingCoViewRenderTreeProjectedSubscribers.get(serverId);
    if (!pending) {
      pending = new Set();
      pendingCoViewRenderTreeProjectedSubscribers.set(serverId, pending);
    }
    pending.add(handler);
  }
  return () => {
    const c = connections.get(serverId);
    c?.coViewRenderTreeProjectedSubscribers.delete(handler);
    pendingCoViewRenderTreeProjectedSubscribers.get(serverId)?.delete(handler);
  };
}

// Send a one-shot request to a plugin and return the result as a Promise.
// Safe to call before the WS is OPEN — the handler is buffered into
// pendingHandlers and the send into pendingSends, both flushed on ws.onopen.
// Without this buffering, the shell's own request() (sidebar.items, etc.)
// raced the auth handshake and silently rejected in dev, leaving the Chat
// section missing; iframe panels worked because their relay uses send() which
// already queues.
export function request<T>(
  serverId: string,
  plugin: string,
  action: string,
  params: Record<string, unknown> = {},
  options: {
    // Matches the plugin SDK's REQUEST_TIMEOUT_MS (30s) and PENDING_SEND_TTL_MS.
    // Cold-start can take 10-25s on a freshly-started runtime container; with
    // the previous 10s default the sidebar / membership / category-list calls
    // rejected before the WS finished its first handshake and the user saw
    // empty sections + "DISCONNECTED" toasts even though the WS was about to
    // open successfully one second later.
    timeoutMs?: number;
    // Optional AbortSignal — when aborted, the pending request is dropped
    // from local state (handler unregistered, pendingRequests entry removed)
    // and the returned Promise rejects with `signal.reason`. The runtime side
    // still completes the work; only the client-side wait is cancelled.
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  const { timeoutMs = 30_000, signal } = options;
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Request aborted"));
      return;
    }
    const id = crypto.randomUUID();
    const handlerKey = `__req:${id}`;

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Request ${plugin}.${action} timed out`));
    }, timeoutMs);

    let unregister: (() => void) | null = null;
    function cleanup() {
      clearTimeout(timer);
      connections.get(serverId)?.pendingRequests.delete(id);
      if (unregister) unregister();
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }

    const onAbort = signal
      ? () => {
          cleanup();
          reject(signal.reason ?? new Error("Request aborted"));
        }
      : null;
    if (onAbort) signal?.addEventListener("abort", onAbort, { once: true });

    const handler = (data: unknown) => {
      const msg = data as Record<string, unknown>;
      if (msg["id"] !== id) return;
      cleanup();
      if (msg["error"]) {
        const err = msg["error"] as { message?: string; code?: string };
        // Attach `code` to the rejected Error so typed callers (e.g.
        // lib/core-client.ts wrapping Amendment B mutations) can distinguish
        // FORBIDDEN from HIERARCHY_VIOLATION etc. without parsing messages.
        const e = new Error(err.message ?? "Request failed") as Error & { code?: string };
        if (typeof err.code === "string") e.code = err.code;
        reject(e);
      } else {
        resolve(msg["result"] as T);
      }
    };

    // onPluginMessage buffers into pendingHandlers if WS isn't up yet.
    unregister = onPluginMessage(serverId, plugin, handler, handlerKey);
    // send() queues into pendingSends if WS isn't OPEN; both buffers flush on open.
    send(serverId, { type: "request", id, plugin, action, params });
  });
}

// Send a message to the server over its WebSocket.
// handlerKey overrides msg.plugin for response routing (used by plugin iframes in panels).
export function send(serverId: string, msg: ClientMessage, handlerKey?: string): void {
  const conn = connections.get(serverId);
  // Hold sends until the server has confirmed auth (auth.result ok:true).
  // Bun's `async message` handler runs concurrently per-frame on the same WS,
  // so a non-auth frame sent in the same tick as the auth frame races the
  // runtime's `await tokenValidator.validate()` — handler #2 sees
  // ws.data.authenticated=false and closes 4002 "First message must be auth".
  // The auth.result handler drains this queue once authentication completes.
  if (!conn || conn.ws.readyState !== WebSocket.OPEN || !conn.authenticated) {
    // WS not open / not yet authenticated / gone. Queue so the auth.result
    // handler (or the next openConnection) can flush. Drop silently past the
    // cap — better than unbounded memory growth if the connection never comes
    // up.
    let queue = pendingSends.get(serverId);
    if (!queue) {
      queue = [];
      pendingSends.set(serverId, queue);
    }
    if (queue.length >= MAX_PENDING_SEND_QUEUE) {
      console.warn("[ws] pending send queue full — dropping message", { serverId, type: msg.type });
      return;
    }
    queue.push({ msg, handlerKey, queuedAt: Date.now() });
    return;
  }
  // Track outbound requests so we can route the response back to the right plugin iframe.
  if (msg.type === "request") {
    if (conn.pendingRequests.size >= MAX_PENDING_REQUESTS) {
      // Too many in-flight requests — drop this one to prevent unbounded map growth.
      // The plugin iframe's own 30s timeout will surface the error to the user.
      console.warn("[ws] pendingRequests cap reached — dropping request", { serverId, id: msg.id, plugin: msg.plugin });
      return;
    }
    const timeoutHandle = setTimeout(() => {
      conn.pendingRequests.delete(msg.id);
    }, REQUEST_TIMEOUT_MS);
    conn.pendingRequests.set(msg.id, { handlerKey: handlerKey ?? msg.plugin, timeoutHandle });
  }
  conn.ws.send(msgpackEncode(msg));
}

// Open a connection to a server. Safe to call multiple times — no-ops if already connected.
// A stale CLOSED/CLOSING entry in `connections` (from a handshake that failed without
// firing onclose cleanly, or while a reconnect is in-flight) would otherwise cause
// this to short-circuit forever and every subsequent request to silently queue+timeout.
export async function connect(server: Server): Promise<void> {
  // No tunnel_url guard here: the URL is a capability resolved (and hydrated
  // into the store) by openConnection's token mint, not list metadata.
  const existing = connections.get(server.id);
  if (existing) {
    const state = existing.ws.readyState;
    if (state === WebSocket.OPEN || state === WebSocket.CONNECTING) {
      bootTrace("ws.connect.skip", { serverId: server.id, state });
      return;
    }
    // CLOSING or CLOSED — treat as gone, tear down and reopen.
    bootTrace("ws.connect.tearDownStale", { serverId: server.id, state });
    existing.dead = true;
    connections.delete(server.id);
  }
  bootTrace("ws.connect.openConnection", { serverId: server.id });
  await openConnection(server, 1000);
}

// Disconnect and clean up.
export function disconnect(serverId: string): void {
  // Cancel any pending scheduled reconnect FIRST — otherwise a timer set
  // before this call fires after connections.delete and re-opens the socket.
  abortReconnect(serverId);
  const conn = connections.get(serverId);
  if (!conn) return;
  conn.dead = true;
  conn.ws.close(1000, "Navigated away");
  clearToken(serverId);
  connections.delete(serverId);
  pendingHandlers.delete(serverId);
  pendingCoViewListSubscribers.delete(serverId);
  pendingCoViewSessionSubscribers.delete(serverId);
  pendingCoViewAckSubscribers.delete(serverId);
  pendingCoViewRenderTreeProjectedSubscribers.delete(serverId);
  pendingSends.delete(serverId);
}

/**
 * Force an immediate reconnect, bypassing any pending exponential-backoff timer.
 *
 * Used by the wizard (spec-10 Amendment A) the moment its background tunnel
 * probe goes green or the user clicks "Switch to server anyway" — without
 * this, the WS layer could be mid-backoff for up to 30s after the dialog
 * closes, leaving the sidebar empty long after the tunnel propagated.
 *
 * No-op if a connection is already OPEN or CONNECTING for this server. If a
 * CLOSED/CLOSING stale entry exists, it is torn down before reopen.
 */
export async function forceReconnect(server: Server): Promise<void> {
  abortReconnect(server.id);
  const existing = connections.get(server.id);
  if (existing) {
    const state = existing.ws.readyState;
    if (state === WebSocket.OPEN || state === WebSocket.CONNECTING) {
      bootTrace("ws.forceReconnect.skip", { serverId: server.id, state });
      return;
    }
    bootTrace("ws.forceReconnect.tearDownStale", { serverId: server.id, state });
    existing.dead = true;
    connections.delete(server.id);
  }
  bootTrace("ws.forceReconnect.openConnection", { serverId: server.id });
  await openConnection(server, 1000);
}

/** Disconnect every active server WebSocket. Used on logout / session expiry. */
export function disconnectAll(): void {
  for (const serverId of Array.from(connections.keys())) {
    disconnect(serverId);
  }
}

function openConnection(server: Server, backoff: number): Promise<void> {
  // Coalesce parallel callers (connect() from multiple stores, scheduleReconnect
  // racing with a fresh connect()) onto a single in-flight openConnection per
  // server-id. See `openInFlight` declaration for the failure mode this prevents.
  const existing = openInFlight.get(server.id);
  if (existing) return existing;
  const promise = openConnectionInner(server, backoff);
  openInFlight.set(server.id, promise);
  // Detach so the cleanup runs even if no one awaits the returned promise.
  void promise.finally(() => {
    if (openInFlight.get(server.id) === promise) {
      openInFlight.delete(server.id);
    }
  });
  return promise;
}

async function openConnectionInner(
  server: Server,
  backoff: number,
): Promise<void> {
  // Expired-tunnel gate. A demo tunnel that hit its 24h TTL (WS3) reports
  // tunnel_state="expired" and the runtime falls its public URL back to a
  // local one that no remote client can reach. Refuse to dial — and don't
  // mint a token — so we don't burn reconnect cycles on a dead address; the
  // active-server view shows the blocking "restart the desktop app" gate
  // instead. Re-resolve live from the store because the `server` captured by
  // a pending scheduleReconnect timer can be stale (still "demo"); fall back
  // to the passed value when the store hasn't loaded it. Detect via
  // tunnel_state ONLY — never by string-matching the tunnel hostname.
  const liveState = (serverById(server.id) ?? server).tunnel_state;
  if (liveState === "expired") {
    bootTrace("ws.open.expiredGate", { serverId: server.id });
    return;
  }

  let tokenData: { token: string; expires_at: number };
  // The token mint is also the only place Central reveals tunnel_url (a
  // membership capability — list responses don't carry it). A fresh mint
  // hydrates the store via patchServer so panels resolving through
  // serverById() see the URL; the cached-token path reuses the stored value.
  let mintedUrl: string | null = null;
  // Reuse the cached token across transient reconnects. The cache survives
  // ws.onclose now (it's only cleared by intentional teardown via disconnect),
  // so a network blip → reconnect cycle no longer hits Central. tokens.ts
  // returns null for entries past their expires_at, so this can never use a
  // stale token.
  const cached = getCachedToken(server.id);
  if (cached) {
    bootTrace("ws.token.cached", { serverId: server.id });
    tokenData = cached;
  } else {
    bootTrace("ws.token.fetch.start", { serverId: server.id });
    try {
      const minted = await central.getServerToken(server.id);
      tokenData = minted;
      mintedUrl = minted.tunnel_url;
      if (mintedUrl && serverById(server.id)?.tunnel_url !== mintedUrl) {
        patchServerStore(server.id, { tunnel_url: mintedUrl });
      }
      bootTrace("ws.token.fetch.done", { serverId: server.id });
    } catch (err) {
      bootTrace("ws.token.fetch.error", { serverId: server.id, error: String(err) });
      // 404 = Central no longer has this server (deleted by owner, or this client
      // is holding a stale id). 403 = user banned. Either way, don't schedule a
      // reconnect — it'll just 404/403 again. Funnel through purgeServer so the
      // sidebar, panels, and any pending autosaves get the same teardown path
      // that a manual delete takes. Dynamic import matches the onclose 4003
      // branch: server-purge imports disconnect/abortReconnect from this module.
      if (err instanceof ApiError) {
        if (err.status === 404) {
          void import("./server-purge").then(({ purgeServer }) => {
            void purgeServer(server.id, "central-gone");
          });
          return;
        }
        if (err.status === 403) {
          void import("./server-purge").then(({ purgeServer }) => {
            void purgeServer(server.id, "banned");
          });
          return;
        }
      }
      scheduleReconnect(server, backoff);
      return;
    }
  }

  // Dial-URL resolution order: this mint's URL → live store value (hydrated
  // by an earlier mint) → the caller's snapshot. A server that has never
  // tunneled has none — bail without scheduling, and drop any cached token
  // so the next connect attempt (fired by the 60s membership poll flipping
  // is_online) re-mints and re-resolves the URL instead of being stuck
  // URL-less until token expiry.
  const dialUrlString =
    mintedUrl ?? (serverById(server.id) ?? server).tunnel_url;
  if (!dialUrlString) {
    bootTrace("ws.open.noTunnelUrl", { serverId: server.id });
    clearToken(server.id);
    return;
  }

  // Server-controlled tunnel_url; still, string replace on "http" matches the
  // scheme *and* any later occurrence, so use the URL API to swap only the
  // scheme cleanly (https → wss, http → ws) and append the path.
  const tunnelUrl = new URL(dialUrlString);
  tunnelUrl.protocol = tunnelUrl.protocol === "https:" ? "wss:" : "ws:";
  tunnelUrl.pathname = "/ws";
  bootTrace("ws.socket.new", { serverId: server.id, url: tunnelUrl.toString() });
  const ws = new WebSocket(tunnelUrl.toString());
  ws.binaryType = "arraybuffer";

  const conn: Connection = {
    ws,
    serverId: server.id,
    handlers: new Map(),
    pendingRequests: new Map(),
    coViewListSubscribers: new Set(),
    coViewSessionSubscribers: new Set(),
    coViewAckSubscribers: new Set(),
    coViewRenderTreeProjectedSubscribers: new Set(),
    backoff,
    dead: false,
    authenticated: false,
  };
  connections.set(server.id, conn);

  // Flush any handlers that registered while getServerToken was in-flight.
  const buffered = pendingHandlers.get(server.id);
  if (buffered) {
    for (const [slug, handler] of buffered) {
      conn.handlers.set(slug, handler);
    }
    pendingHandlers.delete(server.id);
  }

  // Flush co-view subscribers registered while getServerToken was in-flight —
  // Co-View sheets and viewer
  // overlays may register before the WS finishes its auth handshake.
  const bufferedCvList = pendingCoViewListSubscribers.get(server.id);
  if (bufferedCvList) {
    for (const sub of bufferedCvList) conn.coViewListSubscribers.add(sub);
    pendingCoViewListSubscribers.delete(server.id);
  }
  const bufferedCvSession = pendingCoViewSessionSubscribers.get(server.id);
  if (bufferedCvSession) {
    for (const sub of bufferedCvSession) conn.coViewSessionSubscribers.add(sub);
    pendingCoViewSessionSubscribers.delete(server.id);
  }
  const bufferedCvAck = pendingCoViewAckSubscribers.get(server.id);
  if (bufferedCvAck) {
    for (const sub of bufferedCvAck) conn.coViewAckSubscribers.add(sub);
    pendingCoViewAckSubscribers.delete(server.id);
  }
  const bufferedCvProjected = pendingCoViewRenderTreeProjectedSubscribers.get(server.id);
  if (bufferedCvProjected) {
    for (const sub of bufferedCvProjected) conn.coViewRenderTreeProjectedSubscribers.add(sub);
    pendingCoViewRenderTreeProjectedSubscribers.delete(server.id);
  }

  storeToken(server.id, tokenData.token, tokenData.expires_at, (id) => {
    void refreshToken(id, server);
  });

  // Tracks whether the socket ever reached `open`. A close without open is a
  // connection-level failure — the likeliest cause after a runtime restart is
  // a rotated tunnel URL, so onclose uses this to drop the cached token and
  // force the next attempt to re-mint (which re-resolves the URL from
  // Central). Auth-level failures keep their existing cache semantics.
  let sawOpen = false;

  // Resolve once the socket is actually open so callers of connect() can
  // safely call send() / request() immediately after awaiting connect().
  const openPromise = new Promise<void>((resolve) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    // Also resolve on early close/error so connect() doesn't hang forever.
    ws.addEventListener("close", () => resolve(), { once: true });
  });

  ws.onopen = () => {
    sawOpen = true;
    bootTrace("ws.onopen.authSend", { serverId: server.id });
    // Send ONLY the auth frame here. Bun.serve's `async message` handler runs
    // handlers concurrently for frames on the same socket — there is no
    // internal serialization. The runtime auth handler does
    // `await tokenValidator.validate(token)` which is meaningfully async, so
    // any frame queued behind auth on the same tick reaches handler #2 while
    // ws.data.authenticated is still false and the runtime closes the socket
    // with WS_CLOSE_INVALID_MESSAGE (4002) "First message must be auth".
    // Deferring the pendingSends drain and the connect/reconnect callbacks
    // until auth.result ok:true arrives ensures every subsequent frame is
    // processed by a handler whose closure already saw authenticated=true.
    const authMsg: ClientMessage = { type: "auth", token: tokenData.token };
    ws.send(msgpackEncode(authMsg));
    conn.backoff = 1000;
  };

  ws.onmessage = (event: MessageEvent<ArrayBuffer | string>) => {
    let raw: unknown;
    try {
      if (event.data instanceof ArrayBuffer) {
        raw = msgpackDecode(new Uint8Array(event.data));
      } else {
        raw = JSON.parse(event.data as string); // fallback for text frames
      }
    } catch {
      return;
    }

    // Schema-validate the entire ServerMessage envelope at the boundary so a
    // compromised tunnel or malformed frame can't smuggle nonsense into the
    // dispatcher (which previously trusted msg["type"] strings without shape
    // checks). Drop unknown variants — they're not part of the protocol.
    const parseResult = ServerMessageSchema.safeParse(raw);
    if (!parseResult.success) {
      console.warn("[ws] dropped invalid server message", { issues: parseResult.error.issues });
      return;
    }
    const msg = parseResult.data;

    // Auth handshake completion. The runtime adds the JWT's JTI to its replay
    // map the moment ok:true is sent, so the cached token is now single-use:
    // onclose checks this flag to clear the cache and force a fresh mint on
    // the next reconnect (otherwise the second auth attempt closes with
    // 4001 "Token already used"). On ok:false the runtime closes the socket
    // with 4003/4004; both paths handle the failure independently.
    //
    // ok:true is also our signal to drain pendingSends and fire the connect
    // callbacks. We can't do that in ws.onopen because Bun's `async message`
    // handler runs concurrently — a frame queued right after auth would race
    // the runtime's `await tokenValidator.validate()` and trip the
    // "first message must be auth" guard with close 4002. By gating on
    // auth.result, every subsequent frame is processed by a handler that
    // already observed authenticated=true.
    if (msg.type === "auth.result") {
      if (!msg.ok) {
        bootTrace("ws.auth.result.fail", { serverId: server.id });
        return;
      }
      bootTrace("ws.auth.result.ok", { serverId: server.id });
      conn.authenticated = true;
      const queued = pendingSends.get(server.id);
      if (queued && queued.length > 0) {
        pendingSends.delete(server.id);
        const now = Date.now();
        let dropped = 0;
        for (const { msg: queuedMsg, handlerKey, queuedAt } of queued) {
          if (now - queuedAt > PENDING_SEND_TTL_MS) {
            dropped++;
            continue;
          }
          send(server.id, queuedMsg, handlerKey);
        }
        if (dropped > 0) {
          console.warn("[ws] dropped stale queued sends on flush", { serverId: server.id, dropped });
        }
      }
      bootTrace("ws.auth.callbacks.fire", { serverId: server.id, queuedFlushed: queued?.length ?? 0 });
      for (const cb of reconnectCallbacks) cb(server.id);
      for (const cb of connectCallbacks) cb(server.id);
      return;
    }

    // Responses: demux by request ID → plugin slug
    if (msg.type === "response") {
      const responseId = msg.id;
      // One-shot handlers (from request()) are keyed __req:<id>
      const oneShot = conn.handlers.get(`__req:${responseId}`);
      if (oneShot) {
        conn.handlers.delete(`__req:${responseId}`);
        oneShot(msg);
        return;
      }
      const pending = conn.pendingRequests.get(responseId);
      conn.pendingRequests.delete(responseId);
      if (pending) {
        clearTimeout(pending.timeoutHandle);
        conn.handlers.get(pending.handlerKey)?.(msg);
      }
      return;
    }

    // Events: broadcast to every registered plugin handler
    if (msg.type === "event") {
      for (const handler of conn.handlers.values()) {
        handler(msg);
      }
      return;
    }

    // Co-View list deltas. Server-pushed roster changes for this server.
    if (msg.type === "co-view.list.changed") {
      for (const handler of conn.coViewListSubscribers) {
        try {
          handler(msg);
        } catch (err) {
          console.warn("[ws] co-view list subscriber threw", err);
        }
      }
      return;
    }

    // Co-View lifecycle ack/nak + list.res. Routed to the dedicated ack
    // subscriber set (the client wrapper demuxes by type + session_id).
    if (
      msg.type === "co-view.start.ack" ||
      msg.type === "co-view.start.nak" ||
      msg.type === "co-view.update.ack" ||
      msg.type === "co-view.update.nak" ||
      msg.type === "co-view.end.ack" ||
      msg.type === "co-view.join.ack" ||
      msg.type === "co-view.join.nak" ||
      msg.type === "co-view.leave.ack" ||
      msg.type === "co-view.kick.ack" ||
      msg.type === "co-view.kick.nak" ||
      msg.type === "co-view.list.res"
    ) {
      const ackmsg = msg as CoViewAckMessage;
      for (const handler of conn.coViewAckSubscribers) {
        try {
          handler(ackmsg);
        } catch (err) {
          console.warn("[ws] co-view ack subscriber threw", err);
        }
      }
      return;
    }

    // Co-View per-session push family.
    if (
      msg.type === "co-view.member.joined" ||
      msg.type === "co-view.member.left" ||
      msg.type === "co-view.ended" ||
      msg.type === "co-view.state" ||
      msg.type === "co-view.event" ||
      msg.type === "co-view.cursor" ||
      msg.type === "co-view.snapshot.req" ||
      msg.type === "co-view.snapshot.res"
    ) {
      const cvmsg = msg as CoViewSessionMessage;
      for (const sub of conn.coViewSessionSubscribers) {
        try {
          if (sub.predicate(cvmsg)) sub.handler(cvmsg);
        } catch (err) {
          console.warn("[ws] co-view session subscriber threw", err);
        }
      }
      return;
    }

    // Co-View projected render-tree frames (CV-FOUND-6). Dedicated subscriber
    // set, isolated from the legacy session-push family above. With no
    // subscribers (the production default) this is a no-op.
    if (msg.type === "co-view.render-tree.projected") {
      for (const handler of conn.coViewRenderTreeProjectedSubscribers) {
        try {
          handler(msg);
        } catch (err) {
          console.warn("[ws] co-view projected subscriber threw", err);
        }
      }
      return;
    }
  };

  ws.onerror = () => {
    // onclose fires after onerror; reconnect logic lives there
  };

  ws.onclose = (ev: CloseEvent) => {
    bootTrace("ws.onclose", { serverId: server.id, code: ev.code, reason: ev.reason, authenticated: conn.authenticated, dead: conn.dead });
    // Notify subscribers regardless of dead-flag — consumers need to know their
    // WS dropped even when the workspace teardown triggered the close
    // intentionally.
    for (const cb of disconnectCallbacks) cb(server.id);
    if (conn.dead) return;

    // Reject all in-flight requests immediately so callers get an error
    // instead of waiting 30 seconds for the timeout to fire.
    //
    // IMPORTANT: do NOT delete the handler after rejecting. Iframe handlers
    // are persistent (one per iframe, many requests share it) — deleting
    // it here orphaned every subsequent request for that iframe, even after
    // reconnect. Leave the handler in place; the block below preserves it
    // into pendingHandlers for the next openConnection to restore.
    for (const [requestId, pending] of conn.pendingRequests) {
      clearTimeout(pending.timeoutHandle);
      const handler = conn.handlers.get(pending.handlerKey);
      if (handler) {
        handler({ type: "response", id: requestId, error: { code: "DISCONNECTED", message: "Connection lost — reconnecting" } });
      }
    }
    conn.pendingRequests.clear();

    // Reject queued one-shot requests too. A request() call made while the
    // socket was CONNECTING never reached pendingRequests — it sits in
    // pendingSends with its `__req:<id>` handler in conn.handlers. Without
    // this loop, the handler gets dropped a few lines below (the __req:* skip)
    // and the queued message later flushes onto a fresh socket whose response
    // has nowhere to land — producing a silent 30s timeout. Sidebar.items
    // hit exactly this on cold-start runtime restarts: first WS attempt
    // failed, the request was queued, the handler was discarded here, and
    // the user saw "Request text-channels.sidebar.items timed out".
    const queuedSends = pendingSends.get(server.id);
    if (queuedSends) {
      const survivors: typeof queuedSends = [];
      for (const entry of queuedSends) {
        if (entry.msg.type === "request") {
          const reqId = entry.msg.id;
          const handlerKey = entry.handlerKey ?? `__req:${reqId}`;
          const handler = conn.handlers.get(handlerKey);
          if (handler) {
            handler({
              type: "response",
              id: reqId,
              error: { code: "DISCONNECTED", message: "Connection lost — reconnecting" },
            });
            // Drop the handler too so the caller's request() retry path can
            // register a fresh one without the unregister-by-identity check
            // in onPluginMessage stripping it.
            conn.handlers.delete(handlerKey);
            continue;
          }
        }
        survivors.push(entry);
      }
      if (survivors.length > 0) pendingSends.set(server.id, survivors);
      else pendingSends.delete(server.id);
    }

    // Preserve persistent handlers (iframe relays) into pendingHandlers so
    // the next openConnection picks them up immediately on open.
    // Skip one-shot __req:* handlers — their in-flight requests won't retry.
    if (conn.handlers.size > 0) {
      let pending = pendingHandlers.get(server.id);
      if (!pending) { pending = new Map(); pendingHandlers.set(server.id, pending); }
      for (const [key, handler] of conn.handlers) {
        if (!key.startsWith("__req:")) pending.set(key, handler);
      }
    }

    // Preserve co-view subscribers — an open Co-View
    // sheet or active viewer overlay expects deltas to keep landing after a
    // transient reconnect. The runtime drops its end of the subscription on
    // socket close, but the Co-View client wrapper re-issues `list.req` /
    // re-applies the join's snapshot on reconnect, so the subscribers stay
    // useful.
    if (conn.coViewListSubscribers.size > 0) {
      let pending = pendingCoViewListSubscribers.get(server.id);
      if (!pending) { pending = new Set(); pendingCoViewListSubscribers.set(server.id, pending); }
      for (const sub of conn.coViewListSubscribers) pending.add(sub);
    }
    if (conn.coViewSessionSubscribers.size > 0) {
      let pending = pendingCoViewSessionSubscribers.get(server.id);
      if (!pending) { pending = new Set(); pendingCoViewSessionSubscribers.set(server.id, pending); }
      for (const sub of conn.coViewSessionSubscribers) pending.add(sub);
    }
    if (conn.coViewAckSubscribers.size > 0) {
      let pending = pendingCoViewAckSubscribers.get(server.id);
      if (!pending) { pending = new Set(); pendingCoViewAckSubscribers.set(server.id, pending); }
      for (const sub of conn.coViewAckSubscribers) pending.add(sub);
    }
    if (conn.coViewRenderTreeProjectedSubscribers.size > 0) {
      let pending = pendingCoViewRenderTreeProjectedSubscribers.get(server.id);
      if (!pending) { pending = new Set(); pendingCoViewRenderTreeProjectedSubscribers.set(server.id, pending); }
      for (const sub of conn.coViewRenderTreeProjectedSubscribers) pending.add(sub);
    }

    connections.delete(server.id);
    // The cached JWT is single-use against the runtime's JTI replay map
    // (server.ts seenJtis): once auth.result ok:true arrives, the runtime
    // has recorded this token's JTI and a second auth attempt with the same
    // JWT closes immediately with 4001 "Token already used". So drop the
    // cache the moment a successfully-authenticated socket dies — the next
    // openConnection will mint a fresh token from Central.
    //
    // BEFORE auth succeeded, the JTI was never recorded. Most pre-auth closes
    // (upgrade failure, network reset) preserve the cached token; only 4004
    // clears it (handled below) since that signals the cached token itself
    // may be the problem.
    if (conn.authenticated) {
      clearToken(server.id);
    }

    // Never-opened close: the dial itself failed. Drop the cached token so
    // the reconnect re-mints — the mint carries the current tunnel_url, so a
    // runtime that came back on a NEW quick-tunnel URL heals within one
    // backoff cycle instead of redialing the dead address until token
    // expiry. Cost: one extra mint per failed attempt for a genuinely
    // offline server, bounded by the 30s backoff cap (~2/min).
    if (!sawOpen) {
      clearToken(server.id);
    }

    // 4001 = auth timeout / token already used / server-issued re-sync. All
    //        three want a fresh-token reconnect; the clearToken above (when
    //        applicable) makes that safe.
    // 4003 = user was banned from this server — purge it from local state
    //        (close WS, scrub panels, remove from sidebar). Dynamic import
    //        breaks the cycle: server-purge imports disconnect+abortReconnect
    //        from this module, so importing it statically up top would cycle.
    // 4004 = transient auth: either the runtime is warming its JWKS cache OR
    //        the token's kid no longer exists in Central (SIGNING_KEY_SECRET
    //        rotation). Both look identical from the wire. Clear the cached
    //        token so the reconnect mints a fresh one — JWKS-warmup case
    //        pays one extra Central round-trip; rotation case actually heals.
    //        Without this, a kid-rotation 4004 loops forever because the
    //        reconnect path reuses the dead token from getCachedToken.
    //        Must be checked BEFORE 4003 so a future merge that flips order
    //        doesn't regress.
    if (ev.code === 4004) {
      clearToken(server.id);
      scheduleReconnect(server, conn.backoff);
      return;
    }
    if (ev.code === 4003) {
      void import("./server-purge").then(({ purgeServer }) => {
        void purgeServer(server.id, "banned");
      });
      return;
    }

    scheduleReconnect(server, conn.backoff);
  };

  await openPromise;
}

async function refreshToken(
  serverId: string,
  server: Server,
): Promise<void> {
  const conn = connections.get(serverId);
  if (!conn || conn.dead) return;

  try {
    const tokenData = await central.getServerToken(serverId);
    // Same hydration as the connect path — refresh mints are the URL's
    // steady-state update channel now that list responses don't carry it.
    if (tokenData.tunnel_url && serverById(serverId)?.tunnel_url !== tokenData.tunnel_url) {
      patchServerStore(serverId, { tunnel_url: tokenData.tunnel_url });
    }
    storeToken(serverId, tokenData.token, tokenData.expires_at, (id) => {
      void refreshToken(id, server);
    });

    // Push refreshed token to all registered iframe handlers
    const refreshMsg = {
      type: "uncorded.token",
      token: tokenData.token,
      expiresAt: tokenData.expires_at,
    };
    for (const handler of conn.handlers.values()) {
      handler(refreshMsg);
    }
  } catch (err) {
    // 401 means the Central session itself is gone (logged out elsewhere,
    // revoked, or expired). Silent-catching leaves the user on a server
    // that is "connected" but can no longer mint fresh tokens — hard-logout
    // instead so they land on AuthPage with a clear banner. Dynamic import
    // breaks the module cycle between auth.ts and ws.ts — both files
    // reference each other's exports but only at call time.
    if (err instanceof ApiError && err.status === 401) {
      const { sessionExpired } = await import("../stores/auth");
      sessionExpired("Your session expired. Please sign in again.");
      return;
    }
    // 404 / 403 at refresh time mean Central has deleted or banned this server
    // out from under us. The socket is still live for now — the next event /
    // request will also fail, but there's no reason to wait. Purge locally so
    // panels, sidebar, and autosaves clean up immediately. Same dynamic import
    // dance to break the server-purge ↔ ws.ts cycle.
    if (err instanceof ApiError && err.status === 404) {
      void import("./server-purge").then(({ purgeServer }) => {
        void purgeServer(serverId, "central-gone");
      });
      return;
    }
    if (err instanceof ApiError && err.status === 403) {
      void import("./server-purge").then(({ purgeServer }) => {
        void purgeServer(serverId, "banned");
      });
      return;
    }
    // Other errors (network blip, 5xx) — the WS onclose path will
    // schedule a reconnect which will retry getServerToken.
  }
}

function scheduleReconnect(server: Server, currentBackoff: number): void {
  const next = Math.min(currentBackoff * 2, 30_000);
  // Replace any existing pending timer for this server. Multiple consecutive
  // onclose events on a flapping connection would otherwise leak handles.
  const existing = reconnectTimers.get(server.id);
  if (existing !== undefined) clearTimeout(existing);
  const handle = setTimeout(() => {
    // First statement: we're firing now, remove ourselves from the map so
    // abortReconnect's later clearTimeout is a no-op rather than clearing
    // a stale id and (via timer reuse by the runtime) some unrelated timer.
    reconnectTimers.delete(server.id);
    if (!connections.has(server.id)) {
      void openConnection(server, next);
    }
  }, currentBackoff);
  reconnectTimers.set(server.id, handle);
}
