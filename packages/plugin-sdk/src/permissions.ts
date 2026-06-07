// Permission check and registration — wraps IPC permission messages.

import type { createRequestClient } from "./request";
import type { PermissionsApi } from "./types";
import {
  PermissionsBoolResult,
  PermissionsRoleResult,
  unknownResult,
} from "./schemas";

export function createPermissionsApi(
  client: ReturnType<typeof createRequestClient>,
): PermissionsApi {
  async function register(
    key: string,
    options: { description: string; default_level: number },
  ): Promise<void> {
    await client.sendAndWait(unknownResult, {
      type: "permissions.register",
      key,
      description: options.description,
      default_level: options.default_level,
    });
  }

  async function check(
    userId: string,
    permission: string,
    scope?: string,
  ): Promise<boolean> {
    return client.sendAndWait(PermissionsBoolResult, {
      type: "permissions.check",
      user_id: userId,
      permission,
      ...(scope !== undefined ? { scope } : {}),
    });
  }

  async function hasRole(userId: string, roleName: string): Promise<boolean> {
    return client.sendAndWait(PermissionsBoolResult, {
      type: "permissions.has_role",
      user_id: userId,
      role_name: roleName,
    });
  }

  async function hasMinLevel(userId: string, level: number): Promise<boolean> {
    return client.sendAndWait(PermissionsBoolResult, {
      type: "permissions.has_min_level",
      user_id: userId,
      level,
    });
  }

  async function getRole(
    userId: string,
  ): Promise<{ name: string; level: number }> {
    return client.sendAndWait(PermissionsRoleResult, {
      type: "permissions.get_role",
      user_id: userId,
    });
  }

  async function canActOn(actorId: string, targetId: string): Promise<boolean> {
    return client.sendAndWait(PermissionsBoolResult, {
      type: "permissions.can_act_on",
      actor_id: actorId,
      target_id: targetId,
    });
  }

  return { register, check, hasRole, hasMinLevel, getRole, canActOn };
}
