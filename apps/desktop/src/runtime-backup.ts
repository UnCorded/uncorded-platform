// Pre-update snapshot helpers for the orchestrator's update flow.
// Implements the §7.3 backup-before-update contract from
// .claude/docs/prod-docs/phase-01/runtime-lifecycle.md.
//
// The spec sketches an alpine-helper container (`docker run --rm -v ... cp`).
// Desktop diverges intentionally: every per-server volume is a host bind mount
// rooted at <volumePath>/{data,config,plugins} (see server-runtime.ts:121-130),
// so node:fs/promises copies do the same job without spawning a sidecar.
// Mobile / hosted control planes that use real docker volumes can keep the
// alpine sketch — the runtime never observes which path the orchestrator took.
//
// Layout produced (matches §7.1 exactly):
//   <volumePath>/config/backups/<ISO>-pre-update/
//     ├── data/     (snapshot of <volumePath>/data)
//     └── config/   (snapshot of <volumePath>/config, EXCLUDING backups/)
//
// Excluding `backups/` from the config snapshot is critical — without it,
// each new backup would include every prior backup, so size and copy time
// would compound per update. Also avoids the literal infinite-recursion
// (we'd be writing into a directory we're reading from).

import { promises as fs, type Dirent } from "node:fs";
import path from "node:path";

/** Directory name reserved for pre-update snapshots inside <volumePath>/config. */
const BACKUPS_SUBDIR = "backups";
/** Suffix appended to the ISO timestamp to disambiguate from any future
 *  backup category (e.g. pre-rollback) that might land in the same dir. */
const PRE_UPDATE_SUFFIX = "-pre-update";

export interface PreUpdateBackup {
  /** ISO8601 timestamp portion of the directory name (without the suffix). */
  iso: string;
  /** Absolute path to the backup directory. */
  dir: string;
  /** Epoch ms parsed from the ISO timestamp. Used for ordering. */
  createdAt: number;
}

export class RuntimeBackupError extends Error {
  constructor(
    public readonly phase: "create" | "restore" | "rotate" | "list",
    public override readonly cause: unknown,
    message: string,
  ) {
    super(message);
    this.name = "RuntimeBackupError";
  }
}

function backupsRoot(volumePath: string): string {
  return path.join(volumePath, "config", BACKUPS_SUBDIR);
}

// ISO8601 with colons/dots replaced — `2026-05-09T17:34:21.456Z` becomes
// `2026-05-09T17-34-21-456Z`. Filesystems that reject `:` (NTFS, FAT) need
// this. We can still parse it back to a timestamp by reversing the swap.
function isoForFilename(now: number): string {
  return new Date(now).toISOString().replace(/[:.]/g, "-");
}

function parseBackupIso(filename: string): number | null {
  if (!filename.endsWith(PRE_UPDATE_SUFFIX)) return null;
  const isoPart = filename.slice(0, -PRE_UPDATE_SUFFIX.length);
  // Reverse the colon/dot encoding via a strict regex over the
  // YYYY-MM-DDTHH-MM-SS-mmmZ shape isoForFilename produces. A regex is
  // safer than splitting on `-` because the `T` glues the date/time halves
  // together and `split("-")` would otherwise miscount segments.
  const m = isoPart.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/);
  if (!m) return null;
  const reconstructed = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${m[7]}Z`;
  const epoch = Date.parse(reconstructed);
  return Number.isFinite(epoch) ? epoch : null;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// Recursive copy that skips a configurable child directory. Used so the
// /config snapshot doesn't recurse into /config/backups (its own grandparent).
// fs.cp on Node 20+ supports a `filter` callback, but we open-code this
// because the filter API is awkward for "skip this exact descendant" and
// because it keeps the implementation testable on older runtimes that bundle
// fs.cp behind a flag (Electron 33 ships Node 20.x; safe but explicit beats
// implicit here).
async function copyDirExcluding(
  src: string,
  dst: string,
  excludeAbsolute: string | null,
): Promise<void> {
  await fs.mkdir(dst, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcChild = path.join(src, entry.name);
    if (excludeAbsolute !== null && path.resolve(srcChild) === path.resolve(excludeAbsolute)) {
      continue;
    }
    const dstChild = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      await copyDirExcluding(srcChild, dstChild, excludeAbsolute);
    } else if (entry.isSymbolicLink()) {
      // Preserve symlinks rather than dereferencing — matches `cp -a` from
      // the spec sketch, and avoids accidentally bloating the backup with
      // the contents of a symlinked external directory (e.g. a developer
      // who symlinked /data/plugins to a source tree).
      const target = await fs.readlink(srcChild);
      await fs.symlink(target, dstChild);
    } else if (entry.isFile()) {
      await fs.copyFile(srcChild, dstChild);
    }
    // Other dirent types (sockets, fifos, devices) are intentionally skipped
    // — they shouldn't exist under user data dirs, and silently ignoring is
    // safer than failing the whole backup if some plugin laid down a fifo.
  }
}

/** Snapshot <volumePath>/data and <volumePath>/config (minus the backups dir
 *  itself) into <volumePath>/config/backups/<ISO>-pre-update/. Returns the
 *  backup descriptor so the caller can persist it (e.g. in update-state)
 *  and pass it back to {@link restorePreUpdateBackup} on rollback.
 *
 *  The whole operation is atomic-ish: the destination dir is built under a
 *  temporary `.partial` suffix and renamed at the end, so a crash mid-copy
 *  leaves a `.partial` directory that {@link listPreUpdateBackups} ignores.
 *  Rotation can clean those up out-of-band. */
export async function createPreUpdateBackup(args: {
  volumePath: string;
  now?: () => number;
}): Promise<PreUpdateBackup> {
  const now = args.now ?? Date.now;
  const epoch = now();
  const iso = isoForFilename(epoch);
  const finalDir = path.join(backupsRoot(args.volumePath), `${iso}${PRE_UPDATE_SUFFIX}`);
  const partialDir = `${finalDir}.partial`;

  try {
    await fs.mkdir(backupsRoot(args.volumePath), { recursive: true });
    // Clean any leftover partial from a prior crashed attempt so the rename
    // target is free.
    await fs.rm(partialDir, { recursive: true, force: true });

    const dataSrc = path.join(args.volumePath, "data");
    const configSrc = path.join(args.volumePath, "config");

    if (await pathExists(dataSrc)) {
      await copyDirExcluding(dataSrc, path.join(partialDir, "data"), null);
    } else {
      // First-boot servers may not have a /data dir yet. Create an empty
      // marker so the restore path doesn't have to special-case absence.
      await fs.mkdir(path.join(partialDir, "data"), { recursive: true });
    }

    if (await pathExists(configSrc)) {
      await copyDirExcluding(
        configSrc,
        path.join(partialDir, "config"),
        backupsRoot(args.volumePath),
      );
    } else {
      await fs.mkdir(path.join(partialDir, "config"), { recursive: true });
    }

    await fs.rename(partialDir, finalDir);
    return { iso, dir: finalDir, createdAt: epoch };
  } catch (err) {
    // Best-effort cleanup of the partial dir so it doesn't accumulate.
    try { await fs.rm(partialDir, { recursive: true, force: true }); } catch { /* ignore */ }
    throw new RuntimeBackupError(
      "create",
      err,
      `Failed to create pre-update backup at ${finalDir}`,
    );
  }
}

/** Restore <volumePath>/data and <volumePath>/config from a previously-
 *  captured backup directory. Used on the rollback path after the orchestrator
 *  has stopped the new container and before relaunching the `:previous` image.
 *
 *  Implementation: stash the live data/ and config/ aside as safety nets,
 *  then materialize the backup contents into the live paths, then drop the
 *  safety nets. The backup itself lives inside config/backups/, so after
 *  stashing we re-derive the source paths from the stashed config dir
 *  (otherwise we'd be reading from a directory we just moved). On failure
 *  we put the stash back so the runtime isn't left with a half-restored
 *  state.
 *
 *  After a successful restore the entire backups subtree (including the
 *  snapshot we restored from) is moved from the stash back into the new
 *  config, so prior backups remain available for diagnosis or a repeat
 *  rollback. */
export async function restorePreUpdateBackup(args: {
  volumePath: string;
  backupDir: string;
  now?: () => number;
}): Promise<void> {
  const now = args.now ?? Date.now;
  const dataLive = path.join(args.volumePath, "data");
  const configLive = path.join(args.volumePath, "config");

  // Validate snapshot integrity before any destructive moves.
  const dataSrcLive = path.join(args.backupDir, "data");
  const configSrcLive = path.join(args.backupDir, "config");
  if (!(await pathExists(dataSrcLive)) || !(await pathExists(configSrcLive))) {
    throw new RuntimeBackupError(
      "restore",
      null,
      `Backup at ${args.backupDir} is missing data/ or config/ subdirectory`,
    );
  }

  // backupDir is expected to live inside the live config dir (typically
  // config/backups/<iso>-pre-update). After we stash configLive, the source
  // bytes are at <configStash>/<relBackup>. Refuse out-of-tree backups so we
  // don't accidentally restore from a path the orchestrator never wrote.
  const relBackup = path.relative(path.resolve(configLive), path.resolve(args.backupDir));
  if (relBackup.startsWith("..") || path.isAbsolute(relBackup)) {
    throw new RuntimeBackupError(
      "restore",
      null,
      `backupDir ${args.backupDir} must live inside ${configLive}`,
    );
  }

  // Suffix is namespaced + monotonic so concurrent restores (an operator
  // double-clicking, say) don't collide on the stash path.
  const stashSuffix = `restore-stash-${String(now())}`;
  const dataStash = path.join(args.volumePath, `data.${stashSuffix}`);
  const configStash = path.join(args.volumePath, `config.${stashSuffix}`);

  try {
    if (await pathExists(dataLive)) await fs.rename(dataLive, dataStash);
    if (await pathExists(configLive)) await fs.rename(configLive, configStash);

    const stashedDataSrc = path.join(configStash, relBackup, "data");
    const stashedConfigSrc = path.join(configStash, relBackup, "config");

    await copyDirExcluding(stashedDataSrc, dataLive, null);
    await copyDirExcluding(stashedConfigSrc, configLive, null);

    // Move the backups subtree (including the snapshot we restored from)
    // out of the stash and into the new config dir. The new config dir
    // doesn't yet have a backups/ child since we excluded it on create.
    const stashedBackupsRoot = path.join(configStash, "backups");
    if (await pathExists(stashedBackupsRoot)) {
      await fs.rename(stashedBackupsRoot, backupsRoot(args.volumePath));
    }

    await fs.rm(dataStash, { recursive: true, force: true });
    await fs.rm(configStash, { recursive: true, force: true });
  } catch (err) {
    // Roll back: discard whatever we managed to materialize, then move the
    // stash back into place. Best-effort — by the time we're here some bytes
    // may already be on disk in the wrong shape.
    try {
      if (await pathExists(dataLive)) await fs.rm(dataLive, { recursive: true, force: true });
      if (await pathExists(configLive)) await fs.rm(configLive, { recursive: true, force: true });
      if (await pathExists(dataStash)) await fs.rename(dataStash, dataLive);
      if (await pathExists(configStash)) await fs.rename(configStash, configLive);
    } catch {
      // If even the rollback fails, surface the original error — the operator
      // will need the manual-recovery copy from update-ux.md §4.4.
    }
    throw new RuntimeBackupError(
      "restore",
      err,
      `Failed to restore from backup ${args.backupDir}`,
    );
  }
}

/** List every pre-update backup under <volumePath>/config/backups, sorted
 *  newest-first by createdAt. Skips `.partial` directories left by crashed
 *  create attempts and silently drops directories that don't match the
 *  expected ISO-pre-update naming convention. */
export async function listPreUpdateBackups(args: {
  volumePath: string;
}): Promise<PreUpdateBackup[]> {
  const root = backupsRoot(args.volumePath);
  if (!(await pathExists(root))) return [];

  let entries: Dirent[];
  try {
    // Cast through unknown: the readdir overload returned by `withFileTypes:
    // true` (without specifying encoding) resolves to `Dirent<NonSharedBuffer>[]`
    // under Node's typing, but at runtime the `name` field is a string when
    // the path itself is a string. Narrow back to the string-named Dirent.
    entries = (await fs.readdir(root, { withFileTypes: true })) as unknown as Dirent[];
  } catch (err) {
    throw new RuntimeBackupError(
      "list",
      err,
      `Failed to enumerate backups at ${root}`,
    );
  }

  const out: PreUpdateBackup[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.endsWith(".partial")) continue;
    const epoch = parseBackupIso(entry.name);
    if (epoch === null) continue;
    const iso = entry.name.slice(0, -PRE_UPDATE_SUFFIX.length);
    out.push({ iso, dir: path.join(root, entry.name), createdAt: epoch });
  }

  out.sort((a, b) => b.createdAt - a.createdAt);
  return out;
}

/** Delete the oldest backups beyond `keep`. Per §7.3 the default is 3.
 *  Returns the directories removed. Failed deletions don't throw — rotation
 *  is best-effort and the next call will try again. Caller is expected to
 *  invoke this at update commit time, after a successful update, so failed
 *  updates' backups stay around for diagnosis. */
export async function rotateBackups(args: {
  volumePath: string;
  keep: number;
}): Promise<string[]> {
  if (args.keep < 0) {
    throw new RuntimeBackupError(
      "rotate",
      null,
      `keep must be >= 0, got ${String(args.keep)}`,
    );
  }
  const all = await listPreUpdateBackups({ volumePath: args.volumePath });
  const stale = all.slice(args.keep);
  const removed: string[] = [];
  for (const b of stale) {
    try {
      await fs.rm(b.dir, { recursive: true, force: true });
      removed.push(b.dir);
    } catch (err) {
      console.warn("[runtime-backup] failed to rotate backup", { dir: b.dir, err });
    }
  }
  return removed;
}
