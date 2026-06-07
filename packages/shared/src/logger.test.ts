import { describe, it, expect, spyOn, beforeEach, afterEach } from "bun:test";
import {
  createLogger,
  rootLogger,
  setLogLevel,
  getLogLevel,
  parseLogLevel,
} from "./logger";

describe("logger", () => {
  let writeSpy: ReturnType<typeof spyOn>;
  let stderrSpy: ReturnType<typeof spyOn>;
  let captured: string[];
  let stderrCaptured: string[];

  beforeEach(() => {
    captured = [];
    stderrCaptured = [];
    writeSpy = spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      captured.push(String(chunk));
      return true;
    });
    stderrSpy = spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderrCaptured.push(String(chunk));
      return true;
    });
    // Default threshold for the suite is "debug" so the original assertions
    // (which call .debug and expect output) still hold. Individual gating
    // tests override and restore explicitly.
    setLogLevel("debug");
    // setLogLevel emits its own meta-line; drop it so test assertions about
    // captured output aren't fooled by suite setup noise.
    captured.length = 0;
  });

  afterEach(() => {
    // Restore the level FIRST so the meta-line setLogLevel emits is captured
    // by the still-active spy and never reaches real stdout.
    setLogLevel("info");
    writeSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  function lastLine(): Record<string, unknown> {
    const last = captured[captured.length - 1];
    if (!last) throw new Error("No output captured");
    return JSON.parse(last.trim()) as Record<string, unknown>;
  }

  it("emits valid JSON with level, msg, and ts", () => {
    createLogger().info("hello");
    const obj = lastLine();
    expect(obj["level"]).toBe("info");
    expect(obj["msg"]).toBe("hello");
    expect(typeof obj["ts"]).toBe("string");
    expect(() => new Date(obj["ts"] as string)).not.toThrow();
  });

  it("child logger includes bound context in every line", () => {
    createLogger().child({ component: "foo" }).warn("x");
    const obj = lastLine();
    expect(obj["component"]).toBe("foo");
    expect(obj["level"]).toBe("warn");
  });

  it("ctx fields are flat at top level (not nested)", () => {
    createLogger().error("oops", { reqId: "123" });
    const obj = lastLine();
    expect(obj["reqId"]).toBe("123");
    expect(obj["msg"]).toBe("oops");
  });

  it("circular reference in ctx does not throw — emits serialization failure line", () => {
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    expect(() => createLogger().info("bad ctx", circular)).not.toThrow();
    const obj = lastLine();
    expect(obj["msg"]).toBe("logger serialization failure");
    expect(obj["level"]).toBe("error");
  });

  it("level values are exactly lowercase strings", () => {
    const log = createLogger();
    log.debug("d"); expect(lastLine()["level"]).toBe("debug");
    log.info("i");  expect(lastLine()["level"]).toBe("info");
    log.warn("w");  expect(lastLine()["level"]).toBe("warn");
    log.error("e"); expect(lastLine()["level"]).toBe("error");
  });

  it("rootLogger is a valid logger instance", () => {
    rootLogger.info("from root");
    const obj = lastLine();
    expect(obj["level"]).toBe("info");
    expect(obj["msg"]).toBe("from root");
  });

  it("child of child inherits all ancestor context", () => {
    createLogger().child({ component: "runtime" }).child({ subcomponent: "heartbeat" }).warn("tick");
    const obj = lastLine();
    expect(obj["component"]).toBe("runtime");
    expect(obj["subcomponent"]).toBe("heartbeat");
    expect(obj["level"]).toBe("warn");
  });
});

describe("logger — level gating", () => {
  let writeSpy: ReturnType<typeof spyOn>;
  let captured: string[];

  beforeEach(() => {
    captured = [];
    writeSpy = spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      captured.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    setLogLevel("info");
    writeSpy.mockRestore();
  });

  // Strip the meta-line that setLogLevel writes when transitioning. Tests
  // here only care about *application* log output, not the change record.
  function appLines(): Record<string, unknown>[] {
    return captured
      .map((c) => JSON.parse(c.trim()) as Record<string, unknown>)
      .filter((o) => o["msg"] !== "log level set");
  }

  it("default threshold is info — debug is filtered, info and above pass", () => {
    setLogLevel("info");
    captured.length = 0;
    const log = createLogger();
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    const levels = appLines().map((o) => o["level"]);
    expect(levels).toEqual(["info", "warn", "error"]);
  });

  it("debug threshold passes everything", () => {
    setLogLevel("debug");
    captured.length = 0;
    const log = createLogger();
    log.debug("d"); log.info("i"); log.warn("w"); log.error("e");
    expect(appLines().map((o) => o["level"])).toEqual(["debug", "info", "warn", "error"]);
  });

  it("warn threshold filters debug + info", () => {
    setLogLevel("warn");
    captured.length = 0;
    const log = createLogger();
    log.debug("d"); log.info("i"); log.warn("w"); log.error("e");
    expect(appLines().map((o) => o["level"])).toEqual(["warn", "error"]);
  });

  it("error threshold passes only error", () => {
    setLogLevel("error");
    captured.length = 0;
    const log = createLogger();
    log.debug("d"); log.info("i"); log.warn("w"); log.error("e");
    expect(appLines().map((o) => o["level"])).toEqual(["error"]);
  });

  it("silent threshold suppresses every application call", () => {
    setLogLevel("silent");
    captured.length = 0;
    const log = createLogger();
    log.debug("d"); log.info("i"); log.warn("w"); log.error("e");
    expect(appLines()).toEqual([]);
  });

  it("filtered calls do NOT serialize ctx — getter is never invoked", () => {
    setLogLevel("warn");
    captured.length = 0;
    let touches = 0;
    const ctx = {
      get expensive(): string {
        touches += 1;
        return "x";
      },
    };
    const log = createLogger();
    // debug + info both filtered — getter must remain at zero touches
    log.debug("filtered", ctx);
    log.info("filtered", ctx);
    expect(touches).toBe(0);
    // warn passes — getter may be invoked (we don't assert exactly, since the
    // spread cost is what we wanted to avoid pre-gate, not post-gate)
    log.warn("passes", ctx);
    expect(appLines().map((o) => o["level"])).toEqual(["warn"]);
  });

  it("setLogLevel emits a warn-level meta line with previous + next", () => {
    setLogLevel("info");
    captured.length = 0;
    setLogLevel("debug");
    const lines = captured.map((c) => JSON.parse(c.trim()) as Record<string, unknown>);
    expect(lines.length).toBe(1);
    expect(lines[0]!["msg"]).toBe("log level set");
    // emit-level stays "warn" so meta lines filter the same as application
    // warns; the new threshold value rides on the "next" key to avoid
    // colliding with the emit-level field.
    expect(lines[0]!["level"]).toBe("warn");
    expect(lines[0]!["previous"]).toBe("info");
    expect(lines[0]!["next"]).toBe("debug");
  });

  it("setLogLevel meta line is emitted even when transitioning into silent", () => {
    setLogLevel("info");
    captured.length = 0;
    setLogLevel("silent");
    const lines = captured.map((c) => JSON.parse(c.trim()) as Record<string, unknown>);
    expect(lines.length).toBe(1);
    expect(lines[0]!["msg"]).toBe("log level set");
    expect(lines[0]!["next"]).toBe("silent");
    // After this, application logs go quiet — but the audit trail is preserved.
    captured.length = 0;
    createLogger().error("would normally pass error threshold");
    expect(captured).toEqual([]);
  });

  it("setLogLevel is a no-op when level does not change", () => {
    setLogLevel("info");
    captured.length = 0;
    setLogLevel("info");
    expect(captured).toEqual([]);
  });

  it("silent → silent is a no-op (no meta line)", () => {
    setLogLevel("silent");
    captured.length = 0;
    setLogLevel("silent");
    expect(captured).toEqual([]);
  });

  it("getLogLevel reflects the current threshold", () => {
    setLogLevel("warn");
    expect(getLogLevel()).toBe("warn");
    setLogLevel("debug");
    expect(getLogLevel()).toBe("debug");
  });

  it("threshold change applies to existing child loggers (no caching)", () => {
    setLogLevel("info");
    const child = createLogger().child({ component: "test" });
    captured.length = 0;
    child.debug("filtered before");
    expect(appLines()).toEqual([]);
    setLogLevel("debug");
    captured.length = 0;
    child.debug("passes after");
    const after = appLines();
    expect(after.length).toBe(1);
    expect(after[0]!["level"]).toBe("debug");
    expect(after[0]!["component"]).toBe("test");
  });
});

describe("parseLogLevel", () => {
  it("accepts each canonical level", () => {
    for (const lvl of ["debug", "info", "warn", "error", "silent"]) {
      expect(parseLogLevel(lvl)).toBe(lvl as ReturnType<typeof parseLogLevel>);
    }
  });

  it("trims and lowercases", () => {
    expect(parseLogLevel("  WARN \n")).toBe("warn");
    expect(parseLogLevel("Info")).toBe("info");
  });

  it("returns null for unknown values", () => {
    expect(parseLogLevel("verbose")).toBe(null);
    expect(parseLogLevel("trace")).toBe(null);
    expect(parseLogLevel("")).toBe(null);
    expect(parseLogLevel(undefined)).toBe(null);
  });
});
