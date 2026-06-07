// Per-server runtime update state — one slot per active server, populated by:
//   1. An initial GET /admin/api/update-state when the active server flips
//      (every member can read; D4 visibility-universal).
//   2. The `core.runtime.update_state_changed` WS topic, which the runtime
//      broadcasts on every persist.
//   3. A refetch on `onReconnect` to repair gaps if the WS dropped during a
//      transition (orchestrator-driven progress is the most likely victim).
//
// Renderer surfaces (sidebar pill, danger-zone panel, install toast) read
// `runtimeUpdateStateFor(serverId)` and never call the runtime directly. Per
// `feedback_solid_patcher_cascade.md` we treat the per-server slot as the
// reactive unit — consumers should memoize on narrow keys (state, version)
// rather than depend on the whole record.
//
// The orchestrator-bridge calls (check, perform, set channel, set backup)
// live on the renderer side as `window.electron.runtimeUpdate.*` and feed
// state back into this store via the WS broadcast loop. We do NOT optimistically
// patch the local slot — every transition flows through the runtime first so
// the desktop, web (browser-only), and any future client agree on the wire
// state without write-write conflicts.

import { createSignal, createEffect, createMemo, untrack, onCleanup } from "solid-js";
import type { RuntimeUpdateState } from "@uncorded/protocol";
import { CORE_TOPICS } from "@uncorded/protocol";
import { activeServerId, activeServer } from "./servers";
import { connect, onPluginMessage, onReconnect } from "../lib/ws";
import { runtimeFetch, errorFromResponse } from "../api/runtime";

const [statesByServer, setStatesByServer] = createSignal<Record<string, RuntimeUpdateState | null>>({});

// Per-server "have we ever fetched" guard so the initial fetch only fires
// once per server-activation. WS broadcasts keep the slot warm afterward.
const fetched = new Set<string>();

/** Reactive accessor — returns the current update-state slot for `serverId`,
 *  or null when nothing has been fetched yet. */
export function runtimeUpdateStateFor(serverId: string): () => RuntimeUpdateState | null {
  return () => statesByServer()[serverId] ?? null;
}

function patchState(serverId: string, next: RuntimeUpdateState | null): void {
  setStatesByServer((prev) => {
    const cur = prev[serverId] ?? null;
    if (cur === next) return prev;
    if (cur && next && cur.updatedAt === next.updatedAt && cur.state === next.state) {
      // Same logical state — keep the existing reference so consumers that
      // depend on identity equality (e.g. memo cache keys) don't churn.
      return prev;
    }
    return { ...prev, [serverId]: next };
  });
}

async function fetchInitial(serverId: string, tunnelUrl: string): Promise<void> {
  try {
    const res = await runtimeFetch(tunnelUrl, serverId, "/admin/api/update-state");
    if (!res.ok) {
      throw await errorFromResponse(res, "Failed to load runtime update state");
    }
    const body = (await res.json()) as RuntimeUpdateState;
    patchState(serverId, body);
  } catch (err) {
    // Don't blank the slot on transient failure — keep whatever the WS already
    // gave us. Log so the operator can see it in devtools when the pill goes
    // stale unexpectedly.
    console.warn("[runtime-update] initial fetch failed", {
      serverId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

// Validate-and-coerce a WS payload into RuntimeUpdateState. The runtime is the
// single source of truth for the shape but a stray broadcast (or a downgrade
// where the wire format moves ahead of the renderer) shouldn't poison the
// store. We bail on missing top-level fields and otherwise trust the runtime
// to have validated edges and value ranges.
function asRuntimeUpdateState(payload: unknown): RuntimeUpdateState | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (typeof p["state"] !== "string") return null;
  if (typeof p["currentVersion"] !== "string") return null;
  if (typeof p["channel"] !== "string") return null;
  if (typeof p["updatedAt"] !== "number") return null;
  return p as unknown as RuntimeUpdateState;
}

/** Mount once at app boot (App.tsx) — same cadence as `mountPermissionsStores`.
 *  Wires the initial fetch + WS subscription + refetch-on-reconnect for the
 *  active server. The slot for a server stays in the store after switching
 *  away so consumers can still read the last-known state during a transition. */
export function mountRuntimeUpdateStore(): void {
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
    const tunnelUrl = key.slice(key.indexOf("|") + 1);
    const server = untrack(activeServer);
    if (!server) return;

    let cancelled = false;

    // The membership effect already triggers connect(); calling here is
    // idempotent and protects against the rare case where this store is
    // mounted before membership.
    void (async () => {
      await connect(server);
      if (cancelled) return;
    })();

    if (!fetched.has(id)) {
      fetched.add(id);
      void fetchInitial(id, tunnelUrl);
    }

    // Subscribe under the "core" plugin slug + a unique handler key so the
    // permissions store's own "core" subscription isn't displaced. The WS
    // dispatcher fans every event out to all registered handlers regardless
    // of slug, so the slug here is decorative — the handlerKey is what makes
    // the registration unique.
    const unsubEvents = onPluginMessage(
      id,
      "core",
      (data) => {
        const ev = data as { type?: string; topic?: string; payload?: unknown };
        if (ev.type !== "event") return;
        if (ev.topic !== CORE_TOPICS.RUNTIME_UPDATE_STATE_CHANGED) return;
        const next = asRuntimeUpdateState(ev.payload);
        if (next === null) return;
        patchState(id, next);
      },
      "runtime-update-store-watch",
    );

    // Refetch on reconnect — events that landed while the WS was disconnected
    // are lost; the GET is the safe re-sync.
    const unsubReconnect = onReconnect((reconnectedId) => {
      if (reconnectedId !== id) return;
      void fetchInitial(id, tunnelUrl);
    });

    onCleanup(() => {
      cancelled = true;
      unsubEvents();
      unsubReconnect();
    });
  });
}

// ---------------------------------------------------------------------------
// Test seam — clears all in-memory state. Used by unit tests to isolate
// scenarios. Not exported from the package barrel; do not call in app code.
// ---------------------------------------------------------------------------

export function _resetRuntimeUpdateStoreForTests(): void {
  setStatesByServer({});
  fetched.clear();
}
