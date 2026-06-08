// Plugin resource adapter boundary (RP-FOUND-4, plan §7.3).
//
// Some resources need plugin-side existence / parent / value lookups the runtime
// cannot infer: the runtime does not know a photo belongs to an album, and it
// cannot resolve `photo.caption` from a `PluginResourceRef` unless the plugin
// exposes a value source. The plugin therefore exposes a *read-only* adapter.
//
// SECURITY — the adapter answers STRUCTURE, OWNERSHIP, and VALUE MATERIALIZATION,
// never AUTHORIZATION. Authorization stays in the resolver. `resolveValue` is
// invoked ONLY after `PluginResourceResolver` has authorized the viewer for the
// slot's gating action (see `value-gate.ts`); an unauthorized viewer never
// reaches the adapter, so no protected byte is requested for a denied read. A
// missing adapter, a `null` response, or `exists: false` fails closed.
//
// This is a *trusted plugin↔runtime boundary*, not a proof system (plan §7.3):
// the runtime can verify the viewer is authorized for an id, but cannot prove
// the returned bytes are the correct bytes for that id. The adapter remains part
// of the trusted computing base for plugin-owned content.

import type { JsonValue, PlaceholderShape, PluginResourceRef } from "@uncorded/protocol";

/** What the plugin reports about a resource's structure and ownership. */
export interface AdapterDescribeResult {
  exists: boolean;
  /** Parent resource, if this resource inherits from one. */
  parentRef?: PluginResourceRef | undefined;
  /** Owner user id(s), used to seed the `owner` principal. */
  ownerUserIds?: string[] | undefined;
}

/** What the plugin reports when asked to materialize a single value slot. */
export interface AdapterResolveValueResult {
  exists: boolean;
  /** The materialized value. Present only when `exists` is true. */
  value?: JsonValue | undefined;
  /** Optional placeholder hint when the plugin wants a non-default skeleton. */
  placeholderShape?: PlaceholderShape | undefined;
  /** Monotonic value version, for cache invalidation (plan §11).
   *  TODO(RP-FOUND-8): propagate this through viewer projection/cache types. */
  valueVersion: number;
}

/**
 * Read-only adapter a plugin exposes so the runtime can materialize protected
 * values from a runtime-controlled path (plan §7.3). Both methods are async
 * because the real implementation answers over IPC to the plugin subprocess.
 *
 * RP-FOUND-4 defines this boundary and the authorize-then-materialize ordering
 * around it (`value-gate.ts`); the concrete IPC adapter transport that fulfils
 * it for CoView projection is out of scope here (RP-FOUND-7).
 */
export interface PluginResourceAdapter {
  describe(resourceType: string, resourceId: string): Promise<AdapterDescribeResult | null>;

  resolveValue(
    resourceType: string,
    resourceId: string,
    slot: string,
  ): Promise<AdapterResolveValueResult | null>;
}
