import { describe, expect, it } from "bun:test";

import {
  retry,
  RetryAbortedError,
  RetryExhaustedError,
  RETRYABLE_STATUS,
} from "./retry";

const noSleep = async (_ms: number): Promise<void> => undefined;

describe("retry helper — happy paths", () => {
  it("returns the value on the first success", async () => {
    let calls = 0;
    const result = await retry(async () => {
      calls++;
      return "ok";
    }, { sleep: noSleep });
    expect(result).toBe("ok");
    expect(calls).toBe(1);
  });

  it("passes through an ok Response without retrying", async () => {
    let calls = 0;
    const res = await retry(async () => {
      calls++;
      return new Response("body", { status: 200 });
    }, { sleep: noSleep });
    expect(res.status).toBe(200);
    expect(calls).toBe(1);
  });
});

describe("retry helper — retries on transient failures", () => {
  it("retries after a 503 and returns the eventual 200", async () => {
    const sequence = [503, 503, 200];
    let i = 0;
    const res = await retry(async () => {
      const status = sequence[i++] ?? 200;
      return new Response("body", { status });
    }, { sleep: noSleep });
    expect(res.status).toBe(200);
    expect(i).toBe(3);
  });

  it("retries after a network error then succeeds", async () => {
    let calls = 0;
    const res = await retry(async () => {
      calls++;
      if (calls === 1) throw new TypeError("network down");
      return new Response("ok", { status: 200 });
    }, { sleep: noSleep });
    expect(res.status).toBe(200);
    expect(calls).toBe(2);
  });

  it("returns the last response when all attempts fail with retryable status", async () => {
    let calls = 0;
    const res = await retry(async () => {
      calls++;
      return new Response("bad", { status: 503 });
    }, { sleep: noSleep, attempts: 3 });
    expect(res.status).toBe(503);
    expect(calls).toBe(3);
  });

  it("retries on 408 Request Timeout", async () => {
    expect(RETRYABLE_STATUS.has(408)).toBe(true);
    let calls = 0;
    const res = await retry(async () => {
      calls++;
      return new Response("", { status: calls < 2 ? 408 : 200 });
    }, { sleep: noSleep });
    expect(res.status).toBe(200);
    expect(calls).toBe(2);
  });

  it("retries on 429 Too Many Requests", async () => {
    expect(RETRYABLE_STATUS.has(429)).toBe(true);
    let calls = 0;
    const res = await retry(async () => {
      calls++;
      return new Response("", { status: calls < 2 ? 429 : 200 });
    }, { sleep: noSleep });
    expect(res.status).toBe(200);
  });

  it("honors Retry-After (seconds) but caps at backoffCeilingMs", async () => {
    const slept: number[] = [];
    let calls = 0;
    await retry(async () => {
      calls++;
      if (calls === 1) {
        // Server tries to make us wait 600s — must be capped to 8s.
        return new Response("", {
          status: 429,
          headers: { "retry-after": "600" },
        });
      }
      return new Response("", { status: 200 });
    }, {
      sleep: async (ms) => { slept.push(ms); },
      backoffCeilingMs: 8_000,
    });
    expect(slept[0]).toBe(8_000);
  });

  it("honors Retry-After when smaller than the default backoff entry", async () => {
    const slept: number[] = [];
    let calls = 0;
    await retry(async () => {
      calls++;
      if (calls === 1) {
        return new Response("", {
          status: 429,
          headers: { "retry-after": "0.1" },
        });
      }
      return new Response("", { status: 200 });
    }, {
      sleep: async (ms) => { slept.push(ms); },
      backoffMs: [5_000],
      backoffCeilingMs: 8_000,
    });
    // 0.1s → 100ms, which is below the configured backoff and the ceiling.
    expect(slept[0]).toBe(100);
  });
});

describe("retry helper — fail-fast paths", () => {
  it("fails fast on a 404 (no retries)", async () => {
    let calls = 0;
    const res = await retry(async () => {
      calls++;
      return new Response("not found", { status: 404 });
    }, { sleep: noSleep });
    expect(res.status).toBe(404);
    expect(calls).toBe(1);
  });

  it("fails fast on a 401", async () => {
    let calls = 0;
    const res = await retry(async () => {
      calls++;
      return new Response("", { status: 401 });
    }, { sleep: noSleep });
    expect(res.status).toBe(401);
    expect(calls).toBe(1);
  });

  it("fails fast on a 403", async () => {
    let calls = 0;
    const res = await retry(async () => {
      calls++;
      return new Response("", { status: 403 });
    }, { sleep: noSleep });
    expect(res.status).toBe(403);
    expect(calls).toBe(1);
  });

  it("rethrows a non-retryable thrown error immediately", async () => {
    let calls = 0;
    await expect(
      retry(async () => {
        calls++;
        throw new Error("syntax error in callback");
      }, { sleep: noSleep }),
    ).rejects.toThrow(/syntax error/);
    expect(calls).toBe(1);
  });
});

describe("retry helper — signal abort", () => {
  it("throws RetryAbortedError when signal is already aborted", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      retry(async () => new Response("", { status: 200 }), {
        sleep: noSleep,
        signal: ctrl.signal,
      }),
    ).rejects.toBeInstanceOf(RetryAbortedError);
  });

  it("aborts mid-retry between attempts", async () => {
    const ctrl = new AbortController();
    let calls = 0;
    const promise = retry(async () => {
      calls++;
      if (calls === 1) {
        // Schedule the abort to fire during the sleep period.
        queueMicrotask(() => { ctrl.abort(); });
        return new Response("", { status: 503 });
      }
      return new Response("", { status: 200 });
    }, {
      sleep: noSleep,
      signal: ctrl.signal,
    });
    await expect(promise).rejects.toBeInstanceOf(RetryAbortedError);
    expect(calls).toBe(1);
  });

  it("rethrows non-AbortError exceptions caught while signal is also aborted", async () => {
    // A thrown TypeError combined with an aborted signal: the signal abort
    // wins (RetryAbortedError) — caller intent always takes precedence.
    const ctrl = new AbortController();
    let calls = 0;
    const promise = retry(async () => {
      calls++;
      ctrl.abort();
      throw new TypeError("network");
    }, {
      sleep: noSleep,
      signal: ctrl.signal,
    });
    await expect(promise).rejects.toBeInstanceOf(RetryAbortedError);
  });
});

describe("retry helper — RetryExhaustedError", () => {
  it("throws when every attempt fails on network error", async () => {
    let calls = 0;
    await expect(
      retry(async () => {
        calls++;
        throw new TypeError("network down");
      }, { sleep: noSleep, attempts: 3 }),
    ).rejects.toThrow(/network down/);
    expect(calls).toBe(3);
  });
});

describe("retry helper — backoff sequencing", () => {
  it("uses configured backoff entries in order, then reuses the last", async () => {
    const slept: number[] = [];
    let calls = 0;
    await retry(async () => {
      calls++;
      return new Response("", { status: calls < 5 ? 503 : 200 });
    }, {
      sleep: async (ms) => { slept.push(ms); },
      attempts: 5,
      backoffMs: [10, 20, 30],
    });
    expect(slept).toEqual([10, 20, 30, 30]);
  });

  it("default backoff array yields 500/1500/3000 over 4 attempts", async () => {
    const slept: number[] = [];
    let calls = 0;
    await retry(async () => {
      calls++;
      return new Response("", { status: calls < 4 ? 503 : 200 });
    }, {
      sleep: async (ms) => { slept.push(ms); },
      // attempts defaults to 4
    });
    expect(slept).toEqual([500, 1500, 3000]);
  });
});

describe("retry helper — custom shouldRetry", () => {
  it("invokes the predicate for non-ok Responses and respects its decision", async () => {
    const seen: number[] = [];
    let calls = 0;
    const res = await retry(async () => {
      calls++;
      return new Response("", { status: calls === 1 ? 418 : 200 });
    }, {
      sleep: noSleep,
      shouldRetry: (err) => {
        if (err instanceof Response) {
          seen.push(err.status);
          return err.status === 418;
        }
        return false;
      },
    });
    expect(res.status).toBe(200);
    expect(seen).toEqual([418]);
  });

  it("invokes the predicate for thrown errors", async () => {
    let calls = 0;
    const res = await retry(async () => {
      calls++;
      if (calls === 1) throw new RangeError("temporary");
      return new Response("", { status: 200 });
    }, {
      sleep: noSleep,
      shouldRetry: (err) => err instanceof RangeError,
    });
    expect(res.status).toBe(200);
    expect(calls).toBe(2);
  });
});

describe("retry helper — RetryExhaustedError envelope", () => {
  it("captures lastError and attempt count", () => {
    const cause = new TypeError("net");
    const err = new RetryExhaustedError(4, cause);
    expect(err.attempts).toBe(4);
    expect(err.lastError).toBe(cause);
    expect(err.message).toContain("net");
  });
});
