// Pure helpers for the permission matrix tri-state (spec-22 Amendment B
// PR 4.3). Extracted from `permission-matrix.tsx` so the wire-shape
// contract can be unit-tested without spinning up a SolidJS render.
//
// The contract is small and defensive:
//   - role.overrides is the authoritative source for explicit grant/deny
//   - absence of an entry means "inherit from defaultLevel"
//   - clicking a tri-state value must produce the right `op` for the
//     `core.permissions.{grant,deny,remove}` IPC actions

export type TriState = "inherit" | "grant" | "deny";
export type PendingOp = "grant" | "deny" | "remove";

/**
 * Derive the tri-state for one permission key by scanning the role's
 * explicit overrides. Falls back to `inherit` when the key is absent.
 *
 * Linear scan is fine — Phase 1 caps total registered permissions in the
 * dozens, and a role rarely has more than a few overrides. If a server
 * starts to register hundreds of permissions, switch to a Map at the
 * call site.
 */
export function triFromOverride(
  permKey: string,
  overrides: ReadonlyArray<{ permission: string; granted: boolean }> | undefined,
): TriState {
  if (!overrides) return "inherit";
  for (const o of overrides) {
    if (o.permission === permKey) return o.granted ? "grant" : "deny";
  }
  return "inherit";
}

/**
 * Map a clicked tri-state to the IPC op the matrix should send. Inherit
 * means "delete the override row" → remove; grant/deny pass through.
 */
export function pendingOpFor(next: TriState): PendingOp {
  if (next === "grant") return "grant";
  if (next === "deny") return "deny";
  return "remove";
}
