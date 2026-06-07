// JSON Merge Patch (RFC 7396) — minimal recursive implementation.
//
// Used by the Co-View Sessions runtime to maintain `safeStateSnapshot` from
// the stream of `replay: "safe"` `co-view.state` diffs. Mutates the target
// in place to keep allocations down on the hot path; the caller (handlers.ts)
// owns the snapshot object's lifetime.
//
// Semantics, condensed from RFC 7396:
//   - patch is an object → merge keys recursively into target
//   - patch[key] === null → delete target[key]
//   - patch[key] is a non-object value (string/number/bool/array) → replace
//   - target[key] missing or non-object when patch[key] is object → coerce
//     target[key] = {} before recursing
//
// Arrays are treated as opaque values (replace, never merge) — matches RFC.
//
// Spec-27 §The Shell-State Boundary makes the runtime trust the producer's
// allowlist; this helper does NOT validate keys or values, only applies the
// patch. The producer-side serializer is the boundary.

import type {
  CoViewStateDiff,
  CoViewStateSnapshot,
} from "@uncorded/protocol";

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

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null) return false;
  if (Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as object | null;
  return proto === Object.prototype || proto === null;
}
