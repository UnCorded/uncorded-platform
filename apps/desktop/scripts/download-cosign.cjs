#!/usr/bin/env node
// Download per-platform cosign binaries into apps/desktop/resources/cosign/
// before electron-builder runs. The Dockerfile downloads cloudflared inline
// (it runs *inside* the runtime container) but cosign runs on the **host**
// during runtime-image verification, so it has to be bundled with the
// desktop installer.
//
// Each invocation downloads only the binary for the host platform —
// electron-builder's matrix (windows-latest + ubuntu-latest, see
// .github/workflows/release.yml) builds one OS per leg, so each leg only
// needs its own native binary inside `extraResources`.
//
// Cosign version: pinned to v2.4.1 to match release-runtime.yml's
// sigstore/cosign-installer step. Bumping requires updating BOTH
// release-runtime.yml AND COSIGN_VERSION below in the same PR so signatures
// produced by CI keep verifying with the orchestrator's bundled binary.

"use strict";

const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");

const COSIGN_VERSION = "v2.4.1";

/**
 * Map (platform, arch) → ({ target, asset }).
 *  target: matches CosignTarget in src/cosign-bin.ts
 *  asset:  matches the file name on https://github.com/sigstore/cosign/releases
 */
const TARGETS = {
  "win32-x64":   { target: "win32-x64",   asset: "cosign-windows-amd64.exe" },
  "linux-x64":   { target: "linux-x64",   asset: "cosign-linux-amd64" },
  "darwin-x64":  { target: "darwin-x64",  asset: "cosign-darwin-amd64" },
  "darwin-arm64":{ target: "darwin-arm64",asset: "cosign-darwin-arm64" },
};

function destBinaryName(platform) {
  return platform === "win32" ? "cosign.exe" : "cosign";
}

function downloadFollowingRedirects(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest, { mode: 0o755 });
    const req = https.get(url, { headers: { "User-Agent": "UnCorded-Desktop-Build" } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) {
        const next = res.headers.location;
        file.close();
        fs.unlink(dest, () => undefined);
        if (!next) {
          reject(new Error(`Redirect with no Location for ${url}`));
          return;
        }
        downloadFollowingRedirects(next, dest).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlink(dest, () => undefined);
        reject(new Error(`GET ${url} returned ${res.statusCode}`));
        return;
      }
      res.pipe(file);
      file.on("finish", () => file.close(resolve));
    });
    req.on("error", (err) => {
      file.close();
      fs.unlink(dest, () => undefined);
      reject(err);
    });
  });
}

async function main() {
  const platform = process.platform;
  const arch = process.arch;
  const key = `${platform}-${arch}`;
  const entry = TARGETS[key];
  if (!entry) {
    console.error(`[cosign] no bundled cosign target for ${key} — supported: ${Object.keys(TARGETS).join(", ")}`);
    process.exit(1);
  }

  const repoRoot = path.resolve(__dirname, "..");
  const destDir = path.join(repoRoot, "resources", "cosign", entry.target);
  const destFile = path.join(destDir, destBinaryName(platform));

  if (fs.existsSync(destFile)) {
    console.log(`[cosign] already present: ${destFile}`);
    return;
  }

  await fsPromises.mkdir(destDir, { recursive: true });

  const url = `https://github.com/sigstore/cosign/releases/download/${COSIGN_VERSION}/${entry.asset}`;
  console.log(`[cosign] downloading ${url}`);
  console.log(`[cosign]      → ${destFile}`);
  await downloadFollowingRedirects(url, destFile);
  if (platform !== "win32") {
    await fsPromises.chmod(destFile, 0o755);
  }
  const stat = await fsPromises.stat(destFile);
  console.log(`[cosign] downloaded ${(stat.size / (1024 * 1024)).toFixed(1)} MiB`);
}

main().catch((err) => {
  console.error("[cosign] download failed:", err);
  process.exit(1);
});
