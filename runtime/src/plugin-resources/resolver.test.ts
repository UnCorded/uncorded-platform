// PluginResourceResolver (RP-FOUND-3) focused tests.
//
// Exercises the decision engine end-to-end against the real RP-FOUND-2 store
// with injected role / ban / membership authorities:
//   - fail-closed paths: unknown resource, unknown action, malformed parent;
//   - precedence (plan §6.4): user / owner / role / everyone, deny-wins, and
//     more-specific-allow-over-broader-deny;
//   - inheritance (plan §6.5): inheritable allow flows, non-inheritable does
//     not, child deny shadows parent allow, parentVersions are recorded;
//   - ban short-circuit; no implicit server-owner read bypass;
//   - schema conformance of the returned `AuthDecision`.
//
// One test wires the real `RolesEngine` to prove `role`-principal matching uses
// the authoritative role lookup, not a caller hint.

import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  PluginResourceKey,
  PluginResourceRef,
  PluginResourceTypeRegistration,
  ViewerContext,
} from "@uncorded/protocol";
import { AuthDecisionSchema } from "@uncorded/protocol-schemas";
import { PluginResourceStore } from "./store";
import {
  PluginResourceResolver,
  type ResolverRoleSource,
} from "./resolver";
import { RolesEngine } from "../roles/engine";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = join(import.meta.dir, "migrations");
const ROLES_MIGRATIONS_DIR = join(import.meta.dir, "..", "roles", "migrations");
const SERVER = "srv-1";
const PLUGIN = "family-album";

class TestMigrationError extends Error {
  readonly code = "MIGRATION_FAILED";
  readonly context: {
    migrationSet: string;
    error: unknown;
  };

  constructor(migrationSet: string, error: unknown) {
    super(`${migrationSet} migration failed`);
    this.name = "TestMigrationError";
    this.context = { migrationSet, error };
  }
}

const ALBUM_TYPE: PluginResourceTypeRegistration = {
  pluginSlug: PLUGIN,
  type: "album",
  actions: ["read", "comment", "edit", "share", "admin", "family-album:download"],
  inheritableActions: ["read", "comment"],
  actionImplications: { edit: ["read"], admin: ["edit", "share"] },
  valueSlots: { title: { policy: "album.read" } },
  producerValueAllowed: false,
};

const PHOTO_TYPE: PluginResourceTypeRegistration = {
  pluginSlug: PLUGIN,
  type: "photo",
  parentType: "album",
  actions: ["read", "comment", "family-album:download", "admin"],
  inheritableActions: ["read", "comment"],
  valueSlots: { pixels: { policy: "photo.read" } },
  producerValueAllowed: false,
};

// A no-`read` type, to prove `read` itself is gated by declaration.
const OPAQUE_TYPE: PluginResourceTypeRegistration = {
  pluginSlug: PLUGIN,
  type: "opaque",
  actions: ["comment"],
  inheritableActions: [],
  valueSlots: {},
  producerValueAllowed: false,
};

function albumKey(id: string): PluginResourceKey {
  return { serverId: SERVER, pluginSlug: PLUGIN, resourceType: "album", resourceId: id };
}
function photoKey(id: string): PluginResourceKey {
  return { serverId: SERVER, pluginSlug: PLUGIN, resourceType: "photo", resourceId: id };
}
function albumRef(id: string): PluginResourceRef {
  return { kind: "pluginResource", pluginSlug: PLUGIN, resourceType: "album", resourceId: id };
}
function photoRef(id: string): PluginResourceRef {
  return { kind: "pluginResource", pluginSlug: PLUGIN, resourceType: "photo", resourceId: id };
}
function viewer(userId: string): ViewerContext {
  return { userId, serverId: SERVER };
}
function viewerIn(serverId: string, userId: string): ViewerContext {
  return { userId, serverId };
}
function memberKey(serverId: string, userId: string): string {
  return `${serverId}:${userId}`;
}

// ---------------------------------------------------------------------------
// Harness — store + injected authorities. Roles/bans/members are mutable maps
// so each test declares exactly the authoritative facts it needs.
// ---------------------------------------------------------------------------

interface Harness {
  db: Database;
  store: PluginResourceStore;
  resolver: PluginResourceResolver;
  roleOf: Map<string, number>; // userId -> roleId (default 1 = "member")
  banned: Set<string>;
  members: Set<string>; // `${serverId}:${userId}`
}

const MEMBER_ROLE_ID = 1;

function makeHarness(roles?: ResolverRoleSource): Harness {
  const db = new Database(":memory:");
  const result = PluginResourceStore.initialize(
    db,
    MIGRATIONS_DIR,
    (dir) => readdirSync(dir),
    (path) => readFileSync(path, "utf-8"),
  );
  if (!result.ok) throw new TestMigrationError("plugin-resources", result.error);
  const store = new PluginResourceStore(db);

  const roleOf = new Map<string, number>();
  const banned = new Set<string>();
  const members = new Set<string>();

  const roleSource: ResolverRoleSource =
    roles ?? { getRole: (userId) => ({ id: roleOf.get(userId) ?? MEMBER_ROLE_ID }) };

  const resolver = new PluginResourceResolver({
    store,
    roles: roleSource,
    isBanned: (userId) => banned.has(userId),
    isMember: (serverId, userId) => members.has(memberKey(serverId, userId)),
  });

  store.registerType(ALBUM_TYPE);
  store.registerType(PHOTO_TYPE);
  store.registerType(OPAQUE_TYPE);

  return { db, store, resolver, roleOf, banned, members };
}

// ---------------------------------------------------------------------------
// Fail-closed: unknown resource / type / action
// ---------------------------------------------------------------------------

describe("fail-closed lookups", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  test("unknown resource denies with unknown-resource and zero versions", () => {
    const d = h.resolver.canReadPluginResource(viewer("billy"), albumRef("ghost"));
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("unknown-resource");
    expect(d.versions.resourceAclVersion).toBe(0);
    expect(d.versions.resourcePermissionVersion).toBe(0);
  });

  test("unknown / undeclared action denies with unknown-action", () => {
    h.store.createResource({ ...albumKey("a1") });
    const d = h.resolver.canPluginResourceAction(viewer("billy"), albumRef("a1"), "family-album:upload");
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("unknown-action");
  });

  test("read on a type that never declared `read` denies with unknown-action", () => {
    h.store.createResource({ serverId: SERVER, pluginSlug: PLUGIN, resourceType: "opaque", resourceId: "o1" });
    const ref: PluginResourceRef = { kind: "pluginResource", pluginSlug: PLUGIN, resourceType: "opaque", resourceId: "o1" };
    const d = h.resolver.canReadPluginResource(viewer("billy"), ref);
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("unknown-action");
  });
});

// ---------------------------------------------------------------------------
// Default deny + user / owner precedence
// ---------------------------------------------------------------------------

describe("user & owner precedence", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
    h.store.createResource({ ...albumKey("a1"), ownerUserIds: ["dad"] });
  });

  test("no ACL rows → default-deny", () => {
    const d = h.resolver.canReadPluginResource(viewer("billy"), albumRef("a1"));
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("default-deny");
    expect(d.versions.resourceAclVersion).toBeGreaterThan(0);
  });

  test("user allow → explicit-allow", () => {
    h.store.grant(albumKey("a1"), { kind: "user", userId: "billy" }, "read", "dad");
    const d = h.resolver.canReadPluginResource(viewer("billy"), albumRef("a1"));
    expect(d.allowed).toBe(true);
    expect(d.reason).toBe("explicit-allow");
  });

  test("user deny → explicit-deny", () => {
    h.store.deny(albumKey("a1"), { kind: "user", userId: "billy" }, "read", "dad");
    const d = h.resolver.canReadPluginResource(viewer("billy"), albumRef("a1"));
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("explicit-deny");
  });

  test("owner allow → allows when an owner row exists and viewer ∈ ownerUserIds", () => {
    h.store.grant(albumKey("a1"), { kind: "owner" }, "read", "dad");
    const d = h.resolver.canReadPluginResource(viewer("dad"), albumRef("a1"));
    expect(d.allowed).toBe(true);
    expect(d.reason).toBe("explicit-allow");
    // A non-owner is unaffected by the owner row.
    expect(h.resolver.canReadPluginResource(viewer("billy"), albumRef("a1")).reason).toBe("default-deny");
  });

  test("owner metadata WITHOUT an owner ACL row does not grant (no implicit owner bypass)", () => {
    // dad is the stored owner but there is no `owner` allow row.
    const d = h.resolver.canReadPluginResource(viewer("dad"), albumRef("a1"));
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("default-deny");
  });
});

// ---------------------------------------------------------------------------
// Role & everyone precedence
// ---------------------------------------------------------------------------

describe("role & everyone precedence", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
    h.store.createResource({ ...albumKey("a1") });
  });

  test("role allow → role-allow for a viewer in that role", () => {
    h.roleOf.set("billy", 7);
    h.store.grant(albumKey("a1"), { kind: "role", roleId: 7 }, "read", "dad");
    const d = h.resolver.canReadPluginResource(viewer("billy"), albumRef("a1"));
    expect(d.allowed).toBe(true);
    expect(d.reason).toBe("role-allow");
    // A viewer NOT in role 7 is unaffected.
    expect(h.resolver.canReadPluginResource(viewer("sarah"), albumRef("a1")).reason).toBe("default-deny");
  });

  test("role deny → role-deny", () => {
    h.roleOf.set("billy", 7);
    h.store.deny(albumKey("a1"), { kind: "role", roleId: 7 }, "read", "dad");
    const d = h.resolver.canReadPluginResource(viewer("billy"), albumRef("a1"));
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("role-deny");
  });

  test("everyone allow → everyone-allow for a server member", () => {
    h.members.add(memberKey(SERVER, "billy"));
    h.store.grant(albumKey("a1"), { kind: "everyone" }, "read", "dad");
    const d = h.resolver.canReadPluginResource(viewer("billy"), albumRef("a1"));
    expect(d.allowed).toBe(true);
    expect(d.reason).toBe("everyone-allow");
  });

  test("everyone allow is scoped to the viewer's server", () => {
    const otherServer = "srv-2";
    h.members.add(memberKey(SERVER, "billy"));
    h.store.createResource({
      serverId: otherServer,
      pluginSlug: PLUGIN,
      resourceType: "album",
      resourceId: "a1",
    });
    h.store.grant(
      { serverId: otherServer, pluginSlug: PLUGIN, resourceType: "album", resourceId: "a1" },
      { kind: "everyone" },
      "read",
      "dad",
    );

    const d = h.resolver.canReadPluginResource(viewerIn(otherServer, "billy"), albumRef("a1"));
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("default-deny");
  });

  test("everyone allow does NOT apply to a non-member (fail-closed membership)", () => {
    // billy is not in the members set.
    h.store.grant(albumKey("a1"), { kind: "everyone" }, "read", "dad");
    const d = h.resolver.canReadPluginResource(viewer("billy"), albumRef("a1"));
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("default-deny");
  });
});

// ---------------------------------------------------------------------------
// Cross-tier overrides (more-specific allow beats broader deny; deny-wins)
// ---------------------------------------------------------------------------

describe("cross-tier precedence", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
    h.store.createResource({ ...albumKey("a1") });
  });

  test("user allow overrides role deny", () => {
    h.roleOf.set("billy", 7);
    h.store.deny(albumKey("a1"), { kind: "role", roleId: 7 }, "read", "dad");
    h.store.grant(albumKey("a1"), { kind: "user", userId: "billy" }, "read", "dad");
    const d = h.resolver.canReadPluginResource(viewer("billy"), albumRef("a1"));
    expect(d.allowed).toBe(true);
    expect(d.reason).toBe("explicit-allow");
  });

  test("user deny overrides everyone allow", () => {
    h.members.add(memberKey(SERVER, "billy"));
    h.store.grant(albumKey("a1"), { kind: "everyone" }, "read", "dad");
    h.store.deny(albumKey("a1"), { kind: "user", userId: "billy" }, "read", "dad");
    const d = h.resolver.canReadPluginResource(viewer("billy"), albumRef("a1"));
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("explicit-deny");
  });
});

// ---------------------------------------------------------------------------
// Action implications
// ---------------------------------------------------------------------------

describe("action implications", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
    h.store.createResource({ ...albumKey("a1") });
  });

  test("an allow for an implying action satisfies the implied action", () => {
    h.store.grant(albumKey("a1"), { kind: "user", userId: "billy" }, "edit", "dad");
    const d = h.resolver.canReadPluginResource(viewer("billy"), albumRef("a1"));
    expect(d.allowed).toBe(true);
    expect(d.reason).toBe("explicit-allow");
  });

  test("action implications are resolved transitively", () => {
    h.store.grant(albumKey("a1"), { kind: "user", userId: "billy" }, "admin", "dad");
    const d = h.resolver.canReadPluginResource(viewer("billy"), albumRef("a1"));
    expect(d.allowed).toBe(true);
    expect(d.reason).toBe("explicit-allow");
  });

  test("a deny for an implying action does not deny the implied action", () => {
    h.store.deny(albumKey("a1"), { kind: "user", userId: "billy" }, "edit", "dad");
    const d = h.resolver.canReadPluginResource(viewer("billy"), albumRef("a1"));
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("default-deny");
  });

  test("an exact deny for the requested action still beats an implied allow", () => {
    h.store.grant(albumKey("a1"), { kind: "user", userId: "billy" }, "edit", "dad");
    h.store.deny(albumKey("a1"), { kind: "user", userId: "billy" }, "read", "dad");
    const d = h.resolver.canReadPluginResource(viewer("billy"), albumRef("a1"));
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("explicit-deny");
  });
});

// ---------------------------------------------------------------------------
// Inheritance
// ---------------------------------------------------------------------------

describe("inheritance", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
    h.store.createResource({ ...albumKey("a1") });
    h.store.createResource({ ...photoKey("p1"), parent: { resourceType: "album", resourceId: "a1" } });
  });

  test("inheritable allow on the parent flows to the child as inherited-allow", () => {
    h.store.grant(albumKey("a1"), { kind: "user", userId: "billy" }, "read", "dad");
    const d = h.resolver.canReadPluginResource(viewer("billy"), photoRef("p1"));
    expect(d.allowed).toBe(true);
    expect(d.reason).toBe("inherited-allow");
  });

  test("parent ACL version is recorded in parentVersions", () => {
    h.store.grant(albumKey("a1"), { kind: "user", userId: "billy" }, "read", "dad");
    const albumAclVersion = h.store.getResource(albumKey("a1"))!.aclVersion;
    const d = h.resolver.canReadPluginResource(viewer("billy"), photoRef("p1"));
    expect(d.versions.parentVersions).toBeDefined();
    expect(d.versions.parentVersions).toContain(albumAclVersion);
  });

  test("a non-inheritable action does not inherit from the parent", () => {
    // `admin` is declared on both types but is NOT in photo's inheritableActions.
    h.store.grant(albumKey("a1"), { kind: "user", userId: "billy" }, "admin", "dad");
    const d = h.resolver.canPluginResourceAction(viewer("billy"), photoRef("p1"), "admin");
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("default-deny");
    expect(d.versions.parentVersions).toBeUndefined();
  });

  test("a child explicit deny overrides a parent inherited allow", () => {
    h.store.grant(albumKey("a1"), { kind: "user", userId: "billy" }, "read", "dad");
    h.store.deny(photoKey("p1"), { kind: "user", userId: "billy" }, "read", "dad");
    const d = h.resolver.canReadPluginResource(viewer("billy"), photoRef("p1"));
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("explicit-deny");
    // The child was decisive locally, so no parent was consulted.
    expect(d.versions.parentVersions).toBeUndefined();
  });

  test("malformed parent chain (parent row vanished) fails closed with error", () => {
    h.store.grant(albumKey("a1"), { kind: "user", userId: "billy" }, "read", "dad");
    // Simulate corruption: remove the parent row out from under the child.
    h.db.run("DELETE FROM plugin_resources WHERE resource_type = 'album' AND resource_id = 'a1'");
    const d = h.resolver.canReadPluginResource(viewer("billy"), photoRef("p1"));
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// Ban short-circuit & no server-owner bypass
// ---------------------------------------------------------------------------

describe("ban & owner-bypass", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
    h.store.createResource({ ...albumKey("a1") });
  });

  test("a banned viewer denies regardless of an explicit allow", () => {
    h.store.grant(albumKey("a1"), { kind: "user", userId: "billy" }, "read", "dad");
    h.banned.add("billy");
    const d = h.resolver.canReadPluginResource(viewer("billy"), albumRef("a1"));
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("banned");
  });

  test("no implicit server-owner read: a high-level role with no ACL row is denied", () => {
    // Give the viewer the highest role id; the resolver must never read role
    // *level* as an implicit content grant (plan §5.3, §10).
    h.roleOf.set("boss", 999);
    const d = h.resolver.canReadPluginResource(viewer("boss"), albumRef("a1"));
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("default-deny");
  });
});

// ---------------------------------------------------------------------------
// Schema conformance
// ---------------------------------------------------------------------------

describe("decision shape", () => {
  test("returned decisions satisfy AuthDecisionSchema (allowed agrees with reason)", () => {
    const h = makeHarness();
    h.store.createResource({ ...albumKey("a1") });
    h.store.createResource({ ...photoKey("p1"), parent: { resourceType: "album", resourceId: "a1" } });
    h.store.grant(albumKey("a1"), { kind: "user", userId: "billy" }, "read", "dad");

    const decisions = [
      h.resolver.canReadPluginResource(viewer("billy"), albumRef("a1")), // explicit-allow
      h.resolver.canReadPluginResource(viewer("billy"), photoRef("p1")), // inherited-allow
      h.resolver.canReadPluginResource(viewer("sarah"), albumRef("a1")), // default-deny
      h.resolver.canReadPluginResource(viewer("billy"), albumRef("ghost")), // unknown-resource
      h.resolver.canPluginResourceAction(viewer("billy"), albumRef("a1"), "family-album:upload"), // unknown-action
    ];
    for (const d of decisions) {
      expect(() => AuthDecisionSchema.parse(d)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// Integration: real RolesEngine drives `role`-principal matching
// ---------------------------------------------------------------------------

describe("RolesEngine integration", () => {
  test("role-principal allow uses the authoritative role lookup, not a caller hint", () => {
    const db = new Database(":memory:");
    const rolesResult = RolesEngine.initialize(
      db,
      ROLES_MIGRATIONS_DIR,
      (dir) => readdirSync(dir),
      (path) => readFileSync(path, "utf-8"),
    );
    if (!rolesResult.ok) throw new TestMigrationError("roles", rolesResult.error);
    const engine = new RolesEngine(db);

    // Assign "moderator" to billy via an owner caller.
    const moderator = engine.getRoleByName("moderator")!;
    const assigned = engine.assignRole("billy", moderator.id, { userId: "sys", isOwner: true });
    expect(assigned.ok).toBe(true);

    // Resource store on a separate in-memory db; resolver reads roles from the
    // real engine (its `getRole` satisfies ResolverRoleSource structurally).
    const storeDb = new Database(":memory:");
    const sres = PluginResourceStore.initialize(
      storeDb,
      MIGRATIONS_DIR,
      (dir) => readdirSync(dir),
      (path) => readFileSync(path, "utf-8"),
    );
    if (!sres.ok) throw new TestMigrationError("plugin-resources", sres.error);
    const store = new PluginResourceStore(storeDb);
    store.registerType(ALBUM_TYPE);
    store.createResource({ ...albumKey("a1") });
    store.grant(albumKey("a1"), { kind: "role", roleId: moderator.id }, "read", "dad");

    const resolver = new PluginResourceResolver({
      store,
      roles: engine,
      isBanned: () => false,
      isMember: (_serverId, _userId) => false,
    });

    const allowed = resolver.canReadPluginResource(viewer("billy"), albumRef("a1"));
    expect(allowed.allowed).toBe(true);
    expect(allowed.reason).toBe("role-allow");

    // sarah has no assignment → falls back to the default member role, which the
    // grant does not name → default-deny.
    const denied = resolver.canReadPluginResource(viewer("sarah"), albumRef("a1"));
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toBe("default-deny");
  });
});
