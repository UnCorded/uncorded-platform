import { describe, expect, test } from "bun:test";

import {
  buildAgentLaunchCommand,
  buildClaudeCliDeepLink,
  detectAgent,
  detectClaudeCliProtocol,
  detectCommandPath,
  launchAgentTerminal,
  type ExecFileFn,
  type SpawnFn,
} from "./plugin-dev-agent";
import { AGENT_POINTER_PROMPT } from "./plugin-dev-prompt";

const WIN_DIR = "C:\\Users\\some one\\.uncorded\\plugin-dev\\trip-planner";
const POSIX_DIR = "/home/some one/.uncorded/plugin-dev/trip-planner";

function fakeExec(found: Record<string, string>): ExecFileFn {
  return (file, args, _options, callback) => {
    const command = args[0] ?? "";
    const path = found[command];
    if (path !== undefined) callback(null, `${path}\r\n`, "");
    else callback(new Error("not found"), "", "");
    return {};
  };
}

describe("buildAgentLaunchCommand", () => {
  test("win32 with Windows Terminal", () => {
    const cmd = buildAgentLaunchCommand("win32", WIN_DIR, {
      windowsTerminal: true,
      linuxTerminal: null,
    });
    expect(cmd).toEqual({
      file: "wt.exe",
      args: ["-d", `"${WIN_DIR}"`, "cmd", "/k", "claude", `"${AGENT_POINTER_PROMPT}"`],
      windowsVerbatim: true,
    });
  });

  test("win32 uses the resolved executable; space-free path stays unquoted (cmd strip rule)", () => {
    const cmd = buildAgentLaunchCommand(
      "win32",
      WIN_DIR,
      { windowsTerminal: true, linuxTerminal: null },
      "C:\\Users\\x\\.local\\bin\\claude.exe",
    );
    if ("unsupported" in cmd) throw new Error("expected a command");
    // Tail must NOT start with a quote — cmd would strip first+last quotes.
    expect(cmd.args.slice(-2)).toEqual([
      "C:\\Users\\x\\.local\\bin\\claude.exe",
      `"${AGENT_POINTER_PROMPT}"`,
    ]);
  });

  test("win32 wraps a spaced executable path in an outer strip-pair", () => {
    const cmd = buildAgentLaunchCommand(
      "win32",
      WIN_DIR,
      { windowsTerminal: false, linuxTerminal: null },
      "C:\\Users\\some one\\.local\\bin\\claude.exe",
    );
    if ("unsupported" in cmd) throw new Error("expected a command");
    expect(cmd.args.at(-1)).toBe(
      `""C:\\Users\\some one\\.local\\bin\\claude.exe" "${AGENT_POINTER_PROMPT}""`,
    );
  });

  test("win32 fallback uses cmd start with a quoted title guarding /D", () => {
    const cmd = buildAgentLaunchCommand("win32", WIN_DIR, {
      windowsTerminal: false,
      linuxTerminal: null,
    });
    if ("unsupported" in cmd) throw new Error("expected a command");
    expect(cmd.file).toBe("cmd.exe");
    expect(cmd.windowsVerbatim).toBe(true);
    // Title MUST precede /D — start treats its first quoted arg as a title.
    const titleIdx = cmd.args.indexOf(`"UnCorded Plugin Agent"`);
    const dirFlagIdx = cmd.args.indexOf("/D");
    expect(titleIdx).toBeGreaterThan(-1);
    expect(dirFlagIdx).toBeGreaterThan(titleIdx);
    expect(cmd.args[dirFlagIdx + 1]).toBe(`"${WIN_DIR}"`);
    expect(cmd.args.slice(-2)).toEqual(["claude", `"${AGENT_POINTER_PROMPT}"`]);
  });

  test("posix builders carry the resolved executable", () => {
    const mac = buildAgentLaunchCommand(
      "darwin",
      POSIX_DIR,
      { windowsTerminal: false, linuxTerminal: null },
      "/usr/local/bin/claude",
    );
    if ("unsupported" in mac) throw new Error("expected a command");
    expect(mac.args[1]).toContain("'/usr/local/bin/claude'");

    const gnome = buildAgentLaunchCommand(
      "linux",
      POSIX_DIR,
      { windowsTerminal: false, linuxTerminal: "gnome-terminal" },
      "/usr/local/bin/claude",
    );
    if ("unsupported" in gnome) throw new Error("expected a command");
    expect(gnome.args).toContain("/usr/local/bin/claude");
  });

  test("darwin builds osascript Terminal commands with quoted path", () => {
    const cmd = buildAgentLaunchCommand("darwin", POSIX_DIR, {
      windowsTerminal: false,
      linuxTerminal: null,
    });
    if ("unsupported" in cmd) throw new Error("expected a command");
    expect(cmd.file).toBe("osascript");
    expect(cmd.windowsVerbatim).toBe(false);
    expect(cmd.args[0]).toBe("-e");
    expect(cmd.args[1]).toContain("do script");
    expect(cmd.args[1]).toContain("claude");
    // Path with spaces is single-quoted inside the shell line.
    expect(cmd.args[1]).toContain(`cd '${POSIX_DIR}'`);
    expect(cmd.args[3]).toContain("activate");
  });

  test("darwin survives single quotes in the path", () => {
    const dir = "/Users/o'brien/.uncorded/plugin-dev/x-y";
    const cmd = buildAgentLaunchCommand("darwin", dir, {
      windowsTerminal: false,
      linuxTerminal: null,
    });
    if ("unsupported" in cmd) throw new Error("expected a command");
    // posixQuote emits '\'' ; appleScriptQuote doubles the backslash, so the
    // osascript arg carries a literal backslash-backslash sequence.
    expect(cmd.args[1]).toContain(`o'\\\\''brien`);
  });

  test("linux picks the probed terminal", () => {
    const gnome = buildAgentLaunchCommand("linux", POSIX_DIR, {
      windowsTerminal: false,
      linuxTerminal: "gnome-terminal",
    });
    expect(gnome).toMatchObject({
      file: "gnome-terminal",
      args: ["--working-directory", POSIX_DIR, "--", "claude", AGENT_POINTER_PROMPT],
    });

    const konsole = buildAgentLaunchCommand("linux", POSIX_DIR, {
      windowsTerminal: false,
      linuxTerminal: "konsole",
    });
    expect(konsole).toMatchObject({
      file: "konsole",
      args: ["--workdir", POSIX_DIR, "-e", "claude", AGENT_POINTER_PROMPT],
    });
  });

  test("linux with no terminal is unsupported", () => {
    expect(
      buildAgentLaunchCommand("linux", POSIX_DIR, { windowsTerminal: false, linuxTerminal: null }),
    ).toEqual({ unsupported: "NO_TERMINAL" });
  });
});

describe("detectCommandPath / detectAgent", () => {
  test("returns the first resolved line on win32", async () => {
    const path = await detectCommandPath("claude", {
      platform: "win32",
      execFileFn: fakeExec({ claude: "C:\\Users\\x\\AppData\\Roaming\\npm\\claude.cmd" }),
    });
    expect(path).toBe("C:\\Users\\x\\AppData\\Roaming\\npm\\claude.cmd");
  });

  test("not found resolves null / found:false", async () => {
    expect(
      await detectCommandPath("claude", { platform: "linux", execFileFn: fakeExec({}) }),
    ).toBeNull();
    expect(
      await detectAgent({ platform: "win32", execFileFn: fakeExec({}), existsFn: () => false }),
    ).toEqual({ found: false });
  });

  test("falls back to well-known install locations when PATH lookup fails", async () => {
    // The desktop process can inherit a PATH that predates the claude
    // install; the standard per-user location must still be found. env is
    // injected — USERPROFILE/APPDATA don't exist on non-Windows CI runners.
    const checked: string[] = [];
    const result = await detectAgent({
      platform: "win32",
      execFileFn: fakeExec({}),
      env: { USERPROFILE: "C:\\Users\\x", APPDATA: "C:\\Users\\x\\AppData\\Roaming" },
      existsFn: (p) => {
        checked.push(p);
        return p.endsWith("\\.local\\bin\\claude.exe");
      },
    });
    expect(result.found).toBe(true);
    expect(result.path).toBe("C:\\Users\\x\\.local\\bin\\claude.exe");
    expect(checked.length).toBeGreaterThan(0);
  });

  test("detectAgent carries the resolved path", async () => {
    expect(
      await detectAgent({ platform: "linux", execFileFn: fakeExec({ claude: "/usr/bin/claude" }) }),
    ).toEqual({ found: true, path: "/usr/bin/claude" });
  });
});

describe("claude-cli deep link", () => {
  test("URL encodes the directory and prompt", () => {
    const url = buildClaudeCliDeepLink(WIN_DIR, "Do the thing & more");
    expect(url.startsWith("claude-cli://open?cwd=")).toBe(true);
    expect(url).toContain(encodeURIComponent(WIN_DIR));
    expect(url).toContain(`q=${encodeURIComponent("Do the thing & more")}`);
    expect(url).not.toContain(" ");
  });

  test("protocol detection: registry hit on win32, always false elsewhere", async () => {
    const hit: ExecFileFn = (_f, _a, _o, cb) => {
      cb(null, "(Default) REG_SZ URL:claude-cli", "");
      return {};
    };
    const miss: ExecFileFn = (_f, _a, _o, cb) => {
      cb(new Error("not found"), "", "");
      return {};
    };
    expect(await detectClaudeCliProtocol({ platform: "win32", execFileFn: hit })).toBe(true);
    expect(await detectClaudeCliProtocol({ platform: "win32", execFileFn: miss })).toBe(false);
    expect(await detectClaudeCliProtocol({ platform: "darwin", execFileFn: hit })).toBe(false);
  });
});

describe("launchAgentTerminal", () => {
  function fakeSpawn(record: { calls: Array<{ file: string; args: string[]; options: unknown }> }): SpawnFn {
    return (file, args, options) => {
      record.calls.push({ file, args, options });
      return { unref() {}, on() { return undefined; } };
    };
  }

  test("AGENT_NOT_FOUND when claude is missing", async () => {
    const result = await launchAgentTerminal(WIN_DIR, {
      platform: "win32",
      execFileFn: fakeExec({}),
      spawnFn: fakeSpawn({ calls: [] }),
      // Without this the test would find the REAL claude install on the dev
      // machine through the well-known-path fallback.
      existsFn: () => false,
    });
    expect(result).toMatchObject({ ok: false, code: "AGENT_NOT_FOUND" });
  });

  test("win32 prefers wt when present and spawns detached verbatim", async () => {
    const record = { calls: [] as Array<{ file: string; args: string[]; options: unknown }> };
    const result = await launchAgentTerminal(WIN_DIR, {
      platform: "win32",
      execFileFn: fakeExec({ claude: "C:\\x\\claude.cmd", wt: "C:\\x\\wt.exe" }),
      spawnFn: fakeSpawn(record),
    });
    expect(result).toEqual({ ok: true });
    expect(record.calls).toHaveLength(1);
    expect(record.calls[0]!.file).toBe("wt.exe");
    expect(record.calls[0]!.options).toMatchObject({
      detached: true,
      stdio: "ignore",
      windowsVerbatimArguments: true,
      cwd: WIN_DIR,
    });
  });

  test("win32 without wt falls back to cmd start", async () => {
    const record = { calls: [] as Array<{ file: string; args: string[]; options: unknown }> };
    const result = await launchAgentTerminal(WIN_DIR, {
      platform: "win32",
      execFileFn: fakeExec({ claude: "C:\\x\\claude.cmd" }),
      spawnFn: fakeSpawn(record),
    });
    expect(result).toEqual({ ok: true });
    expect(record.calls[0]!.file).toBe("cmd.exe");
  });

  test("linux with no terminal reports NO_TERMINAL", async () => {
    const result = await launchAgentTerminal(POSIX_DIR, {
      platform: "linux",
      execFileFn: fakeExec({ claude: "/usr/bin/claude" }),
      spawnFn: fakeSpawn({ calls: [] }),
    });
    expect(result).toMatchObject({ ok: false, code: "NO_TERMINAL" });
  });

  /** fakeExec, plus reg.exe answering "claude-cli protocol registered". */
  function withProtocol(inner: ExecFileFn): ExecFileFn {
    return (file, args, options, cb) => {
      if (file === "reg.exe") {
        cb(null, "(Default) REG_SZ URL:claude-cli", "");
        return {};
      }
      return inner(file, args, options, cb);
    };
  }

  test("prefers the claude-cli deep link when the protocol is registered", async () => {
    const record = { calls: [] as Array<{ file: string; args: string[]; options: unknown }> };
    const opened: string[] = [];
    const result = await launchAgentTerminal(WIN_DIR, {
      platform: "win32",
      execFileFn: withProtocol(fakeExec({ claude: "C:\\x\\claude.cmd", wt: "C:\\x\\wt.exe" })),
      spawnFn: fakeSpawn(record),
      openExternalFn: async (url) => {
        opened.push(url);
      },
      deepLinkPrompt: "Full prompt with the user idea",
    });
    expect(result).toEqual({ ok: true });
    expect(record.calls).toHaveLength(0); // no terminal spawned
    expect(opened).toHaveLength(1);
    expect(opened[0]!).toContain("claude-cli://open?cwd=");
    expect(opened[0]!).toContain(encodeURIComponent("Full prompt with the user idea"));
  });

  test("oversized deep-link prompt falls back to the pointer prompt", async () => {
    const opened: string[] = [];
    await launchAgentTerminal(WIN_DIR, {
      platform: "win32",
      execFileFn: withProtocol(fakeExec({ claude: "C:\\x\\claude.cmd" })),
      spawnFn: fakeSpawn({ calls: [] }),
      openExternalFn: async (url) => {
        opened.push(url);
      },
      deepLinkPrompt: "x".repeat(10_000),
    });
    expect(opened[0]!).toContain(encodeURIComponent(AGENT_POINTER_PROMPT));
  });

  test("deep-link failure falls back to the terminal spawn", async () => {
    const record = { calls: [] as Array<{ file: string; args: string[]; options: unknown }> };
    const result = await launchAgentTerminal(WIN_DIR, {
      platform: "win32",
      execFileFn: withProtocol(fakeExec({ claude: "C:\\x\\claude.cmd", wt: "C:\\x\\wt.exe" })),
      spawnFn: fakeSpawn(record),
      openExternalFn: async () => {
        throw new Error("no handler after all");
      },
    });
    expect(result).toEqual({ ok: true });
    expect(record.calls).toHaveLength(1);
    expect(record.calls[0]!.file).toBe("wt.exe");
  });

  test("spawn throw maps to SPAWN_FAILED", async () => {
    const result = await launchAgentTerminal(POSIX_DIR, {
      platform: "linux",
      execFileFn: fakeExec({ claude: "/usr/bin/claude", "gnome-terminal": "/usr/bin/gnome-terminal" }),
      spawnFn: () => {
        throw new Error("boom");
      },
    });
    expect(result).toMatchObject({ ok: false, code: "SPAWN_FAILED" });
  });
});
