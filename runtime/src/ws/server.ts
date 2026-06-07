// WebSocket server — Bun.serve() wrapper that handles connection lifecycle,
// auth handshake, and delegates message routing to MessageRouter.
//
// Timeouts (both injectable):
// - Auth timeout: 10s default. Client auth is a single JWT send. 10s is generous
//   for a browser sending one message. Stuck or malicious clients get dropped fast.
// - Request timeout: 30s default. Matches the subprocess handshake timeout in
//   SubprocessManager. Plugin handlers may do DB queries, file I/O, or complex
//   computation. 30s aligns with the spec's sdk.handle callback limit (§04).

import type { Server } from "bun";
import { rootLogger } from "@uncorded/shared";
import type { SubprocessManager } from "../subprocess";
import type {
  TokenValidator,
  AuthenticatedUser,
  WsConnectionData,
} from "./types";
import {
  WS_CLOSE_AUTH_TIMEOUT,
  WS_CLOSE_INVALID_MESSAGE,
  WS_CLOSE_AUTH_FAILED,
  WS_CLOSE_AUTH_RETRYABLE,
  WS_CLOSE_RATE_LIMITED,
} from "./types";
import type { WireCodec } from "./codec";
import { msgpackCodec } from "./codec";
import { MessageRouter, parseClientMessage } from "./router";
import type { PresenceCallback } from "./router";
import type { AuthResultMessage } from "@uncorded/protocol";
import type { JtiRevocationSet } from "./revocation";
import { RateLimiter, RATE_WS_CONNECT } from "../http/rate-limiter";

const log = rootLogger.child({ component: "ws.server" });

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Default auth timeout: 10s. See module docstring for rationale. */
const DEFAULT_AUTH_TIMEOUT_MS = 10_000;

/** Maximum raw WebSocket frame size accepted before closing with 1009. */
const MAX_WS_FRAME_BYTES = 65_536;

/** Default request timeout: 30s. See module docstring for rationale. */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

const CLEANUP_INTERVAL_MS = 5_000;

export interface WsServerOptions {
  port: number;
  tokenValidator: TokenValidator;
  subprocessManager: SubprocessManager;
  codec?: WireCodec | undefined;
  authTimeoutMs?: number | undefined;
  requestTimeoutMs?: number | undefined;
  onPresence?: PresenceCallback | undefined;
  /** HTTP fetch handler for non-WS requests. When provided, all requests except /ws
   *  fall through to this handler instead of returning 404. */
  httpFetch?: ((req: Request) => Promise<Response> | Response) | undefined;
  /** Pre-built router. When provided, the server uses it instead of creating a new one.
   *  This allows plugin attachments to happen before the server starts. */
  router?: MessageRouter | undefined;
  /** JTI revocation set for token replay prevention. */
  revocationSet?: JtiRevocationSet | undefined;
  /** Ban checker — returns true if the given userId is banned. Called after token validation. */
  banChecker?: ((userId: string) => boolean) | undefined;
  /** Shared rate limiter. A new one is created if not provided. */
  rateLimiter?: RateLimiter | undefined;
  /** Extract client IP from request. Defaults to cf-connecting-ip / x-forwarded-for / "unknown". */
  getClientIp?: ((req: Request) => string) | undefined;
  /** Hard cap on concurrent WebSocket connections. When reached, new upgrade
   *  attempts are rejected with HTTP 503 + Retry-After before Bun accepts the
   *  socket. Defaults to Infinity (unlimited). */
  maxConnections?: number | undefined;
  /** Hard cap on concurrent WebSocket connections from a single client IP.
   *  Counted against the IP at upgrade time and includes pre-auth sockets, so
   *  a hostile peer cannot accumulate many half-open connections under the
   *  per-IP attempt rate limit. When reached, new upgrade attempts from that
   *  IP are rejected with HTTP 503 + MAX_CONNECTIONS_PER_IP + Retry-After.
   *  Defaults to Infinity (unlimited). */
  maxConnectionsPerIp?: number | undefined;
  /** Phase 01 §5.1 step 3 — drain rejection gate. When provided and the
   *  callback returns true, new `/ws` upgrade attempts are rejected with
   *  HTTP 503 + Retry-After before any rate-limit / ban checks run. The
   *  drain controller flips this on when update-state transitions to
   *  "installing". `Retry-After` is set from `getDrainRetryAfterSeconds`
   *  (typically the configured grace window) so a polite client waits
   *  out the grace + swap before reconnecting. */
  isDraining?: (() => boolean) | undefined;
  /** Seconds advertised in `Retry-After` when `isDraining()` is true.
   *  Defaults to 30 — matches the default grace window. */
  getDrainRetryAfterSeconds?: (() => number) | undefined;
}

export interface WsServerHandle {
  server: Server<WsConnectionData>;
  router: MessageRouter;
  stop(): void;
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

function defaultGetClientIp(req: Request): string {
  // Cloudflare sets `CF-Connecting-IP` with the real client address and
  // appends it as the LAST entry of `X-Forwarded-For`. Reading the FIRST XFF
  // entry would let an attacker spoof `X-Forwarded-For: 1.2.3.4` and rotate
  // past per-IP WS-connect rate limits with one request per fake IP. Prefer
  // CF-Connecting-IP; fall back to the CF-appended last XFF hop.
  const cfIp = req.headers.get("cf-connecting-ip")?.trim();
  if (cfIp && cfIp.length > 0) return cfIp;

  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((p) => p.trim()).filter((p) => p.length > 0);
    const last = parts[parts.length - 1];
    if (last) return last;
  }

  return "unknown";
}

export function createWsServer(options: WsServerOptions): WsServerHandle {
  const codec = options.codec ?? msgpackCodec;
  const authTimeoutMs = options.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const rateLimiter = options.rateLimiter ?? new RateLimiter();
  const getClientIp = options.getClientIp ?? defaultGetClientIp;
  const banChecker = options.banChecker;
  const maxConnections = options.maxConnections ?? Infinity;
  const maxConnectionsPerIp = options.maxConnectionsPerIp ?? Infinity;
  const isDraining = options.isDraining;
  const getDrainRetryAfterSeconds = options.getDrainRetryAfterSeconds;

  // Per-IP open-socket counter. Incremented after a successful Bun.upgrade(),
  // decremented in the websocket close handler. Pre-auth sockets count, so a
  // hostile peer cannot stockpile half-open connections under the connect-
  // attempt rate limit. Entries are deleted when they hit zero so the map
  // doesn't grow unbounded with churn from unique IPs.
  const connectionsByIp = new Map<string, number>();
  const router = options.router ?? new MessageRouter(
    options.subprocessManager,
    options.onPresence,
    codec,
  );

  // Per-instance map of accepted JTIs → their expiry (Unix seconds).
  // Prevents a captured valid JWT from being replayed on a second connection
  // within its lifetime (up to 10 minutes per the spec). Scoped to this
  // handle so two createWsServer() calls in one process — tests, future
  // multi-listener paths — don't share state and falsely reject each other's
  // tokens as "already used".
  const seenJtis = new Map<string, number>();
  const pruneSeenJtis = (): void => {
    const nowSecs = Date.now() / 1000;
    for (const [jti, expiry] of seenJtis) {
      if (expiry <= nowSecs) {
        seenJtis.delete(jti);
      }
    }
  };

  const server = Bun.serve<WsConnectionData>({
    port: options.port,

    fetch(req, server) {
      const url = new URL(req.url);

      if (url.pathname === "/ws") {
        // Phase 01 §5.1 step 3 — reject new upgrades during drain. Checked
        // before any other gate so a draining server short-circuits cleanly:
        // no rate-limit accounting, no ban-list lookup, just a polite 503
        // with Retry-After pointing past the grace window.
        if (isDraining?.()) {
          const retryAfter = getDrainRetryAfterSeconds?.() ?? 30;
          return new Response(
            JSON.stringify({
              error: "DRAINING",
              message: "Server is draining for an update; retry shortly.",
            }),
            {
              status: 503,
              headers: {
                "Content-Type": "application/json",
                "Retry-After": String(retryAfter),
              },
            },
          );
        }

        // Hard cap — reject new upgrades when the server is already at capacity.
        // Checked before rate limiting so legitimate clients aren't rate-penalized
        // for bouncing off a full server; they get a clear 503 with Retry-After.
        if (router.getConnectionCount() >= maxConnections) {
          return new Response(
            JSON.stringify({
              error: "MAX_CONNECTIONS",
              message: "Server is at maximum connection capacity.",
            }),
            {
              status: 503,
              headers: {
                "Content-Type": "application/json",
                "Retry-After": "30",
              },
            },
          );
        }

        // Rate limit: connection attempts per IP
        const ip = getClientIp(req);
        const connectResult = rateLimiter.consume(`ws:connect:${ip}`, RATE_WS_CONNECT);
        if (!connectResult.allowed) {
          return new Response(
            JSON.stringify({
              error: "RATE_LIMITED",
              message: "Too many WebSocket connection attempts",
              retry_after: connectResult.retryAfterMs,
            }),
            {
              status: 429,
              headers: {
                "Content-Type": "application/json",
                "Retry-After": String(Math.ceil(connectResult.retryAfterMs / 1000)),
              },
            },
          );
        }

        // Check if IP is banned (from auth failures)
        const banResult = rateLimiter.isBanned(ip);
        if (banResult.banned) {
          return new Response(
            JSON.stringify({
              error: "IP_BANNED",
              message: "Too many authentication failures",
              retry_after: banResult.retryAfterMs,
            }),
            {
              status: 429,
              headers: {
                "Content-Type": "application/json",
                "Retry-After": String(Math.ceil(banResult.retryAfterMs / 1000)),
              },
            },
          );
        }

        // Per-IP concurrent-socket cap. Checked after rate limit + ban so a
        // legitimate client at its cap (many tabs) gets a different signal
        // (503 saturation) than a misbehaving one (429 too-many-attempts).
        const ipOpen = connectionsByIp.get(ip) ?? 0;
        if (ipOpen >= maxConnectionsPerIp) {
          log.warn("per-IP connection cap reached", {
            ip,
            open: ipOpen,
            limit: maxConnectionsPerIp,
          });
          return new Response(
            JSON.stringify({
              error: "MAX_CONNECTIONS_PER_IP",
              message: "Too many concurrent connections from this address.",
            }),
            {
              status: 503,
              headers: {
                "Content-Type": "application/json",
                "Retry-After": "30",
              },
            },
          );
        }

        const connectionId = crypto.randomUUID();
        const upgraded = server.upgrade(req, {
          data: {
            connectionId,
            authenticated: false,
            connectedAt: Date.now(),
            clientIp: ip,
          },
        });
        if (upgraded) {
          connectionsByIp.set(ip, ipOpen + 1);
          return undefined;
        }
        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      // When an httpFetch handler is provided, delegate all non-/ws
      // requests to it (including /health — the HTTP handler has a richer response).
      // Without httpFetch, fall back to the minimal built-in /health.
      if (options.httpFetch) {
        return options.httpFetch(req);
      }

      if (url.pathname === "/health") {
        return Response.json({
          status: "ok",
          connections: router.getConnectionCount(),
        });
      }

      return new Response("Not found", { status: 404 });
    },

    websocket: {
      // Bun defaults to a 120s idleTimeout and sendPings=true, but we pin both
      // explicitly so the behavior is obvious to future readers and doesn't
      // silently drift if Bun changes its defaults. 60s keeps us well inside
      // the Cloudflare Tunnel WebSocket idle window (~100s) so dead peers get
      // reaped server-side first — otherwise we'd learn a connection died
      // only when the tunnel severed it.
      idleTimeout: 60,
      sendPings: true,

      open(ws) {
        ws.data.authTimer = setTimeout(() => {
          if (!ws.data.authenticated) {
            ws.close(WS_CLOSE_AUTH_TIMEOUT, "Auth timeout");
          }
        }, authTimeoutMs);
      },

      async message(ws, data) {
        // Reject oversized frames before decoding (RFC 6455 §7.4.1 code 1009)
        const byteLength =
          typeof data === "string"
            ? new TextEncoder().encode(data).byteLength
            : (data as { byteLength: number }).byteLength;
        if (byteLength > MAX_WS_FRAME_BYTES) {
          const ip = ws.data.clientIp ?? "unknown";
          const connId = ws.data.connectionId;
          log.warn("oversized frame rejected", {
            connectionId: connId,
            ip,
            byteLength,
            limit: MAX_WS_FRAME_BYTES,
          });
          ws.close(1009, "Message too large");
          return;
        }

        let parsed: unknown;
        try {
          parsed = codec.decode(data as string | Uint8Array | ArrayBuffer);
        } catch {
          ws.close(WS_CLOSE_INVALID_MESSAGE, "Invalid message format");
          return;
        }

        // --- Unauthenticated: must be an auth message ---
        if (!ws.data.authenticated) {
          const msg = parseClientMessage(parsed);

          if (!msg || msg.type !== "auth") {
            ws.close(WS_CLOSE_INVALID_MESSAGE, "First message must be auth");
            return;
          }

          // Check if this IP is banned before attempting validation
          const authIp = ws.data.clientIp ?? "unknown";
          const authBanCheck = rateLimiter.isBanned(authIp);
          if (authBanCheck.banned) {
            const reply: AuthResultMessage = {
              type: "auth.result",
              ok: false,
              error: "Too many authentication failures",
            };
            ws.send(codec.encode(reply) as string);
            ws.close(WS_CLOSE_RATE_LIMITED, "Rate limited");
            return;
          }

          const result = await options.tokenValidator.validate(msg.token);

          if (!result.ok) {
            // Don't penalize transient server-init errors — these aren't
            // auth attacks, just a race between connection and first heartbeat.
            // Transient codes also get a separate close code (4004) so the
            // website knows to reconnect instead of falsely concluding the
            // user was banned and purging the server from the local store.
            const isTransient = result.code === "UNKNOWN_KEY" || result.code === "SERVER_NOT_READY";
            if (!isTransient) {
              rateLimiter.recordAuthFailure(authIp);
            }
            const reply: AuthResultMessage = {
              type: "auth.result",
              ok: false,
              error: result.message,
            };
            ws.send(codec.encode(reply) as string);
            if (isTransient) {
              ws.close(WS_CLOSE_AUTH_RETRYABLE, "Auth retryable");
            } else {
              ws.close(WS_CLOSE_AUTH_FAILED, "Auth failed");
            }
            return;
          }

          // Check JTI revocation
          if (result.jti && options.revocationSet?.isRevoked(result.jti)) {
            const reply: AuthResultMessage = {
              type: "auth.result",
              ok: false,
              error: "Token has been revoked",
            };
            ws.send(codec.encode(reply) as string);
            ws.close(WS_CLOSE_AUTH_FAILED, "Token revoked");
            return;
          }

          // JTI replay prevention — prune expired entries, then check for reuse
          if (result.jti) {
            pruneSeenJtis();
            if (seenJtis.has(result.jti)) {
              const reply: AuthResultMessage = {
                type: "auth.result",
                ok: false,
                error: "Token already used",
              };
              ws.send(codec.encode(reply) as string);
              ws.close(WS_CLOSE_AUTH_TIMEOUT, "Token already used");
              return;
            }
            // Record this JTI with its expiry (or a 10-minute window if exp is absent)
            const expiry = result.exp ?? (Math.floor(Date.now() / 1000) + 600);
            seenJtis.set(result.jti, expiry);
          }

          // Auth succeeded — check ban before accepting. Fail closed on lookup
          // errors (corrupt SQLite, Bun transient): the user is treated as
          // banned until the ban table is readable again.
          let isBanned = false;
          try {
            isBanned = banChecker?.(result.user.id) ?? false;
          } catch (err) {
            log.error("banChecker threw — failing closed", {
              connectionId: ws.data.connectionId,
              userId: result.user.id,
              err: err instanceof Error ? err.message : String(err),
            });
            const reply: AuthResultMessage = {
              type: "auth.result",
              ok: false,
              error: "Authentication service unavailable.",
            };
            ws.send(codec.encode(reply) as string);
            ws.close(WS_CLOSE_AUTH_FAILED, "Auth service unavailable");
            return;
          }
          if (isBanned) {
            const reply: AuthResultMessage = { type: "auth.result", ok: false, error: "You are banned from this server." };
            ws.send(codec.encode(reply) as string);
            ws.close(WS_CLOSE_AUTH_FAILED, "Banned");
            return;
          }

          rateLimiter.recordAuthSuccess(authIp);

          if (ws.data.authTimer !== undefined) {
            clearTimeout(ws.data.authTimer);
            ws.data.authTimer = undefined;
          }

          ws.data.authenticated = true;
          ws.data.user = result.user;

          router.registerConnection(ws.data.connectionId, result.user, {
            send(d: string | Uint8Array) {
              ws.send(d);
            },
            close(code?: number, reason?: string) {
              ws.close(code, reason);
            },
          });

          const reply: AuthResultMessage = { type: "auth.result", ok: true };
          ws.send(codec.encode(reply) as string);
          return;
        }

        // --- Authenticated: route through router ---
        const msg = parseClientMessage(parsed);
        if (!msg) {
          // Malformed message — send error feedback (don't close the connection)
          ws.send(codec.encode({ type: "error", message: "Malformed message" }));
          return;
        }

        router.handleMessage(ws.data.connectionId, msg);
      },

      close(ws) {
        if (ws.data.authTimer !== undefined) {
          clearTimeout(ws.data.authTimer);
        }
        if (ws.data.authenticated) {
          router.removeConnection(ws.data.connectionId);
        }
        // Decrement the per-IP counter for every socket we incremented for —
        // pre-auth sockets count, so this fires regardless of authenticated.
        const ip = ws.data.clientIp;
        if (ip !== undefined) {
          const current = connectionsByIp.get(ip) ?? 0;
          if (current <= 1) {
            connectionsByIp.delete(ip);
          } else {
            connectionsByIp.set(ip, current - 1);
          }
        }
      },
    },
  });

  // Periodic cleanup of stale pending requests
  const cleanupTimer = setInterval(() => {
    router.cleanupStaleRequests(requestTimeoutMs);
  }, CLEANUP_INTERVAL_MS);

  // Periodic pruning of expired JTIs from the replay-prevention map (every 60s)
  const jtiPruneTimer = setInterval(() => {
    pruneSeenJtis();
  }, 60_000);

  let stopped = false;

  return {
    server,
    router,
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(cleanupTimer);
      clearInterval(jtiPruneTimer);
      try {
        server.stop(true);
      } catch {
        // Best effort during teardown; Bun may already be stopping the server.
      }
    },
  };
}
