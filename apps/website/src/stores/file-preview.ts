// File-preview store — single-instance signal that FilePreviewOverlay reads.
// Plugin iframes ask the shell to open this overlay via `platform.files.preview`
// because nested iframes inside the plugin sandbox can't render PDFs: they
// inherit the parent's sandbox without `allow-same-origin`, and Chromium's
// PDFium refuses to render in an opaque-origin context. The shell hosts the
// overlay outside the sandbox so PDFium works.

import { createSignal } from "solid-js";

export interface FilePreview {
  /** Runtime URL that serves the file inline (no `?download=1`). */
  url: string;
  /** Filename shown in the header caption + used as the download attribute. */
  name: string;
  /** Runtime origin that issued this preview — used to derive the download URL. */
  runtimeOrigin: string;
}

const [preview, setPreview] = createSignal<FilePreview | null>(null);

export const filePreview = preview;

export function openFilePreview(next: FilePreview): void {
  setPreview(next);
}

export function closeFilePreview(): void {
  setPreview(null);
}
