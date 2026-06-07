---
vision: "Central knows nothing beyond 'this server exists at this URL'"
tenet: "Local-first, user-owned data"
depends-on: [spec-01-vision-and-wedge, spec-04-plugin-architecture, spec-05-plugin-data-model, spec-06-authentication]
last-verified: 2026-04-05
---

# 03 — Server Container

*The thing users actually run. What's inside the Docker container, how it starts, how it connects to Central, how it serves plugins, and how it stays alive.*

> **Every endpoint in this container is rate-limited. No exceptions.** See the Rate Limiting section. This is a homelab server on a residential connection — one bad actor with a script can take it down. Rate limits are not a polish task. They ship in Phase 1.

---

## What the Server Container Is

A server container is a **single Docker container** running on the server owner's hardware. It is the entire server — runtime, plugins, data, tunnel, everything. There is no sidecar, no database container, no separate reverse proxy. One container.

The base image is published by UnCorded and updated as part of the release pipeline:

```
uncorded/server:<version>
```

---

## Container Filesystem

```
/app/
├── runtime/              ← Bun runtime + core code (plugin loader, router, auth gateway,
│                            roles engine, event bus, watchdog)
├── core-plugins/         ← bundled core plugins (text-channels, members, moderation)
│                            present on disk but only loaded if installed via server config
└── entrypoint.sh         ← container entrypoint

/plugins/                 ← mounted volume — user-installed plugins live here
/data/
├── core.db               ← runtime database (roles, server settings, audit log)
├── plugins/
│   ├── text-channels.db  ← per-plugin SQLite (see spec-05-plugin-data-model.md)
│   ├── members.db
│   └── ...
└── uploads/
    ├── text-channels/    ← per-plugin file storage
    └── photo-gallery/

/config/
├── server.json           ← server identity, tunnel config, installed plugins list
└── tunnel.json           ← tunnel credentials (if using authenticated Cloudflare)
```

**Three directories are persistent volumes:** `/plugins`, `/data`, `/config`. Everything else is ephemeral — rebuilt from the image on container restart.

**Backing up a server** = copying these three directories. Restoring = mounting them into a fresh container.

---

## Server Configuration (`server.json`)

```json
{
  "server_id": "server_xyz",
  "server_secret": "sk_...",
  "central_url": "https://central.uncorded.app",
  "central_public_keys": [ "..." ],
  "last_sync_version": 42,

  "installed_plugins": [
    "text-channels",
    "members",
    "moderation"
  ],

  "tunnel": {
    "provider": "cloudflare",
    "mode": "production",
    "credentials_file": "/config/tunnel.json",

    // Phase 2: secondary TunnelProvider config for auto-failover.
    // When populated, the runtime calls stop() on the failed provider
    // and start() on this one. Until then, tunnel failure uses the
    // detection + upgrade prompt path (see Tunnel Failure Detection).
    "fallback": null
  },

  "settings": {
    "permissive_mode": false,
    "max_connections": 100,
    "allow_unsigned_plugins": false
  }
}
```

**`installed_plugins`** is the authoritative list. Plugins present on disk but not in this list are ignored. Nothing loads by default — every plugin is a decision the owner made.

---

## Startup Sequence

When the container starts, the following happens in order. Any failure in steps 1-4 is fatal — the container exits with a clear error.

```
[1] Load /config/server.json
    → Parse server identity, tunnel config, installed plugins list
    → If file is missing or malformed → fatal error with specific message

[2] Open runtime database
    → /data/core.db (roles, server settings, audit log, migration tracking)
    → Run runtime schema migrations if needed (same numbered-file pattern as plugins)

[3] Establish tunnel
    → Use the configured TunnelProvider (see Tunnel Abstraction below)
    → Capture the resulting public URL
    → If tunnel fails → fatal error: "Tunnel failed to start: <provider-specific reason>"

[4] Phone home to Central
    → POST heartbeat with tunnel URL, runtime version, last_sync_version
    → Receive: dirty flag, deltas (if any), current Central public keys
    → Cache the public keys for token validation
    → Apply any deltas (bans, revocations, profile updates)
    → If Central is unreachable and no cached keys exist → fatal error
    → If Central is unreachable but cached keys exist → warn and continue
      (server operates with stale cache until Central returns)

[5] Resolve installed plugins
    → Read installed_plugins[] from server.json
    → Locate each plugin folder (core-plugins/ or /plugins/)
    → Validate each manifest.json
    → Check dependencies and resolve topological load order
    → Plugins on disk but NOT in installed_plugins[] are ignored

[6] Load plugins (per-plugin, in dependency order)
    → Run migrations (see spec-05-plugin-data-model.md)
    → Spawn backend subprocess (see spec-04-plugin-architecture.md)
    → Wait for "ready" signal from backend
    → Mount frontend static files at /plugins/<slug>/ui/
    → Each step produces a specific error on failure (see 04 error handling requirement)

[7] Start HTTP server
    → Bind to container port (default: 3000)
    → Serve routes (see HTTP Surface below)
    → Accept WebSocket upgrades

[8] Start heartbeat loop (Phase 1: HTTP polling, Phase 2+: persistent WebSocket)
    → Phase 1: every 30 seconds, POST heartbeat to Central with last_sync_version
    → Phase 2+: server maintains a persistent outbound WebSocket to Central.
      Heartbeat and push both flow over this single connection.
      Central pushes emergency revocations in real-time over this channel.
    → The HTTP polling heartbeat is NOT removed when persistent WS ships.
      It becomes the permanent fallback — if the persistent connection drops,
      the server falls back to polling automatically and resumes persistent
      when restored. Phase 1's polling path is durable infrastructure, not
      temporary scaffolding.
    → Apply returned deltas (if dirty)
    → Update last_sync_version
    → If Central is unreachable: log warning, continue operating with cached state

[9] Ready
    → Log: "server <id> ready — <N> plugins loaded — tunnel: <url>"
    → Container is live and accepting connections
```

---

## HTTP Surface

The runtime's HTTP surface is deliberately small. Plugins do not register HTTP routes — all plugin communication goes over WebSocket (see `spec-04-plugin-architecture.md`).

| Endpoint | Method | Auth required | Purpose |
|---|---|---|---|
| `/` | GET | No | Redirect to UnCorded login or a minimal "this is an UnCorded server" landing page |
| `/ws` | GET (upgrade) | Yes (token in first message) | WebSocket connection — all plugin communication |
| `/upload` | POST | Yes (Bearer token) | File uploads — routed to the correct plugin by `X-Plugin` header |
| `/plugins/<slug>/ui/*` | GET | **No** (unauthenticated by default) | Static frontend files for each plugin's iframe. These are code, not data — the same for every user. Serving without auth enables browser caching and future CDN delivery. Plugins can opt into authenticated assets via `"authenticated_assets": true` in the manifest. |
| `/plugins/<slug>/manifest.json` | GET | **Follows server visibility** | Public servers: unauthenticated (manifest is discoverable). Private servers: auth required (prevents plugin enumeration by unauthenticated visitors — knowing "this server runs a therapy intake plugin" is metadata leakage). |
| `/admin/` | GET | Yes (owner/admin role) | Admin panel web UI |
| `/admin/api/*` | Various | Yes (owner/admin role) | Admin panel backend endpoints |
| `/health` | GET | No | Health check — returns `{ status: "ok", plugins: N, uptime: S }` |

**That's it.** Six route groups. The WebSocket at `/ws` carries all plugin traffic — requests, responses, events, everything. The HTTP surface exists only for static file serving, file uploads, the admin panel, and health checks.

### Why no per-plugin HTTP routes

- The runtime mediates everything — auth, capabilities, rate limiting, audit — in one place (the WebSocket handler), not split across an HTTP proxy and a WebSocket router.
- Fewer HTTP endpoints = smaller attack surface.
- Plugin developers learn two SDK functions (`sdk.request()` and `sdk.subscribe()`), not REST API design.
- Real-time by default — every plugin is naturally live-updating because the communication layer IS the real-time layer.

---

## WebSocket Connection Lifecycle

```
[1] Client connects to /ws
    → WebSocket upgrade accepted

[2] Client sends first message: { type: "auth", token: "<server-auth-token>" }
    → Runtime validates JWT signature against cached Central public keys
    → Checks: token not expired, server_id matches, jti not replayed
    → Resolves user's role from /data/core.db
    → If invalid → close connection with error code + reason

[3] Connection authenticated
    → User is added to the connected users set
    → Presence event emitted: runtime.user.connected
    → Client can now send plugin requests and receive events

[4] During connection
    → Client sends: { type: "request", id, plugin, action, params }
    → Runtime validates capability, routes to plugin subprocess, returns response
    → Runtime pushes events the client is subscribed to
    → Shell pushes token refreshes to plugin iframes via postMessage (client-side)

[5] Disconnect
    → User removed from connected users set
    → Presence event emitted: runtime.user.disconnected
    → In-flight requests are abandoned (client will retry on reconnect)
```

---

## Rate Limiting (Server-Side)

The server container enforces its own rate limits, independent of Central's rate limits. A bad actor hammering a homelab server's tunnel URL could DoS it without Central ever being involved.

### Per-endpoint limits

| Endpoint / Action | Limit | Scope |
|---|---|---|
| WebSocket connection attempts | 10/min | Per IP |
| WebSocket auth failures | 5/min | Per IP (escalating: 3 failures in a row → 5-minute IP ban) |
| `sdk.request()` calls | 60/min | Per user per plugin |
| `sdk.subscribe()` calls | 20/min | Per user |
| `/upload` | 10/min | Per user |
| `/admin/*` | 30/min | Per user |
| `/health` | 60/min | Per IP |

### Enforcement

- Rate limits are checked **before** any business logic runs.
- Exceeded limits return a WebSocket error frame with `retry_after` for WebSocket actions, or HTTP 429 with `Retry-After` header for HTTP endpoints.
- **Repeated auth failures trigger escalating IP bans** — 3 consecutive failures → 5-minute ban, 10 → 1-hour ban. This protects against brute-force token guessing.
- All rate limit events are logged to the audit log.
- Server owners can adjust limits in the admin panel for their specific use case (a busy gaming server might need higher request limits than a family photo server).

---

## Tunnel Abstraction

The runtime does not hardcode a tunnel provider. There is a `TunnelProvider` interface the runtime uses:

```ts
interface TunnelProvider {
  start(config: TunnelConfig): Promise<string>  // returns public URL
  stop(): Promise<void>
  getUrl(): string
  healthCheck(): Promise<boolean>
}
```

### Phase 1 providers

**Cloudflare** ships in two modes:

| Mode | Label in wizard | Requires account | URL stability | Use case |
|---|---|---|---|---|
| **Demo** | "Demo server (temporary)" | No | URL changes on restart | Testing, trying things out, showing a friend |
| **Production** | "Production server (recommended)" | Free Cloudflare account | Stable named URL | Real servers, invite links that persist |

Demo mode is explicitly labeled as ephemeral. The wizard shows a clear warning: "URL changes on restart. Invites will break. Do not use for real servers."

### Tunnel failure detection

- The runtime calls `healthCheck()` periodically (every heartbeat cycle).
- If the tunnel becomes unreachable:
  - The heartbeat payload includes `tunnel_state: "unreachable"` with the provider name.
  - Central marks the server as offline in the directory.
  - If the failed tunnel is a Demo (trycloudflare) tunnel, the shell renders an **upgrade prompt** in the plugin viewport instead of an error: "Demo servers use a temporary tunnel that can go offline. Ready for a production server?"
  - The upgrade flow: user accepts → desktop app opens Cloudflare account setup → runtime config updated → tunnel restarted in Production mode → server live again with stable URL.
- If the failed tunnel is a Production tunnel, the shell shows a connection error with diagnostic information (tunnel provider, last known URL, time since last successful health check).

---

## Connected Users and Presence

The runtime tracks connected users in memory:

```ts
// In-memory map, not persisted
connectedUsers: Map<UserId, {
  connectionId: string,
  connectedAt: number,
  role: Role,
  displayName: string,
  avatarUrl: string
}>
```

### Presence events

| Event | When |
|---|---|
| `runtime.user.connected` | User successfully authenticates on WebSocket |
| `runtime.user.disconnected` | WebSocket closes (any reason) |

Plugins can subscribe to these events to show online indicators, update member lists, or trigger actions on join/leave.

### User count in heartbeat

The heartbeat sends `connected_users: N` to Central so the directory can show live user counts. Central does not know WHO is connected — just how many.

---

## Container Resource Considerations

The server container runs on user hardware — ranging from a Raspberry Pi to a dedicated server. The runtime must be respectful of resources.

### Base runtime overhead

- **RAM:** ~50-80 MB for the Bun runtime + router + event bus + roles engine before any plugins load.
- **CPU:** near-zero when idle. The runtime is event-driven — it only uses CPU when processing WebSocket messages, heartbeats, or plugin IPC.
- **Disk:** the base image is ~100-150 MB. Plugin data and uploads grow with usage.

### Per-plugin overhead

Each plugin runs as a subprocess (see `spec-04-plugin-architecture.md` for limits):
- Default 128 MB memory cap per plugin
- A server with 5 plugins: ~700 MB total (runtime + 5 plugins at default limits)
- A server with 20 plugins: ~2.6 GB total (runtime + 20 plugins at default limits)

Server owners with limited hardware can lower per-plugin memory limits in the admin panel.

---

## Container Networking

### Inbound

- One port exposed (default: 3000).
- Tunnel maps this port to a public URL.
- All inbound traffic goes through the tunnel → port 3000 → runtime HTTP server.

### Outbound

- **Denied by default** at the container level.
- The runtime proxies outbound requests for plugins that declare `http.fetch:<host>`.
- The tunnel provider's own traffic (Cloudflare daemon, etc.) is allowlisted.
- Heartbeat to Central is allowlisted.
- Everything else is blocked.

### Internal (plugin ↔ runtime)

- Plugins communicate with the runtime over **stdio JSON** (newline-delimited JSON over stdin/stdout). This works identically on Windows, Linux, and macOS — no platform-specific socket management.
- Each plugin's stdin/stdout is piped to the runtime. IPC:-prefixed stdout lines are messages; non-prefixed lines go to the log collector.
- Plugins cannot communicate with other plugins directly — the runtime is the only mediator.
- The `IpcTransport` interface abstracts the channel — future multi-container deployments can swap to TCP without changing the message protocol.

---

## Container Lifecycle (Desktop App Controls)

The desktop app (Electron) manages the container lifecycle on the owner's machine:

| Action | What happens |
|---|---|
| **Start** | `docker start <container>` → startup sequence runs |
| **Stop** | `docker stop <container>` → SIGTERM → plugins gracefully shut down → tunnel closes → final heartbeat with `tunnel_state: "shutdown"` → Central marks server offline |
| **Restart** | Stop then start. Demo tunnel gets a new URL. Production tunnel keeps the same URL. |
| **Update runtime** | Pull new `uncorded/server:<version>` image → stop → recreate container with same volumes → start. Data is preserved because volumes are mounted. |
| **Delete server** | Stop → optionally deregister from Central → remove container and volumes. Requires explicit confirmation. Owner can choose to keep data volumes as a backup. |

### Graceful shutdown

On SIGTERM:
1. Runtime sends SIGTERM to all plugin subprocesses (5s grace each).
2. Active WebSocket connections receive a `runtime.server.shutting_down` event.
3. Tunnel is closed.
4. Final heartbeat sent to Central: `tunnel_state: "shutdown"`.
5. Runtime exits.

---

## Server Identity and Registration

### First-time setup (via desktop wizard)

1. Desktop app calls Central: `POST /v1/servers { name, description, visibility }`.
2. Central creates the server record, returns `{ server_id, server_secret }`.
3. Desktop app writes `server.json` with the server identity.
4. Container starts, phones home, Central records the tunnel URL.
5. Server is now registered and discoverable (if public).

### The `server_secret`

- A long random string Central generates on server creation.
- Used to authenticate heartbeat requests — Central verifies the heartbeat comes from the server, not an impersonator.
- Stored only in `/config/server.json` and in Central's database.
- **Never sent to users.** Never included in tokens. Never exposed to plugins.
- If compromised: the owner regenerates it via the admin panel, which calls Central to issue a new one.

---

## Summary of Decisions

| Decision | Answer |
|---|---|
| Container model | Single Docker container. No sidecar, no separate DB container. |
| Persistent volumes | `/plugins`, `/data`, `/config`. Everything else ephemeral. |
| Plugin loading | Only plugins listed in `installed_plugins[]` in server.json. Presence on disk is not enough. |
| HTTP surface | 6 route groups. `/ws` for all plugin communication. No per-plugin HTTP routes. |
| Rate limiting | Server-side, per-endpoint, enforced before business logic. Escalating IP bans on auth failures. |
| Tunnel | `TunnelProvider` abstraction. Phase 1: Cloudflare Demo + Production. Phase 2: Tailscale Funnel. |
| Tunnel failure | Health check every heartbeat. Demo failure → upgrade prompt. Production failure → error with diagnostics. |
| Presence | In-memory connected users map. Events on connect/disconnect. User count (not identities) sent to Central. |
| Outbound network | Denied by default. Runtime proxies for `http.fetch` capabilities. |
| Plugin IPC | Stdio JSON (newline-delimited JSON over stdin/stdout). Cross-platform. `IpcTransport` interface for future TCP swap. |
| Container lifecycle | Desktop app controls start/stop/restart/update/delete. Graceful shutdown with final heartbeat. |
| Backup | Copy `/plugins`, `/data`, `/config`. Restore = mount into fresh container. |

---

## Future Refinements

### Managed hosting mode
- **What changes:** UnCorded operates infrastructure where users can create servers without installing Docker or the desktop app. The container runs on UnCorded-managed hardware.
- **Why not now:** The core platform must be proven and operationally mature before taking on the ops burden of hosting other people's servers. Phase 1 validates the architecture on self-hosted hardware.
- **What today's code must not do:** The runtime must not assume it runs on the owner's local machine. No `localhost` assumptions for service discovery. No assumptions about disk speed, available RAM, or network topology. The container must be relocatable — it works wherever Docker runs.

### Multi-container plugin isolation
- **What changes:** High-risk or resource-heavy plugins could run in their own Docker container, communicating with the main runtime container over a Docker network.
- **Why not now:** Subprocess isolation inside a single container is sufficient for Phase 1 scale and the current trust model. Multi-container adds Docker Compose complexity that breaks the "one container" simplicity.
- **What today's code must not do:** The `IpcTransport` interface must remain network-transparent. The current stdio implementation works inside a single container; a TCP implementation would work across containers. The message format is the same either way — swapping the transport must not require plugin code changes.

### Container auto-updates
- **What changes:** The desktop app detects a new `uncorded/server` image version and offers a one-click update (pull + recreate with same volumes).
- **Why not now:** The desktop app in Phase 1 handles manual updates. Auto-detection adds complexity and needs a notification model (how urgent is this update? Security patch or feature release?).
- **What today's code must not do:** The runtime version must be reported in every heartbeat. Central can use this to track which servers are outdated and, in the future, push update notifications to the desktop app.

### Health dashboard for server owners
- **What changes:** A visual dashboard showing runtime health, per-plugin resource usage over time, connection history, tunnel uptime, and disk usage trends. Currently, the admin panel shows point-in-time status.
- **Why not now:** Historical metrics require a time-series store or at minimum a rolling log. Phase 1 admin panel shows current state, which is sufficient for small servers.
- **What today's code must not do:** The runtime must emit structured metrics (plugin memory usage, request latency, event bus throughput) even if nothing consumes them in Phase 1. When the dashboard ships, the data source already exists.

### Persistent WebSocket to Central (Phase 2)
- **What changes:** The server maintains a long-lived outbound WebSocket to Central. Heartbeat and emergency push both flow over this single connection. The server initiates the connection (not Central → server), which avoids Central needing to track tunnel URLs and manage thousands of outbound connections.
- **Why not now:** Phase 1 polling heartbeat covers all current needs. The persistent connection is required for the emergency revocation push channel, which gates the public directory opening in Phase 2.
- **What today's code must not do:** The server's Central client must not assume "Central communication = HTTP POST only." The client should be structured as a `CentralConnection` interface with a `poll()` method (Phase 1) and room for a `connect()` method (Phase 2 persistent WS). When the persistent connection drops, the client falls back to polling automatically. **The HTTP polling heartbeat is permanent infrastructure — it is the fallback path forever, not temporary scaffolding to be removed.**

### Tunnel provider failover
- **What changes:** If the primary tunnel provider goes down, the runtime automatically switches to a configured fallback provider. Currently, failure surfaces a prompt or error — it doesn't auto-recover.
- **Why not now:** Phase 1 ships one provider (Cloudflare). Auto-failover requires at least two configured and tested providers. Tailscale Funnel in Phase 2 enables this.
- **What today's code must not do:** `server.json` must support a `tunnel.fallback` field even if the runtime ignores it in Phase 1. The `TunnelProvider` interface already supports `stop()` and `start()` — failover is calling `stop()` on one and `start()` on another. The interface is ready; the orchestration is future work.
