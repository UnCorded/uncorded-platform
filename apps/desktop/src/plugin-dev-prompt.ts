// Agent-prompt generation for the Plugin Development Workspace. Two prompts:
// the FULL prompt (clipboard + PROMPT.md in the plugin folder) carrying the
// user's idea and working instructions, and a short fixed POINTER prompt used
// on the command line when launching an agent — Windows caps command lines
// near 8k chars, so the launcher passes the pointer and the full prompt
// travels on disk.

export interface AgentPromptInput {
  slug: string;
  displayName: string;
  description: string;
  /** The user's "what should it do?" text, verbatim. */
  idea: string;
  /** Absolute path of the plugin folder on this machine. */
  pluginPath: string;
}

/**
 * Passed as the agent's command-line prompt at launch. Keep it to letters,
 * digits, spaces, commas, and periods — it is interpolated into cmd.exe /
 * osascript command lines and must never need quoting beyond plain double
 * quotes (enforced by a test).
 */
export const AGENT_POINTER_PROMPT =
  "Read PROMPT.md in this directory, then implement the plugin it describes.";

export function buildAgentPrompt(input: AgentPromptInput): string {
  return `# Build the "${input.displayName}" UnCorded plugin

You are working in an UnCorded plugin development workspace at:

    ${input.pluginPath}

This folder is a scaffolded, working hello-world plugin for the UnCorded
platform (a self-hosted collaborative platform where every feature is a
plugin). Your job is to replace the starter feature with the plugin described
below, keeping the scaffold's structure.

## The plugin to build

Name: ${input.displayName}
Slug: ${input.slug}
Summary: ${input.description}

What it should do, in the author's words:

${input.idea}

## Before writing any code

Read \`AGENTS.md\` in this folder. It contains the complete official plugin
documentation: manifest grammar, capability/permission grammar, the backend
SDK (database, events, broadcast, settings, files, ...), the frontend SDK,
and the plugin lifecycle. Everything you need is in that one file.

## What is already here

- \`manifest.json\` — valid manifest; update description/permissions/sidebar as
  the plugin grows. Every capability you use must be declared here.
- \`backend/index.ts\` — backend entry (Bun subprocess). Handlers are
  registered synchronously at module top level; keep that pattern.
- \`frontend/index.html\` — the panel UI, served into a sandboxed iframe. No
  build step: inline CSS/JS or ship static assets next to it. It loads the
  frontend SDK from \`/sdk/plugin-frontend.js\` (never bundle that).
- \`migrations/001_init.sql\` — schema, applied once at load. Schema changes
  go in NEW numbered files; never edit or renumber applied migrations.
- \`package.json\` — for THIRD-PARTY backend deps only, which must live in
  this folder's node_modules (\`bun add <pkg>\` here; the runtime does not
  install them). \`@uncorded/plugin-sdk\` is provided by the runtime — import
  it freely, never add it to package.json (it is not on npm).

## Hard rules

- Do not rename this folder — its name is the plugin's identity.
- Keep \`manifest.json\` "name" equal to the folder name (${input.slug}).
- The author tests by installing the plugin from the UnCorded desktop app
  (Server settings → Plugins → Add Plugin → Develop → Install), which
  restarts the server container — plugins load only at boot.

Start by reading AGENTS.md, then plan, then implement.
`;
}
