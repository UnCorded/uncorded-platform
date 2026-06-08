// CoView entitlement-class cache key serializer (CV-FOUND-2 — skeleton).
//
// Per-viewer projection cannot be O(viewers × nodes × frames). The fix
// (foundation-plan §4.7) is to group viewers into *entitlement classes* and
// project once per class. The load-bearing primitive is a DETERMINISTIC,
// canonical serialization of an entitlement class so two viewers share a
// projection only when every entitlement-affecting field matches — preventing
// over-broad cache sharing across owner / moderator / banned / whitelist /
// blacklist / render-mode differences.
//
// SCOPE — this file is the serializer ONLY (the "cache skeleton"). The cache
// store, the top-level cache key (session id + render mode + permission version
// + surface/schema version + frame seq, §4.7), and cache invalidation wiring are
// intentionally deferred: invalidation is the explicit subject of CV-FOUND-5 in
// the PR sequence (foundation-plan §7), and standing up a store here without it
// would be a half-built mechanism. Shipping just the deterministic key now lets
// CV-FOUND-2's projector and later PRs build on a fixed, tested serialization.
//
// This module is pure: no state, no I/O, no clock.

/** A viewer's render mode for a session (foundation-plan §4.7, §4.5). */
export type CoViewRenderMode = "as-host" | "as-viewer";

/**
 * The entitlement-affecting facts about one viewer, in a session, that decide
 * which projection they may share (foundation-plan §4.7).
 *
 * Every field uses CANONICAL protocol ids/casing, never display labels: role
 * ids, feature flags, etc. are the authoritative ids. The runtime derives these
 * from authoritative sources (roles engine, ban/membership signals, session
 * config) — they are not viewer-supplied, exactly as `ViewerContext` is kept
 * minimal in the resolver layer.
 */
export interface CoViewEntitlementClass {
  /** Canonical role ids held by the viewer. Order-insensitive (sorted here). */
  roleSet: readonly string[];
  sessionVisibilityMode: "public" | "private";
  whitelistMembership: boolean;
  blacklistMembership: boolean;
  owner: boolean;
  banned: boolean;
  moderator: boolean;
  /**
   * The viewer's render mode. Serialized ONLY when it differs from the session
   * top-level render mode (foundation-plan §4.7) — when it matches, it is already
   * captured by the top-level cache key and would be redundant noise in the
   * class key. Omit (or pass equal to top-level) for "same as session".
   */
  renderMode?: CoViewRenderMode | undefined;
  /** Canonical per-view feature flags. Order-insensitive (sorted here). */
  featureFlags: readonly string[];
}

const SET_SEPARATOR = ",";
const FIELD_SEPARATOR = "\n";

function flag(b: boolean): "0" | "1" {
  return b ? "1" : "0";
}

/**
 * Bytewise-stable sort of canonical ids (foundation-plan §4.7: "sorted bytewise
 * by canonical id"). Canonical ids are ASCII, for which JS's default
 * code-unit-ordering `sort()` is bytewise. A copy is sorted so the caller's array
 * is never mutated.
 */
function sortCanonical(ids: readonly string[]): string[] {
  return [...ids].sort();
}

/**
 * Serialize an entitlement class into its canonical string form (foundation-plan
 * §4.7). The field order is FIXED here and never derived from object iteration
 * order; sets are sorted; booleans are `0`/`1`; an empty set serializes as an
 * empty value (e.g. `role_set=`), never an omitted field. `render_mode` is the
 * one conditional field — present only when distinct from `topLevelRenderMode`.
 *
 * The output is a single string suitable for use directly as a map key or for
 * hashing into a fixed-width cache key. Two viewers may share a projection only
 * when this string is byte-for-byte identical.
 *
 * @param ec                 The viewer's entitlement class.
 * @param topLevelRenderMode The session top-level render mode, used to decide
 *                           whether the `render_mode` line is emitted.
 */
export function serializeEntitlementClass(
  ec: CoViewEntitlementClass,
  topLevelRenderMode: CoViewRenderMode,
): string {
  // Field order is fixed in this array literal; we never iterate object keys.
  const fields: string[] = [
    `role_set=${sortCanonical(ec.roleSet).join(SET_SEPARATOR)}`,
    `session_visibility_mode=${ec.sessionVisibilityMode}`,
    `whitelist_membership_flag=${flag(ec.whitelistMembership)}`,
    `blacklist_membership_flag=${flag(ec.blacklistMembership)}`,
    `owner_flag=${flag(ec.owner)}`,
    `banned_flag=${flag(ec.banned)}`,
    `moderator_flag=${flag(ec.moderator)}`,
  ];

  // render_mode is emitted ONLY when the viewer's mode is distinct from the
  // session top-level mode (§4.7). Equal/omitted → the line is absent, keeping
  // the class key minimal and matching the top-level key that already carries it.
  if (ec.renderMode !== undefined && ec.renderMode !== topLevelRenderMode) {
    fields.push(`render_mode=${ec.renderMode}`);
  }

  fields.push(`feature_flags=${sortCanonical(ec.featureFlags).join(SET_SEPARATOR)}`);

  return fields.join(FIELD_SEPARATOR);
}
