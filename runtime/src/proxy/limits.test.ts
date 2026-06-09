import { describe, expect, test } from "bun:test";
import { PROXY_LIMITS, ProxyConnectionRegistry, withIdleTimeout } from "./limits";

function tightLimits(overrides: Partial<typeof PROXY_LIMITS>) {
  return { ...PROXY_LIMITS, ...overrides };
}

describe("ProxyConnectionRegistry", () => {
  test("enforces the per-user cap and reports the full scope", () => {
    const reg = new ProxyConnectionRegistry(tightLimits({ maxConcurrentPerUser: 1 }));
    const first = reg.acquire("u1", "m1");
    expect(first.ok).toBe(true);
    const second = reg.acquire("u1", "m2");
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.scope).toBe("user");
  });

  test("enforces the per-mount cap across users", () => {
    const reg = new ProxyConnectionRegistry(tightLimits({ maxConcurrentPerMount: 1 }));
    expect(reg.acquire("u1", "shared").ok).toBe(true);
    const blocked = reg.acquire("u2", "shared");
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.scope).toBe("mount");
  });

  test("enforces the global cap", () => {
    const reg = new ProxyConnectionRegistry(tightLimits({ maxConcurrent: 1 }));
    expect(reg.acquire("u1", "m1").ok).toBe(true);
    const blocked = reg.acquire("u2", "m2");
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.scope).toBe("global");
  });

  test("release frees the slot and is idempotent", () => {
    const reg = new ProxyConnectionRegistry(tightLimits({ maxConcurrentPerUser: 1 }));
    const a = reg.acquire("u1", "m1");
    expect(a.ok).toBe(true);
    if (a.ok) {
      a.release();
      a.release(); // double release must not drive counts negative
    }
    expect(reg.active().global).toBe(0);
    expect(reg.acquire("u1", "m2").ok).toBe(true);
  });
});

describe("withIdleTimeout", () => {
  function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    let i = 0;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (i < chunks.length) {
          controller.enqueue(enc.encode(chunks[i] ?? ""));
          i += 1;
        } else {
          controller.close();
        }
      },
    });
  }

  test("passes data through and fires onSettle once on normal close", async () => {
    let settled = 0;
    const guarded = withIdleTimeout(streamOf(["ab", "cd"]), 1000, { onSettle: () => (settled += 1) });
    const text = await new Response(guarded).text();
    expect(text).toBe("abcd");
    expect(settled).toBe(1);
  });

  test("errors the stream and fires onIdle + onSettle when no chunk arrives", async () => {
    let idle = 0;
    let settled = 0;
    // A source that opens but never enqueues or closes ⇒ idle deadline trips.
    const pending = new ReadableStream<Uint8Array>({ start() {} });
    const guarded = withIdleTimeout(pending, 20, {
      onIdle: () => (idle += 1),
      onSettle: () => (settled += 1),
    });
    const reader = guarded.getReader();
    await expect(reader.read()).rejects.toThrow();
    expect(idle).toBe(1);
    expect(settled).toBe(1);
  });

  test("fires onSettle when the consumer cancels", async () => {
    let settled = 0;
    const guarded = withIdleTimeout(streamOf(["x"]), 1000, { onSettle: () => (settled += 1) });
    await guarded.cancel("done");
    expect(settled).toBe(1);
  });
});
