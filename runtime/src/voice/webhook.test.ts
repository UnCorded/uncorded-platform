import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type { Logger } from "@uncorded/shared";
import {
  computeBodySha256Base64,
  extractChannelId,
  handleVoiceWebhook,
  verifyWebhookAuthJwt,
  VOICE_RUNTIME_TOPICS,
  type VoiceWebhookDeps,
} from "./webhook";

const FIXED_API_KEY = "uncorded-deadbeef";
const FIXED_API_SECRET = "secret-".padEnd(64, "x");
const FIXED_SERVER_ID = "srv-test";

// ---------------------------------------------------------------------------
// Test helpers — mint a webhook auth JWT the way LiveKit would
// ---------------------------------------------------------------------------

function base64url(buf: Buffer | Uint8Array | string): string {
  const bytes =
    typeof buf === "string"
      ? Buffer.from(buf, "utf8")
      : buf instanceof Buffer
        ? buf
        : Buffer.from(buf);
  return bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function mintAuthJwt(opts: {
  apiKey?: string;
  apiSecret?: string;
  rawBody: string;
  ttlSeconds?: number;
  now?: number;
  /** Override the sha256 claim (defaults to the correct hash of rawBody). */
  overrideSha256?: string;
  /** Override the alg header. */
  alg?: string;
}): Promise<string> {
  const apiKey = opts.apiKey ?? FIXED_API_KEY;
  const apiSecret = opts.apiSecret ?? FIXED_API_SECRET;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const ttl = opts.ttlSeconds ?? 600;
  const sha = opts.overrideSha256 ?? computeBodySha256Base64(opts.rawBody);

  const header = { alg: opts.alg ?? "HS256", typ: "JWT" };
  const payload = {
    iss: apiKey,
    sha256: sha,
    nbf: now,
    exp: now + ttl,
  };
  const headerSeg = base64url(JSON.stringify(header));
  const payloadSeg = base64url(JSON.stringify(payload));
  const signingInput = `${headerSeg}.${payloadSeg}`;

  const key = await crypto.subtle.importKey(
    "raw",
    Buffer.from(apiSecret, "utf8"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, Buffer.from(signingInput, "utf8"));
  return `${signingInput}.${base64url(new Uint8Array(signature))}`;
}

function makeDeps(
  overrides?: Partial<VoiceWebhookDeps>,
): { deps: VoiceWebhookDeps; published: Array<{ topic: string; payload: unknown }> } {
  const published: Array<{ topic: string; payload: unknown }> = [];
  const deps: VoiceWebhookDeps = {
    serverId: FIXED_SERVER_ID,
    getLiveKitCredentials: async () => ({
      apiKey: FIXED_API_KEY,
      apiSecret: FIXED_API_SECRET,
    }),
    publishRuntimeEvent: (topic, payload) => {
      published.push({ topic, payload });
    },
    ...overrides,
  };
  return { deps, published };
}

function liveKitBody(
  event: string,
  fields: { roomName?: string; identity?: string; sid?: string } = {},
): string {
  const body: Record<string, unknown> = { event, id: "evt-1", createdAt: 1700000000 };
  if (fields.roomName !== undefined) body["room"] = { name: fields.roomName, sid: "rm-1" };
  if (fields.identity !== undefined || fields.sid !== undefined) {
    body["participant"] = { identity: fields.identity, sid: fields.sid ?? "sid-1" };
  }
  return JSON.stringify(body);
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("computeBodySha256Base64", () => {
  test("matches a manual sha256 over the body bytes (standard base64)", () => {
    const body = '{"event":"room_started"}';
    const expected = createHash("sha256").update(body, "utf8").digest("base64");
    expect(computeBodySha256Base64(body)).toBe(expected);
  });

  test("is sensitive to whitespace and ordering (no canonicalization)", () => {
    expect(computeBodySha256Base64('{"a":1}')).not.toBe(computeBodySha256Base64('{"a": 1}'));
  });
});

describe("extractChannelId", () => {
  test("strips the server prefix and returns the channel id", () => {
    expect(extractChannelId("server:srv-test:voice:chan-1", "srv-test")).toBe("chan-1");
  });

  test("rejects rooms with a different server id", () => {
    expect(extractChannelId("server:srv-other:voice:chan-1", "srv-test")).toBeNull();
  });

  test("rejects rooms without the prefix at all", () => {
    expect(extractChannelId("voice:chan-1", "srv-test")).toBeNull();
  });

  test("rejects empty channel ids", () => {
    expect(extractChannelId("server:srv-test:voice:", "srv-test")).toBeNull();
  });

  test("rejects nested colons (would break the contract's flat naming)", () => {
    expect(extractChannelId("server:srv-test:voice:chan:1", "srv-test")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// JWT verification
// ---------------------------------------------------------------------------

describe("verifyWebhookAuthJwt", () => {
  test("accepts a freshly signed JWT", async () => {
    const body = liveKitBody("room_started", { roomName: "server:srv-test:voice:c" });
    const token = await mintAuthJwt({ rawBody: body });
    const r = await verifyWebhookAuthJwt(
      token,
      FIXED_API_SECRET,
      Math.floor(Date.now() / 1000),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.claims.iss).toBe(FIXED_API_KEY);
      expect(r.claims.sha256.length).toBeGreaterThan(0);
    }
  });

  test("rejects a JWT signed with a different secret", async () => {
    const body = liveKitBody("room_started", { roomName: "server:srv-test:voice:c" });
    const token = await mintAuthJwt({ rawBody: body, apiSecret: "wrong-".padEnd(64, "x") });
    const r = await verifyWebhookAuthJwt(
      token,
      FIXED_API_SECRET,
      Math.floor(Date.now() / 1000),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("invalid signature");
  });

  test("rejects an unsupported alg header", async () => {
    const body = liveKitBody("room_started", { roomName: "server:srv-test:voice:c" });
    const token = await mintAuthJwt({ rawBody: body, alg: "none" });
    const r = await verifyWebhookAuthJwt(
      token,
      FIXED_API_SECRET,
      Math.floor(Date.now() / 1000),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("unsupported alg");
  });

  test("rejects an expired JWT (beyond skew)", async () => {
    const body = liveKitBody("room_started", { roomName: "server:srv-test:voice:c" });
    const t0 = 1700000000;
    const token = await mintAuthJwt({ rawBody: body, now: t0, ttlSeconds: 60 });
    // 30s skew window; check 91s past exp.
    const r = await verifyWebhookAuthJwt(token, FIXED_API_SECRET, t0 + 60 + 91);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("expired");
  });

  test("accepts a JWT slightly in the future (within 30s skew)", async () => {
    const body = liveKitBody("room_started", { roomName: "server:srv-test:voice:c" });
    const t0 = 1700000000;
    const token = await mintAuthJwt({ rawBody: body, now: t0 });
    // verifier sees t0 - 10s — should still accept (nbf - now <= skew).
    const r = await verifyWebhookAuthJwt(token, FIXED_API_SECRET, t0 - 10);
    expect(r.ok).toBe(true);
  });

  test("rejects a malformed JWT (not three segments)", async () => {
    const r = await verifyWebhookAuthJwt(
      "not-a-jwt",
      FIXED_API_SECRET,
      Math.floor(Date.now() / 1000),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("malformed");
  });
});

// ---------------------------------------------------------------------------
// handleVoiceWebhook — happy paths
// ---------------------------------------------------------------------------

describe("handleVoiceWebhook — runtime event mapping", () => {
  let captured: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    captured = makeDeps();
  });

  afterEach(() => {
    // makeDeps creates a fresh array each test, no cleanup needed.
  });

  test("room_started → runtime.voice.room.created", async () => {
    const body = liveKitBody("room_started", { roomName: "server:srv-test:voice:lounge" });
    const token = await mintAuthJwt({ rawBody: body });
    const r = await handleVoiceWebhook(body, token, captured.deps);
    expect(r.status).toBe(200);
    expect(captured.published).toHaveLength(1);
    expect(captured.published[0]?.topic).toBe(VOICE_RUNTIME_TOPICS.roomCreated);
    const payload = captured.published[0]?.payload as Record<string, unknown>;
    expect(payload["channelId"]).toBe("lounge");
    expect(typeof payload["ts"]).toBe("number");
  });

  test("room_finished → runtime.voice.room.destroyed", async () => {
    const body = liveKitBody("room_finished", { roomName: "server:srv-test:voice:lounge" });
    const token = await mintAuthJwt({ rawBody: body });
    const r = await handleVoiceWebhook(body, token, captured.deps);
    expect(r.status).toBe(200);
    expect(captured.published[0]?.topic).toBe(VOICE_RUNTIME_TOPICS.roomDestroyed);
    expect((captured.published[0]?.payload as Record<string, unknown>)["channelId"]).toBe("lounge");
  });

  test("participant_joined → runtime.voice.participant.joined with userId + sessionId", async () => {
    const body = liveKitBody("participant_joined", {
      roomName: "server:srv-test:voice:c",
      identity: "user-42",
      sid: "PA_xxx",
    });
    const token = await mintAuthJwt({ rawBody: body });
    const r = await handleVoiceWebhook(body, token, captured.deps);
    expect(r.status).toBe(200);
    expect(captured.published[0]?.topic).toBe(VOICE_RUNTIME_TOPICS.participantJoined);
    const payload = captured.published[0]?.payload as Record<string, unknown>;
    expect(payload["channelId"]).toBe("c");
    expect(payload["userId"]).toBe("user-42");
    expect(payload["sessionId"]).toBe("PA_xxx");
  });

  test("participant_left carries reason='explicit' (4c upgrades this on cascade)", async () => {
    const body = liveKitBody("participant_left", {
      roomName: "server:srv-test:voice:c",
      identity: "user-42",
      sid: "PA_xxx",
    });
    const token = await mintAuthJwt({ rawBody: body });
    const r = await handleVoiceWebhook(body, token, captured.deps);
    expect(r.status).toBe(200);
    expect(captured.published[0]?.topic).toBe(VOICE_RUNTIME_TOPICS.participantLeft);
    expect((captured.published[0]?.payload as Record<string, unknown>)["reason"]).toBe("explicit");
  });

  test("unhandled event types verify but do not publish", async () => {
    const body = liveKitBody("track_published", { roomName: "server:srv-test:voice:c" });
    const token = await mintAuthJwt({ rawBody: body });
    const r = await handleVoiceWebhook(body, token, captured.deps);
    expect(r.status).toBe(200);
    expect(captured.published).toHaveLength(0);
  });

  test("foreign-server room is ignored without 4xx (cross-server bleed)", async () => {
    const body = liveKitBody("room_started", { roomName: "server:srv-other:voice:lounge" });
    const token = await mintAuthJwt({ rawBody: body });
    const r = await handleVoiceWebhook(body, token, captured.deps);
    expect(r.status).toBe(200);
    expect(captured.published).toHaveLength(0);
  });

  test("Bearer-prefixed Authorization header is accepted", async () => {
    const body = liveKitBody("room_started", { roomName: "server:srv-test:voice:c" });
    const token = await mintAuthJwt({ rawBody: body });
    const r = await handleVoiceWebhook(body, `Bearer ${token}`, captured.deps);
    expect(r.status).toBe(200);
    expect(captured.published).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// handleVoiceWebhook — auth failures
// ---------------------------------------------------------------------------

describe("handleVoiceWebhook — auth failures", () => {
  test("missing Authorization header → 401, no publish", async () => {
    const { deps, published } = makeDeps();
    const body = liveKitBody("room_started", { roomName: "server:srv-test:voice:c" });
    const r = await handleVoiceWebhook(body, null, deps);
    expect(r.status).toBe(401);
    expect(JSON.parse(r.body)["error"]).toContain("missing Authorization");
    expect(published).toHaveLength(0);
  });

  test("body modified after signing → 401 body hash mismatch", async () => {
    const { deps, published } = makeDeps();
    const body = liveKitBody("room_started", { roomName: "server:srv-test:voice:c" });
    const token = await mintAuthJwt({ rawBody: body });
    // Tamper with the body after signing.
    const tampered = body.replace("room_started", "room_finished");
    const r = await handleVoiceWebhook(tampered, token, deps);
    expect(r.status).toBe(401);
    expect(JSON.parse(r.body)["error"]).toContain("body hash mismatch");
    expect(published).toHaveLength(0);
  });

  test("forged sha256 claim → still rejected (signature covers the claim)", async () => {
    const { deps, published } = makeDeps();
    const body = liveKitBody("room_started", { roomName: "server:srv-test:voice:c" });
    // Sign over a forged hash (a hash of a different body) but send the
    // original body. JWT signature is valid, but expected hash != claim.
    const wrongHash = computeBodySha256Base64('{"event":"different"}');
    const token = await mintAuthJwt({ rawBody: body, overrideSha256: wrongHash });
    const r = await handleVoiceWebhook(body, token, deps);
    expect(r.status).toBe(401);
    expect(JSON.parse(r.body)["error"]).toContain("body hash mismatch");
    expect(published).toHaveLength(0);
  });

  test("wrong-secret JWT → 401 invalid signature", async () => {
    const { deps, published } = makeDeps();
    const body = liveKitBody("room_started", { roomName: "server:srv-test:voice:c" });
    const token = await mintAuthJwt({ rawBody: body, apiSecret: "rotated-".padEnd(64, "y") });
    const r = await handleVoiceWebhook(body, token, deps);
    expect(r.status).toBe(401);
    expect(JSON.parse(r.body)["error"]).toContain("invalid signature");
    expect(published).toHaveLength(0);
  });

  test("iss does not match runtime's apiKey → 401", async () => {
    const { deps, published } = makeDeps();
    const body = liveKitBody("room_started", { roomName: "server:srv-test:voice:c" });
    // Sign with a foreign apiKey but the runtime's apiSecret. Signature
    // verifies, but iss mismatch should still reject.
    const token = await mintAuthJwt({ rawBody: body, apiKey: "foreign-key" });
    const r = await handleVoiceWebhook(body, token, deps);
    expect(r.status).toBe(401);
    expect(JSON.parse(r.body)["error"]).toContain("iss");
    expect(published).toHaveLength(0);
  });

  test("credential lookup failure surfaces 500", async () => {
    const { deps, published } = makeDeps({
      getLiveKitCredentials: async () => {
        throw new Error("voice supervisor not running");
      },
    });
    const body = liveKitBody("room_started", { roomName: "server:srv-test:voice:c" });
    // Token doesn't matter — credential lookup fails first.
    const r = await handleVoiceWebhook(body, "irrelevant", deps);
    expect(r.status).toBe(500);
    expect(JSON.parse(r.body)["error"]).toContain("credentials unavailable");
    expect(published).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// handleVoiceWebhook — input shape failures
// ---------------------------------------------------------------------------

describe("handleVoiceWebhook — input shape", () => {
  test("non-JSON body → 400 (after auth passes — auth covers raw bytes)", async () => {
    const { deps, published } = makeDeps();
    const body = "not-json";
    const token = await mintAuthJwt({ rawBody: body });
    const r = await handleVoiceWebhook(body, token, deps);
    expect(r.status).toBe(400);
    expect(published).toHaveLength(0);
  });

  test("participant_joined missing identity → 400", async () => {
    const { deps, published } = makeDeps();
    const body = liveKitBody("participant_joined", { roomName: "server:srv-test:voice:c" });
    const token = await mintAuthJwt({ rawBody: body });
    const r = await handleVoiceWebhook(body, token, deps);
    expect(r.status).toBe(400);
    expect(JSON.parse(r.body)["error"]).toContain("identity");
    expect(published).toHaveLength(0);
  });

  test("event missing room.name → 400", async () => {
    const { deps, published } = makeDeps();
    const body = JSON.stringify({ event: "room_started" });
    const token = await mintAuthJwt({ rawBody: body });
    const r = await handleVoiceWebhook(body, token, deps);
    expect(r.status).toBe(400);
    expect(JSON.parse(r.body)["error"]).toContain("room.name");
    expect(published).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Rotation interaction
// ---------------------------------------------------------------------------

describe("handleVoiceWebhook — rotation visibility", () => {
  test("post-rotation, an in-flight delivery signed with the old secret is rejected", async () => {
    let secret = FIXED_API_SECRET;
    const { deps, published } = makeDeps({
      getLiveKitCredentials: async () => ({ apiKey: FIXED_API_KEY, apiSecret: secret }),
    });

    const body = liveKitBody("room_started", { roomName: "server:srv-test:voice:c" });
    const tokenOld = await mintAuthJwt({ rawBody: body, apiSecret: FIXED_API_SECRET });

    // First delivery succeeds.
    expect((await handleVoiceWebhook(body, tokenOld, deps)).status).toBe(200);
    expect(published).toHaveLength(1);

    // Rotate.
    secret = "new-secret-".padEnd(64, "z");
    // A retry from LiveKit signed with the old secret arrives — should be
    // rejected, no duplicate publish.
    const r = await handleVoiceWebhook(body, tokenOld, deps);
    expect(r.status).toBe(401);
    expect(published).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Cascade hook integration — webhook reads the pending-kick map to set
// the `participant_left` reason. Each hook is recorded so the test can
// assert wiring as well as outputs.
// ---------------------------------------------------------------------------

describe("handleVoiceWebhook — cascade hook integration", () => {
  interface CascadeCalls {
    trackJoin: Array<[string, string]>;
    trackLeave: Array<[string, string]>;
    trackRoomDestroyed: string[];
    consumePendingKick: Array<[string, string]>;
  }

  function makeCascadeDeps(consume: (channelId: string, userId: string) => "server_kick" | "server_ban" | null) {
    const calls: CascadeCalls = {
      trackJoin: [],
      trackLeave: [],
      trackRoomDestroyed: [],
      consumePendingKick: [],
    };
    const { deps, published } = makeDeps({
      cascade: {
        trackJoin: (channelId, userId) => {
          calls.trackJoin.push([channelId, userId]);
        },
        trackLeave: (channelId, userId) => {
          calls.trackLeave.push([channelId, userId]);
        },
        trackRoomDestroyed: (channelId) => {
          calls.trackRoomDestroyed.push(channelId);
        },
        consumePendingKick: (channelId, userId) => {
          calls.consumePendingKick.push([channelId, userId]);
          return consume(channelId, userId);
        },
      },
    });
    return { deps, published, calls };
  }

  test("participant_joined feeds tracker.add", async () => {
    const { deps, calls } = makeCascadeDeps(() => null);
    const body = liveKitBody("participant_joined", {
      roomName: "server:srv-test:voice:lounge",
      identity: "user-1",
    });
    const token = await mintAuthJwt({ rawBody: body });
    const r = await handleVoiceWebhook(body, token, deps);
    expect(r.status).toBe(200);
    expect(calls.trackJoin).toEqual([["lounge", "user-1"]]);
  });

  test("room_finished feeds tracker.removeRoom", async () => {
    const { deps, calls } = makeCascadeDeps(() => null);
    const body = liveKitBody("room_finished", { roomName: "server:srv-test:voice:lounge" });
    const token = await mintAuthJwt({ rawBody: body });
    const r = await handleVoiceWebhook(body, token, deps);
    expect(r.status).toBe(200);
    expect(calls.trackRoomDestroyed).toEqual(["lounge"]);
  });

  test("participant_left with staged ban → reason='server_ban'", async () => {
    const { deps, published, calls } = makeCascadeDeps((ch, u) =>
      ch === "lounge" && u === "user-1" ? "server_ban" : null,
    );
    const body = liveKitBody("participant_left", {
      roomName: "server:srv-test:voice:lounge",
      identity: "user-1",
    });
    const token = await mintAuthJwt({ rawBody: body });
    const r = await handleVoiceWebhook(body, token, deps);
    expect(r.status).toBe(200);
    expect(calls.trackLeave).toEqual([["lounge", "user-1"]]);
    expect(calls.consumePendingKick).toEqual([["lounge", "user-1"]]);
    const payload = published[0]?.payload as Record<string, unknown>;
    expect(payload["reason"]).toBe("server_ban");
  });

  test("participant_left with staged kick → reason='server_kick'", async () => {
    const { deps, published } = makeCascadeDeps(() => "server_kick");
    const body = liveKitBody("participant_left", {
      roomName: "server:srv-test:voice:lounge",
      identity: "user-1",
    });
    const token = await mintAuthJwt({ rawBody: body });
    await handleVoiceWebhook(body, token, deps);
    const payload = published[0]?.payload as Record<string, unknown>;
    expect(payload["reason"]).toBe("server_kick");
  });

  test("participant_left without staged entry falls through to 'explicit'", async () => {
    const { deps, published } = makeCascadeDeps(() => null);
    const body = liveKitBody("participant_left", {
      roomName: "server:srv-test:voice:lounge",
      identity: "user-1",
    });
    const token = await mintAuthJwt({ rawBody: body });
    await handleVoiceWebhook(body, token, deps);
    const payload = published[0]?.payload as Record<string, unknown>;
    expect(payload["reason"]).toBe("explicit");
  });
});

// ---------------------------------------------------------------------------
// Structured logging — every error path emits one line; happy paths emit one
// info line; secrets never appear in any logged ctx.
// ---------------------------------------------------------------------------

interface CapturedLine {
  readonly level: "debug" | "info" | "warn" | "error";
  readonly msg: string;
  readonly ctx: Record<string, unknown>;
}

function makeCapturingLogger(): { logger: Logger; lines: CapturedLine[] } {
  const lines: CapturedLine[] = [];
  const make = (): Logger => ({
    debug: (msg, ctx) => { lines.push({ level: "debug", msg, ctx: ctx ?? {} }); },
    info:  (msg, ctx) => { lines.push({ level: "info",  msg, ctx: ctx ?? {} }); },
    warn:  (msg, ctx) => { lines.push({ level: "warn",  msg, ctx: ctx ?? {} }); },
    error: (msg, ctx) => { lines.push({ level: "error", msg, ctx: ctx ?? {} }); },
    child: () => make(),
  });
  return { logger: make(), lines };
}

/** Assert that no log line contains any of the listed secret strings in any
 *  context value. Stringifies ctx to catch nested fields too. */
function expectNoSecretsLogged(lines: CapturedLine[], secrets: readonly string[]): void {
  for (const line of lines) {
    const blob = JSON.stringify(line.ctx);
    for (const secret of secrets) {
      // Empty/short fragments would false-positive; only check meaningful ones.
      if (secret.length < 8) continue;
      expect(blob).not.toContain(secret);
    }
  }
}

describe("handleVoiceWebhook — structured logging", () => {
  test("missing Authorization header → one warn line", async () => {
    const { logger, lines } = makeCapturingLogger();
    const { deps } = makeDeps({ logger });
    const body = liveKitBody("room_started", { roomName: "server:srv-test:voice:c" });
    await handleVoiceWebhook(body, null, deps);
    expect(lines.length).toBe(1);
    expect(lines[0]!.level).toBe("warn");
    expect(lines[0]!.msg).toBe("voice webhook auth failed");
    expect(lines[0]!.ctx["reason"]).toBe("missing Authorization header");
  });

  test("invalid signature → one warn line with safe reason", async () => {
    const { logger, lines } = makeCapturingLogger();
    const { deps } = makeDeps({ logger });
    const body = liveKitBody("room_started", { roomName: "server:srv-test:voice:c" });
    const token = await mintAuthJwt({ rawBody: body, apiSecret: "rotated-".padEnd(64, "y") });
    await handleVoiceWebhook(body, token, deps);
    expect(lines.length).toBe(1);
    expect(lines[0]!.level).toBe("warn");
    expect(lines[0]!.ctx["reason"]).toBe("invalid signature");
  });

  test("iss mismatch → warn does not include iss/apiKey value", async () => {
    const { logger, lines } = makeCapturingLogger();
    const { deps } = makeDeps({ logger });
    const body = liveKitBody("room_started", { roomName: "server:srv-test:voice:c" });
    const token = await mintAuthJwt({ rawBody: body, apiKey: "foreign-key-leakable" });
    await handleVoiceWebhook(body, token, deps);
    expect(lines.length).toBe(1);
    expect(lines[0]!.ctx["reason"]).toBe("iss does not match apiKey");
    // The foreign key must NOT leak into the log.
    expect(JSON.stringify(lines[0]!.ctx)).not.toContain("foreign-key-leakable");
    expect(JSON.stringify(lines[0]!.ctx)).not.toContain(FIXED_API_KEY);
  });

  test("body hash mismatch → one warn line", async () => {
    const { logger, lines } = makeCapturingLogger();
    const { deps } = makeDeps({ logger });
    const body = liveKitBody("room_started", { roomName: "server:srv-test:voice:c" });
    const token = await mintAuthJwt({ rawBody: body });
    const tampered = body.replace("room_started", "room_finished");
    await handleVoiceWebhook(tampered, token, deps);
    expect(lines.length).toBe(1);
    expect(lines[0]!.ctx["reason"]).toBe("body hash mismatch");
  });

  test("malformed body → one warn line", async () => {
    const { logger, lines } = makeCapturingLogger();
    const { deps } = makeDeps({ logger });
    const body = "not-json";
    const token = await mintAuthJwt({ rawBody: body });
    await handleVoiceWebhook(body, token, deps);
    expect(lines.length).toBe(1);
    expect(lines[0]!.level).toBe("warn");
    expect(lines[0]!.msg).toBe("voice webhook body malformed");
  });

  test("credential lookup failure → one error line carrying message only", async () => {
    const { logger, lines } = makeCapturingLogger();
    const { deps } = makeDeps({
      logger,
      getLiveKitCredentials: async () => {
        throw new Error("voice supervisor not running");
      },
    });
    const body = liveKitBody("room_started", { roomName: "server:srv-test:voice:c" });
    await handleVoiceWebhook(body, "irrelevant", deps);
    expect(lines.length).toBe(1);
    expect(lines[0]!.level).toBe("error");
    expect(lines[0]!.ctx["message"]).toBe("voice supervisor not running");
  });

  test("unhandled event → one debug line with event name", async () => {
    const { logger, lines } = makeCapturingLogger();
    const { deps } = makeDeps({ logger });
    const body = liveKitBody("track_published", { roomName: "server:srv-test:voice:c" });
    const token = await mintAuthJwt({ rawBody: body });
    await handleVoiceWebhook(body, token, deps);
    expect(lines.length).toBe(1);
    expect(lines[0]!.level).toBe("debug");
    expect(lines[0]!.ctx["event"]).toBe("track_published");
    expect(lines[0]!.ctx["reason"]).toBe("event not handled");
  });

  test("foreign-server room → one debug line WITHOUT the room name", async () => {
    const { logger, lines } = makeCapturingLogger();
    const { deps } = makeDeps({ logger });
    const foreignRoom = "server:srv-other-tenant:voice:secret-channel";
    const body = liveKitBody("room_started", { roomName: foreignRoom });
    const token = await mintAuthJwt({ rawBody: body });
    await handleVoiceWebhook(body, token, deps);
    expect(lines.length).toBe(1);
    expect(lines[0]!.level).toBe("debug");
    expect(lines[0]!.ctx["reason"]).toBe("foreign room");
    // Cross-tenant safety: foreign room name MUST NOT enter our log stream.
    expect(JSON.stringify(lines[0]!.ctx)).not.toContain("srv-other-tenant");
    expect(JSON.stringify(lines[0]!.ctx)).not.toContain("secret-channel");
  });

  test("missing room.name on a handled event → one warn line", async () => {
    const { logger, lines } = makeCapturingLogger();
    const { deps } = makeDeps({ logger });
    const body = JSON.stringify({ event: "room_started" });
    const token = await mintAuthJwt({ rawBody: body });
    await handleVoiceWebhook(body, token, deps);
    expect(lines.length).toBe(1);
    expect(lines[0]!.level).toBe("warn");
    expect(lines[0]!.msg).toBe("voice webhook missing field");
    expect(lines[0]!.ctx["field"]).toBe("room.name");
  });

  test("participant_joined missing identity → one warn line", async () => {
    const { logger, lines } = makeCapturingLogger();
    const { deps } = makeDeps({ logger });
    const body = liveKitBody("participant_joined", { roomName: "server:srv-test:voice:c" });
    const token = await mintAuthJwt({ rawBody: body });
    await handleVoiceWebhook(body, token, deps);
    expect(lines.length).toBe(1);
    expect(lines[0]!.level).toBe("warn");
    expect(lines[0]!.msg).toBe("voice webhook missing field");
    expect(lines[0]!.ctx["field"]).toBe("participant.identity");
    expect(lines[0]!.ctx["channelId"]).toBe("c");
  });

  test("room_started accepted → one info line", async () => {
    const { logger, lines } = makeCapturingLogger();
    const { deps } = makeDeps({ logger });
    const body = liveKitBody("room_started", { roomName: "server:srv-test:voice:lounge" });
    const token = await mintAuthJwt({ rawBody: body });
    await handleVoiceWebhook(body, token, deps);
    expect(lines.length).toBe(1);
    expect(lines[0]!.level).toBe("info");
    expect(lines[0]!.msg).toBe("voice webhook accepted");
    expect(lines[0]!.ctx["event"]).toBe("room_started");
    expect(lines[0]!.ctx["channelId"]).toBe("lounge");
  });

  test("participant_left accepted → info line carries reason", async () => {
    const { logger, lines } = makeCapturingLogger();
    const { deps } = makeDeps({ logger });
    const body = liveKitBody("participant_left", {
      roomName: "server:srv-test:voice:lounge",
      identity: "user-42",
    });
    const token = await mintAuthJwt({ rawBody: body });
    await handleVoiceWebhook(body, token, deps);
    expect(lines.length).toBe(1);
    expect(lines[0]!.level).toBe("info");
    expect(lines[0]!.ctx["event"]).toBe("participant_left");
    expect(lines[0]!.ctx["userId"]).toBe("user-42");
    expect(lines[0]!.ctx["reason"]).toBe("explicit");
  });

  test("redaction guarantee — secrets, raw token, and sha256 never appear in any ctx", async () => {
    const { logger, lines } = makeCapturingLogger();
    const { deps } = makeDeps({ logger });
    const body = liveKitBody("room_started", { roomName: "server:srv-test:voice:c" });
    const token = await mintAuthJwt({ rawBody: body });
    const sha = computeBodySha256Base64(body);

    // Walk the major code paths: success, auth fail, body fail, missing field.
    await handleVoiceWebhook(body, token, deps);
    await handleVoiceWebhook(body, null, deps);
    await handleVoiceWebhook(body.replace("room_started", "room_finished"), token, deps);
    await handleVoiceWebhook(JSON.stringify({ event: "room_started" }), await mintAuthJwt({ rawBody: JSON.stringify({ event: "room_started" }) }), deps);

    expectNoSecretsLogged(lines, [FIXED_API_KEY, FIXED_API_SECRET, token, sha]);
  });

  test("logger is optional — webhook still works silently without it", async () => {
    const { deps, published } = makeDeps();
    const body = liveKitBody("room_started", { roomName: "server:srv-test:voice:c" });
    const token = await mintAuthJwt({ rawBody: body });
    const r = await handleVoiceWebhook(body, token, deps);
    expect(r.status).toBe(200);
    expect(published).toHaveLength(1);
  });
});
