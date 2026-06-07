// Regression: workspace restore raced loadSidebar and the channel-view
// handshake closed over an empty runtime-capability list, leaving voice plugin
// panels stuck on the "voice.media not granted" warning until the user
// reopened them. The fix gates uncorded.token on awaitCapabilities(serverId);
// these tests assert the gate's contract.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

let mod: typeof import("./sidebar");

beforeAll(async () => {
  // Stub the WS module — sidebar.ts imports from it eagerly at module init via
  // mountSidebarStore. We never call mountSidebarStore here, but the import
  // graph still has to resolve.
  await mock.module("../lib/ws", () => ({
    connect: () => Promise.resolve(),
    onPluginMessage: () => () => {},
    onReconnect: () => () => {},
    onConnect: () => () => {},
    request: () => Promise.resolve(undefined),
  }));
  // Same reason — servers store is imported but not exercised here.
  await mock.module("./servers", () => ({
    activeServerId: () => null,
    activeServer: () => null,
    patchServer: () => {},
    adjustConnectedUsers: () => {},
  }));
  mod = await import("./sidebar");
});

afterAll(() => {
  // No global state to scrub — the per-serverId entries we create use unique
  // ids so they can't leak across files.
});

import { mock } from "bun:test";

describe("awaitCapabilities", () => {
  test("resolves immediately when no load was scheduled", async () => {
    // The handshake is allowed to call awaitCapabilities before
    // beginCapabilityLoad has fired (e.g. an iframe mounted under an unknown
    // serverId). Falling through to current behavior is the safe default —
    // hanging would freeze the iframe.
    const start = Date.now();
    await mod.awaitCapabilities("never-registered");
    expect(Date.now() - start).toBeLessThan(50);
  });

  test("blocks until completeCapabilityLoad fires for that serverId", async () => {
    const serverId = "regression-load-completes";
    mod.__testing__.beginCapabilityLoad(serverId);

    let resolved = false;
    const wait = mod.awaitCapabilities(serverId).then(() => {
      resolved = true;
    });

    // Microtask + macrotask boundary — if awaitCapabilities returned a
    // pre-resolved promise we'd see resolved=true here.
    await new Promise((r) => setTimeout(r, 10));
    expect(resolved).toBe(false);

    mod.__testing__.completeCapabilityLoad(serverId);
    await wait;
    expect(resolved).toBe(true);
  });

  test("only resolves for the specific serverId, not siblings", async () => {
    // Per-server scoping — switching tabs between two servers shouldn't let
    // server A's load completion satisfy server B's pending handshake.
    mod.__testing__.beginCapabilityLoad("server-a");
    mod.__testing__.beginCapabilityLoad("server-b");

    let bResolved = false;
    const waitB = mod.awaitCapabilities("server-b").then(() => {
      bResolved = true;
    });

    mod.__testing__.completeCapabilityLoad("server-a");
    await new Promise((r) => setTimeout(r, 10));
    expect(bResolved).toBe(false);

    mod.__testing__.completeCapabilityLoad("server-b");
    await waitB;
    expect(bResolved).toBe(true);
  });

  test("times out instead of hanging if the load never completes", async () => {
    // Defense in depth: a stalled /plugins fetch (tunnel down, server
    // unreachable, WS path that bypasses the finally) must not freeze the
    // iframe handshake forever. After the timeout, the iframe gets whatever
    // is in the cap map (empty) and renders the same warning the bug
    // produced — same failure mode, but bounded.
    const serverId = "regression-load-never-completes";
    mod.__testing__.beginCapabilityLoad(serverId);

    const start = Date.now();
    await mod.awaitCapabilities(serverId, 30);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(25);
    expect(elapsed).toBeLessThan(500);
  });

  test("idempotent: repeated beginCapabilityLoad reuses the pending promise", async () => {
    // The activeKey effect in mountSidebarStore can re-fire (e.g. memo
    // misfire); a second beginCapabilityLoad must not reset the promise
    // out from under awaiters that already attached to the first one.
    const serverId = "regression-idempotent";
    mod.__testing__.beginCapabilityLoad(serverId);
    const first = mod.awaitCapabilities(serverId);
    mod.__testing__.beginCapabilityLoad(serverId);
    const second = mod.awaitCapabilities(serverId);

    let firstDone = false;
    let secondDone = false;
    void first.then(() => { firstDone = true; });
    void second.then(() => { secondDone = true; });

    mod.__testing__.completeCapabilityLoad(serverId);
    await Promise.all([first, second]);
    expect(firstDone).toBe(true);
    expect(secondDone).toBe(true);
  });
});
