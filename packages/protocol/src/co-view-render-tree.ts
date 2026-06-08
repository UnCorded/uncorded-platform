// CoView render-tree projection protocol types (CV-FOUND-1).
//
// Additive contract layer for the host render-tree projection direction
// described in `docs/coview/foundation-plan.md`. This file defines *types only*
// — no runtime behavior, no projection engine, no producer, no viewer renderer,
// no entitlement cache. Those land in later CV-FOUND-N PRs.
//
// The model (foundation-plan §0, §2, drift guard):
//   control visibility = host permissions   (controls/buttons/menus mirror)
//   data visibility     = viewer permissions (data-bearing values project)
//   action execution    = viewer permissions / CoView collaboration policy
//
// This is NOT viewer-specific UI reconstruction and NOT raw DOM serialization.
// The host publishes a *sanitized render tree* that preserves the structure and
// control/interaction state it actually rendered; the runtime later projects
// only the *data-bearing values* per viewer. Controls exist because the host UI
// rendered them, never because a viewer was entitled.
//
// Mirror-by-default contract (foundation-plan §0): host-rendered structure and
// ordinary content mirror to viewers by default. Only values a plugin author
// explicitly marks as protected — `gated` (resource-scoped) or `secret` — are
// withheld/projected per viewer. Unmarked output is `public`: ordinary UI that
// travels as-is. Nothing is "magically private" for lacking a registry entry —
// protecting data is an explicit act (mark it with the resource primitives), and
// the surface registry below constrains *registered protected slots*, not every
// rendered value.
//
// Two frame shapes live here:
//   - Canonical host render frame  (what the producer emits toward the runtime)
//   - Projected viewer render frame (what the runtime sends to one viewer)
// They share node identity/kind/structure/state/attrs; they differ only in the
// value type each node carries.
//
// Security semantics encoded structurally (foundation-plan §5):
//   - `local` values never leave the producer: the canonical *wire* value type
//     (`CoViewCanonicalValueRef`) has no `local` arm, so an incoming canonical
//     frame carrying `{ origin: "local" }` is unrepresentable / rejected.
//   - `secret` values are unrepresentable on the viewer wire: the projected
//     value type has no variant that carries a secret value, and a canonical
//     `secret` ref carries no `value` and cannot use a `preserve-host-rect`
//     placeholder.
//   - `gated` values require `policyRef` + `resourceRef` + `placeholderShape`.
//   - Host-provided values on runtime-resolved slots fail closed: the surface
//     registry's `producerValueAllowed` defaults to `false` (validated in the
//     companion schema package).
//
// Shared primitives — `JsonValue`, `PlaceholderShape`, and the plugin
// `PluginResourceRef` arm — are imported from the plugin-resource foundation
// (`./plugin-resources`, RP-FOUND-1) rather than redefined, exactly as that
// file anticipated ("CoView can include it by reference when CV-FOUND-1 lands").

import type { JsonValue, PlaceholderShape, PluginResourceRef } from "./plugin-resources.js";

// ---------------------------------------------------------------------------
// Value origins (foundation-plan §4.3)
// ---------------------------------------------------------------------------

/**
 * Provenance class of a data-bearing value, decided by the host/producer:
 *  - `public`: ordinary, unmarked host-rendered content (labels, text, captions).
 *    Mirrors to all viewers as-is and needs no registry entry — this is the
 *    default for anything a plugin author has not explicitly marked protected.
 *  - `gated`: travels only to viewers authorized for `policyRef` + `resourceRef`;
 *    unauthorized viewers receive the placeholder instead.
 *  - `secret`: structurally unrepresentable on the viewer wire — carries no value
 *    and resolves only to a placeholder/absent.
 *  - `local`: never leaves the producer; not representable on the canonical wire.
 */
export type CoViewValueOrigin = "public" | "gated" | "secret" | "local";

/**
 * Canonical ordered list of value origins. Frozen so it cannot be mutated at use
 * sites; layers iterate this rather than hard-coding the strings.
 */
export const CO_VIEW_VALUE_ORIGINS: readonly CoViewValueOrigin[] = [
  "public",
  "gated",
  "secret",
  "local",
] as const;

// ---------------------------------------------------------------------------
// Policy & resource references (foundation-plan §4.4)
// ---------------------------------------------------------------------------

/**
 * The concrete authority reference a gated value is evaluated against. A fixed
 * vocabulary for V1 (foundation-plan §4.4); plugin data uses
 * `"plugin.resource.read"` paired with a `pluginResource` `CoViewResourceRef`.
 * A reference is a *claim about identity*, never a grant (plan §5).
 */
export type CoViewPolicyRef =
  | "server.read"
  | "channel.read"
  | "channel.message.read"
  | "member.read"
  | "album.read"
  | "album.photo.read"
  | "plugin.resource.read"
  | "external.metadata.read";

/**
 * Canonical ordered list of policy refs. Frozen.
 */
export const CO_VIEW_POLICY_REFS: readonly CoViewPolicyRef[] = [
  "server.read",
  "channel.read",
  "channel.message.read",
  "member.read",
  "album.read",
  "album.photo.read",
  "plugin.resource.read",
  "external.metadata.read",
] as const;

/**
 * Identity of the resource backing a gated value (foundation-plan §4.4). V1
 * resolution is scoped to the CoView session's current server/workspace; cross-
 * server resources are malformed unless explicitly designed later. The
 * `pluginResource` arm reuses `PluginResourceRef` from the plugin-resource
 * foundation rather than redefining it.
 */
export type CoViewResourceRef =
  | { kind: "server"; serverId: string }
  | { kind: "channel"; channelId: string }
  | { kind: "message"; channelId: string; messageId: string }
  | { kind: "member"; userId: string }
  | { kind: "album"; albumId: string }
  | { kind: "albumPhoto"; albumId: string; photoId: string }
  | PluginResourceRef
  | { kind: "panel"; panelId: string };

// ---------------------------------------------------------------------------
// Canonical value references (foundation-plan §4.3) — producer/host side
// ---------------------------------------------------------------------------

/**
 * A placeholder shape that does NOT preserve the host's exact rect. Used for
 * `secret` values, which must never leak the real size/existence of protected
 * content (foundation-plan §4.3: `Exclude<PlaceholderShape, "preserve-host-rect">`).
 */
export type CoViewNonRectPlaceholderShape = Exclude<PlaceholderShape, { mode: "preserve-host-rect" }>;

/**
 * The data-bearing value a host attaches to a render node, in the producer's
 * full vocabulary (foundation-plan §4.3). This is the *producer-internal*
 * representation: it still includes the `local` arm, because a producer may hold
 * a local value before its serializer drops it. It must never reach the runtime
 * — see `CoViewCanonicalValueRef` for the wire-safe subset.
 *
 *  - `public`: carries its value; travels to everyone.
 *  - `gated`: carries `policyRef` + `resourceRef` + `placeholderShape`; `value`
 *    is OPTIONAL and only permitted when the surface schema sets
 *    `producerValueAllowed: true` (otherwise the value is runtime-resolved).
 *  - `secret`: carries no value; placeholder cannot be `preserve-host-rect`.
 *  - `local`: carries nothing; never leaves the producer.
 */
export type CoViewValueRef =
  | { origin: "public"; value: JsonValue }
  | {
      origin: "gated";
      policyRef: CoViewPolicyRef;
      resourceRef: CoViewResourceRef;
      value?: JsonValue | undefined;
      placeholderShape: PlaceholderShape;
    }
  | { origin: "secret"; placeholderShape: CoViewNonRectPlaceholderShape }
  | { origin: "local" };

/**
 * The value-reference subset that is legal on an *incoming canonical frame* —
 * i.e. the wire-safe value vocabulary the runtime will accept from a producer.
 * It is `CoViewValueRef` minus the `local` arm: a canonical frame carrying
 * `{ origin: "local" }` is malformed and is rejected deterministically by the
 * companion schema (foundation-plan §4.3, §5.6). `local` may be dropped by the
 * producer serializer before send; it must never be silently dropped by the
 * runtime, so it is structurally absent here rather than tolerated.
 */
export type CoViewCanonicalValueRef = Exclude<CoViewValueRef, { origin: "local" }>;

// ---------------------------------------------------------------------------
// Render-node primitives (foundation-plan §4.1, §4.2)
// ---------------------------------------------------------------------------

/**
 * Safe node kinds (foundation-plan §4.1). An explicit allowlist; unknown/unsafe
 * kinds (`script`, `iframe`, `object`, …) are rejected by the companion schema.
 */
export type CoViewNodeKind = "element" | "text" | "image" | "canvas" | "icon" | "control";

/**
 * Canonical ordered list of safe node kinds. Frozen.
 */
export const CO_VIEW_NODE_KINDS: readonly CoViewNodeKind[] = [
  "element",
  "text",
  "image",
  "canvas",
  "icon",
  "control",
] as const;

/**
 * Control kind for a control/menu/toolbar node (foundation-plan §4.2). Allowlist;
 * controls mirror from the host UI regardless of viewer permission.
 */
export type CoViewControlKind = "button" | "menuitem" | "tab" | "input" | "select" | "toolbar";

/**
 * Canonical ordered list of control kinds. Frozen.
 */
export const CO_VIEW_CONTROL_KINDS: readonly CoViewControlKind[] = [
  "button",
  "menuitem",
  "tab",
  "input",
  "select",
  "toolbar",
] as const;

/**
 * Layout box for a node (foundation-plan §4.1). May leak existence/size; the
 * surface schema controls sensitive cases.
 */
export interface CoViewBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Host-rendered interaction/control state mirrored to viewers (foundation-plan
 * §4.1, §4.5). This reflects host UI state; it does NOT grant a viewer authority
 * to execute the control. Every field is optional — absence means "not in that
 * state."
 */
export interface CoViewNodeState {
  hovered?: boolean | undefined;
  focused?: boolean | undefined;
  pressed?: boolean | undefined;
  selected?: boolean | undefined;
  open?: boolean | undefined;
  disabled?: boolean | undefined;
  scroll?: { x: number; y: number } | undefined;
}

/**
 * The ONLY attributes allowed to travel (foundation-plan §4.2). A strict
 * allowlist enforced by the companion schema: raw `href`, `src`, inline styles,
 * `title`, `alt`, `aria-label`, `data-*`, and arbitrary attributes are data-
 * bearing until proven otherwise — they must become a `CoViewValueRef` or be
 * dropped, never smuggled through here.
 */
export interface CoViewSafeAttrs {
  classTokens?: string[] | undefined;
  ariaRole?: string | undefined;
  ariaExpanded?: boolean | undefined;
  ariaChecked?: boolean | undefined;
  controlKind?: CoViewControlKind | undefined;
  placeholderShape?: PlaceholderShape | undefined;
}

// ---------------------------------------------------------------------------
// Canonical host render tree (foundation-plan §4.1) — producer → runtime
// ---------------------------------------------------------------------------

/**
 * A node in the canonical host render tree (foundation-plan §4.1). This is a
 * renderer-safe tree, NOT raw DOM: it preserves host-rendered structure, control
 * state, and layout while dropping dangerous browser internals. `value` carries
 * a wire-safe `CoViewCanonicalValueRef` (no `local`); controls carry no value
 * and exist purely because the host UI rendered them.
 */
export interface CoViewRenderNode {
  /** Stable node identity, preserved through projection so the same node can
   *  carry per-viewer value differences without changing structure. */
  id: string;
  kind: CoViewNodeKind;
  role?: string | undefined;
  tag?: string | undefined;
  box: CoViewBox;
  state?: CoViewNodeState | undefined;
  attrs?: CoViewSafeAttrs | undefined;
  /** Data-bearing value, if any. Wire-safe vocabulary only (no `local`). */
  value?: CoViewCanonicalValueRef | undefined;
  children?: CoViewRenderNode[] | undefined;
}

/**
 * A canonical host render frame (foundation-plan §4.6). Names the surface (so
 * the runtime can validate it against the registry) and the host-rendered tree
 * the runtime will project per viewer. Additive: legacy `CoViewStateSnapshot` /
 * `CoViewStateDiff` (`Record<string, unknown>`) are untouched by this PR.
 */
export interface CoViewCanonicalRenderFrame {
  /** Registered surface id (foundation-plan §4.9). */
  surfaceId: string;
  root: CoViewRenderNode;
}

// ---------------------------------------------------------------------------
// Projected viewer render tree (foundation-plan §4.6) — runtime → one viewer
// ---------------------------------------------------------------------------

/**
 * The per-viewer projected value (foundation-plan §4.6). Deliberately aligned
 * with the resource layer's `ResolvedPluginResourceValue` so projection maps
 * resolver output without a translation layer.
 *
 * SECURITY — no variant carries a secret or local value toward a viewer:
 *  - `visible` is the only value-bearing arm; it is reached strictly after an
 *    allow decision for a non-secret value. A `secret` value never becomes
 *    `visible` because a canonical `secret` ref carries no value to project.
 *  - `withheld` / `secret` carry only a placeholder shape, never a value.
 *  - `unsupported` carries only a reason string.
 */
export type CoViewProjectedValue =
  | { state: "visible"; value: JsonValue }
  | { state: "withheld"; placeholderShape: PlaceholderShape }
  | { state: "secret"; placeholderShape: PlaceholderShape }
  | { state: "unsupported"; reason: string };

/**
 * A node in the projected viewer render tree. Identical to `CoViewRenderNode` in
 * identity/kind/structure/state/attrs — the difference is purely the value type:
 * a projected node carries a `CoViewProjectedValue`, never a canonical ref. This
 * is what lets the SAME structure (including every control/button/menu item)
 * reach every viewer while only data values differ per entitlement.
 */
export interface CoViewProjectedNode {
  id: string;
  kind: CoViewNodeKind;
  role?: string | undefined;
  tag?: string | undefined;
  box: CoViewBox;
  state?: CoViewNodeState | undefined;
  attrs?: CoViewSafeAttrs | undefined;
  value?: CoViewProjectedValue | undefined;
  children?: CoViewProjectedNode[] | undefined;
}

/**
 * A projected viewer render frame (foundation-plan §4.6). Preserves surface id
 * and node identity/structure; only the per-node value payload differs from the
 * canonical frame.
 */
export interface CoViewProjectedRenderFrame {
  surfaceId: string;
  root: CoViewProjectedNode;
}

// ---------------------------------------------------------------------------
// Surface schema registry skeleton (foundation-plan §4.9)
// ---------------------------------------------------------------------------

/**
 * Placeholder modes a slot may accept (foundation-plan §4.9, "accepted
 * placeholder modes" / "accepted size/existence leaks"). Mirrors the discriminant
 * of `PlaceholderShape`.
 */
export type CoViewPlaceholderMode = "synthetic" | "preserve-host-rect" | "absent";

/**
 * The provenance class a registered slot may declare. A registered slot is never
 * `local` (local values never leave the producer, so they are not projectable
 * and not registrable). Permissiveness order, most → least: `public` > `gated` >
 * `secret`.
 */
export type CoViewSlotOrigin = "public" | "gated" | "secret";

/**
 * One registered value slot on a surface (foundation-plan §4.9). The registry is
 * NOT a schema for rebuilding a viewer UI — it validates render-tree and value
 * provenance. A slot declares its origin, the policy/resource shape a gated slot
 * requires, the placeholder modes it accepts, and whether the host may provide
 * the value directly.
 */
export interface CoViewSurfaceSlotSchema {
  slotId: string;
  /** Declared provenance class. A producer may not *widen* this (e.g. ship a
   *  `public` value for a `gated`/`secret` slot) — see the companion validator. */
  origin: CoViewSlotOrigin;
  /** Required when `origin === "gated"`: the policy a viewer is evaluated against. */
  policyRef?: CoViewPolicyRef | undefined;
  /** Whether a gated value on this slot must carry a `resourceRef`. Required to
   *  be `true` for a gated slot (foundation-plan §4.3 gated-value rule). */
  resourceRefRequired?: boolean | undefined;
  /** Placeholder modes this slot accepts for a withheld value. */
  placeholderModes: CoViewPlaceholderMode[];
  /**
   * Whether the host/producer may provide the protected value directly (`true`)
   * or it must be runtime-resolved (`false`/omitted). DEFAULTS TO `false`
   * (foundation-plan §4.9, §5.8): omission must never become accidental
   * exposure. The companion validator treats `undefined` as `false`.
   */
  producerValueAllowed?: boolean | undefined;
}

/**
 * A registered surface schema (foundation-plan §4.9). Declares the surface id,
 * the node kinds the surface is allowed to emit (omitted = all safe kinds), and
 * its value slots. Unregistered surfaces / slots fail closed in the validator.
 */
export interface CoViewSurfaceSchema {
  surfaceId: string;
  /** Allowed node kinds for this surface. Omitted = all `CO_VIEW_NODE_KINDS`. */
  nodeKinds?: CoViewNodeKind[] | undefined;
  slots: CoViewSurfaceSlotSchema[];
}

/**
 * A registry of surface schemas, keyed by `surfaceId`. The companion validator
 * uses it to reject unknown surfaces, unknown slots, and widened origins.
 */
export interface CoViewSurfaceRegistry {
  surfaces: Record<string, CoViewSurfaceSchema>;
}

/**
 * Outcome of validating a canonical slot value against the surface registry
 * (companion `validateCanonicalSlotValue`). The validator gates *protected
 * provenance* only: `unknown-surface` / `unknown-slot` deny a `gated`/`secret`
 * claim that has no registered slot — they do NOT fire for ordinary `public`
 * content, which mirrors by default. For a protected claim the result is
 * fail-closed: any reason other than `ok: true` denies. Reserving the sentinels
 * guarantees a deny path is always representable.
 */
export type CoViewSlotValidationReason =
  | "unknown-surface"
  | "unknown-slot"
  | "origin-widened"
  | "producer-value-not-allowed"
  | "placeholder-mode-not-accepted"
  | "missing-policy-ref"
  | "missing-resource-ref";

export type CoViewSlotValidationResult =
  | { ok: true }
  | { ok: false; reason: CoViewSlotValidationReason };
