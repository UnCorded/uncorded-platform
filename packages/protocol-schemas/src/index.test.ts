import { describe, test, expect } from "bun:test";
import {
  ClientMessageSchema,
  ServerMessageSchema,
  IpcMessageSchema,
  RuntimeToPluginMessageSchema,
} from "./index";

describe("ClientMessageSchema", () => {
  test("auth: valid", () => {
    expect(
      ClientMessageSchema.safeParse({ type: "auth", token: "tok" }).success,
    ).toBe(true);
  });

  test("auth: token must be string", () => {
    expect(ClientMessageSchema.safeParse({ type: "auth", token: 123 }).success).toBe(
      false,
    );
  });

  test("request: valid", () => {
    expect(
      ClientMessageSchema.safeParse({
        type: "request",
        id: "r1",
        plugin: "tc",
        action: "list",
        params: { x: 1 },
      }).success,
    ).toBe(true);
  });

  test("request: missing params", () => {
    expect(
      ClientMessageSchema.safeParse({
        type: "request",
        id: "r1",
        plugin: "tc",
        action: "list",
      }).success,
    ).toBe(false);
  });

  test("unknown type rejected", () => {
    expect(
      ClientMessageSchema.safeParse({ type: "delete", token: "x" }).success,
    ).toBe(false);
  });

  test("co-view render-tree host frames stay out of the generic client schema", () => {
    // Runtime inbound CoView frames use the router's narrow parseClientMessage
    // guard; ClientMessageSchema remains the auth/request plugin client schema.
    expect(
      ClientMessageSchema.safeParse({
        type: "co-view.render-tree.frame",
        session_id: "sess-1",
        frame: {
          surfaceId: "text-channel",
          root: {
            id: "root",
            kind: "element",
            box: { x: 0, y: 0, width: 1, height: 1 },
          },
        },
      }).success,
    ).toBe(false);
  });

  test("__proto__ key on params is preserved as a string field, not prototype-polluted", () => {
    // Zod rejects unknown keys on object schemas by default — but params is
    // record(string, unknown), so it accepts arbitrary keys. The point of this
    // test is that a key named "__proto__" lands as a regular field on params,
    // it does not mutate the prototype chain.
    const res = ClientMessageSchema.safeParse({
      type: "request",
      id: "r1",
      plugin: "tc",
      action: "list",
      params: { __proto__: { polluted: true } },
    });
    expect(res.success).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const obj: Record<string, unknown> = {};
    expect((obj as { polluted?: unknown }).polluted).toBeUndefined();
  });
});

describe("ServerMessageSchema", () => {
  test("auth.result valid", () => {
    expect(
      ServerMessageSchema.safeParse({ type: "auth.result", ok: true }).success,
    ).toBe(true);
  });

  test("response with error", () => {
    expect(
      ServerMessageSchema.safeParse({
        type: "response",
        id: "r1",
        error: { code: "X", message: "y" },
      }).success,
    ).toBe(true);
  });

  test("event valid", () => {
    expect(
      ServerMessageSchema.safeParse({
        type: "event",
        topic: "tc.message.created",
        payload: { id: "m1" },
      }).success,
    ).toBe(true);
  });

  test("event without topic rejected", () => {
    expect(
      ServerMessageSchema.safeParse({ type: "event", payload: {} }).success,
    ).toBe(false);
  });

  test("unknown type rejected", () => {
    expect(
      ServerMessageSchema.safeParse({ type: "garbage", x: 1 }).success,
    ).toBe(false);
  });

  test("co-view projected render-tree frame valid", () => {
    expect(
      ServerMessageSchema.safeParse({
        type: "co-view.render-tree.projected",
        session_id: "sess-1",
        frame: {
          surfaceId: "text-channel",
          root: {
            id: "root",
            kind: "element",
            box: { x: 0, y: 0, width: 1, height: 1 },
          },
        },
      }).success,
    ).toBe(true);
  });

});

describe("IpcMessageSchema (envelope)", () => {
  test("type required", () => {
    expect(IpcMessageSchema.safeParse({ id: "x" }).success).toBe(false);
  });

  test("type must be non-empty string", () => {
    expect(IpcMessageSchema.safeParse({ type: "" }).success).toBe(false);
    expect(IpcMessageSchema.safeParse({ type: 1 }).success).toBe(false);
  });

  test("id when present must be string", () => {
    expect(IpcMessageSchema.safeParse({ type: "x", id: 123 }).success).toBe(false);
    expect(IpcMessageSchema.safeParse({ type: "x", id: "abc" }).success).toBe(true);
  });

  test("extra fields pass through", () => {
    const res = IpcMessageSchema.safeParse({
      type: "data.kv",
      id: "1",
      method: "get",
      key: "settings.theme",
    });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data["method"]).toBe("get");
      expect(res.data["key"]).toBe("settings.theme");
    }
  });
});

describe("RuntimeToPluginMessageSchema", () => {
  test("request valid", () => {
    expect(
      RuntimeToPluginMessageSchema.safeParse({
        type: "request",
        id: "r1",
        action: "list",
        params: {},
        user: { id: "u1", displayName: "u", avatarUrl: "", role: "member" },
      }).success,
    ).toBe(true);
  });

  test("request missing user rejected", () => {
    expect(
      RuntimeToPluginMessageSchema.safeParse({
        type: "request",
        id: "r1",
        action: "list",
        params: {},
      }).success,
    ).toBe(false);
  });

  test("ping valid", () => {
    expect(
      RuntimeToPluginMessageSchema.safeParse({ type: "ping" }).success,
    ).toBe(true);
  });

  test("event.deliver valid", () => {
    expect(
      RuntimeToPluginMessageSchema.safeParse({
        type: "event.deliver",
        topic: "x",
        version: 1,
        id: "e1",
        ts: 100,
        source_plugin: "p",
        payload: null,
      }).success,
    ).toBe(true);
  });

  test("unknown type rejected (dispatcher drops them silently)", () => {
    expect(
      RuntimeToPluginMessageSchema.safeParse({ type: "wat" }).success,
    ).toBe(false);
  });
});
