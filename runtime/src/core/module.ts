// CoreModule — runtime-owned module initialized before any plugin loads.
// Manages user profile cache, presence state, and workspace layout persistence.

import type { Database } from "bun:sqlite";
import type { Logger } from "@uncorded/shared";
import type { BrowserRecentEntry, CoreUser, CoreMember, CoreBan, CoreAuditEntry, CoreCategory, WorkspaceLayout, SavedWorkspace } from "@uncorded/protocol";
import { CORE_TOPICS } from "@uncorded/protocol";
import type { EventBus } from "../events/bus";
import { runMigrations } from "../migrations";
import * as dao from "./dao";
import { validateLayout } from "./layout";
import type { LayoutValidationResult } from "./layout";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(import.meta.dir, "migrations");

// ---------------------------------------------------------------------------
// CoreModule
// ---------------------------------------------------------------------------

export interface BanEvent {
  userId: string;
  actorId: string;
  reason: string;
}

export interface UnbanEvent {
  userId: string;
  actorId: string;
}

type BanListener = (e: BanEvent) => void;
type UnbanListener = (e: UnbanEvent) => void;

export class CoreModule {
  private readonly db: Database;
  private readonly eventBus: EventBus;
  private readonly log: Logger;
  // Synchronous in-process listeners for moderation events. Used by
  // subsystems (e.g. the voice cascade) that must react to local ban
  // mutations regardless of whether the trigger was a Central delta or
  // a local IPC call. Both paths funnel through banUser/unbanUser, so
  // one hook covers both.
  private readonly banListeners = new Set<BanListener>();
  private readonly unbanListeners = new Set<UnbanListener>();

  constructor(db: Database, eventBus: EventBus, logger: Logger) {
    this.db = db;
    this.eventBus = eventBus;
    this.log = logger.child({ component: "core" });
  }

  /** Register a synchronous ban listener. Returns a disposer. */
  onBanned(fn: BanListener): () => void {
    this.banListeners.add(fn);
    return () => this.banListeners.delete(fn);
  }

  /** Register a synchronous unban listener. Returns a disposer. */
  onUnbanned(fn: UnbanListener): () => void {
    this.unbanListeners.add(fn);
    return () => this.unbanListeners.delete(fn);
  }

  private emitBanned(e: BanEvent): void {
    for (const fn of this.banListeners) {
      try {
        fn(e);
      } catch (err) {
        this.log.error("ban listener threw", { error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  private emitUnbanned(e: UnbanEvent): void {
    for (const fn of this.unbanListeners) {
      try {
        fn(e);
      } catch (err) {
        this.log.error("unban listener threw", { error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  // -----------------------------------------------------------------------
  // Initialization (called once at boot, before plugins load)
  // -----------------------------------------------------------------------

  initialize(): void {
    const result = runMigrations(
      "core",
      this.db,
      MIGRATIONS_DIR,
      (dir) => readdirSync(dir),
      (path) => readFileSync(path, "utf-8"),
      { migrationsTable: "_core_migrations" },
    );

    if (!result.ok) {
      throw new Error(
        `Core Module migration failed: ${result.error.message}`,
      );
    }

    if (result.applied > 0) {
      this.log.info("Core Module migrations applied", { applied: result.applied });
    }

    // is_online is not persisted across restarts — reset on every boot.
    dao.resetAllOnlineFlags(this.db);
    this.log.info("Core Module initialized");
  }

  // -----------------------------------------------------------------------
  // Presence lifecycle (called by WS router)
  // -----------------------------------------------------------------------

  onUserConnected(
    userId: string,
    username: string,
    displayName: string,
    avatarUrl: string,
  ): void {
    const now = Date.now();
    dao.upsertUser(this.db, userId, username, displayName, avatarUrl);
    dao.setUserOnline(this.db, userId, now);

    // Record join history — no-op if already a member.
    const isNewMember = dao.recordMember(this.db, userId, now);

    this.eventBus.publishRuntime(CORE_TOPICS.USER_ONLINE, {
      id: userId,
      username,
      display_name: displayName,
      avatar_url: avatarUrl,
      is_online: true,
      connected_at: now,
      last_seen_at: now,
    });

    if (isNewMember) {
      this.eventBus.publishRuntime(CORE_TOPICS.MEMBER_JOINED, {
        id: userId,
        username,
        display_name: displayName,
        avatar_url: avatarUrl,
        joined_at: now,
      });
    }

    this.log.info("User connected", { userId, isNewMember });
  }

  onUserDisconnected(userId: string): void {
    const now = Date.now();
    dao.setUserOffline(this.db, userId, now);

    this.eventBus.publishRuntime(CORE_TOPICS.USER_OFFLINE, {
      id: userId,
      is_online: false,
      last_seen_at: now,
    });

    this.log.info("User disconnected", { userId });
  }

  onUserProfileChanged(
    userId: string,
    username: string,
    displayName: string,
    avatarUrl: string,
  ): void {
    dao.updateUserProfile(this.db, userId, username, displayName, avatarUrl);

    this.eventBus.publishRuntime(CORE_TOPICS.USER_UPDATED, {
      id: userId,
      username,
      display_name: displayName,
      avatar_url: avatarUrl,
    });
  }

  onUserDeleted(userId: string): void {
    const now = Date.now();
    dao.markUserDeleted(this.db, userId, now);

    this.eventBus.publishRuntime(CORE_TOPICS.USER_DELETED, { id: userId });
  }

  // -----------------------------------------------------------------------
  // Ban check (called during WS auth — synchronous, fast path)
  // -----------------------------------------------------------------------

  isBanned(userId: string): boolean {
    return dao.getBan(this.db, userId) !== null;
  }

  // -----------------------------------------------------------------------
  // Members (called by IPC handler)
  // -----------------------------------------------------------------------

  listMembers(opts: { limit: number; offset: number }): { members: CoreMember[]; total: number } {
    return {
      members: dao.listMembers(this.db, opts),
      total: dao.countMembers(this.db),
    };
  }

  // -----------------------------------------------------------------------
  // Moderation (called by IPC handler — role checks done by caller)
  // -----------------------------------------------------------------------

  banUser(actorId: string, targetId: string, reason: string): void {
    const now = Date.now();
    dao.insertBan(this.db, targetId, actorId, reason, now);
    dao.insertAuditEntry(this.db, crypto.randomUUID(), "ban", actorId, targetId, { reason }, now);

    this.eventBus.publishRuntime(CORE_TOPICS.MOD_BANNED, {
      user_id: targetId,
      banned_by: actorId,
      reason,
    });
    this.emitBanned({ userId: targetId, actorId, reason });

    this.log.info("User banned", { actorId, targetId, reason });
  }

  unbanUser(actorId: string, targetId: string): boolean {
    const existed = dao.deleteBan(this.db, targetId);
    if (existed) {
      const now = Date.now();
      dao.insertAuditEntry(this.db, crypto.randomUUID(), "unban", actorId, targetId, {}, now);
      this.eventBus.publishRuntime(CORE_TOPICS.MOD_UNBANNED, { user_id: targetId, actor_id: actorId });
      this.emitUnbanned({ userId: targetId, actorId });
      this.log.info("User unbanned", { actorId, targetId });
    }
    return existed;
  }

  listBans(): CoreBan[] {
    return dao.listBans(this.db);
  }

  listAuditLog(limit = 100, offset = 0): CoreAuditEntry[] {
    return dao.listAuditLog(this.db, limit, offset);
  }

  // -----------------------------------------------------------------------
  // User reads (called by IPC handler — hot path, synchronous)
  // -----------------------------------------------------------------------

  getUser(userId: string): CoreUser | null {
    return dao.getUser(this.db, userId);
  }

  getUsers(userIds: string[]): CoreUser[] {
    return dao.getUsers(this.db, userIds);
  }

  getOnlineUsers(): CoreUser[] {
    return dao.getOnlineUsers(this.db);
  }

  // -----------------------------------------------------------------------
  // Workspace layout
  // -----------------------------------------------------------------------

  getUserLayout(userId: string): WorkspaceLayout {
    return dao.getUserLayout(this.db, userId);
  }

  setUserLayout(userId: string, layout: WorkspaceLayout): void {
    dao.setUserLayout(this.db, userId, layout, Date.now());
  }

  getDefaultLayout(): WorkspaceLayout {
    return dao.getDefaultLayout(this.db);
  }

  setDefaultLayout(layout: WorkspaceLayout, updatedBy: string): void {
    dao.setDefaultLayout(this.db, layout, updatedBy, Date.now());
  }

  validateLayout(layout: unknown): LayoutValidationResult {
    return validateLayout(layout);
  }

  // -----------------------------------------------------------------------
  // Saved workspaces (multi-layout bookmarks, per user)
  // -----------------------------------------------------------------------

  getUserLayouts(userId: string): SavedWorkspace[] {
    return dao.listSavedWorkspaces(this.db, userId);
  }

  createUserLayout(
    userId: string,
    name: string | null,
    layout: WorkspaceLayout,
  ): SavedWorkspace | { error: "CAP_REACHED" } {
    return dao.createSavedWorkspace(
      this.db,
      crypto.randomUUID(),
      userId,
      name,
      layout,
      Date.now(),
    );
  }

  updateUserLayout(
    userId: string,
    id: string,
    patch: { name?: string | null; layout?: WorkspaceLayout },
  ): boolean {
    return dao.updateSavedWorkspace(this.db, id, userId, patch, Date.now());
  }

  deleteUserLayout(userId: string, id: string): boolean {
    return dao.deleteSavedWorkspace(this.db, id, userId);
  }

  // -----------------------------------------------------------------------
  // Browser recent (per-user, single global list)
  // -----------------------------------------------------------------------

  getBrowserRecent(userId: string): BrowserRecentEntry[] {
    return dao.getBrowserRecent(this.db, userId);
  }

  setBrowserRecent(userId: string, recent: BrowserRecentEntry[]): void {
    dao.setBrowserRecent(this.db, userId, recent, Date.now());
  }

  // -----------------------------------------------------------------------
  // Categories (server-wide grouping; used by text-channels, voice-channels)
  // -----------------------------------------------------------------------

  listCategories(): CoreCategory[] {
    return dao.listCategories(this.db);
  }

  getCategory(id: string): CoreCategory | null {
    return dao.getCategory(this.db, id);
  }

  createCategory(actorId: string, name: string): CoreCategory {
    const now = Date.now();
    const id = crypto.randomUUID();
    const category = dao.createCategory(this.db, id, name, now);
    dao.insertAuditEntry(
      this.db,
      crypto.randomUUID(),
      "category.create",
      actorId,
      id,
      { name },
      now,
    );
    this.eventBus.publishRuntime(CORE_TOPICS.CATEGORY_CREATED, { category });
    this.log.info("Category created", { actorId, id, name });
    return category;
  }

  updateCategory(
    actorId: string,
    id: string,
    name: string,
  ): CoreCategory | null {
    const now = Date.now();
    const category = dao.updateCategory(this.db, id, name, now);
    if (!category) return null;
    dao.insertAuditEntry(
      this.db,
      crypto.randomUUID(),
      "category.update",
      actorId,
      id,
      { name },
      now,
    );
    this.eventBus.publishRuntime(CORE_TOPICS.CATEGORY_UPDATED, { category });
    return category;
  }

  deleteCategory(actorId: string, id: string): boolean {
    const now = Date.now();
    const existed = dao.deleteCategory(this.db, id);
    if (!existed) return false;
    dao.insertAuditEntry(
      this.db,
      crypto.randomUUID(),
      "category.delete",
      actorId,
      id,
      {},
      now,
    );
    this.eventBus.publishRuntime(CORE_TOPICS.CATEGORY_DELETED, { id });
    this.log.info("Category deleted", { actorId, id });
    return true;
  }

  reorderCategories(actorId: string, orderedIds: string[]): CoreCategory[] | null {
    const now = Date.now();
    const categories = dao.reorderCategories(this.db, orderedIds, now);
    if (!categories) return null;
    dao.insertAuditEntry(
      this.db,
      crypto.randomUUID(),
      "category.reorder",
      actorId,
      null,
      { order: orderedIds },
      now,
    );
    this.eventBus.publishRuntime(CORE_TOPICS.CATEGORY_REORDERED, { categories });
    return categories;
  }
}
