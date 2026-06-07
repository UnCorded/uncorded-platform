// Boot entry point for the Co-View Sessions subsystem (spec-27).
//
// `startCoView(deps)` builds the in-memory registry, wires the dispatcher,
// and returns the public CoViewHandle. main.ts wires this in after the
// presence module; the WS router pulls dispatch via `attachCoViewDispatcher`.
//
// PR-CV1 ships lifecycle (start / update / end / join / leave / kick) +
// presence-scope integration + audit + permission gates.
// PR-CV2 adds state + event channels and snapshot req/res routing on top.
// Cursor and pen channels land in PR-CV4.

import { CoViewRegistry } from "./registry";
import {
  handleConnectionClose,
  handleEnd,
  handleJoin,
  handleKick,
  handleLeave,
  handleList,
  handleStart,
  handleUpdate,
  type CoViewContext,
} from "./handlers";
import {
  handleCursor,
  handleEvent,
  handleSnapshotReq,
  handleSnapshotRes,
  handleState,
} from "./state-handlers";
import type {
  CoViewClientMessage,
  CoViewDeps,
  CoViewHandle,
  CoViewSessionInternal,
} from "./types";

export function startCoView(deps: CoViewDeps): CoViewHandle {
  const log = deps.logger.child({ component: "co-view" });
  const registry = new CoViewRegistry();
  const now = deps.now ?? Date.now;
  const setTimer =
    deps.setTimeout ??
    ((fn, ms) => setTimeout(fn, ms));
  const clearTimer =
    deps.clearTimeout ??
    ((handle) => clearTimeout(handle));
  const generateSessionId =
    deps.generateSessionId ?? (() => crypto.randomUUID());

  const ctx: CoViewContext = {
    deps,
    registry,
    log,
    now,
    setTimer,
    clearTimer,
    generateSessionId,
    listSubscribers: new Map(),
  };

  async function dispatch(
    connectionId: string,
    message: CoViewClientMessage,
  ): Promise<void> {
    switch (message.type) {
      case "co-view.start.req":
        handleStart(ctx, message, connectionId);
        return;
      case "co-view.update.req":
        handleUpdate(ctx, message, connectionId);
        return;
      case "co-view.end.req":
        handleEnd(ctx, message, connectionId);
        return;
      case "co-view.join.req":
        handleJoin(ctx, message, connectionId);
        return;
      case "co-view.leave.req":
        handleLeave(ctx, message, connectionId);
        return;
      case "co-view.kick.req":
        handleKick(ctx, message, connectionId);
        return;
      case "co-view.list.req":
        handleList(ctx, message, connectionId);
        return;
      case "co-view.state":
        handleState(ctx, message, connectionId);
        return;
      case "co-view.event":
        handleEvent(ctx, message, connectionId);
        return;
      case "co-view.cursor":
        handleCursor(ctx, message, connectionId);
        return;
      case "co-view.snapshot.req":
        handleSnapshotReq(ctx, message, connectionId);
        return;
      case "co-view.snapshot.res":
        handleSnapshotRes(ctx, message, connectionId);
        return;
    }
  }

  function onConnectionClose(connectionId: string): void {
    handleConnectionClose(ctx, connectionId);
  }

  let disposed = false;
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    // Clear any pending grace timers so they can't fire after shutdown.
    for (const session of registry.list()) {
      if (session.hostDisconnectTimer !== null) {
        clearTimer(session.hostDisconnectTimer);
        session.hostDisconnectTimer = null;
      }
    }
  }

  return {
    dispatch,
    onConnectionClose,
    _internals: () => {
      const ro = registry.asReadOnly();
      return {
        sessions: ro.sessions as ReadonlyMap<string, CoViewSessionInternal>,
        sessionByHostConnection: ro.sessionByHostConnection,
      };
    },
    dispose,
  };
}
