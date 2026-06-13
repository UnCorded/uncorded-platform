// Projected CoView viewer - dev/dogfood enablement switch (CV-FOUND-11).
//
// Website-only seam that lets a developer opt the live viewer flow into the
// projected arm of `CoViewViewerSelector` without flipping the global dormancy
// flag (`CO_VIEW_PROJECTED_VIEWER_ENABLED` stays false). Production stays on the
// legacy `ViewerSession`: with no override present this resolves to `false`, the
// selector receives `projectedEnabled={false}`, and `selectCoViewViewer` picks
// `legacy` exactly as before.
//
// Two explicit opt-ins, mirroring existing repo patterns:
//   - Build/dev env flag: `VITE_UNCORDED_COVIEW_PROJECTED_VIEWER=1` (the
//     `VITE_CENTRAL_URL` pattern) - requires deliberately setting the variable
//     when running/building, so a stock production build can never carry it.
//   - DevTools override: `localStorage.coview_projected_viewer = "1"` (the
//     `boot_trace` pattern) - honored ONLY when Vite dev mode is active
//     (`import.meta.env.DEV === true`), so a user flipping localStorage on a
//     production build changes nothing.
//
// Like `viewer-selector.ts`, this module only chooses - it touches no frame and
// synthesizes no value, so it can introduce no protected bytes. Every
// projection/privacy decision stays downstream in the projected mount ->
// `projected-frame-store` -> `render-tree-viewer`.

/** Raw inputs to the dev-flag decision, injected so the logic is testable. */
export interface ProjectedViewerDevFlagInputs {
  /** `import.meta.env.VITE_UNCORDED_COVIEW_PROJECTED_VIEWER` (build/dev env). */
  envFlag: string | undefined;
  /** `import.meta.env.DEV` - true only under the Vite dev server. */
  isDev: boolean;
  /** `localStorage.getItem("coview_projected_viewer")` (DevTools override). */
  localStorageFlag: string | null;
}

/**
 * Decide whether the projected viewer is dev-enabled. Fail-closed: anything
 * other than an exact `"1"` on an allowed channel resolves to `false`.
 * The localStorage channel is ignored entirely outside dev mode.
 */
export function resolveProjectedViewerDevEnabled(inputs: ProjectedViewerDevFlagInputs): boolean {
  if (inputs.envFlag === "1") return true;
  if (inputs.isDev && inputs.localStorageFlag === "1") return true;
  return false;
}

/** Read `localStorage.coview_projected_viewer`, tolerating environments without storage. */
function readLocalStorageFlag(): string | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage.getItem("coview_projected_viewer");
  } catch {
    return null;
  }
}

/**
 * Live wrapper over `resolveProjectedViewerDevEnabled` reading the real
 * environment. This is what `App.tsx` passes to `CoViewViewerSelector` as
 * `projectedEnabled`; with no override present it returns `false` and the
 * legacy viewer renders.
 */
export function isProjectedViewerDevEnabled(): boolean {
  return resolveProjectedViewerDevEnabled({
    envFlag: import.meta.env.VITE_UNCORDED_COVIEW_PROJECTED_VIEWER,
    isDev: import.meta.env.DEV === true,
    localStorageFlag: readLocalStorageFlag(),
  });
}
