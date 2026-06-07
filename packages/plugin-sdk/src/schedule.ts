// Scheduling API — wraps schedule.register/unregister IPC calls.
//
// Requires runtime.schedule in the plugin manifest permissions.
//
// Schedules are named so plugins can manage multiple independently.
// Re-registering the same name replaces the existing schedule.
// The runtime enforces a minimum interval of 1000ms.
//
// Each tick handler runs with a timeout (default 30s). If the handler exceeds
// the deadline, the tick resolves with a timeout error so the IPC slot is
// unblocked and subsequent ticks are not starved. The handler continues in the
// background — this is a best-effort safety valve, not a hard kill.

import type { IpcUser } from "@uncorded/protocol";
import type { createRequestClient } from "./request";
import type { ScheduleApi, ScheduleOptions, ScheduledHandler } from "./types";
import { unknownResult } from "./schemas";

const DEFAULT_TIMEOUT_MS = 30_000;

interface ScheduleEntry {
  handler: ScheduledHandler;
  timeoutMs: number;
}

function withTimeout<T>(promise: Promise<T>, ms: number, name: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(
        () => reject(new Error(`schedule handler "${name}" timed out after ${ms}ms`)),
        ms,
      )
    ),
  ]);
}

export function createScheduleApi(
  client: ReturnType<typeof createRequestClient>,
  registerHandler: (action: string, handler: (params: Record<string, unknown>, user: IpcUser) => unknown) => void,
): ScheduleApi {
  const entries = new Map<string, ScheduleEntry>();
  let tickHandlerRegistered = false;

  function ensureTickHandler(): void {
    if (tickHandlerRegistered) return;
    tickHandlerRegistered = true;
    registerHandler("schedule.tick", (params) => {
      const name = params["name"];
      if (typeof name !== "string") return;
      const entry = entries.get(name);
      if (!entry) return;
      const firedAt = typeof params["firedAt"] === "number" ? params["firedAt"] : Date.now();
      return withTimeout(
        Promise.resolve(entry.handler({ name, firedAt })),
        entry.timeoutMs,
        name,
      );
    });
  }

  return {
    async every(
      name: string,
      intervalMs: number,
      handler: ScheduledHandler,
      options?: ScheduleOptions,
    ): Promise<void> {
      entries.set(name, {
        handler,
        timeoutMs: options?.timeout_ms ?? DEFAULT_TIMEOUT_MS,
      });
      ensureTickHandler();
      await client.sendAndWait(unknownResult, {
        type: "schedule.register",
        name,
        interval_ms: intervalMs,
      });
    },

    async cancel(name: string): Promise<void> {
      entries.delete(name);
      await client.sendAndWait(unknownResult, {
        type: "schedule.unregister",
        name,
      });
    },
  };
}
