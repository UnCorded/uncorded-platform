// Operational boundaries for the HTTP forwarder (plan §Limits and Timeouts).
// Conservative defaults live here as named constants; tests can construct a
// ProxyConnectionRegistry with smaller caps to exercise the gates.

export interface ProxyLimits {
  /** Upstream TCP connect deadline. */
  upstreamConnectTimeoutMs: number;
  /** Deadline for the upstream to return response headers (first byte). */
  upstreamFirstByteTimeoutMs: number;
  /** Max gap between body chunks before a stalled stream is torn down. */
  idleStreamTimeoutMs: number;
  /** Cap on inbound request header bytes. */
  maxRequestHeaderBytes: number;
  /** Cap on upstream response header bytes. */
  maxResponseHeaderBytes: number;
  /** Max WebSocket frame size (Phase 3; defined here for one home). */
  maxWebSocketFrameBytes: number;
  /** Max concurrent proxy connections across the whole server. */
  maxConcurrent: number;
  /** Max concurrent proxy connections per authenticated user. */
  maxConcurrentPerUser: number;
  /** Max concurrent proxy connections per mount. */
  maxConcurrentPerMount: number;
}

export const PROXY_LIMITS: ProxyLimits = {
  upstreamConnectTimeoutMs: 5_000,
  upstreamFirstByteTimeoutMs: 30_000,
  idleStreamTimeoutMs: 60_000,
  maxRequestHeaderBytes: 32_768,
  maxResponseHeaderBytes: 32_768,
  maxWebSocketFrameBytes: 65_536,
  maxConcurrent: 256,
  maxConcurrentPerUser: 16,
  maxConcurrentPerMount: 64,
};

export type AcquireResult =
  | { ok: true; release: () => void }
  | { ok: false; scope: "global" | "user" | "mount" };

/**
 * Tracks active proxy connections and enforces the concurrency caps. One
 * instance is shared per runtime (module singleton in proxy.ts); tests build
 * their own with tight caps.
 *
 * acquire() reserves a slot in all three scopes atomically — if any cap is at
 * its limit it reserves nothing and reports which scope was full. The returned
 * release() is idempotent so a double-release (e.g. error path + finally) can't
 * drive a counter negative.
 */
export class ProxyConnectionRegistry {
  private global = 0;
  private readonly perUser = new Map<string, number>();
  private readonly perMount = new Map<string, number>();

  constructor(private readonly limits: ProxyLimits = PROXY_LIMITS) {}

  acquire(userId: string, mountKey: string): AcquireResult {
    if (this.global >= this.limits.maxConcurrent) return { ok: false, scope: "global" };
    const userCount = this.perUser.get(userId) ?? 0;
    if (userCount >= this.limits.maxConcurrentPerUser) return { ok: false, scope: "user" };
    const mountCount = this.perMount.get(mountKey) ?? 0;
    if (mountCount >= this.limits.maxConcurrentPerMount) return { ok: false, scope: "mount" };

    this.global += 1;
    this.perUser.set(userId, userCount + 1);
    this.perMount.set(mountKey, mountCount + 1);

    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      this.global -= 1;
      const u = (this.perUser.get(userId) ?? 1) - 1;
      if (u <= 0) this.perUser.delete(userId);
      else this.perUser.set(userId, u);
      const m = (this.perMount.get(mountKey) ?? 1) - 1;
      if (m <= 0) this.perMount.delete(mountKey);
      else this.perMount.set(mountKey, m);
    };
    return { ok: true, release };
  }

  /** Snapshot of active counts — observability + tests. */
  active(): { global: number; users: number; mounts: number } {
    return { global: this.global, users: this.perUser.size, mounts: this.perMount.size };
  }
}

export interface IdleTimeoutOptions {
  /** Fires once when the idle deadline trips. */
  onIdle?: () => void;
  /** Fires exactly once when the stream settles (close, error, or cancel). */
  onSettle?: () => void;
}

/**
 * Wrap a body stream so it errors if no chunk arrives within `ms`. Streaming
 * apps and large assets must not hit a body-size cap, so an idle deadline is the
 * tool for a stalled upstream. `onSettle` lets the caller release a held
 * resource (e.g. a connection slot) exactly when the body finishes.
 */
export function withIdleTimeout(
  source: ReadableStream<Uint8Array>,
  ms: number,
  opts: IdleTimeoutOptions = {},
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  const settle = (): void => {
    if (settled) return;
    settled = true;
    opts.onSettle?.();
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const clear = (): void => {
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
      };
      const arm = (): void => {
        clear();
        timer = setTimeout(() => {
          opts.onIdle?.();
          void reader.cancel(new Error("proxy idle stream timeout"));
          controller.error(new Error("proxy idle stream timeout"));
          settle();
        }, ms);
      };

      arm();
      void (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) {
              clear();
              controller.close();
              settle();
              return;
            }
            arm();
            controller.enqueue(value);
          }
        } catch (err) {
          clear();
          controller.error(err);
          settle();
        }
      })();
    },
    cancel(reason) {
      if (timer !== undefined) clearTimeout(timer);
      settle();
      return reader.cancel(reason);
    },
  });
}
