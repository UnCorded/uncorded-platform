// Scaffold templates for the Plugin Development Workspace. Produces the
// "LLM's starting context, not a tutorial" file set from the SDK refinement
// doc (D8): a working hello-world plugin plus AGENTS.md/CLAUDE.md agent
// context. Pure — returns { relativePath, content } pairs; the store applies
// them to disk. Templates are inline literals (the packaged app is asar'd;
// an assets dir would need extraResources + path forking for no gain).
//
// Validity guarantee: plugin-dev-templates.test.ts feeds the generated
// manifest through validateManifest from @uncorded/shared, so a scaffold
// that the runtime would reject fails the test suite.

import { PLUGIN_DEV_DOCS } from "./plugin-dev-docs.generated";

/** Bump when template output changes shape; recorded in .uncorded-dev.json. */
export const SCAFFOLD_VERSION = 1;

/**
 * Matches SLUG_RE in packages/shared/src/manifest.ts. Duplicated because the
 * desktop main process cannot runtime-import @uncorded/shared (raw-TS
 * workspace package; desktop builds with plain tsc). A parity test asserts
 * the two regex sources are identical.
 */
export const PLUGIN_DEV_SLUG_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export const PLUGIN_DEV_SLUG_MIN = 2;
export const PLUGIN_DEV_SLUG_MAX = 50;

/**
 * Slugs a dev plugin may not use: runtime-reserved names plus first-party
 * plugin slugs (the runtime's core-plugin directory shadows /plugins, so a
 * collision would silently load the core plugin instead of the dev one).
 */
export const RESERVED_PLUGIN_SLUGS: ReadonlySet<string> = new Set([
  "core",
  "admin",
  "runtime",
  "uncorded",
  "sdk",
  "text-channels",
  "voice-channels",
  "foundry-vtt",
  "members",
  "moderation",
]);

export type DevPluginType = "standalone" | "extension";

export interface ScaffoldInput {
  slug: string;
  displayName: string;
  description: string;
  author: string;
  pluginType: DevPluginType;
  extendsSlug?: string;
  icon?: string;
}

export interface ScaffoldFile {
  relativePath: string;
  content: string;
}

export type SlugValidation =
  | { ok: true }
  | { ok: false; code: "SLUG_INVALID" | "SLUG_RESERVED"; message: string };

export function validateDevPluginSlug(slug: string): SlugValidation {
  if (
    slug.length < PLUGIN_DEV_SLUG_MIN ||
    slug.length > PLUGIN_DEV_SLUG_MAX ||
    !PLUGIN_DEV_SLUG_RE.test(slug)
  ) {
    return {
      ok: false,
      code: "SLUG_INVALID",
      message:
        "Slug must be 2-50 characters: lowercase letters, digits, and single hyphens; must start with a letter.",
    };
  }
  if (RESERVED_PLUGIN_SLUGS.has(slug)) {
    return {
      ok: false,
      code: "SLUG_RESERVED",
      message: `"${slug}" is reserved (runtime name or first-party plugin).`,
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

function manifestJson(input: ScaffoldInput): string {
  const manifest: Record<string, unknown> = {
    name: input.slug,
    version: "0.1.0",
    api_version: "^1.0",
    author: input.author,
    description: input.description,
    license: "MIT",
    type: input.pluginType,
    ...(input.pluginType === "extension" ? { extends: input.extendsSlug } : {}),
    icon: input.icon ?? "Puzzle",
    backend: { entry: "backend/index.ts" },
    frontend: { entry: "frontend/index.html" },
    permissions: ["data.sql:self", "broadcast.clients"],
    sidebar: { contributes: true, section: input.displayName },
  };
  return JSON.stringify(manifest, null, 2) + "\n";
}

function migrationSql(): string {
  return `-- 001_init.sql — runs once at plugin load. Later schema changes go in NEW
-- numbered files (002_*.sql, ...); editing this file after it has run does
-- nothing. Timestamps are Unix-ms integers by convention.
CREATE TABLE visits (
  id         TEXT PRIMARY KEY,
  visitor_id TEXT NOT NULL,
  visited_at INTEGER NOT NULL
);

CREATE INDEX idx_visits_visited_at ON visits(visited_at);
`;
}

function backendTs(input: ScaffoldInput): string {
  const label = JSON.stringify(input.displayName);
  const slug = JSON.stringify(input.slug);
  const icon = JSON.stringify(input.icon ?? "Puzzle");
  const section = JSON.stringify(input.displayName);
  return `// Backend entry — runs as a Bun subprocess inside the server container.
// Replace the starter "visits" feature with the real plugin; keep the shape:
// createPlugin() once, handlers registered SYNCHRONOUSLY at module top level,
// async setup only after that. See AGENTS.md for the full SDK reference.
import { createPlugin } from "@uncorded/plugin-sdk";

interface Visit {
  id: string;
  visitor_id: string;
  visited_at: number;
}

const plugin = createPlugin();

// Read: the most recent visits.
plugin.handle("getVisits", async () => {
  return plugin.db.query<Visit>(
    "SELECT id, visitor_id, visited_at FROM visits ORDER BY visited_at DESC LIMIT 50",
  );
});

// Write: record a visit, then push it to every connected client. The
// frontend receives this as sdk.on("visit.recorded", ...).
plugin.handle("recordVisit", async (_params, user) => {
  const visit: Visit = {
    id: crypto.randomUUID(),
    visitor_id: user.id,
    visited_at: Date.now(),
  };
  await plugin.db.run(
    "INSERT INTO visits (id, visitor_id, visited_at) VALUES (?, ?, ?)",
    [visit.id, visit.visitor_id, visit.visited_at],
  );
  await plugin.broadcast.toAll("visit.recorded", visit);
  return visit;
});

// Reserved action: tells the shell what to render in the sidebar.
plugin.handle("sidebar.items", async () => ({
  items: [
    {
      id: ${slug},
      label: ${label},
      icon: ${icon},
      panelType: "plugin" as const,
      slug: ${slug}, // must equal manifest "name"
      section: ${section},
    },
  ],
}));
`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function frontendHtml(input: ScaffoldInput): string {
  const title = escapeHtml(input.displayName);
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${title}</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 0; padding: 1rem; }
      #visits { list-style: none; padding: 0; }
      #visits li { padding: 0.5rem 0; border-bottom: 1px solid #8883; }
    </style>
  </head>
  <body>
    <h1>${title}</h1>
    <button id="wave">Wave</button>
    <ul id="visits"></ul>

    <!-- Served by the runtime. Do not bundle or vendor it. -->
    <script src="/sdk/plugin-frontend.js"></script>
    <script type="module">
      const sdk = await window.UncodedPlugin.createPluginFrontend();
      const list = document.getElementById("visits");

      function prepend(visit) {
        const li = document.createElement("li");
        li.textContent = new Date(visit.visited_at).toLocaleString();
        list.prepend(li);
      }

      // Initial load: one request round trip to the backend.
      const visits = await sdk.request("getVisits");
      for (const v of visits) prepend(v);

      // Live updates pushed by the backend's broadcast.toAll(...).
      sdk.on("visit.recorded", (visit) => prepend(visit));

      document.getElementById("wave").addEventListener("click", () => {
        void sdk.request("recordVisit");
        // No manual insert — the broadcast round-trips back to us.
      });
    </script>
  </body>
</html>
`;
}

function packageJson(input: ScaffoldInput): string {
  // Deliberately NO @uncorded/plugin-sdk dependency: the SDK is runtime-owned
  // (resolved in-container via the /plugins tsconfig shim) and is not on npm —
  // listing it would make `bun install` fail outright, blocking the install
  // of legitimate third-party deps. package.json exists for those real deps.
  return (
    JSON.stringify(
      {
        name: input.slug,
        private: true,
        dependencies: {},
      },
      null,
      2,
    ) + "\n"
  );
}

function readmeMd(input: ScaffoldInput): string {
  return `# ${input.displayName}

${input.description}

An UnCorded plugin. This folder's name (\`${input.slug}\`) is the plugin's slug
and must not change — it is the plugin's identity everywhere.

## Load it into a server

The easiest path is the UnCorded desktop app: Server settings → Plugins →
Add Plugin → Develop → **Install**. Manually:

1. Copy this folder to \`<server-data>/plugins/${input.slug}/\`.
2. Add \`"${input.slug}"\` to \`installed_plugins\` in the server's \`server.json\`.
3. Restart the server **through the desktop app** (the runtime reads
   \`installed_plugins\` only at boot, and a bare \`docker restart\` degrades
   the tunnel).

For development guidance, see \`AGENTS.md\`.
`;
}

function agentsMd(input: ScaffoldInput): string {
  return `# Working on this plugin

This folder is an UnCorded plugin named \`${input.slug}\` ("${input.displayName}").
It was scaffolded by the UnCorded desktop app as a working hello-world; replace
the starter "visits" feature with the real plugin described in \`PROMPT.md\`.

## Rules that will save you time

- **Do not rename this folder.** Its name is the plugin slug — the manifest
  \`name\`, the install directory, the database filename, and all URLs key off it.
- **Declare every capability** you use in \`manifest.json\` \`permissions\` —
  the runtime hard-rejects any IPC call for an undeclared capability.
  \`manifest.json\` is strictly validated; unknown top-level fields are rejected.
- **Register handlers synchronously** at module top level in
  \`backend/index.ts\`, before any \`await\`. Async setup (event subscriptions,
  permission registration) comes after.
- **Migrations run by filename order, once each.** Editing an already-applied
  file does nothing; add a new \`NNN_*.sql\`. Never renumber or delete shipped
  migrations — gaps make the runtime skip the plugin.
- **The frontend is a sandboxed iframe with no build step.** Load
  \`/sdk/plugin-frontend.js\` from the runtime (never bundle it); inline your
  CSS/JS or ship pre-built assets next to \`index.html\`.
- **The SDK is provided by the runtime — never add \`@uncorded/plugin-sdk\`
  to package.json.** It is not on npm; listing it makes \`bun install\` fail
  and blocks your real dependencies. Import it freely in code — the runtime
  resolves it at load time.
- **Third-party dependencies are not installed by the runtime.** Anything
  else you import must resolve from this folder's own \`node_modules\` —
  \`bun add <pkg>\` here and ship the folder with \`node_modules\` present.
- **Do not add a tsconfig.json to this folder.** The runtime provides SDK
  resolution for installed plugins through a tsconfig path-alias shim one
  directory above the plugin; a tsconfig inside the plugin shadows it (nearest
  wins) and breaks \`@uncorded/plugin-sdk\` imports. If you truly need one,
  vendor your node_modules instead.
- **Test by deploying**: in the UnCorded desktop app, open Server settings →
  Plugins → Add Plugin → Develop and click Install on this plugin. Deploying
  restarts the server container — that is normal; plugins load only at boot.

The complete official documentation follows.

---

${PLUGIN_DEV_DOCS}`;
}

function claudeMd(): string {
  return `@AGENTS.md
`;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Produce the full scaffold for a new dev plugin. Caller is responsible for
 * input validation (validateDevPluginSlug + form-level checks); this function
 * only renders. PROMPT.md is written separately by the create flow (content
 * comes from plugin-dev-prompt.ts, which needs the final on-disk path).
 */
export function scaffoldPluginFiles(input: ScaffoldInput): ScaffoldFile[] {
  return [
    { relativePath: "manifest.json", content: manifestJson(input) },
    { relativePath: "migrations/001_init.sql", content: migrationSql() },
    { relativePath: "backend/index.ts", content: backendTs(input) },
    { relativePath: "frontend/index.html", content: frontendHtml(input) },
    { relativePath: "package.json", content: packageJson(input) },
    { relativePath: "README.md", content: readmeMd(input) },
    { relativePath: "AGENTS.md", content: agentsMd(input) },
    { relativePath: "CLAUDE.md", content: claudeMd() },
  ];
}
