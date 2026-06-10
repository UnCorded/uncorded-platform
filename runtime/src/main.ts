// Startup orchestrator — the boot() function that wires every subsystem
// together into a running server. Every module already exists; this file
// composes them following the 9-step startup sequence from §03.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { resolvePlugins } from "./resolver";
import type { ManifestReader, ResolvedPlugin } from "./resolver";
import { PLUGIN_API_VERSION } from "./api-version";
import { runMigrations } from "./migrations";
import type { FileListFn, FileReadFn } from "./migrations";
import { SubprocessManager } from "./subprocess";
import { CapabilityChecker } from "./capabilities/checker";
import { EventBus } from "./events/bus";
import type { PluginTransportProvider } from "./events/types";
import { MessageRouter, sendPluginRequest, type PresenceCallback } from "./ws/router";
import { msgpackCodec } from "./ws/codec";
import { PluginDbCache } from "./ipc/handlers";
import { createWsServer } from "./ws/server";
import type { WsServerHandle } from "./ws/server";
import type { TokenValidator } from "./ws/types";
import { createHttpHandler, sweepStaleUploadTmps } from "./http/handler";
import { createProxyWebSocket } from "./http/proxy-ws";
import {
  sweepStaleUploadSessions,
  SWEEP_INTERVAL_MS as UPLOAD_SWEEP_INTERVAL_MS,
} from "./http/upload-session";
import type { HttpHandlerHandle } from "./http/handler";
import type {
  PluginInfo,
  PluginRegistry,
  FileUploadNotification,
  InstalledPluginInfo,
} from "./http/types";
import { RolesEngine } from "./roles/engine";
import { PluginResourceStore, PluginResourceResolver } from "./plugin-resources";
import type { MembershipCheck } from "./plugin-resources";
import { seedCorePermissions } from "./core/permission-seeds";
import { createUpdateStateStore, type UpdateStateStore } from "./update-state/store";
import { createUpdateLogStore, type UpdateLogStore } from "./update-state/log";
import { createDrainController } from "./drain";
import {
  withShutdownDeadline,
  RUNTIME_SHUTDOWN_DEADLINE_MS,
  RUNTIME_SHUTDOWN_STEP_DEADLINE_MS,
} from "./shutdown";
import { CoreModule } from "./core";
import { assertExpectedTables } from "./db/assert-tables";
import { EXPECTED_TABLES } from "./db/expected-tables";
import { ScopedPresenceModule } from "./presence";
import { CORE_TOPICS, PRESENCE_TOPICS } from "@uncorded/protocol";
import { createHeartbeatClient } from "./heartbeat/client";
import type { CentralConnection, DeltaHandlers, PublicKeyEntry } from "./heartbeat/types";
import { JtiRevocationSet } from "./ws/revocation";
import { Watchdog } from "./watchdog";
import { RateLimiter } from "./http/rate-limiter";
import { rootLogger } from "@uncorded/shared";
import { getSupervisor } from "./managed-services/registry";
import { registerVoiceSupervisor } from "./voice/register";
import type { VoiceRegistrationDeps } from "./voice/register";
import type { LiveKitSupervisor } from "./voice/supervisor";
import { getLiveKitSecretRotatedAt, getOrCreateLiveKitCredentials } from "./voice/secrets";
import { DEFAULT_PORT_PLAN } from "./voice/config";
import { startVoiceCascade, type VoiceCascadeHandle } from "./voice/cascade";
import { createReachability, type ReachabilityHandle } from "./voice/reachability";
import { startCoView } from "./co-view";

const log = rootLogger.child({ component: "runtime" });
const heartbeatLog = log.child({ component: "heartbeat" });
const deltaLog = log.child({ component: "delta" });
const shutdownLog = log.child({ component: "shutdown" });

function errorContext(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return {
      err: err.message,
      errName: err.name,
    };
  }
  return { err: String(err) };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ServerJsonConfig {
  server_id: string;
  server_secret: string;
  central_url: string;
  name?: string | undefined;
  description?: string | undefined;
  visibility?: "public" | "private" | undefined;
  central_public_keys?: { id: string; public_key: JsonWebKey }[] | undefined;
  last_sync_version?: number | undefined;
  installed_plugins: string[];
  tunnel: {
    provider: string;
    mode: string;
    credentials_file?: string | undefined;
    fallback?: null | undefined;
  };
  settings: {
    permissive_mode: boolean;
    max_connections: number;
    /** Per-client-IP cap on concurrent WebSocket connections. Optional —
     *  omit (or set to 0) to leave uncapped. Sized so a small operator
     *  has multiple devices/tabs while a single hostile peer can't
     *  saturate the global `max_connections` quota by itself. */
    max_connections_per_ip?: number;
    allow_unsigned_plugins: boolean;
    /** Origin allowlist for authenticated HTTP endpoints (admin API, /workspace/*,
     *  plugin sidebar). Requests whose Origin matches one of these strings get an
     *  Access-Control-Allow-Origin response header echoing their Origin; others
     *  get no ACAO and are blocked by the browser's cross-origin policy. Omit or
     *  leave empty to forbid all cross-origin access. Wildcard (`*`) is not
     *  supported — it would defeat the purpose. */
    allowed_origins?: readonly string[];
  };
}

export interface TunnelProvider {
  start(config: {
    provider: string;
    mode: string;
    credentials_file?: string | undefined;
  }): Promise<string>;
  stop(): Promise<void>;
  getUrl(): string;
  /** Tunnel lifecycle for the heartbeat's tunnel_state field: "demo" |
   *  "named" | "local", flipping to "expired" once a demo tunnel is killed at
   *  its 24h TTL. undefined before start() resolves (early heartbeats then omit
   *  the field). Central persists this to gate the directory and drive the
   *  client temp-URL banner / expired-restart prompt. */
  getState(): string | undefined;
  healthCheck(): Promise<boolean>;
}

export interface BootDependencies {
  tunnelProvider: TunnelProvider;
  tokenValidator: TokenValidator;
  configPath?: string | undefined;
  corePluginsDir?: string | undefined;
  userPluginsDir?: string | undefined;
  dataDir?: string | undefined;
  runtimeVersion?: string | undefined;
  port?: number | undefined;
  readManifest?: ManifestReader | undefined;
  listFiles?: FileListFn | undefined;
  readFile?: FileReadFn | undefined;
  fetch?: typeof globalThis.fetch | undefined;
  /** Called whenever the heartbeat client receives fresh public keys from Central.
   *  Wire this to update the token validator's key cache in entrypoint.ts. */
  onPublicKeysUpdated?: ((keys: readonly PublicKeyEntry[]) => void) | undefined;
  /** Called after the heartbeat client confirms this server has been deleted
   *  from Central (N consecutive 404s). The runtime shuts down its own
   *  subsystems before invoking this; entrypoint wires it to process.exit so
   *  orphaned containers don't keep serving stale tokens on a shared tunnel. */
  onServerDeleted?: (() => void) | undefined;
  /** Called when the heartbeat client detects the cached public keys have
   *  gone stale (≥ 2× Central's 24h rotation window). Entrypoint should
   *  flip the container health check to unhealthy so the orchestrator
   *  stops routing auth'd traffic — the cache may contain keys Central
   *  has already rotated out. */
  onKeysStale?: ((ageMs: number) => void) | undefined;
  /** Voice (LiveKit) supervisor configuration. When omitted, the runtime
   *  refuses to load any plugin declaring `managed_services: ["livekit"]`.
   *  Production builds wire this in entrypoint.ts; tests opt out by leaving
   *  it undefined. The `db` field on the inner type is filled in by boot()
   *  using the runtime database — callers do not provide it. */
  voice?: Omit<VoiceRegistrationDeps, "db"> | undefined;
  /** Phase 01 §5.1 / §13 — drain grace window in seconds. Window starts
   *  when update-state transitions to "installing"; existing WS clients
   *  receive `runtime.server.draining` and have this long to disconnect
   *  cleanly before the runtime force-closes them with code 1012.
   *  Defaults to RUNTIME_DRAIN_GRACE_SECONDS env var, then 30. */
  drainGraceSeconds?: number | undefined;
  /** Hard upper bound (ms) on the entire graceful shutdown sequence. Guards
   *  against a teardown step hanging forever (wedged final heartbeat, stuck
   *  tunnel/sidecar stop) and never letting `shutdown()` resolve. Tests inject
   *  a small value; production maps RUNTIME_SHUTDOWN_DEADLINE_SECONDS env →
   *  this, falling back to RUNTIME_SHUTDOWN_DEADLINE_MS. */
  shutdownDeadlineMs?: number | undefined;
}

export interface BootResult {
  shutdown: () => Promise<void>;
  config: ServerJsonConfig;
  pluginCount: number;
  port: number;
  /** Force the heartbeat client to poll Central immediately. Single-flight,
   *  throttled. Wire into the token validator so an UNKNOWN_KEY miss can
   *  self-heal a stale JWKS cache without falsely closing the WS as
   *  "auth failed" (which the website maps to "you were banned"). */
  refreshPublicKeys: () => Promise<void>;
}

export class BootError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BootError";
  }
}

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

interface ConfigParseResult {
  ok: true;
  config: ServerJsonConfig;
}

interface ConfigParseError {
  ok: false;
  errors: string[];
}

export function parseServerConfig(
  raw: unknown,
): ConfigParseResult | ConfigParseError {
  const errors: string[] = [];

  if (typeof raw !== "object" || raw === null) {
    return { ok: false, errors: ["server.json must be a JSON object."] };
  }

  const obj = raw as Record<string, unknown>;

  if (typeof obj["server_id"] !== "string" || obj["server_id"] === "") {
    errors.push("server_id must be a non-empty string.");
  }
  if (typeof obj["server_secret"] !== "string" || obj["server_secret"] === "") {
    errors.push("server_secret must be a non-empty string.");
  } else if (obj["server_secret"] === "change-me") {
    // The first-boot seed in entrypoint.ts uses "change-me" as a placeholder
    // so config parse doesn't fail on an empty field. Refuse to boot if the
    // operator left it unchanged — a real secret must be generated and
    // written into /config/server.json before the runtime will start.
    errors.push("server_secret is set to the default placeholder — generate a real secret and update server.json.");
  }
  if (typeof obj["central_url"] !== "string" || obj["central_url"] === "") {
    errors.push("central_url must be a non-empty string.");
  }

  if (
    obj["central_public_keys"] !== undefined &&
    obj["central_public_keys"] !== null
  ) {
    if (!Array.isArray(obj["central_public_keys"])) {
      errors.push("central_public_keys must be an array.");
    }
  }

  if (
    obj["last_sync_version"] !== undefined &&
    obj["last_sync_version"] !== null
  ) {
    if (typeof obj["last_sync_version"] !== "number") {
      errors.push("last_sync_version must be a number.");
    }
  }

  if (!Array.isArray(obj["installed_plugins"])) {
    errors.push("installed_plugins must be an array.");
  }

  // Tunnel validation
  const tunnel = obj["tunnel"];
  if (typeof tunnel !== "object" || tunnel === null) {
    errors.push("tunnel must be an object.");
  } else {
    const t = tunnel as Record<string, unknown>;
    if (typeof t["provider"] !== "string" || t["provider"] === "") {
      errors.push("tunnel.provider must be a non-empty string.");
    }
    if (typeof t["mode"] !== "string" || t["mode"] === "") {
      errors.push("tunnel.mode must be a non-empty string.");
    }
  }

  // Settings validation
  const settings = obj["settings"];
  if (typeof settings !== "object" || settings === null) {
    errors.push("settings must be an object.");
  } else {
    const s = settings as Record<string, unknown>;
    if (typeof s["permissive_mode"] !== "boolean") {
      errors.push("settings.permissive_mode must be a boolean.");
    }
    if (typeof s["max_connections"] !== "number") {
      errors.push("settings.max_connections must be a number.");
    }
    if (s["max_connections_per_ip"] !== undefined) {
      const v = s["max_connections_per_ip"];
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || !Number.isInteger(v)) {
        errors.push("settings.max_connections_per_ip must be a non-negative integer when present.");
      }
    }
    if (typeof s["allow_unsigned_plugins"] !== "boolean") {
      errors.push("settings.allow_unsigned_plugins must be a boolean.");
    }
    if (s["allowed_origins"] !== undefined) {
      if (
        !Array.isArray(s["allowed_origins"]) ||
        !s["allowed_origins"].every((o): o is string => typeof o === "string" && o !== "*" && o.length > 0)
      ) {
        errors.push("settings.allowed_origins must be an array of non-empty origin strings (no wildcard).");
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, config: raw as ServerJsonConfig };
}

// ---------------------------------------------------------------------------
// In-memory plugin registry
// ---------------------------------------------------------------------------

class InMemoryPluginRegistry implements PluginRegistry {
  private plugins = new Map<string, PluginInfo>();

  register(info: PluginInfo): void {
    this.plugins.set(info.slug, info);
  }

  getPlugin(slug: string): PluginInfo | undefined {
    return this.plugins.get(slug);
  }

  getPluginCount(): number {
    return this.plugins.size;
  }

  listPlugins(): PluginInfo[] {
    return [...this.plugins.values()];
  }

  setReady(slug: string, ready: boolean): void {
    const existing = this.plugins.get(slug);
    if (existing === undefined) return;
    if (existing.ready === ready) return;
    this.plugins.set(slug, { ...existing, ready });
  }
}

function loadDisabledPlugins(db: Database): Set<string> {
  try {
    const rows = db
      .query<{ slug: string }, []>("SELECT slug FROM plugin_settings WHERE disabled = 1")
      .all();
    return new Set(rows.map((row) => row.slug));
  } catch {
    return new Set();
  }
}

// ---------------------------------------------------------------------------
// Plugin resolution across two directories
// ---------------------------------------------------------------------------

async function locatePlugins(
  slugs: string[],
  coreDir: string,
  userDir: string,
  readManifest: ManifestReader,
): Promise<Map<string, string>> {
  const slugToDir = new Map<string, string>();

  for (const slug of slugs) {
    // Try core-plugins directory first, then user plugins
    const corePath = `${coreDir}/${slug}/manifest.json`;
    try {
      await readManifest(corePath);
      slugToDir.set(slug, coreDir);
      continue;
    } catch {
      // Not in core, try user dir
    }

    const userPath = `${userDir}/${slug}/manifest.json`;
    try {
      await readManifest(userPath);
      slugToDir.set(slug, userDir);
    } catch {
      // Will be caught by resolvePlugins as MANIFEST_NOT_FOUND
      slugToDir.set(slug, userDir);
    }
  }

  return slugToDir;
}

// ---------------------------------------------------------------------------
// Default filesystem implementations
// ---------------------------------------------------------------------------

function defaultReadManifest(path: string): Promise<unknown> {
  const file = Bun.file(path);
  return file.json() as Promise<unknown>;
}

function defaultListFiles(dir: string): string[] {
  const { readdirSync } = require("node:fs") as typeof import("node:fs");
  try {
    return readdirSync(dir);
  } catch (err: unknown) {
    const errObj = err as Record<string, unknown> | null;
    if (errObj && errObj["code"] === "ENOENT") {
      const e = new Error(`Directory not found: ${dir}`);
      (e as unknown as Record<string, unknown>)["code"] = "ENOENT";
      throw e;
    }
    throw err;
  }
}

function defaultReadFile(path: string): string {
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  return readFileSync(path, "utf-8");
}

// ---------------------------------------------------------------------------
// Plugin-resource membership check
// ---------------------------------------------------------------------------

/**
 * Build the server-scoped, fail-closed `isMember` predicate the plugin-resource
 * resolver consumes for the `everyone` principal (RP-FOUND-3, plan §6.1). The
 * runtime hosts exactly one server, so a resource scoped to any *other*
 * serverId is unrepresentable here and must deny: the predicate returns false
 * for a mismatched scope, and false when the membership source reports the user
 * is not a member. Membership-unknown is never an allow.
 */
export function makePluginResourceMembershipCheck(
  isMemberOfServer: (userId: string) => boolean,
  ownServerId: string,
): MembershipCheck {
  return (serverId, userId) => serverId === ownServerId && isMemberOfServer(userId);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

export async function boot(deps: BootDependencies): Promise<BootResult> {
  const configPath = deps.configPath ?? "/config/server.json";
  const corePluginsDir = deps.corePluginsDir ?? "/app/core-plugins";
  const userPluginsDir = deps.userPluginsDir ?? "/plugins";
  const dataDir = deps.dataDir ?? "/data";
  // Production passes process.env.RUNTIME_VERSION (baked at build time per
  // docker/Dockerfile). Tests opt out by passing their own runtimeVersion.
  // The "0.0.0-dev" fallback should never reach production — it indicates
  // boot was constructed without an explicit version.
  const runtimeVersion = deps.runtimeVersion ?? "0.0.0-dev";
  const port = deps.port ?? 3000;
  // RUNTIME_DRAIN_GRACE_SECONDS is the operator-facing env knob (lifecycle
  // §13). Boot accepts a `drainGraceSeconds` dep for tests; production
  // wiring in entrypoint.ts maps env → dep, falling back to 30s here.
  const drainGraceSeconds = (() => {
    const fromDep = deps.drainGraceSeconds;
    if (typeof fromDep === "number" && Number.isFinite(fromDep) && fromDep >= 0) {
      return fromDep;
    }
    const fromEnv = Number(process.env["RUNTIME_DRAIN_GRACE_SECONDS"] ?? "");
    return Number.isFinite(fromEnv) && fromEnv >= 0 ? fromEnv : 30;
  })();
  // Hard bound on the whole graceful shutdown sequence (see ./shutdown.ts).
  // Dep wins (tests inject a small value); else RUNTIME_SHUTDOWN_DEADLINE_SECONDS
  // env (operator knob), else the conservative compiled default.
  const shutdownDeadlineMs = (() => {
    const fromDep = deps.shutdownDeadlineMs;
    if (typeof fromDep === "number" && Number.isFinite(fromDep) && fromDep > 0) {
      return fromDep;
    }
    const fromEnv = Number(process.env["RUNTIME_SHUTDOWN_DEADLINE_SECONDS"] ?? "");
    return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv * 1000 : RUNTIME_SHUTDOWN_DEADLINE_MS;
  })();
  const readManifest = deps.readManifest ?? defaultReadManifest;
  const listFiles = deps.listFiles ?? defaultListFiles;
  const readFile = deps.readFile ?? defaultReadFile;

  // -----------------------------------------------------------------------
  // Step 1: Load /config/server.json (fatal)
  // -----------------------------------------------------------------------

  let config: ServerJsonConfig;
  try {
    const text = await Bun.file(configPath).text();
    const raw: unknown = JSON.parse(text);
    const result = parseServerConfig(raw);
    if (!result.ok) {
      throw new BootError(
        "CONFIG_INVALID",
        `server.json validation failed: ${result.errors.join("; ")}`,
      );
    }
    config = result.config;
  } catch (err) {
    if (err instanceof BootError) throw err;
    throw new BootError(
      "CONFIG_INVALID",
      `Failed to load server.json at ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // -----------------------------------------------------------------------
  // Step 1.5: Initialize update-state store (Phase 01 §8, §12)
  //
  // Disk-backed, lives next to server.json. Loaded here (rather than at the
  // §2.2 step 7 broadcast point) so HttpDependencies can be wired with the
  // accessor and POST/GET routes work from the moment the server binds.
  // Listeners (WS broadcast, heartbeat fold-in) attach later in boot.
  // -----------------------------------------------------------------------

  const updateStateStore: UpdateStateStore = createUpdateStateStore({
    filePath: join(dirname(configPath), "update-state.json"),
    currentVersion: runtimeVersion,
  });

  // Update log — Phase 01 §11.4. Disk-backed ring buffer; entries are
  // auto-appended below by a subscriber on the update-state store, so the
  // runtime panel's "logs" link is always populated after the first
  // orchestrator action. Lives alongside the state file in /config so a
  // backup of the config dir captures both.
  const updateLogStore: UpdateLogStore = createUpdateLogStore({
    filePath: join(dirname(configPath), "update-log.jsonl"),
  });

  // Auto-record state transitions into the log. Subscribed once at boot;
  // every subsequent `set()` that changes the `state` field appends one entry.
  // Non-state-changing patches (e.g. progress-only updates inside the same
  // state) are intentionally skipped — those are noise for the operator-facing
  // log and would push older entries out of the ring buffer.
  let lastLoggedState = updateStateStore.get().state;
  updateStateStore.subscribe((next) => {
    if (next.state === lastLoggedState) return;
    lastLoggedState = next.state;
    const isError = next.state === "error" || next.state === "rolling-back";
    updateLogStore.append({
      level: isError ? "error" : "info",
      state: next.state,
      errorContext: next.errorContext,
      message: next.errorMessage ?? `transitioned to ${next.state}`,
    });
  });

  // -----------------------------------------------------------------------
  // Step 2: Open runtime database (fatal)
  // -----------------------------------------------------------------------

  const dbPath = join(dataDir, "core.db");
  let db: Database;
  try {
    db = new Database(dbPath);
  } catch (err) {
    throw new BootError(
      "DB_MIGRATION_FAILED",
      `Failed to open core.db at ${dbPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const rolesMigrationsDir = join(import.meta.dir, "roles", "migrations");
  const migrationResult = RolesEngine.initialize(
    db,
    rolesMigrationsDir,
    listFiles,
    readFile,
  );
  if (!migrationResult.ok) {
    db.close();
    throw new BootError(
      "DB_MIGRATION_FAILED",
      `Runtime schema migration failed: ${migrationResult.error.message}`,
    );
  }

  const rolesEngine = new RolesEngine(db);

  // -----------------------------------------------------------------------
  // Step 2.5: Seed core named-permissions (idempotent — INSERT OR IGNORE)
  //
  // Must run after RolesEngine.initialize (migrations) and before any plugin
  // registers permissions of its own, so the platform-built-in keys (e.g.
  // core.categories.manage) are present before the WS server starts
  // accepting requests that may gate on them.
  // -----------------------------------------------------------------------

  seedCorePermissions(db);

  // -----------------------------------------------------------------------
  // Step 2.6: Register managed-service supervisors
  //
  // Must run before resolvePlugins (step 5) so manifest validation accepts
  // plugins declaring `managed_services: ["livekit"]`. Registration
  // captures `db` in the factory closure but does not touch the
  // voice_config table — that table is created by the core migrations
  // applied below at CoreModule.initialize() (line ~712), which runs
  // before any plugin claim() in step 6.
  // -----------------------------------------------------------------------

  if (deps.voice) {
    registerVoiceSupervisor({ db, ...deps.voice });
  }

  const disabledPlugins = loadDisabledPlugins(db);

  // -----------------------------------------------------------------------
  // Step 3: Tunnel start is deferred to after HTTP+WS bind (search "Step 7.5")
  // -----------------------------------------------------------------------
  //
  // Why: cloudflared registers an edge connection within ~300ms of starting,
  // and the moment that registration lands the Cloudflare edge begins
  // routing requests to the tunnel's configured origin (127.0.0.1:3000).
  // If we start the tunnel here — before plugins spawn and HTTP binds —
  // every request that arrives during the boot window (typically 1-3s)
  // gets `dial tcp 127.0.0.1:3000: connect: connection refused`. End users
  // see a transient 5xx every desktop relaunch.
  //
  // The fix: bring up the tunnel as the LAST step, so the edge only starts
  // routing once the runtime can actually serve. tunnelUrl stays "" until
  // then; nothing in steps 4-7 reads it, only the "runtime ready" log line
  // in step 9.
  let tunnelUrl: string = "";

  // -----------------------------------------------------------------------
  // Step 4: Phone home to Central (conditionally fatal)
  // -----------------------------------------------------------------------

  // Mutable state for lazy getters — populated as subsystems come online
  let pluginCount = 0;
  let routerRef: MessageRouter | null = null;
  const deltaHandlers: DeltaHandlers = {};

  // Voice reachability state machine — created later (alongside the voice
  // cascade) so it can capture the live event bus. Heartbeat is wired up
  // first because we need it polling immediately, so the wan_ip callback
  // closures over `reachability` and replays the most recent observation
  // once the handle exists. spec-24 Amendment A.
  let reachability: ReachabilityHandle | undefined;
  let bootWanIp: string | null = null;

  const heartbeat = createHeartbeatClient({
    centralUrl: config.central_url,
    serverId: config.server_id,
    serverSecret: config.server_secret,
    runtimeVersion,
    logger: heartbeatLog,
    getTunnelUrl: () => deps.tunnelProvider.getUrl(),
    // Unique users, not raw sockets. A single user with multiple tabs must
    // count once; otherwise Central's heartbeat-reported `connected_users`
    // inflates every time the shell reconnects (which it does whenever an
    // iframe reloads, a token rotates, or a flaky network reroutes traffic).
    getConnectedUsers: () => routerRef?.getConnectedUsers().size ?? 0,
    getPluginCount: () => pluginCount,
    deltaHandlers,
    fetch: deps.fetch,
    cachedPublicKeys: config.central_public_keys,
    cachedSyncVersion: config.last_sync_version,
    getTunnelState: () => deps.tunnelProvider.getState(),
    // Phase 01 §11.5 — fold the latest update-state into every heartbeat so
    // Central can distinguish "server down" from "server installing" and
    // correlate runtime versions to release channels.
    getUpdateState: () => updateStateStore.get(),
    onFullSnapshot: () => {
      heartbeatLog.warn("full snapshot — disconnecting all users for re-auth");
      routerRef?.disconnectAllUsers(4001, "Server re-sync required");
    },
    onDirtySync: async (syncVersion, publicKeys) => {
      // Notify the token validator of fresh keys immediately (synchronous)
      deps.onPublicKeysUpdated?.(publicKeys);
      try {
        const text = await Bun.file(configPath).text();
        const current = JSON.parse(text) as Record<string, unknown>;
        current["last_sync_version"] = syncVersion;
        current["central_public_keys"] = [...publicKeys];
        await Bun.write(configPath, JSON.stringify(current, null, 2));
      } catch (err) {
        heartbeatLog.warn("failed to persist delta state to server.json", {
          err: err instanceof Error ? err.message : String(err),
        });
      }
    },
    onServerDeleted: () => {
      heartbeatLog.warn("server deleted in Central — initiating self-shutdown", {
        server_id: config.server_id,
      });
      // Fire-and-forget: run graceful shutdown, then hand off to entrypoint
      // via deps.onServerDeleted so it can exit the process.
      void (async () => {
        try {
          await shutdown();
        } catch (err) {
          heartbeatLog.warn("graceful shutdown during server-deleted cleanup failed", {
            err: err instanceof Error ? err.message : String(err),
          });
        }
        deps.onServerDeleted?.();
      })();
    },
    onWanIp: (wanIp) => {
      // Spec-24 Amendment A2: heartbeat surfaces Central's view of our
      // WAN IP. Cache it so that whenever the reachability handle gets
      // wired (after eventBus is constructed below), the boot trigger
      // can fire without waiting for the next heartbeat tick.
      bootWanIp = wanIp;
      reachability?.noteWanIp(wanIp);
    },
    onKeysStale: (ageMs) => {
      // Central key rotation is 24h; 2× window means we've been unable to
      // refresh for ≥ 48h. A key Central has already rotated out could still
      // be in our cache and we wouldn't know. This is a fail-closed signal:
      // log.error + container health check flips unhealthy so the platform
      // stops routing auth'd traffic to us.
      heartbeatLog.error("public-key cache is stale — Central unreachable too long", {
        ageMs,
        ageHours: Math.round(ageMs / 3_600_000),
        cachedKeyCount: heartbeat.getPublicKeys().length,
      });
      deps.onKeysStale?.(ageMs);
    },
  });

  const pollResult = await heartbeat.poll();

  // Notify validator of keys after initial poll (covers both dirty and cached-only paths)
  deps.onPublicKeysUpdated?.(heartbeat.getPublicKeys());

  if (pollResult.ok) {
    if (heartbeat.getPublicKeys().length === 0) {
      db.close();
      await deps.tunnelProvider.stop();
      throw new BootError(
        "NO_PUBLIC_KEYS",
        "Central returned OK but no public keys — cannot validate tokens.",
      );
    }
  } else {
    // Central unreachable
    if (heartbeat.getPublicKeys().length === 0) {
      db.close();
      await deps.tunnelProvider.stop();
      throw new BootError(
        "NO_PUBLIC_KEYS",
        `Central unreachable and no cached public keys — cannot validate tokens. Error: ${pollResult.error.message}`,
      );
    }
    log.warn("central unreachable — continuing with cached keys", {
      keyCount: heartbeat.getPublicKeys().length,
      err: pollResult.error.message,
    });
  }

  // -----------------------------------------------------------------------
  // Step 5: Resolve installed plugins (non-fatal)
  // -----------------------------------------------------------------------

  let resolvedPlugins: ResolvedPlugin[] = [];

  if (config.installed_plugins.length > 0) {
    const slugToDir = await locatePlugins(
      config.installed_plugins,
      corePluginsDir,
      userPluginsDir,
      readManifest,
    );

    // Wrapped reader that routes to the correct directory
    const wrappedReader: ManifestReader = async (manifestPath: string) => {
      // manifestPath is "{pluginsDir}/{slug}/manifest.json" where pluginsDir=""
      // Extract the slug from the path
      const parts = manifestPath.split("/");
      const slug = parts[parts.length - 2]!;
      const actualDir = slugToDir.get(slug) ?? userPluginsDir;
      const actualPath = `${actualDir}/${slug}/manifest.json`;
      return readManifest(actualPath);
    };

    let slugsToLoad = config.installed_plugins;
    let resolverResult = await resolvePlugins(
      "",
      slugsToLoad,
      wrappedReader,
      PLUGIN_API_VERSION,
    );

    // If resolution failed, strip the bad slugs and retry with whatever remains.
    // This prevents one broken/missing plugin from taking down all other plugins.
    if (!resolverResult.ok) {
      const badSlugs = new Set(resolverResult.errors.map((e) => e.plugin));
      for (const err of resolverResult.errors) {
        log.warn("plugin skipped — resolution error", { plugin: err.plugin, code: err.code, message: err.message });
      }
      slugsToLoad = slugsToLoad.filter((s) => !badSlugs.has(s));
      if (slugsToLoad.length > 0) {
        resolverResult = await resolvePlugins("", slugsToLoad, wrappedReader, PLUGIN_API_VERSION);
      } else {
        // Every plugin was rejected — boot zero-plugin instead of falling
        // through to the else-branch below and re-logging the same errors.
        resolverResult = { ok: true, plugins: [] };
      }
    }

    if (resolverResult.ok) {
      // Fix up paths from "/{slug}" to "{actualDir}/{slug}"
      resolvedPlugins = resolverResult.plugins.map((p) => ({
        ...p,
        path: `${slugToDir.get(p.slug) ?? userPluginsDir}/${p.slug}`,
      }));
    } else {
      for (const err of resolverResult.errors) {
        log.warn("plugin resolution warning", { plugin: err.plugin, message: err.message });
      }
    }
  }

  // -----------------------------------------------------------------------
  // Step 6: Load plugins in dependency order (isolated per-plugin)
  // -----------------------------------------------------------------------

  const subprocessManager = new SubprocessManager();
  const watchdog = new Watchdog(subprocessManager);

  const transportProvider: PluginTransportProvider = {
    getTransport(slug: string) {
      const proc = subprocessManager.getProcess(slug);
      return proc?.state === "ready" ? proc.transport : undefined;
    },
    isPluginAlive(slug: string) {
      const proc = subprocessManager.getProcess(slug);
      return proc?.state === "ready";
    },
  };

  const eventBus = new EventBus(transportProvider, {
    cascade(sourcePlugin, topic, payload) {
      // Runtime-level reactions to plugin events
      if (topic === "moderation.user.kicked") {
        const p = payload as Record<string, unknown>;
        const userId = typeof p["user_id"] === "string" ? p["user_id"] : null;
        if (userId) {
          const closed = routerRef?.disconnectUser(userId, 4003, "Kicked from server");
          log.info("moderation.user.kicked — force-disconnected sessions", {
            user_id: userId,
            sessions_closed: closed ?? 0,
          });
        }
      }

      const rules = db
        .query<{
          target_plugin: string;
          target_action: string;
        }, [string, string]>(
          `SELECT target_plugin, target_action
           FROM cascade_rules
           WHERE source_plugin = ?
             AND event_topic = ?
             AND enabled = 1`,
        )
        .all(sourcePlugin, topic);

      for (const rule of rules) {
        const targetProcess = subprocessManager.getProcess(rule.target_plugin);
        if (!targetProcess || targetProcess.state !== "ready") {
          log.warn("cascade target unavailable", {
            sourcePlugin,
            topic,
            targetPlugin: rule.target_plugin,
            targetAction: rule.target_action,
          });
          continue;
        }

        sendPluginRequest(
          targetProcess,
          rule.target_action,
          payload && typeof payload === "object"
            ? { ...(payload as Record<string, unknown>) }
            : { payload },
          {
            id: "__runtime__",
            displayName: "Runtime Cascade",
            avatarUrl: "",
            role: "system",
          },
        );
      }
    },
  });
  // Release event-bus subscriptions held by a plugin whenever it leaves a
  // usable state (graceful stop, crash-with-respawn, quarantine). Without
  // this, a respawned plugin's resubscribe call errors with ALREADY_SUBSCRIBED
  // and stale BoundedQueues retain heap.
  subprocessManager.onPluginUnload((slug) => {
    eventBus.removePlugin(slug);
  });

  // Core Module — initialized before any plugin loads.
  const coreModule = new CoreModule(db, eventBus, log);
  coreModule.initialize();

  // Plugin resource store (RP-FOUND-2) — core-owned resource registry + ACL
  // tables in core.db. Migrations run here, before the expected-table assertion
  // so the tables are present when the fail-fast check fires; the store +
  // resolver instances are constructed and handed to the router just below
  // (RP-FOUND-4 wiring).
  const pluginResourceMigrationsDir = join(import.meta.dir, "plugin-resources", "migrations");
  const pluginResourceMigrationResult = PluginResourceStore.initialize(
    db,
    pluginResourceMigrationsDir,
    listFiles,
    readFile,
  );
  if (!pluginResourceMigrationResult.ok) {
    db.close();
    throw new BootError(
      "DB_MIGRATION_FAILED",
      `Plugin resource store migration failed: ${pluginResourceMigrationResult.error.message}`,
    );
  }

  // Fail-fast: every expected table must exist after both roles + core
  // migrations have run. A half-migrated server will silently lose audit
  // and permission rows otherwise. Per spec-22 Amendment B.
  try {
    assertExpectedTables(db, EXPECTED_TABLES);
  } catch (err) {
    db.close();
    const missing = (err as { missing?: string[] }).missing;
    throw new BootError(
      "DB_MIGRATION_FAILED",
      `core.db is missing required tables: ${missing?.join(", ") ?? "unknown"}. Refusing to start.`,
    );
  }

  // Plugin resource backend (RP-FOUND-4 wiring). The migrations above created
  // the tables; build the runtime-authoritative store + ACL resolver now and
  // hand them to the router below, so `resources.*` IPC is served instead of
  // answering PLUGIN_RESOURCES_UNAVAILABLE. The resolver derives every
  // authorization-affecting fact from authoritative sources — roles from
  // RolesEngine, bans + server membership from CoreModule — never from the
  // caller (plan §7.2). Both ban and membership fail closed: unknown → deny,
  // and the membership check additionally rejects any foreign server scope.
  const pluginResourceStore = new PluginResourceStore(db);
  const pluginResourceResolver = new PluginResourceResolver({
    store: pluginResourceStore,
    roles: rolesEngine,
    isBanned: (userId) => coreModule.isBanned(userId),
    isMember: makePluginResourceMembershipCheck(
      (userId) => coreModule.isMember(userId),
      config.server_id,
    ),
  });

  const pluginRegistry = new InMemoryPluginRegistry();
  const installedPlugins = new Map<string, InstalledPluginInfo>();
  const onPresence: PresenceCallback = (event, user) => {
    // Build the IpcUser-shaped payload once — same shape plugins see in request handlers.
    const ipcUser = {
      id: user.id,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      role: user.role,
    };

    if (event === "runtime.user.connected") {
      const now = Date.now();
      coreModule.onUserConnected(user.id, user.username, user.displayName, user.avatarUrl);
      // Broadcast to WS clients so the frontend users store stays in sync.
      routerRef?.broadcastEvent(CORE_TOPICS.USER_ONLINE, {
        id: user.id,
        username: user.username,
        display_name: user.displayName,
        avatar_url: user.avatarUrl,
        is_online: true,
        connected_at: now,
        last_seen_at: now,
      });
      // Publish to plugin event bus so sdk.presence.onConnected() handlers fire.
      eventBus.publishRuntime(PRESENCE_TOPICS.USER_CONNECTED, { user: ipcUser });
      // Join history is now recorded by CoreModule.onUserConnected() above.
    } else if (event === "runtime.user.disconnected") {
      const now = Date.now();
      coreModule.onUserDisconnected(user.id);
      routerRef?.broadcastEvent(CORE_TOPICS.USER_OFFLINE, {
        id: user.id,
        is_online: false,
        last_seen_at: now,
      });
      // Publish to plugin event bus so sdk.presence.onDisconnected() handlers fire.
      // Full user object included — plugins tracking session time need to know who disconnected.
      eventBus.publishRuntime(PRESENCE_TOPICS.USER_DISCONNECTED, { user: ipcUser });
    }
  };

  // The WS server uses msgpackCodec for inbound frames (per §02 wire-format
  // decision); the router must encode outbound frames with the same codec.
  // Leaving this `undefined` (=> jsonCodec) sends ack/nak as text frames,
  // which the website's WS client tolerates via a JSON fallback but the CLI
  // (binary-only msgpack decode) silently drops, manifesting as
  // "Register timed out" despite the row landing in the DB.
  const router = new MessageRouter(
    subprocessManager,
    onPresence,
    msgpackCodec,
    eventBus,
    rolesEngine,
    pluginRegistry,
  );
  routerRef = router;
  router.setWatchdog(watchdog);
  router.setCoreModule(coreModule);
  // RP-FOUND-4 — serve the `resources.*` IPC family from the store + resolver
  // built above. `checkCapability` is supplied per-call by the router from the
  // calling plugin's CapabilityChecker; serverId is this runtime's own scope.
  router.setPluginResources({
    store: pluginResourceStore,
    resolver: pluginResourceResolver,
    serverId: config.server_id,
  });
  try {
    router.setCentralHost(new URL(config.central_url).hostname);
  } catch {
    // Malformed central_url — config validation would have caught this, but be defensive.
  }

  const pluginDbCache = new PluginDbCache(join(dataDir, "plugins"));
  router.setPluginDbCache(pluginDbCache);

  // Update-state → WS broadcast. Every persisted mutation (POST /admin/api/update-state
  // from the orchestrator) re-broadcasts to all connected clients (D4: visibility
  // is universal, the install action is gated on the client side by `core.runtime.update`).
  // Subscribed AFTER router construction so the first POST from a freshly-booted
  // orchestrator is visible to all clients without a re-fetch.
  updateStateStore.subscribe((next) => {
    router.broadcastEvent(CORE_TOPICS.RUNTIME_UPDATE_STATE_CHANGED, next);
  });

  // Phase 01 §5.1 — drain controller. Constructed below (after wsHandle and
  // shutdown() exist), but the HTTP `/ready` handler and WS `/ws` upgrade
  // path need to read its `isDraining()` flag, so they receive a closure
  // that resolves through this holder. Boot order is fixed:
  //   1. http/ws handlers wire `isDrainingRef.current?.isDraining()` closures
  //   2. wsHandle starts (still no drain controller; closure returns false)
  //   3. shutdown() is defined
  //   4. drainController is constructed, wiring `onDrainComplete = shutdown + exit(0)`
  // Once (4) lands, the closures resolve. Until then, drain is a no-op,
  // which is correct: nothing should be calling drain before boot completes.
  const drainControllerRef: { current: import("./drain").DrainController | null } = { current: null };
  const isDrainingClosure = (): boolean => drainControllerRef.current?.isDraining() ?? false;

  // Shared WS rate limiter — also used by the presence module (RATE_PRESENCE).
  // Constructed early so the presence module can reference it; the WS server
  // wiring further down in step 7 takes the same instance.
  const wsRateLimiter = new RateLimiter(undefined, log.child({ component: "rate-limiter" }));
  router.setRateLimiter(wsRateLimiter);

  // Scoped presence module — depends on eventBus + the shared wsRateLimiter.
  // The installedSlugs thunk reads the live registry so a plugin installed
  // mid-session is immediately recognized for cross-plugin scope rejection.
  const presenceModule = new ScopedPresenceModule(eventBus, wsRateLimiter, log, {
    installedSlugs: () => new Set(pluginRegistry.listPlugins().map((p) => p.slug)),
  });
  router.setPresenceModule(presenceModule);
  router.onConnectionRegistered((connectionId) => presenceModule.registerSession(connectionId));
  router.onConnectionRemoved((connectionId) => presenceModule.evictSession(connectionId));
  subprocessManager.onPluginUnload((slug) => presenceModule.evictPlugin(slug));

  // Voice IPC bridge (PR-4a): only wired when the runtime was booted with a
  // public LiveKit URL (voice provisioned). Plugins requesting `voice.tokens`
  // without this get VOICE_BRIDGE_UNAVAILABLE. Credential lookup runs per-call
  // so a rotateSecret() between mints is reflected without a router restart.
  // (Note: deps.voice is now always present so the manifest validator can
  // resolve `managed_services: ["livekit"]`. publicUrl is the real gate.)
  if (deps.voice?.publicUrl) {
    const signalingPort = deps.voice.ports?.signaling ?? DEFAULT_PORT_PLAN.signaling;
    router.setVoiceIpcDeps({
      serverId: config.server_id,
      livekitPublicUrl: deps.voice.publicUrl,
      getLiveKitCredentials: () => getOrCreateLiveKitCredentials(db),
      getUserDisplayName: (userId) =>
        coreModule.getUsers([userId])[0]?.display_name ?? null,
      getUserAvatarUrl: (userId) =>
        coreModule.getUsers([userId])[0]?.avatar_url ?? null,
      // PR-6 §13: room-service shared with the cascade subscriber so
      // `voice.moderation.removeParticipant` (admin "Stop their share")
      // hits the same loopback Twirp endpoint.
      roomServiceConfig: {
        baseUrl: `http://127.0.0.1:${signalingPort}`,
        getCredentials: () => getOrCreateLiveKitCredentials(db),
      },
    });
  }

  // Voice cascade subscriber — bridges core ban events to LiveKit
  // disconnects. Owns the participant tracker + pending-kick map; the
  // webhook handler reads from those via the same handle. Only wired
  // when voice is provisioned (publicUrl set); otherwise bans skip the
  // kick step (no rooms to kick from).
  let voiceCascade: VoiceCascadeHandle | undefined;
  if (deps.voice?.publicUrl) {
    const signalingPort = deps.voice.ports?.signaling ?? DEFAULT_PORT_PLAN.signaling;
    voiceCascade = startVoiceCascade({
      db,
      logger: log,
      coreModule,
      rolesEngine,
      serverId: config.server_id,
      roomService: {
        baseUrl: `http://127.0.0.1:${signalingPort}`,
        getCredentials: () => getOrCreateLiveKitCredentials(db),
      },
    });

    // Spec-24 Amendment A — voice reachability state machine.
    // Boot probe is gated on (voice wired) AND (first wan_ip from
    // heartbeat). We mark "voice ready" here because publicUrl is set,
    // then replay any wan_ip already observed during the initial
    // heartbeat so the boot trigger fires without a 30s wait.
    reachability = createReachability({
      db,
      centralUrl: config.central_url,
      serverId: config.server_id,
      serverSecret: config.server_secret,
      publishRuntimeEvent: (topic, payload) => {
        eventBus.publishRuntime(topic, payload);
      },
    });
    reachability.init();
    reachability.noteVoiceReady();
    if (bootWanIp !== null) {
      reachability.noteWanIp(bootWanIp);
    }
  }

  // Co-View Sessions — spec-27 / PR-CV1. Ephemeral in-memory registry; no
  // DB tables, no persistent state across runtime restart. Lifecycle frames
  // only at this PR; state/event/cursor/pen channels land in PR-CV2+.
  // sendToConnection / getConnectedUser go through the router so the WS
  // layer remains the single source of truth for connection identity.
  const coView = startCoView({
    db,
    logger: log,
    eventBus,
    coreModule,
    rolesEngine,
    presenceModule,
    serverId: config.server_id,
    sendToConnection: (connectionId, frame) => router.sendToConnection(connectionId, frame),
    getConnectedUser: (connectionId) => router.getConnectedUser(connectionId),
  });
  router.attachCoViewDispatcher(coView);

  // Per-plugin managed-service claims. Filled inside the loader loop and
  // consumed by the unload/respawn callbacks below to release/re-claim
  // sidecars (e.g. LiveKit) as plugin processes come and go.
  const pluginManagedServices = new Map<string, string[]>();

  // Release every claim a plugin holds whenever it leaves "ready" — graceful
  // stop, crash without restart, quarantine. The supervisor's ref count
  // decrements; the sidecar stops only when the last claimer releases.
  // onPluginUnload may fire multiple times for the same slug across its
  // lifetime; release() is idempotent for unknown claimers so re-firing is safe.
  subprocessManager.onPluginUnload((slug) => {
    const services = pluginManagedServices.get(slug);
    if (!services || services.length === 0) return;
    for (const svc of services) {
      const supervisor = getSupervisor(svc);
      if (!supervisor) continue;
      void supervisor.release({ pluginSlug: slug }).catch((err: unknown) => {
        log.warn("managed service release failed", {
          plugin: slug,
          service: svc,
          err: err instanceof Error ? err.message : String(err),
        });
      });
    }
  });

  // Re-claim after a successful respawn. A failed spawn won't fire this with
  // ok=true; we let the watchdog's next attempt cycle through. SERVICE_START_FAILED
  // here is a soft warning — the plugin is alive but the sidecar isn't, and
  // the next respawn will retry. SERVICE_QUARANTINED here is operator-visible:
  // the plugin will keep running but its voice features will fail until the
  // service is manually un-quarantined.
  subprocessManager.onRespawn((slug, result) => {
    if (!result.ok) return;
    const services = pluginManagedServices.get(slug);
    if (!services || services.length === 0) return;
    for (const svc of services) {
      const supervisor = getSupervisor(svc);
      if (!supervisor) continue;
      void supervisor.claim({ pluginSlug: slug }).then((claim) => {
        if (!claim.ok) {
          log.warn("managed service re-claim after respawn failed", {
            plugin: slug,
            service: svc,
            code: claim.error.code,
            err: claim.error.message,
          });
        }
      });
    }
  });

  for (const plugin of resolvedPlugins) {
    const { slug, path: pluginPath, manifest } = plugin;
    installedPlugins.set(slug, { slug, manifest });

    if (disabledPlugins.has(slug)) {
      log.info("plugin is disabled in persisted settings; skipping load", { plugin: slug });
      continue;
    }

    // Step 3 of plugin lifecycle: Run migrations
    const pluginDataDir = join(dataDir, "plugins", slug);
    const pluginDbPath = join(pluginDataDir, `${slug}.db`);
    const pluginMigrationsDir = join(pluginPath, "migrations");

    let pluginDb: Database;
    try {
      // Ensure the plugin's data directory exists before opening the DB.
      // SQLite will not create missing parent directories, and on a read-only
      // rootfs only /data is writable so this must land inside the mount.
      mkdirSync(pluginDataDir, { recursive: true, mode: 0o700 });
      pluginDb = new Database(pluginDbPath);
    } catch (err) {
      log.error("plugin db open failed", {
        plugin: slug,
        path: pluginDbPath,
        err: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    const pluginMigrationResult = runMigrations(
      slug,
      pluginDb,
      pluginMigrationsDir,
      listFiles,
      readFile,
    );
    if (!pluginMigrationResult.ok) {
      log.error("plugin migration failed", {
        plugin: slug,
        err: pluginMigrationResult.error.message,
      });
      pluginDb.close();
      continue;
    }

    // Step 4-5 of plugin lifecycle: Spawn subprocess (if backend exists)
    if (manifest.backend) {
      // Create capability checker early so it can be attached before the
      // ready handshake — prevents losing post-ready IPC messages.
      const checker = new CapabilityChecker(slug, manifest.permissions);

      const spawnResult = await subprocessManager.spawn(
        slug,
        pluginPath,
        manifest.backend.entry,
        dataDir,
        PLUGIN_API_VERSION,
        {
          onTransportCreated(transport) {
            router.attachPlugin(slug, transport, checker);
            // Two-stage handshake: only opt-in plugins can flip serve-ready
            // here. For non-opt-in plugins we ignore the frame entirely so a
            // misuse of `sdk.serveReady()` can't accidentally toggle a
            // registry entry that's already been registered as ready=true.
            if (manifest.serve_ready_handshake === true) {
              transport.onMessage((msg) => {
                if (msg["type"] !== "serve_ready") return;
                const existing = pluginRegistry.getPlugin(slug);
                if (existing === undefined || existing.ready === true) return;
                pluginRegistry.setReady(slug, true);
                router.broadcastEvent(CORE_TOPICS.RUNTIME_PLUGIN_READY, {
                  slug,
                  ready: true,
                });
              });
            }
          },
        },
      );

      if (!spawnResult.ok) {
        log.error("plugin spawn failed", {
          plugin: slug,
          err: spawnResult.error.message,
        });
        pluginDb.close();
        continue;
      }

      // Register with watchdog for health monitoring
      watchdog.track(slug);
    }

    // -----------------------------------------------------------------------
    // Step 6.5: Claim managed services declared in the manifest.
    //
    // Failure semantics (per 3a refinement):
    //   - SERVICE_QUARANTINED → abort the plugin load. The operator sees an
    //     error log; the plugin is not registered and any partial work
    //     (subprocess, prior managed-service claims) is unwound here.
    //   - SERVICE_START_FAILED → log a warning and continue. The plugin runs
    //     without the sidecar; the next subprocess respawn (handled by
    //     onRespawn above) re-attempts the claim.
    //   - getSupervisor returning undefined for a manifest-declared service
    //     should be unreachable (resolver gates on isRegisteredService at
    //     step 5). If we somehow get here, treat it as a fatal abort for
    //     this plugin so the bug surfaces loudly instead of silent voice loss.
    // -----------------------------------------------------------------------

    if (manifest.managed_services && manifest.managed_services.length > 0) {
      const acquired: string[] = [];
      let abortPlugin = false;

      for (const serviceSlug of manifest.managed_services) {
        const supervisor = getSupervisor(serviceSlug);
        if (!supervisor) {
          log.error("managed service registry returned undefined for validated slug", {
            plugin: slug,
            service: serviceSlug,
          });
          abortPlugin = true;
          break;
        }
        const claim = await supervisor.claim({ pluginSlug: slug });
        if (claim.ok) {
          acquired.push(serviceSlug);
          continue;
        }
        if (claim.error.code === "SERVICE_QUARANTINED") {
          log.error("plugin requires quarantined managed service — aborting load", {
            plugin: slug,
            service: serviceSlug,
            err: claim.error.message,
          });
          abortPlugin = true;
          break;
        }
        // SERVICE_START_FAILED or any other non-ok code → soft fail.
        log.warn("managed service claim failed; plugin will load without sidecar", {
          plugin: slug,
          service: serviceSlug,
          code: claim.error.code,
          err: claim.error.message,
        });
        // Record the claim anyway — the supervisor still tracks the
        // claimer (so the next external claim retries) and onRespawn will
        // re-attempt on subprocess respawn.
        acquired.push(serviceSlug);
      }

      if (abortPlugin) {
        // Unwind: release any claims we acquired before the failure.
        for (const svc of acquired) {
          const supervisor = getSupervisor(svc);
          if (!supervisor) continue;
          await supervisor.release({ pluginSlug: slug }).catch(() => {
            // Best-effort cleanup; don't mask the original abort reason.
          });
        }
        if (manifest.backend) {
          await subprocessManager.stop(slug);
          // watchdog.track ran above; without an untrack the watchdog will
          // ping a slug that's not in the registry and miss every ping,
          // eventually triggering a phantom unhealthy report.
          watchdog.untrack(slug);
        }
        // installedPlugins.set above is intentionally not reverted — the
        // plugin IS installed, we just refused to load it. /plugins continues
        // to surface it as installed-but-not-running, matching the existing
        // disabled/migration-failure paths.
        pluginDb.close();
        continue;
      }

      pluginManagedServices.set(slug, acquired);
    }

    // Register in plugin registry
    const frontendDir = manifest.frontend
      ? join(pluginPath, "frontend")
      : null;
    pluginRegistry.register({
      slug,
      manifest,
      dataDir: pluginDataDir,
      frontendDir,
      authenticatedAssets:
        (manifest as unknown as Record<string, unknown>)["authenticated_assets"] === true,
      // Two-stage handshake: opt-in plugins start as not-yet-serve-ready;
      // the IPC frame from sdk.serveReady() flips this to true (see
      // onTransportCreated above). Plugins that don't opt in keep current
      // behavior — registered as ready immediately.
      ready: manifest.serve_ready_handshake !== true,
    });

    pluginCount++;
  }

  // Start watchdog health monitoring
  watchdog.start();

  // Sweep stale single-shot `.tmp` uploads left over from a prior boot, plus
  // any expired chunked-upload sessions (spec-26 Amendment A). Best-effort:
  // log on failure but never abort startup — orphans cost disk, not correctness.
  try {
    const sweep = await sweepStaleUploadTmps(pluginRegistry);
    if (sweep.removed > 0) {
      log.info("removed stale upload tmps", { scanned: sweep.scanned, removed: sweep.removed });
    }
  } catch (err) {
    log.warn("upload tmp sweep failed", { err: err instanceof Error ? err.message : String(err) });
  }
  try {
    const sessionSweep = await sweepStaleUploadSessions(pluginRegistry);
    if (sessionSweep.removed > 0) {
      log.info("removed stale upload sessions", {
        scanned: sessionSweep.scanned,
        removed: sessionSweep.removed,
      });
    }
  } catch (err) {
    log.warn("upload session sweep failed", {
      err: err instanceof Error ? err.message : String(err),
    });
  }
  // Re-run the chunked-session sweep every UPLOAD_SWEEP_INTERVAL_MS so
  // long-running runtimes don't accumulate expired partials. .unref() keeps
  // it from blocking shutdown.
  const uploadSweepTimer = setInterval(() => {
    sweepStaleUploadSessions(pluginRegistry)
      .then((s) => {
        if (s.removed > 0) {
          log.info("removed stale upload sessions", { scanned: s.scanned, removed: s.removed });
        }
      })
      .catch((err: unknown) => {
        log.warn("upload session sweep failed", {
          err: err instanceof Error ? err.message : String(err),
        });
      });
  }, UPLOAD_SWEEP_INTERVAL_MS);
  uploadSweepTimer.unref();

  // -----------------------------------------------------------------------
  // Step 7: Start HTTP+WS server (single Bun.serve())
  // -----------------------------------------------------------------------

  const httpHandler: HttpHandlerHandle = createHttpHandler({
    logger: log.child({ component: "rate-limiter" }),
    deps: {
      tokenValidator: deps.tokenValidator,
      rolesEngine,
      coreModule,
      coreDb: db,
      pluginRegistry,
      getInstalledPlugins(): InstalledPluginInfo[] {
        return [...installedPlugins.values()];
      },
      getPluginRuntimeState(slug: string) {
        return subprocessManager.getProcess(slug)?.state;
      },
      getPluginLogs(slug: string, limit: number) {
        return subprocessManager.getLogs(slug, limit);
      },
      stopPlugin(slug: string) {
        return subprocessManager.stop(slug);
      },
      config: {
        isPrivate: config.visibility === "private",
        maxUploadBytes: 5 * 1024 * 1024 * 1024, // 5 GiB hard ceiling (spec-26 Amendment A; plugin settings impose stricter caps in-plugin)
        startedAt: Date.now(),
        serverName: config.name ?? "UnCorded Server",
        serverDescription: config.description ?? "",
      },
      notifyPlugin(slug: string, notification: FileUploadNotification) {
        const proc = subprocessManager.getProcess(slug);
        if (proc?.state === "ready") {
          proc.transport.send(notification as unknown as import("./ipc/transport").IpcMessage);
        }
      },
      getPluginProcess(slug: string) {
        return subprocessManager.getProcess(slug);
      },
      getPluginDb(slug: string) {
        return pluginDbCache.get(slug);
      },
      getClientIp(request: Request): string {
        // See runtime/src/ws/server.ts defaultGetClientIp for rationale:
        // first-hop XFF is client-spoofable; CF appends the real IP as the
        // last hop, so use CF-Connecting-IP then the final XFF entry.
        const cfIp = request.headers.get("cf-connecting-ip")?.trim();
        if (cfIp && cfIp.length > 0) return cfIp;

        const xff = request.headers.get("x-forwarded-for");
        if (xff) {
          const parts = xff.split(",").map((p) => p.trim()).filter((p) => p.length > 0);
          const last = parts[parts.length - 1];
          if (last) return last;
        }

        return "unknown";
      },
      broadcastEventToUser(userId: string, topic: string, payload: unknown) {
        router.broadcastEventToUser(userId, topic, payload);
      },
      broadcastEvent(topic: string, payload: unknown) {
        router.broadcastEvent(topic, payload);
      },
      areKeysStale: () => heartbeat.areKeysStale(),
      isDraining: isDrainingClosure,
      allowedOrigins: config.settings.allowed_origins ?? [],
      runtimeVersion,
      getUpdateState: () => updateStateStore.get(),
      setUpdateState: (patch) => updateStateStore.set(patch),
      getUpdateLog: () => updateLogStore.getAll(),
      // Voice routes (/health/voice + /admin/api/voice/*) reach the live
      // supervisor through the static registry. We register the supervisor
      // factory unconditionally (so the manifest validator accepts plugins
      // declaring `managed_services: ["livekit"]`), but only expose it to
      // HTTP routes when voice is actually provisioned (publicUrl set).
      // Without this gate, /health/voice would spawn LiveKit on a server
      // whose owner hasn't completed setup yet.
      getVoiceSupervisor: () =>
        deps.voice?.publicUrl
          ? (getSupervisor("livekit") as LiveKitSupervisor | undefined)
          : undefined,
      getVoiceSecretRotatedAt: () => getLiveKitSecretRotatedAt(db),
      // Webhook receiver depends on (a) voice having been provisioned (publicUrl
      // set) — otherwise apiSecret rotation isn't even possible — and (b) the
      // event bus being live. Both are true at this point in boot.
      getVoiceWebhookDeps: deps.voice?.publicUrl
        ? () => ({
            serverId: config.server_id,
            getLiveKitCredentials: () => getOrCreateLiveKitCredentials(db),
            logger: log.child({ component: "voice-webhook" }),
            publishRuntimeEvent: (topic, payload) => {
              eventBus.publishRuntime(topic, payload);
            },
            // Cascade hooks — feed the participant tracker on join/leave
            // and consult the pending-kick map on `participant_left` so
            // the published `runtime.voice.participant.left` carries the
            // canonical reason (server_kick / server_ban) instead of
            // falling through to "explicit". voiceCascade is constructed
            // alongside deps.voice above, so this branch is always set
            // when getVoiceWebhookDeps fires.
            ...(voiceCascade
              ? {
                  cascade: {
                    trackJoin: voiceCascade.trackJoin,
                    trackLeave: voiceCascade.trackLeave,
                    trackRoomDestroyed: voiceCascade.trackRoomDestroyed,
                    consumePendingKick: voiceCascade.consumePendingKick,
                  },
                }
              : {}),
            // Spec-24 Amendment A: feed the ICE-cluster trigger from
            // the same join/leave stream the cascade uses. Only wired
            // when reachability was constructed (voice publicUrl set).
            ...(reachability
              ? {
                  reachability: {
                    noteParticipantJoined:
                      reachability.noteParticipantJoined,
                    noteParticipantLeft: reachability.noteParticipantLeft,
                  },
                }
              : {}),
          })
        : undefined,
      getReachability: () => reachability,
      // Spec-24 Amendment C diagnostic: read live LiveKit credentials so
      // /admin/api/voice/probe-direct-token can mint a short-lived JWT for
      // the browser's direct-UDP-50000 path test. Resolved on every call
      // so a rotateSecret() is reflected without a restart. Undefined when
      // voice isn't provisioned.
      getLiveKitCredentials: deps.voice?.publicUrl
        ? () => getOrCreateLiveKitCredentials(db)
        : undefined,
      getVoicePublicUrl: () => deps.voice?.publicUrl,
      getServerId: () => config.server_id,
    },
  });

  const revocationSet = new JtiRevocationSet();
  // Prune the JTI revocation set on a timer so entries age out on quiet
  // servers that don't receive a steady stream of token.revoked deltas.
  // 10 minutes matches the max token lifetime — any entry older than that
  // is for a token that has already expired and can be safely forgotten.
  const REVOCATION_PRUNE_INTERVAL_MS = 10 * 60 * 1000;
  const revocationPruneTimer = setInterval(() => {
    revocationSet.prune();
  }, REVOCATION_PRUNE_INTERVAL_MS);

  // Periodically checkpoint plugin SQLite WAL files. A long-running plugin
  // that writes steadily but rarely reads can grow `<slug>.db-wal` without
  // bound — SQLite only auto-checkpoints opportunistically on reader passes.
  // 30 minutes is conservative enough to amortize the brief writer lock the
  // TRUNCATE checkpoint takes, frequent enough that the WAL stays bounded
  // through a multi-day uptime.
  const WAL_CHECKPOINT_INTERVAL_MS = 30 * 60 * 1000;
  const walCheckpointLog = log.child({ component: "plugin-db" });
  const walCheckpointTimer = setInterval(() => {
    const results = pluginDbCache.checkpointAll();
    for (const r of results) {
      if (!r.ok) {
        walCheckpointLog.warn("wal checkpoint failed", { plugin: r.slug, err: r.err });
      }
    }
  }, WAL_CHECKPOINT_INTERVAL_MS);

  // wsRateLimiter and router.setRateLimiter were initialized earlier alongside
  // the presence module so both subsystems share the same limiter instance.

  const wsHandle: WsServerHandle = createWsServer({
    port,
    tokenValidator: deps.tokenValidator,
    subprocessManager,
    httpFetch: httpHandler.fetch,
    router,
    revocationSet,
    rateLimiter: wsRateLimiter,
    banChecker: (userId) => coreModule.isBanned(userId),
    maxConnections: config.settings.max_connections,
    // Treat 0 / undefined as "no per-IP cap" so existing configs that omit
    // the field don't suddenly start rejecting legitimate connections.
    maxConnectionsPerIp:
      config.settings.max_connections_per_ip && config.settings.max_connections_per_ip > 0
        ? config.settings.max_connections_per_ip
        : undefined,
    isDraining: isDrainingClosure,
    getDrainRetryAfterSeconds: () => drainGraceSeconds,
    // Reverse-proxy WebSocket bridge (plan §Phase 3). Reuses the same mount
    // resolver/approval/upstream gates as the HTTP forwarder and shares the
    // HTTP handler's rate limiter so proxy WS connects and HTTP proxy hits draw
    // from one bucket family.
    proxyWebSocket: createProxyWebSocket({
      deps: {
        getInstalledPlugins: (): InstalledPluginInfo[] => [...installedPlugins.values()],
        coreDb: db,
        getPluginDb: (slug: string) => pluginDbCache.get(slug),
        getServerId: () => config.server_id,
      },
      rateLimiter: httpHandler.rateLimiter,
    }),
  });

  // -----------------------------------------------------------------------
  // Step 7.5: Bring up the tunnel — deferred from Step 3 (see comment there)
  // -----------------------------------------------------------------------
  //
  // HTTP+WS is now bound on `port`, plugins are spawned and ready, livekit
  // (if claimed) has its STUN-discovered external IP. Routing real traffic
  // through the tunnel from this point on will land on a fully-warmed origin.

  try {
    tunnelUrl = await deps.tunnelProvider.start(config.tunnel);
  } catch (err) {
    // Tunnel is the last fatal-on-failure step. Tear down what we already
    // brought up so we don't leak listeners / subprocesses / heartbeats
    // between failed boots — boot() callers only see the BootError.
    wsHandle.stop();
    httpHandler.dispose();
    await subprocessManager.stopAll();
    db.close();
    throw new BootError(
      "TUNNEL_FAILED",
      `Tunnel failed to start: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // -----------------------------------------------------------------------
  // Step 8: Start heartbeat loop + wire delta handlers
  // -----------------------------------------------------------------------

  deltaHandlers["user.banned"] = (delta) => {
    // Persist to local bans table so banChecker rejects reconnection attempts.
    coreModule.banUser("__central__", delta.user_id, delta.reason ?? "Banned via Central");
    const closed = router.disconnectUser(delta.user_id, 4003, "User banned");
    deltaLog.info("user.banned", { user_id: delta.user_id, closed });
    eventBus.publishRuntime("runtime.cascade.user.banned", { user_id: delta.user_id, reason: delta.reason });
  };

  deltaHandlers["user.unbanned"] = (delta) => {
    coreModule.unbanUser("__central__", delta.user_id);
    deltaLog.info("user.unbanned", { user_id: delta.user_id });
  };

  deltaHandlers["plugin.revoked"] = (delta) => {
    deltaLog.info("plugin.revoked", { plugin_slug: delta.plugin_slug, version: delta.version });
    void subprocessManager.stop(delta.plugin_slug);
  };

  deltaHandlers["token.revoked"] = (delta) => {
    revocationSet.add(delta.jti);
    revocationSet.prune();
    deltaLog.info("token.revoked", { jti: delta.jti, revocationSetSize: revocationSet.size });
  };

  deltaHandlers["ownership.transferred"] = (delta) => {
    deltaLog.info("ownership.transferred", { new_owner: delta.new_owner });
    // Kick any active sessions still claiming owner role for a prior user id.
    // Their JWT still says role=owner until it expires (~10 min); closing the
    // session forces a reconnect with a fresh token reflecting the new role.
    const closed = router.disconnectFormerOwner(delta.new_owner);
    if (closed > 0) {
      deltaLog.info("ownership.transferred: disconnected former-owner sessions", { closed });
    }
  };

  deltaHandlers["user.profile_changed"] = (delta) => {
    deltaLog.info("user.profile_changed", { user_id: delta.user_id, username: delta.username, display_name: delta.display_name });
    const username = typeof delta.username === "string" ? delta.username : "";
    const displayName = typeof delta.display_name === "string" ? delta.display_name : "";
    const avatarUrl = typeof delta.avatar_url === "string" ? delta.avatar_url : "";
    coreModule.onUserProfileChanged(delta.user_id, username, displayName, avatarUrl);
    // Broadcast updated profile to WS clients.
    router.broadcastEvent(CORE_TOPICS.USER_UPDATED, {
      id: delta.user_id,
      username,
      display_name: displayName,
      avatar_url: avatarUrl,
    });
    eventBus.publishRuntime("runtime.cascade.user.profile_changed", {
      user_id: delta.user_id,
      username: delta.username,
      display_name: delta.display_name,
      avatar_url: delta.avatar_url,
    });
  };

  // Note: user.deleted delta handler will be added when Central adds
  // account-deletion to the heartbeat delta protocol.

  heartbeat.start();

  // -----------------------------------------------------------------------
  // Step 9: Log ready
  // -----------------------------------------------------------------------

  log.info("runtime ready", { server_id: config.server_id, pluginCount, tunnelUrl });

  // -----------------------------------------------------------------------
  // Graceful shutdown
  // -----------------------------------------------------------------------

  let shutdownPromise: Promise<void> | null = null;

  async function shutdown(): Promise<void> {
    if (shutdownPromise) return shutdownPromise;

    const runGracefulShutdown = async (): Promise<void> => {
      shutdownLog.info("starting graceful shutdown", {
        server_id: config.server_id,
        deadlineMs: shutdownDeadlineMs,
      });

      const bestEffort = async (
        step: string,
        fn: () => void | Promise<void>,
      ): Promise<void> => {
        try {
          await fn();
        } catch (err) {
          shutdownLog.warn("best-effort shutdown step failed", {
            step,
            ...errorContext(err),
          });
        }
      };

      // Like bestEffort, but also time-bounds the step: a single wedged
      // external call (final heartbeat, tunnel/sidecar stop, a plugin that
      // ignores SIGKILL) is abandoned after RUNTIME_SHUTDOWN_STEP_DEADLINE_MS
      // so the remaining teardown still runs. The overall deadline below is
      // the ultimate backstop if anything slips past these.
      const boundedStep = async (
        step: string,
        fn: () => Promise<void>,
      ): Promise<void> => {
        await withShutdownDeadline({
          label: `shutdown step: ${step}`,
          deadlineMs: RUNTIME_SHUTDOWN_STEP_DEADLINE_MS,
          logger: shutdownLog,
          run: fn,
        });
      };

      // Prevent repeated signal callbacks from stacking during teardown.
      process.removeListener("SIGTERM", onSignal);
      process.removeListener("SIGINT", onSignal);

      await bestEffort("stop heartbeat", () => {
        heartbeat.stop();
      });

      await bestEffort("stop watchdog", () => {
        watchdog.stop();
      });

      await bestEffort("broadcast shutdown event", () => {
        router.broadcastEvent("runtime.server.shutting_down", { reason: "shutdown" });
      });

      await boundedStep("stop plugins", async () => {
        await subprocessManager.stopAll();
      });

      await boundedStep("shutdown managed services", async () => {
        // Iterate the slugs we actually claimed during boot — anything that
        // got registered but never claimed has no in-process state to tear down.
        const seen = new Set<string>();
        for (const services of pluginManagedServices.values()) {
          for (const svc of services) seen.add(svc);
        }
        for (const svc of seen) {
          const supervisor = getSupervisor(svc);
          if (supervisor) await supervisor.shutdown();
        }
      });

      await bestEffort("stop websocket server", () => {
        wsHandle.stop();
      });

      // Final heartbeat to Central (clean-shutdown signal) runs before
      // tearing down outbound network infrastructure. Heartbeat goes
      // direct to Central rather than through the tunnel today, so the
      // ordering is not strictly required — but stopping the tunnel
      // first would silently break this step the moment the transport
      // ever changes. Keep the "tell Central we're gone" step paired
      // with "we still have network".
      await boundedStep("final heartbeat", async () => {
        const result = await heartbeat.poll();
        if (!result.ok) {
          throw new Error(result.error.message);
        }
      });

      await boundedStep("stop tunnel", async () => {
        await deps.tunnelProvider.stop();
      });

      await bestEffort("dispose http handler", () => {
        httpHandler.dispose();
      });

      await bestEffort("dispose ws rate limiter", () => {
        wsRateLimiter.dispose();
      });

      await bestEffort("stop revocation prune timer", () => {
        clearInterval(revocationPruneTimer);
      });

      await bestEffort("stop wal checkpoint timer", () => {
        clearInterval(walCheckpointTimer);
      });

      // Final checkpoint so the next boot reads a small WAL instead of one
      // that has accrued over the session. Best-effort: any DB that errors
      // here doesn't block shutdown.
      await bestEffort("final plugin wal checkpoint", () => {
        const results = pluginDbCache.checkpointAll();
        for (const r of results) {
          if (!r.ok) {
            walCheckpointLog.warn("final wal checkpoint failed", { plugin: r.slug, err: r.err });
          }
        }
      });

      await bestEffort("dispose voice cascade", () => {
        voiceCascade?.dispose();
      });

      await bestEffort("shutdown voice reachability", () => {
        reachability?.shutdown();
      });

      await bestEffort("dispose co-view", () => {
        coView.dispose();
      });

      await bestEffort("close database", () => {
        db.close();
      });

      await bestEffort("dispose drain controller", () => {
        drainControllerRef.current?.dispose();
      });
    };

    // Overall backstop: never let teardown hang the process. The per-step
    // bounds above handle the common single-wedge case; this guarantees
    // shutdown() always resolves so the caller's process.exit is reached even
    // if something slips past them.
    shutdownPromise = withShutdownDeadline({
      label: "graceful shutdown",
      deadlineMs: shutdownDeadlineMs,
      logger: shutdownLog,
      run: runGracefulShutdown,
    }).then((outcome) => {
      if (outcome === "completed") {
        shutdownLog.info("shutdown complete", { server_id: config.server_id });
      }
      // On "deadline" withShutdownDeadline already logged a clear warning; the
      // caller will now exit the process, abandoning any wedged teardown step.
    });

    return shutdownPromise;
  }

  // Phase 01 §5.1 — wire the drain controller now that shutdown() exists.
  // Drain runs the WS-side phase (broadcast → grace → close-1012), then
  // hands off to shutdown() for plugin teardown + tunnel close + final
  // heartbeat, then exits 0. Per lifecycle §6, exit 0 with the runtime
  // having posted state="installing" tells the orchestrator to swap.
  drainControllerRef.current = createDrainController({
    updateStateStore,
    router,
    graceMs: drainGraceSeconds * 1000,
    onDrainComplete: async () => {
      await shutdown();
      process.exit(0);
    },
  });

  // Signal handlers
  const onSignal = async () => {
    await shutdown();
    process.exit(0);
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  return {
    shutdown,
    config,
    pluginCount,
    port: wsHandle.server.port ?? 0,
    refreshPublicKeys: heartbeat.forceRefresh,
  };
}
