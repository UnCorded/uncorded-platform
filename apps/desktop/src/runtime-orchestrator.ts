// Orchestrator wrapper around runtime-update.ts:performUpdate.
//
// Wires the production I/O (docker.ts, cosign-verify.ts, runtime-backup.ts,
// server-registry, secret-store, runtime-releases.ts) into the pure
// state-machine driver in runtime-update.ts. Keeps that driver dependency-
// free so its unit tests can pass synthetic mocks; this module is the
// single place where Electron-only modules and the state machine meet.
//
// Per D3 / O8 the orchestrator is the active driver — it pulls images,
// swaps containers, persists transitions to the runtime via HTTP, and
// updates the local server-registry with the new container id. The
// runtime is a passive store + broadcaster; clients see every transition
// over WS regardless of which orchestrator wrote it.

import { randomBytes } from "node:crypto";
import { CosignError, type CosignSignatureMaterial, verifyAndExtractMaterial } from "./cosign-verify";
import { pullAndVerify, PullPhaseError } from "./pull-verify";
import {
  encryptionSecretKey,
  getSecret,
  setSecret,
  tunnelSecretKey,
} from "./desktop-secrets";
import * as docker from "./docker";
import { recreateContainerForServer } from "./recreate-container";
import { removeIfExists, runServerContainer, SERVER_IMAGE } from "./server-runtime";
import {
  createPreUpdateBackup,
  restorePreUpdateBackup,
  rotateBackups,
} from "./runtime-backup";
import {
  performUpdate,
  RestartCancelledError,
  type RuntimeUpdateChannel,
  type RuntimeUpdateIo,
  type RuntimeUpdateLog,
  type RuntimeUpdateOptions,
  type RuntimeUpdateOutcome,
  type UpdateStatePatch,
} from "./runtime-update";
import { resolveLatestVersion } from "./runtime-releases";
import {
  getServerRecord,
  registerServer,
  type ServerRecord,
} from "./server-registry";
import * as central from "./central";
// Mirror of `runtime/src/signing/cosign-pubkey.ts`. Duplicated rather than
// imported across rootDir boundaries (runtime/ ships in the container image
// and has its own tsconfig). Both copies are empty strings during the seed
// period before the first signed release; when the runtime copy is rotated
// per `reference_release_pipeline.md`, the next desktop release MUST mirror
// the same PEM here. The `release-desktop.yml` workflow has a check that
// fails the build if these two files diverge — see scripts/check-cosign-
// pubkey-sync.cjs.
const COSIGN_PUBKEY_PEM = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEzDGdgkP7NvdQjkoGYzvJIQhxfMjQ
PiyRqQJL06K/JWuUpdGdmPlbuv301ggmnX4iPyBHF6KfYskKrUeJrAaS3w==
-----END PUBLIC KEY-----
`;
function isCosignPubkeyEmbedded(): boolean {
  return COSIGN_PUBKEY_PEM.trim().length > 0;
}

// GHCR-published runtime image (per O4.1 in decisions.md). The orchestrator
// pulls `<REGISTRY_BASE>:<version>` and re-tags it locally to SERVER_IMAGE
// for the swap dance — server-runtime.ts only ever speaks the local tag.
const REGISTRY_BASE = "ghcr.io/uncorded/runtime";

const PREVIOUS_IMAGE = "uncorded-runtime:previous";
const DRAIN_GRACE_SECONDS = 30;
const READY_POLL_TIMEOUT_MS = 90_000;
const READY_POLL_INTERVAL_MS = 1_500;
const BACKUP_RETENTION = 3;

// One Deferred per server sitting at the `awaiting-restart` gate. Resolved
// by `confirmRestartForServer(serverId)` (wired to the IPC the renderer
// fires when the user clicks "Restart to apply update"); rejected by
// `cancelPendingRestarts()` on app quit so the orchestrator can soft-back-out
// to `available` instead of leaving the runtime stuck in `awaiting-restart`.
interface PendingRestart {
  resolve: () => void;
  reject: (err: Error) => void;
}
const pendingRestarts = new Map<string, PendingRestart>();

/** Called by main.ts's IPC handler when the user clicks "Restart to apply
 *  update". No-op if no update is currently sitting at the gate. */
export function confirmRestartForServer(serverId: string): boolean {
  const pending = pendingRestarts.get(serverId);
  if (!pending) return false;
  pendingRestarts.delete(serverId);
  pending.resolve();
  return true;
}

/** Called from main.ts's `before-quit`. Rejects every pending restart so the
 *  state machine can post `state: "available"` and exit cleanly instead of
 *  leaving runtimes stuck at `awaiting-restart` across app restarts. */
export function cancelPendingRestarts(reason = "Application is quitting"): void {
  for (const [serverId, pending] of pendingRestarts) {
    pendingRestarts.delete(serverId);
    pending.reject(new RestartCancelledError(reason));
  }
}

export interface RuntimeUpdatePreferences {
  channel: RuntimeUpdateChannel;
  backupBeforeUpdate: boolean;
}

export interface OrchestratorDeps {
  log?: RuntimeUpdateLog;
  /** Test seam: pluggable fetch for the GitHub Releases call + runtime HTTP
   *  posts. Production injects global fetch. */
  fetchImpl?: typeof fetch;
}

function defaultDeps(): Required<OrchestratorDeps> {
  return {
    log: {
      info: (msg, meta) => console.info(`[runtime-update] ${msg}`, meta ?? {}),
      warn: (msg, meta) => console.warn(`[runtime-update] ${msg}`, meta ?? {}),
      error: (msg, meta) => console.error(`[runtime-update] ${msg}`, meta ?? {}),
    },
    fetchImpl: fetch,
  };
}

interface RuntimeStateResponse {
  state: string;
  errorContext: string | null;
  currentVersion: string;
  availableVersion: string | null;
  channel: RuntimeUpdateChannel;
  progress: number | null;
  lastCheckedAt: number | null;
  errorMessage: string | null;
  updatedAt: number;
}

async function runtimeBaseUrl(record: ServerRecord): Promise<string> {
  return `http://localhost:${String(record.hostPort)}`;
}

async function authHeader(serverId: string): Promise<string> {
  const { token } = await central.getServerToken(serverId);
  return `Bearer ${token}`;
}

async function postUpdateState(
  baseUrl: string,
  authorization: string,
  patch: UpdateStatePatch,
  fetchImpl: typeof fetch,
): Promise<void> {
  const res = await fetchImpl(`${baseUrl}/admin/api/update-state`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: authorization,
    },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `POST /admin/api/update-state failed: ${String(res.status)} ${body.slice(0, 200)}`,
    );
  }
}

async function getUpdateState(
  baseUrl: string,
  authorization: string,
  fetchImpl: typeof fetch,
): Promise<RuntimeStateResponse> {
  const res = await fetchImpl(`${baseUrl}/admin/api/update-state`, {
    headers: { Authorization: authorization },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `GET /admin/api/update-state failed: ${String(res.status)} ${body.slice(0, 200)}`,
    );
  }
  return (await res.json()) as RuntimeStateResponse;
}

// First-boot helpers ──────────────────────────────────────────────────────
// provision.ts uses these to perform the same pull → cosign-verify → re-tag
// dance that performUpdate uses on every subsequent update. Concentrating
// the GHCR base, embedded pubkey, and SERVER_IMAGE local tag here keeps
// provision.ts free of cosign/registry concerns and ensures both code paths
// stay in lock-step on the security invariants.

export interface FirstBootImageDeps {
  log?: RuntimeUpdateLog;
  /** Test seam for the GitHub Releases call. */
  fetchImpl?: typeof fetch;
  /** Per-line `docker pull` stdout/stderr. Caller surfaces in UI. */
  onPullProgress?: (line: string) => void;
}

export interface FirstBootImageResult {
  /** RUNTIME_VERSION embedded in the resolved image. */
  targetVersion: string;
  /** Fully-qualified registry ref the orchestrator pulled. */
  targetImage: string;
  /** sha256:<hex> when verified, empty string when seed-state skip. */
  digest: string;
  /** Cosign material to forward to runServerContainer's RUNTIME_IMAGE_*
   *  envs for boot-time re-verification. undefined when seed-state. */
  signature: CosignSignatureMaterial | undefined;
}

/** Discriminator for first-boot pull-phase failures (different operator copy
 *  than verify failures). Verify failures bubble as the underlying CosignError. */
export class FirstBootPullError extends Error {
  override readonly name = "FirstBootPullError";
  constructor(message: string, public override readonly cause: unknown) {
    super(message);
  }
}

/**
 * Resolve the newest version on `channel`, pull `<REGISTRY_BASE>:<version>`
 * from GHCR, cosign-verify the bytes against the embedded pubkey, then
 * re-tag the verified image to SERVER_IMAGE so server-runtime.ts (which only
 * speaks the local tag) can run it.
 *
 * Throws:
 *   - `Error("No runtime release published for the X channel yet.")` when
 *     resolveLatestVersion returns null. The caller renders this as a
 *     user-facing "switch channel" hint.
 *   - `FirstBootPullError` on docker pull failures.
 *   - The underlying `CosignError` (typed `.code` field) on verify failures.
 *
 * Skip-verify behavior matches performUpdate: when `isCosignPubkeyEmbedded()`
 * is false (pre-first-release seed period), the helper still pulls + tags,
 * but skips cosign and returns `signature: undefined`. Caller MUST then NOT
 * pass `imageSignature` into `runServerContainer`.
 */
export async function pullVerifyAndTagForFirstBoot(
  args: {
    channel: RuntimeUpdateChannel;
    /** Optional override of the GHCR ref. Set by tests / dev escape hatch. */
    sourceImageOverride?: string;
    /** Optional override of the resolved version (paired with sourceImageOverride). */
    targetVersionOverride?: string;
  },
  deps: FirstBootImageDeps = {},
): Promise<FirstBootImageResult> {
  const merged = { ...defaultDeps(), ...deps };

  let targetImage: string;
  let targetVersion: string;
  if (args.sourceImageOverride && args.targetVersionOverride) {
    targetImage = args.sourceImageOverride;
    targetVersion = args.targetVersionOverride;
  } else {
    const latest = await resolveLatestVersion({
      channel: args.channel,
      currentVersion: "0.0.0",
      fetchImpl: merged.fetchImpl,
    });
    if (latest === null) {
      throw new Error(
        `No runtime release published for the "${args.channel}" channel yet.`,
      );
    }
    targetVersion = latest;
    targetImage = `${REGISTRY_BASE}:${targetVersion}`;
  }

  let result: { digest: string; signature: CosignSignatureMaterial | undefined };
  try {
    result = await pullAndVerify(
      {
        sourceImage: targetImage,
        ...(isCosignPubkeyEmbedded() ? {} : { skipVerify: true }),
        ...(deps.onPullProgress ? { onPullProgress: deps.onPullProgress } : {}),
      },
      {
        pullImage: (image, onProgress) =>
          new Promise<void>((resolve, reject) => {
            docker.pullImage(
              image,
              onProgress,
              () => resolve(),
              (msg) => reject(new Error(msg)),
            );
          }),
        verifyAndExtract: (image) =>
          verifyAndExtractMaterial({ imageRef: image, pubkeyPem: COSIGN_PUBKEY_PEM }),
        log: merged.log,
      },
    );
  } catch (err) {
    if (err instanceof PullPhaseError) {
      throw new FirstBootPullError(err.message, err.cause);
    }
    throw err;
  }

  // Verify-then-tag: only after pullAndVerify resolves do we point the
  // local SERVER_IMAGE tag at the new bytes. This closes the TOCTOU window
  // between verify and the next `docker run`.
  await docker.tagImage(targetImage, SERVER_IMAGE);

  return {
    targetVersion,
    targetImage,
    digest: result.digest,
    signature: result.signature,
  };
}

/** Always `true` on desktop — D3 says orchestrator identity is by capability,
 *  not hardcoded "is-desktop", but the desktop is the only first-class
 *  orchestrator in Phase 01. A future hosted control plane swaps this out. */
export function isOrchestrator(): boolean {
  return true;
}

export async function getPreferencesForServer(
  serverId: string,
  deps: OrchestratorDeps = {},
): Promise<RuntimeUpdatePreferences> {
  const merged = { ...defaultDeps(), ...deps };
  const record = getServerRecord(serverId);
  if (!record) throw new Error(`Unknown server ${serverId}`);

  const baseUrl = await runtimeBaseUrl(record);
  const auth = await authHeader(serverId);
  const state = await getUpdateState(baseUrl, auth, merged.fetchImpl);

  // O3 default-on: undefined OR true → true; only an explicit `false` opts
  // out. Keeps newly-created servers safe even before the user opens the
  // Runtime panel for the first time.
  const backupBeforeUpdate = record.backupBeforeUpdate !== false;

  return {
    channel: state.channel,
    backupBeforeUpdate,
  };
}

export async function setChannelForServer(
  serverId: string,
  channel: RuntimeUpdateChannel,
  deps: OrchestratorDeps = {},
): Promise<void> {
  const record = getServerRecord(serverId);
  if (!record) throw new Error(`Unknown server ${serverId}`);
  await setChannelByEndpoint(serverId, record.hostPort, channel, deps);
}

/** Registry-free variant used by first-boot provisioning, where the server
 *  record isn't written until after provisionServer resolves. The renderer-
 *  driven Settings flow uses {@link setChannelForServer} which looks the
 *  hostPort up from the registry. Both paths funnel into the same runtime
 *  POST so the WS broadcast / persistence semantics are identical. */
export async function setChannelByEndpoint(
  serverId: string,
  hostPort: number,
  channel: RuntimeUpdateChannel,
  deps: OrchestratorDeps = {},
): Promise<void> {
  const merged = { ...defaultDeps(), ...deps };
  const baseUrl = `http://localhost:${String(hostPort)}`;
  const auth = await authHeader(serverId);
  await postUpdateState(baseUrl, auth, { state: "idle", channel }, merged.fetchImpl);
  // No-op on the registry — channel is owned by the runtime side. Listeners
  // will pick up the new channel via the WS broadcast triggered by the POST.
}

export function setBackupBeforeUpdateForServer(
  serverId: string,
  enabled: boolean,
): void {
  const record = getServerRecord(serverId);
  if (!record) throw new Error(`Unknown server ${serverId}`);

  // Persist only when the user opts OUT (false). Storing the default-on
  // value would bloat the registry with redundant rows; absence is the
  // canonical "ON" representation. Re-enabling clears the field.
  const next: ServerRecord = { ...record };
  if (enabled) {
    delete next.backupBeforeUpdate;
  } else {
    next.backupBeforeUpdate = false;
  }
  registerServer(serverId, next);
}

// Surfaced so the renderer can distinguish a successful check (next state
// will arrive via WS broadcast) from a no-op caused by the runtime's 1/30s
// per-server throttle. Mirrors `RuntimeCheckOutcome` in @uncorded/electron-bridge.
export type RuntimeCheckOutcome =
  | { ok: true }
  | { ok: false; reason: "rate-limited" };

export async function checkForUpdate(
  serverId: string,
  deps: OrchestratorDeps = {},
): Promise<RuntimeCheckOutcome> {
  const merged = { ...defaultDeps(), ...deps };
  const record = getServerRecord(serverId);
  if (!record) throw new Error(`Unknown server ${serverId}`);

  const baseUrl = await runtimeBaseUrl(record);
  const auth = await authHeader(serverId);

  // Step 1: ask the runtime to flip state → checking. The rate limiter on
  // the runtime side is the throttle of record (1/30s per server bucket).
  let snapshot: RuntimeStateResponse;
  try {
    const res = await merged.fetchImpl(`${baseUrl}/admin/api/check-update`, {
      method: "POST",
      headers: { Authorization: auth },
    });
    if (res.status === 429) {
      // Rate-limited: don't surface as an error pill — the existing state
      // (probably idle/up-to-date) is fine, the next click will succeed.
      // Returned to the caller so the renderer can show a transient hint
      // instead of leaving the user clicking refresh into the void.
      merged.log.info("check-update rate-limited; ignoring", { serverId });
      return { ok: false, reason: "rate-limited" };
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `POST /admin/api/check-update failed: ${String(res.status)} ${body.slice(0, 200)}`,
      );
    }
    snapshot = (await res.json()) as RuntimeStateResponse;
  } catch (err) {
    // Couldn't even reach the runtime — surface as an error directly.
    merged.log.error("check-update request failed", {
      serverId,
      err: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  // Step 2: resolve the latest published version for this channel and POST
  // the resulting state back. Wrap in a try/catch so any failure (network,
  // parse, GitHub rate limit) becomes an `error` state with errorContext:
  // "check" — the renderer already has copy for that case.
  try {
    const latest = await resolveLatestVersion({
      channel: snapshot.channel,
      currentVersion: snapshot.currentVersion,
      fetchImpl: merged.fetchImpl,
    });
    if (latest === null) {
      await postUpdateState(
        baseUrl,
        auth,
        {
          state: "up-to-date",
          availableVersion: null,
          errorContext: null,
          errorMessage: null,
        },
        merged.fetchImpl,
      );
    } else {
      await postUpdateState(
        baseUrl,
        auth,
        {
          state: "available",
          availableVersion: latest,
          errorContext: null,
          errorMessage: null,
        },
        merged.fetchImpl,
      );
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    merged.log.error("update check failed", { serverId, reason });
    // Best-effort — if even THIS POST fails the runtime stays in "checking"
    // until the next attempt. Acceptable: the operator can click Retry.
    try {
      await postUpdateState(
        baseUrl,
        auth,
        {
          state: "error",
          errorContext: "check",
          errorMessage: `Update check failed: ${reason}`,
        },
        merged.fetchImpl,
      );
    } catch (postErr) {
      merged.log.warn("failed to write check-error state", {
        err: postErr instanceof Error ? postErr.message : String(postErr),
      });
    }
  }
  return { ok: true };
}

export async function performUpdateForServer(
  serverId: string,
  deps: OrchestratorDeps = {},
): Promise<RuntimeUpdateOutcome> {
  const merged = { ...defaultDeps(), ...deps };
  const record = getServerRecord(serverId);
  if (!record) throw new Error(`Unknown server ${serverId}`);

  const baseUrl = await runtimeBaseUrl(record);
  const auth = await authHeader(serverId);
  const snapshot = await getUpdateState(baseUrl, auth, merged.fetchImpl);

  if (snapshot.availableVersion === null) {
    throw new Error("No update available — call checkForUpdate first");
  }
  const targetVersion = snapshot.availableVersion;
  const targetImage = `${REGISTRY_BASE}:${targetVersion}`;

  const backupBeforeUpdate = record.backupBeforeUpdate !== false;
  const tunnelToken = getSecret(tunnelSecretKey(serverId)) ?? undefined;
  let runtimeEncryptionSecret = getSecret(encryptionSecretKey(serverId));
  if (!runtimeEncryptionSecret) {
    runtimeEncryptionSecret = randomBytes(32).toString("hex");
    setSecret(encryptionSecretKey(serverId), runtimeEncryptionSecret);
  }

  // Build the I/O seam. Each lambda is a thin adapter — the production
  // primitives keep their existing signatures, the I/O interface keeps
  // its narrow shape, and the unit-tested state machine in
  // runtime-update.ts never sees an Electron or docker import.
  const io: RuntimeUpdateIo = {
    pullImage: (image, onProgress) =>
      new Promise<void>((resolve, reject) => {
        docker.pullImage(
          image,
          onProgress,
          () => resolve(),
          (msg) => reject(new Error(msg)),
        );
      }),
    imageExists: docker.imageExists,
    tagImage: docker.tagImage,
    stopContainer: (id, graceSeconds) => docker.stopContainer(id, { graceSeconds }),
    removeContainer: docker.removeContainer,
    recreateContainer: (_image, signature) =>
      // image is always SERVER_IMAGE here — performUpdate already executed
      // the tag dance so the right bytes are addressable under the local
      // tag. We forward optional cosign material so the runtime can
      // re-verify at boot (defense-in-depth per §10).
      recreateContainerForServer(
        {
          record,
          tunnelToken,
          runtimeEncryptionSecret: runtimeEncryptionSecret!,
          signature,
        },
        { removeIfExists, runServerContainer },
      ),
    verifyAndExtract: (image) => {
      if (!isCosignPubkeyEmbedded()) {
        // Caller must guard with skipVerification — performUpdate is
        // configured to skip the verify phase entirely in that mode, so
        // this branch only fires if someone bypassed the option. Throw a
        // typed error rather than synthesize material.
        throw new CosignError(
          "pubkey_not_embedded",
          "verifyAndExtract",
          "Cosign pubkey is empty — orchestrator must set skipVerification.",
          null,
        );
      }
      return verifyAndExtractMaterial({
        imageRef: image,
        pubkeyPem: COSIGN_PUBKEY_PEM,
      });
    },
    postUpdateState: (patch) => postUpdateState(baseUrl, auth, patch, merged.fetchImpl),
    fetchReady: async () => {
      const r = await merged.fetchImpl(`${baseUrl}/ready`);
      let body: { status?: string; reason?: string; version?: string };
      try {
        body = (await r.json()) as typeof body;
      } catch {
        body = {};
      }
      return {
        ready: r.status === 200 && body.status === "ready",
        ...(typeof body.reason === "string" ? { reason: body.reason } : {}),
        ...(typeof body.version === "string" ? { version: body.version } : {}),
      };
    },
    createBackup: () => createPreUpdateBackup({ volumePath: record.volumePath }),
    restoreBackup: (backupDir) =>
      restorePreUpdateBackup({ volumePath: record.volumePath, backupDir }),
    rotateBackups: (keep) => rotateBackups({ volumePath: record.volumePath, keep }),
    sleep: (ms) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }),
    now: () => Date.now(),
    // Hard pause: registers a Deferred keyed by serverId. Resolved by the
    // renderer's "Restart to apply update" click (via confirmRestartForServer)
    // or rejected by app quit (via cancelPendingRestarts). The runtime sits
    // at `awaiting-restart` indefinitely while we wait.
    restartConfirmed: () =>
      new Promise<void>((resolve, reject) => {
        // If a prior gate is still pending for this server (shouldn't happen
        // — performUpdateForServer is serialized — but be defensive), reject
        // it so we don't leak Deferreds.
        const prior = pendingRestarts.get(serverId);
        if (prior) {
          pendingRestarts.delete(serverId);
          prior.reject(new RestartCancelledError("Superseded by a new update attempt"));
        }
        pendingRestarts.set(serverId, { resolve, reject });
      }),
  };

  const options: RuntimeUpdateOptions = {
    latestImage: SERVER_IMAGE,
    previousImage: PREVIOUS_IMAGE,
    targetImage,
    currentVersion: snapshot.currentVersion,
    targetVersion,
    channel: snapshot.channel,
    containerId: record.containerId,
    backupBeforeUpdate,
    graceSeconds: DRAIN_GRACE_SECONDS,
    readyPollTimeoutMs: READY_POLL_TIMEOUT_MS,
    readyPollIntervalMs: READY_POLL_INTERVAL_MS,
    backupRetention: BACKUP_RETENTION,
    ...(isCosignPubkeyEmbedded() ? {} : { skipVerification: true }),
  };

  const outcome = await performUpdate({ io, log: merged.log, options });

  // Persist the new container id to the registry whether the update
  // committed or rolled back — both paths produce a live container under
  // a different image. Failure modes that left no container running
  // (rollbackOk === false) skip this write so the registry still points
  // at the original (now dead) id, and the operator's next launch hits
  // the registry-quarantine recovery path.
  const newContainerId =
    outcome.ok || (outcome.rolledBack && outcome.rollbackOk)
      ? outcome.containerId
      : undefined;
  if (newContainerId) {
    // On commit (outcome.ok), refresh imageSignature with the freshly-verified
    // material so launch-time rebuilds re-supply RUNTIME_IMAGE_* envs. On
    // rollback the bytes under `:latest` are the original image again, so the
    // existing record.imageSignature is still correct — leave it alone.
    const nextRecord: ServerRecord = { ...record, containerId: newContainerId };
    if (outcome.ok) {
      if (outcome.signature) {
        nextRecord.imageSignature = outcome.signature;
      } else {
        delete nextRecord.imageSignature;
      }
    }
    registerServer(serverId, nextRecord);
  }

  return outcome;
}
