// Public surface for the Co-View Sessions subsystem (spec-27).
// main.ts wires the boot block; the WS router pulls dispatch via the
// returned handle.

export { startCoView } from "./register";
export { isCoViewClientMessage } from "./types";
export type {
  CoViewClientMessage,
  CoViewDeps,
  CoViewHandle,
} from "./types";
export { CO_VIEW_LIMITS } from "./types";
export {
  CO_VIEW_HOST_PERMISSION,
  CO_VIEW_MODERATE_PERMISSION,
} from "./permissions";
// Render-tree projection core (CV-FOUND-2). Pure; not wired into live sessions
// or the broadcast path yet (that lands in CV-FOUND-3/4).
export { projectCanonicalRenderFrame } from "./render-tree-projection";
export type {
  CoViewProjectionResult,
  CoViewValueResolver,
  CoViewGatedResolveRequest,
} from "./render-tree-projection";
// Render-tree transport path (CV-FOUND-4b). Disabled by default — wired into
// dispatch but gated behind the flag + optional injected transport deps.
export {
  CO_VIEW_RENDER_TREE_TRANSPORT_ENABLED,
  handleRenderTreeFrame,
} from "./render-tree-transport";
export type { CoViewRenderTreeTransportDeps } from "./types";
export { serializeEntitlementClass } from "./entitlement-class";
export type { CoViewEntitlementClass, CoViewRenderMode } from "./entitlement-class";
