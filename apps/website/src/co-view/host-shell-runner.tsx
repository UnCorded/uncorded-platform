// Co-View host shell runner (spec-27 PR-CV5).
//
// Mounted by App.tsx wrapped in <CoViewHostProvider>. Owns the lifecycle of
// every host-side mover-of-bytes for an active host session:
//   - the state producer (coalesced co-view.state diffs)
//   - the host controller (auto-instrumented primitives → state mutations)
//   - the cursor producer (≤30 Hz pointer frames)
//   - the pen producer (host-side annotation strokes)
//
// Renders nothing visible — pure orchestration. The provider's controller
// prop comes from this component via a setter passed in from App.tsx.
//
// Pause behavior: when the runtime flips `paused: true` (via update.req or
// update.req-from-self), the producer's notify becomes a no-op so we don't
// burn WS budget on diffs the runtime is dropping anyway. Cursor + pen
// producers also gate locally; the runtime is the integrity layer (drops
// host frames while paused — see spec-27 §Pause is runtime-enforced).

import { createEffect, onCleanup, type JSX } from "solid-js";

import {
  createCoViewHostController,
  type CoViewEventEmitter,
  type CoViewHostController,
} from "./host-context";
import { createCoViewProducer } from "./producer";
import { createCursorProducer } from "./cursor-producer";
import { createPenProducer } from "./pen-producer";
import {
  sendCoViewCursor,
  sendCoViewEvent,
  sendCoViewSnapshotRes,
  sendCoViewState,
} from "./client";
import type { CoViewSessionPushFrame } from "./client";
import { observeCoViewSession } from "./client";

export interface HostShellRunnerProps {
  /** Active server's id; the producer's send() routes through its WS. */
  serverId: string;
  /** Active host session id (from start.ack). */
  sessionId: string;
  /** Whether the host has paused the session. When true, suppresses all outbound state/event/cursor/pen frames. */
  paused: boolean;
  /** Callback invoked once the controller is ready, so App.tsx can pipe it into <CoViewHostProvider>. */
  onControllerReady: (controller: CoViewHostController | null) => void;
  /**
   * Called when the runtime broadcasts `co-view.ended` for this session — i.e.
   * the host disconnected past the grace window or the session was forcibly
   * ended server-side. App.tsx clears its hosting signal in response so the
   * sheet flips back to the default view and HostShellRunner unmounts.
   * NOT called for user-initiated `endCoView` — the sheet handles that path
   * locally by clearing its own hosting signal.
   */
  onSessionEnded?: (() => void) | undefined;
}

/**
 * Mount-point for host-side wire activity. Returns null — App.tsx places this
 * inside the existing render tree just so it gets mount/cleanup lifecycle
 * tied to the active session id.
 */
export function HostShellRunner(props: HostShellRunnerProps): JSX.Element {
  // Re-build the entire stack whenever serverId or sessionId changes (new
  // session, new connection). Pause changes are handled in-place by the
  // gating closures below — no rebuild.
  createEffect(() => {
    const serverId = props.serverId;
    const sessionId = props.sessionId;

    // Forward-reference: the controller needs notify/emitEvent from the
    // producer, but the producer needs getShellState from the controller.
    // Init the controller with placeholders, then patch them after the
    // producer is constructed.
    let producerNotify: () => void = () => {};
    let producerEmitEvent: CoViewEventEmitter = () => {};

    const { controller, getShellState } = createCoViewHostController({
      notify: () => producerNotify(),
      emitEvent: (kind, payload, replay) => producerEmitEvent(kind, payload, replay),
    });

    const producer = createCoViewProducer({
      sessionId,
      getShellState,
      send: (frame) => {
        // Pause hygiene — runtime drops these anyway while paused, but
        // dropping at the source saves bandwidth and queue pressure.
        if (props.paused) return;
        if (frame.type === "co-view.state") {
          sendCoViewState(serverId, frame);
        } else if (frame.type === "co-view.event") {
          sendCoViewEvent(serverId, frame);
        } else {
          // co-view.snapshot.res
          sendCoViewSnapshotRes(serverId, frame);
        }
      },
    });

    producerNotify = () => {
      if (props.paused) return;
      producer.notify();
    };
    producerEmitEvent = (kind, payload, replay) => {
      if (props.paused) return;
      producer.emitEvent(kind, payload, replay);
    };

    // Cursor producer — host's cursor on its own viewport is identity (no
    // overlay scaling), no menu-open hookup required (the host shell sees
    // its own popovers via the controller's isMenuOpen).
    const cursorProducer = createCursorProducer({
      sessionId,
      send: (frame) => {
        if (props.paused) return;
        sendCoViewCursor(serverId, frame);
      },
      isMenuOpen: () => controller.isMenuOpen(),
    });

    // Pen producer — host-only `clearAll` is allowed; the runtime drops
    // scope:"all" pen.clear from non-hosts. `isHost` is hard-coded true
    // here because this runner only mounts for the active host.
    const penProducer = createPenProducer({
      sessionId,
      send: (frame) => {
        if (props.paused) return;
        sendCoViewEvent(serverId, frame);
      },
      isHost: () => true,
    });

    // Forward inbound co-view.snapshot.req frames to the producer so the
    // host can answer mid-session viewer joins / gap recoveries.
    const unsubSession = observeCoViewSession(serverId, sessionId, (frame: CoViewSessionPushFrame) => {
      if (frame.type === "co-view.snapshot.req") {
        producer.handleSnapshotReq(frame);
        return;
      }
      if (frame.type === "co-view.ended") {
        props.onSessionEnded?.();
      }
    });

    props.onControllerReady(controller);

    onCleanup(() => {
      unsubSession();
      producer.dispose();
      cursorProducer.dispose();
      penProducer.dispose();
      props.onControllerReady(null);
    });
  });

  return null;
}
