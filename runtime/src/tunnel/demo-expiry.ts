// Demo (quick) Cloudflare tunnels are ephemeral: trycloudflare URLs are
// unauthenticated, rotate on every restart, and are meant for trying things
// out — not for running a server anyone depends on. We deliberately cap a demo
// tunnel's life at 24h so production-on-a-temp-URL is painful enough to push
// owners toward a named (authenticated) tunnel, while still being first-class
// for dev. When the cap fires the runtime kills the tunnel, reports
// tunnel_state="expired" on its next heartbeat (Central then drops it from the
// directory), and stays alive so a desktop restart re-provisions a fresh one.
//
// The timer mechanics live here — separate from the cloudflared-spawning
// provider in entrypoint.ts — so the lifecycle (arm, fire-once, clear, re-arm)
// is unit-testable with injected timers instead of needing a real 24h wait or
// a live cloudflared process.

/** 24 hours. The demo-tunnel time-to-live. */
export const DEMO_TUNNEL_TTL_MS = 24 * 60 * 60 * 1000;

export interface DemoExpiry {
  /** Start the TTL countdown. Re-arming cancels any pending timer first, so a
   *  tunnel restart can't leave two timers racing. */
  arm(): void;
  /** Cancel a pending countdown. Idempotent — safe to call from stop() even if
   *  the timer already fired or was never armed. */
  clear(): void;
}

export interface DemoExpiryOptions {
  ttlMs: number;
  /** Run exactly once when the TTL elapses. Wire this to flip tunnel_state to
   *  "expired", kill the cloudflared process, and reset the advertised URL. */
  onExpire: () => void;
  /** Injectable for tests; defaults to the global timers. */
  setTimer?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

export function createDemoExpiry(options: DemoExpiryOptions): DemoExpiry {
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;
  let timer: ReturnType<typeof setTimeout> | null = null;

  return {
    arm() {
      if (timer !== null) clearTimer(timer);
      timer = setTimer(() => {
        // Drop the handle before firing so a re-arm inside onExpire (or a
        // later clear()) sees a clean slate rather than a stale handle.
        timer = null;
        options.onExpire();
      }, options.ttlMs);
    },
    clear() {
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
    },
  };
}
