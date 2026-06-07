// Electron-only screen-share picker modal.
//
// On web the browser's native getDisplayMedia picker is the only path, so
// this component does nothing in a browser build (the early-return on
// isElectron() keeps it inert). On Electron the main process registers
// `setDisplayMediaRequestHandler` and pushes a SHOW_PICKER event back to
// the renderer; this component subscribes and renders the modal.
//
// Lifecycle:
//   - Mount once (App.tsx) so we never miss a picker request.
//   - The handler subscription in onMount returns a cleanup; onCleanup
//     tears it down on unmount (HMR friendly).
//   - When a request arrives, we set the active request signal and the
//     Dialog opens. User picks, cancels, or hits Esc — all three paths
//     call respondToPicker(requestId, selection|null) and clear state.
//   - If the user closes the Dialog without selecting (X button, Esc,
//     overlay click), that's a cancel — main interprets null selection
//     as a cancel and returns NotAllowedError to LiveKit, which surfaces
//     as the `screen_share_cancelled` envelope from voice-manager.
//
// Privacy / abuse considerations:
//   - Source thumbnails arrive as data: URLs from the main process. They
//     can contain whatever the OS rendered into that capture frame. We
//     only display them inside the modal; never persist them, never
//     expose them outside the picker UI.
//   - Audio toggle defaults to whatever the request asked for. Even when
//     the page asked for audio, the user can opt out — the toggle is the
//     final word.

import {
  Show,
  For,
  createSignal,
  createMemo,
  onCleanup,
  onMount,
} from "solid-js";
import type { ScreenShareRequest, ScreenShareSource } from "@uncorded/electron-bridge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { isElectron, getElectron } from "@/lib/electron";

function groupSources(sources: ScreenShareSource[]): {
  screens: ScreenShareSource[];
  windows: ScreenShareSource[];
} {
  const screens: ScreenShareSource[] = [];
  const windows: ScreenShareSource[] = [];
  for (const s of sources) {
    if (s.type === "screen") screens.push(s);
    else windows.push(s);
  }
  return { screens, windows };
}

export function ScreenSharePicker() {
  if (!isElectron()) return null;

  const [request, setRequest] = createSignal<ScreenShareRequest | null>(null);
  const [selectedId, setSelectedId] = createSignal<string | null>(null);
  const [audio, setAudio] = createSignal(false);
  const [filter, setFilter] = createSignal("");

  // Defensive against double-respond. Once a response is sent we drop the
  // request immediately; if the user mashes Confirm and Cancel, only the
  // first one wins and the second is a no-op.
  let responded = false;

  function reset() {
    setRequest(null);
    setSelectedId(null);
    setAudio(false);
    setFilter("");
    responded = false;
  }

  async function respond(selection: { sourceId: string; audio: boolean } | null) {
    const req = request();
    if (!req || responded) return;
    responded = true;
    try {
      await getElectron().screenShare.respondToPicker(req.requestId, selection);
    } catch (err) {
      // Logging only — main has already torn down the pending entry.
      // eslint-disable-next-line no-console
      console.warn("[screen-share-picker] respondToPicker failed", err);
    } finally {
      reset();
    }
  }

  onMount(() => {
    const electron = getElectron();
    const cleanup = electron.screenShare.onShowPicker((req) => {
      // If a previous request is still mid-flight, cancel it before
      // adopting the new one. Main only tracks one pending entry per
      // requestId so the dropped one will time out cleanly on its own,
      // but cancelling explicitly is faster.
      const pending = request();
      if (pending && !responded) {
        responded = true;
        void electron.screenShare
          .respondToPicker(pending.requestId, null)
          .catch(() => {
            /* swallow — superseded request */
          });
      }
      reset();
      setRequest(req);
      setAudio(req.audioRequested);
      // Pre-select the first entry so Enter / clicking Confirm without
      // explicit selection still works.
      if (req.sources.length > 0) {
        setSelectedId(req.sources[0]!.id);
      }
    });
    onCleanup(cleanup);
  });

  const filtered = createMemo(() => {
    const req = request();
    if (!req) return { screens: [], windows: [] };
    const q = filter().trim().toLowerCase();
    const matches = q
      ? req.sources.filter((s) => s.name.toLowerCase().includes(q))
      : req.sources;
    return groupSources(matches);
  });

  const open = createMemo(() => request() !== null);

  return (
    <Dialog
      open={open()}
      onOpenChange={(next) => {
        if (!next) {
          // User closed via Esc, X, or overlay click — that's a cancel.
          void respond(null);
        }
      }}
    >
      <DialogContent class="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Choose what to share</DialogTitle>
          <DialogDescription>
            Pick a screen or window to share with the call. The UnCorded
            window itself is hidden from this list to prevent mirror loops.
          </DialogDescription>
        </DialogHeader>

        <div class="mt-3 flex items-center gap-3">
          <input
            type="text"
            placeholder="Filter sources…"
            value={filter()}
            onInput={(e) => setFilter(e.currentTarget.value)}
            class="flex h-9 flex-1 rounded-md border border-input bg-background px-3 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
          <label class="flex select-none items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={audio()}
              onChange={(e) => setAudio(e.currentTarget.checked)}
              class="size-4 rounded border-input"
            />
            Share audio
          </label>
        </div>

        <div class="mt-4 max-h-[60vh] space-y-5 overflow-y-auto pr-1">
          <Show when={filtered().screens.length > 0}>
            <section>
              <h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Screens
              </h3>
              <SourceGrid
                sources={filtered().screens}
                selectedId={selectedId()}
                onSelect={(id) => setSelectedId(id)}
              />
            </section>
          </Show>
          <Show when={filtered().windows.length > 0}>
            <section>
              <h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Windows
              </h3>
              <SourceGrid
                sources={filtered().windows}
                selectedId={selectedId()}
                onSelect={(id) => setSelectedId(id)}
              />
            </section>
          </Show>
          <Show
            when={
              filtered().screens.length === 0 && filtered().windows.length === 0
            }
          >
            <p class="py-12 text-center text-sm text-muted-foreground">
              No sources match this filter.
            </p>
          </Show>
        </div>

        <div class="mt-4 flex items-center justify-end gap-2">
          <Button variant="outline" onClick={() => void respond(null)}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              const id = selectedId();
              if (!id) return;
              void respond({ sourceId: id, audio: audio() });
            }}
            disabled={!selectedId()}
          >
            Share
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SourceGrid(props: {
  sources: ScreenShareSource[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div class="grid grid-cols-2 gap-3 sm:grid-cols-3">
      <For each={props.sources}>
        {(source) => {
          const selected = () => props.selectedId === source.id;
          return (
            <button
              type="button"
              onClick={() => props.onSelect(source.id)}
              class={
                "group flex flex-col gap-1.5 rounded-lg border p-2 text-left transition-colors " +
                (selected()
                  ? "border-primary bg-primary/5 ring-2 ring-primary"
                  : "border-border hover:border-primary/50 hover:bg-accent")
              }
            >
              <div class="aspect-video w-full overflow-hidden rounded-md bg-muted">
                <Show when={source.thumbnailDataUrl} fallback={<div class="h-full w-full" />}>
                  <img
                    src={source.thumbnailDataUrl}
                    alt={source.name}
                    class="h-full w-full object-contain"
                  />
                </Show>
              </div>
              <div class="flex items-center gap-1.5">
                <Show when={source.appIconDataUrl}>
                  <img
                    src={source.appIconDataUrl!}
                    alt=""
                    class="size-4 shrink-0 rounded-sm"
                  />
                </Show>
                <span class="line-clamp-1 text-xs">{source.name}</span>
              </div>
            </button>
          );
        }}
      </For>
    </div>
  );
}
