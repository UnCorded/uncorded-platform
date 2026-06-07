// ScopeRegistry — the triple-indexed in-memory store backing scoped presence.
//
// Three indexes on the same data:
//
//   byScope:   Map<scope, Map<sessionId, Entry>>
//     The canonical store. O(1) read of a scope's full entry list, O(1)
//     mutation by (scope, session).
//
//   byScope_session: Map<sessionId, Set<scope>>
//     For O(k) WS-close eviction where k = scopes that session is in.
//     Without this, every WS close would scan every scope.
//
//   byPlugin:  Map<pluginSlug, Set<scope>>
//     For O(s) plugin-unload eviction where s = scopes owned by the plugin.
//     Without this, plugin unload would scan every scope and string-prefix
//     against the slug.
//
// All three are kept in lockstep via the private insert/remove helpers.

import type { PresenceEntry } from "@uncorded/protocol";
import type { PresenceEntryInternal } from "./types";

export class ScopeRegistry {
  private readonly byScope = new Map<string, Map<string, PresenceEntryInternal>>();
  private readonly byScope_session = new Map<string, Set<string>>();
  private readonly byPlugin = new Map<string, Set<string>>();

  /** Total entries across all scopes — for tests and observability. */
  private entryCount = 0;

  size(): number {
    return this.entryCount;
  }

  /** Scopes a given plugin owns. Returns a defensive copy. */
  scopesForPlugin(slug: string): readonly string[] {
    const set = this.byPlugin.get(slug);
    return set ? [...set] : [];
  }

  /** Scopes a given session is currently in. Returns a defensive copy. */
  scopesForSession(sessionId: string): readonly string[] {
    const set = this.byScope_session.get(sessionId);
    return set ? [...set] : [];
  }

  /** Number of distinct sessions in a given scope. */
  scopeSize(scope: string): number {
    return this.byScope.get(scope)?.size ?? 0;
  }

  /** Get the entry for (scope, session_id) or `undefined`. */
  get(scope: string, sessionId: string): PresenceEntryInternal | undefined {
    return this.byScope.get(scope)?.get(sessionId);
  }

  /** Snapshot of all entries in a scope. Empty array if the scope is empty. */
  list(scope: string): PresenceEntry[] {
    const inner = this.byScope.get(scope);
    if (!inner) return [];
    const out: PresenceEntry[] = [];
    for (const entry of inner.values()) {
      out.push(toWire(entry));
    }
    return out;
  }

  /**
   * Insert or replace an entry for (scope, session_id). Returns the previous
   * entry if one existed (so callers can distinguish join from re-join).
   */
  insert(entry: PresenceEntryInternal): PresenceEntryInternal | undefined {
    let inner = this.byScope.get(entry.scope);
    if (!inner) {
      inner = new Map();
      this.byScope.set(entry.scope, inner);
    }
    const prev = inner.get(entry.session_id);
    inner.set(entry.session_id, entry);
    if (prev === undefined) this.entryCount++;

    let scopes = this.byScope_session.get(entry.session_id);
    if (!scopes) {
      scopes = new Set();
      this.byScope_session.set(entry.session_id, scopes);
    }
    scopes.add(entry.scope);

    let pluginScopes = this.byPlugin.get(entry.plugin_slug);
    if (!pluginScopes) {
      pluginScopes = new Set();
      this.byPlugin.set(entry.plugin_slug, pluginScopes);
    }
    pluginScopes.add(entry.scope);

    return prev;
  }

  /**
   * Remove the entry for (scope, session_id) if it exists. Returns the removed
   * entry, or `undefined` if there was no match.
   */
  remove(scope: string, sessionId: string): PresenceEntryInternal | undefined {
    const inner = this.byScope.get(scope);
    if (!inner) return undefined;
    const entry = inner.get(sessionId);
    if (!entry) return undefined;

    inner.delete(sessionId);
    this.entryCount--;
    if (inner.size === 0) this.byScope.delete(scope);

    const sessionScopes = this.byScope_session.get(sessionId);
    if (sessionScopes) {
      sessionScopes.delete(scope);
      if (sessionScopes.size === 0) this.byScope_session.delete(sessionId);
    }

    const pluginScopes = this.byPlugin.get(entry.plugin_slug);
    if (pluginScopes && inner.size === 0) {
      // Plugin's set tracks scopes (not entries), so only drop when the scope
      // becomes empty across all sessions.
      pluginScopes.delete(scope);
      if (pluginScopes.size === 0) this.byPlugin.delete(entry.plugin_slug);
    }

    return entry;
  }
}

function toWire(entry: PresenceEntryInternal): PresenceEntry {
  return {
    scope: entry.scope,
    user_id: entry.user_id,
    session_id: entry.session_id,
    meta: entry.meta,
    joined_at: entry.joined_at,
    updated_at: entry.updated_at,
  };
}
