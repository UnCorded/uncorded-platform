import { afterAll, beforeAll, beforeEach, describe, expect, test, mock } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import * as _realNodeOs from "node:os";
// Snapshot the real node:os exports into a plain object now, before any
// mock.module call. `import * as` is a live binding, so reading
// _realNodeOs.platform after the mock applies would return the stubbed value
// — copy by value here so afterAll can restore the genuine module shape.
const realNodeOs = { ..._realNodeOs };
const { tmpdir } = _realNodeOs;

// server-registry reads/writes under homedir()/.uncorded. Stub homedir() via
// mock.module("node:os") so every test runs against a disposable temp dir.

const tmpRoot = mkdtempSync(join(tmpdir(), "uncorded-reg-test-"));

let registryModule: typeof import("./server-registry");

beforeAll(async () => {
  // Spread the real exports so other modules that need os.platform, os.cpus,
  // etc. continue to work — only homedir is stubbed here.
  await mock.module("node:os", () => ({
    ...realNodeOs,
    homedir: () => tmpRoot,
  }));
  registryModule = await import("./server-registry");
});

afterAll(async () => {
  rmSync(tmpRoot, { recursive: true, force: true });
  await mock.module("node:os", () => realNodeOs);
});

function registryPath(): string {
  return join(tmpRoot, ".uncorded", "registry.json");
}

function quarantineFiles(): string[] {
  const dir = join(tmpRoot, ".uncorded");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => n.startsWith("registry.quarantine-"));
}

beforeEach(() => {
  registryModule.__resetQuarantineFlagForTests();
  // Clean registry + quarantines between tests so module-level state resets.
  try { rmSync(join(tmpRoot, ".uncorded"), { recursive: true, force: true }); }
  catch { /* nothing to clean on first run */ }
});

describe("server-registry — happy paths", () => {
  test("register → get → list → remove round-trip", () => {
    const { registerServer, getServerRecord, listServerRecords, removeServerRecord } = registryModule;
    registerServer("srv-A", { containerId: "c1", volumePath: "/v/a", hostPort: 3001 });
    registerServer("srv-B", { containerId: "c2", volumePath: "/v/b", hostPort: 3002, tunnelPublicHostname: "host-b" });

    expect(getServerRecord("srv-A")).toEqual({ containerId: "c1", volumePath: "/v/a", hostPort: 3001 });
    expect(getServerRecord("srv-B")?.tunnelPublicHostname).toBe("host-b");

    const list = listServerRecords();
    expect(list.length).toBe(2);

    removeServerRecord("srv-A");
    expect(getServerRecord("srv-A")).toBeNull();
    expect(listServerRecords().length).toBe(1);
  });

  test("persists as a schemaVersion envelope", () => {
    const { registerServer } = registryModule;
    registerServer("srv-X", { containerId: "cx", volumePath: "/vx", hostPort: 4000 });
    const raw = JSON.parse(readFileSync(registryPath(), "utf8")) as Record<string, unknown>;
    expect(raw["schemaVersion"]).toBe(1);
    expect((raw["entries"] as Record<string, unknown>)["srv-X"]).toBeDefined();
  });

  test("missing file reads as empty, no quarantine", () => {
    const { listServerRecords, registryWasQuarantinedThisSession } = registryModule;
    expect(listServerRecords()).toEqual([]);
    expect(registryWasQuarantinedThisSession()).toBe(false);
  });
});

describe("server-registry — quarantine + migration", () => {
  test("corrupt JSON is quarantined and session flag is set", () => {
    const { listServerRecords, registryWasQuarantinedThisSession, lastQuarantinePath } = registryModule;
    const dir = join(tmpRoot, ".uncorded");
    require("node:fs").mkdirSync(dir, { recursive: true });
    writeFileSync(registryPath(), "{not valid json", "utf8");

    const list = listServerRecords();
    expect(list).toEqual([]);
    expect(registryWasQuarantinedThisSession()).toBe(true);
    expect(lastQuarantinePath()).not.toBeNull();
    expect(quarantineFiles().length).toBe(1);
    // A fresh empty envelope should replace the corrupt file.
    const fresh = JSON.parse(readFileSync(registryPath(), "utf8")) as Record<string, unknown>;
    expect(fresh).toEqual({ schemaVersion: 1, entries: {} });
  });

  test("envelope with wrong shape is quarantined", () => {
    const { listServerRecords, registryWasQuarantinedThisSession } = registryModule;
    require("node:fs").mkdirSync(join(tmpRoot, ".uncorded"), { recursive: true });
    writeFileSync(registryPath(), JSON.stringify({ schemaVersion: 2, wrong: true }), "utf8");
    expect(listServerRecords()).toEqual([]);
    expect(registryWasQuarantinedThisSession()).toBe(true);
  });

  test("v0 flat shape migrates to v1 without quarantine", () => {
    const { listServerRecords, registryWasQuarantinedThisSession, getServerRecord } = registryModule;
    require("node:fs").mkdirSync(join(tmpRoot, ".uncorded"), { recursive: true });
    const v0 = {
      "srv-old": { containerId: "co", volumePath: "/vo", hostPort: 5000 },
    };
    writeFileSync(registryPath(), JSON.stringify(v0), "utf8");
    const list = listServerRecords();
    expect(list.length).toBe(1);
    expect(getServerRecord("srv-old")?.containerId).toBe("co");
    expect(registryWasQuarantinedThisSession()).toBe(false);
    // File should be rewritten as an envelope.
    const rewritten = JSON.parse(readFileSync(registryPath(), "utf8")) as Record<string, unknown>;
    expect(rewritten["schemaVersion"]).toBe(1);
  });

  test("one bad entry among good entries: bad is dropped, good preserved, no quarantine", () => {
    const { listServerRecords, registryWasQuarantinedThisSession, getServerRecord } = registryModule;
    require("node:fs").mkdirSync(join(tmpRoot, ".uncorded"), { recursive: true });
    const mixed = {
      schemaVersion: 1,
      entries: {
        "good": { containerId: "g", volumePath: "/g", hostPort: 3000 },
        "bad": { containerId: "b", volumePath: "/b", hostPort: "not-a-number" },
      },
    };
    writeFileSync(registryPath(), JSON.stringify(mixed), "utf8");
    const list = listServerRecords();
    expect(list.length).toBe(1);
    expect(getServerRecord("good")).not.toBeNull();
    expect(getServerRecord("bad")).toBeNull();
    expect(registryWasQuarantinedThisSession()).toBe(false);
  });

  test("imageSignature round-trips through register → read → re-read", () => {
    const { registerServer, getServerRecord } = registryModule;
    const sig = {
      digest: "sha256:abcd1234",
      payloadJson: "{\"critical\":{}}",
      signatureB64: "MEUCIQDxxx",
    };
    registerServer("srv-sig", {
      containerId: "csig",
      volumePath: "/v/sig",
      hostPort: 6000,
      imageSignature: sig,
    });
    expect(getServerRecord("srv-sig")?.imageSignature).toEqual(sig);

    // Re-read from disk to confirm the schema/normalizer round-trips.
    const raw = JSON.parse(readFileSync(registryPath(), "utf8")) as {
      entries: Record<string, { imageSignature?: typeof sig }>;
    };
    expect(raw.entries["srv-sig"]?.imageSignature).toEqual(sig);
  });

  test("records without imageSignature parse cleanly (back-compat)", () => {
    const { listServerRecords, getServerRecord } = registryModule;
    require("node:fs").mkdirSync(join(tmpRoot, ".uncorded"), { recursive: true });
    const legacy = {
      schemaVersion: 1,
      entries: {
        "srv-legacy": { containerId: "cl", volumePath: "/vl", hostPort: 7000 },
      },
    };
    writeFileSync(registryPath(), JSON.stringify(legacy), "utf8");
    expect(listServerRecords().length).toBe(1);
    const rec = getServerRecord("srv-legacy");
    expect(rec).not.toBeNull();
    expect(rec?.imageSignature).toBeUndefined();
  });

  test("__resetQuarantineFlagForTests clears session state", () => {
    const { listServerRecords, registryWasQuarantinedThisSession, __resetQuarantineFlagForTests, lastQuarantinePath } = registryModule;
    require("node:fs").mkdirSync(join(tmpRoot, ".uncorded"), { recursive: true });
    writeFileSync(registryPath(), "not json", "utf8");
    listServerRecords();
    expect(registryWasQuarantinedThisSession()).toBe(true);

    __resetQuarantineFlagForTests();
    expect(registryWasQuarantinedThisSession()).toBe(false);
    expect(lastQuarantinePath()).toBeNull();
  });
});
