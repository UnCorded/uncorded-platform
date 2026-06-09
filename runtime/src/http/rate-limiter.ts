// Rate limiter — token bucket with sliding window refill and escalating IP bans.
// Used by the HTTP handler to enforce per-endpoint rate limits.
//
// Time is injectable via the constructor for deterministic testing.

import type { Logger } from "@uncorded/shared";
import type { RateLimitConfig } from "./types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** GET /health */
export const RATE_HEALTH: RateLimitConfig = { tokens: 60, windowMs: 60_000 };

/** POST /upload, POST /upload/init, POST /upload/<id>/finalize, GET/DELETE /upload/<id> */
export const RATE_UPLOAD: RateLimitConfig = { tokens: 10, windowMs: 60_000 };

/**
 * PATCH /upload/<id>?offset=N — chunked upload body append.
 *
 * Chunk count scales with file size: a single 5 GiB upload at the 8 MiB default
 * chunk size is ~640 PATCHes, and we want to support a handful of parallel
 * uploads from the same user without 429-throttling resumes to death.
 * RATE_UPLOAD's 10/min was sized when every upload was one POST; it cannot
 * meaningfully throttle PATCHes because throughput is already bounded by the
 * network and the per-session mutex. This bucket only guards against a runaway
 * client looping with empty bodies.
 */
export const RATE_UPLOAD_CHUNK: RateLimitConfig = { tokens: 1200, windowMs: 60_000 };

/** /admin/* */
export const RATE_ADMIN: RateLimitConfig = { tokens: 30, windowMs: 60_000 };

/**
 * POST /admin/api/check-update — orchestrator-driven update check trigger.
 * Phase 01 §11.3: 1 per 30s per server. Fast bursts here would have the
 * runtime spam the orchestrator's image-resolution path; the broadcast on
 * state="checking" is also user-visible, so a tight cap keeps the UI from
 * flickering. Keyed per-server (single shared bucket) — every authenticated
 * caller draws from the same well.
 */
export const RATE_CHECK_UPDATE: RateLimitConfig = { tokens: 1, windowMs: 30_000 };

// Plugin static assets — generous for asset serving
export const RATE_STATIC: RateLimitConfig = { tokens: 120, windowMs: 60_000 };

// Plugin manifest.json
export const RATE_MANIFEST: RateLimitConfig = { tokens: 60, windowMs: 60_000 };

/**
 * POST /runtime/voice/webhook — LiveKit webhook deliveries.
 *
 * Sized for the 4c cascade burst: a moderator banning a user with N active
 * voice sessions fans out to N participant_left deliveries from the single
 * LiveKit IP within seconds. RATE_HEALTH (60/min) would force LiveKit
 * retries on a 60+-participant room destroy. 600/min/IP gives room for a
 * ~100-participant room destroy with headroom; auth still gates forged
 * traffic, this bucket only exists to avoid DoS via the loopback path.
 */
export const RATE_VOICE_WEBHOOK: RateLimitConfig = { tokens: 600, windowMs: 60_000 };

// WebSocket connection attempts (per IP)
export const RATE_WS_CONNECT: RateLimitConfig = { tokens: 10, windowMs: 60_000 };

// sdk.request() calls (per user per plugin)
export const RATE_WS_REQUEST: RateLimitConfig = { tokens: 60, windowMs: 60_000 };

// sdk.subscribe() calls (per user)
export const RATE_WS_SUBSCRIBE: RateLimitConfig = { tokens: 20, windowMs: 60_000 };

/**
 * Combined sdk.presence.{join, update, leave} call rate per (plugin, user, scope).
 * Per spec-23 §"Bounds and Limits": ~120/sec/user/scope. This is a DoS guard,
 * not a quality knob — a buggy client sending 10k typing events/sec must not
 * push the runtime into meaningful work.
 */
export const RATE_PRESENCE: RateLimitConfig = { tokens: 120, windowMs: 1_000 };

// Reverse-proxy HTTP passthrough (per IP, pre-auth). Browser apps issue many
// sub-resource requests per page, so this is generous — it's a DoS guard, not a
// usage cap. See docs/reverse-proxy/plugin-reverse-proxy-plan.md §Rate Limiting.
export const RATE_PROXY_HTTP: RateLimitConfig = { tokens: 600, windowMs: 60_000 };

// Reverse-proxy WebSocket upgrade attempts (per IP). Reserved for Phase 3; named
// here so the proxy rate-limit family lives in one place.
export const RATE_PROXY_WS_CONNECT: RateLimitConfig = { tokens: 30, windowMs: 60_000 };

// Reverse-proxy session bootstrap (Bearer-authed, per user). One mint per
// iframe open; modest bucket.
export const RATE_PROXY_SESSION: RateLimitConfig = { tokens: 30, windowMs: 60_000 };

/** Consecutive auth failures before short ban */
export const BAN_THRESHOLD_SHORT = 3;
/** Short ban duration: 5 minutes */
export const BAN_DURATION_SHORT_MS = 5 * 60 * 1_000;

/** Consecutive auth failures before long ban */
export const BAN_THRESHOLD_LONG = 10;
/** Long ban duration: 1 hour */
export const BAN_DURATION_LONG_MS = 60 * 60 * 1_000;

/** How often to purge expired entries (2 minutes) */
const CLEANUP_INTERVAL_MS = 2 * 60 * 1_000;

/**
 * Minimum gap between warn-on-deny lines for the same bucket.
 *
 * A saturated bucket denies on every attempt; without debouncing a stuck
 * client trying once per second would flood the log file. 30 seconds is
 * short enough that the line still appears while the user is still hitting
 * the wall, long enough that a misbehaving client can't drown other signal.
 * Each emitted line carries the count of denies suppressed since the last
 * warn so the operator still sees the magnitude.
 */
const DENY_WARN_DEBOUNCE_MS = 30_000;

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type ConsumeResult =
  | { allowed: true }
  | { allowed: false; retryAfterMs: number };

export type BanCheckResult =
  | { banned: false }
  | { banned: true; retryAfterMs: number };

export interface AuthFailureResult {
  banned: boolean;
  banDurationMs: number;
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

interface BucketEntry {
  tokens: number;
  lastRefill: number;
  // Audit trail for warn-on-deny: how many denies have been suppressed since
  // the last warn line, and when that warn was emitted. Both fields stay 0
  // when no logger is wired so the cost is one zero-write per consume() and
  // one read per deny — invisible compared to the Map lookups already on the
  // hot path.
  lastWarnAt: number;
  suppressedDenies: number;
}

interface BanEntry {
  failures: number;
  bannedUntil: number;
}

// ---------------------------------------------------------------------------
// RateLimiter
// ---------------------------------------------------------------------------

export class RateLimiter {
  private readonly buckets = new Map<string, BucketEntry>();
  private readonly bans = new Map<string, BanEntry>();
  private readonly now: () => number;
  private readonly logger: Logger | undefined;
  private cleanupTimer: ReturnType<typeof setInterval> | undefined;

  constructor(now?: () => number, logger?: Logger) {
    this.now = now ?? Date.now;
    this.logger = logger;

    // Only start auto-cleanup if using real time
    if (!now) {
      this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    }
  }

  // -----------------------------------------------------------------------
  // Token bucket
  // -----------------------------------------------------------------------

  /**
   * Attempt to consume one token from the bucket identified by `key`.
   * Returns allowed: true if a token was available, or allowed: false
   * with retryAfterMs indicating when to retry.
   */
  consume(key: string, config: RateLimitConfig): ConsumeResult {
    const now = this.now();
    let entry = this.buckets.get(key);

    if (!entry) {
      // First request — start with full bucket minus 1. lastWarnAt = -1 is
      // the "never warned" sentinel; tests run at time = 0 so we can't reuse
      // 0 as the sentinel without colliding with a real first-warn timestamp.
      this.buckets.set(key, {
        tokens: config.tokens - 1,
        lastRefill: now,
        lastWarnAt: -1,
        suppressedDenies: 0,
      });
      return { allowed: true };
    }

    // Refill tokens based on elapsed time
    const elapsed = now - entry.lastRefill;
    const refillRate = config.tokens / config.windowMs;
    const refilled = Math.min(
      config.tokens,
      entry.tokens + elapsed * refillRate,
    );

    entry.tokens = refilled;
    entry.lastRefill = now;

    if (entry.tokens < 1) {
      // Not enough tokens — calculate when 1 token will be available
      const deficit = 1 - entry.tokens;
      const retryAfterMs = Math.ceil(deficit / refillRate);
      this.logDeny(entry, key, config, retryAfterMs, now);
      return { allowed: false, retryAfterMs };
    }

    entry.tokens -= 1;
    return { allowed: true };
  }

  // Debounced warn line on deny. The first deny in a fresh window logs
  // immediately; subsequent denies bump suppressedDenies until the window
  // elapses. The next emitted line reports how many were suppressed so the
  // operator can tell the difference between "client gave up" and "client is
  // still hammering". No-op when no logger was wired.
  private logDeny(
    entry: BucketEntry,
    key: string,
    config: RateLimitConfig,
    retryAfterMs: number,
    now: number,
  ): void {
    if (this.logger === undefined) return;
    const isFirstWarn = entry.lastWarnAt === -1;
    if (!isFirstWarn && now - entry.lastWarnAt < DENY_WARN_DEBOUNCE_MS) {
      entry.suppressedDenies += 1;
      return;
    }
    this.logger.warn("rate limit exceeded", {
      key,
      retryAfterMs,
      tokensPerWindow: config.tokens,
      windowMs: config.windowMs,
      suppressedSinceLastWarn: entry.suppressedDenies,
    });
    entry.lastWarnAt = now;
    entry.suppressedDenies = 0;
  }

  // -----------------------------------------------------------------------
  // IP ban tracking
  // -----------------------------------------------------------------------

  /**
   * Record an auth failure for an IP. Increments the consecutive failure
   * counter and triggers bans at thresholds.
   */
  recordAuthFailure(ip: string): AuthFailureResult {
    const now = this.now();
    let entry = this.bans.get(ip);

    if (!entry) {
      entry = { failures: 0, bannedUntil: 0 };
      this.bans.set(ip, entry);
    }

    entry.failures += 1;

    if (entry.failures >= BAN_THRESHOLD_LONG) {
      entry.bannedUntil = now + BAN_DURATION_LONG_MS;
      this.logger?.warn("ip banned (long)", {
        ip,
        failures: entry.failures,
        durationMs: BAN_DURATION_LONG_MS,
      });
      return { banned: true, banDurationMs: BAN_DURATION_LONG_MS };
    }

    if (entry.failures >= BAN_THRESHOLD_SHORT) {
      entry.bannedUntil = now + BAN_DURATION_SHORT_MS;
      this.logger?.warn("ip banned (short)", {
        ip,
        failures: entry.failures,
        durationMs: BAN_DURATION_SHORT_MS,
      });
      return { banned: true, banDurationMs: BAN_DURATION_SHORT_MS };
    }

    return { banned: false, banDurationMs: 0 };
  }

  /**
   * Record a successful auth — resets consecutive failure count for the IP.
   */
  recordAuthSuccess(ip: string): void {
    this.bans.delete(ip);
  }

  /**
   * Check if an IP is currently banned.
   */
  isBanned(ip: string): BanCheckResult {
    const entry = this.bans.get(ip);
    if (!entry || entry.bannedUntil === 0) {
      return { banned: false };
    }

    const now = this.now();
    if (now >= entry.bannedUntil) {
      // Ban expired — clear the ban but keep failure count for escalation
      entry.bannedUntil = 0;
      return { banned: false };
    }

    return { banned: true, retryAfterMs: entry.bannedUntil - now };
  }

  // -----------------------------------------------------------------------
  // Cleanup
  // -----------------------------------------------------------------------

  /**
   * Purge expired bucket entries and expired bans. Called periodically
   * or manually in tests.
   */
  cleanup(): void {
    const now = this.now();

    // Remove bucket entries that haven't been touched in 2x any reasonable window
    const staleThreshold = 2 * 60_000; // 2 minutes
    for (const [key, entry] of this.buckets) {
      if (now - entry.lastRefill > staleThreshold) {
        this.buckets.delete(key);
      }
    }

    // Clear expired bans but keep failure counts for escalation
    for (const [, entry] of this.bans) {
      if (entry.bannedUntil > 0 && now >= entry.bannedUntil) {
        entry.bannedUntil = 0;
      }
    }
  }

  /**
   * Tear down the auto-cleanup timer.
   */
  dispose(): void {
    if (this.cleanupTimer !== undefined) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }
}
