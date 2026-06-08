// Plugin resource store types (RP-FOUND-2) — domain rows, inputs, and results
// for the runtime-authoritative resource registry and ACL store.
//
// These are the *store-layer* shapes. The wire/protocol shapes
// (`PluginResourceTypeRegistration`, `ResourcePrincipal`, `ResourceAclEntry`,
// …) live in `@uncorded/protocol`; this module persists and reads them. No
// resolver/precedence types live here — that is RP-FOUND-3.

import type {
  PluginResourceAction,
  ValueSlotDefinition,
} from "@uncorded/protocol";

// ---------------------------------------------------------------------------
// Results (mirrors runtime/src/roles result convention)
// ---------------------------------------------------------------------------

export interface PluginResourceError {
  code: string;
  message: string;
}

export type PluginResourceResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: PluginResourceError };

export type PluginResourceVoidResult =
  | { ok: true }
  | { ok: false; error: PluginResourceError };

// ---------------------------------------------------------------------------
// Stored domain models (decoded from DB rows)
// ---------------------------------------------------------------------------

/** A registered resource type as stored (plan §4.2). */
export interface StoredResourceType {
  pluginSlug: string;
  type: string;
  parentType: string | null;
  actions: PluginResourceAction[];
  inheritableActions: PluginResourceAction[];
  actionImplications: Record<string, PluginResourceAction[]> | null;
  valueSlots: Record<string, ValueSlotDefinition>;
  producerValueAllowed: boolean;
  registeredAt: number;
}

/**
 * A stored resource instance (plan §4.1). Carries identity, structure, owner
 * metadata, and version counters — never protected content values.
 */
export interface StoredResource {
  serverId: string;
  pluginSlug: string;
  resourceType: string;
  resourceId: string;
  parentType: string | null;
  parentId: string | null;
  /** Distance from the tree root (root = 0). */
  depth: number;
  ownerUserIds: string[] | null;
  aclVersion: number;
  permissionVersion: number;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** Reference to a parent resource within the same (server, plugin) tree. */
export interface ParentResourceRef {
  resourceType: string;
  resourceId: string;
}

/** Input to create a resource instance. */
export interface CreateResourceInput {
  serverId: string;
  pluginSlug: string;
  resourceType: string;
  resourceId: string;
  /** Parent within the same (server, plugin) tree, or omitted for a root. */
  parent?: ParentResourceRef | undefined;
  /** Owner user id(s) recorded as metadata (plan §6.1 `owner` principal). */
  ownerUserIds?: string[] | undefined;
}

// ---------------------------------------------------------------------------
// SQLite row types (internal — match DB column names)
// ---------------------------------------------------------------------------

export interface ResourceTypeRow {
  id: number;
  plugin_slug: string;
  type: string;
  parent_type: string | null;
  actions: string;
  inheritable_actions: string;
  action_implications: string | null;
  value_slots: string;
  producer_value_allowed: number;
  registered_at: number;
}

export interface ResourceRow {
  server_id: string;
  plugin_slug: string;
  resource_type: string;
  resource_id: string;
  parent_type: string | null;
  parent_id: string | null;
  depth: number;
  owner_user_ids: string | null;
  acl_version: number;
  permission_version: number;
  created_at: number;
  updated_at: number;
}

export interface AclRow {
  id: number;
  server_id: string;
  plugin_slug: string;
  resource_type: string;
  resource_id: string;
  principal_kind: string;
  principal_user_id: string;
  principal_role_id: number;
  action: string;
  effect: string;
  granted_by: string;
  granted_at: number;
  source: string;
}
