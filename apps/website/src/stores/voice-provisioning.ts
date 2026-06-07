// Voice-provisioning store — polls each server's `/health/voice` and pushes
// the result into voice-manager's per-server `provisioned` map. Voice plugin
// frontends read it from the `platform.voice.state` envelope and dim/lit
// their channels accordingly.
//
// Why a probe (instead of just trusting Central): Central never sees the
// runtime's env vars, so it can't tell us whether the owner has wired
// LIVEKIT_PUBLIC_URL. The runtime's `/health/voice` endpoint is the
// authoritative signal — it reports `status: "disabled"` whenever voice
// wasn't activated at boot.
//
// Wiring strategy mirrors browser-recent: probe on activeServer change,
// re-probe on WS reconnect (catches the case where the runtime restarted
// because the owner just finished setup).

import { createEffect, onCleanup } from "solid-js";

import { activeServer } from "./servers";
import { onReconnect } from "../lib/ws";
import { setProvisioned } from "@/lib/voice-manager";

interface VoiceHealthBody {
  status: "ready" | "starting" | "degraded" | "unhealthy" | "disabled";
}

async function probe(serverId: string, tunnelUrl: string, signal: AbortSignal): Promise<void> {
  let body: VoiceHealthBody;
  try {
    const res = await fetch(`${tunnelUrl}/health/voice`, { signal });
    // 503 still carries a JSON body (status: "unhealthy" / "degraded"). Read
    // before branching on res.ok so we don't lose the signal.
    body = (await res.json()) as VoiceHealthBody;
  } catch (err) {
    if (signal.aborted) return;
    // Network error or non-JSON — fail open (treat as provisioned). The
    // connect attempt itself will bounce off the runtime if voice is
    // actually disabled, surfacing the precise error there. Dimming the
    // sidebar on a transient probe failure would be worse UX.
    console.warn("[voice-provisioning] probe failed", { serverId, err });
    return;
  }
  if (signal.aborted) return;
  // Anything other than "disabled" means the runtime has voice wired —
  // even unhealthy/degraded; the owner has tried to provision and the user
  // should be allowed to attempt connection (they'll see the error inline).
  setProvisioned(serverId, body.status !== "disabled");
}

export function mountVoiceProvisioningStore(): void {
  let inflight: AbortController | null = null;

  onCleanup(() => {
    if (inflight) {
      inflight.abort();
      inflight = null;
    }
  });

  // Re-probe on activeServer change.
  createEffect(() => {
    const server = activeServer();
    if (!server?.tunnel_url) return;
    if (inflight) inflight.abort();
    const ctrl = new AbortController();
    inflight = ctrl;
    void probe(server.id, server.tunnel_url, ctrl.signal);
  });

  // Re-probe on WS reconnect — the runtime may have just restarted with a
  // freshly-provisioned LIVEKIT_PUBLIC_URL after the owner finished setup.
  onReconnect((reconnectedServerId) => {
    const server = activeServer();
    if (!server || server.id !== reconnectedServerId || !server.tunnel_url) return;
    if (inflight) inflight.abort();
    const ctrl = new AbortController();
    inflight = ctrl;
    void probe(server.id, server.tunnel_url, ctrl.signal);
  });
}
