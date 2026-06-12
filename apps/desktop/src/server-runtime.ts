// Shared docker run config for the runtime container. Used by:
//   - provision.ts on initial server creation, and
//   - main.ts at app launch to recreate the container with a fresh stdin
//     token from the keychain (rm-f + run, since `docker start` cannot
//     re-attach host stdin and the entrypoint wrapper requires a one-line
//     read for tunnel-authenticated mode).
//
// Centralizing here keeps both call paths in lock-step on capability flags,
// tmpfs mounts, and the no-restart lifecycle decision.

import os from "node:os";
import path from "node:path";

import { app } from "electron";

import * as docker from "./docker";

export const SERVER_IMAGE = "uncorded-runtime:latest";

// LiveKit needs to advertise an IPv4 the host's LAN clients can reach without
// hairpin-NATing through the WAN IP — Docker Desktop on Windows runs the
// runtime container in WSL2's network namespace, so the container's own
// interfaces are 172.x bridge addresses and STUN only ever discovers the WAN
// IP. We pick the host's primary RFC1918 LAN IPv4 and pass it through
// HOST_LAN_IP so the runtime can render it as `node_ip` in livekit.yaml.
// LAN clients then use it as the host ICE candidate (no NAT loopback);
// WAN clients keep using the STUN-discovered srflx candidate.
function isRfc1918(ip: string): boolean {
  if (ip.startsWith("10.")) return true;
  if (ip.startsWith("192.168.")) return true;
  if (ip.startsWith("172.")) {
    const second = Number(ip.split(".")[1] ?? "0");
    return second >= 16 && second <= 31;
  }
  return false;
}

function isCgnat(ip: string): boolean {
  if (!ip.startsWith("100.")) return false;
  const second = Number(ip.split(".")[1] ?? "0");
  return second >= 64 && second <= 127;
}

function detectHostLanIp(): string | undefined {
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const entry of list ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      const ip = entry.address;
      if (isRfc1918(ip) && !isCgnat(ip)) return ip;
    }
  }
  return undefined;
}

export interface RunServerArgs {
  /** Host volume root for this server (~/.uncorded/servers/<slug>). */
  volumePath: string;
  /** Loopback port on the host that maps to the container's :3000. */
  hostPort: number;
  /** Cloudflare tunnel token, or undefined for demo / local mode. */
  tunnelToken: string | undefined;
  /** Cloudflare named-tunnel hostname (e.g. "mygame.example.com"), if any. */
  tunnelPublicHostname?: string | undefined;
  /** LiveKit signaling hostname (e.g. "voice.mygame.example.com"), if the
   *  owner has completed the voice setup flow. Translates to
   *  LIVEKIT_PUBLIC_URL=wss://<host> on the container. Absent → the runtime
   *  skips wiring the voice supervisor and /health/voice reports "disabled". */
  voicePublicHostname?: string | undefined;
  /** Hex-encoded ≥32-char secret the runtime uses to derive at-rest keys
   *  (RUNTIME_ENCRYPTION_SECRET). Generated once on server creation and
   *  persisted via secret-store; the runtime fail-closes at boot if it's
   *  shorter than 32 chars. */
  runtimeEncryptionSecret: string;
  /**
   * Dev-only bind mounts that overlay host plugin source directories on top
   * of the image's baked-in copies at /app/core-plugins/<slug>/frontend.
   * Mounted read-only, so the container can still read fresh bytes on every
   * request (runtime uses Bun.file + Cache-Control: no-cache on index.html)
   * but can't write back into the developer's source tree. Caller must omit
   * this field in packaged builds — the prod image ships pre-baked plugin
   * assets and should not accept live overlays.
   */
  devPluginFrontendMounts?: readonly { slug: string; hostDir: string }[];
  /**
   * Cosign signature material the orchestrator already verified for this
   * image. Forwarded to the container as RUNTIME_IMAGE_DIGEST/_PAYLOAD/
   * _SIGNATURE so the runtime can re-verify at boot (defense in depth per
   * Phase 01 §10 / spec-runtime-lifecycle.md §2.2). Omitted in dev /
   * locally-built image flows — the runtime tolerates absence as long as
   * no cosign pubkey is embedded; once the embedded pubkey is non-empty
   * the runtime exits 40 if these envs are missing.
   */
  imageSignature?: {
    /** sha256:<64hex> manifest digest the orchestrator pulled. */
    digest: string;
    /** Cosign simple-signing JSON payload (raw UTF-8 bytes). */
    payloadJson: string;
    /** Base64 Ed25519 signature over `payloadJson`. */
    signatureB64: string;
  };
}

/**
 * Run (or re-run) the runtime container for a single server. Returns the new
 * container id. Caller is responsible for removing any previous container
 * with the same name before invoking this — `docker run` will fail otherwise.
 */
export async function runServerContainer(args: RunServerArgs): Promise<string> {
  const slug = path.basename(args.volumePath);
  const stdinData = args.tunnelToken
    ? JSON.stringify({
        tunnel_token: args.tunnelToken,
        ...(args.tunnelPublicHostname ? { public_hostname: args.tunnelPublicHostname } : {}),
      })
    : undefined;

  const hostLanIp = detectHostLanIp();

  return docker.runContainer({
    image: SERVER_IMAGE,
    name: `uncorded-${slug}`,
    volumes: [
      { host: path.join(args.volumePath, "plugins"), container: "/plugins" },
      { host: path.join(args.volumePath, "data"), container: "/data" },
      { host: path.join(args.volumePath, "config"), container: "/config" },
      ...(args.devPluginFrontendMounts ?? []).map((m) => ({
        host: m.hostDir,
        container: `/app/core-plugins/${m.slug}/frontend`,
        readOnly: true,
      })),
    ],
    env: {
      UNCORDED_PUBLIC_URL: `http://localhost:${String(args.hostPort)}`,
      RUNTIME_ENCRYPTION_SECRET: args.runtimeEncryptionSecret,
      // LIVEKIT_PUBLIC_URL is the runtime's voice provisioning gate. Set only
      // when the owner has configured a voice hostname through the in-app
      // setup flow; absent → /health/voice returns disabled and clients see
      // voice channels dimmed in the sidebar.
      ...(args.voicePublicHostname
        ? { LIVEKIT_PUBLIC_URL: `wss://${args.voicePublicHostname}` }
        : {}),
      // Host's primary RFC1918 LAN IPv4 (e.g. 192.168.1.221), forwarded so
      // the runtime emits it as `node_ip` in livekit.yaml. Absent → LiveKit
      // falls back to STUN-discovered external IP only (WAN works, on-LAN
      // peers depend on router NAT loopback). See comment above
      // detectHostLanIp().
      ...(hostLanIp ? { HOST_LAN_IP: hostLanIp } : {}),
      // Image signature material — orchestrator already verified, runtime
      // re-verifies at boot. All three or none: partial set trips a hard
      // exit 40 in entrypoint.ts (orchestrator-bug guard).
      ...(args.imageSignature
        ? {
            RUNTIME_IMAGE_DIGEST: args.imageSignature.digest,
            RUNTIME_IMAGE_PAYLOAD: args.imageSignature.payloadJson,
            RUNTIME_IMAGE_SIGNATURE: args.imageSignature.signatureB64,
          }
        : {}),
    },
    // Bridge networking with explicit publishing. Docker Desktop on Windows
    // does not actually merge `--network host` with the Windows host network
    // (the container ends up in WSL2's namespace and never sees the LAN IP
    // or receives forwarded UDP), so we publish each port the SFU needs and
    // let LiveKit advertise both the LAN IP (via node_ip from HOST_LAN_IP)
    // and the STUN-discovered WAN IP. Hardcoded ports → one runtime per
    // host until provision.ts can vary them.
    ports: [
      { host: args.hostPort, container: 3000 },
      { host: 7880, container: 7880 },
      { host: 7881, container: 7881 },
      // Single UDP MUX port per spec-24 Amendment B. LiveKit binds this
      // socket at process start and every active call multiplexes through
      // it. We publish but do NOT probe this port — see Amendment C: pion
      // ICE drops cold STUN Binding Requests here because its USERNAME
      // dispatch has no active session to map to.
      { host: 50000, container: 50000, protocol: "udp" },
      // LiveKit embedded TURN/STUN responder per spec-24 Amendment C.
      // RFC 5766 §6.5 mandates that TURN servers answer bare STUN Binding
      // Requests, so this is what Central probes from the public internet
      // to verify "media will reach the SFU". Also serves as a media
      // relay fallback for peers behind restrictive NATs (cellular,
      // symmetric NAT). UDP 3478 is the IANA-registered STUN/TURN port.
      { host: 3478, container: 3478, protocol: "udp" },
    ],
    // Dev only: map host.docker.internal → the host gateway so the bridged
    // container can reach a Central running on the developer's host loopback
    // (getContainerCentralUrl rewrites localhost → host.docker.internal in dev).
    // Docker Desktop resolves this alias automatically; native-Linux Docker
    // needs the explicit mapping. Packaged builds heartbeat to prod and never
    // need it.
    ...(app.isPackaged ? {} : { addHosts: ["host.docker.internal:host-gateway"] }),
    // Electron owns the lifecycle (see main.ts startup / shutdown). Docker's
    // auto-restart path can never re-pipe stdin, so authenticated tunnels
    // would silently degrade to demo mode after a reboot. We rebuild the
    // container on every desktop launch instead.
    restartPolicy: "no",
    capDropAll: true,
    securityOpts: ["no-new-privileges:true"],
    readOnly: true,
    // No `init: true` — the image's ENTRYPOINT already runs a pinned tini at
    // PID 1 (docker/Dockerfile:160). Adding `--init` would inject docker-init
    // ahead of it, demoting our tini to PID 7 and tripping its
    // "not running as PID 1" warning, with two init processes doing the same
    // job.
    // /run/tunnel is tmpfs so the entrypoint wrapper can lay down
    // tunnel.json without touching host disk; sized small + 0700 to bound
    // blast radius if a plugin breaks out of the runtime sandbox. uid/gid=1001
    // is required: without it Docker mounts tmpfs as root:root and the 1001
    // entrypoint can't write (or traverse) the directory.
    tmpfs: ["/tmp", "/run/tunnel:rw,size=1m,mode=0700,uid=1001,gid=1001"],
    // NOTE: per-container --sysctl net.core.{r,w}mem_{max,default} is
    // intentionally NOT set here. v0.0.9 tried it; runc 1.1.13+ rejects
    // those writes with "unsafe procfs detected" on Docker Desktop / WSL2
    // and on any host whose kernel doesn't expose net.core.* as fully
    // per-netns sysctls (pre-Linux-5.10, or with WSL2's patched kernel).
    // The fix has to live on the host kernel — see runtime ops docs.
    ...(stdinData !== undefined ? { stdinData } : {}),
  });
}

/**
 * Best-effort force-remove of a container by id. Used before re-running on
 * launch so the new `docker run` doesn't conflict on container name. Silent
 * on missing container (already gone is the desired post-condition).
 */
export async function removeIfExists(containerId: string): Promise<void> {
  try {
    await docker.removeContainer(containerId);
  } catch {
    // Already removed, never started, or daemon down — caller proceeds.
  }
}
