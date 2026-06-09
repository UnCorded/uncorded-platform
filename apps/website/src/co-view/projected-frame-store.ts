// Website-side receive/store layer for `co-view.render-tree.projected` frames
// (CV-FOUND-6). The runtime projects the host's canonical render tree per viewer
// entitlement and forwards one `WsCoViewRenderTreeProjected` per viewer; this
// module is where those already-projected frames land on the client, keyed by
// `session_id`, so the sanitized viewer renderer (CV-FOUND-5) can later mount
// against the latest stored frame.
//
// Foundation-only: this PR ships the store + the dormant WS receive path. No
// live viewer UI mounts the renderer yet — `CO_VIEW_PROJECTED_VIEWER_ENABLED`
// (render-tree-viewer.ts) stays false. The store holds ONLY already-projected
// frames (`CoViewProjectedRenderFrame`); it never accepts a canonical frame and
// performs no projection itself, so it can introduce no protected bytes.
//
// Mirrors the pure-reducer-plus-thin-Solid-wrapper shape of
// `active-sessions-store.ts`.

import { createStore, reconcile } from "solid-js/store";
import type {
  CoViewProjectedRenderFrame,
  WsCoViewRenderTreeProjected,
} from "@uncorded/protocol";

import { observeCoViewRenderTreeProjected } from "./client";

/** The latest projected render frame for each live CoView session. */
export interface ProjectedFrameStoreState {
  /** `session_id` → latest `CoViewProjectedRenderFrame` received for it. */
  bySession: Record<string, CoViewProjectedRenderFrame>;
}

/** A fresh, empty store value. */
export function createEmptyProjectedFrameStore(): ProjectedFrameStoreState {
  return { bySession: {} };
}

/**
 * Structural guard for a projected-frame envelope. This is the sole gate that
 * keeps non-projected traffic — notably a CANONICAL `co-view.render-tree.frame`
 * envelope — out of the store: only the projected discriminant passes, and only
 * with a usable `session_id` and a present `frame` payload.
 */
export function isProjectedFrameEnvelope(
  value: unknown,
): value is WsCoViewRenderTreeProjected {
  if (typeof value !== "object" || value === null) return false;
  const env = value as Record<string, unknown>;
  if (env["type"] !== "co-view.render-tree.projected") return false;
  if (typeof env["session_id"] !== "string" || env["session_id"] === "") return false;
  const frame = env["frame"];
  if (typeof frame !== "object" || frame === null) return false;
  return true;
}

/**
 * Pure, idempotent apply over the store value. Fail-closed and boring: a
 * non-projected or malformed envelope (wrong `type`, a canonical frame, a
 * missing/empty `session_id`, or an absent `frame`) returns the SAME state
 * reference so callers can short-circuit and a bad frame can never crash a
 * viewer. A valid envelope stores `frame.frame` referentially (no copy, so no
 * canonical bytes are ever synthesized) under its `session_id`.
 */
export function applyProjectedFrame(
  state: ProjectedFrameStoreState,
  frame: unknown,
): ProjectedFrameStoreState {
  if (!isProjectedFrameEnvelope(frame)) return state;
  return {
    bySession: { ...state.bySession, [frame.session_id]: frame.frame },
  };
}

/** Latest projected frame for `sessionId`, or `undefined` if none stored. */
export function getProjectedFrame(
  state: ProjectedFrameStoreState,
  sessionId: string,
): CoViewProjectedRenderFrame | undefined {
  return state.bySession[sessionId];
}

/**
 * Drop the stored frame for one session. Returns the SAME reference when the
 * session has no stored frame (no-op short-circuit).
 */
export function clearProjectedSession(
  state: ProjectedFrameStoreState,
  sessionId: string,
): ProjectedFrameStoreState {
  if (!(sessionId in state.bySession)) return state;
  const next: Record<string, CoViewProjectedRenderFrame> = { ...state.bySession };
  delete next[sessionId];
  return { bySession: next };
}

/**
 * Empty the store. Returns the SAME reference when it is already empty (no-op
 * short-circuit).
 */
export function clearAllProjectedSessions(
  state: ProjectedFrameStoreState,
): ProjectedFrameStoreState {
  if (Object.keys(state.bySession).length === 0) return state;
  return createEmptyProjectedFrameStore();
}

/**
 * Thin reactive wrapper, one per `serverId`, following `active-sessions-store`.
 * Subscribes to the dormant projected-frame WS route and collapses incoming
 * frames into a reactive per-session map. Dormant in production: nothing
 * constructs this yet and no UI mounts the renderer, but the wiring is complete
 * and unit-testable via the imperative methods.
 */
export interface ProjectedFrameStore {
  /** Reactive read of the latest projected frame for a session. */
  frame: (sessionId: string) => CoViewProjectedRenderFrame | undefined;
  /** Apply a received projected envelope (no-op on a bad/non-projected frame). */
  apply: (frame: unknown) => void;
  /** Drop the stored frame for one session. */
  clearSession: (sessionId: string) => void;
  /** Empty the store. */
  clearAll: () => void;
  /** Tear down the underlying WS subscription. */
  dispose: () => void;
}

export function createProjectedFrameStore(serverId: string): ProjectedFrameStore {
  const [state, setState] = createStore<ProjectedFrameStoreState>(
    createEmptyProjectedFrameStore(),
  );

  function commit(next: ProjectedFrameStoreState): void {
    // The pure helpers return the SAME reference on a no-op; `state` is the
    // store proxy we hand them, so identity holds and we skip the write.
    if (next === state) return;
    // `reconcile` diffs the per-session map structurally (default `id` keying
    // matches projected-node `id`s inside each frame's children), preserving
    // referential stability for sessions whose frame did not change.
    setState("bySession", reconcile(next.bySession));
  }

  const unsub = observeCoViewRenderTreeProjected(serverId, (frame) => {
    commit(applyProjectedFrame(state, frame));
  });

  return {
    frame: (sessionId: string) => state.bySession[sessionId],
    apply: (frame) => commit(applyProjectedFrame(state, frame)),
    clearSession: (sessionId) => commit(clearProjectedSession(state, sessionId)),
    clearAll: () => commit(clearAllProjectedSessions(state)),
    dispose: () => unsub(),
  };
}
