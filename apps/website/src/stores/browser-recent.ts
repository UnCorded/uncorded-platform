// Browser "Recently opened" store — single per-user history, scoped to the
// active server. Mirrors the workspace auto-save pattern: optimistic local
// update on add/remove, then a debounced PUT to /browser/recent. Cross-tab
// and cross-window sync via the browser_recent:updated WS broadcast — the
// runtime echoes EDITOR_ID so the saving tab ignores its own event.

import { createEffect, createSignal, onCleanup } from "solid-js";
import type { BrowserRecentEntry } from "@uncorded/protocol";
import { activeServer, activeServerId } from "./servers";
import { onPluginMessage, onReconnect } from "../lib/ws";
import * as runtime from "../api/runtime";
import { EDITOR_ID } from "../api/runtime";
import { defaultBrowserTitle } from "../lib/browser-panel-state";

const MAX_GLOBAL_RECENT = 20;
const SAVE_DEBOUNCE_MS = 1500;

const [recentByServer, setRecentByServer] = createSignal<Record<string, BrowserRecentEntry[]>>({});

const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
const saveAborters = new Map<string, AbortController>();

// ── Reads ───────────────────────────────────────────────────────────────────

export function browserRecent(): BrowserRecentEntry[] {
  const id = activeServerId();
  if (!id) return [];
  return recentByServer()[id] ?? [];
}

// ── Writes ──────────────────────────────────────────────────────────────────

/** Replace the list for a server without scheduling a save. Used by hydrate
 *  and the WS sync handler. */
function setBrowserRecentForServer(serverId: string, list: BrowserRecentEntry[]): void {
  setRecentByServer((prev) => ({ ...prev, [serverId]: list.slice(0, MAX_GLOBAL_RECENT) }));
}

/** Dedupe by URL, prepend, slice to cap, schedule a debounced PUT. */
export function addBrowserRecent(entry: { title: string; url: string }): void {
  const id = activeServerId();
  if (!id) return;
  const normalized: BrowserRecentEntry = {
    title: entry.title || defaultBrowserTitle(entry.url),
    url: entry.url,
  };
  setRecentByServer((prev) => {
    const current = prev[id] ?? [];
    const next = [normalized, ...current.filter((item) => item.url !== normalized.url)].slice(
      0,
      MAX_GLOBAL_RECENT,
    );
    return { ...prev, [id]: next };
  });
  scheduleSave(id);
}

export function removeBrowserRecent(url: string): void {
  const id = activeServerId();
  if (!id) return;
  setRecentByServer((prev) => {
    const current = prev[id] ?? [];
    const next = current.filter((item) => item.url !== url);
    return { ...prev, [id]: next };
  });
  scheduleSave(id);
}

// ── Hydrate ─────────────────────────────────────────────────────────────────

async function hydrateBrowserRecent(server: { id: string; tunnel_url: string }): Promise<void> {
  try {
    const list = await runtime.getBrowserRecent(server.tunnel_url, server.id);
    setBrowserRecentForServer(server.id, list);
  } catch (err) {
    console.warn(
      "[browser-recent] hydrate failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

// ── Internal: debounced PUT ─────────────────────────────────────────────────

function scheduleSave(serverId: string): void {
  const existing = saveTimers.get(serverId);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    saveTimers.delete(serverId);
    const server = activeServer();
    if (!server || server.id !== serverId || !server.tunnel_url) return;

    const list = recentByServer()[serverId] ?? [];
    const prevAborter = saveAborters.get(serverId);
    if (prevAborter) prevAborter.abort();
    const aborter = new AbortController();
    saveAborters.set(serverId, aborter);

    runtime
      .updateBrowserRecent(server.tunnel_url, serverId, list, aborter.signal)
      .then(() => {
        if (saveAborters.get(serverId) === aborter) saveAborters.delete(serverId);
      })
      .catch((err) => {
        if (saveAborters.get(serverId) === aborter) saveAborters.delete(serverId);
        if (err instanceof DOMException && err.name === "AbortError") return;
        console.warn(
          "[browser-recent] save failed:",
          err instanceof Error ? err.message : err,
        );
      });
  }, SAVE_DEBOUNCE_MS);

  saveTimers.set(serverId, timer);
}

// ── Mount (call once from App's onMount) ────────────────────────────────────

export function mountBrowserRecentStore(): void {
  onCleanup(() => {
    saveTimers.forEach(clearTimeout);
    saveTimers.clear();
    saveAborters.forEach((c) => c.abort());
    saveAborters.clear();
  });

  // Hydrate when the active server changes.
  createEffect(() => {
    const server = activeServer();
    if (!server?.tunnel_url) return;
    void hydrateBrowserRecent({ id: server.id, tunnel_url: server.tunnel_url });
  });

  // Re-hydrate on WS reconnect (mirrors the workspace retry pattern — handles
  // the race where the initial HTTP load ran before the server cached
  // Central's public keys).
  onReconnect((reconnectedServerId) => {
    const server = activeServer();
    if (!server || server.id !== reconnectedServerId || !server.tunnel_url) return;
    void hydrateBrowserRecent({ id: server.id, tunnel_url: server.tunnel_url });
  });

  // Cross-tab / cross-window sync via WS broadcast.
  createEffect(() => {
    const server = activeServer();
    if (!server?.tunnel_url) return;
    const serverId = server.id;

    const unregister = onPluginMessage(
      serverId,
      "__browser_recent:sync",
      (data) => {
        const msg = data as Record<string, unknown>;
        if (msg["type"] !== "event" || msg["topic"] !== "browser_recent:updated") return;
        const payload = msg["payload"] as {
          recent: BrowserRecentEntry[];
          editor_id?: string | null;
        };
        // Ignore our own broadcasts — the runtime fans out to every WS
        // connection for this user, including the tab that just saved.
        if (payload.editor_id === EDITOR_ID) return;
        setBrowserRecentForServer(serverId, payload.recent);
      },
      "__browser_recent:sync",
    );

    onCleanup(unregister);
  });
}
