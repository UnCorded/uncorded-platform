import { describe, expect, test } from "bun:test";
import { resolvePlugins } from "./resolver";
import type { ManifestReader, ResolverError, ResolverResult } from "./resolver";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MockManifest {
  name: string;
  version?: string;
  api_version?: string;
  author?: string;
  description?: string;
  type?: string;
  permissions?: string[];
  backend?: { entry: string };
  dependencies?: Record<string, string>;
  extends?: string;
  [key: string]: unknown;
}

/**
 * Build a minimal valid manifest object for mocking.
 */
function manifest(slug: string, overrides: Partial<MockManifest> = {}): MockManifest {
  return {
    name: slug,
    version: "1.0.0",
    api_version: "^1.0",
    author: "Test",
    description: `${slug} plugin.`,
    type: "standalone",
    permissions: ["data.sql:self"],
    backend: { entry: "backend/index.ts" },
    ...overrides,
  };
}

/**
 * Create a mock ManifestReader from a map of slug → manifest data.
 * Slugs not in the map will throw ENOENT.
 */
function mockReader(manifests: Record<string, unknown>): ManifestReader {
  return async (path: string) => {
    // Extract slug from path: .../plugins/<slug>/manifest.json
    const parts = path.split("/");
    const manifestIdx = parts.indexOf("manifest.json");
    if (manifestIdx < 1) {
      throw Object.assign(new Error(`Not found: ${path}`), { code: "ENOENT" });
    }
    const slug = parts[manifestIdx - 1];
    if (slug === undefined || !(slug in manifests)) {
      throw Object.assign(new Error(`Not found: ${path}`), { code: "ENOENT" });
    }
    return manifests[slug];
  };
}

/**
 * Create a mock reader that throws a read error (not ENOENT) for a specific slug.
 */
function mockReaderWithError(
  manifests: Record<string, unknown>,
  errorSlug: string,
  errorMsg: string,
): ManifestReader {
  return async (path: string) => {
    const parts = path.split("/");
    const manifestIdx = parts.indexOf("manifest.json");
    const slug = manifestIdx >= 1 ? parts[manifestIdx - 1] : undefined;
    if (slug === errorSlug) {
      throw new Error(errorMsg);
    }
    return mockReader(manifests)(path);
  };
}

function expectOk(result: ResolverResult) {
  if (!result.ok) {
    throw new Error(
      `Expected ok but got errors:\n${result.errors.map((e) => `  [${e.code}] ${e.plugin}: ${e.message}`).join("\n")}`,
    );
  }
  return result.plugins;
}

function expectErrors(result: ResolverResult): ResolverError[] {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable");
  return result.errors;
}

function expectErrorCode(result: ResolverResult, code: string): ResolverError {
  const errs = expectErrors(result);
  const match = errs.find((e) => e.code === code);
  if (!match) {
    throw new Error(
      `Expected error code "${code}" but got: ${errs.map((e) => e.code).join(", ")}`,
    );
  }
  return match;
}

const PLUGINS_DIR = "/plugins";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolvePlugins", () => {
  // ---- Happy path ----

  describe("happy path", () => {
    test("single plugin resolves", async () => {
      const reader = mockReader({ alpha: manifest("alpha") });
      const result = await resolvePlugins(PLUGINS_DIR, ["alpha"], reader);
      const plugins = expectOk(result);
      expect(plugins).toHaveLength(1);
      expect(plugins[0]!.slug).toBe("alpha");
      expect(plugins[0]!.path).toBe("/plugins/alpha");
      expect(plugins[0]!.manifest.name).toBe("alpha");
    });

    test("multiple independent plugins resolve", async () => {
      const reader = mockReader({
        alpha: manifest("alpha"),
        beta: manifest("beta"),
        gamma: manifest("gamma"),
      });
      const result = await resolvePlugins(
        PLUGINS_DIR,
        ["alpha", "beta", "gamma"],
        reader,
      );
      const plugins = expectOk(result);
      expect(plugins).toHaveLength(3);
      const slugs = plugins.map((p) => p.slug);
      expect(slugs).toContain("alpha");
      expect(slugs).toContain("beta");
      expect(slugs).toContain("gamma");
    });

    test("plugin with dependency loads after its dependency", async () => {
      const reader = mockReader({
        base: manifest("base"),
        consumer: manifest("consumer", {
          dependencies: { base: "^1.0" },
        }),
      });
      const result = await resolvePlugins(
        PLUGINS_DIR,
        ["consumer", "base"],
        reader,
      );
      const plugins = expectOk(result);
      const slugs = plugins.map((p) => p.slug);
      expect(slugs.indexOf("base")).toBeLessThan(slugs.indexOf("consumer"));
    });

    test("extension plugin loads after its base", async () => {
      const reader = mockReader({
        "text-channels": manifest("text-channels", { type: "core" }),
        reactions: manifest("reactions", {
          type: "extension",
          extends: "text-channels",
        }),
      });
      const result = await resolvePlugins(
        PLUGINS_DIR,
        ["reactions", "text-channels"],
        reader,
      );
      const plugins = expectOk(result);
      const slugs = plugins.map((p) => p.slug);
      expect(slugs.indexOf("text-channels")).toBeLessThan(
        slugs.indexOf("reactions"),
      );
    });

    test("chain: A → B → C loads in correct order", async () => {
      const reader = mockReader({
        a: manifest("a", { dependencies: { b: "^1.0" } }),
        b: manifest("b", { dependencies: { c: "^1.0" } }),
        c: manifest("c"),
      });
      const result = await resolvePlugins(
        PLUGINS_DIR,
        ["a", "b", "c"],
        reader,
      );
      const plugins = expectOk(result);
      const slugs = plugins.map((p) => p.slug);
      expect(slugs.indexOf("c")).toBeLessThan(slugs.indexOf("b"));
      expect(slugs.indexOf("b")).toBeLessThan(slugs.indexOf("a"));
    });

    test("diamond: D loaded before B and C, both before A", async () => {
      const reader = mockReader({
        a: manifest("a", { dependencies: { b: "^1.0", c: "^1.0" } }),
        b: manifest("b", { dependencies: { d: "^1.0" } }),
        c: manifest("c", { dependencies: { d: "^1.0" } }),
        d: manifest("d"),
      });
      const result = await resolvePlugins(
        PLUGINS_DIR,
        ["a", "b", "c", "d"],
        reader,
      );
      const plugins = expectOk(result);
      const slugs = plugins.map((p) => p.slug);
      expect(slugs.indexOf("d")).toBeLessThan(slugs.indexOf("b"));
      expect(slugs.indexOf("d")).toBeLessThan(slugs.indexOf("c"));
      expect(slugs.indexOf("b")).toBeLessThan(slugs.indexOf("a"));
      expect(slugs.indexOf("c")).toBeLessThan(slugs.indexOf("a"));
    });

    test("empty installed list returns empty result", async () => {
      const reader = mockReader({});
      const result = await resolvePlugins(PLUGINS_DIR, [], reader);
      const plugins = expectOk(result);
      expect(plugins).toHaveLength(0);
    });

    test("compatible version satisfies dependency range", async () => {
      const reader = mockReader({
        base: manifest("base", { version: "1.5.0" }),
        consumer: manifest("consumer", {
          dependencies: { base: "^1.2.0" },
        }),
      });
      const result = await resolvePlugins(
        PLUGINS_DIR,
        ["consumer", "base"],
        reader,
      );
      expectOk(result);
    });
  });

  // ---- Manifest not found ----

  describe("manifest not found", () => {
    test("missing plugin directory produces MANIFEST_NOT_FOUND", async () => {
      const reader = mockReader({});
      const result = await resolvePlugins(
        PLUGINS_DIR,
        ["nonexistent"],
        reader,
      );
      const err = expectErrorCode(result, "MANIFEST_NOT_FOUND");
      expect(err.plugin).toBe("nonexistent");
    });
  });

  // ---- Manifest read failure ----

  describe("manifest read failure", () => {
    test("unreadable manifest produces MANIFEST_READ_FAILED", async () => {
      const reader = mockReaderWithError({}, "broken", "Permission denied");
      const result = await resolvePlugins(PLUGINS_DIR, ["broken"], reader);
      const err = expectErrorCode(result, "MANIFEST_READ_FAILED");
      expect(err.plugin).toBe("broken");
      expect(err.message).toContain("Permission denied");
    });
  });

  // ---- Invalid manifest ----

  describe("invalid manifest", () => {
    test("invalid manifest produces MANIFEST_INVALID with details", async () => {
      const reader = mockReader({
        bad: { name: "bad" }, // missing most required fields
      });
      const result = await resolvePlugins(PLUGINS_DIR, ["bad"], reader);
      const err = expectErrorCode(result, "MANIFEST_INVALID");
      expect(err.plugin).toBe("bad");
      expect(err.details).toBeDefined();
      expect(err.details!.length).toBeGreaterThan(0);
    });
  });

  // ---- Slug mismatch ----

  describe("slug mismatch", () => {
    test("folder name ≠ manifest name produces SLUG_MISMATCH", async () => {
      // Folder is "alpha" but manifest says name is "beta"
      const reader = mockReader({
        alpha: manifest("beta"),
      });
      const result = await resolvePlugins(PLUGINS_DIR, ["alpha"], reader);
      const err = expectErrorCode(result, "SLUG_MISMATCH");
      expect(err.plugin).toBe("alpha");
      expect(err.message).toContain("beta");
    });

    test("reserved slug \"core\" is rejected before manifest read (G2)", async () => {
      // The reader would ENOENT, but the guard fires first with a clearer error.
      const reader = mockReader({});
      const result = await resolvePlugins(PLUGINS_DIR, ["core"], reader);
      const err = expectErrorCode(result, "RESERVED_SLUG");
      expect(err.plugin).toBe("core");
      expect(err.message).toContain("reserved");
    });

    test("reserved slug \"admin\" is rejected before manifest read (G2)", async () => {
      const reader = mockReader({});
      const result = await resolvePlugins(PLUGINS_DIR, ["admin"], reader);
      const err = expectErrorCode(result, "RESERVED_SLUG");
      expect(err.plugin).toBe("admin");
    });
  });

  // ---- Missing dependency ----

  describe("missing dependency", () => {
    test("dependency not installed produces MISSING_DEPENDENCY", async () => {
      const reader = mockReader({
        consumer: manifest("consumer", {
          dependencies: { "not-installed": "^1.0" },
        }),
      });
      const result = await resolvePlugins(
        PLUGINS_DIR,
        ["consumer"],
        reader,
      );
      const err = expectErrorCode(result, "MISSING_DEPENDENCY");
      expect(err.plugin).toBe("consumer");
      expect(err.message).toContain("not-installed");
    });
  });

  // ---- Incompatible dependency ----

  describe("incompatible dependency", () => {
    test("version mismatch produces INCOMPATIBLE_DEPENDENCY", async () => {
      const reader = mockReader({
        base: manifest("base", { version: "2.0.0" }),
        consumer: manifest("consumer", {
          dependencies: { base: "^1.0" },
        }),
      });
      const result = await resolvePlugins(
        PLUGINS_DIR,
        ["consumer", "base"],
        reader,
      );
      const err = expectErrorCode(result, "INCOMPATIBLE_DEPENDENCY");
      expect(err.plugin).toBe("consumer");
      expect(err.message).toContain("2.0.0");
    });
  });

  // ---- Missing base plugin ----

  describe("missing base plugin", () => {
    test("extension without base installed produces MISSING_BASE_PLUGIN", async () => {
      const reader = mockReader({
        reactions: manifest("reactions", {
          type: "extension",
          extends: "text-channels",
        }),
      });
      const result = await resolvePlugins(
        PLUGINS_DIR,
        ["reactions"],
        reader,
      );
      const err = expectErrorCode(result, "MISSING_BASE_PLUGIN");
      expect(err.plugin).toBe("reactions");
      expect(err.message).toContain("text-channels");
    });
  });

  // ---- Circular dependencies ----

  describe("circular dependencies", () => {
    test("A → B → A produces CIRCULAR_DEPENDENCY", async () => {
      const reader = mockReader({
        a: manifest("a", { dependencies: { b: "^1.0" } }),
        b: manifest("b", { dependencies: { a: "^1.0" } }),
      });
      const result = await resolvePlugins(
        PLUGINS_DIR,
        ["a", "b"],
        reader,
      );
      const err = expectErrorCode(result, "CIRCULAR_DEPENDENCY");
      expect(err.message).toContain("a");
      expect(err.message).toContain("b");
    });

    test("self-dependency produces CIRCULAR_DEPENDENCY", async () => {
      const reader = mockReader({
        lonely: manifest("lonely", { dependencies: { lonely: "^1.0" } }),
      });
      const result = await resolvePlugins(
        PLUGINS_DIR,
        ["lonely"],
        reader,
      );
      expectErrorCode(result, "CIRCULAR_DEPENDENCY");
    });

    test("transitive cycle A → B → C → A produces CIRCULAR_DEPENDENCY", async () => {
      const reader = mockReader({
        a: manifest("a", { dependencies: { b: "^1.0" } }),
        b: manifest("b", { dependencies: { c: "^1.0" } }),
        c: manifest("c", { dependencies: { a: "^1.0" } }),
      });
      const result = await resolvePlugins(
        PLUGINS_DIR,
        ["a", "b", "c"],
        reader,
      );
      const err = expectErrorCode(result, "CIRCULAR_DEPENDENCY");
      expect(err.message).toContain("a");
      expect(err.message).toContain("b");
      expect(err.message).toContain("c");
    });
  });

  // ---- API version incompatibility ----

  describe("API version compatibility", () => {
    test("plugin requiring ^2.0 rejected on runtime 1.0.0", async () => {
      const reader = mockReader({
        alpha: manifest("alpha", { api_version: "^2.0" }),
      });
      const result = await resolvePlugins(PLUGINS_DIR, ["alpha"], reader, "1.0.0");
      const err = expectErrorCode(result, "INCOMPATIBLE_API_VERSION");
      expect(err.plugin).toBe("alpha");
      expect(err.message).toContain("^2.0");
      expect(err.message).toContain("1.0.0");
    });

    test("plugin requiring ^1.0 accepted on runtime 1.5.0", async () => {
      const reader = mockReader({
        alpha: manifest("alpha", { api_version: "^1.0" }),
      });
      const result = await resolvePlugins(PLUGINS_DIR, ["alpha"], reader, "1.5.0");
      expectOk(result);
    });

    test("plugin requiring ^1.2 rejected on runtime 1.1.0", async () => {
      const reader = mockReader({
        alpha: manifest("alpha", { api_version: "^1.2" }),
      });
      const result = await resolvePlugins(PLUGINS_DIR, ["alpha"], reader, "1.1.0");
      expectErrorCode(result, "INCOMPATIBLE_API_VERSION");
    });

    test("exact version match accepted", async () => {
      const reader = mockReader({
        alpha: manifest("alpha", { api_version: "1.0.0" }),
      });
      const result = await resolvePlugins(PLUGINS_DIR, ["alpha"], reader, "1.0.0");
      expectOk(result);
    });

    test("no runtimeApiVersion skips check (backwards compat)", async () => {
      const reader = mockReader({
        alpha: manifest("alpha", { api_version: "^99.0" }),
      });
      const result = await resolvePlugins(PLUGINS_DIR, ["alpha"], reader);
      expectOk(result);
    });
  });

  // ---- Error reporting ----

  describe("error reporting", () => {
    test("every error names the plugin", async () => {
      const reader = mockReader({});
      const result = await resolvePlugins(
        PLUGINS_DIR,
        ["missing1", "missing2"],
        reader,
      );
      const errs = expectErrors(result);
      expect(errs).toHaveLength(2);
      expect(errs[0]!.plugin).toBe("missing1");
      expect(errs[1]!.plugin).toBe("missing2");
    });

    test("step-1 errors prevent dependency resolution", async () => {
      // "bad" has invalid manifest, "good" depends on "bad"
      // Should get MANIFEST_INVALID for bad, NOT MISSING_DEPENDENCY for good
      const reader = mockReader({
        bad: { name: "bad" }, // invalid
        good: manifest("good", { dependencies: { bad: "^1.0" } }),
      });
      const result = await resolvePlugins(
        PLUGINS_DIR,
        ["bad", "good"],
        reader,
      );
      const errs = expectErrors(result);
      const codes = errs.map((e) => e.code);
      expect(codes).toContain("MANIFEST_INVALID");
      expect(codes).not.toContain("MISSING_DEPENDENCY");
    });
  });
});
