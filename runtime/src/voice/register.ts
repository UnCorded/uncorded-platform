// Bind the LiveKit supervisor factory into the static service registry so
// the manifest validator accepts plugins declaring `managed_services:
// ["livekit"]` and the plugin loader can claim against it.
//
// Call exactly once at boot, before manifest validation runs (step 5 in
// main.ts). The factory captures `db` and the path/binary configuration
// in its closure; the supervisor instance itself is created lazily on
// the first `getSupervisor("livekit")` call. Until then no
// filesystem or database I/O happens — registering does not require
// migration 010 to have been applied yet.

import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { registerSupervisor } from "../managed-services/registry";
import { LiveKitSupervisor, type ReadinessProbe, type Spawner } from "./supervisor";
import type { VoicePortPlan } from "./config";

export interface VoiceRegistrationDeps {
  db: Database;
  /** Absolute path to the bundled `livekit-server` binary. */
  livekitBinPath: string;
  /** Directory the runtime owns for voice state. The supervisor writes
   *  `${configDir}/livekit.yaml` (mode 0600). Caller must ensure the
   *  directory exists with appropriate permissions. */
  configDir: string;
  /** Reported in `health()` for operator visibility. Does not affect
   *  spawning behavior. */
  livekitVersion?: string;
  /** Public LiveKit signaling URL — embedded in `createJoinToken` responses
   *  so clients can connect directly to the SFU. Not consumed by the
   *  supervisor itself; main.ts forwards it to the voice IPC bridge. */
  publicUrl?: string;
  /** Override the default port plan. Useful for multi-tenant hosts. */
  ports?: VoicePortPlan;
  /** Host's primary RFC1918 LAN IPv4. Forwarded into the supervisor so
   *  livekit.yaml gets `node_ip: <ip>` and on-LAN peers reach the SFU
   *  directly without router-side hairpin NAT. Absent → STUN-only. */
  internalIp?: string;
  /** Test injection: substitute Bun.spawn with a mock subprocess factory.
   *  Production callers MUST NOT set this. */
  spawner?: Spawner;
  /** Test injection: substitute the HTTP readiness probe with a mock.
   *  Production callers MUST NOT set this. */
  readinessProbe?: ReadinessProbe;
  /** Test injection: shorten the readiness-probe timeout. Defaults to the
   *  supervisor's 30s. Production callers MUST NOT set this. */
  startupTimeoutMs?: number;
}

/**
 * Register the LiveKit supervisor under the canonical slug `livekit`
 * (per spec-24: managed_services slugs are flat product names; the
 * `voice.*` namespace is reserved for runtime_capabilities). Idempotency
 * is the registry's responsibility — calling this twice in the same
 * process throws (the registry is intentionally static; if you need to
 * swap factories, restart the process or call `__resetRegistryForTests`
 * from a test setup).
 */
export function registerVoiceSupervisor(deps: VoiceRegistrationDeps): void {
  const configPath = join(deps.configDir, "livekit.yaml");
  registerSupervisor("livekit", (slug) =>
    new LiveKitSupervisor(slug, {
      db: deps.db,
      livekitBinPath: deps.livekitBinPath,
      configPath,
      ...(deps.ports !== undefined ? { ports: deps.ports } : {}),
      ...(deps.livekitVersion !== undefined ? { livekitVersion: deps.livekitVersion } : {}),
      ...(deps.internalIp !== undefined ? { internalIp: deps.internalIp } : {}),
      ...(deps.spawner !== undefined ? { spawner: deps.spawner } : {}),
      ...(deps.readinessProbe !== undefined ? { readinessProbe: deps.readinessProbe } : {}),
      ...(deps.startupTimeoutMs !== undefined ? { startupTimeoutMs: deps.startupTimeoutMs } : {}),
    }),
  );
}
