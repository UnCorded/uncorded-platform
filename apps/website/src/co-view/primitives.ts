// Shared instrumentation helpers for auto-instrumented primitives (spec-27
// PR-CV3 §Auto-Instrumented Primitives).
//
// Each helper subscribes reactively to `useCoViewHost()` so its publish/
// subscribe lifecycle re-establishes when the host controller appears
// (PR-CV5 mount path) and tears down when it disappears. Cost-when-idle is
// still ~0: a single createEffect that early-returns until `host()` is non-null.
//
// Helpers DO NOT capture or broadcast plugin-fetched record data. They emit
// chrome metadata (modal title, popover label, anchor id) which is the
// documented leak surface (spec §Threat Model: "Plugin authors who render
// secrets in chrome the SDK observes"). Plugin authors mark sensitive chrome
// with `data-uc-coview="hide"` and the producer broadcasts `redacted: true`
// instead of the text.
//
// Mount helpers (CoViewModalMount / CoViewPopoverMount / CoViewContextMenuMount)
// wrap the corresponding `useCoView*` hook in a no-render component. Callers
// place them INSIDE the Kobalte Portal so the primitive only runs while the
// dialog/popover/context-menu is actually open — otherwise the component body
// of SheetContent/DialogContent/etc. fires the hook unconditionally and the
// viewer sees a phantom modal per defined-but-closed dialog in the app.

import { createEffect, onCleanup, type JSX } from "solid-js";
import { useCoViewHost } from "./host-context";
import type {
  CoViewContextMenuEntry,
  CoViewInputShadow,
  CoViewModalEntry,
  CoViewPopoverEntry,
} from "./state-schema";

let nextOverlayId = 1;
function makeOverlayId(prefix: string): string {
  return `${prefix}-${nextOverlayId++}`;
}

/** Coalesce input/scroll/etc. updates to a trailing-edge tick. */
function makeCoalescer(intervalMs: number, run: () => void): () => void {
  let pending = false;
  let last = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return () => {
    pending = true;
    const now = Date.now();
    const elapsed = now - last;
    if (elapsed >= intervalMs && timer === undefined) {
      pending = false;
      last = now;
      run();
      return;
    }
    if (timer === undefined) {
      timer = setTimeout(() => {
        timer = undefined;
        if (!pending) return;
        pending = false;
        last = Date.now();
        run();
      }, Math.max(0, intervalMs - elapsed));
    }
  };
}

/**
 * Walk a node + its descendants for `data-uc-coview="hide"` (or
 * `data-uc-coview-secrets` on a form ancestor). Returns true if any match.
 * Cheap — only called on mount/open, not on every render.
 */
export function hasHideMarker(root: Element | null): boolean {
  if (!root) return false;
  if (root.matches('[data-uc-coview="hide"]')) return true;
  if (root.matches("[data-uc-coview-secrets]")) return true;
  if (root.querySelector('[data-uc-coview="hide"]')) return true;
  if (root.querySelector("[data-uc-coview-secrets]")) return true;
  return false;
}

/** Best-effort: read the title text via aria-labelledby. */
export function readAriaTitle(root: Element | null): string | undefined {
  if (!root) return undefined;
  const labelId = root.getAttribute("aria-labelledby");
  if (!labelId) return undefined;
  const label = root.ownerDocument?.getElementById(labelId);
  const text = label?.textContent?.trim();
  return text && text.length > 0 ? text : undefined;
}

/**
 * Auto-instrument a modal. Pass a `getEl` accessor that returns the rendered
 * content root (so the hook can scan for redaction markers and
 * aria-labelledby). The hook emits nav.modal_open on mount and
 * nav.modal_close on unmount, and mirrors the modal entry into shell-state.
 *
 * `idOverride` lets callers stamp a stable id per modal instance; otherwise
 * a fresh per-mount id is allocated.
 */
export function useCoViewModal(opts: {
  getEl: () => HTMLElement | null;
  title?: () => string | undefined;
  idOverride?: string;
}): void {
  const hostAccessor = useCoViewHost();
  const id = opts.idOverride ?? makeOverlayId("modal");

  createEffect(() => {
    const host = hostAccessor();
    if (!host) return;

    queueMicrotask(() => {
      const el = opts.getEl();
      const redacted = hasHideMarker(el);
      const explicitTitle = opts.title?.();
      const title = redacted
        ? undefined
        : (explicitTitle ?? readAriaTitle(el));
      const entry: CoViewModalEntry = title === undefined
        ? { id, redacted }
        : { id, title, redacted };
      host.upsertModal(entry);
      host.emitEvent("nav.modal_open", { modal_id: id, redacted }, "unsafe");
    });

    onCleanup(() => {
      host.removeModal(id);
      host.emitEvent("nav.modal_close", { modal_id: id }, "unsafe");
    });
  });
}

export function useCoViewPopover(opts: {
  getEl: () => HTMLElement | null;
  anchorId?: () => string | undefined;
  label?: () => string | undefined;
  idOverride?: string;
}): void {
  const hostAccessor = useCoViewHost();
  const id = opts.idOverride ?? makeOverlayId("popover");

  createEffect(() => {
    const host = hostAccessor();
    if (!host) return;

    queueMicrotask(() => {
      const el = opts.getEl();
      const redacted = hasHideMarker(el);
      const label = redacted ? undefined : opts.label?.();
      const anchorId = opts.anchorId?.();
      const entry: CoViewPopoverEntry = { id, redacted };
      if (anchorId !== undefined) entry.anchorId = anchorId;
      if (label !== undefined) entry.label = label;
      host.upsertPopover(entry);
      const payload: Record<string, unknown> = { popover_id: id, redacted };
      if (anchorId !== undefined) payload["anchor_id"] = anchorId;
      host.emitEvent("nav.popover_open", payload, "unsafe");
    });

    onCleanup(() => {
      host.removePopover(id);
      host.emitEvent("nav.popover_close", { popover_id: id }, "unsafe");
    });
  });
}

/**
 * Auto-instrument an input/textarea/contenteditable. Caret + valueRedacted
 * are always broadcast; the raw value is only included when `shareValue` is
 * true OR the DOM has `data-uc-coview="value-shared"` (fail-closed default
 * per spec §Privacy & Redaction Model).
 */
export function useCoViewInput(opts: {
  getEl: () => HTMLInputElement | HTMLTextAreaElement | HTMLElement | null;
  /** Stable id; defaults to a per-mount allocation. */
  idOverride?: string;
  /** Producer opts in to broadcasting raw value. Default false. */
  shareValue?: () => boolean;
}): void {
  const hostAccessor = useCoViewHost();
  const id = opts.idOverride ?? makeOverlayId("input");

  createEffect(() => {
    const host = hostAccessor();
    if (!host) return;

    function readShadow(): CoViewInputShadow | null {
      const el = opts.getEl();
      if (!el) return null;

      // Element-level marker overrides the prop (data-uc-coview="hide" or
      // ancestor data-uc-coview-secrets fully suppresses the entry).
      if (
        el.matches?.('[data-uc-coview="hide"]') ||
        el.closest?.("[data-uc-coview-secrets]")
      ) {
        return null;
      }

      const elementMarkedShared = el.matches?.('[data-uc-coview="value-shared"]');
      const elementMarkedHidden = el.matches?.('[data-uc-coview="value-hidden"]');
      const propShare = opts.shareValue?.() ?? false;
      const share = !elementMarkedHidden && (propShare || !!elementMarkedShared);

      let caret = 0;
      let value = "";
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        caret = el.selectionStart ?? el.value.length;
        value = el.value;
      } else if ("isContentEditable" in el && el.isContentEditable) {
        const sel = el.ownerDocument?.getSelection();
        caret = sel?.focusOffset ?? 0;
        value = el.textContent ?? "";
      }

      const shadow: CoViewInputShadow = { caret, valueRedacted: !share };
      if (share) shadow.value = value;
      return shadow;
    }

    function publish(): void {
      host!.setInput(id, readShadow());
    }

    const coalesced = makeCoalescer(50, publish);

    queueMicrotask(publish);
    const el = opts.getEl();
    const handler = () => coalesced();
    if (el) {
      el.addEventListener("input", handler);
      el.addEventListener("keyup", handler);
      el.addEventListener("click", handler);
      el.addEventListener("focus", handler);
    }

    onCleanup(() => {
      if (el) {
        el.removeEventListener("input", handler);
        el.removeEventListener("keyup", handler);
        el.removeEventListener("click", handler);
        el.removeEventListener("focus", handler);
      }
      host.setInput(id, null);
    });
  });
}

/**
 * Auto-instrument a tabs control. Pass an `activeId` accessor; the hook
 * publishes state.tabs[id] on every mount + change. Replay-safe.
 */
export function useCoViewTabs(opts: {
  controlId?: string;
  activeId: () => string | undefined;
}): void {
  const hostAccessor = useCoViewHost();
  const id = opts.controlId ?? makeOverlayId("tabs");

  createEffect(() => {
    const host = hostAccessor();
    if (!host) return;

    let last: string | undefined;
    function publish(): void {
      const v = opts.activeId();
      if (v === last) return;
      last = v;
      host!.setTab(id, v ?? null);
    }

    queueMicrotask(publish);
    const interval = setInterval(publish, 100);

    onCleanup(() => {
      clearInterval(interval);
      host.setTab(id, null);
    });
  });
}

/**
 * Auto-instrument a scroll container. Coalesced at 50ms per spec §Bounds.
 */
export function useCoViewScroll(opts: {
  getEl: () => HTMLElement | null;
  idOverride?: string;
}): void {
  const hostAccessor = useCoViewHost();
  const id = opts.idOverride ?? makeOverlayId("scroll");

  createEffect(() => {
    const host = hostAccessor();
    if (!host) return;

    function publish(): void {
      const el = opts.getEl();
      if (!el) return;
      host!.setScroll(id, el.scrollTop, el.scrollLeft);
    }
    const coalesced = makeCoalescer(50, publish);

    queueMicrotask(publish);
    const el = opts.getEl();
    const handler = () => coalesced();
    if (el) el.addEventListener("scroll", handler, { passive: true });

    onCleanup(() => {
      if (el) el.removeEventListener("scroll", handler);
      host.setScroll(id, 0, 0);
    });
  });
}

export function useCoViewContextMenu(opts: {
  getEl: () => HTMLElement | null;
  anchorId?: () => string | undefined;
  position?: () => { x: number; y: number } | undefined;
  idOverride?: string;
}): void {
  const hostAccessor = useCoViewHost();
  const id = opts.idOverride ?? makeOverlayId("ctx-menu");

  createEffect(() => {
    const host = hostAccessor();
    if (!host) return;

    queueMicrotask(() => {
      const anchorId = opts.anchorId?.();
      const pos = opts.position?.();
      const entry: CoViewContextMenuEntry = { id };
      if (anchorId !== undefined) entry.anchorId = anchorId;
      if (pos !== undefined) {
        entry.x = pos.x;
        entry.y = pos.y;
      }
      host.upsertContextMenu(entry);
      const payload: Record<string, unknown> = { context_menu_id: id };
      if (anchorId !== undefined) payload["anchor_id"] = anchorId;
      if (pos !== undefined) {
        payload["x"] = pos.x;
        payload["y"] = pos.y;
      }
      host.emitEvent("nav.context_menu_open", payload, "unsafe");
    });

    onCleanup(() => {
      host.removeContextMenu(id);
      host.emitEvent("nav.context_menu_close", { context_menu_id: id }, "unsafe");
    });
  });
}

// ---------------------------------------------------------------------------
// Mount-scoped wrappers
//
// Kobalte's Dialog/DropdownMenu/ContextMenu render their `Content` component
// body unconditionally; only the portaled DOM is gated on `open`. Calling
// useCoView* at the top of those wrappers therefore upserts a modal/popover
// the moment the wrapper component mounts (i.e., when the surrounding JSX
// renders), regardless of whether the user has opened it. The viewer then
// sees a phantom stack of every defined-but-closed dialog in the app.
//
// These no-render components push the hook call DOWN into a child slot that
// only mounts when the Portal actually renders its children (open=true).
// Cleanup fires on close because the helper component unmounts, which
// disposes its createEffect.
// ---------------------------------------------------------------------------

export function CoViewModalMount(props: {
  getEl: () => HTMLElement | null;
  title?: () => string | undefined;
  idOverride?: string;
}): JSX.Element {
  const opts: Parameters<typeof useCoViewModal>[0] = { getEl: props.getEl };
  if (props.title !== undefined) opts.title = props.title;
  if (props.idOverride !== undefined) opts.idOverride = props.idOverride;
  useCoViewModal(opts);
  return null;
}

export function CoViewPopoverMount(props: {
  getEl: () => HTMLElement | null;
  anchorId?: () => string | undefined;
  label?: () => string | undefined;
  idOverride?: string;
}): JSX.Element {
  const opts: Parameters<typeof useCoViewPopover>[0] = { getEl: props.getEl };
  if (props.anchorId !== undefined) opts.anchorId = props.anchorId;
  if (props.label !== undefined) opts.label = props.label;
  if (props.idOverride !== undefined) opts.idOverride = props.idOverride;
  useCoViewPopover(opts);
  return null;
}

export function CoViewContextMenuMount(props: {
  getEl: () => HTMLElement | null;
  anchorId?: () => string | undefined;
  position?: () => { x: number; y: number } | undefined;
  idOverride?: string;
}): JSX.Element {
  const opts: Parameters<typeof useCoViewContextMenu>[0] = { getEl: props.getEl };
  if (props.anchorId !== undefined) opts.anchorId = props.anchorId;
  if (props.position !== undefined) opts.position = props.position;
  if (props.idOverride !== undefined) opts.idOverride = props.idOverride;
  useCoViewContextMenu(opts);
  return null;
}
