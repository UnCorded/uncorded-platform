// createResourcesApi (RP-FOUND-4 SDK surface) tests.
//
// Asserts each method emits the right `resources.*` IPC frame, omits the
// runtime-stamped `pluginSlug` from `define`, threads optional create fields,
// and parses the result — especially `check`, whose result must validate as an
// `AuthDecision`.

import { describe, expect, test } from "bun:test";
import { SdkProtocolError } from "../errors";
import { createRequestClient } from "../request";
import type { IpcMessage, IpcTransport, MessageHandler } from "../transport";
import { createResourcesApi } from "../resources";
import type { AuthDecision, PluginResourceRef } from "@uncorded/protocol";

function createMockTransport() {
  const sent: IpcMessage[] = [];
  const handlers: MessageHandler[] = [];
  const transport: IpcTransport = {
    send(message) {
      sent.push(message);
    },
    onMessage(handler) {
      handlers.push(handler);
    },
    close() {
      handlers.length = 0;
    },
  };
  return { transport, sent };
}

function makeResourcesWithReply(
  result?: unknown,
  error?: { code: string; message: string },
) {
  const mock = createMockTransport();
  const client = createRequestClient(mock.transport);
  const resources = createResourcesApi(client);

  const origSend = mock.transport.send.bind(mock.transport);
  mock.transport.send = (msg) => {
    origSend(msg);
    if (msg.id) {
      const response: IpcMessage = error
        ? { type: "response", id: msg.id as string, error }
        : { type: "response", id: msg.id as string, result };
      client.handleResponse(response);
    }
  };

  return { mock, resources };
}

const REF: PluginResourceRef = {
  kind: "pluginResource",
  pluginSlug: "family-album",
  resourceType: "album",
  resourceId: "a1",
};

describe("createResourcesApi.define", () => {
  test("emits resources.define nesting the registration, without a pluginSlug", async () => {
    const { mock, resources } = makeResourcesWithReply({ ok: true });
    await resources.define({
      type: "album",
      actions: ["read", "comment"],
      inheritableActions: ["read"],
      valueSlots: { title: { policy: "album.read" } },
      producerValueAllowed: false,
    });
    const sent = mock.sent[0]!;
    expect(sent["type"]).toBe("resources.define");
    const registration = sent["registration"] as Record<string, unknown>;
    expect(registration["type"]).toBe("album");
    expect(registration["pluginSlug"]).toBeUndefined(); // runtime stamps it
  });

  test("rejects malformed ok:false ack", async () => {
    const { resources } = makeResourcesWithReply({ ok: false });
    let caught: unknown;
    try {
      await resources.define({
        type: "album",
        actions: ["read"],
        inheritableActions: ["read"],
        valueSlots: { title: { policy: "album.read" } },
        producerValueAllowed: false,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SdkProtocolError);
  });
});

describe("createResourcesApi.create", () => {
  test("emits resources.create and returns the runtime-stamped ref", async () => {
    const { mock, resources } = makeResourcesWithReply({ ref: REF });
    const ref = await resources.create({ resourceType: "album", resourceId: "a1" });
    expect(ref).toEqual(REF);
    const sent = mock.sent[0]!;
    expect(sent["type"]).toBe("resources.create");
    expect(sent["resourceType"]).toBe("album");
    expect(sent["resourceId"]).toBe("a1");
    // Optional fields omitted entirely when not provided.
    expect(sent["parent"]).toBeUndefined();
    expect(sent["owner"]).toBeUndefined();
  });

  test("forwards parent and owner when provided", async () => {
    const { mock, resources } = makeResourcesWithReply({ ref: REF });
    await resources.create({
      resourceType: "photo",
      resourceId: "p1",
      parent: { resourceType: "album", resourceId: "a1" },
      owner: { userId: "dad" },
    });
    const sent = mock.sent[0]!;
    expect(sent["parent"]).toEqual({ resourceType: "album", resourceId: "a1" });
    expect(sent["owner"]).toEqual({ userId: "dad" });
  });
});

describe("createResourcesApi.grant / revoke", () => {
  test("grant emits resources.grant and returns the new aclVersion", async () => {
    const { mock, resources } = makeResourcesWithReply({ ok: true, aclVersion: 5 });
    const out = await resources.grant(REF, { kind: "user", userId: "billy" }, "read");
    expect(out).toEqual({ aclVersion: 5 });
    const sent = mock.sent[0]!;
    expect(sent["type"]).toBe("resources.grant");
    expect(sent["resource"]).toEqual(REF);
    expect(sent["principal"]).toEqual({ kind: "user", userId: "billy" });
    expect(sent["action"]).toBe("read");
  });

  test("revoke emits resources.revoke", async () => {
    const { mock, resources } = makeResourcesWithReply({ ok: true, aclVersion: 6 });
    await resources.revoke(REF, { kind: "everyone" }, "read");
    const sent = mock.sent[0]!;
    expect(sent["type"]).toBe("resources.revoke");
    expect(sent["principal"]).toEqual({ kind: "everyone" });
  });

  test("propagates CROSS_PLUGIN_WRITE_FORBIDDEN as SdkProtocolError", async () => {
    const { resources } = makeResourcesWithReply(undefined, {
      code: "CROSS_PLUGIN_WRITE_FORBIDDEN",
      message: "no",
    });
    let caught: unknown;
    try {
      await resources.grant(REF, { kind: "user", userId: "x" }, "read");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SdkProtocolError);
    expect((caught as SdkProtocolError).code).toBe("CROSS_PLUGIN_WRITE_FORBIDDEN");
  });
});

describe("createResourcesApi.check", () => {
  test("emits resources.check and parses the AuthDecision result", async () => {
    const decision: AuthDecision = {
      allowed: true,
      reason: "explicit-allow",
      versions: { resourceAclVersion: 4, resourcePermissionVersion: 2 },
    };
    const { mock, resources } = makeResourcesWithReply(decision);
    const out = await resources.check("billy", REF, "read");
    expect(out).toEqual(decision);
    const sent = mock.sent[0]!;
    expect(sent["type"]).toBe("resources.check");
    expect(sent["user_id"]).toBe("billy");
    expect(sent["resource"]).toEqual(REF);
    expect(sent["action"]).toBe("read");
  });

  test("rejects a malformed decision (fails AuthDecision validation)", async () => {
    // Missing `versions` — not a valid AuthDecision.
    const { resources } = makeResourcesWithReply({ allowed: true, reason: "explicit-allow" });
    let caught: unknown;
    try {
      await resources.check("billy", REF, "read");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SdkProtocolError);
  });

  test("propagates CAPABILITY_DENIED as SdkProtocolError", async () => {
    const { resources } = makeResourcesWithReply(undefined, {
      code: "CAPABILITY_DENIED",
      message: "declare resources.read:family-album",
    });
    let caught: unknown;
    try {
      await resources.check("billy", REF, "read");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SdkProtocolError);
    expect((caught as SdkProtocolError).code).toBe("CAPABILITY_DENIED");
  });
});
