import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ProvisionInput } from "./provision";

// ---------------------------------------------------------------------------
// Capture real Node built-in module refs BEFORE any mock.module calls.
// Static imports run before beforeAll, so these always get the real modules —
// BUT namespace imports (`import * as X`) are live bindings, so reading
// _realNodeFs.existsSync later would get the currently-mocked value, not the
// pristine real one. Copy each export into a frozen plain object immediately
// so afterAll has true real references to restore from.
// ---------------------------------------------------------------------------
import * as _realNodeFs from "node:fs";
import * as _realNodeFsp from "node:fs/promises";
import * as _realNodeOs from "node:os";
const realNodeFs = { ..._realNodeFs };
const realNodeFsp = { ..._realNodeFsp };
const realNodeOs = { ..._realNodeOs };

// Capture the real ./docker surface too. We mock it below for provision's own
// tests, and Bun's mock.module is process-global: on platforms where it does
// not auto-reset between files (Linux CI), the stripped mock would otherwise
// leak into docker.test.ts. afterAll restores the genuine module. (docker.ts
// only imports child_process/node:fs/docker-pull-api — no electron — so loading
// it here is side-effect free.)
import * as _realDocker from "./docker";
const realDocker = { ..._realDocker };

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

const mockCentralCreateServer = mock(async () => ({
  id: "srv_abc123",
  server_secret: "secret_xyz",
}));
const mockCentralDeleteServer = mock(async () => undefined as void);
const mockCentralGetServer = mock(async () => ({
  tunnel_url: "https://demo-server.trycloudflare.com" as string | null,
  last_heartbeat_at: "2026-01-01T00:00:00Z" as string | null,
}));

const mockDockerImageExists = mock(async () => true);
const mockDockerRunContainer = mock(async () => "container_abc");
const mockDockerRemoveContainer = mock(async () => undefined as void);
const mockDockerPullImage = mock(
  (
    _image: string,
    _onProgress: (line: string) => void,
    onDone: () => void,
    _onError: (msg: string) => void,
  ) => {
    onDone();
  },
);
const mockDockerGetStatus = mock(async () => ({ installed: true, running: true }));
const mockDockerTagImage = mock(async (_source: string, _target: string) => undefined as void);

// First-boot orchestrator helpers — the GHCR resolve / pull / cosign / tag
// dance lives in runtime-orchestrator.ts so the registry/pubkey constants
// stay in one place. provision.ts is now a thin caller; tests assert the
// helper was invoked with the right channel and that the returned signature
// flows into runServerContainer.
const FAKE_DIGEST = "sha256:" + "a".repeat(64);
type FakeSignature = { digest: string; payloadJson: string; signatureB64: string };
const FAKE_SIGNATURE: FakeSignature = {
  digest: FAKE_DIGEST,
  payloadJson: '{"critical":{}}',
  signatureB64: "MEUCIQ==",
};
type FirstBootResult = {
  targetVersion: string;
  targetImage: string;
  digest: string;
  signature: FakeSignature | undefined;
};
const mockPullVerifyAndTagForFirstBoot = mock(
  async (_args: { channel: string }): Promise<FirstBootResult> => ({
    targetVersion: "0.1.0-dev.1",
    targetImage: "ghcr.io/uncorded/runtime:0.1.0-dev.1",
    digest: FAKE_DIGEST,
    signature: FAKE_SIGNATURE,
  }),
);
class MockFirstBootPullError extends Error {
  override readonly name = "FirstBootPullError";
  constructor(message: string, public override readonly cause: unknown) {
    super(message);
  }
}
const mockSetChannelByEndpoint = mock(async (_id: string, _port: number, _ch: string) => undefined as void);

const mockMkdir = mock(async () => undefined);
const mockRm = mock(async () => undefined);
const mockWriteFile = mock(async () => undefined);
const mockExistsSync = mock(() => false);

// Capture secret-store writes so the cloudflare-tunnel test can assert the token
// landed under tunnel:<serverId> instead of being persisted to disk.
const mockKeychainSet = mock((_key: string, _value: string) => undefined);
const mockKeychainGet = mock((_key: string) => null as string | null);
const mockKeychainDelete = mock((_key: string) => undefined);

// ---------------------------------------------------------------------------
// Module setup — mocks must be registered before the module under test loads.
// ---------------------------------------------------------------------------

let provisionModule: typeof import("./provision");
const originalFetch = globalThis.fetch;

beforeAll(async () => {
  // electron is stubbed globally by the test preload
  // (apps/desktop/test/preload-electron.ts) — no per-file electron mock needed.
  await mock.module("./desktop-secrets", () => ({
    getSecret: mockKeychainGet,
    setSecret: mockKeychainSet,
    deleteSecret: mockKeychainDelete,
    tunnelSecretKey: (serverId: string) => `tunnel:${serverId}`,
    encryptionSecretKey: (serverId: string) => `encryption:${serverId}`,
  }));
  await mock.module("./central", () => ({
    createServer: mockCentralCreateServer,
    deleteServer: mockCentralDeleteServer,
    getServer: mockCentralGetServer,
    getContainerCentralUrl: () => "https://central.uncorded.app",
  }));
  await mock.module("./docker", () => ({
    imageExists: mockDockerImageExists,
    runContainer: mockDockerRunContainer,
    removeContainer: mockDockerRemoveContainer,
    pullImage: mockDockerPullImage,
    getDockerStatus: mockDockerGetStatus,
    tagImage: mockDockerTagImage,
  }));
  await mock.module("./runtime-orchestrator", () => ({
    pullVerifyAndTagForFirstBoot: mockPullVerifyAndTagForFirstBoot,
    FirstBootPullError: MockFirstBootPullError,
    setChannelByEndpoint: mockSetChannelByEndpoint,
  }));
  // Spread the real modules and only override the functions provision.ts calls.
  // This prevents stripping exports that other modules (e.g. postgres) rely on.
  await mock.module("node:fs/promises", () => ({
    ...realNodeFsp,
    mkdir: mockMkdir,
    rm: mockRm,
    writeFile: mockWriteFile,
  }));
  await mock.module("node:fs", () => ({
    ...realNodeFs,
    existsSync: mockExistsSync,
  }));
  await mock.module("node:os", () => ({
    ...realNodeOs,
    homedir: () => "/fake/home",
  }));
  provisionModule = await import("./provision");
});

// ---------------------------------------------------------------------------
// Reset helpers
// ---------------------------------------------------------------------------

const originalDateNow = Date.now;

beforeEach(() => {
  // Reset call history and re-apply default implementations for each test.
  mockCentralCreateServer.mockReset();
  mockCentralDeleteServer.mockReset();
  mockCentralGetServer.mockReset();
  mockDockerImageExists.mockReset();
  mockDockerRunContainer.mockReset();
  mockDockerRemoveContainer.mockReset();
  mockDockerPullImage.mockReset();
  mockDockerGetStatus.mockReset();
  mockDockerTagImage.mockReset();
  mockPullVerifyAndTagForFirstBoot.mockReset();
  mockSetChannelByEndpoint.mockReset();
  mockMkdir.mockReset();
  mockRm.mockReset();
  mockWriteFile.mockReset();
  mockExistsSync.mockReset();
  mockKeychainSet.mockReset();
  mockKeychainGet.mockReset();
  mockKeychainDelete.mockReset();
  mockKeychainGet.mockReturnValue(null);

  mockCentralCreateServer.mockResolvedValue({ id: "srv_abc123", server_secret: "secret_xyz" });
  mockCentralDeleteServer.mockResolvedValue(undefined);
  mockCentralGetServer.mockResolvedValue({
    tunnel_url: "https://demo-server.trycloudflare.com",
    last_heartbeat_at: "2026-01-01T00:00:00Z",
  });
  mockDockerImageExists.mockResolvedValue(true);
  mockDockerRunContainer.mockResolvedValue("container_abc");
  mockDockerRemoveContainer.mockResolvedValue(undefined);
  mockDockerPullImage.mockImplementation(
    (_img, _prog, done, _err) => { done(); },
  );
  mockDockerGetStatus.mockResolvedValue({ installed: true, running: true });
  mockDockerTagImage.mockResolvedValue(undefined);
  mockPullVerifyAndTagForFirstBoot.mockResolvedValue({
    targetVersion: "0.1.0-dev.1",
    targetImage: "ghcr.io/uncorded/runtime:0.1.0-dev.1",
    digest: FAKE_DIGEST,
    signature: FAKE_SIGNATURE,
  });
  mockSetChannelByEndpoint.mockResolvedValue(undefined);
  mockMkdir.mockResolvedValue(undefined);
  mockRm.mockResolvedValue(undefined);
  mockWriteFile.mockResolvedValue(undefined);
  mockExistsSync.mockReturnValue(false);

  // Default fetch: health check returns 200 immediately.
  globalThis.fetch = mock(async () => new Response("{}", { status: 200 })) as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  Date.now = originalDateNow;
});

// Restore all mocked Node built-ins so subsequent test files in the same
// Bun worker process see the real modules (not our stripped mock shapes).
afterAll(async () => {
  await Promise.all([
    mock.module("node:fs", () => realNodeFs),
    mock.module("node:fs/promises", () => realNodeFsp),
    mock.module("node:os", () => realNodeOs),
    mock.module("./docker", () => realDocker),
  ]);
});

// ---------------------------------------------------------------------------
// Default input
// ---------------------------------------------------------------------------

function makeInput(overrides?: Partial<ProvisionInput>): ProvisionInput {
  return {
    name: "Test Server",
    description: null,
    visibility: "private",
    selectedPlugins: ["text-channels"],
    tunnelMode: "demo",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("provisionServer — success (demo mode)", () => {
  it("returns serverId, slug, tunnelUrl, containerId, hostPort", async () => {
    const result = await provisionModule.provisionServer(makeInput(), () => {});

    expect(result.serverId).toBe("srv_abc123");
    expect(result.containerId).toBe("container_abc");
    expect(result.hostPort).toBe(3000);
    expect(result.tunnelUrl).toBe("https://demo-server.trycloudflare.com");
    expect(typeof result.slug).toBe("string");
    expect(result.slug.length).toBeGreaterThan(0);
  });

  it("writes server.json with correct tunnel config", async () => {
    await provisionModule.provisionServer(makeInput(), () => {});

    // writeFile is called once for server.json
    expect(mockWriteFile.mock.calls.length).toBe(1);
    const [_path, contents] = (mockWriteFile.mock.calls[0] as unknown) as [string, string, string];
    const parsed = JSON.parse(contents) as {
      server_id: string;
      tunnel: { provider: string; mode: string };
      installed_plugins: string[];
      settings: { allowed_origins: string[] };
    };
    expect(parsed.server_id).toBe("srv_abc123");
    expect(parsed.tunnel.provider).toBe("cloudflare");
    expect(parsed.tunnel.mode).toBe("demo");
    expect(parsed.installed_plugins).toContain("text-channels");
    // Wizard must seed allowed_origins or the shell can't make authenticated
    // cross-origin fetches. Both production (uncorded.app) and dev
    // (localhost:5173/5174) shell origins are seeded so a freshly-created
    // server works against every shell entry point without a manual edit.
    expect(parsed.settings.allowed_origins).toContain("https://uncorded.app");
    expect(parsed.settings.allowed_origins).toContain("http://localhost:5174");
  });

  it("creates volume directories", async () => {
    await provisionModule.provisionServer(makeInput(), () => {});

    // At minimum: root, plugins/, data/, config/, data/plugins/
    expect(mockMkdir.mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it("streams progress events", async () => {
    const events: string[] = [];
    await provisionModule.provisionServer(makeInput(), (e) => events.push(e.step));

    expect(events).toContain("register");
    expect(events).toContain("prepare-volumes");
    expect(events).toContain("write-config");
    expect(events).toContain("start-container");
    expect(events).toContain("done");
  });
});

describe("provisionServer — rollback: image pull failure", () => {
  it("deletes Central registration, does NOT remove container or volumes", async () => {
    mockPullVerifyAndTagForFirstBoot.mockRejectedValueOnce(
      new MockFirstBootPullError("registry unavailable", new Error("registry unavailable")),
    );

    await expect(provisionModule.provisionServer(makeInput(), () => {})).rejects.toThrow(
      /registry unavailable/,
    );

    // Central registration must be rolled back
    expect(mockCentralDeleteServer.mock.calls.length).toBe(1);
    const deleteArgs = (mockCentralDeleteServer.mock.calls[0] as unknown) as [string];
    expect(deleteArgs[0]).toBe("srv_abc123");

    // No container was started, no volumes to clean
    expect(mockDockerRemoveContainer.mock.calls.length).toBe(0);
    expect(mockRm.mock.calls.length).toBe(0);
  });

  it("emits a friendly errorCode the renderer can map to copy", async () => {
    mockPullVerifyAndTagForFirstBoot.mockRejectedValueOnce(
      new MockFirstBootPullError("registry unavailable", new Error("registry unavailable")),
    );
    const events: { step: string; status: string; errorCode?: string }[] = [];
    await expect(
      provisionModule.provisionServer(makeInput(), (e) =>
        events.push({ step: e.step, status: e.status, ...(e.errorCode ? { errorCode: e.errorCode } : {}) }),
      ),
    ).rejects.toThrow();
    const failure = events.find((e) => e.step === "download-runtime" && e.status === "warning");
    expect(failure?.errorCode).toBe("pull_failed");
  });

  it("propagates a cosign verify failure with cosign_<code> errorCode and skips the swap", async () => {
    const cosignError = Object.assign(new Error("signature_unavailable"), {
      code: "no_signature",
    });
    mockPullVerifyAndTagForFirstBoot.mockRejectedValueOnce(cosignError);
    const events: { step: string; status: string; errorCode?: string }[] = [];
    await expect(
      provisionModule.provisionServer(makeInput(), (e) =>
        events.push({ step: e.step, status: e.status, ...(e.errorCode ? { errorCode: e.errorCode } : {}) }),
      ),
    ).rejects.toThrow(/Signature verification failed/);
    const failure = events.find((e) => e.step === "verify-signature" && e.status === "warning");
    expect(failure?.errorCode).toBe("cosign_no_signature");
    expect(mockDockerRunContainer.mock.calls.length).toBe(0);
  });

  it("maps a missing-channel-release to a no_release_for_channel hint", async () => {
    mockPullVerifyAndTagForFirstBoot.mockRejectedValueOnce(
      new Error('No runtime release published for the "stable" channel yet.'),
    );
    const events: { step: string; status: string; errorCode?: string }[] = [];
    await expect(
      provisionModule.provisionServer(makeInput({ channel: "stable" }), (e) =>
        events.push({ step: e.step, status: e.status, ...(e.errorCode ? { errorCode: e.errorCode } : {}) }),
      ),
    ).rejects.toThrow();
    const failure = events.find((e) => e.step === "resolve-version" && e.status === "warning");
    expect(failure?.errorCode).toBe("no_release_for_channel");
  });
});

describe("provisionServer — pre-flight check", () => {
  it("fails fast with docker_not_running when Docker daemon is down — Central never registered", async () => {
    mockDockerGetStatus.mockResolvedValueOnce({ installed: true, running: false });
    const events: { step: string; status: string; errorCode?: string }[] = [];
    await expect(
      provisionModule.provisionServer(makeInput(), (e) =>
        events.push({ step: e.step, status: e.status, ...(e.errorCode ? { errorCode: e.errorCode } : {}) }),
      ),
    ).rejects.toThrow(/Docker isn't running/);
    expect(mockCentralCreateServer.mock.calls.length).toBe(0);
    const failure = events.find((e) => e.step === "check-environment" && e.status === "warning");
    expect(failure?.errorCode).toBe("docker_not_running");
  });

  it("fails fast with docker_not_installed when Docker isn't on the PATH", async () => {
    mockDockerGetStatus.mockResolvedValueOnce({ installed: false, running: false });
    const events: { step: string; errorCode?: string }[] = [];
    await expect(
      provisionModule.provisionServer(makeInput(), (e) =>
        events.push({ step: e.step, ...(e.errorCode ? { errorCode: e.errorCode } : {}) }),
      ),
    ).rejects.toThrow(/Docker isn't installed/);
    expect(events.find((e) => e.errorCode === "docker_not_installed")).toBeDefined();
  });
});

describe("provisionServer — runtime channel", () => {
  it("forwards the channel to the orchestrator and persists it after wait-health", async () => {
    await provisionModule.provisionServer(makeInput({ channel: "beta" }), () => {});

    expect(mockPullVerifyAndTagForFirstBoot.mock.calls.length).toBe(1);
    const [pullArgs] = (mockPullVerifyAndTagForFirstBoot.mock.calls[0] as unknown) as [
      { channel: string },
    ];
    expect(pullArgs.channel).toBe("beta");

    expect(mockSetChannelByEndpoint.mock.calls.length).toBe(1);
    const [serverId, hostPort, ch] = (mockSetChannelByEndpoint.mock.calls[0] as unknown) as [
      string,
      number,
      string,
    ];
    expect(serverId).toBe("srv_abc123");
    expect(hostPort).toBe(3000);
    expect(ch).toBe("beta");
  });

  it("defaults to dev when the wizard didn't pick a channel", async () => {
    await provisionModule.provisionServer(makeInput(), () => {});
    const [pullArgs] = (mockPullVerifyAndTagForFirstBoot.mock.calls[0] as unknown) as [
      { channel: string },
    ];
    expect(pullArgs.channel).toBe("dev");
  });

  it("forwards the cosign signature material to the runtime container", async () => {
    await provisionModule.provisionServer(makeInput(), () => {});
    const [runConfig] = (mockDockerRunContainer.mock.calls[0] as unknown) as [
      { env: Record<string, string> },
    ];
    expect(runConfig.env.RUNTIME_IMAGE_DIGEST).toBe(FAKE_DIGEST);
    expect(runConfig.env.RUNTIME_IMAGE_PAYLOAD).toBe(FAKE_SIGNATURE.payloadJson);
    expect(runConfig.env.RUNTIME_IMAGE_SIGNATURE).toBe(FAKE_SIGNATURE.signatureB64);
  });

  it("does NOT forward RUNTIME_IMAGE_* envs in seed-state (signature undefined)", async () => {
    mockPullVerifyAndTagForFirstBoot.mockResolvedValueOnce({
      targetVersion: "0.1.0-dev.1",
      targetImage: "ghcr.io/uncorded/runtime:0.1.0-dev.1",
      digest: "",
      signature: undefined,
    });
    await provisionModule.provisionServer(makeInput(), () => {});
    const [runConfig] = (mockDockerRunContainer.mock.calls[0] as unknown) as [
      { env: Record<string, string> },
    ];
    expect(runConfig.env.RUNTIME_IMAGE_DIGEST).toBeUndefined();
    expect(runConfig.env.RUNTIME_IMAGE_PAYLOAD).toBeUndefined();
    expect(runConfig.env.RUNTIME_IMAGE_SIGNATURE).toBeUndefined();
  });
});

describe("provisionServer — UNCORDED_DEV_USE_LOCAL_IMAGE escape hatch", () => {
  const originalEnv = process.env.UNCORDED_DEV_USE_LOCAL_IMAGE;
  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.UNCORDED_DEV_USE_LOCAL_IMAGE;
    } else {
      process.env.UNCORDED_DEV_USE_LOCAL_IMAGE = originalEnv;
    }
  });

  it("skips the GHCR helper, set-channel, and tag dance when the env is set", async () => {
    process.env.UNCORDED_DEV_USE_LOCAL_IMAGE = "1";
    mockDockerImageExists.mockResolvedValueOnce(true);

    await provisionModule.provisionServer(makeInput(), () => {});

    expect(mockPullVerifyAndTagForFirstBoot.mock.calls.length).toBe(0);
    expect(mockSetChannelByEndpoint.mock.calls.length).toBe(0);
    // runServerContainer still ran — no signature forwarded in dev mode.
    expect(mockDockerRunContainer.mock.calls.length).toBe(1);
    const [runConfig] = (mockDockerRunContainer.mock.calls[0] as unknown) as [
      { env: Record<string, string> },
    ];
    expect(runConfig.env.RUNTIME_IMAGE_DIGEST).toBeUndefined();
  });

  it("fails with a build hint if the local tag isn't present", async () => {
    process.env.UNCORDED_DEV_USE_LOCAL_IMAGE = "1";
    mockDockerImageExists.mockResolvedValueOnce(false);
    await expect(provisionModule.provisionServer(makeInput(), () => {})).rejects.toThrow(
      /UNCORDED_DEV_USE_LOCAL_IMAGE=1 but uncorded-runtime:latest is not built locally/,
    );
  });
});

describe("provisionServer — rollback: container start failure", () => {
  it("removes volumes and deletes Central registration, does NOT call removeContainer", async () => {
    mockDockerRunContainer.mockRejectedValue(new Error("docker daemon unavailable"));

    await expect(provisionModule.provisionServer(makeInput(), () => {})).rejects.toThrow(
      "docker daemon unavailable",
    );

    // Container never started — nothing to remove
    expect(mockDockerRemoveContainer.mock.calls.length).toBe(0);

    // Volumes were created before container start — must be cleaned up
    expect(mockRm.mock.calls.length).toBe(1);

    // Central registration must be rolled back
    expect(mockCentralDeleteServer.mock.calls.length).toBe(1);
  });
});

describe("provisionServer — PreserveServerError: health timeout", () => {
  it("does NOT roll back Central, container, or volumes", async () => {
    // Call 0: waitForHealth sets deadline = base + 60_000.
    // Call 1: first loop check → base + 80_000 > base + 60_000 → false → loop exits immediately.
    const base = 1_000_000;
    let calls = 0;
    Date.now = () => calls++ === 0 ? base : base + 80_000;

    await expect(provisionModule.provisionServer(makeInput(), () => {})).rejects.toThrow();

    expect(mockCentralDeleteServer.mock.calls.length).toBe(0);
    expect(mockDockerRemoveContainer.mock.calls.length).toBe(0);
    expect(mockRm.mock.calls.length).toBe(0);
  });
});

describe("provisionServer — PreserveServerError: heartbeat timeout", () => {
  it("does NOT roll back Central, container, or volumes when heartbeat is late", async () => {
    // Sequence:
    //   call 0 — waitForHealth deadline: base          → deadline = base + 60_000
    //   call 1 — waitForHealth loop check: base        → base < base+60_000 → true → fetch 200 → return
    //   call 2 — waitForFirstHeartbeat deadline: base+1 → deadline = base+1+60_000 = base+60_001
    //   call 3 — heartbeat loop check: base+80_000     → base+80_000 < base+60_001 → false → throw
    const base = 1_000_000;
    const seq = [base, base, base + 1, base + 80_000];
    let idx = 0;
    Date.now = () => seq[idx++] ?? base + 80_000;

    // Central never reports a tunnel URL or heartbeat.
    mockCentralGetServer.mockResolvedValue({ tunnel_url: null, last_heartbeat_at: null });

    await expect(provisionModule.provisionServer(makeInput(), () => {})).rejects.toThrow();

    expect(mockCentralDeleteServer.mock.calls.length).toBe(0);
    expect(mockDockerRemoveContainer.mock.calls.length).toBe(0);
    expect(mockRm.mock.calls.length).toBe(0);
  });
});

describe("provisionServer — cloudflare tunnel token", () => {
  it("stashes the token in the secret store and pipes it via stdin (no disk write)", async () => {
    const input = makeInput({
      tunnelMode: "cloudflare",
      cloudflare_tunnel_token: "eyJhIjoitest-token",
    });

    await provisionModule.provisionServer(input, () => {});

    // server.json is the only file written — tunnel.json never lands on host
    // disk. The runtime gets its tunnel material from /run/tunnel (tmpfs)
    // populated by the entrypoint wrapper from stdin.
    expect(mockWriteFile.mock.calls.length).toBe(1);
    const [serverPath, serverContents] = (mockWriteFile.mock.calls[0] as unknown) as [string, string, string];
    expect(serverPath).toMatch(/server\.json$/);

    const serverParsed = JSON.parse(serverContents) as {
      tunnel: { provider: string; mode: string; credentials_file: string };
    };
    expect(serverParsed.tunnel.provider).toBe("cloudflare");
    expect(serverParsed.tunnel.mode).toBe("authenticated");
    // credentials_file points inside the container at the tmpfs path the
    // entrypoint writes to — not the bind-mounted /config dir.
    expect(serverParsed.tunnel.credentials_file).toBe("/run/tunnel/tunnel.json");

    // Two keychain writes: the tunnel token, then the runtime encryption
    // secret. provision.ts always generates the encryption secret regardless
    // of tunnel mode (runtime requires ≥32 chars).
    expect(mockKeychainSet.mock.calls.length).toBe(2);
    const [tunnelKey, tunnelValue] = (mockKeychainSet.mock.calls[0] as unknown) as [string, string];
    expect(tunnelKey).toBe("tunnel:srv_abc123");
    expect(tunnelValue).toBe("eyJhIjoitest-token");
    const [encKey, encValue] = (mockKeychainSet.mock.calls[1] as unknown) as [string, string];
    expect(encKey).toBe("encryption:srv_abc123");
    expect(encValue).toMatch(/^[0-9a-f]{64}$/);

    // The token is delivered to the container over stdin (visible only via
    // the RunConfig.stdinData field — never `docker inspect` env).
    expect(mockDockerRunContainer.mock.calls.length).toBe(1);
    const [runConfig] = (mockDockerRunContainer.mock.calls[0] as unknown) as [{ stdinData?: string; restartPolicy: string; tmpfs?: string[] }];
    expect(typeof runConfig.stdinData).toBe("string");
    const stdinPayload = JSON.parse(runConfig.stdinData ?? "{}") as { tunnel_token?: string };
    expect(stdinPayload.tunnel_token).toBe("eyJhIjoitest-token");
    // Container lifecycle is owned by Electron — no auto-restart, since the
    // entrypoint can't re-read host stdin after a Docker auto-restart.
    expect(runConfig.restartPolicy).toBe("no");
    // /run/tunnel must be tmpfs so the token never hits host disk inside
    // the container's writable layer either.
    expect(runConfig.tmpfs?.some((m) => m.startsWith("/run/tunnel"))).toBe(true);
  });

  it("falls back to demo mode when tunnelMode=cloudflare but no token provided", async () => {
    const input = makeInput({
      tunnelMode: "cloudflare",
      cloudflare_tunnel_token: undefined,
    });

    await provisionModule.provisionServer(input, () => {});

    // writeFile called once — only server.json
    expect(mockWriteFile.mock.calls.length).toBe(1);
    const [_path, contents] = (mockWriteFile.mock.calls[0] as unknown) as [string, string, string];
    const parsed = JSON.parse(contents) as {
      tunnel: { provider: string; mode: string; credentials_file?: string };
    };
    expect(parsed.tunnel.mode).toBe("demo");
    expect(parsed.tunnel.credentials_file).toBeUndefined();

    // No tunnel token to stash, but the runtime encryption secret is still
    // written unconditionally — so exactly one keychain call (encryption only).
    expect(mockKeychainSet.mock.calls.length).toBe(1);
    const [encKey, encValue] = (mockKeychainSet.mock.calls[0] as unknown) as [string, string];
    expect(encKey).toBe("encryption:srv_abc123");
    expect(encValue).toMatch(/^[0-9a-f]{64}$/);
    const [runConfig] = (mockDockerRunContainer.mock.calls[0] as unknown) as [{ stdinData?: string }];
    expect(runConfig.stdinData).toBeUndefined();
  });
});

describe("provisionServer — marketplace plugin guard", () => {
  it("throws immediately with a clear error for non-core plugins", async () => {
    const input = makeInput({ selectedPlugins: ["text-channels", "my-game-plugin"] });

    await expect(provisionModule.provisionServer(input, () => {})).rejects.toThrow(
      "Marketplace plugin install is not wired for",
    );
  });

  it("rolls back Central registration and volumes (created before plugin step)", async () => {
    const input = makeInput({ selectedPlugins: ["text-channels", "my-game-plugin"] });

    await expect(provisionModule.provisionServer(input, () => {})).rejects.toThrow();

    // Central was registered before the plugin step — must be rolled back
    expect(mockCentralDeleteServer.mock.calls.length).toBe(1);
    // Volumes were prepared before the plugin step — must be cleaned up
    expect(mockRm.mock.calls.length).toBe(1);
    // Container was never started
    expect(mockDockerRemoveContainer.mock.calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// PR-TR3 — waitForPublicTunnel helper (spec-10 Amendment A step 8.5)
// ---------------------------------------------------------------------------

describe("waitForPublicTunnel — unit", () => {
  it("returns ok on the first 200 from /ready", async () => {
    const fetchCalls: string[] = [];
    const fetchFn = mock(async (input: RequestInfo | URL) => {
      fetchCalls.push(String(input));
      return new Response(JSON.stringify({ status: "ready" }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await provisionModule.waitForPublicTunnel("https://srv.example.com", {
      fetchFn,
      now: () => 1_000,
      sleep: async () => undefined,
    });

    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(1);
    expect(fetchCalls.length).toBe(1);
    // Per R1: probe must hit /ready (orchestrator endpoint), not /health.
    expect(fetchCalls[0]).toBe("https://srv.example.com/ready");
  });

  it("strips a trailing slash on tunnelUrl before joining /ready", async () => {
    const fetchCalls: string[] = [];
    const fetchFn = mock(async (input: RequestInfo | URL) => {
      fetchCalls.push(String(input));
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    await provisionModule.waitForPublicTunnel("https://srv.example.com/", {
      fetchFn,
      now: () => 0,
      sleep: async () => undefined,
    });
    expect(fetchCalls[0]).toBe("https://srv.example.com/ready");
  });

  it("sets credentials:omit + cache:no-store + GET (R5 fetch hygiene)", async () => {
    const fetchInits: RequestInit[] = [];
    const fetchFn = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init) fetchInits.push(init);
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    await provisionModule.waitForPublicTunnel("https://srv.example.com", {
      fetchFn,
      now: () => 0,
      sleep: async () => undefined,
    });
    expect(fetchInits[0]?.method).toBe("GET");
    expect(fetchInits[0]?.credentials).toBe("omit");
    expect(fetchInits[0]?.cache).toBe("no-store");
    expect(fetchInits[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("returns ok after a transient 502 → 200 sequence", async () => {
    const responses = [
      new Response("bad gateway", { status: 502 }),
      new Response("ok", { status: 200 }),
    ];
    let i = 0;
    const fetchFn = mock(async () => responses[i++]!) as unknown as typeof fetch;

    const result = await provisionModule.waitForPublicTunnel("https://srv.example.com", {
      fetchFn,
      now: () => 0,
      sleep: async () => undefined,
    });

    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
  });

  it("returns ok:false with lastStatus when /ready stays non-2xx past the budget", async () => {
    const fetchFn = mock(async () => new Response("not found", { status: 404 })) as unknown as typeof fetch;
    let calls = 0;
    // Sequence: start=0, loop check #1 = 0, elapsed = 0, deadline check post-fetch = 70_000 (past deadline → break).
    const nowSeq = [0, 0, 0, 70_000];
    const now = () => nowSeq[Math.min(calls++, nowSeq.length - 1)] ?? 70_000;

    const result = await provisionModule.waitForPublicTunnel("https://srv.example.com", {
      fetchFn,
      now,
      sleep: async () => undefined,
    });

    expect(result.ok).toBe(false);
    expect(result.lastStatus).toBe(404);
    // Soft-warning semantics: never throws.
  });

  it("returns ok:false with lastError when fetch keeps throwing", async () => {
    const fetchFn = mock(async () => {
      throw new TypeError("network down");
    }) as unknown as typeof fetch;
    let calls = 0;
    const nowSeq = [0, 0, 0, 70_000];
    const now = () => nowSeq[Math.min(calls++, nowSeq.length - 1)] ?? 70_000;

    const result = await provisionModule.waitForPublicTunnel("https://srv.example.com", {
      fetchFn,
      now,
      sleep: async () => undefined,
    });

    expect(result.ok).toBe(false);
    expect(result.lastError).toContain("network down");
    expect(result.lastStatus).toBeUndefined();
  });

  it("fires onProgress at the configured cadence while waiting", async () => {
    const fetchFn = mock(async () => new Response("bad", { status: 502 })) as unknown as typeof fetch;
    const progressCalls: number[] = [];
    // Drive a 12-second timeline: 0, 3000, 6000, 9000 — should yield 3 progress emits.
    // Sequence per loop iter: loop-check, elapsed, deadline-check = 3 now() calls per iter,
    // plus the initial start.
    const ticks = [
      0,        // start
      0,        // iter1: loop check
      0,        // iter1: elapsed
      0,        // iter1: post-fetch deadline check
      0,        // iter2: loop check (after sleep)
      3_000,    // iter2: elapsed (→ first progress emit)
      3_000,    // iter2: post-fetch deadline check
      3_000,    // iter3: loop check
      6_000,    // iter3: elapsed (→ second progress emit)
      6_000,    // iter3: post-fetch deadline check
      6_000,    // iter4: loop check
      9_000,    // iter4: elapsed (→ third progress emit)
      9_000,    // iter4: post-fetch deadline check
      70_000,   // iter5: loop check → past deadline, exits
    ];
    let idx = 0;
    const now = () => ticks[Math.min(idx++, ticks.length - 1)] ?? 70_000;

    await provisionModule.waitForPublicTunnel("https://srv.example.com", {
      fetchFn,
      now,
      sleep: async () => undefined,
      timeoutMs: 60_000,
      progressIntervalMs: 3_000,
      onProgress: (elapsed) => progressCalls.push(elapsed),
    });

    expect(progressCalls.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// PR-TR3 — provisionServer integration with the new wait-public-tunnel step
// ---------------------------------------------------------------------------

describe("provisionServer — public tunnel probe integration", () => {
  it("emits wait-public-tunnel running + completed on the success path", async () => {
    const events: { step: string; status: string; detail?: string }[] = [];
    await provisionModule.provisionServer(makeInput(), (e) =>
      events.push({ step: e.step, status: e.status, ...(e.detail ? { detail: e.detail } : {}) }),
    );

    const probeEvents = events.filter((e) => e.step === "wait-public-tunnel");
    expect(probeEvents.length).toBeGreaterThanOrEqual(2);
    expect(probeEvents[0]?.status).toBe("running");
    expect(probeEvents[probeEvents.length - 1]?.status).toBe("completed");
    // Probe must run BEFORE the done event (the wizard's handoff signal).
    const doneIdx = events.findIndex((e) => e.step === "done");
    let lastProbeIdx = -1;
    for (let i = 0; i < events.length; i++) {
      if (events[i]?.step === "wait-public-tunnel") lastProbeIdx = i;
    }
    expect(lastProbeIdx).toBeLessThan(doneIdx);
  });

  it("emits wait-public-tunnel warning but still emits done on probe budget exhaustion", async () => {
    // Drive Date.now so:
    //   waitForHealth:    calls 0..1 — passes (default fetch 200)
    //   waitForHeartbeat: calls 2..3 — passes (default mockCentralGetServer)
    //   waitForPublicTunnel: calls 4 (start), 5 (loop check < deadline), 6 (elapsed),
    //                        7 (post-fetch deadline check → 70_000 past 60_000 → break)
    const seq = [1000, 1000, 1000, 1000, 1000, 1000, 1000, 71_000];
    let i = 0;
    Date.now = () => seq[i++] ?? 71_000;

    // Probe fetch returns 404 → ok:false; health fetch (called earlier with
    // 127.0.0.1) returns 200. We can't distinguish by URL easily without
    // bookkeeping, so just have fetch always return 404 — and let waitForHealth's
    // deadline-trick skip past it. But waitForHealth does `if (res.ok)` then
    // sets `lastError = "Health returned 404"`. With Date.now seq[1]=1000 still
    // < deadline (=1000+60_000), the loop would re-attempt after sleep(1500).
    //
    // Simpler: keep the default 200 fetch for everything *except* /ready.
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/ready")) return new Response("not found", { status: 404 });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const events: { step: string; status: string }[] = [];
    const result = await provisionModule.provisionServer(makeInput(), (e) =>
      events.push({ step: e.step, status: e.status }),
    );

    // The server is preserved past step 7 — soft warning, no throw.
    expect(result.serverId).toBe("srv_abc123");
    const probeEvents = events.filter((e) => e.step === "wait-public-tunnel");
    expect(probeEvents.some((e) => e.status === "warning")).toBe(true);
    // The wizard's `done` event MUST still fire — the desktop just signals
    // soft-warn; the wizard decides what to do with it.
    const doneEvent = events.find((e) => e.step === "done");
    expect(doneEvent?.status).toBe("completed");
  });

  it("skips the probe entirely when heartbeat returned a null tunnel URL", async () => {
    // Heartbeat fires but Central never wrote a tunnel_url (demo mode with no
    // cloudflared). The probe has no URL to hit, so the step must not emit.
    // Drive Date.now past the new 120s public-URL wait on the very first
    // Phase 2 loop check so the test doesn't sit through real sleeps.
    //   call 0 — waitForHealth deadline           : base
    //   call 1 — waitForHealth loop check         : base (true → fetch 200)
    //   call 2 — waitForFirstHeartbeat Phase 1 dl : base+1
    //   call 3 — Phase 1 loop check               : base+1 (true → heartbeat present)
    //   call 4 — Phase 2 publicUrlStart           : base+2
    //   call 5 — Phase 2 loop check               : base+200_000 (>deadline → break)
    const base = 1_000_000;
    const seq = [base, base, base + 1, base + 1, base + 2, base + 200_000];
    let idx = 0;
    Date.now = () => seq[idx++] ?? base + 200_000;

    mockCentralGetServer.mockResolvedValue({
      tunnel_url: null,
      last_heartbeat_at: "2026-01-01T00:00:00Z",
    });

    const events: { step: string }[] = [];
    await provisionModule.provisionServer(makeInput(), (e) => events.push({ step: e.step }));

    expect(events.some((e) => e.step === "wait-public-tunnel")).toBe(false);
  });

  it("waits past the first heartbeat for a public URL when the runtime first reports localhost", async () => {
    // Repro of the production-polish bug fixed alongside img-retry: the
    // runtime advertises LOCAL_FALLBACK_URL (`http://localhost:3000`) in
    // `currentTunnelUrl` until cloudflared resolves, so the first heartbeat
    // can carry a loopback URL. Without the Phase 2 wait the wizard would
    // hand off with localhost, then later flip to the public URL and tear
    // down WS / sidebar / icon caches mid-session.
    //
    // Here we have central return localhost on the first poll and the public
    // URL on the second. The result MUST be the public URL.
    let pollCount = 0;
    mockCentralGetServer.mockImplementation(async () => {
      pollCount += 1;
      if (pollCount === 1) {
        // Phase 1 sees the heartbeat with the loopback URL → enters Phase 2.
        return {
          tunnel_url: "http://localhost:3000",
          last_heartbeat_at: "2026-01-01T00:00:00Z",
        };
      }
      // Phase 2 polls until cloudflared resolves.
      return {
        tunnel_url: "https://demo-server.trycloudflare.com",
        last_heartbeat_at: "2026-01-01T00:00:00Z",
      };
    });

    // Drive Date.now so Phase 2 stays under the 120s deadline on the only
    // iteration we run (Phase 2 sleeps once via setTimeout, but bun:test
    // runs sleeps in real time; one POLL_INTERVAL_MS = 1.5s is fine).
    //   call 0 — waitForHealth deadline   : base
    //   call 1 — waitForHealth loop check : base (true → fetch 200)
    //   call 2 — Phase 1 deadline         : base+1
    //   call 3 — Phase 1 loop check       : base+1 (true → heartbeat present, URL=localhost)
    //   call 4 — publicUrlStart           : base+2
    //   call 5 — Phase 2 loop check       : base+3 (well under deadline → enter body)
    //   call 6 — onPublicUrlPending       : not reached (return on isPublicTunnelUrl true)
    const base = 1_000_000;
    const seq = [base, base, base + 1, base + 1, base + 2, base + 3];
    let idx = 0;
    Date.now = () => seq[idx++] ?? base + 3;

    const result = await provisionModule.provisionServer(makeInput(), () => {});
    expect(result.tunnelUrl).toBe("https://demo-server.trycloudflare.com");
    expect(pollCount).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// isPublicTunnelUrl — accept only routable URLs so the wizard never hands
// off with a loopback URL the runtime advertised pre-cloudflared.
// ---------------------------------------------------------------------------

describe("isPublicTunnelUrl (via provisionServer URL gating)", () => {
  // Verify the gate by feeding heartbeats with each shape and asserting the
  // wait-heartbeat step status. Public URL → completed; loopback / null →
  // warning (Phase 2 budget exhaustion or null URL).
  async function runWithHeartbeatUrl(url: string | null): Promise<string | undefined> {
    mockCentralGetServer.mockResolvedValue({
      tunnel_url: url,
      last_heartbeat_at: "2026-01-01T00:00:00Z",
    });
    // Drive Date.now past Phase 2 immediately so loopback URLs short-circuit
    // to soft-warn without real sleeps.
    const base = 1_000_000;
    const seq = [base, base, base + 1, base + 1, base + 2, base + 200_000];
    let idx = 0;
    Date.now = () => seq[idx++] ?? base + 200_000;

    const events: { step: string; status: string }[] = [];
    await provisionModule.provisionServer(makeInput(), (e) =>
      events.push({ step: e.step, status: e.status }),
    );
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i]?.step === "wait-heartbeat") return events[i]?.status;
    }
    return undefined;
  }

  it("treats a public https URL as ready (status: completed)", async () => {
    expect(await runWithHeartbeatUrl("https://srv.uncorded.app")).toBe("completed");
  });

  it("rejects http://localhost:3000 (LOCAL_FALLBACK_URL)", async () => {
    expect(await runWithHeartbeatUrl("http://localhost:3000")).toBe("warning");
  });

  it("rejects 127.0.0.1 in any port", async () => {
    expect(await runWithHeartbeatUrl("http://127.0.0.1:3000")).toBe("warning");
  });

  it("rejects 0.0.0.0", async () => {
    expect(await runWithHeartbeatUrl("http://0.0.0.0:3000")).toBe("warning");
  });

  it("rejects IPv6 loopback [::1]", async () => {
    expect(await runWithHeartbeatUrl("http://[::1]:3000")).toBe("warning");
  });

  it("rejects 127.0.0.0/8 broader loopback range", async () => {
    expect(await runWithHeartbeatUrl("http://127.1.2.3:3000")).toBe("warning");
  });

  it("rejects null as 'no URL yet' (warning, not crash)", async () => {
    expect(await runWithHeartbeatUrl(null)).toBe("warning");
  });
});
