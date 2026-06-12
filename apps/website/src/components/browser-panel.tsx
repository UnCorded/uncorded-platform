import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  ExternalLink,
  Globe,
  Monitor,
  Plus,
  RotateCcw,
  Trash2,
  X,
} from "lucide-solid";
import type { BrowserPanelContent, BrowserRecentEntry } from "@uncorded/protocol";
import { checkCanFrame } from "@/api/central";
import {
  type BrowserContent,
  browserUrlsEqual,
  createBrowserTab,
  defaultBrowserTitle,
  normalizeBrowserContent,
  parseBrowserUrl,
} from "@/lib/browser-panel-state";
import {
  addBrowserRecent,
  browserRecent,
  removeBrowserRecent,
} from "@/stores/browser-recent";
import { isElectron } from "@/lib/electron";
import { activeServer } from "@/stores/servers";
import {
  addWebApp,
  getWebAppPref,
  popOutWebApp,
  onNativeSurfaceIntercepted,
  nativeSurfaceOpenWindow,
  dockLiveSurface,
} from "@/stores/web-apps";
import { DockPrompt } from "@/components/web-apps/dock-prompt";
import { showToast } from "@/lib/feedback";
import * as portalHost from "@/lib/portal-host";
import { surfaceKeyOf } from "@/lib/surface-key";
import { useWorkspaceContext } from "@/lib/workspace-context";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

export interface WebviewElement extends HTMLElement {
  src: string;
  goBack(): void;
  goForward(): void;
  reload(): void;
  reloadIgnoringCache?(): void;
  loadURL(url: string): Promise<void>;
  canGoBack(): boolean;
  canGoForward(): boolean;
  getURL(): string;
  // The guest's WebContents id — matches `contents.id` in main. Used to route a
  // main-intercepted site-initiated window.open back to the owning panel.
  getWebContentsId(): number;
}

type WebviewControls = {
  back: () => void;
  forward: () => void;
  reload: (ignoreCache: boolean) => void;
};

type ProbeState = "checking" | "allowed" | "blocked";

const EMPTY_NAV_STATE = { canBack: false, canForward: false };

// Module-level cache of can-frame probe results, keyed by URL. Without this,
// every fresh IframeViewport mount starts at probe="checking" and only renders
// IframeSurface after the async probe completes — which falls outside
// portal-host's microtask deferral window when the BrowserPanel re-mounts
// (e.g. on fullscreen toggle), so the iframe element gets destroyed and
// recreated, reloading the page. Caching lets us short-circuit the gap on
// remount: portal-host still sees a synchronous mount() call and adopts the
// existing iframe.
const probeResultCache = new Map<string, "allowed" | "blocked">();

// Routing table for main-intercepted site-initiated window.open. Each mounted
// browser <webview> registers a handler keyed by its guest WebContents id; the
// single module-level IPC subscription below dispatches an intercepted popup to
// the matching panel so the floating frame opens on the panel that triggered it
// (including background tabs, which still own a live, registered guest). A
// module-level Map + one subscription avoids N panels each binding the channel.
const popupInterceptHandlers = new Map<
  number,
  (surfaceId: number, url: string) => void
>();
let popupInterceptSubscribed = false;

function ensurePopupInterceptSubscription(): void {
  if (popupInterceptSubscribed) return;
  popupInterceptSubscribed = true;
  onNativeSurfaceIntercepted(({ surfaceId, url, webContentsId }) => {
    popupInterceptHandlers.get(webContentsId)?.(surfaceId, url);
  });
}

export function BrowserPanel(props: {
  content: BrowserContent;
  panelId: string;
  onChange: (content: BrowserPanelContent) => void;
}) {
  const normalized = createMemo(() => normalizeBrowserContent(props.content));
  const activeTab = createMemo(
    () => normalized().tabs.find((tab) => tab.id === normalized().activeTabId) ?? null
  );

  const [creatingTab, setCreatingTab] = createSignal(false);
  const [draftTitle, setDraftTitle] = createSignal("");
  const [draftUrl, setDraftUrl] = createSignal("");
  const [displayUrl, setDisplayUrl] = createSignal(activeTab()?.url ?? "");
  const [navState, setNavState] = createSignal(EMPTY_NAV_STATE);
  // Per-tab reload nonces. Keyed by tab id so reloading one tab doesn't churn
  // the inactive tabs' iframes (which now stay mounted, hidden, in the portal).
  const [iframeReloadNonces, setIframeReloadNonces] = createSignal<Record<string, number>>({});
  const reloadNonceFor = (tabId: string) => iframeReloadNonces()[tabId] ?? 0;
  const [webviewControls, setWebviewControls] = createSignal<WebviewControls | null>(null);

  // The dock overlay (Popout / Create Panel / Cancel). Opened by the nav bar's
  // Popout button unless the user has a saved per-URL preference, in which case
  // we execute that action directly and skip the overlay. This is the toolbar
  // path only — a SITE-initiated window.open is handled by handlePopupIntercepted
  // (which opens a free OS popout window), not this overlay.
  const [dockPrompt, setDockPrompt] = createSignal<{
    url: string;
    title: string;
  } | null>(null);
  const handlePopout = async (): Promise<void> => {
    const tab = activeTab();
    const server = activeServer();
    if (!tab || !server) return;
    let isHttp = false;
    try {
      const proto = new URL(tab.url).protocol;
      isHttp = proto === "https:" || proto === "http:";
    } catch {
      isHttp = false;
    }
    if (!isHttp) return;
    const pref = await getWebAppPref(tab.url);
    if (pref === "popout") {
      await popOutWebApp(tab.url);
      return;
    }
    if (pref === "panel") {
      const entry = await addWebApp(server.id, { url: tab.url, title: tab.title });
      if (entry) showToast(`Added ${entry.title} to Web Apps`, "info");
      return;
    }
    setDockPrompt({ url: tab.url, title: tab.title });
  };

  // A site-initiated window.open that main captured into a native WebContentsView
  // (live session preserved, parked hidden) keyed by `surfaceId`. Honor a saved
  // per-URL preference: "panel" with an active server → auto-dock the live view
  // into a workspace panel; everything else (the "popout" pref AND the default,
  // no-pref case) → open it as a free, frameless OS window that owns the view.
  // The window carries its own Dock-as-panel control, so it's the right default
  // even with no server. The native view must be consumed (docked / windowed /
  // released) or it stays parked hidden.
  const handlePopupIntercepted = async (
    surfaceId: number,
    url: string,
  ): Promise<void> => {
    const pref = await getWebAppPref(url);
    // The activeServer() check is load-bearing: with no server the workspace
    // can't host panels, so dockLiveSurface would toast-and-stop — leaving the
    // freshly intercepted view parked hidden forever (leak). Fall through to
    // the window path instead, which works serverless and still offers Dock.
    if (pref === "panel" && activeServer()) {
      await dockLiveSurface(surfaceId, url);
      return;
    }
    await nativeSurfaceOpenWindow(surfaceId);
  };

  // Reset displayUrl only when the active tab's identity changes, not on every
  // url change. The webview pushes live URLs into displayUrl via
  // onLiveUrlChange, and we persist those back into tab.url below — if this
  // effect fired on tab.url changes too, the round-trip would briefly clobber
  // the address bar with the older saved value.
  let lastActiveTabId: string | null | undefined = undefined;
  createEffect(() => {
    const tab = activeTab();
    const id = tab?.id ?? null;
    if (id !== lastActiveTabId) {
      lastActiveTabId = id;
      setDisplayUrl(tab?.url ?? "");
      // Tab activation flips a wrapper from display:none → block, which
      // changes the new active tab's placeholder rect from 0×0 to a real
      // size. ResizeObserver does not always fire across that transition,
      // so portal-host can leave the portaled iframe/webview at
      // visibility:hidden even though its placeholder is now visible. Kick
      // the poll explicitly to guarantee the next frame re-syncs every
      // mount under this panel.
      portalHost.requestSync();
    }
    if (tab === null) {
      setNavState(EMPTY_NAV_STATE);
      setWebviewControls(null);
    }
  });

  // Composer open/close also flips the wrapper's display, with the same RO
  // unreliability. Same fix.
  createEffect(() => {
    creatingTab();
    portalHost.requestSync();
  });

  // Persist the live URL back into the active tab so workspace restore lands
  // where the user actually ended up, not at the original entry URL. Debounced
  // 1s — keeps autosave traffic sane during chained redirects/SPAs.
  // Web (iframe) can't observe cross-origin navigation; this fires only on
  // Electron (webview) where did-navigate updates displayUrl.
  let urlPersistTimer: ReturnType<typeof setTimeout> | null = null;
  createEffect(() => {
    const liveUrl = displayUrl();
    const tab = activeTab();
    if (!tab || !liveUrl) return;
    if (browserUrlsEqual(tab.url, liveUrl)) return;
    if (urlPersistTimer) clearTimeout(urlPersistTimer);
    urlPersistTimer = setTimeout(() => {
      urlPersistTimer = null;
      const state = normalized();
      const currentTab = state.tabs.find((t) => t.id === tab.id);
      if (!currentTab || browserUrlsEqual(currentTab.url, liveUrl)) return;
      writeBrowser({
        type: "browser",
        tabs: state.tabs.map((entry) =>
          entry.id === tab.id ? { ...entry, url: liveUrl } : entry,
        ),
        activeTabId: state.activeTabId,
        recent: [],
      });
    }, 1000);
  });
  onCleanup(() => {
    if (urlPersistTimer) clearTimeout(urlPersistTimer);
  });

  // Recent history is now stored in the global per-user `browser-recent` store
  // (see stores/browser-recent.ts), not embedded in the panel layout. We stop
  // writing the `recent` field — it stays accepted by the validator so old
  // saved layouts continue to load, but new writes leave it out.
  const writeBrowser = (content: ReturnType<typeof normalizeBrowserContent>) => {
    props.onChange({
      type: "browser",
      tabs: content.tabs,
      activeTabId: content.activeTabId,
    });
  };

  const openComposer = (prefill?: BrowserRecentEntry) => {
    setDraftTitle(prefill?.title ?? "");
    setDraftUrl(prefill?.url ?? "");
    setCreatingTab(true);
  };

  const cancelComposer = () => {
    if (normalized().tabs.length === 0) {
      setDraftTitle("");
      setDraftUrl("");
      return;
    }
    setCreatingTab(false);
    setDraftTitle("");
    setDraftUrl("");
  };

  const createTabFromInputs = (url: string, title: string) => {
    const parsedUrl = parseBrowserUrl(url);
    if (parsedUrl === null) return;
    const state = normalized();
    const tab = createBrowserTab(parsedUrl, title);
    writeBrowser({
      type: "browser",
      tabs: [...state.tabs, tab],
      activeTabId: tab.id,
      recent: [],
    });
    addBrowserRecent({ title: tab.title, url: tab.url });
    setDisplayUrl(parsedUrl);
    setCreatingTab(false);
    setDraftTitle("");
    setDraftUrl("");
  };

  const activateTab = (tabId: string) => {
    if (normalized().activeTabId === tabId) {
      setCreatingTab(false);
      return;
    }
    writeBrowser({ ...normalized(), activeTabId: tabId });
    setCreatingTab(false);
  };

  const closeTab = (tabId: string) => {
    const state = normalized();
    const index = state.tabs.findIndex((entry) => entry.id === tabId);
    if (index < 0) return;
    const nextTabs = state.tabs.filter((entry) => entry.id !== tabId);
    const nextActiveTabId =
      nextTabs.length === 0
        ? null
        : state.activeTabId === tabId
          ? nextTabs[Math.min(index, nextTabs.length - 1)]!.id
          : state.activeTabId;
    writeBrowser({
      type: "browser",
      tabs: nextTabs,
      activeTabId: nextActiveTabId,
      recent: [],
    });
    if (nextTabs.length === 0) {
      setCreatingTab(false);
      setDraftTitle("");
      setDraftUrl("");
      setNavState(EMPTY_NAV_STATE);
    }
  };

  const updateActiveTabUrl = (url: string) => {
    const tab = activeTab();
    if (!tab) return;
    const state = normalized();
    if (tab.url === url) {
      setDisplayUrl(url);
      return;
    }
    const updatedTab = { ...tab, url };
    writeBrowser({
      type: "browser",
      tabs: state.tabs.map((entry) => (entry.id === tab.id ? updatedTab : entry)),
      activeTabId: state.activeTabId,
      recent: [],
    });
    addBrowserRecent({ title: updatedTab.title, url: updatedTab.url });
    setDisplayUrl(url);
  };

  const removeRecent = (url: string) => {
    removeBrowserRecent(url);
  };

  const handleAddressSubmit = (rawUrl: string) => {
    const parsedUrl = parseBrowserUrl(rawUrl);
    if (parsedUrl === null) return;
    if (creatingTab() || activeTab() === null) {
      createTabFromInputs(parsedUrl, draftTitle());
      return;
    }
    updateActiveTabUrl(parsedUrl);
  };

  const handleReload = (ignoreCache: boolean) => {
    const tab = activeTab();
    if (!tab) return;
    if (isElectron()) {
      webviewControls()?.reload(ignoreCache);
      return;
    }
    setIframeReloadNonces((prev) => ({ ...prev, [tab.id]: (prev[tab.id] ?? 0) + 1 }));
  };

  const addressBarValue = createMemo(() =>
    creatingTab() || activeTab() === null ? draftUrl() : displayUrl()
  );

  return (
    <div class="flex flex-col flex-1 min-h-0 bg-background">
      <BrowserNavBar
        value={addressBarValue()}
        isComposer={creatingTab() || activeTab() === null}
        canBack={!creatingTab() && !!activeTab() && navState().canBack}
        canForward={!creatingTab() && !!activeTab() && navState().canForward}
        tabs={normalized().tabs}
        activeTabId={normalized().activeTabId}
        onValueChange={(value) => {
          if (creatingTab() || activeTab() === null) setDraftUrl(value);
        }}
        onValueSubmit={handleAddressSubmit}
        onBack={() => webviewControls()?.back()}
        onForward={() => webviewControls()?.forward()}
        onReload={() => handleReload(false)}
        onReloadIgnoringCache={() => handleReload(true)}
        onNewTab={() => openComposer()}
        onActivateTab={activateTab}
        onCloseTab={closeTab}
        onPopout={() => void handlePopout()}
      />

      <div class="relative flex-1 min-h-0">
        {/* Hide the active-tab surface while the composer is open: the portal
            host's webview/iframe sits at z-40 (PortalContainer) and would
            otherwise paint over the BlankState overlay (z-10). Collapsing this
            wrapper to display:none drops the placeholder's bounding rect to
            0×0, which makes portal-host.syncRect flip the surface to
            visibility:hidden — the mount itself stays alive, so cancelling
            the composer brings the same webview back without a reload. */}
        {/* One viewport per tab. Inactive tabs collapse to display:none, which
            drops their placeholder rect to 0×0 — portal-host hides the
            iframe/webview but keeps it mounted, so switching back is a pure
            visibility flip with no reload. Each tab uses a panelId-scoped key
            (`${panelId}:${tab.id}`) so each tab gets its own portal mount. */}
        <div class={cn("h-full", creatingTab() && "hidden")}>
          <For each={normalized().tabs}>
            {(tab) => {
              const isActive = createMemo(() => normalized().activeTabId === tab.id);
              return (
                <div class={cn("absolute inset-0", !isActive() && "hidden")}>
                  <Show
                    when={isElectron()}
                    fallback={
                      <IframeViewport
                        panelId={`${props.panelId}:${tab.id}`}
                        url={tab.url}
                        reloadNonce={reloadNonceFor(tab.id)}
                      />
                    }
                  >
                    <WebviewViewport
                      panelId={`${props.panelId}:${tab.id}`}
                      url={tab.url}
                      active={isActive()}
                      onNavStateChange={setNavState}
                      onLiveUrlChange={setDisplayUrl}
                      onControlsReady={setWebviewControls}
                      onPopupIntercepted={(surfaceId, url) =>
                        void handlePopupIntercepted(surfaceId, url)
                      }
                    />
                  </Show>
                </div>
              );
            }}
          </For>
        </div>

        <Show when={creatingTab() || activeTab() === null}>
          <div class="absolute inset-0 z-10 bg-background">
            <BrowserBlankState
              recent={browserRecent()}
              title={draftTitle()}
              url={draftUrl()}
              onTitleInput={setDraftTitle}
              onUrlInput={setDraftUrl}
              onSubmit={() => createTabFromInputs(draftUrl(), draftTitle())}
              onOpenRecent={(entry) => createTabFromInputs(entry.url, entry.title)}
              onDeleteRecent={removeRecent}
              {...(activeTab() !== null
                ? { onCancel: cancelComposer }
                : {})}
            />
          </div>
        </Show>

        <Show when={dockPrompt()}>
          {(prompt) => (
            <Show when={activeServer()}>
              {(server) => (
                <DockPrompt
                  url={prompt().url}
                  title={prompt().title}
                  serverId={server().id}
                  onClose={() => setDockPrompt(null)}
                />
              )}
            </Show>
          )}
        </Show>
      </div>
    </div>
  );
}

function BrowserNavBar(props: {
  value: string;
  isComposer: boolean;
  canBack: boolean;
  canForward: boolean;
  tabs: ReturnType<typeof normalizeBrowserContent>["tabs"];
  activeTabId: string | null;
  onValueChange: (value: string) => void;
  onValueSubmit: (value: string) => void;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  onReloadIgnoringCache: () => void;
  onNewTab: () => void;
  onActivateTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onPopout: () => void;
}) {
  const [inputValue, setInputValue] = createSignal(props.value);

  createEffect(() => setInputValue(props.value));

  const handleKeyDown: JSX.EventHandlerUnion<HTMLInputElement, KeyboardEvent> = (event) => {
    if (event.key !== "Enter") return;
    props.onValueSubmit(inputValue());
  };

  // Popout (desktop only): hand the committed tab — not the address-bar draft —
  // to BrowserPanel.handlePopout, which decides between the dock overlay and a
  // saved per-URL preference. http(s) only, so a half-typed URL can't act.
  const activeTab = () => props.tabs.find((tab) => tab.id === props.activeTabId) ?? null;
  const pinnable = () => {
    const tab = activeTab();
    if (!tab) return false;
    try {
      return new URL(tab.url).protocol === "https:" || new URL(tab.url).protocol === "http:";
    } catch {
      return false;
    }
  };

  return (
    <div class="flex items-center gap-1 px-1.5 py-1.5 border-b bg-background/95 shrink-0">
      <div class="flex items-center gap-0.5">
        <button
          type="button"
          class="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:opacity-30"
          onClick={props.onBack}
          disabled={!props.canBack}
          title="Back"
        >
          <ArrowLeft class="size-3.5" />
        </button>
        <button
          type="button"
          class="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:opacity-30"
          onClick={props.onForward}
          disabled={!props.canForward}
          title="Forward"
        >
          <ArrowRight class="size-3.5" />
        </button>

        <ContextMenu>
          <ContextMenuTrigger
            as="button"
            type="button"
            class="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:opacity-30"
            onClick={props.onReload}
            disabled={props.isComposer}
            title="Reload"
          >
            <RotateCcw class="size-3.5" />
          </ContextMenuTrigger>
          <ContextMenuContent side="bottom" align="start" class="min-w-[12rem]">
            <ContextMenuItem onSelect={props.onReload}>
              Refresh
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={props.onReloadIgnoringCache}>
              Refresh and Clear Cache
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      </div>

      <div class="flex flex-1 items-center gap-2 rounded-lg border bg-muted/20 px-2.5 h-8 min-w-0">
        <Globe class="size-3 text-muted-foreground shrink-0" />
        <input
          type="text"
          class="flex-1 min-w-0 bg-transparent text-xs text-foreground outline-none"
          value={inputValue()}
          onInput={(event) => {
            setInputValue(event.currentTarget.value);
            props.onValueChange(event.currentTarget.value);
          }}
          onKeyDown={handleKeyDown}
          onFocus={(event) => event.currentTarget.select()}
          spellcheck={false}
          placeholder="Enter a URL"
        />
        <Show when={isElectron() && activeServer()}>
          <button
            type="button"
            class="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground disabled:opacity-30"
            onClick={props.onPopout}
            disabled={!pinnable()}
            title="Popout or save as a Web App"
            aria-label="Popout or save as a Web App"
          >
            <ExternalLink class="size-3" />
          </button>
        </Show>
      </div>

      <BrowserTabsDropdown
        tabs={props.tabs}
        activeTabId={props.activeTabId}
        onNewTab={props.onNewTab}
        onActivateTab={props.onActivateTab}
        onCloseTab={props.onCloseTab}
      />
    </div>
  );
}

function BrowserTabsDropdown(props: {
  tabs: ReturnType<typeof normalizeBrowserContent>["tabs"];
  activeTabId: string | null;
  onNewTab: () => void;
  onActivateTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        type="button"
        class="flex h-8 items-center gap-1 rounded-lg border bg-muted/20 px-2 text-[11px] text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
        title="Browser tabs"
      >
        <Plus class="size-3.5" />
        <Show when={props.tabs.length > 0}>
          <span class="font-medium tabular-nums">{props.tabs.length}</span>
        </Show>
        <ChevronDown class="size-3" />
      </DropdownMenuTrigger>

      <DropdownMenuContent
        side="bottom"
        align="end"
        sideOffset={6}
        class="w-[22rem] rounded-xl border-border/70 bg-background/95 p-2 shadow-2xl backdrop-blur"
      >
        <Show
          when={props.tabs.length > 0}
          fallback={
            <div class="px-3 py-3 text-xs italic text-muted-foreground">
              No open tabs
            </div>
          }
        >
          <For each={props.tabs}>
            {(tab) => (
              <div
                class={cn(
                  "group flex items-start gap-1 rounded-lg",
                  props.activeTabId === tab.id && "bg-muted/60"
                )}
              >
                <DropdownMenuItem
                  class="flex flex-1 min-w-0 flex-col items-start gap-0.5 rounded-lg bg-transparent px-3 py-2 focus:bg-muted/40"
                  onSelect={() => props.onActivateTab(tab.id)}
                >
                  <span class="max-w-full truncate text-sm text-foreground">
                    {tab.title || defaultBrowserTitle(tab.url)}
                  </span>
                  <span class="max-w-full truncate text-[11px] text-muted-foreground">
                    {tab.url}
                  </span>
                </DropdownMenuItem>
                <button
                  type="button"
                  class="mr-1 mt-1 flex size-7 shrink-0 items-center justify-center self-center rounded-md text-muted-foreground opacity-0 transition-colors hover:bg-muted hover:text-destructive focus:opacity-100 group-hover:opacity-100"
                  title="Close tab"
                  aria-label={`Close ${tab.title || tab.url}`}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    event.preventDefault();
                    props.onCloseTab(tab.id);
                  }}
                >
                  <X class="size-3.5" />
                </button>
              </div>
            )}
          </For>
        </Show>

        <DropdownMenuSeparator class="my-1" />
        <DropdownMenuItem class="rounded-lg px-3 py-2" onSelect={props.onNewTab}>
          <Plus class="size-3.5" />
          New tab
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function BrowserBlankState(props: {
  recent: BrowserRecentEntry[];
  title: string;
  url: string;
  onTitleInput: (value: string) => void;
  onUrlInput: (value: string) => void;
  onSubmit: () => void;
  onOpenRecent: (entry: BrowserRecentEntry) => void;
  onDeleteRecent: (url: string) => void;
  onCancel?: () => void;
}) {
  let urlInputRef: HTMLInputElement | undefined;

  onMount(() => {
    queueMicrotask(() => urlInputRef?.focus());
  });

  return (
    <div class="flex h-full flex-col overflow-auto px-5 py-5 sm:px-6">
      <div class="mx-auto w-full max-w-3xl">
        <div class="rounded-2xl border bg-muted/10 p-4 sm:p-5">
          <div class="flex items-start justify-between gap-3">
            <div>
              <p class="text-sm font-medium text-foreground">Open a tab</p>
              <p class="mt-1 text-xs text-muted-foreground">
                Give it a name if you want something cleaner than the raw URL.
              </p>
            </div>
            <Show when={props.onCancel}>
              <button
                type="button"
                class="rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                onClick={() => props.onCancel?.()}
              >
                Cancel
              </button>
            </Show>
          </div>

          <div class="mt-4 grid gap-3 sm:grid-cols-[minmax(0,15rem)_minmax(0,1fr)_auto]">
            <label class="flex min-w-0 flex-col gap-1">
              <span class="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                Name
              </span>
              <input
                type="text"
                value={props.title}
                onInput={(event) => props.onTitleInput(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") props.onSubmit();
                }}
                placeholder="Panel Display Name"
                class="h-9 rounded-lg border bg-background px-3 text-sm outline-none transition-colors focus:border-ring"
              />
            </label>

            <label class="flex min-w-0 flex-col gap-1">
              <span class="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                URL
              </span>
              <input
                ref={urlInputRef}
                type="text"
                value={props.url}
                onInput={(event) => props.onUrlInput(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") props.onSubmit();
                }}
                placeholder="https://example.com"
                class="h-9 rounded-lg border bg-background px-3 text-sm outline-none transition-colors focus:border-ring"
              />
            </label>

            <div class="flex items-end">
              <button
                type="button"
                onClick={props.onSubmit}
                class="inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
              >
                <Globe class="size-4" />
                Open
              </button>
            </div>
          </div>
        </div>

        <div class="mt-4 rounded-2xl border bg-muted/5 p-4 sm:p-5">
          <div class="flex items-center justify-between gap-3">
            <div>
              <p class="text-sm font-medium text-foreground">Recently Opened</p>
              <p class="mt-1 text-xs text-muted-foreground">
                Reopen something without typing the address again.
              </p>
            </div>
            <span class="rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground">
              {props.recent.length}
            </span>
          </div>

          <Show
            when={props.recent.length > 0}
            fallback={
              <div class="mt-4 rounded-xl border border-dashed px-4 py-6 text-center text-xs text-muted-foreground">
                Open a few sites and they will show up here.
              </div>
            }
          >
            <div class="mt-4 grid gap-2">
              <For each={props.recent}>
                {(entry) => (
                  <div class="group flex items-start gap-2 rounded-xl border bg-background px-3 py-3 transition-colors hover:bg-muted/40">
                    <button
                      type="button"
                      onClick={() => props.onOpenRecent(entry)}
                      class="flex min-w-0 flex-1 items-start gap-3 text-left"
                    >
                      <div class="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted/60">
                        <Globe class="size-4 text-muted-foreground" />
                      </div>
                      <div class="min-w-0 flex-1">
                        <p class="truncate text-sm font-medium text-foreground">
                          {entry.title || defaultBrowserTitle(entry.url)}
                        </p>
                        <p class="mt-0.5 truncate text-xs text-muted-foreground">
                          {entry.url}
                        </p>
                      </div>
                    </button>
                    <button
                      type="button"
                      onClick={() => props.onDeleteRecent(entry.url)}
                      class="flex size-7 shrink-0 self-center items-center justify-center rounded-md text-muted-foreground opacity-0 transition-colors hover:bg-muted hover:text-destructive focus:opacity-100 group-hover:opacity-100"
                      title="Remove from recent"
                      aria-label={`Remove ${entry.title || entry.url} from recent`}
                    >
                      <Trash2 class="size-4" />
                    </button>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </div>
      </div>
    </div>
  );
}

function IframeViewport(props: {
  panelId: string;
  url: string;
  reloadNonce: number;
}) {
  const { activeId } = useWorkspaceContext();
  const [currentUrl, setCurrentUrl] = createSignal(props.url);
  const [probe, setProbe] = createSignal<ProbeState>(probeResultCache.get(props.url) ?? "checking");

  const surfaceKey = surfaceKeyOf({ type: "browser", tabs: [], activeTabId: null });
  const mountKey = createMemo(() => `${activeId()}:${props.panelId}:${surfaceKey}`);
  let lastReloadNonce = props.reloadNonce;

  const runProbe = (url: string) => {
    const cached = probeResultCache.get(url);
    if (cached !== undefined) {
      setProbe(cached);
      return;
    }
    setProbe("checking");
    checkCanFrame(url)
      .then((canFrame) => {
        const result = canFrame ? "allowed" : "blocked";
        probeResultCache.set(url, result);
        setProbe(result);
      })
      .catch(() => {
        probeResultCache.set(url, "allowed");
        setProbe("allowed");
      });
  };

  createEffect(() => {
    const url = props.url;
    setCurrentUrl(url);
    runProbe(url);
  });

  createEffect(() => {
    const reloadNonce = props.reloadNonce;
    if (reloadNonce === lastReloadNonce) return;
    lastReloadNonce = reloadNonce;
    const url = currentUrl();
    if (!url) return;
    setCurrentUrl("");
    requestAnimationFrame(() => setCurrentUrl(url));
  });

  return (
    <div class="flex h-full min-h-0 flex-col">
      <Show when={probe() !== "checking"} fallback={<ProbingSpinner />}>
        <Show when={probe() === "allowed"} fallback={<WebInstallPrompt url={currentUrl()} />}>
          <IframeSurface
            mountKey={mountKey()}
            url={currentUrl()}
            onBlocked={() => setProbe("blocked")}
          />
        </Show>
      </Show>
    </div>
  );
}

export function IframeSurface(props: { mountKey: string; url: string; onBlocked: () => void }) {
  let placeholder!: HTMLDivElement;
  let iframe: HTMLIFrameElement | null = null;
  let lastMountKey: string | null = null;
  let lastLoadedUrl: string | null = null;

  createEffect(() => {
    const key = props.mountKey;
    if (lastMountKey === key && iframe !== null) return;
    if (lastMountKey !== null) portalHost.unmount(lastMountKey);

    const adopted = portalHost.hasMount(key)
      ? (portalHost.getMountElement(key) as HTMLIFrameElement | null)
      : null;
    const isAdoption = adopted !== null;
    const next: HTMLIFrameElement = adopted ?? (() => {
      const element = document.createElement("iframe");
      // Intentionally omit allow-same-origin: a hostile or XSS'd third-party
      // page would otherwise read its real-origin cookies/storage from inside
      // our frame. Cookie-bearing flows go through the Electron webview path.
      element.sandbox.add("allow-scripts", "allow-forms", "allow-popups");
      element.allow = "fullscreen";
      element.addEventListener("error", () => props.onBlocked());
      element.addEventListener("load", () => {
        if (element.contentWindow === null) {
          props.onBlocked();
          return;
        }
        try {
          void element.contentWindow.location.href;
          props.onBlocked();
        } catch {
          // Cross-origin success path.
        }
      });
      return element;
    })();

    portalHost.mount({
      key,
      workspaceId: key.split(":")[0]!,
      placeholder,
      element: next,
      ...(isAdoption
        ? {}
        : {
            onAttached: () => {
              next.src = props.url;
            },
          }),
    });

    iframe = next;
    lastMountKey = key;
    lastLoadedUrl = props.url;
  });

  createEffect(() => {
    const url = props.url;
    if (iframe !== null && lastLoadedUrl !== url && !browserUrlsEqual(lastLoadedUrl, url)) {
      lastLoadedUrl = url;
      iframe.src = url;
    }
  });

  onCleanup(() => {
    if (lastMountKey !== null) portalHost.unmount(lastMountKey);
    iframe = null;
  });

  return <div class="relative flex-1 min-h-0" ref={placeholder} />;
}

function WebviewViewport(props: {
  panelId: string;
  url: string;
  active: boolean;
  onNavStateChange: (state: { canBack: boolean; canForward: boolean }) => void;
  onLiveUrlChange: (url: string) => void;
  onControlsReady: (controls: WebviewControls | null) => void;
  // A site-initiated window.open from this guest was captured into a native view
  // by main; `surfaceId` keys that view. The webContentsId routing is internal.
  onPopupIntercepted: (surfaceId: number, url: string) => void;
}) {
  const { activeId } = useWorkspaceContext();
  let webviewEl: WebviewElement | null = null;
  // The guest WebContents id this viewport registered in popupInterceptHandlers.
  // getWebContentsId() throws before dom-ready, so we register on dom-ready and
  // remember the id here to unregister on release.
  let registeredWcId: number | null = null;

  const registerPopupRoute = () => {
    if (webviewEl === null || registeredWcId !== null) return;
    let id: number;
    try {
      id = webviewEl.getWebContentsId();
    } catch {
      return;
    }
    registeredWcId = id;
    popupInterceptHandlers.set(id, (surfaceId, url) =>
      props.onPopupIntercepted(surfaceId, url),
    );
  };

  const unregisterPopupRoute = () => {
    if (registeredWcId === null) return;
    popupInterceptHandlers.delete(registeredWcId);
    registeredWcId = null;
  };

  // Safety net: drop the route if the viewport unmounts while its element is
  // still in the portal (onElementReleased may not fire on teardown).
  onCleanup(unregisterPopupRoute);

  // Background tabs must not push state to the parent — that would let an
  // inactive tab's did-navigate clobber the active tab's address bar /
  // back-forward state. Active-flip is handled below by an effect that pushes
  // current state when this viewport becomes active.
  //
  // getURL/canGoBack/canGoForward all throw on a fresh <webview> until
  // dom-ready fires. The synchronous onElementReady call below runs during
  // the same event-handler tick that mounted the surface, so we have to
  // tolerate the pre-dom-ready state — dom-ready will retrigger us once the
  // webview is actually ready.
  const refreshNavState = () => {
    if (webviewEl === null) return;
    if (!props.active) return;
    let url: string;
    let canBack: boolean;
    let canForward: boolean;
    try {
      url = webviewEl.getURL();
      canBack = webviewEl.canGoBack();
      canForward = webviewEl.canGoForward();
    } catch {
      return;
    }
    props.onNavStateChange({ canBack, canForward });
    if (url !== "about:blank" && url !== "") {
      props.onLiveUrlChange(url);
    }
  };

  // Push current nav state + controls into the parent on activation. The
  // listener events (did-navigate etc.) won't refire just because the user
  // switched tabs, so we re-sync explicitly.
  createEffect(() => {
    if (!props.active) return;
    refreshNavState();
    if (webviewEl !== null) registerControls(webviewEl);
  });

  const surfaceKey = surfaceKeyOf({ type: "browser", tabs: [], activeTabId: null });
  const mountKey = createMemo(() => `${activeId()}:${props.panelId}:${surfaceKey}`);

  const registerControls = (element: WebviewElement | null) => {
    if (element === null) {
      props.onControlsReady(null);
      return;
    }
    props.onControlsReady({
      back: () => element.goBack(),
      forward: () => element.goForward(),
      reload: (ignoreCache) => {
        if (ignoreCache && typeof element.reloadIgnoringCache === "function") {
          element.reloadIgnoringCache();
          return;
        }
        element.reload();
      },
    });
  };

  return (
    <WebviewSurface
      mountKey={mountKey()}
      url={props.url}
      onElementReady={(element) => {
        webviewEl = element;
        ensurePopupInterceptSubscription();
        element.addEventListener("did-navigate", refreshNavState);
        element.addEventListener("did-navigate-in-page", refreshNavState);
        element.addEventListener("dom-ready", refreshNavState);
        element.addEventListener("dom-ready", registerPopupRoute);
        element.addEventListener("did-finish-load", refreshNavState);
        registerControls(element);
        // The guest may already be past dom-ready on adoption; try immediately.
        registerPopupRoute();
        // On adoption (e.g. fullscreen toggle remounts BrowserPanel), the new
        // BrowserPanel resets `displayUrl` to the persisted tab.url. The
        // webview itself is unchanged and may already be at a different live
        // URL after the user's navigation. Sync the address bar to the live
        // URL right away — did-navigate won't fire because we didn't actually
        // navigate.
        refreshNavState();
      }}
      onElementReleased={(element) => {
        element.removeEventListener("did-navigate", refreshNavState);
        element.removeEventListener("did-navigate-in-page", refreshNavState);
        element.removeEventListener("dom-ready", refreshNavState);
        element.removeEventListener("dom-ready", registerPopupRoute);
        element.removeEventListener("did-finish-load", refreshNavState);
        unregisterPopupRoute();
        if (webviewEl === element) webviewEl = null;
        registerControls(null);
        props.onNavStateChange(EMPTY_NAV_STATE);
      }}
    />
  );
}

export function WebviewSurface(props: {
  mountKey: string;
  url: string;
  /**
   * Electron session partition for the guest. Defaults to the shared browser
   * partition; reverse-proxy mounts pass a per-server `persist:proxy:<serverId>`
   * so a proxied app's cookies/storage are isolated from the general Browser
   * Panel and from other servers. Applied only when the element is created —
   * an adopted webview keeps its original partition (it's immutable post-attach).
   */
  partition?: string;
  onElementReady: (element: WebviewElement) => void;
  onElementReleased: (element: WebviewElement) => void;
}) {
  let placeholder!: HTMLDivElement;
  let webview: WebviewElement | null = null;
  let lastMountKey: string | null = null;
  let lastLoadedUrl: string | null = null;

  createEffect(() => {
    const key = props.mountKey;
    if (lastMountKey === key && webview !== null) return;
    if (lastMountKey !== null && webview !== null) {
      props.onElementReleased(webview);
      portalHost.unmount(lastMountKey);
    }

    const adopted = portalHost.hasMount(key)
      ? (portalHost.getMountElement(key) as WebviewElement | null)
      : null;
    const isAdoption = adopted !== null;
    const next: WebviewElement = adopted ?? (() => {
      const element = document.createElement("webview") as WebviewElement;
      element.setAttribute("nodeintegration", "false");
      // Bind every webview to a persistent session partition. A webview without
      // `partition` runs in an ephemeral in-memory session, so sign-in cookies
      // wouldn't survive a tab close. Browser panels share `persist:browser`;
      // proxy mounts pass a per-server `persist:proxy:<serverId>` for isolation.
      element.setAttribute("partition", props.partition ?? "persist:browser");
      // Let window.open reach the main-process window-open handler instead of
      // being silently suppressed by the guest. A <webview> without `allowpopups`
      // kills window.open() before setWindowOpenHandler ever fires, so a site's
      // "detach"/"pop-out" dead-ends. With it set, the request flows to the
      // handler (attachBrowserGuestPopupGuard / attachProxyGuestNavGuards in the
      // desktop main), which denies the in-app window and routes the URL to the
      // OS browser — no native popup ever spawns, so this stays safe.
      element.setAttribute("allowpopups", "true");
      return element;
    })();

    portalHost.mount({
      key,
      workspaceId: key.split(":")[0]!,
      placeholder,
      element: next,
      ...(isAdoption
        ? {}
        : {
            onAttached: () => {
              next.src = props.url;
              props.onElementReady(next);
            },
          }),
    });

    if (isAdoption) props.onElementReady(next);

    webview = next;
    lastMountKey = key;
    lastLoadedUrl = props.url;
  });

  createEffect(() => {
    const url = props.url;
    if (webview === null) return;
    if (browserUrlsEqual(lastLoadedUrl, url)) return;
    // Avoid reloading when displayUrl is just echoing back what the webview
    // navigated to itself. refreshNavState() pushes the live URL back into
    // displayUrl on every did-navigate / did-finish-load, which would
    // otherwise re-enter this effect with a redirected URL (e.g.
    // google.com → www.google.com) and trigger a redundant loadURL —
    // Google et al treat back-to-back navigations to the same URL as bot
    // behavior and serve a CAPTCHA. Only loadURL when the requested URL
    // genuinely differs from where the webview already is.
    if (browserUrlsEqual(webview.getURL(), url)) {
      lastLoadedUrl = url;
      return;
    }
    lastLoadedUrl = url;
    void webview.loadURL(url).catch((error) => {
      console.warn("[WebviewSurface] loadURL failed", error);
    });
  });

  onCleanup(() => {
    if (lastMountKey !== null && webview !== null) {
      props.onElementReleased(webview);
      portalHost.unmount(lastMountKey);
    }
    webview = null;
  });

  return <div class="relative h-full" ref={placeholder} />;
}

function ProbingSpinner() {
  return (
    <div class="flex flex-col flex-1 items-center justify-center gap-3 p-8 select-none">
      <div class="size-6 rounded-full border-2 border-muted border-t-muted-foreground animate-spin" />
      <p class="text-xs text-muted-foreground">Checking...</p>
    </div>
  );
}

function WebInstallPrompt(props: { url: string }) {
  return (
    <div class="flex flex-col flex-1 items-center justify-center gap-4 p-8 select-none">
      <div class="flex size-14 items-center justify-center rounded-2xl bg-muted/50">
        <Monitor class="size-7 text-muted-foreground" />
      </div>
      <div class="text-center max-w-xs">
        <p class="text-sm font-medium text-foreground">This site cannot be framed</p>
        <p class="mt-1.5 text-xs text-muted-foreground leading-relaxed">
          <span class="font-mono text-foreground/70 break-all">{new URL(props.url).hostname}</span>{" "}
          blocks embedding. Install the UnCorded desktop app to open it natively in a browser panel.
        </p>
      </div>
      <a
        href="https://uncorded.app/download"
        target="_blank"
        rel="noopener noreferrer"
        class="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
      >
        Download UnCorded
      </a>
    </div>
  );
}
