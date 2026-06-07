import { Show, createEffect, createMemo, createResource, createSignal, onCleanup } from "solid-js";
import { Download, X } from "lucide-solid";
import { PdfViewer } from "@/components/pdf-viewer";
import { closeFilePreview, filePreview, type FilePreview } from "@/stores/file-preview";

// Lazy-load marked + dompurify so they don't bloat the initial bundle —
// the overlay always mounts in App.tsx, but markdown rendering is a rare
// path. Cached across opens.
let mdRendererPromise: Promise<(text: string) => Promise<string>> | null = null;
function loadMdRenderer(): Promise<(text: string) => Promise<string>> {
  if (mdRendererPromise) return mdRendererPromise;
  mdRendererPromise = (async () => {
    const [{ marked }, dompurifyMod] = await Promise.all([
      import("marked"),
      import("dompurify"),
    ]);
    const DOMPurify = dompurifyMod.default;
    return async (text: string) => DOMPurify.sanitize(await marked.parse(text, { async: true }));
  })();
  return mdRendererPromise;
}

// Full-screen file-preview overlay. Rendered shell-side (outside the plugin
// sandbox) so that nested-iframe PDFs render — PDFium refuses to paint in the
// opaque-origin context the plugin iframe creates. Plugins ask the shell to
// open this via `platform.files.preview` postMessage; channel-view.tsx
// validates the URL against the iframe's tunnelUrl and forwards into the store.
//
// Markdown rendering happens here too: text/plain is not in INLINE_SAFE_MIMES
// so we can't iframe it, and shipping a viewer to the plugin would mean the
// raw HTML lives inside the sandboxed iframe with no real origin. Instead the
// shell fetches the raw text cross-origin (CORS-allowed for signed file URLs)
// and renders it via marked → DOMPurify → innerHTML in the shell origin.

function downloadHref(url: string, name: string, runtimeOrigin: string): string {
  // Same shape the plugin uses: append `?download=1&n=<original name>` so the
  // runtime serves `Content-Disposition: attachment; filename*=UTF-8''<n>`.
  try {
    const u = new URL(url, runtimeOrigin);
    u.searchParams.set("download", "1");
    u.searchParams.set("n", name);
    return u.toString();
  } catch {
    return url;
  }
}

function isMarkdownName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".markdown");
}

function isPdfName(name: string): boolean {
  return name.toLowerCase().endsWith(".pdf");
}

function isHtmlName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith(".html") || lower.endsWith(".htm");
}

async function fetchMarkdown(p: FilePreview): Promise<string> {
  const render = await loadMdRenderer();
  const res = await fetch(p.url, { credentials: "omit" });
  if (!res.ok) throw new Error(`Failed to load (${res.status})`);
  const text = await res.text();
  return render(text);
}

// HTML files come back from the runtime with `Content-Disposition: attachment`
// (text/html is intentionally not in INLINE_SAFE_MIMES — the runtime origin
// hosts other signed files and a malicious upload would otherwise execute in
// that origin). `<iframe src=>` would honor the disposition and trigger a
// download, so we fetch the bytes as text and render via `<iframe srcdoc>`
// with `sandbox=""` (no flags) — that gives an opaque origin, no scripts, no
// forms, no popups, no top-nav. Render-only document preview.
async function fetchHtml(p: FilePreview): Promise<string> {
  const res = await fetch(p.url, { credentials: "omit" });
  if (!res.ok) throw new Error(`Failed to load (${res.status})`);
  return res.text();
}

export function FilePreviewOverlay() {
  const open = createMemo(() => filePreview() !== null);
  const dl = createMemo(() => {
    const p = filePreview();
    return p ? downloadHref(p.url, p.name, p.runtimeOrigin) : "#";
  });
  const isMarkdown = createMemo(() => {
    const p = filePreview();
    return p ? isMarkdownName(p.name) : false;
  });
  const isPdf = createMemo(() => {
    const p = filePreview();
    return p ? isPdfName(p.name) : false;
  });
  const isHtml = createMemo(() => {
    const p = filePreview();
    return p ? isHtmlName(p.name) : false;
  });

  // Source signal drives the resource — null when not previewing markdown.
  const [mdSource, setMdSource] = createSignal<FilePreview | null>(null);
  createEffect(() => {
    const p = filePreview();
    setMdSource(p && isMarkdownName(p.name) ? p : null);
  });
  const [mdHtml] = createResource(mdSource, fetchMarkdown);

  // Same pattern for HTML — fetched as raw text and handed to the sandboxed
  // iframe via `srcdoc`. We can't share the markdown resource because the
  // rendering pipeline is different (no marked / DOMPurify pass).
  const [htmlSource, setHtmlSource] = createSignal<FilePreview | null>(null);
  createEffect(() => {
    const p = filePreview();
    setHtmlSource(p && isHtmlName(p.name) ? p : null);
  });
  const [htmlBody] = createResource(htmlSource, fetchHtml);

  // Esc closes — body-level listener, only active while the overlay is open.
  createEffect(() => {
    if (!open()) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        closeFilePreview();
      }
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  return (
    <Show when={filePreview()}>
      {(p) => (
        <div
          role="dialog"
          aria-modal="true"
          class="fixed inset-0 z-[1000] flex flex-col bg-black/85"
          onClick={(ev) => {
            // Backdrop click — close only when the click is on the wrapper
            // itself, not bubbling up from the iframe/header.
            if (ev.target === ev.currentTarget) closeFilePreview();
          }}
        >
          <div class="flex flex-none items-center gap-2 border-b border-white/10 bg-black/40 px-4 py-2.5">
            <span class="flex-1 truncate text-[13px] text-white/80">
              {p().name}
            </span>
            <a
              href={dl()}
              download={p().name}
              target="_blank"
              rel="noopener"
              aria-label={`Download ${p().name}`}
              class="inline-flex size-8 items-center justify-center rounded-md border border-white/10 bg-white/[0.08] text-white hover:bg-white/[0.18]"
            >
              <Download class="size-4" />
            </a>
            <button
              type="button"
              aria-label="Close preview"
              onClick={() => closeFilePreview()}
              class="inline-flex size-8 items-center justify-center rounded-md border border-white/10 bg-white/[0.08] text-white hover:bg-white/[0.18]"
            >
              <X class="size-4" />
            </button>
          </div>
          <Show
            when={isPdf()}
            fallback={
              <Show
                when={isMarkdown()}
                fallback={
                  <Show
                    when={isHtml()}
                    fallback={
                      <iframe
                        src={p().url}
                        title="File preview"
                        class="size-full flex-1 border-0 bg-neutral-900"
                      />
                    }
                  >
                    <div class="flex-1 overflow-auto bg-neutral-900">
                      <Show
                        when={!htmlBody.loading && !htmlBody.error}
                        fallback={
                          <div class="px-6 py-8 text-sm text-white/60">
                            <Show when={htmlBody.loading}>Loading…</Show>
                            <Show when={htmlBody.error}>
                              Failed to load HTML.
                            </Show>
                          </div>
                        }
                      >
                        {/* `sandbox=""` with no flags = opaque origin, no
                            scripts, no forms, no top-nav. The author's
                            inline `<style>` blocks still apply because
                            sandbox doesn't strip them — just disables JS
                            and disconnects the origin. */}
                        <iframe
                          srcdoc={htmlBody() ?? ""}
                          sandbox=""
                          title={`HTML preview: ${p().name}`}
                          class="size-full border-0 bg-white"
                        />
                      </Show>
                    </div>
                  </Show>
                }
              >
                <div class="flex-1 overflow-auto bg-neutral-900">
                  <Show
                    when={!mdHtml.loading && !mdHtml.error}
                    fallback={
                      <div class="px-6 py-8 text-sm text-white/60">
                        <Show when={mdHtml.loading}>Loading…</Show>
                        <Show when={mdHtml.error}>
                          Failed to load markdown.
                        </Show>
                      </div>
                    }
                  >
                    <article
                      class="md-body mx-auto max-w-3xl px-6 py-8"
                      innerHTML={mdHtml() ?? ""}
                    />
                  </Show>
                </div>
              </Show>
            }
          >
            <PdfViewer url={p().url} />
          </Show>
        </div>
      )}
    </Show>
  );
}
