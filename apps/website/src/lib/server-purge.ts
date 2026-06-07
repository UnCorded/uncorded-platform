// Canonical server-removal path. Every trigger that removes a server from
// local state — Danger Zone delete, Central 404/403 on WS open or token
// refresh, 4003 banned close — funnels through purgeServer(id, reason).
//
// The function is idempotent: a concurrent second call for the same id
// short-circuits on the `purging` guard. The try/finally ensures a
// throwing subscriber can't wedge the guard.

import { abortReconnect, disconnect } from "@/lib/ws";
import { removeServer } from "@/stores/servers";
import { showInlineStatus } from "@/lib/feedback";
import type { FeedbackSeverity } from "@/lib/feedback";

export type PurgeReason = "user-delete" | "central-gone" | "banned" | "token-revoked";

type Subscriber = (serverId: string, reason: PurgeReason) => void;

const subscribers = new Set<Subscriber>();
const purging = new Set<string>();

export function onServerPurged(cb: Subscriber): () => void {
  subscribers.add(cb);
  return () => { subscribers.delete(cb); };
}

function statusFor(reason: PurgeReason): { message: string; severity: FeedbackSeverity } {
  switch (reason) {
    case "user-delete":
      return { message: "Server deleted.", severity: "info" };
    case "central-gone":
      return { message: "Server was removed from Central.", severity: "warning" };
    case "banned":
      return { message: "You were removed from this server.", severity: "warning" };
    case "token-revoked":
      return { message: "Server access was revoked.", severity: "warning" };
  }
}

export async function purgeServer(serverId: string, reason: PurgeReason): Promise<void> {
  if (purging.has(serverId)) return;
  purging.add(serverId);
  try {
    abortReconnect(serverId);
    disconnect(serverId);
    for (const cb of subscribers) {
      try {
        cb(serverId, reason);
      } catch (err) {
        console.error("[purge] subscriber threw", err);
      }
    }
    removeServer(serverId);
    const { message, severity } = statusFor(reason);
    showInlineStatus(message, severity);
  } finally {
    purging.delete(serverId);
  }
}
