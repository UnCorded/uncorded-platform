// Pure evaluator for `useHasPermission` (spec-22 Amendment B PR 5.1).
// Mirrors the runtime's `RolesEngine.check()` algorithm exactly so a UI
// gate based on this function agrees with the runtime FORBIDDEN gate.
//
// Algorithm (matches runtime/src/roles/engine.ts:410):
//   1. Owner → true.
//   2. Unknown permission → false.
//   3. Explicit role override (granted=true → true, granted=false → false).
//   4. Otherwise: member.level >= permission.defaultLevel.
//
// Extracted as a pure function so the revoke scenario (a role override is
// removed mid-session) can be unit-tested without a SolidJS renderer.

export interface MemberInput {
  is_owner: boolean;
  level: number;
  role_id: number | null;
}

export interface RoleInput {
  id: number;
  overrides: ReadonlyArray<{ permission: string; granted: boolean }>;
}

export interface PermissionInput {
  key: string;
  defaultLevel: number;
}

/**
 * Evaluate the caller's effective grant of one permission key. The caller
 * passes the role row only if they're a non-owner and the role has been
 * loaded — owners and unknown roles short-circuit appropriately.
 */
export function evaluateHasPermission(
  member: MemberInput | null,
  role: RoleInput | null,
  perm: PermissionInput | null,
): boolean {
  if (!member) return false;
  if (member.is_owner) return true;
  if (!perm) return false;

  // Explicit role override wins over default_level — both directions.
  // A grant=false override is the only way to deny a permission the
  // caller's level would otherwise satisfy.
  if (role && role.id === member.role_id) {
    for (const o of role.overrides) {
      if (o.permission === perm.key) return o.granted;
    }
  }

  return member.level >= perm.defaultLevel;
}
