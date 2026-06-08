// Runtime validation for the plugin resource permission protocol types
// (RP-FOUND-1). Sibling to the type-only definitions in
// `@uncorded/protocol/plugin-resources`.
//
// These schemas are the runtime guard for the resource layer's identity,
// action vocabulary, and authorization decision shapes. They encode the
// fail-closed posture structurally:
//  - an action is valid only if it is a known base verb OR a namespaced
//    `pluginSlug:action` custom action — a bare unknown verb ("delete") is
//    rejected, never silently accepted;
//  - a resolved viewer value can never carry a secret value (no such variant);
//  - missing required identity fields reject the whole object.

import { z } from "zod";
import type {
  JsonValue,
  PluginResourceKey,
  PluginResourceRef,
  PlaceholderShape,
  ValueSlotRef,
  AuthVersions,
  AuthDecision,
  ResolvedPluginResourceValue,
  ViewerContext,
  ValueSlotDefinition,
  PluginResourceTypeRegistration,
  ResourcePrincipal,
  ResourceAclEntry,
  EffectiveAclDecision,
} from "@uncorded/protocol";

// ---------------------------------------------------------------------------
// JSON value
// ---------------------------------------------------------------------------

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

// ---------------------------------------------------------------------------
// Resource identity (plan §4.1)
// ---------------------------------------------------------------------------

export const PluginResourceKeySchema = z.object({
  serverId: z.string().min(1),
  pluginSlug: z.string().min(1),
  resourceType: z.string().min(1),
  resourceId: z.string().min(1),
}) satisfies z.ZodType<PluginResourceKey>;

export const PluginResourceRefSchema = z.object({
  kind: z.literal("pluginResource"),
  pluginSlug: z.string().min(1),
  resourceType: z.string().min(1),
  resourceId: z.string().min(1),
}) satisfies z.ZodType<PluginResourceRef>;

// ---------------------------------------------------------------------------
// Action vocabulary (plan §5)
// ---------------------------------------------------------------------------

export const BasePluginResourceActionSchema = z.enum([
  "read",
  "comment",
  "edit",
  "share",
  "admin",
]);

/**
 * A registered custom action is namespaced: `pluginSlug:action`. Exactly one
 * colon separating two non-empty lowercase segments. Base actions are reserved
 * and carry no colon, so a namespaced string can never collide with a base verb
 * (plan §5.2, Open Question §13.3).
 */
export const CUSTOM_PLUGIN_RESOURCE_ACTION_RE = /^[a-z][a-z0-9-]*:[a-z][a-z0-9_-]*$/;

/**
 * Accepts a base verb OR a namespaced custom action. A bare unknown verb with
 * no colon (e.g. "delete") matches neither arm and is rejected — fail closed.
 */
export const PluginResourceActionSchema = z.union([
  BasePluginResourceActionSchema,
  z.string().regex(CUSTOM_PLUGIN_RESOURCE_ACTION_RE),
]);

export const ProtocolIdentifierSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "protocol-identifier");

// ---------------------------------------------------------------------------
// Placeholders & value slots (plan §4.5)
// ---------------------------------------------------------------------------

export const PlaceholderShapeSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("synthetic"),
    // Dimensions are non-negative (sub-pixel allowed); a line count is a
    // non-negative integer. Negative hints are malformed.
    width: z.number().nonnegative().optional(),
    height: z.number().nonnegative().optional(),
    lines: z.number().int().nonnegative().optional(),
  }),
  z.object({
    mode: z.literal("preserve-host-rect"),
    // `true` literal: omission cannot opt into the size/existence leak.
    sizeLeakAccepted: z.literal(true),
    reason: z.string().min(1),
  }),
  z.object({
    mode: z.literal("absent"),
  }),
]) satisfies z.ZodType<PlaceholderShape>;

export const ValueSlotRefSchema = z.object({
  resource: PluginResourceRefSchema,
  slot: z.string().min(1),
}) satisfies z.ZodType<ValueSlotRef>;

// ---------------------------------------------------------------------------
// Versioning & decisions (plan §6.2, §7.1)
// ---------------------------------------------------------------------------

// Versions are monotonic counters — non-negative integers, never fractional.
export const AuthVersionsSchema = z.object({
  resourceAclVersion: z.number().int().nonnegative(),
  resourcePermissionVersion: z.number().int().nonnegative(),
  parentVersions: z.array(z.number().int().nonnegative()).optional(),
}) satisfies z.ZodType<AuthVersions>;

export const AclDecisionReasonSchema = z.enum([
  "explicit-allow",
  "role-allow",
  "everyone-allow",
  "inherited-allow",
  "explicit-deny",
  "role-deny",
  "everyone-deny",
  "default-deny",
]);

export const AuthDecisionReasonSchema = z.enum([
  "explicit-allow",
  "role-allow",
  "everyone-allow",
  "inherited-allow",
  "explicit-deny",
  "role-deny",
  "everyone-deny",
  "default-deny",
  "unknown-resource",
  "unknown-action",
  "banned",
  "stale",
  "error",
]);

/**
 * `allowed` must agree with `reason`: an allow reason (the `*-allow` family)
 * implies `allowed: true`; every deny / fail-closed-sentinel reason implies
 * `allowed: false` (plan §10, and the `AuthDecision` doc comment). This rejects
 * incoherent decisions like `{ allowed: true, reason: "banned" }`.
 */
const isAllowReason = (reason: string): boolean => reason.endsWith("-allow");

const allowedMatchesReason = { message: "`allowed` must be true iff `reason` is an allow reason", path: ["allowed"] };

export const AuthDecisionSchema = z
  .object({
    allowed: z.boolean(),
    reason: AuthDecisionReasonSchema,
    versions: AuthVersionsSchema,
  })
  .refine((d) => d.allowed === isAllowReason(d.reason), allowedMatchesReason) satisfies z.ZodType<AuthDecision>;

export const EffectiveAclDecisionSchema = z
  .object({
    allowed: z.boolean(),
    reason: AclDecisionReasonSchema,
    versions: AuthVersionsSchema,
  })
  .refine((d) => d.allowed === isAllowReason(d.reason), allowedMatchesReason) satisfies z.ZodType<EffectiveAclDecision>;

// ---------------------------------------------------------------------------
// Resolved value (plan §7.1) — secret-safe by construction
// ---------------------------------------------------------------------------

// No `secret`-with-value arm exists: the only value-bearing state is `visible`.
// A secret slot resolves to `withheld` (placeholder) or never reaches this path.
export const ResolvedPluginResourceValueSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("visible"),
    value: JsonValueSchema,
    versions: AuthVersionsSchema,
  }),
  z.object({
    state: z.literal("withheld"),
    placeholderShape: PlaceholderShapeSchema,
    versions: AuthVersionsSchema,
  }),
  z.object({
    state: z.literal("unsupported"),
    reason: z.string(),
  }),
]) satisfies z.ZodType<ResolvedPluginResourceValue>;

// ---------------------------------------------------------------------------
// Viewer context (plan §7.2)
// ---------------------------------------------------------------------------

export const ViewerContextSchema = z.object({
  userId: z.string().min(1),
  serverId: z.string().min(1),
}) satisfies z.ZodType<ViewerContext>;

// ---------------------------------------------------------------------------
// Resource type registration (plan §4.2)
// ---------------------------------------------------------------------------

export const ValueSlotDefinitionSchema = z.object({
  policy: z.string().min(1),
  secret: z.boolean().optional(),
}) satisfies z.ZodType<ValueSlotDefinition>;

export const PluginResourceTypeRegistrationSchema = z
  .object({
    pluginSlug: z.string().min(1),
    type: z.string().min(1),
    parentType: z.string().min(1).optional(),
    actions: z.array(PluginResourceActionSchema),
    inheritableActions: z.array(PluginResourceActionSchema),
    actionImplications: z
      .record(PluginResourceActionSchema, z.array(PluginResourceActionSchema))
      .optional(),
    valueSlots: z.record(ProtocolIdentifierSchema, ValueSlotDefinitionSchema),
    // Required, not optional — a registration must state the choice; the future
    // registry treats the semantic default as `false` (plan §4.2, §10.6).
    producerValueAllowed: z.boolean(),
  })
  .refine(
    (r) => r.inheritableActions.every((a) => r.actions.includes(a)),
    {
      message: "inheritableActions must be a subset of actions",
      path: ["inheritableActions"],
    },
  )
  .refine(
    (r) =>
      Object.entries(r.actionImplications ?? {}).every(
        ([action, implied]) =>
          r.actions.includes(action) && implied.every((a) => r.actions.includes(a)),
      ),
    {
      message: "actionImplications must reference declared actions",
      path: ["actionImplications"],
    },
  ) satisfies z.ZodType<PluginResourceTypeRegistration>;

// ---------------------------------------------------------------------------
// ACL model (plan §6)
// ---------------------------------------------------------------------------

export const ResourcePrincipalSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user"), userId: z.string().min(1) }),
  // Role ids are positive integer primary keys (RolesEngine autoincrement).
  z.object({ kind: z.literal("role"), roleId: z.number().int().positive() }),
  z.object({ kind: z.literal("everyone") }),
  z.object({ kind: z.literal("owner") }),
]) satisfies z.ZodType<ResourcePrincipal>;

export const ResourceAclEntrySchema = z.object({
  resourceKey: PluginResourceKeySchema,
  principal: ResourcePrincipalSchema,
  action: PluginResourceActionSchema,
  effect: z.enum(["allow", "deny"]),
  grantedBy: z.string().min(1),
  // Epoch milliseconds — a non-negative integer.
  grantedAt: z.number().int().nonnegative(),
  source: z.enum(["explicit", "registry-seeded"]),
}) satisfies z.ZodType<ResourceAclEntry>;
