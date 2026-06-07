import { Show, createSignal, createEffect, onCleanup } from "solid-js";

// PDF renderer for FilePreviewOverlay. Replaces the browser's built-in
// PDFium-in-iframe (broken on mobile: iOS Safari only paints page 1, Android
// Chrome ignores viewport scaling) with Mozilla's pdfjs-dist.
//
// Strategy: render the doc as a vertically-stacked scroll of placeholder
// divs sized to each page's aspect ratio, then upgrade the visible window
// (±2 pages) to real canvases via IntersectionObserver. Pages outside the
// window revert to placeholder to cap memory at ~5 live canvases. A
// ResizeObserver re-renders the visible canvases at the new container width.
//
// Lazy-loaded — pdfjs-dist (~700KB) is only fetched the first time a PDF
// preview opens, then cached by the browser.

type PdfModule = typeof import("pdfjs-dist");
type PDFDocumentProxy = import("pdfjs-dist").PDFDocumentProxy;
type PDFPageProxy = import("pdfjs-dist").PDFPageProxy;
type RenderTask = import("pdfjs-dist").RenderTask;

let pdfjsPromise: Promise<PdfModule> | null = null;
function loadPdfjs(): Promise<PdfModule> {
  if (pdfjsPromise) return pdfjsPromise;
  pdfjsPromise = (async () => {
    const [mod, workerMod] = await Promise.all([
      import("pdfjs-dist"),
      import("pdfjs-dist/build/pdf.worker.mjs?url"),
    ]);
    // Bust Electron's session-level HTTP cache: in Vite dev the worker URL
    // is stable across pdfjs upgrades, so a stale v5 worker survives a page
    // reload even after the package is downgraded. Pinning a version query
    // forces a different URL whenever pdfjs-dist changes.
    mod.GlobalWorkerOptions.workerSrc = `${workerMod.default}${workerMod.default.includes("?") ? "&" : "?"}v=${mod.version ?? "x"}`;
    return mod;
  })();
  return pdfjsPromise;
}

// Per-page state lives in a plain array (not a Solid store) because the
// children are managed directly via DOM refs — Solid <For> over signals would
// force a full re-render on every state flip and tear down the canvases we're
// trying to keep alive.
interface PageEntry {
  index: number;             // 1-based page number
  proxy: PDFPageProxy | null;
  width: number;             // viewport width at scale=1 (placeholder estimate until proxy is loaded)
  height: number;
  el: HTMLDivElement;        // placeholder wrapper
  canvas: HTMLCanvasElement | null;
  renderTask: RenderTask | null;
  renderedAtCss: number;     // CSS pixel width at last render — invalidates on resize
}

export interface PdfViewerProps {
  url: string;
}

export function PdfViewer(props: PdfViewerProps) {
  let containerRef: HTMLDivElement | undefined;
  const [status, setStatus] = createSignal<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = createSignal("");
  const [pageCount, setPageCount] = createSignal(0);
  const [activePage, setActivePage] = createSignal(1);

  // Per-effect mutable state — wrapped in an object so the effect closure
  // can grab a snapshot and ignore later updates from a URL change.
  interface ViewerState {
    doc: PDFDocumentProxy | null;
    pages: PageEntry[];
    visibilityObserver: IntersectionObserver | null;
    activeObserver: IntersectionObserver | null;
    resizeObserver: ResizeObserver | null;
    visibleSet: Set<number>;
    renderedSet: Set<number>;
    cancelled: boolean;
  }
  let state: ViewerState | null = null;

  const RENDER_WINDOW = 2;

  function pageWidthCss(): number {
    if (!containerRef) return 0;
    // Subtract horizontal padding (matches `.pdf-viewer` in index.css).
    return Math.max(120, containerRef.clientWidth - 32);
  }

  async function ensureProxy(s: ViewerState, entry: PageEntry): Promise<boolean> {
    if (entry.proxy || !s.doc) return entry.proxy !== null;
    try {
      entry.proxy = await s.doc.getPage(entry.index);
      if (s.cancelled || !entry.proxy) return false;
      const vp = entry.proxy.getViewport({ scale: 1 });
      entry.width = vp.width;
      entry.height = vp.height;
      const widthCss = pageWidthCss();
      entry.el.style.height = (widthCss * (entry.height / entry.width)) + "px";
      return true;
    } catch (err) {
      if (!s.cancelled) console.error("getPage failed", err);
      return false;
    }
  }

  async function renderPage(s: ViewerState, entry: PageEntry): Promise<void> {
    if (s.cancelled || !containerRef) return;
    if (!entry.proxy) {
      const ok = await ensureProxy(s, entry);
      if (!ok || s.cancelled) return;
    }
    const widthCss = pageWidthCss();
    if (widthCss <= 0 || !entry.proxy) return;

    if (entry.canvas && Math.abs(entry.renderedAtCss - widthCss) < 4) return;

    if (entry.renderTask) {
      try { entry.renderTask.cancel(); } catch { /* ignore */ }
      entry.renderTask = null;
    }

    const scale = widthCss / entry.width;
    const dpr = window.devicePixelRatio || 1;
    const viewport = entry.proxy.getViewport({ scale: scale * dpr });

    const canvas = entry.canvas ?? document.createElement("canvas");
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.style.width = widthCss + "px";
    canvas.style.height = (widthCss * (entry.height / entry.width)) + "px";
    canvas.className = "pdf-page-canvas";

    if (!entry.canvas) {
      entry.el.innerHTML = "";
      entry.el.appendChild(canvas);
      entry.el.classList.add("is-rendered");
      entry.canvas = canvas;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    try {
      entry.renderTask = entry.proxy.render({ canvasContext: ctx, viewport });
      await entry.renderTask.promise;
      entry.renderedAtCss = widthCss;
      s.renderedSet.add(entry.index);
    } catch (err: unknown) {
      // `RenderingCancelledException` is normal during scroll-driven evict.
      const name = (err as { name?: string } | null)?.name;
      if (name !== "RenderingCancelledException" && !s.cancelled) {
        console.error("pdf render failed", err);
      }
    } finally {
      entry.renderTask = null;
    }
  }

  function unrenderPage(s: ViewerState, entry: PageEntry): void {
    if (entry.renderTask) {
      try { entry.renderTask.cancel(); } catch { /* ignore */ }
      entry.renderTask = null;
    }
    if (entry.canvas) {
      entry.canvas.remove();
      entry.canvas = null;
      entry.renderedAtCss = 0;
      entry.el.classList.remove("is-rendered");
    }
    s.renderedSet.delete(entry.index);
  }

  function reconcileRenderWindow(s: ViewerState): void {
    if (s.cancelled) return;
    const wanted = new Set<number>();
    for (const idx of s.visibleSet) {
      for (let d = -RENDER_WINDOW; d <= RENDER_WINDOW; d++) {
        const n = idx + d;
        if (n >= 1 && n <= s.pages.length) wanted.add(n);
      }
    }
    for (const idx of Array.from(s.renderedSet)) {
      if (!wanted.has(idx)) {
        const entry = s.pages[idx - 1];
        if (entry) unrenderPage(s, entry);
      }
    }
    for (const idx of wanted) {
      if (!s.renderedSet.has(idx)) {
        const entry = s.pages[idx - 1];
        if (entry) void renderPage(s, entry);
      }
    }
  }

  function reRenderAllAtNewWidth(s: ViewerState): void {
    if (s.cancelled) return;
    const widthCss = pageWidthCss();
    if (widthCss <= 0) return;
    for (const entry of s.pages) {
      const h = widthCss * (entry.height / entry.width);
      entry.el.style.width = widthCss + "px";
      entry.el.style.height = h + "px";
      if (entry.canvas) entry.renderedAtCss = 0;
    }
    for (const idx of s.renderedSet) {
      const entry = s.pages[idx - 1];
      if (entry) void renderPage(s, entry);
    }
  }

  function teardown(s: ViewerState | null): void {
    if (!s) return;
    s.cancelled = true;
    s.visibilityObserver?.disconnect();
    s.activeObserver?.disconnect();
    s.resizeObserver?.disconnect();
    for (const entry of s.pages) {
      if (entry.renderTask) {
        try { entry.renderTask.cancel(); } catch { /* ignore */ }
      }
      if (entry.canvas) entry.canvas.remove();
    }
    s.pages = [];
    s.visibleSet.clear();
    s.renderedSet.clear();
    if (s.doc) {
      void s.doc.destroy().catch(() => undefined);
      s.doc = null;
    }
  }

  createEffect(() => {
    const url = props.url;
    if (!url || !containerRef) return;

    // Tear down any prior state (URL change while overlay stays mounted).
    teardown(state);
    const s: ViewerState = {
      doc: null,
      pages: [],
      visibilityObserver: null,
      activeObserver: null,
      resizeObserver: null,
      visibleSet: new Set(),
      renderedSet: new Set(),
      cancelled: false,
    };
    state = s;

    setStatus("loading");
    setErrorMsg("");

    void (async () => {
      try {
        const pdfjs = await loadPdfjs();
        if (s.cancelled) return;
        const task = pdfjs.getDocument({ url, withCredentials: false });
        s.doc = await task.promise;
        if (s.cancelled) {
          await s.doc.destroy();
          s.doc = null;
          return;
        }

        const total = s.doc.numPages;
        setPageCount(total);

        const firstPage = await s.doc.getPage(1);
        if (s.cancelled) return;
        const firstViewport = firstPage.getViewport({ scale: 1 });

        if (!containerRef) return;
        containerRef.innerHTML = "";

        const widthCss = pageWidthCss();
        for (let i = 1; i <= total; i++) {
          const el = document.createElement("div");
          el.className = "pdf-page-placeholder";
          el.dataset["pageIndex"] = String(i);
          const aspect = firstViewport.height / firstViewport.width;
          el.style.width = widthCss + "px";
          el.style.height = (widthCss * aspect) + "px";
          containerRef.appendChild(el);
          s.pages.push({
            index: i,
            proxy: i === 1 ? firstPage : null,
            width: firstViewport.width,
            height: firstViewport.height,
            el,
            canvas: null,
            renderTask: null,
            renderedAtCss: 0,
          });
        }

        s.visibilityObserver = new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              const idx = Number((entry.target as HTMLElement).dataset["pageIndex"] || 0);
              if (!idx) continue;
              if (entry.isIntersecting) s.visibleSet.add(idx);
              else s.visibleSet.delete(idx);
            }
            reconcileRenderWindow(s);
          },
          { root: containerRef, rootMargin: "200px 0px" },
        );
        const activeRatios = new Map<number, number>();
        s.activeObserver = new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              const idx = Number((entry.target as HTMLElement).dataset["pageIndex"] || 0);
              if (!idx) continue;
              if (entry.isIntersecting) activeRatios.set(idx, entry.intersectionRatio);
              else activeRatios.delete(idx);
            }
            let bestIdx = 1;
            let bestRatio = -1;
            for (const [idx, ratio] of activeRatios) {
              if (ratio > bestRatio) { bestRatio = ratio; bestIdx = idx; }
            }
            setActivePage(bestIdx);
          },
          { root: containerRef, threshold: [0, 0.25, 0.5, 0.75, 1] },
        );

        for (const entry of s.pages) {
          s.visibilityObserver.observe(entry.el);
          s.activeObserver.observe(entry.el);
        }

        // IO callbacks fire async after the first layout pass. On some
        // browsers (particularly mobile WebKit) the first fire is delayed
        // long enough that the user sees blank placeholders for hundreds of
        // ms. Seed the visible set with pages 1-3 after one rAF (lets the
        // placeholders settle their box) so render kicks off without waiting
        // on IntersectionObserver; the observer takes over once it catches
        // up.
        requestAnimationFrame(() => {
          if (s.cancelled) return;
          for (let i = 1; i <= Math.min(3, total); i++) s.visibleSet.add(i);
          reconcileRenderWindow(s);
        });

        let lastWidth = widthCss;
        s.resizeObserver = new ResizeObserver(() => {
          const next = pageWidthCss();
          if (next <= 0) return;
          if (Math.abs(next - lastWidth) / Math.max(1, lastWidth) < 0.05) return;
          lastWidth = next;
          reRenderAllAtNewWidth(s);
        });
        s.resizeObserver.observe(containerRef);

        setStatus("ready");
      } catch (err: unknown) {
        if (s.cancelled) return;
        const msg = err instanceof Error ? err.message : "Failed to load PDF";
        setErrorMsg(msg);
        setStatus("error");
      }
    })();
  });

  onCleanup(() => teardown(state));

  return (
    <div class="relative flex flex-1 flex-col overflow-hidden bg-neutral-900">
      <Show when={pageCount() > 0 && status() === "ready"}>
        <div class="flex flex-none items-center justify-center border-b border-white/5 bg-black/30 px-3 py-1.5 text-[11px] text-white/55">
          Page {activePage()} of {pageCount()}
        </div>
      </Show>
      <div
        ref={(el) => { containerRef = el; }}
        class="pdf-viewer flex-1 overflow-auto px-4 py-4"
      />
      <Show when={status() === "loading"}>
        <div class="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 text-center text-sm text-white/60">
          Loading PDF…
        </div>
      </Show>
      <Show when={status() === "error"}>
        <div class="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 px-6 text-center text-sm text-white/60">
          Failed to load PDF{errorMsg() ? `: ${errorMsg()}` : "."}
        </div>
      </Show>
    </div>
  );
}
