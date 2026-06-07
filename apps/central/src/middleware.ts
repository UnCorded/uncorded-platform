import type { Sql } from "./db";
import { hashToken } from "./crypto";
import { unauthorized } from "./errors";

// --- Session auth middleware ---

export interface SessionAccount {
  readonly id: string;
  readonly email: string;
  readonly username: string;
  readonly usernameChangedAt: Date | null;
  readonly displayName: string;
  readonly avatarUrl: string | null;
  readonly emailVerified: boolean;
  readonly phoneVerified: boolean;
}

// Sliding-window session policy.
//
// A session is valid while BOTH deadlines are in the future:
//   - idle_expires_at:    7 days from the last bump. Refreshed on use,
//                         rate-limited to ~once per hour to avoid hot-row
//                         writes on every request.
//   - absolute_expires_at: 30 days from session creation. Never touched
//                         after createSession — caps total lifetime even if
//                         the user is continuously active.
//
// Idle bumps are clamped at absolute_expires_at so we never extend a session
// past the hard cap. Cookie Max-Age tracks the absolute window so the browser
// stops sending a cookie that the server would reject anyway.
export const SESSION_IDLE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const SESSION_ABSOLUTE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const SESSION_SLIDE_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export async function authenticate(
  request: Request,
  sql: Sql,
): Promise<SessionAccount | Response> {
  const cookie = request.headers.get("cookie");
  if (!cookie) return unauthorized();

  const token = parseCookie(cookie, "__Host-session");
  if (!token) return unauthorized();

  const tokenHash = await hashToken(token);
  const rows = await sql`
    SELECT
      s.id AS session_id, s.idle_expires_at,
      a.id, a.email, a.username, a.username_changed_at,
      a.display_name, a.avatar_url,
      a.email_verified, a.phone_verified
    FROM sessions s
    JOIN accounts a ON a.id = s.account_id
    WHERE s.token_hash = ${tokenHash}
      AND s.idle_expires_at > now()
      AND s.absolute_expires_at > now()
    LIMIT 1
  `;

  const row = rows[0];
  if (!row) return unauthorized();

  // Slide the idle window. Skip the write when the session was bumped less
  // than SESSION_SLIDE_INTERVAL_MS ago: an active user firing 100 requests a
  // minute would otherwise pin a writer on this row. The bump is best-effort
  // — a transient DB error here shouldn't fail an otherwise valid request,
  // because idle_expires_at can't shrink, only grow.
  const idleExpiresAt = row.idle_expires_at as Date;
  const remainingMs = idleExpiresAt.getTime() - Date.now();
  const shouldBump = remainingMs < SESSION_IDLE_MAX_AGE_MS - SESSION_SLIDE_INTERVAL_MS;
  if (shouldBump) {
    const sessionId = row.session_id as string;
    const newIdle = new Date(Date.now() + SESSION_IDLE_MAX_AGE_MS);
    try {
      await sql`
        UPDATE sessions
        SET idle_expires_at = LEAST(${newIdle}::timestamptz, absolute_expires_at)
        WHERE id = ${sessionId}
      `;
    } catch {
      // Swallow — the session is still valid; we'll try to bump on the
      // next authenticated request.
    }
  }

  return {
    id: row.id as string,
    email: row.email as string,
    username: row.username as string,
    usernameChangedAt: (row.username_changed_at as Date | null) ?? null,
    displayName: row.display_name as string,
    avatarUrl: (row.avatar_url as string | null) ?? null,
    emailVerified: row.email_verified as boolean,
    phoneVerified: row.phone_verified as boolean,
  };
}

function parseCookie(header: string, name: string): string | null {
  const prefix = `${name}=`;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(prefix)) {
      return trimmed.slice(prefix.length);
    }
  }
  return null;
}

// --- Session cookie helpers ---

// Cookie Max-Age tracks the hard absolute cap. The server still enforces the
// idle window separately; the cookie just stops the browser from sending a
// stale token that's already past the absolute deadline.
const SESSION_COOKIE_MAX_AGE = SESSION_ABSOLUTE_MAX_AGE_MS / 1000;

export function sessionCookie(token: string): string {
  return `__Host-session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_COOKIE_MAX_AGE}`;
}

export function clearSessionCookie(): string {
  return "__Host-session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0";
}

export async function createSession(
  sql: Sql,
  accountId: string,
): Promise<string> {
  const { generateSessionToken, hashToken } = await import("./crypto");
  const token = generateSessionToken();
  const tokenHash = await hashToken(token);
  const now = Date.now();
  const idleExpiresAt = new Date(now + SESSION_IDLE_MAX_AGE_MS);
  const absoluteExpiresAt = new Date(now + SESSION_ABSOLUTE_MAX_AGE_MS);

  await sql`
    INSERT INTO sessions (account_id, token_hash, idle_expires_at, absolute_expires_at)
    VALUES (${accountId}, ${tokenHash}, ${idleExpiresAt}, ${absoluteExpiresAt})
  `;

  return token;
}

// --- Rate limiter ---

interface Bucket {
  tokens: number;
  lastRefill: number;
}

export interface RateLimitConfig {
  readonly maxTokens: number;
  readonly refillRate: number; // tokens per second
}

export interface RateLimiter {
  consume(key: string, config: RateLimitConfig): { allowed: boolean; retryAfter: number };
  /** Test-only: drop all in-memory buckets so a shared fixture (e.g. one
   *  serverId reused across tests) doesn't carry token depletion across cases. */
  resetForTests(): void;
}

// --- Client IP extraction ---
//
// Cloudflare always sets `CF-Connecting-IP` to the real client address and
// appends that same address as the LAST entry of `X-Forwarded-For`; any
// client-supplied XFF values precede it. Reading the FIRST XFF entry (the
// pattern we started with) let an attacker send `X-Forwarded-For: 1.2.3.4`
// and bypass per-IP rate limits on every request by forging a new "source"
// IP each time. This helper prefers CF-Connecting-IP, falls back to the
// *last* XFF hop (CF's own append), and finally to "unknown" so dev/direct
// requests still produce a consistent bucket key.
export function getClientIp(request: Request): string {
  const cfIp = request.headers.get("cf-connecting-ip")?.trim();
  if (cfIp && cfIp.length > 0) return cfIp;

  const xff = request.headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((p) => p.trim()).filter((p) => p.length > 0);
    const last = parts[parts.length - 1];
    if (last) return last;
  }

  return "unknown";
}

export const RATE_REGISTER: RateLimitConfig = { maxTokens: 3, refillRate: 3 / 3600 }; // 3/hour
export const RATE_LOGIN: RateLimitConfig = { maxTokens: 10, refillRate: 10 / 60 }; // 10/min
export const RATE_SERVER_TOKEN: RateLimitConfig = { maxTokens: 30, refillRate: 30 / 60 }; // 30/min
// Heartbeat: 5-token bucket refilling at 3/min. A server coming back online
// may burst a bootstrap poll + first delta catch-up + a short retry — 3
// tokens is tight enough that any brief blip hits the rate limit. 5 gives
// the bucket headroom for a startup burst without changing the steady-state
// rate (3/min, matching the spec-documented 30s heartbeat interval).
export const RATE_HEARTBEAT: RateLimitConfig = { maxTokens: 5, refillRate: 3 / 60 }; // 3/min steady, 5 burst
export const RATE_DIRECTORY_BROWSE: RateLimitConfig = { maxTokens: 30, refillRate: 30 / 60 }; // 30/min
export const RATE_CHECK_FRAME: RateLimitConfig = { maxTokens: 30, refillRate: 30 / 60 }; // 30/min per account
export const RATE_SESSION_REFRESH: RateLimitConfig = { maxTokens: 5, refillRate: 5 / 3600 }; // 5/hour
export const RATE_OAUTH_CALLBACK: RateLimitConfig = { maxTokens: 10, refillRate: 10 / 60 }; // 10/min
export const RATE_OAUTH_LINK: RateLimitConfig = { maxTokens: 10, refillRate: 10 / 60 }; // 10/min
export const RATE_REGISTER_ASN: RateLimitConfig = { maxTokens: 20, refillRate: 20 / 3600 }; // 20/hour per ASN
export const RATE_RESEND_VERIFICATION: RateLimitConfig = { maxTokens: 3, refillRate: 3 / 3600 }; // 3/hour per account
export const RATE_MARKETPLACE_BROWSE: RateLimitConfig = { maxTokens: 60, refillRate: 1 }; // 60/min
export const RATE_PLUGIN_REPORT: RateLimitConfig = { maxTokens: 5, refillRate: 5 / 3600 }; // 5/hour per account
// Logout is per-IP (session may already be gone) with enough headroom for a
// logged-out client hammering the button, but tight enough to keep a
// credential-stuffing script from using /logout as a free probe channel.
export const RATE_LOGOUT: RateLimitConfig = { maxTokens: 20, refillRate: 20 / 60 }; // 20/min per IP
// Publishing plugins is an admin-only write; the slow rate protects R2 from
// accidental upload floods and guarantees a human-sized review cadence.
export const RATE_PLUGIN_PUBLISH: RateLimitConfig = { maxTokens: 5, refillRate: 5 / 3600 }; // 5/hour per account
// Avatar uploads are cheap but hit R2 presign + public URL lookups; 10/hour is
// plenty for a user adjusting their avatar and cheap enough to absorb one
// compromised account without DoS-ing the bucket.
export const RATE_AVATAR_UPLOAD: RateLimitConfig = { maxTokens: 10, refillRate: 10 / 3600 }; // 10/hour per account
// Admin endpoints (report list/resolve, etc.) — fast enough for real review
// work, slow enough that a stolen admin session can't scrape the entire
// reports table in one shot.
export const RATE_ADMIN_OP: RateLimitConfig = { maxTokens: 100, refillRate: 100 / 3600 }; // 100/hour per admin
// Server-ownership transfer initiate (per initiator account). Five attempts
// per hour is plenty for a real owner correcting a typo on the recipient's
// account_id and rare enough that a stolen session can't spam transfers at a
// hundred different recipients in a minute.
export const RATE_SERVER_TRANSFER_INITIATE: RateLimitConfig = { maxTokens: 5, refillRate: 5 / 3600 }; // 5/hour per account
// Confirm/decline is unauthenticated (token-bearer) so it must key on the
// real client IP. The endpoint already requires a hashed-secret match, so
// the rate limit is mostly to bound brute-force probing of the ~256-bit
// token space — 10/min per IP is fast enough for a real user clicking the
// link a few times and slow enough that scanning is hopeless.
export const RATE_SERVER_TRANSFER_CONFIRM: RateLimitConfig = { maxTokens: 10, refillRate: 10 / 60 }; // 10/min per IP
// Voice external-reachability probe (per-server bucket). The DB-backed 60s
// cooldown is the real cap; this in-process bucket is a cheap pre-filter that
// rejects the burst case before we hit the DB. 5 tokens at 1/min refill lets
// a runtime fire one boot probe + one wan-change probe + a manual retry
// without tripping; sustained spam still hits the cooldown.
export const RATE_VOICE_PROBE: RateLimitConfig = { maxTokens: 5, refillRate: 1 / 60 }; // 1/min steady, 5 burst per server

export function createRateLimiter(
  nowFn: () => number = Date.now,
): RateLimiter {
  const buckets = new Map<string, Bucket>();

  // Evict stale buckets every 5 minutes. A bucket is stale when its last
  // activity is older than the slowest realistic refill window × 10 (i.e. the
  // client hasn't touched the endpoint in a very long time). We use a fixed
  // 10-minute idle threshold — generous enough to cover the slowest config
  // (3/hour ≈ 1 token/20 min) while still bounding Map growth over time.
  const EVICT_IDLE_MS = 10 * 60 * 1000; // 10 minutes
  const evictTimer = setInterval(() => {
    const now = nowFn();
    for (const [k, bucket] of buckets) {
      if (now - bucket.lastRefill > EVICT_IDLE_MS) {
        buckets.delete(k);
      }
    }
  }, 5 * 60 * 1000); // every 5 minutes
  // Don't keep the process alive just for cleanup.
  if (typeof evictTimer === "object" && evictTimer !== null && "unref" in evictTimer) {
    (evictTimer as { unref(): void }).unref();
  }

  return {
    consume(key: string, config: RateLimitConfig) {
      const now = nowFn();
      let bucket = buckets.get(key);

      if (!bucket) {
        bucket = { tokens: config.maxTokens, lastRefill: now };
        buckets.set(key, bucket);
      }

      // Refill tokens based on elapsed time
      const elapsed = (now - bucket.lastRefill) / 1000;
      bucket.tokens = Math.min(
        config.maxTokens,
        bucket.tokens + elapsed * config.refillRate,
      );
      bucket.lastRefill = now;

      if (bucket.tokens >= 1) {
        bucket.tokens -= 1;
        return { allowed: true, retryAfter: 0 };
      }

      // Calculate when 1 token will be available
      const deficit = 1 - bucket.tokens;
      const retryAfter = Math.ceil(deficit / config.refillRate);
      return { allowed: false, retryAfter };
    },
    resetForTests() {
      buckets.clear();
    },
  };
}
