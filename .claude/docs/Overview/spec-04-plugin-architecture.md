---
vision: "Central knows nothing beyond 'this server exists at this URL'"
tenet: "Every feature is a choice"
depends-on: [spec-01-vision-and-wedge, spec-05-plugin-data-model]
last-verified: 2026-04-05
---

# 04 — Plugin Architecture

*How plugins work: what they are, how they're structured, how they start, how they communicate, how they're isolated, how they're limited, and how they're updated live.*

---

## What a Plugin Is

A plugin is a **folder** containing backend code, frontend code, and a manifest. Drop it into a server's `/plugins/` directory and it runs. Remove it and it stops. That's the entire install/uninstall model.

```
plugins/text-channels/
├── manifest.json        ← identity, permissions, dependencies, published schema
├── migrations/          ← numbered SQL files (see spec-05-plugin-data-model.md)
├── backend/
│   └── index.ts         ← entry point, runs as a subprocess
└── frontend/
    ├── index.html       ← entry point, served in the shell's iframe
    ├── app.js
    └── style.css
```

A plugin can have only a backend (headless service), only a frontend (pure UI widget), or both. Most plugins have both.

---

## Plugin Types

| Type | Description | Example |
|---|---|---|
| **Core** | Built by UnCorded. Bundled in the base server image. Opt-in during server creation (pre-checked by default in the wizard). Cannot be modified by server owners, only enabled/disabled. | `text-channels` |
| **Standalone** | Independent plugins from any developer. Their own frontend, backend, database, routes. Appear as a top-level item in the server's plugin navigation. | Photo gallery, Minecraft server bridge, Kanban board |
| **Extension** | Hooks into another plugin. Depends on a base plugin being installed. Adds features to the base plugin's UI or data model. | `reactions` extends `text-channels`, `screen-share` extends `voice-channels` |

Extension plugins declare `"extends": "text-channels"` in their manifest. The runtime verifies the base plugin is installed and version-compatible before loading the extension.

**Extension hook system** is designed for but not built in Phase 1. Phase 1 extensions can read from the base plugin's published schema and subscribe to its events, but cannot inject UI into the base plugin's frontend. UI injection via a formal hook API ships in Phase 3.

---

## The Manifest

Every plugin has a `manifest.json` at its root. This is the only file the runtime reads to understand the plugin — everything else is opaque.

```json
{
  "name": "text-channels",
  "version": "1.2.0",
  "api_version": "^1.0",
  "author": "UnCorded",
  "description": "Text-based channels with messages, mentions, edits, and deletions.",
  "license": "MIT",

  "type": "core",

  "backend": {
    "entry": "backend/index.ts"
  },
  "frontend": {
    "entry": "frontend/index.html"
  },

  "permissions": [
    "data.kv:self",
    "data.sql:self",
    "events.publish:text-channels.*",
    "events.subscribe:runtime.cascade.*",
    "storage.file:self"
  ],

  "public_schema": {
    "messages": {
      "columns": ["id", "channel_id", "author_id", "content", "created_at"],
      "description": "All messages across all channels."
    },
    "channels": {
      "columns": ["id", "name", "topic", "created_at"],
      "description": "All text channels in this server."
    }
  },

  "dependencies": {},

  "resources": {
    "memory_mb": 128,
    "cpu_weight": 1024,
    "disk_mb": 512
  },

  "processes": [
    { "name": "backend", "label": "Plugin Backend" }
  ]
}
```

### Manifest fields

| Field | Required | Description |
|---|---|---|
| `name` | Yes | Unique slug. Lowercase, hyphens only. |
| `version` | Yes | Semver. |
| `api_version` | Yes | Semver range of the runtime API this plugin targets. Runtime refuses to load incompatible plugins. |
| `author` | Yes | Publisher name. |
| `description` | Yes | One-line description for the marketplace and admin UI. |
| `type` | Yes | `core`, `standalone`, or `extension`. |
| `extends` | Extension only | The slug of the base plugin this extension hooks into. |
| `backend.entry` | If backend exists | Relative path to the backend entry file. |
| `frontend.entry` | If frontend exists | Relative path to the frontend entry HTML. |
| `permissions` | Yes | Array of capability strings the plugin requires. See Capability Permissions below. |
| `public_schema` | No | Tables and columns exposed for cross-plugin reads. See `spec-05-plugin-data-model.md`. |
| `dependencies` | No | Map of plugin slug → semver range for plugins that must be installed. |
| `resources` | No | Requested resource limits. Server owner can override. Defaults apply if omitted. |
| `processes` | No | Array of named child processes the plugin manages internally. Used for terminal tab labels in the admin panel. If omitted, the plugin gets one default "Backend" terminal tab. See Plugin Terminal Access below. |

---

## Plugin Lifecycle

### Loading (on server startup or hot reload)

```
[1] Runtime reads manifest.json
    → Validates schema (rejects malformed manifests)
    → Checks api_version compatibility with current runtime

[2] Resolve dependencies
    → Verify all declared dependencies are installed and version-compatible
    → For extensions: verify base plugin is installed and version-compatible
    → Build topological load order (dependencies load first)

[3] Run migrations
    → See spec-05-plugin-data-model.md for the full migration flow
    → Database is at latest schema before any backend code runs

[4] Spawn backend subprocess
    → bun run <backend.entry>
    → Environment variables set:
      PLUGIN_SLUG          — the plugin's unique name
      PLUGIN_DATA_DIR      — path to the plugin's data directory
      PLUGIN_API_VERSION   — the runtime's API version
    → stdin: piped (owned by IPC transport — runtime sends JSON messages to plugin)
    → stdout: piped (plugin sends IPC:-prefixed JSON messages to runtime; non-prefixed lines go to log collector)
    → stderr: piped to runtime log collector
    → CWD: the plugin's own directory
    → No inherited env vars, no inherited handles

[5] Backend handshake
    → IPC channel is implicit via stdin/stdout (Bun's built-in IPC is broken on Windows; stdio JSON is the cross-platform solution)
    → Registers its request handlers (sdk.handle)
    → Registers its event subscriptions (sdk.events.subscribe)
    → Sends { type: "ready" } via IPC
    → Runtime waits for "ready" with injectable timeout (default 30s)

[6] Frontend mounted
    → Runtime serves frontend/index.html and all static assets at /plugins/<slug>/ui/
    → Runtime also serves the frontend SDK bundle at /sdk/plugin-frontend.js
    → When a user opens this plugin, the shell loads the iframe to that URL
    → The iframe receives auth via postMessage handshake (see spec-06-authentication.md)

[7] Plugin is live
    → Accepting requests via WebSocket
    → Publishing and receiving events
    → Querying its own database
```

**Error handling requirement:** every step above is a distinct failure point. Each one must produce a **specific, actionable error** that names the plugin, the step number, and the exact cause. Not "plugin failed to load" — instead: "text-channels failed at step 3: migration 002_add_edited_at.sql — SQLITE_ERROR: duplicate column name: edited_at." The server admin UI surfaces these errors with the step context so the owner knows exactly where the load failed and what to fix. This is not optional polish — it is a spec requirement. Seven loading steps without per-step error reporting is debugging hell.

### Unloading (on server shutdown, plugin disable, or hot reload)

```
[1] Runtime sends SIGTERM to the backend subprocess
[2] Grace period: 5 seconds for the backend to finish in-flight work
[3] If still running after 5 seconds: SIGKILL
[4] Frontend iframe is removed from the shell
[5] IPC socket is closed
[6] Database file is NOT deleted (see spec-05-plugin-data-model.md)
```

---

## Communication: WebSocket for Everything

Plugin frontends and backends communicate through the **existing authenticated WebSocket** the user already has open to the server. No per-plugin HTTP routes. No REST APIs. One pipe for everything.

### How it works

```
User's browser
  └── Shell app (SolidJS)
        └── WebSocket to server (authenticated on connect)
              └── Plugin iframe sends a message via sdk.request()
                    └── Shell intercepts, tags with plugin slug, sends over WS
                          └── Runtime receives, checks capability, routes to plugin subprocess
                                └── Plugin backend handles, returns result
                                      └── Runtime sends response back over WS
                                            └── Shell routes to the correct iframe
```

### Request/response (CRUD operations)

Plugin frontend makes a request:

```ts
// Frontend
const messages = await sdk.request("getMessages", { channelId: "abc" })
```

Plugin backend handles it:

```ts
// Backend
sdk.handle("getMessages", async (params, user) => {
  return db.query(
    "SELECT * FROM messages WHERE channel_id = ? ORDER BY created_at DESC LIMIT 50",
    [params.channelId]
  )
})
```

Under the hood:
1. Frontend sends `{ type: "request", id: "req_1", plugin: "text-channels", action: "getMessages", params: { channelId: "abc" } }` via the shell's WebSocket.
2. Runtime receives it, validates auth, checks capabilities, routes to the `text-channels` subprocess.
3. Subprocess handles it, returns the result.
4. Runtime sends `{ type: "response", id: "req_1", result: [...] }` back.
5. Frontend's `sdk.request()` promise resolves with the result.

### Real-time events

Plugin backend publishes an event:

```ts
// Backend: when a new message is created
sdk.events.publish("text-channels.message.created", {
  id: messageId,
  channelId,
  authorId: user.id,
  content,
  createdAt: Date.now()
})
```

Plugin frontend subscribes:

```ts
// Frontend
sdk.subscribe("text-channels.message.created", (event) => {
  addMessageToUI(event.payload)
})
```

Under the hood:
1. Backend publishes via IPC to runtime.
2. Runtime distributes to all subscribers (other plugin backends + connected frontends).
3. For frontends: runtime sends the event over WebSocket to every connected user who has that plugin open.
4. Shell routes the event to the correct plugin iframe.

### File uploads

The one exception to WebSocket-for-everything. Binary file uploads go through a **single runtime HTTP endpoint:**

```
POST /upload
Headers:
  Authorization: Bearer <server-auth-token>
  X-Plugin: photo-gallery
Body: multipart/form-data
```

The runtime:
1. Validates the auth token.
2. Checks that the target plugin has the `storage.file:self` capability.
3. Saves the file to the plugin's data directory.
4. Notifies the plugin backend via IPC: "a file was uploaded."
5. Returns the file ID to the frontend.

One endpoint for all plugins. The runtime handles auth, routing, and storage. Plugins never run their own HTTP server.

---

## Capability Permissions

Plugins declare every capability they need in the manifest's `permissions` array. The runtime enforces these at the IPC boundary — every SDK call is checked before execution. Undeclared capabilities fail closed.

### Permission grammar

```
resource.action[:scope]
```

| Permission | What it grants |
|---|---|
| `data.sql:self` | Raw SQL access to the plugin's own database |
| `data.kv:self` | Key-value storage in the plugin's own namespace |
| `data.read:<plugin>.<table>` | Read-only access to another plugin's published schema table |
| `events.publish:<topic>` | Publish events to a topic (wildcards allowed: `text-channels.*`) |
| `events.subscribe:<topic>` | Subscribe to events on a topic (wildcards allowed) |
| `storage.file:self` | Read/write files in the plugin's own data directory |
| `http.fetch:<host>` | Make outbound HTTP requests to a specific host (runtime proxies) |
| `runtime.log` | Write to the structured runtime log |
| `auth.currentUser` | Access the authenticated user's identity on each request |
| `runtime.plugin.install` | Trigger installation of another plugin. **Official-tier only.** Requires per-call user confirmation. |

### Enforcement

- Every capability call goes through the IPC socket to the runtime.
- The runtime checks the call against the plugin's declared permissions.
- If the permission is not declared → **reject immediately.** No fallback, no warning, no "try anyway."
- If the permission is declared but the scope doesn't match (e.g., `data.read:text-channels.messages` but the query targets `text-channels.drafts`) → **reject.**
- All rejections are logged for observability.

### Subprocess hardening

Plugin backends are spawned with minimal privileges:

- **Environment:** only `PLUGIN_SLUG`, `PLUGIN_DATA_DIR`, `PLUGIN_API_VERSION` are set. No host env vars leak.
- **CWD:** pinned to the plugin's own directory.
- **stdin:** piped — owned by the IPC transport (JSON message channel from runtime to plugin).
- **stdout:** piped — IPC:-prefixed lines are IPC messages; non-prefixed lines go to the log collector.
- **stderr:** piped to runtime log collector.
- **No inherited handles.**

### Container-level defenses

The server container itself runs with:

- `--cap-drop=ALL` — only capabilities actually needed are re-added.
- Read-only root filesystem except for mounted volumes (`/plugins`, `/data`, `/config`).
- Non-root UID for plugin subprocesses.
- `--security-opt=no-new-privileges` — subprocesses cannot escalate.
- Outbound network denied by default at the container level. Plugins that need outbound access declare `http.fetch:<host>` and the runtime proxies the request.

---

## Event Bus

The runtime hosts a publish/subscribe event bus that plugins use for cross-plugin communication and real-time updates.

### Topics

Topics are dotted strings scoped by plugin slug:

- `text-channels.message.created`
- `text-channels.message.deleted`
- `members.user.joined`
- `runtime.cascade.user.deleted` (reserved `runtime.*` namespace)

### Event envelope

Every event has:

```json
{
  "topic": "text-channels.message.created",
  "version": 1,
  "id": "evt_a1b2c3",
  "ts": 1712345678000,
  "source_plugin": "text-channels",
  "payload": { }
}
```

- `id` is unique. Subscribers use it for idempotency (dedupe on the ID if they see the same event twice).
- `version` is bumped on breaking payload changes. Subscribers declare which versions they accept.

### Delivery guarantees

- **At-least-once** delivery. The runtime may deliver an event more than once in edge cases (restart, IPC retry). Subscribers must handle duplicates via the `id` field.
- **Per-(topic, subscriber) FIFO order.** Events from `text-channels.message.created` arrive at a given subscriber in publication order. No ordering across topics or across subscribers.

### Backpressure

Each subscriber has a bounded in-memory queue (default: 1024 events). When the queue fills, the behavior depends on the **declared overflow policy:**

| Policy | Behavior | Use case |
|---|---|---|
| **`mark_unhealthy`** (default) | Queue full → subscription marked unhealthy, delivery stops, `runtime.subscriber.unhealthy` emitted. Plugin must re-subscribe to resume. | Any plugin that cannot tolerate data loss. This is the default because **silent drops are the worst failure mode.** |
| `drop_oldest` | Queue full → oldest event dropped, newest kept. | State-update topics: presence, typing indicators, cursor positions. Newer is always better. |
| `drop_newest` | Queue full → incoming event dropped, oldest kept. | Stream-of-record topics where the prefix matters more than the tail. |
| `persist` | Reserved for future. Would spill overflow to disk. | Not shipped in Phase 1. |

Overflow events (`runtime.subscriber.overflow`, `runtime.dlq.overflow`) are **rate-limited to one per plugin per 60 seconds** with a `drop_count` field carrying the total. Prevents observability noise from chronically failing plugins.

### Failure handling

A subscriber that throws or times out is retried with backoff (1s, 5s, 30s). After **5 consecutive failures**, the subscription is marked unhealthy and events route to a **dead-letter log** (see `spec-05-plugin-data-model.md` for DLQ bounds: 1000 entries, 7-day TTL).

### Permissions

- Publishing requires `events.publish:<topic>`.
- Subscribing requires `events.subscribe:<topic>`.
- Wildcards are allowed: `events.subscribe:text-channels.*`.
- The `runtime.*` namespace is reserved. Plugins can subscribe to `runtime.cascade.*` but cannot publish to `runtime.*`.

---

## Resource Limits and Watchdog

Every plugin runs within enforced resource limits. A single bad plugin cannot destabilize the server.

### Default limits

| Resource | Default | Manifest key | Notes |
|---|---|---|---|
| Memory | 128 MB | `resources.memory_mb` | Hard cap. Exceeding triggers OOM kill. |
| CPU weight | 1024 | `resources.cpu_weight` | Relative share. Higher = more CPU when contended. |
| Max PIDs | 32 | — | Prevents fork bombs. |
| File descriptors | 256 | — | Prevents fd leaks. |
| Disk quota | 512 MB | `resources.disk_mb` | Enforced by the runtime on `storage.file.*` writes. Exceeding returns an error. |
| Request timeout | 30s | — | `sdk.handle` callbacks that exceed 30s are terminated. |

Server owners can override defaults per-plugin in server settings. Plugins can request higher limits in the manifest — the marketplace displays these so users know what they're installing.

### Restart policy

If a plugin subprocess crashes:

1. Restart with exponential backoff: 1s, 2s, 5s, 15s, 60s.
2. After **5 restarts in 10 minutes** → plugin is **quarantined.**
3. Quarantined plugins do not restart. A notice appears in the server admin UI. An event is emitted on the audit log.
4. The server owner must manually re-enable the plugin after investigating.

### Watchdog

The runtime sends a heartbeat ping on the IPC socket every 10 seconds. If a plugin misses **3 consecutive pings** (30 seconds), the runtime force-kills the subprocess and increments the restart counter.

---

## Hot Reload

Plugins can be updated without restarting the entire server. This is a Phase 1 feature for developer experience.

### How it works

1. Runtime watches each installed plugin's directory for file changes.
2. On change detected:
   - The affected plugin's backend subprocess receives SIGTERM (5s grace, then SIGKILL).
   - Manifest is re-read and re-validated.
   - Migrations are checked and run if needed.
   - Backend is respawned with the new code.
   - Frontend static files are already served from disk — the next iframe load picks up changes automatically.
3. Active WebSocket connections to that plugin receive a `runtime.plugin.reloaded` event. The SDK can auto-reconnect.

### Interaction with restart policy

Hot reload increments the restart counter. If a developer's broken code causes a crash loop during hot reload, the quarantine policy still applies. Hot reload is not a backdoor around resource or stability enforcement.

### Interaction with migrations

If the updated plugin has new migration files, they run before the backend starts — same as on initial load. This means a hot-reloaded plugin can alter its database schema live.

---

## Plugin API Versioning

Two version numbers matter. They are independent.

| Version | What it tracks | Who bumps it |
|---|---|---|
| `runtime_version` | The server container image version. | UnCorded (on each release). |
| `api_version` | The semver of the capability API surface exposed to plugins. | UnCorded (when the SDK changes). |

### Compatibility rules

- **Patch** (1.2.0 → 1.2.1): bug fixes only. Always compatible.
- **Minor** (1.2 → 1.3): additive changes only. Backwards-compatible.
- **Major** (1.x → 2.x): breaking changes. Plugins must opt in by updating their `api_version` range.

### Plugin SDK

The `@uncorded/plugin-sdk` package is published per API major version. Plugin authors depend on the SDK; the SDK is a typed wrapper around the IPC socket protocol.

```json
// Plugin's package.json
{
  "dependencies": {
    "@uncorded/plugin-sdk": "^1.0.0"
  }
}
```

### Deprecation lifecycle

A capability marked deprecated in API version N:
- Remains supported through N+1.
- Can be removed in N+2 at the earliest.
- Deprecated calls log a structured warning the marketplace surfaces to the publisher.

---

## Frontend Plugin SDK

Plugin frontends communicate with the shell via a postMessage protocol (`uncorded.ready`, `uncorded.token`, `uncorded.navigate`, `request`, `response`, `event`). The `@uncorded/plugin-sdk-frontend` package implements this protocol as a typed, async-initialized JavaScript library.

```ts
import { createPluginFrontend } from '/sdk/plugin-frontend.js';

const sdk = await createPluginFrontend();

// Make a request to the plugin backend
const messages = await sdk.request('getMessages', { channelId: 'abc' });

// Subscribe to real-time events from the backend
sdk.subscribe('text-channels.message.created', (payload) => {
  addMessageToUI(payload);
});

// Handle navigation events from the shell (e.g., user clicks a channel)
sdk.onNavigate(({ itemId, itemLabel }) => {
  loadChannel(itemId, itemLabel);
});
```

### SDK delivery

The SDK is not a CDN dependency. It is served by the runtime at a stable path and built into the server container image.

**Core plugins** (bundled in the runtime image) reference the SDK at its served path:

```html
<script type="module">
import { createPluginFrontend } from '/sdk/plugin-frontend.js';
// ...
</script>
```

The runtime serves `GET /sdk/plugin-frontend.js` — a pre-built ES module bundle of `@uncorded/plugin-sdk-frontend`. This bundle is produced at **image build time** (not at runtime startup). Core plugins always get the SDK version their runtime image ships with.

**Third-party plugins** have two options:

| Option | How | Trade-off |
|---|---|---|
| Reference the runtime's copy | `import { createPluginFrontend } from '/sdk/plugin-frontend.js'` | Gets whatever SDK version the runtime ships. No build step required. Safe for plugins that track the current `api_version` range. |
| Bundle their own copy | Include a compiled `sdk.js` in their `frontend/` directory and import it with a relative path | Pins to a specific SDK version. Required when targeting an older `api_version` or when predictable behavior across runtime upgrades is needed. |

The runtime serves whatever is in a plugin's `frontend/` directory without modification. A third-party plugin that bundles its own SDK copy simply ships `frontend/sdk.js` alongside `frontend/index.html` — the runtime does not inspect or rewrite it.

### API surface

`createPluginFrontend(options?)` performs the postMessage handshake and returns a `PluginFrontend` handle:

| Member | Description |
|---|---|
| `sdk.slug` | This plugin's slug, as assigned by the runtime |
| `sdk.token` | The raw JWT the shell sent during handshake |
| `sdk.request(action, params?)` | Send a request to the plugin backend. Returns a Promise. Rejects after 30s or on capability denial. |
| `sdk.subscribe(topic, handler)` | Subscribe to a named event topic. Sends a subscribe message to the shell. Returns an unsubscribe function. |
| `sdk.on(event, handler)` | Shorthand: register a local handler for `<slug>.<event>` without sending a subscribe message. Returns an unsubscribe function. |
| `sdk.onNavigate(handler)` | Register a handler for `uncorded.navigate` messages from the shell. Returns an unsubscribe function. |

`options.handshakeTimeoutMs` overrides the default 5-second handshake timeout.

### Navigate protocol

The shell sends `{ type: "uncorded.navigate", itemId, itemLabel }` when the user selects an item in this plugin's nav tree (e.g., clicks a channel). `itemId` is the opaque identifier; `itemLabel` is the human-readable name. Both are always present — the shell never sends one without the other.

The `sdk.onNavigate` handler fires after the SDK is initialized, so there is no race between the handshake and the first navigate event.

### Security

- The handshake derives `shellOrigin` from `document.referrer`. All outbound `postMessage` calls are targeted at `shellOrigin` — never `"*"`.
- Inbound messages are origin-checked against `shellOrigin`. Messages from other origins are silently dropped.
- `createPluginFrontend()` rejects if `document.referrer` is empty (i.e., the page is not inside a shell iframe).

---

## Plugin Terminal Access

> **REMOVED (2026-06-05) — not a V1 feature.** Plugin terminal consoles shipped on the
> Registered Terminals primitive (the `terminals.*` IPC frame family), which was removed in
> commit `95dec38`. The section below is retained as historical design only and does not
> describe current behavior. The runtime still pipes each plugin's stdout/stderr to the log
> collector (see the IPC note in `CLAUDE.md` and the per-plugin log buffer), but there is no
> interactive terminal / xterm.js surface in V1.

> **Authoritative model:** `spec-25-registered-terminals.md`. This section describes the plugin-side registration path (`source: plugin` in the registered-terminals primitive). Attach surface, encryption, permission cascade, panel rendering, and the in-container IPC frame family are all defined there. Per spec-25 Amendment P, the legacy `terminal.input` / `terminal.output` IPC has been removed in PR-T5; the `terminals.*` frames (Amendment O) are the current transport.

Every plugin gets a built-in terminal view via the runtime's registered-terminals system. Server owners and admins can view live output and send input to plugin processes — critical for plugins like Minecraft server bridges where the admin needs console access.

### How it works

The runtime already pipes each plugin's stdout/stderr. The terminal feature extends this into a live, interactive terminal rendered with **xterm.js** (in `/admin/` and as a workspace panel type — see spec-25).

**Terminal I/O flows through the `terminals.*` IPC frame family** (spec-25 Amendment O). stdin is owned by the IPC transport (JSON message channel); plugins call `sdk.terminals.register()` and exchange `terminals.pty.input` / `terminals.pty.bytes` frames with the runtime. Capability gating requires `"terminals.register"` in the manifest's `permissions` array. See spec-25 §IPC for the wire shapes.

### Process declarations in manifest

Plugins can declare named child processes they manage internally. These become terminal tab labels:

```json
{
  "processes": [
    { "name": "backend", "label": "Plugin Backend" },
    { "name": "minecraft", "label": "Minecraft Server" }
  ]
}
```

- The `processes` field is **optional.** If omitted, the plugin gets one default "Backend" terminal tab showing stdout/stderr of the main backend subprocess.
- The runtime spawns **one subprocess per plugin** (the backend). Child processes (e.g., the MC server) are managed by the plugin backend internally.
- Each declared process becomes a separate registered terminal (one `terminals.register.req` per process); the plugin backend routes `terminals.pty.input` to the correct child's stdin and emits child output as `terminals.pty.bytes`.

### Previous launch logs

- On each plugin launch, the previous run's output is saved as a plain `.txt` file in the plugin's data directory.
- The **3 most recent** previous launch logs are retained. Older logs are rotated out automatically by the runtime.
- Previous logs are static files — viewable or downloadable from the admin panel, not rendered in xterm.js.

### Access control

- **Owner and Admin roles only.** No moderators, no members. Terminal access is a privileged operation.
- Access is enforced by the same role check that gates the admin panel (`/admin/`).

### Infrastructure

- **xterm.js** on the frontend — works on desktop and mobile (accessible via the Cloudflare tunnel from anywhere).
- Runtime streams subprocess output over the existing WebSocket to the admin panel client.
- Log rotation handled by the runtime automatically — no plugin author involvement.

---

## Summary of Decisions

| Decision | Answer |
|---|---|
| Plugin structure | Folder with manifest.json, backend/, frontend/, migrations/ |
| Plugin types | Core, standalone, extension |
| Communication model | **WebSocket for everything.** `sdk.request()` for CRUD, `sdk.subscribe()` for real-time. No per-plugin HTTP routes. Single `/upload` endpoint for files. |
| Isolation | Subprocess per plugin. Container-level cap-drop. Capability-mediated IPC. |
| Permissions | Capability-based. Declared in manifest. Enforced at runtime IPC boundary. Fail closed. |
| Event bus default | `mark_unhealthy` on queue full. Silent drops are opt-in. |
| Resource limits | Memory, CPU, PIDs, FDs, disk. Enforced. Quarantine after 5 crashes in 10 minutes. |
| Hot reload | Phase 1. File-watch → graceful restart → re-validate → respawn. |
| API versioning | Independent runtime_version and api_version. Semver. SDK per major. |
| Frontend SDK delivery | Core plugins: `/sdk/plugin-frontend.js` served by runtime, built at image build time. Third-party: reference `/sdk/plugin-frontend.js` (gets runtime's version) or bundle own copy in `frontend/`. |
| Terminal access | **Removed (commit `95dec38`)** — the xterm.js terminal surface and `terminals.*` IPC frame family are not in V1. The runtime still captures plugin stdout/stderr to the per-plugin log buffer. |

---

## Future Refinements

### Extension UI injection (hook system)
- **What changes:** Extension plugins can inject UI components into a base plugin's frontend — e.g., `reactions` adding a reaction bar below each message in `text-channels`.
- **Why not now:** The hook system requires designing a stable set of injection points in base plugin frontends. Those points will only become clear once the base plugins are built and used. Designing hooks now means guessing.
- **What today's code must not do:** The shell's iframe architecture must not assume one plugin = one iframe forever. Leave room for a base plugin's iframe to load extension UI fragments (via nested iframes, Web Components, or a runtime-injected script). The exact mechanism is Phase 3; the constraint on Phase 1 is just "don't make it impossible."

### Worker-thread execution mode
- **What changes:** Lightweight plugins can declare `"execution": "worker"` in the manifest. The runtime hosts these as Bun Worker threads inside the runtime process — lower overhead, weaker isolation. Opt-in, reserved for signed/verified plugins.
- **Why not now:** No performance data showing subprocess overhead is a bottleneck. The Phase 1 scale (5-20 plugins) doesn't warrant the complexity.
- **What today's code must not do:** The IPC protocol between runtime and plugin must not assume subprocess-only semantics. The message format over stdio should work identically if the transport changes to worker-thread message passing or TCP. Design the protocol as message-oriented, not stream-oriented. The `IpcTransport` interface abstracts the channel — swapping the implementation must not require plugin code changes.

### Plugin-to-plugin direct messaging
- **What changes:** Two plugins could communicate directly over a dedicated IPC channel instead of going through the event bus. Lower latency for tightly coupled plugins.
- **Why not now:** The event bus handles cross-plugin communication in Phase 1. Direct messaging adds complexity and a second communication pattern for plugin authors to learn.
- **What today's code must not do:** The capability grammar must have room for `ipc.direct:<plugin>`. Don't use the `ipc` namespace for anything else.

### Outbound network beyond http.fetch
- **What changes:** Plugins could open raw TCP/UDP connections for protocols HTTP can't handle (game servers, custom protocols, IoT).
- **Why not now:** `http.fetch` covers the vast majority of outbound needs. Raw network access is a larger security surface.
- **What today's code must not do:** Container network rules must be configurable per-plugin, not a single global policy. Even if Phase 1 only enforces a global deny + http.fetch allowlist, the infrastructure should support per-plugin rules so they can be turned on later.

### Plugin resource limit negotiation
- **What changes:** When a plugin requests resources beyond the server's defaults, the server owner sees a confirmation dialog during install: "This plugin requests 512MB RAM (default is 128MB). Allow?" Instead of silently applying defaults.
- **Why not now:** Phase 1 plugins are all first-party. Resource negotiation UI adds complexity with no immediate consumer.
- **What today's code must not do:** The manifest `resources` field must be read and stored even if Phase 1 just applies defaults. The field exists so the marketplace can display resource requirements and the future negotiation UI can read them.

## Amendment A — Plugin settings storage, schema extensions, IPC, admin endpoints (2026-05-13)

This amendment ratifies the end-to-end plugin settings system shipped alongside the website Plugins panel. The original spec text declared `settings` in the manifest as an admin-rendered schema and noted that values "are stored in the plugin's KV store under the given key." That sentence is **superseded** by this amendment.

### A.1 — Storage: dedicated `_config` table, not the KV store

Plugin settings values live in a dedicated `_config` table inside the plugin's own SQLite database (the same DB that hosts `_kv`). The KV store is reserved for plugin-defined unbounded data; `_config` is the typed, schema-validated, audit-logged channel for admin-set knobs.

```sql
CREATE TABLE IF NOT EXISTS _config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('string','secret','number','boolean')),
  updated_at INTEGER NOT NULL,
  updated_by_user_id TEXT
);
```

`value` is always TEXT — booleans serialize to `"true"`/`"false"`, numbers to `String(n)`. The `type` column is denormalized so reads can decode without re-loading the manifest if the manifest later removes a key.

The runtime creates this table idempotently the first time it opens any plugin DB. No data migration is required.

### A.2 — Schema extensions on `PluginSetting`

The `PluginSetting` type gains four optional fields, all additive:

| Field | Applies to | Effect |
|-------|------------|--------|
| `min: number` | `type: "number"` | Lower bound; rejected at validation. |
| `max: number` | `type: "number"` | Upper bound; rejected at validation. When both `min` and `max` are present, the admin UI renders a slider; otherwise a numeric input. |
| `step: number` | `type: "number"` | Slider granularity hint; defaults to `1`. Must be positive. |
| `max_length: number` | `type: "string"` and `type: "secret"` | Server-side length cap; HTTP 400 on overflow. Must be positive. |
| `enum: string[]` | `type: "string"` only | Renders as a select; values outside the list rejected. Disallowed for `secret` (would defeat masking) and `number` (use min/max instead). |

`default`, when present, must satisfy all of `min/max`, `max_length`, and `enum`. Manifest validation rejects mismatches.

### A.3 — Admin HTTP endpoints

Two endpoints, both gated by the existing admin Bearer token:

**`GET /admin/api/plugins/:slug/config`**

```jsonc
{
  "slug": "text-channels",
  "settings": [ /* PluginSetting[] from manifest, including extensions */ ],
  "values": {
    "max_message_length": 4000,
    "allow_edits": true
  }
}
```

`values` is the server's view: stored value if present, else manifest `default`. Including `settings` saves the website a second roundtrip and keeps the source-of-truth schema centralized in the runtime.

**`PATCH /admin/api/plugins/:slug/config`**

Body: `{ "key": string, "value": string | number | boolean }`

- 400 on undeclared key, type mismatch, or any constraint violation (range, length, enum).
- For `secret`: empty string clears the row; non-empty stores. The literal string `"__redacted__"` is rejected (it's the read-side mask sentinel — never round-trip).
- Upserts the row, sets `updated_by_user_id = user.id`, `updated_at = Date.now()`.
- After successful upsert, pushes the IPC frame `core.plugin.config_changed` to the plugin if it is currently running. If stopped, the new value will be picked up via `getAll()` on next start.
- Audit log row: `plugin.config_set` with payload `{ key, set: true }` for secrets, `{ key, value }` for non-secrets.
- Response: `{ "ok": true, "value"?: <echo for non-secret> }`.

The endpoints are atomic per-key — there is no bulk PATCH and no transactional multi-key write. The Phase 1 admin UI saves one setting at a time so a typo on one field doesn't gate saving the others.

### A.4 — Secret handling

`type: "secret"` values are masked on the read path:

- `GET /admin/api/plugins/:slug/config` returns the literal string `"__redacted__"` if the row exists and is non-empty, or `""` if unset. The cleartext never crosses the admin HTTP boundary.
- The admin UI must render a write-only input; placeholder copy distinguishes `(unset)` from `(set — type to replace)`.
- The plugin's own `handle.settings.get(key)` returns the real cleartext (a plugin can always see its own secrets — that's the whole point).
- Audit payloads for secrets carry only `{ key, set: true }` — the value is never logged.

### A.5 — IPC frame: `core.plugin.config_changed`

Inbound runtime → plugin frame, no permission required (every plugin always receives changes for its own keys):

```ts
{
  type: "core.plugin.config_changed",
  key: string,
  value: string | number | boolean,
  changed_by_user_id: string,
  ts: number,
}
```

The runtime delivers this frame after a successful PATCH to the plugin process whose slug owns the key. Plugins that opted out of live updates can simply ignore it; plugins that need to pick up changes without a restart register a handler via `handle.settings.onChange`.

### A.6 — SDK surface: `handle.settings`

```ts
interface SettingsApi {
  get(key: string): Promise<string | number | boolean>;
  getAll(): Promise<Record<string, string | number | boolean>>;
  onChange(handler: (event: { key: string; value: string | number | boolean }) => void): () => void;
}
```

- `get` returns the typed value (decoded from TEXT per `type`) or the manifest `default` when no row exists. Throws if the key is not declared in the manifest.
- `getAll` returns all declared keys merged with defaults. Never undefined for declared keys.
- `onChange` registers a local listener for `core.plugin.config_changed` frames addressed to this plugin. Returns a disposer.

The IPC method backing `get`/`getAll` is `data.config` (`{ type: "data.config", method: "get"|"getAll", key? }`), dispatched alongside `data.kv` and gated by no permission — every plugin always reads its own config.

### A.7 — Compatibility

- Existing plugins that did not declare `settings` are unaffected — they get an empty `_config` table and the admin UI shows them in the list with the gear icon disabled.
- Existing plugins that declared `settings` but stored values in `_kv` (none ship today, but the spec text earlier promised that path) must migrate to `handle.settings.*` before reading their values from a Layer 2 admin UI. There is no automatic migration path; this is acceptable because no plugin in the repo has actually stored settings via KV.
