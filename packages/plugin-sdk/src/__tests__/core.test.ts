import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { createCoreApi } from "../core";
import type { CoreUser } from "@uncorded/protocol";

// ---------------------------------------------------------------------------
// Mock client (matches ReturnType<typeof createRequestClient>)
// ---------------------------------------------------------------------------

function mockClient(results: Map<string, unknown>) {
  return {
    nextId: () => "mock-id",
    sendAndWait: async <S extends z.ZodTypeAny>(
      schema: S,
      msg: import("../transport").IpcMessage,
    ): Promise<z.infer<S>> => {
      const key = msg["type"] as string;
      if (!results.has(key)) throw new Error(`Unexpected type: ${key}`);
      const result = results.get(key);
      const value = typeof result === "function" ? result(msg) : result;
      return schema.parse(value) as z.infer<S>;
    },
    request: async <T = unknown>(): Promise<T> => { throw new Error("request() not mocked"); },
    handleResponse: (_msg: import("../transport").IpcMessage): void => { /* no-op */ },
  };
}

const ALICE: CoreUser = {
  id: "u1",
  username: "alice",
  display_name: "Alice",
  avatar_url: "https://example.com/alice.jpg",
  is_online: true,
  last_seen_at: 1000,
  connected_at: 900,
};

const BOB: CoreUser = {
  id: "u2",
  username: "bob",
  display_name: "Bob",
  avatar_url: "",
  is_online: false,
  last_seen_at: 500,
  connected_at: 0,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("sdk.core.getUser", () => {
  it("sends core.user.get with userId and returns user", async () => {
    const api = createCoreApi(
      mockClient(new Map([["core.user.get", { user: ALICE }]])),
    );
    const user = await api.getUser("u1");
    expect(user?.display_name).toBe("Alice");
    expect(user?.is_online).toBe(true);
  });

  it("returns null when user not found", async () => {
    const api = createCoreApi(
      mockClient(new Map([["core.user.get", { user: null }]])),
    );
    const user = await api.getUser("unknown");
    expect(user).toBeNull();
  });
});

describe("sdk.core.getUsers", () => {
  it("sends core.user.getMany with userIds and returns array", async () => {
    const api = createCoreApi(
      mockClient(new Map([["core.user.getMany", { users: [ALICE, BOB] }]])),
    );
    const users = await api.getUsers(["u1", "u2"]);
    expect(users).toHaveLength(2);
    expect(users[0]?.display_name).toBe("Alice");
    expect(users[1]?.display_name).toBe("Bob");
  });

  it("returns empty array for empty ids", async () => {
    const api = createCoreApi(
      mockClient(new Map([["core.user.getMany", { users: [] }]])),
    );
    const users = await api.getUsers([]);
    expect(users).toEqual([]);
  });
});

describe("sdk.core.getOnlineUsers", () => {
  it("sends core.user.getOnline and returns online users", async () => {
    const api = createCoreApi(
      mockClient(new Map([["core.user.getOnline", { users: [ALICE] }]])),
    );
    const users = await api.getOnlineUsers();
    expect(users).toHaveLength(1);
    expect(users[0]?.id).toBe("u1");
  });
});
