import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { IpcMessage, IpcTransport, MessageHandler } from "../ipc/transport";
import { decodeJwtPayloadUnverified } from "./tokens";
import { handleVoiceTokensIpc, type VoiceIpcDeps } from "./ipc";

class MockTransport implements IpcTransport {
  sent: IpcMessage[] = [];
  send(msg: IpcMessage): void {
    this.sent.push(msg);
  }
  onMessage(_h: MessageHandler): void {}
  offMessage(_h: MessageHandler): void {}
  close(): void {}
}

const FIXED_API_KEY = "uncorded-deadbeef";
const FIXED_API_SECRET = "secret-".padEnd(64, "x");
const FIXED_SERVER_ID = "srv-test";
const FIXED_LIVEKIT_URL = "ws://localhost:7880";

function makeDeps(overrides?: Partial<VoiceIpcDeps>): VoiceIpcDeps {
  return {
    serverId: FIXED_SERVER_ID,
    livekitPublicUrl: FIXED_LIVEKIT_URL,
    getLiveKitCredentials: async () => ({
      apiKey: FIXED_API_KEY,
      apiSecret: FIXED_API_SECRET,
    }),
    ...overrides,
  };
}

let transport: MockTransport;

beforeEach(() => {
  transport = new MockTransport();
});

afterEach(() => {
  transport.sent = [];
});

describe("handleVoiceTokensIpc — happy path", () => {
  test("returns token + livekitUrl + expiresAt for valid createJoinToken", async () => {
    const msg: IpcMessage = {
      type: "voice.tokens",
      id: "req-1",
      method: "createJoinToken",
      channelId: "chan-1",
      userId: "user-1",
    };
    await handleVoiceTokensIpc("voice-channels", msg, transport, makeDeps());

    expect(transport.sent.length).toBe(1);
    const reply = transport.sent[0];
    expect(reply?.["type"]).toBe("response");
    expect(reply?.["id"]).toBe("req-1");
    const result = reply?.["result"] as Record<string, unknown> | undefined;
    expect(typeof result?.["token"]).toBe("string");
    expect(result?.["livekitUrl"]).toBe(FIXED_LIVEKIT_URL);
    expect(typeof result?.["expiresAt"]).toBe("number");
  });

  test("token claim shape matches contract §1", async () => {
    const msg: IpcMessage = {
      type: "voice.tokens",
      id: "req-2",
      method: "createJoinToken",
      channelId: "chan-2",
      userId: "user-2-uuid",
    };
    await handleVoiceTokensIpc("voice-channels", msg, transport, makeDeps());

    const result = transport.sent[0]?.["result"] as Record<string, unknown>;
    const payload = decodeJwtPayloadUnverified(result["token"] as string);
    expect(payload?.["iss"]).toBe(FIXED_API_KEY);
    expect(payload?.["sub"]).toBe("user-2-uuid");
    const video = payload?.["video"] as Record<string, unknown>;
    expect(video["room"]).toBe(`server:${FIXED_SERVER_ID}:voice:chan-2`);
    expect(video["roomJoin"]).toBe(true);
  });

  test("plugin-requested grants flow through to the JWT (listener-only)", async () => {
    const msg: IpcMessage = {
      type: "voice.tokens",
      id: "req-3",
      method: "createJoinToken",
      channelId: "chan-3",
      userId: "user-3",
      grants: { canPublish: false, canSubscribe: true, canPublishData: false },
    };
    await handleVoiceTokensIpc("voice-channels", msg, transport, makeDeps());

    const result = transport.sent[0]?.["result"] as Record<string, unknown>;
    const payload = decodeJwtPayloadUnverified(result["token"] as string);
    const video = payload?.["video"] as Record<string, unknown>;
    expect(video["canPublish"]).toBe(false);
    expect(video["canSubscribe"]).toBe(true);
    expect(video["canPublishData"]).toBe(false);
  });

  test("partial grants merge with defaults", async () => {
    const msg: IpcMessage = {
      type: "voice.tokens",
      id: "req-4",
      method: "createJoinToken",
      channelId: "chan-4",
      userId: "user-4",
      grants: { canPublish: false },
    };
    await handleVoiceTokensIpc("voice-channels", msg, transport, makeDeps());

    const result = transport.sent[0]?.["result"] as Record<string, unknown>;
    const payload = decodeJwtPayloadUnverified(result["token"] as string);
    const video = payload?.["video"] as Record<string, unknown>;
    expect(video["canPublish"]).toBe(false);
    expect(video["canSubscribe"]).toBe(true);
    expect(video["canPublishData"]).toBe(true);
  });

  test("each call resolves credentials freshly (rotation visible without restart)", async () => {
    let secret = FIXED_API_SECRET;
    const deps = makeDeps({
      getLiveKitCredentials: async () => ({ apiKey: FIXED_API_KEY, apiSecret: secret }),
    });

    const msg = (id: string): IpcMessage => ({
      type: "voice.tokens",
      id,
      method: "createJoinToken",
      channelId: "chan",
      userId: "user",
    });

    await handleVoiceTokensIpc("voice-channels", msg("a"), transport, deps);
    secret = secret + "-rotated";
    await handleVoiceTokensIpc("voice-channels", msg("b"), transport, deps);

    const sigA = (transport.sent[0]?.["result"] as Record<string, unknown>)["token"] as string;
    const sigB = (transport.sent[1]?.["result"] as Record<string, unknown>)["token"] as string;
    expect(sigA.split(".")[2]).not.toBe(sigB.split(".")[2]);
  });
});

describe("handleVoiceTokensIpc — input validation", () => {
  test("missing id is dropped silently (no response)", async () => {
    const msg = { type: "voice.tokens", method: "createJoinToken" } as unknown as IpcMessage;
    await handleVoiceTokensIpc("voice-channels", msg, transport, makeDeps());
    expect(transport.sent.length).toBe(0);
  });

  test("unknown method rejected with INVALID_PARAMS", async () => {
    const msg: IpcMessage = {
      type: "voice.tokens",
      id: "req",
      method: "nope",
      channelId: "c",
      userId: "u",
    };
    await handleVoiceTokensIpc("voice-channels", msg, transport, makeDeps());
    const err = transport.sent[0]?.["error"] as Record<string, unknown>;
    expect(err["code"]).toBe("INVALID_PARAMS");
    expect(String(err["message"])).toContain("unknown voice.tokens method");
  });

  test("missing channelId rejected", async () => {
    const msg: IpcMessage = {
      type: "voice.tokens",
      id: "req",
      method: "createJoinToken",
      userId: "u",
    };
    await handleVoiceTokensIpc("voice-channels", msg, transport, makeDeps());
    const err = transport.sent[0]?.["error"] as Record<string, unknown>;
    expect(err["code"]).toBe("INVALID_PARAMS");
    expect(String(err["message"])).toContain("channelId");
  });

  test("empty channelId rejected", async () => {
    const msg: IpcMessage = {
      type: "voice.tokens",
      id: "req",
      method: "createJoinToken",
      channelId: "",
      userId: "u",
    };
    await handleVoiceTokensIpc("voice-channels", msg, transport, makeDeps());
    const err = transport.sent[0]?.["error"] as Record<string, unknown>;
    expect(err["code"]).toBe("INVALID_PARAMS");
  });

  test("missing userId rejected", async () => {
    const msg: IpcMessage = {
      type: "voice.tokens",
      id: "req",
      method: "createJoinToken",
      channelId: "c",
    };
    await handleVoiceTokensIpc("voice-channels", msg, transport, makeDeps());
    const err = transport.sent[0]?.["error"] as Record<string, unknown>;
    expect(err["code"]).toBe("INVALID_PARAMS");
    expect(String(err["message"])).toContain("userId");
  });

  test("non-boolean grant rejected with field name", async () => {
    const msg: IpcMessage = {
      type: "voice.tokens",
      id: "req",
      method: "createJoinToken",
      channelId: "c",
      userId: "u",
      grants: { canPublish: "yes" },
    };
    await handleVoiceTokensIpc("voice-channels", msg, transport, makeDeps());
    const err = transport.sent[0]?.["error"] as Record<string, unknown>;
    expect(err["code"]).toBe("INVALID_PARAMS");
    expect(String(err["message"])).toContain("canPublish");
  });

  test("non-object grants rejected", async () => {
    const msg: IpcMessage = {
      type: "voice.tokens",
      id: "req",
      method: "createJoinToken",
      channelId: "c",
      userId: "u",
      grants: "publish",
    };
    await handleVoiceTokensIpc("voice-channels", msg, transport, makeDeps());
    const err = transport.sent[0]?.["error"] as Record<string, unknown>;
    expect(err["code"]).toBe("INVALID_PARAMS");
  });
});

describe("handleVoiceTokensIpc — canPublishSources (PR-6)", () => {
  // Runtime trusts the plugin handler upstream for who-gets-what; here we
  // only enforce shape + allowlist. Anything that comes off the wire as a
  // bad type or unknown enum value must fail with INVALID_PARAMS.

  test("valid sources flow through to the JWT video.canPublishSources claim", async () => {
    const msg: IpcMessage = {
      type: "voice.tokens",
      id: "req-src-1",
      method: "createJoinToken",
      channelId: "c",
      userId: "u",
      canPublishSources: ["microphone", "screen_share", "screen_share_audio"],
    };
    await handleVoiceTokensIpc("voice-channels", msg, transport, makeDeps());
    const result = transport.sent[0]?.["result"] as Record<string, unknown>;
    const payload = decodeJwtPayloadUnverified(result["token"] as string);
    const video = payload?.["video"] as Record<string, unknown>;
    expect(video["canPublishSources"]).toEqual([
      "microphone",
      "screen_share",
      "screen_share_audio",
    ]);
  });

  test("omitted canPublishSources defaults to ['microphone'] (mic-only, backwards-compatible)", async () => {
    const msg: IpcMessage = {
      type: "voice.tokens",
      id: "req-src-2",
      method: "createJoinToken",
      channelId: "c",
      userId: "u",
    };
    await handleVoiceTokensIpc("voice-channels", msg, transport, makeDeps());
    const result = transport.sent[0]?.["result"] as Record<string, unknown>;
    const payload = decodeJwtPayloadUnverified(result["token"] as string);
    const video = payload?.["video"] as Record<string, unknown>;
    expect(video["canPublishSources"]).toEqual(["microphone"]);
  });

  test("unknown source string rejected with INVALID_PARAMS", async () => {
    const msg: IpcMessage = {
      type: "voice.tokens",
      id: "req-src-3",
      method: "createJoinToken",
      channelId: "c",
      userId: "u",
      canPublishSources: ["microphone", "magic_track"],
    };
    await handleVoiceTokensIpc("voice-channels", msg, transport, makeDeps());
    const err = transport.sent[0]?.["error"] as Record<string, unknown>;
    expect(err["code"]).toBe("INVALID_PARAMS");
    expect(String(err["message"])).toContain("magic_track");
    expect(String(err["message"])).toContain("not in the allowlist");
  });

  test("non-string entry rejected with index in the message", async () => {
    const msg: IpcMessage = {
      type: "voice.tokens",
      id: "req-src-4",
      method: "createJoinToken",
      channelId: "c",
      userId: "u",
      canPublishSources: ["microphone", 42],
    };
    await handleVoiceTokensIpc("voice-channels", msg, transport, makeDeps());
    const err = transport.sent[0]?.["error"] as Record<string, unknown>;
    expect(err["code"]).toBe("INVALID_PARAMS");
    expect(String(err["message"])).toContain("canPublishSources[1]");
  });

  test("non-array canPublishSources rejected", async () => {
    const msg: IpcMessage = {
      type: "voice.tokens",
      id: "req-src-5",
      method: "createJoinToken",
      channelId: "c",
      userId: "u",
      canPublishSources: "screen_share",
    };
    await handleVoiceTokensIpc("voice-channels", msg, transport, makeDeps());
    const err = transport.sent[0]?.["error"] as Record<string, unknown>;
    expect(err["code"]).toBe("INVALID_PARAMS");
    expect(String(err["message"])).toContain("must be an array");
  });

  test("empty array is honored (listener-only, no publish)", async () => {
    const msg: IpcMessage = {
      type: "voice.tokens",
      id: "req-src-6",
      method: "createJoinToken",
      channelId: "c",
      userId: "u",
      canPublishSources: [],
    };
    await handleVoiceTokensIpc("voice-channels", msg, transport, makeDeps());
    const result = transport.sent[0]?.["result"] as Record<string, unknown>;
    expect(result["token"]).toBeDefined();
    const payload = decodeJwtPayloadUnverified(result["token"] as string);
    const video = payload?.["video"] as Record<string, unknown>;
    expect(video["canPublishSources"]).toEqual([]);
  });
});

describe("handleVoiceTokensIpc — credential failures", () => {
  test("credential lookup failure surfaces VOICE_CREDENTIALS_UNAVAILABLE", async () => {
    const deps = makeDeps({
      getLiveKitCredentials: async () => {
        throw new Error("voice supervisor not running");
      },
    });
    const msg: IpcMessage = {
      type: "voice.tokens",
      id: "req",
      method: "createJoinToken",
      channelId: "c",
      userId: "u",
    };
    await handleVoiceTokensIpc("voice-channels", msg, transport, deps);
    const err = transport.sent[0]?.["error"] as Record<string, unknown>;
    expect(err["code"]).toBe("VOICE_CREDENTIALS_UNAVAILABLE");
    expect(String(err["message"])).toContain("voice supervisor not running");
  });
});
