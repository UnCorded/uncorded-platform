// Core Module IPC handler.
// Routes `core.*` action types directly to the CoreModule DAO — no subprocess hop.
// No capability declaration is required for these actions (all plugins get them).
//
// Two entry points:
//   handleCoreIpc          — called for plugin subprocess (stdio) requests
//   handleCoreClientAction — called for WS client requests (plugin: "core")

import type { IpcMessage } from "@uncorded/protocol";
import { CORE_TOPICS } from "@uncorded/protocol";
import type { StdioParentTransport } from "../ipc/transport";
import type { CoreModule } from "./module";
import type { RolesEngine } from "../roles/engine";
import { requirePermission, assertGrantSafe } from "./permissions";

// Role level constants (must match roles engine defaults)
const LEVEL_MEMBER = 10;
const LEVEL_MOD = 60;

const CATEGORY_NAME_MAX = 64;
const REASON_MAX = 512;
const PERMISSIONS_AUDIT_LIMIT_MAX = 200;

// core.member.list pagination (per spec-22 Amendment B)
const MEMBER_LIST_LIMIT_DEFAULT = 200;
const MEMBER_LIST_LIMIT_MAX = 500;

// core.permissions.grantMany (per spec-22 Amendment B)
const BULK_PERMISSION_CHANGES_MAX = 50;

// Permission keys
const PERM_CATEGORIES_MANAGE = "core.categories.manage";
const PERM_PERMISSIONS_MANAGE = "core.permissions.manage";

// ---------------------------------------------------------------------------
// Helper — send IPC response back to plugin
// ---------------------------------------------------------------------------

function sendOk(transport: StdioParentTransport, id: string, result: unknown): void {
  transport.send({ type: "response", id, result } as IpcMessage);
}

function sendErr(
  transport: StdioParentTransport,
  id: string,
  code: string,
  message: string,
): void {
  transport.send({
    type: "response",
    id,
    error: { code, message },
  } as IpcMessage);
}

// ---------------------------------------------------------------------------
// Core IPC dispatcher
// ---------------------------------------------------------------------------

/**
 * Handle a `core.*` IPC message from a plugin subprocess.
 * Returns true if the message was handled, false if the action is unknown.
 */
export function handleCoreIpc(
  msg: IpcMessage,
  transport: StdioParentTransport,
  coreModule: CoreModule,
): boolean {
  const { type, id } = msg;

  if (typeof id !== "string") {
    // Malformed — no id to reply to, silently discard.
    return true;
  }

  if (type === "core.user.get") {
    const userId = msg["userId"];
    if (typeof userId !== "string") {
      sendErr(transport, id, "core/invalid_params", "userId must be a string.");
      return true;
    }
    const user = coreModule.getUser(userId);
    sendOk(transport, id, { user });
    return true;
  }

  if (type === "core.user.getMany") {
    const userIds = msg["userIds"];
    if (!Array.isArray(userIds) || userIds.some((u) => typeof u !== "string")) {
      sendErr(transport, id, "core/invalid_params", "userIds must be an array of strings.");
      return true;
    }
    const users = coreModule.getUsers(userIds as string[]);
    sendOk(transport, id, { users });
    return true;
  }

  if (type === "core.user.getOnline") {
    const users = coreModule.getOnlineUsers();
    sendOk(transport, id, { users });
    return true;
  }

  if (type === "core.categories.list") {
    const categories = coreModule.listCategories();
    sendOk(transport, id, { categories });
    return true;
  }

  // Unknown core.* action.
  sendErr(transport, id, "core/unknown_action", `Unknown core action: ${type}`);
  return true;
}

function normalizeCategoryName(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (trimmed.length === 0 || trimmed.length > CATEGORY_NAME_MAX) return null;
  return trimmed;
}

function parsePositiveInteger(input: unknown): number | null {
  if (typeof input !== "number" || !Number.isInteger(input) || input <= 0) return null;
  return input;
}

function parseRoleName(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (trimmed.length === 0 || trimmed.length > 64) return null;
  return trimmed;
}

function parseRoleLevel(input: unknown): number | null {
  if (typeof input !== "number" || !Number.isInteger(input) || input < 1 || input > 99) {
    return null;
  }
  return input;
}

// ---------------------------------------------------------------------------
// WS client action handler (plugin: "core" requests from browser clients)
// ---------------------------------------------------------------------------

/**
 * Handle a `core.*` action sent by a WS client (plugin: "core").
 * Role checks are performed here — the caller provides user context and the roles engine.
 * Returns the result synchronously via the provided callbacks.
 *
 * `broadcastEvent` is optional. When provided, the handler emits WS-client
 * events for category mutations so live sidebars refresh without polling.
 * Plugin subscribers receive the same events through the in-process event bus
 * (already published inside CoreModule).
 */
export function handleCoreClientAction(
  action: string,
  params: Record<string, unknown>,
  userId: string,
  isOwner: boolean,
  coreModule: CoreModule,
  rolesEngine: RolesEngine | undefined,
  onOk: (result: unknown) => void,
  onErr: (code: string, message: string) => void,
  broadcastEvent?: (topic: string, payload: unknown) => void,
): void {
  const callerCtx = { userId, isOwner };

  function requireLevel(level: number): boolean {
    // Fail closed: if no roles engine is present, deny all role-gated actions.
    if (!rolesEngine || !rolesEngine.hasMinLevel(userId, level, callerCtx)) {
      onErr("FORBIDDEN", "Insufficient permissions.");
      return false;
    }
    return true;
  }

  // --- core.member.list ---
  if (action === "core.member.list") {
    if (!requireLevel(LEVEL_MEMBER)) return;

    // Parse `limit` (default 200, clamped to [1, 500]) and either an opaque
    // `cursor` (preferred) or a raw `offset` (legacy/admin tools). Cursor
    // encoding is `"offset:<N>"` — opaque to clients but easy to swap for
    // a keyset cursor later without breaking the protocol.
    const rawLimit = params["limit"];
    let limit = MEMBER_LIST_LIMIT_DEFAULT;
    if (typeof rawLimit === "number" && Number.isInteger(rawLimit) && rawLimit > 0) {
      limit = Math.min(rawLimit, MEMBER_LIST_LIMIT_MAX);
    }

    let offset = 0;
    const rawCursor = params["cursor"];
    if (typeof rawCursor === "string" && rawCursor.startsWith("offset:")) {
      const parsed = Number.parseInt(rawCursor.slice(7), 10);
      if (Number.isFinite(parsed) && parsed >= 0) offset = parsed;
    } else {
      const rawOffset = params["offset"];
      if (typeof rawOffset === "number" && Number.isInteger(rawOffset) && rawOffset >= 0) {
        offset = rawOffset;
      }
    }

    const { members, total } = coreModule.listMembers({ limit, offset });
    // Enrich each member with `role_id`. Bulk-lookup keeps it to one extra
    // query per page; users without an explicit row in `user_roles` get
    // `role_id: null` (frontend resolves to the default `member` role).
    // If the engine isn't wired (test stubs, fail-closed boot), every row
    // surfaces as null — same as "no assignment".
    const roleIds = rolesEngine
      ? rolesEngine.getRoleIdsForUsers(members.map((m) => m.id))
      : new Map<string, number>();
    const enriched = members.map((m) => ({
      ...m,
      role_id: roleIds.get(m.id) ?? null,
    }));
    const nextOffset = offset + members.length;
    const next_cursor = nextOffset < total ? `offset:${nextOffset}` : null;
    onOk({ members: enriched, total, next_cursor });
    return;
  }

  // --- core.member.me ---
  // Returns caller's role context so the client can gate admin UI without
  // probing FORBIDDEN errors. Owner is reported with a virtual level of 100.
  if (action === "core.member.me") {
    if (isOwner) {
      onOk({ user_id: userId, is_owner: true, level: 100, role_name: "owner", role_id: null });
      return;
    }
    if (!rolesEngine) {
      onOk({ user_id: userId, is_owner: false, level: LEVEL_MEMBER, role_name: "member", role_id: null });
      return;
    }
    const role = rolesEngine.getRole(userId);
    onOk({ user_id: userId, is_owner: false, level: role.level, role_name: role.name, role_id: role.id });
    return;
  }

  // --- core.member.role ---
  // Returns the target user's current role row. Used by the member-manage
  // sheet to pre-select the dropdown. Gated by `core.permissions.manage`
  // because role assignment is itself a privileged surface — anyone allowed
  // to *change* a member's role can also see what it currently is. Owners
  // bypass via owner flag.
  if (action === "core.member.role") {
    if (!rolesEngine) {
      onErr("CORE_UNAVAILABLE", "Roles engine is not initialized.");
      return;
    }
    if (!requirePermission(PERM_PERMISSIONS_MANAGE, userId, isOwner, rolesEngine, onErr)) return;
    const targetId = params["user_id"];
    if (typeof targetId !== "string" || !targetId) {
      onErr("core/invalid_params", "user_id must be a non-empty string.");
      return;
    }
    onOk({ role: rolesEngine.getRole(targetId) });
    return;
  }

  // --- core.ban.list ---
  if (action === "core.ban.list") {
    if (!requireLevel(LEVEL_MOD)) return;
    onOk(coreModule.listBans());
    return;
  }

  // --- core.ban.create ---
  if (action === "core.ban.create") {
    if (!requireLevel(LEVEL_MOD)) return;
    const targetId = params["user_id"];
    if (typeof targetId !== "string" || !targetId) {
      onErr("core/invalid_params", "user_id must be a non-empty string.");
      return;
    }
    if (targetId === userId) {
      onErr("core/invalid_params", "Cannot ban yourself.");
      return;
    }
    const reason = typeof params["reason"] === "string" ? params["reason"] : "";
    // Rank check — cannot ban someone of equal or higher rank.
    if (rolesEngine && !rolesEngine.canActOn(userId, targetId, callerCtx)) {
      onErr("FORBIDDEN", "Cannot act on a user of equal or higher rank.");
      return;
    }
    coreModule.banUser(userId, targetId, reason);
    onOk({});
    return;
  }

  // --- core.ban.delete ---
  if (action === "core.ban.delete") {
    if (!requireLevel(LEVEL_MOD)) return;
    const targetId = params["user_id"];
    if (typeof targetId !== "string" || !targetId) {
      onErr("core/invalid_params", "user_id must be a non-empty string.");
      return;
    }
    const removed = coreModule.unbanUser(userId, targetId);
    if (!removed) {
      onErr("core/not_found", "No active ban found for that user.");
      return;
    }
    onOk({});
    return;
  }

  // --- core.audit.list ---
  if (action === "core.audit.list") {
    if (!requireLevel(LEVEL_MOD)) return;
    const rawLimit = typeof params["limit"] === "number" ? params["limit"] : 100;
    const limit = Math.min(Math.max(1, rawLimit), 200);
    const offset = typeof params["offset"] === "number" ? Math.max(0, params["offset"]) : 0;
    onOk(coreModule.listAuditLog(limit, offset));
    return;
  }

  // --- core.categories.list (read for all members) ---
  if (action === "core.categories.list") {
    if (!requireLevel(LEVEL_MEMBER)) return;
    onOk({ categories: coreModule.listCategories() });
    return;
  }

  // --- core.categories.create (gated by core.categories.manage) ---
  if (action === "core.categories.create") {
    if (!requirePermission(PERM_CATEGORIES_MANAGE, userId, isOwner, rolesEngine, onErr)) return;
    const name = normalizeCategoryName(params["name"]);
    if (!name) {
      onErr(
        "core/invalid_params",
        `name must be a non-empty string up to ${CATEGORY_NAME_MAX} chars.`,
      );
      return;
    }
    const category = coreModule.createCategory(userId, name);
    broadcastEvent?.(CORE_TOPICS.CATEGORY_CREATED, { category });
    onOk({ category });
    return;
  }

  // --- core.categories.update (gated by core.categories.manage) ---
  if (action === "core.categories.update") {
    if (!requirePermission(PERM_CATEGORIES_MANAGE, userId, isOwner, rolesEngine, onErr)) return;
    const id = params["id"];
    if (typeof id !== "string" || !id) {
      onErr("core/invalid_params", "id must be a non-empty string.");
      return;
    }
    const name = normalizeCategoryName(params["name"]);
    if (!name) {
      onErr(
        "core/invalid_params",
        `name must be a non-empty string up to ${CATEGORY_NAME_MAX} chars.`,
      );
      return;
    }
    const category = coreModule.updateCategory(userId, id, name);
    if (!category) {
      onErr("core/not_found", "Category not found.");
      return;
    }
    broadcastEvent?.(CORE_TOPICS.CATEGORY_UPDATED, { category });
    onOk({ category });
    return;
  }

  // --- core.categories.delete (gated by core.categories.manage) ---
  if (action === "core.categories.delete") {
    if (!requirePermission(PERM_CATEGORIES_MANAGE, userId, isOwner, rolesEngine, onErr)) return;
    const id = params["id"];
    if (typeof id !== "string" || !id) {
      onErr("core/invalid_params", "id must be a non-empty string.");
      return;
    }
    const removed = coreModule.deleteCategory(userId, id);
    if (!removed) {
      onErr("core/not_found", "Category not found.");
      return;
    }
    broadcastEvent?.(CORE_TOPICS.CATEGORY_DELETED, { id });
    onOk({});
    return;
  }

  // --- core.categories.reorder (gated by core.categories.manage) ---
  if (action === "core.categories.reorder") {
    if (!requirePermission(PERM_CATEGORIES_MANAGE, userId, isOwner, rolesEngine, onErr)) return;
    const orderedIds = params["orderedIds"];
    if (
      !Array.isArray(orderedIds) ||
      orderedIds.some((x) => typeof x !== "string" || !x)
    ) {
      onErr(
        "core/invalid_params",
        "orderedIds must be an array of non-empty strings.",
      );
      return;
    }
    const result = coreModule.reorderCategories(userId, orderedIds as string[]);
    if (!result) {
      onErr(
        "core/invalid_params",
        "orderedIds must list every existing category exactly once.",
      );
      return;
    }
    broadcastEvent?.(CORE_TOPICS.CATEGORY_REORDERED, { categories: result });
    onOk({ categories: result });
    return;
  }

  // --- core.role.* and core.permissions.* management surface ---
  //
  // Owners bootstrap this through owner bypass. Delegated admins need the
  // explicit `core.permissions.manage` permission, and the engine still
  // enforces strict hierarchy on the actual role/permission mutation.
  if (
    action === "core.role.list" ||
    action === "core.role.create" ||
    action === "core.role.update" ||
    action === "core.role.delete" ||
    action === "core.role.assign" ||
    action === "core.role.remove" ||
    action === "core.permissions.list" ||
    action === "core.permissions.grant" ||
    action === "core.permissions.deny" ||
    action === "core.permissions.remove" ||
    action === "core.permissions.grantMany" ||
    action === "core.permissions.audit"
  ) {
    if (!rolesEngine) {
      onErr("CORE_UNAVAILABLE", "Roles engine is not initialized.");
      return;
    }
    if (!requirePermission(PERM_PERMISSIONS_MANAGE, userId, isOwner, rolesEngine, onErr)) return;

    if (action === "core.role.list") {
      // Hydrate `overrides` and `memberCount` per role so the matrix can render
      // tri-state and "Applies to N members" without a second round trip.
      // Override count is bounded by the registered permission set (Phase 1
      // cap is small); revisit payload size if a server registers thousands.
      const memberCounts = rolesEngine.getRoleMemberCounts();
      const roles = rolesEngine.getRoles().map((r) => ({
        ...r,
        overrides: rolesEngine.getRoleOverrides(r.id),
        memberCount: memberCounts.get(r.id) ?? 0,
      }));
      onOk({ roles });
      return;
    }

    if (action === "core.role.create") {
      const name = parseRoleName(params["name"]);
      const level = parseRoleLevel(params["level"]);
      if (!name) {
        onErr("core/invalid_params", "name must be a non-empty string up to 64 chars.");
        return;
      }
      if (level === null) {
        onErr("core/invalid_params", "level must be an integer between 1 and 99.");
        return;
      }
      const result = rolesEngine.createRole({ name, level }, callerCtx);
      if (!result.ok) {
        onErr(result.error.code, result.error.message);
        return;
      }
      broadcastEvent?.(CORE_TOPICS.PERMISSION_CHANGED, { action, role_id: result.value.id });
      onOk({ role: result.value });
      return;
    }

    if (action === "core.role.update") {
      const roleId = parsePositiveInteger(params["role_id"]);
      if (roleId === null) {
        onErr("core/invalid_params", "role_id must be a positive integer.");
        return;
      }
      const patch: { name?: string; level?: number } = {};
      if (params["name"] !== undefined) {
        const name = parseRoleName(params["name"]);
        if (!name) {
          onErr("core/invalid_params", "name must be a non-empty string up to 64 chars.");
          return;
        }
        patch.name = name;
      }
      if (params["level"] !== undefined) {
        const level = parseRoleLevel(params["level"]);
        if (level === null) {
          onErr("core/invalid_params", "level must be an integer between 1 and 99.");
          return;
        }
        patch.level = level;
      }
      const result = rolesEngine.updateRole(roleId, patch, callerCtx);
      if (!result.ok) {
        onErr(result.error.code, result.error.message);
        return;
      }
      broadcastEvent?.(CORE_TOPICS.PERMISSION_CHANGED, { action, role_id: roleId });
      onOk({ role: result.value });
      return;
    }

    if (action === "core.role.delete") {
      const roleId = parsePositiveInteger(params["role_id"]);
      if (roleId === null) {
        onErr("core/invalid_params", "role_id must be a positive integer.");
        return;
      }
      const result = rolesEngine.deleteRole(roleId, callerCtx);
      if (!result.ok) {
        onErr(result.error.code, result.error.message);
        return;
      }
      broadcastEvent?.(CORE_TOPICS.PERMISSION_CHANGED, { action, role_id: roleId });
      onOk({});
      return;
    }

    if (action === "core.role.assign") {
      const targetId = params["user_id"];
      const roleId = parsePositiveInteger(params["role_id"]);
      if (typeof targetId !== "string" || !targetId) {
        onErr("core/invalid_params", "user_id must be a non-empty string.");
        return;
      }
      if (roleId === null) {
        onErr("core/invalid_params", "role_id must be a positive integer.");
        return;
      }
      // Q1 lock (spec-22 Amendment B): a caller cannot mutate their own
      // role through this surface, even as owner. Ownership transfer goes
      // through Central.
      if (targetId === userId) {
        onErr("SELF_DEMOTION_BLOCKED", "You cannot change your own role.");
        return;
      }
      // The owner role is Central-bound — runtime trusts JwtPayload.is_owner
      // as the authoritative signal. The DB row exists for level lookup but
      // is not assignable.
      const targetRole = rolesEngine.getRoleById(roleId);
      if (targetRole && targetRole.isDefault && targetRole.name === "owner") {
        onErr(
          "OWNER_ROLE_NOT_ASSIGNABLE",
          "The owner role is not assignable through the runtime — transfer ownership through Central.",
        );
        return;
      }
      const result = rolesEngine.assignRole(targetId, roleId, callerCtx);
      if (!result.ok) {
        onErr(result.error.code, result.error.message);
        return;
      }
      broadcastEvent?.(CORE_TOPICS.PERMISSION_CHANGED, { action, user_id: targetId, role_id: roleId });
      onOk({});
      return;
    }

    if (action === "core.role.remove") {
      const targetId = params["user_id"];
      if (typeof targetId !== "string" || !targetId) {
        onErr("core/invalid_params", "user_id must be a non-empty string.");
        return;
      }
      if (targetId === userId) {
        onErr("SELF_DEMOTION_BLOCKED", "You cannot change your own role.");
        return;
      }
      const result = rolesEngine.removeRole(targetId, callerCtx);
      if (!result.ok) {
        onErr(result.error.code, result.error.message);
        return;
      }
      broadcastEvent?.(CORE_TOPICS.PERMISSION_CHANGED, { action, user_id: targetId });
      onOk({});
      return;
    }

    if (action === "core.permissions.list") {
      onOk({ permissions: rolesEngine.getPermissions() });
      return;
    }

    if (action === "core.permissions.audit") {
      const rawLimit = typeof params["limit"] === "number" ? params["limit"] : 100;
      const limit = Math.min(Math.max(1, rawLimit), PERMISSIONS_AUDIT_LIMIT_MAX);
      const offset = typeof params["offset"] === "number" ? Math.max(0, params["offset"]) : 0;
      onOk({ entries: rolesEngine.listPermissionAudit(limit, offset) });
      return;
    }

    if (action === "core.permissions.grantMany") {
      const targetRoleId = parsePositiveInteger(params["role_id"]);
      if (targetRoleId === null) {
        onErr("core/invalid_params", "role_id must be a positive integer.");
        return;
      }
      const changes = params["changes"];
      if (!Array.isArray(changes)) {
        onErr("core/invalid_params", "changes must be an array.");
        return;
      }
      if (changes.length === 0) {
        onErr("core/invalid_params", "changes must contain at least one entry.");
        return;
      }
      if (changes.length > BULK_PERMISSION_CHANGES_MAX) {
        onErr(
          "core/invalid_params",
          `changes may contain at most ${BULK_PERMISSION_CHANGES_MAX} entries.`,
        );
        return;
      }

      const skipped: Array<{ permission: string; code: string; message: string }> = [];
      let applied = 0;

      for (const raw of changes) {
        const change = raw as Record<string, unknown>;
        const permission = change["permission"];
        const op = change["op"];
        const rawReason = change["reason"];

        // Validate per-change shape. Malformed entries are skipped rather
        // than aborting the batch — the matrix UI must be able to surface
        // partial successes from a single round trip.
        if (typeof permission !== "string" || permission.length === 0) {
          skipped.push({
            permission: typeof permission === "string" ? permission : "",
            code: "core/invalid_params",
            message: "permission must be a non-empty string.",
          });
          continue;
        }
        if (op !== "grant" && op !== "deny" && op !== "remove") {
          skipped.push({
            permission,
            code: "core/invalid_params",
            message: 'op must be "grant", "deny", or "remove".',
          });
          continue;
        }

        let reason: string | undefined;
        if (rawReason !== undefined) {
          if (typeof rawReason !== "string") {
            skipped.push({
              permission,
              code: "core/invalid_params",
              message: "reason must be a string if provided.",
            });
            continue;
          }
          const trimmed = rawReason.trim();
          if (trimmed.length > REASON_MAX) {
            skipped.push({
              permission,
              code: "core/invalid_params",
              message: `reason must be ≤ ${REASON_MAX} chars.`,
            });
            continue;
          }
          reason = trimmed.length > 0 ? trimmed : undefined;
        }

        // grant + deny require the caller to hold the permission they are
        // delegating; remove never escalates so it skips the guard.
        if (op === "grant" || op === "deny") {
          const guard = assertGrantSafe(permission, userId, isOwner, rolesEngine);
          if (!guard.ok) {
            skipped.push({
              permission,
              code: "FORBIDDEN",
              message: `You cannot ${op} a permission you do not hold.`,
            });
            continue;
          }
        }

        const opAction =
          op === "grant" ? "core.permissions.grant"
          : op === "deny" ? "core.permissions.deny"
          : "core.permissions.remove";

        const result =
          op === "grant" ? rolesEngine.grantPermission(targetRoleId, permission, callerCtx)
          : op === "deny" ? rolesEngine.denyPermission(targetRoleId, permission, callerCtx)
          : rolesEngine.removePermissionOverride(targetRoleId, permission, callerCtx);

        if (!result.ok) {
          skipped.push({
            permission,
            code: result.error.code,
            message: result.error.message,
          });
          continue;
        }

        rolesEngine.recordPermissionAudit(userId, targetRoleId, permission, op, reason);
        broadcastEvent?.(CORE_TOPICS.PERMISSION_CHANGED, {
          action: opAction,
          role_id: targetRoleId,
          permission,
        });
        applied++;
      }

      onOk({ applied, skipped });
      return;
    }

    const roleId = parsePositiveInteger(params["role_id"]);
    const permissionKey = params["permission"];
    if (roleId === null) {
      onErr("core/invalid_params", "role_id must be a positive integer.");
      return;
    }
    if (typeof permissionKey !== "string" || !permissionKey) {
      onErr("core/invalid_params", "permission must be a non-empty string.");
      return;
    }
    const rawReason = params["reason"];
    let reason: string | undefined;
    if (rawReason !== undefined) {
      if (typeof rawReason !== "string") {
        onErr("core/invalid_params", "reason must be a string if provided.");
        return;
      }
      const trimmed = rawReason.trim();
      if (trimmed.length > REASON_MAX) {
        onErr("core/invalid_params", `reason must be ≤ ${REASON_MAX} chars.`);
        return;
      }
      reason = trimmed.length > 0 ? trimmed : undefined;
    }

    if (action === "core.permissions.grant") {
      const guard = assertGrantSafe(permissionKey, userId, isOwner, rolesEngine);
      if (!guard.ok) {
        onErr("FORBIDDEN", "You cannot grant a permission you do not hold.");
        return;
      }
      const result = rolesEngine.grantPermission(roleId, permissionKey, callerCtx);
      if (!result.ok) {
        onErr(result.error.code, result.error.message);
        return;
      }
      rolesEngine.recordPermissionAudit(userId, roleId, permissionKey, "grant", reason);
      broadcastEvent?.(CORE_TOPICS.PERMISSION_CHANGED, { action, role_id: roleId, permission: permissionKey });
      onOk({});
      return;
    }

    if (action === "core.permissions.deny") {
      const guard = assertGrantSafe(permissionKey, userId, isOwner, rolesEngine);
      if (!guard.ok) {
        onErr("FORBIDDEN", "You cannot deny a permission you do not hold.");
        return;
      }
      const result = rolesEngine.denyPermission(roleId, permissionKey, callerCtx);
      if (!result.ok) {
        onErr(result.error.code, result.error.message);
        return;
      }
      rolesEngine.recordPermissionAudit(userId, roleId, permissionKey, "deny", reason);
      broadcastEvent?.(CORE_TOPICS.PERMISSION_CHANGED, { action, role_id: roleId, permission: permissionKey });
      onOk({});
      return;
    }

    if (action === "core.permissions.remove") {
      const result = rolesEngine.removePermissionOverride(roleId, permissionKey, callerCtx);
      if (!result.ok) {
        onErr(result.error.code, result.error.message);
        return;
      }
      rolesEngine.recordPermissionAudit(userId, roleId, permissionKey, "remove", reason);
      broadcastEvent?.(CORE_TOPICS.PERMISSION_CHANGED, { action, role_id: roleId, permission: permissionKey });
      onOk({});
      return;
    }
  }

  onErr("core/unknown_action", `Unknown core action: ${action}`);
}
