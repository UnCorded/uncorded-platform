// Reverse-proxy WebSocket bridge (plan §Phase 3).
//
// A browser opens `wss://<runtime>/proxy/:slug/:mount/*` with an `Upgrade:
// websocket` request. The WS server intercepts that upgrade BEFORE the runtime
// `/ws` branch and BEFORE the httpFetch fallback, and hands it here. We:
//   - reuse the Phase 2 mount resolver / approval / upstream-validation gates,
//     this time requiring the `proxy.websocket:self` capability;
//   - validate the mount-bound proxy-session cookie (fail closed: no cookie ⇒
//     no upstream connection);
//   - re-check the live approval version and DNS address-class drift;
//   - open a `ws:`/`wss:` client to the normalized upstream and bridge frames
//     both directions, tagging the accepted socket `ws.data.kind = "proxy"` so
//     proxy frames never enter `MessageRouter` and protocol frames never pipe
//     upstream.
//
// Backpressure is bounded in BOTH directions — there is no unbounded queue:
//   - upstream→client uses the Bun socket's `send()` return value (-1 ⇒
//     enqueue into a bounded buffer, flushed in `drain()`);
//   - client→upstream watches the upstream `bufferedAmount` and buffers into a
//     bounded queue, flushed opportunistically;
//   - either buffer overflowing the byte cap closes the bridge (1011).
// A frame larger than the shared frame cap closes with 1009. Idle sockets are
// reaped by Bun's server-level `idleTimeout`, which fires our `close()` and
// propagates the close to the upstream.

import type { Server, ServerWebSocket } from "bun";
import { rootLogger } from "@uncorded/shared";
import { RateLimiter, RATE_PROXY_WS_CONNECT } from "./rate-limiter";
import { resolveMount, type ProxyMountDeps } from "./proxy";
import { readProxyCookie, verifyProxySession } from "../proxy/session";
import {
  hostnameFromOrigin,
  resolveHostClasses,
  requiresReapproval,
  type HostClassification,
} from "../proxy/dns";
import { proxyError } from "../proxy/errors";
import { MAX_WS_FRAME_BYTES } from "../ws/server";
import type {
  WsConnectionData,
  ProxyWsConnectionData,
  ProxyWsRuntimeState,
  ProxyWsFrame,
} from "../ws/types";
import type { HttpDependencies } from "./types";

const log = rootLogger.child({ component: "proxy.ws" });

/** Default per-direction buffer ceiling. Generous for interactive apps; small
 *  enough that a stalled peer can't pin unbounded memory. */
const DEFAULT_MAX_BUFFER_BYTES = 1_048_576; // 1 MiB

/** Path shape for a proxied WebSocket — mirrors the HTTP proxy route. */
export const PROXY_WS_PATH_RE =
  /^\/proxy\/([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\/([a-z][a-z0-9]*(?:-[a-z0-9]+)*)(?:\/(.*))?$/;

/** RFC 7230 token — the only shape a subprotocol label may take. */
const TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/** The dependency subset the WS bridge needs (a slice of HttpDependencies). */
export type ProxyWebSocketDeps = ProxyMountDeps & Pick<HttpDependencies, "getServerId">;

export interface ProxyWebSocketOptions {
  deps: ProxyWebSocketDeps;
  rateLimiter: RateLimiter;
  /** DNS classifier override (tests inject a deterministic resolver). */
  resolveHostClasses?: ((hostname: string) => Promise<HostClassification>) | undefined;
  /** Frame-size cap; defaults to the shared {@link MAX_WS_FRAME_BYTES}. */
  maxFrameBytes?: number | undefined;
  /** Per-direction bounded-buffer byte cap. */
  maxBufferBytes?: number | undefined;
  /** Upstream connector override (tests inject a fake socket). */
  connectUpstream?: ((url: string, protocols: string[]) => WebSocket) | undefined;
}

export interface ProxyWebSocketHandler {
  /**
   * Attempt to upgrade a proxied-WS request. Returns `undefined` once the socket
   * has been accepted (the caller returns `undefined` to Bun), or a `Response`
   * that rejects the upgrade with an HTTP status (sent before the 101).
   */
  tryUpgrade(
    req: Request,
    server: Server<WsConnectionData>,
    clientIp: string,
  ): Promise<Response | undefined>;
  open(ws: ServerWebSocket<WsConnectionData>): void;
  message(ws: ServerWebSocket<WsConnectionData>, data: string | Buffer): void;
  drain(ws: ServerWebSocket<WsConnectionData>): void;
  close(ws: ServerWebSocket<WsConnectionData>, code: number, reason: string): void;
}

/**
 * True when `req` is a WebSocket upgrade targeting a `/proxy/:slug/:mount/*`
 * path. A plain (non-upgrade) request on that path is a normal HTTP proxy hit
 * and must fall through to the HTTP handler, so the `Upgrade` header is
 * required here.
 */
export function isProxyWebSocketUpgrade(req: Request, pathname: string): boolean {
  const upgrade = req.headers.get("upgrade");
  if (!upgrade || upgrade.toLowerCase() !== "websocket") return false;
  return PROXY_WS_PATH_RE.test(pathname);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createProxyWebSocket(options: ProxyWebSocketOptions): ProxyWebSocketHandler {
  const { deps, rateLimiter } = options;
  const resolveClasses = options.resolveHostClasses ?? resolveHostClasses;
  const maxFrameBytes = options.maxFrameBytes ?? MAX_WS_FRAME_BYTES;
  const maxBufferBytes = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
  const connect =
    options.connectUpstream ?? ((url, protocols) => new WebSocket(url, protocols));

  // -------------------------------------------------------------------------
  // Bridging helpers (closures over the configured caps).
  // -------------------------------------------------------------------------

  /** Tear down both ends exactly once with a sanitized code/reason. */
  function closeBridge(state: ProxyWsRuntimeState, code: number, reason: string): void {
    if (state.closing) return;
    state.closing = true;
    const trimmed = truncateReason(reason);
    const client = state.client;
    if (client) {
      try {
        client.close(sanitizeClientCloseCode(code), trimmed);
      } catch {
        // socket already gone
      }
    }
    closeUpstream(state, code, trimmed);
  }

  function closeUpstream(state: ProxyWsRuntimeState, code: number, reason: string): void {
    const up = state.upstream;
    if (!up) return;
    state.upstream = undefined;
    const upCode = sanitizeUpstreamCloseCode(code);
    try {
      if (upCode === undefined) up.close();
      else up.close(upCode, reason);
    } catch {
      // already closing/closed
    }
  }

  // --- upstream → client ---------------------------------------------------

  function enqueueToClient(state: ProxyWsRuntimeState, frame: ProxyWsFrame): boolean {
    const bytes = frameBytes(frame);
    if (state.toClientBytes + bytes > maxBufferBytes) {
      log.warn("proxy ws client buffer overflow", {
        slug: state.slug,
        mount: state.mount,
        buffered: state.toClientBytes,
      });
      closeBridge(state, 1011, "Client backpressure exceeded");
      return false;
    }
    state.toClient.push(frame);
    state.toClientBytes += bytes;
    return true;
  }

  function sendToClient(state: ProxyWsRuntimeState, frame: ProxyWsFrame): void {
    if (state.closing) return;
    if (frameBytes(frame) > maxFrameBytes) {
      closeBridge(state, 1009, "Message too large");
      return;
    }
    const client = state.client;
    // Buffer if the socket isn't up yet, is backpressured, or has a backlog
    // (preserve ordering: once anything is queued, everything queues until the
    // queue drains).
    if (client === undefined || state.clientBackpressured || state.toClient.length > 0) {
      enqueueToClient(state, frame);
      return;
    }
    const status = client.send(frame);
    if (status === 0) {
      closeBridge(state, 1011, "Client send failed");
      return;
    }
    if (status < 0) state.clientBackpressured = true; // accepted, but now backpressured
  }

  function flushToClient(state: ProxyWsRuntimeState): void {
    const client = state.client;
    if (!client || state.closing) return;
    state.clientBackpressured = false;
    while (state.toClient.length > 0) {
      const frame = state.toClient[0];
      if (frame === undefined) break;
      const status = client.send(frame);
      if (status === 0) {
        closeBridge(state, 1011, "Client send failed");
        return;
      }
      // -1 and >0 both mean Bun accepted the frame; remove it from our queue.
      state.toClient.shift();
      state.toClientBytes -= frameBytes(frame);
      if (status < 0) {
        state.clientBackpressured = true;
        return; // wait for the next drain()
      }
    }
  }

  // --- client → upstream ---------------------------------------------------

  function enqueueToUpstream(state: ProxyWsRuntimeState, frame: ProxyWsFrame): void {
    // Copy binary frames: Bun may reuse the message Buffer after the handler
    // returns, so a retained reference could be corrupted before it's sent.
    const stored = copyFrame(frame);
    const bytes = frameBytes(stored);
    if (state.toUpstreamBytes + bytes > maxBufferBytes) {
      log.warn("proxy ws upstream buffer overflow", {
        slug: state.slug,
        mount: state.mount,
        buffered: state.toUpstreamBytes,
      });
      closeBridge(state, 1011, "Upstream backpressure exceeded");
      return;
    }
    state.toUpstream.push(stored);
    state.toUpstreamBytes += bytes;
  }

  function flushToUpstream(state: ProxyWsRuntimeState): void {
    const up = state.upstream;
    if (!up || !state.upstreamOpen || state.closing) return;
    while (state.toUpstream.length > 0) {
      if (up.bufferedAmount > maxBufferBytes) return; // still congested
      const frame = state.toUpstream.shift();
      if (frame === undefined) break;
      state.toUpstreamBytes -= frameBytes(frame);
      up.send(frame);
    }
  }

  function sendToUpstream(state: ProxyWsRuntimeState, frame: ProxyWsFrame): void {
    if (state.closing) return;
    if (frameBytes(frame) > maxFrameBytes) {
      closeBridge(state, 1009, "Message too large");
      return;
    }
    const up = state.upstream;
    if (up === undefined || !state.upstreamOpen) {
      enqueueToUpstream(state, frame);
      return;
    }
    // Drain any backlog first so ordering holds.
    flushToUpstream(state);
    if (state.toUpstream.length > 0 || up.bufferedAmount > maxBufferBytes) {
      enqueueToUpstream(state, frame);
      return;
    }
    up.send(frame);
  }

  // -------------------------------------------------------------------------
  // Upgrade
  // -------------------------------------------------------------------------

  async function tryUpgrade(
    req: Request,
    server: Server<WsConnectionData>,
    clientIp: string,
  ): Promise<Response | undefined> {
    const url = new URL(req.url);
    const match = PROXY_WS_PATH_RE.exec(url.pathname);
    if (!match || !match[1] || !match[2]) {
      return new Response("Not found", { status: 404 });
    }
    const slug = match[1];
    const mount = match[2];
    const suffix = match[3] ?? "";

    // Per-IP connect rate limit (pre-auth) — mirrors the /ws connect guard.
    const ipRl = rateLimiter.consume(`proxy:ws:connect:ip:${clientIp}`, RATE_PROXY_WS_CONNECT);
    if (!ipRl.allowed) return rateLimited(ipRl.retryAfterMs);

    // Fail closed: no cookie ⇒ never touch the upstream.
    const token = readProxyCookie(req.headers.get("cookie"), slug, mount);
    if (!token) return proxyError("PROXY_UNAUTHENTICATED");

    // Reuse the Phase 2 resolver, this time requiring the WS capability.
    const resolved = resolveMount(deps, slug, mount, "proxy.websocket:self");
    if (!resolved.ok) return resolved.response;
    const { upstream, approval } = resolved.value;

    const serverId = deps.getServerId?.() ?? "";
    const verified = verifyProxySession(token, { slug, mount, serverId });
    if (!verified.ok) {
      return proxyError("PROXY_UNAUTHENTICATED", "Invalid or expired proxy session.");
    }
    if (verified.claims.approvalVersion !== approval.approval_version) {
      return proxyError("PROXY_NOT_APPROVED", "This proxy session is stale; re-open the plugin.");
    }
    const userId = verified.claims.userId;

    // Per-user connect rate limit (post-identity).
    const userRl = rateLimiter.consume(`proxy:ws:connect:user:${userId}`, RATE_PROXY_WS_CONNECT);
    if (!userRl.allowed) return rateLimited(userRl.retryAfterMs);

    // Connection-time DNS classification + drift re-approval (same as HTTP).
    const hostname = hostnameFromOrigin(upstream.origin);
    let classification: HostClassification;
    try {
      classification = await resolveClasses(hostname);
    } catch (err) {
      log.warn("proxy ws upstream dns resolution failed", {
        slug,
        mount,
        err: err instanceof Error ? err.message : String(err),
      });
      return proxyError("PROXY_UPSTREAM_ERROR");
    }
    if (requiresReapproval(hostname, approval.approved_address_class, classification.representative)) {
      log.warn("proxy ws upstream address class drift", {
        slug,
        mount,
        approved: approval.approved_address_class,
        live: classification.representative,
      });
      return proxyError("PROXY_REAPPROVAL_REQUIRED");
    }

    // Preserve the first valid client-requested subprotocol. Echoed to the
    // client in the 101 and requested upstream. Limitation: the upstream
    // handshake completes AFTER the client's 101, so we echo optimistically —
    // if the upstream rejects the subprotocol the bridge tears down.
    const chosen = pickSubprotocol(parseSubprotocols(req.headers.get("sec-websocket-protocol")));
    const upstreamUrl = toWebSocketUrl(upstream.origin, upstream.basePath, suffix, url.search);

    let upstreamSocket: WebSocket;
    try {
      upstreamSocket = connect(upstreamUrl, chosen ? [chosen] : []);
      upstreamSocket.binaryType = "arraybuffer";
    } catch (err) {
      log.warn("proxy ws upstream connect failed", {
        slug,
        mount,
        err: err instanceof Error ? err.message : String(err),
      });
      return proxyError("PROXY_UPSTREAM_ERROR");
    }

    const state: ProxyWsRuntimeState = {
      upstreamUrl,
      subprotocol: chosen,
      slug,
      mount,
      userId,
      client: undefined,
      upstream: upstreamSocket,
      upstreamOpen: false,
      closing: false,
      clientBackpressured: false,
      toUpstream: [],
      toUpstreamBytes: 0,
      toClient: [],
      toClientBytes: 0,
    };

    // Wire upstream handlers now (before the client socket exists). Frames that
    // arrive before `open()` buffer into state.toClient and flush once the Bun
    // socket is set.
    upstreamSocket.onopen = (): void => {
      state.upstreamOpen = true;
      flushToUpstream(state);
    };
    upstreamSocket.onmessage = (ev: MessageEvent): void => {
      const data: unknown = ev.data;
      const frame = toFrame(data);
      if (frame === null) return;
      sendToClient(state, frame);
      flushToUpstream(state); // upstream traffic implies its buffer is draining
    };
    upstreamSocket.onclose = (ev: CloseEvent): void => {
      state.upstream = undefined;
      propagateUpstreamClose(state, ev.code, ev.reason);
    };
    upstreamSocket.onerror = (): void => {
      closeBridge(state, 1011, "Upstream error");
    };

    const data: ProxyWsConnectionData = {
      kind: "proxy",
      connectionId: crypto.randomUUID(),
      connectedAt: Date.now(),
      clientIp,
      proxy: state,
    };

    const upgraded = chosen
      ? server.upgrade(req, { data, headers: { "Sec-WebSocket-Protocol": chosen } })
      : server.upgrade(req, { data });
    if (!upgraded) {
      closeUpstream(state, 1011, "Upgrade failed");
      return new Response("WebSocket upgrade failed", { status: 400 });
    }
    return undefined;
  }

  /** Close the client when the upstream went away, propagating its close code. */
  function propagateUpstreamClose(state: ProxyWsRuntimeState, code: number, reason: string): void {
    if (state.closing) return;
    state.closing = true;
    const client = state.client;
    if (client) {
      try {
        client.close(sanitizeClientCloseCode(code), truncateReason(reason));
      } catch {
        // already gone
      }
    }
  }

  // -------------------------------------------------------------------------
  // Bun websocket lifecycle (called from the WS server, kind === "proxy").
  // -------------------------------------------------------------------------

  return {
    tryUpgrade,

    open(ws): void {
      const state = proxyState(ws);
      if (!state) return;
      state.client = ws;
      flushToClient(state); // deliver anything the upstream sent pre-open
    },

    message(ws, data): void {
      const state = proxyState(ws);
      if (!state) return;
      // Bun delivers text as string and binary as Buffer (a Uint8Array).
      sendToUpstream(state, data);
    },

    drain(ws): void {
      const state = proxyState(ws);
      if (!state) return;
      flushToClient(state);
    },

    close(ws, code, reason): void {
      const state = proxyState(ws);
      if (!state) return;
      state.client = undefined;
      // The Bun socket is gone; mark closing and mirror the close upstream.
      state.closing = true;
      closeUpstream(state, code, truncateReason(reason));
    },
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function proxyState(ws: ServerWebSocket<WsConnectionData>): ProxyWsRuntimeState | null {
  return ws.data.kind === "proxy" ? ws.data.proxy : null;
}

/** Normalize an upstream MessageEvent payload to a frame, or null if unusable. */
function toFrame(data: unknown): ProxyWsFrame | null {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return data;
  if (data instanceof Uint8Array) return data;
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return null;
}

function frameBytes(frame: ProxyWsFrame): number {
  return typeof frame === "string" ? Buffer.byteLength(frame) : frame.byteLength;
}

/** Deep-copy a binary frame so a retained reference survives buffer reuse. */
function copyFrame(frame: ProxyWsFrame): ProxyWsFrame {
  if (typeof frame === "string") return frame;
  if (frame instanceof Uint8Array) return frame.slice();
  return frame.slice(0);
}

function parseSubprotocols(header: string | null): string[] {
  if (!header) return [];
  return header
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function pickSubprotocol(requested: string[]): string {
  for (const p of requested) {
    if (TOKEN_RE.test(p)) return p;
  }
  return "";
}

/** Rewrite a normalized http(s) origin + path into a ws(s) URL. */
export function toWebSocketUrl(
  origin: string,
  basePath: string,
  suffix: string,
  search: string,
): string {
  const base = basePath === "/" ? "" : basePath;
  let path = `${base}/${suffix}`.replace(/\/{2,}/g, "/");
  if (!path.startsWith("/")) path = `/${path}`;
  let wsOrigin = origin;
  if (origin.startsWith("https:")) wsOrigin = `wss:${origin.slice("https:".length)}`;
  else if (origin.startsWith("http:")) wsOrigin = `ws:${origin.slice("http:".length)}`;
  return `${wsOrigin}${path}${search}`;
}

/**
 * Map an arbitrary close code onto one the Bun client socket will accept.
 * 1005/1006/1015 are reserved (never sent on the wire); anything outside the
 * permitted set collapses to 1011.
 */
export function sanitizeClientCloseCode(code: number): number {
  if (code === 1000 || code === 1001) return code;
  if (code >= 1002 && code <= 1003) return code;
  if (code >= 1007 && code <= 1014) return code;
  if (code >= 3000 && code <= 4999) return code;
  return 1011;
}

/**
 * The WHATWG `WebSocket.close()` only permits 1000 or 3000–4999 (and throws
 * otherwise), so non-conforming codes are dropped — close with no code.
 */
export function sanitizeUpstreamCloseCode(code: number): number | undefined {
  if (code === 1000) return 1000;
  if (code >= 3000 && code <= 4999) return code;
  return undefined;
}

/** WS close reasons must be ≤123 UTF-8 bytes. */
function truncateReason(reason: string): string {
  if (Buffer.byteLength(reason) <= 123) return reason;
  let out = reason;
  while (Buffer.byteLength(out) > 123) out = out.slice(0, -1);
  return out;
}

function rateLimited(retryAfterMs: number): Response {
  const retryAfterSec = Math.ceil(retryAfterMs / 1000);
  return Response.json(
    { error: { code: "RATE_LIMITED", message: "Too many requests.", retryAfter: retryAfterSec } },
    { status: 429, headers: { "Retry-After": String(retryAfterSec) } },
  );
}
