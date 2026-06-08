// Plugin resource value materialization gate (RP-FOUND-4, plan §7.1, §7.3, §10).
//
// This is the security core of RP-FOUND-4: it makes "authorize, THEN materialize"
// structural and non-bypassable. Given a viewer and a value slot, it asks the
// runtime-authoritative resolver whether the viewer may see the slot, and only
// on an allow does it request the bytes from the plugin adapter. A denied or
// secret slot never reaches the adapter, so no protected byte is requested for a
// read the resolver would refuse.
//
// PRODUCER-VALUE INVARIANT (plan §7.3, §10.6): this gate is the ONLY value
// source. Its signature carries no host / render-frame value input, so for any
// slot — including `producerValueAllowed: false` — an authorized viewer's
// `visible` bytes are *structurally* proven to come from `adapter.resolveValue`
// (the runtime-controlled path), never from a producer's browser. CoView later
// projects this gate's output verbatim; it does not introduce a second value
// source for protected slots.

import type {
  PluginResourceAction,
  ResolvedPluginResourceValue,
  ValueSlotRef,
  ViewerContext,
} from "@uncorded/protocol";
import type { PluginResourceStore } from "./store";
import type { PluginResourceResolver } from "./resolver";
import type { PluginResourceAdapter } from "./adapter";

export interface PluginResourceValueGateDeps {
  store: PluginResourceStore;
  resolver: PluginResourceResolver;
  adapter: PluginResourceAdapter;
}

/**
 * Derive the gating action from a value slot's `policyRef`.
 *
 * TEMPORARY / V1 (plan §4.5): a slot policy is written as `<type>.<action>`
 * (e.g. "album.read", "photo.read", or a custom "album.family-album:download").
 * We take the segment after the FIRST `.` as the action. This is a deliberately
 * simple mapping for the foundation PR — a richer policyRef registry can replace
 * it later without changing the gate's authorize-then-materialize contract.
 *
 * An unparseable policy (no `.`) returns `null`, which the gate treats as a
 * fail-closed `unsupported` BEFORE any adapter call. The derived action is still
 * validated against the type's declared actions by the caller.
 */
export function deriveSlotAction(policy: string): string | null {
  const dot = policy.indexOf(".");
  if (dot === -1) return null;
  const action = policy.slice(dot + 1);
  return action.length > 0 ? action : null;
}

export class PluginResourceValueGate {
  constructor(private readonly deps: PluginResourceValueGateDeps) {}

  /**
   * Resolve a single value slot for a viewer (plan §7.1 `ResolvedValue`).
   *
   * Order is load-bearing and fail-closed at every step:
   *   1. unknown type / slot            → `unsupported`  (adapter NOT called)
   *   2. unparseable / undeclared policy→ `unsupported`  (adapter NOT called)
   *   3. resolver authorization (never consults the adapter)
   *   4. secret slot                    → `withheld`     (adapter NOT called)
   *   5. resolver denies                → `withheld`     (adapter NOT called)
   *   6. allow + non-secret             → `adapter.resolveValue` → `visible`
   *      (or `withheld` if the adapter is missing / null / exists:false)
   */
  async materializeValue(
    viewer: ViewerContext,
    slotRef: ValueSlotRef,
  ): Promise<ResolvedPluginResourceValue> {
    const ref = slotRef.resource;

    // 1. Type + slot must be registered. Unknown either way fails closed before
    //    we touch the resolver or the adapter (plan §4.2, §6.8).
    const type = this.deps.store.getType(ref.pluginSlug, ref.resourceType);
    if (!type) {
      return { state: "unsupported", reason: "unknown-resource-type" };
    }
    const slotDef = type.valueSlots[slotRef.slot];
    if (!slotDef) {
      return { state: "unsupported", reason: "unknown-slot" };
    }

    // 2. Map the slot policy → gating action and validate it is declared.
    const action = deriveSlotAction(slotDef.policy);
    if (action === null || !type.actions.includes(action as PluginResourceAction)) {
      return { state: "unsupported", reason: "unresolvable-policy" };
    }

    // 3. Runtime-authoritative authorization. The resolver decides on user ACLs
    //    only and NEVER calls the adapter, so it is safe to consult here for any
    //    slot (including secret) to obtain the version stamps.
    const decision = this.deps.resolver.canPluginResourceAction(
      viewer,
      ref,
      action as PluginResourceAction,
    );

    // 4. A secret slot is unrepresentable as `visible` on the viewer wire
    //    (plan §10.10). It withholds with an absent placeholder regardless of
    //    the decision — the adapter is never asked for its bytes.
    if (slotDef.secret === true) {
      return { state: "withheld", placeholderShape: { mode: "absent" }, versions: decision.versions };
    }

    // 5. Denied → withhold. The adapter is NOT called: no protected byte is
    //    requested for a read the resolver refused.
    if (!decision.allowed) {
      return {
        state: "withheld",
        placeholderShape: { mode: "synthetic" },
        versions: decision.versions,
      };
    }

    // 6. Allowed + non-secret → materialize from the runtime-controlled adapter
    //    path. A missing adapter answer fails closed to a placeholder.
    const raw = await this.deps.adapter.resolveValue(ref.resourceType, ref.resourceId, slotRef.slot);
    if (raw === null || !raw.exists || raw.value === undefined) {
      return {
        state: "withheld",
        placeholderShape: raw?.placeholderShape ?? { mode: "synthetic" },
        versions: decision.versions,
      };
    }

    return { state: "visible", value: raw.value, versions: decision.versions };
  }
}
