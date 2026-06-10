# Lifecycle

What the runtime does to your plugin, from boot to shutdown. Understanding this
explains why handlers must register synchronously, when `serveReady()` matters,
and why a crash loop quarantines a plugin.

## 1. Discovery

At boot the runtime reads `server.json` → `installed_plugins: string[]`. For each
slug it resolves a folder (core plugins first, then user plugins) and reads
`manifest.json`. A slug with no resolvable manifest is **skipped with a warning**
— it doesn't block boot. A plugin marked disabled in settings is also skipped.

> The list is read **only at boot**. Adding a slug to `installed_plugins`
> requires recreating the container (restart via the desktop app), not a hot
> reload.

## 2. Database & migrations

Before spawning, the runtime prepares the plugin's data directory
(`/data/plugins/<slug>/`, mode `0700`) and runs the SQL files in `migrations/`
in filename order. The SQLite database opens in WAL mode on first use. If a
migration throws, the plugin is skipped with an error.

## 3. Spawn

The backend is launched as its own subprocess:

```
Bun.spawn(["bun", "--smol", "run", "<backend entry>"], {
  cwd: "<plugin folder>",
  stdin: "pipe", stdout: "pipe", stderr: "pipe",
  env: {
    PLUGIN_SLUG, PLUGIN_API_VERSION, PLUGIN_DATA_DIR,
    NODE_OPTIONS: "--max-old-space-size=256",  // memory guard (cgroup is authoritative)
  },
})
```

- `--smol` runs Bun in low-memory mode (more frequent GC).
- `stdin`/`stdout` are owned by the IPC transport — **don't read stdin** or write
  raw protocol to stdout. Unprefixed stdout and all stderr are captured as logs.
- The plugin folder is the working directory, which is why imports resolve
  against the folder's own `node_modules` ([packaging](/guide/plugin-anatomy#packaging-backends-run-as-subprocesses)).

## 4. The ready handshake {#the-ready-handshake}

`createPlugin()` sends `{ "type": "ready" }` to the runtime as the last thing it
does. The runtime waits up to **30 seconds** for it; no ready frame in that
window is a `HANDSHAKE_TIMEOUT` and the spawn fails.

`ready` only proves the **process is alive and the SDK is wired** — not that your
caches are warm. For most plugins that's enough and the runtime starts routing
requests immediately.

## 5. The optional serve-ready handshake {#the-optional-serve-ready-handshake}

If your plugin needs to hydrate state before it can answer requests (warm a
cache, prefetch from an external service), opt into the two-stage handshake:

```json
{ "serve_ready_handshake": true }
```

With it set, the runtime registers the plugin as **not-ready-to-serve**: the
client greys out the plugin's sidebar items until you signal completion:

```ts
// after caches are loaded, member lists fetched, etc.
plugin.serveReady();
```

Without the opt-in, `serveReady()` is a harmless no-op (the plugin is treated as
serve-ready the moment it spawns). Use it to avoid surfacing clickable rows the
plugin can't yet answer — otherwise a freshly provisioned server can show a
channel that silently fails to open.

## 6. Watchdog (ping / pong)

Every **10 seconds** the runtime sends `{ "type": "ping" }` to each ready
plugin. The SDK auto-responds with `{ "type": "pong" }` — you write no code for
this. Miss **3 consecutive pings (30s)** and the runtime force-kills the
subprocess as hung.

A plugin that blocks the event loop (a long synchronous loop) can miss pongs and
get killed. Keep handlers async and yield; offload heavy work or chunk it.

## 7. Crash, restart & quarantine

When a subprocess exits unexpectedly, the runtime restarts it on a backoff
schedule: **1s → 2s → 5s → 15s → 60s**. If a plugin crashes **5 times within 10
minutes** it is **quarantined** — no further restarts until manual intervention.
This stops a broken plugin from pinning CPU in a tight crash loop.

A graceful stop (below) or a clean exit does not count toward the crash budget.

## 8. Shutdown

On unload (server stop, plugin disable, container teardown) the runtime stops the
plugin gracefully:

1. Send `SIGTERM`, wait up to **5 seconds** for a clean exit.
2. `SIGKILL` if it hasn't exited.
3. Close the transport and fire unload callbacks (managed services released, etc.).

To shut down cleanly, let your event loop drain — flush pending writes in handler
paths, not in an exit hook, since `SIGKILL` after the grace window won't run one.

## Reference: the message frames

You won't send these directly (the SDK does), but they're useful when reading
logs or debugging:

| Frame | Direction | Meaning |
| --- | --- | --- |
| `ready` | plugin → runtime | SDK initialized; begin routing. |
| `serve_ready` | plugin → runtime | Caches warm; un-grey sidebar items. |
| `ping` / `pong` | runtime ⇄ plugin | Watchdog heartbeat (auto-handled). |
| `request` / `response` | runtime ⇄ plugin | A handler invocation and its result. |
| `event.deliver` / `event.ack` | runtime ⇄ plugin | Event bus delivery + acknowledgement. |

Full protocol: [IPC protocol](/reference/ipc-protocol).
