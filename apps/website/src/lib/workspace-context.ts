// Solid context for the currently-active workspace id.
//
// Surface-level components (PluginFrame, BrowserSurface) need this to build
// stable portal mount keys of the form `${workspaceId}:${leafId}:${surfaceKey}`.
// Prop-drilling through PanelLayout → PanelSplit → PanelLeaf → PanelBody is
// noisy; a context keeps the panel tree generic.

import { createContext, useContext } from "solid-js";

export interface WorkspaceContextValue {
  /** The locally-generated id for the active workspace (not the Central savedId). */
  activeId: () => string;
}

export const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function useWorkspaceContext(): WorkspaceContextValue {
  const ctx = useContext(WorkspaceContext);
  if (ctx === null) {
    throw new Error("useWorkspaceContext must be called inside a WorkspaceContext.Provider");
  }
  return ctx;
}
