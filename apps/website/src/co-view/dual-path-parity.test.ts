// CoView dual-path parity tests (CV-FOUND-10).
//
// Proves that the projected viewer path preserves the structure / control-state
// expectations the legacy CoView viewer represents, while still redacting
// protected values. The projected side is never inspected as a raw fixture: every
// projected fact is extracted from the output of the REAL chain - the fixture
// frame is delivered through `createProjectedViewerSmokeHarness` (CV-FOUND-9:
// selector -> mount controller -> real store -> `resolveProjectedFrame`), so the
// parity claim covers the actual safe renderer, not a hand-built tree.
//
// Coverage (the CV-FOUND-10 contract):
//   - The viewer flag still ships disabled (this PR flips nothing).
//   - The legacy fixture extracts the expected concept-level facts (grounding -
//     the parity pass cannot be vacuous).
//   - Projected safe output preserves control/menu structure for the fixture.
//   - Projected safe output preserves labels and interaction state for
//     buttons/menus (projected-only enrichments asserted directly - see
//     dual-path-parity.ts header for the legacy comparison boundary).
//   - Gated/withheld values are placeholders; protected bytes are absent.
//   - Secret and unsupported values are placeholders; the diagnostic string is
//     absent from rendered output.
//   - Session switching never shows stale projected content.
//   - The parity helper passes for the intended shared subset.
//   - Deliberately broken projected fixtures (missing control, changed order,
//     dropped open state, leaked redacted value) FAIL the comparison - the
//     harness provably catches drift, including privacy drift.

import { describe, expect, test } from "bun:test";
import type { CoViewProjectedNode, CoViewProjectedRenderFrame } from "@uncorded/protocol";

import {
  compareParityFacts,
  createDualPathParityFixture,
  extractLegacyParityFacts,
  extractProjectedParityFacts,
  PARITY_FORBIDDEN_DIAGNOSTIC,
  type ParityFacts,
} from "./dual-path-parity";
import { createProjectedViewerSmokeHarness } from "./projected-viewer-smoke";
import { CO_VIEW_PROJECTED_VIEWER_ENABLED, type SafeViewFrame } from "./render-tree-viewer";

class ParityFixtureError extends Error {
  readonly code: "ERR_PARITY_FIXTURE_NODE_NOT_FOUND" | "ERR_PARITY_EXPECTED_FRAME";
  readonly context: Record<string, string>;

  constructor(
    code: "ERR_PARITY_FIXTURE_NODE_NOT_FOUND" | "ERR_PARITY_EXPECTED_FRAME",
    message: string,
    context: Record<string, string>,
  ) {
    super(message);
    this.name = "ParityFixtureError";
    this.code = code;
    this.context = context;
  }
}

// --- fixture plumbing ---------------------------------------------------------

/** Wrap a projected frame in the WS envelope the real store's apply path takes. */
function envelope(sessionId: string, frame: CoViewProjectedRenderFrame) {
  return { type: "co-view.render-tree.projected", session_id: sessionId, frame };
}

/**
 * Deliver a projected frame through the REAL composed chain and resolve what the
 * viewer renders for the session. Disposes the harness before returning.
 */
function renderThroughRealChain(frame: CoViewProjectedRenderFrame): SafeViewFrame {
  const harness = createProjectedViewerSmokeHarness({
    serverId: "srv-parity",
    sessionId: "A",
    projectedEnabled: true,
  });
  try {
    harness.deliver(envelope("A", frame));
    const rendered = harness.render("A");
    if (rendered.kind !== "frame") {
      throw new ParityFixtureError("ERR_PARITY_EXPECTED_FRAME", "expected a rendered frame", {
        actualKind: rendered.kind,
      });
    }
    return rendered.safe;
  } finally {
    harness.dispose();
  }
}

/** Projected parity facts of the fixture, extracted from real safe output. */
function projectedFactsOf(frame: CoViewProjectedRenderFrame): ParityFacts {
  return extractProjectedParityFacts(renderThroughRealChain(frame));
}

// --- fixture mutators (build the "deliberately broken" worlds) -----------------

/** Deep-clone + apply a mutation to the node with `id`. Throws if absent. */
function mutateNode(
  frame: CoViewProjectedRenderFrame,
  id: string,
  mutate: (node: CoViewProjectedNode) => void,
): CoViewProjectedRenderFrame {
  const next = structuredClone(frame);
  const visit = (node: CoViewProjectedNode): boolean => {
    if (node.id === id) {
      mutate(node);
      return true;
    }
    return (node.children ?? []).some(visit);
  };
  if (!visit(next.root)) {
    throw new ParityFixtureError(
      "ERR_PARITY_FIXTURE_NODE_NOT_FOUND",
      "fixture node not found",
      { id },
    );
  }
  return next;
}

/** Deep-clone with the node with `id` removed wherever it appears. */
function withoutNode(frame: CoViewProjectedRenderFrame, id: string): CoViewProjectedRenderFrame {
  const next = structuredClone(frame);
  const prune = (node: CoViewProjectedNode): void => {
    if (node.children === undefined) return;
    node.children = node.children.filter((child) => child.id !== id);
    for (const child of node.children) prune(child);
  };
  prune(next.root);
  return next;
}

// --- dormancy + grounding -------------------------------------------------------

describe("dual-path parity - dormancy and grounding", () => {
  test("the projected viewer flag still ships disabled", () => {
    expect(CO_VIEW_PROJECTED_VIEWER_ENABLED).toBe(false);
  });

  test("the legacy fixture extracts the expected concept-level facts", () => {
    const { legacyState } = createDualPathParityFixture();
    const facts = extractLegacyParityFacts(legacyState);

    // Exact facts, so a parity pass can never be vacuous (empty vs empty).
    expect(facts.controls).toEqual([
      { id: "panel-settings", kind: "panel", label: "General Settings" },
      { id: "panel-preview", kind: "panel", label: "Live Preview" },
      { id: "modal-billing", kind: "modal", open: true, label: "Billing" },
      { id: "menu-options", kind: "menu", open: true, label: "Options" },
      { id: "tab-general", kind: "tab", selected: true },
      { id: "input-display-name", kind: "input" },
      { id: "input-api-token", kind: "input" },
    ]);
    expect(facts.values).toEqual([
      { id: "panel-settings:body", expectation: "visible" },
      { id: "panel-preview:body", expectation: "placeholder" },
      { id: "modal-billing:body", expectation: "placeholder" },
      { id: "input-display-name", expectation: "visible", text: "Dakota" },
      { id: "input-api-token", expectation: "placeholder" },
    ]);
  });
});

// --- parity: the shared subset holds --------------------------------------------

describe("dual-path parity - shared subset", () => {
  test("projected safe output preserves control/menu structure and passes parity", () => {
    const { legacyState, projectedFrame } = createDualPathParityFixture();
    const legacy = extractLegacyParityFacts(legacyState);
    const projected = projectedFactsOf(projectedFrame);

    const result = compareParityFacts(legacy, projected);
    expect(result.mismatches).toEqual([]);
    expect(result.ok).toBe(true);

    // Every legacy control survived projection with its identity intact.
    const projectedIds = new Set(projected.controls.map((c) => c.id));
    for (const control of legacy.controls) {
      expect(projectedIds.has(control.id)).toBe(true);
    }
  });

  test("projected output is a richer superset: projected-only controls do not fail parity", () => {
    const { legacyState, projectedFrame } = createDualPathParityFixture();
    const projected = projectedFactsOf(projectedFrame);

    // Buttons / menu items / the inactive tab exist only in the projected
    // vocabulary (the legacy fixture cannot express them) ...
    const ids = projected.controls.map((c) => c.id);
    expect(ids).toContain("save-btn");
    expect(ids).toContain("menuitem-export");
    expect(ids).toContain("menuitem-delete");
    expect(ids).toContain("tab-advanced");
    // ... and the asymmetric comparison still passes (see previous test).
    expect(compareParityFacts(extractLegacyParityFacts(legacyState), projected).ok).toBe(true);
  });
});

// --- projected-only enrichments: labels + interaction state ----------------------

describe("dual-path parity - labels and interaction state", () => {
  test("buttons and menus keep their labels and host interaction state", () => {
    const { projectedFrame } = createDualPathParityFixture();
    const projected = projectedFactsOf(projectedFrame);
    const byId = new Map(projected.controls.map((c) => [c.id, c]));

    // Save button: hovered + focused host state, public label.
    expect(byId.get("save-btn")).toMatchObject({
      kind: "button",
      label: "Save changes",
      hovered: true,
      focused: true,
      disabled: false,
    });
    // Open menu with its label; its items mirror, including disabled state.
    expect(byId.get("menu-options")).toMatchObject({ kind: "menu", open: true, label: "Options" });
    expect(byId.get("menuitem-export")).toMatchObject({
      kind: "menuitem",
      label: "Export settings",
      disabled: false,
    });
    expect(byId.get("menuitem-delete")).toMatchObject({
      kind: "menuitem",
      label: "Delete server",
      disabled: true,
    });
    // Tabs: active selected, inactive present and unselected.
    expect(byId.get("tab-general")).toMatchObject({ kind: "tab", label: "General", selected: true });
    expect(byId.get("tab-advanced")).toMatchObject({
      kind: "tab",
      label: "Advanced",
      selected: false,
    });
    // The focused input mirrors its host focus.
    expect(byId.get("input-display-name")).toMatchObject({ kind: "input", focused: true });
  });
});

// --- redaction: placeholders, never bytes ----------------------------------------

describe("dual-path parity - protected values", () => {
  test("gated/withheld values are placeholders and protected bytes are absent", () => {
    const { legacyState, projectedFrame } = createDualPathParityFixture();
    const safe = renderThroughRealChain(projectedFrame);
    const projected = extractProjectedParityFacts(safe);
    const values = new Map(projected.values.map((v) => [v.id, v]));

    // The redacted input and the skeleton/redacted bodies resolve to bytes-free
    // placeholders; the authorized input keeps its real text.
    expect(values.get("input-api-token")).toEqual({ id: "input-api-token", expectation: "placeholder" });
    expect(values.get("panel-preview:body")).toEqual({ id: "panel-preview:body", expectation: "placeholder" });
    expect(values.get("modal-billing:body")).toEqual({ id: "modal-billing:body", expectation: "placeholder" });
    expect(values.get("input-display-name")).toEqual({
      id: "input-display-name",
      expectation: "visible",
      text: "Dakota",
    });

    // And the parity comparison enforces exactly these redaction expectations.
    expect(compareParityFacts(extractLegacyParityFacts(legacyState), projected).ok).toBe(true);
  });

  test("secret and unsupported values are placeholders; diagnostic strings are absent", () => {
    const { projectedFrame, forbiddenBytes } = createDualPathParityFixture();
    const safe = renderThroughRealChain(projectedFrame);
    const values = new Map(extractProjectedParityFacts(safe).values.map((v) => [v.id, v]));

    expect(values.get("signing-secret")).toEqual({ id: "signing-secret", expectation: "placeholder" });
    expect(values.get("diag")).toEqual({ id: "diag", expectation: "placeholder" });

    // The diagnostic reason exists on the WIRE frame but never in safe output.
    expect(JSON.stringify(projectedFrame)).toContain(PARITY_FORBIDDEN_DIAGNOSTIC);
    const rendered = JSON.stringify(safe);
    for (const forbidden of forbiddenBytes) {
      expect(rendered).not.toContain(forbidden);
    }
  });
});

// --- session isolation ------------------------------------------------------------

describe("dual-path parity - session isolation", () => {
  test("session switching does not show stale projected content", () => {
    const { projectedFrame } = createDualPathParityFixture();
    const variantB = mutateNode(projectedFrame, "menu-options:label", (node) => {
      node.value = { state: "visible", value: "Options (B)" };
    });

    const harness = createProjectedViewerSmokeHarness({
      serverId: "srv-parity",
      sessionId: "A",
      projectedEnabled: true,
    });
    try {
      harness.deliver(envelope("A", projectedFrame));

      // B has no frame yet: pending, never A's content.
      expect(harness.render("B")).toEqual({ kind: "pending" });

      harness.deliver(envelope("B", variantB));
      const renderedB = harness.render("B");
      const renderedA = harness.render("A");
      if (renderedA.kind !== "frame" || renderedB.kind !== "frame") {
        throw new ParityFixtureError("ERR_PARITY_EXPECTED_FRAME", "expected rendered frames", {
          a: renderedA.kind,
          b: renderedB.kind,
        });
      }

      // Each session renders its own facts - no bleed in either direction.
      const menuLabel = (facts: ParityFacts) =>
        facts.controls.find((c) => c.id === "menu-options")?.label;
      expect(menuLabel(extractProjectedParityFacts(renderedB.safe))).toBe("Options (B)");
      expect(menuLabel(extractProjectedParityFacts(renderedA.safe))).toBe("Options");
    } finally {
      harness.dispose();
    }
  });
});

// --- drift detection: broken fixtures must fail ------------------------------------

describe("dual-path parity - drift detection", () => {
  test("a missing control fails the comparison", () => {
    const { legacyState, projectedFrame } = createDualPathParityFixture();
    const broken = withoutNode(projectedFrame, "menu-options");

    const result = compareParityFacts(
      extractLegacyParityFacts(legacyState),
      projectedFactsOf(broken),
    );
    expect(result.ok).toBe(false);
    expect(result.mismatches).toEqual([{ kind: "missing-control", id: "menu-options" }]);
  });

  test("changed control order fails the comparison", () => {
    const { legacyState, projectedFrame } = createDualPathParityFixture();
    const broken = mutateNode(projectedFrame, "workspace", (node) => {
      node.children = [...(node.children ?? [])].reverse();
    });

    const result = compareParityFacts(
      extractLegacyParityFacts(legacyState),
      projectedFactsOf(broken),
    );
    expect(result.ok).toBe(false);
    expect(result.mismatches).toEqual([
      {
        kind: "order-mismatch",
        controlKind: "panel",
        expected: ["panel-settings", "panel-preview"],
        actual: ["panel-preview", "panel-settings"],
      },
    ]);
  });

  test("dropped open state fails the comparison", () => {
    const { legacyState, projectedFrame } = createDualPathParityFixture();
    const broken = mutateNode(projectedFrame, "menu-options", (node) => {
      node.state = { open: false };
    });

    const result = compareParityFacts(
      extractLegacyParityFacts(legacyState),
      projectedFactsOf(broken),
    );
    expect(result.ok).toBe(false);
    expect(result.mismatches).toEqual([
      { kind: "state-mismatch", id: "menu-options", field: "open", expected: true, actual: false },
    ]);
  });

  test("a leaked value on a redacted slot fails the comparison (privacy drift)", () => {
    const { legacyState, projectedFrame } = createDualPathParityFixture();
    // A broken projector that resolves the redacted API token as visible: the
    // structure still matches, but the redaction expectation must catch it.
    const broken = mutateNode(projectedFrame, "input-api-token", (node) => {
      node.value = { state: "visible", value: "tok-live-leaked" };
    });

    const result = compareParityFacts(
      extractLegacyParityFacts(legacyState),
      projectedFactsOf(broken),
    );
    expect(result.ok).toBe(false);
    expect(result.mismatches).toEqual([
      {
        kind: "value-expectation-mismatch",
        id: "input-api-token",
        expected: "placeholder",
        actual: "visible",
      },
    ]);
    // Fail-closed reporting: the mismatch never echoes the leaked bytes.
    expect(JSON.stringify(result)).not.toContain("tok-live-leaked");
  });
});
