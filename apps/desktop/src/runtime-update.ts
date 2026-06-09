// Orchestrator-side update state machine for a single runtime container.
// Implements the sequence in .claude/docs/prod-docs/phase-01/runtime-lifecycle.md
// §8.1 (happy path) and §9.1 (rollback). Per O8/D3 the runtime is a passive
// store + broadcaster; this module is the active driver that POSTs each
// state transition into the runtime so connected clients see the right pill.
//
// Flow (happy path):
//   backing-up   → createPreUpdateBackup           (skipped if backupBeforeUpdate=false)
//   downloading  → docker pull <targetImage>
//   downloaded   → cosign verify + extract material
//   installing   → POST update-state {installing}  (runtime begins drain)
//                  docker stop --time graceSeconds <oldContainer>
//                  docker tag :latest :previous
//                  docker tag :targetImage :latest
//                  recreate container (passes verified signature material)
//                  poll /ready until 200 or readyPollTimeoutMs
//   idle (commit)→ POST update-state {idle, currentVersion: targetVersion}
//                  rotate backups (drop oldest beyond backupRetention)
//
// Flow (rollback): triggered by /ready failure during installing OR by an
//   exception inside the swap. Reuses the same primitives in reverse:
//     rolling-back → POST update-state
//                    docker stop new container
//                    docker tag :previous :latest
//                    restorePreUpdateBackup (if a backup exists)
//                    recreate container at :latest (= prior version)
//                    poll /ready until 200
//     idle         → POST update-state {idle, currentVersion: priorVersion,
//                                        errorMessage: "Update to X.Y.Z failed; rolled back"}
//   On rollback failure → POST update-state {error, errorContext: "rollback"}
//   and surface to operator (per §9.3 — no further auto-recovery).
//
// The module owns no I/O directly: every docker / fetch / fs touchpoint is
// injected via {@link RuntimeUpdateIo}. That keeps the unit pure for tests
// and lets main.ts wire the production primitives without this file growing
// implicit dependencies on Electron-only modules.

import type { CosignSignatureMaterial } from "./cosign-verify";
import { pullAndVerify, PullPhaseError } from "./pull-verify";
import type { PreUpdateBackup } from "./runtime-backup";

export type RuntimeUpdateChannel = "stable" | "test" | "dev";

/** Phase identifier used in error outcomes — matches RuntimeUpdateErrorContext
 *  on the runtime side so clients render the right copy from update-ux.md §4.4. */
export type RuntimeUpdatePhase =
  | "check"
  | "backup"
  | "download"
  | "install"
  | "rollback";

export interface UpdateStatePatch {
  state:
    | "checking" | "available" | "pending-confirm"
    | "backing-up" | "downloading" | "downloaded" | "awaiting-restart"
    | "installing" | "rolling-back" | "idle" | "error" | "up-to-date";
  errorContext?: RuntimeUpdatePhase | null;
  currentVersion?: string;
  availableVersion?: string | null;
  channel?: RuntimeUpdateChannel;
  progress?: number | null;
  errorMessage?: string | null;
  lastCheckedAt?: number | null;
  /** Optional one-line phase detail (e.g. "Draining traffic"). The runtime
   *  truncates at 200 chars and broadcasts as part of the same WS frame as
   *  `state`. Pass `null` to clear an earlier substep without changing the
   *  phase. Older runtimes silently drop unknown fields. */
  substep?: string | null;
}

export interface ReadyResponse {
  ready: boolean;
  reason?: string;
  version?: string;
}

/** All side-effecting operations the state machine performs. Production main.ts
 *  wires these to docker.ts / cosign-verify.ts / runtime-backup.ts; tests
 *  pass mocks. Keeping the interface narrow forces the production code to
 *  go through these named seams (good for observability) and keeps the test
 *  surface small. */
export interface RuntimeUpdateIo {
  pullImage: (image: string, onProgress: (line: string) => void) => Promise<void>;
  imageExists: (image: string) => Promise<boolean>;
  tagImage: (source: string, target: string) => Promise<void>;
  stopContainer: (id: string, graceSeconds: number) => Promise<void>;
  removeContainer: (id: string) => Promise<void>;
  /** Recreate the container at the given image. Returns the new container id.
   *  Caller (production) wraps removeIfExists + runServerContainer. The
   *  signature material is forwarded to the runtime's RUNTIME_IMAGE_DIGEST/
   *  PAYLOAD/SIGNATURE envs for boot-time re-verification (§2.2, §10). */
  recreateContainer: (
    image: string,
    signature: CosignSignatureMaterial | undefined,
  ) => Promise<string>;
  /** Cosign verify + signature material extraction. Throws on failure. */
  verifyAndExtract: (image: string) => Promise<CosignSignatureMaterial>;
  /** POST a state patch to the runtime's /admin/api/update-state endpoint.
   *  The runtime persists + broadcasts; this function returns once it's
   *  acknowledged. Errors during the swap window (container stopping) are
   *  expected and should be tolerated by the caller — see {@link postWithTolerance}. */
  postUpdateState: (patch: UpdateStatePatch) => Promise<void>;
  /** Fetch /ready and return parsed body. Throws on network error or non-2xx
   *  with a parsable body — caller's poll loop interprets that as "not ready
   *  yet" rather than a hard failure. */
  fetchReady: () => Promise<ReadyResponse>;
  createBackup: () => Promise<PreUpdateBackup>;
  restoreBackup: (backupDir: string) => Promise<void>;
  rotateBackups: (keep: number) => Promise<string[]>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** Resolves when the user clicks "Restart to apply update" in the runtime
   *  panel. The gate sits between download+verify (downloaded) and the
   *  irreversible install phase. Rejects with {@link RestartCancelledError}
   *  if the orchestrator decides to abort (e.g. app quit while pending).
   *
   *  Hard pause: there is no implicit timeout — the runtime stays in
   *  `awaiting-restart` indefinitely. The orchestrator may inject a deferred
   *  promise that never resolves on its own; only user action or cancel
   *  resolves/rejects it. */
  restartConfirmed: () => Promise<void>;
}

/** Thrown via the `restartConfirmed` deferred when the orchestrator decides
 *  to abandon the staged update (currently: app quit while sitting in
 *  `awaiting-restart`). The state machine treats this as a soft cancel:
 *  posts `state: "available"` and returns a `download` phase failure with
 *  rolledBack=false so the operator can re-trigger later. */
export class RestartCancelledError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "RestartCancelledError";
  }
}

export interface RuntimeUpdateLog {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
}

export interface RuntimeUpdateOptions {
  /** Image tag the orchestrator hands to the next `docker run`. Always
   *  `:latest` after the swap dance — the actual bytes are whatever we
   *  tagged into `:latest` from the target version tag. */
  latestImage: string;
  /** Image tag for the rollback target. Always `:previous` — orchestrator
   *  re-tags the current `:latest` to this before swapping in the new
   *  bytes. */
  previousImage: string;
  /** Image tag of the version being installed (e.g. uncorded-runtime:0.2.0).
   *  Must be locally pullable. */
  targetImage: string;
  /** RUNTIME_VERSION the running container reports today, used for the
   *  rollback "currentVersion" write and operator-facing error copy. */
  currentVersion: string;
  /** RUNTIME_VERSION baked into targetImage. Used for the post-swap
   *  "currentVersion" write. */
  targetVersion: string;
  channel: RuntimeUpdateChannel;
  /** Container id about to be replaced. */
  containerId: string;
  /** Whether to snapshot /data + /config before swap. Per O3 the operator
   *  toggle defaults ON; the caller respects the per-server preference. */
  backupBeforeUpdate: boolean;
  /** docker stop --time grace; mirrors RUNTIME_DRAIN_GRACE_SECONDS. */
  graceSeconds: number;
  /** Total budget for /ready polling after the swap. §8.1 / §14 default 90s. */
  readyPollTimeoutMs: number;
  /** Pause between /ready GETs while polling. */
  readyPollIntervalMs: number;
  /** Pre-update backups to keep around after a successful update (per §7.3
   *  default 3). Failed updates skip rotation so the operator can diagnose. */
  backupRetention: number;
  /** Skip the cosign verify step. Set when the orchestrator detects the
   *  embedded pubkey is empty (pre-first-release seed state — see
   *  runtime/src/signing/cosign-pubkey.ts). The container is then started
   *  without RUNTIME_IMAGE_DIGEST/_PAYLOAD/_SIGNATURE envs; the runtime
   *  tolerates absence iff its embedded pubkey is also empty. */
  skipVerification?: boolean;
}

export interface RuntimeUpdateDeps {
  io: RuntimeUpdateIo;
  log: RuntimeUpdateLog;
  options: RuntimeUpdateOptions;
}

export type RuntimeUpdateOutcome =
  | {
      ok: true;
      /** Final RUNTIME_VERSION the runtime reports — equal to targetVersion
       *  in the happy path, equal to currentVersion if rolled back. */
      version: string;
      /** New container id. */
      containerId: string;
      /** Cosign material verified for the bytes now under `:latest`. Caller
       *  persists to the registry so launch-time rebuilds re-supply
       *  RUNTIME_IMAGE_* envs. Undefined when verify was skipped (seed-state
       *  pubkey absent — see options.skipVerification). */
      signature: CosignSignatureMaterial | undefined;
      rolledBack: false;
    }
  | {
      ok: false;
      /** Failure phase — maps 1:1 to RuntimeUpdateErrorContext. */
      phase: RuntimeUpdatePhase;
      reason: string;
      /** Whether rollback was attempted (only true for install-phase failures). */
      rolledBack: boolean;
      /** Whether rollback succeeded (only present when rolledBack=true). */
      rollbackOk?: boolean;
      /** New container id if a container was successfully started — either
       *  the prior-version container (after rollback) or undefined (no
       *  container running, operator must intervene). */
      containerId?: string;
      version?: string;
    };

const PROGRESS_BUCKET_SIZE = 10;

export function clampProgress(percent: number): number {
  if (!Number.isFinite(percent)) return 0;
  if (percent < 0) return 0;
  if (percent > 100) return 100;
  // 10% buckets per §12 to bound broadcast frequency on slow links.
  return Math.floor(percent / PROGRESS_BUCKET_SIZE) * PROGRESS_BUCKET_SIZE;
}

/** Parse a `docker pull` progress line and extract a 0..100 percent if one
 *  is present. Docker emits per-layer progress that's noisy; we only act on
 *  the rare lines that carry an explicit "Pulling fs layer", "Downloading"
 *  with `[==> ] 12.34MB/45.67MB`, or "Pull complete" markers. Returning
 *  null means "no progress info — don't broadcast". */
export function extractPullPercent(line: string): number | null {
  const match = line.match(/(\d+(?:\.\d+)?)([KMG]?B)\s*\/\s*(\d+(?:\.\d+)?)([KMG]?B)/);
  if (!match) return null;
  const num = (raw: string, unit: string): number => {
    const v = Number(raw);
    if (!Number.isFinite(v)) return 0;
    if (unit === "KB") return v * 1024;
    if (unit === "MB") return v * 1024 * 1024;
    if (unit === "GB") return v * 1024 * 1024 * 1024;
    return v;
  };
  const numerator = num(match[1] ?? "0", match[2] ?? "B");
  const denominator = num(match[3] ?? "0", match[4] ?? "B");
  if (denominator === 0) return null;
  return (numerator / denominator) * 100;
}

/** Best-effort POST that swallows network errors. The runtime stops accepting
 *  HTTP connections at the bottom of its drain (and is fully gone during the
 *  container swap), so postUpdateState calls during those windows must not
 *  abort the update — they're inevitably going to fail and the new container
 *  will pick up the persisted state from disk. */
async function postWithTolerance(
  io: RuntimeUpdateIo,
  log: RuntimeUpdateLog,
  patch: UpdateStatePatch,
  context: string,
): Promise<void> {
  try {
    await io.postUpdateState(patch);
  } catch (err) {
    log.warn(`update-state POST tolerated failure (${context})`, {
      err: err instanceof Error ? err.message : String(err),
      patch,
    });
  }
}

/** Poll /ready until it returns ready=true or the deadline elapses. Returns
 *  the last-seen response (or a synthesized `ready=false` if every poll
 *  threw). Tolerates network errors during the early swap window — the new
 *  container takes a few seconds to bind its HTTP socket, so initial ECONNREFUSED
 *  is expected. */
async function pollUntilReady(
  io: RuntimeUpdateIo,
  log: RuntimeUpdateLog,
  options: RuntimeUpdateOptions,
): Promise<{ ready: boolean; lastReason: string; version?: string }> {
  const deadline = io.now() + options.readyPollTimeoutMs;
  let lastReason = "no response";
  let lastVersion: string | undefined;
  while (io.now() < deadline) {
    try {
      const r = await io.fetchReady();
      lastVersion = r.version;
      if (r.ready) {
        return { ready: true, lastReason: "ready", ...(r.version !== undefined ? { version: r.version } : {}) };
      }
      lastReason = r.reason ?? "not-ready";
    } catch (err) {
      lastReason = err instanceof Error ? err.message : String(err);
      log.info("ready poll attempt failed (expected during swap)", { reason: lastReason });
    }
    await io.sleep(options.readyPollIntervalMs);
  }
  return { ready: false, lastReason, ...(lastVersion !== undefined ? { version: lastVersion } : {}) };
}

/**
 * Drive a single runtime container through the orchestrator-side update
 * state machine. This is a long-running async function — typical happy-path
 * runtime is dominated by `docker pull` (10s–10min depending on registry)
 * and the post-swap /ready wait (sub-second to ~30s).
 *
 * Caller (main.ts) is responsible for:
 *  - acquiring the operator's confirm-typed-UPDATE gesture and writing
 *    `pending-confirm` to the runtime BEFORE invoking this function;
 *  - persisting the new containerId returned in the outcome (for the
 *    server-registry envelope);
 *  - showing the operator the failure copy from update-ux.md §4.4 for
 *    error outcomes.
 */
export async function performUpdate(deps: RuntimeUpdateDeps): Promise<RuntimeUpdateOutcome> {
  const { io, log, options } = deps;
  log.info("update: start", {
    currentVersion: options.currentVersion,
    targetVersion: options.targetVersion,
    targetImage: options.targetImage,
    backup: options.backupBeforeUpdate,
  });

  // ── Phase: backing-up ──────────────────────────────────────────────────
  let backup: PreUpdateBackup | null = null;
  if (options.backupBeforeUpdate) {
    await postWithTolerance(io, log, {
      state: "backing-up",
      errorContext: null,
      progress: null,
      substep: "Snapshotting state directory",
    }, "backing-up");
    try {
      backup = await io.createBackup();
      log.info("update: backup complete", { dir: backup.dir });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log.error("update: backup failed", { reason });
      await postWithTolerance(io, log, {
        state: "error",
        errorContext: "backup",
        errorMessage: `Pre-update backup failed: ${reason}`,
      }, "backup-failed");
      return { ok: false, phase: "backup", reason, rolledBack: false };
    }
  }

  // ── Phase: downloading + downloaded (verify) ───────────────────────────
  await postWithTolerance(io, log, {
    state: "downloading",
    errorContext: null,
    progress: 0,
    substep: `Pulling ${options.targetImage}`,
  }, "downloading-start");
  let signatureMaterial: CosignSignatureMaterial | undefined;
  try {
    let lastBucket = -1;
    const result = await pullAndVerify(
      {
        sourceImage: options.targetImage,
        ...(options.skipVerification ? { skipVerify: true } : {}),
        onPullProgress: (line) => {
          const pct = extractPullPercent(line);
          if (pct === null) return;
          const bucket = clampProgress(pct);
          if (bucket === lastBucket) return;
          lastBucket = bucket;
          // Fire-and-forget — broadcasts are observational, not gating.
          void postWithTolerance(io, log, {
            state: "downloading",
            progress: bucket,
          }, `downloading-${String(bucket)}`);
        },
      },
      {
        pullImage: io.pullImage,
        verifyAndExtract: io.verifyAndExtract,
        onPullComplete: () =>
          postWithTolerance(io, log, {
            state: "downloaded",
            progress: 100,
            substep: "Verifying signature",
          }, "downloaded"),
        log,
      },
    );
    signatureMaterial = result.signature;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const isPullPhase = err instanceof PullPhaseError;
    const errorMessage = isPullPhase
      ? `Image pull failed: ${reason}`
      : `Signature verification failed: ${reason}`;
    log.error(isPullPhase ? "update: pull failed" : "update: cosign verify failed", { reason });
    await postWithTolerance(io, log, {
      state: "error",
      errorContext: "download",
      errorMessage,
    }, isPullPhase ? "download-failed" : "verify-failed");
    return { ok: false, phase: "download", reason, rolledBack: false };
  }

  // ── Phase: awaiting-restart (deliberate gate) ──────────────────────────
  // The bytes are on disk, the signature is verified — but the install phase
  // is irreversible (drains WS, stops the container). We do NOT auto-progress.
  // The user must click "Restart to apply update" in the panel; that gesture
  // resolves io.restartConfirmed(). On cancel (RestartCancelledError) we soft-
  // back-out to `available` so the operator can re-trigger.
  await postWithTolerance(io, log, {
    state: "awaiting-restart",
    errorContext: null,
    progress: null,
    substep: "Ready to restart",
  }, "awaiting-restart");
  try {
    await io.restartConfirmed();
    log.info("update: restart confirmed");
  } catch (err) {
    if (err instanceof RestartCancelledError) {
      const reason = err.message || "Restart cancelled by orchestrator";
      log.warn("update: restart gate cancelled — backing out to available", { reason });
      await postWithTolerance(io, log, {
        state: "available",
        availableVersion: options.targetVersion,
        progress: null,
        substep: null,
        errorContext: null,
        errorMessage: null,
      }, "restart-cancelled");
      return { ok: false, phase: "download", reason, rolledBack: false };
    }
    throw err;
  }

  // ── Phase: installing (drain → swap → poll-ready) ──────────────────────
  await postWithTolerance(io, log, {
    state: "installing",
    errorContext: null,
    progress: null,
    substep: "Draining traffic",
  }, "installing");

  // Stop with the configured grace so the runtime's drain (triggered by
  // receiving state="installing" via WS) gets to negotiate with clients
  // before SIGKILL.
  let newContainerId: string;
  try {
    await postWithTolerance(io, log, {
      state: "installing",
      substep: "Stopping container",
    }, "installing-stop");
    await io.stopContainer(options.containerId, options.graceSeconds);
    // Atomic image swap via tags. tagImage(:latest → :previous) MUST happen
    // before tagImage(target → :latest) — otherwise we'd lose the rollback
    // anchor if the second tag races with anything.
    await postWithTolerance(io, log, {
      state: "installing",
      substep: "Swapping image",
    }, "installing-swap");
    if (await io.imageExists(options.latestImage)) {
      await io.tagImage(options.latestImage, options.previousImage);
    }
    await io.tagImage(options.targetImage, options.latestImage);
    await postWithTolerance(io, log, {
      state: "installing",
      substep: "Starting new container",
    }, "installing-start");
    newContainerId = await io.recreateContainer(options.latestImage, signatureMaterial);
    log.info("update: container recreated", { containerId: newContainerId });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.error("update: swap failed mid-flight", { reason });
    return await runRollback(deps, {
      reason,
      backup,
      newContainerId: undefined,
    });
  }

  // Poll the new container's /ready. New process is booting + loading plugins;
  // we expect ECONNREFUSED for the first couple of polls before the HTTP
  // socket binds.
  const ready = await pollUntilReady(io, log, options);
  if (!ready.ready) {
    log.error("update: post-swap /ready never returned 200", { lastReason: ready.lastReason });
    return await runRollback(deps, {
      reason: `post-swap readiness timeout: ${ready.lastReason}`,
      backup,
      newContainerId,
    });
  }

  // ── Phase: idle (commit) ───────────────────────────────────────────────
  // The new container booted and is already broadcasting state="installing"
  // to clients (because that's what's persisted on disk). Write idle so
  // they switch to the green pill.
  await postWithTolerance(io, log, {
    state: "idle",
    errorContext: null,
    currentVersion: options.targetVersion,
    availableVersion: null,
    progress: null,
    errorMessage: null,
  }, "idle-commit");

  // Rotate stale backups — only after success (per §7.3 "Failed updates'
  // backups are retained until the next successful update so the operator
  // can diagnose").
  try {
    const removed = await io.rotateBackups(options.backupRetention);
    if (removed.length > 0) {
      log.info("update: rotated stale backups", { count: removed.length });
    }
  } catch (err) {
    log.warn("update: backup rotation failed (non-fatal)", {
      err: err instanceof Error ? err.message : String(err),
    });
  }

  log.info("update: complete", {
    version: options.targetVersion,
    containerId: newContainerId,
  });
  return {
    ok: true,
    version: options.targetVersion,
    containerId: newContainerId,
    signature: signatureMaterial,
    rolledBack: false,
  };
}

interface RollbackInputs {
  reason: string;
  backup: PreUpdateBackup | null;
  /** Container id of the failed new-version container, if it managed to
   *  start. We stop+remove it before swapping back to :previous. */
  newContainerId: string | undefined;
}

async function runRollback(
  deps: RuntimeUpdateDeps,
  inputs: RollbackInputs,
): Promise<RuntimeUpdateOutcome> {
  const { io, log, options } = deps;
  log.warn("update: entering rollback", { reason: inputs.reason });

  await postWithTolerance(io, log, {
    state: "rolling-back",
    errorContext: "install",
    errorMessage: `Update to ${options.targetVersion} failed; rolling back`,
    progress: null,
  }, "rolling-back-start");

  // Tear down whatever the new-version container managed to start, then
  // restore :previous and the snapshot. We tolerate stop/remove failures —
  // if the container is already gone we're fine; if it's stuck the
  // subsequent recreate will fail with a clearer error and we'll surface
  // error/rollback.
  try {
    if (inputs.newContainerId) {
      try { await io.stopContainer(inputs.newContainerId, 0); } catch (e) {
        log.warn("rollback: stop new container failed (continuing)", {
          err: e instanceof Error ? e.message : String(e),
        });
      }
      try { await io.removeContainer(inputs.newContainerId); } catch (e) {
        log.warn("rollback: remove new container failed (continuing)", {
          err: e instanceof Error ? e.message : String(e),
        });
      }
    }

    // Re-tag the previous image as :latest so recreate brings up the prior
    // bytes. If :previous doesn't exist (first ever update, theoretically
    // unreachable but check), this is a hard failure — we have nothing to
    // roll back to.
    if (!(await io.imageExists(options.previousImage))) {
      throw new Error(`rollback target ${options.previousImage} not present locally`);
    }
    await io.tagImage(options.previousImage, options.latestImage);

    // Restore the snapshot before launching the prior container so the
    // prior runtime sees the state it expected.
    if (inputs.backup) {
      await io.restoreBackup(inputs.backup.dir);
      log.info("rollback: restored snapshot", { dir: inputs.backup.dir });
    }

    const restoredId = await io.recreateContainer(options.latestImage, undefined);
    log.info("rollback: container recreated at prior version", { containerId: restoredId });

    const ready = await pollUntilReady(io, log, options);
    if (!ready.ready) {
      throw new Error(`prior-version /ready timeout after rollback: ${ready.lastReason}`);
    }

    // Final commit — runtime is up at the prior version, write idle with
    // the operator-facing explanation.
    await postWithTolerance(io, log, {
      state: "idle",
      errorContext: null,
      currentVersion: options.currentVersion,
      availableVersion: options.targetVersion,
      progress: null,
      errorMessage: `Update to ${options.targetVersion} failed; rolled back successfully. Reason: ${inputs.reason}`,
    }, "rolled-back-idle");

    log.info("update: rolled back successfully", {
      version: options.currentVersion,
      containerId: restoredId,
    });
    return {
      ok: false,
      phase: "install",
      reason: inputs.reason,
      rolledBack: true,
      rollbackOk: true,
      containerId: restoredId,
      version: options.currentVersion,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.error("update: rollback itself failed", { reason });
    await postWithTolerance(io, log, {
      state: "error",
      errorContext: "rollback",
      errorMessage: `Rollback failed: ${reason}. Manual recovery required (see runbook).`,
    }, "rollback-failed");
    return {
      ok: false,
      phase: "rollback",
      reason,
      rolledBack: true,
      rollbackOk: false,
    };
  }
}
