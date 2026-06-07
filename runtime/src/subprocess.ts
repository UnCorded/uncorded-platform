// Subprocess spawner + lifecycle manager — steps 4-5 of the 7-step loading sequence.
// Spawns plugin backends as subprocesses, manages IPC, handles graceful shutdown,
// and enforces restart policy with quarantine.

import type { Subprocess } from "bun";
import { StdioParentTransport } from "./ipc/transport";
import type { StdinWriter } from "./ipc/transport";
import { rootLogger } from "@uncorded/shared";

const log = rootLogger.child({ component: "subprocess" });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SpawnError {
  code: string;
  plugin: string;
  message: string;
}

export type SpawnResult =
  | { ok: true; process: PluginProcess }
  | { ok: false; error: SpawnError };

export type PluginState = "starting" | "ready" | "stopping" | "stopped" | "quarantined";

/** Context needed to re-spawn a plugin after crash. */
export interface SpawnContext {
  pluginPath: string;
  backendEntry: string;
  dataDir: string;
  apiVersion: string;
  opts?: SpawnOptions | undefined;
}

export interface PluginProcess {
  slug: string;
  pid: number;
  subprocess: Subprocess;
  transport: StdioParentTransport;
  state: PluginState;
  restarts: RestartTracker;
  spawnContext?: SpawnContext | undefined;
}

export interface PluginLogEntry {
  ts: number;
  stream: "stdout" | "stderr";
  line: string;
}

// ---------------------------------------------------------------------------
// Restart tracking
// ---------------------------------------------------------------------------

export interface RestartTracker {
  crashes: number[];
  backoffIndex: number;
}

export const BACKOFF_SCHEDULE = [1000, 2000, 5000, 15000, 60000] as const;
const QUARANTINE_WINDOW = 10 * 60 * 1000; // 10 minutes
const QUARANTINE_THRESHOLD = 5;

export function createRestartTracker(): RestartTracker {
  return { crashes: [], backoffIndex: 0 };
}

export function recordCrash(tracker: RestartTracker): void {
  tracker.crashes.push(Date.now());
}

export function shouldQuarantine(tracker: RestartTracker): boolean {
  const now = Date.now();
  const recent = tracker.crashes.filter((t) => now - t < QUARANTINE_WINDOW);
  return recent.length >= QUARANTINE_THRESHOLD;
}

/**
 * Return the delay for the current crash and advance the backoff index.
 * Read-then-increment: first crash → index 0 (1000ms), second → index 1 (2000ms), etc.
 */
export function getBackoffDelay(tracker: RestartTracker): number {
  const idx = Math.min(tracker.backoffIndex, BACKOFF_SCHEDULE.length - 1);
  if (tracker.backoffIndex < BACKOFF_SCHEDULE.length - 1) {
    tracker.backoffIndex++;
  }
  return BACKOFF_SCHEDULE[idx] ?? BACKOFF_SCHEDULE[BACKOFF_SCHEDULE.length - 1]!;
}

// ---------------------------------------------------------------------------
// Subprocess Manager
// ---------------------------------------------------------------------------

const DEFAULT_HANDSHAKE_TIMEOUT = 30_000;
const GRACEFUL_STOP_TIMEOUT = 5_000;

export interface SpawnOptions {
  handshakeTimeoutMs?: number;
  /** Called after the IPC transport is created but before the ready handshake.
   *  Use this to attach message handlers that must not miss any post-ready messages. */
  onTransportCreated?: (transport: StdioParentTransport) => void;
}

/** Callback invoked when a plugin is about to be respawned after a crash. */
export type RespawnCallback = (slug: string, result: SpawnResult) => void;

/**
 * Callback invoked when a plugin transitions out of a usable runtime state —
 * graceful stop, crash without restart, quarantine. Use this to release
 * external resources keyed on plugin slug (event-bus subscriptions, scoped
 * presence entries, etc).
 */
export type UnloadCallback = (slug: string) => void;

export class SubprocessManager {
  private processes = new Map<string, PluginProcess>();
  private shuttingDown = false;
  private respawnTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private onRespawnCallback: RespawnCallback | undefined;
  private onUnloadCallbacks: UnloadCallback[] = [];
  private logs = new Map<string, PluginLogEntry[]>();
  private readonly maxLogsPerPlugin = 500;

  constructor() {
    this.checkPid1();
  }

  /** Register a callback invoked after each automatic respawn attempt completes. */
  onRespawn(callback: RespawnCallback): void {
    this.onRespawnCallback = callback;
  }

  /**
   * Register a callback invoked whenever a plugin leaves a usable state.
   * Fires on graceful stop, on crash that schedules a respawn (cleanup happens
   * on every transition out of "ready"), and on quarantine. May fire multiple
   * times for the same slug across its lifetime — listeners must be idempotent.
   */
  onPluginUnload(callback: UnloadCallback): void {
    this.onUnloadCallbacks.push(callback);
  }

  private fireUnload(slug: string): void {
    for (const cb of this.onUnloadCallbacks) {
      try {
        cb(slug);
      } catch (err: unknown) {
        log.warn("plugin-unload callback failed", {
          plugin: slug,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /** Warn if runtime is PID 1 (no init process for orphan reaping). */
  private checkPid1(): void {
    if (process.pid === 1) {
      log.warn("runtime is PID 1 — no init process detected; use --init or tini to prevent orphaned plugin processes on crash");
    }
  }

  /**
   * Spawn a plugin backend subprocess and wait for the "ready" handshake.
   */
  async spawn(
    slug: string,
    pluginPath: string,
    backendEntry: string,
    dataDir: string,
    apiVersion: string,
    opts?: SpawnOptions,
  ): Promise<SpawnResult> {
    if (this.processes.has(slug) && this.processes.get(slug)!.state !== "stopped") {
      return {
        ok: false,
        error: {
          code: "ALREADY_RUNNING",
          plugin: slug,
          message: `${slug}: plugin is already running.`,
        },
      };
    }

    const timeoutMs = opts?.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT;

    let transport: StdioParentTransport;
    let subprocess: Subprocess;

    try {
      // Memory posture for plugin subprocesses:
      //   • --smol triggers more-frequent GC in Bun — the closest thing Bun
      //     currently exposes to Node's --max-old-space-size. It is NOT a
      //     hard cap; a runaway plugin still needs a cgroup/Job-object limit
      //     from the container layer to bound memory.
      //   • NODE_OPTIONS carries the Node cap so a runtime started under
      //     `node` (the tripwire fallback) still enforces a real ceiling.
      // Hard isolation lives in Docker (spec-10). This is defense-in-depth.
      subprocess = Bun.spawn(["bun", "--smol", "run", backendEntry], {
        cwd: pluginPath,
        stdin: "pipe",                     // IPC messages from runtime → plugin
        stdout: "pipe",                    // IPC messages + logs from plugin → runtime
        stderr: "pipe",                    // error logs
        env: {
          PATH: process.env["PATH"] ?? "",
          HOME: process.env["HOME"] ?? "",
          PLUGIN_SLUG: slug,
          PLUGIN_API_VERSION: apiVersion,
          PLUGIN_DATA_DIR: `${dataDir}/plugins/${slug}`,
          NODE_OPTIONS: "--max-old-space-size=256",
        },
        onExit: (_proc, exitCode, signalCode, _error) => {
          this.handleExit(slug, exitCode, signalCode);
        },
      });

      // Narrow types — with stdin/stdout: "pipe", these are always the right types
      const stdinWriter = typeof subprocess.stdin === "object" && subprocess.stdin !== null
        ? subprocess.stdin as StdinWriter
        : null;
      const stdoutStream = subprocess.stdout && typeof subprocess.stdout !== "number"
        ? subprocess.stdout
        : null;

      transport = new StdioParentTransport(
        stdinWriter,
        stdoutStream,
        (line) => {
          // Plugin stdout goes to the in-memory ring buffer only — that's
          // what /admin/api/plugins/{slug}/logs serves. Mirroring to the
          // runtime's own stdout would just duplicate every plugin print
          // on the runtime log file. stderr is still mirrored below
          // because plugin errors should be loud in the runtime log.
          this.appendLog(slug, "stdout", line);
        },
        (details) => {
          // IPC transport cap exceeded — the plugin is misbehaving (runaway
          // query result, infinite loop with no newline, or deliberate OOM
          // attempt). Kill the subprocess so onExit can run its normal
          // cleanup + restart policy. onTransportCreated handlers already
          // saw the transport, so in-flight client requests surface via the
          // standard subprocess-death path rather than hanging indefinitely.
          log.child({ plugin: slug }).error("ipc transport overflow — killing subprocess", {
            byteLength: details.byteLength,
            direction: details.direction,
          });
          try {
            subprocess?.kill("SIGKILL");
          } catch {
            // Process may have already exited
          }
        },
      );
    } catch (err: unknown) {
      return {
        ok: false,
        error: {
          code: "SPAWN_FAILED",
          plugin: slug,
          message: `${slug}: failed to spawn subprocess — ${errorMessage(err)}.`,
        },
      };
    }

    // Invoke callback before the ready handshake so callers can attach
    // message handlers that must not miss post-ready plugin IPC messages.
    opts?.onTransportCreated?.(transport);

    const existingTracker = this.processes.get(slug)?.restarts;
    const pluginProcess: PluginProcess = {
      slug,
      pid: subprocess.pid,
      subprocess,
      transport,
      state: "starting",
      restarts: existingTracker ?? createRestartTracker(),
      spawnContext: { pluginPath, backendEntry, dataDir, apiVersion, opts },
    };

    this.processes.set(slug, pluginProcess);

    // Collect stderr in the background (stdout is handled by transport)
    if (subprocess.stderr && typeof subprocess.stderr !== "number") {
      void this.collectStream(slug, subprocess.stderr);
    }

    // Wait for "ready" handshake
    const handshakeResult = await this.waitForReady(pluginProcess, timeoutMs);
    if (!handshakeResult.ok) {
      // Kill the subprocess if handshake failed
      try {
        subprocess.kill("SIGKILL");
      } catch {
        // Process may have already exited
      }
      pluginProcess.state = "stopped";
      transport.close();
      return handshakeResult;
    }

    pluginProcess.state = "ready";
    return { ok: true, process: pluginProcess };
  }

  /** Gracefully stop a single plugin: SIGTERM → 5s → SIGKILL. */
  async stop(slug: string): Promise<void> {
    const plugin = this.processes.get(slug);
    if (!plugin || plugin.state === "stopped" || plugin.state === "stopping") {
      return;
    }

    plugin.state = "stopping";

    try {
      plugin.subprocess.kill("SIGTERM");
    } catch {
      // Process may have already exited
      plugin.state = "stopped";
      plugin.transport.close();
      this.fireUnload(slug);
      return;
    }

    // Wait up to 5 seconds for graceful exit
    const exitedInTime = await Promise.race([
      plugin.subprocess.exited.then(() => true),
      sleep(GRACEFUL_STOP_TIMEOUT).then(() => false),
    ]);

    if (!exitedInTime) {
      try {
        plugin.subprocess.kill("SIGKILL");
        await plugin.subprocess.exited;
      } catch {
        // Already dead
      }
    }

    plugin.transport.close();
    plugin.state = "stopped";
    this.fireUnload(slug);
  }

  /** Gracefully stop all plugins. Used during runtime shutdown. */
  async stopAll(): Promise<void> {
    this.shuttingDown = true;
    // Cancel all pending respawn timers
    for (const timer of this.respawnTimers.values()) {
      clearTimeout(timer);
    }
    this.respawnTimers.clear();
    const stops = [...this.processes.keys()].map((slug) => this.stop(slug));
    await Promise.all(stops);
  }

  /** Get a tracked plugin process. */
  getProcess(slug: string): PluginProcess | undefined {
    return this.processes.get(slug);
  }

  /** Check if a plugin is quarantined. */
  isQuarantined(slug: string): boolean {
    const plugin = this.processes.get(slug);
    return plugin?.state === "quarantined" || false;
  }

  getLogs(slug: string, limit = 200): PluginLogEntry[] {
    const all = this.logs.get(slug) ?? [];
    if (limit <= 0) return [];
    return all.slice(-limit);
  }

  /** Install signal handlers for graceful runtime shutdown. */
  installSignalHandlers(): void {
    const handler = async () => {
      await this.stopAll();
      process.exit(0);
    };

    process.on("SIGTERM", handler);
    process.on("SIGINT", handler);
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private async waitForReady(
    plugin: PluginProcess,
    timeoutMs: number,
  ): Promise<SpawnResult> {
    return new Promise<SpawnResult>((resolve) => {
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve({
          ok: false,
          error: {
            code: "HANDSHAKE_TIMEOUT",
            plugin: plugin.slug,
            message: `${plugin.slug}: no "ready" message received within ${timeoutMs}ms.`,
          },
        });
      }, timeoutMs);

      // Listen for "ready" message
      plugin.transport.onMessage((message) => {
        if (settled) return;
        if (message.type === "ready") {
          settled = true;
          clearTimeout(timer);
          resolve({ ok: true, process: plugin });
        }
      });

      // Also resolve if the process exits before sending ready
      plugin.subprocess.exited.then((exitCode) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          ok: false,
          error: {
            code: "PLUGIN_CRASHED",
            plugin: plugin.slug,
            message: `${plugin.slug}: subprocess exited with code ${exitCode} before sending "ready".`,
          },
        });
      });
    });
  }

  private handleExit(slug: string, exitCode: number | null, signalCode: number | null): void {
    const plugin = this.processes.get(slug);
    if (!plugin) return;

    // Close the IPC transport so pending sends don't hit a dead pipe (EPIPE)
    plugin.transport.close();

    // If we're stopping gracefully or shutting down, don't restart
    if (plugin.state === "stopping" || plugin.state === "stopped" || this.shuttingDown) {
      return;
    }

    // Unexpected exit — record crash and check quarantine
    recordCrash(plugin.restarts);

    if (shouldQuarantine(plugin.restarts)) {
      plugin.state = "quarantined";
      log.child({ plugin: slug }).error("plugin quarantined", {
        crashCount: QUARANTINE_THRESHOLD,
        windowMs: QUARANTINE_WINDOW,
        exitCode,
        signalCode,
      });
      this.fireUnload(slug);
      return;
    }

    // Schedule restart with backoff
    const delay = getBackoffDelay(plugin.restarts);
    log.child({ plugin: slug }).warn("plugin exited unexpectedly", {
      exitCode,
      signalCode,
      restartIn: delay,
    });

    plugin.state = "stopped";
    // Fire unload before scheduling respawn — the dead subprocess's
    // event-bus subscriptions and scoped-presence entries belong to a
    // session that no longer exists. The respawned subprocess starts fresh.
    this.fireUnload(slug);

    if (!plugin.spawnContext) {
      log.child({ plugin: slug }).error("no spawn context — cannot respawn");
      return;
    }

    const ctx = plugin.spawnContext;
    const timer = setTimeout(() => {
      this.respawnTimers.delete(slug);
      void this.respawn(slug, ctx);
    }, delay);
    this.respawnTimers.set(slug, timer);
  }

  private async respawn(slug: string, ctx: SpawnContext): Promise<void> {
    if (this.shuttingDown) return;

    const result = await this.spawn(
      slug,
      ctx.pluginPath,
      ctx.backendEntry,
      ctx.dataDir,
      ctx.apiVersion,
      ctx.opts,
    );

    if (!result.ok) {
      log.child({ plugin: slug }).error("respawn failed", { err: result.error.message });
    } else {
      log.child({ plugin: slug }).info("respawned successfully", { pid: result.process.pid });
    }

    this.onRespawnCallback?.(slug, result);
  }

  private appendLog(slug: string, stream: "stdout" | "stderr", line: string): void {
    const entries = this.logs.get(slug) ?? [];
    entries.push({ ts: Date.now(), stream, line });
    if (entries.length > this.maxLogsPerPlugin) {
      entries.splice(0, entries.length - this.maxLogsPerPlugin);
    }
    this.logs.set(slug, entries);
  }

  private async collectStream(
    slug: string,
    stream: ReadableStream<Uint8Array>,
  ): Promise<void> {
    try {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (line.length > 0) {
            this.appendLog(slug, "stderr", line);
            log.child({ plugin: slug }).warn("plugin stderr", { line });
          }
        }
      }

      if (buffer.length > 0) {
        this.appendLog(slug, "stderr", buffer);
        log.child({ plugin: slug }).warn("plugin stderr", { line: buffer });
      }
    } catch {
      // Stream closed — expected on subprocess exit
    }
  }

}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err && typeof err.message === "string") {
    return err.message;
  }
  return "Unknown error";
}
