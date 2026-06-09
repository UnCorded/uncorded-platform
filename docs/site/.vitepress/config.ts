import { defineConfig } from "vitepress";

// Config for docs.uncorded.app. Served at the domain root, so base = "/".
// Markdown lives alongside this folder (srcDir defaults to the project root,
// docs/site). Cloudflare Pages builds with `bun run build` → .vitepress/dist.
export default defineConfig({
  title: "UnCorded SDK",
  description: "Developer documentation for building UnCorded plugins.",
  cleanUrls: true,
  lastUpdated: true,
  themeConfig: {
    nav: [{ text: "Plugin SDK", link: "/sdk/reverse-proxy" }],
    sidebar: [
      {
        text: "Plugin SDK",
        items: [{ text: "Reverse-proxy plugins", link: "/sdk/reverse-proxy" }],
      },
    ],
    outline: "deep",
    socialLinks: [
      { icon: "github", link: "https://github.com/UnCorded/uncorded-platform" },
    ],
  },
});
