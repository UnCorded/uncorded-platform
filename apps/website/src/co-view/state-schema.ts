// Co-View shell state schema (spec-27 §Wire Protocol).
//
// This is the well-known shape that the host's producer serializes and the
// viewer's consumer applies as a JSON-merge-patch (RFC 7396) over its local
// snapshot. Every field is optional so the schema can grow per PR without
// invalidating older diffs.
//
// PR-CV2 captured route + workspace panel layout; PR-CV3 grows the schema to
// cover the full auto-instrumented surface: modal stack, popover stack,
// context-menu stack, tabs, scroll positions, redacted-input shadows, and
// per-panel coView privacy metadata. Cursor + pen layers land in PR-CV4.
//
// Note: PanelNode is borrowed verbatim from the local layout type — viewers
// render the host's tree using the same component machinery, so the schema is
// the same shape on both sides.

import type { PanelContent } from "@uncorded/protocol";
import type { PanelNode } from "../lib/panel-layout";

export interface CoViewRoute {
  pathname: string;
}

export interface CoViewWorkspaceLayouts {
  /** Workspace id currently in focus on the host. */
  activeId: string;
  /** Layout tree per workspace id. */
  layouts: Record<string, PanelNode>;
}

/**
 * Per-panel privacy metadata (spec §Privacy & Redaction Model layer 2).
 * "shared" — render normally (default). "skeleton" — chrome only, blank body.
 * "hidden" — placeholder ("Panel hidden by host").
 */
export type CoViewPanelVisibility = "shared" | "skeleton" | "hidden";

export interface CoViewPanelMeta {
  /** Privacy mode for this panel. */
  visibility: CoViewPanelVisibility;
  /**
   * The host's panel content descriptor (plugin/browser). Carried so
   * the viewer can render real chrome — label, icon, content kind — instead
   * of placeholder boxes. Omitted for empty leaves. Plugin iframes are NOT
   * mounted on the viewer; only the descriptor is mirrored.
   */
  content?: PanelContent;
}

/** Modal stack entry. `redacted: true` blanks the modal content for viewers. */
export interface CoViewModalEntry {
  id: string;
  title?: string;
  redacted: boolean;
}

/** Popover stack entry. `anchorId` lets the viewer position correctly. */
export interface CoViewPopoverEntry {
  id: string;
  anchorId?: string;
  label?: string;
  redacted: boolean;
}

/** Context-menu stack entry. Selected item is NEVER broadcast. */
export interface CoViewContextMenuEntry {
  id: string;
  anchorId?: string;
  /** Open coordinates in host-viewport CSS pixels (where the right-click landed). */
  x?: number;
  y?: number;
}

/** Tabs control: the active tab id per tabs-control id. Replay-safe. */
export type CoViewTabs = Record<string, { activeId: string }>;

/** Per-scroll-container scroll position. Replay-safe. */
export type CoViewScrolls = Record<string, { top: number; left: number }>;

/**
 * Per-input shadow. Caret + valueRedacted always present; raw `value` only
 * when the producer's primitive carried `coViewShareValue` (or the DOM had
 * `data-uc-coview="value-shared"`). Spec §Privacy: fail-closed default.
 */
export interface CoViewInputShadow {
  caret: number;
  valueRedacted: boolean;
  value?: string;
}

export type CoViewInputs = Record<string, CoViewInputShadow>;

export interface CoViewShellState {
  route?: CoViewRoute;
  workspace?: CoViewWorkspaceLayouts;
  /** Per-panel privacy metadata, keyed by leaf id. */
  panelMeta?: Record<string, CoViewPanelMeta>;
  /** Open modals, oldest first. Empty/missing = no modals. */
  modals?: CoViewModalEntry[];
  /** Open popovers, oldest first. */
  popovers?: CoViewPopoverEntry[];
  /** Open context menus, oldest first. */
  contextMenus?: CoViewContextMenuEntry[];
  /** Tabs controls, keyed by id. */
  tabs?: CoViewTabs;
  /** Scroll containers, keyed by id. */
  scrolls?: CoViewScrolls;
  /** Inputs, keyed by id. */
  inputs?: CoViewInputs;
}

/**
 * Closed allowlist of top-level shell-state keys the producer is permitted to
 * emit (spec §The Shell-State Boundary). The serializer drops any unknown
 * key with a structured warning. Adding a new field MUST extend both this
 * allowlist and CoViewShellState above.
 */
export const CO_VIEW_SHELL_STATE_KEYS = [
  "route",
  "workspace",
  "panelMeta",
  "modals",
  "popovers",
  "contextMenus",
  "tabs",
  "scrolls",
  "inputs",
] as const satisfies readonly (keyof CoViewShellState)[];
