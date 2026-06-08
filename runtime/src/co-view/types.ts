// Internal types for the Co-View Sessions subsystem (spec-27).
//
// Wire types live in @uncorded/protocol; these are runtime-internal session,
// member, and dependency shapes. PR-CV1 scope: lifecycle only — state, event,
// cursor, and pen channels land in PR-CV2+ and are intentionally absent here.

import type { Database } from "bun:sqlite";
import type { Logger } from "@uncorded/shared";
import type {
  ClientMessage,
  CoViewCursorState,
  CoViewEndReason,
  CoViewMemberLeftReason,
  CoViewRenderMode,
  CoViewStateSnapshot,
  CoViewSurfaceRegistry,
  CoViewVisibility,
  WsCoViewCursor,
  WsCoViewEndReq,
  WsCoViewEvent,
  WsCoViewJoinReq,
  WsCoViewKickReq,
  WsCoViewLeaveReq,
  WsCoViewListReq,
  WsCoViewRenderTreeFrame,
  WsCoViewSnapshotReq,
  WsCoViewSnapshotRes,
  WsCoViewStartReq,
  WsCoViewState,
  WsCoViewUpdateReq,
} from "@uncorded/protocol";
import type { CoreModule } from "../core";
import type { RolesEngine } from "../roles/engine";
import type { EventBus } from "../events/bus";
import type { ScopedPresenceModule } from "../presence";
import type { AuthenticatedUser } from "../ws/types";
import type { CoViewValueResolver } from "./render-tree-projection";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Synthetic plugin slug under which Co-View claims its presence-scope
 * namespace. Co-View is a runtime/shell feature (not a plugin), so it has no
 * manifest entry — but `ScopedPresenceModule.join()` requires a caller slug
 * for prefixing. Using "co-view" produces fully-qualified scopes of the form
 * `co-view.session.<id>`, which the cross-plugin check accepts because no real
 * plugin installs with this slug (and if a malicious manifest tried, the
 * registry installer would have surfaced it elsewhere).
 */
export const CO_VIEW_PRESENCE_SLUG = "co-view";

export const CO_VIEW_LIMITS = {
  /** Host disconnect grace window (spec §Locked Decisions + §Bounds and Limits). */
  HOST_DISCONNECT_GRACE_MS: 60 * 1_000,
  /** Soft viewer cap — joins above this emit a warn + audit but still succeed. */
  SOFT_VIEWER_CAP: 25,
  /** Hard viewer cap — joins above this are rejected with session_full. */
  HARD_VIEWER_CAP: 50,
  /** Custom redaction selectors per session. */
  CUSTOM_SELECTORS_MAX: 32,
  /** Per-selector length cap (chars). */
  CUSTOM_SELECTOR_LENGTH_MAX: 256,
  /** Hard cap on the serialized JSON size of a single `co-view.state` diff (bytes). */
  STATE_DIFF_BYTES_MAX: 16 * 1024,
  /** Hard cap on the serialized JSON size of a single `co-view.event` payload (bytes). */
  EVENT_PAYLOAD_BYTES_MAX: 4 * 1024,
  /** Per-member cursor frame rate cap (Hz). Excess silently dropped. */
  CURSOR_RATE_HZ: 30,
  /** Per-member `pen.stroke_point` rate cap (Hz). Excess silently dropped. */
  PEN_POINT_RATE_HZ: 60,
  /** Per-member `pen.stroke_begin` rate cap (Hz). Anti-spam. */
  PEN_BEGIN_RATE_HZ: 5,
  /**
   * Window inside which a duplicate `pen.clear` from the same
   * (member_id, scope) is coalesced — first forwards, second drops. Prevents
   * a member from amplifying broadcasts via repeated clears while preserving
   * correctness (a clear is idempotent).
   */
  PEN_CLEAR_COALESCE_MS: 100,
  /**
   * Per-cursor-frame coalesce window. If `(x, y, state)` matches the previous
   * accepted entry within this many ms, drop. Distinct from CURSOR_RATE_HZ —
   * coalesce is content-based, rate-limit is time-based.
   */
  CURSOR_COALESCE_MS: 33,
} as const;

// ---------------------------------------------------------------------------
// Internal session + member records
// ---------------------------------------------------------------------------

export interface CoViewRedactionsInternal {
  panelIds: Set<string>;
  pluginSlugs: Set<string>;
  customSelectors: string[];
}

export type CoViewMemberRole = "host" | "viewer";

export interface CoViewMemberInternal {
  userId: string;
  /** WS connection id (1:1 with WS session_id at this layer). */
  sessionId: string;
  joinedAt: number;
  color: string;
  role: CoViewMemberRole;
}

export interface CoViewSessionInternal {
  id: string;
  hostUserId: string;
  hostSessionId: string;
  visibility: CoViewVisibility;
  whitelist: Set<string>;
  blacklist: Set<string>;
  renderMode: CoViewRenderMode;
  redactions: CoViewRedactionsInternal;
  createdAt: number;
  /** WS session_id → member (host entry included; role differentiates). */
  members: Map<string, CoViewMemberInternal>;
  /** Tracks the highest concurrent viewer count seen for the audit on end. */
  peakViewers: number;
  /**
   * PR-CV5: host pause flag. When true, runtime drops inbound state / event
   * (non-pen) / cursor / pen frames from the HOST connection but still
   * accepts `co-view.update` (so the host can resume) and `co-view.end`.
   * Viewer-emitted pen + cursor frames continue to flow so viewers can
   * annotate the frozen surface. Toggled via `co-view.update.req` with
   * `paused: true | false`.
   */
  paused: boolean;
  /** null while host is connected; ms timestamp on host disconnect. */
  hostDisconnectedAt: number | null;
  /** setTimeout handle for the grace expiry; cleared on reconnect or end. */
  hostDisconnectTimer: ReturnType<typeof setTimeout> | null;
  /** Soft-cap warning state — flips true once a join crosses SOFT_VIEWER_CAP. */
  softCapWarned: boolean;
  /**
   * Highest `seq` accepted from the host on `co-view.state`. -1 = no state
   * frame seen yet. Used to detect regressions / duplicates; viewers do
   * their own gap detection and ask via `snapshot.req`.
   */
  lastSeq: number;
  /**
   * Cumulative shell-state snapshot — the running merge of every
   * `replay: "safe"` `co-view.state` diff. Empty `{}` until the host pushes
   * its first safe state; `null` is reserved for "no state yet" surfaced on
   * `join.ack.current_state_snapshot`.
   *
   * The runtime never inspects the shape of the snapshot; the producer-side
   * serializer (apps/website/src/co-view/state-schema.ts) owns the schema.
   * Audit logs MUST NOT include this object (spec §Audit Log: metadata only).
   */
  safeStateSnapshot: CoViewStateSnapshot;
  /**
   * Last-known cursor state per member. Key is the WS connection id
   * (member_id). Cleared on member-left + connection-close. Never persisted.
   */
  cursors: Map<string, CoViewCursorEntry>;
  /**
   * Per-(member, channel) rate-limit token timestamps. Each map records the
   * `Date.now()` of the most recently *accepted* frame on that channel; the
   * handler drops a frame whose `now - lastAccepted < 1000/HZ`. Tracking
   * `pen.stroke_point` and `pen.stroke_begin` separately so anti-spam on
   * begin doesn't starve point throughput.
   *
   * Critical: `pen.stroke_end` and `pen.clear` are NOT tracked here — those
   * frames are never rate-limit-dropped (dropping a terminal frame leaves
   * viewers stuck with in-flight strokes). `pen.clear` uses its own
   * duplicate-coalesce policy (see `lastClearTs`).
   */
  rateLimits: {
    cursor: Map<string, number>;
    penPoint: Map<string, number>;
    penBegin: Map<string, number>;
  };
  /**
   * Per-(member_id, scope) timestamp of the most recently forwarded
   * `pen.clear`. Used by the duplicate-coalesce policy: a second clear with
   * the same key inside `PEN_CLEAR_COALESCE_MS` is dropped (no broadcast).
   * One clear is idempotent and equivalent to many — this denies broadcast
   * amplification without sacrificing correctness. Key shape: `${memberId}|${scope}`.
   */
  lastClearTs: Map<string, number>;
}

export interface CoViewCursorEntry {
  x: number;
  y: number;
  state: CoViewCursorState;
  ts: number;
}

// ---------------------------------------------------------------------------
// Result types — Result<T, E> shape mirroring presence/types.ts
// ---------------------------------------------------------------------------

export const CO_VIEW_ERROR_CODES = {
  PERMISSION_DENIED: "permission_denied",
  ALREADY_HOSTING: "already_hosting",
  INVALID_PAYLOAD: "invalid_payload",
  NOT_HOST: "not_host",
  SESSION_NOT_FOUND: "session_not_found",
  SESSION_FULL: "session_full",
  BLACKLISTED: "blacklisted",
  NOT_INVITED: "not_invited",
  NOT_HOST_OR_MODERATOR: "not_host_or_moderator",
  TARGET_NOT_IN_SESSION: "target_not_in_session",
  STATE_TOO_LARGE: "state_too_large",
  EVENT_TOO_LARGE: "event_too_large",
  SEQ_REGRESSION: "seq_regression",
  NOT_MEMBER: "not_member",
} as const;

export type CoViewErrorCode =
  (typeof CO_VIEW_ERROR_CODES)[keyof typeof CO_VIEW_ERROR_CODES];

// ---------------------------------------------------------------------------
// Sender abstraction (decouples from MessageRouter internals)
// ---------------------------------------------------------------------------

export type SendToConnectionFn = (connectionId: string, message: unknown) => void;
export type GetConnectedUserFn = (connectionId: string) => AuthenticatedUser | undefined;

// ---------------------------------------------------------------------------
// Render-tree transport wiring (CV-FOUND-4b) — optional, disabled in production
// ---------------------------------------------------------------------------

/**
 * Injected wiring for the render-tree transport path. Production boot supplies
 * this as `undefined`, so the path stays disabled and unwired (the legacy
 * `co-view.state` channel is the only live producer→viewer path). Tests inject a
 * surface registry + value resolver test-double here to exercise the gated path.
 *
 * Even when present, the path stays gated behind
 * `CO_VIEW_RENDER_TREE_TRANSPORT_ENABLED` unless `enabled` is explicitly set —
 * so wiring the dependency in is not, by itself, enough to make it live.
 */
export interface CoViewRenderTreeTransportDeps {
  /** Surface schema registry used to gate protected-value provenance per viewer. */
  registry: CoViewSurfaceRegistry;
  /** The injected runtime value authority for gated values. */
  resolver: CoViewValueResolver;
  /**
   * Test-only override of the disabled module flag. Omitted in production, where
   * `CO_VIEW_RENDER_TREE_TRANSPORT_ENABLED` (false) governs.
   */
  enabled?: boolean | undefined;
}

// ---------------------------------------------------------------------------
// Client-message union for dispatch
// ---------------------------------------------------------------------------

export type CoViewClientMessage =
  | WsCoViewStartReq
  | WsCoViewUpdateReq
  | WsCoViewEndReq
  | WsCoViewJoinReq
  | WsCoViewLeaveReq
  | WsCoViewKickReq
  | WsCoViewListReq
  | WsCoViewState
  | WsCoViewEvent
  | WsCoViewCursor
  | WsCoViewSnapshotReq
  | WsCoViewSnapshotRes
  | WsCoViewRenderTreeFrame;

export function isCoViewClientMessage(msg: ClientMessage): msg is CoViewClientMessage {
  switch (msg.type) {
    case "co-view.start.req":
    case "co-view.update.req":
    case "co-view.end.req":
    case "co-view.join.req":
    case "co-view.leave.req":
    case "co-view.kick.req":
    case "co-view.list.req":
    case "co-view.state":
    case "co-view.event":
    case "co-view.cursor":
    case "co-view.snapshot.req":
    case "co-view.snapshot.res":
    case "co-view.render-tree.frame":
      return true;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Boot dependencies (consumed by startCoView)
// ---------------------------------------------------------------------------

export interface CoViewDeps {
  db: Database;
  logger: Logger;
  eventBus: EventBus;
  coreModule: CoreModule;
  rolesEngine: RolesEngine;
  presenceModule: ScopedPresenceModule;
  serverId: string;
  sendToConnection: SendToConnectionFn;
  getConnectedUser: GetConnectedUserFn;
  /** Injectable clock for deterministic tests. Defaults to Date.now. */
  now?: () => number;
  /** Injectable timer plumbing for tests; defaults to global setTimeout/clearTimeout. */
  setTimeout?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (handle: ReturnType<typeof setTimeout>) => void;
  /** Injectable id generator (for deterministic tests). Defaults to ulid-ish crypto.randomUUID. */
  generateSessionId?: () => string;
  /**
   * Optional render-tree transport wiring (CV-FOUND-4b). Undefined in
   * production — the transport path is disabled by default and unwired. When
   * present (tests), the path is still gated behind
   * `CO_VIEW_RENDER_TREE_TRANSPORT_ENABLED` unless `enabled` is set.
   */
  renderTreeTransport?: CoViewRenderTreeTransportDeps | undefined;
}

// ---------------------------------------------------------------------------
// Public handle returned by startCoView
// ---------------------------------------------------------------------------

export interface CoViewHandle {
  /** Dispatch a `co-view.*` client message arriving on `connectionId`. */
  dispatch(connectionId: string, message: CoViewClientMessage): Promise<void>;
  /** Notify the subsystem that a connection has closed. */
  onConnectionClose(connectionId: string): void;
  /** Test / observability accessor. */
  _internals(): {
    sessions: ReadonlyMap<string, CoViewSessionInternal>;
    /** sessions hosted by a given WS connection id (host side). */
    sessionByHostConnection: ReadonlyMap<string, string>;
  };
  /** Idempotent shutdown — clears any pending grace timers. */
  dispose(): void;
}

// Re-export for handler consumers.
export type { CoViewEndReason, CoViewMemberLeftReason };
