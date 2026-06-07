// Cross-component event bus for opening the Co-View sheet from anywhere
// (sidebar today; potentially titlebar or other surfaces later).
//
// Same single-handler pattern as `server-settings-events.ts`. App.tsx owns
// the open signal for the actual <CoViewSheet> and registers the handler on
// mount; the sidebar emits when the user clicks the sidebar entry.

type Handler = () => void;

let handler: Handler | null = null;

export function onCoViewSheetOpen(fn: Handler): () => void {
  handler = fn;
  return () => {
    if (handler === fn) handler = null;
  };
}

export function emitCoViewSheetOpen(): void {
  handler?.();
}
