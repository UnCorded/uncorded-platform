// Message router — the core routing logic between WebSocket clients and plugin
// subprocesses. Decoupled from Bun's WebSocket API for testability.
//
// Responsibilities:
// - Correlate request IDs across client → IPC → client round-trips
// - Demux IPC responses back to the correct WebSocket client
// - Track connected users and emit presence events

import { Buffer } from "node:buffer";
import type { SubprocessManager, PluginProcess } from "../subprocess";
import type { StdioParentTransport } from "../ipc/transport";
import type { AuthenticatedUser, ConnectedUser } from "./types";
import type { CoreModule } from "../core";
import { handleCoreIpc, handleCoreClientAction } from "../core";
import { rootLogger } from "@uncorded/shared";

const log = rootLogger.child({ component: "ws.router" });
import type { WireCodec } from "./codec";
import { jsonCodec } from "./codec";
import type { CapabilityChecker } from "../capabilities/checker";
import type { RolesEngine } from "../roles/engine";
import type { PluginRegistry } from "../http/types";
import {
  handlePermissionsRegister,
  handlePermissionsCheck,
  handlePermissionsHasRole,
  handlePermissionsHasMinLevel,
  handlePermissionsGetRole,
  handlePermissionsCanActOn,
  handleDataRead,
  handleDataSql,
  handleKv,
  handleConfig,
  handleHttpFetch,
  handleFiles,
  PluginDbCache,
} from "../ipc/handlers";
import {
  handleVoiceTokensIpc,
  handleVoiceModerationIpc,
  type VoiceIpcDeps,
} from "../voice/ipc";
import {
  handlePluginResourcesIpc,
  type PluginResourceIpcDeps,
} from "../plugin-resources";
import type { OpenDatabaseFn } from "../ipc/handlers";
import type {
  ClientMessage,
  RequestMessage,
  ResponseMessage,
  EventMessage,
  IpcResponseMessage,
  IpcEventAckMessage,
  IpcUser,
} from "@uncorded/protocol";
import type { IpcMessage } from "../ipc/transport";
import type { EventBus } from "../events/bus";
import type { OverflowPolicy } from "../events/types";
import type { Watchdog } from "../watchdog";
import type { RateLimiter } from "../http/rate-limiter";
import { RATE_WS_REQUEST, RATE_WS_SUBSCRIBE } from "../http/rate-limiter";
import type { ScopedPresenceModule } from "../presence";
import { handlePresenceIpc } from "../presence";
import type { CoViewClientMessage, CoViewHandle } from "../co-view";
import { isCoViewClientMessage } from "../co-view";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PendingRequest {
  connectionId: string;
  clientRequestId: string;
  plugin: string;
  createdAt: number;
}

/**
 * Maximum encoded size for a single event/response frame sent from the runtime
 * to a WebSocket client. Enforced at the plugin-facing boundary (broadcast.toAll
 * and broadcast.toUsers IPC dispatch) so plugins receive a catchable
 * PAYLOAD_TOO_LARGE error. Events are intended for small state changes —
 * large payloads should be fetched via sdk.handle with pagination.
 */
const MAX_WS_OUTBOUND_BYTES = 1 * 1024 * 1024; // 1 MB

/** Byte length of an encoded WS payload, for string or Uint8Array forms. */
function encodedByteLength(encoded: string | Uint8Array): number {
  if (typeof encoded === "string") {
    // Buffer.byteLength is cheap and avoids allocating a second encoded copy.
    return Buffer.byteLength(encoded, "utf8");
  }
  return encoded.byteLength;
}

/** Abstraction over ws.send() so the router doesn't depend on Bun's WebSocket type. */
export interface WebSocketSender {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

export type PresenceCallback = (
  event: "runtime.user.connected" | "runtime.user.disconnected",
  user: AuthenticatedUser,
) => void;

export function sendPluginRequest(
  pluginProcess: PluginProcess,
  action: string,
  params: Record<string, unknown>,
  user: IpcUser,
  id = crypto.randomUUID(),
  sessionId?: string,
): string {
  const ipcMessage: IpcMessage = {
    type: "request",
    id,
    action,
    params,
    user,
  };
  // Only include session_id when it's a real session — runtime-originated
  // calls (schedule.tick, cascade) omit it so the SDK's getCurrentSession()
  // returns undefined for those handlers.
  if (sessionId !== undefined) {
    ipcMessage["session_id"] = sessionId;
  }

  pluginProcess.transport.send(ipcMessage);
  return id;
}

// ---------------------------------------------------------------------------
// Message validation
// ---------------------------------------------------------------------------

export function parseClientMessage(raw: unknown): ClientMessage | null {
  if (typeof raw !== "object" || raw === null) return null;
  const msg = raw as Record<string, unknown>;

  if (typeof msg["type"] !== "string") return null;

  switch (msg["type"]) {
    case "auth":
      if (typeof msg["token"] === "string") {
        return { type: "auth", token: msg["token"] } as ClientMessage;
      }
      return null;

    case "request":
      if (
        typeof msg["id"] === "string" &&
        typeof msg["plugin"] === "string" &&
        typeof msg["action"] === "string" &&
        typeof msg["params"] === "object" &&
        msg["params"] !== null
      ) {
        return {
          type: "request",
          id: msg["id"],
          plugin: msg["plugin"],
          action: msg["action"],
          params: msg["params"] as Record<string, unknown>,
        };
      }
      return null;

    case "co-view.start.req": {
      const visibility = msg["visibility"];
      const renderMode = msg["render_mode"];
      const whitelist = msg["whitelist"];
      const blacklist = msg["blacklist"];
      const redactions = parseCoViewRedactions(msg["redactions"]);
      if (
        (visibility !== "public" && visibility !== "private") ||
        (renderMode !== "as-host" && renderMode !== "as-viewer") ||
        !isStringArray(whitelist) ||
        !isStringArray(blacklist) ||
        redactions === null
      ) {
        return null;
      }
      return {
        type: "co-view.start.req",
        visibility,
        whitelist,
        blacklist,
        render_mode: renderMode,
        redactions,
      };
    }

    case "co-view.update.req": {
      if (typeof msg["session_id"] !== "string") return null;
      const out: import("@uncorded/protocol").WsCoViewUpdateReq = {
        type: "co-view.update.req",
        session_id: msg["session_id"],
      };
      if (msg["visibility"] !== undefined) {
        if (msg["visibility"] !== "public" && msg["visibility"] !== "private") {
          return null;
        }
        out.visibility = msg["visibility"];
      }
      if (msg["render_mode"] !== undefined) {
        if (msg["render_mode"] !== "as-host" && msg["render_mode"] !== "as-viewer") {
          return null;
        }
        out.render_mode = msg["render_mode"];
      }
      if (msg["whitelist"] !== undefined) {
        if (!isStringArray(msg["whitelist"])) return null;
        out.whitelist = msg["whitelist"];
      }
      if (msg["blacklist"] !== undefined) {
        if (!isStringArray(msg["blacklist"])) return null;
        out.blacklist = msg["blacklist"];
      }
      if (msg["redactions"] !== undefined) {
        const r = parseCoViewRedactions(msg["redactions"]);
        if (r === null) return null;
        out.redactions = r;
      }
      if (msg["paused"] !== undefined) {
        if (typeof msg["paused"] !== "boolean") return null;
        out.paused = msg["paused"];
      }
      return out;
    }

    case "co-view.end.req": {
      if (typeof msg["session_id"] !== "string") return null;
      const out: import("@uncorded/protocol").WsCoViewEndReq = {
        type: "co-view.end.req",
        session_id: msg["session_id"],
      };
      if (typeof msg["reason"] === "string") {
        out.reason = msg["reason"];
      }
      return out;
    }

    case "co-view.join.req":
      if (typeof msg["session_id"] === "string") {
        return { type: "co-view.join.req", session_id: msg["session_id"] };
      }
      return null;

    case "co-view.leave.req":
      if (typeof msg["session_id"] === "string") {
        return { type: "co-view.leave.req", session_id: msg["session_id"] };
      }
      return null;

    case "co-view.kick.req": {
      if (
        typeof msg["session_id"] !== "string" ||
        typeof msg["target_user_id"] !== "string"
      ) {
        return null;
      }
      const out: import("@uncorded/protocol").WsCoViewKickReq = {
        type: "co-view.kick.req",
        session_id: msg["session_id"],
        target_user_id: msg["target_user_id"],
      };
      if (typeof msg["reason"] === "string") {
        out.reason = msg["reason"];
      }
      return out;
    }

    case "co-view.state": {
      if (typeof msg["session_id"] !== "string") return null;
      if (typeof msg["seq"] !== "number" || !Number.isFinite(msg["seq"])) return null;
      if (typeof msg["ts"] !== "number" || !Number.isFinite(msg["ts"])) return null;
      if (msg["replay"] !== "safe" && msg["replay"] !== "unsafe") return null;
      const diff = msg["diff"];
      if (!isPlainObject(diff)) return null;
      const out: import("@uncorded/protocol").WsCoViewState = {
        type: "co-view.state",
        session_id: msg["session_id"],
        seq: msg["seq"],
        diff: diff as Record<string, unknown>,
        replay: msg["replay"],
        ts: msg["ts"],
      };
      if (msg["full_state"] !== undefined) {
        if (!isPlainObject(msg["full_state"])) return null;
        out.full_state = msg["full_state"] as Record<string, unknown>;
      }
      return out;
    }

    case "co-view.event": {
      if (typeof msg["session_id"] !== "string") return null;
      if (typeof msg["kind"] !== "string") return null;
      if (typeof msg["ts"] !== "number" || !Number.isFinite(msg["ts"])) return null;
      if (msg["replay"] !== "safe" && msg["replay"] !== "unsafe") return null;
      if (!isPlainObject(msg["payload"])) return null;
      return {
        type: "co-view.event",
        session_id: msg["session_id"],
        kind: msg["kind"] as import("@uncorded/protocol").CoViewEventKind,
        payload: msg["payload"] as Record<string, unknown>,
        replay: msg["replay"],
        ts: msg["ts"],
      };
    }

    case "co-view.list.req": {
      if (typeof msg["request_id"] !== "string" || msg["request_id"].length === 0) return null;
      if (typeof msg["server_id"] !== "string" || msg["server_id"].length === 0) return null;
      return {
        type: "co-view.list.req",
        request_id: msg["request_id"],
        server_id: msg["server_id"],
      };
    }

    case "co-view.snapshot.req": {
      if (typeof msg["session_id"] !== "string") return null;
      if (typeof msg["since_seq"] !== "number" || !Number.isFinite(msg["since_seq"])) {
        return null;
      }
      const out: import("@uncorded/protocol").WsCoViewSnapshotReq = {
        type: "co-view.snapshot.req",
        session_id: msg["session_id"],
        since_seq: msg["since_seq"],
      };
      // member_id is server-stamped; if a client sends one, ignore it.
      return out;
    }

    case "co-view.snapshot.res": {
      if (typeof msg["session_id"] !== "string") return null;
      if (typeof msg["seq"] !== "number" || !Number.isFinite(msg["seq"])) return null;
      if (typeof msg["member_id"] !== "string" || msg["member_id"].length === 0) {
        // Hosts MUST address the response back via member_id; reject otherwise.
        return null;
      }
      const diffs = msg["diffs"];
      const fullState = msg["full_state"];
      if (diffs === undefined && fullState === undefined) return null;
      if (diffs !== undefined && !Array.isArray(diffs)) return null;
      if (fullState !== undefined && !isPlainObject(fullState)) return null;
      const out: import("@uncorded/protocol").WsCoViewSnapshotRes = {
        type: "co-view.snapshot.res",
        session_id: msg["session_id"],
        member_id: msg["member_id"],
        seq: msg["seq"],
      };
      if (diffs !== undefined) {
        out.diffs = diffs as import("@uncorded/protocol").WsCoViewState[];
      }
      if (fullState !== undefined) {
        out.full_state = fullState as Record<string, unknown>;
      }
      return out;
    }

    case "co-view.render-tree.frame": {
      // CV-FOUND-4b: shallow envelope validation only — `session_id` is a
      // string and `frame` is an object. The canonical frame's deep structure
      // is validated downstream by `CoViewCanonicalRenderFrameSchema` inside the
      // projector (the single source of truth for render-tree validity), so we
      // don't duplicate that here. The transport handler is disabled by default
      // regardless, so a frame that parses still goes nowhere in production.
      if (typeof msg["session_id"] !== "string") return null;
      if (!isPlainObject(msg["frame"])) return null;
      return {
        type: "co-view.render-tree.frame",
        session_id: msg["session_id"],
        frame: msg["frame"] as unknown as import("@uncorded/protocol").CoViewCanonicalRenderFrame,
      };
    }

    default:
      return null;
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => typeof s === "string");
}

function parseCoViewRedactions(
  v: unknown,
): import("@uncorded/protocol").CoViewRedactions | null {
  if (typeof v !== "object" || v === null) return null;
  const r = v as Record<string, unknown>;
  if (
    !isStringArray(r["panel_ids"]) ||
    !isStringArray(r["plugin_slugs"]) ||
    !isStringArray(r["custom_selectors"])
  ) {
    return null;
  }
  return {
    panel_ids: r["panel_ids"],
    plugin_slugs: r["plugin_slugs"],
    custom_selectors: r["custom_selectors"],
  };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export class MessageRouter {
  private pendingRequests = new Map<string, PendingRequest>();
  private connections = new Map<string, WebSocketSender>();
  private connectionUsers = new Map<string, AuthenticatedUser>();
  private connectedUsers = new Map<string, ConnectedUser>();
  private userConnections = new Map<string, Set<string>>();
  private checkers = new Map<string, CapabilityChecker>();
  private pluginSchedules = new Map<string, Map<string, ReturnType<typeof setInterval>>>();
  private codec: WireCodec;

  private eventBus: EventBus | undefined;
  private rolesEngine: RolesEngine | undefined;
  private pluginRegistry: PluginRegistry | undefined;
  private openDatabaseFn: OpenDatabaseFn | undefined;
  private watchdog: Watchdog | undefined;
  private rateLimiter: RateLimiter | undefined;
  private pluginDbCache: PluginDbCache | undefined;
  private coreModule: CoreModule | undefined;
  private centralHost: string | undefined;
  private presenceModule: ScopedPresenceModule | undefined;
  private voiceIpcDeps: VoiceIpcDeps | undefined;
  private pluginResourceDeps: Omit<PluginResourceIpcDeps, "checkCapability"> | undefined;
  private coViewDispatcher: CoViewHandle | undefined;
  private connectionRegisteredCallbacks: Array<(connectionId: string) => void> = [];
  private connectionRemovedCallbacks: Array<(connectionId: string) => void> = [];

  constructor(
    private subprocessManager: SubprocessManager,
    private onPresence?: PresenceCallback,
    codec?: WireCodec,
    eventBus?: EventBus,
    rolesEngine?: RolesEngine,
    pluginRegistry?: PluginRegistry,
    openDatabaseFn?: OpenDatabaseFn,
  ) {
    this.codec = codec ?? jsonCodec;
    this.eventBus = eventBus;
    this.rolesEngine = rolesEngine;
    this.pluginRegistry = pluginRegistry;
    this.openDatabaseFn = openDatabaseFn;
  }

  /** Set the watchdog so pong messages from plugins can be forwarded. */
  setWatchdog(watchdog: Watchdog): void {
    this.watchdog = watchdog;
  }

  /** Set the rate limiter for per-message rate limiting (sdk.request, sdk.subscribe). */
  setRateLimiter(limiter: RateLimiter): void {
    this.rateLimiter = limiter;
  }

  /** Set the plugin DB cache for data.sql IPC dispatch. */
  setPluginDbCache(cache: PluginDbCache): void {
    this.pluginDbCache = cache;
  }

  /** Set the Core Module for core.* IPC dispatch. */
  setCoreModule(mod: CoreModule): void {
    this.coreModule = mod;
  }

  /** Set the scoped presence module for presence.* IPC dispatch. */
  setPresenceModule(mod: ScopedPresenceModule): void {
    this.presenceModule = mod;
  }

  /**
   * Set the voice bridge dependencies for voice.* IPC dispatch (PR-4a:
   * `voice.tokens`). Left unset when voice is not configured at boot —
   * plugins requesting voice.tokens get VOICE_BRIDGE_UNAVAILABLE.
   */
  setVoiceIpcDeps(deps: VoiceIpcDeps): void {
    this.voiceIpcDeps = deps;
  }

  /**
   * Set the plugin-resource backend deps for `resources.*` IPC dispatch
   * (RP-FOUND-4). `checkCapability` is supplied per-call in `attachPlugin` from
   * the calling plugin's `CapabilityChecker`, so deps here carry only the
   * store/resolver/serverId. Left unset until the follow-up boot PR wires it —
   * until then `resources.*` answers PLUGIN_RESOURCES_UNAVAILABLE, mirroring how
   * `voice.*` behaves when the bridge is unconfigured.
   */
  setPluginResources(deps: Omit<PluginResourceIpcDeps, "checkCapability">): void {
    this.pluginResourceDeps = deps;
  }

  /**
   * Attach the Co-View Sessions subsystem so `co-view.*` WS frames are
   * dispatched to it. Mirrors the pattern voice uses for IPC injection.
   */
  attachCoViewDispatcher(handle: CoViewHandle): void {
    this.coViewDispatcher = handle;
  }

  /** Look up the authenticated user behind a given connection. */
  getConnectedUser(connectionId: string): AuthenticatedUser | undefined {
    return this.connectionUsers.get(connectionId);
  }

  /**
   * Register a callback fired after a WS connection is registered. Used by the
   * scoped presence module to add the new session to its activeSessions set
   * so subsequent join() calls can be validated against it.
   */
  onConnectionRegistered(cb: (connectionId: string) => void): void {
    this.connectionRegisteredCallbacks.push(cb);
  }

  /**
   * Register a callback fired after a WS connection is removed. Used by the
   * scoped presence module to evict the session's entries and emit
   * runtime.presence.left with reason "session_closed". Synchronously executed
   * before any subsequent join IPC is processed, closing the race against
   * mid-flight join calls.
   */
  onConnectionRemoved(cb: (connectionId: string) => void): void {
    this.connectionRemovedCallbacks.push(cb);
  }

  /**
   * Set the Central hostname (e.g. "central.uncorded.app").
   * Authorization headers are stripped on http.fetch requests targeting this host
   * to prevent plugins from impersonating the runtime to Central.
   */
  setCentralHost(host: string): void {
    this.centralHost = host;
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------

  registerConnection(
    connectionId: string,
    user: AuthenticatedUser,
    sender: WebSocketSender,
  ): void {
    this.connections.set(connectionId, sender);
    this.connectionUsers.set(connectionId, user);

    // Track per-user connection set for multi-tab presence
    let conns = this.userConnections.get(user.id);
    if (!conns) {
      conns = new Set();
      this.userConnections.set(user.id, conns);
    }
    const isFirstConnection = conns.size === 0;
    conns.add(connectionId);

    // Always update connectedUsers entry (latest connection info)
    this.connectedUsers.set(user.id, {
      connectionId,
      user,
      connectedAt: Date.now(),
    });

    // Only emit presence on the first connection for this user
    if (isFirstConnection) {
      this.onPresence?.("runtime.user.connected", user);
    }

    // Notify connection-registered listeners (e.g. scoped presence module
    // adding the new session to its activeSessions set).
    for (const cb of this.connectionRegisteredCallbacks) {
      try {
        cb(connectionId);
      } catch (err: unknown) {
        log.warn("connection-registered callback failed", {
          connectionId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  removeConnection(connectionId: string): void {
    const user = this.connectionUsers.get(connectionId);

    // Clean up pending requests from this connection
    for (const [corrId, pending] of this.pendingRequests) {
      if (pending.connectionId === connectionId) {
        this.pendingRequests.delete(corrId);
      }
    }

    this.connections.delete(connectionId);
    this.connectionUsers.delete(connectionId);

    if (user) {
      // Remove this connection from the user's connection set
      const conns = this.userConnections.get(user.id);
      if (conns) {
        conns.delete(connectionId);
      }
      const isLastConnection = !conns || conns.size === 0;

      if (isLastConnection) {
        // Last connection closed — remove user and emit disconnected
        this.connectedUsers.delete(user.id);
        this.userConnections.delete(user.id);
        this.onPresence?.("runtime.user.disconnected", user);
      } else {
        // Other connections remain — update connectedUsers to point to a surviving connection
        const survivingConnId = conns!.values().next().value as string;
        const survivingUser = this.connectionUsers.get(survivingConnId);
        if (survivingUser) {
          const existing = this.connectedUsers.get(user.id);
          if (existing?.connectionId === connectionId) {
            this.connectedUsers.set(user.id, {
              connectionId: survivingConnId,
              user: survivingUser,
              connectedAt: existing.connectedAt,
            });
          }
        }
      }
    }

    // Notify connection-removed listeners (e.g. scoped presence module
    // evicting this session's entries). Synchronous so the activeSessions
    // mutation lands before any subsequent join IPC is dispatched.
    for (const cb of this.connectionRemovedCallbacks) {
      try {
        cb(connectionId);
      } catch (err: unknown) {
        log.warn("connection-removed callback failed", {
          connectionId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Tear down any Co-View sessions (host or viewer) owned by this
    // connection. Hosts go into the disconnect grace window; viewers are
    // evicted immediately (no partial-reconnect per spec).
    if (this.coViewDispatcher) {
      try {
        this.coViewDispatcher.onConnectionClose(connectionId);
      } catch (err: unknown) {
        log.warn("co-view onConnectionClose failed", {
          connectionId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  getConnectedUsers(): ReadonlyMap<string, ConnectedUser> {
    return this.connectedUsers;
  }

  getConnectionCount(): number {
    return this.connections.size;
  }

  /**
   * Disconnect all WebSocket connections belonging to a given user ID.
   * Used by delta handlers (e.g. user.banned) where we have a user_id
   * but not a connectionId. Returns the number of connections closed.
   */
  disconnectUser(userId: string, code?: number, reason?: string): number {
    // Collect connection IDs first to avoid mutating the map during iteration
    const toClose: string[] = [];
    for (const [connectionId, user] of this.connectionUsers) {
      if (user.id === userId) {
        toClose.push(connectionId);
      }
    }
    for (const connectionId of toClose) {
      const sender = this.connections.get(connectionId);
      if (sender) {
        sender.close(code, reason);
      }
      this.removeConnection(connectionId);
    }
    return toClose.length;
  }

  /**
   * Force-disconnect every WebSocket connection (e.g. full re-sync after
   * extended offline). Returns the number of connections closed.
   */
  disconnectAllUsers(code?: number, reason?: string): number {
    const toClose = [...this.connections.keys()];
    for (const connectionId of toClose) {
      const sender = this.connections.get(connectionId);
      if (sender) {
        sender.close(code, reason);
      }
      this.removeConnection(connectionId);
    }
    return toClose.length;
  }

  /**
   * Close any active sessions held by the *former* server owner so they
   * reconnect with a refreshed JWT reflecting their new role. Role is derived
   * from each session's JWT claim (user.role), not from any persistent
   * server-side state — so we identify former-owner sessions as "role === owner
   * but id !== newOwnerId". Returns the number of connections closed.
   */
  disconnectFormerOwner(newOwnerId: string): number {
    const toClose: string[] = [];
    for (const [connectionId, user] of this.connectionUsers) {
      if (user.role === "owner" && user.id !== newOwnerId) {
        toClose.push(connectionId);
      }
    }
    for (const connectionId of toClose) {
      const sender = this.connections.get(connectionId);
      if (sender) {
        sender.close(4003, "Ownership transferred");
      }
      this.removeConnection(connectionId);
    }
    return toClose.length;
  }

  // -------------------------------------------------------------------------
  // Message handling
  // -------------------------------------------------------------------------

  handleMessage(connectionId: string, message: ClientMessage): void {
    switch (message.type) {
      case "request":
        this.handleRequest(connectionId, message);
        break;
      case "auth":
        // Auth messages should be handled by the server layer, not the router.
        // If one arrives here, the connection is already authenticated — ignore it.
        break;
      default:
        if (isCoViewClientMessage(message)) {
          if (this.coViewDispatcher) {
            void this.coViewDispatcher.dispatch(
              connectionId,
              message as CoViewClientMessage,
            );
          } else {
            log.error("co-view frame received but dispatcher is not attached", {
              connectionId,
              type: message.type,
            });
            this.sendToConnection(connectionId, {
              type: "error",
              message: "Co-View subsystem is not attached.",
            });
          }
        }
        break;
    }
  }

  // -------------------------------------------------------------------------
  // Plugin attachment — call after plugin subprocess is ready
  // -------------------------------------------------------------------------

  attachPlugin(
    slug: string,
    transport: StdioParentTransport,
    checker?: CapabilityChecker,
  ): void {
    // Clear any stale schedules from a previous subprocess instance (respawn).
    this.clearPluginSchedules(slug);

    if (checker) {
      this.checkers.set(slug, checker);
    }

    transport.onMessage((msg) => {
      const msgType = msg["type"] as string;

      // Passthrough types — replies from the plugin, not service requests
      if (msgType === "response") {
        this.handlePluginResponse(msg as unknown as IpcResponseMessage);
        return;
      }
      if (msgType === "ready") {
        return; // Handled by SubprocessManager's waitForReady
      }
      if (msgType === "pong") {
        this.watchdog?.handlePong(slug);
        return;
      }
      if (msgType === "event.deliver.error") {
        const eventId = msg["id"] as string | undefined;
        const error = msg["error"] as string | undefined;
        log.warn("plugin event handler failed", { plugin: slug, eventId, error });
        return;
      }

      // --- Capability gate for plugin→runtime service requests ---
      const capability = buildCapabilityString(msg);
      if (capability !== null) {
        const pluginChecker = this.checkers.get(slug);

        if (!pluginChecker) {
          const msgId = msg["id"];
          log.warn("no capability checker attached — request denied", {
            plugin: slug,
            capability,
            correlationId: typeof msgId === "string" ? msgId : undefined,
          });
          if (typeof msgId === "string") {
            transport.send({
              type: "response",
              id: msgId,
              error: {
                code: "CAPABILITY_CHECKER_MISSING",
                message: `No capability checker attached for plugin '${slug}'; request for '${capability}' denied.`,
              },
            } as IpcMessage);
          }
          return;
        } else {
          const result = pluginChecker.check(capability);
          if (!result.ok) {
            // Denied — send response error back to plugin so the pending SDK promise rejects
            // immediately rather than timing out after 30s.
            const msgId = msg["id"];
            log.warn("capability denied", {
              plugin: slug,
              capability,
              message: result.message,
              correlationId: typeof msgId === "string" ? msgId : undefined,
            });
            if (typeof msgId === "string") {
              transport.send({
                type: "response",
                id: msgId,
                error: {
                  code: result.code,
                  message: `Permission '${result.permission}' is not declared in this plugin's manifest. Add it to the permissions array.`,
                },
              } as IpcMessage);
            }
            return;
          }
        }
      }

      // If we reach here, the message is an allowed service request.
      // Dispatch to the appropriate runtime service handler.
      if (msgType === "events.publish") {
        this.handleEventPublish(slug, msg, transport);
        return;
      }
      if (msgType === "events.subscribe") {
        this.handleEventSubscribe(slug, msg, transport);
        return;
      }
      if (msgType === "events.unsubscribe") {
        this.handleEventUnsubscribe(slug, msg, transport);
        return;
      }

      // --- Permissions dispatch ---
      if (msgType === "permissions.register") {
        if (!this.rolesEngine) {
          this.sendIpcError(transport, msg, "ROLES_ENGINE_UNAVAILABLE", "Roles engine is not initialized.");
          return;
        }
        handlePermissionsRegister(slug, msg, transport, this.rolesEngine);
        return;
      }
      if (msgType === "permissions.check") {
        if (!this.rolesEngine) {
          this.sendIpcError(transport, msg, "ROLES_ENGINE_UNAVAILABLE", "Roles engine is not initialized.");
          return;
        }
        handlePermissionsCheck(msg, transport, this.rolesEngine, (uid) => this.isUserOwner(uid));
        return;
      }
      if (msgType === "permissions.has_role") {
        if (!this.rolesEngine) {
          this.sendIpcError(transport, msg, "ROLES_ENGINE_UNAVAILABLE", "Roles engine is not initialized.");
          return;
        }
        handlePermissionsHasRole(msg, transport, this.rolesEngine);
        return;
      }
      if (msgType === "permissions.has_min_level") {
        if (!this.rolesEngine) {
          this.sendIpcError(transport, msg, "ROLES_ENGINE_UNAVAILABLE", "Roles engine is not initialized.");
          return;
        }
        handlePermissionsHasMinLevel(msg, transport, this.rolesEngine, (uid) => this.isUserOwner(uid));
        return;
      }
      if (msgType === "permissions.get_role") {
        if (!this.rolesEngine) {
          this.sendIpcError(transport, msg, "ROLES_ENGINE_UNAVAILABLE", "Roles engine is not initialized.");
          return;
        }
        handlePermissionsGetRole(msg, transport, this.rolesEngine);
        return;
      }
      if (msgType === "permissions.can_act_on") {
        if (!this.rolesEngine) {
          this.sendIpcError(transport, msg, "ROLES_ENGINE_UNAVAILABLE", "Roles engine is not initialized.");
          return;
        }
        handlePermissionsCanActOn(msg, transport, this.rolesEngine, (uid) => this.isUserOwner(uid));
        return;
      }

      // --- Cross-plugin data.read dispatch ---
      if (msgType === "data.read") {
        if (!this.pluginRegistry) {
          this.sendIpcError(transport, msg, "PLUGIN_REGISTRY_UNAVAILABLE", "Plugin registry is not initialized.");
          return;
        }
        handleDataRead(slug, msg, transport, this.pluginRegistry, this.openDatabaseFn);
        return;
      }

      // --- Core Module dispatch (core.*) — no capability required ---
      if (msgType.startsWith("core.")) {
        if (this.coreModule) {
          handleCoreIpc(msg, transport, this.coreModule);
        } else {
          this.sendIpcError(transport, msg, "CORE_UNAVAILABLE", "Core Module is not initialized.");
        }
        return;
      }

      // --- Scoped presence dispatch (presence.*) — gated on broadcast.clients ---
      // Capability gate already ran above via FIXED_CAPABILITY → broadcast.clients.
      if (msgType.startsWith("presence.")) {
        if (!this.presenceModule) {
          this.sendIpcError(transport, msg, "PRESENCE_UNAVAILABLE", "Scoped presence module is not initialized.");
          return;
        }
        handlePresenceIpc(slug, msg, transport, this.presenceModule);
        return;
      }

      // --- Own-database data.sql dispatch ---
      if (msgType === "data.sql") {
        if (!this.pluginDbCache) {
          this.sendIpcError(transport, msg, "DB_CACHE_UNAVAILABLE", "Plugin DB cache is not initialized.");
          return;
        }
        const cache = this.pluginDbCache;
        handleDataSql(slug, msg, transport, (s) => cache.get(s));
        return;
      }

      // --- Key-value store dispatch ---
      if (msgType === "data.kv") {
        if (!this.pluginDbCache) {
          this.sendIpcError(transport, msg, "DB_CACHE_UNAVAILABLE", "Plugin DB cache is not initialized.");
          return;
        }
        const cache = this.pluginDbCache;
        handleKv(slug, msg, transport, (s) => cache.get(s));
        return;
      }

      // --- Plugin file storage dispatch (spec-26) — gated on storage.file:self ---
      if (msgType === "storage.file") {
        if (!this.pluginRegistry) {
          this.sendIpcError(transport, msg, "PLUGIN_REGISTRY_UNAVAILABLE", "Plugin registry is not initialized.");
          return;
        }
        handleFiles(slug, msg, transport, this.pluginRegistry);
        return;
      }

      // --- Plugin settings store dispatch (spec-04 Amendment A) ---
      if (msgType === "data.config") {
        if (!this.pluginDbCache) {
          this.sendIpcError(transport, msg, "DB_CACHE_UNAVAILABLE", "Plugin DB cache is not initialized.");
          return;
        }
        const cache = this.pluginDbCache;
        const registry = this.pluginRegistry;
        handleConfig(
          slug,
          msg,
          transport,
          (s) => cache.get(s),
          (s) => registry?.getPlugin(s)?.manifest.settings,
        );
        return;
      }

      // --- Voice token dispatch (PR-4a) ---
      if (msgType === "voice.tokens") {
        if (!this.voiceIpcDeps) {
          this.sendIpcError(
            transport,
            msg,
            "VOICE_BRIDGE_UNAVAILABLE",
            "Voice bridge is not configured — runtime was booted without voice support.",
          );
          return;
        }
        const voiceDeps = this.voiceIpcDeps;
        handleVoiceTokensIpc(slug, msg, transport, voiceDeps).catch((err: unknown) => {
          const msgId = msg["id"];
          if (typeof msgId === "string") {
            transport.send({
              type: "response",
              id: msgId,
              error: {
                code: "TOKEN_MINT_FAILED",
                message: err instanceof Error ? err.message : String(err),
              },
            } as IpcMessage);
          }
        });
        return;
      }

      // --- Voice moderation dispatch (PR-6: admin "Stop their share") ---
      if (msgType === "voice.moderation") {
        if (!this.voiceIpcDeps) {
          this.sendIpcError(
            transport,
            msg,
            "VOICE_BRIDGE_UNAVAILABLE",
            "Voice bridge is not configured — runtime was booted without voice support.",
          );
          return;
        }
        const voiceDeps = this.voiceIpcDeps;
        handleVoiceModerationIpc(slug, msg, transport, voiceDeps).catch(
          (err: unknown) => {
            const msgId = msg["id"];
            if (typeof msgId === "string") {
              transport.send({
                type: "response",
                id: msgId,
                error: {
                  code: "VOICE_MODERATION_UNEXPECTED",
                  message: err instanceof Error ? err.message : String(err),
                },
              } as IpcMessage);
            }
          },
        );
        return;
      }

      // --- Plugin resource SDK dispatch (resources.*) — RP-FOUND-4 ---
      // The generic capability gate is intentionally skipped for resources.*
      // (they are in the passthrough set); the handler enforces caller
      // capabilities contextually — own-plugin is always allowed, cross-plugin
      // READ requires `resources.read:<plugin>`, cross-plugin WRITE is forbidden.
      // TODO(RP-FOUND-8): add a resources.* rate limiter once the backend is
      // wired at boot; resources.create can otherwise be called in a tight loop.
      if (msgType.startsWith("resources.")) {
        if (!this.pluginResourceDeps) {
          this.sendIpcError(
            transport,
            msg,
            "PLUGIN_RESOURCES_UNAVAILABLE",
            "Plugin resources are not configured — runtime was booted without the resource backend.",
          );
          return;
        }
        handlePluginResourcesIpc(slug, msg, transport, {
          ...this.pluginResourceDeps,
          checkCapability: (cap) => this.checkers.get(slug)?.check(cap).ok ?? false,
        });
        return;
      }

      // --- Outbound HTTP fetch dispatch ---
      if (msgType === "http.fetch") {
        handleHttpFetch(slug, msg, transport, this.centralHost).catch((err: unknown) => {
          const msgId = msg["id"];
          if (typeof msgId === "string") {
            transport.send({
              type: "response",
              id: msgId,
              error: {
                code: "FETCH_FAILED",
                message: err instanceof Error ? err.message : String(err),
              },
            } as IpcMessage);
          }
        });
        return;
      }

      // --- Scheduling dispatch ---
      if (msgType === "schedule.register") {
        const msgId = msg["id"];
        const name = msg["name"];
        const intervalMs = msg["interval_ms"];

        if (typeof msgId !== "string") return;

        if (typeof name !== "string" || name === "") {
          transport.send({ type: "response", id: msgId, error: { code: "INVALID_NAME", message: "schedule name must be a non-empty string." } } as IpcMessage);
          return;
        }
        if (typeof intervalMs !== "number" || intervalMs < 1000) {
          transport.send({ type: "response", id: msgId, error: { code: "INTERVAL_TOO_SHORT", message: "Minimum schedule interval is 1000ms." } } as IpcMessage);
          return;
        }

        let slugSchedules = this.pluginSchedules.get(slug);
        if (!slugSchedules) {
          slugSchedules = new Map();
          this.pluginSchedules.set(slug, slugSchedules);
        }
        const existing = slugSchedules.get(name);
        if (existing !== undefined) clearInterval(existing);

        const intervalId = setInterval(() => {
          transport.send({
            type: "request",
            id: crypto.randomUUID(),
            action: "schedule.tick",
            params: { name, firedAt: Date.now() },
            user: { id: "__runtime__", displayName: "Runtime", avatarUrl: "", role: "system" },
          } as IpcMessage);
        }, intervalMs);

        slugSchedules.set(name, intervalId);
        transport.send({ type: "response", id: msgId, result: null } as IpcMessage);
        return;
      }

      // --- Broadcast to WS clients dispatch ---
      if (msgType === "broadcast.toUsers") {
        const msgId = msg["id"];
        if (typeof msgId !== "string") return;

        const userIds = msg["userIds"];
        const event = msg["event"];
        const payload = msg["payload"];

        if (!Array.isArray(userIds) || (userIds as unknown[]).some((id) => typeof id !== "string")) {
          transport.send({ type: "response", id: msgId, error: { code: "INVALID_USER_IDS", message: "userIds must be an array of strings." } } as IpcMessage);
          return;
        }
        if ((userIds as string[]).length > 100) {
          transport.send({ type: "response", id: msgId, error: { code: "TOO_MANY_USER_IDS", message: "userIds array exceeds maximum length of 100." } } as IpcMessage);
          return;
        }
        if (typeof event !== "string" || event === "") {
          transport.send({ type: "response", id: msgId, error: { code: "INVALID_EVENT", message: "event must be a non-empty string." } } as IpcMessage);
          return;
        }

        // Prefix topic with plugin slug to prevent cross-plugin event spoofing.
        // NOTE (G9): The topic is prefixed with the plugin slug (e.g. "text-channels.status.update").
        // createPluginFrontend() in the frontend SDK is responsible for stripping this prefix
        // so plugin authors write sdk.on("status.update", handler) not the full namespaced topic.
        const topic = `${slug}.${event}`;

        // Encode once and size-check before fanning out. Large broadcasts
        // would amplify across every recipient, so reject at the plugin
        // boundary with a catchable error.
        const eventMsg: EventMessage = { type: "event", topic, payload };
        const encoded = this.codec.encode(eventMsg);
        const byteLength = encodedByteLength(encoded);
        if (byteLength > MAX_WS_OUTBOUND_BYTES) {
          transport.send({ type: "response", id: msgId, error: { code: "PAYLOAD_TOO_LARGE", message: `Broadcast payload (${String(byteLength)} bytes) exceeds the ${String(MAX_WS_OUTBOUND_BYTES)}-byte limit. Shrink the payload or expose the data via sdk.handle with pagination.` } } as IpcMessage);
          return;
        }

        for (const userId of userIds as string[]) {
          this.sendEncodedToUser(userId, encoded);
        }

        transport.send({ type: "response", id: msgId, result: null } as IpcMessage);
        return;
      }

      if (msgType === "broadcast.toAll") {
        const msgId = msg["id"];
        if (typeof msgId !== "string") return;

        const event = msg["event"];
        const payload = msg["payload"];

        if (typeof event !== "string" || event === "") {
          transport.send({ type: "response", id: msgId, error: { code: "INVALID_EVENT", message: "event must be a non-empty string." } } as IpcMessage);
          return;
        }

        // See NOTE (G9) above regarding slug-prefixed topic namespacing.
        const topic = `${slug}.${event}`;

        // Encode once, size-check, fan out with the already-encoded buffer.
        const eventMsg: EventMessage = { type: "event", topic, payload };
        const encoded = this.codec.encode(eventMsg);
        const byteLength = encodedByteLength(encoded);
        if (byteLength > MAX_WS_OUTBOUND_BYTES) {
          transport.send({ type: "response", id: msgId, error: { code: "PAYLOAD_TOO_LARGE", message: `Broadcast payload (${String(byteLength)} bytes) exceeds the ${String(MAX_WS_OUTBOUND_BYTES)}-byte limit. Shrink the payload or expose the data via sdk.handle with pagination.` } } as IpcMessage);
          return;
        }

        this.sendEncodedToAll(encoded);

        transport.send({ type: "response", id: msgId, result: null } as IpcMessage);
        return;
      }

      if (msgType === "schedule.unregister") {
        const msgId = msg["id"];
        const name = msg["name"];

        if (typeof name === "string") {
          const slugSchedules = this.pluginSchedules.get(slug);
          if (slugSchedules) {
            const existing = slugSchedules.get(name);
            if (existing !== undefined) {
              clearInterval(existing);
              slugSchedules.delete(name);
            }
          }
        }

        if (typeof msgId === "string") {
          transport.send({ type: "response", id: msgId, result: null } as IpcMessage);
        }
        return;
      }
    });
  }

  // -------------------------------------------------------------------------
  // Stale request cleanup — call periodically
  // -------------------------------------------------------------------------

  /**
   * Remove pending requests older than maxAgeMs and send timeout errors
   * to the originating clients. Returns the number of timed-out requests.
   */
  cleanupStaleRequests(maxAgeMs: number): number {
    const now = Date.now();
    let count = 0;

    for (const [corrId, pending] of this.pendingRequests) {
      if (now - pending.createdAt >= maxAgeMs) {
        this.pendingRequests.delete(corrId);
        this.sendToConnection(pending.connectionId, {
          type: "response",
          id: pending.clientRequestId,
          error: {
            code: "REQUEST_TIMEOUT",
            message: `Request to ${pending.plugin}/${corrId} timed out after ${maxAgeMs}ms.`,
          },
        } satisfies ResponseMessage);
        count++;
      }
    }

    return count;
  }

  getPendingRequestCount(): number {
    return this.pendingRequests.size;
  }

  // -------------------------------------------------------------------------
  // Internal: request routing
  // -------------------------------------------------------------------------

  private handleRequest(connectionId: string, message: RequestMessage): void {
    const user = this.connectionUsers.get(connectionId);
    if (!user) return;

    // --- Core Module: plugin: "core" requests are handled inline, no subprocess ---
    if (message.plugin === "core") {
      if (!this.coreModule) {
        this.sendToConnection(connectionId, {
          type: "response",
          id: message.id,
          error: { code: "CORE_UNAVAILABLE", message: "Core Module is not initialized." },
        } satisfies ResponseMessage);
        return;
      }

      // Rate limit core actions the same as plugin requests.
      if (this.rateLimiter) {
        const result = this.rateLimiter.consume(
          `ws:request:${user.id}:core`,
          RATE_WS_REQUEST,
        );
        if (!result.allowed) {
          this.sendToConnection(connectionId, {
            type: "response",
            id: message.id,
            error: { code: "RATE_LIMITED", message: `Too many core requests. Retry after ${String(result.retryAfterMs)}ms.` },
          } satisfies ResponseMessage);
          return;
        }
      }

      const action = message.action;
      const params = message.params as Record<string, unknown>;

      // Core requests are handled inline — no IPC round-trip — so they emit
      // a single trace line instead of the "→ dispatch" / "← dispatch" pair.
      // `plugin: "core"` keeps grepping symmetrical with plugin-routed lines.
      log.debug("ws request (core)", {
        reqId: message.id,
        connId: connectionId,
        plugin: "core",
        action,
        userId: user.id,
      });

      handleCoreClientAction(
        action,
        params,
        user.id,
        user.role === "owner",
        this.coreModule,
        this.rolesEngine,
        (result) => {
          this.sendToConnection(connectionId, {
            type: "response",
            id: message.id,
            result,
          } satisfies ResponseMessage);
          // Disconnect the banned user's active session immediately.
          if (action === "core.ban.create" && typeof params["user_id"] === "string") {
            this.disconnectUser(params["user_id"], 4003, "You have been banned.");
          }
        },
        (code, msg) => {
          this.sendToConnection(connectionId, {
            type: "response",
            id: message.id,
            error: { code, message: msg },
          } satisfies ResponseMessage);
        },
        (topic, payload) => this.broadcastEvent(topic, payload),
      );
      return;
    }

    const pluginProcess = this.resolvePlugin(connectionId, message.plugin, message.id);
    if (!pluginProcess) return;

    // Rate limit: sdk.request() — 60/min per user per plugin
    if (this.rateLimiter) {
      const result = this.rateLimiter.consume(
        `ws:request:${user.id}:${message.plugin}`,
        RATE_WS_REQUEST,
      );
      if (!result.allowed) {
        this.sendToConnection(connectionId, {
          type: "response",
          id: message.id,
          error: {
            code: "RATE_LIMITED",
            message: `Too many requests to ${message.plugin}. Retry after ${String(result.retryAfterMs)}ms.`,
          },
        } satisfies ResponseMessage);
        return;
      }
    }

    const correlationId = crypto.randomUUID();

    this.pendingRequests.set(correlationId, {
      connectionId,
      clientRequestId: message.id,
      plugin: message.plugin,
      createdAt: Date.now(),
    });

    // One debug line per request frame so operators can grep
    // `reqId=<message.id>` to find both halves of the round-trip (this line
    // and the matching "ipc response → ws dispatch" emitted by
    // handlePluginResponse). `correlationId` joins the runtime side to the
    // plugin's own logs, where it appears as the IPC msg id.
    log.debug("ws request → ipc dispatch", {
      reqId: message.id,
      connId: connectionId,
      correlationId,
      plugin: message.plugin,
      action: message.action,
      userId: user.id,
    });

    sendPluginRequest(
      pluginProcess,
      message.action,
      message.params,
      {
        id: user.id,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
        role: user.role,
      },
      correlationId,
      // Stamp the originating WS session so the SDK can pin it in
      // AsyncLocalStorage for nested sdk.presence.* calls.
      connectionId,
    );
  }

  private handlePluginResponse(msg: IpcResponseMessage): void {
    const pending = this.pendingRequests.get(msg.id);
    if (!pending) return; // Orphaned response (client disconnected or already timed out)

    this.pendingRequests.delete(msg.id);

    const response: ResponseMessage = {
      type: "response",
      id: pending.clientRequestId,
      ...(msg.error !== undefined ? { error: msg.error } : { result: msg.result }),
    };

    // Companion of the "ws request → ipc dispatch" debug line — same
    // reqId/correlationId so a grep for either id pulls the full round-trip
    // including measured plugin-handle latency.
    log.debug("ipc response → ws dispatch", {
      reqId: pending.clientRequestId,
      connId: pending.connectionId,
      correlationId: msg.id,
      plugin: pending.plugin,
      durationMs: Date.now() - pending.createdAt,
      ok: msg.error === undefined,
    });

    this.sendToConnection(pending.connectionId, response);
  }

  // -------------------------------------------------------------------------
  // Internal: event bus dispatch
  // -------------------------------------------------------------------------

  private handleEventPublish(
    slug: string,
    msg: IpcMessage,
    transport: StdioParentTransport,
  ): void {
    if (!this.eventBus) {
      this.sendEventAck(transport, msg, false, "EVENT_BUS_UNAVAILABLE", "Event bus is not initialized.");
      return;
    }

    const topic = msg["topic"] as string;
    const payload = msg["payload"];
    const version = typeof msg["version"] === "number" ? (msg["version"] as number) : undefined;

    const result = this.eventBus.publish(slug, topic, payload, version);

    if (!result.ok) {
      this.sendEventAck(transport, msg, false, result.error.code, result.error.message);
      return;
    }

    this.sendEventAck(transport, msg, true, undefined, undefined, result.eventId);

    // Broadcast to all connected WS clients
    this.broadcastEvent(topic, payload);
  }

  private handleEventSubscribe(
    slug: string,
    msg: IpcMessage,
    transport: StdioParentTransport,
  ): void {
    if (!this.eventBus) {
      this.sendEventAck(transport, msg, false, "EVENT_BUS_UNAVAILABLE", "Event bus is not initialized.");
      return;
    }

    if (this.rateLimiter) {
      const result = this.rateLimiter.consume(
        `ws:subscribe:${slug}`,
        RATE_WS_SUBSCRIBE,
      );
      if (!result.allowed) {
        this.sendEventAck(
          transport,
          msg,
          false,
          "RATE_LIMITED",
          "Subscribe rate limit exceeded",
        );
        return;
      }
    }

    const topic = msg["topic"] as string;
    const overflowPolicy = (msg["overflow_policy"] as OverflowPolicy | undefined) ?? "mark_unhealthy";
    const queueSize = typeof msg["queue_size"] === "number" ? (msg["queue_size"] as number) : 1024;

    const result = this.eventBus.subscribe({
      pluginSlug: slug,
      topicPattern: topic,
      overflowPolicy,
      queueSize,
    });

    if (!result.ok) {
      this.sendEventAck(transport, msg, false, result.error.code, result.error.message);
      return;
    }

    this.sendEventAck(transport, msg, true);
  }

  private handleEventUnsubscribe(
    slug: string,
    msg: IpcMessage,
    transport: StdioParentTransport,
  ): void {
    if (!this.eventBus) {
      this.sendEventAck(transport, msg, false, "EVENT_BUS_UNAVAILABLE", "Event bus is not initialized.");
      return;
    }

    const topic = msg["topic"] as string;
    this.eventBus.unsubscribe(slug, topic);
    this.sendEventAck(transport, msg, true);
  }

  private sendEventAck(
    transport: StdioParentTransport,
    msg: IpcMessage,
    ok: boolean,
    code?: string,
    message?: string,
    eventId?: string,
  ): void {
    const id = msg["id"];
    if (typeof id !== "string") return; // no correlation ID → no ack

    const ack: IpcEventAckMessage = { type: "event.ack", id, ok };
    if (eventId !== undefined) ack.event_id = eventId;
    if (!ok && code !== undefined && message !== undefined) {
      ack.error = { code, message };
    }

    transport.send(ack as unknown as IpcMessage);
  }

  broadcastEvent(topic: string, payload: unknown): void {
    const eventMsg: EventMessage = {
      type: "event",
      topic,
      payload,
    };
    // Encode once and reuse across every connection. This is both a perf win
    // on fan-out and required for size-checking at the plugin-facing
    // dispatcher above (which uses sendEncodedToAll with a pre-encoded buffer).
    const encoded = this.codec.encode(eventMsg);
    this.sendEncodedToAll(encoded);
  }

  broadcastEventToUser(userId: string, topic: string, payload: unknown): void {
    const eventMsg: EventMessage = { type: "event", topic, payload };
    const encoded = this.codec.encode(eventMsg);
    this.sendEncodedToUser(userId, encoded);
  }

  /** Send a pre-encoded frame to every connected client. Internal use. */
  private sendEncodedToAll(encoded: string | Uint8Array): void {
    for (const [, sender] of this.connections) {
      try {
        sender.send(encoded as string);
      } catch {
        // Connection may have closed
      }
    }
  }

  /** Send a pre-encoded frame to every connection owned by a single user. Internal use. */
  private sendEncodedToUser(userId: string, encoded: string | Uint8Array): void {
    const userConns = this.userConnections.get(userId);
    if (!userConns) return;
    for (const connId of userConns) {
      const sender = this.connections.get(connId);
      if (!sender) continue;
      try {
        sender.send(encoded as string);
      } catch {
        // Connection may have closed
      }
    }
  }

  // -------------------------------------------------------------------------
  // Internal: helpers
  // -------------------------------------------------------------------------

  private isUserOwner(userId: string): boolean {
    const connected = this.connectedUsers.get(userId);
    return connected?.user.role === "owner";
  }

  private sendIpcError(
    transport: StdioParentTransport,
    msg: IpcMessage,
    code: string,
    message: string,
  ): void {
    const id = msg["id"];
    if (typeof id !== "string") return;
    transport.send({ type: "response", id, error: { code, message } } as IpcMessage);
  }

  /** Cancel all active schedules for a plugin (called on respawn or stop). */
  private clearPluginSchedules(slug: string): void {
    const schedules = this.pluginSchedules.get(slug);
    if (!schedules) return;
    for (const [, id] of schedules) {
      clearInterval(id);
    }
    this.pluginSchedules.delete(slug);
  }

  /** Remove all scheduling state for a plugin that has exited. */
  detachPlugin(slug: string): void {
    this.clearPluginSchedules(slug);
  }

  private resolvePlugin(
    connectionId: string,
    pluginSlug: string,
    requestId?: string,
  ): PluginProcess | null {
    const pluginProcess = this.subprocessManager.getProcess(pluginSlug);

    if (!pluginProcess) {
      if (requestId !== undefined) {
        this.sendToConnection(connectionId, {
          type: "response",
          id: requestId,
          error: {
            code: "PLUGIN_NOT_FOUND",
            message: `Plugin "${pluginSlug}" is not loaded.`,
          },
        } satisfies ResponseMessage);
      }
      return null;
    }

    if (pluginProcess.state !== "ready") {
      if (requestId !== undefined) {
        this.sendToConnection(connectionId, {
          type: "response",
          id: requestId,
          error: {
            code: "PLUGIN_NOT_READY",
            message: `Plugin "${pluginSlug}" is not ready (state: ${pluginProcess.state}).`,
          },
        } satisfies ResponseMessage);
      }
      return null;
    }

    return pluginProcess;
  }

  /**
   * Send a single encoded frame at one connection. Public so subsystems that
   * live outside the router (e.g. Co-View) can push frames at connections
   * without funnelling everything back through router-internal handlers.
   */
  sendToConnection(connectionId: string, message: unknown): void {
    const sender = this.connections.get(connectionId);
    if (!sender) return;

    try {
      sender.send(this.codec.encode(message));
    } catch {
      // Connection may have closed between check and send
    }
  }

  /**
   * Force-close a WebSocket connection with a status code + reason. Used by
   * subsystems that need to terminate a misbehaving client after sending a
   * final NAK.
   * No-op if the connection is already gone.
   */
  closeConnection(connectionId: string, code: number, reason: string): void {
    const sender = this.connections.get(connectionId);
    if (!sender) return;
    try {
      sender.close(code, reason);
    } catch {
      // Already closed.
    }
    this.removeConnection(connectionId);
  }
}

// ---------------------------------------------------------------------------
// Capability string construction
// ---------------------------------------------------------------------------

/** IPC message types that are replies/passthrough — never capability-checked. */
const PASSTHROUGH_TYPES = new Set([
  "response",
  "ready",
  "pong",
  // Event delivery error reports from plugin handlers — infrastructure, not a capability
  "event.deliver.error",
  // Permissions are runtime services available to every plugin — no capability required
  "permissions.register",
  "permissions.check",
  "permissions.has_role",
  "permissions.has_min_level",
  "permissions.get_role",
  "permissions.can_act_on",
  // core.* handled by startsWith("core.") in buildCapabilityString below
  // Unsubscribing should always be allowed — a plugin must be able to stop
  // listening to a topic it previously subscribed to without declaring a capability.
  "events.unsubscribe",
  // Plugin settings (spec-04 Amendment A) — every plugin always has read
  // access to its own _config table; admin writes happen via HTTP.
  "data.config",
]);

/** IPC message types where scope is always "self" (plugin's own resources). */
const SELF_SCOPED_TYPES = new Set([
  "data.sql",
  "data.kv",
  "storage.file",
  // Voice — see pr-4-voice-contract.md §2. The capability `voice.tokens:self`
  // gates the entire voice.tokens IPC type; per-method scoping is the
  // method-discriminator inside the message, not the capability string.
  "voice.tokens",
  // PR-6 §1: voice.moderation gates the admin "Stop their share"
  // RemoveParticipant call. Capability is plugin-scoped because the trust
  // boundary that decides *which* user gets kicked is the plugin handler
  // itself — runtime IPC just forwards once the plugin has decided.
  "voice.moderation",
]);

/** IPC message types where scope comes from a specific message field. */
const FIELD_SCOPED: Record<string, string> = {
  "events.publish": "topic",
  "events.subscribe": "topic",
  "http.fetch": "host",
};

/** IPC message types that map to a fixed capability string (no scope). */
const FIXED_CAPABILITY: Record<string, string> = {
  "schedule.register": "runtime.schedule",
  "schedule.unregister": "runtime.schedule",
  "broadcast.toUsers": "broadcast.clients",
  "broadcast.toAll": "broadcast.clients",
  // Scoped presence — folded into broadcast.clients per spec-23 §"Locked
  // Decisions" so plugins that can already push to clients get presence
  // for free, with no second permission to reason about.
  "presence.join": "broadcast.clients",
  "presence.leave": "broadcast.clients",
  "presence.update": "broadcast.clients",
  "presence.list": "broadcast.clients",
};

/** IPC message types where scope is derived from multiple fields. */
const COMPOSITE_SCOPED: Record<string, readonly string[]> = {
  "data.read": ["plugin", "table"],
};

/**
 * Map an IPC message from a plugin to the capability string that must be
 * checked. Returns `null` for passthrough types that don't need gating.
 *
 * Examples:
 *   { type: "data.sql", ... }              → "data.sql:self"
 *   { type: "events.publish", topic: "t" } → "events.publish:t"
 *   { type: "response", ... }              → null (passthrough)
 */
export function buildCapabilityString(msg: IpcMessage): string | null {
  const msgType = msg["type"] as string;

  if (PASSTHROUGH_TYPES.has(msgType)) return null;
  // All core.* actions are available to every plugin without capability declarations.
  if (msgType.startsWith("core.")) return null;
  // resources.* (RP-FOUND-4) bypass the generic gate: their authorization is
  // context-dependent (own-plugin allowed; cross-plugin read needs
  // `resources.read:<plugin>`; cross-plugin write forbidden) and is enforced
  // inside handlePluginResourcesIpc BEFORE the resolver/store is consulted.
  if (msgType.startsWith("resources.")) return null;

  // Self-scoped: data.sql, data.kv, storage.file
  if (SELF_SCOPED_TYPES.has(msgType)) {
    return `${msgType}:self`;
  }

  // Fixed-capability: schedule.register, schedule.unregister
  const fixedCap = FIXED_CAPABILITY[msgType];
  if (fixedCap !== undefined) return fixedCap;

  // Field-scoped: events.publish, events.subscribe, http.fetch
  const field = FIELD_SCOPED[msgType];
  if (field !== undefined) {
    const scope = msg[field];
    if (typeof scope === "string") {
      return `${msgType}:${scope}`;
    }
    // Missing scope field — capability string is just the type (will be denied
    // unless the plugin has a scopeless permission, which is unlikely)
    return msgType;
  }

  // Composite-scoped: data.read (scope = plugin.table)
  const compositeFields = COMPOSITE_SCOPED[msgType];
  if (compositeFields !== undefined) {
    const parts = compositeFields.map((f) => msg[f]);
    if (parts.every((p) => typeof p === "string")) {
      return `${msgType}:${(parts as string[]).join(".")}`;
    }
    return msgType;
  }

  // Scope-less types: auth.currentUser, runtime.log, runtime.plugin.install, etc.
  return msgType;
}
