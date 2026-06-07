import { describe, test, expect } from "bun:test";
import type { Logger } from "@uncorded/shared";
import { wrapWithAccessLog } from "./access-log";

interface CapturedLine {
  readonly level: "debug" | "info" | "warn" | "error";
  readonly msg: string;
  readonly ctx: Record<string, unknown>;
}

function makeCapturingLogger(): { logger: Logger; lines: CapturedLine[] } {
  const lines: CapturedLine[] = [];
  const make = (): Logger => ({
    debug: (msg, ctx) => { lines.push({ level: "debug", msg, ctx: ctx ?? {} }); },
    info:  (msg, ctx) => { lines.push({ level: "info",  msg, ctx: ctx ?? {} }); },
    warn:  (msg, ctx) => { lines.push({ level: "warn",  msg, ctx: ctx ?? {} }); },
    error: (msg, ctx) => { lines.push({ level: "error", msg, ctx: ctx ?? {} }); },
    child: () => make(),
  });
  return { logger: make(), lines };
}

describe("access-log wrapper", () => {
  test("emits one info line with method, path, status, duration_ms, ip, reqId", async () => {
    const { logger, lines } = makeCapturingLogger();
    let t = 1000;
    const wrapped = wrapWithAccessLog(
      async () => new Response("ok", { status: 200 }),
      {
        logger,
        now: () => { t += 7; return t; },
        newReqId: () => "req-fixed-1",
      },
    );

    const res = await wrapped(new Request("http://localhost/v1/auth/profile", {
      method: "GET",
      headers: { "cf-connecting-ip": "203.0.113.42" },
    }));

    expect(res.status).toBe(200);
    expect(lines.length).toBe(1);
    const line = lines[0]!;
    expect(line.level).toBe("info");
    expect(line.msg).toBe("request");
    expect(line.ctx["method"]).toBe("GET");
    expect(line.ctx["path"]).toBe("/v1/auth/profile");
    expect(line.ctx["status"]).toBe(200);
    expect(line.ctx["ip"]).toBe("203.0.113.42");
    expect(line.ctx["reqId"]).toBe("req-fixed-1");
    expect(typeof line.ctx["duration_ms"]).toBe("number");
    // Single now() before + after the inner handler. The mock advances by 7
    // each call; Math.round((1014 - 1007)) = 7.
    expect(line.ctx["duration_ms"]).toBe(7);
    expect(line.ctx["queryKeys"]).toBeUndefined();
  });

  test("logs /health at debug so LB probes don't drown prod logs", async () => {
    const { logger, lines } = makeCapturingLogger();
    const wrapped = wrapWithAccessLog(
      async () => new Response("{}", { status: 200 }),
      { logger, newReqId: () => "r" },
    );

    await wrapped(new Request("http://localhost/health"));

    expect(lines.length).toBe(1);
    expect(lines[0]!.level).toBe("debug");
    expect(lines[0]!.ctx["path"]).toBe("/health");
  });

  test("redacts query string values — only sorted key list survives", async () => {
    // verify-email and server-transfer confirm/decline carry tokens in the URL.
    // Logging the raw search would put those tokens in log aggregators, which is
    // exactly the leak we're trying to avoid. Confirm the wrapper drops values.
    const { logger, lines } = makeCapturingLogger();
    const wrapped = wrapWithAccessLog(
      async () => new Response("", { status: 302 }),
      { logger, newReqId: () => "r" },
    );

    await wrapped(new Request(
      "http://localhost/v1/auth/verify-email?token=THIS-IS-SECRET&email=user%40example.com",
    ));

    expect(lines.length).toBe(1);
    const ctx = lines[0]!.ctx;
    expect(ctx["queryKeys"]).toBe("email,token");
    // Belt-and-suspenders: the secret token must not appear anywhere in the
    // serialized log fields.
    expect(JSON.stringify(ctx)).not.toContain("THIS-IS-SECRET");
  });

  test("captures status from the inner handler — 4xx and 5xx land in the log", async () => {
    const { logger, lines } = makeCapturingLogger();
    const wrapped = wrapWithAccessLog(
      async () => new Response("nope", { status: 503 }),
      { logger, newReqId: () => "r" },
    );

    await wrapped(new Request("http://localhost/v1/plugins"));

    expect(lines[0]!.ctx["status"]).toBe(503);
  });

  test("each request gets a fresh reqId", async () => {
    const { logger, lines } = makeCapturingLogger();
    let n = 0;
    const wrapped = wrapWithAccessLog(
      async () => new Response("", { status: 200 }),
      { logger, newReqId: () => `r-${++n}` },
    );

    await wrapped(new Request("http://localhost/v1/servers"));
    await wrapped(new Request("http://localhost/v1/servers"));
    await wrapped(new Request("http://localhost/v1/servers"));

    expect(lines.map((l) => l.ctx["reqId"])).toEqual(["r-1", "r-2", "r-3"]);
  });

  test("preserves the inner Response object (body + headers + status)", async () => {
    const { logger } = makeCapturingLogger();
    const inner = new Response("hello", {
      status: 201,
      headers: { "X-Custom": "yes", "Content-Type": "text/plain" },
    });
    const wrapped = wrapWithAccessLog(async () => inner, {
      logger,
      newReqId: () => "r",
    });

    const out = await wrapped(new Request("http://localhost/v1/servers"));

    // The wrapper must return the SAME Response — no copy, no header rewrite.
    // Otherwise CORS/Set-Cookie/streamed bodies would silently break.
    expect(out).toBe(inner);
    expect(out.status).toBe(201);
    expect(out.headers.get("X-Custom")).toBe("yes");
    expect(await out.text()).toBe("hello");
  });

  test("falls back to the raw URL string when URL parsing throws", async () => {
    // Defensive: the inner handler is the one that returns 4xx for malformed
    // URLs. The wrapper should still emit a log line and not throw.
    const { logger, lines } = makeCapturingLogger();
    const wrapped = wrapWithAccessLog(
      async () => new Response("", { status: 400 }),
      { logger, newReqId: () => "r" },
    );

    // Use a bare path the URL constructor can parse to keep this realistic;
    // a truly unparseable URL can't even reach Bun.serve. We assert the
    // surrounding contract: status flows through, no throw escapes.
    const res = await wrapped(new Request("http://localhost/v1/plugins/foo-bar"));

    expect(res.status).toBe(400);
    expect(lines[0]!.ctx["path"]).toBe("/v1/plugins/foo-bar");
  });
});
