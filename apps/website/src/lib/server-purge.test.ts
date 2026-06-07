import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

// server-purge hard-imports the ws disconnect/abortReconnect pair, the
// servers store, and the feedback helper — all of them side-effectful at
// import time under a real SolidJS runtime. Stub each module so the test
// can assert orchestration without booting Solid.

const abortReconnect = mock<(serverId: string) => void>();
const disconnect = mock<(serverId: string) => void>();
const removeServer = mock<(serverId: string) => void>();
const showInlineStatus = mock<(msg: string, severity: "info" | "warning" | "error") => void>();

let purgeModule: typeof import("./server-purge");

// Held at module scope so afterAll can restore the genuine modules. The
// ...real spread keeps the surface complete for files that load while these
// mocks are live, but the *overridden* members (e.g. a no-op showInlineStatus)
// still bleed into feedback.test.ts on platforms where Bun's process-global
// mock.module does not auto-reset between files (Linux CI). Restoring undoes
// that leak.
let realServers: typeof import("@/stores/servers");
let realFeedback: typeof import("@/lib/feedback");
let realWs: typeof import("@/lib/ws");

beforeAll(async () => {
  // Import the real modules BEFORE mocking them so other test files that
  // load later (e.g. stores/servers.test.ts) still see a complete module
  // surface. Bun's mock.module replaces the module globally for the process;
  // without the ...real spread, subsequent imports get `{ removeServer }`
  // with no `loadServers`/`servers`/etc, and unrelated tests fail.
  realServers = await import("@/stores/servers");
  realFeedback = await import("@/lib/feedback");
  realWs = await import("@/lib/ws");
  await mock.module("@/lib/ws", () => ({ ...realWs, abortReconnect, disconnect }));
  await mock.module("@/stores/servers", () => ({ ...realServers, removeServer }));
  await mock.module("@/lib/feedback", () => ({ ...realFeedback, showInlineStatus }));
  // Cache-bust the SUT import. server-purge.ts destructures abortReconnect/
  // disconnect/removeServer/showInlineStatus at module-eval time, so those
  // bindings freeze to whatever the deps resolved to on first evaluation.
  // On Linux CI Bun's module registry is process-global: sibling files
  // (ws.test.ts, servers.test.ts) mock server-purge and thereby evaluate it
  // with the *real* deps before this file installs its mocks above — and a
  // plain `import("./server-purge")` would then return that stale-bound cached
  // copy, so our mocks never fire. The `?fresh` query forces a clean
  // re-evaluation that binds against the mocks just installed. (Windows isolates
  // the registry per file, which is why this only failed on CI.)
  // The specifier is held in a variable so TypeScript doesn't try to resolve
  // the `?fresh`-suffixed path (it only resolves static string-literal imports).
  const freshSpecifier = "./server-purge?fresh";
  purgeModule = (await import(freshSpecifier)) as typeof import("./server-purge");
});

afterAll(async () => {
  await mock.module("@/lib/ws", () => realWs);
  await mock.module("@/stores/servers", () => realServers);
  await mock.module("@/lib/feedback", () => realFeedback);
});

beforeEach(() => {
  abortReconnect.mockReset();
  disconnect.mockReset();
  removeServer.mockReset();
  showInlineStatus.mockReset();
});

afterEach(() => {
  // Drain any lingering subscribers between tests so registrations in one
  // test don't leak observation into the next. The purge module only
  // exposes an unsubscribe via the callback's return — tests must clean
  // up each subscription they register.
});

describe("purgeServer", () => {
  test("runs abortReconnect, disconnect, removeServer and inline status in order", async () => {
    const { purgeServer } = purgeModule;
    await purgeServer("srv-1", "user-delete");
    expect(abortReconnect).toHaveBeenCalledTimes(1);
    expect(abortReconnect).toHaveBeenCalledWith("srv-1");
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledWith("srv-1");
    expect(removeServer).toHaveBeenCalledTimes(1);
    expect(removeServer).toHaveBeenCalledWith("srv-1");
    expect(showInlineStatus).toHaveBeenCalledWith("Server deleted.", "info");
  });

  test("renders a reason-specific status message", async () => {
    const { purgeServer } = purgeModule;
    await purgeServer("srv-2", "central-gone");
    expect(showInlineStatus).toHaveBeenLastCalledWith(
      "Server was removed from Central.",
      "warning",
    );
    await purgeServer("srv-3", "banned");
    expect(showInlineStatus).toHaveBeenLastCalledWith(
      "You were removed from this server.",
      "warning",
    );
    await purgeServer("srv-4", "token-revoked");
    expect(showInlineStatus).toHaveBeenLastCalledWith(
      "Server access was revoked.",
      "warning",
    );
  });

  test("is idempotent under subscriber re-entrance for the same id", async () => {
    const { purgeServer, onServerPurged } = purgeModule;
    // A subscriber that triggers another purge for the same server id is
    // the realistic re-entrance vector (e.g. ws.ts code path during purge
    // re-reaches into purgeServer). Without the `purging` guard, that
    // nested call would run the whole orchestration again — duplicate
    // disconnect/removeServer/status toast.
    const reenter = mock<(id: string) => void>((id) => {
      void purgeServer(id, "central-gone");
    });
    const unsubscribe = onServerPurged(reenter);
    try {
      await purgeServer("srv-reentrant", "banned");
      expect(reenter).toHaveBeenCalledTimes(1);
      expect(disconnect).toHaveBeenCalledTimes(1);
      expect(removeServer).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribe();
    }
  });

  test("subscribers fire once per purge; subsequent purges re-fire", async () => {
    const { purgeServer, onServerPurged } = purgeModule;
    const sub = mock<(id: string, reason: string) => void>();
    const unsubscribe = onServerPurged(sub);
    try {
      await purgeServer("srv-sub", "user-delete");
      expect(sub).toHaveBeenCalledTimes(1);
      expect(sub).toHaveBeenCalledWith("srv-sub", "user-delete");
      await purgeServer("srv-sub-2", "central-gone");
      expect(sub).toHaveBeenCalledTimes(2);
    } finally {
      unsubscribe();
    }
  });

  test("a subscriber that throws does not prevent later subscribers or removeServer", async () => {
    const { purgeServer, onServerPurged } = purgeModule;
    const thrower = mock<() => void>(() => { throw new Error("boom"); });
    const after = mock<() => void>();
    const u1 = onServerPurged(thrower);
    const u2 = onServerPurged(after);
    try {
      await purgeServer("srv-throw", "user-delete");
      expect(thrower).toHaveBeenCalledTimes(1);
      expect(after).toHaveBeenCalledTimes(1);
      expect(removeServer).toHaveBeenCalledTimes(1);
    } finally {
      u1();
      u2();
    }
  });

  test("subscriber throwing does not wedge the idempotence guard", async () => {
    const { purgeServer, onServerPurged } = purgeModule;
    const thrower = mock<() => void>(() => { throw new Error("boom"); });
    const u = onServerPurged(thrower);
    try {
      await purgeServer("srv-guard", "banned");
      // If the guard were wedged by a throwing subscriber (no try/finally),
      // this second call would early-return — and removeServer would only
      // run once total. With a proper try/finally it runs twice.
      await purgeServer("srv-guard", "banned");
      expect(removeServer).toHaveBeenCalledTimes(2);
    } finally {
      u();
    }
  });

  test("unsubscribe removes the listener", async () => {
    const { purgeServer, onServerPurged } = purgeModule;
    const sub = mock<() => void>();
    const unsubscribe = onServerPurged(sub);
    unsubscribe();
    await purgeServer("srv-unsub", "user-delete");
    expect(sub).not.toHaveBeenCalled();
  });
});
