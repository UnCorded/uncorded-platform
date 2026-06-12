import { createSignal } from "solid-js";
import type { Server } from "../api/types";
import * as central from "../api/central";

const [servers, setServers] = createSignal<Server[]>([]);
const [serversLoading, setServersLoading] = createSignal(false);
const [activeServerId, setActiveServerId] = createSignal<string | null>(null);
const [activePluginSlug, setActivePluginSlug] = createSignal<string | null>(null);

// Per-server icon cache-buster. Bumped by `runtime.icon.changed` WS events
// (subscription wired in stores/sidebar.ts). The runtime serves /icon with a
// short max-age=60; this signal lets a viewer who joined before the owner
// uploaded re-fetch the moment the upload broadcast arrives, without
// hard-refreshing.
const [iconVersionsTick, setIconVersionsTick] = createSignal(0);
const iconVersions = new Map<string, number>();

export function getServerIconVersion(serverId: string): number {
  iconVersionsTick(); // subscribe — bumps trigger re-render
  return iconVersions.get(serverId) ?? 0;
}

export function bumpServerIconVersion(serverId: string, updatedAt: number): void {
  const prev = iconVersions.get(serverId) ?? 0;
  if (updatedAt <= prev) return;
  iconVersions.set(serverId, updatedAt);
  setIconVersionsTick((n) => n + 1);
}
/**
 * Set when the last `loadServers()` call failed. Rendered as a retry-able
 * banner; cleared on the next successful load. Kept separate from `servers`
 * so a transient Central outage doesn't wipe the user's list to empty.
 */
const [serversError, setServersError] = createSignal<string | null>(null);

export { servers, serversLoading, serversError, activeServerId, activePluginSlug };

export function removeServer(id: string): void {
  setServers((prev) => prev.filter((s) => s.id !== id));
  if (activeServerId() === id) {
    setActiveServerId(null);
    setActivePluginSlug(null);
  }
}

export function setActiveServer(id: string | null): void {
  setActiveServerId(id);
  setActivePluginSlug(null);
}

export function setActivePlugin(slug: string | null): void {
  setActivePluginSlug(slug);
}

/** Patch a single server's fields in-place without a full reload. */
export function patchServer(id: string, patch: Partial<Server>): void {
  setServers((prev) => {
    const idx = prev.findIndex((s) => s.id === id);
    if (idx === -1) return prev;
    const target = prev[idx]!;
    // Reference-equal exit: if every patched field already matches, skip the
    // write. Without this guard, onConnect's patchServer({is_online:true})
    // emits a fresh server object every reconnect — anything tracking
    // activeServer() (e.g. sidebar.ts's createEffect) re-fires and calls
    // connect() again, looping us into the WS rate limiter.
    let changed = false;
    for (const key of Object.keys(patch) as (keyof Server)[]) {
      if (target[key] !== patch[key]) { changed = true; break; }
    }
    if (!changed) return prev;
    const next = prev.slice();
    next[idx] = { ...target, ...patch };
    return next;
  });
}

/**
 * Adjust connected_users for a server by delta.
 * Used by presence event handlers for real-time count updates between polls.
 */
export function adjustConnectedUsers(id: string, delta: number): void {
  setServers((prev) =>
    prev.map((s) =>
      s.id === id
        ? { ...s, connected_users: Math.max(0, s.connected_users + delta) }
        : s,
    ),
  );
}

let _pollHandle: ReturnType<typeof setInterval> | null = null;

/** Start a 60s background poll of the server list. Safe to call multiple times. */
function startPolling(): void {
  if (_pollHandle !== null) return;
  _pollHandle = setInterval(() => void loadServers(), 60_000);
}

/** Stop the background server-list poll. Tests use this to avoid leaks. */
export function stopPolling(): void {
  if (_pollHandle === null) return;
  clearInterval(_pollHandle);
  _pollHandle = null;
}

export async function loadServers(): Promise<void> {
  setServersLoading(true);
  const prev = servers();
  try {
    const list = await central.listMyServers();
    // The membership payload carries no tunnel_url (it travels only with the
    // join token — see getServerToken, which hydrates it via patchServer).
    // Preserve any URL we already resolved so a 60s poll doesn't blank the
    // field panels resolve through serverById().
    const prevUrlById = new Map(prev.map((s) => [s.id, s.tunnel_url] as const));
    setServers(
      list.map((s) => ({
        ...s,
        tunnel_url: s.tunnel_url ?? prevUrlById.get(s.id) ?? null,
      })),
    );
    setServersError(null);
    startPolling();

    // Reconcile: purge servers that used to be in local state but Central no
    // longer reports. This backstops the per-request 404 branches in
    // openConnection/refreshToken for clients that haven't interacted with
    // the deleted server yet (idle tab, different device).
    //
    // Sanity valve: drain one per poll. The realistic failure mode is the
    // user deleting multiple servers from another client within the 60s
    // window — per-request 404 is the authoritative detector, so leaking
    // one-purge-per-minute is slow enough to catch a bug and fast enough
    // to not feel broken.
    //
    // Skip the diff on first load (pre-call `prev` empty) so the startup
    // sequence doesn't race-fire a purge against an unresolved list.
    if (prev.length > 0) {
      const remoteIds = new Set(list.map((s) => s.id));
      const missing = prev.filter((s) => !remoteIds.has(s.id));
      if (missing.length > 0) {
        // Dynamic import breaks the module cycle (server-purge → ws → stores/servers).
        const { purgeServer } = await import("../lib/server-purge");
        const first = missing[0]!;
        void purgeServer(first.id, "central-gone");
        if (missing.length > 1) {
          console.warn("[reconcile] reconcile_backlog — deferring purge of remaining servers", {
            purged: { id: first.id, name: first.name },
            deferred: missing.slice(1).map((s) => ({ id: s.id, name: s.name })),
          });
        }
      }
    }
  } catch (err) {
    // Keep the existing list — a transient Central outage should not wipe
    // the user's servers to empty and look indistinguishable from "no
    // servers yet". Surface an error signal the UI can show instead.
    const msg = err instanceof Error ? err.message : "Failed to load servers";
    setServersError(msg);
  } finally {
    setServersLoading(false);
  }
}

export function activeServer(): Server | null {
  const id = activeServerId();
  if (!id) return null;
  return servers().find((s) => s.id === id) ?? null;
}

// Live resolution of a server by id from the reactive servers() store. This is
// the single point panels use to resolve a tunnel URL at render time — never a
// by-value snapshot — so a rotated/expired tunnel URL is picked up reactively
// (the heartbeat re-advertises every 30s → Central → servers()). Returns null
// when the server isn't in the store (not loaded yet, or removed/purged).
export function serverById(id: string): Server | null {
  return servers().find((s) => s.id === id) ?? null;
}
