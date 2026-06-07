// PluginFrame — registers a plugin iframe with the portal host so panel
// re-parents (drag, resize, focus toggle, workspace switch) do not
// navigation-reset the iframe.
//
// Lifecycle (matches portal-host's hide-by-default policy):
//   1. PluginFrame component-mounts. createPluginHandle(key) checks a
//      module-level `handles` map. First mount: build the iframe, register
//      the postMessage listener, WS subscription, and voice subscription —
//      all bound to the iframe's lifetime via portal-host onDestroy. Then
//      portalHost.mount with onAttached to set src.
//   2. Same-surfaceKey content changes (different itemId) → key memo
//      unchanged → navigate effect posts uncorded.navigate, no remount.
//   3. PluginFrame component-unmounts (focus collapse, workspace switch,
//      cross-workspace drag mid-flight, leaf rearrange) → portalHost.unmount
//      drops refcount and hides the iframe (display:none) but keeps it
//      alive. WS / voice subscriptions stay attached because they live on
//      the iframe lifetime, not the component lifetime — incoming messages
//      keep updating the hidden iframe's in-memory state so a return to it
//      shows current data without a reload or re-fetch.
//   4. PluginFrame component-remounts with same key → adoption: refcount++,
//      element shown again, no fresh subscription registration.
//   5. Surface key changes within the same component instance (overwrite
//      via dropToPanel) → destroyByKey on the old key fires onDestroy
//      (cleans up subscriptions, removes from `handles` map), then a new
//      handle is created.
//   6. App.tsx user-intent close points (handleClose, closeWorkspace,
//      onServerPurged, server change, applySync drop) call destroyByKey
//      / destroyByWorkspace / destroyAll. Each of those fires onDestroy
//      for the affected mount(s), which is the only path that actually
//      tears down subscriptions.
//
// The placeholder <div> inside the panel tree is what portal-host tracks
// for positioning — its getBoundingClientRect drives the iframe's absolute
// placement.

import { createEffect, createMemo, onCleanup } from "solid-js";
import type { PanelContent, ClientMessage } from "@uncorded/protocol";
import * as central from "@/api/central";
import * as ws from "@/lib/ws";
import { getToken } from "@/lib/tokens";
import { openUserCard } from "@/stores/user-card";
import { openFilePreview } from "@/stores/file-preview";
import { startFileDownload } from "@/stores/file-download";
import * as voiceManager from "@/lib/voice-manager";
import * as portalHost from "@/lib/portal-host";
import { emitPluginPanelFocus, emitPluginPanelOpen } from "@/lib/plugin-panel-events";
import { surfaceKeyOf } from "@/lib/surface-key";
import { useWorkspaceContext } from "@/lib/workspace-context";
import { awaitCapabilities, getPluginRuntimeCapabilities } from "@/stores/sidebar";

type PluginContent = Extract<PanelContent, { type: "plugin" }>;

interface Handle {
  key: string;
  iframe: HTMLIFrameElement;
  ready: boolean;
  // Last itemId we actually sent to the iframe via uncorded.navigate. The
  // navigate effect compares against this before posting, so panel rearrange
  // (which recreates PluginFrame and re-runs the effect with an unchanged
  // itemId) doesn't cause the plugin to re-fetch messages and burn its
  // per-plugin rate limit.
  lastSentItemId: string | null;
}

// Module-level handle registry — keyed by the iframe element (not the mount
// key) so that cross-workspace drag rekeys (portalHost.rekey changes the
// mount key while the iframe stays the same) don't lose the handle. The
// handle outlives PluginFrame components so adoption (after focus collapse,
// workspace switch, or panel rearrange) can recover the existing iframe +
// subscription state. WeakMap entries clear automatically when the iframe is
// garbage-collected, which happens after the onDestroy path detaches it.
const handlesByIframe = new WeakMap<HTMLIFrameElement, Handle>();

function boundedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxLength) return null;
  return trimmed;
}

function optionalBoundedString(value: unknown, maxLength: number): string | null | false {
  if (value === undefined || value === null) return null;
  return boundedString(value, maxLength) ?? false;
}

export function PluginFrame(props: { content: PluginContent; panelId: string }) {
  const { activeId } = useWorkspaceContext();
  let placeholder!: HTMLDivElement;
  let handle: Handle | null = null;

  const key = createMemo(() => `${activeId()}:${props.panelId}:${surfaceKeyOf(props.content)}`);

  // Mount effect: fires only when the key changes (surfaceKey or leaf/workspace
  // identity change). Same-surface, different-itemId changes do NOT fire this —
  // they're handled by the navigate effect below.
  createEffect(() => {
    const k = key();
    if (handle !== null) {
      if (handle.key === k) return;
      // Surface key changed within the same component instance: the old key
      // is unreachable from this PluginFrame (App.tsx's mutatePanelContents
      // diff also catches this on most paths, but destroying here too is
      // idempotent and keeps the local lifecycle correct even when a future
      // refactor bypasses mutatePanelContents).
      portalHost.destroyByKey(handle.key);
      handle = null;
    }
    handle = createPluginHandle(k, props.content, props.panelId, placeholder);
  });

  // Navigate effect: fires on itemId/itemLabel change while the mount persists.
  // Guarded by handle.lastSentItemId so a no-op rerun (panel rearrange recreates
  // PluginFrame with the same content) doesn't re-post navigate and force the
  // plugin to re-fetch messages.
  createEffect(() => {
    const itemId = props.content.itemId;
    const itemLabel = props.content.itemLabel;
    if (handle === null || !handle.ready) return;
    if (handle.lastSentItemId === itemId) return;
    handle.iframe.contentWindow?.postMessage(
      { type: "uncorded.navigate", itemId, itemLabel },
      "*",
    );
    handle.lastSentItemId = itemId;
  });

  onCleanup(() => {
    if (handle !== null) {
      // Hide-only: portalHost.unmount drops refcount and hides the iframe.
      // Subscriptions stay attached (bound to onDestroy, fired only at real
      // teardown) so messages keep updating the hidden iframe's state. A
      // future PluginFrame for this same key adopts the live iframe.
      portalHost.unmount(handle.key);
      handle = null;
    }
  });

  return <div class="relative flex-1 min-h-0" ref={placeholder} />;
}

// ---------------------------------------------------------------------------
// Handle factory — owns iframe creation, WS relay, postMessage handshake.
// ---------------------------------------------------------------------------

function createPluginHandle(
  key: string,
  content: PluginContent,
  panelId: string,
  placeholder: HTMLElement,
): Handle {
  const { serverId, tunnelUrl, slug, itemId, itemLabel } = content;

  // Adoption short-circuit: portal-host has a mount under this key already
  // (focus collapse, workspace switch, panel rearrange, or cross-workspace
  // drag rekey landed here). Reuse the existing iframe + handle. The portal
  // entry might have arrived under a different key originally and been
  // rekeyed to this one — the iframe is the source of truth, so look the
  // handle up by element. Update handle.key so the navigate effect's later
  // posts and frameKey-scoped voice routing stay consistent.
  if (portalHost.hasMount(key)) {
    const adoptedIframe = portalHost.getMountElement(key) as HTMLIFrameElement | null;
    if (adoptedIframe !== null) {
      const existing = handlesByIframe.get(adoptedIframe);
      if (existing !== undefined) {
        existing.key = key;
        portalHost.mount({
          key,
          workspaceId: key.split(":")[0]!,
          placeholder,
          element: adoptedIframe,
        });
        return existing;
      }
      // Portal-host has the mount but the WeakMap entry is missing. Should
      // not happen in normal operation (the WeakMap key is the live iframe,
      // which can't have been GC'd while still in the portal). Treat as a
      // fresh mount — we'd otherwise hand back a half-constructed handle.
      console.warn("[PluginFrame] portal mount exists without handle for key", key);
    }
  }

  const handlerKey = `${panelId}:${slug}`;

  const iframe = document.createElement("iframe");
  // Sandboxed without `allow-same-origin` so the iframe has an opaque origin
  // that can't address the parent via DOM/cookies/storage. Chromium rejects
  // `targetOrigin: "null"`, so outbound postMessage uses "*" — safety rests on
  // the sandbox and on `ev.source === iframe.contentWindow` guards below.
  // `allow-downloads` is required for plugin file-attachment links: without it
  // Chromium silently aborts any `Content-Disposition: attachment` response
  // initiated from the iframe (or from a popup the iframe opens, since popups
  // inherit sandbox flags). The runtime HMAC-checks every `/files/...` request,
  // so the download token does not weaken the file-access boundary.
  iframe.sandbox.add("allow-scripts", "allow-forms", "allow-popups", "allow-downloads");
  // Permissions Policy delegations. The autoplay-unblock CTA itself lives
  // shell-side (audio-blocked-banner.tsx) — iOS Safari does not propagate
  // activation across a sandboxed cross-origin frame, so a button rendered
  // here can never satisfy the gate. We still delegate `autoplay` to keep
  // any future iframe-local audio elements (e.g. ringtones) from being
  // blocked unnecessarily, and `microphone` for parity in case a plugin
  // ever runs its own getUserMedia path independent of the shell Room.
  iframe.setAttribute("allow", "microphone; autoplay");
  iframe.setAttribute("aria-label", `${slug} plugin`);

  // Single-shot token: we can't detect post-load navigation inside an
  // opaque-origin sandboxed iframe, so bound the blast radius by sending the
  // token exactly once on the first uncorded.ready — a second ready from the
  // same frame implies internal navigation and is ignored.
  let tokenSent = false;
  const handleRef: { h: Handle | null } = { h: null };

  function onMessage(ev: MessageEvent): void {
    if (ev.source !== iframe.contentWindow) return;
    const msg = ev.data as { type?: string };
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "uncorded.ready") {
      if (tokenSent) {
        console.warn("[PluginFrame] ignoring repeat uncorded.ready (token already issued)");
        return;
      }
      tokenSent = true;
      void (async () => {
        try {
          const token = getToken(serverId) ?? (await central.getServerToken(serverId)).token;
          // runtimeCapabilities lets the iframe SDK gate platform-feature
          // affordances at render time (e.g. hide "Join voice" when
          // voice.media isn't granted) instead of relying on the manager's
          // failure path. Trust origin: the runtime serializes from
          // PluginRegistry after manifest validation, so this is the
          // validated grant set, not the declared one.
          //
          // Wait for the sidebar store's /plugins fetch to land before reading
          // the cap map. Workspace restore mounts plugin iframes the moment
          // activeServerId flips, which can race ahead of loadSidebar — we'd
          // otherwise hand the iframe an empty cap list and the SDK's
          // `voice.granted` getter would close over `false` for the lifetime
          // of the handshake, leaving voice panels stuck on the cap-warning
          // screen until the user manually reopens them.
          await awaitCapabilities(serverId);
          const runtimeCapabilities = getPluginRuntimeCapabilities(slug);
          iframe.contentWindow?.postMessage(
            { type: "uncorded.token", token, slug, runtimeCapabilities, itemId, itemLabel },
            "*",
          );
          iframe.contentWindow?.postMessage(
            { type: "uncorded.navigate", itemId, itemLabel },
            "*",
          );
          // Voice snapshot — only fires if the manager has an active connection
          // on this serverId. Doing this at uncorded.ready time (rather than at
          // voiceManager.subscribe time) is what makes the fresh-mount path
          // correct: at subscribe time the iframe is still about:blank and the
          // pushes would be lost; at ready time the SDK's dispatch listener is
          // attached, so the snapshot lands. Without this, switching away from
          // a connected server and back leaves the plugin showing the idle
          // "Join voice" CTA on a channel the manager is already connected to.
          voiceManager.snapshotFor(serverId, (env) => {
            iframe.contentWindow?.postMessage(env, "*");
          });
          if (handleRef.h !== null) {
            handleRef.h.ready = true;
            handleRef.h.lastSentItemId = itemId;
          }
        } catch (err) {
          console.error("[PluginFrame] token exchange failed", err);
        }
      })();
      return;
    }

    // platform.browser.open is intentionally ignored: plugin-driven browser
    // opening is disabled until `client.browser` capability enforcement is
    // designed and implemented. User-owned browser panels are unaffected.

    if (msg.type === "platform.user-card.show") {
      // Trusted-but-validated: the iframe is sandboxed, but a buggy plugin
      // could still ship malformed payloads. Drop anything missing the
      // required identity fields rather than rendering a card with "?".
      const raw = ev.data as Record<string, unknown>;
      const userId = typeof raw["userId"] === "string" ? raw["userId"] : null;
      if (userId === null) return;
      const displayName = typeof raw["displayName"] === "string"
        ? raw["displayName"]
        : userId;
      const avatarUrl = typeof raw["avatarUrl"] === "string" ? raw["avatarUrl"] : null;
      openUserCard({ userId, displayName, avatarUrl });
      return;
    }

    if (msg.type === "platform.files.preview") {
      // Plugin asks the shell to open the file-preview overlay. The shell
      // hosts the iframe outside the plugin sandbox so PDFium can render —
      // see the file-preview store comment for the why.
      //
      // We pin the URL to this iframe's tunnelUrl: a plugin can only ask us
      // to preview files served by its own runtime, not arbitrary URLs. That
      // closes the door on a buggy or malicious plugin steering the shell's
      // unsandboxed iframe at attacker-controlled content.
      const raw = ev.data as Record<string, unknown>;
      const rawUrl = typeof raw["url"] === "string" ? raw["url"] : null;
      const rawName = typeof raw["name"] === "string" ? raw["name"] : null;
      if (rawUrl === null || rawName === null) return;
      let parsed: URL;
      try {
        parsed = new URL(rawUrl, tunnelUrl);
      } catch {
        return;
      }
      const runtimeOrigin = new URL(tunnelUrl).origin;
      if (parsed.origin !== runtimeOrigin) return;
      if (!parsed.pathname.startsWith("/files/")) return;
      const name = rawName.slice(0, 512);
      openFilePreview({ url: parsed.toString(), name, runtimeOrigin });
      return;
    }

    if (msg.type === "platform.files.download") {
      // Plugin asks the shell to trigger a native download for a runtime file
      // URL. Same origin-pinning rule as preview — a plugin can only download
      // files from its own runtime, not arbitrary URLs. The shell owns the
      // trigger because the plugin iframe's own `<a download>` is unreliable:
      // cross-origin `download` is ignored by Chromium, and on Linux Electron
      // the setWindowOpenHandler popup-intercept path silently drops
      // `webContents.downloadURL`. Routing through the shell lets desktop
      // call `window.electron.downloads.start()` (main-process download) and
      // web fall back to a programmatic anchor.
      const raw = ev.data as Record<string, unknown>;
      const rawUrl = typeof raw["url"] === "string" ? raw["url"] : null;
      const rawName = typeof raw["name"] === "string" ? raw["name"] : null;
      if (rawUrl === null || rawName === null) return;
      let parsed: URL;
      try {
        parsed = new URL(rawUrl, tunnelUrl);
      } catch {
        return;
      }
      const runtimeOrigin = new URL(tunnelUrl).origin;
      if (parsed.origin !== runtimeOrigin) return;
      if (!parsed.pathname.startsWith("/files/")) return;
      const name = rawName.slice(0, 512);
      startFileDownload({ url: parsed.toString(), name });
      return;
    }

    if (msg.type === "platform.panels.open") {
      const raw = ev.data as Record<string, unknown>;
      const itemId = boundedString(raw["itemId"], 256);
      const itemLabel = boundedString(raw["itemLabel"], 120);
      const itemIcon = optionalBoundedString(raw["itemIcon"], 64);
      const placementRaw = raw["placement"];
      const placement =
        placementRaw === "replace-current" || placementRaw === "beside-current"
          ? placementRaw
          : "beside-current";
      const modeRaw = raw["mode"];
      const mode = modeRaw === "new" || modeRaw === "reuse-or-create"
        ? modeRaw
        : "reuse-or-create";
      if (itemId === null || itemLabel === null || itemIcon === false) return;
      const currentKey = handleRef.h?.key ?? key;
      const [workspaceId, sourcePanelId] = currentKey.split(":");
      if (!workspaceId || !sourcePanelId) return;
      emitPluginPanelOpen({
        workspaceId,
        sourcePanelId,
        placement,
        mode,
        content: {
          type: "plugin",
          serverId,
          tunnelUrl,
          slug,
          itemId,
          itemLabel,
          ...(itemIcon !== null ? { itemIcon } : {}),
        },
      });
      return;
    }

    if (msg.type === "platform.panels.focus-current") {
      const currentKey = handleRef.h?.key ?? key;
      const [workspaceId, panelId] = currentKey.split(":");
      if (!workspaceId || !panelId) return;
      emitPluginPanelFocus({ workspaceId, panelId });
      return;
    }

    // All `platform.voice.*` request envelopes route into the shell voice
    // manager. The manager's dispatch typeguards the payload, so we just
    // need a coarse string-prefix gate here. `frameKey` is the portal key
    // (`${activeId}:${panelId}:${surfaceKey}`) — the manager scopes slot
    // reservations against it (PR-6 §5). `iframe` is the stable element
    // reference the overlay uses for positioning (immune to portal-host
    // rekey on cross-workspace drag).
    if (typeof msg.type === "string" && msg.type.startsWith("platform.voice.")) {
      voiceManager.dispatch({
        serverId,
        slug,
        envelope: ev.data as voiceManager.VoiceRequest,
        frameKey: key,
        iframe,
      });
      return;
    }

    if (msg.type === "request") {
      ws.send(serverId, ev.data as ClientMessage, handlerKey);
    }
  }

  window.addEventListener("message", onMessage);

  const unregisterWs = ws.onPluginMessage(serverId, slug, (data) => {
    iframe.contentWindow?.postMessage(data, "*");
  }, handlerKey);

  // Voice manager → this iframe push fan-out (PR-5 §15 pins #3/#4). Manager
  // filters by serverId; same-server multi-mount means each iframe gets its
  // own subscription and renders independently.
  const unregisterVoice = voiceManager.subscribe(serverId, slug, (env) => {
    iframe.contentWindow?.postMessage(env, "*");
  });

  const handle: Handle = {
    key,
    iframe,
    ready: false,
    lastSentItemId: null,
  };
  handlesByIframe.set(iframe, handle);
  handleRef.h = handle;

  // Mount with onDestroy bound to the iframe's lifetime. portalHost.unmount
  // (component-cleanup path) only hides; this onDestroy fires only at the
  // explicit destroy paths in App.tsx and at the surface-key-change branch
  // of PluginFrame's mount effect.
  portalHost.mount({
    key,
    workspaceId: key.split(":")[0]!,
    placeholder,
    element: iframe,
    onAttached: () => {
      iframe.src = `${tunnelUrl}/plugins/${slug}/ui/`;
    },
    onDestroy: () => {
      window.removeEventListener("message", onMessage);
      unregisterWs();
      unregisterVoice();
      // PR-6 — sweep any screen-share slot reservations the iframe left
      // behind. The plan rejects TTL-based eviction (devtools breakpoints
      // and GC pauses break it); explicit cleanup on iframe disconnect is
      // the load-bearing path. Use the closure-captured `key` (matches the
      // value the onMessage handler passes to voiceManager.dispatch as
      // frameKey) — voice slots are registered under the iframe's original
      // mount key and stay there even if portal-host rekeys the entry for
      // cross-workspace drag.
      voiceManager.unregisterScreenSlotsForFrame(key);
      // WeakMap entry clears via GC after this returns; explicit delete is
      // unnecessary but cheap.
      handlesByIframe.delete(iframe);
    },
  });

  return handle;
}
