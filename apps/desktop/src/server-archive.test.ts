import { afterEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  ARCHIVE_RETENTION_MS,
  archiveServerVolume,
  gcExpiredArchives,
  parseArchiveName,
  trashDir,
} from "./server-archive";

// Real-filesystem tests in a throwaway temp root (injected via opts.root), so
// they exercise the actual rename/rm/readdir paths with zero electron or
// process-global dependency — deterministic regardless of file order.
const tmpRoots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "uncorded-archive-"));
  tmpRoots.push(root);
  return root;
}

async function makeVolume(root: string, slug: string): Promise<string> {
  const vol = path.join(root, "servers", slug);
  await mkdir(path.join(vol, "config"), { recursive: true });
  await mkdir(path.join(vol, "data", "plugins", "my-plugin"), { recursive: true });
  await writeFile(path.join(vol, "config", "server.json"), "{}", "utf8");
  await writeFile(path.join(vol, "data", "plugins", "my-plugin", "data.db"), "rows", "utf8");
  return vol;
}

afterEach(async () => {
  while (tmpRoots.length > 0) {
    const r = tmpRoots.pop();
    if (r) await rm(r, { recursive: true, force: true }).catch(() => {});
  }
});

describe("archiveServerVolume", () => {
  it("moves a server volume into trash and preserves its contents", async () => {
    const root = await makeRoot();
    const vol = await makeVolume(root, "my-server");

    const result = await archiveServerVolume("srv-1", vol, { root, now: 1_000_000 });

    expect(result.archived).toBe(true);
    expect(existsSync(vol)).toBe(false); // original moved, not copied
    const dest = result.dest;
    if (!dest) throw new Error("expected a dest path");
    expect(existsSync(path.join(dest, "config", "server.json"))).toBe(true);
    expect(existsSync(path.join(dest, "data", "plugins", "my-plugin", "data.db"))).toBe(true);

    const parsed = parseArchiveName(path.basename(dest));
    expect(parsed?.serverId).toBe("srv-1");
    expect(parsed?.ts).toBe(1_000_000);
  });

  it("is a no-op when the volume is already gone (idempotent)", async () => {
    const root = await makeRoot();
    const result = await archiveServerVolume("srv-x", path.join(root, "servers", "missing"), { root });
    expect(result.archived).toBe(false);
    expect(result.dest).toBeUndefined();
  });

  it("avoids name collisions by bumping the encoded timestamp", async () => {
    const root = await makeRoot();
    const a = await archiveServerVolume("srv-1", await makeVolume(root, "dup"), { root, now: 5000 });
    const b = await archiveServerVolume("srv-1", await makeVolume(root, "dup"), { root, now: 5000 });

    expect(a.dest).not.toBe(b.dest);
    if (!a.dest || !b.dest) throw new Error("expected both dests");
    expect(existsSync(a.dest)).toBe(true);
    expect(existsSync(b.dest)).toBe(true);
    // Both names stay parseable (the bump kept the ts numeric).
    expect(parseArchiveName(path.basename(b.dest))?.serverId).toBe("srv-1");
  });
});

describe("parseArchiveName", () => {
  it("round-trips a well-formed name", () => {
    expect(parseArchiveName("my-server__srv-1__1700000000000")).toEqual({
      slug: "my-server",
      serverId: "srv-1",
      ts: 1_700_000_000_000,
    });
  });

  it("rejects malformed names", () => {
    expect(parseArchiveName("nope")).toBeNull();
    expect(parseArchiveName("only__onesep")).toBeNull();
    expect(parseArchiveName("a__b__notanumber")).toBeNull();
    expect(parseArchiveName("a__b__0")).toBeNull(); // ts must be positive
  });

  it("tolerates a slug containing the separator by splitting from the right", () => {
    const parsed = parseArchiveName("we__ird__srv-9__123");
    expect(parsed?.slug).toBe("we__ird");
    expect(parsed?.serverId).toBe("srv-9");
    expect(parsed?.ts).toBe(123);
  });
});

describe("gcExpiredArchives", () => {
  it("removes archives past retention and reclaims their serverIds, keeping fresh ones", async () => {
    const root = await makeRoot();
    const now = 1_000_000_000_000;
    await archiveServerVolume("old-srv", await makeVolume(root, "old"), {
      root,
      now: now - ARCHIVE_RETENTION_MS - 1,
    });
    await archiveServerVolume("new-srv", await makeVolume(root, "new"), { root, now: now - 1000 });

    const reclaimedCb: string[] = [];
    const reclaimed = await gcExpiredArchives({ root, now, onReclaim: (s) => reclaimedCb.push(s) });

    expect(reclaimed).toEqual(["old-srv"]);
    expect(reclaimedCb).toEqual(["old-srv"]);
    const remaining = await readdir(trashDir(root));
    expect(remaining.some((n) => n.includes("new-srv"))).toBe(true);
    expect(remaining.some((n) => n.includes("old-srv"))).toBe(false);
  });

  it("returns [] when there is no trash dir", async () => {
    const root = await makeRoot();
    expect(await gcExpiredArchives({ root, now: 1_000_000 })).toEqual([]);
  });

  it("ignores files and unparseable directories in trash", async () => {
    const root = await makeRoot();
    const dir = trashDir(root);
    await mkdir(path.join(dir, "not-an-archive"), { recursive: true });
    await writeFile(path.join(dir, "stray.txt"), "x", "utf8");

    const reclaimed = await gcExpiredArchives({ root, now: 9_999_999_999_999 });

    expect(reclaimed).toEqual([]);
    expect(existsSync(path.join(dir, "not-an-archive"))).toBe(true);
  });
});
