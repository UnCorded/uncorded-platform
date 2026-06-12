// Production entrypoint — called by the Docker container's ENTRYPOINT.
// Wires real dependencies into boot().
//
// - TunnelProvider: Cloudflare quick tunnel (demo) or authenticated tunnel,
//   with a local-fallback mode driven by UNCORDED_PUBLIC_URL for desktop-
//   provisioned deployments.
// - TokenValidator: real Ed25519 JWT validator — see the "Ed25519
//   TokenValidator" section below. Verifies signature against Central's
//   cached public keys, checks exp, and enforces server binding via aud.
//
// No mock Central server — boot() handles "Central unreachable + cached keys"
// by warning and continuing. The seed server.json includes central_public_keys
// so boot succeeds without Central.

import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

import { boot, BootError } from "./main";
import type { TunnelProvider, ServerJsonConfig } from "./main";
import type { PublicKeyEntry } from "./heartbeat/types";
import { createTokenValidator } from "./auth/token-validator";
import { verifyImageSignature, isCosignPubkeyEmbedded } from "./signing/verify";
import { awaitAuthenticatedTunnelReady, runRuntimeTunnelSelfProbe } from "./tunnel/ready";
import { createDemoExpiry, DEMO_TUNNEL_TTL_MS } from "./tunnel/demo-expiry";
import { rootLogger } from "@uncorded/shared";

const log = rootLogger.child({ component: "entrypoint" });
// Cloudflared stdout/stderr fan-out is logged under its own component so
// operators can grep `component=tunnel` to isolate tunnel-side noise from
// runtime boot lines.
const tunnelLog = rootLogger.child({ component: "tunnel" });

// Per Phase 01 lifecycle §13: env-var validation failures exit 10 so
// orchestrators can distinguish "operator misconfigured the container"
// (re-run will fail the same way) from a generic crash (exit 1, retry-worthy).
const EXIT_CODE_ENV_INVALID = 10;
// Per Phase 01 lifecycle §6 + §10: image signature verification failure exits
// 40. The orchestrator (desktop) detects this distinct code, halts the update,
// restores `:previous`, and writes `state: error / errorContext: install`.
const EXIT_CODE_SIGNATURE_INVALID = 40;
// Registry path the running image's docker-reference must match. Catches a
// malicious image signed by our key but pointed at a different repository
// (e.g. `cosign sign` on a fork). Stays in lockstep with O4.1 (GHCR registry
// + ghcr.io/uncorded/runtime path) and the release-runtime.yml workflow.
const EXPECTED_IMAGE_REFERENCE_PREFIX = "ghcr.io/uncorded/runtime";

function errorContext(reason: unknown): Record<string, unknown> {
  if (reason instanceof Error) {
    return {
      err: reason.message,
      errName: reason.name,
      stack: reason.stack,
    };
  }
  return { err: String(reason) };
}

// ---------------------------------------------------------------------------
// Paths (container filesystem layout from §03)
// ---------------------------------------------------------------------------

const CONFIG_PATH = "/config/server.json";
const DATA_DIR = "/data";
const CORE_PLUGINS_DIR = "/app/core-plugins";
const USER_PLUGINS_DIR = "/plugins";
const VOICE_CONFIG_DIR = "/config/voice";
const DEFAULT_LIVEKIT_BIN_PATH = "/opt/livekit/livekit-server";
const PORT = 3000;

// ---------------------------------------------------------------------------
// Encryption-secret precondition (S2 from PR-3a follow-ups; F7 auto-gen)
//
// crypto.ts requires RUNTIME_ENCRYPTION_SECRET to derive at-rest keys. Voice's
// encrypted-at-rest LiveKit secret is the first real consumer.
//
// Resolution order:
//   1. Env var (operator-managed; e.g. desktop wrapper passes one through). If
//      present but < 32 chars we fail closed — silently re-generating would
//      mask an operator misconfiguration.
//   2. Persisted /config/secret (mode 0600, owned by 1001). Survives container
//      rebuilds because /config is a host-mounted volume.
//   3. Generate randomBytes(32) → hex (64 chars), persist to /config/secret at
//      mode 0600, and warn so the first-boot generation is auditable.
//
// Auto-gen removes a sharp UX edge: previously a fresh `docker run` without
// the env var hard-failed on boot, which surprised operators who'd never read
// the install docs. The generated secret is per-server and never leaves the
// container's data volume.
// ---------------------------------------------------------------------------

{
  const SECRET_FILE = "/config/secret";
  const MIN_LENGTH = 32;
  const env = process.env["RUNTIME_ENCRYPTION_SECRET"];
  if (env !== undefined && env.length > 0) {
    if (env.length < MIN_LENGTH) {
      log.error(
        "RUNTIME_ENCRYPTION_SECRET too short — must be at least 32 characters; refusing to auto-generate over an operator-supplied value",
        { configured: `${String(env.length)} chars` },
      );
      process.exit(EXIT_CODE_ENV_INVALID);
    }
  } else if (existsSync(SECRET_FILE)) {
    const fromFile = readFileSync(SECRET_FILE, "utf8").trim();
    if (fromFile.length < MIN_LENGTH) {
      log.error(
        "/config/secret exists but is too short — refusing to overwrite; remove the file or set RUNTIME_ENCRYPTION_SECRET",
        { length: fromFile.length },
      );
      process.exit(EXIT_CODE_ENV_INVALID);
    }
    process.env["RUNTIME_ENCRYPTION_SECRET"] = fromFile;
    log.info("loaded RUNTIME_ENCRYPTION_SECRET from /config/secret");
  } else {
    const generated = randomBytes(32).toString("hex");
    writeFileSync(SECRET_FILE, generated, { mode: 0o600 });
    chmodSync(SECRET_FILE, 0o600);
    process.env["RUNTIME_ENCRYPTION_SECRET"] = generated;
    log.warn(
      "RUNTIME_ENCRYPTION_SECRET not provided — generated a fresh secret and persisted to /config/secret (mode 0600). Back up /config to preserve at-rest decryption capability across rebuilds.",
    );
  }
}

// ---------------------------------------------------------------------------
// Runtime version (F3)
//
// Sourced from the RUNTIME_VERSION ENV baked into the image by docker/Dockerfile
// (which receives it as a build-arg from CI release or scripts/rebuild-runtime-image.ts
// for local builds). "0.0.0-dev" indicates the Dockerfile default was used —
// either a hand-rolled docker build without --build-arg, or a non-Docker
// invocation. The runtime keeps booting either way; the warn surfaces the
// hole so operators don't ship a "version 0.0.0-dev" image.
// ---------------------------------------------------------------------------

const runtimeVersion = (() => {
  const fromEnv = process.env["RUNTIME_VERSION"];
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  log.warn(
    "RUNTIME_VERSION env not set — falling back to 0.0.0-dev. Production images bake this in via docker/Dockerfile build-arg.",
  );
  return "0.0.0-dev";
})();
log.info("runtime version", { version: runtimeVersion });

// ---------------------------------------------------------------------------
// Image signature verification (Phase 01 §10, defense in depth)
//
// The orchestrator (desktop) is the primary verifier — it `cosign verify`s
// the image before tagging :latest. This block is the in-runtime backstop
// that catches a compromised orchestrator that swapped in a malicious image
// without re-running cosign verify.
//
// The orchestrator passes three correlated ENVs at `docker run`:
//   RUNTIME_IMAGE_DIGEST       sha256:<64hex> of the running image manifest
//   RUNTIME_IMAGE_PAYLOAD      cosign simple-signing JSON payload (raw)
//   RUNTIME_IMAGE_SIGNATURE    base64 Ed25519 signature over the payload
//
// Modes:
//   - All three present + verification ok → boot continues.
//   - All three present + verification fails → exit 40.
//   - Partial set (orchestrator bug) → exit 40.
//   - None present → warn + continue. Compose / dev / unsigned local builds
//     run safely without orchestrator-supplied attestations. The pubkey-not-
//     embedded sentinel (cosign-pubkey.ts) means even a misconfigured prod
//     orchestrator that supplies envs against a stub-key build fails closed.
// ---------------------------------------------------------------------------

{
  const sigDigest = process.env["RUNTIME_IMAGE_DIGEST"];
  const sigPayload = process.env["RUNTIME_IMAGE_PAYLOAD"];
  const sigSignature = process.env["RUNTIME_IMAGE_SIGNATURE"];
  const present = [sigDigest, sigPayload, sigSignature].filter(
    (v) => v !== undefined && v.length > 0,
  ).length;

  if (present === 3 && sigDigest && sigPayload && sigSignature) {
    const result = verifyImageSignature({
      imageDigest: sigDigest,
      payloadJson: sigPayload,
      signatureB64: sigSignature,
      expectedReferencePrefix: EXPECTED_IMAGE_REFERENCE_PREFIX,
    });
    if (!result.ok) {
      log.error("image signature verification failed", {
        reason: result.reason,
        ...(result.detail ? { detail: result.detail } : {}),
        digest: sigDigest,
      });
      process.exit(EXIT_CODE_SIGNATURE_INVALID);
    }
    log.info("image signature verified", {
      digest: result.digest,
      reference: result.reference,
    });
  } else if (present > 0) {
    log.error(
      "image signature verification skipped: partial RUNTIME_IMAGE_* envs (orchestrator bug — all three or none required)",
      {
        has_digest: sigDigest !== undefined && sigDigest.length > 0,
        has_payload: sigPayload !== undefined && sigPayload.length > 0,
        has_signature: sigSignature !== undefined && sigSignature.length > 0,
      },
    );
    process.exit(EXIT_CODE_SIGNATURE_INVALID);
  } else if (isCosignPubkeyEmbedded()) {
    log.warn(
      "image signature verification skipped: orchestrator did not supply RUNTIME_IMAGE_DIGEST / RUNTIME_IMAGE_PAYLOAD / RUNTIME_IMAGE_SIGNATURE. Acceptable for compose / dev; production desktop orchestrator must set these.",
    );
  } else {
    log.info(
      "image signature verification skipped: no embedded cosign pubkey (pre-first-release seed state)",
    );
  }
}

// ---------------------------------------------------------------------------
// Voice config directory
//
// The supervisor writes /config/voice/livekit.yaml at mode 0600 each time
// LiveKit (re)spawns. The Dockerfile chowns /config to UID 1001 but we
// re-create the subdir here so it exists even when /config is bind-mounted
// from the host (a common operator pattern for persistence).
//
// mkdirSync's `mode` only applies on creation — when the Dockerfile (or a
// bind mount) already created the directory, the mode arg is a no-op.
// chmodSync after the mkdir guarantees 0700 in both paths so the encrypted
// config file isn't world-listable on shared host filesystems.
// ---------------------------------------------------------------------------
mkdirSync(VOICE_CONFIG_DIR, { recursive: true, mode: 0o700 });
chmodSync(VOICE_CONFIG_DIR, 0o700);

// ---------------------------------------------------------------------------
// SDK resolution for sideloaded plugins
//
// Plugin backends spawn with cwd = their own folder. Core plugins at
// /app/core-plugins/<slug> resolve `@uncorded/plugin-sdk` by walking up to
// /app/node_modules, but a sideloaded plugin at /plugins/<slug> walks
// /plugins/<slug>/node_modules → /plugins/node_modules → /node_modules and
// never reaches /app — so without this link, any dev/sideloaded plugin that
// imports the SDK spawn-fails into quarantine. Linking /plugins/node_modules
// to the image's own tree makes the SDK (at the exact version this runtime
// speaks) resolvable as a fallback, while a plugin's own vendored
// node_modules still wins the walk when present.
//
// Recreated each boot if absent (/plugins is a host bind mount — the host
// side may prune it). A real directory or operator-placed link is left alone.
// ---------------------------------------------------------------------------
try {
  mkdirSync(USER_PLUGINS_DIR, { recursive: true });
  const linkPath = `${USER_PLUGINS_DIR}/node_modules`;
  let present = true;
  try {
    lstatSync(linkPath);
  } catch {
    present = false;
  }
  if (!present) {
    symlinkSync("/app/node_modules", linkPath, "dir");
    log.info("linked /plugins/node_modules -> /app/node_modules for sideloaded plugin SDK resolution");
  }
} catch (err) {
  // Non-fatal: core plugins are unaffected; sideloaded plugins that vendor
  // their own node_modules still load.
  log.warn("could not prepare /plugins/node_modules SDK link", { err: String(err) });
}

// ---------------------------------------------------------------------------
// Seed server.json if missing (first-time boot)
// ---------------------------------------------------------------------------

if (!existsSync(CONFIG_PATH)) {
  log.warn("/config/server.json not found — seeding default config for first-time boot");

  // No baked-in plugin choices — the seed config is empty. Plugin install is
  // an operator action driven through the marketplace (or by hand-editing
  // server.json), not a Dockerfile-time decision. The /data/plugins/<slug>
  // dirs are created lazily by the loader on first install.

  const seed: ServerJsonConfig = {
    server_id: "uncorded-local",
    server_secret: "change-me",
    central_url: "https://central.uncorded.app",
    central_public_keys: [],
    last_sync_version: 0,
    installed_plugins: [],
    tunnel: {
      provider: "none",
      mode: "local",
      credentials_file: undefined,
      fallback: undefined,
    },
    settings: {
      permissive_mode: false,
      max_connections: 100,
      // 25 lets a power-user keep many tabs/devices on one network while
      // preventing a single peer from devouring the global cap. Operators
      // can edit /config/server.json (or set 0) to lift the per-IP cap.
      max_connections_per_ip: 25,
      allow_unsigned_plugins: false,
      // Operators typically run the UnCorded web shell at uncorded.app; the
      // apex host and www-subdomain are both seeded so a freshly-deployed
      // server accepts the shell's authenticated cross-origin fetches out of
      // the box. Operators serving the shell from a different origin must
      // add their origin here and remove the ones they don't use.
      allowed_origins: ["https://uncorded.app", "https://www.uncorded.app"],
    },
  };

  writeFileSync(CONFIG_PATH, JSON.stringify(seed, null, 2));
  log.warn("seeded /config/server.json with defaults — edit this file to configure your server");
}

// ---------------------------------------------------------------------------
// CloudflaredTunnelProvider
// ---------------------------------------------------------------------------

// Fallback URL for local/none mode — the desktop provisioner sets
// UNCORDED_PUBLIC_URL to the host-side port mapping so the container is
// reachable on the LAN without a tunnel. Falls back to the container-internal
// port for raw `docker run` without the provisioner.
const LOCAL_FALLBACK_URL = process.env["UNCORDED_PUBLIC_URL"] ?? `http://localhost:${String(PORT)}`;

// Regex matching the trycloudflare.com URL emitted by cloudflared quick tunnel on stderr.
const DEMO_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const TUNNEL_START_TIMEOUT_MS = 30_000;

// Typed tunnel error — CLAUDE.md mandates typed errors with code/message/context
// over raw `new Error`. Mirrors BootError's (code, message) throwable shape and
// adds an optional context bag for machine-readable diagnostics. boot() in
// main.ts rewraps the `.message` into BootError("TUNNEL_FAILED", ...); the code
// and context survive on the thrown instance for logs and inspection.
export class TunnelError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "TunnelError";
  }
}

// cloudflared embeds a level marker (`INF`/`WRN`/`ERR`/`FTL`/`DBG`) in each
// stderr line. Without parsing it we'd log every warning and error at INFO,
// burying real problems under the boot-time chatter. Lines without a marker
// (e.g. quic-go's UDP buffer perf note) fall through to info.
const CLOUDFLARED_LEVEL_RE = / (DBG|INF|WRN|ERR|FTL) /;
function logCloudflaredLine(line: string): void {
  const level = CLOUDFLARED_LEVEL_RE.exec(line)?.[1] ?? "INF";
  switch (level) {
    case "WRN":
      tunnelLog.warn("cloudflared", { line });
      return;
    case "ERR":
    case "FTL":
      tunnelLog.error("cloudflared", { line });
      return;
    case "DBG":
      tunnelLog.debug("cloudflared", { line });
      return;
    default:
      tunnelLog.info("cloudflared", { line });
  }
}

let cloudflaredProc: ReturnType<typeof Bun.spawn> | null = null;
let currentTunnelUrl = LOCAL_FALLBACK_URL;
// Tunnel lifecycle reported on the heartbeat's tunnel_state field. undefined
// until start() resolves, then "demo" | "named" | "local", flipping to
// "expired" when a demo tunnel hits its 24h TTL (see demoExpiry below).
let tunnelState: string | undefined;

// Arms a 24h countdown when a demo tunnel comes up. On fire we kill cloudflared,
// drop the advertised URL back to the local fallback (so Central stops pointing
// users at the now-dead trycloudflare address), and flip tunnel_state to
// "expired" — the runtime keeps heartbeating, so the next poll tells Central and
// the client to prompt a desktop restart. See ./tunnel/demo-expiry.ts.
const demoExpiry = createDemoExpiry({
  ttlMs: DEMO_TUNNEL_TTL_MS,
  onExpire: () => {
    log.warn("demo tunnel reached its 24h TTL — expiring", { url: currentTunnelUrl });
    if (cloudflaredProc) {
      cloudflaredProc.kill();
      cloudflaredProc = null;
    }
    currentTunnelUrl = LOCAL_FALLBACK_URL;
    tunnelState = "expired";
  },
});

// `--protocol http2` forces TCP+HTTP/2 instead of the default QUIC. QUIC needs
// a ~7 MiB UDP receive buffer (quic-go's default ask); unprivileged containers
// inherit the host kernel's `net.core.rmem_max` (~416 KiB on Docker Desktop /
// many WSL2 hosts) and can't raise it from inside (per-container `net.core.*`
// sysctls were tried in v0.0.9 and rejected by runc 1.1.13+ — see desktop
// release log v0.0.10). The under-sized buffer causes QUIC handshakes to die
// with `context canceled` 80 ms in; the demo URL never gets registered, the
// runtime hangs in tunnel.start(), and the desktop orchestrator times out
// provisioning. HTTP/2 has no UDP buffer dependency and is fully supported by
// trycloudflare quick tunnels — Cloudflare itself recommends it for container
// deployments without UDP tuning.
async function spawnDemoTunnel(): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const proc = Bun.spawn(
      ["cloudflared", "tunnel", "--no-autoupdate", "--protocol", "http2", "--url", `http://localhost:${String(PORT)}`],
      {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
        env: {
          ...process.env,
          // cloudflared may write temp files to ~/.cloudflared; /tmp is the
          // only writable directory inside the read-only container rootfs.
          HOME: "/tmp",
        },
      },
    );

    cloudflaredProc = proc;

    const deadline = setTimeout(() => {
      proc.kill();
      cloudflaredProc = null;
      reject(
        new TunnelError(
          "TUNNEL_TIMEOUT",
          "cloudflared quick tunnel did not provide a URL within 30 seconds",
          { timeoutMs: TUNNEL_START_TIMEOUT_MS, port: PORT },
        ),
      );
    }, TUNNEL_START_TIMEOUT_MS);

    let resolved = false;

    void (async () => {
      try {
        const stderrStream = proc.stderr as ReadableStream<Uint8Array> | null;
        if (!stderrStream) {
          clearTimeout(deadline);
          reject(
            new TunnelError("STDERR_UNAVAILABLE", "cloudflared stderr stream unavailable", {
              mode: "demo",
              port: PORT,
            }),
          );
          return;
        }

        const reader = stderrStream.getReader();
        const decoder = new TextDecoder();
        let buf = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const line of lines) {
            logCloudflaredLine(line);
            if (!resolved) {
              const match = DEMO_URL_RE.exec(line);
              if (match?.[0]) {
                resolved = true;
                clearTimeout(deadline);
                resolve(match[0]);
              }
            }
          }
        }
      } catch {
        // Stream closed — expected on process exit
      }

      if (!resolved) {
        clearTimeout(deadline);
        reject(
          new TunnelError("TUNNEL_NO_URL", "cloudflared exited without providing a tunnel URL", {
            port: PORT,
          }),
        );
      }
    })();
  });
}

// For authenticated tunnels, cloudflared never logs the public hostname — it is
// configured in the Cloudflare dashboard. We resolve once the readiness gate
// (ingress config + ≥2 connections or 5s grace) is met and return the caller-
// supplied public hostname as the tunnel URL. See spec-10 Amendment A and
// the awaitAuthenticatedTunnelReady doc-comment in ./tunnel/ready.ts.
async function spawnAuthenticatedTunnel(token: string, publicUrl: string): Promise<string> {
  const proc = Bun.spawn(
    // See spawnDemoTunnel for why we force --protocol http2.
    ["cloudflared", "tunnel", "--no-autoupdate", "--protocol", "http2", "run", "--token", token],
    {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
      env: {
        ...process.env,
        HOME: "/tmp",
      },
    },
  );

  cloudflaredProc = proc;

  const stderrStream = proc.stderr as ReadableStream<Uint8Array> | null;
  if (!stderrStream) {
    proc.kill();
    cloudflaredProc = null;
    throw new TunnelError("STDERR_UNAVAILABLE", "cloudflared stderr stream unavailable", {
      mode: "authenticated",
      publicUrl,
    });
  }

  try {
    const url = await awaitAuthenticatedTunnelReady({
      publicUrl,
      stderrStream,
      onLine: logCloudflaredLine,
    });

    // Non-blocking diagnostic — see runRuntimeTunnelSelfProbe doc-comment.
    void (async () => {
      const result = await runRuntimeTunnelSelfProbe({ publicUrl: url });
      if (result.ok) {
        log.info("cloudflare authenticated tunnel publicly reachable", {
          attempts: result.attempts,
        });
      } else {
        log.warn("tunnel_state degraded — runtime self-probe failed", {
          reason: result.reason,
          ...(result.status !== undefined ? { status: result.status } : {}),
          attempts: result.attempts,
        });
      }
    })();

    return url;
  } catch (err) {
    proc.kill();
    cloudflaredProc = null;
    throw err;
  }
}

const tunnelProvider: TunnelProvider = {
  async start(config) {
    if (config.mode === "demo") {
      log.info("starting cloudflare quick tunnel (demo mode)");
      try {
        currentTunnelUrl = await spawnDemoTunnel();
        tunnelState = "demo";
        // Start the 24h clock now that the demo URL is live.
        demoExpiry.arm();
        log.info("cloudflare quick tunnel ready", { url: currentTunnelUrl });
        return currentTunnelUrl;
      } catch (err) {
        const cause = err instanceof Error ? err.message : String(err);
        throw new TunnelError("TUNNEL_START_FAILURE", `Cloudflare demo tunnel failed to start: ${cause}`, {
          mode: "demo",
          cause,
        });
      }
    }

    if (config.mode === "authenticated") {
      if (!config.credentials_file) {
        log.warn(
          "authenticated cloudflare tunnel requires credentials_file — " +
            "falling back to local-only mode",
        );
        currentTunnelUrl = LOCAL_FALLBACK_URL;
        tunnelState = "local";
        return currentTunnelUrl;
      }

      let tunnelToken: string;
      let publicHostname: string | undefined;
      try {
        const raw = await Bun.file(config.credentials_file).text();
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (typeof parsed["tunnel_token"] !== "string" || !parsed["tunnel_token"]) {
          throw new TunnelError("TUNNEL_MISSING_TOKEN", "tunnel.json is missing 'tunnel_token' field", {
            credentials_file: config.credentials_file,
          });
        }
        tunnelToken = parsed["tunnel_token"];
        if (typeof parsed["public_hostname"] === "string" && parsed["public_hostname"]) {
          publicHostname = parsed["public_hostname"];
        }
      } catch (err) {
        // A missing-token TunnelError thrown above is already typed — propagate
        // it unchanged so its distinct code survives instead of being flattened
        // into the read-failure wrapper.
        if (err instanceof TunnelError) throw err;
        const cause = err instanceof Error ? err.message : String(err);
        throw new TunnelError(
          "TUNNEL_READ_FAILURE",
          `Failed to read tunnel credentials from ${config.credentials_file}: ${cause}`,
          { credentials_file: config.credentials_file, cause },
        );
      }

      // Use configured hostname if provided; otherwise fall back to the host-mapped
      // port URL so the server remains reachable even without a public hostname.
      const publicUrl = publicHostname
        ? `https://${publicHostname}`
        : LOCAL_FALLBACK_URL;

      log.info("starting cloudflare authenticated tunnel", { publicUrl });
      try {
        currentTunnelUrl = await spawnAuthenticatedTunnel(tunnelToken, publicUrl);
        tunnelState = "named";
        log.info("cloudflare authenticated tunnel ready", { url: currentTunnelUrl });
        return currentTunnelUrl;
      } catch (err) {
        const cause = err instanceof Error ? err.message : String(err);
        throw new TunnelError(
          "TUNNEL_START_FAILURE",
          `Cloudflare authenticated tunnel failed to start: ${cause}`,
          { mode: "authenticated", publicUrl, cause },
        );
      }
    }

    // mode: "local" / provider: "none" — use UNCORDED_PUBLIC_URL fallback
    log.warn(
      "no tunnel configured — server is only reachable locally; " +
        "set tunnelMode to 'demo' or 'cloudflare' for public access",
    );
    currentTunnelUrl = LOCAL_FALLBACK_URL;
    tunnelState = "local";
    return currentTunnelUrl;
  },

  async stop() {
    // Cancel the demo TTL so a shutdown mid-life doesn't leave a dangling
    // timer firing against a torn-down process.
    demoExpiry.clear();
    if (cloudflaredProc) {
      cloudflaredProc.kill();
      cloudflaredProc = null;
    }
  },

  getUrl() {
    return currentTunnelUrl;
  },

  getState() {
    return tunnelState;
  },

  async healthCheck() {
    if (!cloudflaredProc) return false;
    // exitCode is null while the process is still running
    return cloudflaredProc.exitCode === null;
  },
};

// ---------------------------------------------------------------------------
// Ed25519 TokenValidator — wires the testable createTokenValidator factory
// into the runtime's mutable key cache and heartbeat refresh hook.
// ---------------------------------------------------------------------------

// Mutable key cache — updated by onPublicKeysUpdated callback from boot().
// Initialized from server.json cache (if any) before boot() runs.
let validationKeys: PublicKeyEntry[] = [];
let validationServerId: string | null = null;
// Forward-ref to heartbeat.forceRefresh — assigned after boot() resolves.
// Until then, refresh is a no-op so token validation still works (with the
// keys cached from server.json) before the heartbeat client exists.
let refreshPublicKeys: () => Promise<void> = async () => {};

// Seed from cached server.json so the validator works immediately on restart
// even before the first heartbeat completes.
if (existsSync(CONFIG_PATH)) {
  try {
    const cached = JSON.parse(
      await Bun.file(CONFIG_PATH).text(),
    ) as Record<string, unknown>;
    if (typeof cached["server_id"] === "string") {
      validationServerId = cached["server_id"];
    }
    if (Array.isArray(cached["central_public_keys"])) {
      validationKeys = (
        cached["central_public_keys"] as unknown[]
      ).filter(
        (k): k is PublicKeyEntry =>
          typeof k === "object" &&
          k !== null &&
          "id" in k &&
          "public_key" in k,
      );
    }
  } catch {
    // Non-fatal — will be updated after first heartbeat
  }
}

const tokenValidator = createTokenValidator({
  getKeys: () => validationKeys,
  getServerId: () => validationServerId,
  refreshKeys: () => refreshPublicKeys(),
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

let runtimeShutdown: (() => Promise<void>) | null = null;
let fatalHandling = false;

async function handleFatalProcessError(
  subsystem: "unhandledRejection" | "uncaughtException",
  reason: unknown,
): Promise<void> {
  log.error("fatal process error", {
    subsystem: `runtime.${subsystem}`,
    ...errorContext(reason),
  });

  if (fatalHandling) {
    return;
  }
  fatalHandling = true;

  try {
    if (runtimeShutdown) {
      await runtimeShutdown();
    }
  } catch (err) {
    log.error("graceful shutdown after fatal error failed", {
      subsystem: `runtime.${subsystem}`,
      ...errorContext(err),
    });
  } finally {
    process.exit(1);
  }
}

process.on("unhandledRejection", (reason) => {
  void handleFatalProcessError("unhandledRejection", reason);
});

process.on("uncaughtException", (error) => {
  void handleFatalProcessError("uncaughtException", error);
});

// Voice provisioning gate. The desktop sets LIVEKIT_PUBLIC_URL only when the
// owner has completed the "Open Router Ports" setup flow (or a future relay
// flow). Absence of the env var means voice is unprovisioned: /health/voice
// reports `status: "disabled"`, the IPC bridge + cascade stay unwired, and
// the shell dims voice channels in the sidebar.
//
// We always pass voice deps to boot() — the supervisor factory has to be
// registered in the managed-services registry regardless, so the manifest
// validator accepts plugins that declare `managed_services: ["livekit"]`.
// Without this, the resolver drops voice-channels with UNKNOWN_MANAGED_SERVICE
// and the dim-and-click-to-setup UX has nothing to render. publicUrl is the
// real gate for whether voice actually starts.
//
// Local dev (running entrypoint outside Docker) can still opt in by
// exporting LIVEKIT_PUBLIC_URL=ws://localhost:7880 manually.
const livekitPublicUrl = process.env["LIVEKIT_PUBLIC_URL"];
// Host's primary RFC1918 LAN IPv4 — set by the desktop wrapper so LiveKit
// can advertise it as a node_ip ICE host candidate. On-LAN peers then
// reach the SFU directly. Absent on bare-metal Linux deploys → LiveKit
// falls back to STUN-discovered external IP only.
const hostLanIp = process.env["HOST_LAN_IP"];

try {
  const result = await boot({
    tunnelProvider,
    tokenValidator,
    configPath: CONFIG_PATH,
    corePluginsDir: CORE_PLUGINS_DIR,
    userPluginsDir: USER_PLUGINS_DIR,
    dataDir: DATA_DIR,
    runtimeVersion,
    port: PORT,
    onPublicKeysUpdated(keys) {
      validationKeys = [...keys];
    },
    onServerDeleted() {
      log.warn("server deleted in Central — exiting", {
        server_id: validationServerId ?? "unknown",
      });
      // Distinct exit code so operators / the desktop wizard can tell this
      // apart from a crash. `docker inspect` will show ExitCode: 42.
      process.exit(42);
    },
    voice: {
      livekitBinPath: process.env["LIVEKIT_BIN_PATH"] ?? DEFAULT_LIVEKIT_BIN_PATH,
      configDir: VOICE_CONFIG_DIR,
      livekitVersion: process.env["LIVEKIT_VERSION"] ?? "1.11.0",
      ...(livekitPublicUrl ? { publicUrl: livekitPublicUrl } : {}),
      ...(hostLanIp ? { internalIp: hostLanIp } : {}),
    },
  });

  runtimeShutdown = result.shutdown;
  refreshPublicKeys = result.refreshPublicKeys;
  log.info("uncorded server ready", { port: result.port, pluginCount: result.pluginCount });
} catch (err) {
  log.error("boot failed", errorContext(err));
  // Phase 01 §13: a CONFIG_INVALID BootError represents an env-equivalent
  // validation failure (server.json carries CENTRAL_URL + SERVER_TOKEN, both
  // listed in §13). Exit 10 so orchestrators don't restart-loop on a misconfig.
  if (err instanceof BootError && err.code === "CONFIG_INVALID") {
    process.exit(EXIT_CODE_ENV_INVALID);
  }
  process.exit(1);
}
