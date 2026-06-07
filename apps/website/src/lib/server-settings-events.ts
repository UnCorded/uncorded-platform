// Lightweight event bus for opening Server Settings to a specific tab from
// anywhere in the app. The sidebar owns the open/close signal for the sheet
// itself; consumers (e.g. the runtime update pill) emit here to request a
// programmatic open with a target tab.
//
// Mirrors the pattern in `browser-panel-events.ts` — a single registered
// handler, no fan-out. The sidebar registers on mount and tears down on
// unmount, so no manual unsubscribe management is needed at call sites.

export type ServerSettingsTab =
  | "general"
  | "members"
  | "categories"
  | "administration"
  | "plugins"
  | "danger";

type Handler = (tab: ServerSettingsTab) => void;

let handler: Handler | null = null;

export function onServerSettingsOpen(fn: Handler): () => void {
  handler = fn;
  return () => {
    if (handler === fn) handler = null;
  };
}

export function emitServerSettingsOpen(tab: ServerSettingsTab): void {
  handler?.(tab);
}
