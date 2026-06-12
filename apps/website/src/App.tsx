import { createSignal, createEffect, createMemo, on, onMount, onCleanup, Show } from "solid-js";
import { AppSidebar } from "@/components/app-sidebar";
import { Titlebar } from "@/components/titlebar";
import { TunnelStateBanner, TunnelExpiredGate } from "@/components/tunnel-state-notice";
import { PanelLayout } from "@/components/panel";
import { NEW_WORKSPACE_TAB_ID, type Workspace, WorkspaceTabs } from "@/components/workspace-tabs";
import { PortalContainer } from "@/components/portal-container";
import { ToastViewport } from "@/components/ui/toast";
import { TooltipHoverLayer } from "@/components/ui/tooltip";
import { DragCaptureRoot } from "@/components/drag-capture-root";
import { DragPill } from "@/components/drag-pill";
import { CenterDropOverlay } from "@/components/center-drop-overlay";
import {
  type DropTarget,
  type DropZone,
  dragContext,
  dropTarget,
  dwelling,
  tabDwellProgress,
  tabDwellTarget,
} from "@/lib/drag-state";
import * as portalHost from "@/lib/portal-host";
import { surfaceKeyOf } from "@/lib/surface-key";
import { Separator } from "@/components/ui/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import {
  type PanelNode,
  PREVIEW_LEAF_ID,
  closeLeaf,
  countLeaves,
  createLeaf,
  getLeafIds,
  insertAtEdge,
  insertBesideLeaf,
  movePanel,
  splitLeaf,
  updateRatio,
} from "@/lib/panel-layout";
import { showInlineStatus } from "@/lib/feedback";
import { type PanelContent } from "@uncorded/protocol";
import { account, authLoading, bootstrap, setAuthNotice } from "@/stores/auth";
import { activeServer, activeServerId } from "@/stores/servers";
import { onPluginMessage, onReconnect } from "@/lib/ws";
import { onServerPurged } from "@/lib/server-purge";
import { onPluginPanelFocus, onPluginPanelOpen } from "@/lib/plugin-panel-events";
import { browserContentEquals } from "@/lib/browser-panel-state";
import type { WebApp } from "@uncorded/electron-bridge";
import {
  onOpenWebAppAsPanel,
  onLiveSurfaceDockRequested,
  dockLiveSurface,
  liveSurfaceRelease,
} from "@/stores/web-apps";
import { allLiveInstanceIds, clearLiveSurface, peekLiveSurface } from "@/lib/live-surfaces";
import { AuthPage } from "@/components/auth/auth-page";
import type { SidebarItem } from "@/stores/sidebar";
import { mountSidebarStore, sections } from "@/stores/sidebar";
import { mountMembershipStore } from "@/stores/membership";
import { mountPermissionsStores } from "@/stores/permissions";
import { mountBrowserRecentStore } from "@/stores/browser-recent";
import { mountSidebarCollapseStore } from "@/stores/sidebar-collapse";
import { mountVoiceProvisioningStore } from "@/stores/voice-provisioning";
import { mountVoiceReachabilityStore } from "@/stores/voice-reachability";
import { mountVoiceSetupBridge } from "@/stores/voice-setup";
import { mountRuntimeUpdateStore } from "@/stores/runtime-update";
import { VoiceSetupModal } from "@/components/voice/voice-setup-modal";
import { AudioBlockedBanner } from "@/components/audio-blocked-banner";
import { PostUpdateOverlay } from "@/components/server/post-update-overlay";
import { cinematicState } from "@/stores/cinematic";
import { ScreenShareOverlay } from "@/components/screen-share-overlay";
import { ProxyMountOverlay } from "@/components/proxy-mount-overlay";
import { ScreenSharePicker } from "@/components/voice/screen-share-picker";
import { UserCardSheet } from "@/components/user-card-sheet";
import { FilePreviewOverlay } from "@/components/file-preview-overlay";
import { filePreview } from "@/stores/file-preview";
import * as liveSurfaceHost from "@/lib/live-surface-host";
import { MemberManageSheet } from "@/components/server/member-manage-sheet";
import { CoViewSheet } from "@/co-view/co-view-sheet";
import { HostShellRunner } from "@/co-view/host-shell-runner";
import { ViewerSession } from "@/co-view/viewer-session";
import { CoViewHostProvider } from "@/co-view/host-context";
import type { CoViewHostController } from "@/co-view/host-context";
import type { CoViewStateSnapshot } from "@uncorded/protocol";
import {
  coViewHostingPaused,
  coViewHostingSessionId,
  coViewViewingSessionId,
  setCoViewHosting,
  setCoViewHostingPaused,
  setCoViewViewing,
} from "@/co-view/active-state";
import { onCoViewSheetOpen } from "@/lib/co-view-events";
import { initUpdateStore, disposeUpdateStore } from "@/stores/update-store";
import { installIframeFocusDismiss } from "@/lib/iframe-focus-dismiss";
import { bootTrace } from "@/lib/boot-trace";
import {
  createWorkspaceLayout,
  deleteWorkspaceLayout,
  EDITOR_ID,
  listWorkspaceLayouts,
  updateWorkspaceLayout,
} from "@/api/runtime";
import { WorkspaceContext } from "@/lib/workspace-context";
import type { WorkspaceLayout } from "@uncorded/protocol";

function uid() {
  return Math.random().toString(36).slice(2, 9);
}

function firstLeafId(node: PanelNode): string {
  if (node.type === "leaf") return node.id;
  return firstLeafId(node.first);
}

// Structural equality for PanelContent. Used by reconcilePanels to preserve
// object references when a remote sync arrives but doesn't actually change
// what a leaf is displaying — avoids rerendering the portal mount.
function shallowEqualPanel(a: PanelContent, b: PanelContent): boolean {
  if (a === b) return true;
  if (a.type !== b.type) return false;
  if (a.type === "plugin" && b.type === "plugin") {
    return a.serverId === b.serverId
      && a.slug === b.slug
      && a.itemId === b.itemId
      && a.itemLabel === b.itemLabel
      && a.itemIcon === b.itemIcon;
  }
  if (a.type === "browser" && b.type === "browser") {
    return browserContentEquals(a, b);
  }
  if (a.type === "webapp" && b.type === "webapp") {
    return a.instanceId === b.instanceId
      && a.webAppId === b.webAppId
      && a.url === b.url
      && a.title === b.title;
  }
  return false;
}

// surfaceKey-aware reconciliation: for every leaf in newMap, keep the old
// reference if fields match — otherwise take the new one. Reference stability
// lets Solid's fine-grained reactivity skip re-renders; different refs with
// same surfaceKey trigger in-place navigation (PluginFrame's itemId effect,
// IframeSurface's URL effect, WebviewSurface's loadURL effect).
function reconcilePanels(
  oldMap: Record<string, PanelContent>,
  newMap: Record<string, PanelContent>,
): Record<string, PanelContent> {
  const merged: Record<string, PanelContent> = {};
  for (const [leafId, next] of Object.entries(newMap)) {
    const prev = oldMap[leafId];
    merged[leafId] = prev !== undefined && shallowEqualPanel(prev, next) ? prev : next;
  }
  return merged;
}

// Legacy backfill: a `webapp` panel needs a non-empty `instanceId` (the per-panel
// identity that keys its live surface and surfaceKey). Layouts saved before
// instanceId existed — and the runtime validator tolerates that, treating it as
// optional back-compat — arrive without one; mint a fresh id on ingest so the
// surface-key never collapses to `webapp:undefined`. Returns the SAME object
// when nothing was missing, preserving reference stability for reconcilePanels.
function backfillWebAppInstanceIds(
  panels: Record<string, PanelContent>,
): Record<string, PanelContent> {
  let mutated = false;
  const out: Record<string, PanelContent> = {};
  for (const [leafId, content] of Object.entries(panels)) {
    if (content.type === "webapp" && (typeof content.instanceId !== "string" || content.instanceId.length === 0)) {
      out[leafId] = { ...content, instanceId: crypto.randomUUID() };
      mutated = true;
    } else {
      out[leafId] = content;
    }
  }
  return mutated ? out : panels;
}

// Translate URL params left over from Central redirects (email verification,
// future OAuth bounces) into UI feedback. Returns the cleaned URL — caller
// should replaceState so the params don't survive a refresh and double-fire.
function consumeAuthRedirectParams(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  const params = url.searchParams;
  let consumed = false;

  if (params.get("verified") === "1") {
    showInlineStatus("Email verified — welcome!", "info");
    params.delete("verified");
    consumed = true;
  }

  const error = params.get("error");
  if (error === "verify_failed") {
    setAuthNotice({
      message:
        "That verification link is invalid or has expired. Request a new one from the sign-in screen.",
      severity: "error",
    });
    params.delete("error");
    consumed = true;
  } else if (error === "verify_rate_limited") {
    setAuthNotice({
      message: "Too many verification attempts. Please try again in a few minutes.",
      severity: "error",
    });
    params.delete("error");
    consumed = true;
  }

  if (!consumed) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}

function App() {
  bootTrace("app.render");
  onMount(() => {
    bootTrace("app.onMount");
    if (typeof window !== "undefined") {
      const cleaned = consumeAuthRedirectParams(window.location.href);
      if (cleaned !== null) {
        window.history.replaceState(null, "", cleaned);
      }
    }
    void bootstrap();
    // Electron-only: pull any notices the main process accrued during startup
    // (e.g. registry quarantine from corrupt-file recovery). Guarded behind
    // the runtime-detected electron bridge so the web build is unaffected.
    // The main-side handler awaits the startup-complete gate before reading
    // the session flag, so racing the pull against startup can't return a
    // falsely-empty list.
    const bridge = (typeof window !== "undefined" ? window.electron : undefined);
    if (bridge?.app?.getStartupNotices) {
      void bridge.app.getStartupNotices()
        .then((notices) => {
          for (const n of notices) showInlineStatus(n.message, n.severity);
        })
        .catch((err: unknown) => {
          console.error("[startup-notices] fetch failed", err);
        });
    }
    initUpdateStore();
    const disposeIframeFocusDismiss = installIframeFocusDismiss();
    onCleanup(() => {
      disposeUpdateStore();
      disposeIframeFocusDismiss();
    });
  });
  bootTrace("app.mountStores");
  mountSidebarStore();
  mountMembershipStore();
  mountPermissionsStores();
  mountBrowserRecentStore();
  mountSidebarCollapseStore();
  mountVoiceProvisioningStore();
  mountVoiceReachabilityStore();
  mountVoiceSetupBridge();
  mountRuntimeUpdateStore();

  const initialId = uid();

  const [workspaces, setWorkspaces] = createSignal<Workspace[]>([
    { id: initialId, name: "Workspace 1", savedId: null, syncState: "local" },
  ]);
  const [activeId, setActiveId] = createSignal(initialId);
  const [layouts, setLayouts] = createSignal<Record<string, PanelNode>>({
    [initialId]: createLeaf(),
  });
  const [panelContents, setPanelContents] = createSignal<
    Record<string, Record<string, PanelContent>>
  >({ [initialId]: {} });
  const [focusedLeaves, setFocusedLeaves] = createSignal<Record<string, string | null>>({
    [initialId]: null,
  });
  const [workspaceError, setWorkspaceError] = createSignal(false);

  // ---------------------------------------------------------------------------
  // Co-View — sheet open state + per-server hosting/viewing session ids.
  // The active-state store holds the per-server ids so that switching servers
  // doesn't lose a host session that's still running. The sheet open signal is
  // global (it always shows the active server's data), and the host
  // controller signal is a forward-reference for <CoViewHostProvider>.
  // ---------------------------------------------------------------------------
  const [coViewSheetOpen, setCoViewSheetOpen] = createSignal(false);
  const [coViewSnapshot, setCoViewSnapshot] = createSignal<CoViewStateSnapshot | null>(null);
  const [coViewHostController, setCoViewHostController] = createSignal<CoViewHostController | null>(
    null,
  );

  onMount(() => {
    const dispose = onCoViewSheetOpen(() => setCoViewSheetOpen(true));
    onCleanup(dispose);
  });

  // ---------------------------------------------------------------------------
  // Co-View — host shell-state mirror (spec-27 PR-CV5).
  //
  // While the local user is hosting, push the current route, active workspace
  // layout, and per-leaf panel metadata into the host controller. The producer
  // diffs the resulting shell-state and broadcasts patches; viewers reconstruct
  // the layout tree and render real panel chrome (label/icon/content kind)
  // instead of the placeholder dashed boxes. Effects early-return until the
  // controller is published so cost-when-idle stays at one tracked read.
  // ---------------------------------------------------------------------------
  createEffect(() => {
    const ctrl = coViewHostController();
    if (!ctrl) return;
    const sid = activeServerId();
    const wid = activeId();
    const path = sid ? `/server/${sid}/workspace/${wid}` : `/workspace/${wid}`;
    ctrl.setRoute({ pathname: path });
  });

  createEffect(() => {
    const ctrl = coViewHostController();
    if (!ctrl) return;
    const wid = activeId();
    const root = layouts()[wid];
    if (!root) return;
    ctrl.setWorkspace({ activeId: wid, layouts: { [wid]: root } });
  });

  // Per-leaf metadata. Diff the previous leaf set against the current one so
  // removed leaves get explicitly nulled; otherwise the producer would carry
  // stale entries forever.
  let prevCoViewLeafIds: Set<string> = new Set();
  createEffect(() => {
    const ctrl = coViewHostController();
    if (!ctrl) {
      prevCoViewLeafIds = new Set();
      return;
    }
    const wid = activeId();
    const root = layouts()[wid];
    const contents = panelContents()[wid] ?? {};
    const currentIds = new Set(root ? getLeafIds(root) : []);
    for (const id of currentIds) {
      const content = contents[id];
      const meta: { visibility: "shared" | "skeleton" | "hidden"; content?: PanelContent } = {
        visibility: "shared",
      };
      if (content) meta.content = content;
      ctrl.setPanelMeta(id, meta);
    }
    for (const id of prevCoViewLeafIds) {
      if (!currentIds.has(id)) ctrl.setPanelMeta(id, null);
    }
    prevCoViewLeafIds = currentIds;
  });

  // Mount-key contract — must match the format channel-view.tsx and
  // browser-panel.tsx pass to portalHost.mount. Centralised here so destroy
  // sites compute the same string the surfaces register under.
  const mountKeyFor = (workspaceId: string, leafId: string, content: PanelContent): string =>
    `${workspaceId}:${leafId}:${surfaceKeyOf(content)}`;

  // Single entrypoint for every panel-content mutation. Guarantees the
  // surfaceKey reconciliation contract: any leaf whose new content is
  // shallow-equal to its existing content keeps its old object reference,
  // which keeps portal-hosted iframes alive. Local drops, sync updates,
  // and any future source all share this path.
  //
  // Also responsible for explicit portal-host teardown: when a leaf's content
  // is removed or replaced with a different surfaceKey, the old mount becomes
  // unreachable. Hide-by-default semantics in portal-host mean the iframe
  // stays in the portal forever unless we destroy it here. Diffs prev vs next
  // and calls destroyByKey for every disappearing or surface-changed mount.
  const mutatePanelContents = (
    workspaceId: string,
    updater: (prev: Record<string, PanelContent>) => Record<string, PanelContent>,
  ) => {
    setPanelContents((c) => {
      const prev = c[workspaceId] ?? {};
      const next = backfillWebAppInstanceIds(updater(prev));
      if (prev === next) return c;
      const reconciled = reconcilePanels(prev, next);
      for (const [leafId, prevContent] of Object.entries(prev)) {
        const nextContent = reconciled[leafId];
        if (nextContent === undefined) {
          portalHost.destroyByKey(mountKeyFor(workspaceId, leafId, prevContent));
          continue;
        }
        const prevKey = mountKeyFor(workspaceId, leafId, prevContent);
        const nextKey = mountKeyFor(workspaceId, leafId, nextContent);
        if (prevKey !== nextKey) portalHost.destroyByKey(prevKey);
      }
      return { ...c, [workspaceId]: reconciled };
    });
  };

  // Sidebar rename/icon-change → repaint open panels. Plugin PanelContent
  // snapshots the item's label and icon at drop-time so the panel header can
  // render without re-querying the sidebar store. When the source item is
  // renamed or its icon changes, those snapshots go stale. Walk every
  // workspace's panels and patch matching (slug, itemId) entries; reconciliation
  // preserves refs for unchanged panels and only swaps the ones that actually
  // moved, so the iframe mount survives.
  createEffect(() => {
    const sidebarSections = sections();
    if (sidebarSections.length === 0) return;
    const lookup = new Map<string, { label: string; icon?: string }>();
    for (const section of sidebarSections) {
      for (const item of section.items) {
        lookup.set(`${item.slug}:${item.id}`, {
          label: item.label,
          ...(item.icon ? { icon: item.icon } : {}),
        });
      }
    }
    const allPanels = panelContents();
    for (const wsId of Object.keys(allPanels)) {
      const panels = allPanels[wsId] ?? {};
      let dirty = false;
      const next: Record<string, PanelContent> = {};
      for (const [leafId, content] of Object.entries(panels)) {
        if (content.type !== "plugin") {
          next[leafId] = content;
          continue;
        }
        const fresh = lookup.get(`${content.slug}:${content.itemId}`);
        if (!fresh) {
          next[leafId] = content;
          continue;
        }
        const labelChanged = fresh.label !== content.itemLabel;
        const iconChanged = (fresh.icon ?? undefined) !== (content.itemIcon ?? undefined);
        if (!labelChanged && !iconChanged) {
          next[leafId] = content;
          continue;
        }
        dirty = true;
        next[leafId] = {
          type: "plugin",
          serverId: content.serverId,
          slug: content.slug,
          itemId: content.itemId,
          itemLabel: fresh.label,
          ...(fresh.icon ? { itemIcon: fresh.icon } : {}),
        };
      }
      if (dirty) mutatePanelContents(wsId, () => next);
    }
  });

  const activeLayout = () => layouts()[activeId()] ?? createLeaf();
  const activePanelContents = () => panelContents()[activeId()] ?? {};
  const activeFocusedLeafId = () => focusedLeaves()[activeId()] ?? null;
  const getContent = (leafId: string) => activePanelContents()[leafId];

  const workspaceLayoutFor = (id: string): WorkspaceLayout => {
    const root = layouts()[id] ?? createLeaf();
    const panels = panelContents()[id] ?? {};
    const focusedLeafId = focusedLeaves()[id] ?? null;
    const persistedFocusedLeafId =
      focusedLeafId !== null && getLeafIds(root).includes(focusedLeafId)
        ? focusedLeafId
        : null;
    return {
      version: 1,
      root,
      panels,
      ...(persistedFocusedLeafId ? { focusedLeafId: persistedFocusedLeafId } : {}),
    };
  };

  // Preview layout: while the user is dwelling over a committable drop zone,
  // apply the would-be move to the render tree so the layout physically
  // reflows to show where the drop would land. On cursor movement `dwelling`
  // flips back to false and this memo collapses to the base layout — panels
  // flex-transition back.
  //
  //   - Panel drag, edge zone: reuse existing `movePanel` (real leaf id).
  //   - Sidebar-item drag, edge zone: insert a ghost leaf at PREVIEW_LEAF_ID
  //     so the layout can physically make room. Commit path materialises a
  //     real uid'd leaf and real PanelContent; the ghost never persists.
  //   - Center zones: no layout change (drop-into-existing-leaf is a content
  //     swap, not a structure change). Feedback for those remains the ring.
  //
  // The commit path (handleMovePanel / handleSidebarDrop) still reads from
  // `layouts`, not this memo — so abandoning the drop just means the preview
  // collapses without ever touching the real store.
  const previewLayout = createMemo<PanelNode>(() => {
    const base = activeLayout();
    const focusedLeafId = activeFocusedLeafId();
    if (focusedLeafId !== null && getLeafIds(base).includes(focusedLeafId)) {
      return { type: "leaf", id: focusedLeafId };
    }
    if (!dwelling()) return base;
    const ctx = dragContext();
    const tgt = dropTarget();
    if (ctx === null || tgt === null) return base;
    if (tgt.zone === "center") return base;
    const direction: "horizontal" | "vertical" =
      tgt.zone === "left" || tgt.zone === "right" ? "horizontal" : "vertical";
    const position: "before" | "after" =
      tgt.zone === "left" || tgt.zone === "top" ? "before" : "after";
    if (ctx.kind === "panel") {
      return movePanel(base, ctx.sourceLeafId, tgt.leafId, direction, position);
    }
    if (ctx.kind === "sidebar-item" || ctx.kind === "web-app") {
      return insertAtEdge(base, tgt.leafId, PREVIEW_LEAF_ID, direction, position);
    }
    return base;
  });

  // ── Cross-workspace drag: auto-switch on tab-dwell ────────────────────────
  // drag-state runs a 600ms rAF progress ticker over a workspace tab while
  // dragging. When progress reaches 1 we flip activeId — or, if the user
  // dwelled on the "+" button sentinel, create a new workspace first and
  // switch to it. A latch guards against re-firing; tabDwellTarget returning
  // to null (cursor left) resets it so a subsequent dwell on the same target
  // fires again.
  //
  // The source workspace's tree unmounts on activeId change; its portal
  // mounts hit the preservation path in portal-host (set by drag-state's
  // pre-threshold hook), so the dragged iframe survives the switch until
  // commit rekeys it into the destination.
  let lastTabDwellSwitch: string | null = null;
  createEffect(() => {
    const target = tabDwellTarget();
    const progress = tabDwellProgress();
    if (target === null) {
      lastTabDwellSwitch = null;
      return;
    }
    if (progress < 1) return;
    if (lastTabDwellSwitch === target) return;
    lastTabDwellSwitch = target;
    if (target === NEW_WORKSPACE_TAB_ID) {
      addWorkspace();
      return;
    }
    if (target !== activeId()) setActiveId(target);
  });

  // ── Auto-save infrastructure ───────────────────────────────────────────────
  const autoSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // In-flight PUT AbortController per workspace. Needed so a purgeServer
  // firing between "snapshot panelContents at timer-fire" and "PUT resolves"
  // can cancel the request carrying the pre-purge payload — otherwise the
  // scrubbed local state disagrees with what the runtime just persisted.
  const autoSaveAborters = new Map<string, AbortController>();

  onCleanup(() => {
    autoSaveTimers.forEach(clearTimeout);
    autoSaveTimers.clear();
    autoSaveAborters.forEach((c) => c.abort());
    autoSaveAborters.clear();
  });

  const scheduleAutoSave = (id: string) => {
    const ws = workspaces().find((w) => w.id === id);
    if (!ws?.savedId) return;

    setWorkspaces((w) =>
      w.map((t) =>
        t.id === id && (t.syncState === "saved" || t.syncState === "error")
          ? { ...t, syncState: "dirty" as const }
          : t
      )
    );

    const existing = autoSaveTimers.get(id);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      autoSaveTimers.delete(id);
      const server = activeServer();
      const currentWs = workspaces().find((w) => w.id === id);
      if (!server?.tunnel_url || !currentWs?.savedId) return;

      setWorkspaces((w) =>
        w.map((t) => (t.id === id ? { ...t, syncState: "saving" as const } : t))
      );
      // Replace any previous in-flight aborter. An autosave can only overlap
      // itself if two timers fire for the same workspace in <1s, which the
      // clearTimeout above prevents — still cheap to be defensive.
      const prevAborter = autoSaveAborters.get(id);
      if (prevAborter) prevAborter.abort();
      const aborter = new AbortController();
      autoSaveAborters.set(id, aborter);
      updateWorkspaceLayout(server.tunnel_url, server.id, currentWs.savedId, {
        layout: workspaceLayoutFor(id),
      }, aborter.signal)
        .then(() => {
          if (autoSaveAborters.get(id) === aborter) autoSaveAborters.delete(id);
          setWorkspaces((w) =>
            w.map((t) => (t.id === id ? { ...t, syncState: "saved" as const } : t))
          );
        })
        .catch((err) => {
          if (autoSaveAborters.get(id) === aborter) autoSaveAborters.delete(id);
          // An abort (from purge subscriber) is not a save error — the purge
          // path reschedules with scrubbed content, so keep the workspace in
          // its current (dirty) state rather than surfacing "save failed".
          if (err instanceof DOMException && err.name === "AbortError") return;
          setWorkspaces((w) =>
            w.map((t) => (t.id === id ? { ...t, syncState: "error" as const } : t))
          );
        });
    }, 1500);

    autoSaveTimers.set(id, timer);
  };

  // ── Purge fan-out ──────────────────────────────────────────────────────────
  // When a server is purged (user delete, Central 404, WS 4003, token revoke),
  // every workspace's panel tree and panel-content record may reference it.
  // Walk all workspaces, drop matching leaves + entries, cancel any pending
  // autosave timer, abort any in-flight PUT (it carries pre-purge content),
  // then reschedule. Local-only workspaces (savedId === null) get only the
  // in-memory scrub — scheduleAutoSave early-returns for them, which is
  // correct: there's no remote state to reconcile.
  const unsubscribePurge = onServerPurged((purgedId) => {
    const allPanels = panelContents();
    for (const wsId of Object.keys(allPanels)) {
      const panels = allPanels[wsId] ?? {};
      const orphanLeafIds = Object.entries(panels)
        .filter(([, c]) => c.type === "plugin" && c.serverId === purgedId)
        .map(([leafId]) => leafId);
      if (orphanLeafIds.length === 0) continue;

      mutatePanelContents(wsId, (prev) => {
        const next = { ...prev };
        for (const id of orphanLeafIds) delete next[id];
        return next;
      });
      const focusedLeafId = focusedLeaves()[wsId] ?? null;
      setLayouts((ls) => {
        const root = ls[wsId];
        if (!root) return ls;
        let nextRoot = root;
        for (const id of orphanLeafIds) nextRoot = closeLeaf(nextRoot, id);
        if (focusedLeafId !== null && !getLeafIds(nextRoot).includes(focusedLeafId)) {
          clearFocusedLeaf(wsId);
        }
        return { ...ls, [wsId]: nextRoot };
      });
      const timer = autoSaveTimers.get(wsId);
      if (timer) { clearTimeout(timer); autoSaveTimers.delete(wsId); }
      const aborter = autoSaveAborters.get(wsId);
      if (aborter) { aborter.abort(); autoSaveAborters.delete(wsId); }
      scheduleAutoSave(wsId);
    }
  });
  onCleanup(unsubscribePurge);

  // ── Load saved workspaces when server changes ──────────────────────────────
  const resetWorkspaces = () => {
    // Tear down every prior-server mount before re-seeding. Without this,
    // hidden mounts from the previous server would persist indefinitely
    // (and possibly collide on key if a new mount happened to compute the
    // same `${ws}:${leaf}:${surfaceKey}` triple).
    portalHost.destroyAll();
    const id = uid();
    setWorkspaces([{ id, name: "Workspace 1", savedId: null, syncState: "local" }]);
    setLayouts({ [id]: createLeaf() });
    setPanelContents({ [id]: {} });
    setFocusedLeaves({ [id]: null });
    setActiveId(id);
  };

  createEffect(on(activeServerId, (serverId) => {
    autoSaveTimers.forEach(clearTimeout);
    autoSaveTimers.clear();
    autoSaveAborters.forEach((c) => c.abort());
    autoSaveAborters.clear();

    setWorkspaceError(false);
    if (!serverId) { resetWorkspaces(); return; }
    const server = activeServer();
    if (!server?.tunnel_url) { resetWorkspaces(); return; }

    // Destroy all mounts from the prior server BEFORE issuing the load.
    // The success path below replaces all workspace state directly (without
    // going through resetWorkspaces), so we can't rely on resetWorkspaces
    // alone to clear them. Doing it here is unconditional — even a
    // load-failure follow-up would reach a clean portal.
    portalHost.destroyAll();

    listWorkspaceLayouts(server.tunnel_url, server.id)
      .then((saved) => {
        if (saved.length === 0) { resetWorkspaces(); return; }

        const newWorkspaces: Workspace[] = saved.map((sw) => ({
          id: uid(),
          name: sw.name ?? "Workspace",
          savedId: sw.id,
          syncState: "saved" as const,
        }));
        const newLayouts: Record<string, PanelNode> = {};
        const newPanelContents: Record<string, Record<string, PanelContent>> = {};
        const newFocusedLeaves: Record<string, string | null> = {};
        saved.forEach((sw, i) => {
          const localId = newWorkspaces[i]!.id;
          newLayouts[localId] = sw.layout.root;
          newPanelContents[localId] = backfillWebAppInstanceIds(sw.layout.panels);
          newFocusedLeaves[localId] = sw.layout.focusedLeafId ?? null;
        });

        setWorkspaces(newWorkspaces);
        setLayouts(newLayouts);
        setPanelContents(newPanelContents);
        setFocusedLeaves(newFocusedLeaves);
        setActiveId(newWorkspaces[0]!.id);
      })
      .catch((err) => {
        // Don't surface the banner on first-load failure — the retry-on-WS-connect
        // path below handles the common race (fresh container, keys not cached,
        // tunnel not yet routing). Banner is reserved for the retry also failing.
        console.warn("[workspace] initial layout load failed (will retry on WS connect):", err instanceof Error ? err.message : err);
        resetWorkspaces();
      });
  }));

  // ── Retry workspace load when WS connects ─────────────────────────────────
  // Handles the race where the initial HTTP load ran before the server had
  // cached Central's public keys (fresh container with empty central_public_keys).
  // WS auth only succeeds once keys are loaded, so onReconnect is the safe
  // moment to retry.
  createEffect(() => {
    const server = activeServer();
    if (!server?.tunnel_url) return;
    const tunnelUrl = server.tunnel_url;
    const serverId = server.id;

    const unregister = onReconnect((reconnectedServerId) => {
      if (reconnectedServerId !== serverId) return;
      // Only retry if no workspaces have been saved-linked yet (initial load failed)
      if (workspaces().some((w) => w.savedId !== null)) return;

      listWorkspaceLayouts(tunnelUrl, serverId)
        .then((saved) => {
          if (saved.length === 0) return;
          // Tear down any ephemeral mounts from the placeholder workspace
          // before replacing state — same reasoning as the initial-load path.
          portalHost.destroyAll();
          const newWorkspaces: Workspace[] = saved.map((sw) => ({
            id: uid(),
            name: sw.name ?? "Workspace",
            savedId: sw.id,
            syncState: "saved" as const,
          }));
          const newLayouts: Record<string, PanelNode> = {};
          const newPanelContents: Record<string, Record<string, PanelContent>> = {};
          const newFocusedLeaves: Record<string, string | null> = {};
          saved.forEach((sw, i) => {
            const localId = newWorkspaces[i]!.id;
            newLayouts[localId] = sw.layout.root;
            newPanelContents[localId] = backfillWebAppInstanceIds(sw.layout.panels);
            newFocusedLeaves[localId] = sw.layout.focusedLeafId ?? null;
          });
          setWorkspaces(newWorkspaces);
          setLayouts(newLayouts);
          setPanelContents(newPanelContents);
          setFocusedLeaves(newFocusedLeaves);
          setActiveId(newWorkspaces[0]!.id);
        })
        .catch((err) => {
          // Retry also failed — now surface the banner.
          console.warn("[workspace] retry load failed:", err instanceof Error ? err.message : err);
          setWorkspaceError(true);
        });
    });

    onCleanup(unregister);
  });

  // ── Pending sync queue (used during an active drag) ───────────────────────
  // Remote `__workspace:sync` updates arriving while the user is mid-drag are
  // queued here instead of applied immediately — stomping the tree out from
  // under the user mid-motion is jarring. Commit paths drain this on their way
  // out; a cancel-path watcher on `dragContext` drains it when a drag ends
  // without a commit (ESC, blur, pointercancel, drop outside).
  type PendingSync = {
    localWorkspaceId: string;
    root: PanelNode;
    panels: Record<string, PanelContent>;
    focusedLeafId: string | null;
    name: string | null;
  };
  let pendingSync: PendingSync | null = null;

  const applySync = (s: PendingSync) => {
    setLayouts((l) => ({ ...l, [s.localWorkspaceId]: s.root }));
    mutatePanelContents(s.localWorkspaceId, () => s.panels);
    setFocusedLeaves((f) => ({ ...f, [s.localWorkspaceId]: s.focusedLeafId }));
    const current = workspaces().find((w) => w.id === s.localWorkspaceId);
    if (s.name !== null && current && s.name !== current.name) {
      setWorkspaces((w) => w.map((t) => t.id === s.localWorkspaceId ? { ...t, name: s.name! } : t));
    }
  };

  // Cancel-path drain: when `dragContext` transitions back to null without a
  // commit callback firing, drain the queued sync so the remote tree lands.
  createEffect(on(dragContext, (ctx, prevCtx) => {
    if (prevCtx !== undefined && prevCtx !== null && ctx === null) {
      const queued = pendingSync;
      pendingSync = null;
      if (queued !== null) applySync(queued);
    }
  }));

  // ── Live workspace sync from other clients ─────────────────────────────────
  createEffect(() => {
    const server = activeServer();
    if (!server?.tunnel_url) return;
    const tunnelUrl = server.tunnel_url;
    const serverId = server.id;

    const unregister = onPluginMessage(serverId, "__workspace:sync", (data) => {
      const msg = data as Record<string, unknown>;
      if (msg["type"] !== "event" || msg["topic"] !== "workspace:updated") return;
      const payload = msg["payload"] as { savedId: string; editor_id?: string };

      // Ignore our own saves — the runtime broadcasts to every WS connection for
      // this user, including the tab that just saved. Without this filter, the
      // handler below re-fetches and replaces panelContents refs, which flips
      // the keyed <Show> in panel.tsx and remounts every plugin iframe on every
      // autosave.
      if (payload.editor_id === EDITOR_ID) return;

      const ws = workspaces().find((w) => w.savedId === payload.savedId);
      // Skip if we own this save and it's in-flight
      if (ws && (ws.syncState === "saving" || ws.syncState === "dirty")) return;

      listWorkspaceLayouts(tunnelUrl, serverId)
        .then((saved) => {
          const updated = saved.find((s) => s.id === payload.savedId);
          if (!updated) return;

          const localWs = workspaces().find((w) => w.savedId === payload.savedId);
          if (!localWs) {
            // New workspace from another session — add it immediately (not
            // affected by drag, which acts on the active workspace only).
            const newId = uid();
            setWorkspaces((w) => [...w, { id: newId, name: updated.name ?? "Workspace", savedId: updated.id, syncState: "saved" as const }]);
            setLayouts((l) => ({ ...l, [newId]: updated.layout.root }));
            setPanelContents((c) => ({ ...c, [newId]: backfillWebAppInstanceIds(updated.layout.panels) }));
            setFocusedLeaves((f) => ({ ...f, [newId]: updated.layout.focusedLeafId ?? null }));
            return;
          }
          if (localWs.syncState === "saving" || localWs.syncState === "dirty") return;

          const pending: PendingSync = {
            localWorkspaceId: localWs.id,
            root: updated.layout.root,
            panels: updated.layout.panels,
            focusedLeafId: updated.layout.focusedLeafId ?? null,
            name: updated.name,
          };

          // Queue only if the remote update targets the workspace being
          // dragged in. Any non-active workspace is safe to apply immediately.
          if (dragContext() !== null && localWs.id === activeId()) {
            pendingSync = pending;
            return;
          }
          applySync(pending);
        })
        .catch(() => {});
    });

    onCleanup(unregister);
  });

  const clearFocusedLeaf = (workspaceId: string) => {
    setFocusedLeaves((f) => {
      if ((f[workspaceId] ?? null) === null) return f;
      return { ...f, [workspaceId]: null };
    });
  };

  const focusPanel = (workspaceId: string, leafId: string) => {
    const root = layouts()[workspaceId] ?? createLeaf();
    if (!getLeafIds(root).includes(leafId)) return;
    if ((panelContents()[workspaceId] ?? {})[leafId] === undefined) return;
    setFocusedLeaves((f) => {
      if (f[workspaceId] === leafId) return f;
      return { ...f, [workspaceId]: leafId };
    });
    scheduleAutoSave(workspaceId);
  };

  const restoreWorkspaceLayout = (workspaceId: string) => {
    if ((focusedLeaves()[workspaceId] ?? null) === null) return;
    clearFocusedLeaf(workspaceId);
    scheduleAutoSave(workspaceId);
  };

  const dropToPanel = (leafId: string, content: PanelContent) => {
    mutatePanelContents(activeId(), (prev) => ({ ...prev, [leafId]: content }));
    scheduleAutoSave(activeId());
  };

  const updateLocalLayout = (workspaceId: string, fn: (node: PanelNode) => PanelNode) => {
    setLayouts((l) => ({ ...l, [workspaceId]: fn(l[workspaceId] ?? createLeaf()) }));
    scheduleAutoSave(workspaceId);
  };

  const updatePanelContent = (leafId: string, content: PanelContent) => {
    mutatePanelContents(activeId(), (prev) => ({ ...prev, [leafId]: content }));
    scheduleAutoSave(activeId());
  };

  const dropChannelToEdge = (
    targetLeafId: string,
    content: PanelContent,
    direction: "horizontal" | "vertical",
    position: "before" | "after"
  ) => {
    clearFocusedLeaf(activeId());
    const newLeafId = uid();
    // insertAtEdge picks tight-split-vs-full-edge based on the target leaf's
    // tree position; previewLayout uses the same op so commit matches preview.
    updateLayout((tree) =>
      insertAtEdge(tree, targetLeafId, newLeafId, direction, position)
    );
    mutatePanelContents(activeId(), (prev) => ({ ...prev, [newLeafId]: content }));
    scheduleAutoSave(activeId());
  };

  const updateLayout = (fn: (node: PanelNode) => PanelNode) => {
    setLayouts((l) => ({ ...l, [activeId()]: fn(l[activeId()] ?? createLeaf()) }));
    scheduleAutoSave(activeId());
  };

  // ── Workspace handlers ─────────────────────────────────────────────────────
  const addWorkspace = () => {
    const id = uid();
    setWorkspaces((w) => [...w, { id, name: `Workspace ${w.length + 1}`, savedId: null, syncState: "local" as const }]);
    setLayouts((l) => ({ ...l, [id]: createLeaf() }));
    setPanelContents((c) => ({ ...c, [id]: {} }));
    setFocusedLeaves((f) => ({ ...f, [id]: null }));
    setActiveId(id);
  };

  const closeWorkspace = (id: string) => {
    const tabs = workspaces();
    if (tabs.length === 1) return;
    const idx = tabs.findIndex((t) => t.id === id);
    const next = tabs[idx === tabs.length - 1 ? idx - 1 : idx + 1];
    // Destroy every portal mount under this workspace before dropping its
    // state. PluginFrame component-unmounts only call portalHost.unmount
    // (hide-on-zero), which would orphan the mount in the portal indefinitely.
    portalHost.destroyByWorkspace(id);
    setWorkspaces((w) => w.filter((t) => t.id !== id));
    setLayouts(({ [id]: _r, ...rest }) => rest);
    setPanelContents(({ [id]: _r, ...rest }) => rest);
    setFocusedLeaves(({ [id]: _r, ...rest }) => rest);
    if (activeId() === id && next) setActiveId(next.id);
  };

  const renameWorkspace = (id: string, name: string) => {
    setWorkspaces((w) => w.map((t) => (t.id === id ? { ...t, name } : t)));
  };

  const saveWorkspace = (id: string, name: string | null) => {
    const server = activeServer();
    if (!server?.tunnel_url) return;
    const workspaceLayout = workspaceLayoutFor(id);
    const ws = workspaces().find((w) => w.id === id);
    const displayName = name ?? ws?.name ?? null;
    setWorkspaces((w) => w.map((t) => (t.id === id ? { ...t, syncState: "saving" as const } : t)));

    if (ws?.savedId) {
      // Already saved — just update name + layout
      updateWorkspaceLayout(server.tunnel_url, server.id, ws.savedId, {
        name: displayName,
        layout: workspaceLayout,
      })
        .then(() => {
          setWorkspaces((w) =>
            w.map((t) => (t.id === id ? { ...t, syncState: "saved" as const, name: displayName ?? t.name } : t))
          );
        })
        .catch(() => {
          setWorkspaces((w) => w.map((t) => (t.id === id ? { ...t, syncState: "error" as const } : t)));
        });
    } else {
      createWorkspaceLayout(server.tunnel_url, server.id, displayName, workspaceLayout)
        .then((saved) => {
          setWorkspaces((w) =>
            w.map((t) => (t.id === id ? { ...t, savedId: saved.id, syncState: "saved" as const, name: saved.name ?? t.name } : t))
          );
        })
        .catch(() => {
          setWorkspaces((w) => w.map((t) => (t.id === id ? { ...t, syncState: "error" as const } : t)));
        });
    }
  };

  const unsaveWorkspace = (id: string) => {
    const server = activeServer();
    const ws = workspaces().find((w) => w.id === id);
    if (!server?.tunnel_url || !ws?.savedId) return;
    const savedId = ws.savedId;
    deleteWorkspaceLayout(server.tunnel_url, server.id, savedId)
      .then(() => {
        setWorkspaces((w) => w.map((t) => (t.id === id ? { ...t, savedId: null, syncState: "local" as const } : t)));
      })
      .catch(() => {
        // Leave in saved state if delete failed
      });
  };

  // ── Panel handlers ─────────────────────────────────────────────────────────
  const handleSplit = (id: string, direction: "horizontal" | "vertical") => {
    clearFocusedLeaf(activeId());
    updateLayout((tree) => splitLeaf(tree, id, direction));
  };

  const handleClose = (id: string) => {
    clearFocusedLeaf(activeId());
    // Prune both the layout tree and the panel-content entry atomically.
    // Leaving an orphan in panelContents causes the runtime to reject the
    // autosave PUT with LAYOUT_ORPHAN_PANEL and flip the workspace to "error".
    updateLayout((tree) => closeLeaf(tree, id));
    mutatePanelContents(activeId(), ({ [id]: _removed, ...rest }) => rest);
  };

  const handleUpdateRatio = (id: string, ratio: number) => {
    updateLayout((tree) => updateRatio(tree, id, ratio));
  };

  const handleTogglePanelFocus = (id: string) => {
    const wsId = activeId();
    if (activeFocusedLeafId() === id) {
      restoreWorkspaceLayout(wsId);
      return;
    }
    focusPanel(wsId, id);
  };

  const canClose = () => countLeaves(activeLayout()) > 1;

  const handleSidebarItemOpen = (item: SidebarItem) => {
    const server = activeServer();
    if (!server || !server.tunnel_url) return;
    const content: PanelContent = {
      type: "plugin",
      serverId: server.id,
      slug: item.slug,
      itemId: item.id,
      itemLabel: item.label,
      ...(item.icon ? { itemIcon: item.icon } : {}),
    };
    dropToPanel(activeFocusedLeafId() ?? firstLeafId(activeLayout()), content);
  };

  // Open a desktop Web App as a bare-webview panel (warm, login-sticky). Same
  // drop-target resolution as handleSidebarItemOpen; the webapp content renders
  // a chromeless WebviewSurface on persist:browser (see WebAppPanel), keyed by
  // webAppId so each app is its own warm surface.
  const handleOpenWebApp = (app: WebApp) => {
    const content: PanelContent = {
      type: "webapp",
      webAppId: app.id,
      instanceId: crypto.randomUUID(),
      url: app.url,
      title: app.title,
    };
    dropToPanel(activeFocusedLeafId() ?? firstLeafId(activeLayout()), content);
  };

  // Dock a page as a NEW workspace panel (split), not by replacing the focused
  // leaf — this is the path the popout window's "Dock" button drives, and the
  // user wants docking to ADD a panel. Mirrors the sidebar-edge drop. Falls
  // back to filling the leaf when the focused leaf is empty (don't split next to
  // a blank panel). Distinct from handleOpenWebApp (sidebar click → replace),
  // which stays as-is. No webAppId on the content: dock ≠ save — a docked panel
  // is pure layout, not a bookmark ("Save as Web App" stays explicit).
  const dockWebAppAsNewPanel = (app: { url: string; title: string }, instanceId: string) => {
    let titleFallback = app.url;
    try {
      titleFallback = new URL(app.url).host;
    } catch {
      /* keep raw url */
    }
    const content: PanelContent = {
      type: "webapp",
      instanceId,
      url: app.url,
      title: app.title || titleFallback,
    };
    const targetLeafId = activeFocusedLeafId() ?? firstLeafId(activeLayout());
    if (getContent(targetLeafId) === undefined) dropToPanel(targetLeafId, content);
    else dropChannelToEdge(targetLeafId, content, "horizontal", "after");
  };

  // The dock flow (a "dock"-pref interception, or the popout window's "Dock"
  // button) docks a live page by emitting here, so we don't drill a callback
  // through the panel tree. Opens as a NEW panel (split).
  createEffect(() => {
    const unsubscribe = onOpenWebAppAsPanel((app, instanceId) => dockWebAppAsNewPanel(app, instanceId));
    onCleanup(unsubscribe);
  });

  // Step 1 of the dock handshake: the popout window's "Dock" button. The popout
  // is still open and still owns the view — dockLiveSurface verifies an active
  // server (toast + stop if none; the popout survives), claims the view from
  // main, and only then flows through the subscription above to open a panel.
  // Top-level (not per-panel) so it survives the originating browser panel closing.
  createEffect(() => {
    const unsubscribe = onLiveSurfaceDockRequested(({ surfaceId, url, title }) => {
      void dockLiveSurface(surfaceId, url, title);
    });
    onCleanup(unsubscribe);
  });

  // Native WebContentsViews (docked Web App panels) paint ABOVE all renderer DOM,
  // so an overlay can't cover them by z-index — overlays only display above the
  // panels if we HIDE the panels while an overlay is open. Suspend every native
  // surface whenever any blocking overlay is open: every Kobalte Dialog/Sheet
  // registers a blocker for its open lifetime (surfaceBlockersActive), plus the
  // two non-Kobalte full-bleed overlays — the file-preview modal and the
  // cinematic/update takeover. Restored when they all close.
  createEffect(() => {
    const overlayOpen =
      liveSurfaceHost.surfaceBlockersActive() ||
      filePreview() !== null ||
      cinematicState() !== "idle";
    liveSurfaceHost.setSuspended(overlayOpen);
  });

  // Release leaked live surfaces (B3). A Web App panel owns a live
  // WebContentsView in main; closing the panel, replacing its leaf, or deleting
  // its workspace must destroy that view or it leaks (holds a renderer + session,
  // painting nowhere). The render path only ever CREATES, so this single
  // reconciliation effect is the release chokepoint: diff the instanceIds present
  // across EVERY workspace's panels against the registered live surfaces, and
  // release any surface whose panel is gone. One effect covers close / replace /
  // workspace-delete uniformly. Surfaces for inactive-workspace panels stay alive
  // (their content is still present under that workspace id). A surface currently
  // popped out into its own window is protected by main's LIVE_SURFACE_RELEASE
  // no-op (surfacePopouts membership), so this won't yank a live popout.
  createEffect(() => {
    const present = new Set<string>();
    for (const ws of Object.values(panelContents())) {
      for (const content of Object.values(ws)) {
        if (content.type === "webapp") present.add(content.instanceId);
      }
    }
    const live = allLiveInstanceIds();
    for (const instanceId of live) {
      if (present.has(instanceId)) continue;
      const sid = peekLiveSurface(instanceId);
      if (sid !== null) void liveSurfaceRelease(sid);
      clearLiveSurface(instanceId);
    }
  });

  // Plugin-driven browser opening is disabled until `client.browser` capability
  // enforcement is designed and implemented (see spec-20). The shell no longer
  // subscribes to a plugin browser-open channel; user-owned browser panels are
  // created directly from the panel UI and are unaffected.

  // ── Panel drag-to-rearrange ────────────────────────────────────────────────
  // Drag state lives in `lib/drag-state` (pointer pipeline). panel.tsx and
  // nav-sidebar-sections.tsx call startPointerDrag; their onCommit callbacks
  // route back here via onMovePanel / handleSidebarDrop.

  // Plugin panel open from SDK. PluginFrame validates requests so plugins can
  // only open another panel for their own slug/server.
  createEffect(() => {
    const unsubscribe = onPluginPanelOpen((request) => {
      const workspaceId = request.workspaceId;
      const root = layouts()[workspaceId] ?? createLeaf();
      const panels = panelContents()[workspaceId] ?? {};
      const sourcePanelExists = getLeafIds(root).includes(request.sourcePanelId);
      const targetId = sourcePanelExists ? request.sourcePanelId : firstLeafId(root);

      if (request.mode === "reuse-or-create") {
        const existing = Object.entries(panels).find(([, content]) =>
          shallowEqualPanel(content, request.content),
        );
        if (existing !== undefined) {
          const [leafId] = existing;
          if ((focusedLeaves()[workspaceId] ?? null) !== null) {
            focusPanel(workspaceId, leafId);
          }
          return;
        }
      }

      if (request.placement === "replace-current") {
        mutatePanelContents(workspaceId, (prev) => ({
          ...prev,
          [targetId]: request.content,
        }));
        scheduleAutoSave(workspaceId);
        return;
      }

      clearFocusedLeaf(workspaceId);
      const newLeafId = uid();
      updateLocalLayout(workspaceId, (tree) =>
        insertBesideLeaf(tree, targetId, newLeafId, "horizontal", "after"),
      );
      mutatePanelContents(workspaceId, (prev) => ({
        ...prev,
        [newLeafId]: request.content,
      }));
      scheduleAutoSave(workspaceId);
    });
    onCleanup(unsubscribe);
  });

  createEffect(() => {
    const unsubscribe = onPluginPanelFocus(({ workspaceId, panelId }) => {
      const root = layouts()[workspaceId];
      if (!root || !getLeafIds(root).includes(panelId)) return;
      focusPanel(workspaceId, panelId);
    });
    onCleanup(unsubscribe);
  });

  const handleMovePanel = (
    draggedId: string,
    targetId: string,
    zone: DropZone,
    sourceWorkspaceId: string,
  ) => {
    if (draggedId === targetId) return;
    const destWorkspaceId = activeId();

    // Cross-workspace commit: the user dwelled on a tab mid-drag, activeId
    // flipped, and now they've released on a leaf in the destination tree.
    // Source and destination workspaces both need updates, the iframe mount
    // has to follow (portal rekey), and both workspaces autosave. Skip the
    // pendingSync rebase for this path — remote updates to a non-active
    // workspace have already been applied directly by the sync handler, so
    // there's nothing sitting in the queue targeting source; pendingSync
    // only holds updates for the *currently active* workspace (== dest
    // here), which the insert-new-leaf case tolerates because we're adding,
    // not modifying existing structure.
    if (sourceWorkspaceId !== destWorkspaceId) {
      if ((focusedLeaves()[sourceWorkspaceId] ?? null) === draggedId) {
        clearFocusedLeaf(sourceWorkspaceId);
      }
      if ((focusedLeaves()[destWorkspaceId] ?? null) !== null) {
        clearFocusedLeaf(destWorkspaceId);
      }
      const srcPanels = panelContents()[sourceWorkspaceId] ?? {};
      const content = srcPanels[draggedId];
      if (content === undefined) return;

      const sk = surfaceKeyOf(content);
      const destPanels = panelContents()[destWorkspaceId] ?? {};
      // Center drop on an empty leaf (common case: user spun up a fresh
      // workspace via plus-icon dwell, which seeds a single empty leaf) —
      // occupy that leaf in place. Reuses the destination leaf's id so the
      // portal mount rekeys to an already-existing placeholder and the
      // source iframe lands without a reload. Center on a populated leaf
      // has no unambiguous semantic and the commit is dropped.
      if (zone === "center") {
        if (destPanels[targetId] !== undefined) return;
        const oldKey = `${sourceWorkspaceId}:${draggedId}:${sk}`;
        const newKey = `${destWorkspaceId}:${targetId}:${sk}`;
        portalHost.rekey(oldKey, newKey);

        setLayouts((l) => {
          const srcLayout = l[sourceWorkspaceId] ?? createLeaf();
          return { ...l, [sourceWorkspaceId]: closeLeaf(srcLayout, draggedId) };
        });

        setPanelContents((c) => {
          const src = c[sourceWorkspaceId] ?? {};
          const dest = c[destWorkspaceId] ?? {};
          const { [draggedId]: _removed, ...restSrc } = src;
          const nextDest = reconcilePanels(dest, { ...dest, [targetId]: content });
          return { ...c, [sourceWorkspaceId]: restSrc, [destWorkspaceId]: nextDest };
        });

        scheduleAutoSave(sourceWorkspaceId);
        const destWsC = workspaces().find((w) => w.id === destWorkspaceId);
        const sourceWsC = workspaces().find((w) => w.id === sourceWorkspaceId);
        if (destWsC && destWsC.savedId === null && sourceWsC?.savedId) {
          saveWorkspace(destWorkspaceId, null);
        } else {
          scheduleAutoSave(destWorkspaceId);
        }
        return;
      }

      const direction: "horizontal" | "vertical" =
        zone === "left" || zone === "right" ? "horizontal" : "vertical";
      const position: "before" | "after" =
        zone === "left" || zone === "top" ? "before" : "after";

      // Fresh leaf id for the destination so we can never collide with an
      // existing leaf in the dest tree. Mount key then maps 1:1 with the leaf.
      const newLeafId = uid();
      const oldKey = `${sourceWorkspaceId}:${draggedId}:${sk}`;
      const newKey = `${destWorkspaceId}:${newLeafId}:${sk}`;

      // Rekey BEFORE the store update. Destination leaf renders after
      // setLayouts triggers its effect; its mount(newKey) call has to find
      // the existing (preserved, display:none'd) entry to adopt it.
      portalHost.rekey(oldKey, newKey);

      setLayouts((l) => {
        const srcLayout = l[sourceWorkspaceId] ?? createLeaf();
        const destLayout = l[destWorkspaceId] ?? createLeaf();
        const newSrcLayout = closeLeaf(srcLayout, draggedId);
        // insertAtEdge — outer-edge drops produce a full-width row / column,
        // inner-edge drops produce a tight 50/50 split next to the target.
        // Same op as the preview, so commit matches preview.
        const newDestLayout = insertAtEdge(
          destLayout,
          targetId,
          newLeafId,
          direction,
          position,
        );
        return { ...l, [sourceWorkspaceId]: newSrcLayout, [destWorkspaceId]: newDestLayout };
      });

      setPanelContents((c) => {
        const src = c[sourceWorkspaceId] ?? {};
        const dest = c[destWorkspaceId] ?? {};
        const { [draggedId]: _removed, ...restSrc } = src;
        const nextDest = reconcilePanels(dest, { ...dest, [newLeafId]: content });
        return { ...c, [sourceWorkspaceId]: restSrc, [destWorkspaceId]: nextDest };
      });

      // Source: normal autosave. No-op if source was unsaved.
      scheduleAutoSave(sourceWorkspaceId);
      // Destination: if it's unsaved but source was saved, promote it. A panel
      // from a persistent workspace should remain persistent after the move —
      // "dragging into a new workspace" (plus-icon dwell flow) then saves the
      // new workspace with the panel. Unsaved-to-unsaved stays ephemeral.
      const destWs = workspaces().find((w) => w.id === destWorkspaceId);
      const sourceWs = workspaces().find((w) => w.id === sourceWorkspaceId);
      if (destWs && destWs.savedId === null && sourceWs?.savedId) {
        saveWorkspace(destWorkspaceId, null);
      } else {
        scheduleAutoSave(destWorkspaceId);
      }
      return;
    }

    // Same-workspace move requires an edge zone (center was rejected upstream
    // in panel.tsx onCommit). Defensive guard in case that ever changes.
    if (zone === "center") return;
    clearFocusedLeaf(destWorkspaceId);
    const direction: "horizontal" | "vertical" =
      zone === "left" || zone === "right" ? "horizontal" : "vertical";
    const position: "before" | "after" =
      zone === "left" || zone === "top" ? "before" : "after";

    // Commit-time sync rebase: if a remote update arrived mid-drag, we queued
    // it rather than stomping the tree. Now drain it and either (a) rebase the
    // drop onto the remote tree, or (b) abandon the drop if source/target no
    // longer exist remotely.
    const queued = pendingSync;
    pendingSync = null;
    if (queued !== null && queued.localWorkspaceId === activeId()) {
      const ids = getLeafIds(queued.root);
      if (!ids.includes(draggedId)) {
        showInlineStatus("This panel was closed in another session.", "warning");
        applySync(queued);
        return;
      }
      if (!ids.includes(targetId)) {
        showInlineStatus("Drop target was closed elsewhere.", "warning");
        applySync(queued);
        return;
      }
      // Both still present in the remote tree — rebase the move onto it.
      const rebased = movePanel(queued.root, draggedId, targetId, direction, position);
      setLayouts((l) => ({ ...l, [queued.localWorkspaceId]: rebased }));
      mutatePanelContents(queued.localWorkspaceId, () => queued.panels);
      setFocusedLeaves((f) => ({ ...f, [queued.localWorkspaceId]: null }));
      if (queued.name !== null) {
        const current = workspaces().find((w) => w.id === queued.localWorkspaceId);
        if (current && queued.name !== current.name) {
          setWorkspaces((w) => w.map((t) => t.id === queued.localWorkspaceId ? { ...t, name: queued.name! } : t));
        }
      }
      scheduleAutoSave(queued.localWorkspaceId);
      return;
    }

    updateLayout((tree) => movePanel(tree, draggedId, targetId, direction, position));
  };

  // Sidebar-item drop commit. The pointer pipeline hands us a DropTarget
  // (leafId + zone); we materialize the PanelContent from activeServer() and
  // hand off to dropToPanel (center) or dropChannelToEdge (edge).
  const handleSidebarDrop = (item: SidebarItem, target: DropTarget) => {
    const server = activeServer();
    if (!server?.tunnel_url) return;

    // Commit-time sync rebase (see handleMovePanel for the full rationale).
    const queued = pendingSync;
    pendingSync = null;
    if (queued !== null && queued.localWorkspaceId === activeId()) {
      if (!getLeafIds(queued.root).includes(target.leafId)) {
        showInlineStatus("Drop target was closed elsewhere.", "warning");
        applySync(queued);
        return;
      }
      // Drop target is still present remotely — accept the remote tree first,
      // then apply the sidebar drop on top. Keeps the user's action.
      applySync(queued);
    }

    const content: PanelContent = {
      type: "plugin",
      serverId: server.id,
      slug: item.slug,
      itemId: item.id,
      itemLabel: item.label,
      ...(item.icon ? { itemIcon: item.icon } : {}),
    };
    if (target.zone === "center") {
      dropToPanel(target.leafId, content);
      return;
    }
    clearFocusedLeaf(activeId());
    const dir: "horizontal" | "vertical" =
      target.zone === "left" || target.zone === "right" ? "horizontal" : "vertical";
    const pos: "before" | "after" =
      target.zone === "left" || target.zone === "top" ? "before" : "after";
    dropChannelToEdge(target.leafId, content, dir, pos);
  };

  // Web App dropped from the sidebar into the workspace. Mirrors
  // handleSidebarDrop but builds a `webapp` PanelContent (chromeless, warm).
  // Mints a fresh per-panel instanceId — like handleOpenWebApp, each open of an
  // app is its own live surface (so dragging the same app in twice yields two
  // independent panels rather than two views fighting over one surface; B2).
  const handleWebAppDrop = (app: WebApp, target: DropTarget) => {
    const content: PanelContent = {
      type: "webapp",
      webAppId: app.id,
      instanceId: crypto.randomUUID(),
      url: app.url,
      title: app.title,
    };
    if (target.zone === "center") {
      dropToPanel(target.leafId, content);
      return;
    }
    clearFocusedLeaf(activeId());
    const dir: "horizontal" | "vertical" =
      target.zone === "left" || target.zone === "right" ? "horizontal" : "vertical";
    const pos: "before" | "after" =
      target.zone === "left" || target.zone === "top" ? "before" : "after";
    dropChannelToEdge(target.leafId, content, dir, pos);
  };

  return (
    <div class="flex h-full flex-col">
      {/* Custom titlebar — desktop-only (Titlebar returns null in browser).
          Renders ABOVE the auth gate so it's visible during boot, the auth
          page, and authed states. The cinematic-shell + cinematic-backdrop
          stay below this in the tree but use `fixed inset-0` for the backdrop
          so it still covers the titlebar visually during the install window. */}
      <Titlebar />
      <div class="relative flex flex-1 flex-col min-h-0">
        <Show
          when={!authLoading()}
          fallback={
            <div class="flex flex-1 items-center justify-center bg-background">
              <div class="size-6 animate-spin rounded-full border-2 border-muted border-t-foreground" />
            </div>
          }
        >
          <Show when={account() !== null} fallback={<AuthPage />}>
        <WorkspaceContext.Provider value={{ activeId }}>
          {/* Cinematic shell — clip-path collapses outside-in when the user
              clicks "Restart to apply update", then expands inside-out on
              Continue. EVERYTHING that's part of the workspace UX (chrome,
              plugin iframes, drag UI, sheets, screen-share videos) lives
              inside this wrapper so the clip-path takes the entire viewport,
              not just the AppShell chrome. The PostUpdateOverlay is the ONLY
              sibling (outside this wrapper) so it remains visible while the
              workspace is clipped to circle(0%). See stores/cinematic.ts. */}
          <CoViewHostProvider controller={coViewHostController()}>
          <div
            class="relative flex flex-1 flex-col min-h-0 cinematic-shell"
            data-cinematic={cinematicState()}
          >
            <AppShell
              workspaceError={workspaceError()}
              onDismissWorkspaceError={() => setWorkspaceError(false)}
              workspaces={workspaces()}
              activeId={activeId()}
              activeServerId={activeServerId()}
              activeLayout={previewLayout()}
              focusedLeafId={activeFocusedLeafId()}
              canClose={canClose()}
              getContent={getContent}
              onActivate={setActiveId}
              onAdd={addWorkspace}
              onClose={closeWorkspace}
              onRename={renameWorkspace}
              onSave={saveWorkspace}
              onUnsave={unsaveWorkspace}
              onSplit={handleSplit}
              onTogglePanelFocus={handleTogglePanelFocus}
              onPanelClose={handleClose}
              onUpdateRatio={handleUpdateRatio}
              onDrop={dropToPanel}
              onUpdateContent={updatePanelContent}
              onDropSplit={dropChannelToEdge}
              onMovePanel={handleMovePanel}
              onItemSelect={handleSidebarItemOpen}
              onItemDrop={handleSidebarDrop}
              onOpenWebApp={handleOpenWebApp}
              onWebAppDrop={handleWebAppDrop}
            />
            {/* Single portal parent for all iframes/webviews — mounted once at App
                root so panel re-parenting never reloads surfaces. Placed after the
                app tree so stacking order is portal > tree by default; explicit
                z-index: 40 inside PortalContainer fixes the layer. */}
            <PortalContainer />
            {/* Stable pointer-capture root. Sits at z-48 — above portal iframes,
                below modals. Owns setPointerCapture during an active drag so
                capture survives source-leaf DOM mutations. */}
            <DragCaptureRoot />
            {/* Cursor-attached drag pill. Replaces the earlier physical-motion
                ghost; source panels stay put and the pill communicates the
                "something is being dragged" state. pointer-events: none so the
                pill doesn't intercept hit-testing underneath. */}
            <DragPill getPanelContent={getContent} />
            {/* Center-drop preview overlay. Mounted at root (not inside the panel
                tree) so its z-46 sits above portal iframes (z-40) — a sibling
                stacking context an in-tree overlay can't reach. */}
            <CenterDropOverlay getPanelContent={getContent} />
            {/* Voice setup modal — owner-only flow surfaced when a user clicks a
                dimmed voice channel or a voice plugin emits
                `platform.voice.request-setup`. */}
            <VoiceSetupModal />
            {/* Audio autoplay-unblock banner — shown when the LiveKit Room
                reports playback is blocked (iOS Safari, strict autoplay).
                See audio-blocked-banner.tsx for the full rationale. */}
            <AudioBlockedBanner />
            {/* PR-6 — screen-share <video> overlay. Paints absolutely-positioned
                <video> elements over the rectangles plugin iframes report via
                `platform.voice.register-screen-slot`. z-index 41 sits above
                PortalContainer (40); pointer-events: none lets clicks fall
                through to the iframe underneath. */}
            <ScreenShareOverlay />
            {/* Host-owned reverse-proxy surfaces. Paints a sandboxed <iframe>
                (web) or hardened <webview> (desktop) over the viewport rect a
                proxy plugin reserves via sdk.proxy.reserveMount(). The real
                surface lives in PortalContainer (z-40); this layer only carries
                the placeholders, so it's pointer-events:none. */}
            <ProxyMountOverlay />
            {/* PR-6 — Electron-only screen-share picker. Inert in browser
                builds (returns null). Subscribes to main-process picker
                requests pushed when LiveKit calls getDisplayMedia, renders
                a thumbnail-grid modal, and ships the selection back via
                respondToPicker. */}
            <ScreenSharePicker />
            {/* Discord-style user card. Opened by clicking any avatar (sidebar
                voice presence today; text-channels + voice-channels iframes
                wire in next). State lives in `stores/user-card`; the sheet
                reads it reactively and slides in from the right. */}
            <UserCardSheet />
            {/* Member-management sheet — opened from user-card-sheet's Manage
                button after the actor's `core.permissions.manage` check passes.
                Hidden when no target is set; lifecycle managed by stores/member-manage. */}
            <MemberManageSheet />
            {/* File-preview overlay — opened by plugins via
                `platform.files.preview`. Rendered shell-side because plugins
                can't host PDF iframes inside their own sandbox (opaque origin
                breaks PDFium). State lives in `stores/file-preview`. */}
            <FilePreviewOverlay />
            {/* Co-View — host shell runner mounts only when this user is the
                host on the active server. Pure orchestration: returns null and
                pumps state/event/cursor/pen frames to the runtime. */}
            <Show when={activeServerId() && coViewHostingSessionId(activeServerId())}>
              {(sid) => (
                <HostShellRunner
                  serverId={activeServerId()!}
                  sessionId={sid()}
                  paused={coViewHostingPaused(activeServerId())}
                  onControllerReady={setCoViewHostController}
                  onSessionEnded={() => setCoViewHosting(activeServerId()!, null)}
                />
              )}
            </Show>
            {/* Co-View — viewer overlay mounts only when this user has joined
                a session on the active server. Top-right floating window. */}
            <Show when={activeServerId() && coViewViewingSessionId(activeServerId())}>
              {(sid) => (
                <ViewerSession
                  serverId={activeServerId()!}
                  sessionId={sid()}
                  initialSnapshot={coViewSnapshot()}
                  onLeft={() => {
                    setCoViewViewing(activeServerId()!, null);
                    setCoViewSnapshot(null);
                  }}
                />
              )}
            </Show>
            {/* Co-View — main sheet, opened from the sidebar via the
                co-view-events bus. State signals live here so HostShellRunner
                and the sheet share a single source of truth. */}
            <Show when={activeServerId()}>
              {(sid) => (
                <CoViewSheet
                  open={coViewSheetOpen()}
                  onOpenChange={setCoViewSheetOpen}
                  serverId={sid()}
                  hostingSessionId={coViewHostingSessionId(sid())}
                  hostingPaused={coViewHostingPaused(sid())}
                  viewingSessionId={coViewViewingSessionId(sid())}
                  onHostStarted={(id) => setCoViewHosting(sid(), id)}
                  onJoined={(id, snap) => {
                    setCoViewSnapshot(snap);
                    setCoViewViewing(sid(), id);
                  }}
                  onHostEnded={() => setCoViewHosting(sid(), null)}
                  onViewerLeft={() => {
                    setCoViewViewing(sid(), null);
                    setCoViewSnapshot(null);
                  }}
                  onHostPauseChange={(p) => setCoViewHostingPaused(sid(), p)}
                />
              )}
            </Show>
          </div>
          </CoViewHostProvider>
          {/* Cinematic backdrop — dark plate that fades in alongside the
              CRT shutdown so the collapsing workspace darkens behind a
              visible plate (rather than dissolving into the body color
              which is the same dark — making the close look like nothing
              happened). Persists through the install window, fades out
              alongside the bootup expand on Continue. See index.css for
              the timing + z-index rationale (sits at z-[150], above the
              workspace siblings, below PostUpdateOverlay at z-[200]). */}
          <div
            class="fixed inset-0 z-[150] bg-background cinematic-backdrop"
            data-cinematic={cinematicState()}
            aria-hidden="true"
          />
          {/* Full-bleed dark overlay shown to every connected user when the
              active server's runtime enters the irreversible install window
              ({installing, rolling-back}). Backup + download happen inline
              in the runtime panel — the overlay only takes over once the
              user clicks "Restart to apply update". Mounted as a SIBLING of
              the cinematic-shell wrapper so it stays visible during the
              cinematic close + open. See update-ux.md §4.8 + stores/cinematic.ts. */}
          <PostUpdateOverlay />
        </WorkspaceContext.Provider>
          </Show>
        </Show>
      </div>
    </div>
  );
}

type AppShellProps = {
  workspaceError: boolean;
  onDismissWorkspaceError: () => void;
  workspaces: Workspace[];
  activeId: string;
  activeServerId: string | null;
  activeLayout: PanelNode;
  focusedLeafId: string | null;
  canClose: boolean;
  getContent: (leafId: string) => PanelContent | undefined;
  onActivate: (id: string) => void;
  onAdd: () => void;
  onClose: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onSave: (id: string, name: string | null) => void;
  onUnsave: (id: string) => void;
  onSplit: (id: string, direction: "horizontal" | "vertical") => void;
  onTogglePanelFocus: (id: string) => void;
  onPanelClose: (id: string) => void;
  onUpdateRatio: (id: string, ratio: number) => void;
  onDrop: (leafId: string, content: PanelContent) => void;
  onUpdateContent: (leafId: string, content: PanelContent) => void;
  onDropSplit: (
    targetLeafId: string,
    content: PanelContent,
    direction: "horizontal" | "vertical",
    position: "before" | "after",
  ) => void;
  onMovePanel: (
    sourceId: string,
    targetId: string,
    zone: DropZone,
    sourceWorkspaceId: string,
  ) => void;
  onItemSelect: (item: SidebarItem) => void;
  onItemDrop: (item: SidebarItem, target: DropTarget) => void;
  onOpenWebApp: (app: WebApp) => void;
  onWebAppDrop: (app: WebApp, target: DropTarget) => void;
};

function NoServerWelcome() {
  return (
    <div class="flex flex-1 flex-col items-center justify-center gap-4 p-8 select-none">
      <div class="flex size-16 items-center justify-center rounded-2xl bg-muted/40">
        <img src="/uncorded-icon.png" alt="UnCorded" class="size-10 object-contain opacity-30" />
      </div>
      <div class="text-center">
        <p class="text-sm font-medium text-muted-foreground">No server selected</p>
        <p class="mt-1 text-xs text-muted-foreground/60">
          Choose a server from the sidebar to get started.
        </p>
      </div>
    </div>
  );
}

function AppShell(props: AppShellProps) {
  const hasServer = () => !!props.activeServerId;

  return (
    <SidebarProvider>
      <AppSidebar
        onItemSelect={props.onItemSelect}
        onItemDrop={props.onItemDrop}
        onOpenWebApp={props.onOpenWebApp}
        onWebAppDrop={props.onWebAppDrop}
      />
      <SidebarInset>
        <ToastViewport />
        <TooltipHoverLayer />
        <Show when={props.workspaceError}>
          <div class="flex items-center justify-between gap-2 bg-destructive/10 border-b border-destructive/20 px-4 py-2 text-sm text-destructive">
            <span>Failed to load saved workspace layout.</span>
            <button
              class="ml-auto shrink-0 rounded px-2 py-0.5 text-xs font-medium hover:bg-destructive/20"
              onClick={props.onDismissWorkspaceError}
            >
              Dismiss
            </button>
          </div>
        </Show>
        {/* Tab bar — only shown when a server is active */}
        <header class="flex h-12 shrink-0 items-stretch border-b transition-[width] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12">
          <div class="flex items-center gap-2 px-2 shrink-0">
            <SidebarTrigger class="-ml-1" />
            <Separator orientation="vertical" class="data-[orientation=vertical]:h-4" />
          </div>
          <Show when={hasServer()}>
            <WorkspaceTabs
              workspaces={props.workspaces}
              activeId={props.activeId}
              onActivate={props.onActivate}
              onAdd={props.onAdd}
              onClose={props.onClose}
              onRename={props.onRename}
              onSave={props.onSave}
              onUnsave={props.onUnsave}
            />
          </Show>
        </header>

        {/* Temp-URL warning strip (WS4) — shown while the active server is on a
            demo tunnel. Reads activeServer().tunnel_state internally; renders
            nothing when there's no server or the tunnel isn't a demo one. */}
        <TunnelStateBanner />

        {/* Panel workspace or welcome state */}
        <Show
          when={hasServer()}
          fallback={<NoServerWelcome />}
        >
          {/* Expired-tunnel gate (WS4). When the demo tunnel hit its 24h TTL
              the public URL is dead, so block the workspace entirely and tell
              the user to restart the desktop app. Detect via tunnel_state only,
              never by hostname. Composes with WS1: with the workspace
              unmounted, no plugin iframe loads a dead src. */}
          <Show
            when={activeServer()?.tunnel_state !== "expired"}
            fallback={<TunnelExpiredGate />}
          >
            <div class="flex flex-1 min-h-0 overflow-hidden">
              <PanelLayout
                node={props.activeLayout}
                focusedLeafId={props.focusedLeafId}
                canClose={props.canClose}
                onSplit={props.onSplit}
                onToggleFocus={props.onTogglePanelFocus}
                onClose={props.onPanelClose}
                onUpdateRatio={props.onUpdateRatio}
                getContent={props.getContent}
                onDrop={props.onDrop}
                onUpdateContent={props.onUpdateContent}
                onDropSplit={props.onDropSplit}
                onMovePanel={props.onMovePanel}
              />
            </div>
          </Show>
        </Show>
      </SidebarInset>
    </SidebarProvider>
  );
}

export default App;
