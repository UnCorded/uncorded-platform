// HTTP layer types — interfaces for the runtime's HTTP surface.
// These are runtime-internal; the startup orchestrator composes this
// layer with the WebSocket layer into a single Bun.serve() call.

import type { PluginManifest } from "@uncorded/shared";
import type { AuthenticatedUser, TokenValidator } from "../ws/types";
import type { RolesEngine } from "../roles/engine";
import type { CoreModule } from "../core";
import type { Database } from "bun:sqlite";
import type { PluginProcess, PluginState } from "../subprocess";
import type { LiveKitSupervisor } from "../voice/supervisor";
import type { VoiceWebhookDeps } from "../voice/webhook";
import type { ReachabilityHandle } from "../voice/reachability";
import type { RuntimeUpdateState } from "../update-state/types";
import type { UpdateLogEntry } from "../update-state/log";

// ---------------------------------------------------------------------------
// Plugin registry (abstraction over the not-yet-built plugin loader)
// ---------------------------------------------------------------------------

export interface PluginInfo {
  slug: string;
  manifest: PluginManifest;
  /** Absolute path to the plugin's writable data directory (/data/plugins/<slug>/) */
  dataDir: string;
  /** Absolute path to the plugin's frontend directory, null if no frontend */
  frontendDir: string | null;
  /** Plugin opts into requiring auth for its static assets */
  authenticatedAssets: boolean;
  /**
   * Two-stage handshake state. True once the plugin is ready to serve
   * user-facing requests. Plugins without `serve_ready_handshake: true`
   * in their manifest start as ready=true (current behavior). Plugins
   * that opt in start as ready=false and flip to true on receipt of
   * `{ type: "serve_ready" }` over IPC.
   */
  ready: boolean;
}

export interface PluginRegistry {
  getPlugin(slug: string): PluginInfo | undefined;
  getPluginCount(): number;
  listPlugins(): PluginInfo[];
  /** Flip a plugin's serve-ready flag. Safe no-op for unknown slugs. */
  setReady(slug: string, ready: boolean): void;
}

export interface InstalledPluginInfo {
  slug: string;
  manifest: PluginManifest;
}

export interface PluginLogEntry {
  ts: number;
  stream: "stdout" | "stderr";
  line: string;
}

// ---------------------------------------------------------------------------
// Server configuration
// ---------------------------------------------------------------------------

export interface ServerConfig {
  /** Whether this is a private server (affects manifest auth requirements) */
  isPrivate: boolean;
  /** Maximum upload file size in bytes */
  maxUploadBytes: number;
  /** Server start time (epoch ms, for uptime calculation) */
  startedAt: number;
  /** Human-readable server name from server.json */
  serverName: string;
  /** Optional server description from server.json */
  serverDescription: string;
}

// ---------------------------------------------------------------------------
// File upload notification (sent to plugin via IPC)
// ---------------------------------------------------------------------------

export interface FileUploadNotification {
  type: "file.uploaded";
  filename: string;
  path: string;
  size: number;
  mimeType: string;
  uploadedBy: string;
  uploadedAt: number;
}

// ---------------------------------------------------------------------------
// HTTP handler dependencies (injected at construction)
// ---------------------------------------------------------------------------

export interface HttpDependencies {
  tokenValidator: TokenValidator;
  rolesEngine: RolesEngine;
  coreModule: CoreModule;
  coreDb: Database;
  pluginRegistry: PluginRegistry;
  getInstalledPlugins(): InstalledPluginInfo[];
  getPluginRuntimeState(slug: string): PluginState | undefined;
  getPluginLogs(slug: string, limit: number): PluginLogEntry[];
  stopPlugin(slug: string): Promise<void>;
  config: ServerConfig;
  /** Notify a plugin about a file upload via IPC */
  notifyPlugin(slug: string, notification: FileUploadNotification): void;
  /** Get a plugin's running process for IPC round-trips */
  getPluginProcess(slug: string): PluginProcess | undefined;
  /** Open (or get cached) writable handle to a plugin's SQLite DB. Used by the
   *  admin `/plugins/:slug/config` endpoints to read/write the `_config` table
   *  directly — the running plugin (if any) sees the change via a separate
   *  `core.plugin.config_changed` IPC frame. */
  getPluginDb(slug: string): Database;
  /** Extract client IP from request (orchestrator provides this) */
  getClientIp(request: Request): string;
  /** Broadcast a WS event to all connections owned by a specific user */
  broadcastEventToUser(userId: string, topic: string, payload: unknown): void;
  /** Broadcast a WS event to every connected client. Used for state that
   *  every viewer needs to react to, e.g. `runtime.icon.changed` so any
   *  user already in the server re-fetches the icon when the owner uploads. */
  broadcastEvent(topic: string, payload: unknown): void;
  /** True when the public-key cache has exceeded 2× Central's rotation
   *  window. Used by /health to fail closed — orchestrators interpreting
   *  the health check should stop routing auth'd traffic. */
  areKeysStale(): boolean;
  /** Phase 01 §5.1 step 1 — true once the drain controller has flipped
   *  into draining state. `/ready` returns 503 with `reason: "draining"`
   *  for the duration so the orchestrator's post-swap health check
   *  doesn't mistake a draining old-version container for a healthy one.
   *  Optional — when undefined, drain isn't wired (e.g. tests, boot
   *  before the drain controller is constructed). */
  isDraining?: (() => boolean) | undefined;
  /** Origins permitted to make authenticated cross-origin requests (admin API,
   *  /workspace/*, plugin sidebar). Checked against the request's Origin header;
   *  only exact matches receive an Access-Control-Allow-Origin response header.
   *  Empty array = no cross-origin access (same-origin only). */
  allowedOrigins: readonly string[];
  /** Runtime version baked into the image at build time
   *  (process.env.RUNTIME_VERSION). Surfaced by /health and the update-state
   *  broadcast so orchestrators and clients can tell which build is running.
   *  "0.0.0-dev" indicates a local build without a tagged release. */
  runtimeVersion: string;
  /** Returns the registered LiveKit supervisor instance, or undefined when
   *  voice was not wired at boot (operator hasn't activated voice). The
   *  /health/voice and /admin/api/voice/* routes degrade to a "disabled"
   *  response in the undefined case rather than 500. */
  getVoiceSupervisor?: (() => LiveKitSupervisor | undefined) | undefined;
  /** Wall-clock timestamp of the most recent LiveKit credential write,
   *  or null if no credentials have been persisted yet. Surfaced by
   *  /admin/api/voice/state. */
  getVoiceSecretRotatedAt?: (() => number | null) | undefined;
  /** Resolved bag of webhook dependencies (server id, credential getter,
   *  runtime event publisher). When undefined the `/runtime/voice/webhook`
   *  route returns 503 — voice was not wired at boot. */
  getVoiceWebhookDeps?: (() => VoiceWebhookDeps | undefined) | undefined;
  /** Voice reachability handle (spec-24 Amendment A). Returns undefined
   *  when voice was not wired at boot — `/health/voice.externalReachability`
   *  is set to null and `POST /admin/api/voice/probe` returns 409. */
  getReachability?: (() => ReachabilityHandle | undefined) | undefined;
  /** Read live LiveKit credentials. Resolves on every call so a
   *  rotateSecret() is reflected without a restart. Used by
   *  `POST /admin/api/voice/probe-direct-token` to mint a short-lived
   *  diagnostic JWT the browser can hand to LiveKit for the
   *  Amendment-C-recommended direct-UDP-50000 path test. Undefined when
   *  voice was not wired at boot. */
  getLiveKitCredentials?: (() => Promise<{ apiKey: string; apiSecret: string }>) | undefined;
  /** Public LiveKit URL (`wss://voice.example.com`) — the same string the
   *  browser will pass to `livekit-client.connect()`. Undefined when voice
   *  isn't provisioned (no Cloudflare hostname configured); the
   *  direct-path probe route returns 409 in that case. */
  getVoicePublicUrl?: (() => string | undefined) | undefined;
  /** Stable runtime/server id — embedded as the LiveKit `video.room` claim
   *  prefix when minting probe tokens (`server:<id>:voice:__diag_direct_probe__`).
   *  Without it the probe room would collide across servers in a shared LiveKit
   *  install (we only run one runtime per LiveKit, but defense in depth). */
  getServerId?: (() => string) | undefined;
  /** Snapshot of the current orchestrator-driven update lifecycle state
   *  (Phase 01 §8, §12). Read-only handle; mutations flow exclusively through
   *  the WS / admin API path that owns persistence + broadcast. Surfaced by
   *  `GET /admin/api/update-state` for any authenticated user (D4: visibility
   *  is universal — only the install action is gated by `core.runtime.update`). */
  getUpdateState: () => RuntimeUpdateState;
  /** Apply an orchestrator-driven patch to the update-state store. Persists
   *  to disk, stamps `updatedAt`, and fires subscribers (one of which is the
   *  WS broadcaster wired in main.ts). Returns the post-merge state. Called
   *  exclusively from `POST /admin/api/update-state`, which itself is gated by
   *  the `core.runtime.update` permission (D5). */
  setUpdateState: (patch: Partial<RuntimeUpdateState>) => RuntimeUpdateState;
  /** Snapshot of the structured update log (Phase 01 §11.4). Auto-populated by
   *  a listener on the update-state store wired in main.ts: every state change
   *  appends an entry. Surfaced by `GET /admin/api/update-log` to the runtime
   *  panel's "logs" link from error states. Gated by `core.runtime.update`. */
  getUpdateLog: () => readonly UpdateLogEntry[];
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

export interface RateLimitConfig {
  /** Maximum tokens in the bucket */
  tokens: number;
  /** Window size in milliseconds */
  windowMs: number;
}

// ---------------------------------------------------------------------------
// Auth result (used internally by route handlers)
// ---------------------------------------------------------------------------

export type AuthResult =
  | { ok: true; user: AuthenticatedUser }
  | { ok: false; response: Response };
