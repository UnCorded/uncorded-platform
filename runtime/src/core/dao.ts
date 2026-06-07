// Core Module DAO — synchronous SQLite reads and writes.
// All functions operate directly on core.db; no async, no subprocess hop.

import type { Database } from "bun:sqlite";
import type { BrowserRecentEntry, CoreUser, CoreMember, CoreBan, CoreAuditEntry, CoreCategory, WorkspaceLayout, SavedWorkspace } from "@uncorded/protocol";
import type { BrowserRecentRow, CategoryRow, UserRow, MemberRow, BanRow, AuditLogRow, WorkspaceLayoutRow, ServerDefaultLayoutRow, SavedWorkspaceRow } from "./types";
import { rootLogger } from "@uncorded/shared";

const log = rootLogger.child({ component: "core.dao" });

// ---------------------------------------------------------------------------
// Platform default layout (single leaf panel, no content loaded)
// ---------------------------------------------------------------------------

export const DEFAULT_WORKSPACE_LAYOUT: WorkspaceLayout = {
  version: 1,
  root: { type: "leaf", id: "default" },
  panels: {},
};

// ---------------------------------------------------------------------------
// Row → domain type converters
// ---------------------------------------------------------------------------

function toUser(row: UserRow): CoreUser {
  return {
    id: row.id,
    username: row.username,
    display_name: row.display_name,
    avatar_url: row.avatar_url,
    is_online: row.is_online === 1,
    last_seen_at: row.last_seen_at,
    connected_at: row.connected_at,
  };
}

// ---------------------------------------------------------------------------
// User DAO
// ---------------------------------------------------------------------------

export function upsertUser(
  db: Database,
  userId: string,
  username: string,
  displayName: string,
  avatarUrl: string,
): void {
  db.run(
    `INSERT INTO users (id, username, display_name, avatar_url, is_online, last_seen_at, connected_at)
     VALUES (?, ?, ?, ?, 0, 0, 0)
     ON CONFLICT (id) DO UPDATE SET
       username     = excluded.username,
       display_name = excluded.display_name,
       avatar_url   = excluded.avatar_url`,
    [userId, username, displayName, avatarUrl],
  );
}

export function setUserOnline(db: Database, userId: string, now: number): void {
  db.run(
    "UPDATE users SET is_online = 1, connected_at = ?, last_seen_at = ? WHERE id = ?",
    [now, now, userId],
  );
}

export function setUserOffline(db: Database, userId: string, now: number): void {
  db.run(
    "UPDATE users SET is_online = 0, last_seen_at = ? WHERE id = ?",
    [now, userId],
  );
}

export function updateUserProfile(
  db: Database,
  userId: string,
  username: string,
  displayName: string,
  avatarUrl: string,
): void {
  db.run(
    "UPDATE users SET username = ?, display_name = ?, avatar_url = ? WHERE id = ?",
    [username, displayName, avatarUrl, userId],
  );
}

export function markUserDeleted(db: Database, userId: string, now: number): void {
  db.run(
    "UPDATE users SET is_online = 0, last_seen_at = ?, display_name = '[deleted]', avatar_url = '', username = '' WHERE id = ?",
    [now, userId],
  );
}

/** Reset all is_online flags. Called once at startup — is_online is not persisted across restarts. */
export function resetAllOnlineFlags(db: Database): void {
  db.run("UPDATE users SET is_online = 0");
}

export function getUser(db: Database, userId: string): CoreUser | null {
  const row = db
    .query<UserRow, [string]>("SELECT * FROM users WHERE id = ?")
    .get(userId);
  return row ? toUser(row) : null;
}

export function getUsers(db: Database, userIds: string[]): CoreUser[] {
  if (userIds.length === 0) return [];

  // SQLite IN clause — chunk to stay within parameter limits.
  const CHUNK = 100;
  const results: CoreUser[] = [];
  for (let i = 0; i < userIds.length; i += CHUNK) {
    const chunk = userIds.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = db
      .query<UserRow, string[]>(`SELECT * FROM users WHERE id IN (${placeholders})`)
      .all(...chunk);
    for (const row of rows) results.push(toUser(row));
  }
  return results;
}

export function getOnlineUsers(db: Database): CoreUser[] {
  return db
    .query<UserRow, []>("SELECT * FROM users WHERE is_online = 1")
    .all()
    .map(toUser);
}

// ---------------------------------------------------------------------------
// Members DAO
// ---------------------------------------------------------------------------

/** Insert a member record for the first time. No-op if the user already has a row. */
export function recordMember(db: Database, userId: string, joinedAt: number): boolean {
  const result = db.run(
    "INSERT OR IGNORE INTO members (id, joined_at) VALUES (?, ?)",
    [userId, joinedAt],
  );
  return result.changes > 0;
}

export interface ListMembersOptions {
  /** Max rows to return. Caller is responsible for clamping. */
  limit: number;
  /** Zero-based row offset. Caller is responsible for clamping >= 0. */
  offset: number;
}

/**
 * Return a page of members joined with their profile from the users table.
 * Ordering is `joined_at DESC` so the newest members surface first; offset
 * paging is stable as long as joined_at values do not collide. Per spec-22
 * Amendment B the IPC layer clamps the page size — this function trusts
 * the caller's bounds.
 */
export function listMembers(db: Database, opts: ListMembersOptions): CoreMember[] {
  const rows = db
    .query<MemberRow & UserRow, [number, number]>(
      `SELECT m.id, m.joined_at,
              u.display_name, u.avatar_url, u.is_online, u.last_seen_at, u.connected_at
       FROM members m
       LEFT JOIN users u ON u.id = m.id
       ORDER BY m.joined_at DESC
       LIMIT ? OFFSET ?`,
    )
    .all(opts.limit, opts.offset);

  return rows.map((r) => ({
    id: r.id,
    username: r.username ?? "",
    display_name: r.display_name ?? r.id.slice(0, 8),
    avatar_url: r.avatar_url ?? "",
    is_online: r.is_online === 1,
    last_seen_at: r.last_seen_at ?? 0,
    connected_at: r.connected_at ?? 0,
    joined_at: r.joined_at,
    // role_id is enriched by the IPC handler from `RolesEngine`; the DAO
    // doesn't reach across to the roles tables on its own.
    role_id: null,
  }));
}

/** Total member count, used to compute the cursor terminator. */
export function countMembers(db: Database): number {
  const row = db
    .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM members")
    .get();
  return row?.n ?? 0;
}

// ---------------------------------------------------------------------------
// Bans DAO
// ---------------------------------------------------------------------------

export function getBan(db: Database, userId: string): CoreBan | null {
  const row = db
    .query<BanRow, [string]>("SELECT * FROM bans WHERE user_id = ?")
    .get(userId);
  return row ? { ...row } : null;
}

export function insertBan(
  db: Database,
  userId: string,
  bannedBy: string,
  reason: string,
  now: number,
): void {
  db.run(
    "INSERT OR REPLACE INTO bans (user_id, banned_by, banned_at, reason) VALUES (?, ?, ?, ?)",
    [userId, bannedBy, now, reason],
  );
}

export function deleteBan(db: Database, userId: string): boolean {
  const result = db.run("DELETE FROM bans WHERE user_id = ?", [userId]);
  return result.changes > 0;
}

export function listBans(db: Database): CoreBan[] {
  return db
    .query<BanRow, []>("SELECT * FROM bans ORDER BY banned_at DESC")
    .all()
    .map((r) => ({ ...r }));
}

// ---------------------------------------------------------------------------
// Audit log DAO
// ---------------------------------------------------------------------------

export function insertAuditEntry(
  db: Database,
  id: string,
  action: string,
  actorId: string,
  targetId: string | null,
  details: Record<string, unknown>,
  now: number,
): void {
  db.run(
    "INSERT INTO audit_log (id, action, actor_id, target_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    [id, action, actorId, targetId ?? null, JSON.stringify(details), now],
  );
}

export function listAuditLog(
  db: Database,
  limit: number,
  offset: number,
): CoreAuditEntry[] {
  return db
    .query<AuditLogRow, [number, number]>(
      "SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ? OFFSET ?",
    )
    .all(limit, offset)
    .map((r) => ({ ...r }));
}

// ---------------------------------------------------------------------------
// Workspace layout DAO
// ---------------------------------------------------------------------------

function parseLayout(json: string): WorkspaceLayout {
  try {
    return JSON.parse(json) as WorkspaceLayout;
  } catch {
    log.warn("corrupt layout JSON in database — falling back to default", {
      preview: json.slice(0, 120),
    });
    return DEFAULT_WORKSPACE_LAYOUT;
  }
}

export function getUserLayout(db: Database, userId: string): WorkspaceLayout {
  const row = db
    .query<WorkspaceLayoutRow, [string]>(
      "SELECT * FROM workspace_layouts WHERE user_id = ?",
    )
    .get(userId);

  if (row) return parseLayout(row.layout_json);

  // Fall back to server default, then platform default.
  return getDefaultLayout(db);
}

export function setUserLayout(
  db: Database,
  userId: string,
  layout: WorkspaceLayout,
  now: number,
): void {
  db.run(
    `INSERT INTO workspace_layouts (user_id, layout_json, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET layout_json = excluded.layout_json, updated_at = excluded.updated_at`,
    [userId, JSON.stringify(layout), now],
  );
}

export function getDefaultLayout(db: Database): WorkspaceLayout {
  const row = db
    .query<ServerDefaultLayoutRow, []>("SELECT * FROM server_default_layout WHERE id = 1")
    .get();
  return row ? parseLayout(row.layout_json) : DEFAULT_WORKSPACE_LAYOUT;
}

export function setDefaultLayout(
  db: Database,
  layout: WorkspaceLayout,
  updatedBy: string,
  now: number,
): void {
  db.run(
    `INSERT INTO server_default_layout (id, layout_json, updated_at, updated_by)
     VALUES (1, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       layout_json = excluded.layout_json,
       updated_at  = excluded.updated_at,
       updated_by  = excluded.updated_by`,
    [JSON.stringify(layout), now, updatedBy],
  );
}

// ---------------------------------------------------------------------------
// Saved workspaces DAO
// ---------------------------------------------------------------------------

const MAX_SAVED_WORKSPACES = 5;

function toSavedWorkspace(row: SavedWorkspaceRow): SavedWorkspace {
  return {
    id: row.id,
    name: row.name,
    layout: parseLayout(row.layout_json),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function countSavedWorkspaces(db: Database, userId: string): number {
  const row = db
    .query<{ count: number }, [string]>(
      "SELECT COUNT(*) as count FROM saved_workspaces WHERE user_id = ?",
    )
    .get(userId);
  return row?.count ?? 0;
}

export function listSavedWorkspaces(db: Database, userId: string): SavedWorkspace[] {
  return db
    .query<SavedWorkspaceRow, [string]>(
      "SELECT * FROM saved_workspaces WHERE user_id = ? ORDER BY created_at ASC",
    )
    .all(userId)
    .map(toSavedWorkspace);
}

export function getSavedWorkspace(
  db: Database,
  id: string,
  userId: string,
): SavedWorkspace | null {
  const row = db
    .query<SavedWorkspaceRow, [string, string]>(
      "SELECT * FROM saved_workspaces WHERE id = ? AND user_id = ?",
    )
    .get(id, userId);
  return row ? toSavedWorkspace(row) : null;
}

export function createSavedWorkspace(
  db: Database,
  id: string,
  userId: string,
  name: string | null,
  layout: WorkspaceLayout,
  now: number,
): SavedWorkspace | { error: "CAP_REACHED" } {
  const count = countSavedWorkspaces(db, userId);
  if (count >= MAX_SAVED_WORKSPACES) return { error: "CAP_REACHED" };

  db.run(
    `INSERT INTO saved_workspaces (id, user_id, name, layout_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, userId, name ?? null, JSON.stringify(layout), now, now],
  );

  return { id, name, layout, created_at: now, updated_at: now };
}

export function updateSavedWorkspace(
  db: Database,
  id: string,
  userId: string,
  patch: { name?: string | null; layout?: WorkspaceLayout },
  now: number,
): boolean {
  const existing = getSavedWorkspace(db, id, userId);
  if (!existing) return false;

  const newName = "name" in patch ? patch.name ?? null : existing.name;
  const newLayout = patch.layout ?? existing.layout;

  db.run(
    `UPDATE saved_workspaces SET name = ?, layout_json = ?, updated_at = ?
     WHERE id = ? AND user_id = ?`,
    [newName, JSON.stringify(newLayout), now, id, userId],
  );
  return true;
}

export function deleteSavedWorkspace(
  db: Database,
  id: string,
  userId: string,
): boolean {
  const result = db.run(
    "DELETE FROM saved_workspaces WHERE id = ? AND user_id = ?",
    [id, userId],
  );
  return result.changes > 0;
}

// ---------------------------------------------------------------------------
// Browser recent (per-user, single global list)
// ---------------------------------------------------------------------------

export const MAX_GLOBAL_BROWSER_RECENT = 20;

function parseBrowserRecent(json: string): BrowserRecentEntry[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as BrowserRecentEntry[]) : [];
  } catch {
    log.warn("corrupt browser_recent JSON in database — falling back to []", {
      preview: json.slice(0, 120),
    });
    return [];
  }
}

export function getBrowserRecent(db: Database, userId: string): BrowserRecentEntry[] {
  const row = db
    .query<BrowserRecentRow, [string]>(
      "SELECT * FROM browser_recent WHERE user_id = ?",
    )
    .get(userId);
  return row ? parseBrowserRecent(row.recent_json) : [];
}

export function setBrowserRecent(
  db: Database,
  userId: string,
  recent: BrowserRecentEntry[],
  now: number,
): void {
  // Clamp at the global cap as a defense-in-depth check; the HTTP handler
  // also rejects oversize lists at the validator stage.
  const capped = recent.slice(0, MAX_GLOBAL_BROWSER_RECENT);
  db.run(
    `INSERT INTO browser_recent (user_id, recent_json, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET recent_json = excluded.recent_json, updated_at = excluded.updated_at`,
    [userId, JSON.stringify(capped), now],
  );
}

// ---------------------------------------------------------------------------
// Categories DAO — server-wide grouping owned by Core. Plugins reference
// categories via a soft FK (nullable category_id column in their own tables).
// ---------------------------------------------------------------------------

export const CATEGORY_NAME_MAX = 64;

function toCategory(row: CategoryRow): CoreCategory {
  return {
    id: row.id,
    name: row.name,
    position: row.position,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function listCategories(db: Database): CoreCategory[] {
  return db
    .query<CategoryRow, []>(
      "SELECT * FROM categories ORDER BY position ASC, created_at ASC",
    )
    .all()
    .map(toCategory);
}

export function getCategory(db: Database, id: string): CoreCategory | null {
  const row = db
    .query<CategoryRow, [string]>("SELECT * FROM categories WHERE id = ?")
    .get(id);
  return row ? toCategory(row) : null;
}

export function createCategory(
  db: Database,
  id: string,
  name: string,
  now: number,
): CoreCategory {
  const max = db
    .query<{ max: number | null }, []>(
      "SELECT MAX(position) as max FROM categories",
    )
    .get();
  const position = (max?.max ?? -1) + 1;

  db.run(
    `INSERT INTO categories (id, name, position, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
    [id, name, position, now, now],
  );
  return { id, name, position, created_at: now, updated_at: now };
}

export function updateCategory(
  db: Database,
  id: string,
  name: string,
  now: number,
): CoreCategory | null {
  const result = db.run(
    "UPDATE categories SET name = ?, updated_at = ? WHERE id = ?",
    [name, now, id],
  );
  if (result.changes === 0) return null;
  return getCategory(db, id);
}

export function deleteCategory(db: Database, id: string): boolean {
  const result = db.run("DELETE FROM categories WHERE id = ?", [id]);
  return result.changes > 0;
}

/**
 * Reorder categories. `orderedIds` must contain every existing category id
 * exactly once. Returns the new ordering or null if the set doesn't match.
 */
export function reorderCategories(
  db: Database,
  orderedIds: string[],
  now: number,
): CoreCategory[] | null {
  const existing = listCategories(db);
  if (existing.length !== orderedIds.length) return null;
  const existingIds = new Set(existing.map((c) => c.id));
  for (const id of orderedIds) {
    if (!existingIds.has(id)) return null;
  }
  if (new Set(orderedIds).size !== orderedIds.length) return null;

  const stmt = db.prepare(
    "UPDATE categories SET position = ?, updated_at = ? WHERE id = ?",
  );
  const txn = db.transaction((ids: string[]) => {
    for (let i = 0; i < ids.length; i++) {
      stmt.run(i, now, ids[i]!);
    }
  });
  txn(orderedIds);

  return listCategories(db);
}
