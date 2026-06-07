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
