import type {
  BrowserPanelContent,
  BrowserRecentEntry,
  BrowserTab,
  PanelContent,
} from "@uncorded/protocol";

const LEGACY_BROWSER_TAB_ID = "__legacy_browser_tab__";
const MAX_RECENT_URLS = 6;

export type BrowserContent = Extract<PanelContent, { type: "browser" }>;
export type NormalizedBrowserContent = {
  type: "browser";
  tabs: BrowserTab[];
  activeTabId: string | null;
  recent: BrowserRecentEntry[];
};

export function parseBrowserUrl(raw: string): string | null {
  let target = raw.trim();
  if (!target) return null;
  // Recognize any URL scheme verbatim; only bare hostnames get the https://
  // prefix. Without this, typing `chrome-extension://<id>/popup.html` got
  // mangled into `https://chrome-extension//<id>/popup.html` because the
  // scheme has no `://` after the prefix is added. The protocol allowlist
  // below is the actual security boundary.
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(target);
  if (!hasScheme) {
    target = `https://${target}`;
  }
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return null;
  }
  // Allow http(s) for the open web and chrome-extension: for opening
  // installed extension UIs (uBO popup, dashboard, logger). Everything else
  // (javascript:, file:, data:, about:, ws:, …) stays blocked as a user-
  // facing nav target — either dangerous or not useful here.
  if (
    parsed.protocol !== "https:" &&
    parsed.protocol !== "http:" &&
    parsed.protocol !== "chrome-extension:"
  ) {
    return null;
  }
  return parsed.toString();
}

export function browserUrlsEqual(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  try {
    return new URL(a).toString() === new URL(b).toString();
  } catch {
    return a === b;
  }
}

export function defaultBrowserTitle(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./i, "") || url;
  } catch {
    return url;
  }
}

export function createBrowserTab(url: string, title?: string): BrowserTab {
  return {
    id: crypto.randomUUID(),
    title: title?.trim() || defaultBrowserTitle(url),
    url,
  };
}

export function createEmptyBrowserPanel(): BrowserPanelContent {
  return {
    type: "browser",
    tabs: [],
    activeTabId: null,
    recent: [],
  };
}

export function normalizeBrowserContent(content: BrowserContent): NormalizedBrowserContent {
  if ("tabs" in content) {
    // No per-tab spread — preserves reference identity for unchanged tabs so
    // Solid's <For each={normalized().tabs}> can diff by ref and avoid
    // remounting per-tab viewports on every state change. Callers that need
    // to mutate a tab build a fresh tab object themselves; everywhere else
    // gets stable refs.
    const tabs = content.tabs;
    const activeTabId =
      tabs.length === 0
        ? null
        : tabs.some((tab) => tab.id === content.activeTabId)
          ? content.activeTabId
          : tabs[0]!.id;
    return {
      type: "browser",
      tabs,
      activeTabId,
      recent: content.recent ?? [],
    };
  }

  return {
    type: "browser",
    tabs: [{ id: LEGACY_BROWSER_TAB_ID, title: content.title, url: content.url }],
    activeTabId: LEGACY_BROWSER_TAB_ID,
    recent: [{ title: content.title || defaultBrowserTitle(content.url), url: content.url }],
  };
}

export function getActiveBrowserTab(content: BrowserContent): BrowserTab | null {
  const normalized = normalizeBrowserContent(content);
  return normalized.tabs.find((tab) => tab.id === normalized.activeTabId) ?? null;
}

export function browserPanelLabel(content: BrowserContent): string {
  const activeTab = getActiveBrowserTab(content);
  if (!activeTab) return "Browser";
  return activeTab.title || defaultBrowserTitle(activeTab.url);
}

export function updateRecentUrls(
  current: BrowserRecentEntry[],
  tab: Pick<BrowserTab, "title" | "url">,
): BrowserRecentEntry[] {
  const entry: BrowserRecentEntry = {
    title: tab.title || defaultBrowserTitle(tab.url),
    url: tab.url,
  };
  return [entry, ...current.filter((item) => item.url !== entry.url)].slice(0, MAX_RECENT_URLS);
}

export function browserContentEquals(a: BrowserContent, b: BrowserContent): boolean {
  const left = normalizeBrowserContent(a);
  const right = normalizeBrowserContent(b);

  if (left.activeTabId !== right.activeTabId) return false;
  if (left.tabs.length !== right.tabs.length || left.recent.length !== right.recent.length) return false;

  for (let i = 0; i < left.tabs.length; i++) {
    const l = left.tabs[i]!;
    const r = right.tabs[i]!;
    if (l.id !== r.id || l.title !== r.title || l.url !== r.url) return false;
  }

  for (let i = 0; i < left.recent.length; i++) {
    const l = left.recent[i]!;
    const r = right.recent[i]!;
    if (l.title !== r.title || l.url !== r.url) return false;
  }

  return true;
}
