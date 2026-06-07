// Roles, permissions, and audit-log stores for the active server (spec-22
// Amendment B). Three independent stores, all live-refreshed on
// `core.permission.changed` with a 200ms trailing debounce so a bulk
// matrix-save doesn't trigger N round trips.
//
// Stores are LAZY: they don't fetch until the first call to ensureLoaded()
// (or refetch()). This keeps the data plane out of the bootcritical path —
// only the Administration tab and member-manage sheet pay the cost.
//
// Per `feedback_solid_patcher_cascade.md`: effects that read these stores
// must memoize narrow keys, otherwise a refetch can cascade into unrelated
// effects.

import { createSignal, createEffect, createMemo, untrack, onCleanup } from "solid-js";
import { activeServerId, activeServer } from "./servers";
import { connect, onPluginMessage } from "../lib/ws";
import { coreClient, CoreError } from "../lib/core-client";
import { createTrailingDebouncer } from "../lib/trailing-debounce";
import type {
  CoreRole,
  CorePermission,
  CorePermissionAuditEntry,
} from "@uncorded/protocol";

// Default page size for the audit log. Matches `PERMISSIONS_AUDIT_LIMIT_MAX`
// in runtime/src/core/ipc.ts (200), but we ask for 100 as a usable default.
const AUDIT_PAGE_SIZE = 100;

// Trailing-debounce window for `core.permission.changed` invalidations.
// 200ms collapses a matrix bulk-save into one refetch per store.
const INVALIDATE_DEBOUNCE_MS = 200;

// ---------------------------------------------------------------------------
// Internal: per-server signals + load state
// ---------------------------------------------------------------------------

interface RolesState {
  roles: CoreRole[];
  loading: boolean;
  error: CoreError | null;
}

interface PermissionsState {
  permissions: CorePermission[];
  loading: boolean;
  error: CoreError | null;
}

interface AuditState {
  entries: CorePermissionAuditEntry[];
  loading: boolean;
  error: CoreError | null;
  hasMore: boolean;
}

const EMPTY_ROLES: RolesState = { roles: [], loading: false, error: null };
const EMPTY_PERMS: PermissionsState = { permissions: [], loading: false, error: null };
const EMPTY_AUDIT: AuditState = { entries: [], loading: false, error: null, hasMore: false };

const [rolesByServer, setRolesByServer] = createSignal<Record<string, RolesState>>({});
const [permsByServer, setPermsByServer] = createSignal<Record<string, PermissionsState>>({});
const [auditByServer, setAuditByServer] = createSignal<Record<string, AuditState>>({});

// Tracks per-server "have we ever fetched" state so consumers can call
// ensureLoaded() unconditionally without spamming the network.
const rolesLoaded = new Set<string>();
const permsLoaded = new Set<string>();
const auditLoaded = new Set<string>();

function patchRoles(serverId: string, patch: Partial<RolesState>): void {
  setRolesByServer((prev) => ({
    ...prev,
    [serverId]: { ...(prev[serverId] ?? EMPTY_ROLES), ...patch },
  }));
}

function patchPerms(serverId: string, patch: Partial<PermissionsState>): void {
  setPermsByServer((prev) => ({
    ...prev,
    [serverId]: { ...(prev[serverId] ?? EMPTY_PERMS), ...patch },
  }));
}

function patchAudit(serverId: string, patch: Partial<AuditState>): void {
  setAuditByServer((prev) => ({
    ...prev,
    [serverId]: { ...(prev[serverId] ?? EMPTY_AUDIT), ...patch },
  }));
}

function asCoreError(err: unknown): CoreError {
  if (err instanceof CoreError) return err;
  const e = err as { code?: string; message?: string };
  return new CoreError(e.code ?? "core/unknown", e.message ?? String(err));
}

// ---------------------------------------------------------------------------
// Public accessors — narrow per-server reads. Memoize at call site if the
// caller depends on a derived shape (per feedback_solid_patcher_cascade.md).
// ---------------------------------------------------------------------------

export const rolesStoreFor = (serverId: string) => () =>
  rolesByServer()[serverId] ?? EMPTY_ROLES;

export const permissionsStoreFor = (serverId: string) => () =>
  permsByServer()[serverId] ?? EMPTY_PERMS;

export const auditStoreFor = (serverId: string) => () =>
  auditByServer()[serverId] ?? EMPTY_AUDIT;

// ---------------------------------------------------------------------------
// Fetchers
// ---------------------------------------------------------------------------

export async function refetchRoles(serverId: string): Promise<void> {
  patchRoles(serverId, { loading: true, error: null });
  try {
    const res = await coreClient.role.list(serverId);
    patchRoles(serverId, { roles: res.roles, loading: false });
  } catch (err) {
    patchRoles(serverId, { loading: false, error: asCoreError(err) });
  }
}

export async function refetchPermissions(serverId: string): Promise<void> {
  patchPerms(serverId, { loading: true, error: null });
  try {
    const res = await coreClient.permissions.list(serverId);
    patchPerms(serverId, { permissions: res.permissions, loading: false });
  } catch (err) {
    patchPerms(serverId, { loading: false, error: asCoreError(err) });
  }
}

/** Resets the audit log to page 1. Use after a fresh subscribe or on demand. */
export async function refetchAudit(serverId: string): Promise<void> {
  patchAudit(serverId, { loading: true, error: null, entries: [], hasMore: false });
  try {
    const res = await coreClient.permissions.audit(serverId, { limit: AUDIT_PAGE_SIZE, offset: 0 });
    patchAudit(serverId, {
      entries: res.entries,
      loading: false,
      hasMore: res.entries.length === AUDIT_PAGE_SIZE,
    });
  } catch (err) {
    patchAudit(serverId, { loading: false, error: asCoreError(err) });
  }
}

/**
 * Append the next page of audit entries. No-op if {@link AuditState.hasMore}
 * is false or a previous load is still in flight.
 */
export async function loadMoreAudit(serverId: string): Promise<void> {
  const cur = auditByServer()[serverId];
  if (!cur || cur.loading || !cur.hasMore) return;
  patchAudit(serverId, { loading: true });
  try {
    const res = await coreClient.permissions.audit(serverId, {
      limit: AUDIT_PAGE_SIZE,
      offset: cur.entries.length,
    });
    patchAudit(serverId, {
      entries: [...cur.entries, ...res.entries],
      loading: false,
      hasMore: res.entries.length === AUDIT_PAGE_SIZE,
    });
  } catch (err) {
    patchAudit(serverId, { loading: false, error: asCoreError(err) });
  }
}

export async function ensureRolesLoaded(serverId: string): Promise<void> {
  if (rolesLoaded.has(serverId)) return;
  rolesLoaded.add(serverId);
  await refetchRoles(serverId);
}

export async function ensurePermissionsLoaded(serverId: string): Promise<void> {
  if (permsLoaded.has(serverId)) return;
  permsLoaded.add(serverId);
  await refetchPermissions(serverId);
}

export async function ensureAuditLoaded(serverId: string): Promise<void> {
  if (auditLoaded.has(serverId)) return;
  auditLoaded.add(serverId);
  await refetchAudit(serverId);
}

// ---------------------------------------------------------------------------
// Live-update mount: subscribes to `core.permission.changed` for the active
// server and invalidates the three stores via a trailing-debounce. Mount
// once at app boot (App.tsx) — matches the cadence of mountMembershipStore.
// ---------------------------------------------------------------------------

export function mountPermissionsStores(): void {
  // Memoize on a narrow key (id|tunnel_url) so unrelated patchServer churn
  // (presence flips, name edits) doesn't tear this effect down.
  const activeKey = createMemo(() => {
    const id = activeServerId();
    const server = activeServer();
    if (!id || !server?.tunnel_url) return null;
    return `${id}|${server.tunnel_url}`;
  });

  createEffect(() => {
    const key = activeKey();
    if (!key) return;
    const id = key.slice(0, key.indexOf("|"));
    const server = untrack(activeServer);
    if (!server) return;

    let cancelled = false;
    void (async () => {
      // The membership effect already triggers connect(); calling here is
      // idempotent and protects against the rare case where this store is
      // mounted before membership.
      await connect(server);
      if (cancelled) return;
    })();

    // Each invalidation only refetches what was already loaded. Stores that
    // haven't been opened yet stay cold — we don't want to fetch the audit
    // log just because someone granted a permission elsewhere.
    const debouncer = createTrailingDebouncer<[]>(() => {
      if (cancelled) return;
      if (rolesLoaded.has(id)) void refetchRoles(id);
      if (permsLoaded.has(id)) void refetchPermissions(id);
      if (auditLoaded.has(id)) void refetchAudit(id);
    }, INVALIDATE_DEBOUNCE_MS);

    const unsub = onPluginMessage(
      id,
      "core",
      (msg) => {
        const ev = msg as { type?: string; topic?: string };
        if (ev.type === "event" && ev.topic === "core.permission.changed") {
          debouncer.fire();
        }
      },
      "permissions-store-watch",
    );

    onCleanup(() => {
      cancelled = true;
      debouncer.cancel();
      unsub();
    });
  });
}

// ---------------------------------------------------------------------------
// Hierarchy-aware helpers
// ---------------------------------------------------------------------------

/**
 * Roles the actor is allowed to assign in a dropdown. The runtime is
 * authoritative — this only hides illegal options so the user can't
 * naively trigger a HIERARCHY_VIOLATION toast.
 *
 * Filter rules (mirrors `RolesEngine.canActOn` + Amendment B Q1):
 *   - Owner role (level 100) is never assignable here. Ownership transfer
 *     happens through Central, not the runtime UI.
 *   - For non-owner actors, hide roles whose level is `>=` the actor's level.
 *     Strict-greater-than is the rule the engine enforces (engine.ts:447).
 *   - For owner actors, every non-owner role is assignable.
 *
 * `actorLevel` should be `currentMember()?.level` for non-owners. Pass
 * `Number.POSITIVE_INFINITY` (or any value > 99) for owners.
 */
export function assignableRoles<R extends { level: number }>(
  actorLevel: number,
  isActorOwner: boolean,
  allRoles: readonly R[],
): R[] {
  return allRoles.filter((r) => {
    // Owner role is special — runtime refuses to assign it via core.role.assign
    // (engine.ts:282), and Amendment B routes ownership transfers through
    // Central. Hide unconditionally so the dropdown never offers it.
    if (r.level >= 100) return false;
    if (isActorOwner) return true;
    return r.level < actorLevel;
  });
}

// ---------------------------------------------------------------------------
// Test seam — clears all in-memory state. Used by unit tests to isolate
// scenarios. Not exported from the package barrel; do not call in app code.
// ---------------------------------------------------------------------------

export function _resetPermissionsStoresForTests(): void {
  setRolesByServer({});
  setPermsByServer({});
  setAuditByServer({});
  rolesLoaded.clear();
  permsLoaded.clear();
  auditLoaded.clear();
}
