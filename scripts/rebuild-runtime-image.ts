// Rebuild the runtime container image and clear out stale containers so the
// desktop's restoreServerContainers can run them fresh on its next launch.
//
// Usage: bun run docker:rebuild-runtime
//
// Why this script exists:
//   Editing runtime/src/** by itself does nothing — running containers are
//   stuck on whatever image they were created against. The "I changed code
//   and forgot to rebuild" footgun has bitten us in dev. This script
//   automates the manual sequence:
//     1. docker build -t uncorded-runtime:latest -f docker/Dockerfile .
//     2. for each container in ~/.uncorded/registry.json: docker rm -f
//
// Why not also re-run the containers here?
//   Tunnel tokens live in Electron's safeStorage (OS keychain), which a
//   standalone Bun process can't decrypt. Removing the containers is enough:
//   the desktop's restoreServerContainers (apps/desktop/src/main.ts:542)
//   reads the same registry on launch, sees the missing containers, and
//   re-runs them with fresh tokens piped over stdin. So the workflow is:
//     bun run docker:rebuild-runtime  ->  relaunch desktop.
//   No tunnel re-paste needed; volumes and server.json survive untouched.

import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const REGISTRY_PATH = join(homedir(), ".uncorded", "registry.json");
const IMAGE_TAG = "uncorded-runtime:latest";
const DOCKERFILE = "docker/Dockerfile";

// LiveKit binary checksums — must match the LIVEKIT_VERSION pinned in
// docker/Dockerfile (currently v1.11.0). Source:
//   https://github.com/livekit/livekit/releases/download/<version>/checksums.txt
// When bumping LiveKit, update both LIVEKIT_VERSION in the Dockerfile and
// these constants in the same change. The Dockerfile refuses to build
// without these build-args (sha256 verification is mandatory).
const LIVEKIT_SHA256_AMD64 =
  "3e76ed51ecdfefc3005e4257095dccd1ccc8f8b77517d9f2353de7906650b68b";
const LIVEKIT_SHA256_ARM64 =
  "6741466bc12e75544338292ab2c1c02c02f3c626568230b5548fffc53e5a87ff";

interface RegistryEntry {
  containerId: string;
  volumePath: string;
  hostPort: number;
  tunnelPublicHostname?: string;
}
interface Registry {
  schemaVersion: number;
  entries: Record<string, RegistryEntry>;
}

function logStep(msg: string): void {
  process.stdout.write(`\n=== ${msg} ===\n`);
}

function execFileAsync(file: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    execFile(file, args, (err, stdout, stderr) => {
      if (err) {
        reject(Object.assign(err, { stdout, stderr }));
        return;
      }
      resolvePromise({ stdout, stderr });
    });
  });
}

function spawnInherit(file: string, args: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(file, args, { stdio: "inherit", cwd: REPO_ROOT });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${file} ${args.join(" ")} exited with code ${code ?? "null"}`));
    });
  });
}

async function resolveRuntimeVersion(): Promise<string> {
  // Local-dev version string: <package-version>-dev+<git-short-sha>. Format
  // matches semver build metadata so Central's heartbeat field validation
  // accepts it the same way as a tagged release. The CI release workflow
  // (Stage 4 deliverable) will pass an explicit RUNTIME_VERSION instead.
  const pkgRaw = readFileSync(join(REPO_ROOT, "package.json"), "utf8");
  const pkg = JSON.parse(pkgRaw) as { version?: string };
  const base = pkg.version ?? "0.0.0";
  let sha = "";
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--short", "HEAD"]);
    sha = stdout.trim();
  } catch {
    // git not available or not a repo — fall through with empty sha
  }
  return sha ? `${base}-dev+${sha}` : `${base}-dev`;
}

async function buildImage(runtimeVersion: string): Promise<void> {
  logStep(`docker build -> ${IMAGE_TAG} (RUNTIME_VERSION=${runtimeVersion})`);
  await spawnInherit("docker", [
    "build",
    "-t",
    IMAGE_TAG,
    "-f",
    DOCKERFILE,
    "--build-arg",
    `LIVEKIT_SHA256_AMD64=${LIVEKIT_SHA256_AMD64}`,
    "--build-arg",
    `LIVEKIT_SHA256_ARM64=${LIVEKIT_SHA256_ARM64}`,
    "--build-arg",
    `RUNTIME_VERSION=${runtimeVersion}`,
    ".",
  ]);
}

function readRegistry(): Registry | null {
  if (!existsSync(REGISTRY_PATH)) return null;
  const raw = readFileSync(REGISTRY_PATH, "utf8");
  return JSON.parse(raw) as Registry;
}

async function removeContainers(registry: Registry): Promise<{ removed: number; missing: number }> {
  const ids = Object.values(registry.entries).map((e) => e.containerId);
  if (ids.length === 0) return { removed: 0, missing: 0 };
  logStep(`docker rm -f for ${String(ids.length)} registered container${ids.length === 1 ? "" : "s"}`);
  let removed = 0;
  let missing = 0;
  for (const id of ids) {
    try {
      await execFileAsync("docker", ["rm", "-f", id]);
      process.stdout.write(`  removed ${id.slice(0, 12)}\n`);
      removed += 1;
    } catch (err) {
      const stderr = ((err as { stderr?: string }).stderr ?? "").trim();
      if (/no such container/i.test(stderr)) {
        process.stdout.write(`  already gone ${id.slice(0, 12)}\n`);
        missing += 1;
      } else {
        process.stdout.write(`  failed ${id.slice(0, 12)}: ${stderr || (err as Error).message}\n`);
      }
    }
  }
  return { removed, missing };
}

async function main(): Promise<void> {
  const runtimeVersion = await resolveRuntimeVersion();
  await buildImage(runtimeVersion);

  const registry = readRegistry();
  if (!registry) {
    process.stdout.write(`\nNo registry at ${REGISTRY_PATH} — image rebuilt, no containers to clear.\n`);
    return;
  }

  const result = await removeContainers(registry);
  process.stdout.write(
    `\nImage rebuilt. Containers cleared (${String(result.removed)} removed, ${String(result.missing)} already gone).\n` +
      `Relaunch the UnCorded desktop app — restoreServerContainers will run them on the new image with fresh tunnel tokens from the keychain.\n`,
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`\nrebuild-runtime-image failed: ${(err as Error).message}\n`);
  process.exit(1);
});
