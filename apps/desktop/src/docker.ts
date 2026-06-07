import { execFile, spawn } from "child_process";
import { existsSync } from "node:fs";
import { pullImageViaApi } from "./docker-pull-api.js";

export interface DockerStatus {
  installed: boolean;
  running: boolean;
}

/**
 * Default budget for `waitForDockerRunning`. Docker Desktop on a cold Windows
 * boot routinely needs 30-90 seconds before its WSL2 backend answers
 * `docker info`; 120s gives us headroom on slower laptops without making the
 * UI spin forever when the launch silently fails.
 */
const DOCKER_BOOT_TIMEOUT_MS = 120_000;
const DOCKER_BOOT_POLL_INTERVAL_MS = 2_000;

export interface Container {
  id: string;
  name: string;    // container name (e.g. "uncorded-my-server")
  image: string;   // image name (e.g. "uncorded/server:latest")
  status: string;  // "running" | "exited" | "paused" etc.
  created: number; // unix timestamp
}

export interface RunConfig {
  image: string;
  name: string;
  volumes: { host: string; container: string; readOnly?: boolean }[];
  env: Record<string, string>;
  // host/container accept a port number or a "low-high" range string so callers
  // can publish a contiguous UDP range (LiveKit RTC media) without listing each
  // port. protocol defaults to TCP — only set "udp" for media paths that aren't
  // also TCP-routable.
  ports: { host: number | string; container: number | string; protocol?: "tcp" | "udp" }[];
  // Docker network mode. "host" shares the host's network namespace — required
  // for the LiveKit SFU so it can advertise both LAN and STUN-discovered
  // external IP as ICE candidates. When "host", `ports` is ignored — host-mode
  // containers bind directly to host ports and `--publish` is rejected by the
  // daemon.
  network?: string;
  restartPolicy: "unless-stopped" | "no";
  capDropAll?: boolean;
  capAdd?: string[];
  securityOpts?: string[];
  readOnly?: boolean;
  init?: boolean;
  tmpfs?: string[];
  /**
   * Per-container kernel sysctl values rendered as `--sysctl K=V` flags. Docker
   * Desktop on Windows/WSL2 honors namespaced sysctls (net.*) at container
   * scope. Used for tuning UDP receive buffers so LiveKit's SFU doesn't drop
   * packets under bursty simulcast load.
   */
  sysctls?: Record<string, string>;
  /**
   * Optional payload piped to the container's stdin once at startup. Used to
   * deliver secrets (e.g. the cloudflare tunnel token) to a stdin-reading
   * entrypoint wrapper without exposing them in `docker inspect` env or
   * persisting them to host disk. A trailing newline is appended automatically.
   * Requires `-i` on the docker run command line.
   */
  stdinData?: string;
}

export class DockerError extends Error {
  constructor(
    public readonly command: string,
    public readonly stderr: string,
    message: string,
  ) {
    super(message);
    this.name = "DockerError";
  }
}

function execFileAsync(file: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout, stderr }));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function isDockerMissingError(error: NodeJS.ErrnoException & { stderr?: string }): boolean {
  return (
    error.code === "ENOENT" ||
    error.code === "ENOTFOUND" ||
    /not found/i.test(error.message ?? "")
  );
}

export async function getDockerStatus(): Promise<DockerStatus> {
  try {
    await execFileAsync("docker", ["info"]);
    return { installed: true, running: true };
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException & { code?: string; stderr?: string };
    if (isDockerMissingError(error)) {
      return { installed: false, running: false };
    }
    return { installed: true, running: false };
  }
}

/**
 * Locate a Docker Desktop install on disk so the wizard can offer a
 * one-click "Start Docker Desktop" recovery when `getDockerStatus()` reports
 * `running: false`. Returns the launch path (Windows .exe / macOS .app)
 * or `null` if no install is present.
 *
 * Linux deliberately returns `null` — `dockerd` is a system service launched
 * by systemd / init, not a user-launchable bundle, so the wizard falls
 * through to the existing "start Docker yourself" copy.
 */
export function findDockerDesktop(): string | null {
  if (process.platform === "win32") {
    // Default install path is under Program Files; non-admin installs land
    // under %LocalAppData%\Programs. Check both before giving up.
    const programFiles = process.env.PROGRAMFILES ?? "C:\\Program Files";
    const localAppData = process.env.LOCALAPPDATA ?? "";
    const candidates = [
      `${programFiles}\\Docker\\Docker\\Docker Desktop.exe`,
      ...(localAppData ? [`${localAppData}\\Programs\\Docker\\Docker\\Docker Desktop.exe`] : []),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
    return null;
  }
  if (process.platform === "darwin") {
    const bundle = "/Applications/Docker.app";
    return existsSync(bundle) ? bundle : null;
  }
  return null;
}

/**
 * Launch Docker Desktop and return immediately. The child is detached and
 * unref'd so Electron quitting doesn't take Docker Desktop down with it —
 * users who close the app while Docker is still booting still get a working
 * daemon. Returns the launch error (e.g. ENOENT) synchronously when spawn
 * fails; otherwise resolves once the spawn has been requested.
 *
 * Caller should follow with `waitForDockerRunning` to poll for readiness.
 */
export function startDockerDesktop(execPath: string): void {
  if (process.platform === "win32") {
    const child = spawn(execPath, [], { detached: true, stdio: "ignore" });
    child.unref();
    return;
  }
  if (process.platform === "darwin") {
    // `open -a Docker` is the canonical way to launch the app bundle without
    // needing to know its internal Contents/MacOS/Docker layout. execPath is
    // surfaced to the renderer for display only — the spawn uses `open`.
    const child = spawn("open", ["-a", execPath], { detached: true, stdio: "ignore" });
    child.unref();
    return;
  }
  throw new Error(`startDockerDesktop is not supported on ${process.platform}`);
}

/**
 * Poll `getDockerStatus()` until the daemon answers `docker info`, or until
 * the timeout elapses. Returns `true` on success, `false` on timeout. The
 * 2s poll interval matches Docker Desktop's own startup cadence — going
 * faster spams `docker info` calls that all queue against the still-
 * initializing daemon.
 */
export async function waitForDockerRunning(opts: { timeoutMs?: number } = {}): Promise<boolean> {
  const deadline = Date.now() + (opts.timeoutMs ?? DOCKER_BOOT_TIMEOUT_MS);
  while (Date.now() < deadline) {
    const status = await getDockerStatus();
    if (status.running) return true;
    await new Promise((resolve) => setTimeout(resolve, DOCKER_BOOT_POLL_INTERVAL_MS));
  }
  return false;
}

// Each line of `docker ps -a --format {{json .}}` is a JSON object.
interface DockerPsRow {
  ID: string;
  Names: string;
  Image: string;
  Status: string;
  CreatedAt: string;
}

export async function listContainers(nameFilter?: string): Promise<Container[]> {
  const filter = nameFilter?.trim().toLowerCase() ?? "";
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("docker", [
      "ps",
      "-a",
      "--format",
      "{{json .}}",
    ]));
  } catch (err: unknown) {
    const error = err as { stderr?: string };
    throw new DockerError("docker ps", error.stderr ?? "", "Failed to list containers");
  }

  const containers: Container[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const row = JSON.parse(trimmed) as DockerPsRow;
    // Names from docker ps may be prefixed with "/" in some versions
    const name = row.Names.replace(/^\//, "");
    const image = row.Image.replace(/^\//, "");
    const matchesDefaultScope = name.startsWith("uncorded-") || image.startsWith("uncorded/");
    const matchesFilter =
      filter === ""
        ? matchesDefaultScope
        : name.toLowerCase().includes(filter) || image.toLowerCase().includes(filter);
    if (!matchesFilter) continue;
    containers.push({
      id: row.ID,
      name,
      image: row.Image,
      status: row.Status,
      created: Math.floor(new Date(row.CreatedAt).getTime() / 1000),
    });
  }
  return containers;
}

export async function startContainer(id: string): Promise<void> {
  try {
    await execFileAsync("docker", ["start", id]);
  } catch (err: unknown) {
    const error = err as { stderr?: string };
    throw new DockerError("docker start", error.stderr ?? "", `Failed to start container ${id}`);
  }
}

export async function stopContainer(
  id: string,
  options?: { graceSeconds?: number },
): Promise<void> {
  // `docker stop --time N` waits N seconds after SIGTERM before SIGKILL —
  // the budget for the runtime's drain (per spec-runtime-lifecycle.md §5.1).
  // Default Docker behavior is 10s, which is too short for a 30s WS drain.
  const args = ["stop"];
  if (options?.graceSeconds !== undefined) {
    args.push("--time", String(options.graceSeconds));
  }
  args.push(id);
  try {
    await execFileAsync("docker", args);
  } catch (err: unknown) {
    const error = err as { stderr?: string };
    throw new DockerError("docker stop", error.stderr ?? "", `Failed to stop container ${id}`);
  }
}

/**
 * Re-tag an existing image. `docker tag <source> <target>` is the atomic
 * primitive behind the orchestrator's `:latest` ↔ `:previous` promote /
 * rollback dance (spec-runtime-lifecycle.md §8.1, §9.1). source must already
 * exist locally — pull first, tag second.
 */
export async function tagImage(source: string, target: string): Promise<void> {
  try {
    await execFileAsync("docker", ["tag", source, target]);
  } catch (err: unknown) {
    const error = err as { stderr?: string };
    throw new DockerError(
      "docker tag",
      error.stderr ?? "",
      `Failed to tag ${source} as ${target}`,
    );
  }
}

export async function removeContainer(id: string): Promise<void> {
  try {
    await execFileAsync("docker", ["rm", "-f", id]);
  } catch (err: unknown) {
    const error = err as { stderr?: string };
    throw new DockerError("docker rm", error.stderr ?? "", `Failed to remove container ${id}`);
  }
}

export function streamLogs(
  containerId: string,
  onLine: (line: string) => void,
  onEnd: () => void,
): () => void {
  const child = spawn("docker", ["logs", "-f", containerId]);
  const stdoutBuffer = createLineBuffer(onLine);
  const stderrBuffer = createLineBuffer(onLine);
  let finished = false;

  function finish(): void {
    if (finished) return;
    finished = true;
    stdoutBuffer.flush();
    stderrBuffer.flush();
    onEnd();
  }

  child.stdout?.on("data", (chunk: Buffer) => {
    stdoutBuffer.push(chunk.toString("utf8"));
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrBuffer.push(chunk.toString("utf8"));
  });
  child.once("close", finish);
  child.once("error", finish);

  return () => {
    finish();
    child.kill();
  };
}

export async function imageExists(image: string): Promise<boolean> {
  try {
    await execFileAsync("docker", ["image", "inspect", image]);
    return true;
  } catch {
    return false;
  }
}

export function pullImage(
  image: string,
  onProgress: (line: string) => void,
  onDone: () => void,
  onError: (msg: string) => void,
): void {
  // Delegate to the daemon HTTP API. Shelling out to `docker pull` only emits
  // structured per-byte progress when stdout is a TTY; under Node spawn it
  // collapses to summary mode and the runtime-update UI wedges at 0%.
  pullImageViaApi(image, onProgress, onDone, onError);
}

export async function runContainer(config: RunConfig): Promise<string> {
  const commonArgs = buildRunArgs(config);

  // Two paths:
  //   - No stdin payload: classic `docker run -d` — daemonize, get the id back
  //     on stdout, done.
  //   - Stdin payload: `docker run -d -i` does NOT reliably forward piped
  //     stdin to the container because the CLI detaches before flushing the
  //     stdin pipe (empirically verified). Instead use docker create + docker
  //     start -ai: create prints the id synchronously, start -ai keeps stdin
  //     attached for the entrypoint wrapper. We unref() the start child so
  //     Electron can return from provisioning without waiting on the
  //     container's lifetime.
  if (config.stdinData === undefined) {
    try {
      const { stdout } = await execFileAsync("docker", ["run", "-d", ...commonArgs]);
      return stdout.trim();
    } catch (err: unknown) {
      const error = err as { stderr?: string };
      throw new DockerError("docker run", error.stderr ?? "", `Failed to run container from image ${config.image}`);
    }
  }

  let containerId: string;
  try {
    const { stdout } = await execFileAsync("docker", ["create", ...commonArgs]);
    containerId = stdout.trim();
  } catch (err: unknown) {
    const error = err as { stderr?: string };
    throw new DockerError("docker create", error.stderr ?? "", `Failed to create container from image ${config.image}`);
  }

  try {
    await startWithStdin(containerId, config.stdinData);
  } catch (err: unknown) {
    const error = err as { stderr?: string };
    throw new DockerError("docker start -ai", error.stderr ?? "", `Failed to start container ${containerId}`);
  }

  return containerId;
}

function buildRunArgs(config: RunConfig): string[] {
  const args: string[] = ["--name", config.name];

  // Keep stdin attached — the entrypoint wrapper reads one line of token
  // data before execing the real runtime. Required for `docker start -ai`
  // to forward the piped payload.
  if (config.stdinData !== undefined) {
    args.push("-i");
  }

  if (config.network) {
    args.push("--network", config.network);
  }

  for (const vol of config.volumes) {
    const spec = vol.readOnly ? `${vol.host}:${vol.container}:ro` : `${vol.host}:${vol.container}`;
    args.push("--volume", spec);
  }

  for (const [key, value] of Object.entries(config.env)) {
    args.push("--env", `${key}=${value}`);
  }

  // Host-mode containers bind directly to host ports; `--publish` is rejected
  // by the daemon under `--network host`. Skip the publish loop in that case.
  if (config.network !== "host") {
    for (const port of config.ports) {
      const spec = `${String(port.host)}:${String(port.container)}`;
      args.push("--publish", port.protocol ? `${spec}/${port.protocol}` : spec);
    }
  }

  if (config.capDropAll) {
    args.push("--cap-drop", "ALL");
  }

  for (const cap of config.capAdd ?? []) {
    args.push("--cap-add", cap);
  }

  for (const securityOpt of config.securityOpts ?? []) {
    args.push("--security-opt", securityOpt);
  }

  if (config.readOnly) {
    args.push("--read-only");
  }

  if (config.init) {
    args.push("--init");
  }

  for (const mount of config.tmpfs ?? []) {
    args.push("--tmpfs", mount);
  }

  for (const [key, value] of Object.entries(config.sysctls ?? {})) {
    args.push("--sysctl", `${key}=${value}`);
  }

  args.push("--restart", config.restartPolicy);
  args.push(config.image);

  return args;
}

function startWithStdin(containerId: string, data: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // `-a` attaches stdout/stderr so the start succeeds with the proper
    // stream wiring; `-i` keeps stdin open for the entrypoint read. We
    // detach the child and unref so the Promise can resolve as soon as the
    // token is delivered — the container runs for its full lifetime
    // independently.
    const child = spawn("docker", ["start", "-ai", containerId], {
      stdio: ["pipe", "ignore", "pipe"],
      detached: true,
    });

    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    // If the docker process itself fails to start (docker missing, etc.)
    // reject synchronously. Once stdin is written + closed, we unref and
    // resolve — the container's own exit is not our concern here.
    child.once("error", (err) => {
      reject(Object.assign(err, { stderr }));
    });

    child.stdin.once("error", (err) => {
      reject(Object.assign(err, { stderr }));
    });

    child.stdin.write(`${data}\n`, (err) => {
      if (err) {
        reject(Object.assign(err, { stderr }));
        return;
      }
      child.stdin.end(() => {
        child.unref();
        resolve();
      });
    });
  });
}

function createLineBuffer(onLine: (line: string) => void): {
  push: (chunk: string) => void;
  flush: () => void;
} {
  let buffer = "";

  function emit(line: string): void {
    const normalized = line.replace(/\r$/, "");
    if (normalized.length > 0) {
      onLine(normalized);
    }
  }

  return {
    push(chunk: string) {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        emit(buffer.slice(0, newlineIndex));
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");
      }
    },
    flush() {
      const tail = buffer.trimEnd();
      buffer = "";
      if (tail.length > 0) {
        emit(tail);
      }
    },
  };
}
