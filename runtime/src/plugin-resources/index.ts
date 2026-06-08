// Plugin resources (RP-FOUND-2 store + RP-FOUND-3 resolver) — public surface.
//
// Runtime-authoritative registry + ACL store, plus the ACL decision engine that
// reads it. The store persists resource/ACL state and makes no authorization
// decisions; the resolver is the sole authority that answers
// `viewer + resourceRef + action -> AuthDecision`. SDK and CoView surfaces
// (RP-FOUND-4+) build on the resolver.

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
