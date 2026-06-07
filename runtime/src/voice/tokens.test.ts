import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import {
  DEFAULT_GRANTS,
  VOICE_TOKEN_TTL_SECONDS,
  buildRoomClaim,
  decodeJwtPayloadUnverified,
  mintJoinToken,
} from "./tokens";

const FIXED_NOW = 1_700_000_000; // wall-clock seconds, deterministic
const fixedNow = (): number => FIXED_NOW;

const baseInput = {
  apiKey: "uncorded-deadbeef",
  apiSecret: "secret-".padEnd(64, "x"),
  serverId: "srv-abc",
  channelId: "chan-123",
  userId: "user-uuid-456",
  now: fixedNow,
};

describe("buildRoomClaim", () => {
  test("matches contract §1 format", () => {
    expect(buildRoomClaim("srv-abc", "chan-123")).toBe("server:srv-abc:voice:chan-123");
  });
});

describe("mintJoinToken — claim shape", () => {
  test("iss is the apiKey, not the serverId (LiveKit verifier protocol)", async () => {
    const { token } = await mintJoinToken(baseInput);
    const payload = decodeJwtPayloadUnverified(token);
    expect(payload?.["iss"]).toBe(baseInput.apiKey);
    expect(payload?.["iss"]).not.toBe(baseInput.serverId);
  });

  test("sub is the bare user id (no namespacing)", async () => {
    const { token } = await mintJoinToken(baseInput);
    const payload = decodeJwtPayloadUnverified(token);
    expect(payload?.["sub"]).toBe(baseInput.userId);
  });

  test("video.room follows server:<id>:voice:<channel> shape", async () => {
    const { token, room } = await mintJoinToken(baseInput);
    const payload = decodeJwtPayloadUnverified(token);
    const video = payload?.["video"] as Record<string, unknown> | undefined;
    expect(video?.["room"]).toBe("server:srv-abc:voice:chan-123");
    expect(room).toBe("server:srv-abc:voice:chan-123");
  });

  test("nbf and exp are 300s apart by default", async () => {
    const { token, expiresAt } = await mintJoinToken(baseInput);
    const payload = decodeJwtPayloadUnverified(token);
    expect(payload?.["nbf"]).toBe(FIXED_NOW);
    expect(payload?.["exp"]).toBe(FIXED_NOW + VOICE_TOKEN_TTL_SECONDS);
    expect(expiresAt).toBe((FIXED_NOW + VOICE_TOKEN_TTL_SECONDS) * 1000);
  });

  test("custom TTL is honored", async () => {
    const { token } = await mintJoinToken({ ...baseInput, ttlSeconds: 60 });
    const payload = decodeJwtPayloadUnverified(token);
    expect(payload?.["exp"]).toBe(FIXED_NOW + 60);
  });

  test("header is HS256 + JWT", async () => {
    const { token } = await mintJoinToken(baseInput);
    const headerPart = token.split(".")[0];
    expect(headerPart).toBeDefined();
    const padded = (headerPart as string).replace(/-/g, "+").replace(/_/g, "/");
    const headerJson = Buffer.from(padded, "base64").toString("utf8");
    const header = JSON.parse(headerJson) as Record<string, unknown>;
    expect(header["alg"]).toBe("HS256");
    expect(header["typ"]).toBe("JWT");
  });
});

describe("mintJoinToken — grants", () => {
  test("defaults to all-true grants when none requested", async () => {
    const { token } = await mintJoinToken(baseInput);
    const payload = decodeJwtPayloadUnverified(token);
    const video = payload?.["video"] as Record<string, unknown> | undefined;
    expect(video?.["roomJoin"]).toBe(true);
    expect(video?.["canPublish"]).toBe(DEFAULT_GRANTS.canPublish);
    expect(video?.["canSubscribe"]).toBe(DEFAULT_GRANTS.canSubscribe);
    expect(video?.["canPublishData"]).toBe(DEFAULT_GRANTS.canPublishData);
  });

  test("listener-only grants are honored (canPublish=false)", async () => {
    const { token } = await mintJoinToken({
      ...baseInput,
      grants: { canPublish: false, canSubscribe: true, canPublishData: false },
    });
    const payload = decodeJwtPayloadUnverified(token);
    const video = payload?.["video"] as Record<string, unknown> | undefined;
    expect(video?.["canPublish"]).toBe(false);
    expect(video?.["canSubscribe"]).toBe(true);
    expect(video?.["canPublishData"]).toBe(false);
  });

  test("partial grants merge with defaults", async () => {
    const { token } = await mintJoinToken({
      ...baseInput,
      grants: { canPublish: false },
    });
    const payload = decodeJwtPayloadUnverified(token);
    const video = payload?.["video"] as Record<string, unknown> | undefined;
    expect(video?.["canPublish"]).toBe(false);
    expect(video?.["canSubscribe"]).toBe(true);
    expect(video?.["canPublishData"]).toBe(true);
  });
});

describe("mintJoinToken — canPublishSources (PR-6)", () => {
  // The plugin handler is the trust boundary; runtime only validates shape +
  // allowlist. These cases lock in the wire-level invariants the plugin
  // depends on (default = mic-only, allowlist enforced, claim embedded).

  test("defaults to ['microphone'] when canPublishSources omitted (backwards-compatible)", async () => {
    const { token } = await mintJoinToken(baseInput);
    const payload = decodeJwtPayloadUnverified(token);
    const video = payload?.["video"] as Record<string, unknown> | undefined;
    expect(video?.["canPublishSources"]).toEqual(["microphone"]);
  });

  test("embeds the full source list when provided", async () => {
    const { token } = await mintJoinToken({
      ...baseInput,
      canPublishSources: ["microphone", "screen_share", "screen_share_audio"],
    });
    const payload = decodeJwtPayloadUnverified(token);
    const video = payload?.["video"] as Record<string, unknown> | undefined;
    expect(video?.["canPublishSources"]).toEqual([
      "microphone",
      "screen_share",
      "screen_share_audio",
    ]);
  });

  test("rejects unknown source strings (allowlist enforcement)", async () => {
    await expect(
      mintJoinToken({
        ...baseInput,
        // @ts-expect-error — runtime allowlist must reject this regardless of TS
        canPublishSources: ["microphone", "magic_track"],
      }),
    ).rejects.toThrow(/invalid source/);
  });

  test("rejects a non-array (defense-in-depth against bad IPC payloads)", async () => {
    await expect(
      mintJoinToken({
        ...baseInput,
        // @ts-expect-error — runtime must check Array.isArray
        canPublishSources: "screen_share",
      }),
    ).rejects.toThrow(/must be an array/);
  });

  test("listener-only with empty list is honored (no publish allowed)", async () => {
    const { token } = await mintJoinToken({
      ...baseInput,
      canPublishSources: [],
    });
    const payload = decodeJwtPayloadUnverified(token);
    const video = payload?.["video"] as Record<string, unknown> | undefined;
    expect(video?.["canPublishSources"]).toEqual([]);
  });
});

describe("mintJoinToken — metadata claim", () => {
  test("omits metadata when avatarUrl is not provided", async () => {
    const { token } = await mintJoinToken(baseInput);
    const payload = decodeJwtPayloadUnverified(token);
    expect(payload && "metadata" in payload).toBe(false);
  });

  test("packs avatarUrl into a JSON metadata claim", async () => {
    const url = "https://assets.uncorded.app/u/abc.jpg";
    const { token } = await mintJoinToken({ ...baseInput, avatarUrl: url });
    const payload = decodeJwtPayloadUnverified(token);
    const metadata = payload?.["metadata"];
    expect(typeof metadata).toBe("string");
    const parsed = JSON.parse(metadata as string) as Record<string, unknown>;
    expect(parsed["avatarUrl"]).toBe(url);
  });

  test("trims whitespace and skips when result is empty", async () => {
    const { token } = await mintJoinToken({ ...baseInput, avatarUrl: "   " });
    const payload = decodeJwtPayloadUnverified(token);
    expect(payload && "metadata" in payload).toBe(false);
  });
});

describe("mintJoinToken — signature", () => {
  test("token has three base64url segments", async () => {
    const { token } = await mintJoinToken(baseInput);
    const parts = token.split(".");
    expect(parts.length).toBe(3);
    for (const part of parts) {
      expect(part.length).toBeGreaterThan(0);
      expect(part).not.toMatch(/[+/=]/);
    }
  });

  test("two tokens with same input + same now produce same signature (deterministic)", async () => {
    const a = await mintJoinToken(baseInput);
    const b = await mintJoinToken(baseInput);
    expect(a.token).toBe(b.token);
  });

  test("different secrets produce different signatures", async () => {
    const a = await mintJoinToken(baseInput);
    const b = await mintJoinToken({ ...baseInput, apiSecret: baseInput.apiSecret + "-other" });
    const aSig = a.token.split(".")[2];
    const bSig = b.token.split(".")[2];
    expect(aSig).not.toBe(bSig);
  });

  test("signature verifies against apiSecret via Web Crypto", async () => {
    const { token } = await mintJoinToken(baseInput);
    const [headerSeg, payloadSeg, sigSeg] = token.split(".");
    expect(headerSeg).toBeDefined();
    expect(payloadSeg).toBeDefined();
    expect(sigSeg).toBeDefined();
    const signingInput = `${headerSeg as string}.${payloadSeg as string}`;
    const sigBytes = Buffer.from(
      (sigSeg as string).replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    );
    const key = await crypto.subtle.importKey(
      "raw",
      Buffer.from(baseInput.apiSecret, "utf8"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const ok = await crypto.subtle.verify("HMAC", key, sigBytes, Buffer.from(signingInput, "utf8"));
    expect(ok).toBe(true);
  });
});

describe("mintJoinToken — input validation", () => {
  test("rejects empty apiKey", async () => {
    await expect(mintJoinToken({ ...baseInput, apiKey: "" })).rejects.toThrow();
  });

  test("rejects empty apiSecret", async () => {
    await expect(mintJoinToken({ ...baseInput, apiSecret: "" })).rejects.toThrow();
  });

  test("rejects empty serverId", async () => {
    await expect(mintJoinToken({ ...baseInput, serverId: "" })).rejects.toThrow();
  });

  test("rejects empty channelId", async () => {
    await expect(mintJoinToken({ ...baseInput, channelId: "" })).rejects.toThrow();
  });

  test("rejects empty userId", async () => {
    await expect(mintJoinToken({ ...baseInput, userId: "" })).rejects.toThrow();
  });

  test("rejects non-positive TTL", async () => {
    await expect(mintJoinToken({ ...baseInput, ttlSeconds: 0 })).rejects.toThrow();
    await expect(mintJoinToken({ ...baseInput, ttlSeconds: -10 })).rejects.toThrow();
    await expect(mintJoinToken({ ...baseInput, ttlSeconds: NaN })).rejects.toThrow();
  });
});
