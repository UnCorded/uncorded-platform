import { afterAll, beforeAll, beforeEach, describe, expect, test, mock } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import * as _realNodeOs from "node:os";
// Snapshot the real node:os exports by value before any mock.module call —
// `import * as` is a live binding, so reading after the stub applies would
// return the mocked homedir. (Same dance as server-registry.test.ts.)
const realNodeOs = { ..._realNodeOs };
const { tmpdir } = _realNodeOs;

// web-apps-store reads/writes under homedir()/.uncorded. Stub homedir() so
// every test runs against a disposable temp dir.
const tmpRoot = mkdtempSync(join(tmpdir(), "uncorded-webapps-test-"));

let storeModule: typeof import("./web-apps-store");

beforeAll(async () => {
  await mock.module("node:os", () => ({
    ...realNodeOs,
    homedir: () => tmpRoot,
  }));
  storeModule = await import("./web-apps-store");
});

afterAll(async () => {
  rmSync(tmpRoot, { recursive: true, force: true });
  await mock.module("node:os", () => realNodeOs);
});

function storePath(): string {
  return join(tmpRoot, ".uncorded", "web-apps.json");
}

function quarantineFiles(): string[] {
  const dir = join(tmpRoot, ".uncorded");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => n.startsWith("web-apps.quarantine-"));
}

beforeEach(() => {
  storeModule.__resetWebAppsQuarantineForTests();
  try { rmSync(join(tmpRoot, ".uncorded"), { recursive: true, force: true }); }
  catch { /* nothing to clean on first run */ }
});

describe("web-apps-store — happy paths", () => {
  test("add → list → remove round-trip, scoped per server", () => {
    const { addWebApp, listWebApps, removeWebApp } = storeModule;

    const a = addWebApp("srv-A", { url: "https://app.roll20.net/", title: "Roll20" });
    addWebApp("srv-A", { url: "https://miro.com/" });
    addWebApp("srv-B", { url: "https://excalidraw.com/" });

    // srv-A sees only its own two; srv-B only its one.
    expect(listWebApps("srv-A").map((w) => w.url)).toEqual([
      "https://app.roll20.net/",
      "https://miro.com/",
    ]);
    expect(listWebApps("srv-B").map((w) => w.url)).toEqual(["https://excalidraw.com/"]);

    removeWebApp("srv-A", a.id);
    expect(listWebApps("srv-A").map((w) => w.url)).toEqual(["https://miro.com/"]);
    // Removing from one server doesn't touch another.
    expect(listWebApps("srv-B").length).toBe(1);
  });

  test("add is idempotent per (server, url) — returns the existing entry", () => {
    const { addWebApp, listWebApps } = storeModule;
    const first = addWebApp("srv-A", { url: "https://app.roll20.net/", title: "Roll20" });
    const again = addWebApp("srv-A", { url: "https://app.roll20.net/", title: "Different" });
    expect(again.id).toBe(first.id);
    expect(listWebApps("srv-A").length).toBe(1);
    // The original title is preserved (idempotent add does not overwrite).
    expect(again.title).toBe("Roll20");
  });

  test("the same url under two servers is two distinct entries", () => {
    const { addWebApp } = storeModule;
    const a = addWebApp("srv-A", { url: "https://app.roll20.net/" });
    const b = addWebApp("srv-B", { url: "https://app.roll20.net/" });
    expect(a.id).not.toBe(b.id);
  });

  test("title defaults to the hostname without www.", () => {
    const { addWebApp } = storeModule;
    const e = addWebApp("srv-A", { url: "https://www.example.com/path?q=1" });
    expect(e.title).toBe("example.com");
  });

  test("persists as a schemaVersion envelope", () => {
    const { addWebApp } = storeModule;
    addWebApp("srv-X", { url: "https://x.test/" });
    const raw = JSON.parse(readFileSync(storePath(), "utf8")) as Record<string, unknown>;
    expect(raw["schemaVersion"]).toBe(1);
    const servers = raw["servers"] as Record<string, Record<string, unknown>>;
    expect(Object.keys(servers["srv-X"] ?? {}).length).toBe(1);
    expect(raw["urlPrefs"]).toEqual({});
  });

  test("missing file lists empty, no quarantine", () => {
    const { listWebApps, webAppsWereQuarantinedThisSession } = storeModule;
    expect(listWebApps("srv-A")).toEqual([]);
    expect(webAppsWereQuarantinedThisSession()).toBe(false);
  });
});

describe("web-apps-store — per-URL prefs (global)", () => {
  test("getUrlPref returns null until set, then the saved action (exact URL)", () => {
    const { getUrlPref, setUrlPref } = storeModule;
    const url = "https://app.roll20.net/editor/?game=1";
    expect(getUrlPref(url)).toBeNull();
    setUrlPref(url, "panel");
    expect(getUrlPref(url)).toBe("panel");
    // Keyed by exact URL — a different page on the same site is independent.
    expect(getUrlPref("https://app.roll20.net/editor/?game=2")).toBeNull();
  });

  test("setUrlPref overwrites the prior choice for the same URL", () => {
    const { getUrlPref, setUrlPref } = storeModule;
    const url = "https://miro.com/app/board/x/";
    setUrlPref(url, "popout");
    setUrlPref(url, "panel");
    expect(getUrlPref(url)).toBe("panel");
    const raw = JSON.parse(readFileSync(storePath(), "utf8")) as {
      urlPrefs: Record<string, string>;
    };
    expect(raw.urlPrefs[url]).toBe("panel");
  });

  test("a legacy file carrying dismissedHosts loads without quarantining", () => {
    const { listWebApps, getUrlPref, webAppsWereQuarantinedThisSession } = storeModule;
    mkdirSync(join(tmpRoot, ".uncorded"), { recursive: true });
    // Pre-urlPrefs shape: a dismissedHosts array, no urlPrefs key.
    const legacy = {
      schemaVersion: 1,
      servers: { "srv-A": { a: { id: "a", url: "https://g.test/", title: "G", addedAt: 1 } } },
      dismissedHosts: ["app.roll20.net"],
    };
    writeFileSync(storePath(), JSON.stringify(legacy), "utf8");
    expect(listWebApps("srv-A").map((w) => w.id)).toEqual(["a"]);
    expect(getUrlPref("https://g.test/")).toBeNull();
    expect(webAppsWereQuarantinedThisSession()).toBe(false);
  });

  test("a bad pref value is dropped, no quarantine", () => {
    const { getUrlPref, webAppsWereQuarantinedThisSession } = storeModule;
    mkdirSync(join(tmpRoot, ".uncorded"), { recursive: true });
    writeFileSync(
      storePath(),
      JSON.stringify({
        schemaVersion: 1,
        servers: {},
        urlPrefs: { "https://ok.test/": "panel", "https://bad.test/": "nonsense" },
      }),
      "utf8",
    );
    expect(getUrlPref("https://ok.test/")).toBe("panel");
    expect(getUrlPref("https://bad.test/")).toBeNull();
    expect(webAppsWereQuarantinedThisSession()).toBe(false);
  });
});

describe("web-apps-store — quarantine + resilience", () => {
  test("corrupt JSON is quarantined and a fresh envelope replaces it", () => {
    const { listWebApps, webAppsWereQuarantinedThisSession, lastWebAppsQuarantinePath } = storeModule;
    mkdirSync(join(tmpRoot, ".uncorded"), { recursive: true });
    writeFileSync(storePath(), "{not valid json", "utf8");

    expect(listWebApps("srv-A")).toEqual([]);
    expect(webAppsWereQuarantinedThisSession()).toBe(true);
    expect(lastWebAppsQuarantinePath()).not.toBeNull();
    expect(quarantineFiles().length).toBe(1);
    const fresh = JSON.parse(readFileSync(storePath(), "utf8")) as Record<string, unknown>;
    expect(fresh).toEqual({ schemaVersion: 1, servers: {}, urlPrefs: {} });
  });

  test("envelope with wrong shape is quarantined", () => {
    const { listWebApps, webAppsWereQuarantinedThisSession } = storeModule;
    mkdirSync(join(tmpRoot, ".uncorded"), { recursive: true });
    writeFileSync(storePath(), JSON.stringify({ schemaVersion: 2, wrong: true }), "utf8");
    expect(listWebApps("srv-A")).toEqual([]);
    expect(webAppsWereQuarantinedThisSession()).toBe(true);
  });

  test("one bad entry among good ones is dropped, no quarantine", () => {
    const { listWebApps, webAppsWereQuarantinedThisSession } = storeModule;
    mkdirSync(join(tmpRoot, ".uncorded"), { recursive: true });
    const mixed = {
      schemaVersion: 1,
      servers: {
        "srv-A": {
          good: { id: "good", url: "https://g.test/", title: "G", addedAt: 1 },
          bad: { id: "bad", url: "https://b.test/", title: "B", addedAt: "not-a-number" },
        },
      },
      urlPrefs: {},
    };
    writeFileSync(storePath(), JSON.stringify(mixed), "utf8");
    const list = listWebApps("srv-A");
    expect(list.map((w) => w.id)).toEqual(["good"]);
    expect(webAppsWereQuarantinedThisSession()).toBe(false);
  });

  test("remove on an unknown server is a no-op", () => {
    const { removeWebApp, listWebApps } = storeModule;
    expect(() => removeWebApp("nope", "whatever")).not.toThrow();
    expect(listWebApps("nope")).toEqual([]);
  });
});
