import { beforeAll, describe, expect, test } from "bun:test";
import type { UpdateState } from "./auto-update";

let mod: typeof import("./auto-update");

beforeAll(async () => {
  // auto-update.ts imports `electron` and `electron-updater` at module scope.
  // Bun's test runner can't load the real Electron runtime; both are stubbed
  // globally by the test preload (apps/desktop/test/preload-electron.ts) before
  // any file links, so no per-file electron mock is needed here. The reducers
  // under test never touch these — they're only wired in by setupAutoUpdater(),
  // which this suite deliberately doesn't call.
  mod = await import("./auto-update");
});

describe("getDisabledReason", () => {
  test("dev builds are disabled", () => {
    expect(
      mod.getDisabledReason({
        isPackaged: false,
        platform: "darwin",
        env: {},
      }),
    ).toEqual({ disabled: true, reason: "dev-build" });
  });

  test("UNCORDED_DISABLE_AUTO_UPDATE=1 wins over packaged", () => {
    expect(
      mod.getDisabledReason({
        isPackaged: true,
        platform: "darwin",
        env: { UNCORDED_DISABLE_AUTO_UPDATE: "1" },
      }),
    ).toEqual({ disabled: true, reason: "env-override" });
  });

  test("Linux without APPIMAGE env is disabled", () => {
    expect(
      mod.getDisabledReason({
        isPackaged: true,
        platform: "linux",
        env: {},
      }),
    ).toEqual({ disabled: true, reason: "linux-non-appimage" });
  });

  test("Linux AppImage is enabled", () => {
    expect(
      mod.getDisabledReason({
        isPackaged: true,
        platform: "linux",
        env: { APPIMAGE: "/tmp/UnCorded.AppImage" },
      }),
    ).toEqual({ disabled: false });
  });

  test("packaged Windows is enabled", () => {
    expect(
      mod.getDisabledReason({
        isPackaged: true,
        platform: "win32",
        env: {},
      }),
    ).toEqual({ disabled: false });
  });

  test("packaged macOS is enabled", () => {
    expect(
      mod.getDisabledReason({
        isPackaged: true,
        platform: "darwin",
        env: {},
      }),
    ).toEqual({ disabled: false });
  });
});

describe("shouldBroadcastProgress", () => {
  test("first progress event always broadcasts", () => {
    expect(mod.shouldBroadcastProgress(null, 0)).toBe(true);
    expect(mod.shouldBroadcastProgress(null, 7)).toBe(true);
  });

  test("within a bucket, no broadcast", () => {
    expect(mod.shouldBroadcastProgress(0, 3)).toBe(false);
    expect(mod.shouldBroadcastProgress(10, 15)).toBe(false);
    expect(mod.shouldBroadcastProgress(40, 49.9)).toBe(false);
  });

  test("crossing a 10% bucket broadcasts", () => {
    expect(mod.shouldBroadcastProgress(9, 10)).toBe(true);
    expect(mod.shouldBroadcastProgress(19, 20)).toBe(true);
    expect(mod.shouldBroadcastProgress(99, 100)).toBe(true);
  });

  test("descending progress (unlikely but possible) broadcasts", () => {
    expect(mod.shouldBroadcastProgress(50, 39)).toBe(true);
  });
});

describe("initialState", () => {
  test("enabled → idle", () => {
    const s = mod.initialState(true, "0.1.0");
    expect(s.enabled).toBe(true);
    expect(s.status).toBe("idle");
    expect(s.currentVersion).toBe("0.1.0");
    expect(s.canRetry).toBe(false);
    expect(s.errorContext).toBe(null);
  });

  test("disabled → disabled", () => {
    const s = mod.initialState(false, "0.1.0");
    expect(s.enabled).toBe(false);
    expect(s.status).toBe("disabled");
  });
});

describe("reducers", () => {
  const base = () => mod.initialState(true, "0.1.0");

  test("reduceOnCheckStart clears error state", () => {
    const withError = mod.reduceOnCheckFailure(base(), "boom");
    const next = mod.reduceOnCheckStart(withError);
    expect(next.status).toBe("checking");
    expect(next.message).toBe(null);
    expect(next.errorContext).toBe(null);
    expect(next.canRetry).toBe(false);
  });

  test("reduceOnCheckFailure tags errorContext=check + canRetry", () => {
    const s = mod.reduceOnCheckFailure(base(), "ENETUNREACH");
    expect(s.status).toBe("error");
    expect(s.message).toBe("ENETUNREACH");
    expect(s.errorContext).toBe("check");
    expect(s.canRetry).toBe(true);
  });

  test("reduceOnUpdateAvailable records version + checkedAt", () => {
    const s = mod.reduceOnUpdateAvailable(base(), { version: "0.2.0" });
    expect(s.status).toBe("available");
    expect(s.availableVersion).toBe("0.2.0");
    expect(s.checkedAt).not.toBe(null);
    expect(s.errorContext).toBe(null);
  });

  test("reduceOnNoUpdate clears available + downloaded versions", () => {
    const withAvail = mod.reduceOnUpdateAvailable(base(), { version: "0.2.0" });
    const s = mod.reduceOnNoUpdate(withAvail);
    expect(s.status).toBe("up-to-date");
    expect(s.availableVersion).toBe(null);
    expect(s.downloadedVersion).toBe(null);
    expect(s.checkedAt).not.toBe(null);
  });

  test("reduceOnDownloadStart zeros percent and clears error state", () => {
    const withError = mod.reduceOnDownloadFailure(base(), "boom");
    const s = mod.reduceOnDownloadStart(withError);
    expect(s.status).toBe("downloading");
    expect(s.downloadPercent).toBe(0);
    expect(s.errorContext).toBe(null);
    expect(s.canRetry).toBe(false);
  });

  test("reduceOnDownloadProgress buckets to 10%", () => {
    const s0 = mod.reduceOnDownloadStart(base());
    expect(mod.reduceOnDownloadProgress(s0, 0).downloadPercent).toBe(0);
    expect(mod.reduceOnDownloadProgress(s0, 7).downloadPercent).toBe(0);
    expect(mod.reduceOnDownloadProgress(s0, 15.9).downloadPercent).toBe(10);
    expect(mod.reduceOnDownloadProgress(s0, 99.9).downloadPercent).toBe(90);
    expect(mod.reduceOnDownloadProgress(s0, 100).downloadPercent).toBe(100);
    // Guard against out-of-range: clamp at 100.
    expect(mod.reduceOnDownloadProgress(s0, 150).downloadPercent).toBe(100);
  });

  test("reduceOnDownloadFailure tags errorContext=download", () => {
    const s = mod.reduceOnDownloadFailure(base(), "ECONNRESET");
    expect(s.status).toBe("error");
    expect(s.downloadPercent).toBe(null);
    expect(s.errorContext).toBe("download");
    expect(s.canRetry).toBe(true);
    expect(s.message).toBe("ECONNRESET");
  });

  test("reduceOnDownloadComplete pins percent=100 and records version", () => {
    const s = mod.reduceOnDownloadComplete(base(), { version: "0.2.0" });
    expect(s.status).toBe("downloaded");
    expect(s.downloadedVersion).toBe("0.2.0");
    expect(s.downloadPercent).toBe(100);
    expect(s.errorContext).toBe(null);
  });

  test("reduceOnInstallFailure tags errorContext=install", () => {
    const withDownloaded = mod.reduceOnDownloadComplete(base(), {
      version: "0.2.0",
    });
    const s = mod.reduceOnInstallFailure(withDownloaded, "EACCES");
    expect(s.status).toBe("error");
    expect(s.errorContext).toBe("install");
    expect(s.canRetry).toBe(true);
    expect(s.message).toBe("EACCES");
    // downloaded version should still be present — the binary exists on disk.
    expect(s.downloadedVersion).toBe("0.2.0");
  });

  test("reducers preserve currentVersion and enabled across transitions", () => {
    const s0 = base();
    const chain = [
      mod.reduceOnCheckStart,
      (s: UpdateState) =>
        mod.reduceOnUpdateAvailable(s, { version: "0.2.0" }),
      mod.reduceOnDownloadStart,
      (s: UpdateState) => mod.reduceOnDownloadProgress(s, 50),
      (s: UpdateState) =>
        mod.reduceOnDownloadComplete(s, { version: "0.2.0" }),
    ];
    const final = chain.reduce((s, step) => step(s), s0);
    expect(final.enabled).toBe(true);
    expect(final.currentVersion).toBe("0.1.0");
  });
});
