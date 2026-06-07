// spec-24 Amendment A1 — `wanIp` is owner-only and must be stripped before
// any reachability state goes to non-owner clients via `broadcast.toAll`.
// Owners read the unredacted state from /admin/api/voice/state directly.
//
// Pure helper, extracted so the trust-boundary invariant is unit-testable
// without spinning up the plugin runtime.

export interface PortGroupResult {
  reachable: boolean;
  latencyMs: number | null;
  error: string | null;
}

export interface RedactedProbeResult {
  status: "ready" | "unreachable";
  checkedAt: string;
  wanIp: null;
  rtcTcp: PortGroupResult;
  rtcUdp: PortGroupResult;
}

export type RedactedReachability =
  | { status: "checking"; lastResult: RedactedProbeResult | null }
  | { status: "ready"; result: RedactedProbeResult }
  | { status: "unreachable"; result: RedactedProbeResult };

function isPortGroupResult(v: unknown): v is PortGroupResult {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o["reachable"] === "boolean" &&
    (typeof o["latencyMs"] === "number" || o["latencyMs"] === null) &&
    (typeof o["error"] === "string" || o["error"] === null)
  );
}

function stripWanIp(raw: unknown): RedactedProbeResult | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r["status"] !== "ready" && r["status"] !== "unreachable") return null;
  if (typeof r["checkedAt"] !== "string") return null;
  if (!isPortGroupResult(r["rtcTcp"]) || !isPortGroupResult(r["rtcUdp"])) return null;
  return {
    status: r["status"],
    checkedAt: r["checkedAt"],
    wanIp: null,
    rtcTcp: r["rtcTcp"],
    rtcUdp: r["rtcUdp"],
  };
}

export function redactReachability(state: unknown): RedactedReachability | null {
  if (!state || typeof state !== "object") return null;
  const s = state as Record<string, unknown>;
  const status = s["status"];
  if (status === "checking") {
    return { status, lastResult: stripWanIp(s["lastResult"]) };
  }
  if (status === "ready" || status === "unreachable") {
    const result = stripWanIp(s["result"]);
    if (!result) return null;
    return { status, result };
  }
  return null;
}
