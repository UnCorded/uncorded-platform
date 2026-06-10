import { describe, expect, test } from "bun:test";
import { intersectRect, projectViewportRect } from "./proxy-mount-geometry";

describe("intersectRect", () => {
  test("returns the overlapping region of two rects", () => {
    expect(
      intersectRect({ x: 0, y: 0, width: 100, height: 100 }, { x: 50, y: 50, width: 100, height: 100 }),
    ).toEqual({ x: 50, y: 50, width: 50, height: 50 });
  });

  test("clamps to zero size when rects don't overlap", () => {
    expect(
      intersectRect({ x: 0, y: 0, width: 10, height: 10 }, { x: 100, y: 100, width: 10, height: 10 }),
    ).toEqual({ x: 100, y: 100, width: 0, height: 0 });
  });

  test("a fully-contained rect is returned unchanged", () => {
    expect(
      intersectRect({ x: 10, y: 10, width: 20, height: 20 }, { x: 0, y: 0, width: 100, height: 100 }),
    ).toEqual({ x: 10, y: 10, width: 20, height: 20 });
  });
});

describe("projectViewportRect", () => {
  test("offsets the iframe-local rect by the frame's shell position", () => {
    // Local rect (40,30) inside a plugin iframe at shell (200,100) → shell (240,130).
    expect(
      projectViewportRect(
        { x: 40, y: 30, width: 100, height: 80 },
        { x: 200, y: 100, width: 600, height: 400 },
      ),
    ).toEqual({ x: 240, y: 130, width: 100, height: 80 });
  });

  test("clamps a rect that spills past the frame's edges", () => {
    // A 500-wide local rect at local x=400 in a 600-wide frame: projected to
    // shell x=400, the frame's right edge is shell x=600, so width clamps to 200.
    expect(
      projectViewportRect(
        { x: 400, y: 0, width: 500, height: 100 },
        { x: 0, y: 0, width: 600, height: 400 },
      ),
    ).toEqual({ x: 400, y: 0, width: 200, height: 100 });
  });

  test("yields a zero rect when the frame has no box (hidden / unlaid-out)", () => {
    expect(
      projectViewportRect({ x: 10, y: 10, width: 50, height: 50 }, { x: 0, y: 0, width: 0, height: 0 }),
    ).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    expect(
      projectViewportRect({ x: 10, y: 10, width: 50, height: 50 }, { x: 5, y: 5, width: 100, height: 0 }),
    ).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });

  test("a local rect past the frame's right edge projects to zero width", () => {
    // Local origin already past the frame's right edge → no horizontal overlap.
    // The caller hides the surface when width OR height is zero, so zero width
    // alone makes it invisible (height is unconstrained vertically here).
    const out = projectViewportRect(
      { x: 700, y: 0, width: 50, height: 50 },
      { x: 0, y: 0, width: 600, height: 400 },
    );
    expect(out.width).toBe(0);
  });
});
