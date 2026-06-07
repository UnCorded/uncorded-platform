// Structured JSON logger — Principle #3 compliance.
// Zero dependencies. Writes newline-delimited JSON to process.stdout.
//
// `@uncorded/shared` is consumed by both Node-style runtimes (Bun runtime,
// Central) and the browser bundle (website imports `getClientColor` /
// `getNameInitial` from this package). The browser has no `process`, so every
// process access here feature-detects — in the browser the logger silently
// becomes a no-op rather than crashing module init for the whole shared
// barrel.

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

export interface Logger {
  debug(msg: string, ctx?: Record<string, unknown>): void;
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
  child(ctx: Record<string, unknown>): Logger;
}

// Call levels the Logger interface exposes. Excludes "silent" — that's a
// threshold value only, no .silent() method exists.
type CallLevel = Exclude<LogLevel, "silent">;

// Ordering threshold. A call emits when LEVEL_RANK[callLevel] >= currentRank.
// "silent" sits above every call level so it suppresses everything.
const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

const VALID_LEVELS: ReadonlySet<string> = new Set([
  "debug",
  "info",
  "warn",
  "error",
  "silent",
]);

/** Parse a string into a LogLevel. Returns null for unrecognized values.
 *  Exported so callers (and tests) can validate operator input without
 *  duplicating the level-set literal. */
export function parseLogLevel(raw: string | undefined): LogLevel | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim().toLowerCase();
  return VALID_LEVELS.has(trimmed) ? (trimmed as LogLevel) : null;
}

let currentLevel: LogLevel = "info";
let currentRank: number = LEVEL_RANK.info;

// `process` is undefined in the browser; the typeof-check protects module
// init and lets the website import the rest of `@uncorded/shared`.
const hasProcess =
  typeof globalThis !== "undefined" &&
  typeof (globalThis as { process?: unknown }).process !== "undefined";
const proc = hasProcess
  ? (globalThis as { process: NodeJS.Process }).process
  : null;

// One-shot env init. Invalid values fail loud on stderr — but NOT through the
// logger itself, because the logger's own bootstrap is what's misconfigured.
// Empty/unset = use default (info), no warning.
if (proc !== null) {
  const env = proc.env["LOG_LEVEL"];
  if (env !== undefined && env.length > 0) {
    const parsed = parseLogLevel(env);
    if (parsed !== null) {
      currentLevel = parsed;
      currentRank = LEVEL_RANK[parsed];
    } else {
      try {
        proc.stderr.write(
          `logger: ignoring invalid LOG_LEVEL=${JSON.stringify(env)}, ` +
            `falling back to "info" (valid: debug,info,warn,error,silent)\n`,
        );
      } catch {
        // No recovery available — stderr is gone too.
      }
    }
  }
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

let stdoutHealthy = proc !== null;

if (proc !== null) {
  proc.stdout.on("error", () => {
    stdoutHealthy = false;
  });
}

function safeStringify(obj: Record<string, unknown>): string {
  try {
    return JSON.stringify(obj);
  } catch (e: unknown) {
    // Fallback: only known-safe fields to avoid infinite recursion
    return JSON.stringify({
      ts: obj["ts"] ?? new Date().toISOString(),
      level: "error",
      msg: "logger serialization failure",
      error: String(e),
    });
  }
}

function writeLine(line: string): void {
  if (!stdoutHealthy || proc === null) return;
  try {
    proc.stdout.write(line + "\n");
  } catch {
    stdoutHealthy = false;
  }
}

// Bypasses the level filter. Used only for the logger's own meta-events
// (currently: setLogLevel acknowledgement). Keeping this path tiny + private
// prevents callers from accidentally smuggling unfilterable noise.
function emitMeta(level: CallLevel, msg: string, ctx?: Record<string, unknown>): void {
  writeLine(
    safeStringify({
      ts: new Date().toISOString(),
      level,
      msg,
      ...ctx,
    }),
  );
}

/** Reconfigure the global threshold at runtime. Tests and dynamic ops paths
 *  (e.g. a SIGUSR1 handler that flips to "debug" for incident triage) call
 *  this. Emits a single warn-level meta-line so operators always have an
 *  audit trail of the change — except silent→silent, which is a no-op. */
export function setLogLevel(level: LogLevel): void {
  const previous = currentLevel;
  if (previous === level) return;
  currentLevel = level;
  currentRank = LEVEL_RANK[level];
  // The new level may forbid warn (e.g. silent), but a level change is
  // important enough that we always announce it once on the way in. Once
  // emitMeta returns, subsequent calls fall back through the normal gate.
  // Field name is "next" (not "level") so it doesn't collide with the
  // emit-level field via spread — every line must keep level=warn so meta
  // events filter the same way regular warn lines do.
  if (!(previous === "silent" && level === "silent")) {
    emitMeta("warn", "log level set", { previous, next: level });
  }
}

export function createLogger(boundCtx?: Record<string, unknown>): Logger {
  function emit(level: CallLevel, msg: string, ctx?: Record<string, unknown>): void {
    // Hot path: gate BEFORE serialization. Calling .debug() at info threshold
    // must cost a single integer compare and a return — no JSON.stringify, no
    // object spread, no Date allocation.
    if (LEVEL_RANK[level] < currentRank) return;
    if (!stdoutHealthy || proc === null) return;
    const line = safeStringify({
      ts: new Date().toISOString(),
      level,
      msg,
      ...boundCtx,
      ...ctx,
    });
    try {
      proc.stdout.write(line + "\n");
    } catch {
      stdoutHealthy = false;
    }
  }

  return {
    debug(msg, ctx) { emit("debug", msg, ctx); },
    info(msg, ctx)  { emit("info",  msg, ctx); },
    warn(msg, ctx)  { emit("warn",  msg, ctx); },
    error(msg, ctx) { emit("error", msg, ctx); },
    child(ctx) { return createLogger({ ...boundCtx, ...ctx }); },
  };
}

export const rootLogger: Logger = createLogger();
