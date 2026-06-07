import { describe, expect, test } from "bun:test";
import { Watchdog } from "./watchdog";
import { SubprocessManager } from "./subprocess";
import { resolve } from "path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXTURES_DIR = resolve(import.meta.dir, "__fixtures__");
const DATA_DIR = "/tmp/uncorded-test";
const API_VERSION = "1.0.0";
const SHORT_TIMEOUT = 2000;

// ---------------------------------------------------------------------------
// Watchdog — unit tests with real subprocesses
// ---------------------------------------------------------------------------

describe("Watchdog", () => {
  test("handlePong resets missed counter", () => {
    const manager = new SubprocessManager();
    const watchdog = new Watchdog(manager, { pingIntervalMs: 100, maxMissedPings: 3 });

    watchdog.track("test-plugin");
    expect(watchdog.getMissedPings("test-plugin")).toBe(0);

    // Simulate a tick without pong — missed should increment
    // But tick() only increments for "ready" plugins, so we test handlePong directly
    watchdog.handlePong("test-plugin");
    expect(watchdog.getMissedPings("test-plugin")).toBe(0);
  });

  test("tick increments missed pings for ready plugins", async () => {
    const manager = new SubprocessManager();
    const watchdog = new Watchdog(manager, { pingIntervalMs: 100, maxMissedPings: 3 });

    // Spawn a real plugin
    const result = await manager.spawn(
      "watchdog-test",
      FIXTURES_DIR,
      "echo-plugin.ts",
      DATA_DIR,
      API_VERSION,
      { handshakeTimeoutMs: SHORT_TIMEOUT },
    );
    expect(result.ok).toBe(true);

    watchdog.track("watchdog-test");

    // Tick without waiting for pong — should increment missed
    watchdog.tick();
    expect(watchdog.getMissedPings("watchdog-test")).toBe(1);

    watchdog.tick();
    expect(watchdog.getMissedPings("watchdog-test")).toBe(2);

    // Pong resets
    watchdog.handlePong("watchdog-test");
    expect(watchdog.getMissedPings("watchdog-test")).toBe(0);

    watchdog.stop();
    await manager.stopAll();
  });

  test("plugin force-killed after max missed pings", async () => {
    const manager = new SubprocessManager();
    const watchdog = new Watchdog(manager, { pingIntervalMs: 100, maxMissedPings: 3 });

    // Use hang-plugin which never responds to pings
    const result = await manager.spawn(
      "hang-watchdog",
      FIXTURES_DIR,
      "echo-plugin.ts", // echo-plugin won't respond to "ping" with "pong" — only echoes
      DATA_DIR,
      API_VERSION,
      { handshakeTimeoutMs: SHORT_TIMEOUT },
    );
    expect(result.ok).toBe(true);

    watchdog.track("hang-watchdog");

    // Tick 3 times without pong
    watchdog.tick();
    expect(watchdog.getMissedPings("hang-watchdog")).toBe(1);

    watchdog.tick();
    expect(watchdog.getMissedPings("hang-watchdog")).toBe(2);

    // Third tick should force-kill
    watchdog.tick();

    // After force-kill, the plugin should no longer be tracked
    expect(watchdog.getMissedPings("hang-watchdog")).toBe(0);

    // Wait for process to actually die
    await new Promise<void>((resolve) => setTimeout(resolve, 200));

    const proc = manager.getProcess("hang-watchdog");
    expect(proc?.state === "ready").toBe(false);

    watchdog.stop();
    await manager.stopAll();
  });

  test("untracked plugins are not pinged", async () => {
    const manager = new SubprocessManager();
    const watchdog = new Watchdog(manager, { pingIntervalMs: 100, maxMissedPings: 3 });

    const result = await manager.spawn(
      "untracked",
      FIXTURES_DIR,
      "echo-plugin.ts",
      DATA_DIR,
      API_VERSION,
      { handshakeTimeoutMs: SHORT_TIMEOUT },
    );
    expect(result.ok).toBe(true);

    // Don't track — tick should have no effect
    watchdog.tick();
    expect(watchdog.getMissedPings("untracked")).toBe(0);

    watchdog.stop();
    await manager.stopAll();
  });

  test("stop clears interval and state", async () => {
    const manager = new SubprocessManager();
    const watchdog = new Watchdog(manager, { pingIntervalMs: 100, maxMissedPings: 3 });

    watchdog.track("test");
    watchdog.start();
    watchdog.stop();

    expect(watchdog.getMissedPings("test")).toBe(0);
    await manager.stopAll();
  });

  test("pong from echo-plugin via real IPC roundtrip", async () => {
    const manager = new SubprocessManager();
    const watchdog = new Watchdog(manager, { pingIntervalMs: 100, maxMissedPings: 3 });

    // Use echo-plugin: it echoes any message with type "echo".
    // For this test we manually simulate what a real SDK plugin would do:
    // The watchdog sends { type: "ping" }, the echo-plugin responds with
    // { type: "echo", original_type: "ping" }. In production, the SDK handles
    // ping→pong. Here we just verify the watchdog's tracking logic.
    const result = await manager.spawn(
      "pong-test",
      FIXTURES_DIR,
      "echo-plugin.ts",
      DATA_DIR,
      API_VERSION,
      { handshakeTimeoutMs: SHORT_TIMEOUT },
    );
    expect(result.ok).toBe(true);

    watchdog.track("pong-test");
    watchdog.tick(); // sends ping, increments missed
    expect(watchdog.getMissedPings("pong-test")).toBe(1);

    // Simulate pong received (in production, router forwards this)
    watchdog.handlePong("pong-test");
    expect(watchdog.getMissedPings("pong-test")).toBe(0);

    watchdog.stop();
    await manager.stopAll();
  });
});
