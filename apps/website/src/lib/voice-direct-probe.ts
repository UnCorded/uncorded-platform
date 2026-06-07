// Spec-24 Amendment C client-side diagnostic. The runtime mints a 30s,
// data-only LiveKit join token (POST /admin/api/voice/probe-direct-token);
// this module connects to LiveKit with that token, lets ICE settle, reads
// the nominated candidate-pair from getStats(), classifies it, and
// disconnects — all without publishing or subscribing any media.
//
// Why we need this: Central's reachability probe (UDP 3478) only verifies
// that LiveKit's TURN responder answers cold STUN. It cannot verify that
// the *direct* UDP 50000 media path works because pion ICE drops cold STUN
// at the MUX socket (see runtime/src/voice/reachability.ts header). So
// "TCP 7881 + UDP 3478 reachable" tells the owner voice will work, but
// not whether each call ends up on the fast UDP path or fallback through
// the TURN/TCP/WS relay.
//
// Classification follows the standard WebRTC selected-candidate-pair logic:
//   - Find the candidate-pair with `nominated: true` (or `state: "succeeded"`
//     with `selected: true` in older Chromium).
//   - Look up its localCandidateId in the stats map → local candidate.
//   - candidateType + protocol determine the path:
//       host  + udp = LAN (won't happen across WAN)
//       srflx + udp = direct UDP through NAT (the 50000 fast path)
//       prflx + udp = peer-reflexive (rare; treat as direct)
//       relay + udp = TURN-relayed UDP (works, but adds latency)
//       any   + tcp = TCP fallback (works, but slower)
//
// "Direct UDP" is reported only for the (host|srflx|prflx) + udp combo on
// the LiveKit media port (typically 50000). Anything else is classified
// as relayed/fallback so the owner sees the actual path their callers
// will take.

import type { Room } from "livekit-client";

export type DirectProbeOutcome =
  | { kind: "direct"; protocol: "udp"; localPort: number; localAddress: string | null }
  | { kind: "relayed"; protocol: "udp" | "tcp"; reason: string }
  | { kind: "tcp"; localPort: number; localAddress: string | null }
  | { kind: "no-pair"; reason: string }
  | { kind: "error"; reason: string };

interface RawCandidate {
  type?: string; // "local-candidate" | "remote-candidate"
  candidateType?: string; // "host" | "srflx" | "prflx" | "relay"
  protocol?: string; // "udp" | "tcp"
  port?: number;
  ip?: string;
  address?: string;
}

interface RawCandidatePair {
  type?: string; // "candidate-pair"
  state?: string;
  nominated?: boolean;
  selected?: boolean;
  localCandidateId?: string;
}

/** Wait until ICE has converged or timeout fires. Returns the publisher PC's
 *  stats report for inspection. */
async function waitForIce(room: Room, timeoutMs: number): Promise<RTCStatsReport | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // PCTransport publisher is created during room.connect() once data channel
    // negotiation kicks off (we requested canPublishData=true on the token to
    // force this). Before that the field is undefined.
    const publisher = room.engine.pcManager?.publisher;
    if (publisher && publisher.getICEConnectionState() === "connected") {
      return publisher.getStats();
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  // Final attempt — return whatever stats are available so the caller can at
  // least see "no candidate pair" instead of a blanket timeout error.
  const publisher = room.engine.pcManager?.publisher;
  return publisher ? publisher.getStats() : null;
}

function classify(stats: RTCStatsReport): DirectProbeOutcome {
  // Build a map of stats by id so we can resolve localCandidateId references.
  const byId = new Map<string, unknown>();
  for (const [id, value] of stats) byId.set(id, value);

  let selectedPair: RawCandidatePair | null = null;
  for (const value of stats.values()) {
    const r = value as RawCandidatePair;
    if (r.type === "candidate-pair" && (r.nominated === true || r.selected === true)) {
      selectedPair = r;
      break;
    }
  }
  // Fall back to the first succeeded pair if none is explicitly nominated —
  // some browsers populate `state` but not `nominated` on data-only PCs.
  if (!selectedPair) {
    for (const value of stats.values()) {
      const r = value as RawCandidatePair;
      if (r.type === "candidate-pair" && r.state === "succeeded") {
        selectedPair = r;
        break;
      }
    }
  }
  if (!selectedPair?.localCandidateId) {
    return { kind: "no-pair", reason: "ICE did not settle on a candidate pair" };
  }
  const local = byId.get(selectedPair.localCandidateId) as RawCandidate | undefined;
  if (!local) {
    return { kind: "no-pair", reason: "selected pair references unknown local candidate" };
  }

  const protocol = local.protocol === "tcp" ? "tcp" : local.protocol === "udp" ? "udp" : null;
  const candidateType = local.candidateType ?? "";
  const localPort = typeof local.port === "number" ? local.port : 0;
  const localAddress = local.address ?? local.ip ?? null;

  if (protocol === "tcp") {
    return { kind: "tcp", localPort, localAddress };
  }
  if (protocol === "udp" && candidateType === "relay") {
    return { kind: "relayed", protocol: "udp", reason: "TURN-relayed UDP" };
  }
  if (protocol === "udp" && (candidateType === "host" || candidateType === "srflx" || candidateType === "prflx")) {
    return { kind: "direct", protocol: "udp", localPort, localAddress };
  }
  return {
    kind: "no-pair",
    reason: `unrecognized pair (protocol=${String(protocol)}, type=${candidateType})`,
  };
}

export interface DirectProbeInput {
  /** LiveKit wss:// URL to dial. */
  url: string;
  /** 30s diagnostic JWT minted by the runtime. */
  token: string;
  /** Hard cap on how long we wait for ICE to converge before classifying. */
  timeoutMs?: number;
}

/** Run a one-shot direct-path probe. Resolves with the classified outcome and
 *  always tears down the LiveKit room — even on error — so we don't leave a
 *  zombie connection on the SFU. */
export async function runDirectPathProbe(input: DirectProbeInput): Promise<DirectProbeOutcome> {
  const timeoutMs = input.timeoutMs ?? 5000;
  // Lazy-load livekit-client so the diagnostic chunk only ships when an owner
  // actually opens the probe modal — same pattern as voice-manager.ts.
  let mod: typeof import("livekit-client");
  try {
    mod = await import("livekit-client");
  } catch (err) {
    return {
      kind: "error",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
  const room = new mod.Room({
    // Diagnostic-only — no auto-subscribe, no adaptive stream. We just want
    // ICE to converge so we can read the candidate-pair.
    adaptiveStream: false,
    dynacast: false,
  });
  try {
    await room.connect(input.url, input.token, {
      // 5s LK connect ceiling — separate from our ICE-wait deadline. If the
      // signaling WS can't reach LiveKit at all, fail fast.
      maxRetries: 0,
    });
    const stats = await waitForIce(room, timeoutMs);
    if (!stats) {
      return { kind: "no-pair", reason: "publisher peer connection was never created" };
    }
    return classify(stats);
  } catch (err) {
    return {
      kind: "error",
      reason: err instanceof Error ? err.message : String(err),
    };
  } finally {
    try {
      await room.disconnect(true);
    } catch {
      // Disconnect failures don't affect the probe result — LiveKit will
      // close the WS on its end when our token expires (30s).
    }
  }
}
