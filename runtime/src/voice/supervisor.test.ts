import { describe, expect, test, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiveKitSupervisor, type SpawnedProcess } from "./supervisor";
import { DEFAULT_PORT_PLAN } from "./config";

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

const TEST_SECRET = "x".repeat(64);
let prevSecret: string | undefined;

beforeAll(() => {
  prevSecret = process.env["RUNTIME_ENCRYPTION_SECRET"];
  process.env["RUNTIME_ENCRYPTION_SECRET"] = TEST_SECRET;
});

afterAll(() => {
  if (prevSecret === undefined) delete process.env["RUNTIME_ENCRYPTION_SECRET"];
  else process.env["RUNTIME_ENCRYPTION_SECRET"] = prevSecret;
});

function makeDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE IF NOT EXISTS voice_config (
      service_slug     TEXT    NOT NULL PRIMARY KEY,
      api_key          TEXT    NOT NULL,
      secret_encrypted TEXT    NOT NULL,
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL
    );
  `);
  return db;
}

/**
 * Controllable mock subprocess. Tests can resolve `exit` to simulate the
 * process dying on signal, or leave it pending to simulate a hung child.
 */
interface MockProc extends SpawnedProcess {
  signals: string[];
  resolveExit: (code?: number) => void;
}

function makeMockProc(opts: {
  pid?: number;
  stderrChunks?: string[];
  autoExitOnSignal?: boolean;
} = {}): MockProc {
  const signals: string[] = [];
  let resolveExit!: (code?: number) => void;
  const exited = new Promise<number | undefined>((res) => {
    resolveExit = res;
  });

  let stderr: ReadableStream<Uint8Array> | null = null;
  if (opts.stderrChunks && opts.stderrChunks.length > 0) {
    const enc = new TextEncoder();
    const chunks = opts.stderrChunks;
    stderr = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(enc.encode(c));
        controller.close();
      },
    });
  }

  return {
    pid: opts.pid ?? 12345,
    exited,
    stderr,
    signals,
    resolveExit,
    kill(signal) {
      signals.push(String(signal ?? "SIGTERM"));
      if (opts.autoExitOnSignal !== false) resolveExit(0);
    },
  };
}

interface Harness {
  dir: string;
  configPath: string;
  db: Database;
  spawned: MockProc[];
  probeResults: boolean[]; // queue of returns for sequential calls
  probeCalls: string[];
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "uncorded-voice-sup-"));
  const configPath = join(dir, "livekit.yaml");
  const db = makeDb();
  return { dir, configPath, db, spawned: [], probeResults: [], probeCalls: [] };
}

function cleanupHarness(h: Harness): void {
  h.db.close();
  rmSync(h.dir, { recursive: true, force: true });
}

function makeSupervisor(
  h: Harness,
  overrides: { startupTimeoutMs?: number; nextProc?: () => MockProc } = {},
): LiveKitSupervisor {
  return new LiveKitSupervisor("livekit", {
    db: h.db,
    livekitBinPath: "/opt/livekit/livekit-server",
    configPath: h.configPath,
    livekitVersion: "1.7.2-test",
    startupTimeoutMs: overrides.startupTimeoutMs ?? 2000,
    spawner: () => {
      const p = overrides.nextProc ? overrides.nextProc() : makeMockProc();
      h.spawned.push(p);
      return p;
    },
    readinessProbe: async (url) => {
      h.probeCalls.push(url);
      return h.probeResults.shift() ?? false;
    },
  });
}

// ---------------------------------------------------------------------------
// LiveKitSupervisor
// ---------------------------------------------------------------------------

describe("LiveKitSupervisor", () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });

  afterEach(() => {
    cleanupHarness(h);
  });

  test("doStart writes config, spawns, polls readiness, transitions to running", async () => {
    // Probe returns false twice then true → exercises the polling loop.
    h.probeResults = [false, false, true];
    const sup = makeSupervisor(h);
    const r = await sup.claim({ pluginSlug: "voice-plugin" });
    expect(r.ok).toBe(true);
    expect(sup.state()).toBe("running");
    expect(h.spawned.length).toBe(1);
    expect(existsSync(h.configPath)).toBe(true);
    const yaml = readFileSync(h.configPath, "utf8");
    expect(yaml).toContain(`port: ${DEFAULT_PORT_PLAN.signaling}`);
    // Probe URL points at the signaling port on loopback.
    expect(h.probeCalls[0]).toBe(`http://127.0.0.1:${DEFAULT_PORT_PLAN.signaling}/`);
    expect(h.probeCalls.length).toBeGreaterThanOrEqual(3);
  });

  test("readiness timeout kills the half-started process and reports start failure", async () => {
    // Probe never returns true.
    h.probeResults = [];
    const sup = makeSupervisor(h, { startupTimeoutMs: 50 });
    const r = await sup.claim({ pluginSlug: "voice-plugin" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("SERVICE_START_FAILED");
      expect(r.error.message).toContain("failed to become ready");
    }
    expect(sup.state()).toBe("stopped");
    // Process was killed (SIGKILL on timeout).
    expect(h.spawned[0]!.signals).toContain("SIGKILL");
  });

  test("release sends SIGTERM and transitions to stopped when child exits in time", async () => {
    h.probeResults = [true];
    const sup = makeSupervisor(h);
    await sup.claim({ pluginSlug: "p1" });
    expect(sup.state()).toBe("running");
    const proc = h.spawned[0]!;

    await sup.release({ pluginSlug: "p1" });
    expect(sup.state()).toBe("stopped");
    expect(proc.signals[0]).toBe("SIGTERM");
    // No SIGKILL needed — child exited within the grace period.
    expect(proc.signals).not.toContain("SIGKILL");
  });

  test("release escalates to SIGKILL when child does not exit within grace", async () => {
    h.probeResults = [true];
    // Build a proc whose kill() does NOT auto-resolve `exited`.
    const sup = makeSupervisor(h, {
      nextProc: () => makeMockProc({ autoExitOnSignal: false }),
    });
    await sup.claim({ pluginSlug: "p1" });
    const proc = h.spawned[0]!;

    // Don't await — release will block on the 5s grace timeout. We assert
    // the SIGKILL fallback fires by waiting just past the grace.
    const releasePromise = sup.release({ pluginSlug: "p1" });

    // After the grace window the supervisor sends SIGKILL. Use a generous
    // wait to keep the test stable on slow CI; the release still completes
    // promptly because the timeout is the deciding factor.
    await releasePromise;
    expect(proc.signals[0]).toBe("SIGTERM");
    expect(proc.signals).toContain("SIGKILL");
    expect(sup.state()).toBe("stopped");
  }, 10_000);

  test("health() returns VoiceHealth shape with stubbed activeRooms/activeParticipants", async () => {
    h.probeResults = [true];
    const sup = makeSupervisor(h);
    await sup.claim({ pluginSlug: "p1" });
    const hh = await sup.health();
    expect(hh.state).toBe("running");
    expect(hh.status).toBe("ready");
    expect(hh.livekitVersion).toBe("1.7.2-test");
    expect(hh.activeRooms).toBe(0);
    expect(hh.activeParticipants).toBe(0);
    expect(hh.uptimeMs).not.toBeNull();
    expect(hh.lastError).toBeNull();
  });

  test("health.status maps stopped+no-claimers → disabled, stopped+claimers → unhealthy", async () => {
    const sup = makeSupervisor(h);
    // Fresh supervisor with no claimers: stopped → disabled.
    const before = await sup.health();
    expect(before.state).toBe("stopped");
    expect(before.status).toBe("disabled");

    // Now fail a start to leave a claimer attached but state=stopped.
    h.probeResults = []; // probe always false → readiness times out
    const sup2 = makeSupervisor(h, { startupTimeoutMs: 30 });
    const r = await sup2.claim({ pluginSlug: "p1" });
    expect(r.ok).toBe(false);
    expect(sup2.state()).toBe("stopped");
    expect(sup2.claimerCount()).toBe(1);
    const after = await sup2.health();
    expect(after.status).toBe("unhealthy");
  });

  test("rotateSecret without a running process does not spawn", async () => {
    const sup = makeSupervisor(h);
    await sup.rotateSecret();
    expect(h.spawned.length).toBe(0);
    // The persisted credential row exists.
    const row = h.db
      .prepare("SELECT api_key FROM voice_config WHERE service_slug = 'livekit'")
      .get() as { api_key: string } | null;
    expect(row).not.toBeNull();
    expect(row!.api_key).toMatch(/^uncorded-[0-9a-f]{16}$/);
  });

  test("rotateSecret while running stops then restarts with new credentials", async () => {
    h.probeResults = [true, true]; // first start, then post-rotate restart
    const sup = makeSupervisor(h);
    await sup.claim({ pluginSlug: "p1" });
    expect(sup.state()).toBe("running");
    const yamlBefore = readFileSync(h.configPath, "utf8");

    await sup.rotateSecret();

    expect(sup.state()).toBe("running");
    expect(h.spawned.length).toBe(2); // old killed, fresh spawn
    expect(h.spawned[0]!.signals[0]).toBe("SIGTERM");
    const yamlAfter = readFileSync(h.configPath, "utf8");
    expect(yamlAfter).not.toBe(yamlBefore); // different secret
  });

  test("stderr stream is consumed without throwing", async () => {
    h.probeResults = [true];
    const sup = makeSupervisor(h, {
      nextProc: () =>
        makeMockProc({ stderrChunks: ["line one\n", "line two\n", "line three\n"] }),
    });
    await sup.claim({ pluginSlug: "p1" });
    // Give the pipeStderr loop a tick to drain.
    await new Promise((r) => setTimeout(r, 20));
    expect(sup.state()).toBe("running");
  });
});
