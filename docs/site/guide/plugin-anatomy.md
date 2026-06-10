# Plugin anatomy

A plugin is one folder, named exactly its slug, containing a manifest and one or
both entry points. This page is the map: what each file is, how the runtime
treats it, and the packaging rule that trips up most first attempts.

## The folder

```
my-plugin/
  manifest.json          ← required. Slug, entry points, capabilities, settings.
  backend/
    index.ts             ← backend entry (path is set by manifest.backend.entry)
  frontend/
    index.html           ← frontend entry (path is set by manifest.frontend.entry)
  migrations/
    001_init.sql         ← SQL run in filename order at load (data-owning plugins)
    002_add_column.sql
  node_modules/          ← REQUIRED if the backend imports anything (see Packaging)
  package.json           ← how you install node_modules
```

Only `manifest.json` plus at least one entry point is mandatory. A frontend-only
plugin omits `backend`; a headless plugin omits `frontend`; a reverse-proxy
plugin needs both but the backend is a few lines.

The folder name **must** equal the manifest `name`. That slug is the plugin's
identity everywhere: the install directory, the `installed_plugins` entry, the
DB filename, broadcast namespacing, and proxy/upload URLs.

## manifest.json

The contract between your plugin and the runtime. It is validated at load; an
invalid manifest means the plugin is skipped. The fields you'll touch most:

| Field | Purpose |
| --- | --- |
| `name` | Slug. `^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$`. |
| `version` / `api_version` | Plugin semver / runtime-API semver range (`^1.0`). |
| `type` | `core` \| `standalone` \| `extension`. Third-party = `standalone`. |
| `backend` / `frontend` | `{ "entry": "<path>" }`. At least one required. |
| `permissions` | The capabilities the runtime will allow. Undeclared = rejected. |
| `settings` | Admin-configurable values, rendered as a form in Server settings. |
| `sidebar` | `{ "contributes": true, … }` to put items in the client sidebar. |
| `public_schema` | Tables/columns you expose for cross-plugin reads. |

Full reference: [Manifest](/reference/manifest). Capability grammar:
[Permissions](/reference/permissions).

## backend/

The backend is a Bun program the runtime spawns as a **subprocess**. It speaks
the stdio JSON [IPC protocol](/reference/ipc-protocol), but you never touch that
directly — `createPlugin()` from `@uncorded/plugin-sdk` wraps it into a typed
handle.

Structure every backend the same way:

```ts
import { createPlugin } from "@uncorded/plugin-sdk";

const plugin = createPlugin();

// 1. Register handlers SYNCHRONOUSLY, at module top level, so they exist before
//    the runtime starts routing requests.
plugin.handle("doThing", async (params, user) => { /* … */ });
plugin.handle("sidebar.items", async (_params, user) => ({ items: [/* … */] }));

// 2. THEN do async setup: register permissions, subscribe to events, register
//    schedules, warm caches.
await plugin.permissions.register("my-plugin.post", { description: "…", default_level: 10 });
await plugin.events.subscribe("runtime.cascade.user.deleted", async (e) => { /* … */ });
```

Why the order matters: handler registration is local and instant; async setup
involves IPC round-trips. Registering handlers first guarantees a request that
arrives mid-startup has somewhere to land. See the
[text-channels walkthrough](/examples/text-channels) for a full backend.

The `createPlugin()` handle exposes the whole backend surface — `db`, `kv`,
`settings`, `events`, `broadcast`, `presence`, `schedule`, `fetch`, `core`,
`data`, `permissions`, `resources`, `files`, `voice`. Reference:
[Backend SDK](/reference/backend-sdk).

### Two reserved handler actions

| Action | Called by | Returns |
| --- | --- | --- |
| `sidebar.items` | the shell, to build the sidebar | `{ items: SidebarItem[], adminActions?: [] }` |
| `schedule.tick` | the runtime, on a registered schedule | (handled for you by `plugin.schedule.every`) |

Everything else is an action name you choose and the frontend calls by string.

## frontend/

The frontend entry (an HTML file) is served into a **sandboxed iframe** inside
the client shell. It has no same-origin access to the shell; all communication
goes through an origin-verified `postMessage` channel that the frontend SDK
manages for you.

```html
<script src="/sdk/plugin-frontend.js"></script>
<script type="module">
  const sdk = await window.UncodedPlugin.createPluginFrontend();
  // sdk.request(...), sdk.on(...), sdk.subscribe(...), sdk.files, sdk.proxy,
  // sdk.platform.* — see the Frontend SDK reference.
</script>
```

- Load `/sdk/plugin-frontend.js` from the runtime. **Do not** bundle or vendor
  it — it's served and cache-busted by the runtime so it stays in lockstep.
- The HTML is served as-is. **No build step** — inline your CSS and JS, or ship
  pre-built assets alongside `index.html`.
- `createPluginFrontend()` resolves after the handshake completes; everything
  else hangs off the returned `sdk`.

Reference: [Frontend SDK](/reference/frontend-sdk).

## migrations/

Data-owning plugins (those with `data.sql:self`) get a private SQLite database.
SQL files in `migrations/` run **in filename order** at plugin load to build and
evolve the schema:

- `001_init.sql` — `CREATE TABLE` + any seed rows.
- `002_*.sql`, `003_*.sql` — `ALTER TABLE`, new tables, backfills.

Conventions from the core plugins: integer Unix-ms timestamps
(`strftime('%s','now') * 1000` for seeds), explicit column lists in `SELECT`
(don't `SELECT *` — it leaks columns added by a later migration before your wire
contract catches up), and soft foreign keys checked in code rather than
`REFERENCES` constraints across plugin boundaries.

More on the database, KV, and events: [Data & events](/guide/data-and-events).

## Packaging — backends run as subprocesses

The single most common reason a plugin won't load. The runtime executes your
backend as its own subprocess with the plugin folder as the working directory:

```
Bun.spawn(["bun", "--smol", "run", "<backend entry>"], { cwd: "<plugin folder>" })
```

The runtime **does not** install your dependencies. So:

- Any `import` resolves against the plugin folder's **own `node_modules`**.
- **Ship `node_modules` in the installed folder** — either commit it, or include
  a `package.json` + lockfile and run `bun install` in the folder before
  installing the plugin.

```sh
cd my-plugin
bun add @uncorded/plugin-sdk   # populates node_modules/
```

> A backend that imports nothing (raw stdio) loads without packaging, but any
> real plugin imports the SDK and therefore must be packaged with its deps.

## Where data lives on disk

Inside the container, each plugin gets an isolated directory (mode `0700`):

```
/data/plugins/<slug>/
  <slug>.db            ← the plugin's private SQLite (WAL mode)
  <slug>.db-wal
  <slug>.db-shm
  uploads/             ← files POSTed to /upload, served via signed URLs
```

A plugin can never open another plugin's database for writing. Cross-plugin
reads go through the [`data.read`](/reference/backend-sdk#data) capability, which
opens the target DB read-only and enforces the target's `public_schema`.

Next: [Lifecycle](/guide/lifecycle) — exactly what happens from spawn to
shutdown, including the readiness handshakes and the watchdog.
