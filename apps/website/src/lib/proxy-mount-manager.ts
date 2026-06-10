// Proxy-mount manager — shell-side registry of host-owned reverse-proxy mount
// surfaces, the proxy analogue of the voice screen-slot registry in
// voice-manager.ts.
//
// A reverse-proxy plugin iframe calls `sdk.proxy.reserveMount(mount, el)`, which
// reports the placeholder's rect to the shell via `platform.proxy.*-viewport`
// envelopes. PluginFrame (channel-view.tsx) routes those here, supplying the
// trusted identity (serverId, slug, frameKey, iframe) from its own closure —
// never from the untrusted payload — plus the validated mount name
// and rect. The proxy-mount overlay renders one host-owned surface (a dedicated
// Electron <webview> on desktop, a sandboxed <iframe> on web) per entry,
// positioned over the reported rect.
//
// Entry objects are STABLE for the life of a reservation: `<For>` keys by
// reference, so a stable entry → a stable surface component → no webview reload.
// Rect updates mutate `entry.rect` IN PLACE and do NOT republish the signal —
// the overlay re-reads `entry.rect` every rAF frame (its layoutTick), so the
// surface repositions without churning the array and risking a remount. The
// signal publishes only when a mount is added or removed.

import { createSignal, type Accessor } from "solid-js";

export interface ViewportRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ProxyMountEntry {
  /** Owning plugin iframe's portal key (`${activeId}:${panelId}:${surfaceKey}`). */
  frameKey: string;
  /** Stable iframe element — immune to portal-host rekey; used for rect anchoring. */
  iframe: HTMLIFrameElement;
  serverId: string;
  slug: string;
  mountName: string;
  /** Iframe-local rect reported by the plugin; mutated in place on update. */
  rect: ViewportRect;
}

const mounts = new Map<string, ProxyMountEntry>();
function mountKey(frameKey: string, mountName: string): string {
  return `${frameKey}::${mountName}`;
}

const [mountsSignal, setMountsSignal] = createSignal<ReadonlyArray<ProxyMountEntry>>([]);
/** Reactive accessor for the active proxy-mount surfaces (read by the overlay). */
export const proxyMounts$: Accessor<ReadonlyArray<ProxyMountEntry>> = mountsSignal;
function publish(): void {
  setMountsSignal(Array.from(mounts.values()));
}

// Validate the mount name from an untrusted iframe payload. Mirrors the manifest
// proxy-mount name rule (starts with a letter; lowercase alnum + single hyphens,
// no leading/trailing/doubled hyphens) so a spoofed envelope can't smuggle a
// path-traversal or a surface-key-breaking value.
const MOUNT_NAME_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export function parseMountName(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 128) return null;
  return MOUNT_NAME_RE.test(raw) ? raw : null;
}

export function parseViewportRect(raw: unknown): ViewportRect | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const { x, y, width, height } = r as { x: unknown; y: unknown; width: unknown; height: unknown };
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof width !== "number" ||
    typeof height !== "number" ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width < 0 ||
    height < 0
  ) {
    return null;
  }
  return { x, y, width, height };
}

export function register(input: {
  frameKey: string;
  iframe: HTMLIFrameElement;
  serverId: string;
  slug: string;
  mountName: string;
  rect: ViewportRect;
}): void {
  const key = mountKey(input.frameKey, input.mountName);
  const existing = mounts.get(key);
  if (existing) {
    // Re-register for an already-tracked mount (the plugin re-reserved without
    // an intervening unregister). Update the rect in place so the existing
    // surface keeps its identity — no webview reload — and skip the publish.
    existing.rect = input.rect;
    return;
  }
  mounts.set(key, { ...input });
  publish();
}

export function update(input: { frameKey: string; mountName: string; rect: ViewportRect }): void {
  const existing = mounts.get(mountKey(input.frameKey, input.mountName));
  if (!existing) return;
  // In-place mutation — see the file header: the overlay re-reads entry.rect on
  // its rAF layoutTick, so no publish (and no <For> churn / remount risk).
  existing.rect = input.rect;
}

export function unregister(input: { frameKey: string; mountName: string }): void {
  if (mounts.delete(mountKey(input.frameKey, input.mountName))) publish();
}

// Sweep all mounts owned by a frame — called when its iframe unmounts
// (channel-view.tsx onDestroy), next to the voice screen-slot sweep.
export function unregisterForFrame(frameKey: string): void {
  let dirty = false;
  for (const key of Array.from(mounts.keys())) {
    const entry = mounts.get(key);
    if (entry && entry.frameKey === frameKey) {
      mounts.delete(key);
      dirty = true;
    }
  }
  if (dirty) publish();
}

/** Test-only: clear all state between cases. */
export function _resetForTest(): void {
  mounts.clear();
  publish();
}
