// Stamp the freshly built /sdk/plugin-frontend.js content hash into every
// plugin iframe HTML's <script src> reference. Run after `bun build` of the
// SDK bundle.
//
// Why this exists:
//   The runtime serves /sdk/plugin-frontend.js with `Cache-Control: no-cache`,
//   but browser HTTP caches and CDN edge caches that captured a previous
//   long-TTL response can keep serving the stale bundle for up to an hour.
//   The iframe HTML is fetched fresh on every load, so if its <script src>
//   includes a content hash, every bundle change becomes a new URL string —
//   which all caches treat as a fresh resource and fetch from origin.
//
// Strategy:
//   - sha256 the bundle, take the first 12 hex chars.
//   - Walk core-plugins/ for *.html files.
//   - Rewrite /sdk/plugin-frontend.js[?v=...]? -> /sdk/plugin-frontend.js?v=<hash>
//
// CWD: repo root (the same root the Dockerfile uses; `cd /app && bun run …`).

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BUNDLE_PATH = "runtime/public/sdk/plugin-frontend.js";
const PLUGINS_ROOT = "core-plugins";
const SDK_REF = /\/sdk\/plugin-frontend\.js(?:\?[^"' >]*)?/g;

function sha256Prefix(path: string, bytes: number): string {
  const buf = readFileSync(path);
  const hex = createHash("sha256").update(buf).digest("hex");
  return hex.slice(0, bytes);
}

function* walkHtml(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) yield* walkHtml(p);
    else if (s.isFile() && p.endsWith(".html")) yield p;
  }
}

function main(): void {
  const hash = sha256Prefix(BUNDLE_PATH, 12);
  const replacement = `/sdk/plugin-frontend.js?v=${hash}`;
  let stamped = 0;
  for (const file of walkHtml(PLUGINS_ROOT)) {
    const orig = readFileSync(file, "utf8");
    if (!SDK_REF.test(orig)) continue;
    SDK_REF.lastIndex = 0;
    const next = orig.replace(SDK_REF, replacement);
    if (next === orig) continue;
    writeFileSync(file, next);
    process.stdout.write(`stamped ${file} -> ?v=${hash}\n`);
    stamped += 1;
  }
  process.stdout.write(`SDK cache-bust applied to ${String(stamped)} file(s) (hash=${hash}).\n`);
}

main();
