// Perf budget guard for `core.member.list` per spec-22 Amendment B:
// a 200-row page must respond in < 20 ms on dev hardware. The threshold
// is loose (60 ms) here so a busy CI runner does not flap; the inner
// hot-path measurement is taken across multiple iterations to smooth out
// per-call jitter from the surrounding harness.

import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { CoreModule } from "./module";
import { handleCoreClientAction } from "./ipc";
import { createLogger } from "@uncorded/shared";
import type { EventBus } from "../events/bus";
import type { RolesEngine } from "../roles/engine";

function makeBus(): EventBus {
  return {
    publishRuntime() { return { ok: true as const, eventId: "mock" }; },
    publish() { return { ok: true as const, eventId: "mock" }; },
    subscribe() { return { ok: true as const }; },
    unsubscribe() { return { ok: true as const }; },
    getStats() { return {} as never; },
    getDeadLetters() { return []; },
  } as unknown as EventBus;
}

function makeEngine(): RolesEngine {
  return {
    hasMinLevel: () => true,
    getRoleIdsForUsers: () => new Map<string, number>(),
  } as unknown as RolesEngine;
}

describe("core.member.list perf", () => {
  it("returns a 200-row page in well under the 20ms budget", () => {
    const db = new Database(":memory:");
    const mod = new CoreModule(db, makeBus(), createLogger({ test: true }));
    mod.initialize();

    const insert = db.prepare("INSERT OR REPLACE INTO members (id, joined_at) VALUES (?, ?)");
    const upsertUser = db.prepare(
      "INSERT OR REPLACE INTO users (id, username, display_name, avatar_url, is_online, last_seen_at, connected_at) VALUES (?, ?, ?, '', 0, 0, 0)",
    );
    const txn = db.transaction(() => {
      for (let i = 0; i < 1000; i++) {
        const id = `u${i.toString().padStart(5, "0")}`;
        upsertUser.run(id, id, `User ${i}`);
        insert.run(id, 1_700_000_000_000 + i);
      }
    });
    txn();

    // Warm-up to JIT compile the prepared statement path.
    handleCoreClientAction(
      "core.member.list",
      { limit: 200 },
      "caller",
      false,
      mod,
      makeEngine(),
      () => {},
      () => {},
    );

    const iters = 20;
    const start = performance.now();
    for (let i = 0; i < iters; i++) {
      handleCoreClientAction(
        "core.member.list",
        { limit: 200 },
        "caller",
        false,
        mod,
        makeEngine(),
        () => {},
        () => {},
      );
    }
    const avgMs = (performance.now() - start) / iters;
    // Budget is 20 ms; pad to 60 ms so this guards the right order of
    // magnitude without flapping on a noisy CI box.
    expect(avgMs).toBeLessThan(60);
  });
});
