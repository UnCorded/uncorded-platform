// Active-server route: `/s/<server-slug>` (e.g. uncorded.app/s/uncorded).
//
// Selecting a server puts it in the URL; a refresh (or a pasted link)
// restores the selection instead of dumping the user on the no-server view.
//
// The slug is derived client-side from the server name and resolved against
// the signed-in user's own membership list — Central has no slug column, and
// this is a selection-restore route, not a global address, so per-user
// resolution is exactly the right scope. When two of the user's servers
// slugify identically, the path disambiguates with a short id suffix
// (`/s/game-night--1a2b3c4d`); a raw UUID segment is accepted too.
//
// Encoding is surface-aware:
//   - http(s) (web prod, Vite dev, Electron dev): real pathname `/s/<slug>`.
//     serve-website.ts and Vite both SPA-fallback unmatched paths to
//     index.html, so refresh works with no server config.
//   - file:// (packaged desktop): pathname pushState breaks reload outright,
//     so the same route rides the hash (`#/s/<slug>`) — identical semantics,
//     refresh-stable, zero filesystem implications.
//
// Writes are replaceState-style: selection changes don't pile up history
// entries, so the back button leaves the app instead of unwinding clicks.

import { createSignal, createEffect, untrack } from "solid-js";
import type { Server } from "../api/types";
import { servers, serversLoadedOnce, activeServerId, setActiveServer } from "../stores/servers";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ID_SUFFIX_RE = /--([0-9a-f]{8})$/;
const PATH_RE = /^\/s\/([a-z0-9][a-z0-9-]*)$/;
const HASH_RE = /^#\/s\/([a-z0-9][a-z0-9-]*)$/;
const MAX_SLUG_LENGTH = 48;

/** Lowercased, hyphen-joined, length-capped form of a server name. Returns
 *  "" for names with no usable characters (the caller falls back to the id). */
export function slugifyServerName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/, "");
}

/** The route segment for a server: its slug, disambiguated with a short id
 *  suffix when another server in the same list shares the slug (or when the
 *  name slugifies to nothing). */
export function serverRouteSegment(server: Server, all: Server[]): string {
  const slug = slugifyServerName(server.name);
  const shortId = server.id.slice(0, 8);
  if (!slug) return shortId.length === 8 ? `${"server"}--${shortId}` : server.id;
  const collides = all.some(
    (s) => s.id !== server.id && slugifyServerName(s.name) === slug,
  );
  return collides ? `${slug}--${shortId}` : slug;
}

/** Resolve a route segment back to a server id within the user's list.
 *  Returns null when nothing (or more than one thing) matches — the caller
 *  treats that as a dead link and cleans the URL rather than guessing. */
export function resolveServerRoute(segment: string, all: Server[]): string | null {
  if (UUID_RE.test(segment)) {
    return all.some((s) => s.id === segment) ? segment : null;
  }
  const suffix = ID_SUFFIX_RE.exec(segment);
  if (suffix) {
    const match = all.find((s) => s.id.startsWith(suffix[1]!));
    return match?.id ?? null;
  }
  const matches = all.filter((s) => slugifyServerName(s.name) === segment);
  return matches.length === 1 ? matches[0]!.id : null;
}

function useHashEncoding(): boolean {
  return typeof window !== "undefined" && window.location.protocol === "file:";
}

/** Read the route segment the current URL points at, if any. */
export function readServerRoute(): string | null {
  if (typeof window === "undefined") return null;
  const match = useHashEncoding()
    ? HASH_RE.exec(window.location.hash)
    : PATH_RE.exec(window.location.pathname);
  return match?.[1] ?? null;
}

/** Write the selection into the URL without adding a history entry. */
export function writeServerRoute(server: Server | null, all: Server[]): void {
  if (typeof window === "undefined") return;
  const segment = server ? serverRouteSegment(server, all) : null;
  const { pathname, search, hash } = window.location;
  let next: string;
  if (useHashEncoding()) {
    next = `${pathname}${search}${segment ? `#/s/${segment}` : ""}`;
    if (`${pathname}${search}${hash}` === next) return;
  } else {
    // Only own the URL when it's ours to own: `/` or an existing `/s/*`.
    // Anything else (a future route family) is left alone.
    if (pathname !== "/" && !PATH_RE.test(pathname)) return;
    next = `${segment ? `/s/${segment}` : "/"}${search}${hash}`;
    if (`${pathname}${search}${hash}` === next) return;
  }
  window.history.replaceState(window.history.state, "", next);
}

// Pending restore target, captured from the URL before the membership list
// exists. Resolved (and cleared) by the first list that arrives.
const [pendingRoute, setPendingRoute] = createSignal<string | null>(null);

/**
 * Wire the route ↔ selection sync. Call once from App's component body (the
 * effects need a reactive owner that lives as long as the app).
 *
 * Restore order matters: the URL is read before any effect runs, the
 * write-mirror stays quiet while a restore is pending so it can't clobber
 * the very URL being restored, and a segment that no longer matches any
 * membership (renamed away, left, deleted) cleans itself up once the list
 * has loaded instead of wedging.
 */
export function mountServerRoute(): void {
  setPendingRoute(readServerRoute());

  // Resolve the pending segment once the membership list is authoritative.
  // Gated on serversLoadedOnce, NOT list emptiness: a zero-server user's list
  // is legitimately empty after a successful load, and their stale /s/ URL
  // must resolve (to "dead link, clean it") rather than pend forever. The
  // loading flag wouldn't work either — it's false before the first load
  // even starts, which would clear the pending route at mount.
  createEffect(() => {
    const pending = pendingRoute();
    if (pending === null) return;
    if (!serversLoadedOnce()) return;
    const list = servers();
    setPendingRoute(null);
    const id = resolveServerRoute(pending, list);
    if (id) {
      setActiveServer(id);
    } else {
      writeServerRoute(null, list); // dead link — clean the URL
    }
  });

  // Mirror selection (and renames of the selected server) into the URL.
  createEffect(() => {
    if (pendingRoute() !== null) return;
    const id = activeServerId();
    const list = servers();
    const server = id ? (list.find((s) => s.id === id) ?? null) : null;
    // Selected but not yet in the list (store still hydrating) — hold off
    // rather than writing a transiently-empty route.
    if (id && !server) return;
    untrack(() => writeServerRoute(server, list));
  });
}
