// Co-View host context (spec-27 PR-CV3).
//
// Bridges auto-instrumented primitives to the active host producer. When no
// host session is active, every consumer hook is a cheap no-op — there is no
// allocation per primitive mount, no microtask, no broadcast. The producer
// is only attached when the user actually starts hosting (PR-CV5 wires the
// real start-session flow; PR-CV3 mounts it under a dev URL flag in App.tsx).
//
// The context value is a tiny façade rather than the full producer so we
// don't leak private surface (snapshot ring buffer, sequence numbers) into
// random component code. Primitives publish events and bump state; the
// producer alone owns the wire.
//
// State shape mutation lives in this module too — primitives push their bit
// of shell-state into a host-owned mutable record, and the producer's
// `getShellState` reads it on each notify. Solid signals would also work
// but the producer's coalesce is microtask-grained: we don't need fine-grained
// reactivity, only "current value at flush time".

import {
  createContext,
  createMemo,
  useContext,
  type JSX,
  type ParentProps,
} from "solid-js";

import type {
  CoViewContextMenuEntry,
  CoViewInputShadow,
  CoViewModalEntry,
  CoViewPanelMeta,
  CoViewPopoverEntry,
  CoViewRoute,
  CoViewShellState,
  CoViewWorkspaceLayouts,
} from "./state-schema";

export type CoViewEventEmitter = (
  kind:
    | "nav.route_change"
    | "nav.panel_open"
    | "nav.panel_close"
    | "nav.modal_open"
    | "nav.modal_close"
    | "nav.popover_open"
    | "nav.popover_close"
    | "nav.context_menu_open"
    | "nav.context_menu_close"
    | "host.action_observed",
  payload: Record<string, unknown>,
  replay?: "safe" | "unsafe",
) => void;

/**
 * The shell-state mutator used by instrumented primitives. Each method patches
 * the host's mutable shell-state and calls notify() to schedule a coalesced
 * diff frame.
 */
export interface CoViewHostController {
  setRoute: (route: CoViewRoute) => void;
  setWorkspace: (workspace: CoViewWorkspaceLayouts) => void;
  setPanelMeta: (panelId: string, meta: CoViewPanelMeta | null) => void;

  upsertModal: (entry: CoViewModalEntry) => void;
  removeModal: (id: string) => void;

  upsertPopover: (entry: CoViewPopoverEntry) => void;
  removePopover: (id: string) => void;

  upsertContextMenu: (entry: CoViewContextMenuEntry) => void;
  removeContextMenu: (id: string) => void;

  setTab: (controlId: string, activeId: string | null) => void;
  setScroll: (id: string, top: number, left: number) => void;
  setInput: (id: string, shadow: CoViewInputShadow | null) => void;

  /**
   * Returns true if at least one popover or context menu is currently open.
   * The cursor producer reads this to escape DOM scanning when classifying
   * pointer state — `menu-open` takes priority over `typing`/`hover` because
   * it describes an active committed UI interaction. Modals are *not*
   * included; they own the surface entirely and a hover-over-modal is
   * normal pointer activity, not a menu.
   */
  isMenuOpen: () => boolean;

  emitEvent: CoViewEventEmitter;
}

// Context value is an *accessor*, not the controller directly, so consumers
// inside reactive scopes (createEffect, createMemo) re-run when the host
// controller comes/goes. A plain controller value would be captured at
// component-mount time — useless because primitives mount BEFORE the host
// session starts, and `useContext` doesn't re-track on Provider value change.
const CoViewHostContext = createContext<() => CoViewHostController | null>(() => null);

/** Provider — wrap the live host shell with a real controller from PR-CV5. */
export function CoViewHostProvider(
  props: ParentProps<{ controller: CoViewHostController | null }>,
): JSX.Element {
  return (
    <CoViewHostContext.Provider value={() => props.controller}>
      {props.children}
    </CoViewHostContext.Provider>
  );
}

/**
 * Read-only "am I hosting" check primitives use to skip work entirely when
 * no session is active. Returns false outside a CoViewHostProvider.
 */
export function useIsCoViewHosting(): () => boolean {
  const ctx = useContext(CoViewHostContext);
  return createMemo(() => ctx() !== null);
}

/**
 * Accessor for the active host controller (or `null` when no session is
 * active). Primitives MUST call this *inside* a reactive scope (e.g.
 * `createEffect`) so they re-run when the controller appears or disappears.
 * Reading it once at function-body scope captures the snapshot value at mount
 * time and misses every later update — the bug that left viewers stuck on
 * "Waiting for host state…" pre-fix.
 */
export function useCoViewHost(): () => CoViewHostController | null {
  return useContext(CoViewHostContext);
}

/**
 * Build a controller backed by a mutable shell-state record. Returns the
 * controller plus a `getShellState` accessor the producer reads on each
 * notify(). The `notify` callback is invoked after every mutation so the
 * producer can coalesce.
 */
export function createCoViewHostController(opts: {
  notify: () => void;
  emitEvent: CoViewEventEmitter;
}): { controller: CoViewHostController; getShellState: () => CoViewShellState } {
  const state: CoViewShellState = {};

  function bump(): void {
    opts.notify();
  }

  function ensureModals(): CoViewModalEntry[] {
    if (!state.modals) state.modals = [];
    return state.modals;
  }
  function ensurePopovers(): CoViewPopoverEntry[] {
    if (!state.popovers) state.popovers = [];
    return state.popovers;
  }
  function ensureContextMenus(): CoViewContextMenuEntry[] {
    if (!state.contextMenus) state.contextMenus = [];
    return state.contextMenus;
  }

  const controller: CoViewHostController = {
    setRoute(route) {
      state.route = { ...route };
      bump();
    },
    setWorkspace(workspace) {
      state.workspace = {
        activeId: workspace.activeId,
        layouts: { ...workspace.layouts },
      };
      bump();
    },
    setPanelMeta(panelId, meta) {
      if (!state.panelMeta) state.panelMeta = {};
      if (meta === null) {
        delete state.panelMeta[panelId];
      } else {
        state.panelMeta[panelId] = { ...meta };
      }
      if (Object.keys(state.panelMeta).length === 0) delete state.panelMeta;
      bump();
    },
    upsertModal(entry) {
      const list = ensureModals();
      const idx = list.findIndex((m) => m.id === entry.id);
      if (idx >= 0) {
        list[idx] = { ...entry };
      } else {
        list.push({ ...entry });
      }
      bump();
    },
    removeModal(id) {
      if (!state.modals) return;
      const next = state.modals.filter((m) => m.id !== id);
      if (next.length === state.modals.length) return;
      if (next.length === 0) delete state.modals;
      else state.modals = next;
      bump();
    },
    upsertPopover(entry) {
      const list = ensurePopovers();
      const idx = list.findIndex((m) => m.id === entry.id);
      if (idx >= 0) list[idx] = { ...entry };
      else list.push({ ...entry });
      bump();
    },
    removePopover(id) {
      if (!state.popovers) return;
      const next = state.popovers.filter((m) => m.id !== id);
      if (next.length === state.popovers.length) return;
      if (next.length === 0) delete state.popovers;
      else state.popovers = next;
      bump();
    },
    upsertContextMenu(entry) {
      const list = ensureContextMenus();
      const idx = list.findIndex((m) => m.id === entry.id);
      if (idx >= 0) list[idx] = { ...entry };
      else list.push({ ...entry });
      bump();
    },
    removeContextMenu(id) {
      if (!state.contextMenus) return;
      const next = state.contextMenus.filter((m) => m.id !== id);
      if (next.length === state.contextMenus.length) return;
      if (next.length === 0) delete state.contextMenus;
      else state.contextMenus = next;
      bump();
    },
    setTab(controlId, activeId) {
      if (!state.tabs) state.tabs = {};
      if (activeId === null) {
        delete state.tabs[controlId];
      } else {
        state.tabs[controlId] = { activeId };
      }
      if (Object.keys(state.tabs).length === 0) delete state.tabs;
      bump();
    },
    setScroll(id, top, left) {
      if (!state.scrolls) state.scrolls = {};
      const prev = state.scrolls[id];
      if (prev && prev.top === top && prev.left === left) return;
      state.scrolls[id] = { top, left };
      bump();
    },
    setInput(id, shadow) {
      if (!state.inputs) state.inputs = {};
      if (shadow === null) {
        delete state.inputs[id];
      } else {
        state.inputs[id] = { ...shadow };
      }
      if (Object.keys(state.inputs).length === 0) delete state.inputs;
      bump();
    },
    isMenuOpen() {
      return (
        (state.popovers?.length ?? 0) > 0 ||
        (state.contextMenus?.length ?? 0) > 0
      );
    },
    emitEvent: opts.emitEvent,
  };

  return { controller, getShellState: () => state };
}
