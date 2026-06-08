// Plugin resource ACL resolver / decision engine (RP-FOUND-3).
//
// The resolver is the *only* authorization authority for plugin resources
// (plan §7). It answers two questions, and only these two:
//
//   canReadPluginResource(viewer, resourceRef)        -> AuthDecision
//   canPluginResourceAction(viewer, resourceRef, act) -> AuthDecision
//
// It composes the runtime-authoritative RP-FOUND-2 store (resource/ACL state),
// the existing RolesEngine (role membership), and the runtime ban/membership
// signals. It returns *decisions only*: it executes no mutation, materializes
// no protected value, and calls no plugin adapter (those are RP-FOUND-4+).
//
// Trust boundary (plan §7.2, §10.1):
//   - ViewerContext is `{ userId, serverId }` ONLY. Every authorization-
//     affecting fact — role, owner status, ban state, server membership — is
//     re-derived here from authoritative sources. A caller cannot smuggle an
//     allow/deny hint; there is no field for it.
//
// Fail-closed by construction (plan §6.8, §10.2): unknown resource, unknown
// resource type, unknown/undeclared action, banned viewer, malformed or
// over-deep or cyclic parent chain, and any thrown error all return a deny
// decision. Deny is the default return, never an exception a caller might
// swallow into an allow.
//
// What this layer deliberately does NOT do (out of scope for this PR):
//   - no SDK surface;
//   - no CoView projection;
//   - no plugin adapter / value materialization (`resolveValue`);
//   - no viewer action *execution* — it answers `canPluginResourceAction` but
//     mutates nothing;
//   - no caching yet. The returned `AuthVersions` are correct so a future cache
//     (RP-FOUND-8) can key on them, but no cache is implemented here.

import type {
  AuthDecision,
  AuthDecisionReason,
  AclDecisionReason,
  AuthVersions,
  PluginResourceAction,
  PluginResourceKey,
  PluginResourceRef,
  ViewerContext,
} from "@uncorded/protocol";
import { MAX_PLUGIN_RESOURCE_PARENT_DEPTH } from "@uncorded/protocol";
import type { PluginResourceStore } from "./store";
import type { StoredResource, StoredResourceType } from "./types";

// ---------------------------------------------------------------------------
// Injected authority sources (plan §7 — the resolver derives, never trusts)
// ---------------------------------------------------------------------------

/**
 * Authoritative role lookup — the minimal slice of `RolesEngine` the resolver
 * needs. `RolesEngine.getRole(userId)` satisfies this structurally (its `Role`
 * has an `id`). V1 is single-role (one effective role per user, plan §7.2); the
 * resolver reads exactly that role id for `role`-principal matching. It never
 * consults role *level* — server-level rank grants no implicit resource read
 * (plan §5.3, §10).
 */
export interface ResolverRoleSource {
  getRole(userId: string): { id: number };
}

/**
 * Authoritative ban signal (plan §6.6). `CoreModule.isBanned(userId)` satisfies
 * this. A banned viewer is denied regardless of any lingering ACL row.
 */
export type BanCheck = (userId: string) => boolean;

/**
 * Authoritative server-membership signal for the `everyone` principal (plan
 * §6.1: `everyone` is every *member* of the server scope, never global).
 *
 * The runtime tracks membership in core's `members` table (populated on first
 * connect). This predicate is injected so the resolver stays pure and testable;
 * real wiring backs it with that table. See the LIMITATION note at the bottom
 * of this file for the fail-closed posture when membership is unknown.
 */
export type MembershipCheck = (serverId: string, userId: string) => boolean;

export interface PluginResourceResolverDeps {
  store: PluginResourceStore;
  roles: ResolverRoleSource;
  isBanned: BanCheck;
  isMember: MembershipCheck;
}

// ---------------------------------------------------------------------------
// Internal evaluation types
// ---------------------------------------------------------------------------

/** The viewer facts the resolver derives once, then evaluates against. */
interface ViewerFacts {
  userId: string;
  /** Effective role id from the authoritative RolesEngine (single-role V1). */
  roleId: number;
  /** Whether the viewer is a member of the server scope (gates `everyone`). */
  isMember: boolean;
}

/** Local (single-node, no inheritance) ACL outcome, or `null` for no match. */
interface LocalOutcome {
  allowed: boolean;
  reason: AclDecisionReason;
}

/** Result of walking a node (with inheritance). */
type WalkResult =
  | { kind: "ok"; allowed: boolean; reason: AclDecisionReason; parentVersions: number[] }
  | { kind: "error" };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Versions with no resource consulted (unknown-resource path). */
const ZERO_VERSIONS: AuthVersions = {
  resourceAclVersion: 0,
  resourcePermissionVersion: 0,
};

function baseVersions(resource: StoredResource): AuthVersions {
  return {
    resourceAclVersion: resource.aclVersion,
    resourcePermissionVersion: resource.permissionVersion,
  };
}

function deny(reason: AuthDecisionReason, versions: AuthVersions): AuthDecision {
  return { allowed: false, reason, versions };
}

function nodeKey(resource: StoredResource): PluginResourceKey {
  return {
    serverId: resource.serverId,
    pluginSlug: resource.pluginSlug,
    resourceType: resource.resourceType,
    resourceId: resource.resourceId,
  };
}

function nodeKeyString(resource: StoredResource): string {
  return JSON.stringify([
    resource.serverId,
    resource.pluginSlug,
    resource.resourceType,
    resource.resourceId,
  ]);
}

// ---------------------------------------------------------------------------
// PluginResourceResolver
// ---------------------------------------------------------------------------

export class PluginResourceResolver {
  private readonly deps: PluginResourceResolverDeps;

  constructor(deps: PluginResourceResolverDeps) {
    this.deps = deps;
  }

  /**
   * Can this viewer see the protected value content of this resource? `read` is
   * the action behind this question (plan §5.1, §7.1). A type that does not
   * declare `read` denies with `unknown-action` — fail closed.
   *
   * This enforces user-level ACL only. If a plugin caller reads another
   * plugin's resource, the SDK/capability layer (RP-FOUND-4+) must first verify
   * the caller declared the required cross-plugin read capability.
   */
  canReadPluginResource(viewer: ViewerContext, resourceRef: PluginResourceRef): AuthDecision {
    return this.decide(viewer, resourceRef, "read");
  }

  /**
   * Can this viewer take a (registered) action on this resource? This answers
   * the authorization question only; it executes nothing (plan §3, §10.13). An
   * action not declared by the resource type denies with `unknown-action`.
   *
   * This enforces user-level ACL only. Cross-plugin caller capability checks
   * belong to the SDK/capability layer before invoking this resolver.
   */
  canPluginResourceAction(
    viewer: ViewerContext,
    resourceRef: PluginResourceRef,
    action: PluginResourceAction,
  ): AuthDecision {
    return this.decide(viewer, resourceRef, action);
  }

  // -----------------------------------------------------------------------
  // Core decision path
  // -----------------------------------------------------------------------

  private decide(
    viewer: ViewerContext,
    resourceRef: PluginResourceRef,
    action: PluginResourceAction,
  ): AuthDecision {
    let knownVersions = ZERO_VERSIONS;
    try {
      // The runtime re-attaches server scope from the viewer context; a ref
      // carries identity, never scope (plan §4.1).
      const key: PluginResourceKey = {
        serverId: viewer.serverId,
        pluginSlug: resourceRef.pluginSlug,
        resourceType: resourceRef.resourceType,
        resourceId: resourceRef.resourceId,
      };

      // 1. Resource lookup. Unknown resource fails closed (plan §6.8).
      const resource = this.deps.store.getResource(key);
      if (!resource) return deny("unknown-resource", ZERO_VERSIONS);
      knownVersions = baseVersions(resource);

      // 2. Resource type lookup. An unregistered type is unknown (plan §4.2).
      const type = this.deps.store.getType(key.pluginSlug, key.resourceType);
      if (!type) return deny("unknown-resource", knownVersions);

      // 3. Action validity. The action must be declared by the type — no
      //    free-form `check(user, "whatever")` (plan §5.2). This also gates
      //    `read`: a type that never declared `read` cannot be read.
      if (!type.actions.includes(action)) {
        return deny("unknown-action", knownVersions);
      }

      // 4. Ban short-circuit. A banned viewer denies regardless of ACL rows
      //    (plan §6.6, §10.11). Derived from the authoritative ban source.
      if (this.deps.isBanned(viewer.userId)) {
        return deny("banned", knownVersions);
      }

      // 5. Derive viewer facts from authoritative sources (never the caller).
      const facts: ViewerFacts = {
        userId: viewer.userId,
        roleId: this.deps.roles.getRole(viewer.userId).id,
        isMember: this.deps.isMember(viewer.serverId, viewer.userId),
      };

      // 6. Evaluate precedence + inheritance.
      const result = this.walk(resource, type, action, facts, new Set<string>(), 0);
      if (result.kind === "error") {
        // Malformed / cyclic / over-deep parent chain → fail closed (plan §6.8).
        return deny("error", knownVersions);
      }

      const versions: AuthVersions = {
        resourceAclVersion: resource.aclVersion,
        resourcePermissionVersion: resource.permissionVersion,
        ...(result.parentVersions.length > 0 ? { parentVersions: result.parentVersions } : {}),
      };
      return { allowed: result.allowed, reason: result.reason, versions };
    } catch {
      // Authorization uncertainty withholds (plan §10.11): any unexpected error
      // denies rather than risking a fall-open.
      return deny("error", knownVersions);
    }
  }

  // -----------------------------------------------------------------------
  // Precedence (plan §6.4) + inheritance (plan §6.5)
  // -----------------------------------------------------------------------

  /**
   * Evaluate `action` for `facts` at `node`, recursing into the parent chain
   * for inheritable actions. Returns the effective decision plus the ACL
   * versions of every parent consulted (plan §11.1), or `error` for a malformed
   * chain.
   *
   * `visited` carries the keys already on the current path so a cycle is
   * detected defensively even though the store rejects cycles at write time
   * (plan §6.8). `depth` bounds the walk at `MAX_PLUGIN_RESOURCE_PARENT_DEPTH`.
   */
  private walk(
    node: StoredResource,
    type: StoredResourceType,
    action: PluginResourceAction,
    facts: ViewerFacts,
    visited: Set<string>,
    depth: number,
  ): WalkResult {
    if (depth > MAX_PLUGIN_RESOURCE_PARENT_DEPTH) return { kind: "error" };

    const keyStr = nodeKeyString(node);
    if (visited.has(keyStr)) return { kind: "error" }; // cycle
    // `visited` is mutated in place. The resource graph is a single-parent
    // chain, so there is no branch to backtrack.
    visited.add(keyStr);

    // Local precedence (most-specific-first, deny-wins-within-tier).
    const local = this.evaluateLocal(node, type, action, facts);
    if (local) {
      return { kind: "ok", allowed: local.allowed, reason: local.reason, parentVersions: [] };
    }

    // No decisive local row. Inheritance applies ONLY when the action is
    // inheritable for *this* resource type (plan §4.4, §6.5).
    const inheritable = type.inheritableActions.includes(action);
    if (!inheritable) {
      return { kind: "ok", allowed: false, reason: "default-deny", parentVersions: [] };
    }

    // A root (no parent link) with no decisive local row → registry default deny.
    if (node.parentType === null && node.parentId === null) {
      return { kind: "ok", allowed: false, reason: "default-deny", parentVersions: [] };
    }
    // A half-set parent link is structurally malformed → fail closed.
    if (node.parentType === null || node.parentId === null) return { kind: "error" };

    const parent = this.deps.store.getResource({
      serverId: node.serverId,
      pluginSlug: node.pluginSlug,
      resourceType: node.parentType,
      resourceId: node.parentId,
    });
    // A parent referenced but absent is a broken chain → fail closed.
    if (!parent) return { kind: "error" };
    const parentType = this.deps.store.getType(parent.pluginSlug, parent.resourceType);
    if (!parentType) return { kind: "error" };

    const sub = this.walk(parent, parentType, action, facts, visited, depth + 1);
    if (sub.kind === "error") return sub;

    // We consulted the parent: record its ACL version (and any further up the
    // chain) so a parent revocation invalidates a cached child decision.
    const parentVersions = [parent.aclVersion, ...sub.parentVersions];

    if (sub.allowed) {
      // An inherited allow surfaces with the dedicated reason (plan §6.5).
      return { kind: "ok", allowed: true, reason: "inherited-allow", parentVersions };
    }
    // An inherited deny denies. The protocol has no `inherited-deny`, so the
    // closest matching reason is the upstream deny reason itself (an actual
    // deny rule that fired up-chain, or `default-deny` when nothing matched).
    return { kind: "ok", allowed: false, reason: sub.reason, parentVersions };
  }

  /**
   * Single-node precedence over the stored ACL rows for `action` (plan §6.4):
   *
   *   1. explicit deny   (user row for the viewer, OR owner row when viewer ∈
   *      ownerUserIds)
   *   2. explicit allow
   *   3. role deny        (role row matching the viewer's effective role)
   *   4. role allow
   *   5. everyone deny    (only when the viewer is a server member)
   *   6. everyone allow
   *
   * Returns `null` when no row matches the viewer at this node (the caller then
   * consults the parent or the registry default).
   *
   * Owner placement: the `owner` principal is identity-based (it names the
   * resource's owner set), so it is evaluated in the *most-specific* (explicit)
   * tier alongside direct `user` rows and maps to the `explicit-allow` /
   * `explicit-deny` reasons — the protocol vocabulary has no separate owner
   * reason. Deny still wins within the tier. This is NOT a server-owner bypass:
   * it matches only the resource's stored `ownerUserIds`, and only when an
   * explicit `owner` ACL row exists (plan §5.3, §10 — no implicit content read
   * for server owners).
   */
  private evaluateLocal(
    node: StoredResource,
    type: StoredResourceType,
    action: PluginResourceAction,
    facts: ViewerFacts,
  ): LocalOutcome | null {
    const isOwner = node.ownerUserIds?.includes(facts.userId) ?? false;

    let explicitAllow = false;
    let explicitDeny = false;
    let roleAllow = false;
    let roleDeny = false;
    let everyoneAllow = false;
    let everyoneDeny = false;

    for (const entry of this.deps.store.listAcl(nodeKey(node))) {
      if (!this.entryApplies(type, entry.action, entry.effect, action)) continue;
      const isDeny = entry.effect === "deny";
      const p = entry.principal;

      switch (p.kind) {
        case "user":
          if (p.userId === facts.userId) {
            if (isDeny) explicitDeny = true;
            else explicitAllow = true;
          }
          break;
        case "owner":
          if (isOwner) {
            if (isDeny) explicitDeny = true;
            else explicitAllow = true;
          }
          break;
        case "role":
          if (p.roleId === facts.roleId) {
            if (isDeny) roleDeny = true;
            else roleAllow = true;
          }
          break;
        case "everyone":
          if (facts.isMember) {
            if (isDeny) everyoneDeny = true;
            else everyoneAllow = true;
          }
          break;
      }
    }

    if (explicitDeny) return { allowed: false, reason: "explicit-deny" };
    if (explicitAllow) return { allowed: true, reason: "explicit-allow" };
    if (roleDeny) return { allowed: false, reason: "role-deny" };
    if (roleAllow) return { allowed: true, reason: "role-allow" };
    if (everyoneDeny) return { allowed: false, reason: "everyone-deny" };
    if (everyoneAllow) return { allowed: true, reason: "everyone-allow" };
    return null;
  }

  /**
   * An allow row for an implying action can satisfy the implied action
   * (`edit => read`). A deny row applies only to its exact action: denying
   * `edit` says nothing about whether `read` is allowed.
   */
  private entryApplies(
    type: StoredResourceType,
    entryAction: PluginResourceAction,
    entryEffect: "allow" | "deny",
    requestedAction: PluginResourceAction,
  ): boolean {
    if (entryAction === requestedAction) return true;
    if (entryEffect === "deny") return false;
    return this.actionImplies(type, entryAction, requestedAction, new Set<PluginResourceAction>());
  }

  private actionImplies(
    type: StoredResourceType,
    from: PluginResourceAction,
    to: PluginResourceAction,
    seen: Set<PluginResourceAction>,
  ): boolean {
    if (seen.has(from)) return false;
    seen.add(from);

    const implied = type.actionImplications?.[from] ?? [];
    if (implied.includes(to)) return true;
    return implied.some((next) => this.actionImplies(type, next, to, seen));
  }
}

// ---------------------------------------------------------------------------
// LIMITATION — `everyone` / ban membership sources
// ---------------------------------------------------------------------------
//
// `everyone` and `banned` are derived through injected predicates
// (`isMember`, `isBanned`) rather than hard-wired to a concrete module, so this
// decision engine stays pure and unit-testable (plan §7 — runtime is the
// authority; this file is dependency-injected).
//
//   - Ban: a reliable runtime source EXISTS today — `CoreModule.isBanned`,
//     backed by core's `bans` table. Real wiring passes it straight through.
//   - Membership: the runtime DOES track membership in core's `members` table
//     (populated on first connect). There is currently no single `isMember`
//     method on `CoreModule`; real wiring backs the predicate with a `members`
//     lookup. Until a deployment populates membership, the predicate returns
//     false and `everyone` grants simply do not apply — fail closed, never
//     fall open. This matches the plan's posture (§6.1 `everyone` is membership-
//     scoped; §10.2 unknown fails closed) and is the only V1 deviation worth
//     calling out: `everyone` visibility is exactly as wide as the authoritative
//     membership source says, and no wider.
//
// Runtime boot wiring (constructing the resolver with the real store / roles /
// core signals) is intentionally NOT done in this PR — it belongs with the SDK
// and CoView consumers (RP-FOUND-4+), and adding it here would wire an
// unused authority into boot.
