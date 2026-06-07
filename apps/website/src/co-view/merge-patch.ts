// JSON Merge Patch (RFC 7396) — viewer-side mirror of the runtime helper.
//
// Used by the consumer to fold `co-view.state` diff frames into its local
// snapshot. Mutates the target in place. Semantics match the runtime
// implementation in `runtime/src/co-view/merge-patch.ts` exactly — they MUST
// stay in lockstep, otherwise viewers and the runtime cache disagree on what
// "current state" means for a mid-session joiner.
//
// Arrays are opaque (replace, never merge) per RFC 7396.

import type { CoViewStateDiff, CoViewStateSnapshot } from "@uncorded/protocol";

export function applyMergePatch(
  target: CoViewStateSnapshot,
  patch: CoViewStateDiff,
): void {
  for (const key of Object.keys(patch)) {
    const value = patch[key];
    if (value === null) {
      delete target[key];
      continue;
    }
    if (isPlainObject(value)) {
      const existing = target[key];
      const next = isPlainObject(existing) ? existing : {};
      applyMergePatch(next, value);
      target[key] = next;
      continue;
    }
    target[key] = value;
  }
}

/**
 * Compute a JSON-merge-patch (RFC 7396) that, when applied to `from`, yields
 * `to`. Used by the producer to compress consecutive snapshots into the
 * smallest valid wire diff.
 *
 * Returns `null` only when from and to are identical objects (no diff to send).
 * For root-level scalar replacements where `to` differs from `from`, returns
 * `to` itself — RFC 7396 only defines patches over objects, so the caller is
 * expected to wrap shell state in an object root (which CoViewShellState
 * always is).
 */
export function diffMergePatch(
  from: CoViewStateSnapshot,
  to: CoViewStateSnapshot,
): CoViewStateDiff | null {
  const patch: Record<string, unknown> = {};
  let touched = false;

  for (const key of Object.keys(to)) {
    const a = from[key];
    const b = to[key];
    if (deepEqual(a, b)) continue;
    touched = true;
    if (isPlainObject(a) && isPlainObject(b)) {
      const sub = diffMergePatch(a, b);
      patch[key] = sub === null ? {} : sub;
    } else {
      patch[key] = b;
    }
  }

  for (const key of Object.keys(from)) {
    if (key in to) continue;
    touched = true;
    patch[key] = null;
  }

  return touched ? patch : null;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null) return false;
  if (Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as object | null;
  return proto === Object.prototype || proto === null;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (typeof a === "object") {
    if (typeof b !== "object" || b === null || Array.isArray(b)) return false;
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const aKeys = Object.keys(ao);
    const bKeys = Object.keys(bo);
    if (aKeys.length !== bKeys.length) return false;
    for (const k of aKeys) {
      if (!(k in bo)) return false;
      if (!deepEqual(ao[k], bo[k])) return false;
    }
    return true;
  }
  return false;
}
