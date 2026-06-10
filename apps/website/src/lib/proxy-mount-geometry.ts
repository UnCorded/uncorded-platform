// Pure geometry for positioning a host-owned proxy surface over a plugin's
// reserved viewport. Extracted from proxy-mount-surface.tsx so the projection +
// clamp — the one real wrinkle (a plugin reports an iframe-LOCAL rect; the host
// paints in shell coordinates) — is unit-testable without a DOM. Mirrors the
// translate+clamp in screen-share-overlay.tsx.

export interface OverlayRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Axis-aligned intersection of two rects; never negative width/height. */
export function intersectRect(a: OverlayRect, b: OverlayRect): OverlayRect {
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

/**
 * Project an iframe-local viewport rect into shell coordinates by offsetting it
 * with the plugin iframe's shell-space rect, then clamp to that frame so a
 * resize/scroll race can never paint the surface outside the plugin panel.
 *
 * A zero-box frame (the plugin iframe isn't laid out yet, e.g. a background tab)
 * yields a zero rect — the caller hides the surface rather than flashing it at
 * the un-offset local coordinates.
 */
export function projectViewportRect(local: OverlayRect, frame: OverlayRect): OverlayRect {
  if (frame.width === 0 || frame.height === 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  return intersectRect(
    { x: local.x + frame.x, y: local.y + frame.y, width: local.width, height: local.height },
    frame,
  );
}
