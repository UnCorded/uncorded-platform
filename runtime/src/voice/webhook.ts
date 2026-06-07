// LiveKit webhook receiver. LiveKit posts JSON-encoded events to the
// loopback URL declared in `livekit.yaml` (see voice/config.ts). Each
// request carries an `Authorization: <jwt>` header — the JWT is signed
// HS256 with the same `(apiKey, apiSecret)` pair as join tokens and
// includes a `sha256` claim equal to `base64(sha256(rawBody))`. Per
// pr-4-voice-contract.md §5, verification is JWT signature check + body
// hash equality; rotation invalidates in-flight deliveries (LiveKit
// retries, dual-key acceptance is intentionally not implemented).
//
// This module is transport-agnostic — it takes the raw body and auth
// header and returns a status + body. The HTTP route in main.ts adapts
// it to Bun.serve.

import { Buffer } from "node:buffer";
import { createHash, timingSafeEqual } from "node:crypto";
import type { Logger } from "@uncorded/shared";

/** Topics this module emits. Locked by pr-4-voice-contract.md §4. */
export const VOICE_RUNTIME_TOPICS = {
  participantJoined: "runtime.voice.participant.joined",
  participantLeft: "runtime.voice.participant.left",
  roomCreated: "runtime.voice.room.created",
  roomDestroyed: "runtime.voice.room.destroyed",
} as const;

/** LiveKit webhook event types we care about. Other event types
 *  (track_published, egress_*, etc.) are accepted for signature/hash
 *  verification but produce no runtime event. */
const HANDLED_LIVEKIT_EVENTS = new Set([
  "room_started",
  "room_finished",
  "participant_joined",
  "participant_left",
]);

export interface VoiceWebhookDeps {
  /** UnCorded server id — webhook handler validates that every inbound
   *  room name carries the `server:<server-id>:` prefix. Cross-server
   *  isolation in shared deployments depends on this check. */
  serverId: string;
  /** Read the live LiveKit credentials. Resolves on every call so a
   *  rotateSecret() is reflected without a process restart. */
  getLiveKitCredentials: () => Promise<{ apiKey: string; apiSecret: string }>;
  /** Publish a `runtime.*` event onto the bus. Wired to
   *  `EventBus.publishRuntime` in main.ts. */
  publishRuntimeEvent: (topic: string, payload: unknown) => void;
  /** Injectable clock for deterministic tests. Wall-clock seconds. */
  now?: () => number;
  /** Optional cascade hooks — wired by 4c. When present, the webhook
   *  feeds the participant tracker on joined/left and consults the
   *  pending-kick map on `participant_left` to set the published
   *  event's `reason`. Absent in tests that exercise webhook auth/parse
   *  in isolation; absent at boot before voice is wired. */
  cascade?: {
    /** Fed on `participant_joined`. */
    trackJoin: (channelId: string, userId: string) => void;
    /** Fed on `participant_left`. */
    trackLeave: (channelId: string, userId: string) => void;
    /** Fed on `room_finished`. */
    trackRoomDestroyed: (channelId: string) => void;
    /** Returns the staged reason for this (channelId, userId) and
     *  consumes the entry, or null if no match. */
    consumePendingKick: (channelId: string, userId: string) => "server_kick" | "server_ban" | null;
  };
  /** Optional reachability hooks — wired by spec-24 Amendment A. The
   *  webhook feeds participant join/leave timing into the ICE-failure-
   *  cluster heuristic. Absent at boot before voice is wired and in tests
   *  that exercise webhook auth/parse in isolation. */
  reachability?: {
    noteParticipantJoined: (channelId: string, userId: string, sessionId: string) => void;
    noteParticipantLeft: (channelId: string, userId: string, sessionId: string) => void;
  };
  // Optional structured logger. NEVER receives raw tokens, apiKey, apiSecret,
  // sha256 claims, or raw bodies — only the human-readable failure reason,
  // event type, channelId, and userId. The webhook is the entry point for a
  // privileged loopback delivery, so log payloads must stay scrubbable: an
  // operator triaging from log aggregators must not see secrets while
  // figuring out why deliveries are failing.
  logger?: Logger;
}

export interface WebhookHandlerResult {
  status: 200 | 400 | 401 | 500;
  body: string;
}

// ---------------------------------------------------------------------------
// Base64url helpers
// ---------------------------------------------------------------------------

function base64urlDecode(segment: string): Buffer {
  const padded = segment.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(padded, "base64");
}

function base64urlEncode(bytes: Buffer | Uint8Array): string {
  const buf = bytes instanceof Buffer ? bytes : Buffer.from(bytes);
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ---------------------------------------------------------------------------
// JWT parse + HS256 verify
// ---------------------------------------------------------------------------

interface ParsedJwt {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signingInput: string;
  signatureSegment: string;
}

function parseJwt(token: string): ParsedJwt | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerSeg, payloadSeg, sigSeg] = parts;
  if (!headerSeg || !payloadSeg || !sigSeg) return null;
  try {
    const header = JSON.parse(base64urlDecode(headerSeg).toString("utf8")) as unknown;
    const payload = JSON.parse(base64urlDecode(payloadSeg).toString("utf8")) as unknown;
    if (typeof header !== "object" || header === null) return null;
    if (typeof payload !== "object" || payload === null) return null;
    return {
      header: header as Record<string, unknown>,
      payload: payload as Record<string, unknown>,
      signingInput: `${headerSeg}.${payloadSeg}`,
      signatureSegment: sigSeg,
    };
  } catch {
    return null;
  }
}

async function hmacSha256(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    Buffer.from(secret, "utf8"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, Buffer.from(data, "utf8"));
  return new Uint8Array(sig);
}

/** Constant-time equality on two Buffer views of identical length. */
function safeEqualBuf(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface AuthJwtClaims {
  iss: string;
  sha256: string;
  exp?: number;
  nbf?: number;
}

/**
 * Verify a LiveKit webhook auth JWT. Returns the validated claims on success
 * or an error code/message identical to the eventual HTTP error body.
 *
 * Time validation is intentionally loose: LiveKit sometimes sets `nbf` very
 * close to the request issue time, so we accept up to 30s of clock skew on
 * either side.
 */
export async function verifyWebhookAuthJwt(
  token: string,
  apiSecret: string,
  now: number,
): Promise<{ ok: true; claims: AuthJwtClaims } | { ok: false; message: string }> {
  const parsed = parseJwt(token);
  if (!parsed) return { ok: false, message: "malformed JWT" };

  if (parsed.header["alg"] !== "HS256") {
    return { ok: false, message: "unsupported alg" };
  }

  const expected = await hmacSha256(apiSecret, parsed.signingInput);
  const provided = base64urlDecode(parsed.signatureSegment);
  if (!safeEqualBuf(Buffer.from(expected), provided)) {
    return { ok: false, message: "invalid signature" };
  }

  const SKEW = 30;
  const exp = parsed.payload["exp"];
  if (typeof exp === "number" && now > exp + SKEW) {
    return { ok: false, message: "token expired" };
  }
  const nbf = parsed.payload["nbf"];
  if (typeof nbf === "number" && now + SKEW < nbf) {
    return { ok: false, message: "token not yet valid" };
  }

  const iss = parsed.payload["iss"];
  const sha = parsed.payload["sha256"];
  if (typeof iss !== "string" || iss.length === 0) {
    return { ok: false, message: "missing iss claim" };
  }
  if (typeof sha !== "string" || sha.length === 0) {
    return { ok: false, message: "missing sha256 claim" };
  }

  const claims: AuthJwtClaims = { iss, sha256: sha };
  if (typeof exp === "number") claims.exp = exp;
  if (typeof nbf === "number") claims.nbf = nbf;
  return { ok: true, claims };
}

/** Compute the base64-encoded SHA-256 of the raw body — what LiveKit
 *  puts in the JWT's `sha256` claim. LiveKit uses standard base64 (with
 *  padding), not base64url — match that exactly. */
export function computeBodySha256Base64(rawBody: string): string {
  return createHash("sha256").update(rawBody, "utf8").digest("base64");
}

// ---------------------------------------------------------------------------
// LiveKit event → runtime topic mapping
// ---------------------------------------------------------------------------

interface LiveKitEvent {
  event: string;
  room?: { name?: unknown; sid?: unknown };
  participant?: { identity?: unknown; sid?: unknown };
  createdAt?: unknown;
  id?: unknown;
}

function parseLiveKitEvent(rawBody: string): LiveKitEvent | null {
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const obj = parsed as Record<string, unknown>;
    const event = obj["event"];
    if (typeof event !== "string" || event.length === 0) return null;
    const out: LiveKitEvent = { event };
    const room = obj["room"];
    if (typeof room === "object" && room !== null) {
      out.room = room as { name?: unknown; sid?: unknown };
    }
    const participant = obj["participant"];
    if (typeof participant === "object" && participant !== null) {
      out.participant = participant as { identity?: unknown; sid?: unknown };
    }
    if ("createdAt" in obj) out.createdAt = obj["createdAt"];
    if ("id" in obj) out.id = obj["id"];
    return out;
  } catch {
    return null;
  }
}

/**
 * Extract the channelId from a `server:<server-id>:voice:<channel-id>` room
 * name, validating the server-id prefix. Returns null on prefix mismatch
 * (cross-server bleed-through, ignored without erroring) or malformed input.
 */
export function extractChannelId(roomName: string, serverId: string): string | null {
  const prefix = `server:${serverId}:voice:`;
  if (!roomName.startsWith(prefix)) return null;
  const channelId = roomName.slice(prefix.length);
  if (channelId.length === 0 || channelId.includes(":")) return null;
  return channelId;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function nowMs(now?: () => number): number {
  return now ? now() * 1000 : Date.now();
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Receive and process a LiveKit webhook delivery. Returns a response
 * descriptor the HTTP route can serialize. Always returns 200 once the
 * signature + body hash are verified, even for events we don't translate
 * to a runtime topic — LiveKit otherwise retries, which would amplify
 * load for events we deliberately ignore.
 */
export async function handleVoiceWebhook(
  rawBody: string,
  authHeader: string | null,
  deps: VoiceWebhookDeps,
): Promise<WebhookHandlerResult> {
  const log = deps.logger;
  if (!authHeader || authHeader.length === 0) {
    log?.warn("voice webhook auth failed", { reason: "missing Authorization header" });
    return { status: 401, body: JSON.stringify({ error: "missing Authorization header" }) };
  }

  // LiveKit sends the bare JWT (no "Bearer " prefix). Be tolerant of the
  // prefix anyway — a future LiveKit version flipping conventions
  // shouldn't break us.
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length).trim()
    : authHeader.trim();

  let creds: { apiKey: string; apiSecret: string };
  try {
    creds = await deps.getLiveKitCredentials();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log?.error("voice webhook credentials unavailable", { message });
    return {
      status: 500,
      body: JSON.stringify({ error: "credentials unavailable", message }),
    };
  }

  const now = deps.now ? deps.now() : Math.floor(Date.now() / 1000);
  const verified = await verifyWebhookAuthJwt(token, creds.apiSecret, now);
  if (!verified.ok) {
    // verified.message is one of a fixed set of strings ("malformed JWT",
    // "invalid signature", "token expired", etc.) — none of them carry
    // token/key/secret bytes, so it's safe to log verbatim.
    log?.warn("voice webhook auth failed", { reason: verified.message });
    return { status: 401, body: JSON.stringify({ error: verified.message }) };
  }
  if (verified.claims.iss !== creds.apiKey) {
    // The iss claim IS the apiKey, so we deliberately don't log either side.
    log?.warn("voice webhook auth failed", { reason: "iss does not match apiKey" });
    return { status: 401, body: JSON.stringify({ error: "iss does not match apiKey" }) };
  }

  const expectedHash = computeBodySha256Base64(rawBody);
  // Guard against length mismatch before timingSafeEqual (which throws on
  // unequal lengths). Constant-time compare on the buffers.
  const a = Buffer.from(verified.claims.sha256, "utf8");
  const b = Buffer.from(expectedHash, "utf8");
  if (!safeEqualBuf(a, b)) {
    log?.warn("voice webhook auth failed", { reason: "body hash mismatch" });
    return { status: 401, body: JSON.stringify({ error: "body hash mismatch" }) };
  }

  const event = parseLiveKitEvent(rawBody);
  if (!event) {
    log?.warn("voice webhook body malformed");
    return { status: 400, body: JSON.stringify({ error: "malformed event body" }) };
  }

  if (!HANDLED_LIVEKIT_EVENTS.has(event.event)) {
    log?.debug("voice webhook ignored", { reason: "event not handled", event: event.event });
    return { status: 200, body: JSON.stringify({ ok: true, ignored: event.event }) };
  }

  const roomName = asString(event.room?.name);
  if (!roomName) {
    log?.warn("voice webhook missing field", { event: event.event, field: "room.name" });
    return { status: 400, body: JSON.stringify({ error: "missing room.name" }) };
  }
  const channelId = extractChannelId(roomName, deps.serverId);
  if (!channelId) {
    // Cross-server bleed-through (or an unrelated room) — ignore without
    // erroring. LiveKit treats 200 as accept-and-forget. We deliberately do
    // NOT log the raw room name: in a multi-tenant deployment that name
    // belongs to another tenant and shouldn't enter our log stream.
    log?.debug("voice webhook ignored", { reason: "foreign room", event: event.event });
    return { status: 200, body: JSON.stringify({ ok: true, ignored: "foreign room" }) };
  }

  const ts = nowMs(deps.now);

  switch (event.event) {
    case "room_started":
      log?.info("voice webhook accepted", { event: event.event, channelId });
      deps.publishRuntimeEvent(VOICE_RUNTIME_TOPICS.roomCreated, {
        channelId,
        config: {},
        ts,
      });
      break;
    case "room_finished":
      log?.info("voice webhook accepted", { event: event.event, channelId });
      deps.cascade?.trackRoomDestroyed(channelId);
      deps.publishRuntimeEvent(VOICE_RUNTIME_TOPICS.roomDestroyed, {
        channelId,
        ts,
      });
      break;
    case "participant_joined": {
      const userId = asString(event.participant?.identity);
      const sessionId = asString(event.participant?.sid) ?? "";
      if (!userId) {
        log?.warn("voice webhook missing field", {
          event: event.event,
          channelId,
          field: "participant.identity",
        });
        return {
          status: 400,
          body: JSON.stringify({ error: "missing participant.identity" }),
        };
      }
      log?.info("voice webhook accepted", { event: event.event, channelId, userId });
      deps.cascade?.trackJoin(channelId, userId);
      deps.reachability?.noteParticipantJoined(channelId, userId, sessionId);
      deps.publishRuntimeEvent(VOICE_RUNTIME_TOPICS.participantJoined, {
        channelId,
        userId,
        sessionId,
        ts,
      });
      break;
    }
    case "participant_left": {
      const userId = asString(event.participant?.identity);
      const sessionId = asString(event.participant?.sid) ?? "";
      if (!userId) {
        log?.warn("voice webhook missing field", {
          event: event.event,
          channelId,
          field: "participant.identity",
        });
        return {
          status: 400,
          body: JSON.stringify({ error: "missing participant.identity" }),
        };
      }
      deps.cascade?.trackLeave(channelId, userId);
      deps.reachability?.noteParticipantLeft(channelId, userId, sessionId);
      // LiveKit's webhook does not carry an explicit reason; the cascade
      // module stages the kick reason in PendingKickMap before issuing
      // removeParticipant. Consume the staged entry here to publish the
      // canonical reason — fall through to "explicit" if no entry matches
      // (user left voluntarily, or the runtime restarted mid-cascade).
      const reason = deps.cascade?.consumePendingKick(channelId, userId) ?? "explicit";
      log?.info("voice webhook accepted", {
        event: event.event,
        channelId,
        userId,
        reason,
      });
      deps.publishRuntimeEvent(VOICE_RUNTIME_TOPICS.participantLeft, {
        channelId,
        userId,
        sessionId,
        reason,
        ts,
      });
      break;
    }
    /* c8 ignore next */
    default:
      // Unreachable — HANDLED_LIVEKIT_EVENTS guards the switch.
      break;
  }

  return { status: 200, body: JSON.stringify({ ok: true }) };
}
