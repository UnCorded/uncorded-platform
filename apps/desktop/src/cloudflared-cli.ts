import { execFile } from "child_process";
import type { ExecFileOptions } from "child_process";
import { app } from "./electron-main-deps";
import { withCloudflareOrigincert } from "./cloudflare";
import { CloudflaredBinaryNotFoundError, getCloudflaredBinary } from "./cloudflared-bin";

const DEFAULT_TIMEOUT_MS = 30_000;
const EXEC_MAX_BUFFER = 8 * 1024 * 1024;

export type CloudflaredErrorCode =
  | "auth_expired"
  | "permission_denied"
  | "duplicate_name"
  | "invalid_hostname"
  | "not_found"
  | "binary_not_found"
  | "timeout"
  | "unknown";

export interface CloudflaredTunnelSummary {
  id: string;
  name: string;
  status?: string;
  createdAt?: string;
  created_at?: string;
  connections?: unknown[];
  [key: string]: unknown;
}

export interface CloudflaredTunnelInfo {
  id?: string;
  name?: string;
  connections?: unknown[];
  [key: string]: unknown;
}

export interface CloudflaredTunnelCreateResult {
  id: string;
  name: string;
  credentials_file?: string;
  [key: string]: unknown;
}

export class CloudflaredCliError extends Error {
  constructor(
    public readonly code: CloudflaredErrorCode,
    public readonly command: string,
    public readonly stderr: string,
    public readonly exitCode: number | null = null,
  ) {
    super(stderr.length > 0 ? stderr : `${command} failed`);
    this.name = "CloudflaredCliError";
  }
}

export class CloudflaredTimeoutError extends CloudflaredCliError {
  constructor(command: string) {
    super("timeout", command, `${command} timed out`, null);
    this.name = "CloudflaredTimeoutError";
  }
}

function sanitizeCloudflaredEnv(overrides?: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const allowlist = [
    "PATH",
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "TMP",
    "TEMP",
    "SYSTEMROOT",
    "SystemRoot",
    "COMSPEC",
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const key of allowlist) {
    const value = process.env[key];
    if (typeof value === "string" && value.length > 0) {
      env[key] = value;
    }
  }
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

function classifyCloudflaredError(stderr: string): CloudflaredErrorCode {
  const text = stderr.toLowerCase();
  if (
    /401|unauthorized|credentials file .* doesn't exist|cert.*expired|cert.*invalid|not logged in/.test(text)
  ) {
    return "auth_expired";
  }
  if (/403|forbidden|permission/.test(text)) {
    return "permission_denied";
  }
  if (/409|already exists|duplicate/.test(text)) {
    return "duplicate_name";
  }
  if (/400|invalid hostname|not in your cloudflare account|hostname/.test(text)) {
    return "invalid_hostname";
  }
  if (/not found|unknown tunnel|cannot find tunnel/.test(text)) {
    return "not_found";
  }
  return "unknown";
}

function execFileAsync(
  file: string,
  args: string[],
  options: ExecFileOptions,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout, stderr }));
        return;
      }
      resolve({
        stdout: typeof stdout === "string" ? stdout : stdout.toString("utf8"),
        stderr: typeof stderr === "string" ? stderr : stderr.toString("utf8"),
      });
    });
  });
}

async function runCloudflared(
  args: string[],
  options?: { timeoutMs?: number; envOverrides?: Record<string, string | undefined> },
): Promise<{ stdout: string; stderr: string }> {
  let binary: string;
  try {
    binary = getCloudflaredBinary();
  } catch (err) {
    if (err instanceof CloudflaredBinaryNotFoundError) {
      throw new CloudflaredCliError("binary_not_found", args.join(" "), err.message, null);
    }
    throw err;
  }

  const command = [binary, ...args].join(" ");
  try {
    return await execFileAsync(binary, args, {
      cwd: app.getPath("userData"),
      env: sanitizeCloudflaredEnv(options?.envOverrides),
      timeout: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: EXEC_MAX_BUFFER,
      encoding: "utf8",
    });
  } catch (err) {
    const error = err as NodeJS.ErrnoException & {
      code?: string;
      killed?: boolean;
      signal?: NodeJS.Signals | null;
      stderr?: string;
      stdout?: string;
    };
    if (error.code === "ENOENT") {
      throw new CloudflaredCliError("binary_not_found", command, error.message ?? "cloudflared not found", null);
    }
    if (error.killed || error.signal === "SIGTERM") {
      throw new CloudflaredTimeoutError(command);
    }
    const stderr = typeof error.stderr === "string" ? error.stderr.trim() : "";
    throw new CloudflaredCliError(
      classifyCloudflaredError(stderr),
      command,
      stderr.length > 0 ? stderr : error.message ?? `${command} failed`,
      typeof error.code === "number" ? error.code : null,
    );
  }
}

function parseJsonOutput<T>(command: string, stdout: string): T {
  try {
    return JSON.parse(stdout) as T;
  } catch {
    throw new CloudflaredCliError("unknown", command, "cloudflared returned invalid JSON", null);
  }
}

async function withManagementCert<T>(
  args: string[],
  runner?: (resolvedArgs: string[]) => Promise<T>,
): Promise<T> {
  return withCloudflareOrigincert(async (certPath) => {
    const resolvedArgs = ["tunnel", "--origincert", certPath, "--no-autoupdate", ...args];
    if (runner) return runner(resolvedArgs);
    throw new Error("cloudflared runner missing");
  });
}

export async function getCloudflaredVersion(): Promise<string> {
  const { stdout } = await runCloudflared(["version"], { timeoutMs: 10_000 });
  return stdout.trim();
}

export async function listTunnels(): Promise<CloudflaredTunnelSummary[]> {
  return withManagementCert(["list", "--output", "json"], async (args) => {
    const { stdout } = await runCloudflared(args);
    return parseJsonOutput<CloudflaredTunnelSummary[]>(args.join(" "), stdout);
  });
}

export async function getTunnelInfo(tunnel: string): Promise<CloudflaredTunnelInfo> {
  return withManagementCert(["info", tunnel, "--output", "json"], async (args) => {
    const { stdout } = await runCloudflared(args);
    return parseJsonOutput<CloudflaredTunnelInfo>(args.join(" "), stdout);
  });
}

export async function createTunnel(name: string): Promise<CloudflaredTunnelCreateResult> {
  return withManagementCert(["create", name, "--output", "json"], async (args) => {
    const { stdout } = await runCloudflared(args);
    return parseJsonOutput<CloudflaredTunnelCreateResult>(args.join(" "), stdout);
  });
}

export async function getTunnelToken(tunnel: string): Promise<string> {
  return withManagementCert(["token", tunnel], async (args) => {
    const { stdout } = await runCloudflared(args);
    return stdout.trim();
  });
}

export async function routeTunnelDns(
  tunnel: string,
  hostname: string,
  overwriteDns = false,
): Promise<string> {
  const extraArgs = overwriteDns ? ["--overwrite-dns"] : [];
  return withManagementCert(["route", "dns", ...extraArgs, tunnel, hostname], async (args) => {
    const { stdout } = await runCloudflared(args);
    return stdout.trim();
  });
}

export async function deleteTunnel(tunnel: string, force = true): Promise<string> {
  const extraArgs = force ? ["-f"] : [];
  return withManagementCert(["delete", ...extraArgs, tunnel], async (args) => {
    const { stdout } = await runCloudflared(args);
    return stdout.trim();
  });
}

