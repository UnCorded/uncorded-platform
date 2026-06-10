import { describe, it, expect } from "bun:test";
import { validateLayout } from "./layout";
import type { WorkspaceLayout } from "@uncorded/protocol";

const validSinglePanel: WorkspaceLayout = {
  version: 1,
  root: { type: "leaf", id: "p1" },
  panels: {
    p1: {
      type: "plugin",
      serverId: "srv1",
      slug: "text-channels",
      itemId: "ch1",
      itemLabel: "general",
    },
  },
};

const validSplitLayout: WorkspaceLayout = {
  version: 1,
  root: {
    type: "split",
    id: "s1",
    direction: "horizontal",
    ratio: 0.5,
    first: { type: "leaf", id: "p1" },
    second: { type: "leaf", id: "p2" },
  },
  panels: {
    p1: {
      type: "plugin",
      serverId: "srv1",
      slug: "text-channels",
      itemId: "ch1",
      itemLabel: "general",
    },
    p2: {
      type: "plugin",
      serverId: "srv1",
      slug: "text-channels",
      itemId: "ch2",
      itemLabel: "random",
    },
  },
};

const validTabbedBrowserLayout: WorkspaceLayout = {
  version: 1,
  root: { type: "leaf", id: "browser-1" },
  panels: {
    "browser-1": {
      type: "browser",
      tabs: [
        { id: "tab-1", title: "Docs", url: "https://docs.example.com" },
        { id: "tab-2", title: "Dashboard", url: "https://app.example.com" },
      ],
      activeTabId: "tab-2",
      recent: [
        { title: "Dashboard", url: "https://app.example.com" },
        { title: "Docs", url: "https://docs.example.com" },
      ],
    },
  },
};

describe("validateLayout", () => {
  it("accepts a valid single-panel layout", () => {
    expect(validateLayout(validSinglePanel)).toEqual({ ok: true });
  });

  it("accepts a valid split layout", () => {
    expect(validateLayout(validSplitLayout)).toEqual({ ok: true });
  });

  it("tolerates a legacy plugin panel that still carries tunnelUrl", () => {
    // Back-compat: tunnelUrl was dropped from PanelContent (panels now resolve
    // the URL live by serverId), but layouts saved before that change still
    // carry the field. The validator must tolerate-and-ignore it rather than
    // reject the whole layout — the field disappears on the next re-save.
    const legacy = {
      version: 1,
      root: { type: "leaf", id: "p1" },
      panels: {
        p1: {
          type: "plugin",
          serverId: "srv1",
          tunnelUrl: "https://example.com",
          slug: "text-channels",
          itemId: "ch1",
          itemLabel: "general",
        },
      },
    };
    expect(validateLayout(legacy)).toEqual({ ok: true });
  });

  it("accepts a valid tabbed browser layout", () => {
    expect(validateLayout(validTabbedBrowserLayout)).toEqual({ ok: true });
  });

  it("accepts an empty browser tab collection", () => {
    const r = validateLayout({
      version: 1,
      root: { type: "leaf", id: "browser-1" },
      panels: {
        "browser-1": {
          type: "browser",
          tabs: [],
          activeTabId: null,
          recent: [],
        },
      },
    });
    expect(r).toEqual({ ok: true });
  });

  it("accepts a valid focused leaf id", () => {
    const r = validateLayout({
      ...validSplitLayout,
      focusedLeafId: "p2",
    });
    expect(r).toEqual({ ok: true });
  });

  it("rejects null", () => {
    const r = validateLayout(null);
    expect(r.ok).toBe(false);
  });

  it("rejects wrong version", () => {
    const r = validateLayout({ ...validSinglePanel, version: 2 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("LAYOUT_INVALID_VERSION");
  });

  it("rejects missing root", () => {
    const r = validateLayout({ version: 1, panels: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("LAYOUT_MISSING_ROOT");
  });

  it("rejects missing panels", () => {
    const r = validateLayout({ version: 1, root: { type: "leaf", id: "p1" } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("LAYOUT_MISSING_PANELS");
  });

  it("rejects leaf with no panels entry", () => {
    const r = validateLayout({ version: 1, root: { type: "leaf", id: "p1" }, panels: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("LAYOUT_MISSING_PANEL_ENTRY");
  });

  it("rejects orphan panel key", () => {
    const layout = {
      ...validSinglePanel,
      panels: {
        ...validSinglePanel.panels,
        orphan: validSinglePanel.panels["p1"],
      },
    };
    const r = validateLayout(layout);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("LAYOUT_ORPHAN_PANEL");
  });

  it("rejects invalid split direction", () => {
    const r = validateLayout({
      version: 1,
      root: {
        type: "split",
        id: "s1",
        direction: "diagonal",
        ratio: 0.5,
        first: { type: "leaf", id: "p1" },
        second: { type: "leaf", id: "p2" },
      },
      panels: {
        p1: validSinglePanel.panels["p1"],
        p2: validSinglePanel.panels["p1"],
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("LAYOUT_INVALID_DIRECTION");
  });

  it("rejects ratio out of range", () => {
    const r = validateLayout({
      version: 1,
      root: {
        type: "split",
        id: "s1",
        direction: "horizontal",
        ratio: 1.5,
        first: { type: "leaf", id: "p1" },
        second: { type: "leaf", id: "p2" },
      },
      panels: {
        p1: validSinglePanel.panels["p1"],
        p2: validSinglePanel.panels["p1"],
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("LAYOUT_INVALID_RATIO");
  });

  it("rejects duplicate node IDs", () => {
    const r = validateLayout({
      version: 1,
      root: {
        type: "split",
        id: "s1",
        direction: "horizontal",
        ratio: 0.5,
        first: { type: "leaf", id: "same" },
        second: { type: "leaf", id: "same" },
      },
      panels: {
        same: validSinglePanel.panels["p1"],
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("LAYOUT_DUPLICATE_ID");
  });

  it("rejects unknown node type", () => {
    const r = validateLayout({
      version: 1,
      root: { type: "grid", id: "p1" },
      panels: { p1: validSinglePanel.panels["p1"] },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("LAYOUT_INVALID_NODE_TYPE");
  });

  it("rejects an empty focused leaf id", () => {
    const r = validateLayout({
      ...validSinglePanel,
      focusedLeafId: "",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("LAYOUT_INVALID_FOCUSED_LEAF");
  });

  it("rejects a focused leaf id that is not in the tree", () => {
    const r = validateLayout({
      ...validSinglePanel,
      focusedLeafId: "missing",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("LAYOUT_FOCUSED_LEAF_MISSING");
  });

  it("accepts ratio at boundaries 0.0 and 1.0", () => {
    for (const ratio of [0.0, 1.0]) {
      const r = validateLayout({
        version: 1,
        root: {
          type: "split",
          id: "s1",
          direction: "vertical",
          ratio,
          first: { type: "leaf", id: "p1" },
          second: { type: "leaf", id: "p2" },
        },
        panels: {
          p1: validSinglePanel.panels["p1"],
          p2: validSinglePanel.panels["p1"],
        },
      });
      expect(r.ok).toBe(true);
    }
  });

  it("rejects a browser activeTabId that is not present", () => {
    const r = validateLayout({
      ...validTabbedBrowserLayout,
      panels: {
        "browser-1": {
          type: "browser",
          tabs: [{ id: "tab-1", title: "Docs", url: "https://docs.example.com" }],
          activeTabId: "missing",
          recent: [],
        },
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("LAYOUT_INVALID_PANEL_FIELD");
  });
});
