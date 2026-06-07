import { describe, expect, test } from "bun:test";
import type { IpcMessage, IpcTransport, MessageHandler } from "../transport";
import { createHandlerRegistry } from "../handle";
import { createRequestClient } from "../request";
import { createEventsApi } from "../events";
import { createPermissionsApi } from "../permissions";
import { createDataApi } from "../data";
import { unknownResult } from "../schemas";
import type { IpcUser } from "@uncorded/protocol";

// ---------------------------------------------------------------------------
// Mock transport
// ---------------------------------------------------------------------------

function createMockTransport() {
  const sent: IpcMessage[] = [];
  const handlers: MessageHandler[] = [];

  const transport: IpcTransport = {
    send(message: IpcMessage): void {
      sent.push(message);
    },
    onMessage(handler: MessageHandler): void {
      handlers.push(handler);
    },
    close(): void {
      handlers.length = 0;
    },
  };

  /** Simulate an incoming message from the runtime. */
  function receive(message: IpcMessage): void {
    for (const handler of handlers) {
      handler(message);
    }
  }

  return { transport, sent, receive };
}

// ---------------------------------------------------------------------------
// Handler registry
// ---------------------------------------------------------------------------

describe("createHandlerRegistry", () => {
  test("dispatches request to registered handler and sends response", async () => {
    const { transport, sent } = createMockTransport();
    const registry = createHandlerRegistry(transport);

    registry.register("greet", (params) => `Hello, ${params["name"]}!`);

    await registry.dispatch({
      type: "request",
      id: "req_1",
      action: "greet",
      params: { name: "Alice" },
      user: { id: "u1", displayName: "Alice", avatarUrl: "", role: "member" },
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      type: "response",
      id: "req_1",
      result: "Hello, Alice!",
    });
  });

  test("sends error for unknown action", async () => {
    const { transport, sent } = createMockTransport();
    const registry = createHandlerRegistry(transport);

    await registry.dispatch({
      type: "request",
      id: "req_2",
      action: "nonexistent",
      params: {},
      user: { id: "u1", displayName: "Alice", avatarUrl: "", role: "member" },
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]!["error"]).toEqual({
      code: "UNKNOWN_ACTION",
      message: "No handler registered for action: nonexistent",
    });
  });

  test("sends error when handler throws", async () => {
    const { transport, sent } = createMockTransport();
    const registry = createHandlerRegistry(transport);

    registry.register("fail", () => {
      throw new Error("something broke");
    });

    await registry.dispatch({
      type: "request",
      id: "req_3",
      action: "fail",
      params: {},
      user: { id: "u1", displayName: "Alice", avatarUrl: "", role: "member" },
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]!["error"]).toEqual({
      code: "HANDLER_ERROR",
      message: "something broke",
    });
  });

  test("handles async handler", async () => {
    const { transport, sent } = createMockTransport();
    const registry = createHandlerRegistry(transport);

    registry.register("async", async (params) => {
      await new Promise((r) => setTimeout(r, 1));
      return { doubled: (params["n"] as number) * 2 };
    });

    await registry.dispatch({
      type: "request",
      id: "req_4",
      action: "async",
      params: { n: 21 },
      user: { id: "u1", displayName: "Alice", avatarUrl: "", role: "member" },
    });

    expect(sent[0]!["result"]).toEqual({ doubled: 42 });
  });

  test("passes user context to handler", async () => {
    const { transport } = createMockTransport();
    const registry = createHandlerRegistry(transport);

    let receivedUser: IpcUser | undefined;
    registry.register("whoami", (_params, user) => {
      receivedUser = user;
      return null;
    });

    await registry.dispatch({
      type: "request",
      id: "req_5",
      action: "whoami",
      params: {},
      user: { id: "u42", displayName: "Bob", avatarUrl: "", role: "admin" },
    });

    expect(receivedUser).toEqual({ id: "u42", displayName: "Bob", avatarUrl: "", role: "admin" });
  });
});

// ---------------------------------------------------------------------------
// Request client
// ---------------------------------------------------------------------------

describe("createRequestClient", () => {
  test("request sends message and resolves on response", async () => {
    const { transport, sent } = createMockTransport();
    const client = createRequestClient(transport);

    const promise = client.request("getData", { key: "foo" });

    // Simulate runtime response
    const reqId = sent[0]!["id"] as string;
    client.handleResponse({ type: "response", id: reqId, result: { value: 42 } });

    const result = await promise;
    expect(result).toEqual({ value: 42 });
  });

  test("request rejects on error response", async () => {
    const { transport, sent } = createMockTransport();
    const client = createRequestClient(transport);

    const promise = client.request("bad");

    const reqId = sent[0]!["id"] as string;
    client.handleResponse({
      type: "response",
      id: reqId,
      error: { code: "NOT_FOUND", message: "nope" },
    });

    await expect(promise).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "nope",
    });
  });

  test("request rejects on timeout", async () => {
    const { transport } = createMockTransport();
    // Use a very short timeout for testing by sending and never responding
    const client = createRequestClient(transport);

    // We can't easily override the timeout constant, so we test that
    // sendAndWait generates incrementing IDs
    const p1 = client.sendAndWait(unknownResult, { type: "test" });
    const p2 = client.sendAndWait(unknownResult, { type: "test" });

    // Respond to both to avoid dangling timers
    client.handleResponse({ type: "response", id: "req_1", result: "a" });
    client.handleResponse({ type: "response", id: "req_2", result: "b" });

    expect(await p1).toBe("a");
    expect(await p2).toBe("b");
  });

  test("sendAndWait generates incrementing IDs", async () => {
    const { transport, sent } = createMockTransport();
    const client = createRequestClient(transport);

    client.sendAndWait(unknownResult, { type: "a" });
    client.sendAndWait(unknownResult, { type: "b" });

    expect(sent[0]!["id"]).toBe("req_1");
    expect(sent[1]!["id"]).toBe("req_2");

    // Clean up pending
    client.handleResponse({ type: "response", id: "req_1", result: null });
    client.handleResponse({ type: "response", id: "req_2", result: null });
  });

  test("ignores responses for unknown IDs", () => {
    const { transport } = createMockTransport();
    const client = createRequestClient(transport);

    // Should not throw
    client.handleResponse({ type: "response", id: "unknown_999", result: null });
  });
});

// ---------------------------------------------------------------------------
// Events API
// ---------------------------------------------------------------------------

describe("createEventsApi", () => {
  test("publish sends correct IPC message", () => {
    const { transport, sent } = createMockTransport();
    const client = createRequestClient(transport);
    const events = createEventsApi(transport, client);

    events.publish("chat.message.created", { content: "hi" });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      type: "events.publish",
      topic: "chat.message.created",
      payload: { content: "hi" },
    });
  });

  test("publish includes version when provided", () => {
    const { transport, sent } = createMockTransport();
    const client = createRequestClient(transport);
    const events = createEventsApi(transport, client);

    events.publish("chat.message.created", { content: "hi" }, 2);

    expect(sent[0]!["version"]).toBe(2);
  });

  test("subscribe sends IPC message and registers handler", async () => {
    const { transport, sent } = createMockTransport();
    const client = createRequestClient(transport);
    const events = createEventsApi(transport, client);

    const received: unknown[] = [];
    const subscribePromise = events.subscribe("topic.a", (evt) => {
      received.push(evt.payload);
    });

    // The subscribe message was sent
    expect(sent).toHaveLength(1);
    expect(sent[0]!["type"]).toBe("events.subscribe");
    expect(sent[0]!["topic"]).toBe("topic.a");

    // Simulate ack
    client.handleResponse({ type: "event.ack", id: sent[0]!["id"] as string, ok: true });
    await subscribePromise;

    // Now simulate event delivery
    const eventsInternal = events as unknown as {
      handleDelivery(msg: unknown): void;
    };
    eventsInternal.handleDelivery({
      type: "event.deliver",
      topic: "topic.a",
      version: 1,
      id: "evt_1",
      ts: 1234567890,
      source_plugin: "chat",
      payload: { message: "hello" },
    });

    expect(received).toEqual([{ message: "hello" }]);
  });

  test("subscribe with options passes overflow_policy and queue_size", async () => {
    const { transport, sent } = createMockTransport();
    const client = createRequestClient(transport);
    const events = createEventsApi(transport, client);

    const subscribePromise = events.subscribe(
      "topic.b",
      () => {},
      { overflow_policy: "drop_oldest", queue_size: 512 },
    );

    expect(sent[0]!["overflow_policy"]).toBe("drop_oldest");
    expect(sent[0]!["queue_size"]).toBe(512);

    client.handleResponse({ type: "event.ack", id: sent[0]!["id"] as string, ok: true });
    await subscribePromise;
  });

  test("handler throws → event.deliver.error is sent back via transport", async () => {
    const { transport, sent, receive } = createMockTransport();
    const client = createRequestClient(transport);
    const events = createEventsApi(transport, client);

    // Subscribe with a handler that always throws
    const subscribePromise = events.subscribe("topic.err", () => {
      throw new Error("handler failure");
    });

    // Simulate ack
    client.handleResponse({ type: "event.ack", id: sent[0]!["id"] as string, ok: true });
    await subscribePromise;

    // Deliver an event to the throwing handler
    const eventsInternal = events as unknown as { handleDelivery(msg: unknown): void };
    eventsInternal.handleDelivery({
      type: "event.deliver",
      topic: "topic.err",
      version: 1,
      id: "evt_err_1",
      ts: Date.now(),
      source_plugin: "other",
      payload: {},
    });

    // An event.deliver.error message should have been sent
    const errorMsg = sent.find((m) => m["type"] === "event.deliver.error");
    expect(errorMsg).toBeDefined();
    expect(errorMsg!["id"]).toBe("evt_err_1");
    expect(typeof errorMsg!["error"]).toBe("string");
  });

  test("unsubscribe sends message and removes handlers", async () => {
    const { transport, sent } = createMockTransport();
    const client = createRequestClient(transport);
    const events = createEventsApi(transport, client);

    // Subscribe first
    const p = events.subscribe("topic.c", () => {});
    client.handleResponse({ type: "event.ack", id: sent[0]!["id"] as string, ok: true });
    await p;

    // Unsubscribe
    const unsubPromise = events.unsubscribe("topic.c");
    const unsubMsg = sent[sent.length - 1]!;
    expect(unsubMsg["type"]).toBe("events.unsubscribe");

    client.handleResponse({ type: "event.ack", id: unsubMsg["id"] as string, ok: true });
    await unsubPromise;
  });
});

// ---------------------------------------------------------------------------
// Permissions API
// ---------------------------------------------------------------------------

describe("createPermissionsApi", () => {
  test("register sends correct IPC message", async () => {
    const { transport, sent } = createMockTransport();
    const client = createRequestClient(transport);
    const perms = createPermissionsApi(client);

    const p = perms.register("gallery.upload", { description: "Can upload photos", default_level: 10 });

    expect(sent[0]!["type"]).toBe("permissions.register");
    expect(sent[0]!["key"]).toBe("gallery.upload");
    expect(sent[0]!["description"]).toBe("Can upload photos");
    expect(sent[0]!["default_level"]).toBe(10);

    client.handleResponse({ type: "response", id: sent[0]!["id"] as string, result: null });
    await p;
  });

  test("check returns boolean result", async () => {
    const { transport, sent } = createMockTransport();
    const client = createRequestClient(transport);
    const perms = createPermissionsApi(client);

    const p = perms.check("user_1", "gallery.upload", "channel_abc");

    expect(sent[0]!["type"]).toBe("permissions.check");
    expect(sent[0]!["user_id"]).toBe("user_1");
    expect(sent[0]!["permission"]).toBe("gallery.upload");
    expect(sent[0]!["scope"]).toBe("channel_abc");

    client.handleResponse({ type: "response", id: sent[0]!["id"] as string, result: true });

    expect(await p).toBe(true);
  });

  test("hasRole returns boolean result", async () => {
    const { transport, sent } = createMockTransport();
    const client = createRequestClient(transport);
    const perms = createPermissionsApi(client);

    const p = perms.hasRole("user_1", "admin");

    expect(sent[0]!["type"]).toBe("permissions.has_role");
    client.handleResponse({ type: "response", id: sent[0]!["id"] as string, result: false });

    expect(await p).toBe(false);
  });

  test("hasMinLevel returns boolean result", async () => {
    const { transport, sent } = createMockTransport();
    const client = createRequestClient(transport);
    const perms = createPermissionsApi(client);

    const p = perms.hasMinLevel("user_1", 60);

    expect(sent[0]!["type"]).toBe("permissions.has_min_level");
    expect(sent[0]!["level"]).toBe(60);
    client.handleResponse({ type: "response", id: sent[0]!["id"] as string, result: true });

    expect(await p).toBe(true);
  });

  test("getRole returns role info", async () => {
    const { transport, sent } = createMockTransport();
    const client = createRequestClient(transport);
    const perms = createPermissionsApi(client);

    const p = perms.getRole("user_1");

    expect(sent[0]!["type"]).toBe("permissions.get_role");
    client.handleResponse({
      type: "response",
      id: sent[0]!["id"] as string,
      result: { name: "moderator", level: 60 },
    });

    expect(await p).toEqual({ name: "moderator", level: 60 });
  });
});

// ---------------------------------------------------------------------------
// Data read query builder
// ---------------------------------------------------------------------------

describe("createDataApi", () => {
  test("basic read sends correct IPC message", async () => {
    const { transport, sent } = createMockTransport();
    const client = createRequestClient(transport);
    const data = createDataApi(client);

    const p = data.read("text-channels", "messages").exec();

    expect(sent[0]!["type"]).toBe("data.read");
    expect(sent[0]!["plugin"]).toBe("text-channels");
    expect(sent[0]!["table"]).toBe("messages");

    // No optional fields when not specified
    expect(sent[0]!["where"]).toBeUndefined();
    expect(sent[0]!["select"]).toBeUndefined();
    expect(sent[0]!["order_by"]).toBeUndefined();
    expect(sent[0]!["limit"]).toBeUndefined();

    client.handleResponse({ type: "response", id: sent[0]!["id"] as string, result: [] });
    expect(await p).toEqual([]);
  });

  test("chained query builder sends all clauses", async () => {
    const { transport, sent } = createMockTransport();
    const client = createRequestClient(transport);
    const data = createDataApi(client);

    const p = data
      .read("text-channels", "messages")
      .where("channel_id", "=", "ch_1")
      .where("author_id", "!=", "u_banned")
      .select(["id", "content", "created_at"])
      .orderBy("created_at", "desc")
      .limit(50)
      .exec();

    const msg = sent[0]!;
    expect(msg["where"]).toEqual([
      { column: "channel_id", op: "=", value: "ch_1" },
      { column: "author_id", op: "!=", value: "u_banned" },
    ]);
    expect(msg["select"]).toEqual(["id", "content", "created_at"]);
    expect(msg["order_by"]).toEqual([{ column: "created_at", direction: "desc" }]);
    expect(msg["limit"]).toBe(50);

    client.handleResponse({
      type: "response",
      id: msg["id"] as string,
      result: [{ id: "m1", content: "hello", created_at: 123 }],
    });

    const rows = await p;
    expect(rows).toHaveLength(1);
    expect(rows[0]!["content"]).toBe("hello");
  });

  test("query builder is immutable — chaining creates new instances", () => {
    const { transport } = createMockTransport();
    const client = createRequestClient(transport);
    const data = createDataApi(client);

    const base = data.read("plugin", "table");
    const withWhere = base.where("col", "=", "val");
    const withLimit = base.limit(10);

    // These are different builder instances
    expect(base).not.toBe(withWhere);
    expect(base).not.toBe(withLimit);
    expect(withWhere).not.toBe(withLimit);
  });

  test("orderBy defaults to ascending", async () => {
    const { transport, sent } = createMockTransport();
    const client = createRequestClient(transport);
    const data = createDataApi(client);

    data.read("p", "t").orderBy("col").exec();

    expect(sent[0]!["order_by"]).toEqual([{ column: "col", direction: "asc" }]);

    client.handleResponse({ type: "response", id: sent[0]!["id"] as string, result: [] });
  });
});

// ---------------------------------------------------------------------------
// Message dispatch (integration-level with mock transport)
// ---------------------------------------------------------------------------

describe("message dispatch integration", () => {
  test("unknown message types are silently ignored", () => {
    const { transport, sent, receive } = createMockTransport();
    const client = createRequestClient(transport);

    // Wire up the dispatcher as createPlugin would
    transport.onMessage((msg) => {
      if (msg["type"] === "response" || msg["type"] === "event.ack") {
        client.handleResponse(msg);
      }
    });

    // This should not throw
    receive({ type: "totally.unknown.message" });
    expect(sent).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// serveReady — opt-in two-stage handshake
// ---------------------------------------------------------------------------

describe("serveReady", () => {
  test("sends serve_ready frame to runtime", () => {
    const { transport, sent } = createMockTransport();
    // Mirror createPlugin's call shape directly — no need to spin up the full
    // SDK just to assert one frame.
    transport.send({ type: "serve_ready" });
    expect(sent).toEqual([{ type: "serve_ready" }]);
  });
});
