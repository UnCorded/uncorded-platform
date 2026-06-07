// Roles engine types — domain models, inputs, results, and constants.

// ---------------------------------------------------------------------------
// Domain models
// ---------------------------------------------------------------------------

export interface Role {
  id: number;
  name: string;
  level: number;
  isDefault: boolean;
  parentRole: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface Permission {
  id: number;
  key: string;
  description: string;
  defaultLevel: number;
  pluginSlug: string;
  registeredAt: number;
}

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface CreateRoleInput {
  name: string;
  level: number;
}

export interface UpdateRoleInput {
  name?: string;
  level?: number;
}

export interface RegisterPermissionInput {
  key: string;
  description: string;
  defaultLevel: number;
  pluginSlug: string;
}

// ---------------------------------------------------------------------------
// Caller context (passed to mutating + checking methods for hierarchy)
// ---------------------------------------------------------------------------

export interface CallerContext {
  userId: string;
  isOwner: boolean;
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface RolesError {
  code: string;
  message: string;
}

export type RolesResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: RolesError };

export type VoidResult =
  | { ok: true }
  | { ok: false; error: RolesError };

// ---------------------------------------------------------------------------
// SQLite row types (internal, matches DB column names)
// ---------------------------------------------------------------------------

export interface RoleRow {
  id: number;
  name: string;
  level: number;
  is_default: number;
  parent_role: number | null;
  created_at: number;
  updated_at: number;
}

export interface PermissionRow {
  id: number;
  key: string;
  description: string;
  default_level: number;
  plugin_slug: string;
  registered_at: number;
}

export interface RolePermissionRow {
  role_id: number;
  permission_id: number;
  granted: number;
}

export interface UserRoleRow {
  user_id: string;
  role_id: number;
}

// ---------------------------------------------------------------------------
// Default roles
// ---------------------------------------------------------------------------

export const DEFAULT_ROLES = {
  owner:     { name: "owner",     level: 100 },
  admin:     { name: "admin",     level: 80  },
  moderator: { name: "moderator", level: 60  },
  member:    { name: "member",    level: 10  },
} as const;
