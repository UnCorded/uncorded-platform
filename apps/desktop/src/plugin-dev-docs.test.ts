// Guards the checked-in plugin-dev-docs.generated.ts against drift from its
// source docs in docs/site. If this fails, re-run:
//   node apps/desktop/scripts/generate-plugin-dev-docs.cjs
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { PLUGIN_DEV_DOCS } from "./plugin-dev-docs.generated";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const generator = require("../scripts/generate-plugin-dev-docs.cjs") as {
  DOC_SOURCES: string[];
  buildDocsString: (files: Record<string, string>) => string;
  readDocSources: (root: string) => Record<string, string>;
  repoRoot: () => string;
};

describe("plugin-dev-docs.generated.ts", () => {
  const root = generator.repoRoot();
  const docsPresent = generator.DOC_SOURCES.every((rel) => existsSync(join(root, rel)));

  test("docs sources exist in the repo", () => {
    expect(docsPresent).toBe(true);
  });

  test("checked-in module matches a fresh regeneration", () => {
    if (!docsPresent) return; // covered by the assertion above
    const fresh = generator.buildDocsString(generator.readDocSources(root));
    expect(PLUGIN_DEV_DOCS).toBe(fresh);
  });

  test("internal docs-site links are flattened", () => {
    expect(PLUGIN_DEV_DOCS).not.toMatch(/\]\(\//);
  });

  test("every source doc made it into the bundle", () => {
    // Each page's H1 must appear — guards against a silently empty section.
    for (const heading of [
      "# Plugin anatomy",
      "# Getting started",
      "# Lifecycle",
      "# Data & events",
      "# Manifest reference",
      "# Permissions",
      "# Backend SDK",
      "# Frontend SDK",
    ]) {
      expect(PLUGIN_DEV_DOCS).toContain(heading);
    }
  });
});
