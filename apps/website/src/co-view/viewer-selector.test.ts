// CoView viewer selector tests (CV-FOUND-8).
//
// The integration seam's testable substance is the pure choice
// (`selectCoViewViewer`); the thin `.tsx` component (`CoViewViewerSelector`) is a
// declarative wrapper covered by typecheck only (its element templates touch
// `document` at module load, and this repo has no DOM test environment - exactly
// why `projected-viewer-mount-view.tsx` / `render-tree-viewer-view.tsx` have no
// tests either). These tests drive the selector directly, so no socket is dialed
// and the choice is deterministic.
//
// Coverage:
//   - The viewer flag ships disabled (the projected arm stays dormant by default).
//   - Default (no `enabled`) and `enabled: false` resolve to the legacy viewer - the
//     projected mount is never selected.
//   - `enabled: true` resolves to the projected arm, carrying the exact serverId /
//     sessionId the mount will receive.
//   - Switching sessionId re-selects for that session (no stale carry-over at this
//     layer); the projected mount's own stale-frame guard lives in
//     `projected-viewer-mount.test.ts` (the frame read is reactive on sessionId).

import { describe, expect, test } from "bun:test";

import { selectCoViewViewer } from "./viewer-selector";
import { CO_VIEW_PROJECTED_VIEWER_ENABLED } from "./render-tree-viewer";

// --- dormant / legacy default ----------------------------------------------

describe("selectCoViewViewer - dormant default", () => {
  test("the viewer flag ships disabled (the projected arm stays dormant)", () => {
    expect(CO_VIEW_PROJECTED_VIEWER_ENABLED).toBe(false);
  });

  test("default (no `enabled`) selects the legacy viewer", () => {
    const choice = selectCoViewViewer({ serverId: "srv", sessionId: "A" });
    expect(choice).toEqual({ kind: "legacy" });
  });

  test("`enabled: false` selects the legacy viewer", () => {
    const choice = selectCoViewViewer({ serverId: "srv", sessionId: "A", enabled: false });
    expect(choice).toEqual({ kind: "legacy" });
  });

  test("`enabled: undefined` falls back to the (false) flag - legacy", () => {
    const choice = selectCoViewViewer({ serverId: "srv", sessionId: "A", enabled: undefined });
    expect(choice).toEqual({ kind: "legacy" });
  });
});

// --- enabled (via DI) -------------------------------------------------------

describe("selectCoViewViewer - enabled via DI", () => {
  test("`enabled: true` selects the projected mount with the exact serverId/sessionId", () => {
    const choice = selectCoViewViewer({ serverId: "srv-1", sessionId: "sess-7", enabled: true });
    expect(choice).toEqual({ kind: "projected", serverId: "srv-1", sessionId: "sess-7" });
  });

  test("switching sessionId re-selects for that session (no stale carry-over here)", () => {
    const a = selectCoViewViewer({ serverId: "srv", sessionId: "A", enabled: true });
    const b = selectCoViewViewer({ serverId: "srv", sessionId: "B", enabled: true });
    expect(a).toEqual({ kind: "projected", serverId: "srv", sessionId: "A" });
    expect(b).toEqual({ kind: "projected", serverId: "srv", sessionId: "B" });
  });

  test("the selector forwards IDs only - it carries no frame data", () => {
    const choice = selectCoViewViewer({ serverId: "srv", sessionId: "A", enabled: true });
    // The projected arm's keys are exactly the discriminant plus the two IDs; the
    // selector reads/synthesizes no value, so it can introduce no protected bytes.
    expect(Object.keys(choice).sort()).toEqual(["kind", "serverId", "sessionId"]);
  });
});
