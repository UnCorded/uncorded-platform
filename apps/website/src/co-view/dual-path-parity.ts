// CoView dual-path parity harness - pure helpers + dual fixture (CV-FOUND-10).
//
// Test-only. Proves that the projected viewer path (CV-FOUND-1..9) preserves the
// UI structure / control-state expectations the legacy CoView viewer represents,
// while still redacting protected values. Nothing here is imported by live code,
// no flag is flipped, and no production file changes.
//
// The two worlds being compared:
//   - LEGACY: the host broadcasts `CoViewShellState` (state-schema.ts) and the
//     viewer re-renders it with the host's own component machinery. The state is
//     concept-level: panel layout + meta, modal/popover/context-menu stacks,
//     tabs, input shadows. There is no per-control render tree.
//   - PROJECTED: the host publishes a sanitized render tree; the runtime projects
//     per-viewer values; `resolveProjectedFrame` (render-tree-viewer.ts) resolves
//     the projected frame into a `SafeViewFrame`.
//
// Comparison boundary (why this is fixture-based, per CV-FOUND-10):
//   The legacy viewer has no extractable per-control facts at runtime - hover and
//   focus live in the cursor layer (PR-CV4), buttons/menu items are host
//   components re-rendered from layout, not shell-state entries. Deriving facts
//   from the LIVE legacy viewer would mean refactoring ViewerSession /
//   viewer-overlay, which is explicitly out of scope. So the harness compares the
//   two REPRESENTATIONS of one host interaction: a legacy `CoViewShellState`
//   fixture and a projected render-tree fixture, built side by side with a shared
//   id convention (a panel/modal body slot is `${id}:body`, a chrome label node
//   is `${id}:label`).
//
//   The comparable ("shared") subset is what legacy shell state can genuinely
//   express:
//     - control existence + stable ids (panels, modals, menus, tabs, inputs),
//     - public chrome labels (panel itemLabel, modal title, popover label),
//     - open state (presence in a modal/popover/context-menu stack),
//     - selected state (the tabs control's activeId),
//     - per-kind relative order (legacy state is grouped per concept and has no
//       global cross-group ordering, so global DFS order is NOT comparable),
//     - data-slot redaction expectations (input valueRedacted, panel visibility,
//       modal redacted) - an EXPECTATION about bytes, never the bytes themselves.
//   Hover / focus / pressed / disabled and button/menuitem nodes exist only in
//   the projected vocabulary; tests assert them directly against the projected
//   facts rather than pretending legacy expresses them.
//
// Fail-closed reporting: mismatch values never echo projected-side strings. A
// projected label/text that fails comparison is of unproven provenance, so only
// the legacy-authorized EXPECTED string is reported
// ([[fail-closed-never-echo-rejected-input]]). Enum/boolean actuals are safe.

import type { CoViewBox, CoViewProjectedRenderFrame, PanelContent } from "@uncorded/protocol";

import type { PanelNode } from "../lib/panel-layout";
import type { SafeViewFrame, SafeViewNode } from "./render-tree-viewer";
import type { CoViewShellState } from "./state-schema";

// ---------------------------------------------------------------------------
// Parity fact vocabulary
// ---------------------------------------------------------------------------

/**
 * Concept-level control kinds the two worlds share. Legacy shell state can
 * express `panel`/`modal`/`menu`/`tab`/`input`; `button` and `menuitem` are
 * recognized on the projected side only (legacy renders them as components, not
 * state), so they never appear in legacy facts and are never parity-compared.
 */
export type ParityControlKind =
  | "panel"
  | "modal"
  | "menu"
  | "menuitem"
  | "tab"
  | "button"
  | "input";

/** Host interaction-state fields a fact may carry. */
const PARITY_STATE_FIELDS = ["open", "selected", "hovered", "focused", "disabled"] as const;
export type ParityStateField = (typeof PARITY_STATE_FIELDS)[number];

/**
 * One comparable structure/control fact. Optional fields mean "this world does
 * not express the property" - the comparator checks only fields the LEGACY fact
 * defines, so legacy stays the expectation baseline and projected-only
 * enrichments (hover/focus/...) never fail parity.
 */
export interface ParityControlFact {
  /** Stable id, shared across worlds by the dual-fixture id convention. */
  id: string;
  kind: ParityControlKind;
  /** Public chrome label (never a protected value). */
  label?: string | undefined;
  open?: boolean | undefined;
  selected?: boolean | undefined;
  hovered?: boolean | undefined;
  focused?: boolean | undefined;
  disabled?: boolean | undefined;
}

export type ParityValueExpectation = "visible" | "placeholder";

/**
 * An expectation about one data-bearing slot. `placeholder` asserts NO bytes may
 * render for the slot; `visible` asserts real (authorized) content renders.
 * `text` is carried only for legacy-authorized values (e.g. an input shadow with
 * `valueRedacted: false`), so comparing it never requires protected bytes.
 */
export interface ParityValueFact {
  id: string;
  expectation: ParityValueExpectation;
  text?: string | undefined;
}

/** The comparable facts one world expresses, in that world's traversal order. */
export interface ParityFacts {
  controls: ParityControlFact[];
  values: ParityValueFact[];
}

// ---------------------------------------------------------------------------
// Parity comparison result
// ---------------------------------------------------------------------------

/**
 * One detected drift. String actuals from the projected side are deliberately
 * absent (see header: fail-closed reporting); enum/boolean actuals are safe.
 */
export type ParityMismatch =
  | { kind: "missing-control"; id: string }
  | { kind: "control-kind-mismatch"; id: string; expected: ParityControlKind; actual: ParityControlKind }
  | { kind: "label-mismatch"; id: string; expected: string }
  | { kind: "state-mismatch"; id: string; field: ParityStateField; expected: boolean; actual: boolean }
  | { kind: "order-mismatch"; controlKind: ParityControlKind; expected: string[]; actual: string[] }
  | { kind: "missing-value"; id: string }
  | { kind: "value-expectation-mismatch"; id: string; expected: ParityValueExpectation; actual: ParityValueExpectation }
  | { kind: "value-text-mismatch"; id: string; expected: string };

export interface ParityResult {
  ok: boolean;
  mismatches: ParityMismatch[];
}

// ---------------------------------------------------------------------------
// Legacy fact extraction (CoViewShellState -> facts)
// ---------------------------------------------------------------------------

/** In-order leaf ids of a legacy panel layout - the order the viewer renders. */
function collectLeafIds(node: PanelNode, out: string[]): string[] {
  if (node.type === "leaf") {
    out.push(node.id);
    return out;
  }
  collectLeafIds(node.first, out);
  collectLeafIds(node.second, out);
  return out;
}

/** Public chrome label of a panel content descriptor, if it carries one. */
function panelContentLabel(content: PanelContent | undefined): string | undefined {
  if (content !== undefined && "itemLabel" in content) return content.itemLabel;
  return undefined;
}

/**
 * Extract the comparable facts a legacy `CoViewShellState` expresses. Pure.
 *
 * Per-concept semantics (state-schema.ts):
 *   - panels: in-order leaves of the ACTIVE workspace layout. Chrome label
 *     renders for `shared`/`skeleton` visibility ("chrome only" still shows
 *     chrome); a `hidden` panel shows only a host placeholder, so no label fact.
 *     The body slot (`${id}:body`) is `visible` only for `shared`.
 *   - modals/popovers: presence in the stack == open. `redacted` blanks the
 *     body, so a body fact is emitted as `placeholder`; a non-redacted popover
 *     emits NO body fact (its items are host components, not shell state).
 *   - context menus: open menus with no label/body (the selected item is never
 *     broadcast).
 *   - tabs: legacy carries only the ACTIVE tab id per control - the fact is
 *     "that tab exists and is selected". The full tab list is not comparable.
 *   - inputs: a control fact plus a value fact - `valueRedacted` decides
 *     placeholder vs visible, and only a non-redacted shadow carries text.
 */
export function extractLegacyParityFacts(state: CoViewShellState): ParityFacts {
  const controls: ParityControlFact[] = [];
  const values: ParityValueFact[] = [];

  const workspace = state.workspace;
  const layout = workspace?.layouts[workspace.activeId];
  if (layout) {
    for (const leafId of collectLeafIds(layout, [])) {
      const meta = state.panelMeta?.[leafId];
      const label =
        meta !== undefined && meta.visibility !== "hidden"
          ? panelContentLabel(meta.content)
          : undefined;
      controls.push({ id: leafId, kind: "panel", ...(label !== undefined ? { label } : {}) });
      if (meta !== undefined) {
        values.push({
          id: `${leafId}:body`,
          expectation: meta.visibility === "shared" ? "visible" : "placeholder",
        });
      }
    }
  }

  for (const modal of state.modals ?? []) {
    controls.push({
      id: modal.id,
      kind: "modal",
      open: true,
      ...(modal.title !== undefined ? { label: modal.title } : {}),
    });
    if (modal.redacted) values.push({ id: `${modal.id}:body`, expectation: "placeholder" });
  }

  for (const popover of state.popovers ?? []) {
    controls.push({
      id: popover.id,
      kind: "menu",
      open: true,
      ...(popover.label !== undefined ? { label: popover.label } : {}),
    });
    if (popover.redacted) values.push({ id: `${popover.id}:body`, expectation: "placeholder" });
  }

  for (const menu of state.contextMenus ?? []) {
    controls.push({ id: menu.id, kind: "menu", open: true });
  }

  for (const tabs of Object.values(state.tabs ?? {})) {
    controls.push({ id: tabs.activeId, kind: "tab", selected: true });
  }

  for (const [inputId, shadow] of Object.entries(state.inputs ?? {})) {
    controls.push({ id: inputId, kind: "input" });
    values.push({
      id: inputId,
      expectation: shadow.valueRedacted ? "placeholder" : "visible",
      ...(!shadow.valueRedacted && shadow.value !== undefined ? { text: shadow.value } : {}),
    });
  }

  return { controls, values };
}

// ---------------------------------------------------------------------------
// Projected fact extraction (SafeViewFrame -> facts)
// ---------------------------------------------------------------------------

/**
 * Recognize a safe view node as a parity control. The renderer's allowlisted
 * control kind wins (button/menuitem/tab/input map 1:1); structural concepts
 * (panel/modal/menu) are recognized by their mirrored ARIA role. Anything else
 * (plain layout, text, toolbars) is structure, not a comparable control.
 */
function classifyProjectedControl(node: SafeViewNode): ParityControlKind | undefined {
  switch (node.controlKind) {
    case "button":
      return "button";
    case "menuitem":
      return "menuitem";
    case "tab":
      return "tab";
    case "input":
      return "input";
    default:
      break;
  }
  switch (node.aria.role) {
    case "group":
      return "panel";
    case "dialog":
      return "modal";
    case "menu":
      return "menu";
    default:
      return undefined;
  }
}

/**
 * A control's chrome label: the first DIRECT text child that resolved to real
 * (authorized) text. A placeholder child yields no label - a label fact can
 * never surface protected bytes because the safe renderer already stripped them.
 */
function directTextLabel(node: SafeViewNode): string | undefined {
  for (const child of node.children) {
    if (child.kind === "text" && child.content.kind === "text") return child.content.text;
  }
  return undefined;
}

/**
 * Extract the comparable facts a resolved `SafeViewFrame` expresses. Pure;
 * operates strictly on the SAFE renderer output, so every byte it can ever
 * report has already passed the privacy boundary in render-tree-viewer.ts.
 * Controls carry the full mirrored state-flag set; every node with non-empty
 * content yields a value fact (text -> `visible`, placeholder -> `placeholder`).
 */
export function extractProjectedParityFacts(frame: SafeViewFrame): ParityFacts {
  const controls: ParityControlFact[] = [];
  const values: ParityValueFact[] = [];

  const walk = (node: SafeViewNode): void => {
    const kind = classifyProjectedControl(node);
    if (kind !== undefined) {
      const label = directTextLabel(node);
      controls.push({
        id: node.id,
        kind,
        ...(label !== undefined ? { label } : {}),
        open: node.state.open,
        selected: node.state.selected,
        hovered: node.state.hovered,
        focused: node.state.focused,
        disabled: node.state.disabled,
      });
    }
    if (node.content.kind === "text") {
      values.push({ id: node.id, expectation: "visible", text: node.content.text });
    } else if (node.content.kind === "placeholder") {
      values.push({ id: node.id, expectation: "placeholder" });
    }
    for (const child of node.children) walk(child);
  };

  walk(frame.root);
  return { controls, values };
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

/**
 * Compare legacy facts (the expectation baseline) against projected facts.
 * Asymmetric by design: every legacy fact must hold on the projected side, while
 * projected-only controls/values (buttons, menu items, labels, hover state) are
 * allowed - the projected path is a richer representation of the same host UI,
 * not a 1:1 serialization of shell state.
 *
 * Order is compared PER KIND, with both sequences filtered to the shared id set:
 * legacy state has no cross-concept ordering, and a control already reported as
 * missing should not also fail ordering.
 */
export function compareParityFacts(legacy: ParityFacts, projected: ParityFacts): ParityResult {
  const mismatches: ParityMismatch[] = [];
  const projectedControls = new Map(projected.controls.map((c) => [c.id, c]));

  for (const want of legacy.controls) {
    const got = projectedControls.get(want.id);
    if (got === undefined) {
      mismatches.push({ kind: "missing-control", id: want.id });
      continue;
    }
    if (got.kind !== want.kind) {
      mismatches.push({
        kind: "control-kind-mismatch",
        id: want.id,
        expected: want.kind,
        actual: got.kind,
      });
    }
    if (want.label !== undefined && got.label !== want.label) {
      mismatches.push({ kind: "label-mismatch", id: want.id, expected: want.label });
    }
    for (const field of PARITY_STATE_FIELDS) {
      const expected = want[field];
      if (expected === undefined) continue;
      const actual = got[field] ?? false;
      if (actual !== expected) {
        mismatches.push({ kind: "state-mismatch", id: want.id, field, expected, actual });
      }
    }
  }

  const seenKinds = new Set<ParityControlKind>();
  for (const want of legacy.controls) {
    if (seenKinds.has(want.kind)) continue;
    seenKinds.add(want.kind);
    const expected = legacy.controls
      .filter((c) => c.kind === want.kind && projectedControls.has(c.id))
      .map((c) => c.id);
    const sharedIds = new Set(expected);
    const actual = projected.controls
      .filter((c) => c.kind === want.kind && sharedIds.has(c.id))
      .map((c) => c.id);
    if (expected.length !== actual.length || expected.some((id, i) => actual[i] !== id)) {
      mismatches.push({ kind: "order-mismatch", controlKind: want.kind, expected, actual });
    }
  }

  const projectedValues = new Map(projected.values.map((v) => [v.id, v]));
  for (const want of legacy.values) {
    const got = projectedValues.get(want.id);
    if (got === undefined) {
      mismatches.push({ kind: "missing-value", id: want.id });
      continue;
    }
    if (got.expectation !== want.expectation) {
      mismatches.push({
        kind: "value-expectation-mismatch",
        id: want.id,
        expected: want.expectation,
        actual: got.expectation,
      });
    } else if (want.text !== undefined && got.text !== want.text) {
      mismatches.push({ kind: "value-text-mismatch", id: want.id, expected: want.text });
    }
  }

  return { ok: mismatches.length === 0, mismatches };
}

// ---------------------------------------------------------------------------
// Dual fixture - one host interaction, both representations
// ---------------------------------------------------------------------------

/**
 * Diagnostic text of unproven sensitivity carried by the unsupported projected
 * value. It exists on the WIRE frame; the safe renderer must drop it, and the
 * tests assert it never appears in rendered output.
 */
export const PARITY_FORBIDDEN_DIAGNOSTIC =
  "projector: resolver error for slot signing-key at /vault/keys";

export interface DualPathParityFixture {
  /** The host interaction in the legacy world's vocabulary. */
  legacyState: CoViewShellState;
  /** The SAME host interaction as a projected per-viewer render frame. */
  projectedFrame: CoViewProjectedRenderFrame;
  /** Strings that must never appear in resolved safe output. */
  forbiddenBytes: readonly string[];
}

function box(x: number, y: number, width: number, height: number): CoViewBox {
  return { x, y, width, height };
}

/**
 * The shared host interaction, expressed in both vocabularies:
 *
 *   A settings surface with two panels - "General Settings" (shared) holding a
 *   tabs control (General active / Advanced inactive), a display-name input
 *   sharing its value, a redacted API-token input, and public body text; and
 *   "Live Preview" (skeleton: chrome only, blanked body). A redacted "Billing"
 *   modal and an open "Options" popover menu are stacked on top.
 *
 * Projected-only enrichments the legacy vocabulary cannot express (asserted
 * directly in tests, excluded from the parity subset): a hovered+focused Save
 * button, menu items (one disabled), the input's focus flag, a secret value
 * node, and an unsupported value node carrying the forbidden diagnostic.
 */
export function createDualPathParityFixture(): DualPathParityFixture {
  const legacyState: CoViewShellState = {
    route: { pathname: "/server/srv-parity/settings" },
    workspace: {
      activeId: "ws-main",
      layouts: {
        "ws-main": {
          type: "split",
          id: "split-root",
          direction: "horizontal",
          ratio: 0.6,
          first: { type: "leaf", id: "panel-settings" },
          second: { type: "leaf", id: "panel-preview" },
        },
      },
    },
    panelMeta: {
      "panel-settings": {
        visibility: "shared",
        content: {
          type: "plugin",
          serverId: "srv-parity",
          slug: "settings",
          itemId: "general",
          itemLabel: "General Settings",
        },
      },
      "panel-preview": {
        visibility: "skeleton",
        content: {
          type: "plugin",
          serverId: "srv-parity",
          slug: "preview",
          itemId: "live",
          itemLabel: "Live Preview",
        },
      },
    },
    modals: [{ id: "modal-billing", title: "Billing", redacted: true }],
    popovers: [
      { id: "menu-options", anchorId: "panel-settings", label: "Options", redacted: false },
    ],
    tabs: { "tabs-settings": { activeId: "tab-general" } },
    inputs: {
      "input-display-name": { caret: 6, valueRedacted: false, value: "Dakota" },
      "input-api-token": { caret: 0, valueRedacted: true },
    },
  };

  const projectedFrame: CoViewProjectedRenderFrame = {
    surfaceId: "shell:settings",
    root: {
      id: "shell-root",
      kind: "element",
      box: box(0, 0, 960, 600),
      attrs: { classTokens: ["co-view-shell"] },
      children: [
        {
          id: "workspace",
          kind: "element",
          box: box(0, 0, 960, 600),
          children: [
            {
              id: "panel-settings",
              kind: "element",
              box: box(0, 0, 576, 600),
              attrs: { ariaRole: "group", classTokens: ["co-view-panel"] },
              children: [
                {
                  id: "panel-settings:label",
                  kind: "text",
                  box: box(8, 8, 200, 20),
                  value: { state: "visible", value: "General Settings" },
                },
                {
                  id: "tabs-settings",
                  kind: "element",
                  box: box(8, 36, 560, 32),
                  attrs: { ariaRole: "toolbar" },
                  children: [
                    {
                      id: "tab-general",
                      kind: "control",
                      box: box(8, 36, 96, 32),
                      attrs: { controlKind: "tab", ariaRole: "tab" },
                      state: { selected: true },
                      children: [
                        {
                          id: "tab-general:label",
                          kind: "text",
                          box: box(16, 42, 80, 20),
                          value: { state: "visible", value: "General" },
                        },
                      ],
                    },
                    {
                      id: "tab-advanced",
                      kind: "control",
                      box: box(108, 36, 96, 32),
                      attrs: { controlKind: "tab", ariaRole: "tab" },
                      children: [
                        {
                          id: "tab-advanced:label",
                          kind: "text",
                          box: box(116, 42, 80, 20),
                          value: { state: "visible", value: "Advanced" },
                        },
                      ],
                    },
                  ],
                },
                {
                  id: "input-display-name",
                  kind: "control",
                  box: box(8, 84, 280, 32),
                  attrs: { controlKind: "input", ariaRole: "textbox" },
                  state: { focused: true },
                  value: { state: "visible", value: "Dakota" },
                },
                {
                  id: "input-api-token",
                  kind: "control",
                  box: box(8, 128, 280, 32),
                  attrs: { controlKind: "input", ariaRole: "textbox" },
                  value: {
                    state: "withheld",
                    placeholderShape: { mode: "synthetic", width: 280, height: 32, lines: 1 },
                  },
                },
                {
                  id: "save-btn",
                  kind: "control",
                  box: box(8, 176, 120, 32),
                  attrs: { controlKind: "button", ariaRole: "button", classTokens: ["btn"] },
                  state: { hovered: true, focused: true },
                  children: [
                    {
                      id: "save-btn:label",
                      kind: "text",
                      box: box(20, 182, 96, 20),
                      value: { state: "visible", value: "Save changes" },
                    },
                  ],
                },
                {
                  id: "panel-settings:body",
                  kind: "text",
                  box: box(8, 224, 280, 20),
                  value: { state: "visible", value: "Theme: Dark" },
                },
              ],
            },
            {
              id: "panel-preview",
              kind: "element",
              box: box(576, 0, 384, 600),
              attrs: { ariaRole: "group", classTokens: ["co-view-panel"] },
              children: [
                {
                  id: "panel-preview:label",
                  kind: "text",
                  box: box(584, 8, 200, 20),
                  value: { state: "visible", value: "Live Preview" },
                },
                {
                  id: "panel-preview:body",
                  kind: "text",
                  box: box(584, 36, 368, 540),
                  value: {
                    state: "withheld",
                    placeholderShape: { mode: "synthetic", width: 368, height: 540 },
                  },
                },
              ],
            },
          ],
        },
        {
          id: "modal-billing",
          kind: "element",
          box: box(280, 160, 400, 280),
          attrs: { ariaRole: "dialog" },
          state: { open: true },
          children: [
            {
              id: "modal-billing:label",
              kind: "text",
              box: box(296, 172, 120, 20),
              value: { state: "visible", value: "Billing" },
            },
            {
              id: "modal-billing:body",
              kind: "text",
              box: box(296, 204, 368, 220),
              value: {
                state: "withheld",
                placeholderShape: { mode: "synthetic", width: 368, height: 220, lines: 6 },
              },
            },
          ],
        },
        {
          id: "menu-options",
          kind: "element",
          box: box(120, 60, 180, 120),
          attrs: { ariaRole: "menu", ariaExpanded: true },
          state: { open: true },
          children: [
            {
              id: "menu-options:label",
              kind: "text",
              box: box(128, 66, 120, 20),
              value: { state: "visible", value: "Options" },
            },
            {
              id: "menuitem-export",
              kind: "control",
              box: box(124, 92, 172, 28),
              attrs: { controlKind: "menuitem", ariaRole: "menuitem" },
              children: [
                {
                  id: "menuitem-export:label",
                  kind: "text",
                  box: box(132, 96, 140, 20),
                  value: { state: "visible", value: "Export settings" },
                },
              ],
            },
            {
              id: "menuitem-delete",
              kind: "control",
              box: box(124, 124, 172, 28),
              attrs: { controlKind: "menuitem", ariaRole: "menuitem" },
              state: { disabled: true },
              children: [
                {
                  id: "menuitem-delete:label",
                  kind: "text",
                  box: box(132, 128, 140, 20),
                  value: { state: "visible", value: "Delete server" },
                },
              ],
            },
          ],
        },
        {
          id: "signing-secret",
          kind: "text",
          box: box(8, 560, 220, 20),
          value: { state: "secret", placeholderShape: { mode: "synthetic" } },
        },
        {
          id: "diag",
          kind: "text",
          box: box(8, 584, 220, 16),
          value: { state: "unsupported", reason: PARITY_FORBIDDEN_DIAGNOSTIC },
        },
      ],
    },
  };

  return { legacyState, projectedFrame, forbiddenBytes: [PARITY_FORBIDDEN_DIAGNOSTIC] };
}
