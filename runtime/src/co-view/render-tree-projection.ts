// Runtime CoView render-tree projection core (CV-FOUND-2).
//
// This is the first piece of *runtime behavior* for the host render-tree
// projection direction (`docs/coview/foundation-plan.md` §4.6). CV-FOUND-1
// shipped the protocol/types/schemas; this module turns a single canonical host
// render frame into a single viewer's projected render frame, applying the
// production privacy boundary:
//
//   control visibility = host permissions   (controls/buttons/menus mirror as-is)
//   data visibility     = viewer permissions (data-bearing values project per viewer)
//
// Scope (deliberately narrow — see the CV-FOUND-2 row in foundation-plan §7):
//   - validate the incoming canonical frame with the CV-FOUND-1 schema;
//   - walk the tree preserving node id/kind/box/state/attrs/children EXACTLY;
//   - project each node's `value` per viewer through an injected resolver/gate;
//   - never introduce a second value source for protected slots.
//
// NOT in scope here (later PRs): producer wiring (CV-FOUND-3), broadcast path /
// viewer renderer (CV-FOUND-4), cache storage + invalidation (CV-FOUND-5), and
// any change to the legacy CoView state/broadcast path. This module is pure and
// is not wired into a live session by this PR.
//
// ---------------------------------------------------------------------------
// Security posture (foundation-plan §5)
// ---------------------------------------------------------------------------
//
//  - LOCAL never reaches projection except as a rejection. The function accepts
//    untrusted input and validates it with `CoViewCanonicalRenderFrameSchema`,
//    whose value vocabulary has no `local` arm — a frame carrying
//    `{ origin: "local" }` fails the schema and the whole frame is rejected
//    (§4.3, §5.6, §5.8). The walk below only ever sees `CoViewCanonicalValueRef`
//    (public | gated | secret); there is no `local` branch to handle.
//  - SECRET never calls the resolver/gate and never carries a value: a `secret`
//    canonical ref short-circuits to a secret-state placeholder *before* any
//    registry or resolver work, so no protected byte is ever requested (§5.5).
//  - SINGLE VALUE SOURCE for protected slots. Mirroring the value-gate invariant
//    (RP-FOUND-4, plan §7.3/§10.6), this projector takes NO host-frame value as a
//    source of truth for a gated slot: an authorized viewer's `visible` bytes can
//    only come from the injected resolver, never from the producer's frame. A
//    host-provided `value` on a gated node is therefore ignored as a value source
//    here. (`producerValueAllowed: true` host-value passthrough is a later-PR
//    concern; omitting it now is the fail-safe default.)
//  - FAIL CLOSED. A protected (`gated`/`secret`) claim on an unregistered/widened/
//    mismatched slot withholds rather than leaking; resolver `withheld`/
//    `unsupported` pass straight through. A malformed frame rejects whole.

import type {
  CoViewCanonicalRenderFrame,
  CoViewCanonicalValueRef,
  CoViewProjectedNode,
  CoViewProjectedRenderFrame,
  CoViewProjectedValue,
  CoViewPolicyRef,
  CoViewRenderNode,
  CoViewResourceRef,
  CoViewSurfaceRegistry,
  PlaceholderShape,
  ResolvedPluginResourceValue,
  ViewerContext,
} from "@uncorded/protocol";
import {
  CoViewCanonicalRenderFrameSchema,
  validateCanonicalSlotValue,
} from "@uncorded/protocol-schemas";

// ---------------------------------------------------------------------------
// Injected value resolver/gate (foundation-plan §4.6)
// ---------------------------------------------------------------------------

/**
 * One gated-value resolution request handed to the injected resolver. It carries
 * the surface/slot identity and the *claim* (policy + resource + intended
 * placeholder) — never a host-provided value. The resolver is the only authority
 * that may turn this claim into bytes, and only after authorizing the viewer.
 */
export interface CoViewGatedResolveRequest {
  /** Registered surface this node belongs to. */
  surfaceId: string;
  /** The node id, which is the slot id within the surface schema. */
  slotId: string;
  policyRef: CoViewPolicyRef;
  resourceRef: CoViewResourceRef;
  /** The author-declared placeholder shape (already validated against the slot's
   *  accepted modes) — supplied so a resolver may echo it on a withhold. */
  placeholderShape: PlaceholderShape;
}

/**
 * The runtime value authority projection depends on (foundation-plan §4.6). It
 * is deliberately abstract: a production implementation maps each
 * `CoViewResourceRef` kind to its backend (e.g. the RP-FOUND-4
 * `PluginResourceValueGate` for `pluginResource` refs, channel/message adapters
 * for the first-party kinds), but the projector neither knows nor cares which.
 *
 * It returns `ResolvedPluginResourceValue` — whose `visible`/`withheld`/
 * `unsupported` arms align 1:1 with `CoViewProjectedValue` (see
 * `@uncorded/protocol` doc comments), so projection maps the result with no
 * translation layer.
 *
 * Contract obligations (the projector relies on these, the gate already honors
 * them, RP-FOUND-4 §7.1):
 *  - authorize THEN materialize — never return `visible` for a viewer the policy
 *    would deny;
 *  - fail closed — resolver errors / missing adapters / deleted resources
 *    `withheld`, they do not throw a value open.
 */
export interface CoViewValueResolver {
  resolveGatedValue(
    viewer: ViewerContext,
    request: CoViewGatedResolveRequest,
  ): ResolvedPluginResourceValue | Promise<ResolvedPluginResourceValue>;
}

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/**
 * Outcome of projecting a canonical frame for one viewer. A malformed/unsafe
 * incoming frame (including any `origin: "local"` value, value-bearing secret,
 * unsafe attribute, or unknown node kind) rejects WHOLE (foundation-plan §5.8) —
 * projection never partially trusts a frame the schema refused.
 */
export type CoViewProjectionResult =
  | { ok: true; frame: CoViewProjectedRenderFrame }
  | { ok: false; reason: "invalid-frame"; issues: string[] };

// ---------------------------------------------------------------------------
// Projection entry point
// ---------------------------------------------------------------------------

/**
 * Project a canonical host render frame into the frame a single viewer receives.
 *
 * @param frame    Untrusted canonical frame (from a producer). Validated against
 *                 `CoViewCanonicalRenderFrameSchema` before any walk.
 * @param registry Surface schema registry (runtime-controlled config) used to
 *                 gate protected-value provenance per `validateCanonicalSlotValue`.
 * @param viewer   The viewer this frame is being projected for.
 * @param resolver The injected runtime value authority for gated values.
 *
 * Structure is preserved exactly: every node's id/kind/role/tag/box/state/attrs
 * and child order survive untouched, so every control/button/menu item the host
 * rendered reaches every viewer. Only the per-node `value` payload differs by
 * entitlement.
 */
export async function projectCanonicalRenderFrame(
  frame: unknown,
  registry: CoViewSurfaceRegistry,
  viewer: ViewerContext,
  resolver: CoViewValueResolver,
): Promise<CoViewProjectionResult> {
  // §5.8: validate the WHOLE frame first. This is also the only place an
  // `origin: "local"` value can be present, and the canonical schema rejects it
  // (no `local` arm) — so `local` reaches projection exclusively as a rejection.
  const parsed = CoViewCanonicalRenderFrameSchema.safeParse(frame);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "invalid-frame",
      issues: parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`),
    };
  }

  const canonical: CoViewCanonicalRenderFrame = parsed.data;
  const root = await projectNode(canonical.root, canonical.surfaceId, registry, viewer, resolver);
  return { ok: true, frame: { surfaceId: canonical.surfaceId, root } };
}

// ---------------------------------------------------------------------------
// Node walk — structure preserved exactly, value projected per viewer
// ---------------------------------------------------------------------------

async function projectNode(
  node: CoViewRenderNode,
  surfaceId: string,
  registry: CoViewSurfaceRegistry,
  viewer: ViewerContext,
  resolver: CoViewValueResolver,
): Promise<CoViewProjectedNode> {
  // A node with no `value` (every control/button/menu item, every pure layout
  // box) is preserved unchanged — it exists because the host UI rendered it, and
  // viewer permissions never recompute control existence (foundation-plan §2.1).
  const value =
    node.value === undefined
      ? undefined
      : await projectValue(node.value, node.id, surfaceId, registry, viewer, resolver);

  const children =
    node.children === undefined
      ? undefined
      : await Promise.all(
          node.children.map((child) => projectNode(child, surfaceId, registry, viewer, resolver)),
        );

  // Conditional spreads keep the projected node structurally identical to the
  // canonical node (omitted fields stay omitted under exactOptionalPropertyTypes).
  return {
    id: node.id,
    kind: node.kind,
    box: node.box,
    ...(node.role !== undefined ? { role: node.role } : {}),
    ...(node.tag !== undefined ? { tag: node.tag } : {}),
    ...(node.state !== undefined ? { state: node.state } : {}),
    ...(node.attrs !== undefined ? { attrs: node.attrs } : {}),
    ...(value !== undefined ? { value } : {}),
    ...(children !== undefined ? { children } : {}),
  };
}

// ---------------------------------------------------------------------------
// Per-node value projection (foundation-plan §4.6)
// ---------------------------------------------------------------------------

async function projectValue(
  value: CoViewCanonicalValueRef,
  slotId: string,
  surfaceId: string,
  registry: CoViewSurfaceRegistry,
  viewer: ViewerContext,
  resolver: CoViewValueResolver,
): Promise<CoViewProjectedValue> {
  switch (value.origin) {
    // SECRET — structurally safe by construction. Never validated against the
    // registry, never resolved: a secret canonical ref carries no value, and we
    // emit a secret-state placeholder so the resolver/gate is never consulted
    // and no protected byte is ever requested (foundation-plan §5.5).
    case "secret":
      return { state: "secret", placeholderShape: value.placeholderShape };

    // PUBLIC — ordinary host-rendered content mirrors by default (§0). It is
    // accepted wherever it lands EXCEPT on a registered protected slot, which it
    // may not widen to public. `validateCanonicalSlotValue` returns ok for public
    // on any unregistered/public slot and `origin-widened` only when it collides
    // with a registered gated/secret slot — that case fails closed.
    case "public": {
      const check = validateCanonicalSlotValue(registry, surfaceId, slotId, value);
      if (check.ok) {
        return { state: "visible", value: value.value };
      }
      // A public value on a registered protected slot — refuse to widen. The
      // public ref carries no placeholder, so withhold with a non-leaking
      // synthetic skeleton.
      return { state: "withheld", placeholderShape: { mode: "synthetic" } };
    }

    // GATED — a protected claim. Validate the slot against the registry FIRST,
    // then (only if valid) resolve through the injected authority.
    case "gated": {
      const check = validateCanonicalSlotValue(registry, surfaceId, slotId, value);
      if (!check.ok) {
        // Unknown surface/slot, widened origin, policy-ref mismatch, missing
        // resource ref, host value on a producer-disallowed slot, or an
        // unaccepted placeholder mode — every one fails closed. We MUST NOT echo
        // the producer's `value.placeholderShape`: validation failed, so it is
        // unvetted. In particular `placeholder-mode-not-accepted` fires precisely
        // when the producer's shape (e.g. `preserve-host-rect`) is one the slot
        // refused — passing it through would leak the size/existence the registry
        // rejected. Withhold with a non-leaking synthetic skeleton instead.
        return { state: "withheld", placeholderShape: { mode: "synthetic" } };
      }

      const resolved = await resolver.resolveGatedValue(viewer, {
        surfaceId,
        slotId,
        policyRef: value.policyRef,
        resourceRef: value.resourceRef,
        placeholderShape: value.placeholderShape,
      });

      switch (resolved.state) {
        case "visible":
          return { state: "visible", value: resolved.value };
        case "withheld":
          // The runtime's withhold decision wins: echo its placeholder shape.
          return { state: "withheld", placeholderShape: resolved.placeholderShape };
        case "unsupported":
          return { state: "unsupported", reason: resolved.reason };
      }
    }
  }
}
