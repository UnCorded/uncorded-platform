// Permission gating helpers for WS client actions.
//
// `requirePermission` is the named-permission analogue of the inline
// `requireLevel` helper that lived in `core/ipc.ts`. Callers pass a
// permission key; the engine resolves owner-bypass → explicit role override
// → default_level fall-through. On deny it invokes `onErr` with a
// FORBIDDEN code so handlers can `return` immediately.
//
// `assertGrantSafe` enforces the privilege-escalation guard: an actor
// cannot grant a permission they don't themselves hold. The level
// hierarchy ("can't grant against a role at or above your level") is
// already enforced by the engine on the actual grant/deny call
// (HIERARCHY_VIOLATION), so this layer only owns the holds-the-permission
// check.
//
// Audit writes go through `RolesEngine.recordPermissionAudit` directly.

import type { RolesEngine } from "../roles/engine";

export interface PermissionGuardResult {
  ok: boolean;
}

export function requirePermission(
  permissionKey: string,
  userId: string,
  isOwner: boolean,
  rolesEngine: RolesEngine | undefined,
  onErr: (code: string, message: string) => void,
): boolean {
  if (isOwner) return true;
  if (!rolesEngine) {
    onErr("FORBIDDEN", "Insufficient permissions.");
    return false;
  }
  const allowed = rolesEngine.check(userId, permissionKey, { userId, isOwner });
  if (!allowed) {
    onErr("FORBIDDEN", "Insufficient permissions.");
    return false;
  }
  return true;
}

/**
 * Returns ok=true if the actor may grant/deny `permissionKey` against any role.
 *
 * The actor must already hold `permissionKey` themselves (owners bypass).
 * Otherwise an admin without the permission could hand it to themselves
 * via a confederate role assignment.
 *
 * The level-hierarchy check is delegated to the engine on the actual
 * grantPermission/denyPermission call (HIERARCHY_VIOLATION).
 */
export function assertGrantSafe(
  permissionKey: string,
  actorUserId: string,
  isOwner: boolean,
  rolesEngine: RolesEngine,
): PermissionGuardResult {
  if (isOwner) return { ok: true };
  const holds = rolesEngine.check(actorUserId, permissionKey, {
    userId: actorUserId,
    isOwner,
  });
  return { ok: holds };
}
