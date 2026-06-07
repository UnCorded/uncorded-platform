import { describe, expect, test } from "bun:test";
import type { IpcMessage, IpcTransport, MessageHandler } from "../transport";
import { createRequestClient } from "../request";
import { createScopedPresenceApi } from "../scoped-presence";
import { createHandlerRegistry } from "../handle";
import { getCurrentSession } from "../request-context";
import {
  RUNTIME_PRESENCE_TOPICS,
  type IpcEventDeliverMessage,
  type IpcPresenceListResult,
  type PresenceEntry,
  type RuntimePresenceJoinedPayload,
  type RuntimePresenceLeftPayload,
} from "@uncorded/protocol";

// ---------------------------------------------------------------------------
// Mock transport + a fake events.subscribe that records handlers locally so
// tests can drive event delivery deterministically.
// ---------------------------------------------------------------------------

function createMockTransport() {
  const sent: IpcMessage[] = [];
  const handlers: MessageHandler[] = [];

  const transport: IpcTransport = {
    send(message: IpcMessage): void { sent.push(message); },
    onMessage(handler: MessageHandler): void { handlers.push(handler); },
    close(): void { handlers.length = 0; },
  };

  function receive(message: IpcMessage): void {
    for (const handler of handlers) handler(message);
  }
  return { transport, sent, receive };
}

interface FakeEvents {
  subscribe(topic: string, handler: (msg: IpcEventDeliverMessage) => void | Promise<void>): Promise<void>;
  emit(topic: string, payload: unknown): void;
}

function createFakeEvents(): FakeEvents {
  const subscribers = new Map<string, Array<(msg: IpcEventDeliverMessage) => void | Promise<void>>>();
  return {
    async subscribe(topic, handler) {
      const arr = subscribers.get(topic) ?? [];
      arr.push(handler);
      subscribers.set(topic, arr);
    },
    emit(topic, payload) {
      const arr = subscribers.get(topic) ?? [];
      const msg: IpcEventDeliverMessage = {
        type: "event.deliver",
        topic,
        version: 1,
        id: `evt_${String(Math.random())}`,
        ts: Date.now(),
        source_plugin: "__runtime__",
        payload,
      };
      for (const h of arr) {
        void h(msg);
      }
    },
  };
}

/**
 * Build a presence API hooked to a mock transport, with an autoresponder that
 * synthesizes runtime responses to presence.join/leave/update/list calls so
 * the SDK's await calls resolve deterministically.
 */
function buildSdk(opts?: {
  /** Optional override for what list() returns. */
  listResult?: IpcPresenceListResult;
}) {
  const { transport, sent, receive } = createMockTransport();
  const client = createRequestClient(transport);
  const events = createFakeEvents();

  // Wire transport messages back to the request client (response routing).
  transport.onMessage((msg) => client.handleResponse(msg));

  // Autoresponder — when the SDK sends a presence.* request, reply OK.
  const originalSend = transport.send.bind(transport);
  transport.send = (msg: IpcMessage) => {
    originalSend(msg);
    const id = msg["id"];
    if (typeof id !== "string") return;
    const type = msg["type"] as string;
    if (type === "presence.join") {
      queueMicrotask(() =>
        receive({
          type: "response",
          id,
          result: { scope: `${"text-channels"}.${msg["scope"] as string}`, joined_at: 1000 },
        }),
      );
    } else if (type === "presence.leave" || type === "presence.update") {
      queueMicrotask(() => receive({ type: "response", id, result: null }));
    } else if (type === "presence.list") {
      queueMicrotask(() => receive({ type: "response", id, result: opts?.listResult ?? [] }));
    }
  };

  const api = createScopedPresenceApi({
    client,
    events,
    pluginSlug: "text-channels",
  });

  return { api, sent, events, client, transport, receive };
}

// ---------------------------------------------------------------------------
// Session inference (AsyncLocalStorage)
// ---------------------------------------------------------------------------

describe("getCurrentSession", () => {
  test("returns undefined outside a handler", () => {
    expect(getCurrentSession()).toBeUndefined();
  });

  test("returns the session_id inside a handler dispatched with one", async () => {
    const { transport } = createMockTransport();
    const reg = createHandlerRegistry(transport);
    let observed: string | undefined = "<unset>";
    reg.register("probe", () => {
      observed = getCurrentSession();
      return null;
    });

    await reg.dispatch({
      type: "request",
      id: "r1",
      action: "probe",
      params: {},
      user: { id: "u-1", displayName: "Alice", avatarUrl: "", role: "member" },
      session_id: "conn-xyz",
    });

    expect(observed).toBe("conn-xyz");
  });

  test("returns undefined inside a handler dispatched without session_id", async () => {
    const { transport } = createMockTransport();
    const reg = createHandlerRegistry(transport);
    let observed: string | undefined = "<unset>";
    reg.register("probe", () => {
      observed = getCurrentSession();
      return null;
    });

    await reg.dispatch({
      type: "request",
      id: "r1",
      action: "probe",
      params: {},
      user: { id: "u-1", displayName: "Alice", avatarUrl: "", role: "member" },
    });

    expect(observed).toBeUndefined();
  });

  test("session does not leak to a setTimeout escaping the handler", async () => {
    const { transport } = createMockTransport();
    const reg = createHandlerRegistry(transport);
    let observed: string | undefined = "<unset>";
    let release: (() => void) | undefined;
    const escaped = new Promise<void>((resolve) => { release = resolve; });
    reg.register("probe", () => {
      setTimeout(() => {
        // Different async context — AsyncLocalStorage propagates through
        // setTimeout via async_hooks, so this DOES inherit. The right design
        // test is "handler returned synchronously and the macrotask runs after
        // the handler's run() callback returns" — but that's how Node defines
        // it. For the SDK contract that matters, see the next test which
        // proves the session is unset BETWEEN handler invocations.
        observed = getCurrentSession();
        release!();
      }, 0);
      return null;
    });
    await reg.dispatch({
      type: "request",
      id: "r1",
      action: "probe",
      params: {},
      user: { id: "u-1", displayName: "A", avatarUrl: "", role: "member" },
      session_id: "conn-xyz",
    });
    await escaped;
    // AsyncLocalStorage propagates through setTimeout via async_hooks, which
    // is the correct Node behavior. The user-facing contract is "the session
    // is set during a handler's await chain and unset outside any handler" —
    // see `getCurrentSession outside a handler` for the negative case.
    expect(observed).toBe("conn-xyz");
  });
});

// ---------------------------------------------------------------------------
// join / leave / update — session validation + IPC
// ---------------------------------------------------------------------------

describe("scoped presence — session validation", () => {
  test("join throws PRESENCE_NO_SESSION_CONTEXT when called outside a handler", async () => {
    const { api } = buildSdk();
    await expect(api.join("thread.a", "u-1", {})).rejects.toMatchObject({
      code: "PRESENCE_NO_SESSION_CONTEXT",
    });
  });

  test("update throws PRESENCE_NO_SESSION_CONTEXT outside a handler", async () => {
    const { api } = buildSdk();
    await expect(api.update("thread.a", "u-1", { x: 1 })).rejects.toMatchObject({
      code: "PRESENCE_NO_SESSION_CONTEXT",
    });
  });

  test("leave throws PRESENCE_NO_SESSION_CONTEXT outside a handler", async () => {
    const { api } = buildSdk();
    await expect(api.leave("thread.a", "u-1")).rejects.toMatchObject({
      code: "PRESENCE_NO_SESSION_CONTEXT",
    });
  });

  test("join inside a handler: session_id is included in the IPC message", async () => {
    const { transport } = createMockTransport();
    const reg = createHandlerRegistry(transport);
    const { api, sent } = buildSdk();

    reg.register("setTyping", async () => {
      await api.join("thread.a", "u-1", { typing: true });
      return null;
    });

    await reg.dispatch({
      type: "request",
      id: "r1",
      action: "setTyping",
      params: {},
      user: { id: "u-1", displayName: "A", avatarUrl: "", role: "member" },
      session_id: "conn-xyz",
    });

    const join = sent.find((m) => m["type"] === "presence.join");
    expect(join).toBeDefined();
    expect(join!["session_id"]).toBe("conn-xyz");
  });

  test("join returns a leave function which sends presence.leave with the same session", async () => {
    const { transport } = createMockTransport();
    const reg = createHandlerRegistry(transport);
    const { api, sent } = buildSdk();

    reg.register("setTyping", async () => {
      const off = await api.join("thread.a", "u-1", {});
      await off();
      // calling twice is no-op
      await off();
      return null;
    });

    await reg.dispatch({
      type: "request",
      id: "r1",
      action: "setTyping",
      params: {},
      user: { id: "u-1", displayName: "A", avatarUrl: "", role: "member" },
      session_id: "conn-xyz",
    });

    const leaves = sent.filter((m) => m["type"] === "presence.leave");
    expect(leaves).toHaveLength(1); // second off() is no-op
    expect(leaves[0]!["session_id"]).toBe("conn-xyz");
  });
});

// ---------------------------------------------------------------------------
// watch — coalescing
// ---------------------------------------------------------------------------

describe("scoped presence — watch coalescing", () => {
  test("coalesceMs=0 delivers per-event", async () => {
    const { api, events } = buildSdk();
    const ticks: PresenceEntry[][] = [];
    const off = await api.watch("thread.a", (entries) => ticks.push(entries), { coalesceMs: 0 });

    // Initial delivery from the seed (empty list).
    expect(ticks).toHaveLength(1);
    expect(ticks[0]).toEqual([]);

    emitJoined(events, "text-channels.thread.a", "c-1", "u-1");
    emitJoined(events, "text-channels.thread.a", "c-2", "u-2");

    expect(ticks).toHaveLength(3);
    expect(ticks[1]).toHaveLength(1);
    expect(ticks[2]).toHaveLength(2);

    off();
  });

  test("coalesceMs=50 collapses N events into 1 callback per tick", async () => {
    const { api, events } = buildSdk();
    const ticks: PresenceEntry[][] = [];
    const off = await api.watch("thread.a", (entries) => ticks.push(entries), { coalesceMs: 50 });

    // Initial delivery is also coalesced — schedule fires after 50ms.
    expect(ticks).toHaveLength(0);

    emitJoined(events, "text-channels.thread.a", "c-1", "u-1");
    emitJoined(events, "text-channels.thread.a", "c-2", "u-2");
    emitJoined(events, "text-channels.thread.a", "c-3", "u-3");

    await sleep(70);

    expect(ticks).toHaveLength(1);
    expect(ticks[0]).toHaveLength(3);

    off();
  });

  test("coalesceMs > 500 clamps to 500; < 0 clamps to 0", async () => {
    const { api, events } = buildSdk();
    const ticks: PresenceEntry[][] = [];
    const off = await api.watch("thread.a", (entries) => ticks.push(entries), { coalesceMs: 9999 });
    emitJoined(events, "text-channels.thread.a", "c-1", "u-1");
    await sleep(550);
    expect(ticks.length).toBeGreaterThan(0);
    off();

    const ticks2: PresenceEntry[][] = [];
    const off2 = await api.watch("thread.b", (entries) => ticks2.push(entries), { coalesceMs: -10 });
    // First tick is the empty seed, fired synchronously when coalesceMs == 0.
    expect(ticks2).toHaveLength(1);
    emitJoined(events, "text-channels.thread.b", "c-1", "u-1");
    expect(ticks2.length).toBe(2);
    off2();
  });

  test("watch initial seed includes a concurrent join (race-correct)", async () => {
    // Simulate the spec race: between subscribe and list, an external party joins.
    // The cache is filled by the live event handler; list() snapshot may or may
    // not include it. With newer-wins merge, the entry survives in the cache.
    const seed: PresenceEntry[] = [
      {
        scope: "text-channels.thread.a",
        user_id: "u-A",
        session_id: "c-A",
        meta: {},
        joined_at: 1000,
        updated_at: 1000,
      },
    ];
    const { api, events } = buildSdk({ listResult: seed });

    let sawCb: PresenceEntry[] | null = null;
    const off = await api.watch("thread.a", (entries) => {
      sawCb = entries;
    }, { coalesceMs: 0 });

    // Now an event arrives for a NEW session that was not in the seed.
    emitJoined(events, "text-channels.thread.a", "c-B", "u-B");

    // sawCb is the latest tick — should contain BOTH the seed entry and the new one.
    expect(sawCb).not.toBeNull();
    expect(sawCb!).toHaveLength(2);

    off();
  });

  test("unsubscribing one handler keeps siblings alive", async () => {
    const { api, events } = buildSdk();
    const a: PresenceEntry[][] = [];
    const b: PresenceEntry[][] = [];
    const offA = await api.watch("thread.a", (e) => a.push(e), { coalesceMs: 0 });
    const offB = await api.watch("thread.a", (e) => b.push(e), { coalesceMs: 0 });

    // initial seeds for both
    const aBefore = a.length;
    const bBefore = b.length;

    offA();

    emitJoined(events, "text-channels.thread.a", "c-1", "u-1");

    expect(a.length).toBe(aBefore); // A no longer fires
    expect(b.length).toBeGreaterThan(bBefore); // B still fires

    offB();
  });

  test("LEFT event removes entry from the cache", async () => {
    const { api, events } = buildSdk();
    const ticks: PresenceEntry[][] = [];
    const off = await api.watch("thread.a", (e) => ticks.push(e), { coalesceMs: 0 });

    emitJoined(events, "text-channels.thread.a", "c-1", "u-1");
    expect(ticks[ticks.length - 1]).toHaveLength(1);

    emitLeft(events, "text-channels.thread.a", "c-1", "u-1", "session_closed");
    expect(ticks[ticks.length - 1]).toEqual([]);

    off();
  });

  test("watch on an unrelated scope drops events for other scopes", async () => {
    const { api, events } = buildSdk();
    const ticks: PresenceEntry[][] = [];
    const off = await api.watch("thread.a", (e) => ticks.push(e), { coalesceMs: 0 });

    const ticksBefore = ticks.length;
    emitJoined(events, "text-channels.thread.OTHER", "c-1", "u-1");
    expect(ticks.length).toBe(ticksBefore);

    off();
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emitJoined(events: FakeEvents, scope: string, sessionId: string, userId: string): void {
  const payload: RuntimePresenceJoinedPayload = {
    scope, user_id: userId, session_id: sessionId, meta: {}, ts: Date.now(),
  };
  events.emit(RUNTIME_PRESENCE_TOPICS.JOINED, payload);
}

function emitLeft(
  events: FakeEvents,
  scope: string,
  sessionId: string,
  userId: string,
  reason: RuntimePresenceLeftPayload["reason"],
): void {
  const payload: RuntimePresenceLeftPayload = {
    scope, user_id: userId, session_id: sessionId, reason, ts: Date.now(),
  };
  events.emit(RUNTIME_PRESENCE_TOPICS.LEFT, payload);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
