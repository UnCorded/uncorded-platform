import { describe, expect, test } from "bun:test";
import { PLUGIN_SLUG_RE, validateManifest } from "@uncorded/shared";

import { PLUGIN_DEV_DOCS } from "./plugin-dev-docs.generated";
import {
  PLUGIN_DEV_SLUG_RE,
  RESERVED_PLUGIN_SLUGS,
  scaffoldPluginFiles,
  validateDevPluginSlug,
  type ScaffoldInput,
} from "./plugin-dev-templates";

const BASE_INPUT: ScaffoldInput = {
  slug: "trip-planner",
  displayName: "Trip Planner",
  description: "Plan trips together.",
  author: "Test Author",
  pluginType: "standalone",
};

function fileMap(input: ScaffoldInput): Map<string, string> {
  return new Map(scaffoldPluginFiles(input).map((f) => [f.relativePath, f.content]));
}

describe("scaffoldPluginFiles", () => {
  test("produces the full file set", () => {
    const files = fileMap(BASE_INPUT);
    expect([...files.keys()].sort()).toEqual(
      [
        "AGENTS.md",
        "CLAUDE.md",
        "README.md",
        "backend/index.ts",
        "frontend/index.html",
        "manifest.json",
        "migrations/001_init.sql",
        "package.json",
      ].sort(),
    );
  });

  test("manifest passes the shared validateManifest", () => {
    const manifest: unknown = JSON.parse(fileMap(BASE_INPUT).get("manifest.json")!);
    const result = validateManifest(manifest);
    // Assert the error list (not just ok) so a failure prints the validator's
    // actual complaints in the diff.
    expect(result.ok ? [] : result.errors).toEqual([]);
    if (!result.ok) return; // narrowing only; unreachable after the assert
    expect(result.manifest.name).toBe("trip-planner");
    expect(result.manifest.type).toBe("standalone");
    expect(result.manifest.backend?.entry).toBe("backend/index.ts");
    expect(result.manifest.frontend?.entry).toBe("frontend/index.html");
  });

  test("extension variant carries extends and still validates", () => {
    const files = fileMap({
      ...BASE_INPUT,
      pluginType: "extension",
      extendsSlug: "text-channels",
    });
    const manifest: unknown = JSON.parse(files.get("manifest.json")!);
    const result = validateManifest(manifest);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.extends).toBe("text-channels");
    }
  });

  test("manifest stays valid JSON when metadata contains quotes and angle brackets", () => {
    const files = fileMap({
      ...BASE_INPUT,
      displayName: 'The "Best" <Plugin>',
      description: 'Say "hi" & more',
      author: 'O"Brien <x>',
    });
    const manifest: unknown = JSON.parse(files.get("manifest.json")!);
    expect(validateManifest(manifest).ok).toBe(true);
    // HTML output must escape the display name.
    const html = files.get("frontend/index.html")!;
    expect(html).not.toContain("<Plugin>");
    expect(html).toContain("&lt;Plugin&gt;");
  });

  test("backend template uses the SDK shape the runtime expects", () => {
    const backend = fileMap(BASE_INPUT).get("backend/index.ts")!;
    expect(backend).toContain('from "@uncorded/plugin-sdk"');
    expect(backend).toContain("createPlugin()");
    expect(backend).toContain('plugin.handle("sidebar.items"');
    expect(backend).toContain("plugin.broadcast.toAll");
    expect(backend).toContain('slug: "trip-planner"');
  });

  test("frontend loads the runtime SDK and does a request round trip", () => {
    const html = fileMap(BASE_INPUT).get("frontend/index.html")!;
    expect(html).toContain('src="/sdk/plugin-frontend.js"');
    expect(html).toContain("createPluginFrontend()");
    expect(html).toContain("sdk.request(");
    expect(html).toContain("sdk.on(");
  });

  test("migration is non-empty and creates a table", () => {
    const sql = fileMap(BASE_INPUT).get("migrations/001_init.sql")!;
    expect(sql).toContain("CREATE TABLE");
  });

  test("AGENTS.md embeds the generated docs; CLAUDE.md points at it", () => {
    const files = fileMap(BASE_INPUT);
    expect(files.get("AGENTS.md")!).toContain(PLUGIN_DEV_DOCS);
    expect(files.get("CLAUDE.md")!.trim()).toBe("@AGENTS.md");
  });

  test("every file interpolation site carries the slug where expected", () => {
    const files = fileMap(BASE_INPUT);
    for (const path of ["manifest.json", "backend/index.ts", "README.md", "package.json"]) {
      expect(files.get(path)!).toContain("trip-planner");
    }
  });
});

describe("validateDevPluginSlug", () => {
  test("accepts well-formed slugs", () => {
    for (const slug of ["ab", "guestbook", "trip-planner", "a1-b2"]) {
      expect(validateDevPluginSlug(slug)).toEqual({ ok: true });
    }
  });

  test("rejects malformed slugs", () => {
    for (const slug of ["", "a", "A-b", "1abc", "-abc", "abc-", "a--b", "a_b", "a".repeat(51), "../x"]) {
      const result = validateDevPluginSlug(slug);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("SLUG_INVALID");
    }
  });

  test("rejects reserved slugs", () => {
    for (const slug of RESERVED_PLUGIN_SLUGS) {
      const result = validateDevPluginSlug(slug);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("SLUG_RESERVED");
    }
  });
});

describe("reserved-slug parity", () => {
  test("every provisioned core plugin slug is reserved for dev plugins", async () => {
    const { CORE_PLUGIN_SLUGS } = await import("./provision");
    for (const slug of CORE_PLUGIN_SLUGS) {
      expect(RESERVED_PLUGIN_SLUGS.has(slug)).toBe(true);
    }
  });
});

describe("slug regex parity", () => {
  test("desktop literal matches the canonical shared PLUGIN_SLUG_RE", () => {
    expect(PLUGIN_DEV_SLUG_RE.source).toBe(PLUGIN_SLUG_RE.source);
    expect(PLUGIN_DEV_SLUG_RE.flags).toBe(PLUGIN_SLUG_RE.flags);
  });
});
