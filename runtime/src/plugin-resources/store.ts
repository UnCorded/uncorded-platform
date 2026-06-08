// Plugin resource store (RP-FOUND-2) — runtime-authoritative registry and ACL
// store for plugin resources. Operates on /data/core.db.
//
// Scope of this layer (deliberately narrow, per the RP-FOUND-2 row in the plan
// §12 PR sequence):
//   - register resource types (validated against the protocol schema);
//   - persist resource instances (identity, parent link, owner metadata,
//     version counters, timestamps) — NEVER protected content values;
//   - persist explicit / registry-seeded ACL rows;
//   - enforce metadata integrity: action must be declared by the type,
//     principal shape must be valid, parent type must match, depth is bounded,
//     cycles are rejected;
//   - bump the resource ACL version on ACL mutations and owner/parent
//     reassignment.
//
// What this layer is NOT (lands later): the resolver. There is no precedence,
// inheritance evaluation, role/everyone/owner expansion, deny/allow resolution,
// owner bypass, or ban short-circuit here. RP-FOUND-3 builds the decision engine
// on top of this store.

import type { Database } from "bun:sqlite";
import {
  PluginResourceTypeRegistrationSchema,
  ResourcePrincipalSchema,
} from "@uncorded/protocol-schemas";
import { MAX_PLUGIN_RESOURCE_PARENT_DEPTH } from "@uncorded/protocol";
import type {
  PluginResourceAction,
  PluginResourceKey,
  PluginResourceTypeRegistration,
  ResourceAclEntry,
  ResourcePrincipal,
  ValueSlotDefinition,
} from "@uncorded/protocol";
import { runMigrations } from "../migrations";
import type { FileListFn, FileReadFn, MigrationResult } from "../migrations";
import type {
  AclRow,
  CreateResourceInput,
  ParentResourceRef,
  PluginResourceResult,
  PluginResourceVoidResult,
  ResourceRow,
  ResourceTypeRow,
  StoredResource,
  StoredResourceType,
} from "./types";

/** Tracking table for this module's migrations — independent of roles/core. */
const MIGRATIONS_TABLE = "_plugin_resources_migrations";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function err(code: string, message: string): { ok: false; error: { code: string; message: string } } {
  return { ok: false, error: { code, message } };
}

function toResourceType(row: ResourceTypeRow): StoredResourceType {
  return {
    pluginSlug: row.plugin_slug,
    type: row.type,
    parentType: row.parent_type,
    actions: JSON.parse(row.actions) as PluginResourceAction[],
    inheritableActions: JSON.parse(row.inheritable_actions) as PluginResourceAction[],
    actionImplications:
      row.action_implications === null
        ? null
        : (JSON.parse(row.action_implications) as Record<string, PluginResourceAction[]>),
    valueSlots: JSON.parse(row.value_slots) as Record<string, ValueSlotDefinition>,
    producerValueAllowed: row.producer_value_allowed === 1,
    registeredAt: row.registered_at,
  };
}

function toResource(row: ResourceRow): StoredResource {
  return {
    serverId: row.server_id,
    pluginSlug: row.plugin_slug,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    parentType: row.parent_type,
    parentId: row.parent_id,
    depth: row.depth,
    ownerUserIds: row.owner_user_ids === null ? null : (JSON.parse(row.owner_user_ids) as string[]),
    aclVersion: row.acl_version,
    permissionVersion: row.permission_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Principal → DB columns. Unused columns use sentinels ('' / 0). */
function principalToCols(p: ResourcePrincipal): {
  kind: string;
  userId: string;
  roleId: number;
} {
  switch (p.kind) {
    case "user":
      return { kind: "user", userId: p.userId, roleId: 0 };
    case "role":
      return { kind: "role", userId: "", roleId: p.roleId };
    case "everyone":
      return { kind: "everyone", userId: "", roleId: 0 };
    case "owner":
      return { kind: "owner", userId: "", roleId: 0 };
  }
}

function rowToPrincipal(row: AclRow): ResourcePrincipal {
  switch (row.principal_kind) {
    case "user":
      return { kind: "user", userId: row.principal_user_id };
    case "role":
      return { kind: "role", roleId: row.principal_role_id };
    case "everyone":
      return { kind: "everyone" };
    default:
      return { kind: "owner" };
  }
}

// ---------------------------------------------------------------------------
// PluginResourceStore
// ---------------------------------------------------------------------------

export class PluginResourceStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /**
   * Run this module's migrations against core.db. Mirrors
   * `RolesEngine.initialize` / `CoreModule.initialize`: a separate migration
   * directory and tracking table sharing the same database file.
   */
  static initialize(
    db: Database,
    migrationsDir: string,
    listFiles: FileListFn,
    readFile: FileReadFn,
  ): MigrationResult {
    return runMigrations("plugin-resources", db, migrationsDir, listFiles, readFile, {
      migrationsTable: MIGRATIONS_TABLE,
    });
  }

  // -----------------------------------------------------------------------
  // Resource type registration (plan §4.2)
  // -----------------------------------------------------------------------

  /**
   * Register (or update) a plugin resource type. Validated against the protocol
   * schema; an invalid registration (bad action shape, inheritableActions not a
   * subset, dangling actionImplications, missing producerValueAllowed, …) is
   * rejected. A re-registration of the same (pluginSlug, type) updates the
   * metadata in place.
   */
  registerType(registration: PluginResourceTypeRegistration): PluginResourceVoidResult {
    const parsed = PluginResourceTypeRegistrationSchema.safeParse(registration);
    if (!parsed.success) {
      return err(
        "INVALID_REGISTRATION",
        `Invalid resource type registration: ${parsed.error.issues.map((i) => i.message).join("; ")}.`,
      );
    }
    const reg = parsed.data;

    this.db.run(
      `INSERT INTO plugin_resource_types
         (plugin_slug, type, parent_type, actions, inheritable_actions,
          action_implications, value_slots, producer_value_allowed, registered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (plugin_slug, type) DO UPDATE SET
         parent_type = excluded.parent_type,
         actions = excluded.actions,
         inheritable_actions = excluded.inheritable_actions,
         action_implications = excluded.action_implications,
         value_slots = excluded.value_slots,
         producer_value_allowed = excluded.producer_value_allowed`,
      [
        reg.pluginSlug,
        reg.type,
        reg.parentType ?? null,
        JSON.stringify(reg.actions),
        JSON.stringify(reg.inheritableActions),
        reg.actionImplications === undefined ? null : JSON.stringify(reg.actionImplications),
        JSON.stringify(reg.valueSlots),
        reg.producerValueAllowed ? 1 : 0,
        Date.now(),
      ],
    );
    return { ok: true };
  }

  getType(pluginSlug: string, type: string): StoredResourceType | null {
    const row = this.db
      .query<ResourceTypeRow, [string, string]>(
        "SELECT * FROM plugin_resource_types WHERE plugin_slug = ? AND type = ?",
      )
      .get(pluginSlug, type);
    return row ? toResourceType(row) : null;
  }

  // -----------------------------------------------------------------------
  // Resource instances (plan §4.1)
  // -----------------------------------------------------------------------

  /**
   * Create a resource instance. Validates: the resource type is registered, the
   * key is not already taken, and — when a parent is supplied — that the parent
   * exists in the same (server, plugin) tree, its type matches the registered
   * `parentType`, no cycle is formed, and the resulting depth does not exceed
   * `MAX_PLUGIN_RESOURCE_PARENT_DEPTH`.
   *
   * No protected content value is accepted or stored: the input has no value
   * field by construction.
   */
  createResource(input: CreateResourceInput): PluginResourceResult<StoredResource> {
    const type = this.getType(input.pluginSlug, input.resourceType);
    if (!type) {
      return err(
        "UNKNOWN_RESOURCE_TYPE",
        `Resource type "${input.resourceType}" is not registered for plugin "${input.pluginSlug}".`,
      );
    }

    const key: PluginResourceKey = {
      serverId: input.serverId,
      pluginSlug: input.pluginSlug,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
    };

    if (this.getResource(key)) {
      return err(
        "RESOURCE_EXISTS",
        `Resource ${describeKey(key)} already exists.`,
      );
    }

    let parentType: string | null = null;
    let parentId: string | null = null;
    let depth = 0;

    if (input.parent) {
      const check = this.validateParent(
        input.serverId,
        input.pluginSlug,
        type,
        input.resourceId,
        input.parent,
        input.resourceType,
      );
      if (!check.ok) return check;
      parentType = input.parent.resourceType;
      parentId = input.parent.resourceId;
      depth = check.value;
    } else if (type.parentType !== null && type.parentType !== type.type) {
      // A type whose parent is a *different* type must always be created under a
      // parent; a parentless instance is an orphan that cannot participate in the
      // tree (plan §4.1 parent metadata integrity). Self-referential types
      // (parentType === type, e.g. nested folders / threads) are exempt: their
      // tree root legitimately has no parent.
      return err(
        "PARENT_REQUIRED",
        `Resource type "${type.type}" declares parentType "${type.parentType}"; a parent is required.`,
      );
    }

    const now = Date.now();
    this.db.run(
      `INSERT INTO plugin_resources
         (server_id, plugin_slug, resource_type, resource_id, parent_type, parent_id,
          depth, owner_user_ids, acl_version, permission_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)`,
      [
        input.serverId,
        input.pluginSlug,
        input.resourceType,
        input.resourceId,
        parentType,
        parentId,
        depth,
        input.ownerUserIds && input.ownerUserIds.length > 0 ? JSON.stringify(input.ownerUserIds) : null,
        now,
        now,
      ],
    );

    const inserted = this.getResource(key);
    if (!inserted) {
      throw new Error(`Failed to retrieve resource after insert for key: ${describeKey(key)}.`);
    }
    return { ok: true, value: inserted };
  }

  getResource(key: PluginResourceKey): StoredResource | null {
    const row = this.db
      .query<ResourceRow, [string, string, string, string]>(
        `SELECT * FROM plugin_resources
         WHERE server_id = ? AND plugin_slug = ? AND resource_type = ? AND resource_id = ?`,
      )
      .get(key.serverId, key.pluginSlug, key.resourceType, key.resourceId);
    return row ? toResource(row) : null;
  }

  /**
   * Re-assign a resource's parent (or detach it with `null`). Enforces the same
   * parent integrity rules as create (type match, cycle, depth) across the moved
   * node and its descendants, and bumps the ACL version (plan §11.1).
   */
  reassignParent(
    key: PluginResourceKey,
    newParent: ParentResourceRef | null,
  ): PluginResourceVoidResult {
    const resource = this.getResource(key);
    if (!resource) {
      return err("UNKNOWN_RESOURCE", `Resource ${describeKey(key)} not found.`);
    }
    const type = this.getType(key.pluginSlug, key.resourceType);
    if (!type) {
      return err("UNKNOWN_RESOURCE_TYPE", `Resource type "${key.resourceType}" is not registered.`);
    }

    let newDepth = 0;
    if (newParent) {
      const check = this.validateParent(key.serverId, key.pluginSlug, type, key.resourceId, newParent, key.resourceType);
      if (!check.ok) return check;
      newDepth = check.value;
    }

    // Re-parenting shifts the whole subtree's depth. Reject before mutating if
    // any descendant would exceed the bound.
    const delta = newDepth - resource.depth;
    if (delta > 0) {
      const maxDescendantDepth = this.maxSubtreeDepth(key);
      if (maxDescendantDepth + delta > MAX_PLUGIN_RESOURCE_PARENT_DEPTH) {
        return err(
          "MAX_DEPTH_EXCEEDED",
          `Re-parenting ${describeKey(key)} would push a descendant past depth ${MAX_PLUGIN_RESOURCE_PARENT_DEPTH}.`,
        );
      }
    }

    const now = Date.now();
    const tx = this.db.transaction(() => {
      this.db.run(
        `UPDATE plugin_resources
           SET parent_type = ?, parent_id = ?, depth = ?, acl_version = acl_version + 1, updated_at = ?
         WHERE server_id = ? AND plugin_slug = ? AND resource_type = ? AND resource_id = ?`,
        [
          newParent ? newParent.resourceType : null,
          newParent ? newParent.resourceId : null,
          newDepth,
          now,
          key.serverId,
          key.pluginSlug,
          key.resourceType,
          key.resourceId,
        ],
      );
      if (delta !== 0) this.shiftDescendantDepths(key, delta, now);
    });
    tx();
    return { ok: true };
  }

  /** Set (or clear) the owner metadata. Bumps the ACL version (plan §11.1). */
  setOwner(key: PluginResourceKey, ownerUserIds: string[] | null): PluginResourceVoidResult {
    const resource = this.getResource(key);
    if (!resource) {
      return err("UNKNOWN_RESOURCE", `Resource ${describeKey(key)} not found.`);
    }
    this.db.run(
      `UPDATE plugin_resources
         SET owner_user_ids = ?, acl_version = acl_version + 1, updated_at = ?
       WHERE server_id = ? AND plugin_slug = ? AND resource_type = ? AND resource_id = ?`,
      [
        ownerUserIds && ownerUserIds.length > 0 ? JSON.stringify(ownerUserIds) : null,
        Date.now(),
        key.serverId,
        key.pluginSlug,
        key.resourceType,
        key.resourceId,
      ],
    );
    return { ok: true };
  }

  // -----------------------------------------------------------------------
  // ACL rows (plan §6.2)
  // -----------------------------------------------------------------------

  /** Store an `allow` ACL row. Bumps the resource ACL version. */
  grant(
    key: PluginResourceKey,
    principal: ResourcePrincipal,
    action: PluginResourceAction,
    grantedBy: string,
    source: "explicit" | "registry-seeded" = "explicit",
  ): PluginResourceVoidResult {
    return this.setAcl(key, principal, action, "allow", grantedBy, source);
  }

  /** Store a `deny` ACL row. Bumps the resource ACL version. */
  deny(
    key: PluginResourceKey,
    principal: ResourcePrincipal,
    action: PluginResourceAction,
    grantedBy: string,
    source: "explicit" | "registry-seeded" = "explicit",
  ): PluginResourceVoidResult {
    return this.setAcl(key, principal, action, "deny", grantedBy, source);
  }

  /**
   * Remove an ACL row for `(resource, principal, action)`. Bumps the ACL
   * version only if a row was actually removed.
   */
  revoke(
    key: PluginResourceKey,
    principal: ResourcePrincipal,
    action: PluginResourceAction,
  ): PluginResourceVoidResult {
    const resource = this.getResource(key);
    if (!resource) {
      return err("UNKNOWN_RESOURCE", `Resource ${describeKey(key)} not found.`);
    }
    const cols = principalToCols(principal);
    this.db.run(
      `DELETE FROM plugin_resource_acl
         WHERE server_id = ? AND plugin_slug = ? AND resource_type = ? AND resource_id = ?
           AND principal_kind = ? AND principal_user_id = ? AND principal_role_id = ? AND action = ?`,
      [
        key.serverId,
        key.pluginSlug,
        key.resourceType,
        key.resourceId,
        cols.kind,
        cols.userId,
        cols.roleId,
        action,
      ],
    );
    const changed = this.db.query<{ cnt: number }, []>("SELECT changes() as cnt").get()!.cnt;
    if (changed > 0) this.bumpAclVersion(key);
    return { ok: true };
  }

  /** All stored ACL rows for a resource, in insertion order. */
  listAcl(key: PluginResourceKey): ResourceAclEntry[] {
    const rows = this.db
      .query<AclRow, [string, string, string, string]>(
        `SELECT * FROM plugin_resource_acl
         WHERE server_id = ? AND plugin_slug = ? AND resource_type = ? AND resource_id = ?
         ORDER BY id ASC`,
      )
      .all(key.serverId, key.pluginSlug, key.resourceType, key.resourceId);
    return rows.map((row) => ({
      resourceKey: {
        serverId: row.server_id,
        pluginSlug: row.plugin_slug,
        resourceType: row.resource_type,
        resourceId: row.resource_id,
      },
      principal: rowToPrincipal(row),
      action: row.action,
      effect: row.effect === "deny" ? "deny" : "allow",
      grantedBy: row.granted_by,
      grantedAt: row.granted_at,
      source: row.source === "registry-seeded" ? "registry-seeded" : "explicit",
    }));
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private setAcl(
    key: PluginResourceKey,
    principal: ResourcePrincipal,
    action: PluginResourceAction,
    effect: "allow" | "deny",
    grantedBy: string,
    source: "explicit" | "registry-seeded",
  ): PluginResourceVoidResult {
    const resource = this.getResource(key);
    if (!resource) {
      return err("UNKNOWN_RESOURCE", `Resource ${describeKey(key)} not found.`);
    }

    // Principal shape must be valid (plan §6.1).
    const principalParse = ResourcePrincipalSchema.safeParse(principal);
    if (!principalParse.success) {
      return err(
        "INVALID_PRINCIPAL",
        `Invalid principal: ${principalParse.error.issues.map((i) => i.message).join("; ")}.`,
      );
    }

    // Action must be declared by the resource type (plan §5.2 — no free-form
    // actions; an undeclared action fails closed).
    const type = this.getType(key.pluginSlug, key.resourceType);
    if (!type) {
      return err("UNKNOWN_RESOURCE_TYPE", `Resource type "${key.resourceType}" is not registered.`);
    }
    if (!type.actions.includes(action)) {
      return err(
        "INVALID_ACTION",
        `Action "${action}" is not declared by resource type "${key.resourceType}".`,
      );
    }

    if (!grantedBy) {
      return err("INVALID_GRANTER", "grantedBy must be a non-empty user id (or 'system').");
    }

    const cols = principalToCols(principalParse.data);
    const tx = this.db.transaction(() => {
      this.db.run(
        `INSERT INTO plugin_resource_acl
           (server_id, plugin_slug, resource_type, resource_id,
            principal_kind, principal_user_id, principal_role_id,
            action, effect, granted_by, granted_at, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (server_id, plugin_slug, resource_type, resource_id,
                      principal_kind, principal_user_id, principal_role_id, action)
         DO UPDATE SET effect = excluded.effect, granted_by = excluded.granted_by,
                       granted_at = excluded.granted_at, source = excluded.source`,
        [
          key.serverId,
          key.pluginSlug,
          key.resourceType,
          key.resourceId,
          cols.kind,
          cols.userId,
          cols.roleId,
          action,
          effect,
          grantedBy,
          Date.now(),
          source,
        ],
      );
      this.bumpAclVersion(key);
    });
    tx();
    return { ok: true };
  }

  private bumpAclVersion(key: PluginResourceKey): void {
    this.db.run(
      `UPDATE plugin_resources
         SET acl_version = acl_version + 1, updated_at = ?
       WHERE server_id = ? AND plugin_slug = ? AND resource_type = ? AND resource_id = ?`,
      [Date.now(), key.serverId, key.pluginSlug, key.resourceType, key.resourceId],
    );
  }

  /**
   * Validate a proposed parent for a (would-be) child of `type`. Returns the
   * child's resulting depth on success. `childResourceType` is always supplied
   * so cycle detection compares the full resource key, not just the id.
   */
  private validateParent(
    serverId: string,
    pluginSlug: string,
    type: StoredResourceType,
    childResourceId: string,
    parent: ParentResourceRef,
    childResourceType: string,
  ): PluginResourceResult<number> {
    if (type.parentType === null) {
      return err(
        "PARENT_NOT_ALLOWED",
        `Resource type "${type.type}" declares no parentType; cannot attach a parent.`,
      );
    }
    if (parent.resourceType !== type.parentType) {
      return err(
        "PARENT_TYPE_MISMATCH",
        `Parent type "${parent.resourceType}" does not match registered parentType "${type.parentType}" for "${type.type}".`,
      );
    }

    // Self-parent is the trivial cycle.
    if (
      parent.resourceId === childResourceId &&
      parent.resourceType === childResourceType
    ) {
      return err("PARENT_CYCLE", `Resource "${childResourceId}" cannot be its own parent.`);
    }

    // Parent must exist in the same (server, plugin) tree. A parent in another
    // server or plugin is simply unrepresentable here (the lookup is scoped),
    // which enforces the no-cross-boundary-parent rule (plan §4.3).
    const parentRow = this.getResource({
      serverId,
      pluginSlug,
      resourceType: parent.resourceType,
      resourceId: parent.resourceId,
    });
    if (!parentRow) {
      return err(
        "PARENT_NOT_FOUND",
        `Parent resource ${parent.resourceType}:${parent.resourceId} not found in this (server, plugin) tree.`,
      );
    }

    // Walk the parent chain to the root, rejecting a cycle back to the child and
    // bounding the chain length defensively.
    let cursor: { resourceType: string; resourceId: string } | null = {
      resourceType: parentRow.resourceType,
      resourceId: parentRow.resourceId,
    };
    let hops = 0;
    while (cursor) {
      if (
        cursor.resourceId === childResourceId &&
        cursor.resourceType === childResourceType
      ) {
        return err(
          "PARENT_CYCLE",
          `Re-parenting "${childResourceId}" under ${parent.resourceType}:${parent.resourceId} would form a cycle.`,
        );
      }
      if (hops > MAX_PLUGIN_RESOURCE_PARENT_DEPTH + 1) {
        return err("PARENT_CYCLE", "Parent chain exceeds the maximum depth — possible cycle.");
      }
      const ancestor: StoredResource | null = this.getResource({
        serverId,
        pluginSlug,
        resourceType: cursor.resourceType,
        resourceId: cursor.resourceId,
      });
      if (!ancestor || ancestor.parentId === null || ancestor.parentType === null) {
        cursor = null;
      } else {
        cursor = { resourceType: ancestor.parentType, resourceId: ancestor.parentId };
      }
      hops++;
    }

    const newDepth = parentRow.depth + 1;
    if (newDepth > MAX_PLUGIN_RESOURCE_PARENT_DEPTH) {
      return err(
        "MAX_DEPTH_EXCEEDED",
        `Parent chain depth ${newDepth} exceeds the maximum of ${MAX_PLUGIN_RESOURCE_PARENT_DEPTH}.`,
      );
    }

    return { ok: true, value: newDepth };
  }

  /** Largest depth among `key` and all its descendants. */
  private maxSubtreeDepth(key: PluginResourceKey): number {
    let max = this.getResource(key)?.depth ?? 0;
    const queue: Array<{ resourceType: string; resourceId: string }> = [
      { resourceType: key.resourceType, resourceId: key.resourceId },
    ];
    while (queue.length > 0) {
      const node = queue.shift()!;
      const children = this.childrenOf(key.serverId, key.pluginSlug, node.resourceType, node.resourceId);
      for (const child of children) {
        if (child.depth > max) max = child.depth;
        queue.push({ resourceType: child.resource_type, resourceId: child.resource_id });
      }
    }
    return max;
  }

  /** Shift the depth of every descendant of `key` by `delta`. */
  private shiftDescendantDepths(key: PluginResourceKey, delta: number, now: number): void {
    const queue: Array<{ resourceType: string; resourceId: string }> = [
      { resourceType: key.resourceType, resourceId: key.resourceId },
    ];
    while (queue.length > 0) {
      const node = queue.shift()!;
      const children = this.childrenOf(key.serverId, key.pluginSlug, node.resourceType, node.resourceId);
      for (const child of children) {
        this.db.run(
          `UPDATE plugin_resources
             SET depth = depth + ?, updated_at = ?
           WHERE server_id = ? AND plugin_slug = ? AND resource_type = ? AND resource_id = ?`,
          [delta, now, key.serverId, key.pluginSlug, child.resource_type, child.resource_id],
        );
        queue.push({ resourceType: child.resource_type, resourceId: child.resource_id });
      }
    }
  }

  private childrenOf(
    serverId: string,
    pluginSlug: string,
    parentType: string,
    parentId: string,
  ): ResourceRow[] {
    return this.db
      .query<ResourceRow, [string, string, string, string]>(
        `SELECT * FROM plugin_resources
         WHERE server_id = ? AND plugin_slug = ? AND parent_type = ? AND parent_id = ?`,
      )
      .all(serverId, pluginSlug, parentType, parentId);
  }
}

function describeKey(key: PluginResourceKey): string {
  return `${key.serverId}/${key.pluginSlug}/${key.resourceType}:${key.resourceId}`;
}
