import { describe, expect, test } from "bun:test";
import { redactReachability } from "../backend/reachability-redact";

// spec-24 Amendment A1 trust boundary — `wanIp` is owner-only and must
// never reach a non-owner client via the plugin broadcast path. The plugin
// backend feeds every inbound `runtime.voice.reachability.changed` payload
// through `redactReachability` before calling `broadcast.toAll`. These
// tests lock in the redaction contract:
//
//   1. `wanIp` on `result` is replaced with null on every output shape
//   2. `wanIp` on `lastResult` (checking phase) is replaced with null
//   3. Malformed inputs collapse to null rather than leaking partial state
//   4. Status discriminator is preserved for the shell's UI branching

const FRESH_RESULT = {
  status: "ready" as const,
  checkedAt: "2026-05-05T12:00:00.000Z",
  wanIp: "203.0.113.42",
  rtcTcp: { reachable: true, latencyMs: 18, error: null },
  rtcUdp: { reachable: true, latencyMs: 22, error: null },
};

const UNREACHABLE_RESULT = {
  status: "unreachable" as const,
  checkedAt: "2026-05-05T12:01:00.000Z",
  wanIp: "203.0.113.42",
  rtcTcp: { reachable: false, latencyMs: null, error: "timeout" },
  rtcUdp: { reachable: false, latencyMs: null, error: "timeout" },
};

describe("redactReachability — wanIp is stripped on every output shape", () => {
  test("ready state: wanIp on result becomes null", () => {
    const out = redactReachability({ status: "ready", result: FRESH_RESULT });
    expect(out).not.toBeNull();
    expect(out!.status).toBe("ready");
    if (out!.status !== "ready") throw new Error("narrowing");
    expect(out.result.wanIp).toBeNull();
    expect(out.result.checkedAt).toBe(FRESH_RESULT.checkedAt);
    expect(out.result.rtcTcp.reachable).toBe(true);
    expect(out.result.rtcUdp.reachable).toBe(true);
  });

  test("unreachable state: wanIp on result becomes null", () => {
    const out = redactReachability({
      status: "unreachable",
      result: UNREACHABLE_RESULT,
    });
    expect(out).not.toBeNull();
    if (out!.status !== "unreachable") throw new Error("narrowing");
    expect(out.result.wanIp).toBeNull();
    expect(out.result.rtcTcp.reachable).toBe(false);
    expect(out.result.rtcTcp.error).toBe("timeout");
  });

  test("checking state with prior result: lastResult.wanIp becomes null", () => {
    const out = redactReachability({
      status: "checking",
      lastResult: FRESH_RESULT,
    });
    expect(out).not.toBeNull();
    if (out!.status !== "checking") throw new Error("narrowing");
    expect(out.lastResult).not.toBeNull();
    expect(out.lastResult!.wanIp).toBeNull();
    expect(out.lastResult!.checkedAt).toBe(FRESH_RESULT.checkedAt);
  });

  test("checking state with no prior result: lastResult is null", () => {
    const out = redactReachability({ status: "checking", lastResult: null });
    expect(out).toEqual({ status: "checking", lastResult: null });
  });
});

describe("redactReachability — malformed inputs return null", () => {
  test("non-object input returns null", () => {
    expect(redactReachability(null)).toBeNull();
    expect(redactReachability(undefined)).toBeNull();
    expect(redactReachability(42)).toBeNull();
    expect(redactReachability("ready")).toBeNull();
  });

  test("unknown status returns null", () => {
    expect(redactReachability({ status: "idle" })).toBeNull();
    expect(redactReachability({ status: "" })).toBeNull();
  });

  test("ready/unreachable with malformed result returns null", () => {
    expect(redactReachability({ status: "ready", result: null })).toBeNull();
    expect(
      redactReachability({
        status: "ready",
        result: { ...FRESH_RESULT, rtcTcp: { reachable: "yes" } },
      }),
    ).toBeNull();
    expect(
      redactReachability({
        status: "unreachable",
        result: { ...UNREACHABLE_RESULT, checkedAt: 12345 },
      }),
    ).toBeNull();
  });

  test("redacted output never serializes a wanIp string", () => {
    const out = redactReachability({ status: "ready", result: FRESH_RESULT });
    expect(JSON.stringify(out)).not.toContain("203.0.113.42");
  });
});
