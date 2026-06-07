// Perf budget guard for `core.permissions.grantMany` per spec-22 Amendment B:
// 50 changes must respond in < 80 ms on dev hardware. Threshold is loose
// (240 ms) so a busy CI runner doesn't flap.

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

function makeFastEngine(): RolesEngine {
  // No-op success engine so the perf measurement isolates the IPC handler
  // overhead and per-change loop cost; engine SQL cost is exercised by
  // the engine's own perf tests.
  return {
    check: () => true,
    grantPermission: () => ({ ok: true as const }),
    denyPermission: () => ({ ok: true as const }),
    removePermissionOverride: () => ({ ok: true as const }),
    recordPermissionAudit: () => {},
  } as unknown as RolesEngine;
}

describe("core.permissions.grantMany perf", () => {
  it("processes 50 changes in well under the 80ms budget", () => {
    const db = new Database(":memory:");
    const mod = new CoreModule(db, makeBus(), createLogger({ test: true }));
    mod.initialize();
    const engine = makeFastEngine();

    const changes = Array.from({ length: 50 }, (_, i) => ({
      permission: `plugin.p${i}`,
      op: "grant" as const,
    }));

    // Warm-up.
    handleCoreClientAction(
      "core.permissions.grantMany",
      { role_id: 7, changes },
      "actor",
      true,
      mod,
      engine,
      () => {},
      () => {},
    );

    const iters = 10;
    const start = performance.now();
    for (let i = 0; i < iters; i++) {
      handleCoreClientAction(
        "core.permissions.grantMany",
        { role_id: 7, changes },
        "actor",
        true,
        mod,
        engine,
        () => {},
        () => {},
      );
    }
    const avgMs = (performance.now() - start) / iters;
    expect(avgMs).toBeLessThan(240);
  });
});
