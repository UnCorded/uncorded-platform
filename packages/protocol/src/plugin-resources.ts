// Plugin resource permission protocol types (RP-FOUND-1).
//
// Additive type layer for the plugin resource permission foundation described
// in `docs/plugins/resource-permissions-plan.md`. This file defines *identity,
// vocabulary, and decision shapes only* — no runtime behavior, no resolver, no
// store, no SDK surface. Those land in later RP-FOUND-N PRs.
//
// The runtime is the grant authority (plan §10.1). Nothing here grants
// anything: a `PluginResourceRef` / `ValueSlotRef` is a *claim about identity*,
// never a grant. These types only let the wire and the runtime *talk about*
// resource identity, actions, and version-stamped authorization decisions.
//
// Alignment: these shapes are deliberately compatible with the CoView render-
// tree projection plan (`docs/coview/foundation-plan.md` §4.3/§4.4). CoView's
// `ResourceRef` plugin kind, `PlaceholderShape`, and `JsonValue` live here so
// CoView's eventual CV-FOUND-1 types reuse them rather than redefine them.
//
// Security semantics encoded structurally (plan §10):
//  - Unknown resource / unknown action will fail closed in the future
//    resolver; the reason vocabulary (`AuthDecisionReason`) reserves the
//    `unknown-resource` / `unknown-action` / `banned` / `stale` / `error`
//    sentinels so a deny path is always representable.
//  - Secret values are *unrepresentable* on the viewer-facing resolved value
//    type: `ResolvedPluginResourceValue` has no variant that carries a secret
//    value to a viewer (see the type's doc comment).
//  - `producerValueAllowed` defaults to `false` in the future registry/store;
//    the registration type documents this and the field is required so a
//    registration cannot silently omit it into accidental exposure.

// ---------------------------------------------------------------------------
// JSON value (shared)
// ---------------------------------------------------------------------------

/**
 * A plain JSON-serializable value. Shared with the CoView projection plan,
 * which references `JsonValue` for `CoViewValueRef` / `CoViewProjectedValue`.
 * Defined here (the resource layer is the first consumer) so later CoView
 * protocol types import it instead of redefining it.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

// ---------------------------------------------------------------------------
// Resource identity (plan §4.1)
// ---------------------------------------------------------------------------

/**
 * The stable identity tuple for a plugin resource. Scoped to exactly one
 * server/workspace (`serverId`); cross-server resources are out of scope for
 * V1 (plan §3, §4.3). `resourceId` is plugin-assigned and opaque to the
 * runtime.
 */
export interface PluginResourceKey {
  /** Server/workspace scope. Part of the key, every ACL row, every cache key. */
  serverId: string;
  /** Owning plugin slug, e.g. "family-album". */
  pluginSlug: string;
  /** Registered resource type, e.g. "album" | "photo". Namespacing under the
   *  plugin slug is enforced at registration, not encoded in this field. */
  resourceType: string;
  /** Plugin-assigned stable id, opaque to the runtime. */
  resourceId: string;
}

/**
 * The reference shape that travels on the wire / in a CoView render tree. It is
 * `PluginResourceKey` minus `serverId`: the runtime re-attaches scope from the
 * calling session context (plan §4.1). A ref that arrives carrying a mismatched
 * or cross-server scope is malformed and is rejected by the future resolver.
 *
 * This is the `kind: "pluginResource"` arm of CoView's `ResourceRef` union
 * (foundation-plan §4.4); kept as a standalone interface so this layer can name
 * it without depending on the full CoView union, and so CoView can include it
 * by reference when CV-FOUND-1 lands.
 */
export interface PluginResourceRef {
  kind: "pluginResource";
  pluginSlug: string;
  resourceType: string;
  resourceId: string;
}

// ---------------------------------------------------------------------------
// Action vocabulary (plan §5)
// ---------------------------------------------------------------------------

/**
 * Base action vocabulary every resource type supports (plan §5.1). These are
 * the verbs CoView and other runtime systems reason about. Actions are NOT a
 * strict hierarchy by default — `admin` does not imply `read` unless a
 * registration declares the implication explicitly (see
 * `PluginResourceTypeRegistration.actionImplications`).
 */
export type BasePluginResourceAction =
  | "read"
  | "comment"
  | "edit"
  | "share"
  | "admin";

/**
 * Canonical ordered list of base actions. Runtime/schema layers iterate this
 * rather than hard-coding the strings. Frozen so it cannot be mutated at use
 * sites.
 */
export const BASE_PLUGIN_RESOURCE_ACTIONS: readonly BasePluginResourceAction[] = [
  "read",
  "comment",
  "edit",
  "share",
  "admin",
] as const;

/**
 * A plugin-defined action. Always a *registered, namespaced* string of the form
 * `pluginSlug:action` (plan §5.2), e.g. "family-album:download". This is a
 * naked `string` at the type level — the namespacing rule and "must exist in
 * the registry" rule are enforced by the schema and the future registry, not by
 * the type system. An unregistered action string fails closed exactly like an
 * unregistered capability; there is no free-form `check(user, "whatever")`.
 */
export type CustomPluginResourceAction = string;

/**
 * Either a base action or a registered, namespaced plugin action. Note this
 * collapses to `string` structurally (custom actions are strings); the literal
 * `BasePluginResourceAction` arm is kept for documentation and editor
 * autocomplete of the well-known verbs.
 */
export type PluginResourceAction =
  | BasePluginResourceAction
  | CustomPluginResourceAction;

// ---------------------------------------------------------------------------
// Value slots & placeholders (plan §4.5, CoView foundation-plan §4.3)
// ---------------------------------------------------------------------------

/**
 * Shape a withheld value is replaced with so the viewer UI keeps the host's
 * layout without receiving protected content. Mirrors CoView's `PlaceholderShape`
 * (foundation-plan §4.3); defined here so both layers share one definition.
 *
 *  - `synthetic`: a same-intent skeleton; optional dims/lines hints. Default
 *    for protected values — leaks no real size unless given hints.
 *  - `preserve-host-rect`: keep the host's exact rect. Allowed ONLY when the
 *    schema explicitly accepts the size/existence leak (`sizeLeakAccepted` is a
 *    `true` literal so omission cannot opt in by accident).
 *  - `absent`: render nothing in place of the value.
 */
export type PlaceholderShape =
  | { mode: "synthetic"; width?: number | undefined; height?: number | undefined; lines?: number | undefined }
  | { mode: "preserve-host-rect"; sizeLeakAccepted: true; reason: string }
  | { mode: "absent" };

/**
 * A reference to a single data-bearing value slot on a specific resource (plan
 * §4.5, §7.1). This is what CoView passes per gated value when asking the
 * resolver to materialize a slot. `slot` names a field declared in the
 * resource type's registration (e.g. "title", "pixels", "caption"); the
 * registry maps it to a `policyRef`, so the caller does not carry the policy.
 *
 * Deviation note: the plan's resolver sketch (§7.1) passes `resourceRef` and
 * `valueRef` as separate arguments. We bundle the resource into the ref so a
 * value slot is self-describing for callers that pass a single value reference
 * (CoView's gated `CoViewValueRef`). A resolver that takes them separately can
 * still read `valueRef.resource`.
 */
export interface ValueSlotRef {
  resource: PluginResourceRef;
  slot: string;
}

// ---------------------------------------------------------------------------
// Versioning (plan §6.6, §7.1, §11)
// ---------------------------------------------------------------------------

/**
 * Version stamps consulted while making an authorization decision, so a caller
 * (CoView) can cache the decision and later detect staleness (plan §11.1). A
 * cached projection at an older version must re-resolve; there is no TTL-only
 * path.
 */
export interface AuthVersions {
  /** The target resource's monotonically-increasing ACL version. */
  resourceAclVersion: number;
  /** Server-scoped version covering role-membership / ban changes that affect
   *  resource evaluation (driven by `PermissionChangedEvent`). */
  resourcePermissionVersion: number;
  /** ACL versions of every parent consulted during inheritance, so a parent
   *  revocation invalidates child cache entries without rewriting child rows.
   *  Omitted / empty when no parent was consulted. */
  parentVersions?: number[] | undefined;
}

// ---------------------------------------------------------------------------
// Authorization decisions (plan §6.2, §7.1)
// ---------------------------------------------------------------------------

/**
 * Why an authorization decision came out the way it did. The first eight arms
 * mirror the ACL evaluator's precedence outcomes (plan §6.4); the remaining
 * arms are fail-closed sentinels the resolver returns instead of throwing
 * (plan §6.8, §7.1): every one of them denies. Reserving them in the vocabulary
 * guarantees a deny path is always representable for unknown / banned / stale /
 * error conditions.
 */
export type AuthDecisionReason =
  // ACL-evaluator outcomes (a subset of these is the ACL-layer decision reason)
  | "explicit-allow"
  | "role-allow"
  | "everyone-allow"
  | "inherited-allow"
  | "explicit-deny"
  | "role-deny"
  | "everyone-deny"
  | "default-deny"
  // resolver fail-closed sentinels (always deny)
  | "unknown-resource"
  | "unknown-action"
  | "banned"
  | "stale"
  | "error";

/**
 * The reason arms producible by the pure ACL evaluator (plan §6.2
 * `EffectiveAclDecision`), before the resolver layers ban/stale/unknown/error
 * handling on top. A strict subset of `AuthDecisionReason`.
 */
export type AclDecisionReason = Extract<
  AuthDecisionReason,
  | "explicit-allow"
  | "role-allow"
  | "everyone-allow"
  | "inherited-allow"
  | "explicit-deny"
  | "role-deny"
  | "everyone-deny"
  | "default-deny"
>;

/**
 * The answer to `canReadPluginResource` / `canPluginResourceAction` (plan §7.1).
 * `allowed` is the load-bearing field; `reason` explains it; `versions` lets the
 * caller cache and later detect staleness. Fail-closed: any reason outside the
 * `*-allow` family implies `allowed: false`.
 */
export interface AuthDecision {
  allowed: boolean;
  reason: AuthDecisionReason;
  versions: AuthVersions;
}

// ---------------------------------------------------------------------------
// Resolved value (plan §7.1) — viewer-facing, secret-safe
// ---------------------------------------------------------------------------

/**
 * The output of resolving a value slot for a viewer (plan §7.1 `ResolvedValue`).
 * Aligns deliberately with CoView's `CoViewProjectedValue` (foundation-plan
 * §4.6) so CoView maps resolver output to projected output with no translation:
 * `visible → visible`, `withheld → withheld`.
 *
 * SECURITY — secret values are unrepresentable here (plan §10.10): there is no
 * variant carrying a secret value toward a viewer. A slot classified secret
 * resolves only to `withheld` (placeholder, typically `absent`) or never reaches
 * this path at all. The resolver has no code path that returns a secret value.
 * The only value-bearing arm is `visible`, which is reached strictly after an
 * allow decision for a non-secret slot.
 */
export type ResolvedPluginResourceValue =
  | { state: "visible"; value: JsonValue; versions: AuthVersions }
  | { state: "withheld"; placeholderShape: PlaceholderShape; versions: AuthVersions }
  | { state: "unsupported"; reason: string };

// ---------------------------------------------------------------------------
// Viewer context (plan §7.2)
// ---------------------------------------------------------------------------

/**
 * The minimal, trusted input the future resolver needs to authorize a viewer
 * (plan §7.2). Deliberately tiny: only `userId` and `serverId`.
 *
 * Authorization-affecting facts — role, owner status, ban state, resource
 * membership — are NOT caller-supplied. The resolver derives them from
 * authoritative runtime sources. A caller cannot smuggle "I am an admin" in
 * here; there is no field for it. This prevents a host/plugin client from
 * influencing an allow/deny via untrusted hints.
 */
export interface ViewerContext {
  userId: string;
  serverId: string;
}

// ---------------------------------------------------------------------------
// Resource type registration (plan §4.2, §8.1)
// ---------------------------------------------------------------------------

/**
 * One declared value slot in a resource type registration (plan §4.5). Maps the
 * slot to the `policyRef` that gates it.
 */
export interface ValueSlotDefinition {
  /** The policy reference that gates this slot, e.g. "album.read". Namespacing
   *  under the plugin slug is applied by the registry. */
  policy: string;
  /**
   * Marks this slot as carrying secret content (credentials, tokens). A secret
   * slot is never resolvable to a value on the viewer wire (plan §10.10): the
   * resolver returns a placeholder or absent, never the value. Defaults to
   * `false` (a normal protected value) when omitted.
   */
  secret?: boolean | undefined;
}

/**
 * The declaration a plugin makes (at install/boot) to register a resource type,
 * analogous to registering a named permission today (plan §4.2). An unregistered
 * `type` is unknown and fails closed in the future registry.
 *
 * SECURITY — `producerValueAllowed` is REQUIRED, not optional, and the future
 * registry/store treats its semantic default as `false` (plan §4.2, §10.6):
 * protected values are runtime-resolved unless a registration explicitly opts
 * in. Making the field required means a registration cannot silently omit it
 * into accidental exposure — the author must state the choice.
 */
export interface PluginResourceTypeRegistration {
  /** Owning plugin slug; the namespace for `type` and custom actions. */
  pluginSlug: string;
  /** The resource type name, e.g. "album". Namespaced under `pluginSlug` to
   *  form the fully-qualified type (`family-album:album`). */
  type: string;
  /** Parent resource type for inheritance, if any (plan §4.4). Root types omit. */
  parentType?: string | undefined;
  /** Every action this type supports — base and/or registered custom actions. */
  actions: PluginResourceAction[];
  /** Which of `actions` inherit from the parent's ACL (plan §4.4). Commonly
   *  `read` / `comment`; rarely `admin`. */
  inheritableActions: PluginResourceAction[];
  /** Declared action implications, e.g. `{ edit: ["read"] }` for "edit ⇒ read"
   *  (plan §5.1). Absent means no implications — `admin` does not imply `read`. */
  actionImplications?: Record<string, PluginResourceAction[]> | undefined;
  /** Named data-bearing slots and their policy mapping (plan §4.5). */
  valueSlots: Record<string, ValueSlotDefinition>;
  /**
   * Whether protected values for this type may be host/producer-provided
   * (`true`) or must be runtime-resolved (`false`). Required; the semantic
   * default in the future registry is `false` (plan §4.2, §10.6).
   */
  producerValueAllowed: boolean;
}

// ---------------------------------------------------------------------------
// ACL model (plan §6)
// ---------------------------------------------------------------------------

/**
 * The subject of an ACL entry (plan §6.1). `everyone` is scoped to the
 * server/workspace, never global. `owner` is the resource's creator or an
 * explicitly assigned owner — the only principal that holds `admin` by default
 * on a root resource. `role` is resolved through the existing `RolesEngine` at
 * evaluation time.
 */
export type ResourcePrincipal =
  | { kind: "user"; userId: string }
  | { kind: "role"; roleId: number }
  | { kind: "everyone" }
  | { kind: "owner" };

/**
 * A stored ACL row (plan §6.2). Inherited entries are NOT materialized per
 * child — they are computed at evaluation time (plan §4.4, §6.5) — so every
 * row here is an explicit or registry-seeded grant/deny on one resource.
 *
 * Time-limited grants (`expiresAt`) are explicitly deferred to post-V1 (plan
 * Open Question §13.8) and are intentionally NOT a field on this type yet.
 */
export interface ResourceAclEntry {
  resourceKey: PluginResourceKey;
  principal: ResourcePrincipal;
  /** Registered base or custom action this entry governs. */
  action: PluginResourceAction;
  effect: "allow" | "deny";
  /** User id of the granter, or "system" for registry-seeded rows. */
  grantedBy: string;
  /** Epoch ms. */
  grantedAt: number;
  source: "explicit" | "registry-seeded";
}

/**
 * The result of evaluating the ACL for a `(resource, principal, action)` —
 * computed, not stored (plan §6.2). Inherited and registry-default outcomes
 * surface here rather than as rows. This is the pure-ACL-layer counterpart to
 * the resolver's `AuthDecision`; its `reason` is the narrower `AclDecisionReason`.
 */
export interface EffectiveAclDecision {
  allowed: boolean;
  reason: AclDecisionReason;
  versions: AuthVersions;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Maximum plugin-resource parent-chain depth for V1 (plan §4.4). Bounds
 * resolution cost, cache-key size, and parent-version vectors. A registry
 * constant, not per-plugin; a chain deeper than this fails closed.
 */
export const MAX_PLUGIN_RESOURCE_PARENT_DEPTH = 16;
