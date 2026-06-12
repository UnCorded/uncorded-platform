// Soft-delete for server volumes. A server's volume holds irreplaceable user
// data — custom plugins, channel history, server config — so teardown must
// NEVER permanently `rm` it. That applies to both intentional deletes and the
// automatic reconcile orphan-purge (which can fire on a transient/erroneous
// Central response). Instead we move the volume into ~/.uncorded/trash and let a
// startup GC reclaim entries past the retention window. The owning server's
// encryption secret is deliberately kept until GC so the archived at-rest data
// stays decryptable while it's recoverable.
//
// Kept free of electron imports so it's unit-testable without booting Electron;
// main.ts wires the real secret-store + logger.

import { existsSync } from "node:fs";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

// 30 days of recoverability before a teardown becomes permanent. Long enough to
// notice "my server vanished" and recover; short enough that intentional
// deletes eventually free disk.
export const ARCHIVE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

// Field separator in archived dir names. slugs come from slugify() (no
// underscores) and serverIds are UUIDs (no underscores), so "__" can't collide
// with their contents — but parseArchiveName still splits from the right to
// tolerate a legacy slug that somehow contains it.
const SEP = "__";

function defaultRoot(): string {
  return path.join(homedir(), ".uncorded");
}

export function trashDir(root: string = defaultRoot()): string {
  return path.join(root, "trash");
}

// Encode serverId + timestamp into the archived dir name so GC can decide expiry
// and drop the matching encryption secret. The slug is cosmetic (human-readable
// in the trash listing).
function archiveName(slug: string, serverId: string, now: number): string {
  return `${slug}${SEP}${serverId}${SEP}${String(now)}`;
}

export interface ParsedArchiveName {
  slug: string;
  serverId: string;
  ts: number;
}

export function parseArchiveName(name: string): ParsedArchiveName | null {
  const lastSep = name.lastIndexOf(SEP);
  if (lastSep < 0) return null;
  const tsStr = name.slice(lastSep + SEP.length);
  const rest = name.slice(0, lastSep);
  const midSep = rest.lastIndexOf(SEP);
  if (midSep < 0) return null;
  const serverId = rest.slice(midSep + SEP.length);
  const slug = rest.slice(0, midSep);
  const ts = Number(tsStr);
  if (slug.length === 0 || serverId.length === 0 || !Number.isInteger(ts) || ts <= 0) {
    return null;
  }
  return { slug, serverId, ts };
}

export interface ArchiveResult {
  archived: boolean;
  dest?: string;
}

/**
 * Move a server volume into the trash. Idempotent: returns `archived: false`
 * (without throwing) when the volume is already gone, so callers can run it on a
 * partially torn-down server. Throws only on a genuine move failure — callers
 * log and continue; it must NEVER fall back to `rm`, which would defeat the
 * entire point (a failed archive leaves the data in place, still recoverable).
 */
export async function archiveServerVolume(
  serverId: string,
  volumePath: string,
  opts: { root?: string; now?: number } = {},
): Promise<ArchiveResult> {
  if (!existsSync(volumePath)) return { archived: false };
  const root = opts.root ?? defaultRoot();
  const slug = path.basename(volumePath);
  const dir = trashDir(root);
  await mkdir(dir, { recursive: true });

  // Collision guard: a second purge of the same server within the same
  // millisecond, or a leftover archive. Bump the encoded timestamp (keeps the
  // name parseable) until the destination is free.
  let now = opts.now ?? Date.now();
  let dest = path.join(dir, archiveName(slug, serverId, now));
  while (existsSync(dest)) {
    now += 1;
    dest = path.join(dir, archiveName(slug, serverId, now));
  }

  await rename(volumePath, dest);
  return { archived: true, dest };
}

/**
 * Remove archived volumes older than the retention window. Calls `onReclaim`
 * with each removed entry's serverId so the caller can drop the now-unneeded
 * encryption secret. Best-effort per entry — a single failure never aborts the
 * sweep. Returns the serverIds reclaimed (for logging / tests).
 */
export async function gcExpiredArchives(
  opts: {
    root?: string;
    now?: number;
    retentionMs?: number;
    onReclaim?: (serverId: string) => void;
    onError?: (name: string, err: unknown) => void;
  } = {},
): Promise<string[]> {
  const root = opts.root ?? defaultRoot();
  const now = opts.now ?? Date.now();
  const retentionMs = opts.retentionMs ?? ARCHIVE_RETENTION_MS;
  const dir = trashDir(root);
  if (!existsSync(dir)) return [];

  // Infer the Dirent[] type from the call (annotating with ReturnType<readdir>
  // picks the Buffer overload). null on read failure → treat as empty.
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
  if (entries === null) return [];

  const reclaimed: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const parsed = parseArchiveName(entry.name);
    if (!parsed) continue;
    if (now - parsed.ts < retentionMs) continue;
    try {
      await rm(path.join(dir, entry.name), { recursive: true, force: true });
      reclaimed.push(parsed.serverId);
      opts.onReclaim?.(parsed.serverId);
    } catch (err) {
      opts.onError?.(entry.name, err);
    }
  }
  return reclaimed;
}
