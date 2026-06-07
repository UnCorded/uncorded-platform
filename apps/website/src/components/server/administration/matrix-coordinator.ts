// Pure state-machine primitives for the permission matrix's optimistic
// overlay (spec-22 Amendment B PR 5). Extracted from `permission-matrix.tsx`
// so the reconciliation rules can be unit-tested without spinning up a
// SolidJS renderer.
//
// The component still owns the SolidJS signals; this module owns the
// transitions. Three primitives are exposed:
//
//   collapseQueue            — last-write-wins on a click queue, so a
//                              single grantMany sends the user's *latest*
//                              intent per permission key.
//   shouldDropOverlay        — the third-actor reconciliation rule. Returns
//                              true iff a `core.permission.changed` event
//                              should clear our optimistic overlay.
//   rollbackKeysOf           — extracts the failed permission keys from a
//                              partial-success grantMany response so the UI
//                              can roll back the overlay for those keys
//                              without disturbing the successful ones.

import type { TriState } from "./matrix-state";

/**
 * One queued click in the matrix's coalesce buffer. The component bumps
 * `generation` on every click so a delayed flush can ignore an entry that
 * the user has already overwritten.
 */
export interface PendingClick {
  permission: string;
  next: TriState;
  generation: number;
}

/**
 * One failed change inside a `core.permissions.grantMany` partial-success
 * response. Mirrors `CorePermissionGrantManySkipped` in @uncorded/protocol
 * but stays minimal so this module has no protocol dependency.
 */
export interface SkippedChange {
  permission: string;
  code: string;
  message: string;
}

/**
 * Collapse the click queue: keep the LAST click per permission key. The
 * matrix flushes clicks on a 250ms idle timer; if the user clicks the same
 * permission three times in that window we only need to send the final
 * value — the intermediate flips are noise.
 *
 * Per Map semantics: keys keep their FIRST-insertion slot in iteration
 * order; the value is overwritten. Order doesn't affect `grantMany`
 * correctness (the runtime applies each row independently), but the
 * stable order makes the wire payload deterministic for tests/logs.
 */
export function collapseQueue(items: readonly PendingClick[]): PendingClick[] {
  const collapsed = new Map<string, PendingClick>();
  for (const c of items) collapsed.set(c.permission, c);
  return Array.from(collapsed.values());
}

/**
 * Third-actor reconciliation rule. A `core.permission.changed` event must
 * NOT clear our optimistic overlay if any of the following is true:
 *   - inflight: our own mutation is round-tripping; the response will
 *     reconcile via the success path or the error rollback.
 *   - queueLength > 0: the user has clicked since we last flushed; the next
 *     flush will reconcile.
 *   - pendingSize === 0: there's nothing to drop.
 *
 * Returns true only when the event must be from someone else AND we have
 * stale overlay to drop.
 */
export function shouldDropOverlay(opts: {
  inflight: boolean;
  queueLength: number;
  pendingSize: number;
}): boolean {
  return !opts.inflight && opts.queueLength === 0 && opts.pendingSize > 0;
}

/**
 * Roll-back set for a `grantMany` partial-success response: every skipped
 * permission key. The matrix calls `clearPendingFor(rollbackKeysOf(skipped))`
 * to drop those keys from the overlay; the successful keys reconcile via
 * the upcoming `refetchRoles()` instead of being held in pending limbo.
 */
export function rollbackKeysOf(
  skipped: readonly SkippedChange[],
): Set<string> {
  return new Set(skipped.map((s) => s.permission));
}

/**
 * Whether the matrix should show its search input. Per PR 5.3: shown when
 * any single plugin group exceeds 25 registered permissions, since the
 * row count starts to outpace what fits on a settings sheet without
 * scrolling for an irritating amount of time.
 */
export function shouldShowMatrixSearch(
  groups: readonly { perms: readonly { key: string }[] }[],
  threshold = 25,
): boolean {
  for (const g of groups) {
    if (g.perms.length > threshold) return true;
  }
  return false;
}

/**
 * Filter a permission-group listing by a free-text query. Matches against
 * the permission key and the human description, case-insensitive. Empty
 * query returns the input unchanged. Groups that end up with zero matches
 * are dropped so the matrix doesn't render empty section headers.
 */
export function filterGroupsByQuery<
  G extends { slug: string; perms: readonly P[] },
  P extends { key: string; description: string },
>(groups: readonly G[], query: string): G[] {
  const trimmed = query.trim().toLowerCase();
  if (trimmed === "") return groups.slice();
  const out: G[] = [];
  for (const g of groups) {
    const filtered = g.perms.filter(
      (p) =>
        p.key.toLowerCase().includes(trimmed) ||
        p.description.toLowerCase().includes(trimmed),
    );
    if (filtered.length === 0) continue;
    out.push({ ...g, perms: filtered });
  }
  return out;
}
