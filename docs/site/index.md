# UnCorded SDK

Developer- and agent-facing documentation for building UnCorded plugins.

This site is intentionally minimal — it tracks the SDK surface so the docs move
in lockstep with the code. Each page is built from the published packages and
verified against a working example plugin in the monorepo.

## Plugin SDK

- [**Reverse-proxy plugins**](/sdk/reverse-proxy) — declare a `proxy_mount`, surface
  a sidebar panel, and serve an upstream (a self-hosted web app) through the
  runtime's reverse proxy.

## Packages

| Package | Import | Role |
| --- | --- | --- |
| `@uncorded/plugin-sdk` | backend `index.ts` | Plugin backend runtime (`createPlugin()`). |
| `@uncorded/plugin-sdk-frontend` | `/sdk/plugin-frontend.js` | Panel/iframe SDK (`createPluginFrontend()`, `sdk.proxy`). |
| `@uncorded/shared` | — | Manifest schema (`PluginManifest`, `ProxyMount`). |
