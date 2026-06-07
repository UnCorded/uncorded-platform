// Watchdog — sends IPC pings to plugin subprocesses every 10 seconds.
// If a plugin misses 3 consecutive pings (30 seconds), force-kill it.
// The force-kill triggers SubprocessManager.handleExit() which feeds
// into the restart loop (C1).

import type { SubprocessManager } from "./subprocess";
import { rootLogger } from "@uncorded/shared";

const log = rootLogger.child({ component: "watchdog" });

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_PING_INTERVAL_MS = 10_000;
const DEFAULT_MAX_MISSED_PINGS = 3;

// ---------------------------------------------------------------------------
// Watchdog
// ---------------------------------------------------------------------------

export interface WatchdogOptions {
  pingIntervalMs?: number | undefined;
  maxMissedPings?: number | undefined;
}

export class Watchdog {
  private missedPings = new Map<string, number>();
  private intervalTimer: ReturnType<typeof setInterval> | undefined;
  private readonly pingIntervalMs: number;
  private readonly maxMissedPings: number;

  constructor(
    private subprocessManager: SubprocessManager,
    opts?: WatchdogOptions,
  ) {
    this.pingIntervalMs = opts?.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
    this.maxMissedPings = opts?.maxMissedPings ?? DEFAULT_MAX_MISSED_PINGS;
  }

  /** Start the periodic ping loop. */
  start(): void {
    if (this.intervalTimer !== undefined) return;

    this.intervalTimer = setInterval(() => {
      this.tick();
    }, this.pingIntervalMs);
  }

  /** Stop the ping loop. */
  stop(): void {
    if (this.intervalTimer !== undefined) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = undefined;
    }
    this.missedPings.clear();
  }

  /** Called by the router when a pong is received from a plugin. */
  handlePong(slug: string): void {
    this.missedPings.set(slug, 0);
  }

  /** Run one tick: send pings and check for missed pongs. Exposed for testing. */
  tick(): void {
    // Iterate all tracked plugins — we only care about "ready" ones
    // The subprocess manager tracks all processes; we ping those in "ready" state
    for (const [slug, missed] of this.missedPings) {
      const proc = this.subprocessManager.getProcess(slug);
      if (!proc || proc.state !== "ready") {
        this.missedPings.delete(slug);
        continue;
      }

      const newMissed = missed + 1;

      if (newMissed >= this.maxMissedPings) {
        log.error("plugin missed pings — force killing", { plugin: slug, missedPings: newMissed });
        this.missedPings.delete(slug);
        try {
          proc.subprocess.kill("SIGKILL");
        } catch {
          // Process may have already exited
        }
        continue;
      }

      this.missedPings.set(slug, newMissed);
    }

    // Send ping to all ready plugins (including newly tracked ones)
    this.sendPings();
  }

  /** Start tracking a plugin for watchdog pings. */
  track(slug: string): void {
    this.missedPings.set(slug, 0);
  }

  /** Stop tracking a plugin. */
  untrack(slug: string): void {
    this.missedPings.delete(slug);
  }

  /** Get the current missed ping count for a plugin. */
  getMissedPings(slug: string): number {
    return this.missedPings.get(slug) ?? 0;
  }

  private sendPings(): void {
    for (const slug of this.missedPings.keys()) {
      const proc = this.subprocessManager.getProcess(slug);
      if (!proc || proc.state !== "ready") continue;

      try {
        proc.transport.send({ type: "ping" });
      } catch {
        // Transport may be closed — will be caught on next tick as missed ping
      }
    }
  }
}
