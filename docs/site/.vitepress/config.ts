import { defineConfig } from "vitepress";
import llmstxt from "vitepress-plugin-llms";

// Config for docs.uncorded.app. Served at the domain root, so base = "/".
// Markdown lives alongside this folder (srcDir defaults to the project root,
// docs/site). Cloudflare Pages builds with `bun run build` → .vitepress/dist.
export default defineConfig({
  title: "UnCorded SDK",
  description: "Developer and AI-agent documentation for building UnCorded plugins.",
  cleanUrls: true,
  lastUpdated: true,
  // README.md is repo/deploy documentation, not a published page. Excluding it
  // keeps it out of the site and out of the dead-link check (it links to
  // wrangler.jsonc, which isn't a markdown page).
  srcExclude: ["**/README.md"],
  // Emit the llms.txt convention at build time: /llms.txt (a curated, linked
  // index) and /llms-full.txt (every page concatenated). These let an AI agent
  // fetch the whole SDK surface from one URL instead of crawling pages.
  vite: {
    plugins: [
      llmstxt({
        ignoreFiles: ["README.md"],
        description:
          "UnCorded is a self-hosted collaborative platform where every feature is a plugin. This is the developer SDK for building those plugins: a backend SDK (createPlugin), a frontend/panel SDK (createPluginFrontend), the manifest schema, the capability model, and the stdio IPC protocol.",
      }),
    ],
  },
  themeConfig: {
    nav: [
      { text: "Guide", link: "/guide/getting-started" },
      { text: "Reference", link: "/reference/manifest" },
      { text: "Examples", link: "/examples/text-channels" },
      { text: "llms.txt", link: "/llms.txt", target: "_blank" },
    ],
    sidebar: [
      {
        text: "Guide",
        items: [
          { text: "Getting started", link: "/guide/getting-started" },
          { text: "Plugin anatomy", link: "/guide/plugin-anatomy" },
          { text: "Lifecycle", link: "/guide/lifecycle" },
          { text: "Data & events", link: "/guide/data-and-events" },
        ],
      },
      {
        text: "Reference",
        items: [
          { text: "Manifest", link: "/reference/manifest" },
          { text: "Permissions", link: "/reference/permissions" },
          { text: "Backend SDK", link: "/reference/backend-sdk" },
          { text: "Frontend SDK", link: "/reference/frontend-sdk" },
          { text: "IPC protocol", link: "/reference/ipc-protocol" },
        ],
      },
      {
        text: "Plugin types",
        items: [{ text: "Reverse-proxy plugins", link: "/sdk/reverse-proxy" }],
      },
      {
        text: "Examples",
        items: [{ text: "text-channels (annotated)", link: "/examples/text-channels" }],
      },
    ],
    outline: "deep",
    socialLinks: [
      { icon: "github", link: "https://github.com/UnCorded/uncorded-platform" },
    ],
  },
});
