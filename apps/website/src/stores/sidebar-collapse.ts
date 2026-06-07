// Per-server sidebar collapse state. Keys are prefixed strings — `cat:<id>`
// for category groups, `sec:<slug>` for plugin sections — so the same Set
// can hold both kinds without collision. Persisted to localStorage so the
// user's chosen layout survives reloads and tab swaps.

import { createSignal, createEffect } from "solid-js";
import { activeServerId } from "./servers";

const [collapsed, setCollapsed] = createSignal<Set<string>>(new Set());

function storageKey(serverId: string): string {
  return `sidebar:collapsed:${serverId}`;
}

function load(serverId: string): Set<string> {
  try {
    const raw = localStorage.getItem(storageKey(serverId));
    if (!raw) return new Set();
    const arr: unknown = JSON.parse(raw);
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter((s): s is string => typeof s === "string"));
  } catch {
    return new Set();
  }
}

function save(serverId: string, set: Set<string>): void {
  try {
    localStorage.setItem(storageKey(serverId), JSON.stringify([...set]));
  } catch {
    // localStorage can throw on quota / private mode — collapse is cosmetic, ignore.
  }
}

export function isCollapsed(key: string): boolean {
  return collapsed().has(key);
}

export function toggleCollapsed(key: string): void {
  const sid = activeServerId();
  setCollapsed((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    if (sid) save(sid, next);
    return next;
  });
}

// Mount once from App's onMount so the createEffect lives inside the render
// owner (otherwise SolidJS warns about disposed-orphan effects).
export function mountSidebarCollapseStore(): void {
  createEffect(() => {
    const id = activeServerId();
    setCollapsed(id ? load(id) : new Set<string>());
  });
}
