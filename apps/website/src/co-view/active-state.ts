// Shared "what Co-View is the local user doing right now" store.
//
// This decouples the three places that need to agree:
//   - <CoViewSheet> (sidebar) — disables Start when hosting; offers Leave when viewing
//   - <HostShellRunner> (App.tsx) — mounted only when hostingSessionId is non-null
//   - <ViewerSession> (App.tsx) — mounted only when viewingSessionId is non-null
//
// All three are scoped to the active server. When the user switches servers,
// the per-server entry is preserved (a host session keeps running while the
// user pokes around another server) — but the renderers are gated on
// activeServerId so only the relevant entry surfaces in UI at any moment.
//
// Setters are exported separately from accessors so that read-only consumers
// (the sheet's display logic) don't accidentally write.

import { createSignal } from "solid-js";

interface ServerCoViewState {
  hostingSessionId: string | null;
  hostingPaused: boolean;
  viewingSessionId: string | null;
}

const EMPTY: ServerCoViewState = {
  hostingSessionId: null,
  hostingPaused: false,
  viewingSessionId: null,
};

const [statesByServer, setStatesByServer] = createSignal<Record<string, ServerCoViewState>>({});

function get(serverId: string | null): ServerCoViewState {
  if (!serverId) return EMPTY;
  return statesByServer()[serverId] ?? EMPTY;
}

function patch(serverId: string, p: Partial<ServerCoViewState>): void {
  setStatesByServer((prev) => {
    const cur = prev[serverId] ?? EMPTY;
    return { ...prev, [serverId]: { ...cur, ...p } };
  });
}

// ---------------------------------------------------------------------------
// Read accessors — return the entry for a given server, defaulting to EMPTY.
// ---------------------------------------------------------------------------

export function coViewHostingSessionId(serverId: string | null): string | null {
  return get(serverId).hostingSessionId;
}

export function coViewHostingPaused(serverId: string | null): boolean {
  return get(serverId).hostingPaused;
}

export function coViewViewingSessionId(serverId: string | null): string | null {
  return get(serverId).viewingSessionId;
}

// ---------------------------------------------------------------------------
// Setters — small, intention-revealing names.
// ---------------------------------------------------------------------------

export function setCoViewHosting(serverId: string, sessionId: string | null): void {
  // When clearing, also reset paused — a fresh next session shouldn't inherit.
  patch(serverId, { hostingSessionId: sessionId, hostingPaused: false });
}

export function setCoViewHostingPaused(serverId: string, paused: boolean): void {
  patch(serverId, { hostingPaused: paused });
}

export function setCoViewViewing(serverId: string, sessionId: string | null): void {
  patch(serverId, { viewingSessionId: sessionId });
}
