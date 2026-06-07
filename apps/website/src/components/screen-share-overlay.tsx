// ScreenShareOverlay — top-level shell component that paints `<video>`
// elements over the rectangles plugin iframes report via the
// `platform.voice.register-screen-slot` envelope.
//
// Why shell-side:
//   - The shell owns the LiveKit `Room` (PR-5 §17 / PR-6 plan trust boundary).
//   - Cross-origin sandboxed iframes can't receive `MediaStream` postMessage
//     transfers reliably (Firefox + Safari refuse; Chromium accepts but the
//     production path needs the lowest common denominator).
//   - Solution: shell paints `<video>` elements aligned to per-iframe slot
//     rectangles, projected visually into the iframe. The iframe stays a
//     pure presentation/intent layer — it never holds a MediaStream.
//
// Z-stack (matches portal-container.tsx; explicit constants in `<style>`):
//   z-index: 40   portal iframes (PortalContainer)
//   z-index: 41   screen-share <video> (this component) — `pointer-events:none`
//   z-index: 42   per-tile control overlay (mute, volume, popout, fullscreen)
//                 — `pointer-events: auto` so controls work, video underneath
//                 stays click-through to the iframe roster
//
// The video itself sets `pointer-events: none` so clicks (e.g. on a roster
// row underneath in the iframe) pass through. Hover affordances live on a
// sibling layer with `pointer-events: auto` — that's the only layer that
// captures pointer input.
//
// Placeholder for popped-out tiles: a "Watching in popout" badge replaces
// the video while the publisher's `trackSid` is in the popout set.

import {
  For,
  Index,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import type { Accessor } from "solid-js";
import type { Room, RemoteVideoTrack } from "livekit-client";
import * as voiceManager from "@/lib/voice-manager";
import type { ScreenShareSlotEntry } from "@/lib/voice-manager";
import * as portalHost from "@/lib/portal-host";

// Stable shape per slot — recomputed only when the slot list, room identity,
// or voice state envelope changes. The per-tick rect translation is *not*
// folded in here; doing so would create a fresh object every rAF frame and
// force `<Index>`'s child accessor to fire on every animation frame, which
// would in turn re-attach the LiveKit track and reset the <video>. The rect
// reads layoutTick locally inside VideoSlot.
interface SlotShape {
  entry: ScreenShareSlotEntry;
  track: RemoteVideoTrack | null;
  popped: boolean;
}

interface OverlayRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function intersectRect(a: OverlayRect, b: OverlayRect): OverlayRect {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return {
    x: left,
    y: top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

function findScreenShareVideoTrack(
  room: Room | null,
  trackSid: string,
): RemoteVideoTrack | null {
  if (!room) return null;
  for (const p of room.remoteParticipants.values()) {
    for (const pub of p.videoTrackPublications.values()) {
      if (pub.trackSid !== trackSid) continue;
      if (pub.source !== "screen_share") continue;
      // RemoteParticipant.videoTrackPublications.values() yields
      // RemoteTrackPublication, whose `videoTrack` is RemoteVideoTrack — but
      // the iterator widens to the participant base type. Narrow back here;
      // the source guard above guarantees we're on a remote pub.
      const track = pub.videoTrack as RemoteVideoTrack | undefined;
      return track ?? null;
    }
  }
  return null;
}

function VideoSlot(props: {
  shape: Accessor<SlotShape>;
  layoutTick: Accessor<number>;
  onFullscreen: (trackSid: string) => void;
}) {
  let videoRef: HTMLVideoElement | undefined;

  // Per-slot reactive rect: recomputes every layoutTick AND every shape
  // change, but the recompute only writes left/top/width/height to the
  // existing DOM nodes. The <video> element and its attached LiveKit track
  // are NOT recreated, so playback stays continuous as the user scrolls.
  //
  // Anchor on portal-host's placeholder rect. The slot rect is iframe-local;
  // after projecting it into shell coordinates, clamp it to the iframe mount
  // rect so resize/scroll races can never paint video outside the plugin panel.
  const shellRect = createMemo(() => {
    props.layoutTick();
    const shape = props.shape();
    const r = shape.entry.rect;
    const mountRect = portalHost.getMountRect(shape.entry.frameKey);
    const frameRect = mountRect
      ? { x: mountRect.x, y: mountRect.y, width: mountRect.w, height: mountRect.h }
      : shape.entry.iframe.getBoundingClientRect();
    // Hide if the iframe isn't laid out yet (zero box). Otherwise overlays
    // would flash at the slot rect's iframe-local coordinates with no offset.
    if (frameRect.width === 0 || frameRect.height === 0) {
      return { x: 0, y: 0, width: 0, height: 0 };
    }
    return intersectRect(
      { x: r.x + frameRect.x, y: r.y + frameRect.y, width: r.width, height: r.height },
      frameRect,
    );
  });

  // Memoize the track reference so the attach/detach effect only re-runs when
  // the actual RemoteVideoTrack identity changes (publisher republish after
  // reconnect → fresh trackSid). Without this memo, every shapes() recompute
  // fires the shape() accessor, which would re-run the effect, which clears
  // el.srcObject in cleanup before re-attaching — the video never gets time to
  // paint. createMemo's default Object.is equality dedupes stable references.
  const track = createMemo<RemoteVideoTrack | null>(() => props.shape().track);
  const videoRect = createMemo(() => {
    const r = shellRect();
    const controlStrip = Math.min(48, Math.max(0, r.height * 0.32));
    return { ...r, height: Math.max(0, r.height - controlStrip) };
  });

  // Attach the LiveKit RemoteVideoTrack to the <video> element. createEffect
  // re-runs whenever the resolved track identity changes (e.g. publisher
  // republishes after reconnect → fresh trackSid). LiveKit's track.attach()
  // is idempotent: passing an already-attached element is a no-op, but
  // detaching is required when we lose the reference.
  createEffect(() => {
    const t = track();
    const el = videoRef;
    if (!el) return;
    if (!t) return;
    t.attach(el);
    onCleanup(() => {
      t.detach(el);
    });
  });

  return (
    <div
      style={{
        position: "absolute",
        left: `${videoRect().x}px`,
        top: `${videoRect().y}px`,
        width: `${videoRect().width}px`,
        height: `${videoRect().height}px`,
        // Tiles position over iframe content; pointer-events: none here so
        // clicks pass through to the iframe roster underneath. The control
        // overlay (sibling layer, not a child) holds pointer-events: auto.
        "pointer-events": "none",
        "z-index": "41",
      }}
    >
      <Show
        when={!props.shape().popped}
        fallback={
          <div
            style={{
              display: "flex",
              "align-items": "center",
              "justify-content": "center",
              width: "100%",
              height: "100%",
              background: "rgba(0,0,0,0.65)",
              color: "rgba(255,255,255,0.85)",
              "font-size": "13px",
              "font-weight": "500",
              "border-radius": "8px",
              "pointer-events": "none",
            }}
          >
            Watching in popout
          </div>
        }
      >
        <video
          ref={(el) => {
            videoRef = el;
          }}
          autoplay
          playsinline
          muted
          // The audio peer is published as a separate `screen_share_audio`
          // track and attached as a hidden <audio> in voice-manager. Muting
          // the <video> avoids accidentally double-playing the share audio.
          style={{
            position: "absolute",
            inset: "0",
            width: "100%",
            height: "100%",
            "object-fit": "contain",
            background: "#000",
            "border-radius": "8px",
            // Same as parent — clicks pass through. The control overlay is
            // a separate sibling with pointer-events: auto.
            "pointer-events": "none",
          }}
        />
      </Show>
      <button
        type="button"
        aria-label="Fullscreen"
        data-tooltip="Fullscreen"
        data-tooltip-side="left"
        onClick={() => {
          props.onFullscreen(props.shape().entry.trackSid);
        }}
        style={{
          position: "absolute",
          right: "10px",
          top: "10px",
          width: "30px",
          height: "30px",
          display: "grid",
          "place-items": "center",
          background: "rgba(0,0,0,0.58)",
          color: "#fff",
          border: "1px solid rgba(255,255,255,0.2)",
          "border-radius": "6px",
          "backdrop-filter": "blur(8px)",
          cursor: "pointer",
          "pointer-events": "auto",
          "z-index": "42",
        }}
      >
        <svg
          viewBox="0 0 24 24"
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <polyline points="15 3 21 3 21 9" />
          <polyline points="9 21 3 21 3 15" />
          <line x1="21" x2="14" y1="3" y2="10" />
          <line x1="3" x2="10" y1="21" y2="14" />
        </svg>
      </button>
    </div>
  );
}

export function ScreenShareOverlay() {
  // Iframe positions (slot rect is iframe-local; we add the iframe's
  // shell-viewport offset before painting). Re-tick on scroll/resize so the
  // overlay tracks iframe movement — slot envelopes only fire on
  // *iframe-internal* layout changes, so window scroll inside the shell would
  // otherwise leave the overlay stuck at the old offset.
  const [layoutTick, setLayoutTick] = createSignal(0);
  const [fullscreenTrackSid, setFullscreenTrackSid] = createSignal<string | null>(null);

  onMount(() => {
    const bump = (): void => {
      setLayoutTick((n) => n + 1);
    };
    window.addEventListener("scroll", bump, { passive: true, capture: true });
    window.addEventListener("resize", bump);
    let raf = requestAnimationFrame(function tick() {
      bump();
      raf = requestAnimationFrame(tick);
    });
    onCleanup(() => {
      window.removeEventListener("scroll", bump, { capture: true } as EventListenerOptions);
      window.removeEventListener("resize", bump);
      cancelAnimationFrame(raf);
    });
  });

  createEffect(() => {
    const active = fullscreenTrackSid() !== null;
    if (!active) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setFullscreenTrackSid(null);
    };
    document.addEventListener("keydown", onKeyDown);
    onCleanup(() => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
    });
  });

  // Slot shapes — pure (slot, track, popped) tuples. No layoutTick dep here;
  // the per-frame rect computation lives inside VideoSlot. Reads:
  //   - screenShareSlots$       slot registrations from plugin iframes
  //   - activeRoom$              room identity (so reconnect re-resolves tracks)
  //   - screenShareTrackVersion$ bumps on TrackSubscribed/Unsubscribed for
  //                              screen-share so the lazy track resolution
  //                              re-runs once the SFU delivers the stream
  //   - screenSharePoppedOut$    actual user-popped state (NOT track absence —
  //                              treating null-track as popped flashes a
  //                              "Watching in popout" placeholder during the
  //                              normal subscribe→deliver window)
  const shapes = createMemo<SlotShape[]>(() => {
    const slots = voiceManager.screenShareSlots$();
    const room = voiceManager.activeRoom$();
    voiceManager.screenShareTrackVersion$();
    const poppedOut = voiceManager.screenSharePoppedOut$();
    const out: SlotShape[] = [];
    for (const entry of slots) {
      const track = findScreenShareVideoTrack(room, entry.trackSid);
      out.push({ entry, track, popped: poppedOut.has(entry.trackSid) });
    }
    return out;
  });

  // Popped tracks (track must be resolved — the fullscreen layer can't paint
  // a null-track <video>). Filtered into a stable array of resolved shapes;
  // `<For>` keys by reference, so a shape with a stable RemoteVideoTrack
  // identity survives unrelated shapes() recomputes.
  const poppedShapes = createMemo<SlotShape[]>(() =>
    shapes().filter((s) => s.popped && s.track !== null),
  );

  const fullscreenShape = createMemo<SlotShape | null>(() => {
    const sid = fullscreenTrackSid();
    if (sid === null) return null;
    return shapes().find((s) => s.entry.trackSid === sid && s.track !== null) ?? null;
  });

  return (
    <>
      <div
        data-screen-share-overlay
        aria-hidden="true"
        style={{
          position: "fixed",
          inset: "0",
          // Container itself is click-through; child tiles also click-through
          // (the video element) — only the controls layer captures input.
          "pointer-events": "none",
          "z-index": "41",
        }}
      >
        {/* `<Index>` keys by position, not by reference identity. That keeps
            each VideoSlot mounted across `shapes()` recomputations — a fresh
            SlotShape object at the same index does NOT remount the slot, it
            just updates the inner accessor. `<For>` would unmount/remount
            every time, recreating the <video> and re-attaching the track,
            which is the bug that left tiles stuck on a black frame. */}
        <Index each={shapes()}>
          {(shape) => (
            <VideoSlot
              shape={shape}
              layoutTick={layoutTick}
              onFullscreen={setFullscreenTrackSid}
            />
          )}
        </Index>
      </div>
      {/* Expanded popouts stay visually bounded to the plugin iframe. The
          shell still owns the <video> element, but it no longer takes over
          the whole app viewport. */}
      <For each={poppedShapes()}>
        {(shape) => <PopoutTile shape={shape} layoutTick={layoutTick} />}
      </For>
      <Show when={fullscreenShape()}>
        {(shape) => (
          <FullscreenTile
            shape={shape()}
            onClose={() => setFullscreenTrackSid(null)}
          />
        )}
      </Show>
    </>
  );
}

function FullscreenTile(props: { shape: SlotShape; onClose: () => void }) {
  let videoRef: HTMLVideoElement | undefined;
  const track = props.shape.track;

  onMount(() => {
    if (track && videoRef) track.attach(videoRef);
  });
  onCleanup(() => {
    if (track && videoRef) track.detach(videoRef);
  });

  return (
    <div
      data-screen-share-fullscreen
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed",
        inset: "0",
        width: "100vw",
        height: "100dvh",
        display: "flex",
        "align-items": "center",
        "justify-content": "center",
        background: "#000",
        "z-index": "100",
        "pointer-events": "auto",
      }}
    >
      <video
        ref={(el) => {
          videoRef = el;
        }}
        autoplay
        playsinline
        muted
        style={{
          width: "100%",
          height: "100%",
          "object-fit": "contain",
          background: "#000",
        }}
      />
      <button
        type="button"
        aria-label="Exit fullscreen"
        data-tooltip="Exit fullscreen"
        data-tooltip-side="left"
        onClick={props.onClose}
        style={{
          position: "absolute",
          right: "max(12px, env(safe-area-inset-right))",
          top: "max(12px, env(safe-area-inset-top))",
          width: "38px",
          height: "38px",
          display: "grid",
          "place-items": "center",
          background: "rgba(0,0,0,0.62)",
          color: "#fff",
          border: "1px solid rgba(255,255,255,0.24)",
          "border-radius": "8px",
          "backdrop-filter": "blur(8px)",
          cursor: "pointer",
          "z-index": "101",
        }}
      >
        <svg
          viewBox="0 0 24 24"
          width="16"
          height="16"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <line x1="18" x2="6" y1="6" y2="18" />
          <line x1="6" x2="18" y1="6" y2="18" />
        </svg>
      </button>
    </div>
  );
}

function PopoutTile(props: { shape: SlotShape; layoutTick: Accessor<number> }) {
  let videoRef: HTMLVideoElement | undefined;
  const trackSid = props.shape.entry.trackSid;
  const track = props.shape.track;
  const frameRect = createMemo(() => {
    props.layoutTick();
    const mountRect = portalHost.getMountRect(props.shape.entry.frameKey);
    const r = mountRect
      ? { x: mountRect.x, y: mountRect.y, width: mountRect.w, height: mountRect.h }
      : props.shape.entry.iframe.getBoundingClientRect();
    const pad = 12;
    const availableWidth = Math.max(0, r.width - pad * 2);
    const availableHeight = Math.max(0, r.height - pad * 2);
    const maxWidth = 1280;
    const maxHeight = 820;
    const width = Math.min(availableWidth, maxWidth);
    const height = Math.min(availableHeight, maxHeight);
    return {
      x: r.x + pad + Math.max(0, (availableWidth - width) / 2),
      y: r.y + pad + Math.max(0, (availableHeight - height) / 2),
      width,
      height,
    };
  });
  // No need for createEffect-on-track here: For keys by reference, so this
  // component only mounts when the resolved (track !== null) shape arrives,
  // and unmounts when the user docks. attach() is idempotent and the cleanup
  // detaches from the captured element only.
  onMount(() => {
    if (track && videoRef) track.attach(videoRef);
  });
  onCleanup(() => {
    if (track && videoRef) track.detach(videoRef);
  });

  return (
    <div
      data-screen-share-popout-layer
      style={{
        position: "fixed",
        left: `${frameRect().x}px`,
        top: `${frameRect().y}px`,
        width: `${frameRect().width}px`,
        height: `${frameRect().height}px`,
        display: "flex",
        "align-items": "center",
        "justify-content": "center",
        background: "rgba(8, 10, 14, 0.96)",
        border: "1px solid rgba(255,255,255,0.12)",
        "border-radius": "10px",
        "box-shadow": "0 18px 60px rgba(0,0,0,0.45)",
        overflow: "hidden",
        "z-index": "50",
      }}
    >
      <video
        ref={(el) => {
          videoRef = el;
        }}
        autoplay
        playsinline
        muted
        style={{
          width: "100%",
          height: "100%",
          "object-fit": "contain",
          background: "#000",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: "12px",
          right: "12px",
          bottom: "12px",
          height: "42px",
          background: "linear-gradient(180deg, rgba(10,12,16,0.56), rgba(10,12,16,0.84))",
          border: "1px solid rgba(255,255,255,0.12)",
          "border-radius": "8px",
          "backdrop-filter": "blur(10px)",
          "pointer-events": "none",
        }}
      />
      <button
        type="button"
        onClick={() => voiceManager.dockScreenShare(trackSid)}
        style={{
          position: "absolute",
          bottom: "18px",
          right: "12px",
          background: "rgba(255,255,255,0.08)",
          color: "#fff",
          border: "1px solid rgba(255,255,255,0.2)",
          "border-radius": "6px",
          padding: "6px 12px",
          "font-size": "13px",
          "font-weight": "500",
          cursor: "pointer",
        }}
      >
        Close popout
      </button>
    </div>
  );
}
