import { describe, expect, test, setDefaultTimeout } from "bun:test";
import { SubprocessManager } from "./subprocess";
import {
  createRestartTracker,
  recordCrash,
  shouldQuarantine,
  getBackoffDelay,
  BACKOFF_SCHEDULE,
} from "./subprocess";
import type { RestartTracker, SpawnResult } from "./subprocess";
import { resolve } from "path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXTURES_DIR = resolve(import.meta.dir, "__fixtures__");
const DATA_DIR = "/tmp/uncorded-test";
const API_VERSION = "1.0.0";
// These tests spawn real Bun subprocesses and wait on the IPC ready handshake +
// first message. Under load on a 2-core Ubuntu CI runner a cold subprocess
// cold-start can intermittently blow past Bun's 5s default per-test timeout
// (observed: a spawn still mid-handshake when the test was killed at 5000ms),
// which flipped these green-on-Windows tests red on CI. Raise the per-file
// budget so a slow-but-valid spawn completes instead of racing the deadline.
// The success path still resolves the instant the child reports ready, so this
// only adds headroom — it never slows a healthy run.
setDefaultTimeout(20_000);

// Ready-handshake budget for spawn() in these tests. Must comfortably exceed
// worst-case cold-start (and stay under the per-test budget above) so a slow
// spawn resolves result.ok=true rather than expiring. The one test that asserts
// timeout/crash behavior sets its own explicit short budget inline.
const SHORT_TIMEOUT = 15000; // 15s (was 2s — too tight for cold-start under CI load)

// ---------------------------------------------------------------------------
// RestartTracker (pure unit tests)
// ---------------------------------------------------------------------------

describe("RestartTracker", () => {
  test("fresh tracker: not quarantined", () => {
    const tracker = createRestartTracker();
    expect(shouldQuarantine(tracker)).toBe(false);
  });

  test("4 crashes in window: not quarantined", () => {
    const tracker = createRestartTracker();
    for (let i = 0; i < 4; i++) {
      recordCrash(tracker);
    }
    expect(shouldQuarantine(tracker)).toBe(false);
  });

  test("5 crashes in window: quarantined", () => {
    const tracker = createRestartTracker();
    for (let i = 0; i < 5; i++) {
      recordCrash(tracker);
    }
    expect(shouldQuarantine(tracker)).toBe(true);
  });

  test("old crashes outside window don't count", () => {
    const tracker: RestartTracker = {
      crashes: [
        Date.now() - 11 * 60 * 1000, // 11 min ago
        Date.now() - 11 * 60 * 1000,
        Date.now() - 11 * 60 * 1000,
        Date.now() - 11 * 60 * 1000,
        Date.now() - 11 * 60 * 1000,
      ],
      backoffIndex: 4,
    };
    expect(shouldQuarantine(tracker)).toBe(false);
  });

  test("mix of old and recent crashes", () => {
    const tracker: RestartTracker = {
      crashes: [
        Date.now() - 11 * 60 * 1000, // old
        Date.now() - 11 * 60 * 1000, // old
        Date.now() - 11 * 60 * 1000, // old
        Date.now() - 1000,            // recent
        Date.now() - 500,             // recent
      ],
      backoffIndex: 4,
    };
    expect(shouldQuarantine(tracker)).toBe(false);
  });

  test("backoff schedule returns correct delays", () => {
    const tracker = createRestartTracker();
    expect(getBackoffDelay(tracker)).toBe(BACKOFF_SCHEDULE[0]);

    recordCrash(tracker);
    expect(getBackoffDelay(tracker)).toBe(BACKOFF_SCHEDULE[1]);

    recordCrash(tracker);
    expect(getBackoffDelay(tracker)).toBe(BACKOFF_SCHEDULE[2]);

    recordCrash(tracker);
    expect(getBackoffDelay(tracker)).toBe(BACKOFF_SCHEDULE[3]);

    recordCrash(tracker);
    expect(getBackoffDelay(tracker)).toBe(BACKOFF_SCHEDULE[4]);
  });

  test("backoff caps at maximum", () => {
    const tracker = createRestartTracker();
    // getBackoffDelay is what advances backoffIndex; recordCrash only tracks
    // crash timestamps for the quarantine window. Each real crash calls both.
    for (let i = 0; i < 10; i++) {
      recordCrash(tracker);
      getBackoffDelay(tracker);
    }
    expect(getBackoffDelay(tracker)).toBe(BACKOFF_SCHEDULE[BACKOFF_SCHEDULE.length - 1]!);
  });
});

// ---------------------------------------------------------------------------
// SubprocessManager — spawn + handshake
// ---------------------------------------------------------------------------

describe("SubprocessManager — spawn", () => {
  test("spawn echo-plugin: receives ready, state becomes ready", async () => {
    const manager = new SubprocessManager();
    const result = await manager.spawn(
      "echo",
      FIXTURES_DIR,
      "echo-plugin.ts",
      DATA_DIR,
      API_VERSION,
      { handshakeTimeoutMs: SHORT_TIMEOUT },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");

    expect(result.process.state).toBe("ready");
    expect(result.process.slug).toBe("echo");
    expect(typeof result.process.pid).toBe("number");

    await manager.stopAll();
  });

  test("spawn crash-plugin: exits before ready, returns PLUGIN_CRASHED", async () => {
    const manager = new SubprocessManager();
    const result = await manager.spawn(
      "crash",
      FIXTURES_DIR,
      "crash-plugin.ts",
      DATA_DIR,
      API_VERSION,
      { handshakeTimeoutMs: SHORT_TIMEOUT },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");

    expect(result.error.code).toBe("PLUGIN_CRASHED");
    expect(result.error.plugin).toBe("crash");

    await manager.stopAll();
  });

  test("spawn hang-plugin: times out, returns HANDSHAKE_TIMEOUT", async () => {
    const manager = new SubprocessManager();
    const result = await manager.spawn(
      "hang",
      FIXTURES_DIR,
      "hang-plugin.ts",
      DATA_DIR,
      API_VERSION,
      { handshakeTimeoutMs: 500 }, // very short timeout for test speed
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");

    expect(result.error.code).toBe("HANDSHAKE_TIMEOUT");
    expect(result.error.plugin).toBe("hang");

    await manager.stopAll();
  });

  test("spawn nonexistent entry: returns SPAWN_FAILED", async () => {
    const manager = new SubprocessManager();
    const result = await manager.spawn(
      "missing",
      FIXTURES_DIR,
      "nonexistent-file.ts",
      DATA_DIR,
      API_VERSION,
      { handshakeTimeoutMs: SHORT_TIMEOUT },
    );

    // Bun.spawn may not throw for a missing file — the subprocess starts
    // but then exits with an error. So this could be PLUGIN_CRASHED instead.
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(["SPAWN_FAILED", "PLUGIN_CRASHED"]).toContain(result.error.code);

    await manager.stopAll();
  });

  test("duplicate spawn returns ALREADY_RUNNING", async () => {
    const manager = new SubprocessManager();
    const first = await manager.spawn(
      "echo",
      FIXTURES_DIR,
      "echo-plugin.ts",
      DATA_DIR,
      API_VERSION,
      { handshakeTimeoutMs: SHORT_TIMEOUT },
    );
    expect(first.ok).toBe(true);

    const second = await manager.spawn(
      "echo",
      FIXTURES_DIR,
      "echo-plugin.ts",
      DATA_DIR,
      API_VERSION,
      { handshakeTimeoutMs: SHORT_TIMEOUT },
    );
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("unreachable");
    expect(second.error.code).toBe("ALREADY_RUNNING");

    await manager.stopAll();
  });
});

// ---------------------------------------------------------------------------
// SubprocessManager — stop
// ---------------------------------------------------------------------------

describe("SubprocessManager — stop", () => {
  test("stop a running plugin gracefully", async () => {
    const manager = new SubprocessManager();
    const result = await manager.spawn(
      "echo",
      FIXTURES_DIR,
      "echo-plugin.ts",
      DATA_DIR,
      API_VERSION,
      { handshakeTimeoutMs: SHORT_TIMEOUT },
    );
    expect(result.ok).toBe(true);

    await manager.stop("echo");

    const proc = manager.getProcess("echo");
    expect(proc?.state).toBe("stopped");
  });

  test("stop nonexistent plugin is a no-op", async () => {
    const manager = new SubprocessManager();
    await manager.stop("nonexistent"); // should not throw
  });

  test("stopAll stops all running plugins", async () => {
    const manager = new SubprocessManager();

    // Spawn two plugins
    const r1 = await manager.spawn(
      "echo1",
      FIXTURES_DIR,
      "echo-plugin.ts",
      DATA_DIR,
      API_VERSION,
      { handshakeTimeoutMs: SHORT_TIMEOUT },
    );
    expect(r1.ok).toBe(true);

    const r2 = await manager.spawn(
      "echo2",
      FIXTURES_DIR,
      "echo-plugin.ts",
      DATA_DIR,
      API_VERSION,
      { handshakeTimeoutMs: SHORT_TIMEOUT },
    );
    expect(r2.ok).toBe(true);

    await manager.stopAll();

    expect(manager.getProcess("echo1")?.state).toBe("stopped");
    expect(manager.getProcess("echo2")?.state).toBe("stopped");
  });
});

// ---------------------------------------------------------------------------
// SubprocessManager — IPC messaging
// ---------------------------------------------------------------------------

describe("SubprocessManager — IPC", () => {
  test("send and receive messages through transport", async () => {
    const manager = new SubprocessManager();
    const result = await manager.spawn(
      "echo",
      FIXTURES_DIR,
      "echo-plugin.ts",
      DATA_DIR,
      API_VERSION,
      { handshakeTimeoutMs: SHORT_TIMEOUT },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");

    const { transport } = result.process;
    const received: unknown[] = [];
    transport.onMessage((msg) => received.push(msg));

    // Send a test message
    transport.send({ type: "ping", data: "hello" });

    // Wait for echo
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (received.length > 0) {
          clearInterval(check);
          resolve();
        }
      }, 10);
    });

    const echo = received[0] as Record<string, unknown>;
    expect(echo["type"]).toBe("echo");
    expect(echo["original_type"]).toBe("ping");
    expect(echo["data"]).toBe("hello");

    await manager.stopAll();
  });
});

// ---------------------------------------------------------------------------
// SubprocessManager — environment isolation (C5 + I7)
// ---------------------------------------------------------------------------

describe("SubprocessManager — environment", () => {
  test("PLUGIN_DATA_DIR is set to plugins root", async () => {
    const received: Record<string, unknown>[] = [];

    const manager = new SubprocessManager();
    const result = await manager.spawn(
      "my-plugin",
      FIXTURES_DIR,
      "env-plugin.ts",
      DATA_DIR,
      API_VERSION,
      {
        handshakeTimeoutMs: SHORT_TIMEOUT,
        // The fixture emits env_report immediately after ready. Attach before
        // spawn resolves so fast CI runners cannot dispatch the frame before
        // this test's listener exists.
        onTransportCreated: (transport) => {
          transport.onMessage((msg) => received.push(msg as Record<string, unknown>));
        },
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");

    // Wait for env report
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (received.some((msg) => msg["type"] === "env_report")) {
          clearInterval(check);
          resolve();
        }
      }, 10);
    });

    const report = received.find((msg) => msg["type"] === "env_report");
    if (!report) throw new Error("unreachable");
    expect(report["type"]).toBe("env_report");
    expect(report["plugin_slug"]).toBe("my-plugin");
    expect(report["plugin_data_dir"]).toBe(`${DATA_DIR}/plugins/my-plugin`);
    expect(report["plugin_api_version"]).toBe(API_VERSION);

    await manager.stopAll();
  });

  test("plugin does not inherit sensitive parent env vars", async () => {
    // Set a "secret" env var in the parent process
    const originalSecret = process.env["UNCORDED_TEST_SECRET"];
    process.env["UNCORDED_TEST_SECRET"] = "s3cret_value";

    const received: Record<string, unknown>[] = [];

    const manager = new SubprocessManager();
    const result = await manager.spawn(
      "env-check",
      FIXTURES_DIR,
      "env-plugin.ts",
      DATA_DIR,
      API_VERSION,
      {
        handshakeTimeoutMs: SHORT_TIMEOUT,
        // Attach the listener BEFORE the ready handshake. The fixture emits
        // its "env_report" frame immediately after "ready", so registering on
        // result.process.transport only after spawn() resolves races the
        // plugin's startup writes: on fast Linux CI the report is read and
        // dispatched (to the no-op handshake handler) before the post-spawn
        // listener attaches, so it is dropped and the test hangs to timeout.
        // onTransportCreated exists precisely for handlers that must not miss
        // post-ready messages.
        onTransportCreated: (transport) => {
          transport.onMessage((msg) => received.push(msg as Record<string, unknown>));
        },
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");

    // This listener now also sees the "ready" frame, so select env_report.
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (received.some((msg) => msg["type"] === "env_report")) {
          clearInterval(check);
          resolve();
        }
      }, 10);
    });

    const report = received.find((msg) => msg["type"] === "env_report");
    if (!report) throw new Error("unreachable");
    const envKeys = report["env_keys"] as string[];

    // On Docker/Linux: child should NOT have UNCORDED_TEST_SECRET.
    // On Windows: OS injects system vars but user-defined vars should not leak
    // when Bun.spawn is given explicit env.
    expect(envKeys).not.toContain("UNCORDED_TEST_SECRET");

    // Cleanup
    if (originalSecret === undefined) {
      delete process.env["UNCORDED_TEST_SECRET"];
    } else {
      process.env["UNCORDED_TEST_SECRET"] = originalSecret;
    }

    await manager.stopAll();
  });
});

// ---------------------------------------------------------------------------
// SubprocessManager — getProcess / isQuarantined
// ---------------------------------------------------------------------------

describe("SubprocessManager — state queries", () => {
  test("getProcess returns tracked process", async () => {
    const manager = new SubprocessManager();
    await manager.spawn(
      "echo",
      FIXTURES_DIR,
      "echo-plugin.ts",
      DATA_DIR,
      API_VERSION,
      { handshakeTimeoutMs: SHORT_TIMEOUT },
    );

    const proc = manager.getProcess("echo");
    expect(proc).toBeDefined();
    expect(proc!.slug).toBe("echo");

    await manager.stopAll();
  });

  test("getProcess returns undefined for unknown slug", () => {
    const manager = new SubprocessManager();
    expect(manager.getProcess("unknown")).toBeUndefined();
  });

  test("isQuarantined returns false for non-quarantined plugin", async () => {
    const manager = new SubprocessManager();
    await manager.spawn(
      "echo",
      FIXTURES_DIR,
      "echo-plugin.ts",
      DATA_DIR,
      API_VERSION,
      { handshakeTimeoutMs: SHORT_TIMEOUT },
    );

    expect(manager.isQuarantined("echo")).toBe(false);

    await manager.stopAll();
  });
});

// ---------------------------------------------------------------------------
// SubprocessManager — restart loop (C1)
// ---------------------------------------------------------------------------

describe("SubprocessManager — restart loop", () => {
  test("plugin that crashes after ready is respawned automatically", async () => {
    const manager = new SubprocessManager();

    const respawnResults: SpawnResult[] = [];
    manager.onRespawn((_slug, result) => {
      respawnResults.push(result);
    });

    const result = await manager.spawn(
      "crash-loop",
      FIXTURES_DIR,
      "crash-after-ready-plugin.ts",
      DATA_DIR,
      API_VERSION,
      { handshakeTimeoutMs: SHORT_TIMEOUT },
    );
    expect(result.ok).toBe(true);

    // Wait for the crash + backoff (1s) + respawn + ready handshake
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (respawnResults.length > 0) {
          clearInterval(check);
          resolve();
        }
      }, 50);
      // Safety timeout
      setTimeout(() => {
        clearInterval(check);
        resolve();
      }, 5000);
    });

    expect(respawnResults.length).toBeGreaterThanOrEqual(1);
    // The respawn should succeed (crash-after-ready does send "ready")
    expect(respawnResults[0]!.ok).toBe(true);

    await manager.stopAll();
  });

  test("quarantined plugin is not respawned", async () => {
    const manager = new SubprocessManager();

    const respawnResults: SpawnResult[] = [];
    manager.onRespawn((_slug, result) => {
      respawnResults.push(result);
    });

    const result = await manager.spawn(
      "quarantine-test",
      FIXTURES_DIR,
      "crash-after-ready-plugin.ts",
      DATA_DIR,
      API_VERSION,
      { handshakeTimeoutMs: SHORT_TIMEOUT },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");

    // Pre-fill the crash tracker to be 1 away from quarantine
    const proc = manager.getProcess("quarantine-test")!;
    proc.restarts.crashes = [
      Date.now() - 1000,
      Date.now() - 1000,
      Date.now() - 1000,
      Date.now() - 1000,
    ];

    // Wait for the crash — the 5th crash should trigger quarantine
    await new Promise<void>((resolve) => setTimeout(resolve, 500));

    // Should be quarantined, not respawned
    expect(proc.state).toBe("quarantined");
    expect(manager.isQuarantined("quarantine-test")).toBe(true);
    expect(respawnResults.length).toBe(0);

    await manager.stopAll();
  });

  test("stopAll cancels pending respawn timers", async () => {
    const manager = new SubprocessManager();

    const respawnResults: SpawnResult[] = [];
    manager.onRespawn((_slug, result) => {
      respawnResults.push(result);
    });

    const result = await manager.spawn(
      "stop-cancel",
      FIXTURES_DIR,
      "crash-after-ready-plugin.ts",
      DATA_DIR,
      API_VERSION,
      { handshakeTimeoutMs: SHORT_TIMEOUT },
    );
    expect(result.ok).toBe(true);

    // Wait for the crash to be detected (100ms crash delay + some margin)
    await new Promise<void>((resolve) => setTimeout(resolve, 300));

    // Stop all before backoff timer fires (backoff is 1000ms)
    await manager.stopAll();

    // Wait a bit more — respawn should NOT fire
    await new Promise<void>((resolve) => setTimeout(resolve, 1500));
    expect(respawnResults.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// SubprocessManager — onPluginUnload hook
// ---------------------------------------------------------------------------

describe("SubprocessManager — onPluginUnload", () => {
  test("graceful stop fires unload callback once", async () => {
    const manager = new SubprocessManager();
    const unloads: string[] = [];
    manager.onPluginUnload((slug) => unloads.push(slug));

    const result = await manager.spawn(
      "echo",
      FIXTURES_DIR,
      "echo-plugin.ts",
      DATA_DIR,
      API_VERSION,
      { handshakeTimeoutMs: SHORT_TIMEOUT },
    );
    expect(result.ok).toBe(true);

    await manager.stop("echo");

    expect(unloads).toEqual(["echo"]);
  });

  test("crash-with-respawn fires unload before scheduling respawn", async () => {
    const manager = new SubprocessManager();
    const events: string[] = [];
    manager.onPluginUnload((slug) => events.push(`unload:${slug}`));
    manager.onRespawn((slug, result) => {
      events.push(`respawn:${slug}:${result.ok ? "ok" : "fail"}`);
    });

    const result = await manager.spawn(
      "crash-after-ready",
      FIXTURES_DIR,
      "crash-after-ready-plugin.ts",
      DATA_DIR,
      API_VERSION,
      { handshakeTimeoutMs: SHORT_TIMEOUT },
    );
    expect(result.ok).toBe(true);

    // Crash fires after 100ms, then unload, then respawn after 1000ms backoff.
    await new Promise<void>((resolve) => setTimeout(resolve, 1500));

    // First unload from the initial crash.
    expect(events[0]).toBe("unload:crash-after-ready");
    // Respawn fires after; the respawned process may also crash, producing
    // additional unload entries. The contract under test is just: unload
    // fires before the respawn for a given crash cycle.
    const firstUnloadIdx = events.indexOf("unload:crash-after-ready");
    const firstRespawnIdx = events.findIndex((e) => e.startsWith("respawn:"));
    if (firstRespawnIdx !== -1) {
      expect(firstUnloadIdx).toBeLessThan(firstRespawnIdx);
    }

    await manager.stopAll();
  });

  test("multiple callbacks all fire", async () => {
    const manager = new SubprocessManager();
    const log: string[] = [];
    manager.onPluginUnload((slug) => log.push(`a:${slug}`));
    manager.onPluginUnload((slug) => log.push(`b:${slug}`));

    const result = await manager.spawn(
      "echo",
      FIXTURES_DIR,
      "echo-plugin.ts",
      DATA_DIR,
      API_VERSION,
      { handshakeTimeoutMs: SHORT_TIMEOUT },
    );
    expect(result.ok).toBe(true);

    await manager.stop("echo");

    expect(log).toContain("a:echo");
    expect(log).toContain("b:echo");
  });

  test("a throwing callback does not stop later callbacks", async () => {
    const manager = new SubprocessManager();
    const log: string[] = [];
    manager.onPluginUnload(() => {
      throw new Error("boom");
    });
    manager.onPluginUnload((slug) => log.push(slug));

    const result = await manager.spawn(
      "echo",
      FIXTURES_DIR,
      "echo-plugin.ts",
      DATA_DIR,
      API_VERSION,
      { handshakeTimeoutMs: SHORT_TIMEOUT },
    );
    expect(result.ok).toBe(true);

    await manager.stop("echo");

    expect(log).toEqual(["echo"]);
  });

  test("stop on already-stopped plugin does not re-fire unload", async () => {
    const manager = new SubprocessManager();
    const unloads: string[] = [];
    manager.onPluginUnload((slug) => unloads.push(slug));

    const result = await manager.spawn(
      "echo",
      FIXTURES_DIR,
      "echo-plugin.ts",
      DATA_DIR,
      API_VERSION,
      { handshakeTimeoutMs: SHORT_TIMEOUT },
    );
    expect(result.ok).toBe(true);

    await manager.stop("echo");
    await manager.stop("echo");

    expect(unloads).toEqual(["echo"]);
  });
});
