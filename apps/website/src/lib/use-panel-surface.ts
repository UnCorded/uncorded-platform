// usePanelSurface — generic SolidJS helper that lets any panel content type
// portal a stable DOM surface (iframe, webview, future media or whiteboard
// surfaces) into the workspace's top-level <PortalContainer />.
//
// Why this exists:
//   The panel tree restructures constantly (split, resize, drag rearrange,
//   focus collapse, workspace switch). Re-parenting an iframe/webview/canvas
//   triggers a navigation reset or destroys GPU state. The portal-host pattern
//   solves it by parking surface elements at a single DOM root and positioning
//   them absolutely over their in-tree placeholders. BrowserPanel and
//   PluginFrame both wired this up by hand, with subtle differences in
//   ordering and adoption semantics — and edge cases in maximize/extreme
//   rearrange paths leaked. This helper consolidates the contract so every
//   future panel type gets identical, audited survival behavior.
//
// Lifecycle (mirrors portal-host's hide-by-default policy):
//   1. Component mounts → placeholderRef fires with the in-tree div →
//      computeAndSync derives the mountKey
//      (`${workspaceId}:${panelId}:${surfaceKey}`) and either:
//        - **Adopts** an existing surface for that key (portalHost.hasMount
//          is true): retrieves the element + handle, calls onAdopt(handle),
//          re-mounts with the new placeholder. NO `create` call.
//          Subscriptions stay live because they're tied to the surface, not
//          the component.
//        - **Creates** fresh: calls `create()` to build the surface element
//          and a caller-defined handle (runtime, controller, cipher, etc.).
//          Registers the mount with portal-host, including an `onDestroy`
//          callback that runs at real teardown.
//   2. Component unmounts (panel split, drag mid-flight, focus toggle,
//      workspace switch) → portalHost.unmount: refcount drops, element is
//      hidden but kept alive. The handle stays in the registry. State
//      subscriptions inside the handle keep updating.
//   3. Real teardown is driven by App.tsx's reconcile diff — when a panel is
//      closed, replaced, or the workspace destroyed, App calls
//      portalHost.destroyByKey/destroyByWorkspace. That fires our onDestroy,
//      which removes the handle from the registry and invokes the caller's
//      `destroy(handle)` so they can dispose runtimes, ciphers, and listeners
//      exactly once.
//   4. Surface-key changes within the same component (rare — e.g. panel
//      content swapped via dropToPanel): the createEffect re-fires; the prior
//      key is unmounted (refcount-only). App.tsx separately calls destroyByKey
//      on the prior key as part of the same content swap, which runs the
//      caller's destroy(). No teardown happens here on key change so we
//      don't double-fire.
//
// Testability: the helper is driven by direct calls to `placeholderRef` and
// the option accessors. createEffect is only used to re-trigger sync when
// reactive deps change. Bun tests can exercise the full lifecycle by calling
// placeholderRef directly without a Solid runtime.

import { createEffect, onCleanup } from "solid-js";
import type { PanelContent } from "@uncorded/protocol";
import * as portalHost from "@/lib/portal-host";
import { surfaceKeyOf } from "@/lib/surface-key";

export interface PanelSurfaceOptions<Handle> {
  /**
   * Reactive accessor for the active workspace id. Callers in the panel tree
   * typically wire this to `useWorkspaceContext().activeId` — passing the
   * accessor directly (rather than reading context here) keeps the helper
   * testable without a Solid runtime + JSX harness.
   */
  workspaceId: () => string;
  panelId: string;
  /**
   * Reactive accessor for the panel's content. Surface-key is recomputed
   * via surfaceKeyOf() whenever this changes; identity-preserving updates
   * (e.g. a plugin item label change that doesn't affect surfaceKey) are
   * no-ops here.
   */
  content: () => PanelContent;
  /**
   * Build the surface element + caller-defined handle. Called exactly once
   * per surface lifetime — across panel splits, focus toggles, and workspace
   * switches the same element + handle are re-adopted, never recreated.
   * The handle is stored in a module-level registry until destroy() runs.
   */
  create: () => { element: HTMLElement; handle: Handle };
  /**
   * Real teardown — runs at portal-host destroyByKey/destroyByWorkspace time,
   * not on every component unmount. Dispose runtime controllers, ciphers,
   * WS subscriptions, etc. here. Always paired with exactly one prior
   * create() call; never invoked twice for the same handle.
   */
  destroy: (handle: Handle) => void;
  /**
   * Post-attach hook — element is in the portal DOM at first mount only.
   * Useful for assigning iframe.src after the parent is set, or for late
   * subscriptions that need a live element. Not called on adoption.
   */
  onAttached?: (handle: Handle) => void;
  /**
   * Adoption hook — fires every time a fresh component instance picks up an
   * existing surface (panel split, focus toggle return, workspace re-entry).
   * Use it to re-bind component-scoped UI state (signals, overlays) to the
   * surface's persistent state without rebuilding the surface itself.
   */
  onAdopt?: (handle: Handle) => void;
}

export interface PanelSurfaceResult<Handle> {
  /** Attach to the placeholder div: `<div ref={placeholderRef} />`. */
  placeholderRef: (el: HTMLDivElement) => void;
  /**
   * The current handle, or null before first mount / between key changes.
   * Plain accessor — read it any time, including from createMemo, but it
   * does not produce reactive updates on its own.
   */
  handle: () => Handle | null;
}

// Module-level handle registry. Outlives component instances so adoption
// recovers the runtime + subscriptions tied to the surface. Cleared by the
// onDestroy callback registered with portal-host at create time.
const handles = new Map<string, unknown>();

export function usePanelSurface<Handle>(
  opts: PanelSurfaceOptions<Handle>,
): PanelSurfaceResult<Handle> {
  let placeholder: HTMLDivElement | null = null;
  let lastMountKey: string | null = null;
  let lastPlaceholder: HTMLDivElement | null = null;
  let currentHandle: Handle | null = null;
  let cleanedUp = false;

  function syncMount(): void {
    if (cleanedUp) return;
    if (placeholder === null) return;

    const wsId = opts.workspaceId();
    const key = `${wsId}:${opts.panelId}:${surfaceKeyOf(opts.content())}`;

    // Same key + same placeholder → no-op. Same key + different placeholder
    // (e.g. a `<Show>` collapsed and re-expanded inside the panel without
    // changing surface identity): rebind the portal mount to the new
    // placeholder so its ResizeObserver tracks live geometry instead of a
    // detached node.
    if (lastMountKey === key) {
      if (lastPlaceholder !== placeholder) {
        portalHost.updatePlaceholder(key, placeholder);
        lastPlaceholder = placeholder;
      }
      return;
    }

    if (lastMountKey !== null) portalHost.unmount(lastMountKey);

    const isAdoption = portalHost.hasMount(key);
    let element: HTMLElement;
    let h: Handle;
    if (isAdoption) {
      // Adoption invariants: portal-host has the element, and our registry
      // holds the matching handle (registered when the surface was created).
      // Both being absent would mean a foreign mount-key collision — fail
      // loudly rather than silently rebuild and lose subscriptions.
      const adopted = portalHost.getMountElement(key);
      const stored = handles.get(key);
      if (adopted === null || stored === undefined) {
        throw new Error(
          `[usePanelSurface] adoption failed for key '${key}': element=${adopted !== null} handle=${stored !== undefined}`,
        );
      }
      element = adopted;
      h = stored as Handle;
      opts.onAdopt?.(h);
    } else {
      const created = opts.create();
      element = created.element;
      h = created.handle;
      handles.set(key, h);
    }

    portalHost.mount({
      key,
      workspaceId: wsId,
      placeholder,
      element,
      ...(isAdoption
        ? {}
        : {
            onAttached: () => opts.onAttached?.(h),
            onDestroy: () => {
              const stored = handles.get(key);
              handles.delete(key);
              if (stored !== undefined) opts.destroy(stored as Handle);
            },
          }),
    });

    lastMountKey = key;
    lastPlaceholder = placeholder;
    currentHandle = h;
  }

  const placeholderRef = (el: HTMLDivElement) => {
    placeholder = el;
    syncMount();
  };

  // Re-trigger sync when reactive deps change. Reading workspaceId() and
  // content() inside an effect subscribes to them; placeholder is a plain
  // variable so this effect won't re-fire when the placeholder is assigned —
  // that path is driven by placeholderRef calling syncMount directly.
  createEffect(() => {
    opts.workspaceId();
    opts.content();
    syncMount();
  });

  onCleanup(() => {
    cleanedUp = true;
    if (lastMountKey !== null) {
      portalHost.unmount(lastMountKey);
      lastMountKey = null;
    }
    lastPlaceholder = null;
    currentHandle = null;
  });

  return { placeholderRef, handle: () => currentHandle };
}

/** @internal — for tests to clear the cross-test handle registry. */
export function _resetForTests(): void {
  handles.clear();
}
