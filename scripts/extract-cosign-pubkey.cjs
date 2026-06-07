#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-var-requires */
// Prints the COSIGN_PUBKEY_PEM string from `runtime/src/signing/cosign-pubkey.ts`
// to stdout, suitable for `> /tmp/cosign.pub` then `cosign verify --key`.
//
// Lives alongside `check-cosign-pubkey-sync.cjs` and uses the same anchored
// regex so the two stay in sync. Earlier inline regex in release-runtime.yml's
// "Verify signature" step matched the EXAMPLE PEM in the file's docstring
// (lines 31-34) instead of the real export — handing cosign a `// MFkw...`
// payload that failed PEM decoding. Anchoring to start-of-line + the
// `(?:export\s+)?const\s+` prefix dodges the comment.
//
// Used by .github/workflows/release-runtime.yml.

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const RUNTIME_FILE = path.join(ROOT, "runtime/src/signing/cosign-pubkey.ts");

const src = fs.readFileSync(RUNTIME_FILE, "utf8");
const match = src.match(
  /^(?:export\s+)?const\s+COSIGN_PUBKEY_PEM\s*=\s*("(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)/m,
);

if (!match) {
  console.error(
    `[extract-cosign-pubkey] COSIGN_PUBKEY_PEM declaration not found in ${RUNTIME_FILE}`,
  );
  process.exit(1);
}

// eslint-disable-next-line no-eval
const pem = eval(match[1]);
process.stdout.write(pem);
