import type { PanelContent } from "@uncorded/protocol";

export type PluginPanelPlacement = "beside-current" | "replace-current";
export type PluginPanelMode = "reuse-or-create" | "new";

export interface PluginPanelOpenRequest {
  workspaceId: string;
  sourcePanelId: string;
  content: Extract<PanelContent, { type: "plugin" }>;
  placement: PluginPanelPlacement;
  mode: PluginPanelMode;
}

type PluginPanelOpenHandler = (request: PluginPanelOpenRequest) => void;
type PluginPanelFocusHandler = (request: { workspaceId: string; panelId: string }) => void;

const handlers = new Set<PluginPanelOpenHandler>();
const focusHandlers = new Set<PluginPanelFocusHandler>();

export function onPluginPanelOpen(fn: PluginPanelOpenHandler): () => void {
  handlers.add(fn);
  return () => {
    handlers.delete(fn);
  };
}

export function emitPluginPanelOpen(request: PluginPanelOpenRequest): void {
  for (const handler of [...handlers]) handler(request);
}

export function onPluginPanelFocus(fn: PluginPanelFocusHandler): () => void {
  focusHandlers.add(fn);
  return () => {
    focusHandlers.delete(fn);
  };
}

export function emitPluginPanelFocus(request: { workspaceId: string; panelId: string }): void {
  for (const handler of [...focusHandlers]) handler(request);
}
