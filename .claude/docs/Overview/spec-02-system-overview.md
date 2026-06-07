---
vision: "Central knows nothing beyond 'this server exists at this URL'"
tenet: "Simplicity over cleverness"
depends-on: [spec-01-vision-and-wedge]
last-verified: 2026-04-05
---

# 02 — System Overview

*The three components, their boundaries, and what flows between them.*

---

## Three Components

UnCorded has exactly three components. Each is independently deployable, independently testable, and has a clearly defined boundary. Nothing else exists in the system.

```
+-------------------------------+
|       UNCORDED CENTRAL        |
|       (Cloud — lightweight)   |
|                               |
|  - Auth (accounts, tokens)    |
|  - Server Directory           |
|  - Plugin Marketplace         |
|  - Heartbeat / Invalidation   |
+---------------^---------------+
                |
  (heartbeat + auth validation only
   — never user data)
                |
  +-------------v--------------+       +---------------------------+
  |     SERVER CONTAINER       |       |      CLIENT APPS          |
  |     (User's hardware)      |       |      (User's device)      |
  |                            |       |                           |
  |  - Bun runtime             |<----->|  - Web app (SolidJS)      |
  |  - Plugin loader           |  WS   |  - Desktop app (Electron) |
  |  - Per-plugin SQLite       |       |  - Shell UI + iframes     |
  |  - Roles engine            |       |  - Docker mgmt (desktop)  |
  |  - Event bus               |       |  - Server wizard (desktop)|
  |  - Cloudflare tunnel       |       |                           |
  +----------------------------+       +---------------------------+
```

---

## What Flows Between Components

### Central ↔ Server Container

| What flows | Direction | Purpose |
|---|---|---|
| Heartbeat (every 30s) | Server → Central | Report tunnel URL, runtime version, user count, last_sync_version |
| Dirty flag + deltas | Central → Server | Profile changes, bans, token revocations, plugin revocations — only when something changed |
| Public key bundle | Central → Server | Ed25519 keys for local token validation. Delivered on first heartbeat, refreshed on key rotation. |
| Server registration | Server → Central | One-time on creation: name, description, visibility. Central returns server_id + server_secret. |

**What does NOT flow:** messages, files, voice, plugin data, user content of any kind. Ever.

### Server Container ↔ Client Apps

| What flows | Direction | Transport |
|---|---|---|
| Auth token (on connect) | Client → Server | First WebSocket message |
| Plugin requests + responses | Both | WebSocket (`sdk.request()` / response) |
| Real-time events | Server → Client | WebSocket (`sdk.subscribe()` events) |
| File uploads | Client → Server | HTTP POST to `/upload` |
| Plugin frontend assets | Server → Client | HTTP GET to `/plugins/<slug>/ui/*` |
| Admin panel | Server → Client | HTTP GET to `/admin/` |

**All plugin communication is WebSocket.** The only HTTP traffic is static file serving, file uploads, the admin panel, and health checks.

### Central ↔ Client Apps

| What flows | Direction | Transport |
|---|---|---|
| Login credentials | Client → Central | HTTPS POST |
| Session cookie | Central → Client | HTTP-only `__Host-` cookie |
| Server auth token request | Client → Central | HTTPS POST with session cookie |
| Server auth token | Central → Client | HTTPS response (JWT) |
| Server directory listing | Central → Client | HTTPS GET |
| Plugin marketplace browsing | Central → Client | HTTPS GET |

**Client apps never talk to Central during normal server usage.** After the initial token fetch, all communication goes directly to the server container. Central is only involved for login, token refresh, and directory/marketplace browsing.

---

## Trust Boundaries

Each arrow between components is a trust boundary. The rules are simple:

### Central trusts nothing from servers
- Heartbeats are authenticated with the server_secret.
- Central validates every heartbeat before updating directory state.
- A server cannot claim to be a different server.
- A server cannot modify another server's directory entry.

### Servers trust Central for identity only
- Central's public keys are used to validate user tokens. That is the full extent of the server's trust in Central.
- Central cannot read server data.
- Central cannot push code to a server.
- Central cannot modify a server's plugins, config, or data.
- If Central is compromised, the attacker gets: the ability to issue fake tokens (serious), directory manipulation (serious), and nothing else. They do not get message content, files, or plugin data from any server.

### Clients trust the server they connect to
- The client sends its auth token to the server on connect. The server validates it.
- The client trusts that the server is what Central said it is (the tunnel URL matches the directory entry).
- The client does NOT trust plugin iframes — plugin UIs run in sandboxed iframes with origin-verified postMessage for auth delivery. A malicious iframe cannot read other iframes or the shell's tokens.

### Plugins trust nothing
- Plugins run as sandboxed subprocesses inside the container.
- They communicate with the runtime via IPC. They cannot reach the network, the filesystem (beyond their own data dir), or other plugins' data.
- Every capability call is checked against the manifest's declared permissions.
- A plugin that attempts an undeclared capability gets a hard rejection, not a warning.

---

## What Central Knows

Precisely and only:

- **Account data:** email, hashed password, display name, avatar URL, Google OAuth link, registration date.
- **Server directory entries:** server_id, name, description, visibility (public/private), tunnel URL, online/offline status, connected user count, runtime version, owner account ID.
- **Plugin marketplace:** published plugin metadata, signatures, download counts, ratings.
- **Heartbeat state:** per-server sync version counter and delta log (retained 24 hours).
- **Billing:** Stripe customer ID, subscription status, payment history.

**What Central does not know and cannot obtain:** message content, file content, voice audio, plugin data, member rosters (beyond count), role assignments, channel names, server configuration details, what plugins are installed, or anything that happens inside a server container.

This is not a policy decision. It is a structural guarantee. The data never leaves the server container, so Central cannot know it even if it wanted to.

---

## Component Failure Modes

### Central goes down

| Who is affected | Impact |
|---|---|
| Already-connected users | **None.** Servers continue operating with cached keys and cached invalidation state. |
| New users trying to join a server | **Blocked (strict default).** Server cannot validate fresh tokens. Returns "auth temporarily unavailable." Server owners who opted into permissive mode allow joins using cached keys. |
| Server owners creating new servers | **Blocked.** Server registration requires Central. |
| Plugin marketplace | **Unavailable.** No browsing or installing from marketplace. Plugins already installed continue working. |

### A server container goes down

| Who is affected | Impact |
|---|---|
| Users of that server | **Disconnected.** Central marks the server offline within 30 seconds (missed heartbeat). |
| Other servers | **None.** Servers are completely independent. |
| Central | **Minimal.** Central notes the missed heartbeat, marks the server offline. No data is lost — the server's data is on the owner's disk. |

### A client app crashes

| Who is affected | Impact |
|---|---|
| That user | **Reconnects on restart.** Session cookie is still valid. Server auth token is re-fetched. No data loss — all data lives on the server. |
| Other users | **None.** Other users see a disconnect presence event for that user. |

---

## The Principle Behind the Architecture

Every architectural decision in this system optimizes for one thing: **minimizing what Central knows and does.** Central is the smallest possible trust anchor — identity and discovery, nothing else.

This is not minimalism for aesthetics. It is minimalism for:

- **Privacy.** Central cannot leak what it does not have.
- **Cost.** Central's infrastructure is cheap because it handles zero user-generated traffic.
- **Resilience.** A Central outage degrades discovery and new joins. It does not break running servers.
- **Legal exposure.** A subpoena to Central produces account emails and server URLs. It does not produce messages, files, or content, because those never touched Central.
- **Trust.** Users do not have to trust UnCorded with their data. They only trust UnCorded with their identity — the same trust they place in Google when they use "Sign in with Google" anywhere else.

---

## Summary

| Question | Answer |
|---|---|
| How many components? | Three. Central, server containers, client apps. Nothing else. |
| What does Central handle? | Auth, directory, marketplace, heartbeat. That's it. |
| What does the server container handle? | Everything else. Plugins, data, roles, events, files, admin. |
| What do clients handle? | UI shell, iframe viewport, Docker management (desktop only). |
| What flows between Central and servers? | Heartbeats and auth keys. Never user data. |
| What flows between servers and clients? | Everything over WebSocket. Static files and uploads over HTTP. |
| What flows between Central and clients? | Login, token fetch, directory browse, marketplace browse. |
| What happens when Central is down? | Running servers keep running. New joins are blocked (strict default). |
| What happens when a server is down? | That server is offline. Everything else is unaffected. |

---

## Future Refinements

### Federation (server-to-server communication)
- **What changes:** Two UnCorded servers could communicate directly — sharing events, mirroring channels, or allowing a user on Server A to interact with content on Server B without joining Server B.
- **Why not now:** Federation is an enormous protocol design problem (see Matrix, ActivityPub). Doing it wrong fragments the user experience. Doing it right requires a stable single-server experience first.
- **What today's code must not do:** The WebSocket message protocol must not assume the sender is always a local user. Leave room in the message envelope for a `source_server` field that is `null` for local messages. If federation ships, remote messages arrive through the same protocol with `source_server` populated.

### Central redundancy / multi-region
- **What changes:** Central runs in multiple regions for lower latency and higher availability.
- **Why not now:** Phase 1 scale doesn't justify multi-region. A single well-provisioned instance handles the expected load (auth tokens + heartbeats + marketplace, no user data traffic).
- **What today's code must not do:** Central's database must not use features that prevent replication (e.g., local filesystem state, in-memory-only caches without invalidation). Use stateless request handling and a replicable database from day one.
