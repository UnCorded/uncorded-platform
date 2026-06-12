import { mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

import * as central from "./central";
import type { CosignSignatureMaterial } from "./cosign-verify";
import * as docker from "./docker";
import { encryptionSecretKey, setSecret, tunnelSecretKey } from "./desktop-secrets";
import {
  FirstBootPullError,
  pullVerifyAndTagForFirstBoot,
  setChannelByEndpoint,
} from "./runtime-orchestrator";
import { clampProgress, extractPullPercent, type RuntimeUpdateChannel } from "./runtime-update";
import { runServerContainer, SERVER_IMAGE } from "./server-runtime";

// Keep this in sync with Dockerfile's COPY plugins/ lines. Adding a slug here
// without shipping the plugin in the image will cause the runtime's plugin
// resolver to bail on boot (fail-closed per engineering principles).
const CORE_PLUGIN_SLUGS = ["text-channels", "voice-channels"] as const;
const HEALTH_TIMEOUT_MS = 60_000;
const HEARTBEAT_TIMEOUT_MS = 60_000;
// After the first heartbeat lands the runtime may still be advertising the
// LOCAL_FALLBACK_URL (`http://localhost:3000`) in `currentTunnelUrl` because
// `cloudflared` hasn't resolved its outbound URL yet. We block the wizard
// handoff until a *public* URL arrives so the web client mounts against the
// final URL once — no later flip that triggers WS+sidebar+icon refetch
// storms (Phase 2 production-polish: `dead UX → users walk away`).
// 120s covers cloudflared cold-start + DNS propagation under typical
// home-network conditions; bursts past that fall through to the soft-warn
// stalled-state UI in the wizard.
const PUBLIC_URL_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 1_500;
// Public-tunnel probe budget — spec-10 Amendment A step 8.5. Outbound heartbeats
// don't exercise Cloudflare's edge ingress, so we probe the public URL from the
// user-network vantage before handing the wizard off. Soft warning on failure;
// the server is preserved and may still propagate.
const PUBLIC_TUNNEL_TIMEOUT_MS = 60_000;
// Per-attempt fetch timeout. Shorter than POLL_INTERVAL_MS so a hung probe
// doesn't starve the cadence.
const PUBLIC_TUNNEL_ATTEMPT_TIMEOUT_MS = 2_500;
// Cadence for the "Xs elapsed" progress events so the wizard's ProgressLog
// shows live feedback rather than going silent for a minute.
const PUBLIC_TUNNEL_PROGRESS_INTERVAL_MS = 3_000;

export interface ProvisionInput {
  name: string;
  description: string | null;
  visibility: "public" | "private";
  selectedPlugins: string[];
  tunnelMode: "cloudflare" | "demo";
  cloudflare_tunnel_token?: string | undefined;
  cloudflare_public_hostname?: string | undefined;
  /** Runtime distribution channel for the initial pull. Defaults to "dev"
   *  on the wizard side until the first stable release exists. The runtime
   *  also persists this so subsequent auto-update checks honor the same
   *  channel without a separate user gesture. */
  channel?: RuntimeUpdateChannel;
}

export interface ProvisionSuccess {
  serverId: string;
  slug: string;
  tunnelUrl: string | null;
  containerId: string;
  hostPort: number;
  volumePath: string;
  /** Echoed back to main.ts so the registry can persist it for lifecycle restores. */
  tunnelPublicHostname?: string;
  /** Cosign material verified during pull. Persisted to the registry so launch-
   *  time and voice-hostname rebuild paths can re-supply RUNTIME_IMAGE_*
   *  envs without a fresh pull. Absent in dev / seed-state flows. */
  imageSignature?: {
    digest: string;
    payloadJson: string;
    signatureB64: string;
  };
}

export interface ProvisionEvent {
  step:
    | "check-environment"
    | "register"
    | "resolve-version"
    | "download-runtime"
    | "verify-signature"
    | "prepare-volumes"
    | "install-plugins"
    | "write-config"
    | "start-container"
    | "wait-health"
    | "wait-heartbeat"
    | "wait-public-tunnel"
    | "set-channel"
    | "rollback"
    | "done";
  status: "running" | "progress" | "completed" | "warning";
  message: string;
  detail?: string;
  /** Stable error code for the renderer to map to friendly copy. Set on
   *  the failure event that a step emits before throwing. Renderer falls
   *  back to `message` when absent. */
  errorCode?: string;
  /** 0..1 progress fraction. Only emitted on download-runtime PROGRESS
   *  events when docker prints a layer percentage; absence means
   *  indeterminate (renderer should show a spinner). */
  percent?: number;
}

interface CreatedLayout {
  root: string;
  plugins: string;
  data: string;
  config: string;
}

class PreserveServerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreserveServerError";
  }
}

function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "server";
}

function emit(
  onEvent: (event: ProvisionEvent) => void,
  event: ProvisionEvent,
): void {
  onEvent(event);
}

function isCorePlugin(slug: string): boolean {
  return CORE_PLUGIN_SLUGS.includes(slug as (typeof CORE_PLUGIN_SLUGS)[number]);
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

async function ensureUniqueServerRoot(baseRoot: string, slug: string): Promise<CreatedLayout> {
  let candidate = slug;
  let suffix = 2;
  let root = path.join(baseRoot, candidate);

  while (existsSync(root)) {
    candidate = `${slug}-${String(suffix)}`;
    root = path.join(baseRoot, candidate);
    suffix++;
  }

  const plugins = path.join(root, "plugins");
  const data = path.join(root, "data");
  const config = path.join(root, "config");

  await mkdir(plugins, { recursive: true });
  await mkdir(data, { recursive: true });
  await mkdir(config, { recursive: true });
  await mkdir(path.join(data, "plugins"), { recursive: true });

  return { root, plugins, data, config };
}

// The runtime container publishes its :3000 to host 127.0.0.1:3000 (bridge
// network with --publish; see server-runtime.ts). The runtime's PORT is fixed
// at 3000 and Cloudflare Tunnel ingress maps the public hostname → 127.0.0.1:3000,
// so this number must stay 3000 in lockstep with both the entrypoint and the
// tunnel config. This caps the host to one runtime container at a time;
// multi-runtime-per-host is a separate workstream that needs configurable
// LiveKit ports first.
const RUNTIME_HOST_PORT = 3000;

// Dev escape hatch: skip the GHCR resolve/pull/verify path entirely and
// assume `uncorded-runtime:latest` already exists locally (e.g. from
// `docker build -t uncorded-runtime:latest ./docker`). Documented inline only
// — no UI toggle, because in production this would be misleading. End users
// always go through the GHCR + cosign path.
function isDevLocalImageMode(): boolean {
  return process.env.UNCORDED_DEV_USE_LOCAL_IMAGE === "1";
}

async function writeServerConfig(
  layout: CreatedLayout,
  created: { id: string; server_secret: string },
  input: ProvisionInput,
  cloudflare_tunnel_token: string | undefined,
  cloudflare_public_hostname: string | undefined,
): Promise<void> {
  const { selectedPlugins, tunnelMode, name, description } = input;
  const installedPlugins = unique(selectedPlugins);

  let tunnel: { provider: string; mode: string; credentials_file?: string };
  if (tunnelMode === "cloudflare" && cloudflare_tunnel_token) {
    // Token lives in the desktop secret store (OS keyring in packaged builds;
    // dev fallback only in local development). The container
    // receives it over stdin at start time and the entrypoint wrapper writes
    // /run/tunnel/tunnel.json on tmpfs — never on host disk, never in
    // `docker inspect`.
    tunnel = {
      provider: "cloudflare",
      mode: "authenticated",
      credentials_file: "/run/tunnel/tunnel.json",
    };
  } else if (tunnelMode === "cloudflare") {
    // cloudflare selected but no token yet — fall back to demo mode
    tunnel = {
      provider: "cloudflare",
      mode: "demo",
    };
  } else {
    tunnel = {
      provider: "cloudflare",
      mode: "demo",
    };
  }

  const serverJson = {
    server_id: created.id,
    server_secret: created.server_secret,
    central_url: central.getContainerCentralUrl(),
    name: name.trim(),
    ...(description?.trim() ? { description: description.trim() } : {}),
    visibility: input.visibility,
    installed_plugins: installedPlugins,
    tunnel,
    settings: {
      permissive_mode: false,
      max_connections: 100,
      // 25 lets a power-user keep many tabs/devices on one home network
      // while preventing a single peer from devouring the global cap.
      // Operators can edit server.json (or set 0) to lift the per-IP cap.
      max_connections_per_ip: 25,
      allow_unsigned_plugins: false,
      // Seed every shell origin an UnCorded operator typically uses:
      // public deployment (uncorded.app, www.uncorded.app) plus the local
      // dev shell (Electron on :5173, Vite web on :5174). Without these the
      // runtime returns no Access-Control-Allow-Origin on authenticated
      // routes and the browser blocks credentialed fetches. Operators
      // running the shell from a different origin can edit server.json.
      allowed_origins: [
        "https://uncorded.app",
        "https://www.uncorded.app",
        "http://localhost:5173",
        "http://localhost:5174",
      ],
    },
  };

  await writeFile(
    path.join(layout.config, "server.json"),
    JSON.stringify(serverJson, null, 2),
    "utf8",
  );
}

async function waitForHealth(hostPort: number): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let lastError = "No health response yet";

  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${String(hostPort)}/health`);
      if (res.ok) return;
      lastError = `Health returned ${String(res.status)}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  throw new Error(`Server did not become healthy within 60 seconds: ${lastError}`);
}

export interface WaitForPublicTunnelDeps {
  readonly fetchFn?: typeof fetch;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly timeoutMs?: number;
  readonly attemptTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly progressIntervalMs?: number;
  readonly onProgress?: (elapsedMs: number) => void;
}

export interface WaitForPublicTunnelResult {
  readonly ok: boolean;
  readonly attempts: number;
  readonly elapsedMs: number;
  readonly lastStatus?: number;
  readonly lastError?: string;
}

/**
 * Probe the user-facing public tunnel URL until /ready returns 200 or the
 * budget expires. Returns a result rather than throwing — soft warning is the
 * documented failure semantic (spec-10 Amendment A: probe failures past step 7
 * never destroy the server).
 *
 * Per Amendment A R1: hits /ready (not /health). /ready additionally gates on
 * key-cache freshness, so a green probe means the runtime is genuinely willing
 * to serve authenticated traffic.
 *
 * Per Amendment A R5: credentials:omit, cache:no-store, GET. No cookies should
 * ever flow on this fetch, and a stale 200 from disk cache must not short-
 * circuit the readiness signal.
 */
export async function waitForPublicTunnel(
  tunnelUrl: string,
  deps: WaitForPublicTunnelDeps = {},
): Promise<WaitForPublicTunnelResult> {
  const fetchFn = deps.fetchFn ?? fetch;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const timeoutMs = deps.timeoutMs ?? PUBLIC_TUNNEL_TIMEOUT_MS;
  const attemptTimeoutMs = deps.attemptTimeoutMs ?? PUBLIC_TUNNEL_ATTEMPT_TIMEOUT_MS;
  const pollIntervalMs = deps.pollIntervalMs ?? POLL_INTERVAL_MS;
  const progressIntervalMs = deps.progressIntervalMs ?? PUBLIC_TUNNEL_PROGRESS_INTERVAL_MS;

  const url = `${tunnelUrl.replace(/\/$/, "")}/ready`;
  const start = now();
  const deadline = start + timeoutMs;
  let attempts = 0;
  let lastStatus: number | undefined;
  let lastError: string | undefined;
  let lastProgressEmit = start;

  while (now() < deadline) {
    attempts += 1;
    try {
      const res = await fetchFn(url, {
        method: "GET",
        signal: AbortSignal.timeout(attemptTimeoutMs),
        credentials: "omit",
        cache: "no-store",
      });
      if (res.ok) {
        return { ok: true, attempts, elapsedMs: now() - start, lastStatus: res.status };
      }
      lastStatus = res.status;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }

    const elapsed = now() - start;
    if (elapsed - (lastProgressEmit - start) >= progressIntervalMs) {
      lastProgressEmit = now();
      deps.onProgress?.(elapsed);
    }

    if (now() >= deadline) break;
    await sleep(pollIntervalMs);
  }

  const result: WaitForPublicTunnelResult = {
    ok: false,
    attempts,
    elapsedMs: now() - start,
    ...(lastStatus !== undefined ? { lastStatus } : {}),
    ...(lastError !== undefined ? { lastError } : {}),
  };
  return result;
}

// Reject loopback URLs so we don't accept the runtime's LOCAL_FALLBACK_URL
// (advertised in heartbeats before cloudflared resolves) as the final tunnel
// URL. `URL` parsing lets us catch IPv6 (`[::1]`), uppercase, port variants,
// and trailing-slash forms without ad-hoc string matching.
function isPublicTunnelUrl(url: string | null | undefined): url is string {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === "localhost") return false;
  if (host === "0.0.0.0") return false;
  if (host === "127.0.0.1") return false;
  if (host === "::1" || host === "[::1]") return false;
  // Catch the broader 127.0.0.0/8 loopback range too — anything else is
  // routable enough that we'll let the public-tunnel probe make the final call.
  if (host.startsWith("127.")) return false;
  return true;
}

interface WaitForFirstHeartbeatOptions {
  /** Fires every ~1.5s once the first heartbeat lands but we're still waiting
   *  for a public URL. Lets the wizard's ProgressLog show "Waiting for
   *  Cloudflare tunnel · Xs elapsed" instead of a silent spinner. */
  readonly onPublicUrlPending?: (elapsedMs: number) => void;
}

async function waitForFirstHeartbeat(
  serverId: string,
  opts: WaitForFirstHeartbeatOptions = {},
): Promise<string | null> {
  // Phase 1: wait for *any* heartbeat (proves the runtime came up at all).
  const heartbeatDeadline = Date.now() + HEARTBEAT_TIMEOUT_MS;
  let firstHeartbeatTunnelUrl: string | null = null;
  let sawHeartbeat = false;

  while (Date.now() < heartbeatDeadline) {
    const server = await central.getServer(serverId);
    if (server.tunnel_url || server.last_heartbeat_at) {
      firstHeartbeatTunnelUrl = server.tunnel_url;
      sawHeartbeat = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  if (!sawHeartbeat) {
    throw new Error("Timed out waiting for the first Central heartbeat");
  }

  // Fast path: heartbeat arrived already carrying a public URL (cloudflared
  // resolved before the first heartbeat tick). Common when the tunnel token
  // was previously used and DNS is hot.
  if (isPublicTunnelUrl(firstHeartbeatTunnelUrl)) {
    return firstHeartbeatTunnelUrl;
  }

  // Phase 2: heartbeat is in but the URL is still loopback (or null). Keep
  // polling until cloudflared resolves so the wizard hands off with the
  // final URL — no mid-session tunnel_url flip that would tear down WS,
  // sidebar, and icon caches.
  const publicUrlStart = Date.now();
  const publicUrlDeadline = publicUrlStart + PUBLIC_URL_TIMEOUT_MS;

  while (Date.now() < publicUrlDeadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    const server = await central.getServer(serverId);
    if (isPublicTunnelUrl(server.tunnel_url)) {
      return server.tunnel_url;
    }
    opts.onPublicUrlPending?.(Date.now() - publicUrlStart);
  }

  // Budget exhausted with only a loopback URL. Treat as a soft warn — the
  // server is preserved; the wizard's stalled-state UI tells the operator
  // we'll switch them in once the tunnel propagates.
  return firstHeartbeatTunnelUrl;
}

/**
 * The durable record the local registry needs to restore a server on the next
 * desktop launch. A subset of the registry's ServerRecord — exactly the fields
 * provisioning knows at container-start. Persisted via
 * ProvisionOptions.persistServerRecord; see the call site in provisionServer.
 */
export interface ProvisionPersistRecord {
  containerId: string;
  volumePath: string;
  hostPort: number;
  tunnelPublicHostname?: string;
  imageSignature?: {
    digest: string;
    payloadJson: string;
    signatureB64: string;
  };
}

export interface ProvisionOptions {
  /** See RunServerArgs.devPluginFrontendMounts. Empty/undefined in packaged builds. */
  devPluginFrontendMounts?: readonly { slug: string; hostDir: string }[];
  /**
   * Persist the server to the local registry the moment its container is
   * confirmed healthy — BEFORE the best-effort Central heartbeat / public-
   * tunnel waits. Those later steps soft-warn (and the heartbeat wait throws
   * PreserveServerError) on failure without meaning the server doesn't exist,
   * so gating persistence on them would leave a healthy, running container that
   * restoreServerContainers can't boot after a restart — the bug this fixes.
   * Injected by main.ts as a thin wrapper over registerServer; tests pass a
   * spy. Omitted → persistence is skipped (unit tests that only assert the
   * provisioning event stream).
   */
  persistServerRecord?: (serverId: string, record: ProvisionPersistRecord) => void;
}

export async function provisionServer(
  input: ProvisionInput,
  onEvent: (event: ProvisionEvent) => void,
  opts: ProvisionOptions = {},
): Promise<ProvisionSuccess> {
  let created: { id: string; server_secret: string } | null = null;
  let layout: CreatedLayout | null = null;
  let containerId: string | null = null;
  const channel: RuntimeUpdateChannel = input.channel ?? "dev";

  try {
    // Pre-flight: surface "Docker isn't running" before we make any state
    // changes (Central registration, secret writes, volumes). Failing early
    // means there's nothing to roll back, and the operator copy is the
    // first thing they see in the wizard log instead of a cryptic
    // mid-stream "ENOENT" later.
    emit(onEvent, {
      step: "check-environment",
      status: "running",
      message: "Checking Docker",
    });
    const dockerStatus = await docker.getDockerStatus();
    if (!dockerStatus.installed) {
      emit(onEvent, {
        step: "check-environment",
        status: "warning",
        message: "Docker isn't installed",
        detail: "Install Docker Desktop, then try again.",
        errorCode: "docker_not_installed",
      });
      throw new Error("Docker isn't installed. Install Docker Desktop, then try again.");
    }
    if (!dockerStatus.running) {
      emit(onEvent, {
        step: "check-environment",
        status: "warning",
        message: "Docker isn't running",
        detail: "Start Docker Desktop, then try again.",
        errorCode: "docker_not_running",
      });
      throw new Error("Docker isn't running. Start Docker Desktop, then try again.");
    }
    emit(onEvent, {
      step: "check-environment",
      status: "completed",
      message: "Docker is ready",
    });

    emit(onEvent, {
      step: "register",
      status: "running",
      message: "Registering server with Central",
    });
    created = await central.createServer(
      input.name.trim(),
      input.description?.trim() || null,
      input.visibility,
    );
    emit(onEvent, {
      step: "register",
      status: "completed",
      message: "Central registration complete",
      detail: created.id,
    });

    let imageSignature: CosignSignatureMaterial | undefined;
    if (isDevLocalImageMode()) {
      // Dev path: assume `uncorded-runtime:latest` is already built locally.
      // Skip resolve/pull/verify/tag; runServerContainer will pick up the
      // local tag as-is. No imageSignature → runtime tolerates absence iff
      // its embedded pubkey is also empty.
      if (!(await docker.imageExists(SERVER_IMAGE))) {
        throw new Error(
          `UNCORDED_DEV_USE_LOCAL_IMAGE=1 but ${SERVER_IMAGE} is not built locally. Run 'docker build -t ${SERVER_IMAGE} ./docker' first.`,
        );
      }
      emit(onEvent, {
        step: "download-runtime",
        status: "completed",
        message: "Using local dev image (UNCORDED_DEV_USE_LOCAL_IMAGE=1)",
        detail: SERVER_IMAGE,
      });
    } else {
      emit(onEvent, {
        step: "resolve-version",
        status: "running",
        message: `Looking up the latest ${channel} runtime release`,
      });
      let firstBoot;
      // Track the last percent we emitted so we don't spam the renderer with
      // duplicates — `extractPullPercent` already snaps to 5% buckets, but a
      // long pull repeats the same bucket across many layer lines.
      let lastPercent = -1;
      try {
        firstBoot = await pullVerifyAndTagForFirstBoot(
          { channel },
          {
            onPullProgress: (line) => {
              const pct = extractPullPercent(line);
              const bucket = pct === null ? null : clampProgress(pct);
              if (bucket !== null && bucket !== lastPercent) {
                lastPercent = bucket;
                emit(onEvent, {
                  step: "download-runtime",
                  status: "progress",
                  message: "Downloading runtime image",
                  detail: line,
                  percent: bucket / 100,
                });
              } else {
                emit(onEvent, {
                  step: "download-runtime",
                  status: "progress",
                  message: "Downloading runtime image",
                  detail: line,
                });
              }
            },
          },
        );
      } catch (err) {
        // Map known error shapes to stable error codes the renderer can
        // turn into friendly copy. Unknown shapes fall through to the
        // generic outer catch.
        if (err instanceof FirstBootPullError) {
          emit(onEvent, {
            step: "download-runtime",
            status: "warning",
            message: "Couldn't download the runtime image",
            detail: err.message,
            errorCode: "pull_failed",
          });
          throw new Error(`Couldn't download the runtime image: ${err.message}`);
        }
        const msg = err instanceof Error ? err.message : String(err);
        // CosignError has a `.code` field — propagate it as errorCode so the
        // renderer can render the safety messaging from the plan's D7 table.
        const cosignCode = (err as { code?: unknown } | null)?.code;
        if (typeof cosignCode === "string") {
          emit(onEvent, {
            step: "verify-signature",
            status: "warning",
            message: "Signature verification failed",
            detail: msg,
            errorCode: `cosign_${cosignCode}`,
          });
          throw new Error(`Signature verification failed: ${msg}`);
        }
        // resolveLatestVersion returned null → user-facing channel hint.
        if (msg.startsWith("No runtime release published")) {
          emit(onEvent, {
            step: "resolve-version",
            status: "warning",
            message: msg,
            errorCode: "no_release_for_channel",
          });
          throw new Error(msg);
        }
        throw err;
      }
      emit(onEvent, {
        step: "resolve-version",
        status: "completed",
        message: `Resolved runtime ${firstBoot.targetVersion}`,
        detail: firstBoot.targetImage,
      });
      emit(onEvent, {
        step: "download-runtime",
        status: "completed",
        message: "Runtime image downloaded",
        detail: firstBoot.targetImage,
      });
      emit(onEvent, {
        step: "verify-signature",
        status: firstBoot.signature ? "completed" : "warning",
        message: firstBoot.signature
          ? "Signature verified"
          : "Signature verification skipped (seed-state runtime)",
        ...(firstBoot.digest ? { detail: firstBoot.digest } : {}),
      });
      imageSignature = firstBoot.signature;
    }

    emit(onEvent, {
      step: "prepare-volumes",
      status: "running",
      message: "Preparing server volumes",
    });
    const baseRoot = path.join(homedir(), ".uncorded", "servers");
    await mkdir(baseRoot, { recursive: true });
    layout = await ensureUniqueServerRoot(baseRoot, slugify(input.name));
    emit(onEvent, {
      step: "prepare-volumes",
      status: "completed",
      message: "Server volumes created",
      detail: layout.root,
    });

    emit(onEvent, {
      step: "install-plugins",
      status: "running",
      message: "Installing selected plugins",
    });
    const marketplacePlugins = input.selectedPlugins.filter((slug) => !isCorePlugin(slug));
    if (marketplacePlugins.length > 0) {
      throw new Error(
        `Marketplace plugin install is not wired for: ${marketplacePlugins.join(", ")}`,
      );
    }
    emit(onEvent, {
      step: "install-plugins",
      status: "completed",
      message: "Plugin installation complete",
      detail: "Core plugins are provided by the image",
    });

    emit(onEvent, {
      step: "write-config",
      status: "running",
      message: "Writing server configuration",
    });
    await writeServerConfig(layout, created, input, input.cloudflare_tunnel_token, input.cloudflare_public_hostname);
    // Persist the tunnel token to the desktop secret store so the desktop app can
    // re-deliver it on every container start without ever writing it to disk.
    // Cleared only on server delete (see CENTRAL_DELETE_SERVER).
    if (input.tunnelMode === "cloudflare" && input.cloudflare_tunnel_token) {
      setSecret(tunnelSecretKey(created.id), input.cloudflare_tunnel_token);
    }
    // Generate the runtime encryption secret once per server. The runtime
    // requires ≥32 chars; 64 hex chars (32 random bytes) is the
    // recommended minimum from the entrypoint's error message. Persisted
    // alongside the tunnel token; cleared on server purge.
    const runtimeEncryptionSecret = randomBytes(32).toString("hex");
    setSecret(encryptionSecretKey(created.id), runtimeEncryptionSecret);
    emit(onEvent, {
      step: "write-config",
      status: "completed",
      message: "Configuration written",
    });

    emit(onEvent, {
      step: "start-container",
      status: "running",
      message: "Starting server container",
    });
    const hostPort = RUNTIME_HOST_PORT;
    const tunnelTokenForRun =
      input.tunnelMode === "cloudflare" ? input.cloudflare_tunnel_token : undefined;
    const tunnelHostnameForRun =
      input.tunnelMode === "cloudflare" ? input.cloudflare_public_hostname : undefined;
    containerId = await runServerContainer({
      volumePath: layout.root,
      hostPort,
      tunnelToken: tunnelTokenForRun,
      tunnelPublicHostname: tunnelHostnameForRun,
      runtimeEncryptionSecret,
      ...(opts.devPluginFrontendMounts && opts.devPluginFrontendMounts.length > 0
        ? { devPluginFrontendMounts: opts.devPluginFrontendMounts }
        : {}),
      // Forward the cosign-verified material so the runtime can re-verify
      // the image at boot (defense-in-depth per Phase 01 §10). Omitted in
      // dev / seed-state flows; the runtime tolerates absence iff its own
      // embedded pubkey is empty, otherwise it exits 40.
      ...(imageSignature ? { imageSignature } : {}),
    });
    emit(onEvent, {
      step: "start-container",
      status: "completed",
      message: "Container started",
      detail: containerId,
    });

    emit(onEvent, {
      step: "wait-health",
      status: "running",
      message: "Waiting for server health check",
    });
    try {
      await waitForHealth(hostPort);
    } catch (err) {
      throw new PreserveServerError(
        err instanceof Error ? err.message : String(err),
      );
    }
    emit(onEvent, {
      step: "wait-health",
      status: "completed",
      message: "Server reported healthy",
    });

    // Persist to the local registry NOW — the container exists and is healthy.
    // Everything past this point (set-channel, heartbeat, public-tunnel) is a
    // best-effort Central round-trip that soft-warns or throws
    // PreserveServerError on failure; none of them change the fact that this
    // machine hosts this server. Writing the record here (rather than after the
    // wizard's `done`) is what lets restoreServerContainers boot the server on
    // the next launch even when those round-trips never complete.
    //
    // INVARIANT: this is the last step before the preserve-only tail, so a
    // persisted record is never left behind by the non-preserve rollback in the
    // catch below (which only fires for failures *before* this point). If a
    // future throwing, non-preserve step is added after here, extend the
    // rollback to drop the registry entry too.
    opts.persistServerRecord?.(created.id, {
      containerId,
      volumePath: layout.root,
      hostPort,
      ...(tunnelHostnameForRun ? { tunnelPublicHostname: tunnelHostnameForRun } : {}),
      ...(imageSignature ? { imageSignature } : {}),
    });

    // Persist the chosen channel into the runtime's update-state so future
    // auto-update checks pick up releases on the same channel without a
    // separate user gesture. The runtime's WS broadcast notifies any
    // connected clients (including the wizard's own renderer once it
    // hands off to the server view). Best-effort: a failure here doesn't
    // invalidate the just-created server, so we surface a warning instead
    // of throwing.
    if (!isDevLocalImageMode()) {
      emit(onEvent, {
        step: "set-channel",
        status: "running",
        message: `Setting runtime channel to ${channel}`,
      });
      try {
        await setChannelByEndpoint(created.id, hostPort, channel);
        emit(onEvent, {
          step: "set-channel",
          status: "completed",
          message: `Runtime channel set to ${channel}`,
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        emit(onEvent, {
          step: "set-channel",
          status: "warning",
          message: "Couldn't persist runtime channel — auto-updates will use the runtime default until you change it in Settings",
          detail: reason,
        });
      }
    }

    emit(onEvent, {
      step: "wait-heartbeat",
      status: "running",
      message: "Waiting for first heartbeat and tunnel URL",
    });
    let tunnelUrl: string | null = null;
    try {
      tunnelUrl = await waitForFirstHeartbeat(created.id, {
        onPublicUrlPending: (elapsedMs) => {
          emit(onEvent, {
            step: "wait-heartbeat",
            status: "progress",
            message: "Waiting for the public tunnel URL to resolve",
            detail: `${String(Math.round(elapsedMs / 1000))}s elapsed`,
          });
        },
      });
    } catch (err) {
      emit(onEvent, {
        step: "wait-heartbeat",
        status: "warning",
        message: "Server is running, but the first heartbeat did not arrive in time",
      });
      throw new PreserveServerError(
        err instanceof Error ? err.message : String(err),
      );
    }
    if (isPublicTunnelUrl(tunnelUrl)) {
      emit(onEvent, {
        step: "wait-heartbeat",
        status: "completed",
        message: "Central heartbeat confirmed",
        detail: tunnelUrl,
      });
    } else if (tunnelUrl) {
      // Heartbeat is alive but Cloudflare hasn't resolved a public URL yet.
      // Drop into soft-warn so the wait-public-tunnel probe is skipped and
      // the wizard's stalled-state UI takes over (it'll keep re-probing in
      // the background and switch the user in once the URL flips public).
      emit(onEvent, {
        step: "wait-heartbeat",
        status: "warning",
        message: "Tunnel still propagating — we'll switch you in once it's ready",
        detail: tunnelUrl,
      });
    } else {
      emit(onEvent, {
        step: "wait-heartbeat",
        status: "warning",
        message: "Heartbeat confirmed without a tunnel URL",
      });
    }

    // spec-10 Amendment A step 8.5 — heartbeats don't exercise inbound CF
    // ingress, so before we tell the wizard `done` (and hand the user a
    // tunnel URL), probe /ready over the public URL. Soft warning on budget
    // exhaustion — the wizard decides what to do; the server is preserved.
    // Skip when the URL is still loopback: the runtime IS reachable on
    // localhost from the desktop process, so the probe would falsely succeed
    // and we'd hand the user a URL nobody else can reach.
    if (isPublicTunnelUrl(tunnelUrl)) {
      emit(onEvent, {
        step: "wait-public-tunnel",
        status: "running",
        message: "Verifying public tunnel reachability",
      });
      const probe = await waitForPublicTunnel(tunnelUrl, {
        onProgress: (elapsedMs) => {
          emit(onEvent, {
            step: "wait-public-tunnel",
            status: "progress",
            message: "Verifying public tunnel reachability",
            detail: `${String(Math.round(elapsedMs / 1000))}s elapsed`,
          });
        },
      });
      if (probe.ok) {
        emit(onEvent, {
          step: "wait-public-tunnel",
          status: "completed",
          message: "Public tunnel is reachable",
          detail: `${String(Math.round(probe.elapsedMs / 1000))}s, ${String(probe.attempts)} attempt${probe.attempts === 1 ? "" : "s"}`,
        });
      } else {
        const detailParts: string[] = ["60s budget exceeded"];
        if (probe.lastStatus !== undefined) detailParts.push(`last status ${String(probe.lastStatus)}`);
        else if (probe.lastError) detailParts.push(`last error: ${probe.lastError}`);
        emit(onEvent, {
          step: "wait-public-tunnel",
          status: "warning",
          message: "Tunnel still propagating — we'll switch you in once it's ready",
          detail: detailParts.join(" · "),
        });
      }
    }

    emit(onEvent, tunnelUrl
      ? {
          step: "done",
          status: "completed",
          message: "Server is live",
          detail: tunnelUrl,
        }
      : {
          step: "done",
          status: "completed",
          message: "Server is live",
        });

    return {
      serverId: created.id,
      slug: path.basename(layout.root),
      tunnelUrl,
      containerId,
      hostPort,
      volumePath: layout.root,
      ...(tunnelHostnameForRun ? { tunnelPublicHostname: tunnelHostnameForRun } : {}),
      ...(imageSignature ? { imageSignature } : {}),
    };
  } catch (err) {
    const preserveServer = err instanceof PreserveServerError;

    if (!preserveServer && (containerId || layout || created)) {
      emit(onEvent, {
        step: "rollback",
        status: "running",
        message: "Rolling back failed provisioning",
      });
    }

    const message = err instanceof Error ? err.message : String(err);

    if (!preserveServer && containerId) {
      try {
        await docker.removeContainer(containerId);
      } catch {
        // Best effort rollback.
      }
    }

    if (!preserveServer && layout) {
      try {
        await rm(layout.root, { recursive: true, force: true });
      } catch {
        // Best effort rollback.
      }
    }

    if (!preserveServer && created) {
      try {
        await central.deleteServer(created.id);
      } catch {
        // Best effort rollback.
      }
    }

    throw new Error(message);
  }
}
