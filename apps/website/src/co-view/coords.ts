// Coordinate translator — shared by host AND viewer producers (both cursor
// and pen) so the math lives in exactly one place. The host passes
// `IDENTITY_TRANSFORM` and a `null` overlay element (the producer is reading
// raw page coordinates already in host-viewport space). The viewer passes its
// scaled overlay element + the live transform; the formula cancels the
// overlay's page position so strokes don't shift when the overlay isn't at
// (0,0), and divides by scale to land back in host-viewport space.
//
// Two implementations would inevitably drift once PR-CV5+ adds workspace
// pan; one shared translator keeps host and viewer producers honest.

export interface OverlayTransform {
  /** Scale applied to host-viewport coordinates when displayed in the overlay. */
  scale: number;
  /** Offset of the scaled host-viewport rectangle within the overlay element. */
  offsetX: number;
  offsetY: number;
}

/** Identity transform — host producers use this (their input is already in host-viewport space). */
export const IDENTITY_TRANSFORM: OverlayTransform = {
  scale: 1,
  offsetX: 0,
  offsetY: 0,
};

/**
 * Convert a `clientX`/`clientY` pointer-event coordinate to host-viewport CSS
 * pixels. Host producer: pass `null` for `overlayEl` and `IDENTITY_TRANSFORM`
 * — the formula reduces to `(clientX, clientY)` unchanged. Viewer producer:
 * pass the overlay container element + the live transform.
 */
export function clientPointToHostViewport(
  point: { clientX: number; clientY: number },
  overlayEl: HTMLElement | null,
  transform: OverlayTransform,
): { x: number; y: number } {
  const rect = overlayEl?.getBoundingClientRect();
  const localX = point.clientX - (rect?.left ?? 0);
  const localY = point.clientY - (rect?.top ?? 0);
  return {
    x: (localX - transform.offsetX) / transform.scale,
    y: (localY - transform.offsetY) / transform.scale,
  };
}
