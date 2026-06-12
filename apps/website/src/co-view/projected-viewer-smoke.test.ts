// CoView projected viewer smoke tests (CV-FOUND-9).
//
// First integrated pass over the REAL projected viewer chain: the harness in
// `projected-viewer-smoke.ts` composes `selectCoViewViewer` ->
// `createProjectedViewerMountController` -> the REAL `createProjectedFrameStore`
// -> `resolveProjectedFrame` - the exact data path the projected branch of
// `CoViewViewerSelector` runs, with only the logic-free JSX wrappers replaced by
// plain values. Nothing in the chain is mocked; the projected arm is selected
// through the selector's DI seam, never by flipping the global flag.
//
// Coverage (the user contract, end to end):
//   - The flag still ships disabled; the default harness chooses legacy and the
//     projected store is never constructed.
//   - The projected override constructs the real store for the exact serverId
//     and reads back the expected per-session frame.
//   - A delivered frame resolves through the real safe renderer pipeline.
//   - Host UI structure / control state mirrors: the public button label, the
//     hover/focus/open flags, and node identity/order all survive projection.
//   - Withheld/secret values render as bytes-free placeholders; the unsupported
//     diagnostic reason is dropped (protected bytes absent from the rendered tree).
//   - Switching sessionId never shows another session's (stale) frame.
//   - A canonical envelope is rejected by the integrated path (fail-closed).
//   - The legacy arm stays inert: nothing to deliver to, dispose is a no-op.

import { describe, expect, test } from "bun:test";
import type {
  CoViewProjectedRenderFrame,
  WsCoViewRenderTreeFrame,
} from "@uncorded/protocol";

import {
  createProjectedViewerSmokeHarness,
  ProjectedViewerSmokeError,
  type ProjectedViewerSmokeHarness,
} from "./projected-viewer-smoke";
import { CO_VIEW_PROJECTED_VIEWER_ENABLED, type SafeViewNode } from "./render-tree-viewer";

class SmokeAssertionError extends Error {
  readonly code = "ERR_EXPECTED_FRAME_RENDER" as const;
  readonly context: { readonly actualKind: string; readonly sessionId: string };

  constructor(context: { actualKind: string; sessionId: string }) {
    super("expected projected smoke harness to render a frame");
    this.name = "SmokeAssertionError";
    this.context = context;
  }
}

// --- fixture -----------------------------------------------------------------
//
// A realistic small surface: a settings panel with a toolbar (a hovered/focused
// Save button carrying a PUBLIC visible label, and an open menu control), one
// gated value (withheld), one secret value, and one unsupported value whose
// diagnostic reason must never render. Structure and control state are host
// decisions and mirror to every viewer; only the data values differ.

/** Diagnostic text of unproven sensitivity - must NOT appear in rendered output. */
const UNSUPPORTED_REASON = "projector: resolver error for slot api-token at /vault/keys";

function smokeFrame(surfaceId: string): CoViewProjectedRenderFrame {
  return {
    surfaceId,
    root: {
      id: "panel",
      kind: "element",
      box: { x: 0, y: 0, width: 480, height: 300 },
      attrs: { classTokens: ["settings-panel"], ariaRole: "group" },
      children: [
        {
          id: "toolbar",
          kind: "element",
          box: { x: 0, y: 0, width: 480, height: 40 },
          attrs: { ariaRole: "toolbar" },
          children: [
            {
              id: "save-btn",
              kind: "control",
              box: { x: 8, y: 4, width: 112, height: 32 },
              attrs: { controlKind: "button", ariaRole: "button", classTokens: ["btn"] },
              state: { hovered: true, focused: true },
              children: [
                {
                  id: "save-btn-label",
                  kind: "text",
                  box: { x: 20, y: 10, width: 88, height: 20 },
                  value: { state: "visible", value: "Save changes" },
                },
              ],
            },
            {
              id: "options-menu",
              kind: "control",
              box: { x: 128, y: 4, width: 120, height: 32 },
              attrs: { controlKind: "select", ariaRole: "menu", ariaExpanded: true },
              state: { open: true },
            },
          ],
        },
        {
          id: "api-key",
          kind: "text",
          box: { x: 8, y: 56, width: 220, height: 20 },
          value: {
            state: "withheld",
            placeholderShape: { mode: "synthetic", width: 220, height: 20, lines: 1 },
          },
        },
        {
          id: "signing-secret",
          kind: "text",
          box: { x: 8, y: 84, width: 220, height: 20 },
          value: { state: "secret", placeholderShape: { mode: "synthetic" } },
        },
        {
          id: "diag",
          kind: "text",
          box: { x: 8, y: 112, width: 220, height: 20 },
          value: { state: "unsupported", reason: UNSUPPORTED_REASON },
        },
      ],
    },
  };
}

function envelope(sessionId: string, surfaceId = `surface-${sessionId}`) {
  return {
    type: "co-view.render-tree.projected",
    session_id: sessionId,
    frame: smokeFrame(surfaceId),
  };
}

// A CANONICAL render frame - what the integrated path must reject (the store's
// envelope guard is the gate that keeps non-projected traffic out).
function canonicalEnvelope(sessionId: string): WsCoViewRenderTreeFrame {
  return {
    type: "co-view.render-tree.frame",
    session_id: sessionId,
    frame: {
      surfaceId: `surface-${sessionId}`,
      root: { id: "root", kind: "element", box: { x: 0, y: 0, width: 1, height: 1 } },
    },
  };
}

/** Depth-first lookup by preserved node id in the resolved safe tree. */
function findSafeNode(node: SafeViewNode, id: string): SafeViewNode | undefined {
  if (node.id === id) return node;
  for (const child of node.children) {
    const hit = findSafeNode(child, id);
    if (hit) return hit;
  }
  return undefined;
}

/** Run a projected-arm harness against a callback, always disposing after. */
function withProjectedHarness(
  serverId: string,
  sessionId: string,
  run: (harness: ProjectedViewerSmokeHarness) => void,
): void {
  const harness = createProjectedViewerSmokeHarness({
    serverId,
    sessionId,
    projectedEnabled: true,
  });
  try {
    run(harness);
  } finally {
    harness.dispose();
  }
}

/** Resolve the rendered safe frame for a session, asserting one is mounted. */
function renderedSafeFrame(harness: ProjectedViewerSmokeHarness, sessionId: string) {
  const rendered = harness.render(sessionId);
  expect(rendered.kind).toBe("frame");
  if (rendered.kind !== "frame") {
    throw new SmokeAssertionError({ actualKind: rendered.kind, sessionId });
  }
  return rendered.safe;
}

// --- dormant default: legacy stays the sole path -----------------------------

describe("projected viewer smoke - dormant default", () => {
  test("the viewer flag still ships disabled", () => {
    expect(CO_VIEW_PROJECTED_VIEWER_ENABLED).toBe(false);
  });

  test("default harness chooses legacy and never constructs the projected store", () => {
    const harness = createProjectedViewerSmokeHarness({ serverId: "srv", sessionId: "A" });
    expect(harness.choice).toEqual({ kind: "legacy" });
    expect(harness.storesCreatedFor).toEqual([]);
    expect(harness.frame("A")).toBeUndefined();
    expect(harness.render("A")).toEqual({ kind: "legacy" });
    expect(() => harness.dispose()).not.toThrow();
  });

  test("the legacy arm has no store to deliver to (delivery throws, loudly)", () => {
    const harness = createProjectedViewerSmokeHarness({ serverId: "srv", sessionId: "A" });
    try {
      harness.deliver(envelope("A"));
      expect.unreachable("legacy-arm delivery should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ProjectedViewerSmokeError);
      expect((err as ProjectedViewerSmokeError).code).toBe(
        "ERR_PROJECTED_VIEWER_SMOKE_LEGACY_DELIVERY",
      );
      expect((err as ProjectedViewerSmokeError).context).toEqual({
        serverId: "srv",
        sessionId: "A",
      });
    }
    // And the failed delivery changed nothing: still the legacy render.
    expect(harness.render("A")).toEqual({ kind: "legacy" });
  });
});

// --- projected arm via DI: the integrated chain ------------------------------

describe("projected viewer smoke - projected arm via DI", () => {
  test("constructs the real store for the exact serverId, once", () => {
    withProjectedHarness("srv-smoke-1", "A", (harness) => {
      expect(harness.choice).toEqual({
        kind: "projected",
        serverId: "srv-smoke-1",
        sessionId: "A",
      });
      expect(harness.storesCreatedFor).toEqual(["srv-smoke-1"]);
    });
  });

  test("renders the pending placeholder until a frame arrives, then the frame", () => {
    withProjectedHarness("srv-smoke-2", "A", (harness) => {
      expect(harness.render("A")).toEqual({ kind: "pending" });

      harness.deliver(envelope("A"));

      // The store now holds the expected session frame...
      expect(harness.frame("A")).toEqual(smokeFrame("surface-A"));
      // ...and the composed viewer resolves it through the real safe renderer.
      const safe = renderedSafeFrame(harness, "A");
      expect(safe.surfaceId).toBe("surface-A");
      expect(safe.root.id).toBe("panel");
    });
  });

  test("public control label and host control state survive projection", () => {
    withProjectedHarness("srv-smoke-3", "A", (harness) => {
      harness.deliver(envelope("A"));
      const safe = renderedSafeFrame(harness, "A");

      // The Save button mirrors as a real (presentational) button with its
      // host-rendered hover/focus state intact.
      const saveBtn = findSafeNode(safe.root, "save-btn");
      expect(saveBtn?.tag).toBe("button");
      expect(saveBtn?.controlKind).toBe("button");
      expect(saveBtn?.state.hovered).toBe(true);
      expect(saveBtn?.state.focused).toBe(true);

      // Its PUBLIC label is host chrome, not viewer-gated data - it renders.
      const label = findSafeNode(safe.root, "save-btn-label");
      expect(label?.content).toEqual({ kind: "text", text: "Save changes" });

      // The open menu mirrors its open/expanded state.
      const menu = findSafeNode(safe.root, "options-menu");
      expect(menu?.state.open).toBe(true);
      expect(menu?.aria.expanded).toBe(true);
    });
  });

  test("structure and node identity/order are preserved 1:1", () => {
    withProjectedHarness("srv-smoke-4", "A", (harness) => {
      harness.deliver(envelope("A"));
      const safe = renderedSafeFrame(harness, "A");
      expect(safe.root.children.map((c) => c.id)).toEqual([
        "toolbar",
        "api-key",
        "signing-secret",
        "diag",
      ]);
      const toolbar = findSafeNode(safe.root, "toolbar");
      expect(toolbar?.children.map((c) => c.id)).toEqual(["save-btn", "options-menu"]);
    });
  });

  test("withheld/secret values render as bytes-free placeholders; the unsupported reason is dropped", () => {
    withProjectedHarness("srv-smoke-5", "A", (harness) => {
      harness.deliver(envelope("A"));
      const safe = renderedSafeFrame(harness, "A");

      // Gated value: a deterministic placeholder carrying only layout hints.
      expect(findSafeNode(safe.root, "api-key")?.content).toEqual({
        kind: "placeholder",
        placeholder: { reason: "withheld", mode: "synthetic", width: 220, height: 20, lines: 1 },
      });

      // Secret value: placeholder, never any bytes (none existed to begin with -
      // the projected vocabulary cannot carry a secret value).
      expect(findSafeNode(safe.root, "signing-secret")?.content).toEqual({
        kind: "placeholder",
        placeholder: { reason: "secret", mode: "synthetic" },
      });

      // Unsupported value: the diagnostic reason string IS present on the wire
      // frame but the renderer drops it - the rendered tree carries no trace.
      expect(findSafeNode(safe.root, "diag")?.content).toEqual({
        kind: "placeholder",
        placeholder: { reason: "unsupported", mode: "synthetic" },
      });
      expect(JSON.stringify(safe)).not.toContain(UNSUPPORTED_REASON);
    });
  });

  test("switching sessionId never shows another session's frame", () => {
    withProjectedHarness("srv-smoke-6", "A", (harness) => {
      harness.deliver(envelope("A"));

      // Session B has no frame yet: pending placeholder, never A's content.
      expect(harness.render("B")).toEqual({ kind: "pending" });
      expect(harness.frame("B")).toBeUndefined();

      harness.deliver(envelope("B"));
      expect(renderedSafeFrame(harness, "B").surfaceId).toBe("surface-B");
      // Switching back still reads A's own frame.
      expect(renderedSafeFrame(harness, "A").surfaceId).toBe("surface-A");
      // An unknown session stays pending.
      expect(harness.render("ghost")).toEqual({ kind: "pending" });
    });
  });

  test("a canonical envelope is rejected by the integrated path (fail-closed)", () => {
    withProjectedHarness("srv-smoke-7", "A", (harness) => {
      harness.deliver(canonicalEnvelope("A"));
      // The store's envelope guard kept the canonical frame out: still pending.
      expect(harness.frame("A")).toBeUndefined();
      expect(harness.render("A")).toEqual({ kind: "pending" });
    });
  });

  test("dispose tears the chain down without throwing", () => {
    const harness = createProjectedViewerSmokeHarness({
      serverId: "srv-smoke-8",
      sessionId: "A",
      projectedEnabled: true,
    });
    harness.deliver(envelope("A"));
    expect(() => harness.dispose()).not.toThrow();
  });
});
