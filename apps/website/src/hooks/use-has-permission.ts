// Effective-permission hook for the active server (spec-22 Amendment B).
//
// Returns a SolidJS Accessor<boolean> that mirrors the runtime's `check()`
// algorithm in roles/engine.ts:410 — owner bypass, explicit role override,
// then default-level fall-through. The pure transition is in
// `has-permission-eval.ts` so it can be unit-tested without a renderer.
//
// **Convenience only.** The runtime is authoritative and re-checks on every
// mutating IPC call. Per Amendment B: "UI gates are convenience only;
// runtime is authoritative." Always render error toasts on FORBIDDEN even
// when this hook returned true — a stale store between mutation and refetch
// can briefly disagree.

import { type Accessor, createMemo } from "solid-js";
import { activeServerId } from "../stores/servers";
import { currentMember } from "../stores/membership";
import {
  ensurePermissionsLoaded,
  ensureRolesLoaded,
  permissionsStoreFor,
  rolesStoreFor,
} from "../stores/permissions";
import { evaluateHasPermission } from "./has-permission-eval";

export function useHasPermission(permissionKey: string): Accessor<boolean> {
  // Lazy-fire the loaders so admin pages don't pay the cost on first paint.
  // The hook returns false until both registries arrive — UI must treat
  // this as "unknown" semantically and either show a skeleton or hide the
  // gate.
  const id = activeServerId();
  if (id) {
    void ensurePermissionsLoaded(id);
    void ensureRolesLoaded(id);
  }

  return createMemo(() => {
    const me = currentMember();
    const serverId = activeServerId();
    if (!serverId) return evaluateHasPermission(me, null, null);

    const perm =
      permissionsStoreFor(serverId)().permissions.find((p) => p.key === permissionKey) ??
      null;
    // CoreRole.overrides is optional on the wire (only role.list returns it),
    // so normalize to [] for the evaluator's required shape. A role without
    // loaded overrides simply falls through to the default-level check.
    const rawRole = me?.role_id != null
      ? rolesStoreFor(serverId)().roles.find((r) => r.id === me.role_id) ?? null
      : null;
    const role = rawRole
      ? { id: rawRole.id, overrides: rawRole.overrides ?? [] }
      : null;

    return evaluateHasPermission(me, role, perm);
  });
}
