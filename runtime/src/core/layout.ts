// Workspace layout validation.
// Validates the full recursive split-tree structure.

import type { PanelNode, WorkspaceLayout } from "@uncorded/protocol";

export interface LayoutValidationError {
  code: string;
  message: string;
}

export type LayoutValidationResult =
  | { ok: true }
  | { ok: false; error: LayoutValidationError };

function err(code: string, message: string): LayoutValidationResult {
  return { ok: false, error: { code, message } };
}

const RATIO_MIN = 0.0;
const RATIO_MAX = 1.0;
const MAX_DEPTH = 32;
const REQUIRED_STRING_FIELDS: { field: string; maxLen: number }[] = [
  { field: "serverId", maxLen: 128 },
  { field: "slug", maxLen: 64 },
  { field: "itemId", maxLen: 128 },
  { field: "itemLabel", maxLen: 256 },
];
// `tunnelUrl` is no longer part of PanelContent — panels resolve the live URL by
// serverId at render time. It stays in the allowed-keys set (but out of
// REQUIRED_STRING_FIELDS) purely for back-compat: layouts saved before the
// change still carry it, and we tolerate-and-ignore it rather than reject the
// whole layout. It vanishes the next time the layout is re-saved.
const PLUGIN_ALLOWED_KEYS = new Set(["type", "serverId", "tunnelUrl", "slug", "itemId", "itemLabel", "itemIcon"]);
const BROWSER_LEGACY_ALLOWED_KEYS = new Set(["type", "url", "title"]);
const BROWSER_TABBED_ALLOWED_KEYS = new Set(["type", "tabs", "activeTabId", "recent"]);
const BROWSER_TAB_ALLOWED_KEYS = new Set(["id", "title", "url"]);
const BROWSER_RECENT_ALLOWED_KEYS = new Set(["title", "url"]);
// `instanceId` (the per-panel identity) is validated when present but NOT
// required: layouts saved before it existed lack it, and the renderer backfills
// one on load. Rejecting its absence would flip every restored pre-instanceId
// workspace to "error" — same tolerate-and-backfill stance as `tunnelUrl` above.
const WEBAPP_ALLOWED_KEYS = new Set(["type", "webAppId", "instanceId", "url", "title", "renamed"]);
const MAX_BROWSER_TABS = 16;
const MAX_BROWSER_RECENT = 6;

/**
 * Validate a `BrowserRecentEntry[]`. Used by both the embedded `recent` field on
 * tabbed browser panels (legacy, capped at MAX_BROWSER_RECENT) and the standalone
 * /browser/recent endpoint (caller passes its own cap).
 *
 * `pathLabel` is interpolated into error messages — pass something meaningful to
 * the caller (e.g. `panels["browser-1"].recent` or `recent`).
 */
export function validateBrowserRecentArray(
  value: unknown,
  pathLabel: string,
  maxEntries: number,
): LayoutValidationResult {
  if (!Array.isArray(value)) {
    return err("LAYOUT_INVALID_PANEL_FIELD", `${pathLabel} must be an array.`);
  }
  if (value.length > maxEntries) {
    return err("LAYOUT_PANEL_FIELD_TOO_LONG", `${pathLabel} must not exceed ${maxEntries} entries.`);
  }
  for (let i = 0; i < value.length; i++) {
    const entry = value[i];
    if (!entry || typeof entry !== "object") {
      return err("LAYOUT_INVALID_PANEL_FIELD", `${pathLabel}[${i}] must be an object.`);
    }
    const recentEntry = entry as Record<string, unknown>;
    const title = recentEntry["title"];
    if (typeof title !== "string") {
      return err("LAYOUT_INVALID_PANEL_FIELD", `${pathLabel}[${i}].title must be a string.`);
    }
    if (title.length > 256) {
      return err("LAYOUT_PANEL_FIELD_TOO_LONG", `${pathLabel}[${i}].title must not exceed 256 characters.`);
    }
    const url = recentEntry["url"];
    if (typeof url !== "string" || url.length === 0) {
      return err("LAYOUT_INVALID_PANEL_FIELD", `${pathLabel}[${i}].url must be a non-empty string.`);
    }
    if (url.length > 2048) {
      return err("LAYOUT_PANEL_FIELD_TOO_LONG", `${pathLabel}[${i}].url must not exceed 2048 characters.`);
    }
    for (const key of Object.keys(recentEntry)) {
      if (!BROWSER_RECENT_ALLOWED_KEYS.has(key)) {
        return err("LAYOUT_UNKNOWN_PANEL_FIELD", `${pathLabel}[${i}] contains unknown field "${key}".`);
      }
    }
  }
  return { ok: true };
}

function validateBrowserLegacyPanel(
  leafId: string,
  content: Record<string, unknown>,
): LayoutValidationResult | null {
  const url = content["url"];
  if (typeof url !== "string" || url.length === 0) {
    return err("LAYOUT_INVALID_PANEL_FIELD", `panels["${leafId}"].url must be a non-empty string.`);
  }
  if (url.length > 2048) {
    return err("LAYOUT_PANEL_FIELD_TOO_LONG", `panels["${leafId}"].url must not exceed 2048 characters.`);
  }
  const title = content["title"];
  if (typeof title !== "string") {
    return err("LAYOUT_INVALID_PANEL_FIELD", `panels["${leafId}"].title must be a string.`);
  }
  if (title.length > 256) {
    return err("LAYOUT_PANEL_FIELD_TOO_LONG", `panels["${leafId}"].title must not exceed 256 characters.`);
  }
  for (const key of Object.keys(content)) {
    if (!BROWSER_LEGACY_ALLOWED_KEYS.has(key)) {
      return err("LAYOUT_UNKNOWN_PANEL_FIELD", `panels["${leafId}"] contains unknown field "${key}".`);
    }
  }
  return null;
}

function validateBrowserTabbedPanel(
  leafId: string,
  content: Record<string, unknown>,
): LayoutValidationResult | null {
  const tabs = content["tabs"];
  if (!Array.isArray(tabs)) {
    return err("LAYOUT_INVALID_PANEL_FIELD", `panels["${leafId}"].tabs must be an array.`);
  }
  if (tabs.length > MAX_BROWSER_TABS) {
    return err("LAYOUT_PANEL_FIELD_TOO_LONG", `panels["${leafId}"].tabs must not exceed ${MAX_BROWSER_TABS} entries.`);
  }

  const tabIds = new Set<string>();
  for (let i = 0; i < tabs.length; i++) {
    const tab = tabs[i];
    if (!tab || typeof tab !== "object") {
      return err("LAYOUT_INVALID_PANEL_FIELD", `panels["${leafId}"].tabs[${i}] must be an object.`);
    }
    const entry = tab as Record<string, unknown>;
    const id = entry["id"];
    if (typeof id !== "string" || id.length === 0) {
      return err("LAYOUT_INVALID_PANEL_FIELD", `panels["${leafId}"].tabs[${i}].id must be a non-empty string.`);
    }
    if (id.length > 128) {
      return err("LAYOUT_PANEL_FIELD_TOO_LONG", `panels["${leafId}"].tabs[${i}].id must not exceed 128 characters.`);
    }
    if (tabIds.has(id)) {
      return err("LAYOUT_INVALID_PANEL_FIELD", `panels["${leafId}"].tabs[${i}].id must be unique.`);
    }
    tabIds.add(id);

    const title = entry["title"];
    if (typeof title !== "string") {
      return err("LAYOUT_INVALID_PANEL_FIELD", `panels["${leafId}"].tabs[${i}].title must be a string.`);
    }
    if (title.length > 256) {
      return err("LAYOUT_PANEL_FIELD_TOO_LONG", `panels["${leafId}"].tabs[${i}].title must not exceed 256 characters.`);
    }

    const url = entry["url"];
    if (typeof url !== "string" || url.length === 0) {
      return err("LAYOUT_INVALID_PANEL_FIELD", `panels["${leafId}"].tabs[${i}].url must be a non-empty string.`);
    }
    if (url.length > 2048) {
      return err("LAYOUT_PANEL_FIELD_TOO_LONG", `panels["${leafId}"].tabs[${i}].url must not exceed 2048 characters.`);
    }

    for (const key of Object.keys(entry)) {
      if (!BROWSER_TAB_ALLOWED_KEYS.has(key)) {
        return err("LAYOUT_UNKNOWN_PANEL_FIELD", `panels["${leafId}"].tabs[${i}] contains unknown field "${key}".`);
      }
    }
  }

  const activeTabId = content["activeTabId"];
  if (tabs.length === 0) {
    if (activeTabId !== null) {
      return err("LAYOUT_INVALID_PANEL_FIELD", `panels["${leafId}"].activeTabId must be null when tabs is empty.`);
    }
  } else {
    if (typeof activeTabId !== "string" || !tabIds.has(activeTabId)) {
      return err("LAYOUT_INVALID_PANEL_FIELD", `panels["${leafId}"].activeTabId must match one of tabs[].id.`);
    }
  }

  const recent = content["recent"];
  if (recent !== undefined) {
    const recentResult = validateBrowserRecentArray(
      recent,
      `panels["${leafId}"].recent`,
      MAX_BROWSER_RECENT,
    );
    if (!recentResult.ok) return recentResult;
  }

  for (const key of Object.keys(content)) {
    if (!BROWSER_TABBED_ALLOWED_KEYS.has(key)) {
      return err("LAYOUT_UNKNOWN_PANEL_FIELD", `panels["${leafId}"] contains unknown field "${key}".`);
    }
  }

  return null;
}

// A desktop "Web App" panel: a single pinned page rendered as a live native
// view. The Web App definition is desktop-local, but the panel persists by
// value (url + title, plus webAppId only when it's a saved bookmark) in synced
// layouts so it survives restore — a non-desktop client shows a placeholder
// instead of mounting a live view.
function validateWebAppPanel(
  leafId: string,
  content: Record<string, unknown>,
): LayoutValidationResult | null {
  // Optional since dock ≠ save: a panel created by docking a live popup has no
  // bookmark linkage, so it carries no webAppId. Validate only if present.
  if ("webAppId" in content) {
    const webAppId = content["webAppId"];
    if (typeof webAppId !== "string" || webAppId.length === 0) {
      return err("LAYOUT_INVALID_PANEL_FIELD", `panels["${leafId}"].webAppId must be a non-empty string.`);
    }
    if (webAppId.length > 128) {
      return err("LAYOUT_PANEL_FIELD_TOO_LONG", `panels["${leafId}"].webAppId must not exceed 128 characters.`);
    }
  }
  // Optional (back-compat) — see WEBAPP_ALLOWED_KEYS note. Validate only if present.
  if ("instanceId" in content) {
    const instanceId = content["instanceId"];
    if (typeof instanceId !== "string" || instanceId.length === 0) {
      return err("LAYOUT_INVALID_PANEL_FIELD", `panels["${leafId}"].instanceId must be a non-empty string.`);
    }
    if (instanceId.length > 128) {
      return err("LAYOUT_PANEL_FIELD_TOO_LONG", `panels["${leafId}"].instanceId must not exceed 128 characters.`);
    }
  }
  const url = content["url"];
  if (typeof url !== "string" || url.length === 0) {
    return err("LAYOUT_INVALID_PANEL_FIELD", `panels["${leafId}"].url must be a non-empty string.`);
  }
  if (url.length > 2048) {
    return err("LAYOUT_PANEL_FIELD_TOO_LONG", `panels["${leafId}"].url must not exceed 2048 characters.`);
  }
  const title = content["title"];
  if (typeof title !== "string") {
    return err("LAYOUT_INVALID_PANEL_FIELD", `panels["${leafId}"].title must be a string.`);
  }
  if (title.length > 256) {
    return err("LAYOUT_PANEL_FIELD_TOO_LONG", `panels["${leafId}"].title must not exceed 256 characters.`);
  }
  // Optional user-rename pin (desktop title sync skips renamed panels).
  if ("renamed" in content && typeof content["renamed"] !== "boolean") {
    return err("LAYOUT_INVALID_PANEL_FIELD", `panels["${leafId}"].renamed must be a boolean.`);
  }
  for (const key of Object.keys(content)) {
    if (!WEBAPP_ALLOWED_KEYS.has(key)) {
      return err("LAYOUT_UNKNOWN_PANEL_FIELD", `panels["${leafId}"] contains unknown field "${key}".`);
    }
  }
  return null;
}

/**
 * Collect all leaf IDs from the tree.
 * Returns null if a structural error is found (tracked separately).
 */
function collectLeafIds(
  node: PanelNode,
  depth: number,
  leafIds: Set<string>,
  nodeIds: Set<string>,
): LayoutValidationResult | null {
  if (depth > MAX_DEPTH) {
    return err("LAYOUT_TOO_DEEP", `Panel tree exceeds maximum depth of ${MAX_DEPTH}.`);
  }

  if (!node || typeof node !== "object") {
    return err("LAYOUT_INVALID_NODE", "Panel node must be an object.");
  }

  if (typeof node.id !== "string" || node.id.length === 0) {
    return err("LAYOUT_MISSING_ID", "Every panel node must have a non-empty string id.");
  }

  if (nodeIds.has(node.id)) {
    return err("LAYOUT_DUPLICATE_ID", `Duplicate node id "${node.id}" found in tree.`);
  }
  nodeIds.add(node.id);

  if (node.type === "leaf") {
    leafIds.add(node.id);
    return null;
  }

  if (node.type === "split") {
    if (node.direction !== "horizontal" && node.direction !== "vertical") {
      return err(
        "LAYOUT_INVALID_DIRECTION",
        `Split node "${node.id}" has invalid direction "${String(node.direction)}". Must be "horizontal" or "vertical".`,
      );
    }

    if (
      typeof node.ratio !== "number" ||
      !Number.isFinite(node.ratio) ||
      node.ratio < RATIO_MIN ||
      node.ratio > RATIO_MAX
    ) {
      return err(
        "LAYOUT_INVALID_RATIO",
        `Split node "${node.id}" has invalid ratio ${String(node.ratio)}. Must be a finite number between 0 and 1.`,
      );
    }

    const firstErr = collectLeafIds(node.first, depth + 1, leafIds, nodeIds);
    if (firstErr) return firstErr;

    return collectLeafIds(node.second, depth + 1, leafIds, nodeIds);
  }

  return err(
    "LAYOUT_INVALID_NODE_TYPE",
    `Unknown node type "${String((node as PanelNode).type)}". Must be "leaf" or "split".`,
  );
}

function validatePanels(
  panels: Record<string, unknown>,
  leafIds: Set<string>,
  leafLabel: string,
): LayoutValidationResult | null {
  const panelKeys = Object.keys(panels);

  // Every leaf in the tree must be in panels.
  for (const leafId of leafIds) {
    if (!panelKeys.includes(leafId)) {
      return err(
        "LAYOUT_MISSING_PANEL_ENTRY",
        `${leafLabel} "${leafId}" has no entry in panels map.`,
      );
    }
  }

  // Every key in panels must be a leaf in the tree (no orphans).
  for (const key of panelKeys) {
    if (!leafIds.has(key)) {
      return err(
        "LAYOUT_ORPHAN_PANEL",
        `panels["${key}"] has no corresponding ${leafLabel.toLowerCase()} in the tree.`,
      );
    }
  }

  // Validate each panel entry's PanelContent shape.
  for (const [leafId, content] of Object.entries(panels)) {
    if (content === null || typeof content !== "object") {
      return err("LAYOUT_INVALID_PANEL", `panels["${leafId}"] must be an object.`);
    }
    const c = content as Record<string, unknown>;

    if (c["type"] === "plugin") {
      for (const { field, maxLen } of REQUIRED_STRING_FIELDS) {
        const val = c[field];
        if (typeof val !== "string" || val.length === 0) {
          return err(
            "LAYOUT_INVALID_PANEL_FIELD",
            `panels["${leafId}"].${field} must be a non-empty string.`,
          );
        }
        if (val.length > maxLen) {
          return err(
            "LAYOUT_PANEL_FIELD_TOO_LONG",
            `panels["${leafId}"].${field} must not exceed ${maxLen} characters.`,
          );
        }
      }
      if ("itemIcon" in c) {
        const icon = c["itemIcon"];
        if (typeof icon !== "string" || icon.length === 0 || icon.length > 64) {
          return err(
            "LAYOUT_INVALID_PANEL_FIELD",
            `panels["${leafId}"].itemIcon must be a non-empty string of at most 64 characters.`,
          );
        }
      }
      for (const key of Object.keys(c)) {
        if (!PLUGIN_ALLOWED_KEYS.has(key)) {
          return err("LAYOUT_UNKNOWN_PANEL_FIELD", `panels["${leafId}"] contains unknown field "${key}".`);
        }
      }
    } else if (c["type"] === "browser") {
      const browserErr =
        "tabs" in c || "activeTabId" in c || "recent" in c
          ? validateBrowserTabbedPanel(leafId, c)
          : validateBrowserLegacyPanel(leafId, c);
      if (browserErr) return browserErr;
    } else if (c["type"] === "webapp") {
      const webAppErr = validateWebAppPanel(leafId, c);
      if (webAppErr) return webAppErr;
    } else {
      return err(
        "LAYOUT_INVALID_PANEL_TYPE",
        `panels["${leafId}"].type must be "plugin", "browser", or "webapp", got "${String(c["type"])}".`,
      );
    }
  }

  return null;
}

/**
 * Validate a WorkspaceLayout.
 *
 * Checks:
 * - version is 1
 * - root is a valid recursive split tree
 * - no duplicate node IDs
 * - tree depth ≤ 32
 * - ratio ∈ [0, 1] on split nodes
 * - every leaf ID in the tree has an entry in panels
 * - every key in panels is a leaf ID (no orphans)
 */
export function validateLayout(layout: unknown): LayoutValidationResult {
  if (!layout || typeof layout !== "object") {
    return err("LAYOUT_NOT_OBJECT", "Layout must be an object.");
  }

  const l = layout as Record<string, unknown>;

  if (l["version"] !== 1) {
    return err(
      "LAYOUT_INVALID_VERSION",
      `Layout version must be 1, got ${String(l["version"])}.`,
    );
  }

  if (!l["root"] || typeof l["root"] !== "object") {
    return err("LAYOUT_MISSING_ROOT", "Layout must have a root node.");
  }

  if (!l["panels"] || typeof l["panels"] !== "object" || Array.isArray(l["panels"])) {
    return err("LAYOUT_MISSING_PANELS", "Layout must have a panels object.");
  }

  const leafIds = new Set<string>();
  const nodeIds = new Set<string>();
  const treeErr = collectLeafIds(l["root"] as PanelNode, 0, leafIds, nodeIds);
  if (treeErr) return treeErr;

  const panels = l["panels"] as Record<string, unknown>;
  const panelsErr = validatePanels(panels, leafIds, "Leaf");
  if (panelsErr) return panelsErr;

  if (!("focusedLeafId" in l) || l["focusedLeafId"] === undefined || l["focusedLeafId"] === null) {
    return { ok: true };
  }

  const focusedLeafId = l["focusedLeafId"];
  if (typeof focusedLeafId !== "string" || focusedLeafId.length === 0) {
    return err("LAYOUT_INVALID_FOCUSED_LEAF", "focusedLeafId must be a non-empty string when provided.");
  }
  if (!leafIds.has(focusedLeafId)) {
    return err("LAYOUT_FOCUSED_LEAF_MISSING", `focusedLeafId "${focusedLeafId}" does not exist in the panel tree.`);
  }

  return { ok: true };
}
