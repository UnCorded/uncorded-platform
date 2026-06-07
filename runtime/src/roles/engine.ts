// Roles engine — manages server roles, user assignments, plugin permissions,
// and permission checking. Operates on /data/core.db.

import type { Database } from "bun:sqlite";
import { rootLogger } from "@uncorded/shared";
import { runMigrations } from "../migrations";
import type { FileListFn, FileReadFn, MigrationResult } from "../migrations";

const log = rootLogger.child({ component: "roles-engine" });
import {
  DEFAULT_ROLES,
  type CallerContext,
  type CreateRoleInput,
  type Permission,
  type PermissionRow,
  type RegisterPermissionInput,
  type Role,
  type RoleRow,
  type RolesError,
  type RolesResult,
  type UpdateRoleInput,
  type VoidResult,
} from "./types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toRole(row: RoleRow): Role {
  return {
    id: row.id,
    name: row.name,
    level: row.level,
    isDefault: row.is_default === 1,
    parentRole: row.parent_role,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toPermission(row: PermissionRow): Permission {
  return {
    id: row.id,
    key: row.key,
    description: row.description,
    defaultLevel: row.default_level,
    pluginSlug: row.plugin_slug,
    registeredAt: row.registered_at,
  };
}

function err(code: string, message: string): { ok: false; error: RolesError } {
  return { ok: false, error: { code, message } };
}

function isValidLevel(level: number): boolean {
  return Number.isInteger(level) && level >= 1 && level <= 99;
}

// ---------------------------------------------------------------------------
// RolesEngine
// ---------------------------------------------------------------------------

/**
 * Emitted by RolesEngine whenever a role/permission mutation succeeds.
 * Subscribers re-evaluate effective permissions for affected users and
 * revoke open sessions if a permission they relied on has been withdrawn.
 *
 * - `userId` is set when the change is scoped to a single user
 *   (assignRole / removeRole).
 * - `roleId` is set when the change is scoped to a role
 *   (grant/deny/remove on a role override). Subscribers must enumerate
 *   users with that role and re-check.
 * - `permissionKey` is set for grant/deny/remove. Absent for assignRole/
 *   removeRole because *any* permission could change.
 */
export interface PermissionChangedEvent {
  userId?: string;
  roleId?: number;
  permissionKey?: string;
}

export type PermissionChangedListener = (e: PermissionChangedEvent) => void;

export class RolesEngine {
  private readonly db: Database;

  // Cached member role (resolved lazily)
  private cachedMemberRole: Role | undefined;

  // In-process permission-change listeners. Used by subsystems that need
  // sub-second revocation. Not the public event bus — listeners run
  // synchronously in the same tick as the mutation.
  private readonly permissionChangedListeners = new Set<PermissionChangedListener>();

  constructor(db: Database) {
    this.db = db;
  }

  // -----------------------------------------------------------------------
  // Static initialization (called once at startup)
  // -----------------------------------------------------------------------

  static initialize(
    db: Database,
    migrationsDir: string,
    listFiles: FileListFn,
    readFile: FileReadFn,
  ): MigrationResult {
    // SQLite doesn't enforce FK constraints by default — cascades won't fire without this.
    db.run("PRAGMA foreign_keys = ON");

    const result = runMigrations("runtime", db, migrationsDir, listFiles, readFile);
    if (!result.ok) return result;

    // Seed default roles if empty
    const count = db
      .query<{ cnt: number }, []>("SELECT COUNT(*) as cnt FROM roles WHERE is_default = 1")
      .get();

    if (count === null || count.cnt === 0) {
      const now = Date.now();
      const insert = db.prepare(
        "INSERT INTO roles (name, level, is_default, parent_role, created_at, updated_at) VALUES (?, ?, 1, NULL, ?, ?)",
      );
      const seed = db.transaction(() => {
        for (const role of Object.values(DEFAULT_ROLES)) {
          insert.run(role.name, role.level, now, now);
        }
      });
      seed();
    }

    return result;
  }

  // -----------------------------------------------------------------------
  // Role reads
  // -----------------------------------------------------------------------

  getRoles(): Role[] {
    return this.db
      .query<RoleRow, []>("SELECT * FROM roles ORDER BY level DESC")
      .all()
      .map(toRole);
  }

  getRoleById(id: number): Role | null {
    const row = this.db
      .query<RoleRow, [number]>("SELECT * FROM roles WHERE id = ?")
      .get(id);
    return row ? toRole(row) : null;
  }

  getRoleByName(name: string): Role | null {
    const row = this.db
      .query<RoleRow, [string]>("SELECT * FROM roles WHERE name = ?")
      .get(name);
    return row ? toRole(row) : null;
  }

  /**
   * Per-role explicit overrides. Returns one entry per (role, permission)
   * row in `role_permissions`, joined to `permissions.key` so the wire form
   * carries the human-readable key (matrix UI expects keys, not IDs).
   *
   * Empty array when the role has no overrides — the matrix renders those
   * rows in `inherit` state via `default_level`. Bounded by the registered
   * permission count (Phase 1 cap is small; revisit if a server registers
   * thousands of permission types).
   */
  getRoleOverrides(roleId: number): Array<{ permission: string; granted: boolean }> {
    return this.db
      .query<{ key: string; granted: number }, [number]>(
        `SELECT p.key as key, rp.granted as granted
         FROM role_permissions rp
         JOIN permissions p ON p.id = rp.permission_id
         WHERE rp.role_id = ?
         ORDER BY p.key ASC`,
      )
      .all(roleId)
      .map((row) => ({ permission: row.key, granted: row.granted === 1 }));
  }

  // -----------------------------------------------------------------------
  // Role CRUD
  // -----------------------------------------------------------------------

  createRole(input: CreateRoleInput, caller: CallerContext): RolesResult<Role> {
    if (!isValidLevel(input.level)) {
      return err("INVALID_LEVEL", `Level must be an integer between 1 and 99, got ${input.level}.`);
    }

    const callerLevel = this.getCallerLevel(caller);
    if (input.level >= callerLevel) {
      return err("HIERARCHY_VIOLATION", `Cannot create a role at level ${input.level} — your level is ${callerLevel}.`);
    }

    const existing = this.getRoleByName(input.name);
    if (existing) {
      return err("ROLE_NAME_TAKEN", `A role named "${input.name}" already exists.`);
    }

    const now = Date.now();
    this.db.run(
      "INSERT INTO roles (name, level, is_default, parent_role, created_at, updated_at) VALUES (?, ?, 0, NULL, ?, ?)",
      [input.name, input.level, now, now],
    );

    const role = this.getRoleByName(input.name)!;
    return { ok: true, value: role };
  }

  updateRole(id: number, input: UpdateRoleInput, caller: CallerContext): RolesResult<Role> {
    const role = this.getRoleById(id);
    if (!role) {
      return err("ROLE_NOT_FOUND", `Role with id ${id} not found.`);
    }

    const callerLevel = this.getCallerLevel(caller);
    if (role.level >= callerLevel) {
      return err("HIERARCHY_VIOLATION", `Cannot modify a role at level ${role.level} — your level is ${callerLevel}.`);
    }

    if (input.name !== undefined && role.isDefault) {
      return err("DEFAULT_ROLE_PROTECTED", `Cannot rename the default role "${role.name}".`);
    }

    if (input.level !== undefined) {
      if (!isValidLevel(input.level)) {
        return err("INVALID_LEVEL", `Level must be an integer between 1 and 99, got ${input.level}.`);
      }
      if (role.isDefault) {
        return err("DEFAULT_ROLE_PROTECTED", `Cannot change the level of the default role "${role.name}".`);
      }
      if (input.level >= callerLevel) {
        return err("HIERARCHY_VIOLATION", `Cannot set level to ${input.level} — your level is ${callerLevel}.`);
      }
    }

    if (input.name !== undefined) {
      const existing = this.getRoleByName(input.name);
      if (existing && existing.id !== id) {
        return err("ROLE_NAME_TAKEN", `A role named "${input.name}" already exists.`);
      }
    }

    const now = Date.now();
    const newName = input.name ?? role.name;
    const newLevel = input.level ?? role.level;
    this.db.run(
      "UPDATE roles SET name = ?, level = ?, updated_at = ? WHERE id = ?",
      [newName, newLevel, now, id],
    );

    return { ok: true, value: this.getRoleById(id)! };
  }

  deleteRole(id: number, caller: CallerContext): VoidResult {
    const role = this.getRoleById(id);
    if (!role) {
      return err("ROLE_NOT_FOUND", `Role with id ${id} not found.`);
    }
    if (role.isDefault) {
      return err("DEFAULT_ROLE_PROTECTED", `Cannot delete the default role "${role.name}".`);
    }

    const callerLevel = this.getCallerLevel(caller);
    if (role.level >= callerLevel) {
      return err("HIERARCHY_VIOLATION", `Cannot delete a role at level ${role.level} — your level is ${callerLevel}.`);
    }

    const memberRole = this.getMemberRole();
    const deleteAndReassign = this.db.transaction(() => {
      this.db.run(
        "UPDATE user_roles SET role_id = ? WHERE role_id = ?",
        [memberRole.id, id],
      );
      this.db.run("DELETE FROM roles WHERE id = ?", [id]);
    });
    deleteAndReassign();

    return { ok: true };
  }

  // -----------------------------------------------------------------------
  // User-role assignment
  // -----------------------------------------------------------------------

  assignRole(userId: string, roleId: number, caller: CallerContext): VoidResult {
    const role = this.getRoleById(roleId);
    if (!role) {
      return err("ROLE_NOT_FOUND", `Role with id ${roleId} not found.`);
    }

    const callerLevel = this.getCallerLevel(caller);
    if (role.level >= callerLevel) {
      return err("HIERARCHY_VIOLATION", `Cannot assign a role at level ${role.level} — your level is ${callerLevel}.`);
    }

    // Check target user's current role level
    const currentRole = this.getRole(userId);
    if (currentRole.level >= callerLevel) {
      return err("HIERARCHY_VIOLATION", `Cannot modify a user with role level ${currentRole.level} — your level is ${callerLevel}.`);
    }

    // Single-role model: replace existing
    const assign = this.db.transaction(() => {
      this.db.run("DELETE FROM user_roles WHERE user_id = ?", [userId]);
      this.db.run("INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)", [userId, roleId]);
    });
    assign();

    this.emitPermissionChanged({ userId });
    return { ok: true };
  }

  removeRole(userId: string, caller: CallerContext): VoidResult {
    const currentRole = this.getRole(userId);
    const callerLevel = this.getCallerLevel(caller);

    if (currentRole.level >= callerLevel) {
      return err("HIERARCHY_VIOLATION", `Cannot modify a user with role level ${currentRole.level} — your level is ${callerLevel}.`);
    }

    this.db.run("DELETE FROM user_roles WHERE user_id = ?", [userId]);
    this.emitPermissionChanged({ userId });
    return { ok: true };
  }

  getRole(userId: string): Role {
    const row = this.db
      .query<RoleRow, [string]>(
        "SELECT r.* FROM roles r JOIN user_roles ur ON r.id = ur.role_id WHERE ur.user_id = ?",
      )
      .get(userId);

    if (row) return toRole(row);
    return this.getMemberRole();
  }

  // -----------------------------------------------------------------------
  // Permission registration (plugins)
  // -----------------------------------------------------------------------

  registerPermission(input: RegisterPermissionInput): VoidResult {
    const existing = this.db
      .query<PermissionRow, [string]>("SELECT * FROM permissions WHERE key = ?")
      .get(input.key);

    if (existing) {
      if (existing.plugin_slug !== input.pluginSlug) {
        return err(
          "PERMISSION_ALREADY_REGISTERED",
          `Permission "${input.key}" is already registered by plugin "${existing.plugin_slug}".`,
        );
      }
      // Same plugin — update
      this.db.run(
        "UPDATE permissions SET description = ?, default_level = ? WHERE id = ?",
        [input.description, input.defaultLevel, existing.id],
      );
      return { ok: true };
    }

    this.db.run(
      "INSERT INTO permissions (key, description, default_level, plugin_slug, registered_at) VALUES (?, ?, ?, ?, ?)",
      [input.key, input.description, input.defaultLevel, input.pluginSlug, Date.now()],
    );
    return { ok: true };
  }

  unregisterPluginPermissions(pluginSlug: string): number {
    // CASCADE deletes role_permissions rows
    this.db.run("DELETE FROM permissions WHERE plugin_slug = ?", [pluginSlug]);
    return this.db.query<{ cnt: number }, []>("SELECT changes() as cnt").get()!.cnt;
  }

  getPermissions(): Permission[] {
    return this.db
      .query<PermissionRow, []>("SELECT * FROM permissions ORDER BY key")
      .all()
      .map(toPermission);
  }

  getPermissionsByPlugin(pluginSlug: string): Permission[] {
    return this.db
      .query<PermissionRow, [string]>("SELECT * FROM permissions WHERE plugin_slug = ? ORDER BY key")
      .all(pluginSlug)
      .map(toPermission);
  }

  // -----------------------------------------------------------------------
  // Role-permission mapping
  // -----------------------------------------------------------------------

  grantPermission(roleId: number, permissionKey: string, caller: CallerContext): VoidResult {
    const result = this.setPermissionOverride(roleId, permissionKey, caller, 1);
    if (result.ok) this.emitPermissionChanged({ roleId, permissionKey });
    return result;
  }

  denyPermission(roleId: number, permissionKey: string, caller: CallerContext): VoidResult {
    const result = this.setPermissionOverride(roleId, permissionKey, caller, 0);
    if (result.ok) this.emitPermissionChanged({ roleId, permissionKey });
    return result;
  }

  removePermissionOverride(roleId: number, permissionKey: string, caller: CallerContext): VoidResult {
    const role = this.getRoleById(roleId);
    if (!role) return err("ROLE_NOT_FOUND", `Role with id ${roleId} not found.`);

    const callerLevel = this.getCallerLevel(caller);
    if (role.level >= callerLevel) {
      return err("HIERARCHY_VIOLATION", `Cannot modify permissions for a role at level ${role.level} — your level is ${callerLevel}.`);
    }

    const perm = this.db
      .query<PermissionRow, [string]>("SELECT * FROM permissions WHERE key = ?")
      .get(permissionKey);
    if (!perm) return err("PERMISSION_NOT_FOUND", `Permission "${permissionKey}" not found.`);

    this.db.run(
      "DELETE FROM role_permissions WHERE role_id = ? AND permission_id = ?",
      [roleId, perm.id],
    );
    this.emitPermissionChanged({ roleId, permissionKey });
    return { ok: true };
  }

  // -----------------------------------------------------------------------
  // Permission checking (hot path)
  // -----------------------------------------------------------------------

  check(userId: string, permissionKey: string, caller: CallerContext, scope?: string): boolean {
    // Owner bypasses everything
    if (caller.isOwner) return true;

    const userRole = this.getRole(userId);

    // Look up permission
    const perm = this.db
      .query<PermissionRow, [string]>("SELECT * FROM permissions WHERE key = ?")
      .get(permissionKey);

    if (!perm) return false;

    // Check explicit role override
    const override = this.db
      .query<{ granted: number }, [number, number]>(
        "SELECT granted FROM role_permissions WHERE role_id = ? AND permission_id = ?",
      )
      .get(userRole.id, perm.id);

    if (override) {
      return override.granted === 1;
    }

    // Fall back to default_level
    return userRole.level >= perm.default_level;
  }

  hasRole(userId: string, roleName: string): boolean {
    return this.getRole(userId).name === roleName;
  }

  hasMinLevel(userId: string, level: number, caller: CallerContext): boolean {
    if (caller.isOwner) return true;
    return this.getRole(userId).level >= level;
  }

  canActOn(actorId: string, targetId: string, caller: CallerContext): boolean {
    // Owner can act on anyone
    if (caller.isOwner) return true;
    const actorRole = this.getRole(actorId);
    const targetRole = this.getRole(targetId);
    // Actor must strictly outrank the target
    return actorRole.level > targetRole.level;
  }

  // -----------------------------------------------------------------------
  // Permission audit log (migration 004)
  // -----------------------------------------------------------------------

  recordPermissionAudit(
    actorUserId: string,
    targetRoleId: number | null,
    permissionKey: string,
    action: "grant" | "deny" | "remove",
    reason?: string,
  ): void {
    this.db.run(
      "INSERT INTO permission_audit (ts, actor_user_id, target_role_id, permission, action, reason) VALUES (?, ?, ?, ?, ?, ?)",
      [Date.now(), actorUserId, targetRoleId, permissionKey, action, reason ?? null],
    );
  }

  listPermissionAudit(limit: number, offset: number): Array<{
    id: number;
    ts: number;
    actor_user_id: string;
    target_role_id: number | null;
    permission: string;
    action: string;
    reason: string | null;
  }> {
    return this.db
      .query<{
        id: number;
        ts: number;
        actor_user_id: string;
        target_role_id: number | null;
        permission: string;
        action: string;
        reason: string | null;
      }, [number, number]>(
        "SELECT id, ts, actor_user_id, target_role_id, permission, action, reason FROM permission_audit ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?",
      )
      .all(limit, offset);
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private getCallerLevel(caller: CallerContext): number {
    if (caller.isOwner) return 100;
    return this.getRole(caller.userId).level;
  }

  private getMemberRole(): Role {
    if (this.cachedMemberRole) return this.cachedMemberRole;
    const row = this.db
      .query<RoleRow, [string]>("SELECT * FROM roles WHERE name = ?")
      .get("member");
    if (!row) throw new Error("Member role not found — database not initialized.");
    this.cachedMemberRole = toRole(row);
    return this.cachedMemberRole;
  }

  private setPermissionOverride(
    roleId: number,
    permissionKey: string,
    caller: CallerContext,
    granted: number,
  ): VoidResult {
    const role = this.getRoleById(roleId);
    if (!role) return err("ROLE_NOT_FOUND", `Role with id ${roleId} not found.`);

    const callerLevel = this.getCallerLevel(caller);
    if (role.level >= callerLevel) {
      return err("HIERARCHY_VIOLATION", `Cannot modify permissions for a role at level ${role.level} — your level is ${callerLevel}.`);
    }

    const perm = this.db
      .query<PermissionRow, [string]>("SELECT * FROM permissions WHERE key = ?")
      .get(permissionKey);
    if (!perm) return err("PERMISSION_NOT_FOUND", `Permission "${permissionKey}" not found.`);

    this.db.run(
      "INSERT INTO role_permissions (role_id, permission_id, granted) VALUES (?, ?, ?) ON CONFLICT (role_id, permission_id) DO UPDATE SET granted = ?",
      [roleId, perm.id, granted, granted],
    );
    return { ok: true };
  }

  // -----------------------------------------------------------------------
  // Permission change notifications (in-process)
  // -----------------------------------------------------------------------

  /**
   * Subscribe to role/permission mutations. Listeners fire synchronously
   * after the mutation succeeds, in the same tick. Returns an unsubscribe
   * function. Mirrors CoreModule.onBanned — used by subsystems that need
   * sub-second revocation without the public event-bus latency.
   *
   * Listeners must not throw: a thrown listener is caught and logged via
   * console.error, then siblings continue to run. Engine state is never
   * mutated here.
   */
  onPermissionChanged(callback: PermissionChangedListener): () => void {
    this.permissionChangedListeners.add(callback);
    return () => {
      this.permissionChangedListeners.delete(callback);
    };
  }

  /**
   * GROUP BY count of explicit role assignments. Returns one entry per role
   * that has at least one assigned user — roles with zero explicit holders
   * are omitted, so callers should default to 0 when a role id is missing.
   *
   * "Explicit" matters: this counts rows in `user_roles`, not the implicit
   * `member` fallback. Members who never had `role.assign` applied are
   * counted as 0 here even though `getRole(userId)` returns the default
   * `member` role for them. The matrix UI labels this as "Applies to N
   * members" — for the default `member` role, we display the implicit
   * fallback count separately (server.member_count - sum of explicit).
   */
  getRoleMemberCounts(): Map<number, number> {
    const rows = this.db
      .query<{ role_id: number; count: number }, []>(
        "SELECT role_id, COUNT(*) as count FROM user_roles GROUP BY role_id",
      )
      .all();
    const out = new Map<number, number>();
    for (const r of rows) out.set(r.role_id, r.count);
    return out;
  }

  /**
   * Bulk lookup of explicit role assignments for a list of users. Returns a
   * Map from `userId → roleId` containing only users with a row in
   * `user_roles`; users without an explicit assignment are absent from the
   * map (callers default them to `null`, mirroring the `member` fallback
   * convention used on the wire).
   *
   * Used by the `core.member.list` enricher so the admin members panel can
   * show + edit each row's role inline without an N+1 round-trip.
   */
  getRoleIdsForUsers(userIds: readonly string[]): Map<string, number> {
    if (userIds.length === 0) return new Map();
    const placeholders = userIds.map(() => "?").join(",");
    const rows = this.db
      .query<{ user_id: string; role_id: number }, string[]>(
        `SELECT user_id, role_id FROM user_roles WHERE user_id IN (${placeholders})`,
      )
      .all(...userIds);
    const out = new Map<string, number>();
    for (const r of rows) out.set(r.user_id, r.role_id);
    return out;
  }

  /**
   * Lookup helper for cascade subscribers: returns every userId whose
   * effective role is the given roleId. Sub-second cascades use this
   * to translate a `roleId` event into the affected user set.
   */
  getUsersWithRole(roleId: number): string[] {
    return this.db
      .query<{ user_id: string }, [number]>(
        "SELECT user_id FROM user_roles WHERE role_id = ?",
      )
      .all(roleId)
      .map((r) => r.user_id);
  }

  private emitPermissionChanged(event: PermissionChangedEvent): void {
    for (const listener of this.permissionChangedListeners) {
      try {
        listener(event);
      } catch (err) {
        // Listener bugs must not corrupt engine state or block siblings.
        log.error("onPermissionChanged listener threw", {
          err: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
      }
    }
  }
}
