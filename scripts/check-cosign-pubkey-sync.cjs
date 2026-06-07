#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-var-requires */
// Guard: keep `runtime/src/signing/cosign-pubkey.ts` and the desktop-side
// mirror in `apps/desktop/src/runtime-orchestrator.ts` in lock-step.
//
// Why duplicated: the runtime ships in a Docker image with its own tsconfig
// rootDir; desktop's tsconfig refuses cross-rootDir imports. Rather than
// loosen rootDir (which would pull the entire runtime/ tree into the desktop
// build), we keep a tiny duplicated constant and verify equality in CI.
//
// Run from `release-desktop.yml` and locally via `bun run check-cosign-sync`.
// Exits non-zero with a diff hint if the two PEMs disagree.

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const RUNTIME_FILE = path.join(ROOT, "runtime/src/signing/cosign-pubkey.ts");
const DESKTOP_FILE = path.join(ROOT, "apps/desktop/src/runtime-orchestrator.ts");

function extractPem(filePath) {
  const src = fs.readFileSync(filePath, "utf8");
  // Anchor to start-of-line + `(export )?const ` so we never match the example
  // PEM that lives inside a comment block. The runtime file uses
  // `export const`; the desktop mirror uses bare `const`. /m enables ^ to match
  // line starts.
  const match = src.match(/^(?:export\s+)?const\s+COSIGN_PUBKEY_PEM\s*=\s*("(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)/m);
  if (!match) {
    throw new Error(`COSIGN_PUBKEY_PEM declaration not found in ${filePath}`);
  }
  // eslint-disable-next-line no-eval
  return eval(match[1]);
}

const runtimePem = extractPem(RUNTIME_FILE);
const desktopPem = extractPem(DESKTOP_FILE);

if (runtimePem !== desktopPem) {
  console.error(
    "[check-cosign-sync] FAIL: runtime and desktop COSIGN_PUBKEY_PEM disagree.",
  );
  console.error(`  runtime (${RUNTIME_FILE}):\n${JSON.stringify(runtimePem)}`);
  console.error(`  desktop (${DESKTOP_FILE}):\n${JSON.stringify(desktopPem)}`);
  console.error(
    "Update the desktop mirror in apps/desktop/src/runtime-orchestrator.ts to match.",
  );
  process.exit(1);
}

console.log("[check-cosign-sync] OK: PEMs match.");
