import { Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

// Avatar crop + zoom dialog. Replaces the legacy "PUT the raw file at R2"
// flow — that path stretched non-square sources because R2 has no concept of
// crop, and the <Avatar> renderer just `object-fit: cover`'d on display.
//
// Crop frame: 320×320 logical px. Output image: 512×512 PNG (high-DPI ready,
// lossless so a face uploaded at near-1:1 is not JPEG-mushed). Canvas-only
// rendering — no SVG mask — so the export round-trips through `canvas.toBlob`
// without re-tracing.
//
// Interaction:
//   - drag (pointer/touch) anywhere in the frame → pan
//   - wheel → zoom around the cursor
//   - pinch (two-finger touch) → zoom around the centroid
//   - +/− buttons + slider → zoom for accessibility (no scroll surface required)
//
// Bounds:
//   - minScale = the scale at which the smaller image dimension fills the
//     320 frame (so the user can't expose transparent pixels by zooming out).
//   - maxScale = 8× (arbitrary upper bound; keeps export crisp).
//   - pan is clamped each pointer move so the image never reveals empty space.

const FRAME_PX = 320;
const OUTPUT_PX = 512;
const MAX_SCALE = 8;

interface ImageDims {
  el: HTMLImageElement;
  naturalWidth: number;
  naturalHeight: number;
}

interface AvatarCropDialogProps {
  open: boolean;
  /** Source file selected via the file input. Owned by the dialog: revoked on close. */
  file: File | null;
  onCancel: () => void;
  /** Receives the cropped 512×512 PNG ready for upload. */
  onConfirm: (cropped: Blob) => void;
}

export function AvatarCropDialog(props: AvatarCropDialogProps) {
  const [dims, setDims] = createSignal<ImageDims | null>(null);
  const [scale, setScale] = createSignal(1);
  const [tx, setTx] = createSignal(0);
  const [ty, setTy] = createSignal(0);
  const [exporting, setExporting] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  let canvasRef: HTMLCanvasElement | undefined;
  let frameRef: HTMLDivElement | undefined;
  let objectUrl: string | null = null;

  const minScale = createMemo(() => {
    const d = dims();
    if (d === null) return 1;
    // Smaller dimension must equal the frame to fill it.
    return FRAME_PX / Math.min(d.naturalWidth, d.naturalHeight);
  });

  // Load the file when it changes. Revoke previous object URL to avoid leaks.
  createEffect(() => {
    const f = props.file;
    if (objectUrl !== null) {
      URL.revokeObjectURL(objectUrl);
      objectUrl = null;
    }
    setDims(null);
    setError(null);
    if (f === null) return;
    const url = URL.createObjectURL(f);
    objectUrl = url;
    const img = new Image();
    img.onload = () => {
      if (img.naturalWidth === 0 || img.naturalHeight === 0) {
        setError("Could not read image dimensions");
        return;
      }
      setDims({ el: img, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight });
      // Initial fit-to-frame at minScale, centered.
      const s = FRAME_PX / Math.min(img.naturalWidth, img.naturalHeight);
      setScale(s);
      setTx(0);
      setTy(0);
    };
    img.onerror = () => {
      setError("Could not decode image");
    };
    img.src = url;
  });

  onCleanup(() => {
    if (objectUrl !== null) {
      URL.revokeObjectURL(objectUrl);
      objectUrl = null;
    }
  });

  // Clamp pan so the image always covers the frame at the current scale.
  // The image is rendered centered on (tx, ty). At scale s the rendered
  // dimensions are (naturalWidth * s, naturalHeight * s). Each axis must
  // span at least FRAME_PX, otherwise the user has zoomed below minScale.
  function clampPan(nx: number, ny: number, s: number): { x: number; y: number } {
    const d = dims();
    if (d === null) return { x: 0, y: 0 };
    const renderedW = d.naturalWidth * s;
    const renderedH = d.naturalHeight * s;
    const limX = Math.max(0, (renderedW - FRAME_PX) / 2);
    const limY = Math.max(0, (renderedH - FRAME_PX) / 2);
    return {
      x: Math.max(-limX, Math.min(limX, nx)),
      y: Math.max(-limY, Math.min(limY, ny)),
    };
  }

  function applyPan(dx: number, dy: number) {
    const next = clampPan(tx() + dx, ty() + dy, scale());
    setTx(next.x);
    setTy(next.y);
  }

  function setScaleAround(nextScale: number, anchorX: number, anchorY: number) {
    // Anchor coords are within the frame in [-FRAME_PX/2, FRAME_PX/2].
    // Translate so the image-space point under the anchor stays put.
    const s0 = scale();
    const s1 = Math.max(minScale(), Math.min(MAX_SCALE, nextScale));
    if (s1 === s0) return;
    // image-space point under anchor at scale s0:
    //   px = (anchorX - tx) / s0
    // After zoom we want: anchorX - tx' = px * s1 ⇒ tx' = anchorX - px * s1
    const px = (anchorX - tx()) / s0;
    const py = (anchorY - ty()) / s0;
    const ntx = anchorX - px * s1;
    const nty = anchorY - py * s1;
    const clamped = clampPan(ntx, nty, s1);
    setScale(s1);
    setTx(clamped.x);
    setTy(clamped.y);
  }

  // Re-clamp when scale changes via the slider (anchorless): keep center put.
  function setScaleCentered(nextScale: number) {
    setScaleAround(nextScale, 0, 0);
  }

  // ── Pointer / touch input ──────────────────────────────────────────────────

  let dragPointerId: number | null = null;
  let lastX = 0;
  let lastY = 0;
  // Multi-touch pinch tracking. Active when ≥2 active pointers.
  const activePointers = new Map<number, { x: number; y: number }>();
  let pinchStartScale = 0;
  let pinchStartDist = 0;

  function onPointerDown(ev: PointerEvent) {
    if (frameRef === undefined) return;
    const rect = frameRef.getBoundingClientRect();
    activePointers.set(ev.pointerId, {
      x: ev.clientX - rect.left,
      y: ev.clientY - rect.top,
    });
    if (activePointers.size === 1) {
      dragPointerId = ev.pointerId;
      lastX = ev.clientX;
      lastY = ev.clientY;
      (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
    } else if (activePointers.size === 2) {
      // Pinch begin
      dragPointerId = null;
      const pts = [...activePointers.values()];
      const dx = pts[0]!.x - pts[1]!.x;
      const dy = pts[0]!.y - pts[1]!.y;
      pinchStartDist = Math.hypot(dx, dy);
      pinchStartScale = scale();
    }
  }

  function onPointerMove(ev: PointerEvent) {
    if (frameRef === undefined) return;
    const tracked = activePointers.get(ev.pointerId);
    if (tracked === undefined) return;
    const rect = frameRef.getBoundingClientRect();
    tracked.x = ev.clientX - rect.left;
    tracked.y = ev.clientY - rect.top;

    if (activePointers.size >= 2 && pinchStartDist > 0) {
      const pts = [...activePointers.values()];
      const dx = pts[0]!.x - pts[1]!.x;
      const dy = pts[0]!.y - pts[1]!.y;
      const dist = Math.hypot(dx, dy);
      const ratio = dist / pinchStartDist;
      // Anchor zoom around the centroid of the two touches, expressed in
      // frame-centered coordinates (origin at frame center).
      const cx = (pts[0]!.x + pts[1]!.x) / 2 - FRAME_PX / 2;
      const cy = (pts[0]!.y + pts[1]!.y) / 2 - FRAME_PX / 2;
      setScaleAround(pinchStartScale * ratio, cx, cy);
      return;
    }

    if (ev.pointerId === dragPointerId) {
      const dx = ev.clientX - lastX;
      const dy = ev.clientY - lastY;
      lastX = ev.clientX;
      lastY = ev.clientY;
      applyPan(dx, dy);
    }
  }

  function onPointerEnd(ev: PointerEvent) {
    activePointers.delete(ev.pointerId);
    if (ev.pointerId === dragPointerId) {
      dragPointerId = null;
      try {
        (ev.currentTarget as HTMLElement).releasePointerCapture(ev.pointerId);
      } catch {
        // ignore — capture may have been released by the browser already
      }
    }
    if (activePointers.size < 2) {
      pinchStartDist = 0;
    }
  }

  function onWheel(ev: WheelEvent) {
    if (frameRef === undefined) return;
    ev.preventDefault();
    const rect = frameRef.getBoundingClientRect();
    const ax = ev.clientX - rect.left - FRAME_PX / 2;
    const ay = ev.clientY - rect.top - FRAME_PX / 2;
    // Wheel deltaY is positive on scroll-down → zoom out. Multiplicative so
    // the perceived speed is constant across scale levels.
    const factor = Math.pow(0.998, ev.deltaY);
    setScaleAround(scale() * factor, ax, ay);
  }

  // ── Render canvas preview ──────────────────────────────────────────────────

  // Redraw whenever scale, tx, ty, or dims change.
  function draw() {
    const c = canvasRef;
    const d = dims();
    if (c === undefined || d === null) return;
    const ctx = c.getContext("2d");
    if (ctx === null) return;
    ctx.save();
    ctx.clearRect(0, 0, FRAME_PX, FRAME_PX);
    // image-space (0,0) maps to canvas (FRAME_PX/2 - imgW*scale/2 + tx, ...).
    const s = scale();
    const dx = FRAME_PX / 2 - (d.naturalWidth * s) / 2 + tx();
    const dy = FRAME_PX / 2 - (d.naturalHeight * s) / 2 + ty();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(d.el, dx, dy, d.naturalWidth * s, d.naturalHeight * s);
    ctx.restore();
  }

  createEffect(() => {
    void scale();
    void tx();
    void ty();
    void dims();
    draw();
  });

  onMount(() => {
    if (canvasRef !== undefined) {
      canvasRef.width = FRAME_PX;
      canvasRef.height = FRAME_PX;
    }
  });

  // ── Export ─────────────────────────────────────────────────────────────────

  async function exportCropped(): Promise<Blob | null> {
    const d = dims();
    if (d === null) return null;
    // Render into an off-screen 512×512 canvas at OUTPUT_PX size. Same
    // transform but scaled by OUTPUT_PX / FRAME_PX so the visible crop
    // round-trips 1:1 to the export.
    const off = document.createElement("canvas");
    off.width = OUTPUT_PX;
    off.height = OUTPUT_PX;
    const ctx = off.getContext("2d");
    if (ctx === null) return null;
    const k = OUTPUT_PX / FRAME_PX;
    const s = scale() * k;
    const dx = OUTPUT_PX / 2 - (d.naturalWidth * s) / 2 + tx() * k;
    const dy = OUTPUT_PX / 2 - (d.naturalHeight * s) / 2 + ty() * k;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(d.el, dx, dy, d.naturalWidth * s, d.naturalHeight * s);
    return await new Promise<Blob | null>((resolve) => {
      off.toBlob((b) => resolve(b), "image/png");
    });
  }

  async function handleConfirm() {
    if (exporting()) return;
    setExporting(true);
    setError(null);
    try {
      const blob = await exportCropped();
      if (blob === null) {
        setError("Could not export image");
        return;
      }
      props.onConfirm(blob);
    } finally {
      setExporting(false);
    }
  }

  return (
    <Dialog open={props.open} onOpenChange={(o) => { if (!o) props.onCancel(); }}>
      <DialogContent class="max-w-md p-5">
        <DialogHeader>
          <DialogTitle>Crop avatar</DialogTitle>
        </DialogHeader>

        <div class="mt-4 flex flex-col items-center gap-3">
          <div
            ref={frameRef}
            class="relative overflow-hidden rounded-md bg-muted/40 select-none touch-none"
            style={{ width: `${String(FRAME_PX)}px`, height: `${String(FRAME_PX)}px` }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerEnd}
            onPointerCancel={onPointerEnd}
            onLostPointerCapture={onPointerEnd}
            onWheel={onWheel}
          >
            <canvas
              ref={canvasRef}
              class="block"
              style={{ width: `${String(FRAME_PX)}px`, height: `${String(FRAME_PX)}px` }}
            />
            {/* Circular mask overlay — visualises the avatar shape. The four
                corners outside the circle render at 50% opacity so the user
                still sees what gets clipped. SVG mask is drawn over the
                canvas, not into it, so the export remains square. */}
            <svg
              class="pointer-events-none absolute inset-0"
              width={FRAME_PX}
              height={FRAME_PX}
              viewBox={`0 0 ${String(FRAME_PX)} ${String(FRAME_PX)}`}
            >
              <defs>
                <mask id="circle-cutout">
                  <rect width={FRAME_PX} height={FRAME_PX} fill="white" />
                  <circle cx={FRAME_PX / 2} cy={FRAME_PX / 2} r={FRAME_PX / 2 - 2} fill="black" />
                </mask>
              </defs>
              <rect width={FRAME_PX} height={FRAME_PX} fill="rgba(0,0,0,0.45)" mask="url(#circle-cutout)" />
              <circle
                cx={FRAME_PX / 2}
                cy={FRAME_PX / 2}
                r={FRAME_PX / 2 - 2}
                fill="none"
                stroke="rgba(255,255,255,0.5)"
                stroke-width="2"
              />
            </svg>
          </div>

          <div class="flex w-full items-center gap-2">
            <Button
              variant="outline"
              size="icon"
              class="size-7"
              onClick={() => setScaleCentered(scale() / 1.2)}
              aria-label="Zoom out"
            >
              −
            </Button>
            <input
              type="range"
              min={minScale()}
              max={MAX_SCALE}
              step={0.01}
              value={scale()}
              onInput={(e) => setScaleCentered(Number(e.currentTarget.value))}
              class="flex-1 accent-sidebar-primary"
            />
            <Button
              variant="outline"
              size="icon"
              class="size-7"
              onClick={() => setScaleCentered(scale() * 1.2)}
              aria-label="Zoom in"
            >
              +
            </Button>
          </div>

          <Show when={error()}>
            <p class="text-xs text-destructive">{error()}</p>
          </Show>
        </div>

        <div class="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => props.onCancel()} disabled={exporting()}>
            Cancel
          </Button>
          <Button onClick={() => void handleConfirm()} disabled={exporting() || dims() === null}>
            {exporting() ? "Saving…" : "Save avatar"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
