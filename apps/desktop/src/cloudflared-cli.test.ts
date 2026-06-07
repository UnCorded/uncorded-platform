import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ChildProcess, ExecFileOptions } from "child_process";
import * as _realChildProcess from "child_process";
// Snapshot real exports by value so afterAll can restore the genuine module
// shape. `import * as` is a live binding — reading from it after the mock
// applies would just return the stubbed shape.
const realChildProcess = { ..._realChildProcess };

// Capture the real sibling modules we stub below. Bun's mock.module is
// process-global and does not reliably auto-reset between files on every
// platform (it leaks on Linux CI), so without restoring these the stripped
// mocks bleed into cloudflare.test.ts / cloudflared-bin.test.ts. Their
// internal `import { app } from "./electron-main-deps"` is a live binding, so
// the restored modules re-resolve against whatever those files mock.
import * as _realCloudflare from "./cloudflare";
import * as _realCloudflaredBin from "./cloudflared-bin";
const realCloudflare = { ..._realCloudflare };
const realCloudflaredBin = { ..._realCloudflaredBin };

const mockExecFile = mock<typeof import("child_process").execFile>();

let userDataDir = "";
let cloudflaredBinary = "";
let certPath = "";
let cloudflaredCliModule: typeof import("./cloudflared-cli");

const originalPath = process.env["PATH"];
const originalAppData = process.env["APPDATA"];
const originalTemp = process.env["TEMP"];
const originalSecretEnv = process.env["UNCORDED_SECRET_TEST"];

class MockCloudflaredBinaryNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloudflaredBinaryNotFoundError";
  }
}

function mockExecFileSuccess(stdout = "", stderr = ""): void {
  mockExecFile.mockImplementation(((...args: unknown[]) => {
    const callback = args[3] as (error: null, stdout: string, stderr: string) => void;
    callback(null, stdout, stderr);
    return {} as ChildProcess;
  }) as unknown as typeof import("child_process").execFile);
}

function mockExecFileFailure(
  error: {
    message?: string;
    code?: string | number;
    killed?: boolean;
    signal?: NodeJS.Signals | null;
  },
  stderr = "",
): void {
  mockExecFile.mockImplementation(((...args: unknown[]) => {
    const callback = args[3] as (error: NodeJS.ErrnoException, stdout: string, stderr: string) => void;
    callback(error as NodeJS.ErrnoException, "", stderr);
    return {} as ChildProcess;
  }) as unknown as typeof import("child_process").execFile);
}

beforeAll(async () => {
  // Spread real exports so siblings that need spawn/exec/fork still resolve.
  await mock.module("child_process", () => ({
    ...realChildProcess,
    execFile: mockExecFile,
  }));

  await mock.module("./electron-main-deps", () => ({
    app: {
      getPath(name: string) {
        if (name !== "userData") throw new Error(`unexpected path ${name}`);
        return userDataDir;
      },
    },
    // Stubbed to keep the module namespace shape intact — secret-store.ts
    // imports `safeStorage` and the namespace is sealed by the first mock.
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: (s: string) => Buffer.from(s, "utf8"),
      decryptString: (b: Buffer) => b.toString("utf8"),
    },
  }));

  await mock.module("./cloudflare", () => ({
    withCloudflareOrigincert: async <T>(callback: (candidate: string) => Promise<T>) => callback(certPath),
  }));

  await mock.module("./cloudflared-bin", () => ({
    CloudflaredBinaryNotFoundError: MockCloudflaredBinaryNotFoundError,
    getCloudflaredBinary: () => cloudflaredBinary,
  }));

  cloudflaredCliModule = await import("./cloudflared-cli");
});

beforeEach(() => {
  userDataDir = "C:\\Users\\jusss\\AppData\\Roaming\\UnCorded";
  cloudflaredBinary = "C:\\tools\\cloudflared.exe";
  certPath = "C:\\Users\\jusss\\AppData\\Local\\Temp\\cf-cert\\cert.pem";
  mockExecFile.mockReset();
  process.env["PATH"] = "C:\\Windows\\System32";
  process.env["APPDATA"] = "C:\\Users\\jusss\\AppData\\Roaming";
  process.env["TEMP"] = "C:\\Users\\jusss\\AppData\\Local\\Temp";
  process.env["UNCORDED_SECRET_TEST"] = "should-not-leak";
});

afterEach(() => {
  if (originalPath === undefined) delete process.env["PATH"];
  else process.env["PATH"] = originalPath;
  if (originalAppData === undefined) delete process.env["APPDATA"];
  else process.env["APPDATA"] = originalAppData;
  if (originalTemp === undefined) delete process.env["TEMP"];
  else process.env["TEMP"] = originalTemp;
  if (originalSecretEnv === undefined) delete process.env["UNCORDED_SECRET_TEST"];
  else process.env["UNCORDED_SECRET_TEST"] = originalSecretEnv;
});

afterAll(async () => {
  await mock.module("child_process", () => realChildProcess);
  await mock.module("./cloudflare", () => realCloudflare);
  await mock.module("./cloudflared-bin", () => realCloudflaredBin);
});

describe("cloudflared CLI wrapper", () => {
  it("builds management commands with --origincert and a sanitized env", async () => {
    mockExecFileSuccess('[{"id":"abc","name":"Main"}]');

    const tunnels = await cloudflaredCliModule.listTunnels();

    expect(tunnels).toEqual([{ id: "abc", name: "Main" }]);
    expect(mockExecFile).toHaveBeenCalledTimes(1);

    const [file, args, options] = mockExecFile.mock.calls[0] as unknown as [
      string,
      string[],
      ExecFileOptions,
    ];

    expect(file).toBe(cloudflaredBinary);
    expect(args).toEqual([
      "tunnel",
      "--origincert",
      certPath,
      "--no-autoupdate",
      "list",
      "--output",
      "json",
    ]);
    expect(options.cwd).toBe(userDataDir);
    expect(options.timeout).toBe(30_000);
    expect(options.env?.["PATH"]).toBe("C:\\Windows\\System32");
    expect(options.env?.["APPDATA"]).toBe("C:\\Users\\jusss\\AppData\\Roaming");
    expect(options.env?.["UNCORDED_SECRET_TEST"]).toBeUndefined();
  });

  it("trims the raw token response", async () => {
    mockExecFileSuccess("token-value\n");

    await expect(cloudflaredCliModule.getTunnelToken("abc")).resolves.toBe("token-value");
  });

  it("maps duplicate-name stderr to a typed error", async () => {
    mockExecFileFailure(
      {
        code: 1,
        message: "exit 1",
      },
      "Error: tunnel with name already exists",
    );

    await expect(cloudflaredCliModule.createTunnel("duplicate-name")).rejects.toMatchObject({
      code: "duplicate_name",
    });
  });

  it("maps killed subprocesses to CloudflaredTimeoutError", async () => {
    mockExecFileFailure(
      {
        message: "timed out",
        killed: true,
        signal: "SIGTERM",
      },
      "",
    );

    await expect(cloudflaredCliModule.listTunnels()).rejects.toBeInstanceOf(
      cloudflaredCliModule.CloudflaredTimeoutError,
    );
  });
});
