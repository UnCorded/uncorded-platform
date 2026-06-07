// LiveKit join-token minter. Signs HS256 JWTs whose claim shape is locked by
// pr-4-voice-contract.md §1: `iss = apiKey` (LiveKit's verifier looks up the
// matching secret keyed by `iss` — fixed by the SFU's verification protocol),
// `sub = bare UnCorded user id`, `video.room = server:<server-id>:voice:<channel-id>`,
// 300-second TTL.
//
// No third-party JWT library — Web Crypto's HMAC-SHA256 is enough and avoids
// adding a dep to the runtime image. Matches the codebase pattern in
// auth/token-validator.ts (Ed25519 via crypto.subtle).

import { Buffer } from "node:buffer";

/** Default TTL per contract §1. Client refreshes at 60s remaining. */
export const VOICE_TOKEN_TTL_SECONDS = 300;

/** Per-grant defaults applied when a field is omitted (contract §3). */
export const DEFAULT_GRANTS: Required<TokenGrants> = {
  canPublish: true,
  canSubscribe: true,
  canPublishData: true,
};

export interface TokenGrants {
  canPublish?: boolean;
  canSubscribe?: boolean;
  canPublishData?: boolean;
}

/** Allowlisted LiveKit `TrackSource` strings. PR-6 §1: any string outside this
 *  set is rejected at the runtime IPC boundary. Mirrors LiveKit's protocol
 *  enum (`microphone | camera | screen_share | screen_share_audio`). */
export const VALID_TRACK_SOURCES = [
  "microphone",
  "camera",
  "screen_share",
  "screen_share_audio",
] as const;
export type TrackSource = (typeof VALID_TRACK_SOURCES)[number];

export interface MintJoinTokenInput {
  apiKey: string;
  apiSecret: string;
  serverId: string;
  channelId: string;
  userId: string;
  /** Override the default 300s TTL — tests use shorter windows. */
  ttlSeconds?: number;
  /** Plugin-requested grants. Omitted fields fall back to DEFAULT_GRANTS. */
  grants?: TokenGrants;
  /** LiveKit per-source publish gate. When set, LiveKit rejects publishes for
   *  any TrackSource not in the list. Authorization is decided upstream by
   *  the plugin `voice.join` handler — see PR-6 contract §14. Defaults to
   *  `["microphone"]` when omitted (audio-only, backwards-compatible with
   *  pre-PR-6 callers). */
  canPublishSources?: TrackSource[];
  /** Injectable clock for deterministic tests. Returns wall-clock seconds. */
  now?: () => number;
  /** Optional display label that LiveKit hands back as Participant.name on the
   *  client. UnCorded passes the user's Core display_name here so frontends
   *  don't render bare UUIDs. Distinct from `userId` (= Participant.identity),
   *  which stays stable for matching across server-to-server permission
   *  cascades. Empty / undefined skips the claim entirely so older tokens that
   *  don't carry it still validate. */
  displayName?: string;
  /** Optional avatar URL packed into the LiveKit `metadata` claim as JSON
   *  `{"avatarUrl": "..."}`. LiveKit hands `metadata` back as a verbatim
   *  string on `Participant.metadata`; the shell parses it into ParticipantSnapshot
   *  so voice rosters render the same PFPs as the rest of the UI. Empty or
   *  undefined skips `metadata` entirely. */
  avatarUrl?: string;
}

export interface MintedJoinToken {
  token: string;
  /** Wall-clock ms when the token expires — exposed so the SDK can compute
   *  the refresh deadline without re-decoding the JWT. */
  expiresAt: number;
  /** The room claim that was embedded — useful for downstream logging. */
  room: string;
}

/** Build the canonical room claim for a (server, channel) pair. */
export function buildRoomClaim(serverId: string, channelId: string): string {
  return `server:${serverId}:voice:${channelId}`;
}

function base64url(buf: ArrayBuffer | Uint8Array | string): string {
  const bytes =
    typeof buf === "string"
      ? Buffer.from(buf, "utf8")
      : buf instanceof Uint8Array
        ? Buffer.from(buf)
        : Buffer.from(new Uint8Array(buf));
  return bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmacSha256(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    Buffer.from(secret, "utf8"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, Buffer.from(data, "utf8"));
  return new Uint8Array(signature);
}

/**
 * Mint a LiveKit join token for the given (channel, user) pair. The caller is
 * responsible for capability gating (the `voice.tokens:self` check runs
 * upstream in the IPC router); this function trusts its inputs and only
 * enforces shape: non-empty ids, boolean grants, positive TTL.
 */
export async function mintJoinToken(input: MintJoinTokenInput): Promise<MintedJoinToken> {
  if (input.apiKey.length === 0) throw new Error("apiKey must be non-empty");
  if (input.apiSecret.length === 0) throw new Error("apiSecret must be non-empty");
  if (input.serverId.length === 0) throw new Error("serverId must be non-empty");
  if (input.channelId.length === 0) throw new Error("channelId must be non-empty");
  if (input.userId.length === 0) throw new Error("userId must be non-empty");

  const now = input.now ?? (() => Math.floor(Date.now() / 1000));
  const nbf = now();
  const ttl = input.ttlSeconds ?? VOICE_TOKEN_TTL_SECONDS;
  if (!Number.isFinite(ttl) || ttl <= 0) throw new Error("ttlSeconds must be a positive number");
  const exp = nbf + ttl;

  const grants: Required<TokenGrants> = {
    canPublish: input.grants?.canPublish ?? DEFAULT_GRANTS.canPublish,
    canSubscribe: input.grants?.canSubscribe ?? DEFAULT_GRANTS.canSubscribe,
    canPublishData: input.grants?.canPublishData ?? DEFAULT_GRANTS.canPublishData,
  };

  if (input.canPublishSources !== undefined) {
    if (!Array.isArray(input.canPublishSources)) {
      throw new Error("canPublishSources must be an array of strings");
    }
    for (const src of input.canPublishSources) {
      if (!VALID_TRACK_SOURCES.includes(src as TrackSource)) {
        throw new Error(
          `canPublishSources contains invalid source "${String(src)}" (allowed: ${VALID_TRACK_SOURCES.join(", ")})`,
        );
      }
    }
  }
  const sources: TrackSource[] = input.canPublishSources ?? ["microphone"];

  const room = buildRoomClaim(input.serverId, input.channelId);

  const header = { alg: "HS256", typ: "JWT" };
  const trimmedName =
    typeof input.displayName === "string" ? input.displayName.trim() : "";
  const trimmedAvatar =
    typeof input.avatarUrl === "string" ? input.avatarUrl.trim() : "";
  const metadataClaim =
    trimmedAvatar.length > 0 ? JSON.stringify({ avatarUrl: trimmedAvatar }) : "";
  const payload: Record<string, unknown> = {
    iss: input.apiKey,
    sub: input.userId,
    nbf,
    exp,
    ...(trimmedName.length > 0 ? { name: trimmedName } : {}),
    ...(metadataClaim.length > 0 ? { metadata: metadataClaim } : {}),
    video: {
      room,
      roomJoin: true,
      canPublish: grants.canPublish,
      canSubscribe: grants.canSubscribe,
      canPublishData: grants.canPublishData,
      canPublishSources: sources,
    },
  };

  const headerSegment = base64url(JSON.stringify(header));
  const payloadSegment = base64url(JSON.stringify(payload));
  const signingInput = `${headerSegment}.${payloadSegment}`;
  const signature = await hmacSha256(input.apiSecret, signingInput);
  const sigSegment = base64url(signature);

  return {
    token: `${signingInput}.${sigSegment}`,
    expiresAt: exp * 1000,
    room,
  };
}

/** TTL for admin tokens used against LiveKit's room-service API. Short
 *  because each call mints a fresh one — there's no client refresh cycle. */
export const VOICE_ADMIN_TOKEN_TTL_SECONDS = 60;

export interface MintAdminTokenInput {
  apiKey: string;
  apiSecret: string;
  /** Scope the admin grant to a specific room. LiveKit ignores this field
   *  on RoomService.RemoveParticipant when roomAdmin is global, but
   *  scoping limits blast radius on a leaked token. */
  room: string;
  ttlSeconds?: number;
  now?: () => number;
}

/**
 * Mint a short-lived HS256 JWT carrying the `roomAdmin` grant — required
 * by LiveKit's room-service Twirp API for state-mutating calls
 * (RemoveParticipant, MutePublishedTrack, …). Distinct from the join
 * token shape: no `roomJoin`, scoped to admin actions only.
 */
export async function mintAdminToken(input: MintAdminTokenInput): Promise<string> {
  if (input.apiKey.length === 0) throw new Error("apiKey must be non-empty");
  if (input.apiSecret.length === 0) throw new Error("apiSecret must be non-empty");
  if (input.room.length === 0) throw new Error("room must be non-empty");

  const now = input.now ?? (() => Math.floor(Date.now() / 1000));
  const nbf = now();
  const ttl = input.ttlSeconds ?? VOICE_ADMIN_TOKEN_TTL_SECONDS;
  if (!Number.isFinite(ttl) || ttl <= 0) throw new Error("ttlSeconds must be a positive number");
  const exp = nbf + ttl;

  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    iss: input.apiKey,
    nbf,
    exp,
    video: {
      room: input.room,
      roomAdmin: true,
    },
  };

  const headerSegment = base64url(JSON.stringify(header));
  const payloadSegment = base64url(JSON.stringify(payload));
  const signingInput = `${headerSegment}.${payloadSegment}`;
  const signature = await hmacSha256(input.apiSecret, signingInput);
  return `${signingInput}.${base64url(signature)}`;
}

/**
 * Decode a JWT's payload without verifying the signature. Test-only helper —
 * production code should rely on the SFU's verifier. Returns null on malformed
 * input rather than throwing so test assertions stay readable.
 */
export function decodeJwtPayloadUnverified(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const payloadPart = parts[1];
  if (payloadPart === undefined) return null;
  try {
    const padded = payloadPart.replace(/-/g, "+").replace(/_/g, "/");
    const json = Buffer.from(padded, "base64").toString("utf8");
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}
