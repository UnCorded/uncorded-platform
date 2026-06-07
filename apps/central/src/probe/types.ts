// Voice external-reachability probe types — see spec-24 Amendment A1.
//
// `VoiceProbeResult` is the Central → runtime contract: one snapshot, never
// "checking". The runtime wraps this in its own `VoiceReachabilityState`
// union (with a transient `checking` phase) before exposing it to plugins
// and the UI; that wrapper lives in the runtime, not here.

export interface PortGroupResult {
  /** True iff the probe completed its handshake (TCP) or saw a valid STUN binding response (UDP). */
  reachable: boolean;
  /** Round-trip duration of the successful probe, or null on failure. */
  latencyMs: number | null;
  /**
   * Human-readable failure code (e.g. "ETIMEDOUT", "ECONNREFUSED",
   * "STUN_TIMEOUT", "STUN_INVALID"). null on success. The public
   * /health/voice surface redacts these to the code only; the
   * owner-only /admin/api/voice/state retains the full string.
   */
  error: string | null;
}

export interface VoiceProbeResult {
  /**
   * Schema version of this result envelope. Current writers emit 1.
   * Bumped any time the field set, types, or interpretation of any field
   * changes — admin-UI / runtime readers branch on this so a v2 row never
   * gets rendered with v1 assumptions.
   */
  version: 1;
  /**
   * "ready" iff at least one of {rtcTcp, rtcUdp} is reachable. LiveKit ICE
   * picks the working path, so the owner does not need both. "unreachable"
   * means both probes failed.
   */
  status: "ready" | "unreachable";
  /** ISO8601 timestamp when the probe completed. */
  checkedAt: string;
  /** The IP Central probed — copied from the server's last cf-connecting-ip. */
  wanIp: string;
  rtcTcp: PortGroupResult;
  rtcUdp: PortGroupResult;
}
