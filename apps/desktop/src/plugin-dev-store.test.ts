import { afterAll, beforeAll, beforeEach, describe, expect, test, mock } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import * as _realNodeOs from "node:os";
import type { CreateDevPluginInput } from "@uncorded/electron-bridge";

// Snapshot the real node:os exports by value before any mock.module call —
// `import * as` is a live binding (same dance as web-apps-store.test.ts).
const realNodeOs = { ..._realNodeOs };
const { tmpdir } = _realNodeOs;

const tmpRoot = mkdtempSync(join(tmpdir(), "uncorded-plugindev-test-"));

let store: typeof import("./plugin-dev-store");

beforeAll(async () => {
  await mock.module("node:os", () => ({
    ...realNodeOs,
    homedir: () => tmpRoot,
  }));
  store = await import("./plugin-dev-store");
});

afterAll(async () => {
  rmSync(tmpRoot, { recursive: true, force: true });
  await mock.module("node:os", () => realNodeOs);
});

function workspaceRoot(): string {
  return join(tmpRoot, ".uncorded", "plugin-dev");
}

const BASE_INPUT: CreateDevPluginInput = {
  slug: "trip-planner",
  displayName: "Trip Planner",
  description: "Plan trips together.",
  idea: "Members propose destinations and vote.",
  author: "Test Author",
  pluginType: "standalone",
};

beforeEach(() => {
  rmSync(workspaceRoot(), { recursive: true, force: true });
});

describe("createDevPlugin", () => {
  test("scaffolds the folder and lists it back", () => {
    const result = store.createDevPlugin(BASE_INPUT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plugin.slug).toBe("trip-planner");
    expect(result.plugin.manifestStatus).toBe("ok");
    expect(result.plugin.scaffoldVersion).toBe(1);
    expect(result.prompt).toContain("Members propose destinations and vote.");

    const dir = join(workspaceRoot(), "trip-planner");
    for (const f of [
      "manifest.json",
      "backend/index.ts",
      "frontend/index.html",
      "migrations/001_init.sql",
      "package.json",
      "README.md",
      "AGENTS.md",
      "CLAUDE.md",
      "PROMPT.md",
      ".uncorded-dev.json",
    ]) {
      expect(existsSync(join(dir, f))).toBe(true);
    }

    const listed = store.listDevPlugins();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.slug).toBe("trip-planner");
    expect(listed[0]!.displayName).toBe("Trip Planner");
    expect(listed[0]!.description).toBe("Plan trips together.");
  });

  test("rejects invalid, reserved, and taken slugs", () => {
    expect(store.createDevPlugin({ ...BASE_INPUT, slug: "Bad Slug" })).toMatchObject({
      ok: false,
      code: "SLUG_INVALID",
    });
    expect(store.createDevPlugin({ ...BASE_INPUT, slug: "text-channels" })).toMatchObject({
      ok: false,
      code: "SLUG_RESERVED",
    });
    expect(store.createDevPlugin(BASE_INPUT).ok).toBe(true);
    expect(store.createDevPlugin(BASE_INPUT)).toMatchObject({ ok: false, code: "SLUG_TAKEN" });
  });

  test("extension without a valid extends slug is rejected", () => {
    expect(
      store.createDevPlugin({ ...BASE_INPUT, pluginType: "extension" }),
    ).toMatchObject({ ok: false, code: "SLUG_INVALID" });
    expect(
      store.createDevPlugin({
        ...BASE_INPUT,
        pluginType: "extension",
        extendsSlug: "text-channels",
      }).ok,
    ).toBe(true);
  });
});

describe("listDevPlugins — directory-scan-as-truth", () => {
  test("empty/missing workspace lists nothing", () => {
    expect(store.listDevPlugins()).toEqual([]);
  });

  test("out-of-band rename appears under the new slug", () => {
    store.createDevPlugin(BASE_INPUT);
    renameSync(join(workspaceRoot(), "trip-planner"), join(workspaceRoot(), "trip-planner-v2"));
    const listed = store.listDevPlugins();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.slug).toBe("trip-planner-v2");
  });

  test("out-of-band delete disappears", () => {
    store.createDevPlugin(BASE_INPUT);
    rmSync(join(workspaceRoot(), "trip-planner"), { recursive: true, force: true });
    expect(store.listDevPlugins()).toEqual([]);
  });

  test("hand-dropped folder without a sidecar lists with fallbacks", () => {
    const dir = join(workspaceRoot(), "rescued");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({ name: "rescued", description: "Rescued from backup." }),
      "utf8",
    );
    const listed = store.listDevPlugins();
    expect(listed).toHaveLength(1);
    expect(listed[0]!).toMatchObject({
      slug: "rescued",
      displayName: "rescued",
      description: "Rescued from backup.",
      scaffoldVersion: null,
      manifestStatus: "ok",
    });
    expect(listed[0]!.createdAt).toBeGreaterThan(0);
  });

  test("corrupt sidecar degrades gracefully", () => {
    store.createDevPlugin(BASE_INPUT);
    writeFileSync(join(workspaceRoot(), "trip-planner", ".uncorded-dev.json"), "{nope", "utf8");
    const listed = store.listDevPlugins();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.displayName).toBe("trip-planner"); // falls back to slug
    expect(listed[0]!.manifestStatus).toBe("ok");
  });

  test("invalid and missing manifests are surfaced as status, not dropped", () => {
    store.createDevPlugin(BASE_INPUT);
    writeFileSync(join(workspaceRoot(), "trip-planner", "manifest.json"), "{nope", "utf8");
    expect(store.listDevPlugins()[0]!.manifestStatus).toBe("invalid");

    rmSync(join(workspaceRoot(), "trip-planner", "manifest.json"));
    expect(store.listDevPlugins()[0]!.manifestStatus).toBe("missing");
  });

  test("non-slug-shaped names are ignored", () => {
    mkdirSync(join(workspaceRoot(), ".staging-thing"), { recursive: true });
    mkdirSync(join(workspaceRoot(), "Has Spaces"), { recursive: true });
    writeFileSync(join(workspaceRoot(), "loose-file"), "x", "utf8"); // slug-shaped FILE
    expect(store.listDevPlugins()).toEqual([]);
  });
});

describe("devPluginPath", () => {
  test("resolves an existing plugin and guards traversal", () => {
    store.createDevPlugin(BASE_INPUT);
    expect(store.devPluginPath("trip-planner")).toBe(join(workspaceRoot(), "trip-planner"));
    expect(store.devPluginPath("../escape")).toBeNull();
    expect(store.devPluginPath("..")).toBeNull();
    expect(store.devPluginPath("no-such-plugin")).toBeNull();
  });
});

describe("regenerateDevPrompt", () => {
  test("rebuilds from sidecar idea and live manifest description", () => {
    store.createDevPlugin(BASE_INPUT);
    const manifestPath = join(workspaceRoot(), "trip-planner", "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    manifest["description"] = "Evolved by the agent.";
    writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");

    const prompt = store.regenerateDevPrompt("trip-planner");
    expect(prompt).not.toBeNull();
    expect(prompt!).toContain("Members propose destinations and vote.");
    expect(prompt!).toContain("Evolved by the agent.");
    expect(readFileSync(join(workspaceRoot(), "trip-planner", "PROMPT.md"), "utf8")).toBe(prompt!);
  });

  test("returns null for unknown slugs", () => {
    expect(store.regenerateDevPrompt("nope")).toBeNull();
  });
});

describe("deleteDevPlugin", () => {
  test("invokes the injected trash function with the plugin path", async () => {
    store.createDevPlugin(BASE_INPUT);
    const trashed: string[] = [];
    const ok = await store.deleteDevPlugin("trip-planner", async (p) => {
      trashed.push(p);
    });
    expect(ok).toBe(true);
    expect(trashed).toEqual([join(workspaceRoot(), "trip-planner")]);
    // The store did NOT hard-delete; the injected trash owns removal.
    expect(existsSync(join(workspaceRoot(), "trip-planner"))).toBe(true);
  });

  test("returns false for unresolvable slugs without calling trash", async () => {
    let called = false;
    const ok = await store.deleteDevPlugin("../escape", async () => {
      called = true;
    });
    expect(ok).toBe(false);
    expect(called).toBe(false);
  });
});
