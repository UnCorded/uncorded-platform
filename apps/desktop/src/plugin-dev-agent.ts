// Agent detection + launch for the Plugin Development Workspace: find the
// `claude` CLI on PATH and open a terminal in a plugin folder running it with
// the short pointer prompt (the full prompt lives in PROMPT.md and on the
// clipboard — Windows command lines cap near 8k chars, so the prompt never
// rides the command line).
//
// Split pure/impure for tests: buildAgentLaunchCommand is a pure function of
// (platform, dir, available terminals); detection and spawning take injected
// exec/spawn functions so tests never touch the shared electron stub or a
// real shell.

import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { LaunchAgentResult } from "@uncorded/electron-bridge";
import { AGENT_POINTER_PROMPT } from "./plugin-dev-prompt";

const DETECT_TIMEOUT_MS = 5_000;

/** Same allowlist discipline as cloudflared-cli.ts — never leak the full
 *  desktop process env into child processes. */
function sanitizedEnv(): NodeJS.ProcessEnv {
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
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "XDG_RUNTIME_DIR",
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const key of allowlist) {
    const value = process.env[key];
    if (typeof value === "string" && value.length > 0) env[key] = value;
  }
  return env;
}

export type ExecFileFn = (
  file: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeout: number; windowsHide: boolean },
  callback: (error: Error | null, stdout: string | Buffer, stderr: string | Buffer) => void,
) => unknown;

export interface DetectDeps {
  platform?: NodeJS.Platform;
  execFileFn?: ExecFileFn;
}

/**
 * Resolve a command on PATH: `where.exe` on Windows (a real exe — no .cmd
 * shim problems), `which` elsewhere. Returns the first resolved path, or
 * null when absent / lookup fails / times out.
 */
export async function detectCommandPath(
  command: string,
  deps: DetectDeps = {},
): Promise<string | null> {
  const platform = deps.platform ?? process.platform;
  const execFileFn = deps.execFileFn ?? (execFile as unknown as ExecFileFn);
  const [file, args] = platform === "win32" ? ["where.exe", [command]] : ["which", [command]];
  return new Promise((resolve) => {
    try {
      execFileFn(
        file,
        args,
        { env: sanitizedEnv(), timeout: DETECT_TIMEOUT_MS, windowsHide: true },
        (error, stdout) => {
          if (error) {
            resolve(null);
            return;
          }
          const first = String(stdout)
            .split(/\r?\n/)
            .map((l) => l.trim())
            .find((l) => l.length > 0);
          resolve(first ?? null);
        },
      );
    } catch {
      resolve(null);
    }
  });
}

/**
 * Well-known install locations checked when PATH lookup fails — the desktop
 * process can inherit a PATH that predates the claude install (launched from
 * a stale shell, an OS launcher, or the auto-updater), while the CLI is
 * sitting in its standard per-user location the whole time.
 */
function wellKnownAgentPaths(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform === "win32") {
    const home = env["USERPROFILE"];
    const appData = env["APPDATA"];
    return [
      ...(home ? [`${home}\\.local\\bin\\claude.exe`] : []),
      ...(appData ? [`${appData}\\npm\\claude.cmd`] : []),
    ];
  }
  const home = env["HOME"];
  return [
    ...(home ? [`${home}/.local/bin/claude`] : []),
    "/usr/local/bin/claude",
    "/opt/homebrew/bin/claude",
  ];
}

export async function detectAgent(
  deps: DetectDeps & { existsFn?: (path: string) => boolean } = {},
): Promise<{ found: boolean; path?: string }> {
  const path = await detectCommandPath("claude", deps);
  if (path !== null) return { found: true, path };
  const platform = deps.platform ?? process.platform;
  const existsFn = deps.existsFn ?? existsSync;
  for (const candidate of wellKnownAgentPaths(platform, process.env)) {
    if (existsFn(candidate)) return { found: true, path: candidate };
  }
  return { found: false };
}

// ---------------------------------------------------------------------------
// Launch-command builder (pure)
// ---------------------------------------------------------------------------

export type LinuxTerminal = "x-terminal-emulator" | "gnome-terminal" | "konsole";

export const LINUX_TERMINAL_PROBE_ORDER: readonly LinuxTerminal[] = [
  "x-terminal-emulator",
  "gnome-terminal",
  "konsole",
];

export interface AgentLaunchCommand {
  file: string;
  args: string[];
  /**
   * Windows only: args are pre-quoted by the builder and must be passed with
   * windowsVerbatimArguments so Node does not re-quote. Three quoting layers
   * (spawn → wt/cmd → claude) make automatic quoting non-deterministic;
   * hand-quoting is safe because the only variable segment is the plugin dir
   * (Windows paths cannot contain `"`) and the pointer prompt is a fixed
   * charset-restricted constant.
   */
  windowsVerbatim: boolean;
}

export type BuildLaunchResult = AgentLaunchCommand | { unsupported: "NO_TERMINAL" };

export interface TerminalAvailability {
  /** Windows Terminal (wt.exe) found on PATH. */
  windowsTerminal: boolean;
  /** First available Linux terminal emulator, or null. */
  linuxTerminal: LinuxTerminal | null;
}

/** POSIX single-quote: safe for any content including spaces and quotes. */
function posixQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Escape for inclusion inside an AppleScript double-quoted string. */
function appleScriptQuote(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

export function buildAgentLaunchCommand(
  platform: NodeJS.Platform,
  pluginDir: string,
  terminals: TerminalAvailability,
  /** Resolved claude executable. Defaults to bare "claude" (PATH lookup in
   *  the spawned terminal), but the launcher passes the detected absolute
   *  path — the desktop process can find claude via a well-known location
   *  while its own inherited PATH (which the terminal inherits in turn)
   *  doesn't carry it. */
  agentCommand = "claude",
): BuildLaunchResult {
  const pointer = AGENT_POINTER_PROMPT;

  if (platform === "win32") {
    // What follows `cmd /k` is re-parsed by cmd with its leading-quote strip
    // rule: a tail that STARTS with a quote and contains more than one quote
    // pair loses its first and last quote characters. So: leave a space-free
    // executable unquoted (tail starts unquoted → no stripping); wrap a
    // spaced path in an OUTER quote pair that cmd strips back off, leaving a
    // correctly quoted command line.
    const cmdTail = agentCommand.includes(" ")
      ? [`""${agentCommand}" "${pointer}""`]
      : [agentCommand, `"${pointer}"`];
    if (terminals.windowsTerminal) {
      // wt -d <dir> cmd /k <claude> "<pointer>" — cmd /k keeps the window
      // open after claude exits so the user sees what happened.
      return {
        file: "wt.exe",
        args: ["-d", `"${pluginDir}"`, "cmd", "/k", ...cmdTail],
        windowsVerbatim: true,
      };
    }
    // `start` is a cmd builtin, so it must go through cmd /c. The quoted
    // title is mandatory — start treats its first quoted argument as the
    // window title, so without it a quoted /D path would be eaten as a title.
    return {
      file: "cmd.exe",
      args: [
        "/c",
        "start",
        `"UnCorded Plugin Agent"`,
        "/D",
        `"${pluginDir}"`,
        "cmd",
        "/k",
        ...cmdTail,
      ],
      windowsVerbatim: true,
    };
  }

  if (platform === "darwin") {
    const shellLine = `cd ${posixQuote(pluginDir)} && ${posixQuote(agentCommand)} ${posixQuote(pointer)}`;
    return {
      file: "osascript",
      args: [
        "-e",
        `tell application "Terminal" to do script "${appleScriptQuote(shellLine)}"`,
        "-e",
        `tell application "Terminal" to activate`,
      ],
      windowsVerbatim: false,
    };
  }

  // linux + everything else: best effort against known emulators.
  switch (terminals.linuxTerminal) {
    case "gnome-terminal":
      return {
        file: "gnome-terminal",
        args: ["--working-directory", pluginDir, "--", agentCommand, pointer],
        windowsVerbatim: false,
      };
    case "konsole":
      return {
        file: "konsole",
        args: ["--workdir", pluginDir, "-e", agentCommand, pointer],
        windowsVerbatim: false,
      };
    case "x-terminal-emulator":
      // The Debian alternative's -e contract takes a single command string;
      // route through sh so cwd and argument quoting behave uniformly.
      return {
        file: "x-terminal-emulator",
        args: ["-e", `sh -c ${posixQuote(`cd ${posixQuote(pluginDir)} && ${posixQuote(agentCommand)} ${posixQuote(pointer)}`)}`],
        windowsVerbatim: false,
      };
    case null:
      return { unsupported: "NO_TERMINAL" };
  }
}

// ---------------------------------------------------------------------------
// Spawner (thin, injected for tests)
// ---------------------------------------------------------------------------

export type SpawnFn = (
  file: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    detached: boolean;
    stdio: "ignore";
    windowsVerbatimArguments: boolean;
    windowsHide: boolean;
  },
) => { unref(): void; on(event: "error", handler: (err: Error) => void): unknown };

export interface LaunchDeps {
  platform?: NodeJS.Platform;
  execFileFn?: ExecFileFn;
  spawnFn?: SpawnFn;
  existsFn?: (path: string) => boolean;
}

/**
 * Open a terminal in `pluginDir` running the agent with the pointer prompt.
 * The caller has already validated the directory (devPluginPath) and copied
 * the full prompt to the clipboard — every failure here degrades to "the
 * prompt is on your clipboard".
 */
export async function launchAgentTerminal(
  pluginDir: string,
  deps: LaunchDeps = {},
): Promise<LaunchAgentResult> {
  const platform = deps.platform ?? process.platform;
  const detect: DetectDeps = { platform, ...(deps.execFileFn ? { execFileFn: deps.execFileFn } : {}) };

  const agent = await detectAgent({
    ...detect,
    ...(deps.existsFn ? { existsFn: deps.existsFn } : {}),
  });
  if (!agent.found) {
    return {
      ok: false,
      code: "AGENT_NOT_FOUND",
      message: "The claude CLI was not found on PATH.",
    };
  }

  const terminals: TerminalAvailability = { windowsTerminal: false, linuxTerminal: null };
  if (platform === "win32") {
    terminals.windowsTerminal = (await detectCommandPath("wt", detect)) !== null;
  } else if (platform !== "darwin") {
    for (const candidate of LINUX_TERMINAL_PROBE_ORDER) {
      if ((await detectCommandPath(candidate, detect)) !== null) {
        terminals.linuxTerminal = candidate;
        break;
      }
    }
  }

  const command = buildAgentLaunchCommand(platform, pluginDir, terminals, agent.path ?? "claude");
  if ("unsupported" in command) {
    return {
      ok: false,
      code: "NO_TERMINAL",
      message: "No supported terminal emulator was found.",
    };
  }

  const spawnFn = deps.spawnFn ?? (spawn as unknown as SpawnFn);
  try {
    const child = spawnFn(command.file, command.args, {
      cwd: pluginDir,
      env: sanitizedEnv(),
      detached: true,
      stdio: "ignore",
      windowsVerbatimArguments: command.windowsVerbatim,
      windowsHide: false,
    });
    // Detached fire-and-forget: a late spawn error (ENOENT) has nowhere to
    // land except the log; the synchronous-throw path below covers the
    // common failure on Windows.
    child.on("error", (err) => {
      console.error("[plugin-dev] agent terminal spawn error", { err });
    });
    child.unref();
    return { ok: true };
  } catch (err) {
    console.error("[plugin-dev] agent terminal spawn failed", { err });
    return {
      ok: false,
      code: "SPAWN_FAILED",
      message: "Could not open a terminal window.",
    };
  }
}
