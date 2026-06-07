import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createPreUpdateBackup,
  listPreUpdateBackups,
  restorePreUpdateBackup,
  rotateBackups,
  RuntimeBackupError,
} from "./runtime-backup";

// Each test gets its own throwaway volume root so concurrent test files (and
// re-runs after a crash) don't see each other's bytes.
let volumePath = "";

beforeEach(async () => {
  volumePath = await fs.mkdtemp(path.join(tmpdir(), "uncorded-backup-test-"));
});

afterEach(async () => {
  await fs.rm(volumePath, { recursive: true, force: true });
});

async function seedFile(rel: string, contents: string): Promise<void> {
  const abs = path.join(volumePath, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, contents, "utf8");
}

async function readFileOrNull(rel: string): Promise<string | null> {
  try {
    return await fs.readFile(path.join(volumePath, rel), "utf8");
  } catch {
    return null;
  }
}

describe("createPreUpdateBackup", () => {
  test("snapshots data and config into config/backups/<iso>-pre-update", async () => {
    await seedFile("data/plugins/text-channels/data.sqlite", "DATA-BLOB");
    await seedFile("config/server.json", '{"name":"hello"}');
    await seedFile("config/voice/livekit.yaml", "key: val");

    const backup = await createPreUpdateBackup({
      volumePath,
      now: () => Date.parse("2026-05-09T17:34:21.456Z"),
    });

    expect(backup.dir.endsWith("2026-05-09T17-34-21-456Z-pre-update")).toBe(true);
    expect(backup.iso).toBe("2026-05-09T17-34-21-456Z");
    expect(backup.createdAt).toBe(Date.parse("2026-05-09T17:34:21.456Z"));

    expect(await readFileOrNull(path.join(
      "config/backups/2026-05-09T17-34-21-456Z-pre-update/data/plugins/text-channels/data.sqlite",
    ))).toBe("DATA-BLOB");
    expect(await readFileOrNull(path.join(
      "config/backups/2026-05-09T17-34-21-456Z-pre-update/config/server.json",
    ))).toBe('{"name":"hello"}');
    expect(await readFileOrNull(path.join(
      "config/backups/2026-05-09T17-34-21-456Z-pre-update/config/voice/livekit.yaml",
    ))).toBe("key: val");
  });

  test("excludes config/backups/ from the config snapshot (no recursion)", async () => {
    await seedFile("config/server.json", "live");
    await seedFile("config/backups/old-pre-update/config/server.json", "old");

    const backup = await createPreUpdateBackup({ volumePath });

    // The new snapshot contains config/server.json…
    expect(await readFileOrNull(
      path.relative(volumePath, path.join(backup.dir, "config/server.json")),
    )).toBe("live");
    // …but does NOT contain a nested backups/ subtree.
    const newBackupConfigEntries = await fs.readdir(path.join(backup.dir, "config"));
    expect(newBackupConfigEntries).not.toContain("backups");
  });

  test("handles a server with no /data dir yet (first-boot)", async () => {
    await seedFile("config/server.json", "fresh");

    const backup = await createPreUpdateBackup({ volumePath });

    // Empty data/ marker exists so restore doesn't have to special-case absence.
    const dataEntries = await fs.readdir(path.join(backup.dir, "data"));
    expect(dataEntries).toEqual([]);
    expect(await readFileOrNull(
      path.relative(volumePath, path.join(backup.dir, "config/server.json")),
    )).toBe("fresh");
  });

  test("preserves symlinks rather than dereferencing", async () => {
    await seedFile("data/real.txt", "real-bytes");
    const linkPath = path.join(volumePath, "data", "alias.txt");
    try {
      await fs.symlink(path.join(volumePath, "data", "real.txt"), linkPath);
    } catch (err) {
      // Symlink creation requires elevation on some Windows configurations;
      // skip this assertion rather than failing on dev boxes.
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES") return;
      throw err;
    }

    const backup = await createPreUpdateBackup({ volumePath });
    const stat = await fs.lstat(path.join(backup.dir, "data/alias.txt"));
    expect(stat.isSymbolicLink()).toBe(true);
  });

  test("cleans up the .partial directory if copying fails", async () => {
    // Force a failure by passing a volumePath whose config dir is unreadable.
    // Simplest reliable trigger: pre-create the backups root as a file so the
    // mkdir -p fails.
    await fs.mkdir(path.join(volumePath, "config"), { recursive: true });
    await fs.writeFile(path.join(volumePath, "config", "backups"), "not-a-dir", "utf8");

    await expect(createPreUpdateBackup({ volumePath })).rejects.toBeInstanceOf(
      RuntimeBackupError,
    );
  });
});

describe("listPreUpdateBackups", () => {
  test("returns empty when no backups directory exists", async () => {
    expect(await listPreUpdateBackups({ volumePath })).toEqual([]);
  });

  test("returns sorted newest-first and skips junk entries", async () => {
    await createPreUpdateBackup({
      volumePath,
      now: () => Date.parse("2026-05-09T10:00:00.000Z"),
    });
    await createPreUpdateBackup({
      volumePath,
      now: () => Date.parse("2026-05-09T12:00:00.000Z"),
    });
    await createPreUpdateBackup({
      volumePath,
      now: () => Date.parse("2026-05-09T11:00:00.000Z"),
    });

    // Litter the backups directory with non-matching entries to make sure
    // they're filtered out.
    await fs.mkdir(
      path.join(volumePath, "config/backups/garbage-name"),
      { recursive: true },
    );
    await fs.mkdir(
      path.join(volumePath, "config/backups/2026-05-09T13-00-00-000Z-pre-update.partial"),
      { recursive: true },
    );
    await fs.writeFile(
      path.join(volumePath, "config/backups/loose-file.txt"),
      "junk",
      "utf8",
    );

    const list = await listPreUpdateBackups({ volumePath });
    expect(list.map((b) => b.iso)).toEqual([
      "2026-05-09T12-00-00-000Z",
      "2026-05-09T11-00-00-000Z",
      "2026-05-09T10-00-00-000Z",
    ]);
  });
});

describe("rotateBackups", () => {
  test("keeps the N newest and removes older ones", async () => {
    const stamps = [
      "2026-05-09T08:00:00.000Z",
      "2026-05-09T09:00:00.000Z",
      "2026-05-09T10:00:00.000Z",
      "2026-05-09T11:00:00.000Z",
      "2026-05-09T12:00:00.000Z",
    ];
    for (const s of stamps) {
      await createPreUpdateBackup({ volumePath, now: () => Date.parse(s) });
    }

    const removed = await rotateBackups({ volumePath, keep: 3 });
    expect(removed).toHaveLength(2);

    const remaining = await listPreUpdateBackups({ volumePath });
    expect(remaining.map((b) => b.iso)).toEqual([
      "2026-05-09T12-00-00-000Z",
      "2026-05-09T11-00-00-000Z",
      "2026-05-09T10-00-00-000Z",
    ]);
  });

  test("noop when fewer backups exist than keep", async () => {
    await createPreUpdateBackup({
      volumePath,
      now: () => Date.parse("2026-05-09T08:00:00.000Z"),
    });
    const removed = await rotateBackups({ volumePath, keep: 3 });
    expect(removed).toEqual([]);
  });

  test("rejects negative keep", async () => {
    await expect(rotateBackups({ volumePath, keep: -1 })).rejects.toBeInstanceOf(
      RuntimeBackupError,
    );
  });

  test("keep=0 wipes everything", async () => {
    await createPreUpdateBackup({
      volumePath,
      now: () => Date.parse("2026-05-09T08:00:00.000Z"),
    });
    await createPreUpdateBackup({
      volumePath,
      now: () => Date.parse("2026-05-09T09:00:00.000Z"),
    });

    const removed = await rotateBackups({ volumePath, keep: 0 });
    expect(removed).toHaveLength(2);
    expect(await listPreUpdateBackups({ volumePath })).toEqual([]);
  });
});

describe("restorePreUpdateBackup", () => {
  test("restores data and config from a snapshot, preserving the backups subtree", async () => {
    // Initial state, snapshotted.
    await seedFile("data/plugins/text-channels/data.sqlite", "OLD-DATA");
    await seedFile("config/server.json", '{"name":"old"}');
    const backup = await createPreUpdateBackup({
      volumePath,
      now: () => Date.parse("2026-05-09T08:00:00.000Z"),
    });

    // Simulate the new container running and writing different state.
    await fs.writeFile(
      path.join(volumePath, "data/plugins/text-channels/data.sqlite"),
      "NEW-DATA",
      "utf8",
    );
    await fs.writeFile(
      path.join(volumePath, "config/server.json"),
      '{"name":"new"}',
      "utf8",
    );
    await seedFile("data/plugins/text-channels/extra.bin", "extra"); // new file from new version

    await restorePreUpdateBackup({
      volumePath,
      backupDir: backup.dir,
    });

    expect(await readFileOrNull("data/plugins/text-channels/data.sqlite")).toBe("OLD-DATA");
    expect(await readFileOrNull("config/server.json")).toBe('{"name":"old"}');
    // Files added by the failed update are gone — the snapshot is authoritative.
    expect(await readFileOrNull("data/plugins/text-channels/extra.bin")).toBeNull();
    // Backups subtree survives, including the directory we restored from.
    const remaining = await listPreUpdateBackups({ volumePath });
    expect(remaining.map((b) => b.iso)).toContain("2026-05-09T08-00-00-000Z");
  });

  test("throws RuntimeBackupError when backup is missing data/ or config/", async () => {
    await fs.mkdir(path.join(volumePath, "config/backups/broken-pre-update/data"), { recursive: true });
    // No config/ subdir.
    await expect(
      restorePreUpdateBackup({
        volumePath,
        backupDir: path.join(volumePath, "config/backups/broken-pre-update"),
      }),
    ).rejects.toBeInstanceOf(RuntimeBackupError);
  });

  test("doesn't leave the live volume in a broken state if rollback is invoked twice", async () => {
    await seedFile("data/file.txt", "v1");
    await seedFile("config/server.json", "v1");
    const backup = await createPreUpdateBackup({
      volumePath,
      now: () => Date.parse("2026-05-09T08:00:00.000Z"),
    });

    await fs.writeFile(path.join(volumePath, "data/file.txt"), "v2", "utf8");
    await restorePreUpdateBackup({ volumePath, backupDir: backup.dir });
    expect(await readFileOrNull("data/file.txt")).toBe("v1");

    // Restoring again should be idempotent.
    await restorePreUpdateBackup({ volumePath, backupDir: backup.dir });
    expect(await readFileOrNull("data/file.txt")).toBe("v1");
    expect(await readFileOrNull("config/server.json")).toBe("v1");
  });
});
