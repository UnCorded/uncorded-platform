// The dock overlay shown over the browser panel by the toolbar Popout button
// (nothing has opened yet):
//   • Popout       → native, login-sticky pop-out window (shared persist:browser)
//   • Create Panel → save the page to this server's Web Apps list (the user
//                    later drags it into the workspace; it does NOT auto-dock)
//   • Cancel       → do nothing
//
// A "save preference for this URL" checkbox remembers the chosen action (keyed by
// exact URL) so the same URL skips the overlay next time (see browser-panel.tsx).
//
// A SITE-initiated window.open is NOT handled here — main captures it into a
// native WebContentsView and the renderer opens it as a free OS popout window
// (an inset modal can't paint over a native view; memory: chrome-above-portal-zindex).
//
// Rendered as an absolute inset overlay INSIDE the browser panel's own DOM
// subtree (not a portal/Dialog) so it reliably paints above the <webview> tag.

import { Show, createSignal } from "solid-js";
import { ExternalLink, Globe, LayoutPanelLeft, X } from "lucide-solid";
import { addWebApp, popOutWebApp, setWebAppPref } from "@/stores/web-apps";
import { showToast } from "@/lib/feedback";

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function DockPrompt(props: {
  url: string;
  title: string;
  faviconUrl?: string;
  serverId: string;
  onClose: () => void;
}) {
  const [remember, setRemember] = createSignal(false);
  const [faviconFailed, setFaviconFailed] = createSignal(false);
  const [busy, setBusy] = createSignal(false);

  // action "panel" = save to Web Apps; "popout" = open a native window.
  const choose = async (action: "popout" | "panel"): Promise<void> => {
    if (busy()) return;
    setBusy(true);
    try {
      if (remember()) await setWebAppPref(props.url, action);
      if (action === "popout") {
        await popOutWebApp(props.url);
      } else {
        const entry = await addWebApp(props.serverId, { url: props.url, title: props.title });
        if (entry) showToast(`Added ${entry.title} to Web Apps`, "info");
      }
    } finally {
      props.onClose();
    }
  };

  return (
    <div
      class="absolute inset-0 z-50 flex items-center justify-center bg-background/70 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Dock this page"
      onClick={(e) => {
        // Click on the backdrop (not the card) cancels.
        if (e.target === e.currentTarget && !busy()) props.onClose();
      }}
    >
      <div class="w-[22rem] max-w-[calc(100%-2rem)] rounded-xl border bg-background shadow-xl">
        <div class="flex items-start gap-3 p-4">
          <Show
            when={props.faviconUrl && !faviconFailed()}
            fallback={<Globe class="mt-0.5 size-5 shrink-0 text-muted-foreground" />}
          >
            <img
              src={props.faviconUrl}
              alt=""
              class="mt-0.5 size-5 shrink-0 rounded object-contain"
              onError={() => setFaviconFailed(true)}
            />
          </Show>
          <div class="min-w-0 flex-1">
            <h2 class="text-sm font-semibold text-foreground">
              Would you like to Dock this as a Panel?
            </h2>
            <p class="mt-0.5 truncate text-xs text-muted-foreground" title={props.url}>
              {props.title || hostOf(props.url)}
            </p>
          </div>
        </div>

        <div class="flex flex-col gap-2 px-4">
          <button
            type="button"
            class="flex items-center gap-2 rounded-lg border bg-muted/20 px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted/50 disabled:opacity-50"
            disabled={busy()}
            onClick={() => void choose("panel")}
          >
            <LayoutPanelLeft class="size-4 shrink-0 text-muted-foreground" />
            <span class="flex-1 text-left">Create Panel</span>
            <span class="text-[11px] text-muted-foreground">Save to Web Apps</span>
          </button>
          <button
            type="button"
            class="flex items-center gap-2 rounded-lg border bg-muted/20 px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted/50 disabled:opacity-50"
            disabled={busy()}
            onClick={() => void choose("popout")}
          >
            <ExternalLink class="size-4 shrink-0 text-muted-foreground" />
            <span class="flex-1 text-left">Popout</span>
            <span class="text-[11px] text-muted-foreground">Open a window</span>
          </button>
        </div>

        <label class="flex cursor-pointer items-center gap-2 px-4 pt-3 text-xs text-muted-foreground select-none">
          <input
            type="checkbox"
            class="size-3.5 accent-primary"
            checked={remember()}
            onChange={(e) => setRemember(e.currentTarget.checked)}
          />
          Save preference for this URL
        </label>

        <div class="flex justify-end p-3">
          <button
            type="button"
            class="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
            disabled={busy()}
            onClick={() => props.onClose()}
          >
            <X class="size-3.5" />
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
