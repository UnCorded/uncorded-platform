import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  TUNNEL_READY_GRACE_MS,
  awaitAuthenticatedTunnelReady,
  runRuntimeTunnelSelfProbe,
} from "./ready";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface FakeTimerHandle {
  readonly id: number;
  readonly cb: () => void;
  runAtMs: number;
  cancelled: boolean;
}

class FakeClock {
  private nowMs = 0;
  private nextId = 1;
  private timers: FakeTimerHandle[] = [];

  readonly now = (): number => this.nowMs;

  readonly setTimeoutFn = (cb: () => void, ms: number): number => {
    const id = this.nextId++;
    this.timers.push({ id, cb, runAtMs: this.nowMs + ms, cancelled: false });
    return id;
  };

  readonly clearTimeoutFn = (handle: unknown): void => {
    const id = handle as number;
    const t = this.timers.find((h) => h.id === id);
    if (t) t.cancelled = true;
  };

  /** Advance virtual time by `ms`, firing any timers that come due in order. */
  async advance(ms: number): Promise<void> {
    const target = this.nowMs + ms;
    while (true) {
      const next = this.timers
        .filter((t) => !t.cancelled && t.runAtMs <= target)
        .sort((a, b) => a.runAtMs - b.runAtMs)[0];
      if (!next) break;
      this.nowMs = next.runAtMs;
      next.cancelled = true;
      next.cb();
      await flushMicrotasks();
    }
    this.nowMs = target;
    await flushMicrotasks();
  }

  pendingCount(): number {
    return this.timers.filter((t) => !t.cancelled).length;
  }
}

async function flushMicrotasks(): Promise<void> {
  // The gate's reader loop pumps through several microtasks per line —
  // a few yields are needed to let the chain advance past `reader.read()`
  // and the synchronous `evaluate()` call.
  for (let i = 0; i < 8; i++) {
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

/** Pair of a writable stream you can push lines into and the readable end
 *  the gate consumes. */
function makeLineStream(): {
  writeLine: (line: string) => Promise<void>;
  close: () => Promise<void>;
  abort: (err?: Error) => Promise<void>;
  readable: ReadableStream<Uint8Array>;
} {
  const ts = new TransformStream<Uint8Array, Uint8Array>();
  const writer = ts.writable.getWriter();
  const encoder = new TextEncoder();
  return {
    writeLine: async (line: string) => {
      await writer.write(encoder.encode(`${line}\n`));
    },
    close: async () => {
      await writer.close();
    },
    abort: async (err?: Error) => {
      await writer.abort(err);
    },
    readable: ts.readable,
  };
}

const INGRESS = "2026-05-11T00:00:00Z INF Updated to new configuration config_version=42";
const CONN = "2026-05-11T00:00:00Z INF Registered tunnel connection connIndex=0 location=ord07";
const CONN_2 = "2026-05-11T00:00:00Z INF Registered tunnel connection connIndex=1 location=ord08";
const CONN_3 = "2026-05-11T00:00:00Z INF Registered tunnel connection connIndex=2 location=ord09";

// ---------------------------------------------------------------------------
// awaitAuthenticatedTunnelReady — gate state machine
// ---------------------------------------------------------------------------

describe("awaitAuthenticatedTunnelReady", () => {
  test("resolves when ingress config + 2 connections arrive", async () => {
    const clock = new FakeClock();
    const stream = makeLineStream();
    const promise = awaitAuthenticatedTunnelReady({
      publicUrl: "https://srv.example.com",
      stderrStream: stream.readable,
      now: clock.now,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    });

    await stream.writeLine(INGRESS);
    await stream.writeLine(CONN);
    await stream.writeLine(CONN_2);
    await flushMicrotasks();

    await expect(promise).resolves.toBe("https://srv.example.com");
    expect(clock.pendingCount()).toBe(0);
  });

  test("connections arriving before ingress still wait for ingress", async () => {
    const clock = new FakeClock();
    const stream = makeLineStream();
    const promise = awaitAuthenticatedTunnelReady({
      publicUrl: "https://srv.example.com",
      stderrStream: stream.readable,
      now: clock.now,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    });

    await stream.writeLine(CONN);
    await stream.writeLine(CONN_2);
    await stream.writeLine(CONN_3);
    await flushMicrotasks();
    // No ingress yet → still pending, no grace armed (grace requires ingress).
    expect(clock.pendingCount()).toBe(1); // only the deadline timer

    await stream.writeLine(INGRESS);
    await flushMicrotasks();

    await expect(promise).resolves.toBe("https://srv.example.com");
  });

  test("ingress + 1 connection resolves after grace expiry", async () => {
    const clock = new FakeClock();
    const stream = makeLineStream();
    const promise = awaitAuthenticatedTunnelReady({
      publicUrl: "https://srv.example.com",
      stderrStream: stream.readable,
      now: clock.now,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    });

    await stream.writeLine(INGRESS);
    await stream.writeLine(CONN);
    await flushMicrotasks();

    // Grace timer is armed for TUNNEL_READY_GRACE_MS (5s).
    // Advance just before grace expiry — still pending.
    await clock.advance(TUNNEL_READY_GRACE_MS - 1);
    let settled = false;
    void promise.then(
      () => { settled = true; },
      () => { settled = true; },
    );
    await flushMicrotasks();
    expect(settled).toBe(false);

    await clock.advance(2);
    await expect(promise).resolves.toBe("https://srv.example.com");
  });

  test("ingress alone (no connections) stays pending until deadline rejects", async () => {
    const clock = new FakeClock();
    const stream = makeLineStream();
    const promise = awaitAuthenticatedTunnelReady({
      publicUrl: "https://srv.example.com",
      stderrStream: stream.readable,
      now: clock.now,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    });
    // Catch eagerly so the rejection fires inside an attached handler rather
    // than as an unhandled rejection during clock.advance().
    const captured = promise.then(
      () => ({ kind: "resolved" as const }),
      (err: Error) => ({ kind: "rejected" as const, err }),
    );

    await stream.writeLine(INGRESS);
    await flushMicrotasks();
    expect(clock.pendingCount()).toBe(1); // deadline only

    await clock.advance(30_000);
    const settled = await captured;
    expect(settled.kind).toBe("rejected");
    if (settled.kind === "rejected") {
      expect(settled.err.message).toMatch(/did not register within 30 seconds/);
    }
  });

  test("connections without ingress never resolve (deadline rejects)", async () => {
    const clock = new FakeClock();
    const stream = makeLineStream();
    const promise = awaitAuthenticatedTunnelReady({
      publicUrl: "https://srv.example.com",
      stderrStream: stream.readable,
      now: clock.now,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    });
    const captured = promise.then(
      () => ({ kind: "resolved" as const }),
      (err: Error) => ({ kind: "rejected" as const, err }),
    );

    await stream.writeLine(CONN);
    await stream.writeLine(CONN_2);
    await stream.writeLine(CONN_3);
    await flushMicrotasks();

    // No ingress was seen → no grace timer either.
    expect(clock.pendingCount()).toBe(1);

    await clock.advance(30_000);
    const settled = await captured;
    expect(settled.kind).toBe("rejected");
    if (settled.kind === "rejected") {
      expect(settled.err.message).toMatch(/did not register within 30 seconds/);
    }
  });

  test("deadline rejects with the documented error message", async () => {
    const clock = new FakeClock();
    const stream = makeLineStream();
    const promise = awaitAuthenticatedTunnelReady({
      publicUrl: "https://srv.example.com",
      stderrStream: stream.readable,
      now: clock.now,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    });
    const captured = promise.then(
      () => ({ kind: "resolved" as const }),
      (err: Error) => ({ kind: "rejected" as const, err }),
    );

    await clock.advance(30_000);
    const settled = await captured;
    expect(settled.kind).toBe("rejected");
    if (settled.kind === "rejected") {
      expect(settled.err.message).toMatch(/did not register within 30 seconds/);
    }
  });

  test("stream closes before gate met → rejects (process exit path, R3)", async () => {
    const clock = new FakeClock();
    const stream = makeLineStream();
    const promise = awaitAuthenticatedTunnelReady({
      publicUrl: "https://srv.example.com",
      stderrStream: stream.readable,
      now: clock.now,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    });

    await stream.writeLine(CONN);
    await flushMicrotasks();
    await stream.close();

    await expect(promise).rejects.toThrow(/exited without registering a connection/);
    // All timers (deadline) must be cleared on rejection — no orphan handles.
    expect(clock.pendingCount()).toBe(0);
  });

  test("ingress + 1 connection then stream close before grace → rejects (R3)", async () => {
    const clock = new FakeClock();
    const stream = makeLineStream();
    const promise = awaitAuthenticatedTunnelReady({
      publicUrl: "https://srv.example.com",
      stderrStream: stream.readable,
      now: clock.now,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    });

    await stream.writeLine(INGRESS);
    await stream.writeLine(CONN);
    await flushMicrotasks();
    // Grace armed; advance by less than grace, then close stream.
    await clock.advance(TUNNEL_READY_GRACE_MS / 2);
    await stream.close();

    await expect(promise).rejects.toThrow(/exited without registering a connection/);
    // Both grace + deadline must be cleared.
    expect(clock.pendingCount()).toBe(0);
  });

  test("onLine callback fires for every parsed line", async () => {
    const clock = new FakeClock();
    const stream = makeLineStream();
    const lines: string[] = [];
    const promise = awaitAuthenticatedTunnelReady({
      publicUrl: "https://srv.example.com",
      stderrStream: stream.readable,
      onLine: (line) => lines.push(line),
      now: clock.now,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    });

    await stream.writeLine("noise");
    await stream.writeLine(INGRESS);
    await stream.writeLine(CONN);
    await stream.writeLine(CONN_2);
    await flushMicrotasks();
    await promise;

    expect(lines).toEqual(["noise", INGRESS, CONN, CONN_2]);
  });
});

// ---------------------------------------------------------------------------
// runRuntimeTunnelSelfProbe
// ---------------------------------------------------------------------------

describe("runRuntimeTunnelSelfProbe", () => {
  test("success on first attempt", async () => {
    let calls = 0;
    const result = await runRuntimeTunnelSelfProbe({
      publicUrl: "https://srv.example.com",
      fetchFn: (async () => {
        calls += 1;
        return new Response("{\"status\":\"ok\"}", { status: 200 });
      }) as unknown as typeof fetch,
      sleep: async () => undefined,
    });
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(1);
    expect(calls).toBe(1);
  });

  test("success on third attempt", async () => {
    let calls = 0;
    const result = await runRuntimeTunnelSelfProbe({
      publicUrl: "https://srv.example.com",
      fetchFn: (async () => {
        calls += 1;
        if (calls < 3) return new Response("err", { status: 521 });
        return new Response("ok", { status: 200 });
      }) as unknown as typeof fetch,
      sleep: async () => undefined,
    });
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(3);
  });

  test("classifies HTTP failure with last status", async () => {
    const result = await runRuntimeTunnelSelfProbe({
      publicUrl: "https://srv.example.com",
      fetchFn: (async () => new Response("nope", { status: 522 })) as unknown as typeof fetch,
      sleep: async () => undefined,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("http");
    expect(result.status).toBe(522);
    expect(result.attempts).toBe(3);
  });

  test("classifies DNS error", async () => {
    const result = await runRuntimeTunnelSelfProbe({
      publicUrl: "https://srv.example.com",
      fetchFn: (async () => {
        throw new Error("getaddrinfo ENOTFOUND srv.example.com");
      }) as unknown as typeof fetch,
      sleep: async () => undefined,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("dns");
  });

  test("classifies timeout", async () => {
    const result = await runRuntimeTunnelSelfProbe({
      publicUrl: "https://srv.example.com",
      fetchFn: (async () => {
        const err = new Error("The operation was aborted due to timeout");
        err.name = "AbortError";
        throw err;
      }) as unknown as typeof fetch,
      sleep: async () => undefined,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("timeout");
  });

  test("waits between attempts using injected sleep", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    await runRuntimeTunnelSelfProbe({
      publicUrl: "https://srv.example.com",
      fetchFn: (async () => {
        calls += 1;
        return new Response("err", { status: 503 });
      }) as unknown as typeof fetch,
      sleep: async (ms) => { sleeps.push(ms); },
    });
    expect(calls).toBe(3);
    expect(sleeps).toEqual([500, 1500]);
  });
});

// ---------------------------------------------------------------------------
// Smoke — graceful unhandled-rejection sanity. The deadline + stream-close
// paths can race in real Bun environments; ensure neither leaves an
// unhandled rejection if the caller awaits the returned promise.
// ---------------------------------------------------------------------------

describe("awaitAuthenticatedTunnelReady — rejection hygiene", () => {
  const handlers: Array<(reason: unknown) => void> = [];
  let captured: unknown[] = [];

  beforeEach(() => {
    captured = [];
    const onUnhandled = (reason: unknown) => { captured.push(reason); };
    handlers.push(onUnhandled);
    process.on("unhandledRejection", onUnhandled);
  });

  afterEach(() => {
    const h = handlers.pop();
    if (h) process.off("unhandledRejection", h);
  });

  test("deadline rejection does not produce unhandled rejection when awaited", async () => {
    const clock = new FakeClock();
    const stream = makeLineStream();
    const promise = awaitAuthenticatedTunnelReady({
      publicUrl: "https://srv.example.com",
      stderrStream: stream.readable,
      now: clock.now,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    });
    // Attach a handler immediately so a caller awaiting the rejection
    // never sees it as "unhandled" even if there's a microtask gap.
    const settled = promise.then(
      () => null,
      (err: unknown) => err,
    );

    await clock.advance(30_000);
    expect(await settled).toBeDefined();
    await flushMicrotasks();
    expect(captured).toEqual([]);
  });
});
