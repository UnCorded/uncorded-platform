import { describe, expect, test, beforeEach } from "bun:test";
import { ScopedPresenceModule } from "./module";
import { PRESENCE_ERROR_CODES, PRESENCE_LIMITS } from "./types";
import { EventBus } from "../events/bus";
import { RateLimiter } from "../http/rate-limiter";
import { rootLogger } from "@uncorded/shared";
import { RUNTIME_PRESENCE_TOPICS } from "@uncorded/protocol";
import type { IpcMessage } from "../ipc/transport";
import type { PluginTransportProvider } from "../events/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface PublishCapture {
  topic: string;
  payload: unknown;
}

function makeFixture(opts?: {
  installedSlugs?: ReadonlySet<string>;
  now?: () => number;
  rateLimiter?: RateLimiter;
}) {
  const sentByPlugin = new Map<string, IpcMessage[]>();
  const transportProvider: PluginTransportProvider = {
    getTransport(slug: string) {
      let arr = sentByPlugin.get(slug);
      if (!arr) {
        arr = [];
        sentByPlugin.set(slug, arr);
      }
      // The provider's return type is the concrete StdioParentTransport, but
      // this test only exercises send/onMessage/close — duck-type and cast.
      return {
        send(msg: IpcMessage) { arr!.push(msg); },
        onMessage() {},
        close() {},
      } as unknown as ReturnType<PluginTransportProvider["getTransport"]>;
    },
    isPluginAlive() { return true; },
  };
  const bus = new EventBus(transportProvider);

  // Capture published events by intercepting publishRuntime.
  const published: PublishCapture[] = [];
  const originalPublishRuntime = bus.publishRuntime.bind(bus);
  bus.publishRuntime = (topic: string, payload: unknown, version?: number) => {
    published.push({ topic, payload });
    return originalPublishRuntime(topic, payload, version);
  };

  const rateLimiter = opts?.rateLimiter ?? new RateLimiter(opts?.now);
  const module = new ScopedPresenceModule(bus, rateLimiter, rootLogger, {
    installedSlugs: () => opts?.installedSlugs ?? new Set(["text-channels", "voice", "members"]),
    now: opts?.now ?? (() => 1000),
  });

  return { module, bus, rateLimiter, published };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe("ScopedPresenceModule — lifecycle", () => {
  test("join inserts entry and emits runtime.presence.joined", () => {
    const { module, published } = makeFixture();
    module.registerSession("c-1");

    const result = module.join("text-channels", "thread.a", "u-1", "c-1", { typing: true });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");

    expect(result.value.scope).toBe("text-channels.thread.a");
    expect(module.getRegistry().size()).toBe(1);
    const joined = published.filter((e) => e.topic === RUNTIME_PRESENCE_TOPICS.JOINED);
    expect(joined).toHaveLength(1);
    expect((joined[0]!.payload as Record<string, unknown>)["scope"]).toBe("text-channels.thread.a");
  });

  test("re-join with same (scope, user, session) is idempotent — emits UPDATED, refreshes meta", () => {
    let now = 1000;
    const { module, published } = makeFixture({ now: () => now });
    module.registerSession("c-1");

    module.join("text-channels", "thread.a", "u-1", "c-1", { typing: true });
    now = 2000;
    const r2 = module.join("text-channels", "thread.a", "u-1", "c-1", { typing: false });
    expect(r2.ok).toBe(true);
    if (!r2.ok) throw new Error("unreachable");
    expect(r2.value.joined_at).toBe(1000); // preserved
    expect(module.getRegistry().size()).toBe(1);
    const entry = module.getRegistry().get("text-channels.thread.a", "c-1");
    expect(entry?.meta).toEqual({ typing: false });
    expect(entry?.updated_at).toBe(2000);

    // First emit JOINED, second emit UPDATED.
    expect(published.map((e) => e.topic)).toEqual([
      RUNTIME_PRESENCE_TOPICS.JOINED,
      RUNTIME_PRESENCE_TOPICS.UPDATED,
    ]);
  });

  test("join rejects when session_id is not active — PRESENCE_SESSION_GONE", () => {
    const { module } = makeFixture();
    // Note: no registerSession call.
    const result = module.join("text-channels", "thread.a", "u-1", "c-missing", {});
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe(PRESENCE_ERROR_CODES.SESSION_GONE);
  });

  test("update no-ops when entry does not exist; otherwise replaces meta and emits UPDATED", () => {
    let now = 1000;
    const { module, published } = makeFixture({ now: () => now });
    module.registerSession("c-1");

    // No entry yet — no-op success.
    const noop = module.update("text-channels", "thread.a", "u-1", "c-1", { typing: true });
    expect(noop.ok).toBe(true);
    expect(module.getRegistry().size()).toBe(0);
    expect(published).toHaveLength(0);

    // Now join, then update.
    module.join("text-channels", "thread.a", "u-1", "c-1", { typing: true });
    now = 2000;
    const ok = module.update("text-channels", "thread.a", "u-1", "c-1", { typing: false });
    expect(ok.ok).toBe(true);
    expect(module.getRegistry().get("text-channels.thread.a", "c-1")?.meta).toEqual({ typing: false });

    const updated = published.filter((e) => e.topic === RUNTIME_PRESENCE_TOPICS.UPDATED);
    expect(updated).toHaveLength(1);
  });

  test("update with byte-identical meta still emits UPDATED and bumps updated_at", () => {
    let now = 1000;
    const { module, published } = makeFixture({ now: () => now });
    module.registerSession("c-1");

    module.join("text-channels", "thread.a", "u-1", "c-1", { x: 1 });
    now = 2000;
    module.update("text-channels", "thread.a", "u-1", "c-1", { x: 1 });

    expect(module.getRegistry().get("text-channels.thread.a", "c-1")?.updated_at).toBe(2000);
    const updated = published.filter((e) => e.topic === RUNTIME_PRESENCE_TOPICS.UPDATED);
    expect(updated).toHaveLength(1);
  });

  test("leave removes the entry and emits LEFT with reason explicit", () => {
    const { module, published } = makeFixture();
    module.registerSession("c-1");

    module.join("text-channels", "thread.a", "u-1", "c-1", {});
    const result = module.leave("text-channels", "thread.a", "u-1", "c-1");
    expect(result.ok).toBe(true);
    expect(module.getRegistry().size()).toBe(0);

    const left = published.filter((e) => e.topic === RUNTIME_PRESENCE_TOPICS.LEFT);
    expect(left).toHaveLength(1);
    expect((left[0]!.payload as Record<string, unknown>)["reason"]).toBe("explicit");
  });

  test("leave is no-op when user_id mismatches", () => {
    const { module, published } = makeFixture();
    module.registerSession("c-1");
    module.join("text-channels", "thread.a", "u-1", "c-1", {});

    const result = module.leave("text-channels", "thread.a", "u-other", "c-1");
    expect(result.ok).toBe(true);
    expect(module.getRegistry().size()).toBe(1);
    expect(published.filter((e) => e.topic === RUNTIME_PRESENCE_TOPICS.LEFT)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Eviction
// ---------------------------------------------------------------------------

describe("ScopedPresenceModule — eviction", () => {
  test("evictSession removes all of session's entries with reason session_closed", () => {
    const { module, published } = makeFixture();
    module.registerSession("c-1");
    module.registerSession("c-2");

    module.join("text-channels", "thread.a", "u-1", "c-1", {});
    module.join("text-channels", "thread.b", "u-1", "c-1", {});
    module.join("text-channels", "thread.a", "u-2", "c-2", {});

    module.evictSession("c-1");

    expect(module.getRegistry().size()).toBe(1);
    expect(module.isSessionActive("c-1")).toBe(false);
    expect(module.isSessionActive("c-2")).toBe(true);
    expect(module.getRegistry().get("text-channels.thread.a", "c-2")).toBeDefined();

    const lefts = published.filter((e) => e.topic === RUNTIME_PRESENCE_TOPICS.LEFT);
    expect(lefts).toHaveLength(2);
    for (const ev of lefts) {
      expect((ev.payload as Record<string, unknown>)["reason"]).toBe("session_closed");
      expect((ev.payload as Record<string, unknown>)["session_id"]).toBe("c-1");
    }
  });

  test("evictSession removes session from activeSessions BEFORE publishing LEFT (race fix)", () => {
    // Verifies the synchronous ordering claim that closes the join-after-close race.
    const { module } = makeFixture();
    module.registerSession("c-1");
    module.join("text-channels", "thread.a", "u-1", "c-1", {});

    module.evictSession("c-1");

    // Subsequent join must be rejected with SESSION_GONE — proves activeSessions
    // was cleared synchronously, not after an async event-publish hop.
    const r = module.join("text-channels", "thread.b", "u-1", "c-1", {});
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error.code).toBe(PRESENCE_ERROR_CODES.SESSION_GONE);
  });

  test("evictPlugin removes all of plugin's scopes with reason plugin_unloaded", () => {
    const { module, published } = makeFixture();
    module.registerSession("c-1");
    module.registerSession("c-2");

    module.join("text-channels", "thread.a", "u-1", "c-1", {});
    module.join("text-channels", "thread.b", "u-2", "c-2", {});

    module.evictPlugin("text-channels");

    expect(module.getRegistry().size()).toBe(0);
    // Sessions remain active.
    expect(module.isSessionActive("c-1")).toBe(true);
    expect(module.isSessionActive("c-2")).toBe(true);

    const lefts = published.filter((e) => e.topic === RUNTIME_PRESENCE_TOPICS.LEFT);
    expect(lefts).toHaveLength(2);
    for (const ev of lefts) {
      expect((ev.payload as Record<string, unknown>)["reason"]).toBe("plugin_unloaded");
    }
  });

  test("evictSession on session with no entries is a quiet no-op", () => {
    const { module, published } = makeFixture();
    module.registerSession("c-1");
    module.evictSession("c-1");
    expect(published).toHaveLength(0);
    expect(module.isSessionActive("c-1")).toBe(false);
  });

  test("evictPlugin on plugin with no entries is a quiet no-op", () => {
    const { module, published } = makeFixture();
    module.evictPlugin("text-channels");
    expect(published).toHaveLength(0);
  });

  test("multi-session same user produces independent entries with independent meta", () => {
    const { module } = makeFixture();
    module.registerSession("tab-1");
    module.registerSession("tab-2");

    module.join("text-channels", "thread.a", "u-1", "tab-1", { focused: true });
    module.join("text-channels", "thread.a", "u-1", "tab-2", { focused: false });

    expect(module.getRegistry().size()).toBe(2);
    expect(module.getRegistry().get("text-channels.thread.a", "tab-1")?.meta)
      .toEqual({ focused: true });
    expect(module.getRegistry().get("text-channels.thread.a", "tab-2")?.meta)
      .toEqual({ focused: false });
  });
});

// ---------------------------------------------------------------------------
// Validation: scope grammar + cross-plugin
// ---------------------------------------------------------------------------

describe("ScopedPresenceModule — scope validation", () => {
  let mod: ScopedPresenceModule;

  beforeEach(() => {
    mod = makeFixture({ installedSlugs: new Set(["text-channels", "voice", "excalidraw"]) }).module;
    mod.registerSession("c-1");
  });

  test("scope auto-prefixes with caller slug", () => {
    const r = mod.join("text-channels", "thread.t1.typing", "u-1", "c-1", {});
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.value.scope).toBe("text-channels.thread.t1.typing");
  });

  test("scope starting with another installed plugin's slug → CROSS_PLUGIN_SCOPE", () => {
    const r = mod.join("text-channels", "voice.room.x", "u-1", "c-1", {});
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error.code).toBe(PRESENCE_ERROR_CODES.CROSS_PLUGIN_SCOPE);
  });

  test("scope starting with caller's OWN slug → CROSS_PLUGIN_SCOPE (double-prefix prevention)", () => {
    const r = mod.join("text-channels", "text-channels.thread.x", "u-1", "c-1", {});
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error.code).toBe(PRESENCE_ERROR_CODES.CROSS_PLUGIN_SCOPE);
  });

  test("scope with no dots and not matching another slug → accepted (auto-prefixed)", () => {
    const r = mod.join("text-channels", "typing", "u-1", "c-1", {});
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.value.scope).toBe("text-channels.typing");
  });

  test("scope with first segment matching uninstalled plugin slug-shape → accepted", () => {
    const r = mod.join("text-channels", "hedgedoc.doc.x", "u-1", "c-1", {});
    // "hedgedoc" is not in installedSlugs, so it's just a path component.
    expect(r.ok).toBe(true);
  });

  test("scope > 200 chars after prefixing → SCOPE_LENGTH", () => {
    const long = "a".repeat(PRESENCE_LIMITS.SCOPE_LENGTH_MAX); // 200 chars; +14 prefix > 200
    const r = mod.join("text-channels", long, "u-1", "c-1", {});
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error.code).toBe(PRESENCE_ERROR_CODES.SCOPE_LENGTH);
  });

  test("scope with whitespace → SCOPE_INVALID", () => {
    const r = mod.join("text-channels", "thread a", "u-1", "c-1", {});
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error.code).toBe(PRESENCE_ERROR_CODES.SCOPE_INVALID);
  });

  test("scope with control char → SCOPE_INVALID", () => {
    const r = mod.join("text-channels", "thread\nfoo", "u-1", "c-1", {});
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error.code).toBe(PRESENCE_ERROR_CODES.SCOPE_INVALID);
  });

  test("empty scope → SCOPE_INVALID", () => {
    const r = mod.join("text-channels", "", "u-1", "c-1", {});
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error.code).toBe(PRESENCE_ERROR_CODES.SCOPE_INVALID);
  });
});

// ---------------------------------------------------------------------------
// Bounds: meta size + rate limit
// ---------------------------------------------------------------------------

describe("ScopedPresenceModule — bounds", () => {
  test("meta > 1024 bytes → META_TOO_LARGE", () => {
    const { module } = makeFixture();
    module.registerSession("c-1");
    const big = { blob: "x".repeat(2000) };
    const r = module.join("text-channels", "thread.a", "u-1", "c-1", big);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error.code).toBe(PRESENCE_ERROR_CODES.META_TOO_LARGE);
  });

  test("rate limit per (user, scope) — ~120 calls/sec", () => {
    // Use deterministic time so the bucket math is stable.
    let now = 1_000_000;
    const limiter = new RateLimiter(() => now);
    const { module } = makeFixture({ now: () => now, rateLimiter: limiter });
    module.registerSession("c-1");

    let lastError: string | undefined;
    for (let i = 0; i < 200; i++) {
      const r = module.join("text-channels", "thread.a", "u-1", "c-1", {});
      if (!r.ok) {
        lastError = r.error.code;
        break;
      }
    }
    expect(lastError).toBe(PRESENCE_ERROR_CODES.RATE_EXCEEDED);
  });

  test("rate limit is per (user, scope) — different scopes don't share budget", () => {
    let now = 1_000_000;
    const limiter = new RateLimiter(() => now);
    const { module } = makeFixture({ now: () => now, rateLimiter: limiter });
    module.registerSession("c-1");

    // Burn all 120 tokens on scope A.
    for (let i = 0; i < 120; i++) {
      module.join("text-channels", "thread.a", "u-1", "c-1", {});
    }
    // Scope B should still have a full budget.
    const r = module.join("text-channels", "thread.b", "u-1", "c-1", {});
    expect(r.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

describe("ScopedPresenceModule — list", () => {
  test("list returns all entries in a scope", () => {
    const { module } = makeFixture();
    module.registerSession("c-1");
    module.registerSession("c-2");
    module.join("text-channels", "thread.a", "u-1", "c-1", { typing: true });
    module.join("text-channels", "thread.a", "u-2", "c-2", { typing: false });

    const r = module.list("text-channels", "thread.a");
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.value).toHaveLength(2);
  });

  test("list returns empty array for unknown scope", () => {
    const { module } = makeFixture();
    const r = module.list("text-channels", "thread.a");
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.value).toEqual([]);
  });

  test("list rejects cross-plugin scope read", () => {
    const { module } = makeFixture();
    const r = module.list("text-channels", "voice.room.x");
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error.code).toBe(PRESENCE_ERROR_CODES.CROSS_PLUGIN_SCOPE);
  });
});
