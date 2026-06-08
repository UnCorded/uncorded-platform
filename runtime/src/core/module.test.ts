import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { CoreModule } from "./module";
import { CORE_TOPICS } from "@uncorded/protocol";
import type { EventBus } from "../events/bus";
import { createLogger } from "@uncorded/shared";

// ---------------------------------------------------------------------------
// Minimal EventBus mock
// ---------------------------------------------------------------------------

interface Published {
  topic: string;
  payload: unknown;
}

function makeMockBus(): EventBus & { published: Published[] } {
  const published: Published[] = [];
  return {
    published,
    publishRuntime(topic: string, payload: unknown) {
      published.push({ topic, payload });
      return { ok: true as const, eventId: "mock" };
    },
    publish() { return { ok: true as const, eventId: "mock" }; },
    subscribe() { return { ok: true as const }; },
    unsubscribe() { return { ok: true as const }; },
    getStats() { return {} as never; },
    getDeadLetters() { return []; },
  } as unknown as EventBus & { published: Published[] };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeModule() {
  const db = new Database(":memory:");
  const bus = makeMockBus();
  const log = createLogger({ test: true });
  const mod = new CoreModule(db, bus as EventBus, log);
  mod.initialize();
  return { mod, db, bus };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CoreModule.initialize", () => {
  it("runs migrations and resets online flags", () => {
    const { mod, db } = makeModule();

    // Tables should exist
    const tables = db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => r.name);

    expect(tables).toContain("users");
    expect(tables).toContain("workspace_layouts");
    expect(tables).toContain("server_default_layout");
  });

  it("seeds the platform-default layout row", () => {
    const { mod } = makeModule();
    const layout = mod.getDefaultLayout();
    expect(layout.version).toBe(1);
    expect(layout.root.type).toBe("leaf");
  });

  it("is idempotent — can call initialize twice", () => {
    const db = new Database(":memory:");
    const bus = makeMockBus();
    const log = createLogger({ test: true });
    const mod = new CoreModule(db, bus as EventBus, log);
    mod.initialize();
    // Second call must not throw.
    expect(() => mod.initialize()).not.toThrow();
  });
});

describe("CoreModule.onUserConnected", () => {
  it("upserts user, marks online, publishes core.user.online", () => {
    const { mod, bus } = makeModule();
    mod.onUserConnected("u1", "alice", "Alice", "https://example.com/a.jpg");

    const user = mod.getUser("u1");
    expect(user).not.toBeNull();
    expect(user?.display_name).toBe("Alice");
    expect(user?.is_online).toBe(true);

    const evt = bus.published.find((p) => p.topic === CORE_TOPICS.USER_ONLINE);
    expect(evt).toBeDefined();
    expect((evt?.payload as Record<string, unknown>)["id"]).toBe("u1");
  });

  it("updates profile on reconnect", () => {
    const { mod } = makeModule();
    mod.onUserConnected("u1", "alice", "Alice", "https://example.com/old.jpg");
    mod.onUserConnected("u1", "alice", "Alice V2", "https://example.com/new.jpg");

    const user = mod.getUser("u1");
    expect(user?.display_name).toBe("Alice V2");
    expect(user?.is_online).toBe(true);
  });
});

describe("CoreModule.onUserDisconnected", () => {
  it("marks offline, publishes core.user.offline", () => {
    const { mod, bus } = makeModule();
    mod.onUserConnected("u1", "alice", "Alice", "");
    mod.onUserDisconnected("u1");

    const user = mod.getUser("u1");
    expect(user?.is_online).toBe(false);

    const evt = bus.published.find((p) => p.topic === CORE_TOPICS.USER_OFFLINE);
    expect(evt).toBeDefined();
    expect((evt?.payload as Record<string, unknown>)["id"]).toBe("u1");
  });
});

describe("CoreModule.onUserProfileChanged", () => {
  it("updates name + avatar, publishes core.user.updated", () => {
    const { mod, bus } = makeModule();
    mod.onUserConnected("u1", "alice", "Alice", "https://example.com/old.jpg");
    mod.onUserProfileChanged("u1", "alice", "Alice New", "https://example.com/new.jpg");

    const user = mod.getUser("u1");
    expect(user?.display_name).toBe("Alice New");
    expect(user?.avatar_url).toBe("https://example.com/new.jpg");

    const evt = bus.published.find((p) => p.topic === CORE_TOPICS.USER_UPDATED);
    expect(evt).toBeDefined();
  });
});

describe("CoreModule.onUserDeleted", () => {
  it("tombstones user, publishes core.user.deleted", () => {
    const { mod, bus } = makeModule();
    mod.onUserConnected("u1", "alice", "Alice", "");
    mod.onUserDeleted("u1");

    const user = mod.getUser("u1");
    expect(user?.display_name).toBe("[deleted]");
    expect(user?.is_online).toBe(false);

    const evt = bus.published.find((p) => p.topic === CORE_TOPICS.USER_DELETED);
    expect(evt).toBeDefined();
  });
});

describe("CoreModule getUsers / getOnlineUsers", () => {
  it("getUsers returns subset by ids", () => {
    const { mod } = makeModule();
    mod.onUserConnected("u1", "alice", "Alice", "");
    mod.onUserConnected("u2", "bob", "Bob", "");
    mod.onUserConnected("u3", "carol", "Carol", "");

    const users = mod.getUsers(["u1", "u3"]);
    expect(users).toHaveLength(2);
    const names = users.map((u) => u.display_name).sort();
    expect(names).toEqual(["Alice", "Carol"]);
  });

  it("getOnlineUsers returns only online", () => {
    const { mod } = makeModule();
    mod.onUserConnected("u1", "alice", "Alice", "");
    mod.onUserConnected("u2", "bob", "Bob", "");
    mod.onUserDisconnected("u2");

    const online = mod.getOnlineUsers();
    expect(online).toHaveLength(1);
    expect(online[0]?.id).toBe("u1");
  });
});

describe("CoreModule workspace layouts", () => {
  it("getUserLayout returns default when no user layout saved", () => {
    const { mod } = makeModule();
    const layout = mod.getUserLayout("u1");
    expect(layout.version).toBe(1);
  });

  it("setUserLayout and getUserLayout roundtrip", () => {
    const { mod } = makeModule();
    mod.onUserConnected("u1", "alice", "Alice", "");

    const layout = {
      version: 1 as const,
      root: { type: "leaf" as const, id: "panel1" },
      panels: {
        panel1: {
          type: "plugin" as const,
          serverId: "srv1",
          tunnelUrl: "https://example.com",
          slug: "text-channels",
          itemId: "ch1",
          itemLabel: "general",
        },
      },
    };

    mod.setUserLayout("u1", layout);
    const fetched = mod.getUserLayout("u1");
    expect(fetched.root.type).toBe("leaf");
    const panel1 = fetched.panels["panel1"];
    expect(panel1?.type === "plugin" && panel1.itemLabel).toBe("general");
  });

  it("setDefaultLayout is returned by getDefaultLayout", () => {
    const { mod } = makeModule();
    const layout = {
      version: 1 as const,
      root: { type: "leaf" as const, id: "admin-panel" },
      panels: {
        "admin-panel": {
          type: "plugin" as const,
          serverId: "srv1",
          tunnelUrl: "https://example.com",
          slug: "text-channels",
          itemId: "ch99",
          itemLabel: "announcements",
        },
      },
    };

    mod.setDefaultLayout(layout, "owner1");
    const fetched = mod.getDefaultLayout();
    const adminPanel = fetched.panels["admin-panel"];
    expect(adminPanel?.type === "plugin" && adminPanel.itemLabel).toBe("announcements");
  });

  it("getUserLayout falls back to server default", () => {
    const { mod } = makeModule();
    const defaultLayout = {
      version: 1 as const,
      root: { type: "leaf" as const, id: "def" },
      panels: {
        def: {
          type: "plugin" as const,
          serverId: "srv1",
          tunnelUrl: "https://example.com",
          slug: "text-channels",
          itemId: "ch1",
          itemLabel: "default-channel",
        },
      },
    };

    mod.setDefaultLayout(defaultLayout, "owner1");

    // User "u2" has no saved layout — should get the server default.
    const layout = mod.getUserLayout("u2");
    const defPanel = layout.panels["def"];
    expect(defPanel?.type === "plugin" && defPanel.itemLabel).toBe("default-channel");
  });
});

describe("CoreModule.initialize — online flag reset", () => {
  it("resets is_online to 0 on boot even if DB had stale rows", () => {
    // Simulate a crash: leave is_online=1 in the DB, then re-init.
    const db = new Database(":memory:");
    const bus = makeMockBus();
    const log = createLogger({ test: true });

    const mod1 = new CoreModule(db, bus as EventBus, log);
    mod1.initialize();
    mod1.onUserConnected("u1", "alice", "Alice", "");

    // Confirm online before re-init.
    expect(mod1.getUser("u1")?.is_online).toBe(true);

    // New module instance on same DB (simulates restart).
    const mod2 = new CoreModule(db, bus as EventBus, log);
    mod2.initialize();

    // Should be offline after restart.
    expect(mod2.getUser("u1")?.is_online).toBe(false);
  });
});

describe("CoreModule.isMember", () => {
  it("returns true for a user who has joined (membership row exists)", () => {
    const { mod } = makeModule();
    mod.onUserConnected("u1", "alice", "Alice", "");
    expect(mod.isMember("u1")).toBe(true);
  });

  it("fails closed: returns false for a user with no membership row", () => {
    const { mod } = makeModule();
    mod.onUserConnected("u1", "alice", "Alice", "");
    // A different, never-seen user is not a member.
    expect(mod.isMember("stranger")).toBe(false);
  });

  it("membership survives disconnect (a former member stays a member)", () => {
    const { mod } = makeModule();
    mod.onUserConnected("u1", "alice", "Alice", "");
    mod.onUserDisconnected("u1");
    // The resolver's `everyone` principal keys on having ever joined, not on
    // being currently online.
    expect(mod.isMember("u1")).toBe(true);
  });
});
