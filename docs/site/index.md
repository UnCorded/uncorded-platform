# UnCorded Plugin SDK

Developer- and agent-facing documentation for building **UnCorded plugins**.

UnCorded is a self-hosted collaborative platform where users run a Docker
container on their own hardware. **Every feature is a plugin** — chat, voice,
dashboards, game integrations. This site documents the SDK you use to build one.

## Mental model

A plugin is three things that the runtime wires together:

1. **A manifest** (`manifest.json`) — declares the plugin's slug, entry points,
   and the exact set of capabilities it's allowed to use. Undeclared capability =
   hard reject at runtime.
2. **A backend** — a Bun process the runtime spawns as a subprocess. It talks to
   the runtime over a stdio JSON IPC channel, wrapped by the
   [`@uncorded/plugin-sdk`](/reference/backend-sdk) `createPlugin()` handle.
   It owns a private SQLite database, registers request handlers, publishes and
   subscribes to events, and pushes real-time updates to clients.
3. **A frontend** — an HTML panel rendered in a sandboxed iframe in the client
   shell. It uses the [`@uncorded/plugin-sdk-frontend`](/reference/frontend-sdk)
   `createPluginFrontend()` handle to call backend handlers, subscribe to
   broadcasts, upload files, and reach platform features (voice, panels, user
   cards).

```
manifest.json ── declares ──▶ capabilities the runtime enforces
      │
      ├── backend/  ── createPlugin() ──▶ subprocess ⇄ runtime (stdio JSON IPC)
      │                                     own SQLite · events · broadcast · schedule
      │
      └── frontend/ ── createPluginFrontend() ──▶ sandboxed iframe ⇄ shell (postMessage)
                                                  request() · subscribe() · files · voice
```

## For AI agents

This site emits the [llms.txt convention](https://llmstxt.org):

- [**/llms.txt**](/llms.txt) — a flat, linked index of every page.
- [**/llms-full.txt**](/llms-full.txt) — every page concatenated into one
  document. Fetch this single URL to load the entire SDK surface into context.

If you are an agent building a plugin, start from `/llms-full.txt`, then read the
[manifest reference](/reference/manifest) and [permissions reference](/reference/permissions)
to get the capability declarations right — that is where most first-attempt
plugins fail.

## Where to start

| You want to… | Go to |
| --- | --- |
| Build a working plugin end-to-end | [Getting started](/guide/getting-started) |
| Understand the folder layout & packaging | [Plugin anatomy](/guide/plugin-anatomy) |
| Know what happens from spawn to shutdown | [Lifecycle](/guide/lifecycle) |
| Use SQLite, KV, events, presence | [Data & events](/guide/data-and-events) |
| Look up a manifest field | [Manifest reference](/reference/manifest) |
| Look up a capability string | [Permissions reference](/reference/permissions) |
| Look up a backend SDK method | [Backend SDK](/reference/backend-sdk) |
| Look up a frontend SDK method | [Frontend SDK](/reference/frontend-sdk) |
| Debug the wire protocol | [IPC protocol](/reference/ipc-protocol) |
| Proxy a self-hosted web app | [Reverse-proxy plugins](/sdk/reverse-proxy) |
| Read a real, annotated plugin | [text-channels walkthrough](/examples/text-channels) |

## Packages

| Package | Import | Role |
| --- | --- | --- |
| `@uncorded/plugin-sdk` | `createPlugin()` | Backend runtime SDK (subprocess side). |
| `@uncorded/plugin-sdk-frontend` | `/sdk/plugin-frontend.js` | Panel/iframe SDK (`createPluginFrontend()`, `sdk.proxy`, `sdk.platform`). |
| `@uncorded/shared` | — | Manifest schema (`PluginManifest`, `ProxyMount`) and the validator. |
| `@uncorded/protocol` | — | Wire types shared by runtime and SDK (IPC frames, user shape). |

> Docs move in lockstep with the code. Every snippet here is adapted from real
> source in the [monorepo](https://github.com/UnCorded/uncorded-platform) and the
> shipped core plugins. When the SDK surface changes, the page changes in the
> same PR.
