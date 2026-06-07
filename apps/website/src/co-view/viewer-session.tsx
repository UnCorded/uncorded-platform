// Co-View viewer session mount (spec-27 PR-CV5).
//
// Renders <CoViewViewerOverlay> inside a fixed top-right floating window
// when the local user has joined a viewer session. Owns:
//   - the consumer (state snapshot, cursor + stroke maps, gap recovery)
//   - the cursor producer (viewer's cursor inside the overlay → server)
//   - the pen producer (viewer's annotation strokes — not host-only clear)
//   - the inbound subscription that routes per-session frames into apply*
//   - a "Leave" button that calls coViewClient.leave()
//
// One viewer session per server connection (per spec-27 §UX); App.tsx
// enforces this by allowing only one ViewerSession to mount at a time.

import { createSignal, createEffect, onCleanup, Show, type JSX } from "solid-js";
import type {
  CoViewStateSnapshot,
  WsCoViewState,
  WsCoViewEvent,
  WsCoViewCursor,
  WsCoViewMemberJoined,
  WsCoViewMemberLeft,
  WsCoViewSnapshotRes,
} from "@uncorded/protocol";

import { createCoViewConsumer } from "./consumer";
import { createCursorProducer } from "./cursor-producer";
import { createPenProducer } from "./pen-producer";
import { CoViewViewerOverlay } from "./viewer-overlay";
import {
  leaveCoView,
  observeCoViewSession,
  sendCoViewCursor,
  sendCoViewEvent,
  sendCoViewSnapshotReq,
  type CoViewSessionPushFrame,
} from "./client";

const DEFAULT_WIDTH = 480;
const DEFAULT_HEIGHT = 300;

export interface ViewerSessionProps {
  serverId: string;
  sessionId: string;
  /** Snapshot delivered with `co-view.join.ack` so the overlay paints immediately. */
  initialSnapshot: CoViewStateSnapshot | null;
  /** Whether the local viewer is the host (true when watching your own session). */
  isHost?: boolean;
  /** Called after `coViewClient.leave` resolves OR when the session ends remotely. */
  onLeft: () => void;
  /** Optional dimension overrides — defaults to a 480×300 floating window. */
  width?: number;
  height?: number;
}

export function ViewerSession(props: ViewerSessionProps): JSX.Element {
  // Mount state — banner messages for "session ended", "you were removed", etc.
  const [endedBanner, setEndedBanner] = createSignal<string | null>(null);
  // Hold the overlay element ref so the cursor + pen producers can clamp
  // pointer coordinates to it.
  let overlayContainer: HTMLDivElement | undefined;

  createEffect(() => {
    const serverId = props.serverId;
    const sessionId = props.sessionId;

    const consumer = createCoViewConsumer({
      sessionId,
      send: (req) => sendCoViewSnapshotReq(serverId, req),
      seedSnapshot: props.initialSnapshot,
    });

    // Viewer-side cursor producer: pointer events captured on the overlay
    // element get translated through the live overlay transform (scale +
    // letterbox offset) into host-viewport CSS pixels before sending.
    const cursorProducer = createCursorProducer({
      sessionId,
      send: (frame) => sendCoViewCursor(serverId, frame),
      getOverlayEl: () => overlayContainer ?? null,
    });

    // Viewer pen producer — same overlay translation. `isHost` is whatever
    // App passed in (false for the common viewer case). The runtime drops
    // scope:"all" pen.clear from non-hosts; locally we still allow toggle.
    const penProducer = createPenProducer({
      sessionId,
      send: (frame) => sendCoViewEvent(serverId, frame),
      getOverlayEl: () => overlayContainer ?? null,
      isHost: () => props.isHost === true,
    });

    const unsub = observeCoViewSession(serverId, sessionId, (frame: CoViewSessionPushFrame) => {
      switch (frame.type) {
        case "co-view.state":
          consumer.applyStateFrame(frame as WsCoViewState);
          return;
        case "co-view.event":
          consumer.applyEventFrame(frame as WsCoViewEvent);
          return;
        case "co-view.cursor":
          consumer.applyCursorFrame(frame as WsCoViewCursor);
          return;
        case "co-view.member.joined":
          consumer.applyMemberJoined(frame as WsCoViewMemberJoined);
          return;
        case "co-view.member.left":
          consumer.applyMemberLeft(frame as WsCoViewMemberLeft);
          // If we got member_left for ourselves (kicked / no-longer-invited /
          // blacklisted), tear down. The runtime broadcasts member_left to
          // every member including the departing one, so this fires for the
          // local viewer when they're evicted.
          // We can't easily compare user_id here — onLeft propagates the
          // teardown decision up to App.tsx which knows whose session this is.
          return;
        case "co-view.ended":
          setEndedBanner("Session ended");
          // Brief UI grace period so the user sees the banner before the
          // overlay disappears. App.tsx does the actual unmount on onLeft.
          setTimeout(() => {
            props.onLeft();
          }, 1_500);
          return;
        case "co-view.snapshot.res":
          consumer.applySnapshotRes(frame as WsCoViewSnapshotRes);
          return;
        case "co-view.snapshot.req":
          // Viewer never receives snapshot.req — runtime addresses these
          // to the host only. Defensive ignore.
          return;
      }
    });

    onCleanup(() => {
      unsub();
      cursorProducer.dispose();
      penProducer.dispose();
      consumer.dispose();
    });

    // Stash for the JSX below to render the overlay against the consumer.
    setRuntime({ consumer, penProducer });
  });

  const [runtime, setRuntime] = createSignal<{
    consumer: ReturnType<typeof createCoViewConsumer>;
    penProducer: ReturnType<typeof createPenProducer>;
  } | null>(null);

  async function handleLeaveClick(): Promise<void> {
    try {
      await leaveCoView(props.serverId, props.sessionId);
    } catch (err) {
      console.warn("[co-view] leave failed", err);
    } finally {
      props.onLeft();
    }
  }

  const width = () => props.width ?? DEFAULT_WIDTH;
  const height = () => props.height ?? DEFAULT_HEIGHT;

  return (
    <div
      data-testid="co-view-viewer-session"
      style={{
        position: "fixed",
        top: "16px",
        right: "16px",
        "z-index": "60",
        display: "flex",
        "flex-direction": "column",
        gap: "6px",
      }}
    >
      <div
        ref={overlayContainer}
        style={{
          position: "relative",
          width: `${width()}px`,
          height: `${height()}px`,
        }}
      >
        <Show when={runtime()}>
          {(rt) => (
            <CoViewViewerOverlay
              consumer={rt().consumer}
              penProducer={rt().penProducer}
              isHost={props.isHost === true}
              width={width()}
              height={height()}
            />
          )}
        </Show>
        <Show when={endedBanner()}>
          <div
            style={{
              position: "absolute",
              inset: "0",
              display: "flex",
              "align-items": "center",
              "justify-content": "center",
              background: "rgba(0,0,0,0.55)",
              color: "white",
              "font-size": "14px",
              "border-radius": "8px",
              "pointer-events": "none",
            }}
          >
            {endedBanner()}
          </div>
        </Show>
      </div>
      <div style={{ display: "flex", "justify-content": "flex-end" }}>
        <button
          type="button"
          onClick={() => void handleLeaveClick()}
          style={{
            padding: "4px 12px",
            "font-size": "12px",
            "border-radius": "4px",
            border: "1px solid var(--border, #1f2937)",
            background: "var(--background, #0b0f17)",
            color: "var(--foreground, white)",
            cursor: "pointer",
          }}
        >
          Leave
        </button>
      </div>
    </div>
  );
}
