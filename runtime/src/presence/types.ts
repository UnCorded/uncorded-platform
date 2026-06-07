// Internal types and error codes for the scoped presence module.

import type { PresenceEntry } from "@uncorded/protocol";

/**
 * Internal representation of a presence entry. Mirrors the wire-level
 * PresenceEntry plus the owning plugin slug (which is implicit in the scope
 * but kept explicit for O(s) plugin-unload eviction).
 */
export interface PresenceEntryInternal extends PresenceEntry {
  plugin_slug: string;
}

export type EvictionReason = "explicit" | "session_closed" | "plugin_unloaded";

/**
 * Typed error codes surfaced to plugin authors. Names per the implementation
 * decision documented in the PR description.
 *
 * - PRESENCE_RATE_EXCEEDED: combined join/update/leave rate per (user, scope)
 *   has crossed the spec's input ceiling (~120/sec).
 * - PRESENCE_META_TOO_LARGE: serialized meta exceeds 1 KB.
 * - PRESENCE_SCOPE_INVALID: scope contains whitespace, control chars, or is
 *   not ASCII printable.
 * - PRESENCE_SCOPE_LENGTH: scope exceeds 200 chars after auto-prefixing.
 * - PRESENCE_NO_SESSION_CONTEXT: SDK-side; raised when join/leave/update is
 *   called outside an active sdk.handle() handler.
 * - PRESENCE_CROSS_PLUGIN_SCOPE: scope's first dot-segment names another
 *   installed plugin's slug.
 * - PRESENCE_SESSION_GONE: WS session closed between request issue and the
 *   join/update IPC arriving (race resolution; not in spec text — flagged for
 *   spec amendment).
 * - PRESENCE_UNAVAILABLE: module not initialized in the runtime.
 */
export const PRESENCE_ERROR_CODES = {
  RATE_EXCEEDED: "PRESENCE_RATE_EXCEEDED",
  META_TOO_LARGE: "PRESENCE_META_TOO_LARGE",
  SCOPE_INVALID: "PRESENCE_SCOPE_INVALID",
  SCOPE_LENGTH: "PRESENCE_SCOPE_LENGTH",
  NO_SESSION_CONTEXT: "PRESENCE_NO_SESSION_CONTEXT",
  CROSS_PLUGIN_SCOPE: "PRESENCE_CROSS_PLUGIN_SCOPE",
  SESSION_GONE: "PRESENCE_SESSION_GONE",
  UNAVAILABLE: "PRESENCE_UNAVAILABLE",
} as const;

export type PresenceErrorCode =
  (typeof PRESENCE_ERROR_CODES)[keyof typeof PRESENCE_ERROR_CODES];

export interface PresenceError {
  code: PresenceErrorCode;
  message: string;
  retry_after_ms?: number;
}

export type PresenceResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: PresenceError };

/** Hard bounds enforced at the runtime boundary, per spec §"Bounds and Limits". */
export const PRESENCE_LIMITS = {
  /** Combined join + update + leave per (user, scope) per second. */
  INPUT_RATE_PER_SEC: 120,
  /** Serialized JSON byte cap on `meta`. */
  META_BYTES_MAX: 1024,
  /** Scope length after auto-prefixing. */
  SCOPE_LENGTH_MAX: 200,
  /** Spec range for SDK coalesceMs (0 = per-event delivery, 500 = max). */
  COALESCE_MS_MIN: 0,
  COALESCE_MS_MAX: 500,
  COALESCE_MS_DEFAULT: 50,
  /**
   * Soft cap for per-scope entry count — spec calls this a "design smell"
   * threshold; we log a structured warning once per scope crossing the line
   * and continue accepting joins. No hard rejection.
   */
  SOFT_ENTRIES_PER_SCOPE: 10_000,
} as const;
