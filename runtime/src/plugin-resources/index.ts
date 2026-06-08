// Plugin resources (RP-FOUND-2 store + RP-FOUND-3 resolver + RP-FOUND-4 SDK
// backend / adapter boundary) — public surface.
//
// Runtime-authoritative registry + ACL store, plus the ACL decision engine that
// reads it. The store persists resource/ACL state and makes no authorization
// decisions; the resolver is the sole authority that answers
// `viewer + resourceRef + action -> AuthDecision`. The RP-FOUND-4 layer adds the
// adapter boundary, the authorize-then-materialize value gate, and the IPC
// dispatch plugins call (`resources.*`). CoView surfaces (RP-FOUND-7+) build on
// the value gate.

export { PluginResourceStore } from "./store";
export type {
  CreateResourceInput,
  ParentResourceRef,
  PluginResourceError,
  PluginResourceResult,
  PluginResourceVoidResult,
  StoredResource,
  StoredResourceType,
} from "./types";

export { PluginResourceResolver } from "./resolver";
export type {
  BanCheck,
  MembershipCheck,
  PluginResourceResolverDeps,
  ResolverRoleSource,
} from "./resolver";

// RP-FOUND-4 — adapter boundary, value gate, IPC dispatch.
export type {
  AdapterDescribeResult,
  AdapterResolveValueResult,
  PluginResourceAdapter,
} from "./adapter";
export { PluginResourceValueGate, deriveSlotAction } from "./value-gate";
export type { PluginResourceValueGateDeps } from "./value-gate";
export { handlePluginResourcesIpc } from "./ipc";
export type { PluginResourceIpcDeps } from "./ipc";
