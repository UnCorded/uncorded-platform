import { describe, expect, test } from "bun:test";
import type { Logger } from "@uncorded/shared";
import {
  RateLimiter,
  BAN_THRESHOLD_SHORT,
  BAN_THRESHOLD_LONG,
  BAN_DURATION_SHORT_MS,
  BAN_DURATION_LONG_MS,
} from "./rate-limiter";
import type { RateLimitConfig } from "./types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a rate limiter with controllable time */
function createLimiter() {
  let time = 0;
  const limiter = new RateLimiter(() => time);
  return { limiter, setTime: (t: number) => { time = t; }, getTime: () => time };
}

const TEN_PER_MIN: RateLimitConfig = { tokens: 10, windowMs: 60_000 };

// ---------------------------------------------------------------------------
// Token bucket
// ---------------------------------------------------------------------------

describe("RateLimiter — token bucket", () => {
  test("allows requests within the limit", () => {
    const { limiter } = createLimiter();
    for (let i = 0; i < 10; i++) {
      expect(limiter.consume("ip:1.2.3.4", TEN_PER_MIN)).toEqual({ allowed: true });
    }
  });

  test("rejects when tokens exhausted", () => {
    const { limiter } = createLimiter();
    for (let i = 0; i < 10; i++) {
      limiter.consume("ip:1.2.3.4", TEN_PER_MIN);
    }
    const result = limiter.consume("ip:1.2.3.4", TEN_PER_MIN);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.retryAfterMs).toBeGreaterThan(0);
    }
  });

  test("different keys are independent", () => {
    const { limiter } = createLimiter();
    for (let i = 0; i < 10; i++) {
      limiter.consume("ip:1.1.1.1", TEN_PER_MIN);
    }
    // Different key should still have tokens
    expect(limiter.consume("ip:2.2.2.2", TEN_PER_MIN)).toEqual({ allowed: true });
  });

  test("tokens refill over time", () => {
    const { limiter, setTime } = createLimiter();

    // Exhaust all tokens
    for (let i = 0; i < 10; i++) {
      limiter.consume("ip:1.2.3.4", TEN_PER_MIN);
    }
    expect(limiter.consume("ip:1.2.3.4", TEN_PER_MIN).allowed).toBe(false);

    // Advance time by 6 seconds — should refill 1 token (10 per 60s = 1 per 6s)
    setTime(6_000);
    expect(limiter.consume("ip:1.2.3.4", TEN_PER_MIN)).toEqual({ allowed: true });
  });

  test("tokens do not exceed max after long idle", () => {
    const { limiter, setTime } = createLimiter();

    // Use 1 token
    limiter.consume("ip:1.2.3.4", TEN_PER_MIN);

    // Advance far into the future
    setTime(10 * 60_000);

    // Should be able to use exactly 10 tokens (capped at max)
    for (let i = 0; i < 10; i++) {
      expect(limiter.consume("ip:1.2.3.4", TEN_PER_MIN)).toEqual({ allowed: true });
    }
    expect(limiter.consume("ip:1.2.3.4", TEN_PER_MIN).allowed).toBe(false);
  });

  test("retryAfterMs is correct", () => {
    const { limiter } = createLimiter();
    for (let i = 0; i < 10; i++) {
      limiter.consume("ip:1.2.3.4", TEN_PER_MIN);
    }
    const result = limiter.consume("ip:1.2.3.4", TEN_PER_MIN);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      // 10 tokens per 60,000ms = 1 token per 6,000ms
      expect(result.retryAfterMs).toBe(6_000);
    }
  });
});

// ---------------------------------------------------------------------------
// IP ban escalation
// ---------------------------------------------------------------------------

describe("RateLimiter — IP bans", () => {
  test("no ban before threshold", () => {
    const { limiter } = createLimiter();
    for (let i = 0; i < BAN_THRESHOLD_SHORT - 1; i++) {
      const result = limiter.recordAuthFailure("1.2.3.4");
      expect(result.banned).toBe(false);
    }
  });

  test("short ban at 3 consecutive failures", () => {
    const { limiter } = createLimiter();
    for (let i = 0; i < BAN_THRESHOLD_SHORT - 1; i++) {
      limiter.recordAuthFailure("1.2.3.4");
    }
    const result = limiter.recordAuthFailure("1.2.3.4");
    expect(result.banned).toBe(true);
    expect(result.banDurationMs).toBe(BAN_DURATION_SHORT_MS);
  });

  test("long ban at 10 consecutive failures", () => {
    const { limiter } = createLimiter();
    for (let i = 0; i < BAN_THRESHOLD_LONG - 1; i++) {
      limiter.recordAuthFailure("1.2.3.4");
    }
    const result = limiter.recordAuthFailure("1.2.3.4");
    expect(result.banned).toBe(true);
    expect(result.banDurationMs).toBe(BAN_DURATION_LONG_MS);
  });

  test("isBanned returns true during ban period", () => {
    const { limiter, setTime } = createLimiter();
    for (let i = 0; i < BAN_THRESHOLD_SHORT; i++) {
      limiter.recordAuthFailure("1.2.3.4");
    }
    const result = limiter.isBanned("1.2.3.4");
    expect(result.banned).toBe(true);
    if (result.banned) {
      expect(result.retryAfterMs).toBe(BAN_DURATION_SHORT_MS);
    }
  });

  test("ban expires after duration", () => {
    const { limiter, setTime } = createLimiter();
    for (let i = 0; i < BAN_THRESHOLD_SHORT; i++) {
      limiter.recordAuthFailure("1.2.3.4");
    }
    // Advance past the ban period
    setTime(BAN_DURATION_SHORT_MS + 1);
    expect(limiter.isBanned("1.2.3.4")).toEqual({ banned: false });
  });

  test("successful auth resets failure count", () => {
    const { limiter } = createLimiter();
    // 2 failures — one away from ban
    limiter.recordAuthFailure("1.2.3.4");
    limiter.recordAuthFailure("1.2.3.4");

    // Success resets
    limiter.recordAuthSuccess("1.2.3.4");

    // Another failure — count starts fresh, should not ban
    const result = limiter.recordAuthFailure("1.2.3.4");
    expect(result.banned).toBe(false);
  });

  test("isBanned returns false for unknown IP", () => {
    const { limiter } = createLimiter();
    expect(limiter.isBanned("unknown")).toEqual({ banned: false });
  });

  test("different IPs are independent", () => {
    const { limiter } = createLimiter();
    for (let i = 0; i < BAN_THRESHOLD_SHORT; i++) {
      limiter.recordAuthFailure("1.1.1.1");
    }
    expect(limiter.isBanned("1.1.1.1").banned).toBe(true);
    expect(limiter.isBanned("2.2.2.2").banned).toBe(false);
  });

  test("ban expiry preserves failure count — escalates to long ban", () => {
    const { limiter, setTime } = createLimiter();
    let time = 0;

    // 3 failures → short ban
    for (let i = 0; i < BAN_THRESHOLD_SHORT; i++) {
      limiter.recordAuthFailure("1.2.3.4");
    }
    expect(limiter.isBanned("1.2.3.4").banned).toBe(true);

    // Ban expires
    time = BAN_DURATION_SHORT_MS + 1;
    setTime(time);
    expect(limiter.isBanned("1.2.3.4")).toEqual({ banned: false });

    // Each additional failure (4 through 9) re-triggers short ban since
    // failures stays >= BAN_THRESHOLD_SHORT. Advance time past each ban.
    for (let i = BAN_THRESHOLD_SHORT; i < BAN_THRESHOLD_LONG - 1; i++) {
      const result = limiter.recordAuthFailure("1.2.3.4");
      expect(result.banned).toBe(true);
      expect(result.banDurationMs).toBe(BAN_DURATION_SHORT_MS);

      // Advance past this short ban
      time += BAN_DURATION_SHORT_MS + 1;
      setTime(time);
      expect(limiter.isBanned("1.2.3.4")).toEqual({ banned: false });
    }

    // Failure #10 triggers long ban
    const result = limiter.recordAuthFailure("1.2.3.4");
    expect(result.banned).toBe(true);
    expect(result.banDurationMs).toBe(BAN_DURATION_LONG_MS);
  });
});

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

describe("RateLimiter — cleanup", () => {
  test("removes stale bucket entries", () => {
    const { limiter, setTime } = createLimiter();
    limiter.consume("ip:old", TEN_PER_MIN);

    // Advance past stale threshold (2 minutes)
    setTime(2 * 60_000 + 1);
    limiter.cleanup();

    // The old entry should be gone — fresh bucket starts with full tokens
    // Consume all 10 to verify it was reset
    for (let i = 0; i < 10; i++) {
      expect(limiter.consume("ip:old", TEN_PER_MIN)).toEqual({ allowed: true });
    }
  });

  test("removes expired bans", () => {
    const { limiter, setTime } = createLimiter();
    for (let i = 0; i < BAN_THRESHOLD_SHORT; i++) {
      limiter.recordAuthFailure("1.2.3.4");
    }
    setTime(BAN_DURATION_SHORT_MS + 1);
    limiter.cleanup();
    expect(limiter.isBanned("1.2.3.4")).toEqual({ banned: false });
  });
});

// ---------------------------------------------------------------------------
// Structured logging on deny + ban transitions
// ---------------------------------------------------------------------------

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

function createLimiterWithLog() {
  let time = 0;
  const { logger, lines } = makeCapturingLogger();
  const limiter = new RateLimiter(() => time, logger);
  return {
    limiter,
    lines,
    setTime: (t: number) => { time = t; },
    advance: (ms: number) => { time += ms; },
  };
}

describe("RateLimiter — deny logging", () => {
  test("first deny emits a warn line; quiet allows do not", () => {
    const { limiter, lines } = createLimiterWithLog();

    // 10 allowed consumes — silence.
    for (let i = 0; i < 10; i++) {
      expect(limiter.consume("ip:1.2.3.4", TEN_PER_MIN).allowed).toBe(true);
    }
    expect(lines).toEqual([]);

    // First deny — single warn.
    const denied = limiter.consume("ip:1.2.3.4", TEN_PER_MIN);
    expect(denied.allowed).toBe(false);

    expect(lines.length).toBe(1);
    expect(lines[0]!.level).toBe("warn");
    expect(lines[0]!.msg).toBe("rate limit exceeded");
    expect(lines[0]!.ctx["key"]).toBe("ip:1.2.3.4");
    expect(lines[0]!.ctx["tokensPerWindow"]).toBe(10);
    expect(lines[0]!.ctx["windowMs"]).toBe(60_000);
    expect(lines[0]!.ctx["suppressedSinceLastWarn"]).toBe(0);
    expect(typeof lines[0]!.ctx["retryAfterMs"]).toBe("number");
  });

  test("subsequent denies within the debounce window are suppressed", () => {
    const { limiter, lines, advance } = createLimiterWithLog();

    // Drain the bucket (10 allowed consumes), then 5 denies in quick succession.
    for (let i = 0; i < 10; i++) limiter.consume("ip:flood", TEN_PER_MIN);
    expect(lines).toEqual([]);

    for (let i = 0; i < 5; i++) limiter.consume("ip:flood", TEN_PER_MIN);

    // Only the first of the 5 denies should have logged.
    expect(lines.length).toBe(1);
    expect(lines[0]!.ctx["suppressedSinceLastWarn"]).toBe(0);

    // Advance past the 30s debounce. 30_001ms of refill restores ~5 tokens at
    // 10/60_000 per ms, so the next 5 consumes are allowed; the 6th drains
    // the partial-token deficit and triggers another deny → another warn,
    // this time reporting the 4 denies suppressed since the first warn.
    advance(30_001);
    for (let i = 0; i < 5; i++) limiter.consume("ip:flood", TEN_PER_MIN);
    limiter.consume("ip:flood", TEN_PER_MIN);

    expect(lines.length).toBe(2);
    expect(lines[1]!.ctx["suppressedSinceLastWarn"]).toBe(4);
  });

  test("each bucket key debounces independently", () => {
    const { limiter, lines } = createLimiterWithLog();

    // Drain two separate buckets and immediately deny each once.
    for (let i = 0; i < 10; i++) limiter.consume("ip:a", TEN_PER_MIN);
    for (let i = 0; i < 10; i++) limiter.consume("ip:b", TEN_PER_MIN);
    limiter.consume("ip:a", TEN_PER_MIN);
    limiter.consume("ip:b", TEN_PER_MIN);

    expect(lines.length).toBe(2);
    expect(new Set(lines.map((l) => l.ctx["key"]))).toEqual(new Set(["ip:a", "ip:b"]));
  });
});

describe("RateLimiter — ban transition logging", () => {
  test("crossing the short threshold emits a warn", () => {
    const { limiter, lines } = createLimiterWithLog();

    for (let i = 0; i < BAN_THRESHOLD_SHORT - 1; i++) {
      limiter.recordAuthFailure("1.2.3.4");
    }
    expect(lines).toEqual([]);

    limiter.recordAuthFailure("1.2.3.4"); // crosses threshold
    expect(lines.length).toBe(1);
    expect(lines[0]!.level).toBe("warn");
    expect(lines[0]!.msg).toBe("ip banned (short)");
    expect(lines[0]!.ctx["ip"]).toBe("1.2.3.4");
    expect(lines[0]!.ctx["durationMs"]).toBe(BAN_DURATION_SHORT_MS);
    expect(lines[0]!.ctx["failures"]).toBe(BAN_THRESHOLD_SHORT);
  });

  test("crossing the long threshold emits the long-ban warn", () => {
    const { limiter, lines } = createLimiterWithLog();

    for (let i = 0; i < BAN_THRESHOLD_LONG; i++) {
      limiter.recordAuthFailure("1.2.3.4");
    }

    // The short crossing also logs once on the way to long; just confirm a
    // long-ban line is emitted with the right duration.
    const long = lines.find((l) => l.msg === "ip banned (long)");
    expect(long).toBeDefined();
    expect(long!.ctx["ip"]).toBe("1.2.3.4");
    expect(long!.ctx["durationMs"]).toBe(BAN_DURATION_LONG_MS);
    expect(long!.ctx["failures"]).toBe(BAN_THRESHOLD_LONG);
  });

  test("logger is optional — limiter works silently without it", () => {
    // No logger arg — the existing "no logger" tests already cover this, but
    // we assert here too because the public type now claims it's truly optional.
    const limiter = new RateLimiter(() => 0);
    for (let i = 0; i < 100; i++) limiter.consume("ip:silent", TEN_PER_MIN);
    for (let i = 0; i < BAN_THRESHOLD_LONG; i++) limiter.recordAuthFailure("1.2.3.4");
    // No throw, no behavioral change.
    expect(limiter.isBanned("1.2.3.4").banned).toBe(true);
  });
});
