// Heartbeat client — the runtime's polling connection to Central.
// Phones home every 30s, caches public keys, dispatches deltas to injected handlers.
// The HTTP polling path is permanent infrastructure (fallback for Phase 2 WS).

import type {
  CentralConnection,
  HeartbeatClientOptions,
  HeartbeatDelta,
  HeartbeatRequest,
  HeartbeatResponse,
  PollResult,
  PublicKeyEntry,
} from "./types";

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_SERVER_DELETED_THRESHOLD = 3;
const DEFAULT_KEY_ROTATION_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h
const STALE_WINDOW_MULTIPLIER = 2;
const FORCE_REFRESH_MIN_INTERVAL_MS = 5_000;

function isPublicKeyEntry(v: unknown): v is PublicKeyEntry {
  if (typeof v !== "object" || v === null) return false;
  const obj = v as Record<string, unknown>;
  return typeof obj["id"] === "string" && typeof obj["public_key"] === "object" && obj["public_key"] !== null;
}

function isValidDirtyResponse(
  body: Record<string, unknown>,
): body is { dirty: true; sync_version: number; public_keys: unknown[]; deltas: unknown[] } {
  return (
    typeof body["sync_version"] === "number" &&
    Array.isArray(body["public_keys"]) &&
    Array.isArray(body["deltas"])
  );
}

function isHeartbeatResponse(body: unknown): body is HeartbeatResponse {
  if (typeof body !== "object" || body === null) return false;
  const obj = body as Record<string, unknown>;
  if (typeof obj["dirty"] !== "boolean") return false;
  // wan_ip is optional in both branches; tolerate missing or string. Reject
  // any other type so we don't pass garbage through to onWanIp.
  if (obj["wan_ip"] !== undefined && typeof obj["wan_ip"] !== "string") {
    return false;
  }
  if (obj["dirty"] === false) return true;
  return isValidDirtyResponse(obj);
}

export function createHeartbeatClient(
  options: HeartbeatClientOptions,
): CentralConnection {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const setIntervalFn = options.setInterval ?? globalThis.setInterval;
  const clearIntervalFn: (id: unknown) => void =
    options.clearInterval ?? ((id) => globalThis.clearInterval(id as Parameters<typeof globalThis.clearInterval>[0]));
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const onWarn = options.onWarn ?? (() => {});
  const now = options.now ?? Date.now;
  const keyRotationWindowMs = options.keyRotationWindowMs ?? DEFAULT_KEY_ROTATION_WINDOW_MS;
  const staleThresholdMs = keyRotationWindowMs * STALE_WINDOW_MULTIPLIER;

  let publicKeys: PublicKeyEntry[] = options.cachedPublicKeys
    ? [...options.cachedPublicKeys]
    : [];
  let lastSyncVersion: number = options.cachedSyncVersion ?? 0;
  let intervalHandle: unknown = null;
  let running = false;
  let consecutive404s = 0;
  let serverDeletedFired = false;
  let inflightRefresh: Promise<void> | null = null;
  let lastRefreshAt = 0;
  const serverDeletedThreshold = options.serverDeletedThreshold ?? DEFAULT_SERVER_DELETED_THRESHOLD;

  // `lastKeysConfirmedAt` is set to wall-clock time on every SUCCESSFUL
  // poll, dirty or clean — both confirm the cache matches Central's current
  // view. A clean cache loaded from server.json is deliberately NOT treated
  // as fresh: we have no evidence Central still accepts those keys until a
  // live poll succeeds. `null` therefore means "never confirmed in this
  // process".
  let lastKeysConfirmedAt: number | null = null;
  // Last wan_ip observed in a heartbeat response. Tracked here (not in the
  // reachability subsystem) so the heartbeat client can fire `onWanIp` only
  // on delta — subscribers don't need to dedupe themselves. `null` means
  // "Central has never echoed wan_ip yet" (e.g. dev runs without CF/XFF).
  let lastWanIp: string | null = null;
  // Fires onKeysStale exactly once per stale episode — we don't want to
  // spam the caller's log.error loop every 30s while Central is down.
  // Resets when a successful poll brings the cache back into freshness.
  let staleFiredAt: number | null = null;

  function markKeysFresh(): void {
    lastKeysConfirmedAt = now();
    staleFiredAt = null;
  }

  function checkStale(): void {
    if (lastKeysConfirmedAt === null) return;
    const age = now() - lastKeysConfirmedAt;
    if (age < staleThresholdMs) return;
    // Don't re-fire until a successful poll resets the timestamp.
    if (staleFiredAt !== null) return;
    staleFiredAt = now();
    options.onKeysStale?.(age);
  }

  const url =
    options.centralUrl.replace(/\/+$/, "") +
    `/v1/servers/${options.serverId}/heartbeat`;

  async function poll(): Promise<PollResult> {
    const result = await pollOnce();
    // Runs on every poll, success OR failure. Successful polls reset
    // lastKeysConfirmedAt inside pollOnce first, so this only fires when
    // we've been failing to reach Central for ≥ 2× rotation window.
    checkStale();
    return result;
  }

  async function pollOnce(): Promise<PollResult> {
    const request: HeartbeatRequest = {
      server_id: options.serverId,
      server_secret: options.serverSecret,
      last_sync_version: lastSyncVersion,
      tunnel_url: options.getTunnelUrl(),
      runtime_version: options.runtimeVersion,
      connected_users: options.getConnectedUsers(),
      plugin_count: options.getPluginCount(),
    };

    const tunnelState = options.getTunnelState?.();
    if (tunnelState !== undefined) {
      request.tunnel_state = tunnelState;
    }

    const updateState = options.getUpdateState?.();
    if (updateState !== undefined) {
      request.channel = updateState.channel;
      request.update_state = updateState;
    }

    let res: Response;
    try {
      res = await fetchFn(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });
    } catch {
      if (publicKeys.length > 0) {
        onWarn("Central unreachable — operating with cached keys");
      }
      return {
        ok: false,
        error: {
          code: "CENTRAL_UNREACHABLE",
          message: "Failed to reach Central",
        },
      };
    }

    if (!res.ok) {
      // 404 = Central no longer knows about this server. Track consecutive
      // 404s so a transient DB blip can't trigger self-destruct, but a real
      // deletion (user deleted via web, skipping the Electron IPC that would
      // have stopped the container) eventually does.
      if (res.status === 404) {
        consecutive404s += 1;
        if (consecutive404s >= serverDeletedThreshold && !serverDeletedFired) {
          serverDeletedFired = true;
          onWarn(`Central returned 404 on ${String(consecutive404s)} consecutive heartbeats — server appears to have been deleted.`);
          if (options.onServerDeleted) {
            try {
              options.onServerDeleted();
            } catch (err) {
              onWarn(
                `onServerDeleted threw: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
        }
        return {
          ok: false,
          error: {
            code: "SERVER_DELETED",
            message: `Central returned 404 (${String(consecutive404s)} consecutive)`,
          },
        };
      }
      return {
        ok: false,
        error: {
          code: "HTTP_ERROR",
          message: `Central returned ${String(res.status)}`,
        },
      };
    }

    // Reset on any non-404 response — we got through to Central.
    consecutive404s = 0;

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return {
        ok: false,
        error: {
          code: "INVALID_RESPONSE",
          message: "Response body is not valid JSON",
        },
      };
    }

    if (!isHeartbeatResponse(body)) {
      return {
        ok: false,
        error: {
          code: "INVALID_RESPONSE",
          message: "Response does not match expected heartbeat shape",
        },
      };
    }

    // wan_ip dispatch — fires on first observation and on every change.
    // Wrapped in try/catch so a buggy subscriber can't break the heartbeat
    // loop. Same defensive shape as the other on*() handlers below.
    if (typeof body.wan_ip === "string" && body.wan_ip !== lastWanIp) {
      lastWanIp = body.wan_ip;
      if (options.onWanIp) {
        try {
          options.onWanIp(body.wan_ip);
        } catch (err) {
          onWarn(
            `onWanIp threw: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    if (!body.dirty) {
      // Clean responses confirm the cache is still authoritative — reset
      // staleness even though we didn't receive a new key bundle.
      markKeysFresh();
      options.logger?.debug("heartbeat ok", {
        dirty: false,
        wanIp: lastWanIp,
        connectedUsers: options.getConnectedUsers(),
      });
      return { ok: true, dirty: false, deltasApplied: 0 };
    }

    // Dirty response — update keys, apply deltas, advance version
    publicKeys = body.public_keys.filter(isPublicKeyEntry);
    markKeysFresh();

    let applied = 0;
    for (const delta of body.deltas) {
      const typed = delta as HeartbeatDelta;
      const handler = options.deltaHandlers[typed.type];
      if (handler == null) {
        onWarn(`Unknown or unhandled delta type: ${typed.type}, skipping`);
        continue;
      }
      try {
        // The mapped type ensures handler receives the correct delta subtype
        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
        (handler as (d: HeartbeatDelta) => void)(typed);
        applied++;
      } catch (err) {
        onWarn(
          `Delta handler for ${typed.type} threw: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Full snapshot — server was offline too long, deltas expired
    if (body.full_snapshot === true) {
      onWarn("Server was offline too long — full re-sync needed. Forcing re-authentication of all connected users.");
      if (options.onFullSnapshot) {
        try {
          options.onFullSnapshot();
        } catch (err) {
          onWarn(
            `onFullSnapshot threw: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    lastSyncVersion = body.sync_version;

    // Persist delta state (e.g., write to server.json) — fire-and-forget
    if (options.onDirtySync) {
      void Promise.resolve()
        .then(() => options.onDirtySync?.(lastSyncVersion, publicKeys))
        .catch((err) => {
          onWarn(
            `onDirtySync threw: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    }

    options.logger?.debug("heartbeat ok", {
      dirty: true,
      wanIp: lastWanIp,
      deltasApplied: applied,
      connectedUsers: options.getConnectedUsers(),
    });
    return { ok: true, dirty: true, deltasApplied: applied };
  }

  async function runPollSafely(context: "startup" | "interval"): Promise<void> {
    try {
      await poll();
    } catch (err) {
      onWarn(
        `Heartbeat poll threw during ${context}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  function start(): void {
    if (running) return;
    running = true;
    void runPollSafely("startup");
    intervalHandle = setIntervalFn(() => {
      void runPollSafely("interval");
    }, intervalMs);
  }

  function stop(): void {
    if (!running) return;
    running = false;
    if (intervalHandle !== null) {
      clearIntervalFn(intervalHandle);
      intervalHandle = null;
    }
  }

  async function forceRefresh(): Promise<void> {
    // Single-flight: a concurrent caller piggybacks on the in-flight poll.
    if (inflightRefresh) return inflightRefresh;
    // Throttle: a successful refresh blocks repeats within the min interval,
    // so a flood of UNKNOWN_KEY misses can't hammer Central.
    if (now() - lastRefreshAt < FORCE_REFRESH_MIN_INTERVAL_MS) return;
    inflightRefresh = (async () => {
      try {
        await pollOnce();
      } catch (err) {
        onWarn(
          `forceRefresh poll threw: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        lastRefreshAt = now();
        inflightRefresh = null;
      }
    })();
    return inflightRefresh;
  }

  function getPublicKeys(): readonly PublicKeyEntry[] {
    return Object.freeze([...publicKeys]);
  }

  function getSyncVersion(): number {
    return lastSyncVersion;
  }

  function getKeysAgeMs(): number | null {
    if (lastKeysConfirmedAt === null) return null;
    return now() - lastKeysConfirmedAt;
  }

  function areKeysStale(): boolean {
    if (lastKeysConfirmedAt === null) return false;
    return now() - lastKeysConfirmedAt >= staleThresholdMs;
  }

  return { poll, start, stop, forceRefresh, getPublicKeys, getSyncVersion, getKeysAgeMs, areKeysStale };
}
