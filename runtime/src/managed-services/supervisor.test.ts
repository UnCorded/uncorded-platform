import { describe, expect, test, beforeEach } from "bun:test";
import { BaseManagedServiceSupervisor } from "./supervisor";
import {
  registerSupervisor,
  isRegisteredService,
  listRegisteredServices,
  getSupervisor,
  __resetRegistryForTests,
} from "./registry";
import type { ServiceSlug } from "./types";

// ---------------------------------------------------------------------------
// MockSupervisor — records every doStart/doStop call and lets each test
// configure failures, latency, and stop behavior independently.
// ---------------------------------------------------------------------------

interface MockSupervisorConfig {
  startsToFail?: number; // first N starts will throw
  startError?: string;
  stopThrows?: boolean;
  startDelayMs?: number;
}

class MockSupervisor extends BaseManagedServiceSupervisor {
  starts = 0;
  stops = 0;
  startsCompleted = 0;
  cfg: MockSupervisorConfig;

  constructor(slug: ServiceSlug, cfg: MockSupervisorConfig = {}) {
    super(slug);
    this.cfg = cfg;
  }

  protected async doStart(): Promise<void> {
    this.starts += 1;
    if (this.cfg.startDelayMs) {
      await new Promise((r) => setTimeout(r, this.cfg.startDelayMs));
    }
    if ((this.cfg.startsToFail ?? 0) >= this.starts) {
      throw new Error(this.cfg.startError ?? "boom");
    }
    this.startsCompleted += 1;
  }

  protected async doStop(): Promise<void> {
    this.stops += 1;
    if (this.cfg.stopThrows) throw new Error("stop boom");
  }
}

// ---------------------------------------------------------------------------
// supervisor.ts — claim/release and lifecycle
// ---------------------------------------------------------------------------

describe("BaseManagedServiceSupervisor", () => {
  test("first claim spawns; release stops", async () => {
    const s = new MockSupervisor("svc");
    const claim = await s.claim({ pluginSlug: "p1" });
    expect(claim.ok).toBe(true);
    expect(s.state()).toBe("running");
    expect(s.starts).toBe(1);
    expect(s.claimerCount()).toBe(1);

    const release = await s.release({ pluginSlug: "p1" });
    expect(release.ok).toBe(true);
    expect(s.state()).toBe("stopped");
    expect(s.stops).toBe(1);
    expect(s.claimerCount()).toBe(0);
  });

  test("ref count: two plugins claim, second release stops", async () => {
    const s = new MockSupervisor("svc");
    await s.claim({ pluginSlug: "p1" });
    await s.claim({ pluginSlug: "p2" });
    expect(s.starts).toBe(1);
    expect(s.claimerCount()).toBe(2);
    expect(s.state()).toBe("running");

    await s.release({ pluginSlug: "p1" });
    // Still running — p2 holds a claim.
    expect(s.state()).toBe("running");
    expect(s.stops).toBe(0);

    await s.release({ pluginSlug: "p2" });
    expect(s.state()).toBe("stopped");
    expect(s.stops).toBe(1);
  });

  test("ref count: quarantined plugin releases, supervisor stays up", async () => {
    // Scenario from the PR-2 plan: two plugins claim the same service.
    // One of the plugins quarantines (the runtime then issues release on
    // its behalf). The other plugin still holds a claim, so the
    // supervisor must stay running.
    const s = new MockSupervisor("svc");
    await s.claim({ pluginSlug: "plugin-a" });
    await s.claim({ pluginSlug: "plugin-b" });
    expect(s.state()).toBe("running");
    expect(s.claimerCount()).toBe(2);

    // plugin-a quarantined — runtime releases its claim.
    await s.release({ pluginSlug: "plugin-a" });
    expect(s.state()).toBe("running");
    expect(s.claimerCount()).toBe(1);
    expect(s.stops).toBe(0);
    // The remaining claim from plugin-b keeps the service alive.
  });

  test("duplicate claims from the same plugin are idempotent", async () => {
    const s = new MockSupervisor("svc");
    await s.claim({ pluginSlug: "p1" });
    await s.claim({ pluginSlug: "p1" });
    expect(s.claimerCount()).toBe(1);
    expect(s.starts).toBe(1);
  });

  test("release without prior claim is a no-op success", async () => {
    const s = new MockSupervisor("svc");
    const r = await s.release({ pluginSlug: "ghost" });
    expect(r.ok).toBe(true);
    expect(s.state()).toBe("stopped");
    expect(s.stops).toBe(0);
  });

  test("doStart failure transitions to stopped (not quarantined) on first failure", async () => {
    const s = new MockSupervisor("svc", { startsToFail: 1 });
    const r = await s.claim({ pluginSlug: "p1" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("SERVICE_START_FAILED");
    }
    expect(s.state()).toBe("stopped");
    // Claim is still recorded so a future re-claim by anyone retries.
    expect(s.claimerCount()).toBe(1);
  });

  test("repeated start failures quarantine the service", async () => {
    const s = new MockSupervisor("svc", { startsToFail: 100 });
    for (let i = 0; i < 5; i++) {
      const r = await s.claim({ pluginSlug: `p${i}` });
      expect(r.ok).toBe(false);
    }
    expect(s.state()).toBe("quarantined");

    // Subsequent claims attach but don't auto-spawn.
    const r = await s.claim({ pluginSlug: "p999" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("SERVICE_QUARANTINED");
    }
    expect(s.starts).toBe(5);
  });

  test("shutdown clears claimers and stops the running service", async () => {
    const s = new MockSupervisor("svc");
    await s.claim({ pluginSlug: "p1" });
    await s.claim({ pluginSlug: "p2" });
    expect(s.state()).toBe("running");
    await s.shutdown();
    expect(s.state()).toBe("stopped");
    expect(s.claimerCount()).toBe(0);
    expect(s.stops).toBe(1);
  });

  test("shutdown resets failure tracker — fresh post-shutdown attempts get a clean slate", async () => {
    // Accumulate 4 failures (one shy of the quarantine threshold), then
    // shutdown. A subsequent re-claim that fails should not immediately
    // quarantine — the tracker must have been wiped by shutdown(). This
    // matches the user-visible contract: shutdown() is the documented
    // un-quarantine path.
    const s = new MockSupervisor("svc", { startsToFail: 4 });
    for (let i = 0; i < 4; i++) {
      const r = await s.claim({ pluginSlug: `p${i}` });
      expect(r.ok).toBe(false);
    }
    expect(s.state()).toBe("stopped"); // still under threshold

    await s.shutdown();
    expect(s.claimerCount()).toBe(0);

    // Now flip the mock to keep failing forever and accumulate 4 fresh
    // failures — should still be under threshold because the prior 4
    // failures were cleared by shutdown.
    s.cfg.startsToFail = 100;
    s.starts = 0; // reset so startsToFail logic fires the right number of times
    for (let i = 0; i < 4; i++) {
      const r = await s.claim({ pluginSlug: `q${i}` });
      expect(r.ok).toBe(false);
    }
    expect(s.state()).toBe("stopped");
    // The 5th fresh failure tips it into quarantine.
    const r = await s.claim({ pluginSlug: "q4" });
    expect(r.ok).toBe(false);
    expect(s.state()).toBe("quarantined");
  });

  test("concurrent claim and release serialize without overlap", async () => {
    const s = new MockSupervisor("svc", { startDelayMs: 30 });
    const a = s.claim({ pluginSlug: "p1" });
    const b = s.release({ pluginSlug: "p1" });
    await Promise.all([a, b]);
    // After both, claims = 0, so service should be stopped or have been
    // started-then-stopped. Either way, end state is consistent.
    expect(s.claimerCount()).toBe(0);
    expect(s.state() === "stopped" || s.state() === "running").toBe(true);
    // doStart may or may not have been called depending on which queued
    // op ran first — what matters is no overlap (every doStop happens
    // strictly after a matching doStart).
    expect(s.stops).toBeLessThanOrEqual(s.starts);
  });

  test("stop hook errors are swallowed — supervisor still ends in stopped", async () => {
    const s = new MockSupervisor("svc", { stopThrows: true });
    await s.claim({ pluginSlug: "p1" });
    await s.release({ pluginSlug: "p1" });
    expect(s.state()).toBe("stopped");
    expect(s.stops).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// registry.ts — static registration + manifest-validator surface
// ---------------------------------------------------------------------------

describe("managed-service registry", () => {
  beforeEach(() => {
    __resetRegistryForTests();
  });

  test("PR-2 default is empty", () => {
    expect(listRegisteredServices()).toEqual([]);
    expect(isRegisteredService("livekit")).toBe(false);
    expect(getSupervisor("livekit")).toBeUndefined();
  });

  test("registerSupervisor exposes the slug", () => {
    registerSupervisor("livekit", (slug) => new MockSupervisor(slug));
    expect(isRegisteredService("livekit")).toBe(true);
    expect(listRegisteredServices()).toEqual(["livekit"]);
    const inst = getSupervisor("livekit");
    expect(inst).toBeDefined();
    expect(inst!.slug).toBe("livekit");
  });

  test("registerSupervisor twice for the same slug throws", () => {
    registerSupervisor("livekit", (slug) => new MockSupervisor(slug));
    expect(() =>
      registerSupervisor("livekit", (slug) => new MockSupervisor(slug)),
    ).toThrow();
  });

  test("getSupervisor returns the same instance across calls", () => {
    registerSupervisor("svc", (slug) => new MockSupervisor(slug));
    const a = getSupervisor("svc");
    const b = getSupervisor("svc");
    expect(a).toBe(b);
  });
});
