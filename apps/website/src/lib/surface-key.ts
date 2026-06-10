// Content-identity contract for portal-hosted iframes.
//
// A "surface" is a stable DOM element (iframe or webview) mounted once in the
// top-level portal container. Panel content may change over time — a plugin
// navigates to a different item, a browser panel loads a different URL — and
// the portal host uses surfaceKey equality to decide whether those updates
// can navigate the existing surface or require a fresh mount.
//
// Contract:
//   same surfaceKey  → keep mount, send a navigate message (uncorded.navigate,
//                      webview.loadURL, or iframe.src assignment)
//   different key    → unmount the old surface, mount a new one
//
// The key MUST be a pure function of PanelContent fields that determine DOM
// identity. Fields that merely change what's displayed inside the same DOM
// element (itemId, URL) must NOT appear in the key.

import type { PanelContent } from "@uncorded/protocol";
import { isElectron } from "@/lib/electron";

export function surfaceKeyOf(content: PanelContent): string {
  if (content.type === "plugin") {
    return `plugin:${content.serverId}:${content.slug}`;
  }
  if (content.type === "browser") {
    return `browser:${isElectron() ? "webview" : "iframe"}`;
  }
  // Exhaustiveness: if PanelContent gains a variant, TS will flag this line.
  const _exhaustive: never = content;
  throw new Error(`Unknown PanelContent type: ${JSON.stringify(_exhaustive)}`);
}

// Identity key for a host-owned reverse-proxy mount surface (the dedicated
// webview on desktop, sandboxed iframe on web). A proxy mount is not a
// PanelContent variant — the panel stays type:"plugin" and the host promotes
// the approved mount into its own surface — so this key lives alongside
// surfaceKeyOf rather than inside it.
//
// Same contract as surfaceKeyOf: the key is pure panel-mount identity
// (server + plugin slug + mount name) and MUST NOT encode the render platform
// (webview vs iframe) — that's fixed per session by isElectron(), exactly like
// the browser key — nor any ephemeral content (the session url/openUrl, which
// are re-bootstrapped on each mount and never persisted).
export function proxyMountSurfaceKey(serverId: string, slug: string, mountName: string): string {
  return `proxy-mount:${serverId}:${slug}:${mountName}`;
}
