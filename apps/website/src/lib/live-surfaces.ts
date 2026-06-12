// Live-surfaces map — the renderer-only, session-only link between a Web App
// panel (keyed by its per-panel `instanceId`) and a live native
// `WebContentsView` (the main-assigned `surfaceId`).
//
// Why keyed by instanceId, not webAppId:
//   webAppId is the per-URL bookmark id (idempotent by URL), so two panels of
//   the same saved page share it — and a flat webAppId→surfaceId map would let
//   the second panel's live view clobber the first's binding. instanceId is
//   unique per panel, so each open panel owns its own live view cleanly.
//
// Why session-only:
//   The live view is an in-memory main-process object; it can't be serialized.
//   The protocol `PanelContent` carries only `instanceId` (+ webAppId/url/title)
//   — never the surfaceId. The live link is kept here, out of the protocol, and
//   is NEVER persisted. On restart/crash the map is empty, so the panel's
//   always-live path (web-app-panel.tsx) re-creates a fresh live view loading
//   the URL (cookies/localStorage restored via persist:browser; sessionStorage
//   lost across a process restart — unavoidable).
//
// Reactivity:
//   Backed by a single SolidJS signal holding an immutable map. `liveSurfaceId`
//   returns a memo so a WebAppPanel re-renders the moment its surface is
//   registered or cleared.

import { createMemo, createSignal, type Accessor } from "solid-js";

const [map, setMap] = createSignal<ReadonlyMap<string, number>>(new Map());

/**
 * Bind a panel instance to a live native surface. Called when a panel creates
 * its view (sidebar open / restore) or adopts a docked view, so the panel
 * renders the live `WebContentsView` rather than a placeholder.
 */
export function registerLiveSurface(instanceId: string, surfaceId: number): void {
  const next = new Map(map());
  next.set(instanceId, surfaceId);
  setMap(next);
}

/**
 * Drop the live link for a panel instance. Called when the native view is
 * released (panel closed, web app removed). Pairs with nativeSurfaceRelease.
 */
export function clearLiveSurface(instanceId: string): void {
  if (!map().has(instanceId)) return;
  const next = new Map(map());
  next.delete(instanceId);
  setMap(next);
}

/**
 * Reactive accessor: the live surfaceId bound to a panel instance, or null if
 * none yet. Memoized so panels only re-render on actual change.
 */
export function liveSurfaceId(instanceId: string): Accessor<number | null> {
  return createMemo(() => map().get(instanceId) ?? null);
}

/** Non-reactive lookup — for imperative paths (e.g. release-on-close). */
export function peekLiveSurface(instanceId: string): number | null {
  return map().get(instanceId) ?? null;
}

/**
 * Reactive snapshot of every instanceId currently bound to a live surface. The
 * App-level reconciliation effect compares this against the instanceIds present
 * in panelContents to find orphaned surfaces (panel closed / replaced / its
 * workspace deleted) and release them — the single release chokepoint (B3 leak).
 */
export function allLiveInstanceIds(): string[] {
  return [...map().keys()];
}
