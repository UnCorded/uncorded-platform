// Viewer-side Co-View overlay shell (spec-27 PR-CV3 §Locked Decisions
// "Overlay-contained viewer").
//
// A sized HTML container that holds the host's viewport at fixed host-pixel
// dimensions and CSS-`transform: scale(...)` to fit. The viewer's own shell,
// sidebar, and current panels remain interactive around the overlay — this
// component is layout-agnostic about its own placement; callers position it.
//
// What renders inside:
//   - Route placeholder (shows the host's pathname; the actual viewer-side
//     plugin frontends fetch under the viewer's own JWT in the live wiring,
//     so PR-CV3 paints a structural surface that the future router swap will
//     replace verbatim).
//   - Workspace panel-tree skeleton honoring host's split ratios + per-panel
//     `coView` visibility (shared / skeleton / hidden).
//   - Modal stack overlays (host's open modals, with redacted text where the
//     producer flagged it).
//   - Popover and context-menu indicators.
//
// PR-CV4 extension: cursor + pen layers + a minimal toolbar. The producers
// publish frames the runtime forwards to viewers; this overlay reads the
// resulting `cursors` / `strokes` / `memberMeta` accessors on the consumer.
//
// What does NOT render here (deferred):
//   - Live plugin iframes under the viewer's identity — wired in PR-CV5
//     when the start-session UX exists; until then the panels paint as
//     structural skeletons so we can verify state-sync end-to-end.
//   - Polished member roster (uses PR-Avatar's <AvatarStack>) — wire-up
//     happens in PR-CV5 alongside the start-session sidebar entry.

import {
  For,
  Show,
  createMemo,
  createSignal,
  onCleanup,
  type JSX,
} from "solid-js";
import { getStroke } from "perfect-freehand";

import type { PanelContent } from "@uncorded/protocol";

import type { CoViewConsumer, CursorEntry, StrokeEntry } from "./consumer";
import { CURSOR_SHAPES } from "./cursor-shapes";
import type { PenProducer } from "./pen-producer";
import type {
  CoViewModalEntry,
  CoViewPanelMeta,
  CoViewPanelVisibility,
  CoViewShellState,
} from "./state-schema";
import type { PanelNode } from "../lib/panel-layout";

const HOST_VIEWPORT = { width: 1440, height: 900 } as const;
/** Color used when a cursor/stroke arrives before its member.joined. */
const FALLBACK_COLOR = "rgba(180, 180, 180, 0.85)";

export interface ViewerOverlayProps {
  consumer: CoViewConsumer;
  /** Outer dimensions — the overlay scales the host viewport to fit these. */
  width: number;
  height: number;
  /**
   * Optional pen producer — when provided, the overlay renders the toolbar
   * (pen toggle + clear). When omitted, the overlay is read-only.
   */
  penProducer?: PenProducer;
  /** True if the local viewer is the session host. Toggles `Clear all`. */
  isHost?: boolean;
}

export function CoViewViewerOverlay(props: ViewerOverlayProps): JSX.Element {
  const snapshot = () => props.consumer.snapshot() as CoViewShellState;

  const scale = createMemo(() => {
    const sx = props.width / HOST_VIEWPORT.width;
    const sy = props.height / HOST_VIEWPORT.height;
    return Math.min(sx, sy);
  });

  const offset = createMemo(() => {
    const s = scale();
    const usedW = HOST_VIEWPORT.width * s;
    const usedH = HOST_VIEWPORT.height * s;
    return {
      x: Math.max(0, (props.width - usedW) / 2),
      y: Math.max(0, (props.height - usedH) / 2),
    };
  });

  return (
    <div
      data-testid="co-view-viewer-overlay"
      style={{
        position: "relative",
        width: `${props.width}px`,
        height: `${props.height}px`,
        overflow: "hidden",
        background: "var(--background, #0b0f17)",
        "border-radius": "8px",
        border: "1px solid var(--border, #1f2937)",
      }}
    >
      <div
        style={{
          position: "absolute",
          left: `${offset().x}px`,
          top: `${offset().y}px`,
          width: `${HOST_VIEWPORT.width}px`,
          height: `${HOST_VIEWPORT.height}px`,
          transform: `scale(${scale()})`,
          "transform-origin": "top left",
        }}
      >
        <Show
          when={Object.keys(snapshot()).length > 0}
          fallback={<EmptyStateOverlay />}
        >
          <RouteHeader pathname={snapshot().route?.pathname} />
          <WorkspaceCanvas snapshot={snapshot()} />
          <ModalStackOverlay modals={snapshot().modals} />
          <PopoverIndicator count={snapshot().popovers?.length ?? 0} />
          <ContextMenuIndicator count={snapshot().contextMenus?.length ?? 0} />
        </Show>
        <PenLayer
          strokes={props.consumer.strokes}
          memberMeta={props.consumer.memberMeta}
        />
        <CursorLayer
          cursors={props.consumer.cursors}
          memberMeta={props.consumer.memberMeta}
        />
      </div>
      <Show when={props.penProducer}>
        {(producer) => (
          <PenToolbar producer={producer()} isHost={!!props.isHost} />
        )}
      </Show>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cursor layer — SVG, one <g> per remote member.
// ---------------------------------------------------------------------------

function CursorLayer(props: {
  cursors: () => ReadonlyMap<string, CursorEntry>;
  memberMeta: () => ReadonlyMap<string, { color: string; name?: string }>;
}): JSX.Element {
  return (
    <svg
      data-testid="co-view-cursor-layer"
      width={HOST_VIEWPORT.width}
      height={HOST_VIEWPORT.height}
      style={{
        position: "absolute",
        inset: "0",
        "pointer-events": "none",
        overflow: "visible",
      }}
    >
      <For each={[...props.cursors().entries()]}>
        {([memberId, entry]) => {
          const meta = props.memberMeta().get(memberId);
          const color = meta?.color ?? FALLBACK_COLOR;
          const name = meta?.name;
          const shape = CURSOR_SHAPES[entry.state];
          return (
            <g
              transform={`translate(${entry.x} ${entry.y})`}
              aria-label={name ? `${name}'s cursor` : `cursor ${memberId}`}
              opacity={shape.opacity ?? 1}
            >
              <path d={shape.d} fill={color} stroke="#000" stroke-width="0.6" />
              <Show when={shape.detail}>
                <path d={shape.detail!} fill={color} opacity={0.8} />
              </Show>
              <Show when={name}>
                <g transform="translate(12 12)">
                  <rect
                    x="0"
                    y="0"
                    width={Math.max(20, name!.length * 6.5 + 8)}
                    height="14"
                    rx="3"
                    fill={color}
                  />
                  <text
                    x="4"
                    y="10"
                    font-family="ui-sans-serif, system-ui, sans-serif"
                    font-size="10"
                    fill="#0b0f17"
                  >
                    {name}
                  </text>
                </g>
              </Show>
            </g>
          );
        }}
      </For>
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Pen layer — canvas, perfect-freehand strokes with TTL fade.
// ---------------------------------------------------------------------------

function PenLayer(props: {
  strokes: () => ReadonlyMap<string, StrokeEntry>;
  memberMeta: () => ReadonlyMap<string, { color: string }>;
}): JSX.Element {
  let canvas: HTMLCanvasElement | undefined;
  let raf: number | undefined;

  function draw(): void {
    raf = undefined;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const meta = props.memberMeta();
    const now = Date.now();
    const TTL = 4000;

    for (const stroke of props.strokes().values()) {
      if (stroke.points.length === 0) continue;
      const color = meta.get(stroke.memberId)?.color ?? FALLBACK_COLOR;

      let alpha = 1;
      if (stroke.completedAt !== null) {
        const age = now - stroke.completedAt;
        if (age >= TTL) continue;
        alpha = Math.max(0, 1 - age / TTL);
      }

      const inputPoints = stroke.points.map((p) => [p.x, p.y, p.p] as [number, number, number]);
      const outline = getStroke(inputPoints, {
        size: 6,
        thinning: 0.6,
        smoothing: 0.5,
        streamline: 0.5,
        last: stroke.completedAt !== null,
      });
      if (outline.length === 0) continue;

      ctx.fillStyle = color;
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      const first = outline[0]!;
      ctx.moveTo(first[0]!, first[1]!);
      for (let i = 1; i < outline.length; i++) {
        const pt = outline[i]!;
        ctx.lineTo(pt[0]!, pt[1]!);
      }
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Keep redrawing while strokes exist (fade animation + in-flight points).
    if (props.strokes().size > 0) scheduleDraw();
  }

  function scheduleDraw(): void {
    if (raf !== undefined) return;
    raf = requestAnimationFrame(draw);
  }

  // Re-schedule on every stroke change.
  createMemo(() => {
    props.strokes();
    scheduleDraw();
  });

  onCleanup(() => {
    if (raf !== undefined) cancelAnimationFrame(raf);
  });

  return (
    <canvas
      data-testid="co-view-pen-layer"
      ref={canvas}
      width={HOST_VIEWPORT.width}
      height={HOST_VIEWPORT.height}
      style={{
        position: "absolute",
        inset: "0",
        "pointer-events": "none",
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Pen toolbar — minimal: toggle + clear buttons. Polished UX in PR-CV5.
// ---------------------------------------------------------------------------

function PenToolbar(props: {
  producer: PenProducer;
  isHost: boolean;
}): JSX.Element {
  const [active, setActive] = createSignal(props.producer.isActive());

  function toggle(): void {
    props.producer.toggle();
    setActive(props.producer.isActive());
  }

  return (
    <div
      data-testid="co-view-pen-toolbar"
      style={{
        position: "absolute",
        bottom: "8px",
        right: "8px",
        display: "flex",
        gap: "4px",
        padding: "4px",
        background: "rgba(15, 23, 42, 0.9)",
        border: "1px solid rgba(124, 58, 237, 0.4)",
        "border-radius": "6px",
      }}
    >
      <button
        type="button"
        onClick={toggle}
        title="Toggle pen (Alt+P)"
        style={{
          padding: "4px 10px",
          background: active() ? "rgba(124, 58, 237, 0.7)" : "transparent",
          color: "white",
          border: "1px solid rgba(124, 58, 237, 0.6)",
          "border-radius": "4px",
          cursor: "pointer",
          "font-size": "12px",
        }}
      >
        {active() ? "Pen on" : "Pen off"}
      </button>
      <button
        type="button"
        onClick={() => props.producer.clearMine()}
        title="Clear my strokes"
        style={{
          padding: "4px 10px",
          background: "transparent",
          color: "white",
          border: "1px solid rgba(124, 58, 237, 0.6)",
          "border-radius": "4px",
          cursor: "pointer",
          "font-size": "12px",
        }}
      >
        Clear mine
      </button>
      <Show when={props.isHost}>
        <button
          type="button"
          onClick={() => props.producer.clearAll()}
          title="Clear everyone's strokes (host only)"
          style={{
            padding: "4px 10px",
            background: "transparent",
            color: "white",
            border: "1px solid rgba(239, 68, 68, 0.6)",
            "border-radius": "4px",
            cursor: "pointer",
            "font-size": "12px",
          }}
        >
          Clear all
        </button>
      </Show>
    </div>
  );
}

function EmptyStateOverlay(): JSX.Element {
  return (
    <div
      style={{
        position: "absolute",
        inset: "0",
        display: "flex",
        "align-items": "center",
        "justify-content": "center",
        color: "rgba(229, 231, 235, 0.6)",
        "font-family": "ui-sans-serif, system-ui, sans-serif",
        "font-size": "16px",
      }}
    >
      Waiting for host state…
    </div>
  );
}

function RouteHeader(props: { pathname: string | undefined }): JSX.Element {
  return (
    <div
      style={{
        position: "absolute",
        top: "0",
        left: "0",
        right: "0",
        height: "32px",
        display: "flex",
        "align-items": "center",
        padding: "0 12px",
        "background": "rgba(15, 23, 42, 0.7)",
        "border-bottom": "1px solid rgba(31, 41, 55, 0.6)",
        "font-family": "ui-monospace, SFMono-Regular, Menlo, monospace",
        "font-size": "12px",
        color: "rgba(229, 231, 235, 0.85)",
      }}
    >
      <span style={{ opacity: "0.55", "margin-right": "6px" }}>route</span>
      <span>{props.pathname ?? "—"}</span>
    </div>
  );
}

function WorkspaceCanvas(props: { snapshot: CoViewShellState }): JSX.Element {
  const ws = () => props.snapshot.workspace;
  const layout = () => {
    const w = ws();
    if (!w) return undefined;
    return w.layouts[w.activeId];
  };
  return (
    <div
      style={{
        position: "absolute",
        top: "32px",
        left: "0",
        right: "0",
        bottom: "0",
        padding: "8px",
      }}
    >
      <Show
        when={layout()}
        fallback={
          <div style={{ opacity: "0.6", color: "rgba(229,231,235,0.7)", "font-family": "ui-sans-serif, system-ui, sans-serif", "font-size": "13px" }}>
            no workspace
          </div>
        }
      >
        {(node) => (
          <PanelNodeView
            node={node()}
            panelMeta={props.snapshot.panelMeta ?? {}}
          />
        )}
      </Show>
    </div>
  );
}

function PanelNodeView(props: {
  node: PanelNode;
  panelMeta: Record<string, CoViewPanelMeta>;
}): JSX.Element {
  const visibility = (id: string): CoViewPanelVisibility =>
    props.panelMeta[id]?.visibility ?? "shared";
  const contentOf = (id: string): PanelContent | undefined =>
    props.panelMeta[id]?.content;

  return (
    <Show
      when={props.node.type === "split"}
      fallback={
        <LeafPanel
          id={(props.node as { id: string }).id}
          visibility={visibility((props.node as { id: string }).id)}
          content={contentOf((props.node as { id: string }).id)}
        />
      }
    >
      {(() => {
        const split = props.node as Extract<PanelNode, { type: "split" }>;
        return (
          <div
            style={{
              display: "flex",
              "flex-direction": split.direction === "horizontal" ? "row" : "column",
              width: "100%",
              height: "100%",
              gap: "4px",
            }}
          >
            <div style={{ flex: split.ratio, "min-width": "0", "min-height": "0" }}>
              <PanelNodeView node={split.first} panelMeta={props.panelMeta} />
            </div>
            <div style={{ flex: 1 - split.ratio, "min-width": "0", "min-height": "0" }}>
              <PanelNodeView node={split.second} panelMeta={props.panelMeta} />
            </div>
          </div>
        );
      })()}
    </Show>
  );
}

// Active browser tab title falls back to the URL when titles are missing.
function describeBrowserContent(content: Extract<PanelContent, { type: "browser" }>): {
  label: string;
  detail?: string;
} {
  if ("tabs" in content) {
    const active = content.tabs.find((t) => t.id === content.activeTabId) ?? content.tabs[0];
    if (!active) return { label: "Browser" };
    return { label: active.title || active.url, detail: active.url };
  }
  return { label: content.title || content.url, detail: content.url };
}

function describeContent(content: PanelContent | undefined): {
  kind: string;
  label: string;
  icon?: string;
  detail?: string;
} {
  if (!content) return { kind: "empty", label: "Empty panel" };
  if (content.type === "plugin") {
    const out: { kind: string; label: string; icon?: string; detail?: string } = {
      kind: content.slug,
      label: content.itemLabel,
    };
    if (content.itemIcon !== undefined) out.icon = content.itemIcon;
    return out;
  }
  const { label, detail } = describeBrowserContent(content);
  const out: { kind: string; label: string; icon?: string; detail?: string } = {
    kind: "browser",
    label,
  };
  if (detail !== undefined) out.detail = detail;
  return out;
}

function LeafPanel(props: {
  id: string;
  visibility: CoViewPanelVisibility;
  content: PanelContent | undefined;
}): JSX.Element {
  const desc = createMemo(() => describeContent(props.content));

  return (
    <div
      data-leaf-id={props.id}
      data-co-view-visibility={props.visibility}
      data-co-view-content-kind={desc().kind}
      style={{
        width: "100%",
        height: "100%",
        "border-radius": "6px",
        border: "1px solid rgba(124, 58, 237, 0.45)",
        background: "rgba(15, 23, 42, 0.55)",
        display: "flex",
        "flex-direction": "column",
        overflow: "hidden",
        "font-family": "ui-sans-serif, system-ui, sans-serif",
        color: "rgba(229, 231, 235, 0.85)",
      }}
    >
      <Show when={props.visibility !== "hidden"}>
        <div
          style={{
            display: "flex",
            "align-items": "center",
            gap: "6px",
            padding: "6px 10px",
            "background": "rgba(15, 23, 42, 0.85)",
            "border-bottom": "1px solid rgba(124, 58, 237, 0.35)",
            "font-size": "12px",
          }}
        >
          <Show when={desc().icon}>
            {(icon) => (
              <span aria-hidden="true" style={{ "font-size": "13px" }}>
                {icon()}
              </span>
            )}
          </Show>
          <span style={{ "font-weight": 600, "white-space": "nowrap", overflow: "hidden", "text-overflow": "ellipsis" }}>
            {desc().label}
          </span>
          <span style={{ "margin-left": "auto", opacity: 0.55, "font-size": "10px", "text-transform": "uppercase", "letter-spacing": "0.04em" }}>
            {desc().kind}
          </span>
        </div>
      </Show>
      <div
        style={{
          flex: "1",
          display: "flex",
          "align-items": "center",
          "justify-content": "center",
          padding: "8px",
          "font-size": "12px",
          color: "rgba(229, 231, 235, 0.6)",
          "text-align": "center",
        }}
      >
        <Show
          when={props.visibility === "hidden"}
          fallback={
            <Show
              when={props.visibility === "skeleton"}
              fallback={
                <Show
                  when={desc().detail}
                  fallback={<span style={{ opacity: 0.55 }}>Mirrored from host</span>}
                >
                  {(detail) => (
                    <span
                      style={{
                        opacity: 0.7,
                        "font-family": "ui-monospace, SFMono-Regular, Menlo, monospace",
                        "font-size": "11px",
                        "word-break": "break-all",
                      }}
                    >
                      {detail()}
                    </span>
                  )}
                </Show>
              }
            >
              <span style={{ opacity: 0.5 }}>(skeleton)</span>
            </Show>
          }
        >
          <span style={{ opacity: 0.55 }}>Panel hidden by host</span>
        </Show>
      </div>
    </div>
  );
}

function ModalStackOverlay(props: { modals: CoViewModalEntry[] | undefined }): JSX.Element {
  return (
    <Show when={(props.modals?.length ?? 0) > 0}>
      <div
        style={{
          position: "absolute",
          inset: "0",
          background: "rgba(0, 0, 0, 0.45)",
          display: "flex",
          "align-items": "center",
          "justify-content": "center",
          "pointer-events": "none",
        }}
      >
        <div
          style={{
            background: "rgba(15, 23, 42, 0.9)",
            border: "1px solid rgba(124, 58, 237, 0.4)",
            "border-radius": "8px",
            padding: "16px 20px",
            "min-width": "240px",
            color: "rgba(229, 231, 235, 0.92)",
            "font-family": "ui-sans-serif, system-ui, sans-serif",
            "font-size": "13px",
          }}
        >
          <For each={props.modals ?? []}>
            {(m) => (
              <div style={{ "margin-bottom": "6px" }}>
                <div style={{ "font-weight": 600, "margin-bottom": "2px" }}>
                  {m.redacted ? "(modal hidden by host)" : (m.title ?? "(modal)")}
                </div>
                <div style={{ opacity: 0.55, "font-size": "11px" }}>{m.id}</div>
              </div>
            )}
          </For>
        </div>
      </div>
    </Show>
  );
}

function PopoverIndicator(props: { count: number }): JSX.Element {
  return (
    <Show when={props.count > 0}>
      <div
        style={{
          position: "absolute",
          right: "8px",
          top: "40px",
          padding: "4px 8px",
          "background": "rgba(124, 58, 237, 0.5)",
          color: "white",
          "border-radius": "4px",
          "font-family": "ui-sans-serif, system-ui, sans-serif",
          "font-size": "11px",
        }}
      >
        {props.count} popover{props.count > 1 ? "s" : ""} open
      </div>
    </Show>
  );
}

function ContextMenuIndicator(props: { count: number }): JSX.Element {
  return (
    <Show when={props.count > 0}>
      <div
        style={{
          position: "absolute",
          right: "8px",
          top: "70px",
          padding: "4px 8px",
          "background": "rgba(34, 197, 94, 0.5)",
          color: "white",
          "border-radius": "4px",
          "font-family": "ui-sans-serif, system-ui, sans-serif",
          "font-size": "11px",
        }}
      >
        {props.count} context-menu{props.count > 1 ? "s" : ""} open
      </div>
    </Show>
  );
}
