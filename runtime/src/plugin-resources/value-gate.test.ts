// PluginResourceValueGate (RP-FOUND-4) focused tests.
//
// The security contract under test is "authorize, THEN materialize":
//   - a denied or secret or unsupported slot NEVER reaches adapter.resolveValue;
//   - on allow, the adapter is consulted strictly AFTER the resolver allowed
//     (asserted via a shared call-order log);
//   - a `producerValueAllowed: false` slot's visible bytes equal exactly what
//     the adapter returned — structurally proving the runtime-controlled path is
//     the only value source (no host/producer frame input exists on the gate).
//
// The resolver is mocked so each test pins allow/deny deterministically and
// records call order; the store is real so type/slot lookup and the temporary
// policy→action derivation run exactly as in production.

import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AuthDecision,
  PluginResourceRef,
  PluginResourceTypeRegistration,
  ValueSlotRef,
  ViewerContext,
} from "@uncorded/protocol";
import { PluginResourceStore } from "./store";
import type { PluginResourceResolver } from "./resolver";
import type { PluginResourceAdapter, AdapterResolveValueResult } from "./adapter";
import { PluginResourceValueGate, deriveSlotAction } from "./value-gate";

const MIGRATIONS_DIR = join(import.meta.dir, "migrations");
const SERVER = "srv-1";
const PLUGIN = "family-album";

const ALBUM_TYPE: PluginResourceTypeRegistration = {
  pluginSlug: PLUGIN,
  type: "album",
  actions: ["read", "comment"],
  inheritableActions: ["read"],
  valueSlots: {
    title: { policy: "album.read" },
    locked: { policy: "album.read", secret: true },
    nodot: { policy: "nopolicy" }, // unparseable → unsupported
    teleport: { policy: "album.teleport" }, // action not declared → unsupported
  },
  producerValueAllowed: false,
};

function albumRef(id: string): PluginResourceRef {
  return { kind: "pluginResource", pluginSlug: PLUGIN, resourceType: "album", resourceId: id };
}
function viewer(userId: string): ViewerContext {
  return { userId, serverId: SERVER };
}
function slot(ref: PluginResourceRef, name: string): ValueSlotRef {
  return { resource: ref, slot: name };
}

function allowDecision(): AuthDecision {
  return { allowed: true, reason: "explicit-allow", versions: { resourceAclVersion: 4, resourcePermissionVersion: 2 } };
}
function denyDecision(): AuthDecision {
  return { allowed: false, reason: "default-deny", versions: { resourceAclVersion: 4, resourcePermissionVersion: 2 } };
}

interface Harness {
  gate: PluginResourceValueGate;
  callLog: string[];
  setDecision: (d: AuthDecision) => void;
  setAdapterResult: (r: AdapterResolveValueResult | null) => void;
}

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
  store.registerType(ALBUM_TYPE);

  const callLog: string[] = [];
  let decision: AuthDecision = allowDecision();
  let adapterResult: AdapterResolveValueResult | null = {
    exists: true,
    value: "the-real-bytes",
    valueVersion: 3,
  };

  // Mock resolver: records when it was consulted and returns the pinned
  // decision. Cast through unknown because the gate's dep is the concrete
  // (nominal) resolver class; here we only need its two query methods.
  const resolver = {
    canPluginResourceAction: (_v: ViewerContext, _r: PluginResourceRef, _a: string): AuthDecision => {
      callLog.push("resolver");
      return decision;
    },
    canReadPluginResource: (_v: ViewerContext, _r: PluginResourceRef): AuthDecision => {
      callLog.push("resolver");
      return decision;
    },
  } as unknown as PluginResourceResolver;

  const adapter: PluginResourceAdapter = {
    describe: async () => null,
    resolveValue: async (): Promise<AdapterResolveValueResult | null> => {
      callLog.push("adapter");
      return adapterResult;
    },
  };

  const gate = new PluginResourceValueGate({ store, resolver, adapter });
  return {
    gate,
    callLog,
    setDecision: (d) => {
      decision = d;
    },
    setAdapterResult: (r) => {
      adapterResult = r;
    },
  };
}

// ---------------------------------------------------------------------------
// deriveSlotAction — the temporary V1 policy→action mapping
// ---------------------------------------------------------------------------

describe("deriveSlotAction (V1, temporary)", () => {
  test("takes the segment after the first dot", () => {
    expect(deriveSlotAction("album.read")).toBe("read");
    expect(deriveSlotAction("album.family-album:download")).toBe("family-album:download");
  });

  test("keeps everything after the FIRST dot (later dots are part of the action)", () => {
    expect(deriveSlotAction("a.b.c")).toBe("b.c");
  });

  test("fails closed (null) when there is no dot or an empty action", () => {
    expect(deriveSlotAction("nopolicy")).toBeNull();
    expect(deriveSlotAction("album.")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Authorize-then-materialize ordering
// ---------------------------------------------------------------------------

describe("materializeValue ordering & gating", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  test("deny → withheld(synthetic), adapter NEVER called", async () => {
    h.setDecision(denyDecision());
    const r = await h.gate.materializeValue(viewer("billy"), slot(albumRef("a1"), "title"));
    expect(r.state).toBe("withheld");
    if (r.state === "withheld") {
      expect(r.placeholderShape).toEqual({ mode: "synthetic" });
      expect(r.versions.resourceAclVersion).toBe(4);
    }
    expect(h.callLog).toEqual(["resolver"]); // resolver ran; adapter did not
  });

  test("allow + non-secret → visible, adapter called STRICTLY AFTER the resolver", async () => {
    h.setDecision(allowDecision());
    const r = await h.gate.materializeValue(viewer("billy"), slot(albumRef("a1"), "title"));
    expect(r.state).toBe("visible");
    if (r.state === "visible") {
      expect(r.value).toBe("the-real-bytes");
      expect(r.versions.resourceAclVersion).toBe(4);
    }
    expect(h.callLog).toEqual(["resolver", "adapter"]);
  });

  test("producerValueAllowed:false slot → visible bytes equal the adapter's bytes (runtime path)", async () => {
    // The gate has no host/producer-frame input, so for a producer-disallowed
    // slot an authorized viewer's bytes can only have come from the adapter.
    expect(ALBUM_TYPE.producerValueAllowed).toBe(false);
    h.setDecision(allowDecision());
    h.setAdapterResult({ exists: true, value: { caption: "from-runtime" }, valueVersion: 9 });
    const r = await h.gate.materializeValue(viewer("billy"), slot(albumRef("a1"), "title"));
    expect(r.state).toBe("visible");
    if (r.state === "visible") {
      expect(r.value).toEqual({ caption: "from-runtime" });
    }
  });

  test("secret slot → withheld(absent), adapter NEVER called even when allowed", async () => {
    h.setDecision(allowDecision());
    const r = await h.gate.materializeValue(viewer("billy"), slot(albumRef("a1"), "locked"));
    expect(r.state).toBe("withheld");
    if (r.state === "withheld") {
      expect(r.placeholderShape).toEqual({ mode: "absent" });
    }
    expect(h.callLog).toEqual(["resolver"]); // resolver consulted for versions; adapter not
  });

  test("unknown resource type → unsupported, neither resolver nor adapter called", async () => {
    const ghost: PluginResourceRef = { kind: "pluginResource", pluginSlug: PLUGIN, resourceType: "ghost", resourceId: "x" };
    const r = await h.gate.materializeValue(viewer("billy"), slot(ghost, "title"));
    expect(r.state).toBe("unsupported");
    expect(h.callLog).toEqual([]);
  });

  test("unknown slot → unsupported, neither resolver nor adapter called", async () => {
    const r = await h.gate.materializeValue(viewer("billy"), slot(albumRef("a1"), "missing"));
    expect(r.state).toBe("unsupported");
    expect(h.callLog).toEqual([]);
  });

  test("unparseable policy (no dot) → unsupported before adapter", async () => {
    const r = await h.gate.materializeValue(viewer("billy"), slot(albumRef("a1"), "nodot"));
    expect(r.state).toBe("unsupported");
    expect(h.callLog).toEqual([]);
  });

  test("policy deriving an UNDECLARED action → unsupported before adapter", async () => {
    const r = await h.gate.materializeValue(viewer("billy"), slot(albumRef("a1"), "teleport"));
    expect(r.state).toBe("unsupported");
    expect(h.callLog).toEqual([]);
  });

  test("allow but adapter returns null → fail closed to withheld(synthetic)", async () => {
    h.setDecision(allowDecision());
    h.setAdapterResult(null);
    const r = await h.gate.materializeValue(viewer("billy"), slot(albumRef("a1"), "title"));
    expect(r.state).toBe("withheld");
    expect(h.callLog).toEqual(["resolver", "adapter"]);
  });

  test("allow but adapter reports exists:false → fail closed to withheld", async () => {
    h.setDecision(allowDecision());
    h.setAdapterResult({ exists: false, valueVersion: 1 });
    const r = await h.gate.materializeValue(viewer("billy"), slot(albumRef("a1"), "title"));
    expect(r.state).toBe("withheld");
  });
});
