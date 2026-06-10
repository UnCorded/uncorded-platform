// Server-internal types for the WebSocket layer.
// These are NOT part of the wire protocol — they're runtime implementation details.

import type { ServerWebSocket } from "bun";

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export interface AuthenticatedUser {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string;
  role: string;
}

export type TokenValidationResult =
  | { ok: true; user: AuthenticatedUser; jti?: string | undefined; exp?: number | undefined }
  | { ok: false; code: string; message: string };

/** Injectable token validator — real impl uses Ed25519 JWT verification. */
export interface TokenValidator {
  validate(token: string): Promise<TokenValidationResult>;
}

// ---------------------------------------------------------------------------
// Connected users
// ---------------------------------------------------------------------------

export interface ConnectedUser {
  connectionId: string;
  user: AuthenticatedUser;
  connectedAt: number;
}

// ---------------------------------------------------------------------------
// Per-connection state (stored on ws.data)
//
// A single Bun.serve() accepts two unrelated kinds of socket:
//   - "runtime": the UnCorded WS protocol (auth handshake → MessageRouter).
//   - "proxy":   a reverse-proxy WebSocket bridged to a plugin upstream.
// `kind` discriminates the two so the websocket handlers can branch without
// ever feeding proxy frames into the router (or protocol frames upstream).
// ---------------------------------------------------------------------------

export interface RuntimeWsConnectionData {
  kind: "runtime";
  connectionId: string;
  authenticated: boolean;
  user?: AuthenticatedUser | undefined;
  connectedAt: number;
  authTimer?: ReturnType<typeof setTimeout> | undefined;
  clientIp?: string | undefined;
}

/** A frame in flight between the proxy client and its upstream. */
export type ProxyWsFrame = string | ArrayBuffer | Uint8Array;

/**
 * Mutable per-connection state for a proxied WebSocket. Owns both the upstream
 * client socket and the bounded buffers that absorb backpressure in each
 * direction (no unbounded queue: overflow closes the bridge).
 */
export interface ProxyWsRuntimeState {
  /** Resolved upstream ws(s):// URL. */
  readonly upstreamUrl: string;
  /** Subprotocol echoed to the client (and requested upstream), "" if none. */
  readonly subprotocol: string;
  readonly slug: string;
  readonly mount: string;
  readonly userId: string;
  /** Max frame (message) size relayed in either direction; a larger frame
   *  closes the bridge with 1009. Resolved per mount from its manifest
   *  `max_frame_bytes`, else the bridge default. */
  readonly maxFrameBytes: number;
  /** Per-direction bounded-buffer byte cap. Scaled to hold at least one
   *  `maxFrameBytes` frame so a single large message can absorb backpressure
   *  without overflowing to a 1011 close. */
  readonly maxBufferBytes: number;
  /** The accepted Bun client socket — set in `open()`, cleared on `close()`. */
  client: ServerWebSocket<WsConnectionData> | undefined;
  /** Upstream client socket; undefined once it has been torn down. */
  upstream: WebSocket | undefined;
  /** True once the upstream "open" event has fired. */
  upstreamOpen: boolean;
  /** True once either side has begun closing — suppresses further piping. */
  closing: boolean;
  /** True while the Bun client socket is backpressured (last send() == -1). */
  clientBackpressured: boolean;
  /** Client→upstream frames buffered before upstream open or while congested. */
  toUpstream: ProxyWsFrame[];
  toUpstreamBytes: number;
  /** Upstream→client frames the Bun socket couldn't take yet; flushed on drain. */
  toClient: ProxyWsFrame[];
  toClientBytes: number;
}

export interface ProxyWsConnectionData {
  kind: "proxy";
  connectionId: string;
  connectedAt: number;
  clientIp?: string | undefined;
  proxy: ProxyWsRuntimeState;
}

export type WsConnectionData = RuntimeWsConnectionData | ProxyWsConnectionData;

// ---------------------------------------------------------------------------
// WebSocket close codes (4000-4999 = application-defined per RFC 6455)
// ---------------------------------------------------------------------------

/** No auth message received within the auth timeout window. */
export const WS_CLOSE_AUTH_TIMEOUT = 4001;

/** First message was not a valid auth message. */
export const WS_CLOSE_INVALID_MESSAGE = 4002;

/** Token validation failed (expired, bad signature, wrong server, etc). */
export const WS_CLOSE_AUTH_FAILED = 4003;

/** Token validation failed for a transient reason (key cache stale, server still warming up).
 *  Client should reconnect after Central session refresh, NOT purge the server. */
export const WS_CLOSE_AUTH_RETRYABLE = 4004;

/** Rate limit exceeded. */
export const WS_CLOSE_RATE_LIMITED = 4008;
