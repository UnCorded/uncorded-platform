import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { CosignSignatureMaterial } from "./cosign-verify";
import type { PreUpdateBackup } from "./runtime-backup";
import {
  performUpdate,
  RestartCancelledError,
  type RuntimeUpdateDeps,
  type RuntimeUpdateIo,
  type RuntimeUpdateLog,
  type RuntimeUpdateOptions,
  type UpdateStatePatch,
} from "./runtime-update";

// Fake clock + sleep — every test that polls /ready advances time via this
// shared cursor so we don't actually wait. sleep() resolves immediately and
// nudges the clock forward by the requested ms.
function makeClock(initial: number): {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  advance: (ms: number) => void;
} {
  let cursor = initial;
  return {
    now: () => cursor,
    sleep: async (ms: number) => {
      cursor += ms;
    },
    advance: (ms: number) => {
      cursor += ms;
    },
  };
}

const FAKE_SIG: CosignSignatureMaterial = {
  digest: "sha256:" + "a".repeat(64),
  payloadJson: '{"critical":{"image":{"docker-manifest-digest":"sha256:..."}}}',
  signatureB64: "MEUCIQ==",
};

const BACKUP: PreUpdateBackup = {
  iso: "2026-05-09T08-00-00-000Z",
  dir: "/v/config/backups/2026-05-09T08-00-00-000Z-pre-update",
  createdAt: Date.parse("2026-05-09T08:00:00.000Z"),
};

function noopLog(): RuntimeUpdateLog {
  return { info: mock(), warn: mock(), error: mock() };
}

function defaultOptions(overrides: Partial<RuntimeUpdateOptions> = {}): RuntimeUpdateOptions {
  return {
    latestImage: "uncorded-runtime:latest",
    previousImage: "uncorded-runtime:previous",
    targetImage: "uncorded-runtime:0.2.0",
    currentVersion: "0.1.0",
    targetVersion: "0.2.0",
    channel: "stable",
    containerId: "old-container-id",
    backupBeforeUpdate: true,
    graceSeconds: 30,
    readyPollTimeoutMs: 90_000,
    readyPollIntervalMs: 1_500,
    backupRetention: 3,
    ...overrides,
  };
}

interface FakeIo extends RuntimeUpdateIo {
  posts: UpdateStatePatch[];
  pulled: string[];
  tags: { source: string; target: string }[];
  stops: { id: string; grace: number }[];
  removed: string[];
  recreated: { image: string; sig: CosignSignatureMaterial | undefined }[];
  verified: string[];
  backupsCreated: number;
  restored: string[];
  rotated: number[];
}

interface FakeIoOverrides {
  pullImage?: RuntimeUpdateIo["pullImage"];
  imageExists?: RuntimeUpdateIo["imageExists"];
  tagImage?: RuntimeUpdateIo["tagImage"];
  stopContainer?: RuntimeUpdateIo["stopContainer"];
  removeContainer?: RuntimeUpdateIo["removeContainer"];
  recreateContainer?: RuntimeUpdateIo["recreateContainer"];
  verifyAndExtract?: RuntimeUpdateIo["verifyAndExtract"];
  postUpdateState?: RuntimeUpdateIo["postUpdateState"];
  fetchReady?: RuntimeUpdateIo["fetchReady"];
  createBackup?: RuntimeUpdateIo["createBackup"];
  restoreBackup?: RuntimeUpdateIo["restoreBackup"];
  rotateBackups?: RuntimeUpdateIo["rotateBackups"];
  restartConfirmed?: RuntimeUpdateIo["restartConfirmed"];
}

function makeIo(
  clock: ReturnType<typeof makeClock>,
  overrides: FakeIoOverrides = {},
): FakeIo {
  const io: FakeIo = {
    posts: [],
    pulled: [],
    tags: [],
    stops: [],
    removed: [],
    recreated: [],
    verified: [],
    backupsCreated: 0,
    restored: [],
    rotated: [],

    pullImage: async (image: string, _onProgress: (line: string) => void) => {
      io.pulled.push(image);
    },
    imageExists: async (_image: string) => true,
    tagImage: async (source: string, target: string) => {
      io.tags.push({ source, target });
    },
    stopContainer: async (id: string, grace: number) => {
      io.stops.push({ id, grace });
    },
    removeContainer: async (id: string) => {
      io.removed.push(id);
    },
    recreateContainer: async (image: string, sig: CosignSignatureMaterial | undefined) => {
      io.recreated.push({ image, sig });
      return io.recreated.length === 1 ? "new-container-id" : "rolled-back-container-id";
    },
    verifyAndExtract: async (image: string) => {
      io.verified.push(image);
      return FAKE_SIG;
    },
    postUpdateState: async (patch: UpdateStatePatch) => {
      io.posts.push(patch);
    },
    fetchReady: async () => ({ ready: true, version: "0.2.0" }),
    createBackup: async () => {
      io.backupsCreated += 1;
      return BACKUP;
    },
    restoreBackup: async (dir: string) => {
      io.restored.push(dir);
    },
    rotateBackups: async (keep: number) => {
      io.rotated.push(keep);
      return [];
    },
    // Default: gate auto-resolves so existing happy-path tests pass through
    // the new `awaiting-restart` step without modification. Tests that want
    // to exercise the cancel/reject path supply their own override.
    restartConfirmed: () => Promise.resolve(),
    sleep: clock.sleep,
    now: clock.now,
    ...overrides,
  };
  return io;
}

function makeDeps(
  clock: ReturnType<typeof makeClock>,
  ioOverrides: FakeIoOverrides = {},
  options: Partial<RuntimeUpdateOptions> = {},
): { deps: RuntimeUpdateDeps; io: FakeIo } {
  const io = makeIo(clock, ioOverrides);
  return {
    deps: { io, log: noopLog(), options: defaultOptions(options) },
    io,
  };
}

describe("performUpdate — happy path", () => {
  let clock: ReturnType<typeof makeClock>;

  beforeEach(() => {
    clock = makeClock(1_700_000_000_000);
  });

  test("runs through every phase in order and returns the new container id", async () => {
    const { deps, io } = makeDeps(clock);

    const outcome = await performUpdate(deps);

    expect(outcome).toEqual({
      ok: true,
      version: "0.2.0",
      containerId: "new-container-id",
      signature: FAKE_SIG,
      rolledBack: false,
    });

    // Validate the canonical state transitions in order. The "installing"
    // phase emits one POST per substep ("Draining traffic", "Stopping
    // container", "Swapping image", "Starting new container") — same `state`,
    // different `substep` strings.
    const states = io.posts.map((p) => p.state);
    expect(states).toEqual([
      "backing-up",
      "downloading",
      "downloaded",
      "awaiting-restart",
      "installing",
      "installing",
      "installing",
      "installing",
      "idle",
    ]);

    // Substeps fire in order during the installing phase.
    const installingSubsteps = io.posts
      .filter((p) => p.state === "installing")
      .map((p) => p.substep);
    expect(installingSubsteps).toEqual([
      "Draining traffic",
      "Stopping container",
      "Swapping image",
      "Starting new container",
    ]);

    // Backup ran exactly once.
    expect(io.backupsCreated).toBe(1);

    // Pull received the right image.
    expect(io.pulled).toEqual(["uncorded-runtime:0.2.0"]);

    // Verify ran on the same image.
    expect(io.verified).toEqual(["uncorded-runtime:0.2.0"]);

    // Stop happened with the configured grace.
    expect(io.stops).toEqual([{ id: "old-container-id", grace: 30 }]);

    // Tag dance: latest → previous, then target → latest.
    expect(io.tags).toEqual([
      { source: "uncorded-runtime:latest", target: "uncorded-runtime:previous" },
      { source: "uncorded-runtime:0.2.0", target: "uncorded-runtime:latest" },
    ]);

    // Recreate received the verified signature material.
    expect(io.recreated).toEqual([
      { image: "uncorded-runtime:latest", sig: FAKE_SIG },
    ]);

    // Final commit POST carries the new currentVersion.
    expect(io.posts.at(-1)).toMatchObject({
      state: "idle",
      errorContext: null,
      currentVersion: "0.2.0",
      availableVersion: null,
      errorMessage: null,
    });

    // Backup retention rotation ran with the configured keep.
    expect(io.rotated).toEqual([3]);
  });

  test("skips backup when backupBeforeUpdate is false", async () => {
    const { deps, io } = makeDeps(clock, {}, { backupBeforeUpdate: false });

    const outcome = await performUpdate(deps);

    expect(outcome.ok).toBe(true);
    expect(io.backupsCreated).toBe(0);
    expect(io.posts.map((p) => p.state)).not.toContain("backing-up");
  });

  test("skips :latest → :previous tag when :latest doesn't exist (first update)", async () => {
    const { deps, io } = makeDeps(clock, {
      imageExists: async (_image: string) => false,
    });

    await performUpdate(deps);

    expect(io.tags).toEqual([
      { source: "uncorded-runtime:0.2.0", target: "uncorded-runtime:latest" },
    ]);
  });
});

describe("performUpdate — non-rollback failure branches", () => {
  let clock: ReturnType<typeof makeClock>;

  beforeEach(() => {
    clock = makeClock(1_700_000_000_000);
  });

  test("backup failure → error/backup, no rollback, no swap", async () => {
    const { deps, io } = makeDeps(clock, {
      createBackup: async () => {
        throw new Error("disk full");
      },
    });

    const outcome = await performUpdate(deps);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.phase).toBe("backup");
    expect(outcome.rolledBack).toBe(false);
    expect(outcome.reason).toContain("disk full");

    // Old container untouched.
    expect(io.stops).toEqual([]);
    expect(io.recreated).toEqual([]);
    expect(io.tags).toEqual([]);

    // Last post is error/backup with operator-facing message.
    expect(io.posts.at(-1)).toMatchObject({
      state: "error",
      errorContext: "backup",
    });
    expect(io.posts.at(-1)?.errorMessage).toContain("disk full");
  });

  test("pull failure → error/download, no rollback, no swap", async () => {
    const { deps, io } = makeDeps(clock, {
      pullImage: async () => {
        throw new Error("registry unreachable");
      },
    });

    const outcome = await performUpdate(deps);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.phase).toBe("download");
    expect(outcome.rolledBack).toBe(false);
    expect(io.stops).toEqual([]);
    expect(io.recreated).toEqual([]);
    expect(io.posts.at(-1)).toMatchObject({
      state: "error",
      errorContext: "download",
    });
  });

  test("cosign verify failure → error/download, no rollback", async () => {
    const { deps, io } = makeDeps(clock, {
      verifyAndExtract: async () => {
        throw new Error("signature_unavailable");
      },
    });

    const outcome = await performUpdate(deps);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.phase).toBe("download");
    expect(io.stops).toEqual([]);
    expect(io.recreated).toEqual([]);
    expect(io.posts.at(-1)).toMatchObject({
      state: "error",
      errorContext: "download",
      errorMessage: expect.stringContaining("signature_unavailable"),
    });
  });
});

describe("performUpdate — rollback path", () => {
  let clock: ReturnType<typeof makeClock>;

  beforeEach(() => {
    clock = makeClock(1_700_000_000_000);
  });

  test("post-swap /ready timeout triggers rollback to :previous", async () => {
    let io: FakeIo;
    const made = makeDeps(clock, {
      // Install-phase /ready never reaches 200 (forces rollback). After the
      // rollback recreate happens, switch to ready=true so the rollback's
      // own ready-poll succeeds and we exercise the recovered-idle branch.
      fetchReady: async () => {
        if (io.recreated.length >= 2) return { ready: true, version: "0.1.0" };
        return { ready: false, reason: "booting" };
      },
    });
    io = made.io;
    const deps = made.deps;

    const outcome = await performUpdate(deps);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.phase).toBe("install");
    expect(outcome.rolledBack).toBe(true);
    expect(outcome.rollbackOk).toBe(true);
    expect(outcome.containerId).toBe("rolled-back-container-id");
    expect(outcome.version).toBe("0.1.0");

    // State sequence includes rolling-back and a final idle.
    const states = io.posts.map((p) => p.state);
    expect(states).toContain("installing");
    expect(states).toContain("rolling-back");

    // Tag dance: forward swap, then rollback :previous → :latest.
    expect(io.tags).toEqual([
      { source: "uncorded-runtime:latest", target: "uncorded-runtime:previous" },
      { source: "uncorded-runtime:0.2.0", target: "uncorded-runtime:latest" },
      { source: "uncorded-runtime:previous", target: "uncorded-runtime:latest" },
    ]);

    // Snapshot was restored.
    expect(io.restored).toEqual([BACKUP.dir]);

    // Recreate ran twice — once for the failed install, once for the rollback.
    expect(io.recreated).toHaveLength(2);

    // Final post: idle at prior version, errorMessage explains the rollback.
    expect(io.posts.at(-1)).toMatchObject({
      state: "idle",
      errorContext: null,
      currentVersion: "0.1.0",
      availableVersion: "0.2.0",
    });
    expect(io.posts.at(-1)?.errorMessage).toContain("rolled back successfully");
  });

  test("rollback skips snapshot restore when no backup was made", async () => {
    let io: FakeIo;
    const made = makeDeps(clock, {
      fetchReady: async () => {
        if (io.recreated.length >= 2) return { ready: true, version: "0.1.0" };
        return { ready: false, reason: "booting" };
      },
    }, { backupBeforeUpdate: false });
    io = made.io;
    const deps = made.deps;

    const outcome = await performUpdate(deps);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.rolledBack).toBe(true);
    expect(outcome.rollbackOk).toBe(true);
    expect(io.restored).toEqual([]);
  });

  test("hard failure: rollback target :previous missing → error/rollback", async () => {
    let firstReadyCalled = false;
    const { deps, io } = makeDeps(clock, {
      // First fetchReady (post-install) fails so we enter rollback. But we
      // never re-enter pollUntilReady because imageExists check fails first.
      fetchReady: async () => {
        firstReadyCalled = true;
        return { ready: false, reason: "booting" };
      },
      // imageExists returns false for :previous (rollback target gone).
      // Forward path uses imageExists for :latest — return true there so the
      // forward swap proceeds normally.
      imageExists: async (image: string) => {
        if (image === "uncorded-runtime:previous") return false;
        return true;
      },
    });

    const outcome = await performUpdate(deps);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.phase).toBe("rollback");
    expect(outcome.rolledBack).toBe(true);
    expect(outcome.rollbackOk).toBe(false);
    expect(firstReadyCalled).toBe(true);

    expect(io.posts.at(-1)).toMatchObject({
      state: "error",
      errorContext: "rollback",
      errorMessage: expect.stringContaining("Manual recovery required"),
    });
  });

  test("recreateContainer failing during the swap triggers rollback", async () => {
    let recreateCalls = 0;
    const { deps, io } = makeDeps(clock, {
      recreateContainer: async (image: string, sig) => {
        recreateCalls += 1;
        if (recreateCalls === 1) throw new Error("docker run refused");
        // Second call (rollback) succeeds.
        io.recreated.push({ image, sig });
        return "rolled-back-container-id";
      },
    });

    const outcome = await performUpdate(deps);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.rolledBack).toBe(true);
    expect(outcome.rollbackOk).toBe(true);
    expect(io.posts.map((p) => p.state)).toContain("rolling-back");
  });
});

describe("performUpdate — broadcast resilience", () => {
  let clock: ReturnType<typeof makeClock>;

  beforeEach(() => {
    clock = makeClock(1_700_000_000_000);
  });

  test("postUpdateState failures are tolerated and don't abort the update", async () => {
    let postCount = 0;
    const { deps, io } = makeDeps(clock, {
      postUpdateState: async (patch: UpdateStatePatch) => {
        postCount += 1;
        // Fail every other call to simulate a flaky runtime during drain.
        if (postCount % 2 === 0) throw new Error("ECONNREFUSED");
        io.posts.push(patch);
      },
    });

    const outcome = await performUpdate(deps);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // The update reached its terminal commit despite half the broadcasts
    // failing — the container was recreated and the version flipped.
    expect(outcome.containerId).toBe("new-container-id");
    expect(outcome.version).toBe("0.2.0");
    // postUpdateState was attempted for every state transition (the runtime
    // tolerates the misses, it doesn't skip them).
    expect(postCount).toBeGreaterThan(io.posts.length);
  });

  test("/ready transient failures recover before the timeout elapses", async () => {
    let attempts = 0;
    const { deps, io } = makeDeps(clock, {
      fetchReady: async () => {
        attempts += 1;
        if (attempts < 3) throw new Error("ECONNREFUSED");
        return { ready: true, version: "0.2.0" };
      },
    });

    const outcome = await performUpdate(deps);

    expect(outcome.ok).toBe(true);
    expect(attempts).toBeGreaterThanOrEqual(3);
    expect(io.recreated).toHaveLength(1);
  });
});

// ─── awaiting-restart gate ──────────────────────────────────────────────────
// The hard-pause between download/verify and install. The orchestrator opens
// a Deferred and POSTs `awaiting-restart`; install only proceeds once the IPC
// handler resolves the Deferred (= user clicked Restart). On reject we roll
// back to `available` and exit cleanly without touching the running container.

describe("performUpdate — awaiting-restart gate", () => {
  let clock: ReturnType<typeof makeClock>;

  beforeEach(() => {
    clock = makeClock(1_700_000_000_000);
  });

  test("posts awaiting-restart, awaits restartConfirmed, then proceeds to install", async () => {
    let gateReleased = false;
    let resolveGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      resolveGate = resolve;
    });

    const { deps, io } = makeDeps(clock, {
      restartConfirmed: () => gate,
    });

    const outcomePromise = performUpdate(deps);

    // Spin the event loop until performUpdate reaches the gate POST and parks
    // on the awaiting promise. Bounded so a regression that never reaches the
    // gate fails loudly instead of hanging the suite.
    for (let i = 0; i < 200 && !io.posts.some((p) => p.state === "awaiting-restart"); i++) {
      await Promise.resolve();
    }

    const statesSoFar = io.posts.map((p) => p.state);
    expect(statesSoFar).toEqual([
      "backing-up",
      "downloading",
      "downloaded",
      "awaiting-restart",
    ]);
    expect(io.recreated).toHaveLength(0); // container untouched
    expect(io.stops).toHaveLength(0);

    // The gate POST carries the user-facing copy.
    const gatePost = io.posts.at(-1)!;
    expect(gatePost.substep).toBe("Ready to restart");

    // Release the gate — install + final commit follow.
    gateReleased = true;
    resolveGate();
    const outcome = await outcomePromise;

    expect(gateReleased).toBe(true);
    expect(outcome.ok).toBe(true);
    expect(io.posts.map((p) => p.state)).toContain("installing");
    expect(io.posts.at(-1)?.state).toBe("idle");
  });

  test("RestartCancelledError soft-backs-out to `available`, no install, no rollback", async () => {
    const { deps, io } = makeDeps(clock, {
      restartConfirmed: () => Promise.reject(new RestartCancelledError("user backed out")),
    });

    const outcome = await performUpdate(deps);

    // Cancel returns a non-ok outcome but rolledBack=false (we never swapped).
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.rolledBack).toBe(false);
      expect(outcome.phase).toBe("download");
      expect(outcome.reason).toContain("user backed out");
    }

    // Last state on the wire is `available` (back to "Update available" UI).
    expect(io.posts.at(-1)?.state).toBe("available");
    expect(io.posts.at(-1)?.availableVersion).toBe("0.2.0");

    // Critically: container untouched.
    expect(io.recreated).toHaveLength(0);
    expect(io.stops).toHaveLength(0);
    expect(io.posts.map((p) => p.state)).not.toContain("installing");
  });

  test("non-RestartCancelledError rejection bubbles out (unexpected gate failure)", async () => {
    const { deps } = makeDeps(clock, {
      restartConfirmed: () => Promise.reject(new Error("ipc bridge died")),
    });

    expect(performUpdate(deps)).rejects.toThrow("ipc bridge died");
  });
});
