import { describe, expect, test } from "bun:test";
import { handlePresenceIpc } from "./ipc";
import { ScopedPresenceModule } from "./module";
import { PRESENCE_ERROR_CODES } from "./types";
import { EventBus } from "../events/bus";
import { RateLimiter } from "../http/rate-limiter";
import { rootLogger } from "@uncorded/shared";
import type { IpcMessage } from "../ipc/transport";
import type { StdioParentTransport } from "../ipc/transport";
import type { PluginTransportProvider } from "../events/types";

function makeFixture() {
  const transportProvider: PluginTransportProvider = {
    getTransport() {
      // Duck-typed transport — only send/onMessage/close are exercised in this test.
      return {
        send() {},
        onMessage() {},
        close() {},
      } as unknown as ReturnType<PluginTransportProvider["getTransport"]>;
    },
    isPluginAlive() { return true; },
  };
  const bus = new EventBus(transportProvider);
  const rateLimiter = new RateLimiter(() => Date.now());
  const module = new ScopedPresenceModule(bus, rateLimiter, rootLogger, {
    installedSlugs: () => new Set(["text-channels", "voice"]),
  });

  const sent: IpcMessage[] = [];
  const transport: StdioParentTransport = {
    send(msg: IpcMessage) { sent.push(msg); },
    onMessage() {},
    close() {},
  } as unknown as StdioParentTransport;

  return { module, transport, sent };
}

describe("handlePresenceIpc — happy paths", () => {
  test("presence.join routes to module.join and replies with result", () => {
    const { module, transport, sent } = makeFixture();
    module.registerSession("c-1");

    handlePresenceIpc(
      "text-channels",
      {
        type: "presence.join",
        id: "req-1",
        scope: "thread.a",
        user_id: "u-1",
        session_id: "c-1",
        meta: {},
      },
      transport,
      module,
    );

    expect(sent).toHaveLength(1);
    const reply = sent[0]!;
    expect(reply["type"]).toBe("response");
    expect(reply["id"]).toBe("req-1");
    expect(reply["error"]).toBeUndefined();
    const result = reply["result"] as Record<string, unknown>;
    expect(result["scope"]).toBe("text-channels.thread.a");
  });

  test("presence.list returns the entry list", () => {
    const { module, transport, sent } = makeFixture();
    module.registerSession("c-1");
    module.join("text-channels", "thread.a", "u-1", "c-1", { typing: true });

    handlePresenceIpc(
      "text-channels",
      {
        type: "presence.list",
        id: "req-2",
        scope: "thread.a",
      },
      transport,
      module,
    );

    expect(sent).toHaveLength(1);
    const result = sent[0]!["result"] as unknown[];
    expect(result).toHaveLength(1);
  });

  test("presence.leave then presence.list returns empty", () => {
    const { module, transport, sent } = makeFixture();
    module.registerSession("c-1");
    module.join("text-channels", "thread.a", "u-1", "c-1", {});

    handlePresenceIpc(
      "text-channels",
      {
        type: "presence.leave",
        id: "req-3",
        scope: "thread.a",
        user_id: "u-1",
        session_id: "c-1",
      },
      transport,
      module,
    );

    expect(sent[0]!["error"]).toBeUndefined();
    expect(module.getRegistry().size()).toBe(0);
  });

  test("presence.update routes to module.update", () => {
    const { module, transport, sent } = makeFixture();
    module.registerSession("c-1");
    module.join("text-channels", "thread.a", "u-1", "c-1", { x: 1 });

    handlePresenceIpc(
      "text-channels",
      {
        type: "presence.update",
        id: "req-4",
        scope: "thread.a",
        user_id: "u-1",
        session_id: "c-1",
        meta: { x: 2 },
      },
      transport,
      module,
    );

    expect(sent[0]!["error"]).toBeUndefined();
    expect(module.getRegistry().get("text-channels.thread.a", "c-1")?.meta).toEqual({ x: 2 });
  });
});

describe("handlePresenceIpc — error paths", () => {
  test("missing session_id field → error response", () => {
    const { module, transport, sent } = makeFixture();
    handlePresenceIpc(
      "text-channels",
      {
        type: "presence.join",
        id: "req-1",
        scope: "thread.a",
        user_id: "u-1",
      },
      transport,
      module,
    );
    expect(sent[0]!["error"]).toBeDefined();
    expect((sent[0]!["error"] as Record<string, unknown>)["code"]).toBe(
      PRESENCE_ERROR_CODES.SCOPE_INVALID,
    );
  });

  test("session not active → SESSION_GONE error response", () => {
    const { module, transport, sent } = makeFixture();
    handlePresenceIpc(
      "text-channels",
      {
        type: "presence.join",
        id: "req-1",
        scope: "thread.a",
        user_id: "u-1",
        session_id: "c-missing",
        meta: {},
      },
      transport,
      module,
    );
    expect((sent[0]!["error"] as Record<string, unknown>)["code"]).toBe(
      PRESENCE_ERROR_CODES.SESSION_GONE,
    );
  });

  test("update with non-object meta → META_TOO_LARGE error response", () => {
    const { module, transport, sent } = makeFixture();
    module.registerSession("c-1");
    handlePresenceIpc(
      "text-channels",
      {
        type: "presence.update",
        id: "req-1",
        scope: "thread.a",
        user_id: "u-1",
        session_id: "c-1",
        meta: "not an object",
      },
      transport,
      module,
    );
    expect((sent[0]!["error"] as Record<string, unknown>)["code"]).toBe(
      PRESENCE_ERROR_CODES.META_TOO_LARGE,
    );
  });

  test("unknown presence.* type → UNAVAILABLE error", () => {
    const { module, transport, sent } = makeFixture();
    handlePresenceIpc(
      "text-channels",
      {
        type: "presence.unknown",
        id: "req-1",
      },
      transport,
      module,
    );
    expect((sent[0]!["error"] as Record<string, unknown>)["code"]).toBe(
      PRESENCE_ERROR_CODES.UNAVAILABLE,
    );
  });

  test("malformed message with no id → silently dropped (no reply)", () => {
    const { module, transport, sent } = makeFixture();
    handlePresenceIpc(
      "text-channels",
      { type: "presence.join" },
      transport,
      module,
    );
    expect(sent).toHaveLength(0);
  });
});
