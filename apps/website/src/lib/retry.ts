// Shared retry-with-backoff helper — spec-10 Amendment A PR-TR5.
//
// Used by sidebar.ts (/plugins), the wizard's icon upload, and the wizard's
// background tunnel probe to ride out transient Cloudflare propagation
// failures, 502/503 bursts, and tab-suspend network blips without flipping
// the visible "sidebar broken" state on the user's first attempt.
//
// Failure semantics:
//   - HTTP 4xx (except 408/429) → fail fast. A 404 from Cloudflare's edge for
//     an unpropagated hostname is the same shape as a real "no such route",
//     and pacing the retry there is the desktop probe's job (PR-TR3) — the
//     web client shouldn't double-stack.
//   - HTTP 408, 429, 502, 503, 521, 522, 523, 525 → retry.
//   - Network errors (TypeError from fetch, non-signal AbortError) → retry.
//   - Signal-driven AbortError → propagate immediately, no further attempts.
//
// Retry-After is honored on 429 responses but capped at the configured
// backoff ceiling so a server-sent value of 600s can't pin the UI.

export const DEFAULT_RETRY_ATTEMPTS = 4;
export const DEFAULT_RETRY_BACKOFF_MS = [500, 1500, 3000] as const;
export const DEFAULT_RETRY_BACKOFF_CEILING_MS = 8_000;

/** Status codes that indicate a transient server-side condition. */
export const RETRYABLE_STATUS = new Set<number>([408, 429, 502, 503, 521, 522, 523, 525]);

export interface RetryOptions {
  /** Total attempt count including the initial call. Default 4. */
  readonly attempts?: number;
  /** Delay between attempts. Length < (attempts-1) reuses the final entry. */
  readonly backoffMs?: readonly number[];
  /** Upper bound on any single backoff (incl. Retry-After overrides). Default 8s. */
  readonly backoffCeilingMs?: number;
  /** Custom retry predicate. Receives the error or a non-ok Response. */
  readonly shouldRetry?: (err: unknown) => boolean;
  /** Aborts the entire retry loop. */
  readonly signal?: AbortSignal;
  /** Injectable sleep — tests pass a fake. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export class RetryAbortedError extends Error {
  override readonly name = "RetryAbortedError";
}

export class RetryExhaustedError extends Error {
  override readonly name = "RetryExhaustedError";
  readonly attempts: number;
  readonly lastError: unknown;
  constructor(attempts: number, lastError: unknown) {
    const lastMsg = lastError instanceof Error ? lastError.message : String(lastError);
    super(`retry exhausted after ${String(attempts)} attempt(s): ${lastMsg}`);
    this.attempts = attempts;
    this.lastError = lastError;
  }
}

function defaultShouldRetry(err: unknown): boolean {
  if (err instanceof Response) return RETRYABLE_STATUS.has(err.status);
  if (err instanceof TypeError) return true;
  if (err instanceof DOMException && err.name === "AbortError") {
    // Signal-driven aborts are caller intent — never retry. A non-signal
    // AbortError is a fetch-internal timeout and is fine to retry.
    return false;
  }
  if (err instanceof Error) {
    // Bun's AbortSignal.timeout surfaces as a plain Error with "timeout" /
    // "aborted" in the message — treat as transient.
    if (/timeout|aborted|network|fetch failed/i.test(err.message)) return true;
  }
  return false;
}

function parseRetryAfter(headerValue: string | null, nowMs: number): number | null {
  if (!headerValue) return null;
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const httpDateMs = Date.parse(headerValue);
  if (Number.isFinite(httpDateMs)) return Math.max(0, httpDateMs - nowMs);
  return null;
}

function pickBackoff(
  attemptIndex: number,
  backoffMs: readonly number[],
  ceiling: number,
): number {
  if (backoffMs.length === 0) return 0;
  const raw = backoffMs[Math.min(attemptIndex, backoffMs.length - 1)] ?? 0;
  return Math.min(raw, ceiling);
}

/**
 * Run `fn` with bounded retry-and-backoff.
 *
 * `fn` may either resolve with a value (returned as-is) or resolve with a
 * Response. A non-ok Response is treated as a potentially-retryable failure
 * — the helper inspects status against {@link RETRYABLE_STATUS} and either
 * retries or returns the Response untouched so callers can branch on
 * `res.ok`.
 *
 * Throws {@link RetryExhaustedError} when every attempt fails on a network
 * error, or {@link RetryAbortedError} if the signal fires.
 */
export async function retry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? DEFAULT_RETRY_ATTEMPTS;
  const backoffMs = options.backoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
  const ceiling = options.backoffCeilingMs ?? DEFAULT_RETRY_BACKOFF_CEILING_MS;
  const shouldRetry = options.shouldRetry ?? defaultShouldRetry;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const signal = options.signal;

  let lastError: unknown = new Error("retry: no attempt made");

  for (let i = 0; i < attempts; i++) {
    if (signal?.aborted) throw new RetryAbortedError("retry aborted before attempt");

    try {
      const result = await fn();
      // Response detection: a non-ok HTTP response should be subject to the
      // shouldRetry gate. ok responses pass through untouched.
      if (result instanceof Response && !result.ok) {
        if (!shouldRetry(result) || i === attempts - 1) return result;
        const retryAfterMs = parseRetryAfter(
          result.headers.get("retry-after"),
          Date.now(),
        );
        const baseDelay = pickBackoff(i, backoffMs, ceiling);
        const delay = retryAfterMs !== null ? Math.min(retryAfterMs, ceiling) : baseDelay;
        if (delay > 0) await sleep(delay);
        if (signal?.aborted) throw new RetryAbortedError("retry aborted between attempts");
        lastError = result;
        continue;
      }
      return result;
    } catch (err) {
      if (err instanceof RetryAbortedError) throw err;
      if (signal?.aborted) throw new RetryAbortedError("retry aborted between attempts");
      lastError = err;
      if (!shouldRetry(err) || i === attempts - 1) throw err;
      const delay = pickBackoff(i, backoffMs, ceiling);
      if (delay > 0) await sleep(delay);
      if (signal?.aborted) throw new RetryAbortedError("retry aborted between attempts");
    }
  }

  throw new RetryExhaustedError(attempts, lastError);
}
