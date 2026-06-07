// Per-server voice reachability — spec-24 Amendment A1 client surface.
//
// Tracks whether the runtime's RTC ports (TCP 7881, UDP 3478) are
// reachable from the public internet. UDP 3478 is LiveKit's embedded
// TURN/STUN responder — see spec-24 Amendment C for why we probe it
// instead of the UDP MUX media port (50000): pion ICE drops cold STUN
// Binding Requests at the MUX socket because its USERNAME-required
// dispatch has no active session to map to. RFC 5766 §6.5 forces TURN
// servers to answer bare STUN, which makes 3478 the deterministic
// reachability target.
//
// The runtime owns the state machine (see runtime/src/voice/reachability.ts)
// and surfaces two layers:
//
//   1. Public, redacted: GET /health/voice → externalReachability with
//      wanIp stripped. Anyone with the tunnel URL can read.
//   2. Owner-only, full: GET /admin/api/voice/state → externalReachability
//      with wanIp included. Used by the diagnostics modal.
//
// The shell only needs the public projection to dim broken voice rows,
// so this store consumes the redacted form. Two ingestion paths:
//
//   - Bootstrap on activeServer change → fetch /health/voice once.
//   - Live updates → subscribe to the voice-channels plugin broadcast
//     `voice.reachability.changed` (already redacted by the plugin
//     backend before fanout).
//
// Fail-open: a probe error or missing field collapses to "ready" (no dim)
// rather than "unreachable" (dim). A transient probe failure should never
// hide an otherwise-working channel from users.

import { createSignal, createEffect, onCleanup } from "solid-js";

import { activeServer } from "./servers";
import { onPluginMessage, onReconnect } from "../lib/ws";

export type ReachabilityStatus = "checking" | "ready" | "unreachable";

interface PortGroupResult {
  reachable: boolean;
  latencyMs: number | null;
  error: string | null;
}

interface ProbeResult {
  status: "ready" | "unreachable";
  checkedAt: string;
  rtcTcp: PortGroupResult;
  rtcUdp: PortGroupResult;
}

export interface ReachabilitySnapshot {
  status: ReachabilityStatus;
  result: ProbeResult | null;
}

const [statusSignal, setStatusSignal] = createSignal<ReadonlyMap<string, ReachabilitySnapshot>>(
  new Map(),
);

const statusByServer = new Map<string, ReachabilitySnapshot>();

function setSnapshot(serverId: string, snap: ReachabilitySnapshot): void {
  const prev = statusByServer.get(serverId);
  if (
    prev?.status === snap.status &&
    prev.result?.checkedAt === snap.result?.checkedAt
  ) {
    return;
  }
  statusByServer.set(serverId, snap);
  setStatusSignal(new Map(statusByServer));
}

export function voiceReachability(serverId: string | null): ReachabilitySnapshot | null {
  if (serverId === null) return null;
  return statusSignal().get(serverId) ?? null;
}

export function isVoiceUnreachable(serverId: string | null): boolean {
  if (serverId === null) return false;
  return statusSignal().get(serverId)?.status === "unreachable";
}

function isPortGroup(v: unknown): v is PortGroupResult {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o["reachable"] === "boolean" &&
    (typeof o["latencyMs"] === "number" || o["latencyMs"] === null) &&
    (typeof o["error"] === "string" || o["error"] === null)
  );
}

function parseResult(raw: unknown): ProbeResult | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r["status"] !== "ready" && r["status"] !== "unreachable") return null;
  if (typeof r["checkedAt"] !== "string") return null;
  if (!isPortGroup(r["rtcTcp"]) || !isPortGroup(r["rtcUdp"])) return null;
  return {
    status: r["status"],
    checkedAt: r["checkedAt"],
    rtcTcp: r["rtcTcp"],
    rtcUdp: r["rtcUdp"],
  };
}

function parseEnvelope(raw: unknown): ReachabilitySnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const status = o["status"];
  if (status === "checking") {
    return { status, result: parseResult(o["lastResult"]) };
  }
  if (status === "ready" || status === "unreachable") {
    const result = parseResult(o["result"]);
    if (!result) return null;
    return { status, result };
  }
  return null;
}

async function probeOnce(serverId: string, tunnelUrl: string, signal: AbortSignal): Promise<void> {
  try {
    const res = await fetch(`${tunnelUrl}/health/voice`, { signal });
    if (signal.aborted) return;
    const body = (await res.json()) as { externalReachability?: unknown };
    if (signal.aborted) return;
    const snap = parseEnvelope(body.externalReachability);
    if (snap) setSnapshot(serverId, snap);
  } catch (err) {
    if (signal.aborted) return;
    // Fail-open: leave whatever we already had cached. A network blip should
    // not flip an otherwise-fine row into a dimmed state.
    console.warn("[voice-reachability] probe failed", { serverId, err });
  }
}

/** Mount the reachability store. Call once from App's onMount. */
export function mountVoiceReachabilityStore(): void {
  let inflight: AbortController | null = null;
  const subscriptions = new Map<string, () => void>();

  function subscribe(serverId: string): void {
    if (subscriptions.has(serverId)) return;
    const unsub = onPluginMessage(
      serverId,
      "__voice_reachability__",
      (msg: unknown) => {
        const ev = msg as { type?: string; topic?: string; payload?: unknown };
        if (ev.type !== "event" || ev.topic !== "voice-channels.voice.reachability.changed") {
          return;
        }
        const payload = ev.payload as { current?: unknown } | undefined;
        const snap = parseEnvelope(payload?.current);
        if (snap) setSnapshot(serverId, snap);
      },
      "__voice_reachability__",
    );
    subscriptions.set(serverId, unsub);
  }

  onCleanup(() => {
    if (inflight) inflight.abort();
    for (const u of subscriptions.values()) u();
    subscriptions.clear();
  });

  // Re-probe + subscribe on activeServer change.
  createEffect(() => {
    const server = activeServer();
    if (!server?.tunnel_url) return;
    if (inflight) inflight.abort();
    const ctrl = new AbortController();
    inflight = ctrl;
    void probeOnce(server.id, server.tunnel_url, ctrl.signal);
    subscribe(server.id);
  });

  // Re-probe on reconnect — runtime may have just restarted.
  onReconnect((reconnectedServerId) => {
    const server = activeServer();
    if (!server || server.id !== reconnectedServerId || !server.tunnel_url) return;
    if (inflight) inflight.abort();
    const ctrl = new AbortController();
    inflight = ctrl;
    void probeOnce(server.id, server.tunnel_url, ctrl.signal);
  });
}
