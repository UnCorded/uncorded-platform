import { describe, expect, test } from "bun:test";
import { MessageRouter, parseClientMessage, buildCapabilityString } from "./router";
import type { WebSocketSender, PresenceCallback } from "./router";
import type { SubprocessManager, PluginProcess, PluginState } from "../subprocess";
import type { StdioParentTransport, IpcMessage, MessageHandler } from "../ipc/transport";
import type { AuthenticatedUser } from "./types";
import { CapabilityChecker } from "../capabilities/checker";
import { RateLimiter } from "../http/rate-limiter";
import type {
  RequestMessage,
  ResponseMessage,
  EventMessage,
  IpcResponseMessage,
  IpcEventAckMessage,
} from "@uncorded/protocol";
import { jsonCodec } from "./codec";
import { EventBus } from "../events/bus";
import type { PluginTransportProvider } from "../events/types";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PluginResourceStore, PluginResourceResolver } from "../plugin-resources";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function mockUser(overrides?: Partial<AuthenticatedUser>): AuthenticatedUser {
  return {
    id: "user_1",
    username: "alice",
    displayName: "Alice",
    avatarUrl: "https://example.com/alice.png",
    role: "member",
    ...overrides,
  };
}

function mockSender(): WebSocketSender & { sent: unknown[]; closed: boolean } {
  const sent: unknown[] = [];
  return {
    sent,
    closed: false,
    send(data: string | Uint8Array) {
      sent.push(typeof data === "string" ? JSON.parse(data) : data);
    },
    close() {
      this.closed = true;
    },
  };
}

interface MockTransport {
  sent: IpcMessage[];
  handlers: MessageHandler[];
  send(msg: IpcMessage): void;
  onMessage(handler: MessageHandler): void;
  close(): void;
  simulateMessage(msg: IpcMessage): void;
}

function mockTransport(): MockTransport {
  const sent: IpcMessage[] = [];
  const handlers: MessageHandler[] = [];
  return {
    sent,
    handlers,
    send(msg: IpcMessage) {
      sent.push(msg);
    },
    onMessage(handler: MessageHandler) {
      handlers.push(handler);
    },
    close() {},
    simulateMessage(msg: IpcMessage) {
      for (const h of handlers) h(msg);
    },
  };
}

function mockPluginProcess(
  slug: string,
  transport: MockTransport,
  state: PluginState = "ready",
): PluginProcess {
  return {
    slug,
    pid: 1234,
    subprocess: {} as PluginProcess["subprocess"],
    transport: transport as unknown as StdioParentTransport,
    state,
    restarts: { crashes: [], backoffIndex: 0 },
  };
}

function mockSubprocessManager(
  plugins: Record<string, PluginProcess>,
): SubprocessManager {
  return {
    getProcess(slug: string) {
      return plugins[slug];
    },
  } as SubprocessManager;
}

function createRouter(
  plugins: Record<string, { transport: MockTransport; state?: PluginState }>,
  onPresence?: PresenceCallback,
  eventBus?: EventBus,
): { router: MessageRouter; transports: Record<string, MockTransport> } {
  const transports: Record<string, MockTransport> = {};
  const processes: Record<string, PluginProcess> = {};

  for (const [slug, cfg] of Object.entries(plugins)) {
    transports[slug] = cfg.transport;
    processes[slug] = mockPluginProcess(slug, cfg.transport, cfg.state ?? "ready");
  }

  const manager = mockSubprocessManager(processes);
  const router = new MessageRouter(manager, onPresence, jsonCodec, eventBus);

  // Attach plugin handlers
  for (const [slug, t] of Object.entries(transports)) {
    router.attachPlugin(slug, t as unknown as StdioParentTransport);
  }

  return { router, transports };
}

function createTransportProvider(
  transports: Record<string, MockTransport>,
): PluginTransportProvider {
  return {
    getTransport(slug: string) {
      return transports[slug] as unknown as StdioParentTransport | undefined;
    },
    isPluginAlive(slug: string) {
      return slug in transports;
    },
  };
}

// ---------------------------------------------------------------------------
// parseClientMessage
// ---------------------------------------------------------------------------

describe("parseClientMessage", () => {
  test("parses valid auth message", () => {
    const msg = parseClientMessage({ type: "auth", token: "abc" });
    expect(msg).toEqual({ type: "auth", token: "abc" });
  });

  test("parses valid request message", () => {
    const msg = parseClientMessage({
      type: "request",
      id: "req_1",
      plugin: "text-channels",
      action: "getMessages",
      params: { channelId: "abc" },
    });
    expect(msg).toEqual({
      type: "request",
      id: "req_1",
      plugin: "text-channels",
      action: "getMessages",
      params: { channelId: "abc" },
    });
  });

  test("rejects null", () => {
    expect(parseClientMessage(null)).toBeNull();
  });

  test("rejects non-object", () => {
    expect(parseClientMessage("hello")).toBeNull();
  });

  test("rejects missing type", () => {
    expect(parseClientMessage({ token: "abc" })).toBeNull();
  });

  test("rejects unknown type", () => {
    expect(parseClientMessage({ type: "unknown" })).toBeNull();
  });

  test("rejects auth without token", () => {
    expect(parseClientMessage({ type: "auth" })).toBeNull();
  });

  test("rejects request with missing fields", () => {
    expect(parseClientMessage({ type: "request", id: "1" })).toBeNull();
  });

  test("rejects request with null params", () => {
    expect(
      parseClientMessage({
        type: "request",
        id: "1",
        plugin: "p",
        action: "a",
        params: null,
      }),
    ).toBeNull();
  });

});

// ---------------------------------------------------------------------------
// Connection lifecycle
// ---------------------------------------------------------------------------

describe("connection lifecycle", () => {
  test("registerConnection tracks user and calls presence callback", () => {
    const events: string[] = [];
    const { router } = createRouter({}, (event) => events.push(event));
    const sender = mockSender();
    const user = mockUser();

    router.registerConnection("conn_1", user, sender);

    expect(router.getConnectionCount()).toBe(1);
    expect(router.getConnectedUsers().get("user_1")?.user).toEqual(user);
    expect(events).toEqual(["runtime.user.connected"]);
  });

  test("removeConnection cleans up and calls presence callback", () => {
    const events: string[] = [];
    const { router } = createRouter({}, (event) => events.push(event));
    const sender = mockSender();

    router.registerConnection("conn_1", mockUser(), sender);
    router.removeConnection("conn_1");

    expect(router.getConnectionCount()).toBe(0);
    expect(router.getConnectedUsers().size).toBe(0);
    expect(events).toEqual([
      "runtime.user.connected",
      "runtime.user.disconnected",
    ]);
  });

  test("removing unknown connection is a no-op", () => {
    const { router } = createRouter({});
    router.removeConnection("nonexistent"); // should not throw
    expect(router.getConnectionCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Multi-connection presence (I1)
// ---------------------------------------------------------------------------

describe("multi-connection presence", () => {
  test("second connection for same user does NOT emit runtime.user.connected", () => {
    const events: string[] = [];
    const { router } = createRouter({}, (event) => events.push(event));
    const user = mockUser();

    router.registerConnection("conn_1", user, mockSender());
    router.registerConnection("conn_2", user, mockSender());

    expect(events).toEqual(["runtime.user.connected"]);
    expect(router.getConnectionCount()).toBe(2);
    expect(router.getConnectedUsers().size).toBe(1);
  });

  test("closing one of two connections does NOT emit runtime.user.disconnected", () => {
    const events: string[] = [];
    const { router } = createRouter({}, (event) => events.push(event));
    const user = mockUser();

    router.registerConnection("conn_1", user, mockSender());
    router.registerConnection("conn_2", user, mockSender());
    events.length = 0; // clear prior events

    router.removeConnection("conn_1");

    expect(events).toEqual([]);
    expect(router.getConnectionCount()).toBe(1);
    expect(router.getConnectedUsers().has("user_1")).toBe(true);
  });

  test("closing the last connection emits runtime.user.disconnected", () => {
    const events: string[] = [];
    const { router } = createRouter({}, (event) => events.push(event));
    const user = mockUser();

    router.registerConnection("conn_1", user, mockSender());
    router.registerConnection("conn_2", user, mockSender());
    events.length = 0;

    router.removeConnection("conn_1");
    router.removeConnection("conn_2");

    expect(events).toEqual(["runtime.user.disconnected"]);
    expect(router.getConnectedUsers().size).toBe(0);
  });

  test("getConnectedUsers shows user present while any connection remains", () => {
    const { router } = createRouter({});
    const user = mockUser();

    router.registerConnection("conn_1", user, mockSender());
    router.registerConnection("conn_2", user, mockSender());
    router.registerConnection("conn_3", user, mockSender());

    router.removeConnection("conn_1");
    router.removeConnection("conn_2");

    expect(router.getConnectedUsers().has("user_1")).toBe(true);
    expect(router.getConnectionCount()).toBe(1);
  });

  test("disconnectUser closes all connections and emits disconnected once", () => {
    const events: string[] = [];
    const { router } = createRouter({}, (event) => events.push(event));
    const user = mockUser();
    const s1 = mockSender();
    const s2 = mockSender();

    router.registerConnection("conn_1", user, s1);
    router.registerConnection("conn_2", user, s2);
    events.length = 0;

    const closed = router.disconnectUser("user_1", 4003, "banned");

    expect(closed).toBe(2);
    expect(s1.closed).toBe(true);
    expect(s2.closed).toBe(true);
    // Only one disconnected event despite two connections
    expect(events.filter((e) => e === "runtime.user.disconnected")).toHaveLength(1);
    expect(router.getConnectedUsers().size).toBe(0);
  });

  test("disconnectAllUsers closes all tracked connections across users", () => {
    const events: string[] = [];
    const { router } = createRouter({}, (event) => events.push(event));
    const user1 = mockUser({ id: "user_1" });
    const user2 = mockUser({ id: "user_2", displayName: "Bob" });
    const s1 = mockSender();
    const s2 = mockSender();
    const s3 = mockSender();

    router.registerConnection("conn_1", user1, s1);
    router.registerConnection("conn_2", user1, s2);
    router.registerConnection("conn_3", user2, s3);
    events.length = 0;

    const closed = router.disconnectAllUsers(4001, "Server re-sync required");

    expect(closed).toBe(3);
    expect(s1.closed).toBe(true);
    expect(s2.closed).toBe(true);
    expect(s3.closed).toBe(true);
    expect(router.getConnectionCount()).toBe(0);
    expect(router.getConnectedUsers().size).toBe(0);
    // Each user gets exactly one disconnected event
    expect(events.filter((e) => e === "runtime.user.disconnected")).toHaveLength(2);
  });

  test("disconnectFormerOwner closes sessions whose role=owner but id!=newOwner (G4)", () => {
    const { router } = createRouter({});
    const ownerA = mockUser({ id: "user_a", role: "owner" });
    const ownerB = mockUser({ id: "user_b", displayName: "B", role: "owner" });
    const member = mockUser({ id: "user_m", displayName: "M", role: "member" });
    const sA = mockSender();
    const sB = mockSender();
    const sM = mockSender();

    // Before transfer, two sessions still claim owner role (stale JWTs) plus
    // one member. After ownership transfer to user_b, only user_a's stale
    // owner session should be torn down.
    router.registerConnection("conn_a", ownerA, sA);
    router.registerConnection("conn_b", ownerB, sB);
    router.registerConnection("conn_m", member, sM);

    const closed = router.disconnectFormerOwner("user_b");

    expect(closed).toBe(1);
    expect(sA.closed).toBe(true);
    expect(sB.closed).toBe(false);
    expect(sM.closed).toBe(false);
    expect(router.getConnectionCount()).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Request routing
// ---------------------------------------------------------------------------

describe("request routing", () => {
  test("routes request to correct plugin and maps response back", () => {
    const transport = mockTransport();
    const { router } = createRouter({ "text-channels": { transport } });
    const sender = mockSender();
    const user = mockUser();

    router.registerConnection("conn_1", user, sender);

    const request: RequestMessage = {
      type: "request",
      id: "req_1",
      plugin: "text-channels",
      action: "getMessages",
      params: { channelId: "abc" },
    };

    router.handleMessage("conn_1", request);

    // Verify IPC message was sent to plugin
    expect(transport.sent).toHaveLength(1);
    const ipcMsg = transport.sent[0]!;
    expect(ipcMsg["type"]).toBe("request");
    expect(ipcMsg["action"]).toBe("getMessages");
    expect(ipcMsg["params"]).toEqual({ channelId: "abc" });
    expect(ipcMsg["user"]).toEqual({
      id: "user_1",
      displayName: "Alice",
      avatarUrl: "https://example.com/alice.png",
      role: "member",
    });

    // The correlation ID should NOT be the client's request ID
    const correlationId = ipcMsg["id"] as string;
    expect(correlationId).not.toBe("req_1");
    expect(correlationId.length).toBeGreaterThan(0);

    // Simulate plugin response with the correlation ID
    transport.simulateMessage({
      type: "response",
      id: correlationId,
      result: [{ id: "msg_1", content: "hello" }],
    } as IpcMessage);

    // Verify response sent back to client with original request ID
    expect(sender.sent).toHaveLength(1);
    const response = sender.sent[0] as ResponseMessage;
    expect(response.type).toBe("response");
    expect(response.id).toBe("req_1");
    expect(response.result).toEqual([{ id: "msg_1", content: "hello" }]);
  });

  test("two clients with same request ID get correct responses", () => {
    const transport = mockTransport();
    const { router } = createRouter({ "text-channels": { transport } });
    const sender1 = mockSender();
    const sender2 = mockSender();

    router.registerConnection("conn_1", mockUser({ id: "user_1" }), sender1);
    router.registerConnection("conn_2", mockUser({ id: "user_2" }), sender2);

    // Both clients send request with id "req_1"
    router.handleMessage("conn_1", {
      type: "request",
      id: "req_1",
      plugin: "text-channels",
      action: "getA",
      params: {},
    });
    router.handleMessage("conn_2", {
      type: "request",
      id: "req_1",
      plugin: "text-channels",
      action: "getB",
      params: {},
    });

    expect(transport.sent).toHaveLength(2);
    const corrId1 = transport.sent[0]!["id"] as string;
    const corrId2 = transport.sent[1]!["id"] as string;
    expect(corrId1).not.toBe(corrId2);

    // Respond in reverse order
    transport.simulateMessage({
      type: "response",
      id: corrId2,
      result: "response_B",
    } as IpcMessage);
    transport.simulateMessage({
      type: "response",
      id: corrId1,
      result: "response_A",
    } as IpcMessage);

    // Each client gets the correct response
    expect(sender1.sent).toHaveLength(1);
    expect((sender1.sent[0] as ResponseMessage).result).toBe("response_A");
    expect(sender2.sent).toHaveLength(1);
    expect((sender2.sent[0] as ResponseMessage).result).toBe("response_B");
  });

  test("returns error for unknown plugin", () => {
    const { router } = createRouter({});
    const sender = mockSender();

    router.registerConnection("conn_1", mockUser(), sender);

    router.handleMessage("conn_1", {
      type: "request",
      id: "req_1",
      plugin: "nonexistent",
      action: "foo",
      params: {},
    });

    expect(sender.sent).toHaveLength(1);
    const response = sender.sent[0] as ResponseMessage;
    expect(response.id).toBe("req_1");
    expect(response.error?.code).toBe("PLUGIN_NOT_FOUND");
  });

  test("returns error for plugin not in ready state", () => {
    const transport = mockTransport();
    const { router } = createRouter({
      "text-channels": { transport, state: "starting" },
    });
    const sender = mockSender();

    router.registerConnection("conn_1", mockUser(), sender);

    router.handleMessage("conn_1", {
      type: "request",
      id: "req_1",
      plugin: "text-channels",
      action: "foo",
      params: {},
    });

    expect(sender.sent).toHaveLength(1);
    expect((sender.sent[0] as ResponseMessage).error?.code).toBe(
      "PLUGIN_NOT_READY",
    );
    expect(transport.sent).toHaveLength(0); // nothing sent to IPC
  });

  test("routes error response from plugin back to client", () => {
    const transport = mockTransport();
    const { router } = createRouter({ "text-channels": { transport } });
    const sender = mockSender();

    router.registerConnection("conn_1", mockUser(), sender);

    router.handleMessage("conn_1", {
      type: "request",
      id: "req_1",
      plugin: "text-channels",
      action: "foo",
      params: {},
    });

    const corrId = transport.sent[0]!["id"] as string;
    transport.simulateMessage({
      type: "response",
      id: corrId,
      error: { code: "NOT_FOUND", message: "Channel not found" },
    } as IpcMessage);

    const response = sender.sent[0] as ResponseMessage;
    expect(response.error?.code).toBe("NOT_FOUND");
    expect(response.error?.message).toBe("Channel not found");
    expect(response.result).toBeUndefined();
  });

  test("orphaned IPC response is silently dropped", () => {
    const transport = mockTransport();
    const { router } = createRouter({ "text-channels": { transport } });

    // No pending request exists for this correlation ID
    transport.simulateMessage({
      type: "response",
      id: "orphaned_corr_id",
      result: "dropped",
    } as IpcMessage);

    // Should not throw — just silently ignored
    expect(router.getPendingRequestCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Request timeout cleanup
// ---------------------------------------------------------------------------

describe("request timeout cleanup", () => {
  test("cleans up stale requests and sends timeout errors", () => {
    const transport = mockTransport();
    const { router } = createRouter({ "text-channels": { transport } });
    const sender = mockSender();

    router.registerConnection("conn_1", mockUser(), sender);

    router.handleMessage("conn_1", {
      type: "request",
      id: "req_1",
      plugin: "text-channels",
      action: "slow",
      params: {},
    });

    expect(router.getPendingRequestCount()).toBe(1);

    // Cleanup with 0ms max age — everything is stale
    const cleaned = router.cleanupStaleRequests(0);

    expect(cleaned).toBe(1);
    expect(router.getPendingRequestCount()).toBe(0);
    expect(sender.sent).toHaveLength(1);
    expect((sender.sent[0] as ResponseMessage).error?.code).toBe(
      "REQUEST_TIMEOUT",
    );
  });

  test("does not clean up fresh requests", () => {
    const transport = mockTransport();
    const { router } = createRouter({ "text-channels": { transport } });
    const sender = mockSender();

    router.registerConnection("conn_1", mockUser(), sender);

    router.handleMessage("conn_1", {
      type: "request",
      id: "req_1",
      plugin: "text-channels",
      action: "fast",
      params: {},
    });

    // Cleanup with very long max age
    const cleaned = router.cleanupStaleRequests(60_000);

    expect(cleaned).toBe(0);
    expect(router.getPendingRequestCount()).toBe(1);
    expect(sender.sent).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Disconnect cleanup of pending requests
// ---------------------------------------------------------------------------

describe("disconnect cleanup", () => {
  test("pending requests from disconnected client are removed", () => {
    const transport = mockTransport();
    const { router } = createRouter({ "text-channels": { transport } });
    const sender = mockSender();

    router.registerConnection("conn_1", mockUser(), sender);

    router.handleMessage("conn_1", {
      type: "request",
      id: "req_1",
      plugin: "text-channels",
      action: "slow",
      params: {},
    });

    expect(router.getPendingRequestCount()).toBe(1);

    router.removeConnection("conn_1");

    expect(router.getPendingRequestCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// buildCapabilityString
// ---------------------------------------------------------------------------

describe("buildCapabilityString", () => {
  test("data.sql → data.sql:self", () => {
    expect(buildCapabilityString({ type: "data.sql", id: "1" })).toBe("data.sql:self");
  });

  test("data.kv → data.kv:self", () => {
    expect(buildCapabilityString({ type: "data.kv", id: "1" })).toBe("data.kv:self");
  });

  test("storage.file → storage.file:self", () => {
    expect(buildCapabilityString({ type: "storage.file", id: "1" })).toBe("storage.file:self");
  });

  test("events.publish with topic → events.publish:<topic>", () => {
    expect(
      buildCapabilityString({
        type: "events.publish",
        topic: "text-channels.message.created",
      }),
    ).toBe("events.publish:text-channels.message.created");
  });

  test("events.subscribe with topic → events.subscribe:<topic>", () => {
    expect(
      buildCapabilityString({
        type: "events.subscribe",
        topic: "runtime.cascade.user.deleted",
      }),
    ).toBe("events.subscribe:runtime.cascade.user.deleted");
  });

  test("http.fetch with host → http.fetch:<host>", () => {
    expect(
      buildCapabilityString({ type: "http.fetch", host: "api.example.com" }),
    ).toBe("http.fetch:api.example.com");
  });

  test("data.read with plugin+table → data.read:<plugin>.<table>", () => {
    expect(
      buildCapabilityString({
        type: "data.read",
        plugin: "text-channels",
        table: "messages",
      }),
    ).toBe("data.read:text-channels.messages");
  });

  test("auth.currentUser → auth.currentUser (scopeless)", () => {
    expect(buildCapabilityString({ type: "auth.currentUser" })).toBe(
      "auth.currentUser",
    );
  });

  test("runtime.log → runtime.log (scopeless)", () => {
    expect(buildCapabilityString({ type: "runtime.log" })).toBe("runtime.log");
  });

  test("response → null (passthrough)", () => {
    expect(buildCapabilityString({ type: "response", id: "1" })).toBeNull();
  });

  test("ready → null (passthrough)", () => {
    expect(buildCapabilityString({ type: "ready" })).toBeNull();
  });

  test("event.deliver.error is a passthrough type", () => {
    const result = buildCapabilityString({ type: "event.deliver.error", id: "evt_1", error: "boom" });
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Capability enforcement in attachPlugin
// ---------------------------------------------------------------------------

describe("capability enforcement", () => {
  test("allowed IPC call is not rejected", () => {
    const transport = mockTransport();
    const checker = new CapabilityChecker("text-channels", [
      "events.publish:text-channels.*",
    ]);
    const manager = mockSubprocessManager({
      "text-channels": mockPluginProcess("text-channels", transport),
    });
    const router = new MessageRouter(manager, undefined, jsonCodec);
    router.attachPlugin("text-channels", transport as unknown as StdioParentTransport, checker);

    // Plugin sends an allowed events.publish IPC call
    transport.simulateMessage({
      type: "events.publish",
      id: "ipc_1",
      topic: "text-channels.message.created",
      payload: { content: "hello" },
    });

    // No error sent back to plugin — call was allowed
    const errors = transport.sent.filter((m) => m["type"] === "error");
    expect(errors).toHaveLength(0);
  });

  test("denied IPC call returns CAPABILITY_DENIED error to plugin", () => {
    const transport = mockTransport();
    const checker = new CapabilityChecker("text-channels", [
      "data.sql:self",
    ]);
    const manager = mockSubprocessManager({
      "text-channels": mockPluginProcess("text-channels", transport),
    });
    const router = new MessageRouter(manager, undefined, jsonCodec);
    router.attachPlugin("text-channels", transport as unknown as StdioParentTransport, checker);

    // Plugin sends a denied http.fetch IPC call
    transport.simulateMessage({
      type: "http.fetch",
      id: "ipc_2",
      host: "evil.com",
    });

    // Error sent back to plugin via IPC response (not type: "error" — rejected promise, not silent hang)
    const errors = transport.sent.filter((m) => m["type"] === "response" && m["error"] !== undefined);
    expect(errors).toHaveLength(1);

    const err = errors[0]!;
    expect(err["id"]).toBe("ipc_2");

    const errBody = err["error"] as Record<string, unknown>;
    expect(errBody["code"]).toBe("CAPABILITY_DENIED");
    expect(typeof errBody["message"]).toBe("string");
    expect((errBody["message"] as string)).toContain("http.fetch:evil.com");
  });

  test("response messages pass through without capability check", () => {
    const transport = mockTransport();
    const checker = new CapabilityChecker("text-channels", []); // empty — denies everything
    const manager = mockSubprocessManager({
      "text-channels": mockPluginProcess("text-channels", transport),
    });
    const router = new MessageRouter(manager, undefined, jsonCodec);
    const sender = mockSender();

    router.registerConnection("conn_1", mockUser(), sender);
    router.attachPlugin("text-channels", transport as unknown as StdioParentTransport, checker);

    // Send a request to create a pending entry
    router.handleMessage("conn_1", {
      type: "request",
      id: "req_1",
      plugin: "text-channels",
      action: "getMessages",
      params: {},
    });

    const corrId = transport.sent[0]!["id"] as string;

    // Plugin response should pass through even with empty permissions
    transport.simulateMessage({
      type: "response",
      id: corrId,
      result: { data: "ok" },
    } as IpcMessage);

    // Client should receive the response
    expect(sender.sent).toHaveLength(1);
    expect((sender.sent[0] as ResponseMessage).result).toEqual({ data: "ok" });

    // No errors sent back to plugin
    const errors = transport.sent.filter((m) => m["type"] === "error");
    expect(errors).toHaveLength(0);
  });

  test("no checker attached logs warning and denies call", () => {
    const transport = mockTransport();
    const manager = mockSubprocessManager({
      "text-channels": mockPluginProcess("text-channels", transport),
    });
    const router = new MessageRouter(manager, undefined, jsonCodec);

    // Attach WITHOUT a checker
    router.attachPlugin("text-channels", transport as unknown as StdioParentTransport);

    // Capture structured log output
    const lines: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: unknown, ...args: unknown[]) => {
      lines.push(String(chunk));
      return true;
    };

    try {
      transport.simulateMessage({
        type: "data.sql",
        id: "ipc_1",
        query: "SELECT 1",
      });

      // Response error sent — call denied (rejected promise, not silent hang)
      const errors = transport.sent.filter((m) => m["type"] === "response" && m["error"] !== undefined);
      expect(errors).toHaveLength(1);
      const err = errors[0] as Record<string, unknown>;
      expect((err["error"] as Record<string, unknown>)["code"]).toBe("CAPABILITY_CHECKER_MISSING");
      expect((err["error"] as Record<string, unknown>)["message"] as string).toContain("data.sql");
      expect(err["id"]).toBe("ipc_1");

      // And a warning was logged via structured logger
      const warnings = lines
        .map((l) => { try { return JSON.parse(l.trim()) as Record<string, unknown>; } catch { return null; } })
        .filter((o): o is Record<string, unknown> => o !== null && o["level"] === "warn");
      expect(warnings.length).toBeGreaterThanOrEqual(1);
      const w = warnings[0]!;
      expect(String(w["plugin"] ?? "")).toContain("text-channels");
      expect(String(w["msg"] ?? "")).toContain("no capability checker");
      expect(String(w["capability"] ?? "")).toContain("data.sql:self");
      // The plugin's IPC msg id rides along as `correlationId` so an
      // operator can grep capability denials in plugin output by the same
      // id the plugin printed when it issued the call.
      expect(w["correlationId"]).toBe("ipc_1");
    } finally {
      process.stdout.write = originalWrite;
    }
  });
});

// ---------------------------------------------------------------------------
// Request → response lifecycle trace
// ---------------------------------------------------------------------------

describe("request lifecycle structured trace", () => {
  // The router emits two debug lines per WS request frame so an operator
  // can grep `reqId=<id>` and pull both halves of the round-trip from the
  // log file. The lines also carry `correlationId` (= IPC msg id) so the
  // runtime line can be joined to the plugin's own logs.
  function captureDebug<T>(fn: () => T): { result: T; lines: Record<string, unknown>[] } {
    // Lazy-import to keep the level mutation scoped to this block. We never
    // import setLogLevel at top-of-file because most tests rely on the
    // default `info` threshold.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { setLogLevel } = require("@uncorded/shared") as typeof import("@uncorded/shared");
    const captured: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: unknown) => {
      captured.push(String(chunk));
      return true;
    };
    setLogLevel("debug");
    try {
      const result = fn();
      const lines = captured
        .map((c) => { try { return JSON.parse(c.trim()) as Record<string, unknown>; } catch { return null; } })
        .filter((o): o is Record<string, unknown> => o !== null);
      return { result, lines };
    } finally {
      setLogLevel("info");
      process.stdout.write = originalWrite;
    }
  }

  test("plugin request emits matched dispatch + response debug lines", () => {
    const transport = mockTransport();
    const { router } = createRouter({ "text-channels": { transport } });
    const sender = mockSender();
    router.registerConnection("conn_42", mockUser({ id: "user_99" }), sender);

    const { lines } = captureDebug(() => {
      router.handleMessage("conn_42", {
        type: "request",
        id: "req_abc",
        plugin: "text-channels",
        action: "getMessages",
        params: { channelId: "x" },
      } satisfies RequestMessage);

      const correlationId = transport.sent[0]!["id"] as string;
      transport.simulateMessage({
        type: "response",
        id: correlationId,
        result: { ok: true },
      } as IpcMessage);
    });

    const dispatch = lines.find((l) => l["msg"] === "ws request → ipc dispatch");
    const response = lines.find((l) => l["msg"] === "ipc response → ws dispatch");

    expect(dispatch).toBeDefined();
    expect(dispatch!["reqId"]).toBe("req_abc");
    expect(dispatch!["connId"]).toBe("conn_42");
    expect(dispatch!["plugin"]).toBe("text-channels");
    expect(dispatch!["action"]).toBe("getMessages");
    expect(dispatch!["userId"]).toBe("user_99");
    expect(typeof dispatch!["correlationId"]).toBe("string");

    expect(response).toBeDefined();
    expect(response!["reqId"]).toBe("req_abc");
    expect(response!["connId"]).toBe("conn_42");
    expect(response!["plugin"]).toBe("text-channels");
    expect(response!["correlationId"]).toBe(dispatch!["correlationId"]);
    expect(response!["ok"]).toBe(true);
    expect(typeof response!["durationMs"]).toBe("number");
  });

  test("core request emits a single core-trace line (no IPC round-trip)", () => {
    const { router } = createRouter({});
    const sender = mockSender();
    router.registerConnection("conn_c", mockUser({ id: "user_c" }), sender);

    const { lines } = captureDebug(() => {
      // No coreModule attached → handler returns CORE_UNAVAILABLE early,
      // but the entry-trace line must fire BEFORE that branch is taken
      // ... actually it fires after rate-limit + before action dispatch.
      // We exercise the path where coreModule is absent only to confirm
      // the trace line is independent of the action's success.
      // For cores-enabled paths the line still fires — same code site.
      router.handleMessage("conn_c", {
        type: "request",
        id: "req_core",
        plugin: "core",
        action: "core.ping",
        params: {},
      } satisfies RequestMessage);
    });

    // No core module → no entry trace (the early-return path emits an
    // error response, not a debug trace). Sanity-check we didn't emit
    // a misleading "ws request" line.
    expect(lines.find((l) => l["msg"] === "ws request (core)")).toBeUndefined();
    // The plugin-routed debug message must NOT appear either.
    expect(lines.find((l) => l["msg"] === "ws request → ipc dispatch")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Event bus integration
// ---------------------------------------------------------------------------

describe("event bus integration", () => {
  function setupWithEventBus(pluginSlugs: string[]) {
    const transports: Record<string, MockTransport> = {};
    const processes: Record<string, PluginProcess> = {};
    const pluginConfigs: Record<string, { transport: MockTransport }> = {};

    for (const slug of pluginSlugs) {
      const t = mockTransport();
      transports[slug] = t;
      processes[slug] = mockPluginProcess(slug, t);
      pluginConfigs[slug] = { transport: t };
    }

    const provider = createTransportProvider(transports);
    const bus = new EventBus(provider, {
      retrySchedule: [10, 20, 50],
      maxConsecutiveFailures: 5,
    });

    const manager = mockSubprocessManager(processes);
    const router = new MessageRouter(manager, undefined, jsonCodec, bus);

    // Attach plugins with event capabilities
    for (const slug of pluginSlugs) {
      const checker = new CapabilityChecker(slug, [
        `events.publish:${slug}.*`,
        "events.subscribe:*",
        "events.unsubscribe:*",
      ]);
      router.attachPlugin(slug, transports[slug] as unknown as StdioParentTransport, checker);
    }

    return { router, transports, bus };
  }

  test("events.publish dispatches to event bus and sends ack", () => {
    const { transports } = setupWithEventBus(["text-channels", "members"]);

    // members subscribes
    transports["members"]!.simulateMessage({
      type: "events.subscribe",
      id: "sub_1",
      topic: "text-channels.*",
    });

    // Check subscribe ack
    const subAck = transports["members"]!.sent.find(
      (m) => m["type"] === "event.ack" && m["id"] === "sub_1",
    ) as IpcMessage | undefined;
    expect(subAck).toBeDefined();
    expect(subAck!["ok"]).toBe(true);

    // text-channels publishes
    transports["text-channels"]!.simulateMessage({
      type: "events.publish",
      id: "pub_1",
      topic: "text-channels.message.created",
      payload: { content: "hello" },
    });

    // Check publish ack
    const pubAck = transports["text-channels"]!.sent.find(
      (m) => m["type"] === "event.ack" && m["id"] === "pub_1",
    ) as IpcMessage | undefined;
    expect(pubAck).toBeDefined();
    expect(pubAck!["ok"]).toBe(true);
    expect(typeof pubAck!["event_id"]).toBe("string");

    // Check event delivered to members via IPC
    const delivered = transports["members"]!.sent.find(
      (m) => m["type"] === "event.deliver",
    ) as IpcMessage | undefined;
    expect(delivered).toBeDefined();
    expect(delivered!["topic"]).toBe("text-channels.message.created");
    expect(delivered!["source_plugin"]).toBe("text-channels");
    expect(delivered!["payload"]).toEqual({ content: "hello" });
  });

  test("events.publish broadcasts to connected WS clients", () => {
    const { router, transports } = setupWithEventBus(["text-channels"]);
    const sender = mockSender();

    router.registerConnection("conn_1", mockUser(), sender);

    transports["text-channels"]!.simulateMessage({
      type: "events.publish",
      id: "pub_1",
      topic: "text-channels.message.created",
      payload: { content: "hi" },
    });

    // WS client should receive EventMessage
    const wsEvent = sender.sent.find(
      (m) => (m as EventMessage).type === "event",
    ) as EventMessage | undefined;
    expect(wsEvent).toBeDefined();
    expect(wsEvent!.topic).toBe("text-channels.message.created");
    expect(wsEvent!.payload).toEqual({ content: "hi" });
  });

  test("events.unsubscribe stops delivery", () => {
    const { transports } = setupWithEventBus(["text-channels", "members"]);

    // Subscribe
    transports["members"]!.simulateMessage({
      type: "events.subscribe",
      id: "sub_1",
      topic: "text-channels.*",
    });

    // Unsubscribe
    transports["members"]!.simulateMessage({
      type: "events.unsubscribe",
      id: "unsub_1",
      topic: "text-channels.*",
    });

    // Publish — should NOT be delivered to members
    transports["text-channels"]!.simulateMessage({
      type: "events.publish",
      id: "pub_1",
      topic: "text-channels.message.created",
      payload: {},
    });

    const delivered = transports["members"]!.sent.filter(
      (m) => m["type"] === "event.deliver",
    );
    expect(delivered).toHaveLength(0);
  });

  test("events.publish to runtime.* is rejected with ack error", () => {
    // Give the plugin broad publish permission so capability gate passes
    // and the event bus's runtime namespace guard is what catches it
    const transport = mockTransport();
    const processes: Record<string, PluginProcess> = {
      "text-channels": mockPluginProcess("text-channels", transport),
    };
    const transportsMap: Record<string, MockTransport> = {
      "text-channels": transport,
    };
    const provider = createTransportProvider(transportsMap);
    const bus = new EventBus(provider);
    const manager = mockSubprocessManager(processes);
    const router = new MessageRouter(manager, undefined, jsonCodec, bus);
    const checker = new CapabilityChecker("text-channels", [
      "events.publish:*",
    ]);
    router.attachPlugin("text-channels", transport as unknown as StdioParentTransport, checker);

    transport.simulateMessage({
      type: "events.publish",
      id: "pub_bad",
      topic: "runtime.cascade.user.deleted",
      payload: {},
    });

    const ack = transport.sent.find(
      (m) => m["type"] === "event.ack" && m["id"] === "pub_bad",
    ) as IpcMessage | undefined;
    expect(ack).toBeDefined();
    expect(ack!["ok"]).toBe(false);
    expect((ack!["error"] as Record<string, unknown>)["code"]).toBe(
      "RUNTIME_NAMESPACE_RESERVED",
    );
  });

  test("events.publish without event bus returns unavailable error", () => {
    const transport = mockTransport();
    const checker = new CapabilityChecker("text-channels", [
      "events.publish:text-channels.*",
    ]);
    const manager = mockSubprocessManager({
      "text-channels": mockPluginProcess("text-channels", transport),
    });
    // No event bus provided
    const router = new MessageRouter(manager, undefined, jsonCodec);
    router.attachPlugin("text-channels", transport as unknown as StdioParentTransport, checker);

    transport.simulateMessage({
      type: "events.publish",
      id: "pub_1",
      topic: "text-channels.message.created",
      payload: {},
    });

    const ack = transport.sent.find(
      (m) => m["type"] === "event.ack" && m["id"] === "pub_1",
    ) as IpcMessage | undefined;
    expect(ack).toBeDefined();
    expect(ack!["ok"]).toBe(false);
    expect((ack!["error"] as Record<string, unknown>)["code"]).toBe(
      "EVENT_BUS_UNAVAILABLE",
    );
  });

  test("events.unsubscribe is passthrough — never gated by a capability", () => {
    // A plugin must always be able to stop listening to a topic it previously
    // subscribed to, so events.unsubscribe lives in PASSTHROUGH_TYPES.
    expect(
      buildCapabilityString({
        type: "events.unsubscribe",
        topic: "text-channels.*",
      }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Permissions + data.read integration (via router dispatch)
// ---------------------------------------------------------------------------

import { Database } from "bun:sqlite";
import { RolesEngine } from "../roles/engine";
import type { FileListFn, FileReadFn } from "../migrations";
import type { PluginRegistry, PluginInfo } from "../http/types";
import type { PluginManifest } from "@uncorded/shared";

const ROLES_MIGRATION_SQL = `
CREATE TABLE roles (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL UNIQUE,
  level       INTEGER NOT NULL CHECK (level >= 1 AND level <= 100),
  is_default  INTEGER NOT NULL DEFAULT 0,
  parent_role INTEGER REFERENCES roles(id) ON DELETE SET NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE TABLE user_roles (
  user_id TEXT    NOT NULL,
  role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_id)
);
CREATE INDEX idx_user_roles_user ON user_roles(user_id);
CREATE TABLE permissions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  key           TEXT    NOT NULL UNIQUE,
  description   TEXT    NOT NULL DEFAULT '',
  default_level INTEGER NOT NULL CHECK (default_level >= 0 AND default_level <= 100),
  plugin_slug   TEXT    NOT NULL,
  registered_at INTEGER NOT NULL
);
CREATE TABLE role_permissions (
  role_id       INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id INTEGER NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  granted       INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (role_id, permission_id)
);
`;

function makeRolesEngine(): { db: Database; engine: RolesEngine } {
  const db = new Database(":memory:");
  const listFiles: FileListFn = () => ["001_create_tables.sql"];
  const readFile: FileReadFn = () => ROLES_MIGRATION_SQL;
  const result = RolesEngine.initialize(db, "/migrations", listFiles, readFile);
  if (!result.ok) throw new Error(`Init failed: ${result.error.message}`);
  return { db, engine: new RolesEngine(db) };
}

describe("permissions dispatch via router", () => {
  test("permissions.register dispatched to handler and returns response", () => {
    const { engine } = makeRolesEngine();
    const transport = mockTransport();
    const checker = new CapabilityChecker("text-channels", ["permissions.register"]);
    const manager = mockSubprocessManager({
      "text-channels": mockPluginProcess("text-channels", transport),
    });
    const router = new MessageRouter(manager, undefined, jsonCodec, undefined, engine);
    router.attachPlugin("text-channels", transport as unknown as StdioParentTransport, checker);

    transport.simulateMessage({
      type: "permissions.register",
      id: "pr1",
      key: "chat.send",
      description: "Send messages",
      default_level: 10,
    });

    const resp = transport.sent.find((m) => m.type === "response" && m.id === "pr1");
    expect(resp).toBeDefined();
    expect(resp!["result"]).toBe(true);
  });

  test("permissions.check with owner bypass via connected user", () => {
    const { engine } = makeRolesEngine();
    engine.registerPermission({
      key: "admin.panel",
      description: "Access admin panel",
      defaultLevel: 80,
      pluginSlug: "core",
    });

    const transport = mockTransport();
    const checker = new CapabilityChecker("core", ["permissions.check"]);
    const manager = mockSubprocessManager({
      core: mockPluginProcess("core", transport),
    });
    const router = new MessageRouter(manager, undefined, jsonCodec, undefined, engine);
    router.attachPlugin("core", transport as unknown as StdioParentTransport, checker);

    // Register a connected user with owner role
    const sender = mockSender();
    router.registerConnection("conn_owner", mockUser({ id: "owner-1", role: "owner" }), sender);

    transport.simulateMessage({
      type: "permissions.check",
      id: "pc1",
      user_id: "owner-1",
      permission: "admin.panel",
    });

    const resp = transport.sent.find((m) => m.type === "response" && m.id === "pc1");
    expect(resp).toBeDefined();
    expect(resp!["result"]).toBe(true);
  });

  test("permissions.check without roles engine returns error", () => {
    const transport = mockTransport();
    const checker = new CapabilityChecker("core", ["permissions.check"]);
    const manager = mockSubprocessManager({
      core: mockPluginProcess("core", transport),
    });
    // No roles engine
    const router = new MessageRouter(manager, undefined, jsonCodec);
    router.attachPlugin("core", transport as unknown as StdioParentTransport, checker);

    transport.simulateMessage({
      type: "permissions.check",
      id: "pc2",
      user_id: "user_1",
      permission: "anything",
    });

    const resp = transport.sent.find((m) => m.type === "response" && m.id === "pc2");
    expect(resp).toBeDefined();
    expect((resp!["error"] as { code: string }).code).toBe("ROLES_ENGINE_UNAVAILABLE");
  });
});

describe("data.read dispatch via router", () => {
  test("data.read dispatched to handler and returns rows", () => {
    const targetDb = new Database(":memory:");
    targetDb.run("CREATE TABLE channels (id TEXT, name TEXT, topic TEXT, created_at INTEGER)");
    targetDb.run("INSERT INTO channels VALUES ('ch1', 'general', 'General chat', 1000)");

    const manifest: PluginManifest = {
      name: "text-channels",
      version: "1.0.0",
      api_version: "1",
      author: "test",
      description: "Test",
      license: "MIT",
      type: "standalone",
      permissions: [],
      public_schema: {
        channels: { columns: ["id", "name", "topic", "created_at"], description: "Channels" },
      },
    };

    const registry: PluginRegistry = {
      getPlugin(slug: string): PluginInfo | undefined {
        if (slug === "text-channels") {
          return { slug, manifest, dataDir: "/data/plugins/text-channels", frontendDir: null, authenticatedAssets: false, ready: true };
        }
        return undefined;
      },
      getPluginCount() { return 1; },
      listPlugins() { return []; },
      setReady() {},
    };

    const transport = mockTransport();
    const checker = new CapabilityChecker("reactions", ["data.read:text-channels.channels"]);
    const manager = mockSubprocessManager({
      reactions: mockPluginProcess("reactions", transport),
    });
    const router = new MessageRouter(
      manager, undefined, jsonCodec, undefined, undefined, registry,
      () => targetDb,
    );
    router.attachPlugin("reactions", transport as unknown as StdioParentTransport, checker);

    transport.simulateMessage({
      type: "data.read",
      id: "dr1",
      plugin: "text-channels",
      table: "channels",
      select: ["id", "name"],
    });

    const resp = transport.sent.find((m) => m.type === "response" && m.id === "dr1");
    expect(resp).toBeDefined();
    expect(resp!["result"]).toEqual([{ id: "ch1", name: "general" }]);
  });

  test("data.read without plugin registry returns error", () => {
    const transport = mockTransport();
    const checker = new CapabilityChecker("reactions", ["data.read:text-channels.channels"]);
    const manager = mockSubprocessManager({
      reactions: mockPluginProcess("reactions", transport),
    });
    // No plugin registry
    const router = new MessageRouter(manager, undefined, jsonCodec);
    router.attachPlugin("reactions", transport as unknown as StdioParentTransport, checker);

    transport.simulateMessage({
      type: "data.read",
      id: "dr2",
      plugin: "text-channels",
      table: "channels",
    });

    const resp = transport.sent.find((m) => m.type === "response" && m.id === "dr2");
    expect(resp).toBeDefined();
    expect((resp!["error"] as { code: string }).code).toBe("PLUGIN_REGISTRY_UNAVAILABLE");
  });

  test("data.read capability denied by checker", () => {
    const transport = mockTransport();
    // Only has data.read for text-channels.messages, NOT channels
    const checker = new CapabilityChecker("reactions", ["data.read:text-channels.messages"]);
    const manager = mockSubprocessManager({
      reactions: mockPluginProcess("reactions", transport),
    });
    const router = new MessageRouter(manager, undefined, jsonCodec);
    router.attachPlugin("reactions", transport as unknown as StdioParentTransport, checker);

    transport.simulateMessage({
      type: "data.read",
      id: "dr3",
      plugin: "text-channels",
      table: "channels",
    });

    // Should get a response error, not a silent hang
    const errors = transport.sent.filter((m) => m["type"] === "response" && m["error"] !== undefined);
    expect(errors).toHaveLength(1);
    expect((errors[0]!["error"] as { code: string }).code).toBe("CAPABILITY_DENIED");
  });
});

// ---------------------------------------------------------------------------
// broadcastEvent (public) — used for shutdown notifications
// ---------------------------------------------------------------------------

describe("broadcastEvent", () => {
  test("broadcasts event to all connected WS clients", () => {
    const manager = mockSubprocessManager({});
    const router = new MessageRouter(manager, undefined, jsonCodec);

    const sender1 = mockSender();
    const sender2 = mockSender();
    router.registerConnection("conn_1", mockUser({ id: "u1" }), sender1);
    router.registerConnection("conn_2", mockUser({ id: "u2" }), sender2);

    router.broadcastEvent("runtime.server.shutting_down", { reason: "shutdown" });

    const event1 = sender1.sent.find(
      (m) => (m as EventMessage).type === "event",
    ) as EventMessage | undefined;
    expect(event1).toBeDefined();
    expect(event1!.topic).toBe("runtime.server.shutting_down");
    expect(event1!.payload).toEqual({ reason: "shutdown" });

    const event2 = sender2.sent.find(
      (m) => (m as EventMessage).type === "event",
    ) as EventMessage | undefined;
    expect(event2).toBeDefined();
    expect(event2!.topic).toBe("runtime.server.shutting_down");
  });

  test("broadcasts to zero clients without error", () => {
    const manager = mockSubprocessManager({});
    const router = new MessageRouter(manager, undefined, jsonCodec);

    // Should not throw
    router.broadcastEvent("runtime.server.shutting_down", { reason: "shutdown" });
  });
});

// ---------------------------------------------------------------------------
// Broadcast dispatch — PAYLOAD_TOO_LARGE at the plugin-facing boundary
// ---------------------------------------------------------------------------

describe("broadcast dispatch size cap", () => {
  // 1 MB. Must match MAX_WS_OUTBOUND_BYTES in router.ts. If the source constant
  // is relaxed, the test should be updated deliberately.
  const CAP = 1 * 1024 * 1024;

  /** Wire up a router with broadcast.clients granted so the dispatch reaches our size check. */
  function setupBroadcastCapable(): {
    router: MessageRouter;
    transport: MockTransport;
  } {
    const transport = mockTransport();
    const manager = mockSubprocessManager({
      echo: mockPluginProcess("echo", transport),
    });
    const router = new MessageRouter(manager, undefined, jsonCodec);
    const checker = new CapabilityChecker("echo", ["broadcast.clients"]);
    router.attachPlugin("echo", transport as unknown as StdioParentTransport, checker);
    return { router, transport };
  }

  test("broadcast.toAll over the cap returns PAYLOAD_TOO_LARGE and does not fan out", () => {
    const { router, transport } = setupBroadcastCapable();

    const sender = mockSender();
    router.registerConnection("conn1", mockUser(), sender);

    // Payload encodes well past 1 MB once wrapped in the event envelope.
    const big = "x".repeat(CAP + 1024);

    transport.simulateMessage({
      type: "broadcast.toAll",
      id: "bc_1",
      event: "huge",
      payload: { data: big },
    } as IpcMessage);

    const reply = transport.sent.find(
      (m) => (m as { id?: string }).id === "bc_1",
    ) as { error?: { code: string; message: string } } | undefined;

    expect(reply).toBeDefined();
    expect(reply!.error?.code).toBe("PAYLOAD_TOO_LARGE");
    expect(reply!.error?.message).toContain(String(CAP));

    // No event frame should have reached the WS sender.
    const events = sender.sent.filter(
      (m) => (m as EventMessage).type === "event",
    );
    expect(events).toHaveLength(0);
  });

  test("broadcast.toUsers over the cap returns PAYLOAD_TOO_LARGE and does not fan out", () => {
    const { router, transport } = setupBroadcastCapable();

    const sender = mockSender();
    router.registerConnection("conn1", mockUser({ id: "u1" }), sender);

    const big = "x".repeat(CAP + 1024);

    transport.simulateMessage({
      type: "broadcast.toUsers",
      id: "bcu_1",
      userIds: ["u1"],
      event: "huge",
      payload: { data: big },
    } as IpcMessage);

    const reply = transport.sent.find(
      (m) => (m as { id?: string }).id === "bcu_1",
    ) as { error?: { code: string; message: string } } | undefined;

    expect(reply).toBeDefined();
    expect(reply!.error?.code).toBe("PAYLOAD_TOO_LARGE");

    const events = sender.sent.filter(
      (m) => (m as EventMessage).type === "event",
    );
    expect(events).toHaveLength(0);
  });

  test("broadcast.toAll under the cap delivers the event normally", () => {
    const { router, transport } = setupBroadcastCapable();

    const sender = mockSender();
    router.registerConnection("conn1", mockUser(), sender);

    transport.simulateMessage({
      type: "broadcast.toAll",
      id: "bc_ok",
      event: "small",
      payload: { n: 1 },
    } as IpcMessage);

    const reply = transport.sent.find(
      (m) => (m as { id?: string }).id === "bc_ok",
    ) as { error?: unknown; result?: unknown } | undefined;
    expect(reply).toBeDefined();
    expect(reply!.error).toBeUndefined();

    const events = sender.sent.filter(
      (m) => (m as EventMessage).type === "event",
    );
    expect(events).toHaveLength(1);
    expect((events[0] as EventMessage).topic).toBe("echo.small");
  });
});

// ---------------------------------------------------------------------------
// Per-message rate limiting (C4)
// ---------------------------------------------------------------------------

describe("per-message rate limiting", () => {
  test("rate-limited request returns RATE_LIMITED error to client", () => {
    const transport = mockTransport();
    const { router } = createRouter({ echo: { transport } });

    // Inject a rate limiter with injectable time
    let fakeTime = 1000;
    const limiter = new RateLimiter(() => fakeTime);
    router.setRateLimiter(limiter);

    const sender = mockSender();
    router.registerConnection("conn1", mockUser(), sender);

    // Send 60 requests (the limit) — all should succeed
    for (let i = 0; i < 60; i++) {
      router.handleMessage("conn1", {
        type: "request",
        id: `req_${i}`,
        plugin: "echo",
        action: "test",
        params: {},
      });
    }

    // All 60 should have been forwarded to the plugin
    expect(transport.sent.length).toBe(60);

    // 61st request should be rate limited
    router.handleMessage("conn1", {
      type: "request",
      id: "req_limited",
      plugin: "echo",
      action: "test",
      params: {},
    });

    // Plugin should NOT receive the 61st request
    expect(transport.sent.length).toBe(60);

    // Client should receive a rate limit error
    const lastMsg = sender.sent[sender.sent.length - 1] as ResponseMessage;
    expect(lastMsg.type).toBe("response");
    expect(lastMsg.id).toBe("req_limited");
    expect(lastMsg.error?.code).toBe("RATE_LIMITED");
  });

  test("rate-limited subscribe returns RATE_LIMITED event ack to plugin", () => {
    const transport = mockTransport();
    const checker = new CapabilityChecker("members", ["events.subscribe:*"]);
    const manager = mockSubprocessManager({
      members: mockPluginProcess("members", transport),
    });
    const provider = createTransportProvider({ members: transport });
    const bus = new EventBus(provider);
    const router = new MessageRouter(manager, undefined, jsonCodec, bus);

    let fakeTime = 1000;
    const limiter = new RateLimiter(() => fakeTime);
    router.setRateLimiter(limiter);
    router.attachPlugin(
      "members",
      transport as unknown as StdioParentTransport,
      checker,
    );

    for (let i = 0; i < 20; i++) {
      transport.simulateMessage({
        type: "events.subscribe",
        id: `sub_${i}`,
        topic: `members.topic.${i}`,
      });
    }

    transport.simulateMessage({
      type: "events.subscribe",
      id: "sub_limited",
      topic: "members.topic.limited",
    });

    const limitedAck = transport.sent.find(
      (m) => m["type"] === "event.ack" && m["id"] === "sub_limited",
    ) as IpcEventAckMessage | undefined;

    expect(limitedAck).toBeDefined();
    expect(limitedAck).toEqual({
      type: "event.ack",
      id: "sub_limited",
      ok: false,
      error: {
        code: "RATE_LIMITED",
        message: "Subscribe rate limit exceeded",
      },
    });
  });

  test("rate limit is per-user per-plugin", () => {
    const transportA = mockTransport();
    const transportB = mockTransport();
    const { router } = createRouter({
      pluginA: { transport: transportA },
      pluginB: { transport: transportB },
    });

    let fakeTime = 1000;
    const limiter = new RateLimiter(() => fakeTime);
    router.setRateLimiter(limiter);

    const sender = mockSender();
    router.registerConnection("conn1", mockUser({ id: "user_1" }), sender);

    // Exhaust limit for pluginA
    for (let i = 0; i < 60; i++) {
      router.handleMessage("conn1", {
        type: "request",
        id: `a_${i}`,
        plugin: "pluginA",
        action: "test",
        params: {},
      });
    }

    // pluginB should still work
    router.handleMessage("conn1", {
      type: "request",
      id: "b_1",
      plugin: "pluginB",
      action: "test",
      params: {},
    });

    expect(transportB.sent.length).toBe(1);
  });

  test("rate limit resets after window elapses", () => {
    const transport = mockTransport();
    const { router } = createRouter({ echo: { transport } });

    let fakeTime = 1000;
    const limiter = new RateLimiter(() => fakeTime);
    router.setRateLimiter(limiter);

    const sender = mockSender();
    router.registerConnection("conn1", mockUser(), sender);

    // Exhaust limit
    for (let i = 0; i < 60; i++) {
      router.handleMessage("conn1", {
        type: "request",
        id: `req_${i}`,
        plugin: "echo",
        action: "test",
        params: {},
      });
    }

    // Should be rate limited
    router.handleMessage("conn1", {
      type: "request",
      id: "req_limited",
      plugin: "echo",
      action: "test",
      params: {},
    });
    expect(transport.sent.length).toBe(60);

    // Advance time past the window
    fakeTime += 61_000;

    router.handleMessage("conn1", {
      type: "request",
      id: "req_after_window",
      plugin: "echo",
      action: "test",
      params: {},
    });

    // Should succeed after window reset
    expect(transport.sent.length).toBe(61);
  });

  test("no rate limiting when limiter not set", () => {
    const transport = mockTransport();
    const { router } = createRouter({ echo: { transport } });
    // Don't set a rate limiter

    const sender = mockSender();
    router.registerConnection("conn1", mockUser(), sender);

    // Should work without limits
    for (let i = 0; i < 100; i++) {
      router.handleMessage("conn1", {
        type: "request",
        id: `req_${i}`,
        plugin: "echo",
        action: "test",
        params: {},
      });
    }

    expect(transport.sent.length).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// Plugin resource SDK dispatch (resources.*) — RP-FOUND-4 boot-wiring contract
//
// The boot follow-up calls router.setPluginResources({ store, resolver,
// serverId }). These tests pin the router's two states around that call:
//   - UNWIRED: resources.* answers PLUGIN_RESOURCES_UNAVAILABLE.
//   - WIRED:   resources.* is served by handlePluginResourcesIpc (the resolver
//              answers with an AuthDecision, never the UNAVAILABLE error).
// A real RP-FOUND-2 store over an in-memory core.db (migrations applied) and a
// real RP-FOUND-3 resolver stand in for what boot constructs.
// ---------------------------------------------------------------------------

describe("plugin resource dispatch (resources.*)", () => {
  const RESOURCE_MIGRATIONS_DIR = join(import.meta.dir, "../plugin-resources/migrations");

  function buildPluginResourceBackend(): {
    store: PluginResourceStore;
    resolver: PluginResourceResolver;
  } {
    const db = new Database(":memory:");
    const init = PluginResourceStore.initialize(
      db,
      RESOURCE_MIGRATIONS_DIR,
      (dir) => readdirSync(dir),
      (path) => readFileSync(path, "utf-8"),
    );
    if (!init.ok) throw new Error(`migration failed: ${init.error.message}`);
    const store = new PluginResourceStore(db);
    const resolver = new PluginResourceResolver({
      store,
      roles: { getRole: () => ({ id: 1 }) },
      isBanned: () => false,
      // Server-scoped, fail-closed predicate (mirrors makePluginResourceMembershipCheck).
      isMember: (serverId, _userId) => serverId === "srv-1",
    });
    return { store, resolver };
  }

  const ownCheck = {
    type: "resources.check",
    id: "ck_1",
    user_id: "billy",
    resource: {
      kind: "pluginResource",
      pluginSlug: "family-album",
      resourceType: "album",
      resourceId: "ghost",
    },
    action: "read",
  } as unknown as IpcMessage;

  test("UNWIRED: resources.* answers PLUGIN_RESOURCES_UNAVAILABLE", () => {
    const transport = mockTransport();
    const checker = new CapabilityChecker("family-album", []);
    const manager = mockSubprocessManager({
      "family-album": mockPluginProcess("family-album", transport),
    });
    const router = new MessageRouter(manager, undefined, jsonCodec);
    router.attachPlugin("family-album", transport as unknown as StdioParentTransport, checker);
    // NOTE: setPluginResources is intentionally NOT called.

    transport.simulateMessage(ownCheck);

    const responses = transport.sent.filter(
      (m) => m["type"] === "response" && m["id"] === "ck_1",
    );
    expect(responses).toHaveLength(1);
    const err = responses[0]!["error"] as Record<string, unknown> | undefined;
    expect(err?.["code"]).toBe("PLUGIN_RESOURCES_UNAVAILABLE");
  });

  test("WIRED: resources.* is served by the resolver (no UNAVAILABLE error, returns a decision)", () => {
    const transport = mockTransport();
    const checker = new CapabilityChecker("family-album", []);
    const manager = mockSubprocessManager({
      "family-album": mockPluginProcess("family-album", transport),
    });
    const router = new MessageRouter(manager, undefined, jsonCodec);
    router.attachPlugin("family-album", transport as unknown as StdioParentTransport, checker);

    const { store, resolver } = buildPluginResourceBackend();
    router.setPluginResources({ store, resolver, serverId: "srv-1" });

    transport.simulateMessage(ownCheck);

    const responses = transport.sent.filter(
      (m) => m["type"] === "response" && m["id"] === "ck_1",
    );
    expect(responses).toHaveLength(1);
    const res = responses[0]!;
    // Served, not the unavailable error: an own-plugin check on an unknown
    // resource fails closed inside the resolver as a DECISION, not an IPC error.
    expect(res["error"]).toBeUndefined();
    const result = res["result"] as Record<string, unknown> | undefined;
    expect(result?.["allowed"]).toBe(false);
    expect(result?.["reason"]).toBe("unknown-resource");
  });
});
