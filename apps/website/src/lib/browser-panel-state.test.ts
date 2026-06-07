import { describe, expect, test } from "bun:test";
import {
  browserContentEquals,
  browserPanelLabel,
  normalizeBrowserContent,
  parseBrowserUrl,
  updateRecentUrls,
} from "./browser-panel-state";

describe("browser-panel-state", () => {
  test("normalizes a legacy browser panel into a single active tab", () => {
    const normalized = normalizeBrowserContent({
      type: "browser",
      url: "https://example.com",
      title: "Example",
    });

    expect(normalized.tabs).toHaveLength(1);
    expect(normalized.activeTabId).toBe(normalized.tabs[0]!.id);
    expect(normalized.tabs[0]).toEqual({
      id: "__legacy_browser_tab__",
      title: "Example",
      url: "https://example.com",
    });
  });

  test("compares legacy and tabbed content by the normalized browser state", () => {
    const legacy = { type: "browser" as const, url: "https://example.com", title: "Example" };
    const tabbed = {
      type: "browser" as const,
      tabs: [{ id: "__legacy_browser_tab__", title: "Example", url: "https://example.com" }],
      activeTabId: "__legacy_browser_tab__",
      recent: [{ title: "Example", url: "https://example.com" }],
    };

    expect(browserContentEquals(legacy, tabbed)).toBe(true);
  });

  test("parses bare hostnames as https urls", () => {
    expect(parseBrowserUrl("example.com")).toBe("https://example.com/");
    expect(parseBrowserUrl("javascript:alert(1)")).toBeNull();
  });

  test("preserves chrome-extension URLs verbatim instead of mangling them", () => {
    const ublock = "chrome-extension://dfcfaohjfkidkokndknleombjgilcmme/popup.html";
    expect(parseBrowserUrl(ublock)).toBe(ublock);
    expect(parseBrowserUrl("file:///etc/passwd")).toBeNull();
    expect(parseBrowserUrl("data:text/html,<script>1</script>")).toBeNull();
  });

  test("uses the active tab title for browser labels", () => {
    expect(
      browserPanelLabel({
        type: "browser",
        tabs: [{ id: "tab-1", title: "Docs", url: "https://docs.example.com" }],
        activeTabId: "tab-1",
        recent: [],
      })
    ).toBe("Docs");
  });

  test("keeps recent urls deduplicated and newest-first", () => {
    const recent = updateRecentUrls(
      [
        { title: "Docs", url: "https://docs.example.com" },
        { title: "Dashboard", url: "https://app.example.com" },
      ],
      { title: "Dashboard", url: "https://app.example.com" }
    );

    expect(recent).toEqual([
      { title: "Dashboard", url: "https://app.example.com" },
      { title: "Docs", url: "https://docs.example.com" },
    ]);
  });
});
