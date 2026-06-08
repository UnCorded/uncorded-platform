// handlePluginResourcesIpc (RP-FOUND-4) focused tests.
//
// Drives the dispatch handler directly against the real RP-FOUND-2 store and
// RP-FOUND-3 resolver with a fake transport, asserting the TWO-AUTHORITY split:
//   - plugin-caller authority (this layer): own-plugin define/create/grant/
//     revoke are stamped with the caller's slug; cross-plugin WRITES are
//     rejected (CROSS_PLUGIN_WRITE_FORBIDDEN) and cross-plugin READS without a
//     declared `resources.read:<plugin>` capability are rejected
//     (CAPABILITY_DENIED) — both BEFORE the resolver/store is consulted;
//   - user-ACL authority (the resolver): `check` returns its AuthDecision
//     verbatim, and unknown resources fail closed inside it.

import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  IpcMessage,
  IpcTransport,
  PluginResourceKey,
  PluginResourceRef,
} from "@uncorded/protocol";
import { PluginResourceStore } from "./store";
import { PluginResourceResolver } from "./resolver";
import { handlePluginResourcesIpc, type PluginResourceIpcDeps } from "./ipc";

const MIGRATIONS_DIR = join(import.meta.dir, "migrations");
const SERVER = "srv-1";
const PLUGIN = "family-album";
const OTHER = "weather-widget";

interface ResponseMsg {
  type: "response";
  id: string;
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
}

interface Harness {
  store: PluginResourceStore;
  resolver: PluginResourceResolver;
  members: Set<string>;
  capabilities: Set<string>;
  /** Dispatch a message as `callerSlug` and return the single response sent. */
  call: (callerSlug: string, message: Record<string, unknown>) => ResponseMsg;
}

function albumRef(id: string): PluginResourceRef {
  return { kind: "pluginResource", pluginSlug: PLUGIN, resourceType: "album", resourceId: id };
}
function albumKey(id: string): PluginResourceKey {
  return { serverId: SERVER, pluginSlug: PLUGIN, resourceType: "album", resourceId: id };
}

const ALBUM_REGISTRATION = {
  type: "album",
  actions: ["read", "comment"],
  inheritableActions: ["read"],
  valueSlots: { title: { policy: "album.read" } },
  producerValueAllowed: false,
};

function makeHarness(): Harness {
  const db = new Database(":memory:");
  const init = PluginResourceStore.initialize(
    db,
    MIGRATIONS_DIR,
    (dir) => readdirSync(dir),
    (path) => readFileSync(path, "utf-8"),
  );
  if (!init.ok) throw new Error(`migration failed: ${init.error.message}`);
  const store = new PluginResourceStore(db);

  const members = new Set<string>();
  const resolver = new PluginResourceResolver({
    store,
    roles: { getRole: () => ({ id: 1 }) },
    isBanned: () => false,
    isMember: (serverId, userId) => members.has(`${serverId}:${userId}`),
  });

  const capabilities = new Set<string>();
  const deps: PluginResourceIpcDeps = {
    store,
    resolver,
    serverId: SERVER,
    checkCapability: (cap) => capabilities.has(cap),
  };

  const sent: IpcMessage[] = [];
  const transport = {
    send: (m: IpcMessage) => {
      sent.push(m);
    },
  } as unknown as IpcTransport;

  function call(callerSlug: string, message: Record<string, unknown>): ResponseMsg {
    sent.length = 0;
    handlePluginResourcesIpc(callerSlug, message as unknown as IpcMessage, transport, deps);
    expect(sent.length).toBe(1);
    return sent[0] as unknown as ResponseMsg;
  }

  return { store, resolver, members, capabilities, call };
}

// ---------------------------------------------------------------------------
// define / create — own-plugin, slug-stamped
// ---------------------------------------------------------------------------

describe("define & create", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  test("define registers the type and stamps the caller's slug", () => {
    const res = h.call(PLUGIN, { type: "resources.define", id: "1", registration: ALBUM_REGISTRATION });
    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({ ok: true });
    const stored = h.store.getType(PLUGIN, "album");
    expect(stored).not.toBeNull();
    expect(stored?.pluginSlug).toBe(PLUGIN);
  });

  test("define ignores a caller-supplied pluginSlug and stamps the caller's instead", () => {
    const res = h.call(PLUGIN, {
      type: "resources.define",
      id: "1",
      registration: { ...ALBUM_REGISTRATION, pluginSlug: OTHER },
    });
    expect(res.error).toBeUndefined();
    expect(h.store.getType(PLUGIN, "album")?.pluginSlug).toBe(PLUGIN);
    expect(h.store.getType(OTHER, "album")).toBeNull();
  });

  test("define without a registration object → INVALID_PARAMS", () => {
    const res = h.call(PLUGIN, { type: "resources.define", id: "1" });
    expect(res.error?.code).toBe("INVALID_PARAMS");
  });

  test("create persists the instance (with owner) and returns its ref", () => {
    h.call(PLUGIN, { type: "resources.define", id: "1", registration: ALBUM_REGISTRATION });
    const res = h.call(PLUGIN, {
      type: "resources.create",
      id: "2",
      resourceType: "album",
      resourceId: "a1",
      owner: { userId: "dad" },
    });
    expect(res.error).toBeUndefined();
    expect(res.result?.ref).toEqual(albumRef("a1"));
    const stored = h.store.getResource(albumKey("a1"));
    expect(stored?.ownerUserIds).toEqual(["dad"]);
  });
});

// ---------------------------------------------------------------------------
// grant / revoke — own-plugin mutate; cross-plugin forbidden
// ---------------------------------------------------------------------------

describe("grant & revoke", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
    h.call(PLUGIN, { type: "resources.define", id: "d", registration: ALBUM_REGISTRATION });
    h.call(PLUGIN, { type: "resources.create", id: "c", resourceType: "album", resourceId: "a1" });
  });

  test("grant adds an allow row, bumps aclVersion, and the resolver now allows", () => {
    const before = h.store.getResource(albumKey("a1"))!.aclVersion;
    const res = h.call(PLUGIN, {
      type: "resources.grant",
      id: "g",
      resource: albumRef("a1"),
      principal: { kind: "user", userId: "billy" },
      action: "read",
    });
    expect(res.error).toBeUndefined();
    expect(res.result?.ok).toBe(true);
    expect(res.result?.aclVersion as number).toBeGreaterThan(before);
    const d = h.resolver.canReadPluginResource({ userId: "billy", serverId: SERVER }, albumRef("a1"));
    expect(d.allowed).toBe(true);
  });

  test("revoke removes the row and the resolver returns to default-deny", () => {
    h.call(PLUGIN, {
      type: "resources.grant",
      id: "g",
      resource: albumRef("a1"),
      principal: { kind: "user", userId: "billy" },
      action: "read",
    });
    const res = h.call(PLUGIN, {
      type: "resources.revoke",
      id: "r",
      resource: albumRef("a1"),
      principal: { kind: "user", userId: "billy" },
      action: "read",
    });
    expect(res.error).toBeUndefined();
    expect(res.result?.ok).toBe(true);
    const d = h.resolver.canReadPluginResource({ userId: "billy", serverId: SERVER }, albumRef("a1"));
    expect(d.allowed).toBe(false);
  });

  test("cross-plugin grant is rejected with CROSS_PLUGIN_WRITE_FORBIDDEN (even with a read capability)", () => {
    h.capabilities.add(`resources.read:${PLUGIN}`); // a read cap must NOT enable writes
    const res = h.call(OTHER, {
      type: "resources.grant",
      id: "g",
      resource: albumRef("a1"),
      principal: { kind: "user", userId: "billy" },
      action: "read",
    });
    expect(res.error?.code).toBe("CROSS_PLUGIN_WRITE_FORBIDDEN");
  });

  test("cross-plugin revoke is rejected with CROSS_PLUGIN_WRITE_FORBIDDEN", () => {
    const res = h.call(OTHER, {
      type: "resources.revoke",
      id: "r",
      resource: albumRef("a1"),
      principal: { kind: "user", userId: "billy" },
      action: "read",
    });
    expect(res.error?.code).toBe("CROSS_PLUGIN_WRITE_FORBIDDEN");
  });
});

// ---------------------------------------------------------------------------
// check — resolver AuthDecision; cross-plugin read capability-gated
// ---------------------------------------------------------------------------

describe("check", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
    h.call(PLUGIN, { type: "resources.define", id: "d", registration: ALBUM_REGISTRATION });
    h.call(PLUGIN, { type: "resources.create", id: "c", resourceType: "album", resourceId: "a1" });
  });

  test("own-plugin check returns the resolver's AuthDecision verbatim", () => {
    h.call(PLUGIN, {
      type: "resources.grant",
      id: "g",
      resource: albumRef("a1"),
      principal: { kind: "user", userId: "billy" },
      action: "read",
    });
    const res = h.call(PLUGIN, {
      type: "resources.check",
      id: "ck",
      user_id: "billy",
      resource: albumRef("a1"),
      action: "read",
    });
    expect(res.error).toBeUndefined();
    expect(res.result?.allowed).toBe(true);
    expect(res.result?.reason).toBe("explicit-allow");
  });

  test("unknown resource fails closed inside the resolver (a denied decision, not an error)", () => {
    const res = h.call(PLUGIN, {
      type: "resources.check",
      id: "ck",
      user_id: "billy",
      resource: albumRef("ghost"),
      action: "read",
    });
    expect(res.error).toBeUndefined();
    expect(res.result?.allowed).toBe(false);
    expect(res.result?.reason).toBe("unknown-resource");
  });

  test("cross-plugin check WITHOUT the read capability → CAPABILITY_DENIED before the resolver", () => {
    // OTHER has no `resources.read:family-album`. The capability gate must reject
    // before the resolver runs — proven by getting an ERROR rather than the
    // resolver's default-deny DECISION.
    const res = h.call(OTHER, {
      type: "resources.check",
      id: "ck",
      user_id: "billy",
      resource: albumRef("a1"),
      action: "read",
    });
    expect(res.result).toBeUndefined();
    expect(res.error?.code).toBe("CAPABILITY_DENIED");
  });

  test("cross-plugin check WITH the read capability reaches the resolver (returns a decision)", () => {
    h.capabilities.add(`resources.read:${PLUGIN}`);
    const res = h.call(OTHER, {
      type: "resources.check",
      id: "ck",
      user_id: "billy",
      resource: albumRef("a1"),
      action: "read",
    });
    expect(res.error).toBeUndefined();
    expect(res.result?.allowed).toBe(false);
    expect(res.result?.reason).toBe("default-deny");
  });
});
