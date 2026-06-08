// Plugin resource store (RP-FOUND-2) — public module surface.
//
// Runtime-authoritative registry + ACL store for plugin resources. The resolver
// (RP-FOUND-3) and SDK surfaces (RP-FOUND-4+) build on this; this module itself
// makes no authorization decisions.

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
