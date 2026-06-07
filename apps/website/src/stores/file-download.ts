// File-download trigger — runs in the shell (not in plugin iframes) because the
// plugin's own `<a download>` is unreliable in two ways:
//
//   1. The cross-origin HTML `download` attribute is silently ignored by
//      Chromium, so the runtime's `Content-Disposition` header is the only
//      knob that survives. We append `?n=<encoded-name>` to the URL so the
//      runtime emits `Content-Disposition: attachment; filename="<name>"`
//      and `?download=1` so it switches inline → attachment.
//   2. On Linux Electron, the popup-intercept path
//      (`setWindowOpenHandler` → `webContents.downloadURL`) silently drops
//      the download. The desktop bridge exposes a direct main-process
//      `downloads.start(url)` IPC that calls `downloadURL` on the parent
//      webContents itself — that works on every platform.
//
// On the web (no electron bridge) we fall back to a hidden anchor click; the
// `Content-Disposition: attachment` header forces the browser to save rather
// than navigate.

import { isElectron, getElectron } from "@/lib/electron";

export interface FileDownload {
  /** Origin-validated runtime file URL. */
  url: string;
  /** Original filename — surfaced to the runtime via `?n=` for Content-Disposition. */
  name: string;
}

export function startFileDownload(req: FileDownload): void {
  const url = ensureDownloadParams(req.url, req.name);
  if (isElectron()) {
    const bridge = getElectron();
    void bridge.downloads.start(url).catch(() => {
      // The main-process handler validates the URL and may reject it. Fall
      // back to the anchor path so the user still gets a download attempt —
      // worst case Chromium opens it as a tab and Content-Disposition forces
      // the save dialog.
      triggerAnchorDownload(url);
    });
    return;
  }
  triggerAnchorDownload(url);
}

function ensureDownloadParams(rawUrl: string, name: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return rawUrl;
  }
  if (parsed.searchParams.get("download") !== "1") {
    parsed.searchParams.set("download", "1");
  }
  if (!parsed.searchParams.has("n") && name.length > 0) {
    parsed.searchParams.set("n", name);
  }
  return parsed.toString();
}

function triggerAnchorDownload(url: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.rel = "noopener";
  // Cross-origin `download` is ignored, but setting it is harmless and
  // helps same-origin debug builds.
  a.download = "";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}
