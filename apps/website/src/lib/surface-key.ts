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
