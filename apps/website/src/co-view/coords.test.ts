import { describe, expect, test } from "bun:test";
import {
  IDENTITY_TRANSFORM,
  clientPointToHostViewport,
  type OverlayTransform,
} from "./coords";

describe("clientPointToHostViewport", () => {
  test("identity transform with null element returns clientX/Y unchanged", () => {
    const out = clientPointToHostViewport(
      { clientX: 200, clientY: 150 },
      null,
      IDENTITY_TRANSFORM,
    );
    expect(out).toEqual({ x: 200, y: 150 });
  });

  test("scale=0.5 halves the coordinate (overlay shows host-viewport at 50%)", () => {
    const out = clientPointToHostViewport(
      { clientX: 100, clientY: 80 },
      null,
      { scale: 0.5, offsetX: 0, offsetY: 0 },
    );
    expect(out).toEqual({ x: 200, y: 160 });
  });

  test("offset is subtracted before dividing by scale", () => {
    // Overlay container is at page (0,0), scaled host is offset (40,20)
    // inside the overlay, scale = 0.5. A click at clientX=140, clientY=120
    // maps to host-viewport (200, 200): (140-40)/0.5 = 200, (120-20)/0.5 = 200.
    const out = clientPointToHostViewport(
      { clientX: 140, clientY: 120 },
      null,
      { scale: 0.5, offsetX: 40, offsetY: 20 },
    );
    expect(out).toEqual({ x: 200, y: 200 });
  });

  test("overlay element page-position is canceled via getBoundingClientRect", () => {
    // Fake an element placed 50px from the page top-left.
    const fakeEl = {
      getBoundingClientRect: () => ({ left: 50, top: 50 }),
    } as unknown as HTMLElement;
    const transform: OverlayTransform = { scale: 1, offsetX: 0, offsetY: 0 };
    const out = clientPointToHostViewport(
      { clientX: 250, clientY: 200 },
      fakeEl,
      transform,
    );
    // (250 - 50)/1 = 200 in overlay-local space, no further offset/scale.
    expect(out).toEqual({ x: 200, y: 150 });
  });
});
