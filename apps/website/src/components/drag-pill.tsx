// DragPill — cursor-attached chip rendered while a drag is active.
// Replaces PR-C's physical-motion ghost (which caused preview oscillation
// because the layout reflowed continuously during motion, feeding back into
// hit-testing). This version couples the pill to the dwell signal:
//
//   - Cursor moving → pill tracks cursor 1:1, no transition, layout untouched.
//   - Cursor still (≥DWELL_MS) over a committable zone → App.tsx's
//     `previewLayout` memo reflows the tree; the pill glides into the centre
//     of the dragged panel's new rect. Layout + pill are the preview.
//   - Cursor moves again → dwell flips false → preview layout collapses,
//     pill pops back up to the cursor.
//
// Why this dodges the old oscillation: layout changes are gated on pointer
// stillness, so there's no feedback loop from reflow-during-motion. When
// motion resumes, the preview collapses before the next hit-test.
//
// Docking coords for panel drags come from the dragged panel's real rect in
// the preview tree (we query `[data-panel-leaf=<draggedId>]`). A tiny rAF
// loop re-measures each frame so the pill tracks the flex transition as
// panels squeeze into their new positions.
//
// Pointer-events: none — hit-test under the pill always finds the real leaf.

import { Show, createEffect, createMemo, createSignal, on, onCleanup, onMount, type Component } from "solid-js";
import { Dynamic } from "solid-js/web";
import { Globe, Hash, Users, Volume2, type LucideProps } from "lucide-solid";
import { dragContext, dropTarget, cursor, dwelling, type DragPayload, type DropTarget } from "@/lib/drag-state";
import { PREVIEW_LEAF_ID } from "@/lib/panel-layout";
import { type PanelContent } from "@uncorded/protocol";
import { browserPanelLabel } from "@/lib/browser-panel-state";

const ICON_MAP: Record<string, Component<LucideProps>> = {
  hash: Hash,
  users: Users,
  volume2: Volume2,
  globe: Globe,
};

// Trail offset keeps the pill off the cursor hotspot so the pointer stays
// visible for precise edge targeting.
const PILL_OFFSET = 14;
// Docked pill shrinks to this scale. Small enough to read as "snapped" and
// let the preview layout behind it breathe; large enough that the label
// stays legible.
const DOCKED_SCALE = 0.85;
// Glide duration for dock / undock. Matched to the panel's flex transition
// in panel.tsx so the pill and the reflowing layout complete their motion
// together rather than one trailing the other. Curve (below, in the classList
// for transition-transform) matches panel.tsx's cubic-bezier(0.32,0.72,0,1)
// — a soft "settle" curve that reads as a physical object coming to rest.
const DOCK_MS = 200;

interface Display {
  label: string;
  icon: string;
}

interface Placement {
  tx: number;
  ty: number;
  scale: number;
}

function findLeafEl(leafId: string): HTMLElement | null {
  const nodes = document.querySelectorAll<HTMLElement>("[data-panel-leaf]");
  for (const n of nodes) {
    if (n.getAttribute("data-panel-leaf") === leafId) return n;
  }
  return null;
}

function cursorPlacement(cx: number, cy: number, pw: number, ph: number): Placement {
  const vw = typeof window === "undefined" ? 0 : window.innerWidth;
  const vh = typeof window === "undefined" ? 0 : window.innerHeight;
  const flipX = cx + PILL_OFFSET + pw > vw;
  const flipY = cy + PILL_OFFSET + ph > vh;
  const tx = flipX ? cx - PILL_OFFSET - pw : cx + PILL_OFFSET;
  const ty = flipY ? cy - PILL_OFFSET - ph : cy + PILL_OFFSET;
  return { tx, ty, scale: 1 };
}

// Dock target resolution by drag kind + zone:
//   - Panel drag (any edge): dock into the dragged panel's real rect in the
//     reflowed preview tree (movePanel has relocated it next to the target).
//   - Sidebar drag, edge zone: dock into the PREVIEW_LEAF_ID ghost rect — the
//     preview tree inserted a placeholder leaf that represents the new panel.
//   - Any center zone: no reflow happened (drop-into-existing is a content
//     swap, not a structure change), so dock to the target leaf's centre.
//
// Fallback for transitional frames where the expected leaf isn't yet
// measurable (e.g. first frame after dwell) is the target leaf's zone region.
function dockPlacement(
  ctx: DragPayload,
  tgt: DropTarget,
  pw: number,
  ph: number,
): Placement | null {
  const dockRect = (r: DOMRect): Placement => ({
    tx: r.left + r.width / 2 - (pw * DOCKED_SCALE) / 2,
    ty: r.top + r.height / 2 - (ph * DOCKED_SCALE) / 2,
    scale: DOCKED_SCALE,
  });

  if (ctx.kind === "panel" && tgt.zone !== "center") {
    const el = findLeafEl(ctx.sourceLeafId);
    if (el !== null) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return dockRect(r);
    }
  }

  if ((ctx.kind === "sidebar-item" || ctx.kind === "web-app") && tgt.zone !== "center") {
    const el = findLeafEl(PREVIEW_LEAF_ID);
    if (el !== null) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return dockRect(r);
    }
  }

  const el = findLeafEl(tgt.leafId);
  if (el === null) return null;
  const r = el.getBoundingClientRect();
  let cx: number;
  let cy: number;
  switch (tgt.zone) {
    case "left":   cx = r.left + r.width * 0.25; cy = r.top + r.height * 0.5;  break;
    case "right":  cx = r.left + r.width * 0.75; cy = r.top + r.height * 0.5;  break;
    case "top":    cx = r.left + r.width * 0.5;  cy = r.top + r.height * 0.25; break;
    case "bottom": cx = r.left + r.width * 0.5;  cy = r.top + r.height * 0.75; break;
    case "center": cx = r.left + r.width * 0.5;  cy = r.top + r.height * 0.5;  break;
  }
  return {
    tx: cx - (pw * DOCKED_SCALE) / 2,
    ty: cy - (ph * DOCKED_SCALE) / 2,
    scale: DOCKED_SCALE,
  };
}

export function DragPill(props: { getPanelContent: (leafId: string) => PanelContent | undefined }) {
  let pillEl: HTMLDivElement | undefined;
  const [size, setSize] = createSignal({ w: 0, h: 0 });

  onMount(() => {
    if (pillEl === undefined) return;
    const measure = () => {
      if (pillEl === undefined) return;
      setSize({ w: pillEl.offsetWidth, h: pillEl.offsetHeight });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(pillEl);
    onCleanup(() => ro.disconnect());
  });

  const display = createMemo<Display | null>(() => {
    const ctx = dragContext();
    if (ctx === null) return null;
    if (ctx.kind === "sidebar-item") {
      return { label: ctx.item.label, icon: ctx.item.icon ?? "hash" };
    }
    if (ctx.kind === "web-app") {
      return { label: ctx.app.title, icon: "globe" };
    }
    const content = props.getPanelContent(ctx.sourceLeafId);
    if (content === undefined) return { label: "Empty Panel", icon: "hash" };
    if (content.type === "browser") {
      return {
        label: browserPanelLabel(content),
        icon: "globe",
      };
    }
    if (content.type === "webapp") {
      return { label: content.title, icon: "globe" };
    }
    return { label: content.itemLabel, icon: content.itemIcon ?? "hash" };
  });

  // True when the user has paused over a target that would commit on release.
  // Drives the phase state machine below.
  const previewEngaged = createMemo<boolean>(() => {
    const ctx = dragContext();
    const tgt = dropTarget();
    if (ctx === null || tgt === null || !dwelling()) return false;
    // Sidebar-item / web-app: center = open in panel; edges = split. Both commit.
    if (ctx.kind === "sidebar-item" || ctx.kind === "web-app") return true;
    // Panel drag: center on a different leaf is a no-op; don't dock for it.
    return tgt.zone !== "center";
  });

  // Pill lifecycle. Separates "glide" phases (CSS transition drives motion,
  // target is stable) from the "docked" phase (rAF direct writes track the
  // panel's evolving rect with zero lag). Without this split, a transition
  // restarted every frame by rAF rubber-bands badly.
  //
  //   cursor    — no preview, pill follows cursor 1:1, transform written directly
  //   entering  — preview just engaged, pill CSS-glides from cursor to dock
  //   docked    — glide done, rAF sync to the dragged panel's live rect
  //   exiting   — preview just disengaged, pill CSS-glides from last dock back to cursor
  type PillPhase = "cursor" | "entering" | "docked" | "exiting";
  const [phase, setPhase] = createSignal<PillPhase>("cursor");
  let phaseTimeout: ReturnType<typeof setTimeout> | undefined;

  createEffect(on(previewEngaged, (engaged, prev) => {
    if (engaged === true) {
      if (phaseTimeout !== undefined) clearTimeout(phaseTimeout);
      setPhase("entering");
      phaseTimeout = setTimeout(() => setPhase("docked"), DOCK_MS);
    } else if (prev === true) {
      if (phaseTimeout !== undefined) clearTimeout(phaseTimeout);
      setPhase("exiting");
      phaseTimeout = setTimeout(() => setPhase("cursor"), DOCK_MS);
    }
  }, { defer: true }));

  onCleanup(() => {
    if (phaseTimeout !== undefined) clearTimeout(phaseTimeout);
  });

  // rAF ticker, only during the "docked" phase. Cheap — one
  // getBoundingClientRect per frame — and stops the moment we exit.
  const [rectTick, setRectTick] = createSignal(0);
  createEffect(() => {
    if (phase() !== "docked") return;
    let rafId = 0;
    const tick = () => {
      setRectTick((t) => t + 1);
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    onCleanup(() => cancelAnimationFrame(rafId));
  });

  // CSS transition toggle: ON during the glide phases only. OFF during
  // cursor-track (no lag) AND during docked (rAF writes direct transforms
  // per-frame — no transition needed, none wanted).
  const shouldAnimate = createMemo<boolean>(() => {
    const p = phase();
    return p === "entering" || p === "exiting";
  });

  const placement = createMemo<Placement>(() => {
    const { w, h } = size();
    const c = cursor();
    const p = phase();
    if (p === "entering" || p === "docked") {
      // Re-measure each rAF tick during docked so the pill tracks reflow.
      // During entering the tick doesn't fire, so target is sampled once.
      rectTick();
      const ctx = dragContext();
      const tgt = dropTarget();
      if (ctx !== null && tgt !== null && w > 0 && h > 0) {
        const dock = dockPlacement(ctx, tgt, w, h);
        if (dock !== null) return dock;
      }
    }
    if (c !== null) return cursorPlacement(c.x, c.y, w, h);
    return { tx: -9999, ty: -9999, scale: 1 };
  });

  // Exit deferral: keep the pill mounted for EXIT_MS after the drag ends so
  // it can fade+shrink in place instead of vanishing. Without this, release
  // feels abrupt — the pill just pops off screen the instant you let go, even
  // though the panel layout is still settling.
  //
  //   - `frozenDisplay` / `frozenPlacement` capture the last live values so
  //     the fading pill stays where it was (rather than teleporting to
  //     `{-9999, -9999}` once cursor/ctx/tgt all go null).
  //   - `fadingOut` drives the opacity/scale transition classes below.
  //   - Re-opening a drag during the fade cancels the exit timer cleanly.
  //
  // Entry fade uses its own `mounted` signal (not @keyframes animate-in)
  // because tw-animate-css's keyframes override `transform` for their whole
  // duration — which would swallow the first 150ms of cursor tracking and
  // make fast drags feel laggy. Opacity-only transition keeps the inline
  // transform style in full control.
  const EXIT_MS = 200;
  const [frozenDisplay, setFrozenDisplay] = createSignal<Display | null>(null);
  const [frozenPlacement, setFrozenPlacement] = createSignal<Placement | null>(null);
  const [fadingOut, setFadingOut] = createSignal(false);
  const [mounted, setMounted] = createSignal(false);
  let exitTimer: ReturnType<typeof setTimeout> | undefined;

  // Mirror live values into the frozen slots on every paint where the drag
  // is still active. The display-watcher below reads these at the moment the
  // drag ends — so the pill's last visible position/label are what fade out.
  createEffect(() => {
    const d = display();
    if (d !== null) {
      setFrozenDisplay(d);
      setFrozenPlacement(placement());
    }
  });

  createEffect(on(display, (d, prev) => {
    if (d !== null) {
      // Re-engaged drag during fade — cancel the teardown.
      if (exitTimer !== undefined) { clearTimeout(exitTimer); exitTimer = undefined; }
      setFadingOut(false);
      return;
    }
    if (prev === null || prev === undefined) return;
    setFadingOut(true);
    if (exitTimer !== undefined) clearTimeout(exitTimer);
    exitTimer = setTimeout(() => {
      setFadingOut(false);
      setFrozenDisplay(null);
      setFrozenPlacement(null);
      exitTimer = undefined;
    }, EXIT_MS);
  }, { defer: true }));

  onCleanup(() => {
    if (exitTimer !== undefined) clearTimeout(exitTimer);
  });

  const renderedDisplay = () => display() ?? frozenDisplay();
  const renderedPlacement = (): Placement => {
    if (display() !== null) return placement();
    return frozenPlacement() ?? { tx: -9999, ty: -9999, scale: 1 };
  };

  return (
    <Show when={renderedDisplay()}>
      {(d) => {
        // Flip `mounted` to true on the next frame so the opacity transition
        // from 0 → 1 runs on entrance. Done per-mount because Show unmounts
        // between drags, so each drag gets a fresh fade-in.
        setMounted(false);
        requestAnimationFrame(() => setMounted(true));
        return (
          <div
            ref={pillEl}
            class={
              "fixed left-0 top-0 pointer-events-none z-[60] select-none " +
              "flex items-center gap-2 rounded-md border bg-background/95 backdrop-blur " +
              "px-2.5 py-1.5 text-sm font-medium text-foreground shadow-lg " +
              "max-w-[240px] will-change-transform " +
              // Opacity transition is always on (enter fade + exit fade share
              // the same property). Transform transition is class-toggled
              // below so it ONLY runs during dock/undock glide — never during
              // cursor tracking, where we want 1:1 pointer following.
              "transition-opacity duration-150 ease-out"
            }
            classList={{
              // Curve matches panel.tsx's flex-transition so pill glide and
              // layout reflow settle in sync. Applied on top of the base
              // transition-opacity; the more specific rule wins on transform.
              "transition-[transform,opacity] duration-200 ease-[cubic-bezier(0.32,0.72,0,1)]":
                shouldAnimate() || fadingOut(),
            }}
            style={{
              transform: `translate3d(${renderedPlacement().tx}px, ${renderedPlacement().ty}px, 0) scale(${fadingOut() ? renderedPlacement().scale * 0.9 : renderedPlacement().scale})`,
              "transform-origin": "top left",
              opacity: fadingOut() || !mounted() ? 0 : 1,
            }}
          >
            <Dynamic
              component={ICON_MAP[d().icon] ?? Hash}
              class="size-3.5 text-muted-foreground shrink-0"
            />
            <span class="truncate">{d().label}</span>
          </div>
        );
      }}
    </Show>
  );
}
