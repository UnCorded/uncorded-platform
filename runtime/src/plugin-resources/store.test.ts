// PluginResourceStore (RP-FOUND-2) focused tests.
//
// Covers: type registration (valid + invalid), instance create (valid +
// unregistered type), parent integrity (type match, cycle, depth bound), ACL
// row storage, action validation, version bumping, the no-content invariant,
// and migration / expected-table coverage. No resolver behavior is tested —
// there is none in this PR.

import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PluginResourceKey, PluginResourceTypeRegistration } from "@uncorded/protocol";
import { MAX_PLUGIN_RESOURCE_PARENT_DEPTH } from "@uncorded/protocol";
import { assertExpectedTables } from "../db/assert-tables";
import { PluginResourceStore } from "./store";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = join(import.meta.dir, "migrations");
const SERVER = "srv-1";
const PLUGIN = "family-album";

const ALBUM_TYPE: PluginResourceTypeRegistration = {
  pluginSlug: PLUGIN,
  type: "album",
  actions: ["read", "comment", "edit", "share", "admin", "family-album:download"],
  inheritableActions: ["read", "comment"],
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

// A self-parenting type, used to build deep chains / cycles cheaply.
const NODE_TYPE: PluginResourceTypeRegistration = {
  pluginSlug: PLUGIN,
  type: "node",
  parentType: "node",
  actions: ["read"],
  inheritableActions: [],
  valueSlots: {},
  producerValueAllowed: false,
};

function makeStore(): { db: Database; store: PluginResourceStore } {
  const db = new Database(":memory:");
  const result = PluginResourceStore.initialize(
    db,
    MIGRATIONS_DIR,
    (dir) => readdirSync(dir),
    (path) => readFileSync(path, "utf-8"),
  );
  if (!result.ok) throw new Error(`migration failed: ${result.error.message}`);
  return { db, store: new PluginResourceStore(db) };
}

function albumKey(id: string): PluginResourceKey {
  return { serverId: SERVER, pluginSlug: PLUGIN, resourceType: "album", resourceId: id };
}

function nodeKey(id: string): PluginResourceKey {
  return { serverId: SERVER, pluginSlug: PLUGIN, resourceType: "node", resourceId: id };
}

// ---------------------------------------------------------------------------
// Migration / expected-table coverage
// ---------------------------------------------------------------------------

describe("migrations", () => {
  test("creates the three resource tables", () => {
    const { db } = makeStore();
    expect(() =>
      assertExpectedTables(db, [
        "plugin_resource_types",
        "plugin_resources",
        "plugin_resource_acl",
      ]),
    ).not.toThrow();
  });

  test("is idempotent on re-run", () => {
    const { db } = makeStore();
    const second = PluginResourceStore.initialize(
      db,
      MIGRATIONS_DIR,
      (dir) => readdirSync(dir),
      (path) => readFileSync(path, "utf-8"),
    );
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.applied).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Type registration
// ---------------------------------------------------------------------------

describe("registerType", () => {
  let store: PluginResourceStore;
  beforeEach(() => {
    store = makeStore().store;
  });

  test("registers a valid resource type and stores actions/slots", () => {
    const res = store.registerType(ALBUM_TYPE);
    expect(res.ok).toBe(true);

    const stored = store.getType(PLUGIN, "album");
    expect(stored).not.toBeNull();
    expect(stored!.actions).toEqual(ALBUM_TYPE.actions);
    expect(stored!.inheritableActions).toEqual(["read", "comment"]);
    expect(stored!.valueSlots).toEqual({ title: { policy: "album.read" } });
    expect(stored!.producerValueAllowed).toBe(false);
    expect(stored!.parentType).toBeNull();
  });

  test("stores parentType for child types", () => {
    store.registerType(PHOTO_TYPE);
    expect(store.getType(PLUGIN, "photo")!.parentType).toBe("album");
  });

  test("rejects an invalid registration (bare unknown action)", () => {
    const bad = {
      ...ALBUM_TYPE,
      actions: ["read", "delete"], // "delete" is neither a base verb nor namespaced
      inheritableActions: ["read"],
    } as unknown as PluginResourceTypeRegistration;
    const res = store.registerType(bad);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("INVALID_REGISTRATION");
    expect(store.getType(PLUGIN, "album")).toBeNull();
  });

  test("rejects when inheritableActions is not a subset of actions", () => {
    const bad = {
      ...ALBUM_TYPE,
      inheritableActions: ["read", "family-album:nonexistent"], // not in actions
    } as unknown as PluginResourceTypeRegistration;
    const res = store.registerType(bad);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("INVALID_REGISTRATION");
  });

  test("re-registering the same type updates metadata in place", () => {
    store.registerType(ALBUM_TYPE);
    const updated: PluginResourceTypeRegistration = {
      ...ALBUM_TYPE,
      valueSlots: { title: { policy: "album.read" }, cover: { policy: "album.read" } },
    };
    expect(store.registerType(updated).ok).toBe(true);
    expect(Object.keys(store.getType(PLUGIN, "album")!.valueSlots).sort()).toEqual(["cover", "title"]);
  });
});

// ---------------------------------------------------------------------------
// Resource instances
// ---------------------------------------------------------------------------

describe("createResource", () => {
  let store: PluginResourceStore;
  beforeEach(() => {
    store = makeStore().store;
    store.registerType(ALBUM_TYPE);
    store.registerType(PHOTO_TYPE);
    store.registerType(NODE_TYPE);
  });

  test("creates a root resource with version + timestamps", () => {
    const res = store.createResource({
      serverId: SERVER,
      pluginSlug: PLUGIN,
      resourceType: "album",
      resourceId: "a1",
      ownerUserIds: ["dad"],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.depth).toBe(0);
    expect(res.value.parentId).toBeNull();
    expect(res.value.ownerUserIds).toEqual(["dad"]);
    expect(res.value.aclVersion).toBe(1);
    expect(res.value.permissionVersion).toBe(1);
    expect(res.value.createdAt).toBeGreaterThan(0);
  });

  test("rejects an unregistered resource type", () => {
    const res = store.createResource({
      serverId: SERVER,
      pluginSlug: PLUGIN,
      resourceType: "ghost",
      resourceId: "g1",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("UNKNOWN_RESOURCE_TYPE");
  });

  test("rejects a duplicate key", () => {
    store.createResource({ serverId: SERVER, pluginSlug: PLUGIN, resourceType: "album", resourceId: "a1" });
    const dup = store.createResource({ serverId: SERVER, pluginSlug: PLUGIN, resourceType: "album", resourceId: "a1" });
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.error.code).toBe("RESOURCE_EXISTS");
  });

  test("creates a child whose parent type matches the registered parentType", () => {
    store.createResource({ serverId: SERVER, pluginSlug: PLUGIN, resourceType: "album", resourceId: "a1" });
    const res = store.createResource({
      serverId: SERVER,
      pluginSlug: PLUGIN,
      resourceType: "photo",
      resourceId: "p1",
      parent: { resourceType: "album", resourceId: "a1" },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.parentType).toBe("album");
    expect(res.value.parentId).toBe("a1");
    expect(res.value.depth).toBe(1);
  });

  test("rejects a parent type mismatch", () => {
    store.createResource({ serverId: SERVER, pluginSlug: PLUGIN, resourceType: "album", resourceId: "a1" });
    const res = store.createResource({
      serverId: SERVER,
      pluginSlug: PLUGIN,
      resourceType: "photo",
      resourceId: "p1",
      parent: { resourceType: "photo", resourceId: "p0" }, // photo's parentType is "album"
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("PARENT_TYPE_MISMATCH");
  });

  test("rejects a missing parent", () => {
    const res = store.createResource({
      serverId: SERVER,
      pluginSlug: PLUGIN,
      resourceType: "photo",
      resourceId: "p1",
      parent: { resourceType: "album", resourceId: "nope" },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("PARENT_NOT_FOUND");
  });

  test("rejects creating a parent-typed resource as a root (no parent given)", () => {
    // photo declares parentType "album"; omitting the parent must reject rather
    // than silently create an orphan that cannot participate in the tree.
    const res = store.createResource({
      serverId: SERVER,
      pluginSlug: PLUGIN,
      resourceType: "photo",
      resourceId: "p1",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("PARENT_REQUIRED");
    expect(store.getResource({ serverId: SERVER, pluginSlug: PLUGIN, resourceType: "photo", resourceId: "p1" })).toBeNull();
  });

  test("allows a child sharing the parent's resourceId across different types", () => {
    // album:same and photo:same are distinct keys (type differs). The self-parent
    // cycle check must compare type AND id, not id alone.
    store.createResource({ serverId: SERVER, pluginSlug: PLUGIN, resourceType: "album", resourceId: "same" });
    const res = store.createResource({
      serverId: SERVER,
      pluginSlug: PLUGIN,
      resourceType: "photo",
      resourceId: "same",
      parent: { resourceType: "album", resourceId: "same" },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.parentType).toBe("album");
    expect(res.value.parentId).toBe("same");
    expect(res.value.depth).toBe(1);
  });

  test(`rejects a parent chain deeper than ${MAX_PLUGIN_RESOURCE_PARENT_DEPTH}`, () => {
    // node:node self-parenting chain. n0 (depth 0) .. nMAX (depth MAX) ok,
    // the next link would be depth MAX+1 and must reject.
    store.createResource({ serverId: SERVER, pluginSlug: PLUGIN, resourceType: "node", resourceId: "n0" });
    for (let d = 1; d <= MAX_PLUGIN_RESOURCE_PARENT_DEPTH; d++) {
      const res = store.createResource({
        serverId: SERVER,
        pluginSlug: PLUGIN,
        resourceType: "node",
        resourceId: `n${d}`,
        parent: { resourceType: "node", resourceId: `n${d - 1}` },
      });
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.value.depth).toBe(d);
    }
    const tooDeep = store.createResource({
      serverId: SERVER,
      pluginSlug: PLUGIN,
      resourceType: "node",
      resourceId: `n${MAX_PLUGIN_RESOURCE_PARENT_DEPTH + 1}`,
      parent: { resourceType: "node", resourceId: `n${MAX_PLUGIN_RESOURCE_PARENT_DEPTH}` },
    });
    expect(tooDeep.ok).toBe(false);
    if (!tooDeep.ok) expect(tooDeep.error.code).toBe("MAX_DEPTH_EXCEEDED");
  });

  test("does not store any plugin content value (metadata columns only)", () => {
    const { db, store: s } = makeStore();
    s.registerType(ALBUM_TYPE);
    s.createResource({ serverId: SERVER, pluginSlug: PLUGIN, resourceType: "album", resourceId: "a1", ownerUserIds: ["dad"] });
    const cols = db
      .query<{ name: string }, []>("PRAGMA table_info(plugin_resources)")
      .all()
      .map((r) => r.name)
      .sort();
    expect(cols).toEqual(
      [
        "acl_version",
        "created_at",
        "depth",
        "owner_user_ids",
        "parent_id",
        "parent_type",
        "permission_version",
        "plugin_slug",
        "resource_id",
        "resource_type",
        "server_id",
        "updated_at",
      ].sort(),
    );
    // No column name suggests content storage.
    expect(cols.some((c) => /value|content|title|pixels|caption|body|blob|data/.test(c))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Parent reassignment & cycles
// ---------------------------------------------------------------------------

describe("reassignParent", () => {
  let store: PluginResourceStore;
  beforeEach(() => {
    store = makeStore().store;
    store.registerType(NODE_TYPE);
  });

  test("rejects a self-parent cycle", () => {
    store.createResource({ serverId: SERVER, pluginSlug: PLUGIN, resourceType: "node", resourceId: "n0" });
    const res = store.reassignParent(nodeKey("n0"), { resourceType: "node", resourceId: "n0" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("PARENT_CYCLE");
  });

  test("rejects a deeper cycle (parent under its own descendant)", () => {
    store.createResource({ serverId: SERVER, pluginSlug: PLUGIN, resourceType: "node", resourceId: "n0" });
    store.createResource({
      serverId: SERVER,
      pluginSlug: PLUGIN,
      resourceType: "node",
      resourceId: "n1",
      parent: { resourceType: "node", resourceId: "n0" },
    });
    // n0 would become a child of its own descendant n1 → cycle.
    const res = store.reassignParent(nodeKey("n0"), { resourceType: "node", resourceId: "n1" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("PARENT_CYCLE");
  });

  test("a valid re-parent bumps the ACL version and updates depth", () => {
    store.createResource({ serverId: SERVER, pluginSlug: PLUGIN, resourceType: "node", resourceId: "root-a" });
    store.createResource({ serverId: SERVER, pluginSlug: PLUGIN, resourceType: "node", resourceId: "root-b" });
    store.createResource({
      serverId: SERVER,
      pluginSlug: PLUGIN,
      resourceType: "node",
      resourceId: "leaf",
      parent: { resourceType: "node", resourceId: "root-a" },
    });
    const before = store.getResource(nodeKey("leaf"))!;
    const res = store.reassignParent(nodeKey("leaf"), { resourceType: "node", resourceId: "root-b" });
    expect(res.ok).toBe(true);
    const after = store.getResource(nodeKey("leaf"))!;
    expect(after.parentId).toBe("root-b");
    expect(after.depth).toBe(1);
    expect(after.aclVersion).toBe(before.aclVersion + 1);
  });
});

// ---------------------------------------------------------------------------
// ACL rows
// ---------------------------------------------------------------------------

describe("ACL", () => {
  let store: PluginResourceStore;
  beforeEach(() => {
    store = makeStore().store;
    store.registerType(ALBUM_TYPE);
    store.createResource({ serverId: SERVER, pluginSlug: PLUGIN, resourceType: "album", resourceId: "a1" });
  });

  test("stores allow/deny rows with provenance", () => {
    expect(store.grant(albumKey("a1"), { kind: "user", userId: "billy" }, "read", "dad").ok).toBe(true);
    expect(store.deny(albumKey("a1"), { kind: "user", userId: "sarah" }, "read", "dad").ok).toBe(true);
    expect(store.grant(albumKey("a1"), { kind: "role", roleId: 3 }, "comment", "system", "registry-seeded").ok).toBe(true);
    expect(store.grant(albumKey("a1"), { kind: "everyone" }, "read", "dad").ok).toBe(true);

    const rows = store.listAcl(albumKey("a1"));
    expect(rows).toHaveLength(4);

    const billy = rows.find((r) => r.principal.kind === "user" && r.principal.userId === "billy")!;
    expect(billy.effect).toBe("allow");
    expect(billy.action).toBe("read");
    expect(billy.grantedBy).toBe("dad");
    expect(billy.source).toBe("explicit");
    expect(billy.grantedAt).toBeGreaterThan(0);

    const seeded = rows.find((r) => r.principal.kind === "role")!;
    expect(seeded.source).toBe("registry-seeded");
    expect(seeded.principal).toEqual({ kind: "role", roleId: 3 });
  });

  test("a repeated grant on the same (principal, action) upserts, not duplicates", () => {
    store.grant(albumKey("a1"), { kind: "user", userId: "billy" }, "read", "dad");
    store.deny(albumKey("a1"), { kind: "user", userId: "billy" }, "read", "mom");
    const rows = store.listAcl(albumKey("a1"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.effect).toBe("deny");
    expect(rows[0]!.grantedBy).toBe("mom");
  });

  test("rejects an action not declared by the resource type", () => {
    const res = store.grant(albumKey("a1"), { kind: "user", userId: "billy" }, "family-album:upload", "dad");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("INVALID_ACTION");
    expect(store.listAcl(albumKey("a1"))).toHaveLength(0);
  });

  test("rejects an ACL write against an unknown resource", () => {
    const res = store.grant(albumKey("missing"), { kind: "user", userId: "billy" }, "read", "dad");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("UNKNOWN_RESOURCE");
  });

  test("rejects a malformed principal", () => {
    const res = store.grant(
      albumKey("a1"),
      { kind: "role", roleId: 0 } as unknown as { kind: "role"; roleId: number },
      "read",
      "dad",
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("INVALID_PRINCIPAL");
  });

  test("grant / deny / revoke each bump the resource ACL version", () => {
    expect(store.getResource(albumKey("a1"))!.aclVersion).toBe(1);

    store.grant(albumKey("a1"), { kind: "user", userId: "billy" }, "read", "dad");
    expect(store.getResource(albumKey("a1"))!.aclVersion).toBe(2);

    store.deny(albumKey("a1"), { kind: "user", userId: "sarah" }, "read", "dad");
    expect(store.getResource(albumKey("a1"))!.aclVersion).toBe(3);

    store.revoke(albumKey("a1"), { kind: "user", userId: "billy" }, "read");
    expect(store.getResource(albumKey("a1"))!.aclVersion).toBe(4);
  });

  test("revoke on a non-existent row does not bump the version", () => {
    store.grant(albumKey("a1"), { kind: "user", userId: "billy" }, "read", "dad"); // v2
    store.revoke(albumKey("a1"), { kind: "user", userId: "nobody" }, "read"); // no-op
    expect(store.getResource(albumKey("a1"))!.aclVersion).toBe(2);
  });

  test("setOwner bumps the ACL version", () => {
    const before = store.getResource(albumKey("a1"))!.aclVersion;
    expect(store.setOwner(albumKey("a1"), ["dad", "mom"]).ok).toBe(true);
    const after = store.getResource(albumKey("a1"))!;
    expect(after.aclVersion).toBe(before + 1);
    expect(after.ownerUserIds).toEqual(["dad", "mom"]);
  });
});
