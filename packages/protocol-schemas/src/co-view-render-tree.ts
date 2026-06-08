// Runtime validation for the CoView render-tree projection protocol types
// (CV-FOUND-1). Sibling to the type-only definitions in
// `@uncorded/protocol/co-view-render-tree`.
//
// These schemas are the runtime guard for the render-tree contract. They encode
// the security posture structurally (foundation-plan §5, §8):
//  - an incoming canonical frame carrying `{ origin: "local" }` is rejected:
//    the canonical value-ref schema has no `local` arm, so a discriminated-union
//    parse fails deterministically (§4.3, §5.6);
//  - a projected viewer value can never carry a secret value: there is no
//    value-bearing `secret` variant (§5.5);
//  - a canonical `secret` value carries no value and cannot use a
//    `preserve-host-rect` placeholder;
//  - a `gated` value requires `policyRef` + `resourceRef` + `placeholderShape`;
//  - the safe-attrs allowlist is a strict object, so unsafe attributes
//    (`href`, `src`, inline `style`, `title`, `alt`, `data-*`, …) reject;
//  - unknown / unsafe node kinds reject;
//  - the surface registry validator fails closed: `producerValueAllowed`
//    defaults to `false`, and a producer cannot widen a gated/secret slot.
//
// Shared schemas — `JsonValueSchema`, `PlaceholderShapeSchema`,
// `PluginResourceRefSchema` — are imported from the plugin-resource schema
// sibling (`./plugin-resources`, RP-FOUND-1) rather than redefined.

import { z } from "zod";
import {
  JsonValueSchema,
  PlaceholderShapeSchema,
  PluginResourceRefSchema,
} from "./plugin-resources.js";
import type {
  CoViewValueOrigin,
  CoViewPolicyRef,
  CoViewResourceRef,
  CoViewNonRectPlaceholderShape,
  CoViewCanonicalValueRef,
  CoViewNodeKind,
  CoViewControlKind,
  CoViewBox,
  CoViewNodeState,
  CoViewSafeAttrs,
  CoViewRenderNode,
  CoViewCanonicalRenderFrame,
  CoViewProjectedValue,
  CoViewProjectedNode,
  CoViewProjectedRenderFrame,
  CoViewPlaceholderMode,
  CoViewSlotOrigin,
  CoViewSurfaceSlotSchema,
  CoViewSurfaceSchema,
  CoViewSurfaceRegistry,
  CoViewSlotValidationResult,
} from "@uncorded/protocol";

// ---------------------------------------------------------------------------
// Value origins (foundation-plan §4.3)
// ---------------------------------------------------------------------------

export const CoViewValueOriginSchema = z.enum([
  "public",
  "gated",
  "secret",
  "local",
]) satisfies z.ZodType<CoViewValueOrigin>;

// ---------------------------------------------------------------------------
// Policy & resource references (foundation-plan §4.4)
// ---------------------------------------------------------------------------

export const CoViewPolicyRefSchema = z.enum([
  "server.read",
  "channel.read",
  "channel.message.read",
  "member.read",
  "album.read",
  "album.photo.read",
  "plugin.resource.read",
  "external.metadata.read",
]) satisfies z.ZodType<CoViewPolicyRef>;

// Discriminated on `kind`; the `pluginResource` arm reuses the RP-FOUND-1 ref
// schema so the two layers share one definition.
export const CoViewResourceRefSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("server"), serverId: z.string().min(1) }),
  z.strictObject({ kind: z.literal("channel"), channelId: z.string().min(1) }),
  z.strictObject({
    kind: z.literal("message"),
    channelId: z.string().min(1),
    messageId: z.string().min(1),
  }),
  z.strictObject({ kind: z.literal("member"), userId: z.string().min(1) }),
  z.strictObject({ kind: z.literal("album"), albumId: z.string().min(1) }),
  z.strictObject({
    kind: z.literal("albumPhoto"),
    albumId: z.string().min(1),
    photoId: z.string().min(1),
  }),
  PluginResourceRefSchema,
  z.strictObject({ kind: z.literal("panel"), panelId: z.string().min(1) }),
]) satisfies z.ZodType<CoViewResourceRef>;

// ---------------------------------------------------------------------------
// Canonical value references (foundation-plan §4.3)
// ---------------------------------------------------------------------------

// Synthetic or absent only — a secret value must never leak the host's exact
// rect, so `preserve-host-rect` is unrepresentable here.
export const CoViewNonRectPlaceholderShapeSchema = z.discriminatedUnion("mode", [
  z.strictObject({
    mode: z.literal("synthetic"),
    width: z.number().nonnegative().optional(),
    height: z.number().nonnegative().optional(),
    lines: z.number().int().nonnegative().optional(),
  }),
  z.strictObject({ mode: z.literal("absent") }),
]) satisfies z.ZodType<CoViewNonRectPlaceholderShape>;

/**
 * The wire-safe value vocabulary the runtime accepts on an incoming canonical
 * frame. Discriminated on `origin` with exactly the `public` / `gated` /
 * `secret` arms — there is NO `local` arm, so `{ origin: "local" }` fails to
 * match any branch and is rejected deterministically (foundation-plan §4.3,
 * §5.6).
 */
// Arms are strict: an extra key (notably a `value` on the `secret` arm) is
// REJECTED, not silently stripped — malformed frames reject whole (§5.8).
export const CoViewCanonicalValueRefSchema = z.discriminatedUnion("origin", [
  z.strictObject({ origin: z.literal("public"), value: JsonValueSchema }),
  z.strictObject({
    origin: z.literal("gated"),
    policyRef: CoViewPolicyRefSchema,
    resourceRef: CoViewResourceRefSchema,
    // Optional host-provided value; only legal when the surface schema sets
    // `producerValueAllowed: true` (enforced by `validateCanonicalSlotValue`).
    value: JsonValueSchema.optional(),
    placeholderShape: PlaceholderShapeSchema,
  }),
  z.strictObject({
    origin: z.literal("secret"),
    // No `value` field exists on this arm — a secret carries no value, and a
    // stray `value` key is rejected.
    placeholderShape: CoViewNonRectPlaceholderShapeSchema,
  }),
]) satisfies z.ZodType<CoViewCanonicalValueRef>;

// ---------------------------------------------------------------------------
// Render-node primitives (foundation-plan §4.1, §4.2)
// ---------------------------------------------------------------------------

export const CoViewNodeKindSchema = z.enum([
  "element",
  "text",
  "image",
  "canvas",
  "icon",
  "control",
]) satisfies z.ZodType<CoViewNodeKind>;

export const CoViewControlKindSchema = z.enum([
  "button",
  "menuitem",
  "tab",
  "input",
  "select",
  "toolbar",
]) satisfies z.ZodType<CoViewControlKind>;

export const CoViewBoxSchema = z.strictObject({
  x: z.number(),
  y: z.number(),
  width: z.number().nonnegative(),
  height: z.number().nonnegative(),
}) satisfies z.ZodType<CoViewBox>;

// Strict: an unknown state flag rejects rather than silently riding along.
export const CoViewNodeStateSchema = z.strictObject({
  hovered: z.boolean().optional(),
  focused: z.boolean().optional(),
  pressed: z.boolean().optional(),
  selected: z.boolean().optional(),
  open: z.boolean().optional(),
  disabled: z.boolean().optional(),
  scroll: z.strictObject({ x: z.number(), y: z.number() }).optional(),
}) satisfies z.ZodType<CoViewNodeState>;

/**
 * Strict allowlist (foundation-plan §4.2): only these attributes may travel.
 * `z.strictObject` rejects any other key, so unsafe/data-bearing attributes
 * (`href`, `src`, `style`, `title`, `alt`, `ariaLabel`, `data-*`, …) are
 * rejected, never smuggled through.
 */
export const CoViewSafeAttrsSchema = z.strictObject({
  classTokens: z.array(z.string()).optional(),
  ariaRole: z.string().optional(),
  ariaExpanded: z.boolean().optional(),
  ariaChecked: z.boolean().optional(),
  controlKind: CoViewControlKindSchema.optional(),
  placeholderShape: PlaceholderShapeSchema.optional(),
}) satisfies z.ZodType<CoViewSafeAttrs>;

// ---------------------------------------------------------------------------
// Canonical host render tree (foundation-plan §4.1)
// ---------------------------------------------------------------------------

// Recursive: annotated as `z.ZodType<CoViewRenderNode>` so the self-reference in
// `children` type-checks. Strict so raw DOM attributes can't ride on a node.
export const CoViewRenderNodeSchema: z.ZodType<CoViewRenderNode> = z.lazy(() =>
  z.strictObject({
    id: z.string().min(1),
    kind: CoViewNodeKindSchema,
    role: z.string().optional(),
    tag: z.string().optional(),
    box: CoViewBoxSchema,
    state: CoViewNodeStateSchema.optional(),
    attrs: CoViewSafeAttrsSchema.optional(),
    value: CoViewCanonicalValueRefSchema.optional(),
    children: z.array(CoViewRenderNodeSchema).optional(),
  }),
);

export const CoViewCanonicalRenderFrameSchema = z.strictObject({
  surfaceId: z.string().min(1),
  root: CoViewRenderNodeSchema,
}) satisfies z.ZodType<CoViewCanonicalRenderFrame>;

// ---------------------------------------------------------------------------
// Projected viewer render tree (foundation-plan §4.6) — secret-safe
// ---------------------------------------------------------------------------

/**
 * The per-viewer projected value. The ONLY value-bearing arm is `visible`;
 * `withheld` / `secret` carry only a placeholder, `unsupported` only a reason.
 * There is no variant that carries a secret value toward a viewer
 * (foundation-plan §5.5).
 */
export const CoViewProjectedValueSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("visible"), value: JsonValueSchema }),
  z.strictObject({ state: z.literal("withheld"), placeholderShape: PlaceholderShapeSchema }),
  // No `value` field — a secret never resolves to a value on the viewer wire;
  // a stray `value` key is rejected, not stripped.
  z.strictObject({ state: z.literal("secret"), placeholderShape: PlaceholderShapeSchema }),
  z.strictObject({ state: z.literal("unsupported"), reason: z.string() }),
]) satisfies z.ZodType<CoViewProjectedValue>;

export const CoViewProjectedNodeSchema: z.ZodType<CoViewProjectedNode> = z.lazy(() =>
  z.strictObject({
    id: z.string().min(1),
    kind: CoViewNodeKindSchema,
    role: z.string().optional(),
    tag: z.string().optional(),
    box: CoViewBoxSchema,
    state: CoViewNodeStateSchema.optional(),
    attrs: CoViewSafeAttrsSchema.optional(),
    value: CoViewProjectedValueSchema.optional(),
    children: z.array(CoViewProjectedNodeSchema).optional(),
  }),
);

export const CoViewProjectedRenderFrameSchema = z.strictObject({
  surfaceId: z.string().min(1),
  root: CoViewProjectedNodeSchema,
}) satisfies z.ZodType<CoViewProjectedRenderFrame>;

// ---------------------------------------------------------------------------
// Surface schema registry (foundation-plan §4.9)
// ---------------------------------------------------------------------------

export const CoViewPlaceholderModeSchema = z.enum([
  "synthetic",
  "preserve-host-rect",
  "absent",
]) satisfies z.ZodType<CoViewPlaceholderMode>;

export const CoViewSlotOriginSchema = z.enum([
  "public",
  "gated",
  "secret",
]) satisfies z.ZodType<CoViewSlotOrigin>;

/**
 * A registered slot. A `gated` slot MUST declare its policy and require a
 * resource ref (foundation-plan §4.3 gated-value rule); the refine enforces that
 * shape requirement at registration time. `producerValueAllowed` is optional and
 * defaults to `false` in `validateCanonicalSlotValue`.
 */
export const CoViewSurfaceSlotSchemaSchema = z
  .strictObject({
    slotId: z.string().min(1),
    origin: CoViewSlotOriginSchema,
    policyRef: CoViewPolicyRefSchema.optional(),
    resourceRefRequired: z.boolean().optional(),
    placeholderModes: z.array(CoViewPlaceholderModeSchema),
    producerValueAllowed: z.boolean().optional(),
  })
  .refine(
    (s) => s.origin !== "gated" || (s.policyRef !== undefined && s.resourceRefRequired === true),
    {
      message: "a gated slot must declare policyRef and set resourceRefRequired: true",
      path: ["origin"],
    },
  ) satisfies z.ZodType<CoViewSurfaceSlotSchema>;

export const CoViewSurfaceSchemaSchema = z
  .strictObject({
    surfaceId: z.string().min(1),
    nodeKinds: z.array(CoViewNodeKindSchema).optional(),
    slots: z.array(CoViewSurfaceSlotSchemaSchema),
  })
  .refine(
    (s) => new Set(s.slots.map((slot) => slot.slotId)).size === s.slots.length,
    { message: "slot ids must be unique within a surface", path: ["slots"] },
  ) satisfies z.ZodType<CoViewSurfaceSchema>;

// The map key must equal the inner `surfaceId` — they are two names for the same
// surface, and a mismatch is a registry-authoring bug (the validator looks a
// surface up by key, so a drifted `surfaceId` would silently never be reached).
export const CoViewSurfaceRegistrySchema = z
  .strictObject({
    surfaces: z.record(z.string().min(1), CoViewSurfaceSchemaSchema),
  })
  .refine(
    (r) => Object.entries(r.surfaces).every(([key, surface]) => key === surface.surfaceId),
    { message: "registry key must equal the surface's surfaceId", path: ["surfaces"] },
  ) satisfies z.ZodType<CoViewSurfaceRegistry>;

// ---------------------------------------------------------------------------
// Registry validation (foundation-plan §4.9, §5.8) — fail-closed
// ---------------------------------------------------------------------------

// Permissiveness rank, most → least permissive: public > gated > secret. A
// producer may not ship a value *more* permissive than the slot's declared
// origin (that would be widening).
const ORIGIN_RANK: Readonly<Record<CoViewSlotOrigin, number>> = {
  secret: 0,
  gated: 1,
  public: 2,
};

/**
 * Validate a canonical value against the surface registry for `(surfaceId,
 * slotId)`. This is the gate for *protected provenance only* — it does NOT
 * decide whether ordinary UI may travel (foundation-plan §0, drift guard):
 *
 *  - Host-rendered structure and ordinary `public`/unmarked content MIRROR by
 *    default. A `public` value is accepted wherever it lands and is constrained
 *    in exactly one case: it must not occupy a registered *protected*
 *    (`gated`/`secret`) slot (that would be widening). It is never withheld for
 *    want of a registry entry — unmarked plugin output is ordinary UI, not
 *    magically private.
 *  - A `gated`/`secret` value is a *protected claim*. Protected claims require a
 *    registered slot, so an unknown surface/slot fails closed for them.
 *
 * Fail-closed for protected claims: a widened origin, a host-provided value on a
 * slot whose `producerValueAllowed` is not explicitly `true`, an unaccepted
 * placeholder mode, or a gated slot/value missing its policy/resource shape all
 * return `{ ok: false, reason }`. `producerValueAllowed` is treated as `false`
 * when omitted, so omission never becomes accidental exposure.
 *
 * Pure and additive: this is the schema-contract-level guard CV-FOUND-2's
 * runtime projection will build on; it changes no runtime behavior here.
 */
export function validateCanonicalSlotValue(
  registry: CoViewSurfaceRegistry,
  surfaceId: string,
  slotId: string,
  value: CoViewCanonicalValueRef,
): CoViewSlotValidationResult {
  const surface = registry.surfaces[surfaceId];
  const slot = surface?.slots.find((s) => s.slotId === slotId);

  // Ordinary public / unmarked content mirrors by default. It is accepted
  // wherever it lands EXCEPT on a registered protected slot, which it may not
  // widen. Crucially, a public value on an unregistered surface/slot is ordinary
  // mirrored UI — `ok: true`, never `unknown-slot`. The registry gate governs
  // protected provenance, not every rendered value.
  if (value.origin === "public") {
    if (slot && slot.origin !== "public") {
      return { ok: false, reason: "origin-widened" };
    }
    return { ok: true };
  }

  // A gated/secret value is a protected claim and REQUIRES a registered slot:
  // fail closed if the surface or slot is unknown.
  if (!surface) return { ok: false, reason: "unknown-surface" };
  if (!slot) return { ok: false, reason: "unknown-slot" };

  // A producer cannot widen a registered gated/secret slot toward public.
  if (ORIGIN_RANK[value.origin] > ORIGIN_RANK[slot.origin]) {
    return { ok: false, reason: "origin-widened" };
  }

  // A gated slot must carry its policy shape (registry-time invariant; checked
  // again here defensively in case an unvalidated registry is passed in).
  if (slot.origin === "gated" && slot.policyRef === undefined) {
    return { ok: false, reason: "missing-policy-ref" };
  }

  if (value.origin === "gated") {
    // A gated value must be evaluated against the slot's REGISTERED authority —
    // a producer cannot swap in a different policy than the slot was registered
    // with. (slot.policyRef is defined here: a gated slot with an undefined
    // policyRef already failed `missing-policy-ref` above.)
    if (slot.origin === "gated" && slot.policyRef !== value.policyRef) {
      return { ok: false, reason: "policy-ref-mismatch" };
    }
    // Defensive against loosely-typed/JSON input: a gated value must carry a
    // resource ref unless the slot explicitly opts out.
    if (slot.resourceRefRequired !== false && value.resourceRef === undefined) {
      return { ok: false, reason: "missing-resource-ref" };
    }
    // Host-provided value on a runtime-resolved slot fails closed by default.
    if (value.value !== undefined && slot.producerValueAllowed !== true) {
      return { ok: false, reason: "producer-value-not-allowed" };
    }
  }

  // Placeholder mode must be one the slot accepts (gated/secret carry one).
  const placeholderShape =
    value.origin === "gated" || value.origin === "secret" ? value.placeholderShape : undefined;
  if (placeholderShape !== undefined && !slot.placeholderModes.includes(placeholderShape.mode)) {
    return { ok: false, reason: "placeholder-mode-not-accepted" };
  }

  return { ok: true };
}
