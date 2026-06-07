import { describe, expect, test } from "bun:test";
import { SdkProtocolError } from "../errors";
import { createRequestClient } from "../request";
import type { IpcMessage, IpcTransport, MessageHandler } from "../transport";
import { createVoiceApi } from "../voice";

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

function makeVoiceWithReply(
  result?: unknown,
  error?: { code: string; message: string },
) {
  const mock = createMockTransport();
  const client = createRequestClient(mock.transport);
  const voice = createVoiceApi(client);

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

  return { mock, voice };
}

describe("createVoiceApi.createJoinToken", () => {
  test("sends voice.tokens IPC with method=createJoinToken and resolves the token", async () => {
    const expiresAt = Date.now() + 300_000;
    const { mock, voice } = makeVoiceWithReply({
      token: "lk-jwt-payload",
      livekitUrl: "ws://livekit.local:7880",
      expiresAt,
    });

    const result = await voice.createJoinToken({
      channelId: "ch-1",
      userId: "user-1",
    });

    expect(result).toEqual({
      token: "lk-jwt-payload",
      livekitUrl: "ws://livekit.local:7880",
      expiresAt,
    });

    const sent = mock.sent[0]!;
    expect(sent["type"]).toBe("voice.tokens");
    expect(sent["method"]).toBe("createJoinToken");
    expect(sent["channelId"]).toBe("ch-1");
    expect(sent["userId"]).toBe("user-1");
    // No grants field when caller omits it — runtime applies defaults.
    expect(sent["grants"]).toBeUndefined();
  });

  test("forwards grants when provided, stripping undefined fields", async () => {
    const { mock, voice } = makeVoiceWithReply({
      token: "tok",
      livekitUrl: "ws://lk:7880",
      expiresAt: 0,
    });

    // Cast through unknown: exactOptionalPropertyTypes forbids `: undefined`
    // at the call site, but the runtime contract is that callers may construct
    // grants objects (e.g. from spread/dynamic config) where optional keys
    // happen to land as undefined. The wrapper must strip those — this test
    // pins that behavior, so bypass the strict typing here on purpose.
    await voice.createJoinToken({
      channelId: "ch-1",
      userId: "user-1",
      grants: { canPublish: false, canSubscribe: true, canPublishData: undefined } as unknown as { canPublish: boolean; canSubscribe: boolean },
    });

    const sent = mock.sent[0]!;
    expect(sent["grants"]).toEqual({ canPublish: false, canSubscribe: true });
  });

  test("propagates runtime error as SdkProtocolError", async () => {
    const { voice } = makeVoiceWithReply(undefined, {
      code: "VOICE_BRIDGE_UNAVAILABLE",
      message: "Voice bridge is not configured",
    });

    let caught: unknown;
    try {
      await voice.createJoinToken({ channelId: "ch", userId: "u" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SdkProtocolError);
    const err = caught as SdkProtocolError;
    expect(err.code).toBe("VOICE_BRIDGE_UNAVAILABLE");
  });

  test("forwards canPublishSources when provided (PR-6)", async () => {
    const { mock, voice } = makeVoiceWithReply({
      token: "tok",
      livekitUrl: "ws://lk:7880",
      expiresAt: 0,
    });

    await voice.createJoinToken({
      channelId: "ch-1",
      userId: "user-1",
      canPublishSources: ["microphone", "screen_share", "screen_share_audio"],
    });

    const sent = mock.sent[0]!;
    expect(sent["canPublishSources"]).toEqual([
      "microphone",
      "screen_share",
      "screen_share_audio",
    ]);
  });

  test("omits canPublishSources when caller does not provide it (mic-only fallback in runtime)", async () => {
    const { mock, voice } = makeVoiceWithReply({
      token: "tok",
      livekitUrl: "ws://lk:7880",
      expiresAt: 0,
    });

    await voice.createJoinToken({ channelId: "ch", userId: "u" });
    const sent = mock.sent[0]!;
    expect(sent["canPublishSources"]).toBeUndefined();
  });

  test("rejects unknown source string before sending the IPC (fail-fast for plugin authors)", async () => {
    const { voice } = makeVoiceWithReply({
      token: "tok",
      livekitUrl: "ws://lk:7880",
      expiresAt: 0,
    });

    let caught: unknown;
    try {
      await voice.createJoinToken({
        channelId: "ch",
        userId: "u",
        canPublishSources: [
          "microphone",
          // @ts-expect-error — local sanity check rejects unknown literals
          "invalid_source",
        ],
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(String((caught as Error).message)).toContain("invalid_source");
  });

  test("clones the canPublishSources array (caller mutation does not leak into IPC msg)", async () => {
    const { mock, voice } = makeVoiceWithReply({
      token: "tok",
      livekitUrl: "ws://lk:7880",
      expiresAt: 0,
    });

    const sources: Array<"microphone" | "screen_share"> = [
      "microphone",
      "screen_share",
    ];
    await voice.createJoinToken({
      channelId: "ch",
      userId: "u",
      canPublishSources: sources,
    });
    sources.push("microphone");

    const sent = mock.sent[0]!;
    expect(sent["canPublishSources"]).toEqual(["microphone", "screen_share"]);
  });
});

describe("createVoiceApi.removeParticipant (PR-6 admin moderation)", () => {
  test("sends voice.moderation IPC with method=removeParticipant and forwards reason", async () => {
    const { mock, voice } = makeVoiceWithReply({ ok: true });
    const result = await voice.removeParticipant({
      channelId: "ch-mod",
      userId: "user-bad",
      reason: "Spamming",
    });
    expect(result).toEqual({ ok: true });

    const sent = mock.sent[0]!;
    expect(sent["type"]).toBe("voice.moderation");
    expect(sent["method"]).toBe("removeParticipant");
    expect(sent["channelId"]).toBe("ch-mod");
    expect(sent["userId"]).toBe("user-bad");
    expect(sent["reason"]).toBe("Spamming");
  });

  test("omits reason when caller passes empty string or undefined", async () => {
    const { mock, voice } = makeVoiceWithReply({ ok: true });
    await voice.removeParticipant({
      channelId: "ch",
      userId: "u",
      reason: "",
    });
    expect(mock.sent[0]!["reason"]).toBeUndefined();

    await voice.removeParticipant({ channelId: "ch", userId: "u" });
    expect(mock.sent[1]!["reason"]).toBeUndefined();
  });

  test("propagates VOICE_BRIDGE_UNAVAILABLE from runtime when room-service is not configured", async () => {
    const { voice } = makeVoiceWithReply(undefined, {
      code: "VOICE_BRIDGE_UNAVAILABLE",
      message: "voice room-service not configured",
    });
    let caught: unknown;
    try {
      await voice.removeParticipant({ channelId: "ch", userId: "u" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SdkProtocolError);
    expect((caught as SdkProtocolError).code).toBe("VOICE_BRIDGE_UNAVAILABLE");
  });
});

describe("createVoiceApi.createJoinToken — error and shape", () => {
  test("malformed runtime response throws invalid_response_shape", async () => {
    const { voice } = makeVoiceWithReply({
      // Missing `livekitUrl` and `expiresAt`.
      token: "tok",
    });

    let caught: unknown;
    try {
      await voice.createJoinToken({ channelId: "ch", userId: "u" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SdkProtocolError);
    const err = caught as SdkProtocolError;
    expect(err.code).toBe("invalid_response_shape");
  });
});
