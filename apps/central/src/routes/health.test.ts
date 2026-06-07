import { describe, test, expect } from "bun:test";
import { handleHealth, type BootInfo } from "./health";
import type { Sql } from "../db";

// Minimal sql() shim. The real `postgres` driver returns a tagged-template
// callable whose result is a thenable yielding a row array. /health only
// awaits `sql\`SELECT 1\`` and does not read the rows, so the shim returns
// whatever the test wants — { kind } controls the shape:
//   - "ok":    resolves immediately with []
//   - "slow":  hangs longer than the timeout
//   - "throw": rejects synchronously with an internal error message
function makeSql(kind: "ok" | "slow" | "throw"): Sql {
  const fn = (..._args: unknown[]): Promise<unknown[]> => {
    if (kind === "ok") return Promise.resolve([]);
    if (kind === "throw") {
      return Promise.reject(
        new Error("postgres connection refused 127.0.0.1:5432 password=topsecret"),
      );
    }
    // "slow": never resolves within the test window
    return new Promise(() => {});
  };
  return fn as unknown as Sql;
}

const baseBoot: BootInfo = {
  version: "9.9.9",
  commit: "abcdef0",
  startedAt: Date.now() - 5_000,
};

describe("handleHealth", () => {
  test("ok: returns 200 with version, commit, uptime, db ok", async () => {
    const res = await handleHealth(makeSql("ok"), baseBoot);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      version: string;
      commit: string;
      uptime_s: number;
      db: { state: string; latency_ms: number };
    };
    expect(body.status).toBe("ok");
    expect(body.version).toBe("9.9.9");
    expect(body.commit).toBe("abcdef0");
    expect(body.uptime_s).toBeGreaterThanOrEqual(5);
    expect(body.db.state).toBe("ok");
    expect(body.db.latency_ms).toBeGreaterThanOrEqual(0);
  });

  test("db throw: returns 503 degraded and never leaks driver internals", async () => {
    const res = await handleHealth(makeSql("throw"), baseBoot);
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(text).not.toMatch(/postgres|password|topsecret|127\.0\.0\.1/i);
    const body = JSON.parse(text);
    expect(body.status).toBe("degraded");
    expect(body.db.state).toBe("down");
    expect(body.version).toBe("9.9.9");
  });

  test("db slow: timeout fires under ~300ms and returns 503 degraded", async () => {
    const t0 = Date.now();
    const res = await handleHealth(makeSql("slow"), baseBoot);
    const elapsed = Date.now() - t0;
    expect(res.status).toBe(503);
    // Timeout cap is 250ms; allow generous slack for CI scheduler jitter but
    // assert it's nowhere near "blocked the worker for seconds".
    expect(elapsed).toBeLessThan(1_500);
    const body = (await res.json()) as { status: string; db: { state: string } };
    expect(body.status).toBe("degraded");
    expect(body.db.state).toBe("down");
  });
});
