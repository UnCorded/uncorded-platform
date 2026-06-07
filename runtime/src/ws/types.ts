// Server-internal types for the WebSocket layer.
// These are NOT part of the wire protocol — they're runtime implementation details.

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
// ---------------------------------------------------------------------------

export interface WsConnectionData {
  connectionId: string;
  authenticated: boolean;
  user?: AuthenticatedUser | undefined;
  connectedAt: number;
  authTimer?: ReturnType<typeof setTimeout> | undefined;
  clientIp?: string | undefined;
}

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
