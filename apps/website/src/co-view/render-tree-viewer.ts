// CoView projected render-tree viewer renderer — pure core (CV-FOUND-5).
//
// The website-side counterpart to the runtime projector: it turns a
// `CoViewProjectedRenderFrame` (what a viewer receives over the wire) into a
// safe, serializable *view model* that a SolidJS component renders to the DOM
// (`render-tree-viewer-view.tsx`). All security-relevant decisions live here in
// pure functions so they are exhaustively testable without a DOM.
//
// Contract (foundation-plan §0, §4; product CoView invariants):
//   - Host UI structure / control state mirrors to every viewer. Buttons, menu
//     items, tabs, hover/open/focus state, and public control labels render
//     regardless of the viewer's data permissions — control visibility is a
//     host decision, never a viewer entitlement.
//   - Only the per-node *data value* differs per viewer:
//       `visible`     → render the real value.
//       `withheld`    → deterministic placeholder, never any bytes.
//       `secret`      → deterministic placeholder, never any bytes.
//       `unsupported` → safe placeholder; the `reason` string is NOT rendered
//                       (it is producer/runtime diagnostic text of unproven
//                       sensitivity — fail closed, mirror [[fail-closed-never-echo-rejected-input]]).
//   - This is a sanitized render tree, NOT raw DOM. The renderer emits no
//     `src`/`href`/inline-style/`title`/`data-*`/arbitrary attributes: it reads
//     ONLY the allowlisted safe fields off each node, so an unsafe attribute
//     cannot be introduced even if a malformed node smuggles extra keys.
//   - Node identity / kind / order / structure are preserved 1:1 so the viewer
//     stays in video-like parity with the host surface across entitlements.
//
// This module is pure and side-effect free. It is NOT wired into the live app;
// the companion view component is gated behind `CO_VIEW_PROJECTED_VIEWER_ENABLED`.

import {
  CO_VIEW_CONTROL_KINDS,
  type CoViewBox,
  type CoViewControlKind,
  type CoViewNodeKind,
  type CoViewNodeState,
  type CoViewProjectedNode,
  type CoViewProjectedRenderFrame,
  type CoViewProjectedValue,
  type CoViewSafeAttrs,
  type JsonValue,
  type PlaceholderShape,
} from "@uncorded/protocol";

/**
 * Master switch for the projected viewer renderer. Disabled: this PR ships the
 * renderer + tests only and does not wire it into any live CoView surface
 * (mirrors `CO_VIEW_RENDER_TREE_PRODUCER_ENABLED` / `_TRANSPORT_ENABLED`).
 */
export const CO_VIEW_PROJECTED_VIEWER_ENABLED = false;

/**
 * The fixed, tiny set of DOM tags the renderer is ever allowed to emit. Every
 * projected node kind resolves into one of these — no `img`, `canvas`, `iframe`,
 * `script`, `a`, … ever reaches the DOM. Image/canvas nodes become layout boxes
 * (`div`); media bytes/URLs are never fetched because no `src` attribute exists
 * in the projected vocabulary and the renderer emits none.
 */
export type SafeViewTag = "div" | "span" | "button";

/**
 * Why a node renders a placeholder instead of a value. Distinct from the value
 * `state` only in that `withheld` and `secret` both mean "a real value exists on
 * the host but no bytes may reach this viewer"; `unsupported` means the runtime
 * could not project the value at all.
 */
export type SafeViewPlaceholderReason = "withheld" | "secret" | "unsupported";

/**
 * The deterministic, bytes-free shape a placeholder occupies. Carries only
 * layout hints already present in the projected `PlaceholderShape` — never a
 * value, never a reason string.
 */
export interface SafeViewPlaceholder {
  reason: SafeViewPlaceholderReason;
  mode: PlaceholderShape["mode"];
  width?: number | undefined;
  height?: number | undefined;
  lines?: number | undefined;
}

/**
 * The resolved content slot of a node. Exactly one of:
 *   - `text`        : a real, authorized value coerced to a display string.
 *   - `placeholder` : a withheld/secret/unsupported stand-in carrying no bytes.
 *   - `empty`       : the node carries no value (pure structure/container).
 */
export type SafeViewContent =
  | { kind: "text"; text: string }
  | { kind: "placeholder"; placeholder: SafeViewPlaceholder }
  | { kind: "empty" };

/**
 * Host interaction/control state, copied through verbatim from the projected
 * node so the viewer mirrors hover/open/focus/etc. These are presentation flags
 * only — they reflect what the host rendered and never grant the viewer the
 * authority to execute the control.
 */
export interface SafeViewStateFlags {
  hovered: boolean;
  focused: boolean;
  pressed: boolean;
  selected: boolean;
  open: boolean;
  disabled: boolean;
}

/**
 * The safe ARIA subset the renderer mirrors — exactly the allowlisted attrs from
 * `CoViewSafeAttrs`, nothing else.
 */
export interface SafeViewAria {
  role?: string | undefined;
  expanded?: boolean | undefined;
  checked?: boolean | undefined;
}

/**
 * A fully-resolved, serializable view node. The view component renders this
 * directly; tests assert against it. It contains no callable values, no raw
 * attributes, and (for protected nodes) no bytes — everything here is safe to
 * show any viewer.
 */
export interface SafeViewNode {
  /** Preserved node identity (== the projected node id == structure key). */
  id: string;
  /** Preserved projected kind (drives styling/semantics, not the emitted tag). */
  kind: CoViewNodeKind;
  /** The single DOM tag this node renders as, from the fixed allowlist. */
  tag: SafeViewTag;
  /** Allowlisted class tokens, passed through to `class` only. */
  classTokens: string[];
  /** Allowlisted ARIA mirror. */
  aria: SafeViewAria;
  /** Control kind if this is a control node — drives semantics, mirrors always. */
  controlKind?: CoViewControlKind | undefined;
  /** Mirrored host interaction state. */
  state: SafeViewStateFlags;
  /** Layout box, preserved for parity. */
  box: CoViewBox;
  /** Resolved, bytes-safe content slot. */
  content: SafeViewContent;
  /** Children in preserved order. */
  children: SafeViewNode[];
}

/** A whole projected frame resolved to a safe view tree. */
export interface SafeViewFrame {
  surfaceId: string;
  root: SafeViewNode;
}

// ---------------------------------------------------------------------------
// Tag resolution (kind → fixed allowlist)
// ---------------------------------------------------------------------------

/**
 * Map a projected node kind to one of the three allowed tags. `text`/`icon`
 * become `span`; a `control` node whose `controlKind` is `button` becomes a
 * real `button`; everything else (including `image`/`canvas`, which render as
 * layout boxes) becomes a `div`. Unknown kinds — which the schema would already
 * have rejected upstream — fall through to the safest container (`div`).
 */
function resolveTag(kind: CoViewNodeKind, controlKind: CoViewControlKind | undefined): SafeViewTag {
  if (kind === "text" || kind === "icon") return "span";
  if (kind === "control" && controlKind === "button") return "button";
  return "div";
}

// ---------------------------------------------------------------------------
// Safe-attr extraction (read ONLY the allowlist)
// ---------------------------------------------------------------------------

/**
 * Pull the allowlisted class tokens, returning a fresh string array. Reads only
 * `attrs.classTokens`; any other key on `attrs` is ignored, so a malformed node
 * cannot smuggle a raw attribute through.
 */
function extractClassTokens(attrs: CoViewSafeAttrs | undefined): string[] {
  const tokens = attrs?.classTokens;
  if (!Array.isArray(tokens)) return [];
  // Keep only string tokens; never coerce objects/etc. into class strings.
  return tokens.filter((t): t is string => typeof t === "string");
}

/** Pull the allowlisted ARIA mirror — role/expanded/checked only. */
const SAFE_ARIA_ROLES = new Set([
  "button",
  "checkbox",
  "dialog",
  "grid",
  "group",
  "list",
  "listitem",
  "menu",
  "menuitem",
  "none",
  "presentation",
  "radio",
  "row",
  "status",
  "tab",
  "tabpanel",
  "textbox",
  "toolbar",
  "tree",
  "treeitem",
]);

const SAFE_CONTROL_KINDS = new Set<string>(CO_VIEW_CONTROL_KINDS);

function extractAria(attrs: CoViewSafeAttrs | undefined): SafeViewAria {
  if (!attrs) return {};
  const aria: SafeViewAria = {};
  if (typeof attrs.ariaRole === "string" && SAFE_ARIA_ROLES.has(attrs.ariaRole)) {
    aria.role = attrs.ariaRole;
  }
  if (typeof attrs.ariaExpanded === "boolean") aria.expanded = attrs.ariaExpanded;
  if (typeof attrs.ariaChecked === "boolean") aria.checked = attrs.ariaChecked;
  return aria;
}

/** Pull the allowlisted control kind, if this node declares one. */
function extractControlKind(attrs: CoViewSafeAttrs | undefined): CoViewControlKind | undefined {
  const controlKind = attrs?.controlKind;
  if (typeof controlKind === "string" && SAFE_CONTROL_KINDS.has(controlKind)) {
    return controlKind as CoViewControlKind;
  }
  return undefined;
}

/** Copy host interaction state into a fully-populated boolean flag set. */
function extractStateFlags(state: CoViewNodeState | undefined): SafeViewStateFlags {
  return {
    hovered: state?.hovered === true,
    focused: state?.focused === true,
    pressed: state?.pressed === true,
    selected: state?.selected === true,
    open: state?.open === true,
    disabled: state?.disabled === true,
  };
}

// ---------------------------------------------------------------------------
// Content resolution (the privacy boundary)
// ---------------------------------------------------------------------------

/**
 * Coerce an authorized (`visible`) JSON value into a display string. Only JSON
 * primitives become text; objects/arrays/null render as empty content rather
 * than dumping a structure into the UI. This is reached strictly on the
 * `visible` arm, i.e. after the runtime already made an allow decision — so this
 * is the only place a real byte is intentionally shown.
 */
function coerceVisibleText(value: JsonValue): SafeViewContent {
  if (typeof value === "string") return { kind: "text", text: value };
  if (typeof value === "number" || typeof value === "boolean") {
    return { kind: "text", text: String(value) };
  }
  // null, arrays, objects: nothing meaningful (and nothing safe) to render as
  // display text — keep the slot empty rather than serialize a structure.
  return { kind: "empty" };
}

/**
 * Build a deterministic, bytes-free placeholder from a projected placeholder
 * shape. Copies only layout hints (`width`/`height`/`lines`) — there is no value
 * on a withheld/secret arm to leak, and we never read one.
 */
function placeholderFrom(
  reason: SafeViewPlaceholderReason,
  shape: PlaceholderShape,
): SafeViewPlaceholder {
  const placeholder: SafeViewPlaceholder = { reason, mode: shape.mode };
  if (shape.mode === "synthetic") {
    if (typeof shape.width === "number") placeholder.width = shape.width;
    if (typeof shape.height === "number") placeholder.height = shape.height;
    if (typeof shape.lines === "number") placeholder.lines = shape.lines;
  }
  return placeholder;
}

/** The fixed placeholder used when no shape is available (e.g. `unsupported`). */
const DEFAULT_PLACEHOLDER_MODE: PlaceholderShape["mode"] = "synthetic";

/**
 * Resolve a projected value into safe content. This is the privacy boundary:
 *   - `visible`     → the real value (only primitives become text).
 *   - `withheld`    → placeholder from its shape; never a value.
 *   - `secret`      → placeholder from its shape; never a value.
 *   - `unsupported` → a generic synthetic placeholder. The `reason` string is
 *                     deliberately dropped: it is unproven-sensitivity diagnostic
 *                     text, so we fail closed and never render it.
 *   - absent value  → empty (pure structural node).
 */
function resolveContent(value: CoViewProjectedValue | undefined): SafeViewContent {
  if (!value) return { kind: "empty" };
  switch (value.state) {
    case "visible":
      return coerceVisibleText(value.value);
    case "withheld":
      return { kind: "placeholder", placeholder: placeholderFrom("withheld", value.placeholderShape) };
    case "secret":
      return { kind: "placeholder", placeholder: placeholderFrom("secret", value.placeholderShape) };
    case "unsupported":
      return {
        kind: "placeholder",
        placeholder: { reason: "unsupported", mode: DEFAULT_PLACEHOLDER_MODE },
      };
    default:
      // Defensive: an unknown future state is treated as an unsupported
      // placeholder, never rendered as raw content. (Schema-unreachable.)
      return {
        kind: "placeholder",
        placeholder: { reason: "unsupported", mode: DEFAULT_PLACEHOLDER_MODE },
      };
  }
}

// ---------------------------------------------------------------------------
// Node / frame projection
// ---------------------------------------------------------------------------

/**
 * Resolve a single projected node into a safe view node, recursing into
 * children in order. Reads only the allowlisted fields; structure, identity, and
 * order are preserved exactly.
 */
export function resolveProjectedNode(node: CoViewProjectedNode): SafeViewNode {
  const controlKind = extractControlKind(node.attrs);
  const children = Array.isArray(node.children)
    ? node.children.map((child) => resolveProjectedNode(child))
    : [];
  return {
    id: node.id,
    kind: node.kind,
    tag: resolveTag(node.kind, controlKind),
    classTokens: extractClassTokens(node.attrs),
    aria: extractAria(node.attrs),
    ...(controlKind !== undefined ? { controlKind } : {}),
    state: extractStateFlags(node.state),
    box: { x: node.box.x, y: node.box.y, width: node.box.width, height: node.box.height },
    content: resolveContent(node.value),
    children,
  };
}

/**
 * Resolve a whole projected frame into a safe view frame. Pure: same input
 * always yields the same output, and protected frames yield identical structure
 * to their authorized counterparts (only `content` slots differ).
 */
export function resolveProjectedFrame(frame: CoViewProjectedRenderFrame): SafeViewFrame {
  return { surfaceId: frame.surfaceId, root: resolveProjectedNode(frame.root) };
}
