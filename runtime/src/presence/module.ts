// ScopedPresenceModule — runtime-side orchestrator for spec-23 scoped presence.
//
// Composes:
//   - ScopeRegistry            (in-memory triple-indexed store)
//   - RateLimiter (RATE_PRESENCE)  (per-(user, scope) input ceiling)
//   - EventBus (publishRuntime)    (runtime.presence.{joined,updated,left})
//
// Public surface:
//   registerSession(sessionId)    — gate join() against active sessions
//   evictSession(sessionId)       — WS-close handler
//   evictPlugin(slug)             — plugin-unload handler
//   join / leave / update / list  — IPC dispatch entry points

import type { Logger } from "@uncorded/shared";
import type { PresenceEntry } from "@uncorded/protocol";
import { RUNTIME_PRESENCE_TOPICS } from "@uncorded/protocol";

import type { EventBus } from "../events/bus";
import type { RateLimiter } from "../http/rate-limiter";
import { RATE_PRESENCE } from "../http/rate-limiter";

import { ScopeRegistry } from "./registry";
import { validateScope, crossPluginCheck, prefixScope } from "./scope";
import {
  PRESENCE_ERROR_CODES,
  PRESENCE_LIMITS,
  type PresenceError,
  type PresenceResult,
  type PresenceEntryInternal,
} from "./types";

/** Snapshot of installed plugin slugs — kept loose so wiring can pass a thunk. */
export type InstalledSlugsProvider = () => ReadonlySet<string>;

export interface ScopedPresenceOptions {
  /** Provider for the live set of installed plugin slugs (for cross-plugin scope check). */
  installedSlugs: InstalledSlugsProvider;
  /** Defaults to Date.now — injectable for deterministic tests. */
  now?: () => number;
}

export interface JoinSuccess {
  scope: string;
  joined_at: number;
}

export class ScopedPresenceModule {
  private readonly registry = new ScopeRegistry();
  private readonly activeSessions = new Set<string>();

  /**
   * Scopes that have already crossed the soft entry cap and emitted a warning.
   * Cleared per scope when the count drops back below the threshold so that a
   * later re-cross emits a fresh warning. Per-scope, not per-process — a noisy
   * scope shouldn't suppress warnings for unrelated scopes.
   */
  private readonly oversizeWarnedScopes = new Set<string>();

  private readonly eventBus: EventBus;
  private readonly rateLimiter: RateLimiter;
  private readonly log: Logger;
  private readonly installedSlugs: InstalledSlugsProvider;
  private readonly now: () => number;

  constructor(
    eventBus: EventBus,
    rateLimiter: RateLimiter,
    logger: Logger,
    options: ScopedPresenceOptions,
  ) {
    this.eventBus = eventBus;
    this.rateLimiter = rateLimiter;
    this.log = logger.child({ component: "presence" });
    this.installedSlugs = options.installedSlugs;
    this.now = options.now ?? Date.now;
  }

  // -------------------------------------------------------------------------
  // Session lifecycle (called from MessageRouter on connection register/remove)
  // -------------------------------------------------------------------------

  registerSession(sessionId: string): void {
    this.activeSessions.add(sessionId);
  }

  /**
   * Synchronously remove the session from activeSessions FIRST (closes the
   * race against any in-flight join IPC), then evict its entries and emit
   * runtime.presence.left for each. Idempotent.
   */
  evictSession(sessionId: string): void {
    const wasActive = this.activeSessions.delete(sessionId);

    const scopes = this.registry.scopesForSession(sessionId);
    if (scopes.length === 0) {
      // Nothing to evict; the session may never have joined any scope.
      return;
    }

    const ts = this.now();
    for (const scope of scopes) {
      const entry = this.registry.remove(scope, sessionId);
      if (!entry) continue;
      this.maybeClearOversizeWarning(scope);
      this.eventBus.publishRuntime(RUNTIME_PRESENCE_TOPICS.LEFT, {
        scope: entry.scope,
        user_id: entry.user_id,
        session_id: entry.session_id,
        reason: "session_closed",
        ts,
      });
    }

    if (wasActive) {
      this.log.info("scoped presence: session evicted", {
        sessionId,
        scopesCleared: scopes.length,
      });
    }
  }

  /**
   * Evict every entry under any scope owned by the unloading plugin. Active
   * sessions remain active — only their entries owned by THIS plugin are
   * cleared. Idempotent.
   */
  evictPlugin(slug: string): void {
    const scopes = this.registry.scopesForPlugin(slug);
    if (scopes.length === 0) return;

    const ts = this.now();
    let cleared = 0;
    for (const scope of scopes) {
      const entries = this.registry.list(scope);
      for (const entry of entries) {
        this.registry.remove(scope, entry.session_id);
        cleared++;
        this.eventBus.publishRuntime(RUNTIME_PRESENCE_TOPICS.LEFT, {
          scope: entry.scope,
          user_id: entry.user_id,
          session_id: entry.session_id,
          reason: "plugin_unloaded",
          ts,
        });
      }
      this.oversizeWarnedScopes.delete(scope);
    }

    this.log.info("scoped presence: plugin evicted", {
      plugin: slug,
      scopesCleared: scopes.length,
      entriesCleared: cleared,
    });
  }

  /** Used by tests and observability. */
  isSessionActive(sessionId: string): boolean {
    return this.activeSessions.has(sessionId);
  }

  /** Used by tests and observability. */
  getRegistry(): ScopeRegistry {
    return this.registry;
  }

  // -------------------------------------------------------------------------
  // Mutations (called from IPC dispatch)
  // -------------------------------------------------------------------------

  join(
    callerSlug: string,
    unprefixedScope: string,
    userId: string,
    sessionId: string,
    meta: Record<string, unknown> | undefined,
  ): PresenceResult<JoinSuccess> {
    const validated = this.validate(callerSlug, unprefixedScope, sessionId);
    if (!validated.ok) return validated;
    const fqScope = validated.value;

    const rate = this.consumeRate(callerSlug, userId, fqScope);
    if (!rate.ok) return rate;

    const m = meta ?? {};
    const metaCheck = enforceMetaSize(m);
    if (!metaCheck.ok) return metaCheck;

    const ts = this.now();
    const previous = this.registry.get(fqScope, sessionId);
    const entry: PresenceEntryInternal = {
      scope: fqScope,
      user_id: userId,
      session_id: sessionId,
      meta: m,
      joined_at: previous ? previous.joined_at : ts,
      updated_at: ts,
      plugin_slug: callerSlug,
    };
    this.registry.insert(entry);
    this.maybeWarnSoftCap(fqScope);

    // Re-join with same (scope, session, user) is idempotent per spec — meta
    // and updated_at refresh, no second entry. We still emit JOINED for the
    // first insert, and UPDATED for refresh so watchers see it.
    if (previous === undefined) {
      this.eventBus.publishRuntime(RUNTIME_PRESENCE_TOPICS.JOINED, {
        scope: entry.scope,
        user_id: entry.user_id,
        session_id: entry.session_id,
        meta: entry.meta,
        ts,
      });
    } else {
      this.eventBus.publishRuntime(RUNTIME_PRESENCE_TOPICS.UPDATED, {
        scope: entry.scope,
        user_id: entry.user_id,
        session_id: entry.session_id,
        meta: entry.meta,
        ts,
      });
    }

    return { ok: true, value: { scope: fqScope, joined_at: entry.joined_at } };
  }

  /**
   * Per spec: "update does not implicitly join." When no entry exists for
   * (scope, session_id) the call is a silent no-op — but rate-limiting and
   * scope validation still happen so a misbehaving caller cannot bypass the
   * input ceiling by spamming updates against vanished entries.
   */
  update(
    callerSlug: string,
    unprefixedScope: string,
    userId: string,
    sessionId: string,
    meta: Record<string, unknown>,
  ): PresenceResult<true> {
    const validated = this.validate(callerSlug, unprefixedScope, sessionId);
    if (!validated.ok) return validated;
    const fqScope = validated.value;

    const rate = this.consumeRate(callerSlug, userId, fqScope);
    if (!rate.ok) return rate;

    const metaCheck = enforceMetaSize(meta);
    if (!metaCheck.ok) return metaCheck;

    const existing = this.registry.get(fqScope, sessionId);
    if (!existing || existing.user_id !== userId) {
      // No matching entry — silent no-op per spec. We do NOT error.
      return { ok: true, value: true };
    }

    const ts = this.now();
    const entry: PresenceEntryInternal = {
      ...existing,
      meta,
      updated_at: ts,
    };
    this.registry.insert(entry);

    // Always emit UPDATED, even when meta is byte-identical — watchers can
    // use updated_at as a heartbeat (per user clarification on the spec gap).
    this.eventBus.publishRuntime(RUNTIME_PRESENCE_TOPICS.UPDATED, {
      scope: entry.scope,
      user_id: entry.user_id,
      session_id: entry.session_id,
      meta: entry.meta,
      ts,
    });

    return { ok: true, value: true };
  }

  /**
   * Remove the (scope, session_id) entry if its user_id matches. No-op when
   * there is no matching entry. Per spec leave-semantics decision: the
   * triple keying is unique so "all entries for (scope, userId) owned by the
   * calling session" reduces to at most one entry.
   */
  leave(
    callerSlug: string,
    unprefixedScope: string,
    userId: string,
    sessionId: string,
  ): PresenceResult<true> {
    const validated = this.validate(callerSlug, unprefixedScope, sessionId);
    if (!validated.ok) return validated;
    const fqScope = validated.value;

    const rate = this.consumeRate(callerSlug, userId, fqScope);
    if (!rate.ok) return rate;

    const existing = this.registry.get(fqScope, sessionId);
    if (!existing || existing.user_id !== userId) {
      return { ok: true, value: true };
    }

    this.registry.remove(fqScope, sessionId);
    this.maybeClearOversizeWarning(fqScope);

    this.eventBus.publishRuntime(RUNTIME_PRESENCE_TOPICS.LEFT, {
      scope: existing.scope,
      user_id: existing.user_id,
      session_id: existing.session_id,
      reason: "explicit",
      ts: this.now(),
    });

    return { ok: true, value: true };
  }

  /**
   * One-shot read of a scope's entries. The caller's slug is required to
   * compute the full prefix — but spec-23 explicitly forbids cross-plugin
   * reads, so the runtime never exposes another plugin's scopes here.
   */
  list(callerSlug: string, unprefixedScope: string): PresenceResult<PresenceEntry[]> {
    const validated = this.validateScopeOnly(callerSlug, unprefixedScope);
    if (!validated.ok) return validated;
    return { ok: true, value: this.registry.list(validated.value) };
  }

  // -------------------------------------------------------------------------
  // Internal: validation pipeline
  // -------------------------------------------------------------------------

  /**
   * Validation pipeline shared by join/leave/update. Order matters:
   *   1. session_id exists in activeSessions → else SESSION_GONE
   *   2. scope grammar → else SCOPE_INVALID
   *   3. cross-plugin check → else CROSS_PLUGIN_SCOPE
   *   4. prefix + length cap → else SCOPE_LENGTH
   *
   * Returns the fully-qualified scope on success.
   */
  private validate(
    callerSlug: string,
    unprefixedScope: string,
    sessionId: string,
  ): PresenceResult<string> {
    if (!this.activeSessions.has(sessionId)) {
      return {
        ok: false,
        error: {
          code: PRESENCE_ERROR_CODES.SESSION_GONE,
          message: `WS session "${sessionId}" is not active. The session may have closed before the call arrived.`,
        },
      };
    }
    return this.validateScopeOnly(callerSlug, unprefixedScope);
  }

  /** Used by `list` (which has no session context to verify). */
  private validateScopeOnly(
    callerSlug: string,
    unprefixedScope: string,
  ): PresenceResult<string> {
    const grammar = validateScope(unprefixedScope);
    if (!grammar.ok) return grammar;

    const cross = crossPluginCheck(callerSlug, unprefixedScope, this.installedSlugs());
    if (!cross.ok) return cross;

    return prefixScope(callerSlug, unprefixedScope);
  }

  private consumeRate(
    callerSlug: string,
    userId: string,
    fqScope: string,
  ): PresenceResult<true> {
    const result = this.rateLimiter.consume(
      `presence:${callerSlug}:${userId}:${fqScope}`,
      RATE_PRESENCE,
    );
    if (!result.allowed) {
      return {
        ok: false,
        error: {
          code: PRESENCE_ERROR_CODES.RATE_EXCEEDED,
          message: `presence input rate exceeded for (user "${userId}", scope "${fqScope}"). Cap: ${String(PRESENCE_LIMITS.INPUT_RATE_PER_SEC)}/sec combined join+update+leave.`,
          retry_after_ms: result.retryAfterMs,
        },
      };
    }
    return { ok: true, value: true };
  }

  private maybeWarnSoftCap(scope: string): void {
    if (this.oversizeWarnedScopes.has(scope)) return;
    if (this.registry.scopeSize(scope) <= PRESENCE_LIMITS.SOFT_ENTRIES_PER_SCOPE) return;
    this.oversizeWarnedScopes.add(scope);
    this.log.warn("scoped presence: scope crossed soft entry cap", {
      scope,
      size: this.registry.scopeSize(scope),
      softCap: PRESENCE_LIMITS.SOFT_ENTRIES_PER_SCOPE,
    });
  }

  private maybeClearOversizeWarning(scope: string): void {
    if (!this.oversizeWarnedScopes.has(scope)) return;
    if (this.registry.scopeSize(scope) > PRESENCE_LIMITS.SOFT_ENTRIES_PER_SCOPE) return;
    this.oversizeWarnedScopes.delete(scope);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function enforceMetaSize(meta: Record<string, unknown>): PresenceResult<true> {
  let serialized: string;
  try {
    serialized = JSON.stringify(meta);
  } catch (err: unknown) {
    return {
      ok: false,
      error: {
        code: PRESENCE_ERROR_CODES.META_TOO_LARGE,
        message: `meta is not JSON-serializable: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }
  // Buffer.byteLength would be cheaper but pulls a Node import; for a 1 KB
  // cap the simple TextEncoder.encode().byteLength is fine.
  const bytes = new TextEncoder().encode(serialized).byteLength;
  if (bytes > PRESENCE_LIMITS.META_BYTES_MAX) {
    return {
      ok: false,
      error: {
        code: PRESENCE_ERROR_CODES.META_TOO_LARGE,
        message: `meta serialized to ${String(bytes)} bytes, exceeds ${String(PRESENCE_LIMITS.META_BYTES_MAX)}-byte cap.`,
      },
    };
  }
  return { ok: true, value: true };
}

export type { PresenceError };
