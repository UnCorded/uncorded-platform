// Typed wrapper around the runtime's `core.*` IPC surface (spec-22 Amendment B).
//
// `request()` from lib/ws.ts is the underlying transport — this module adds:
//   1. Per-action input/output types so callers can't mistype params.
//   2. A `CoreError` subclass that preserves the runtime `error.code` field
//      so callers can `switch (err.code)` instead of parsing messages.
//
// The wrapper is intentionally THIN: it does no caching, no batching, no
// retries. Stores (stores/permissions.ts) layer those policies on top.

import type {
  CoreMember,
  CoreMemberListResponse,
  CoreMemberMe,
  CoreRole,
  CorePermission,
  CorePermissionAuditEntry,
  CorePermissionChange,
  CorePermissionGrantManyResponse,
  CoreErrorCode,
} from "@uncorded/protocol";
import { request } from "./ws";

/**
 * Error thrown by every coreClient.* method when the runtime returns an
 * error envelope. Preserves the structured `code` from the wire so callers
 * can `switch` on it.
 *
 * `code` is typed as `CoreErrorCode | string` because the runtime can return
 * codes the protocol package hasn't catalogued yet (forward-compat).
 */
export class CoreError extends Error {
  readonly code: CoreErrorCode | string;
  constructor(code: CoreErrorCode | string, message: string) {
    super(message);
    this.name = "CoreError";
    this.code = code;
  }
}

function call<T>(
  serverId: string,
  action: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  return request<T>(serverId, "core", action, params).catch((err: unknown) => {
    const e = err as { code?: string; message?: string };
    throw new CoreError(e.code ?? "core/unknown", e.message ?? String(err));
  });
}

// ---------------------------------------------------------------------------
// member
// ---------------------------------------------------------------------------

export interface MemberListOptions {
  /** Page size. Defaults to 200 in the runtime; max 500. */
  limit?: number;
  /**
   * Opaque cursor returned by the previous page's `next_cursor`. Pass
   * verbatim — the runtime currently encodes "offset:<N>" but clients must
   * not parse it.
   */
  cursor?: string;
  /** Alternative to `cursor`: explicit zero-based offset. */
  offset?: number;
}

export const member = {
  list(serverId: string, opts: MemberListOptions = {}): Promise<CoreMemberListResponse> {
    const params: Record<string, unknown> = {};
    if (opts.limit !== undefined) params["limit"] = opts.limit;
    if (opts.cursor !== undefined) params["cursor"] = opts.cursor;
    if (opts.offset !== undefined) params["offset"] = opts.offset;
    return call<CoreMemberListResponse>(serverId, "core.member.list", params);
  },

  me(serverId: string): Promise<CoreMemberMe> {
    return call<CoreMemberMe>(serverId, "core.member.me");
  },

  /**
   * Look up the current role of an arbitrary member. Gated by
   * `core.permissions.manage` server-side — the runtime returns FORBIDDEN
   * to non-owners without that permission.
   */
  role(serverId: string, userId: string): Promise<{ role: CoreRole }> {
    return call<{ role: CoreRole }>(serverId, "core.member.role", { user_id: userId });
  },
} as const;

// ---------------------------------------------------------------------------
// role
// ---------------------------------------------------------------------------

export interface RoleCreateInput {
  name: string;
  /** 1-99. Owner (100) is Central-bound and not creatable here. */
  level: number;
}

export interface RoleUpdateInput {
  name?: string;
  level?: number;
}

export const role = {
  list(serverId: string): Promise<{ roles: CoreRole[] }> {
    return call<{ roles: CoreRole[] }>(serverId, "core.role.list");
  },

  create(serverId: string, input: RoleCreateInput): Promise<{ role: CoreRole }> {
    return call<{ role: CoreRole }>(serverId, "core.role.create", { ...input });
  },

  update(serverId: string, roleId: number, patch: RoleUpdateInput): Promise<{ role: CoreRole }> {
    return call<{ role: CoreRole }>(serverId, "core.role.update", { role_id: roleId, ...patch });
  },

  delete(serverId: string, roleId: number): Promise<Record<string, never>> {
    return call<Record<string, never>>(serverId, "core.role.delete", { role_id: roleId });
  },

  assign(serverId: string, userId: string, roleId: number): Promise<Record<string, never>> {
    return call<Record<string, never>>(serverId, "core.role.assign", {
      user_id: userId,
      role_id: roleId,
    });
  },

  remove(serverId: string, userId: string): Promise<Record<string, never>> {
    return call<Record<string, never>>(serverId, "core.role.remove", { user_id: userId });
  },
} as const;

// ---------------------------------------------------------------------------
// permissions
// ---------------------------------------------------------------------------

export interface AuditListOptions {
  limit?: number;
  offset?: number;
}

export const permissions = {
  list(serverId: string): Promise<{ permissions: CorePermission[] }> {
    return call<{ permissions: CorePermission[] }>(serverId, "core.permissions.list");
  },

  grant(
    serverId: string,
    roleId: number,
    permission: string,
    reason?: string,
  ): Promise<Record<string, never>> {
    const params: Record<string, unknown> = { role_id: roleId, permission };
    if (reason !== undefined) params["reason"] = reason;
    return call<Record<string, never>>(serverId, "core.permissions.grant", params);
  },

  deny(
    serverId: string,
    roleId: number,
    permission: string,
    reason?: string,
  ): Promise<Record<string, never>> {
    const params: Record<string, unknown> = { role_id: roleId, permission };
    if (reason !== undefined) params["reason"] = reason;
    return call<Record<string, never>>(serverId, "core.permissions.deny", params);
  },

  remove(
    serverId: string,
    roleId: number,
    permission: string,
    reason?: string,
  ): Promise<Record<string, never>> {
    const params: Record<string, unknown> = { role_id: roleId, permission };
    if (reason !== undefined) params["reason"] = reason;
    return call<Record<string, never>>(serverId, "core.permissions.remove", params);
  },

  grantMany(
    serverId: string,
    roleId: number,
    changes: CorePermissionChange[],
  ): Promise<CorePermissionGrantManyResponse> {
    return call<CorePermissionGrantManyResponse>(serverId, "core.permissions.grantMany", {
      role_id: roleId,
      changes,
    });
  },

  audit(
    serverId: string,
    opts: AuditListOptions = {},
  ): Promise<{ entries: CorePermissionAuditEntry[] }> {
    const params: Record<string, unknown> = {};
    if (opts.limit !== undefined) params["limit"] = opts.limit;
    if (opts.offset !== undefined) params["offset"] = opts.offset;
    return call<{ entries: CorePermissionAuditEntry[] }>(serverId, "core.permissions.audit", params);
  },
} as const;

// ---------------------------------------------------------------------------
// re-export under a single namespace for ergonomic imports
// ---------------------------------------------------------------------------

export const coreClient = { member, role, permissions } as const;
export type { CoreMember };
