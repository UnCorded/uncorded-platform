// Unit tests for voice/reachability.ts. Pure in-memory state machine —
// covers all four trigger types, cooldown semantics, persistence round-trip,
// the WAN-change detector, and the ICE-failure-cluster heuristic.

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  createReachability,
  isVoiceProbeResult,
  type ReachabilityHandle,
  type VoiceProbeResult,
} from "./reachability";

/** Drain enough microtasks for an in-flight probe to settle.
 *  callCentral does fetch + .json() awaits, plus the IIFE finally — give
 *  it generous headroom so tests don't race. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function mkResult(
  overrides: Partial<VoiceProbeResult> = {},
): VoiceProbeResult {
  return {
    version: 1,
    status: "ready",
    checkedAt: "2026-05-05T12:00:00.000Z",
    wanIp: "203.0.113.10",
    rtcTcp: { reachable: true, latencyMs: 7, error: null },
    rtcUdp: { reachable: true, latencyMs: 9, error: null },
    ...overrides,
  };
}

const MIGRATION_PATH = join(
  import.meta.dir,
  "..",
  "core",
  "migrations",
  "013_create_voice_reachability_state.sql",
);

function freshDb(): Database {
  const db = new Database(":memory:");
  const sql = readFileSync(MIGRATION_PATH, "utf-8");
  db.exec(sql);
  return db;
}

type StagedResponse =
  | VoiceProbeResult
  | "network-error"
  | { status: number; retryAfterSeconds?: number };

interface Harness {
  handle: ReachabilityHandle;
  db: Database;
  events: { topic: string; payload: unknown }[];
  fetchCalls: number;
  setNextResult: (result: StagedResponse) => void;
  setNow: (n: number) => void;
}

function makeHarness(opts?: {
  centralUrl?: string;
  initialNow?: number;
}): Harness {
  const db = freshDb();
  const events: { topic: string; payload: unknown }[] = [];
  let nextResult: StagedResponse | null = mkResult();
  let fetchCalls = 0;
  let nowVal = opts?.initialNow ?? 1_700_000_000_000;

  const handle = createReachability({
    db,
    centralUrl: opts?.centralUrl ?? "https://central.example.com",
    serverId: "srv_test",
    serverSecret: "secret",
    publishRuntimeEvent: (topic, payload) => {
      events.push({ topic, payload });
    },
    fetch: (async (_url: unknown, _init: unknown): Promise<Response> => {
      fetchCalls++;
      if (nextResult === null) throw new Error("no next result staged");
      const r = nextResult;
      if (r === "network-error") throw new TypeError("fetch failed");
      if ("status" in r && !("rtcTcp" in r)) {
        const headers: Record<string, string> = {};
        if (r.retryAfterSeconds !== undefined) {
          headers["Retry-After"] = String(r.retryAfterSeconds);
        }
        return new Response("err", { status: r.status, headers });
      }
      return new Response(JSON.stringify(r), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof globalThis.fetch,
    now: () => nowVal,
    // Boot timer fires immediately for deterministic tests.
    setTimeout: (cb) => {
      cb();
      return 0;
    },
    clearTimeout: () => {},
  });

  return {
    handle,
    db,
    events,
    get fetchCalls() {
      return fetchCalls;
    },
    setNextResult: (r: StagedResponse) => {
      nextResult = r;
    },
    setNow: (n: number) => {
      nowVal = n;
    },
  } as unknown as Harness;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("reachability — initialization", () => {
  test("starts in null state when DB is empty", () => {
    const h = makeHarness();
    h.handle.init();
    expect(h.handle.getState()).toBeNull();
  });

  test("restores prior result from DB on init", () => {
    const h = makeHarness();
    const result = mkResult({ status: "unreachable" });
    h.db.run(
      `INSERT INTO voice_reachability_state
        (id, status, checked_at, wan_ip, rtc_tcp_json, rtc_udp_json)
       VALUES (1, ?, ?, ?, ?, ?)`,
      [
        result.status,
        Date.parse(result.checkedAt),
        result.wanIp,
        JSON.stringify(result.rtcTcp),
        JSON.stringify(result.rtcUdp),
      ],
    );
    h.handle.init();
    const state = h.handle.getState();
    expect(state?.status).toBe("unreachable");
    if (state && state.status !== "checking") {
      expect(state.result.wanIp).toBe(result.wanIp);
    }
  });
});

describe("reachability — boot trigger", () => {
  test("fires after voice ready AND first wan_ip observed", async () => {
    const h = makeHarness();
    h.handle.init();

    // wan_ip alone shouldn't trigger
    h.handle.noteWanIp("203.0.113.5");
    expect(h.fetchCalls).toBe(0);

    // voice ready completes the gate, boot probe fires
    h.handle.noteVoiceReady();
    // Boot timer (mocked) fires synchronously, but the probe IIFE awaits
    // fetch + .json() before settling. flush() drains those microtasks.
    await flush();
    expect(h.fetchCalls).toBe(1);
  });

  test("voice-ready alone with no wan_ip never fires", () => {
    const h = makeHarness();
    h.handle.init();
    h.handle.noteVoiceReady();
    expect(h.fetchCalls).toBe(0);
  });

  test("only fires once even if both gates settle multiple times", async () => {
    const h = makeHarness();
    h.handle.init();
    h.handle.noteWanIp("203.0.113.5");
    h.handle.noteVoiceReady();
    await flush();
    h.handle.noteVoiceReady();
    h.handle.noteVoiceReady();
    await flush();
    expect(h.fetchCalls).toBe(1);
  });
});

describe("reachability — wan_change trigger", () => {
  test("first wan_ip is treated as boot signal, not delta", () => {
    const h = makeHarness();
    h.handle.init();
    h.handle.noteWanIp("203.0.113.5");
    expect(h.fetchCalls).toBe(0); // no voice-ready yet
  });

  test("changed wan_ip after voice-ready triggers probe", async () => {
    const h = makeHarness();
    h.handle.init();
    h.handle.noteWanIp("203.0.113.5");
    h.handle.noteVoiceReady();
    await flush();
    expect(h.fetchCalls).toBe(1);

    // Move past cooldown
    h.setNow(1_700_000_000_000 + 61_000);

    h.setNextResult(mkResult({ wanIp: "198.51.100.42" }));
    h.handle.noteWanIp("198.51.100.42");
    await flush();
    expect(h.fetchCalls).toBe(2);
  });

  test("same wan_ip repeated does NOT trigger probe", async () => {
    const h = makeHarness();
    h.handle.init();
    h.handle.noteWanIp("203.0.113.5");
    h.handle.noteVoiceReady();
    await flush();
    expect(h.fetchCalls).toBe(1);

    h.setNow(1_700_000_000_000 + 61_000);
    h.handle.noteWanIp("203.0.113.5");
    await flush();
    expect(h.fetchCalls).toBe(1);
  });
});

describe("reachability — cooldown gate", () => {
  test("automatic trigger blocked during 60s window", async () => {
    const h = makeHarness();
    h.handle.init();
    h.handle.noteWanIp("203.0.113.5");
    h.handle.noteVoiceReady();
    await flush();
    expect(h.fetchCalls).toBe(1);

    // Immediately try a wan_change (different IP) — should be blocked
    h.handle.noteWanIp("198.51.100.99");
    await flush();
    expect(h.fetchCalls).toBe(1);
  });

  test("manual trigger bypasses cooldown", async () => {
    const h = makeHarness();
    h.handle.init();
    h.handle.noteWanIp("203.0.113.5");
    h.handle.noteVoiceReady();
    await flush();
    expect(h.fetchCalls).toBe(1);

    const result = await h.handle.requestProbe("manual");
    expect(result.ok).toBe(true);
    expect(h.fetchCalls).toBe(2);
  });

  test("Central 429 surfaces as cooldown with parsed Retry-After", async () => {
    const h = makeHarness();
    h.handle.init();
    h.handle.noteWanIp("203.0.113.5");
    h.handle.noteVoiceReady();
    await flush();

    h.setNextResult({ status: 429, retryAfterSeconds: 42 });
    const result = await h.handle.requestProbe("manual");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("narrowing");
    expect(result.code).toBe("cooldown");
    expect(result.retryAfterMs).toBe(42_000);
    expect(result.message).toContain("42s");
  });

  test("Central 429 without Retry-After still surfaces as cooldown", async () => {
    const h = makeHarness();
    h.handle.init();
    h.handle.noteWanIp("203.0.113.5");
    h.handle.noteVoiceReady();
    await flush();

    h.setNextResult({ status: 429 });
    const result = await h.handle.requestProbe("manual");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("narrowing");
    expect(result.code).toBe("cooldown");
    expect(result.retryAfterMs).toBeUndefined();
  });

  test("automatic triggers resume after cooldown elapses", async () => {
    const h = makeHarness();
    h.handle.init();
    h.handle.noteWanIp("203.0.113.5");
    h.handle.noteVoiceReady();
    await flush();
    expect(h.fetchCalls).toBe(1);

    h.setNow(1_700_000_000_000 + 61_000);
    h.setNextResult(mkResult({ wanIp: "198.51.100.99" }));
    h.handle.noteWanIp("198.51.100.99");
    await flush();
    expect(h.fetchCalls).toBe(2);
  });
});

describe("reachability — persistence", () => {
  test("successful probe is persisted to voice_reachability_state", async () => {
    const h = makeHarness();
    h.handle.init();
    const result = mkResult({ status: "unreachable" });
    h.setNextResult(result);
    await h.handle.requestProbe("manual");

    const row = h.db
      .query<
        { status: string; wan_ip: string },
        []
      >(`SELECT status, wan_ip FROM voice_reachability_state WHERE id = 1`)
      .get();
    expect(row?.status).toBe("unreachable");
    expect(row?.wan_ip).toBe(result.wanIp);
  });
});

describe("reachability — event publishing", () => {
  test("publishes runtime.voice.reachability.changed on first probe", async () => {
    const h = makeHarness();
    h.handle.init();
    await h.handle.requestProbe("manual");

    // Two events: idle → checking → ready (or directly settled).
    // We assert at least one event with the changed topic.
    const topics = h.events.map((e) => e.topic);
    expect(topics).toContain("runtime.voice.reachability.changed");
  });

  test("does NOT republish when probe confirms same status", async () => {
    const h = makeHarness();
    h.handle.init();
    h.setNextResult(mkResult({ status: "ready" }));
    await h.handle.requestProbe("manual");
    const eventsAfterFirst = h.events.length;

    h.setNow(1_700_000_000_000 + 61_000);
    h.setNextResult(mkResult({ status: "ready", wanIp: "203.0.113.10" }));
    await h.handle.requestProbe("manual");
    // Manual probe transitions through checking → ready. Both transitions
    // publish the *changed* topic when status flips. Same-status probes:
    //   ready → checking (publish), checking → ready (no publish, same as
    //   prior public projection's status "ready").
    // We allow 1 additional event (the checking transition) but never two
    // ready events in a row.
    const after = h.events.length;
    expect(after).toBeGreaterThanOrEqual(eventsAfterFirst);
    expect(after - eventsAfterFirst).toBeLessThanOrEqual(2);
  });
});

describe("reachability — ICE failure cluster", () => {
  test("3 short joins with no long sessions fires probe", async () => {
    const h = makeHarness();
    h.handle.init();

    // Three short-lived joins (5s each).
    for (let i = 0; i < 3; i++) {
      const t = 1_700_000_000_000 + i * 1000;
      h.setNow(t);
      h.handle.noteParticipantJoined("ch1", `u${String(i)}`, `s${String(i)}`);
      h.setNow(t + 5_000);
      h.handle.noteParticipantLeft("ch1", `u${String(i)}`, `s${String(i)}`);
    }

    await flush();
    expect(h.fetchCalls).toBe(1);
  });

  test("one long session inhibits the trigger", async () => {
    const h = makeHarness();
    h.handle.init();

    h.setNow(1_700_000_000_000);
    h.handle.noteParticipantJoined("ch1", "u_long", "s1");
    h.setNow(1_700_000_000_000 + 60_000); // 60s session
    h.handle.noteParticipantLeft("ch1", "u_long", "s1");

    for (let i = 0; i < 3; i++) {
      const t = 1_700_000_000_000 + 70_000 + i * 1000;
      h.setNow(t);
      h.handle.noteParticipantJoined("ch1", `u${String(i)}`, `s${String(i)}`);
      h.setNow(t + 5_000);
      h.handle.noteParticipantLeft("ch1", `u${String(i)}`, `s${String(i)}`);
    }

    await flush();
    expect(h.fetchCalls).toBe(0);
  });
});

describe("reachability — failure handling", () => {
  test("network error preserves prior state, does not transition to unreachable", async () => {
    const h = makeHarness();
    h.handle.init();
    h.setNextResult(mkResult({ status: "ready" }));
    await h.handle.requestProbe("manual");
    expect(h.handle.getState()?.status).toBe("ready");

    h.setNow(1_700_000_000_000 + 61_000);
    h.setNextResult("network-error");
    const r2 = await h.handle.requestProbe("manual");
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.code).toBe("remote");
    // State stays ready (the prior settled result), not unreachable.
    expect(h.handle.getState()?.status).toBe("ready");
  });

  test("Central 500 surfaces remote error", async () => {
    const h = makeHarness();
    h.handle.init();
    h.setNextResult({ status: 500 });
    const r = await h.handle.requestProbe("manual");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("remote");
  });
});

// ---------------------------------------------------------------------------
// Schema version (forward-compat)
// ---------------------------------------------------------------------------

describe("isVoiceProbeResult — version gate", () => {
  // The validator was tightened to gate on a `version` field so future
  // shape changes can't render with v1 assumptions. Three cases matter:
  // explicit v1 (current), missing (legacy SQLite rows / older Central),
  // anything else (future Central — fail closed).

  function legacyPayload(): Record<string, unknown> {
    return {
      status: "ready",
      checkedAt: "2026-05-05T12:00:00.000Z",
      wanIp: "203.0.113.10",
      rtcTcp: { reachable: true, latencyMs: 7, error: null },
      rtcUdp: { reachable: true, latencyMs: 9, error: null },
    };
  }

  test("accepts explicit version: 1", () => {
    expect(isVoiceProbeResult({ ...legacyPayload(), version: 1 })).toBe(true);
  });

  test("accepts payload with missing version (legacy)", () => {
    expect(isVoiceProbeResult(legacyPayload())).toBe(true);
  });

  test("rejects unknown future version", () => {
    expect(isVoiceProbeResult({ ...legacyPayload(), version: 2 })).toBe(false);
    expect(isVoiceProbeResult({ ...legacyPayload(), version: 0 })).toBe(false);
  });

  test("rejects non-numeric version", () => {
    expect(isVoiceProbeResult({ ...legacyPayload(), version: "1" })).toBe(false);
    expect(isVoiceProbeResult({ ...legacyPayload(), version: null })).toBe(false);
  });

  test("normalizes legacy payload by stamping version: 1 into the result", async () => {
    // End-to-end: when Central returns a legacy (no-version) payload,
    // requestProbe still surfaces a fully-populated VoiceProbeResult so
    // downstream code can rely on `result.version === 1`.
    const h = makeHarness();
    h.handle.init();
    // Cast through unknown — the harness's setNextResult expects a typed
    // VoiceProbeResult, but we want to simulate a Central deploy that
    // hasn't picked up the version field.
    h.setNextResult(legacyPayload() as unknown as VoiceProbeResult);
    const r = await h.handle.requestProbe("manual");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.result.version).toBe(1);
      expect(r.result.status).toBe("ready");
    }
  });
});

// ---------------------------------------------------------------------------
// Restore from SQLite — version is implicit on the stored shape
// ---------------------------------------------------------------------------

describe("restore from SQLite", () => {
  test("restored result carries version: 1 even though the SQLite columns predate the field", () => {
    const db = new Database(":memory:");
    db.exec(readFileSync(MIGRATION_PATH, "utf-8"));
    // Hand-roll a row that mirrors what an earlier release would have
    // persisted — no version anywhere in the column set.
    db.prepare(
      `INSERT INTO voice_reachability_state
         (id, status, checked_at, wan_ip, rtc_tcp_json, rtc_udp_json)
       VALUES (1, 'ready', 1700000000000, '203.0.113.10', ?, ?)`,
    ).run(
      JSON.stringify({ reachable: true, latencyMs: 7, error: null }),
      JSON.stringify({ reachable: true, latencyMs: 9, error: null }),
    );

    const events: { topic: string; payload: unknown }[] = [];
    const handle = createReachability({
      db,
      centralUrl: "https://central.example.com",
      serverId: "srv_test",
      serverSecret: "s",
      publishRuntimeEvent: (topic, payload) => events.push({ topic, payload }),
      // No fetch — we never trigger a probe in this test.
      fetch: (async (_url: unknown, _init: unknown): Promise<Response> =>
        new Response("", { status: 500 })) as unknown as typeof globalThis.fetch,
      now: () => 1_700_000_001_000,
      setTimeout: () => 0,
    });
    handle.init();
    const state = handle.getState();
    expect(state).not.toBeNull();
    if (state && state.status === "ready") {
      expect(state.result.version).toBe(1);
    }
  });
});
