import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { CoreModule } from "../core";
import { createLogger } from "@uncorded/shared";
import {
  handleGetBrowserRecent,
  handlePutBrowserRecent,
} from "./browser-recent";
import type { HttpDependencies } from "./types";
import type { TokenValidator, AuthenticatedUser, TokenValidationResult } from "../ws/types";
import type { RolesEngine } from "../roles/engine";
import type { EventBus } from "../events/bus";
import type { RateLimiter } from "./rate-limiter";
import type { BrowserRecentEntry } from "@uncorded/protocol";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MEMBER: AuthenticatedUser = {
  id: "member-1",
  username: "member",
  displayName: "Member",
  avatarUrl: "",
  role: "member",
};

function makeBus(): EventBus {
  return {
    publishRuntime() { return { ok: true as const, eventId: "x" }; },
    publish() { return { ok: true as const, eventId: "x" }; },
    subscribe() { return { ok: true as const }; },
    unsubscribe() { return { ok: true as const }; },
    getStats() { return {} as never; },
    getDeadLetters() { return []; },
  } as unknown as EventBus;
}

function makeTokenValidator(tokens: Map<string, AuthenticatedUser>): TokenValidator {
  return {
    async validate(token: string): Promise<TokenValidationResult> {
      const user = tokens.get(token);
      if (user) return { ok: true, user };
      return { ok: false, code: "INVALID_TOKEN", message: "invalid" };
    },
  };
}

function makeRolesEngine(): RolesEngine {
  return {
    hasMinLevel(_userId: string, level: number, caller: { userId: string; isOwner: boolean }): boolean {
      if (caller.isOwner) return true;
      const levels: Record<string, number> = { "member-1": 10 };
      return (levels[caller.userId] ?? 0) >= level;
    },
  } as unknown as RolesEngine;
}

interface BroadcastEntry {
  userId: string;
  topic: string;
  payload: unknown;
}

function makeDeps(
  coreModule: CoreModule,
  broadcasts: BroadcastEntry[],
): HttpDependencies {
  const tokens = new Map<string, AuthenticatedUser>([["member-token", MEMBER]]);
  return {
    tokenValidator: makeTokenValidator(tokens),
    rolesEngine: makeRolesEngine(),
    coreModule,
    coreDb: null as never,
    pluginRegistry: null as never,
    getInstalledPlugins: () => [],
    getPluginRuntimeState: () => undefined,
    getPluginLogs: () => [],
    stopPlugin: () => Promise.resolve(),
    config: {
      isPrivate: false,
      maxUploadBytes: 1024 * 1024,
      startedAt: Date.now(),
      serverName: "Test",
      serverDescription: "",
    },
    notifyPlugin: () => {},
    getPluginProcess: () => undefined,
    getPluginDb: () => { throw new Error("getPluginDb not stubbed in this test"); },
    getClientIp: () => "127.0.0.1",
    broadcastEventToUser: (userId, topic, payload) => {
      broadcasts.push({ userId, topic, payload });
    },
    broadcastEvent: () => {},
    areKeysStale: () => false,
    allowedOrigins: [],
    runtimeVersion: "1.0.0-test",
    getUpdateState: () => ({
      state: "idle",
      errorContext: null,
      currentVersion: "1.0.0-test",
      availableVersion: null,
      channel: "stable",
      progress: null,
      lastCheckedAt: null,
      errorMessage: null,
      updatedAt: 0,
    }),
    setUpdateState: (patch) => ({
      state: "idle",
      errorContext: null,
      currentVersion: "1.0.0-test",
      availableVersion: null,
      channel: "stable",
      progress: null,
      lastCheckedAt: null,
      errorMessage: null,
      updatedAt: 0,
      ...patch,
    }),
    getUpdateLog: () => [],
  };
}

function makeRateLimiter(): RateLimiter {
  return {
    consume() { return { allowed: true, retryAfterMs: 0 }; },
    isBanned() { return { banned: false, retryAfterMs: 0 }; },
    recordAuthFailure() {},
    recordAuthSuccess() {},
    dispose() {},
  } as unknown as RateLimiter;
}

const rl = makeRateLimiter();

function authHeaders(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

function makeRequest(method: string, path: string, token: string, body?: unknown): Request {
  const init: RequestInit = { method, headers: authHeaders(token) };
  if (body !== undefined) init.body = JSON.stringify(body);
  return new Request(`http://localhost${path}`, init);
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let coreModule: CoreModule;
let deps: HttpDependencies;
let broadcasts: BroadcastEntry[];

beforeEach(() => {
  const db = new Database(":memory:");
  coreModule = new CoreModule(db, makeBus(), createLogger({ test: true }));
  coreModule.initialize();
  broadcasts = [];
  deps = makeDeps(coreModule, broadcasts);
});

// ---------------------------------------------------------------------------
// GET /browser/recent
// ---------------------------------------------------------------------------

describe("GET /browser/recent", () => {
  it("401 without token", async () => {
    const req = new Request("http://localhost/browser/recent");
    const res = await handleGetBrowserRecent(req, {}, deps, rl);
    expect(res.status).toBe(401);
  });

  it("returns empty array when nothing saved", async () => {
    const req = makeRequest("GET", "/browser/recent", "member-token");
    const res = await handleGetBrowserRecent(req, {}, deps, rl);
    expect(res.status).toBe(200);
    const body = await res.json() as { recent: BrowserRecentEntry[] };
    expect(body.recent).toEqual([]);
  });

  it("returns saved list after PUT", async () => {
    const entries: BrowserRecentEntry[] = [
      { title: "Example", url: "https://example.com/" },
    ];
    const put = makeRequest("PUT", "/browser/recent", "member-token", { recent: entries });
    await handlePutBrowserRecent(put, {}, deps, rl);

    const get = makeRequest("GET", "/browser/recent", "member-token");
    const res = await handleGetBrowserRecent(get, {}, deps, rl);
    const body = await res.json() as { recent: BrowserRecentEntry[] };
    expect(body.recent).toEqual(entries);
  });
});

// ---------------------------------------------------------------------------
// PUT /browser/recent
// ---------------------------------------------------------------------------

describe("PUT /browser/recent", () => {
  it("401 without token", async () => {
    const req = new Request("http://localhost/browser/recent", { method: "PUT" });
    const res = await handlePutBrowserRecent(req, {}, deps, rl);
    expect(res.status).toBe(401);
  });

  it("400 for invalid JSON", async () => {
    const req = new Request("http://localhost/browser/recent", {
      method: "PUT",
      headers: { Authorization: "Bearer member-token", "Content-Type": "application/json" },
      body: "not json",
    });
    const res = await handlePutBrowserRecent(req, {}, deps, rl);
    expect(res.status).toBe(400);
  });

  it("400 when recent is missing", async () => {
    const req = makeRequest("PUT", "/browser/recent", "member-token", {});
    const res = await handlePutBrowserRecent(req, {}, deps, rl);
    expect(res.status).toBe(400);
  });

  it("400 when an entry has empty url", async () => {
    const req = makeRequest("PUT", "/browser/recent", "member-token", {
      recent: [{ title: "x", url: "" }],
    });
    const res = await handlePutBrowserRecent(req, {}, deps, rl);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("LAYOUT_INVALID_PANEL_FIELD");
  });

  it("400 when list exceeds the global cap", async () => {
    const recent = Array.from({ length: 21 }, (_, i) => ({
      title: `t${i}`,
      url: `https://example.com/${i}`,
    }));
    const req = makeRequest("PUT", "/browser/recent", "member-token", { recent });
    const res = await handlePutBrowserRecent(req, {}, deps, rl);
    expect(res.status).toBe(400);
  });

  it("200 for a valid list", async () => {
    const req = makeRequest("PUT", "/browser/recent", "member-token", {
      recent: [{ title: "Example", url: "https://example.com/" }],
    });
    const res = await handlePutBrowserRecent(req, {}, deps, rl);
    expect(res.status).toBe(200);
  });

  it("broadcasts browser_recent:updated with editor_id echoed", async () => {
    const req = makeRequest("PUT", "/browser/recent", "member-token", {
      recent: [{ title: "Ex", url: "https://example.com/" }],
      editor_id: "tab-123",
    });
    await handlePutBrowserRecent(req, {}, deps, rl);
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]).toMatchObject({
      userId: "member-1",
      topic: "browser_recent:updated",
    });
    const payload = broadcasts[0]!.payload as { editor_id: string | null };
    expect(payload.editor_id).toBe("tab-123");
  });

  it("broadcast carries null editor_id when not provided", async () => {
    const req = makeRequest("PUT", "/browser/recent", "member-token", {
      recent: [{ title: "Ex", url: "https://example.com/" }],
    });
    await handlePutBrowserRecent(req, {}, deps, rl);
    const payload = broadcasts[0]!.payload as { editor_id: string | null };
    expect(payload.editor_id).toBeNull();
  });
});
