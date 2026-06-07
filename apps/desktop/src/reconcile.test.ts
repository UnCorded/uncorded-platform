import { beforeEach, describe, expect, mock, test } from "bun:test";
import { reconcileRegistryWithCentral, type ReconcileDeps } from "./reconcile";

// Tests exercise the reconcile function as a pure unit with test-double deps.
// The real main.ts wiring (central.listServers / listServerRecords / quarantine
// flag / purgeLocalServer) is covered by the manual QA section of the
// server-lifecycle plan.

function makeDeps(overrides: Partial<ReconcileDeps>): ReconcileDeps {
  return {
    listRemoteServers: mock(async () => []),
    listLocalRecords: mock(() => []),
    wasQuarantinedThisSession: mock(() => false),
    purgeLocalServer: mock(async () => {}),
    log: {
      info: mock(),
      warn: mock(),
      error: mock(),
    },
    ...overrides,
  };
}

function record(serverId: string) {
  return {
    serverId,
    record: { containerId: `c-${serverId}`, volumePath: `/v/${serverId}`, hostPort: 3000 },
  };
}

function remote(id: string) {
  return { id, name: id };
}

describe("reconcileRegistryWithCentral", () => {
  let infoLog: ReturnType<typeof mock>;
  let warnLog: ReturnType<typeof mock>;
  let errorLog: ReturnType<typeof mock>;

  beforeEach(() => {
    infoLog = mock();
    warnLog = mock();
    errorLog = mock();
  });

  function depsWithLogs(overrides: Partial<ReconcileDeps>): ReconcileDeps {
    return makeDeps({
      ...overrides,
      log: { info: infoLog, warn: warnLog, error: errorLog },
    });
  }

  test("skips entirely when registry was quarantined this session", async () => {
    const purge = mock(async () => {});
    const list = mock(async () => [remote("a"), remote("b"), remote("c")]);
    const deps = depsWithLogs({
      wasQuarantinedThisSession: () => true,
      listRemoteServers: list,
      listLocalRecords: () => [],
      purgeLocalServer: purge,
    });
    await reconcileRegistryWithCentral(deps);
    expect(list).not.toHaveBeenCalled();
    expect(purge).not.toHaveBeenCalled();
    expect(infoLog).toHaveBeenCalledWith("reconcile skipped — post-quarantine startup");
  });

  test("skips without purging when Central call rejects (offline boot)", async () => {
    const purge = mock(async () => {});
    const deps = depsWithLogs({
      listRemoteServers: async () => { throw new Error("network down"); },
      listLocalRecords: () => [record("a"), record("b")],
      purgeLocalServer: purge,
    });
    await reconcileRegistryWithCentral(deps);
    expect(purge).not.toHaveBeenCalled();
    expect(warnLog).toHaveBeenCalledWith(
      "reconcile skipped — central unreachable",
      { err: "network down" },
    );
  });

  test("skips without purging when Central returns a non-array shape", async () => {
    const purge = mock(async () => {});
    const deps = depsWithLogs({
      listRemoteServers: async () => ({ oops: "unexpected" }),
      listLocalRecords: () => [record("a")],
      purgeLocalServer: purge,
    });
    await reconcileRegistryWithCentral(deps);
    expect(purge).not.toHaveBeenCalled();
    expect(warnLog).toHaveBeenCalledWith("reconcile skipped — unexpected listServers response shape");
  });

  test("no orphans → no purges", async () => {
    const purge = mock(async () => {});
    const deps = depsWithLogs({
      listRemoteServers: async () => [remote("a"), remote("b")],
      listLocalRecords: () => [record("a"), record("b")],
      purgeLocalServer: purge,
    });
    await reconcileRegistryWithCentral(deps);
    expect(purge).not.toHaveBeenCalled();
  });

  test("exactly one orphan → one purge", async () => {
    const purge = mock(async () => {});
    const deps = depsWithLogs({
      listRemoteServers: async () => [remote("a"), remote("b")],
      listLocalRecords: () => [record("a"), record("b"), record("gone")],
      purgeLocalServer: purge,
    });
    await reconcileRegistryWithCentral(deps);
    expect(purge).toHaveBeenCalledTimes(1);
    expect(purge).toHaveBeenCalledWith("gone");
  });

  test("multiple orphans → all are purged in order", async () => {
    const seen: string[] = [];
    const purge = mock(async (id: string) => { seen.push(id); });
    const deps = depsWithLogs({
      listRemoteServers: async () => [remote("keep")],
      listLocalRecords: () => [record("keep"), record("orphan1"), record("orphan2")],
      purgeLocalServer: purge,
    });
    await reconcileRegistryWithCentral(deps);
    expect(purge).toHaveBeenCalledTimes(2);
    expect(seen).toEqual(["orphan1", "orphan2"]);
  });

  test("bail: Central returns empty while >=2 local records", async () => {
    const purge = mock(async () => {});
    const deps = depsWithLogs({
      listRemoteServers: async () => [],
      listLocalRecords: () => [record("a"), record("b"), record("c")],
      purgeLocalServer: purge,
    });
    await reconcileRegistryWithCentral(deps);
    expect(purge).not.toHaveBeenCalled();
    expect(warnLog).toHaveBeenCalledWith(
      "reconcile bailed — central returned empty list against >=2 local records",
      { local: 3 },
    );
  });

  test("single-entry genuine deletion: Central [] vs one local record → purge the one", async () => {
    // A user with exactly one server who deletes it from another client.
    // Central returns [], local has 1. This is a valid reconcile, not a
    // suspected bogus-response case.
    const purge = mock(async () => {});
    const deps = depsWithLogs({
      listRemoteServers: async () => [],
      listLocalRecords: () => [record("alone")],
      purgeLocalServer: purge,
    });
    await reconcileRegistryWithCentral(deps);
    expect(purge).toHaveBeenCalledTimes(1);
    expect(purge).toHaveBeenCalledWith("alone");
  });

  test("a purge failure is logged but doesn't block the rest", async () => {
    const purge = mock(async (id: string) => {
      if (id === "boom") throw new Error("docker rm failed");
    });
    const deps = depsWithLogs({
      listRemoteServers: async () => [],
      listLocalRecords: () => [record("boom"), record("ok")],
      purgeLocalServer: purge,
    });
    // Two orphans, and listServers returned empty against 2 locals → bail
    // guard triggers. Adjust: give Central one remote so reconcile proceeds
    // with the two local orphans (keep + boom + ok; keep is known remote).
    deps.listRemoteServers = async () => [remote("keep")];
    deps.listLocalRecords = () => [record("keep"), record("boom"), record("ok")];
    await reconcileRegistryWithCentral(deps);
    expect(purge).toHaveBeenCalledTimes(2);
    expect(errorLog).toHaveBeenCalledWith(
      "purgeLocalServer failed during reconcile",
      expect.objectContaining({ serverId: "boom" }),
    );
  });

  test("malformed remote entries (missing id) are skipped without crashing", async () => {
    const purge = mock(async () => {});
    const deps = depsWithLogs({
      listRemoteServers: async () => [
        remote("good"),
        null,
        { notAnId: true },
        { id: 42 },
        { id: "also-good" },
      ],
      listLocalRecords: () => [record("good"), record("also-good"), record("orphan")],
      purgeLocalServer: purge,
    });
    await reconcileRegistryWithCentral(deps);
    expect(purge).toHaveBeenCalledTimes(1);
    expect(purge).toHaveBeenCalledWith("orphan");
  });
});
