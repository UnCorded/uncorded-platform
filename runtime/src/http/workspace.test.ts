import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { CoreModule } from "../core";
import { createLogger } from "@uncorded/shared";
import {
  handleGetUserLayout,
  handlePutUserLayout,
  handleGetDefaultLayout,
  handlePutDefaultLayout,
  handleGetUserLayouts,
  handlePostUserLayout,
  handlePutUserLayoutById,
  handleDeleteUserLayout,
} from "./workspace";
import type { HttpDependencies } from "./types";
import type { TokenValidator, AuthenticatedUser, TokenValidationResult } from "../ws/types";
import type { RolesEngine } from "../roles/engine";
import type { EventBus } from "../events/bus";
import type { RateLimiter } from "./rate-limiter";
import type { WorkspaceLayout, SavedWorkspace } from "@uncorded/protocol";

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

const ADMIN: AuthenticatedUser = {
  id: "admin-1",
  username: "admin",
  displayName: "Admin",
  avatarUrl: "",
  role: "admin",
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
      const levels: Record<string, number> = {
        "admin-1": 80,
        "member-1": 10,
      };
      return (levels[caller.userId] ?? 0) >= level;
    },
  } as unknown as RolesEngine;
}

function makeDeps(coreModule: CoreModule, extra?: Partial<HttpDependencies>): HttpDependencies {
  const tokens = new Map<string, AuthenticatedUser>([
    ["member-token", MEMBER],
    ["admin-token", ADMIN],
  ]);
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
    broadcastEventToUser: () => {},
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
    ...extra,
  };
}

const VALID_LAYOUT: WorkspaceLayout = {
  version: 1,
  root: { type: "leaf", id: "panel-1" },
  panels: {
    "panel-1": {
      type: "plugin",
      serverId: "srv1",
      tunnelUrl: "https://example.com",
      slug: "text-channels",
      itemId: "ch1",
      itemLabel: "general",
    },
  },
};

/** Mock rate limiter that always allows requests. */
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
  const init: RequestInit = {
    method,
    headers: authHeaders(token),
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  return new Request(`http://localhost${path}`, init);
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let coreModule: CoreModule;
let deps: HttpDependencies;

beforeEach(() => {
  const db = new Database(":memory:");
  coreModule = new CoreModule(db, makeBus(), createLogger({ test: true }));
  coreModule.initialize();
  deps = makeDeps(coreModule);
});

// ---------------------------------------------------------------------------
// GET /workspace/layout
// ---------------------------------------------------------------------------

describe("GET /workspace/layout", () => {
  it("401 without token", async () => {
    const req = new Request("http://localhost/workspace/layout");
    const res = await handleGetUserLayout(req, {}, deps, rl);
    expect(res.status).toBe(401);
  });

  it("returns platform default when no layout saved", async () => {
    const req = makeRequest("GET", "/workspace/layout", "member-token");
    const res = await handleGetUserLayout(req, {}, deps, rl);
    expect(res.status).toBe(200);
    const body = await res.json() as { layout: WorkspaceLayout };
    expect(body.layout.version).toBe(1);
  });

  it("returns saved layout after PUT", async () => {
    // Save first.
    const put = makeRequest("PUT", "/workspace/layout", "member-token", { layout: VALID_LAYOUT });
    await handlePutUserLayout(put, {}, deps, rl);

    const get = makeRequest("GET", "/workspace/layout", "member-token");
    const res = await handleGetUserLayout(get, {}, deps, rl);
    const body = await res.json() as { layout: WorkspaceLayout };
    const p1 = body.layout.panels["panel-1"];
    expect(p1?.type === "plugin" && p1.itemLabel).toBe("general");
  });
});

// ---------------------------------------------------------------------------
// PUT /workspace/layout
// ---------------------------------------------------------------------------

describe("PUT /workspace/layout", () => {
  it("401 without token", async () => {
    const req = new Request("http://localhost/workspace/layout", { method: "PUT" });
    const res = await handlePutUserLayout(req, {}, deps, rl);
    expect(res.status).toBe(401);
  });

  it("400 for invalid JSON", async () => {
    const req = new Request("http://localhost/workspace/layout", {
      method: "PUT",
      headers: { Authorization: "Bearer member-token", "Content-Type": "application/json" },
      body: "not json",
    });
    const res = await handlePutUserLayout(req, {}, deps, rl);
    expect(res.status).toBe(400);
  });

  it("400 for invalid layout", async () => {
    const req = makeRequest("PUT", "/workspace/layout", "member-token", {
      layout: { version: 2, root: { type: "leaf", id: "p1" }, panels: { p1: {} } },
    });
    const res = await handlePutUserLayout(req, {}, deps, rl);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("LAYOUT_INVALID_VERSION");
  });

  it("200 for valid layout", async () => {
    const req = makeRequest("PUT", "/workspace/layout", "member-token", { layout: VALID_LAYOUT });
    const res = await handlePutUserLayout(req, {}, deps, rl);
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// GET /workspace/default
// ---------------------------------------------------------------------------

describe("GET /workspace/default", () => {
  it("401 without token", async () => {
    const req = new Request("http://localhost/workspace/default");
    const res = await handleGetDefaultLayout(req, {}, deps, rl);
    expect(res.status).toBe(401);
  });

  it("returns platform default layout", async () => {
    const req = makeRequest("GET", "/workspace/default", "member-token");
    const res = await handleGetDefaultLayout(req, {}, deps, rl);
    expect(res.status).toBe(200);
    const body = await res.json() as { layout: WorkspaceLayout };
    expect(body.layout.version).toBe(1);
  });

  it("returns server default after admin sets it", async () => {
    const put = makeRequest("PUT", "/workspace/default", "admin-token", { layout: VALID_LAYOUT });
    await handlePutDefaultLayout(put, {}, deps, rl);

    const get = makeRequest("GET", "/workspace/default", "member-token");
    const res = await handleGetDefaultLayout(get, {}, deps, rl);
    const body = await res.json() as { layout: WorkspaceLayout };
    const p1 = body.layout.panels["panel-1"];
    expect(p1?.type === "plugin" && p1.itemLabel).toBe("general");
  });
});

// ---------------------------------------------------------------------------
// PUT /workspace/default
// ---------------------------------------------------------------------------

describe("PUT /workspace/default", () => {
  it("401 without token", async () => {
    const req = new Request("http://localhost/workspace/default", { method: "PUT" });
    const res = await handlePutDefaultLayout(req, {}, deps, rl);
    expect(res.status).toBe(401);
  });

  it("403 for member (level 10 < 80)", async () => {
    const req = makeRequest("PUT", "/workspace/default", "member-token", { layout: VALID_LAYOUT });
    const res = await handlePutDefaultLayout(req, {}, deps, rl);
    expect(res.status).toBe(403);
  });

  it("200 for admin", async () => {
    const req = makeRequest("PUT", "/workspace/default", "admin-token", { layout: VALID_LAYOUT });
    const res = await handlePutDefaultLayout(req, {}, deps, rl);
    expect(res.status).toBe(200);
  });

  it("400 for invalid layout", async () => {
    const req = makeRequest("PUT", "/workspace/default", "admin-token", {
      layout: { version: 1, root: { type: "leaf", id: "p1" }, panels: {} },
    });
    const res = await handlePutDefaultLayout(req, {}, deps, rl);
    // p1 leaf has no entry in panels
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// GET /workspace/layouts
// ---------------------------------------------------------------------------

describe("GET /workspace/layouts", () => {
  it("401 without token", async () => {
    const req = new Request("http://localhost/workspace/layouts");
    const res = await handleGetUserLayouts(req, {}, deps, rl);
    expect(res.status).toBe(401);
  });

  it("returns empty array when no workspaces saved", async () => {
    const req = makeRequest("GET", "/workspace/layouts", "member-token");
    const res = await handleGetUserLayouts(req, {}, deps, rl);
    expect(res.status).toBe(200);
    const body = await res.json() as { layouts: SavedWorkspace[] };
    expect(body.layouts).toEqual([]);
  });

  it("returns saved workspaces after POST", async () => {
    const post = makeRequest("POST", "/workspace/layouts", "member-token", {
      name: "My workspace",
      layout: VALID_LAYOUT,
    });
    await handlePostUserLayout(post, {}, deps, rl);

    const get = makeRequest("GET", "/workspace/layouts", "member-token");
    const res = await handleGetUserLayouts(get, {}, deps, rl);
    const body = await res.json() as { layouts: SavedWorkspace[] };
    expect(body.layouts).toHaveLength(1);
    expect(body.layouts[0]?.name).toBe("My workspace");
    const savedPanel = body.layouts[0]?.layout.panels["panel-1"];
    expect(savedPanel?.type === "plugin" && savedPanel.itemLabel).toBe("general");
  });
});

// ---------------------------------------------------------------------------
// POST /workspace/layouts
// ---------------------------------------------------------------------------

describe("POST /workspace/layouts", () => {
  it("401 without token", async () => {
    const req = new Request("http://localhost/workspace/layouts", { method: "POST" });
    const res = await handlePostUserLayout(req, {}, deps, rl);
    expect(res.status).toBe(401);
  });

  it("400 for invalid layout", async () => {
    const req = makeRequest("POST", "/workspace/layouts", "member-token", {
      layout: { version: 2, root: { type: "leaf", id: "p1" }, panels: { p1: {} } },
    });
    const res = await handlePostUserLayout(req, {}, deps, rl);
    expect(res.status).toBe(400);
  });

  it("201 with valid layout and no name", async () => {
    const req = makeRequest("POST", "/workspace/layouts", "member-token", {
      layout: VALID_LAYOUT,
    });
    const res = await handlePostUserLayout(req, {}, deps, rl);
    expect(res.status).toBe(201);
    const body = await res.json() as { layout: SavedWorkspace };
    expect(body.layout.id).toBeDefined();
    expect(body.layout.name).toBeNull();
  });

  it("201 with valid layout and name", async () => {
    const req = makeRequest("POST", "/workspace/layouts", "member-token", {
      name: "Work",
      layout: VALID_LAYOUT,
    });
    const res = await handlePostUserLayout(req, {}, deps, rl);
    expect(res.status).toBe(201);
    const body = await res.json() as { layout: SavedWorkspace };
    expect(body.layout.name).toBe("Work");
  });

  it("409 when cap of 5 is reached", async () => {
    for (let i = 0; i < 5; i++) {
      const req = makeRequest("POST", "/workspace/layouts", "member-token", {
        layout: VALID_LAYOUT,
      });
      const res = await handlePostUserLayout(req, {}, deps, rl);
      expect(res.status).toBe(201);
    }
    const req = makeRequest("POST", "/workspace/layouts", "member-token", {
      layout: VALID_LAYOUT,
    });
    const res = await handlePostUserLayout(req, {}, deps, rl);
    expect(res.status).toBe(409);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("WORKSPACE_CAP_REACHED");
  });
});

// ---------------------------------------------------------------------------
// PUT /workspace/layouts/:id
// ---------------------------------------------------------------------------

describe("PUT /workspace/layouts/:id", () => {
  it("401 without token", async () => {
    const req = new Request("http://localhost/workspace/layouts/abc", { method: "PUT" });
    const res = await handlePutUserLayoutById(req, { id: "abc" }, deps, rl);
    expect(res.status).toBe(401);
  });

  it("404 for unknown id", async () => {
    const req = makeRequest("PUT", "/workspace/layouts/nonexistent", "member-token", { name: "x" });
    const res = await handlePutUserLayoutById(req, { id: "nonexistent" }, deps, rl);
    expect(res.status).toBe(404);
  });

  it("200 rename", async () => {
    const post = makeRequest("POST", "/workspace/layouts", "member-token", {
      name: "Old name",
      layout: VALID_LAYOUT,
    });
    const created = await (await handlePostUserLayout(post, {}, deps, rl)).json() as { layout: SavedWorkspace };
    const id = created.layout.id;

    const put = makeRequest("PUT", `/workspace/layouts/${id}`, "member-token", { name: "New name" });
    const res = await handlePutUserLayoutById(put, { id }, deps, rl);
    expect(res.status).toBe(200);

    const get = makeRequest("GET", "/workspace/layouts", "member-token");
    const list = await (await handleGetUserLayouts(get, {}, deps, rl)).json() as { layouts: SavedWorkspace[] };
    expect(list.layouts[0]?.name).toBe("New name");
  });

  it("400 for invalid layout in PUT", async () => {
    const post = makeRequest("POST", "/workspace/layouts", "member-token", { layout: VALID_LAYOUT });
    const created = await (await handlePostUserLayout(post, {}, deps, rl)).json() as { layout: SavedWorkspace };
    const id = created.layout.id;

    const put = makeRequest("PUT", `/workspace/layouts/${id}`, "member-token", {
      layout: { version: 2, root: { type: "leaf", id: "x" }, panels: {} },
    });
    const res = await handlePutUserLayoutById(put, { id }, deps, rl);
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// DELETE /workspace/layouts/:id
// ---------------------------------------------------------------------------

describe("DELETE /workspace/layouts/:id", () => {
  it("401 without token", async () => {
    const req = new Request("http://localhost/workspace/layouts/abc", { method: "DELETE" });
    const res = await handleDeleteUserLayout(req, { id: "abc" }, deps, rl);
    expect(res.status).toBe(401);
  });

  it("404 for unknown id", async () => {
    const req = makeRequest("DELETE", "/workspace/layouts/nonexistent", "member-token");
    const res = await handleDeleteUserLayout(req, { id: "nonexistent" }, deps, rl);
    expect(res.status).toBe(404);
  });

  it("200 and removes workspace from list", async () => {
    const post = makeRequest("POST", "/workspace/layouts", "member-token", { layout: VALID_LAYOUT });
    const created = await (await handlePostUserLayout(post, {}, deps, rl)).json() as { layout: SavedWorkspace };
    const id = created.layout.id;

    const del = makeRequest("DELETE", `/workspace/layouts/${id}`, "member-token");
    const res = await handleDeleteUserLayout(del, { id }, deps, rl);
    expect(res.status).toBe(200);

    const get = makeRequest("GET", "/workspace/layouts", "member-token");
    const list = await (await handleGetUserLayouts(get, {}, deps, rl)).json() as { layouts: SavedWorkspace[] };
    expect(list.layouts).toHaveLength(0);
  });

  it("cannot delete another user's workspace", async () => {
    const post = makeRequest("POST", "/workspace/layouts", "member-token", { layout: VALID_LAYOUT });
    const created = await (await handlePostUserLayout(post, {}, deps, rl)).json() as { layout: SavedWorkspace };
    const id = created.layout.id;

    const del = makeRequest("DELETE", `/workspace/layouts/${id}`, "admin-token");
    const res = await handleDeleteUserLayout(del, { id }, deps, rl);
    expect(res.status).toBe(404);
  });
});
