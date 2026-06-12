// "Install into server" — deploy a dev plugin from the workspace
// (~/.uncorded/plugin-dev/<slug>/) into a locally-hosted server's volume and
// restart the server so the runtime loads it. The dev folder stays the source
// of truth; the server copy is disposable.
//
// Why restart: the runtime enumerates plugins exactly once at boot
// (runtime/src/main.ts boot step 5) — there is no hot-load of new plugin
// directories. Stop-first is also the SAFE ordering: it removes both deploy
// hazards (replacing files under a running plugin subprocess, and a
// half-copied directory being present at boot), and restart counters are
// in-memory so every container start begins with a clean quarantine slate.
// The desktop already owns this recreate lifecycle (VOICE_SET_HOSTNAME /
// restoreServerContainers in main.ts); the container-start seam is injected
// here so this module stays pure enough to test against temp dirs.
//
// server.json is safe to mutate host-side while the container is stopped:
// the runtime only SEEDS it when missing (entrypoint.ts) and never writes it
// afterwards.

import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type {
  DevPluginDeployErrorCode,
  DevPluginDeployStep,
  DockerStatus,
} from "@uncorded/electron-bridge";
import { RESERVED_PLUGIN_SLUGS } from "./plugin-dev-templates";
import {
  releaseServerLifecycle,
  tryAcquireServerLifecycle,
  __resetServerLifecycleForTests,
} from "./server-lifecycle-lock";

// ---------------------------------------------------------------------------
// Types — step/error unions live in @uncorded/electron-bridge (the renderer
// renders them); aliased here for readability.
// ---------------------------------------------------------------------------

export type DeployStep = DevPluginDeployStep;
export type DeployErrorCode = DevPluginDeployErrorCode;

export interface DeployProgressEvent {
  step: DeployStep;
  status: "running" | "completed" | "warning";
  message: string;
  detail?: string;
}

export type DeployOutcome =
  | { ok: true; containerId: string; pluginStatus: "ready" | "starting" | "unknown" }
  | { ok: false; code: DeployErrorCode; message: string };

export type UndeployOutcome =
  | { ok: true; containerId: string }
  | { ok: false; code: DeployErrorCode | "UNINSTALL_FAILED"; message: string };

export interface DeployOptions {
  /** User accepted flipping allow_unsigned_plugins on this server. */
  consentUnsigned?: boolean;
  /** Replace a /plugins/<slug> folder that this flow doesn't own. */
  overwriteExisting?: boolean;
}

/** The slice of the registry record deploy needs. */
export interface DeployServerRecord {
  containerId: string;
  volumePath: string;
  hostPort: number;
}

export interface DeployDeps {
  /** devPluginPath from plugin-dev-store (slug-validated, traversal-safe). */
  resolveDevPluginPath(slug: string): string | null;
  getServerRecord(serverId: string): DeployServerRecord | null;
  getDockerStatus(): Promise<DockerStatus>;
  /** removeIfExists — tolerates an already-gone container. */
  removeContainer(containerId: string): Promise<void>;
  /**
   * Recreate + start the server container (docker run — the tunnel token is
   * piped at create time, so never `docker start`). Owns secret-store access
   * and registry containerId persistence. Returns the new container id.
   */
  startServerContainer(serverId: string): Promise<string>;
  /** Bearer token for the runtime admin API, or null when Central is
   *  unreachable (degrades verify to "unknown", never fails the deploy). */
  getAdminToken(serverId: string): Promise<string | null>;
  onProgress?(event: DeployProgressEvent): void;
  fetchFn?: typeof fetch;
  /** Health-poll budget; tests shrink it. */
  healthTimeoutMs?: number;
  healthPollIntervalMs?: number;
  /** Injected for failure-path tests (fs errors are not reliably
   *  simulatable cross-platform). Production uses the real fs calls. */
  renameFn?: (oldPath: string, newPath: string) => void;
  removePathFn?: (path: string) => void;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * Minimal caret-range check for `manifest.api_version` (^MAJOR.MINOR[.PATCH])
 * against the runtime's concrete plugin API version. Mirrors
 * @uncorded/shared's satisfiesRange for this grammar — desktop main cannot
 * runtime-import that raw-TS package; a parity test pins the two.
 */
export function caretSatisfies(version: string, range: string): boolean {
  const vm = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  const rm = /^\^?(\d+)\.(\d+)(?:\.(\d+))?$/.exec(range);
  if (!vm || !rm) return false;
  const [vMaj, vMin, vPat] = [Number(vm[1]), Number(vm[2]), Number(vm[3])];
  const [rMaj, rMin, rPat] = [Number(rm[1]), Number(rm[2]), Number(rm[3] ?? "0")];
  if (vMaj !== rMaj) return false;
  if (vMin !== rMin) return vMin > rMin;
  return vPat >= rPat;
}

interface ManifestPeek {
  name: string;
  apiVersion: string;
}

/** Tolerant essential-fields read — full validation is the runtime
 *  resolver's job; this catches what would brick the deploy. */
function readDeployManifest(pluginDir: string): { ok: true; manifest: ManifestPeek } | { ok: false; message: string } {
  const p = join(pluginDir, "manifest.json");
  if (!existsSync(p)) return { ok: false, message: "manifest.json is missing." };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return { ok: false, message: "manifest.json is not valid JSON." };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, message: "manifest.json must be a JSON object." };
  }
  const o = raw as Record<string, unknown>;
  for (const field of ["name", "version", "api_version", "author", "description", "type"]) {
    if (typeof o[field] !== "string" || (o[field] as string).length === 0) {
      return { ok: false, message: `manifest.json "${field}" must be a non-empty string.` };
    }
  }
  if (!Array.isArray(o["permissions"])) {
    return { ok: false, message: 'manifest.json "permissions" must be an array.' };
  }
  if (o["backend"] === undefined && o["frontend"] === undefined) {
    return { ok: false, message: "manifest.json needs at least one of backend/frontend." };
  }
  return { ok: true, manifest: { name: o["name"] as string, apiVersion: o["api_version"] as string } };
}

interface ServerJsonFile {
  raw: Record<string, unknown>;
  installedPlugins: string[];
  allowUnsigned: boolean;
}

function readServerJson(volumePath: string): { ok: true; file: ServerJsonFile } | { ok: false; message: string } {
  const p = join(volumePath, "config", "server.json");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(p, "utf8"));
  } catch (err) {
    return { ok: false, message: `Could not read server.json: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, message: "server.json is not a JSON object." };
  }
  const o = raw as Record<string, unknown>;
  const installed = Array.isArray(o["installed_plugins"])
    ? o["installed_plugins"].filter((s): s is string => typeof s === "string")
    : [];
  const settings = o["settings"];
  const allowUnsigned =
    typeof settings === "object" && settings !== null && !Array.isArray(settings)
      ? (settings as Record<string, unknown>)["allow_unsigned_plugins"] === true
      : false;
  return { ok: true, file: { raw: o, installedPlugins: installed, allowUnsigned } };
}

/** Read-modify-write with tmp+rename so a crash never leaves a torn file. */
function writeServerJson(
  volumePath: string,
  file: ServerJsonFile,
  mutate: (raw: Record<string, unknown>) => void,
): { ok: true } | { ok: false; message: string } {
  const p = join(volumePath, "config", "server.json");
  const tmp = `${p}.tmp`;
  try {
    mutate(file.raw);
    writeFileSync(tmp, JSON.stringify(file.raw, null, 2), "utf8");
    renameSync(tmp, p);
    return { ok: true };
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // best effort
    }
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/** Files that exist for the desktop/agent, not the runtime. node_modules IS
 *  copied — the documented packaging contract is "ship your deps"; only the
 *  SDK itself falls back to the runtime's /plugins/node_modules link. */
const COPY_EXCLUDE = new Set([".git", ".uncorded-dev.json", "PROMPT.md", "AGENTS.md", "CLAUDE.md"]);

function copyPluginToStaging(sourceDir: string, pluginsDir: string, slug: string): { ok: true; stagingDir: string } | { ok: false; message: string } {
  const stagingDir = join(pluginsDir, `.staging-${slug}`);
  try {
    // Sweep stale staging/backup dirs from crashed prior deploys.
    for (const name of existsSync(pluginsDir) ? readdirSync(pluginsDir) : []) {
      if (name.startsWith(".staging-") || name.startsWith(".backup-")) {
        rmSync(join(pluginsDir, name), { recursive: true, force: true });
      }
    }
    mkdirSync(pluginsDir, { recursive: true });
    cpSync(sourceDir, stagingDir, {
      recursive: true,
      filter: (src) => {
        const name = basename(src);
        if (src === sourceDir) return true;
        if (COPY_EXCLUDE.has(name)) return false;
        if (name.endsWith(".db") || name.endsWith(".db-wal") || name.endsWith(".db-shm")) return false;
        try {
          // Exclude symlinks/junctions — they wouldn't resolve inside the
          // container and Windows junction loops can blow up the copy.
          if (lstatSync(src).isSymbolicLink()) return false;
        } catch {
          return false;
        }
        return true;
      },
    });
    return { ok: true, stagingDir };
  } catch (err) {
    try {
      rmSync(stagingDir, { recursive: true, force: true });
    } catch {
      // best effort — the sweep above catches leftovers next time
    }
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

interface AdminPluginRow {
  slug?: string;
  statusLabel?: string;
}

/**
 * The picker facts for one local server: is this slug already installed, and
 * does server.json already allow unsigned plugins (no consent step needed).
 * Null when server.json can't be read — the picker shows the row disabled.
 */
export function readInstallTargetInfo(
  volumePath: string,
  slug: string,
): { deployed: boolean; allowUnsigned: boolean } | null {
  const config = readServerJson(volumePath);
  if (!config.ok) return null;
  return {
    deployed: config.file.installedPlugins.includes(slug),
    allowUnsigned: config.file.allowUnsigned,
  };
}

// ---------------------------------------------------------------------------
// Per-server serialization — the SHARED lifecycle lock, so deploys also
// exclude runtime updates and voice-hostname rebuilds (and vice versa), not
// just other deploys. All three flows docker-rm + re-run the same container.
// ---------------------------------------------------------------------------

/** Test-only: clear the per-server lifecycle locks. */
export function __resetDeployLocksForTests(): void {
  __resetServerLifecycleForTests();
}

/**
 * Preflight size check over the files the copy would actually ship (same
 * exclusion rules). A dev folder can legitimately carry a large node_modules,
 * but an unbounded copy into the server volume is a disk-filler — and far
 * past this point it's almost always an accident (a stray .cache, a vendored
 * toolchain). Marketplace packages cap at 50 MB (spec-11); sideload gets
 * generous headroom, not infinity.
 */
export const DEPLOY_MAX_BYTES = 512 * 1024 * 1024;

export function measureCopyBytes(dir: string, budget: number): { bytes: number; overBudget: boolean } {
  let bytes = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let names: string[];
    try {
      names = readdirSync(current);
    } catch {
      continue;
    }
    for (const name of names) {
      // Same rule set as copyPluginToStaging's filter: excluded basenames
      // apply at any depth, as do db files and symlinks.
      if (COPY_EXCLUDE.has(name)) continue;
      if (name.endsWith(".db") || name.endsWith(".db-wal") || name.endsWith(".db-shm")) continue;
      const full = join(current, name);
      let stat;
      try {
        stat = lstatSync(full);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        stack.push(full);
      } else {
        bytes += stat.size;
        if (bytes > budget) return { bytes, overBudget: true };
      }
    }
  }
  return { bytes, overBudget: false };
}

// ---------------------------------------------------------------------------
// Deploy
// ---------------------------------------------------------------------------

export async function deployDevPlugin(
  slug: string,
  serverId: string,
  options: DeployOptions,
  deps: DeployDeps,
): Promise<DeployOutcome> {
  if (!tryAcquireServerLifecycle(serverId)) {
    return {
      ok: false,
      code: "DEPLOY_IN_PROGRESS",
      message:
        "Another operation (install, runtime update, or server rebuild) is already running for this server.",
    };
  }
  try {
    return await runDeploy(slug, serverId, options, deps);
  } finally {
    releaseServerLifecycle(serverId);
  }
}

async function runDeploy(
  slug: string,
  serverId: string,
  options: DeployOptions,
  deps: DeployDeps,
): Promise<DeployOutcome> {
  const progress = deps.onProgress ?? (() => undefined);
  const fetchFn = deps.fetchFn ?? fetch;
  const fail = (code: DeployErrorCode, message: string): DeployOutcome => ({ ok: false, code, message });

  // --- validate (no side effects) ---
  progress({ step: "validate", status: "running", message: "Checking plugin and server" });

  const sourceDir = deps.resolveDevPluginPath(slug);
  if (sourceDir === null) return fail("WORKSPACE_NOT_FOUND", `No dev plugin named "${slug}" in the workspace.`);

  const manifestResult = readDeployManifest(sourceDir);
  if (!manifestResult.ok) return fail("MANIFEST_INVALID", manifestResult.message);
  const manifest = manifestResult.manifest;
  if (manifest.name !== slug) {
    return fail("SLUG_MISMATCH", `manifest.json "name" (${manifest.name}) must equal the folder name (${slug}).`);
  }
  if (RESERVED_PLUGIN_SLUGS.has(slug)) {
    // Core plugin dirs shadow /plugins in the runtime resolver — a collision
    // would silently load the CORE plugin, not this one.
    return fail("SLUG_RESERVED", `"${slug}" collides with a reserved or first-party plugin name.`);
  }

  const size = measureCopyBytes(sourceDir, DEPLOY_MAX_BYTES);
  if (size.overBudget) {
    return fail(
      "PLUGIN_TOO_LARGE",
      `The plugin folder exceeds ${String(DEPLOY_MAX_BYTES / (1024 * 1024))} MB of deployable files — check for stray caches or vendored toolchains before installing.`,
    );
  }

  const record = deps.getServerRecord(serverId);
  if (record === null) return fail("SERVER_NOT_FOUND", "That server is not hosted on this machine.");

  const dockerStatus = await deps.getDockerStatus();
  if (!dockerStatus.running) return fail("DOCKER_NOT_RUNNING", "Docker is not running.");

  const configResult = readServerJson(record.volumePath);
  if (!configResult.ok) return fail("CONFIG_READ_FAILED", configResult.message);
  const config = configResult.file;

  if (!config.allowUnsigned && options.consentUnsigned !== true) {
    return fail("CONSENT_REQUIRED", "This server doesn't accept unsigned local plugins yet — consent is required.");
  }

  const targetDir = join(record.volumePath, "plugins", slug);
  const isRedeploy = config.installedPlugins.includes(slug);
  if (existsSync(targetDir) && !isRedeploy && options.overwriteExisting !== true) {
    return fail(
      "SLUG_CONFLICT_EXISTING",
      `The server already has a /plugins/${slug} folder that wasn't installed by this flow.`,
    );
  }

  // Probe the RUNNING server (if it answers) for the plugin API contract.
  // The plugin_api_version field doubles as the capability marker for the
  // runtime release that makes the SDK resolvable from /plugins — absence
  // means deploying would quarantine any SDK-importing plugin.
  try {
    const res = await fetchFn(`http://127.0.0.1:${String(record.hostPort)}/health`, {
      signal: AbortSignal.timeout(3_000),
    });
    if (res.ok) {
      const body = (await res.json()) as { plugin_api_version?: unknown };
      if (typeof body.plugin_api_version !== "string") {
        return fail(
          "RUNTIME_TOO_OLD",
          "This server's runtime predates sideloaded-plugin support. Update the server runtime first (Server settings → Runtime).",
        );
      }
      if (!caretSatisfies(body.plugin_api_version, manifest.apiVersion)) {
        return fail(
          "API_VERSION_INCOMPATIBLE",
          `The plugin targets api_version ${manifest.apiVersion}, but the server speaks ${body.plugin_api_version}.`,
        );
      }
    }
  } catch {
    // Container stopped or unreachable — the post-start verify still catches
    // a load failure; don't block the deploy on a probe.
  }
  progress({ step: "validate", status: "completed", message: "Plugin and server look good" });

  // --- stop-container ---
  progress({ step: "stop-container", status: "running", message: "Stopping the server" });
  await deps.removeContainer(record.containerId);
  progress({ step: "stop-container", status: "completed", message: "Server stopped" });

  // --- copy-files (stage + swap so the old install survives a failed copy) ---
  progress({ step: "copy-files", status: "running", message: "Copying plugin files" });
  const pluginsDir = join(record.volumePath, "plugins");
  const staged = copyPluginToStaging(sourceDir, pluginsDir, slug);
  if (!staged.ok) {
    await restartBestEffort(deps, serverId, progress);
    return fail("COPY_FAILED", staged.message);
  }
  // Swap via backup/restore, never delete-then-rename: if the rename into
  // place fails after a delete, installed_plugins points at a missing folder
  // and the previous install is gone. With a backup, any failure restores
  // the exact prior state.
  const renameFn = deps.renameFn ?? renameSync;
  const backupDir = join(pluginsDir, `.backup-${slug}`);
  const hadExisting = existsSync(targetDir);
  try {
    rmSync(backupDir, { recursive: true, force: true });
    if (hadExisting) renameFn(targetDir, backupDir);
    renameFn(staged.stagingDir, targetDir);
    rmSync(backupDir, { recursive: true, force: true });
  } catch (err) {
    try {
      if (hadExisting && !existsSync(targetDir) && existsSync(backupDir)) {
        renameFn(backupDir, targetDir);
      }
      rmSync(staged.stagingDir, { recursive: true, force: true });
    } catch {
      // Best effort — the staging/backup sweep at the next deploy collects
      // whatever this leaves behind.
    }
    await restartBestEffort(deps, serverId, progress);
    return fail("COPY_FAILED", err instanceof Error ? err.message : String(err));
  }
  progress({ step: "copy-files", status: "completed", message: "Plugin files in place" });

  // --- write-config ---
  progress({ step: "write-config", status: "running", message: "Registering the plugin" });
  const written = writeServerJson(record.volumePath, config, (raw) => {
    const installed = new Set(config.installedPlugins);
    installed.add(slug);
    raw["installed_plugins"] = [...installed];
    if (options.consentUnsigned === true) {
      const settings =
        typeof raw["settings"] === "object" && raw["settings"] !== null && !Array.isArray(raw["settings"])
          ? (raw["settings"] as Record<string, unknown>)
          : {};
      settings["allow_unsigned_plugins"] = true;
      raw["settings"] = settings;
    }
  });
  if (!written.ok) {
    await restartBestEffort(deps, serverId, progress);
    return fail("CONFIG_WRITE_FAILED", written.message);
  }
  progress({ step: "write-config", status: "completed", message: "Plugin registered with the server" });

  // --- start-container ---
  progress({ step: "start-container", status: "running", message: "Starting the server" });
  let containerId: string;
  try {
    containerId = await deps.startServerContainer(serverId);
  } catch (err) {
    return fail("CONTAINER_START_FAILED", err instanceof Error ? err.message : String(err));
  }
  progress({ step: "start-container", status: "completed", message: "Server starting" });

  // --- wait-health ---
  progress({ step: "wait-health", status: "running", message: "Waiting for the server to come up" });
  const healthy = await waitForHealth(record.hostPort, deps, fetchFn);
  if (!healthy) {
    return fail("HEALTH_TIMEOUT", "The server did not become healthy in time. Check its logs — the plugin files are installed and will load once it boots.");
  }
  progress({ step: "wait-health", status: "completed", message: "Server is up" });

  // --- verify-plugin ---
  progress({ step: "verify-plugin", status: "running", message: "Checking the plugin loaded" });
  let pluginStatus: "ready" | "starting" | "unknown" = "unknown";
  try {
    const token = await deps.getAdminToken(serverId);
    if (token !== null) {
      const res = await fetchFn(`http://127.0.0.1:${String(record.hostPort)}/admin/api/plugins`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        const body = (await res.json()) as { plugins?: AdminPluginRow[] } | AdminPluginRow[];
        const rows = Array.isArray(body) ? body : (body.plugins ?? []);
        const row = rows.find((r) => r.slug === slug);
        if (row === undefined || row.statusLabel === "quarantined" || row.statusLabel === "stopped") {
          return fail(
            "PLUGIN_FAILED_TO_LOAD",
            row === undefined
              ? "The server is up but did not load the plugin — check the manifest and the server's plugin panel."
              : `The server is up but the plugin is ${row.statusLabel} — check its logs in the plugin panel.`,
          );
        }
        pluginStatus = row.statusLabel === "ready" ? "ready" : "starting";
      }
    }
  } catch {
    // Central or admin API unreachable — deployed but unconfirmed; that is a
    // degraded SUCCESS, not a failure.
    pluginStatus = "unknown";
  }
  progress({
    step: "verify-plugin",
    status: pluginStatus === "unknown" ? "warning" : "completed",
    message:
      pluginStatus === "unknown"
        ? "Installed — couldn't confirm plugin status (Central unreachable)"
        : `Plugin is ${pluginStatus}`,
  });

  progress({ step: "done", status: "completed", message: "Install complete" });
  return { ok: true, containerId, pluginStatus };
}

/** After the container is stopped, every failure path must still try to give
 *  the user their server back — a failed plugin copy must not strand a dead
 *  server. */
async function restartBestEffort(
  deps: DeployDeps,
  serverId: string,
  progress: (e: DeployProgressEvent) => void,
): Promise<void> {
  try {
    await deps.startServerContainer(serverId);
    progress({ step: "start-container", status: "warning", message: "Install failed — server restarted without changes" });
  } catch (err) {
    progress({
      step: "start-container",
      status: "warning",
      message: "Install failed AND the server could not be restarted — start it from the app",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

async function waitForHealth(hostPort: number, deps: DeployDeps, fetchFn: typeof fetch): Promise<boolean> {
  const timeoutMs = deps.healthTimeoutMs ?? 60_000;
  const pollMs = deps.healthPollIntervalMs ?? 1_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetchFn(`http://127.0.0.1:${String(hostPort)}/health`, {
        signal: AbortSignal.timeout(3_000),
      });
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Undeploy
// ---------------------------------------------------------------------------

export async function undeployDevPlugin(
  slug: string,
  serverId: string,
  options: { deleteData: boolean },
  deps: DeployDeps,
): Promise<UndeployOutcome> {
  if (!tryAcquireServerLifecycle(serverId)) {
    return {
      ok: false,
      code: "DEPLOY_IN_PROGRESS",
      message:
        "Another operation (install, runtime update, or server rebuild) is already running for this server.",
    };
  }
  try {
    const record = deps.getServerRecord(serverId);
    if (record === null) return { ok: false, code: "SERVER_NOT_FOUND", message: "That server is not hosted on this machine." };
    if (RESERVED_PLUGIN_SLUGS.has(slug)) {
      return { ok: false, code: "SLUG_RESERVED", message: "Core plugins can't be uninstalled this way." };
    }
    const dockerStatus = await deps.getDockerStatus();
    if (!dockerStatus.running) return { ok: false, code: "DOCKER_NOT_RUNNING", message: "Docker is not running." };

    const configResult = readServerJson(record.volumePath);
    if (!configResult.ok) return { ok: false, code: "CONFIG_READ_FAILED", message: configResult.message };

    await deps.removeContainer(record.containerId);

    const written = writeServerJson(record.volumePath, configResult.file, (raw) => {
      raw["installed_plugins"] = configResult.file.installedPlugins.filter((s) => s !== slug);
    });
    if (!written.ok) {
      await deps.startServerContainer(serverId).catch(() => undefined);
      return { ok: false, code: "CONFIG_WRITE_FAILED", message: written.message };
    }

    // File removal happens with the container stopped — a throw here (e.g.
    // EPERM from a scanner holding a handle on Windows) must not strand the
    // server stopped: restart it and report, exactly like the config-write
    // failure branch. force:true already swallows ENOENT.
    const removePathFn =
      deps.removePathFn ?? ((p: string) => rmSync(p, { recursive: true, force: true }));
    try {
      removePathFn(join(record.volumePath, "plugins", slug));
      if (options.deleteData) {
        // The plugin's SQLite + uploads. Left intact by default so a redeploy
        // picks up where it left off.
        removePathFn(join(record.volumePath, "data", "plugins", slug));
      }
    } catch (err) {
      console.error("[plugin-dev] undeploy file removal failed", { slug, serverId, err });
      await deps.startServerContainer(serverId).catch(() => undefined);
      return {
        ok: false,
        code: "UNINSTALL_FAILED",
        message: `Could not remove the plugin's files: ${err instanceof Error ? err.message : String(err)}. The server was restarted.`,
      };
    }

    let containerId: string;
    try {
      containerId = await deps.startServerContainer(serverId);
    } catch (err) {
      return { ok: false, code: "CONTAINER_START_FAILED", message: err instanceof Error ? err.message : String(err) };
    }
    return { ok: true, containerId };
  } finally {
    releaseServerLifecycle(serverId);
  }
}
