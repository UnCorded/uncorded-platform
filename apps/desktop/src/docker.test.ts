import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import * as _realChildProcess from "node:child_process";
import * as _realNodeFs from "node:fs";
import { PassThrough } from "node:stream";
import type { RunConfig } from "./docker";

// Snapshot real child_process exports before mocking so afterAll can restore
// the genuine module shape — `import * as` is a live binding.
const realChildProcess = { ..._realChildProcess };
const realNodeFs = { ..._realNodeFs };

const mockExecFile = mock<typeof import("node:child_process").execFile>();
const mockSpawn = mock<typeof import("node:child_process").spawn>();
const mockExistsSync = mock<(path: string) => boolean>();

let dockerModule: typeof import("./docker");

beforeAll(async () => {
  // Spread real exports so any sibling test that imports exec/fork still works.
  await mock.module("child_process", () => ({
    ...realChildProcess,
    execFile: mockExecFile,
    spawn: mockSpawn,
  }));
  await mock.module("node:fs", () => ({
    ...realNodeFs,
    existsSync: mockExistsSync,
  }));

  dockerModule = await import("./docker");
});

afterAll(async () => {
  await mock.module("child_process", () => realChildProcess);
  await mock.module("node:fs", () => realNodeFs);
});

function mockExecFileSuccess(stdout = "", stderr = ""): void {
  mockExecFile.mockImplementation(((...args: unknown[]) => {
    const cb = args[args.length - 1] as (
      err: null,
      stdout: string,
      stderr: string,
    ) => void;
    cb(null, stdout, stderr);
    return {} as ChildProcess;
  }) as unknown as typeof import("node:child_process").execFile);
}

function mockExecFileError(err: Partial<NodeJS.ErrnoException>): void {
  mockExecFile.mockImplementation(((...args: unknown[]) => {
    const cb = args[args.length - 1] as (
      err: NodeJS.ErrnoException,
      stdout: string,
      stderr: string,
    ) => void;
    cb(err as NodeJS.ErrnoException, "", err.message ?? "");
    return {} as ChildProcess;
  }) as unknown as typeof import("node:child_process").execFile);
}

beforeEach(() => {
  mockExecFile.mockReset();
  mockSpawn.mockReset();
});

describe("getDockerStatus", () => {
  it("returns installed:false, running:false when docker is not installed (ENOENT)", async () => {
    mockExecFileError({ code: "ENOENT", message: "docker: command not found" });
    const status = await dockerModule.getDockerStatus();
    expect(status).toEqual({ installed: false, running: false });
  });

  it("returns installed:true, running:true when docker info succeeds", async () => {
    mockExecFileSuccess("Server:\n  Containers: 0\n");
    const status = await dockerModule.getDockerStatus();
    expect(status).toEqual({ installed: true, running: true });
  });

  it("returns installed:true, running:false when docker info exits non-zero", async () => {
    mockExecFileError({ code: "1", message: "Cannot connect to the Docker daemon" });
    const status = await dockerModule.getDockerStatus();
    expect(status).toEqual({ installed: true, running: false });
  });
});

describe("listContainers", () => {
  it("returns app-owned containers by name prefix or image prefix", async () => {
    const rows = [
      JSON.stringify({
        ID: "abc123",
        Names: "uncorded-my-server",
        Image: "uncorded/server:latest",
        Status: "running",
        CreatedAt: "2024-01-01 00:00:00 +0000 UTC",
      }),
      JSON.stringify({
        ID: "def456",
        Names: "other-container",
        Image: "nginx:latest",
        Status: "exited",
        CreatedAt: "2024-01-01 00:00:00 +0000 UTC",
      }),
      JSON.stringify({
        ID: "ghi789",
        Names: "custom-server",
        Image: "uncorded/server:latest",
        Status: "paused",
        CreatedAt: "2024-01-01 12:00:00 +0000 UTC",
      }),
      JSON.stringify({
        ID: "jkl012",
        Names: "uncorded-second-server",
        Image: "uncorded/server:latest",
        Status: "exited",
        CreatedAt: "2024-01-02 00:00:00 +0000 UTC",
      }),
    ];

    mockExecFileSuccess(rows.join("\n"));
    const containers = await dockerModule.listContainers();

    expect(containers).toHaveLength(3);
    expect(containers[0]?.name).toBe("uncorded-my-server");
    expect(containers[1]?.name).toBe("custom-server");
    expect(containers[2]?.name).toBe("uncorded-second-server");
    expect(containers.find((container) => container.name === "other-container")).toBeUndefined();
  });
});

describe("streamLogs", () => {
  it("buffers partial lines and flushes them on close", () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = new EventEmitter() as ChildProcess & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: ReturnType<typeof mock>;
    };
    child.stdout = stdout;
    child.stderr = stderr;
    child.kill = mock(() => true);
    mockSpawn.mockReturnValue(child);

    const lines: string[] = [];
    let ended = 0;
    const stop = dockerModule.streamLogs(
      "container-123",
      (line) => lines.push(line),
      () => {
        ended += 1;
      },
    );

    stdout.write("first line\npart");
    stderr.write("stderr line\n");
    stdout.write("ial line\n");
    child.emit("close");

    expect(lines).toEqual(["first line", "stderr line", "partial line"]);
    expect(ended).toBe(1);

    stop();
    expect(child.kill).toHaveBeenCalled();
  });
});

// pullImage now delegates to docker-pull-api (HTTP daemon socket) — see
// docker-pull-api.test.ts for the unit tests on parseImageRef +
// formatPullEventLine. Shelling out to `docker pull` from Node spawn
// silently degraded to summary mode and the runtime-update UI wedged at 0%.

describe("runContainer", () => {
  it("builds the docker run argv array correctly without shell interpolation", async () => {
    let capturedArgs: string[] = [];
    mockExecFile.mockImplementation(((...args: unknown[]) => {
      capturedArgs = args[1] as string[];
      const cb = args[args.length - 1] as (
        err: null,
        stdout: string,
        stderr: string,
      ) => void;
      cb(null, "container-id-abc\n", "");
      return {} as ChildProcess;
    }) as unknown as typeof import("node:child_process").execFile);

    const config: RunConfig = {
      image: "uncorded/server:latest",
      name: "uncorded-test",
      volumes: [{ host: "/host/data", container: "/data" }],
      env: { UNCORDED_TOKEN: "secret-value", PORT: "3000" },
      ports: [{ host: 8080, container: 80 }],
      restartPolicy: "unless-stopped",
    };

    const containerId = await dockerModule.runContainer(config);

    expect(containerId).toBe("container-id-abc");
    expect(mockExecFile).toHaveBeenCalled();
    expect(mockExecFile.mock.calls[0]?.[0]).toBe("docker");
    expect(Array.isArray(mockExecFile.mock.calls[0]?.[1])).toBe(true);
    expect(typeof mockExecFile.mock.calls[0]?.[2]).toBe("function");

    expect(capturedArgs).toContain("run");
    expect(capturedArgs).toContain("-d");
    expect(capturedArgs).toContain("--name");
    expect(capturedArgs).toContain("uncorded-test");
    expect(capturedArgs).toContain("--volume");
    expect(capturedArgs).toContain("/host/data:/data");
    expect(capturedArgs).toContain("--env");
    expect(capturedArgs).toContain("UNCORDED_TOKEN=secret-value");
    expect(capturedArgs).toContain("--publish");
    expect(capturedArgs).toContain("8080:80");
    expect(capturedArgs).toContain("--restart");
    expect(capturedArgs).toContain("unless-stopped");
    expect(capturedArgs).toContain("uncorded/server:latest");

    const joined = capturedArgs.join(" ");
    expect(joined).not.toMatch(/[;&|`$]/);
  });

  it("renders --sysctl flags for each kernel parameter", async () => {
    let capturedArgs: string[] = [];
    mockExecFile.mockImplementation(((...args: unknown[]) => {
      capturedArgs = args[1] as string[];
      const cb = args[args.length - 1] as (
        err: null,
        stdout: string,
        stderr: string,
      ) => void;
      cb(null, "container-id-sysctl\n", "");
      return {} as ChildProcess;
    }) as unknown as typeof import("node:child_process").execFile);

    const config: RunConfig = {
      image: "uncorded/server:latest",
      name: "uncorded-sysctl",
      volumes: [],
      env: {},
      ports: [],
      restartPolicy: "unless-stopped",
      sysctls: {
        "net.core.rmem_max": "7500000",
        "net.core.wmem_max": "7500000",
      },
    };

    await dockerModule.runContainer(config);

    const sysctlIndices = capturedArgs.reduce<number[]>((acc, arg, idx) => {
      if (arg === "--sysctl") acc.push(idx);
      return acc;
    }, []);
    expect(sysctlIndices.length).toBe(2);
    const sysctlValues = sysctlIndices
      .map((idx) => capturedArgs[idx + 1])
      .sort();
    expect(sysctlValues).toEqual([
      "net.core.rmem_max=7500000",
      "net.core.wmem_max=7500000",
    ]);
  });
});

// ── Docker Desktop boot helpers ──────────────────────────────────────────────
// Driven by process.platform branching, so we patch it per-test. mockExistsSync
// is configured to mirror the candidate-path checks the helper uses on each
// platform; the goal is that the wizard's "Start Docker Desktop" button only
// renders when an actual install can be located.

describe("findDockerDesktop", () => {
  const originalPlatform = process.platform;
  const originalProgramFiles = process.env.PROGRAMFILES;
  const originalLocalAppData = process.env.LOCALAPPDATA;

  function setPlatform(value: NodeJS.Platform): void {
    Object.defineProperty(process, "platform", { value, configurable: true });
  }

  beforeEach(() => {
    mockExistsSync.mockReset();
  });

  afterAll(() => {
    setPlatform(originalPlatform);
    if (originalProgramFiles === undefined) {
      delete process.env.PROGRAMFILES;
    } else {
      process.env.PROGRAMFILES = originalProgramFiles;
    }
    if (originalLocalAppData === undefined) {
      delete process.env.LOCALAPPDATA;
    } else {
      process.env.LOCALAPPDATA = originalLocalAppData;
    }
  });

  it("returns the Program Files path on Windows when present", () => {
    setPlatform("win32");
    process.env.PROGRAMFILES = "C:\\Program Files";
    process.env.LOCALAPPDATA = "C:\\Users\\u\\AppData\\Local";
    mockExistsSync.mockImplementation(
      (p: string) => p === "C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe",
    );
    expect(dockerModule.findDockerDesktop()).toBe(
      "C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe",
    );
  });

  it("falls back to LocalAppData on Windows for non-admin installs", () => {
    setPlatform("win32");
    process.env.PROGRAMFILES = "C:\\Program Files";
    process.env.LOCALAPPDATA = "C:\\Users\\u\\AppData\\Local";
    const expected = "C:\\Users\\u\\AppData\\Local\\Programs\\Docker\\Docker\\Docker Desktop.exe";
    mockExistsSync.mockImplementation((p: string) => p === expected);
    expect(dockerModule.findDockerDesktop()).toBe(expected);
  });

  it("returns null on Windows when no candidate exists", () => {
    setPlatform("win32");
    process.env.PROGRAMFILES = "C:\\Program Files";
    process.env.LOCALAPPDATA = "C:\\Users\\u\\AppData\\Local";
    mockExistsSync.mockReturnValue(false);
    expect(dockerModule.findDockerDesktop()).toBeNull();
  });

  it("returns the Docker.app bundle on macOS when present", () => {
    setPlatform("darwin");
    mockExistsSync.mockImplementation((p: string) => p === "/Applications/Docker.app");
    expect(dockerModule.findDockerDesktop()).toBe("/Applications/Docker.app");
  });

  it("returns null on Linux (dockerd is a system service, not user-launchable)", () => {
    setPlatform("linux");
    mockExistsSync.mockReturnValue(true);
    expect(dockerModule.findDockerDesktop()).toBeNull();
  });
});

describe("waitForDockerRunning", () => {
  it("resolves true once `docker info` answers", async () => {
    let calls = 0;
    mockExecFile.mockImplementation(((...args: unknown[]) => {
      calls++;
      const cb = args[args.length - 1] as (
        err: NodeJS.ErrnoException | null,
        stdout: string,
        stderr: string,
      ) => void;
      // First two calls: daemon still booting → exit 1.
      // Third call: succeed.
      if (calls < 3) {
        cb(Object.assign(new Error("daemon not running"), { code: "EBADF" }), "", "");
      } else {
        cb(null, "", "");
      }
      return {} as ChildProcess;
    }) as unknown as typeof import("node:child_process").execFile);

    // Generous timeout so the 2s polling cadence has room — our default
    // interval is 2000ms but we don't want the suite to take 6s, so we
    // override on the helper directly via a much shorter custom interval
    // by using a large timeout and trusting the loop to converge fast.
    const result = await dockerModule.waitForDockerRunning({ timeoutMs: 30_000 });
    expect(result).toBe(true);
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it("returns false if the daemon never answers within the budget", async () => {
    mockExecFile.mockImplementation(((...args: unknown[]) => {
      const cb = args[args.length - 1] as (
        err: NodeJS.ErrnoException | null,
        stdout: string,
        stderr: string,
      ) => void;
      cb(Object.assign(new Error("not running"), { code: "EBADF" }), "", "");
      return {} as ChildProcess;
    }) as unknown as typeof import("node:child_process").execFile);

    // 100ms budget — well under one poll interval, so the first iteration
    // runs (sees not-running) then the deadline check exits the loop.
    const result = await dockerModule.waitForDockerRunning({ timeoutMs: 100 });
    expect(result).toBe(false);
  });
});
