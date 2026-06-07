---
vision: "Central knows nothing beyond 'this server exists at this URL'"
tenet: "Simplicity over cleverness"
depends-on: [spec-02-system-overview, spec-06-authentication]
last-verified: 2026-04-05
---

# 08 — UnCorded Central

*The cloud service. What it does, what it doesn't do, its API surface, rate limiting, and the permanent SPOF question.*

---

## What Central Is

Central is the **smallest possible cloud service** that makes self-hosted servers viable. It does four things:

1. **Auth** — accounts, login, token issuance, public key distribution
2. **Server Directory** — server registration, public listing, online/offline tracking
3. **Plugin Marketplace** — browse, download, publish plugins
4. **Heartbeat service** — receive heartbeats, track server status, push invalidation deltas

Central is deliberately lightweight. It never touches user content, never proxies data traffic, never stores messages or files. Its infrastructure cost per server is tiny — auth tokens, heartbeats (~20 bytes when nothing changed), and marketplace metadata.

---

## What Central Is NOT

- Not a message relay. Messages go user → server → users. Central is not in the path.
- Not a file store (for user content). Central stores account avatars and plugin packages. Not user-uploaded files.
- Not a CDN. Plugin frontends and user files are served by the server container, not Central.
- Not a moderation engine. Central can delist servers and revoke accounts. It cannot inspect server content because it does not have it.

---

## API Surface

### Auth endpoints

| Endpoint | Method | Auth | Purpose |
|---|---|---|---|
| `/v1/auth/register` | POST | No | Create account (email+password or Google OAuth) |
| `/v1/auth/login` | POST | No | Login, receive session cookie |
| `/v1/auth/logout` | POST | Session | Clear session |
| `/v1/auth/token/server` | POST | Session | Issue a short-lived server auth token (JWT) for a specific server |
| `/v1/auth/token/refresh` | POST | Session | Refresh session before expiry |
| `/v1/auth/profile` | GET/PATCH | Session | Read or update display name, avatar |
| `/v1/auth/google` | GET | No | Google OAuth redirect |
| `/v1/auth/google/callback` | GET | No | Google OAuth callback |

### Server directory endpoints

| Endpoint | Method | Auth | Purpose |
|---|---|---|---|
| `/v1/servers` | POST | Session | Register a new server (from desktop wizard) |
| `/v1/servers` | GET | Session | Browse the public server directory (search, filter, paginate) |
| `/v1/servers/:id` | GET | Session | Get server details (name, description, online status, user count) |
| `/v1/servers/:id` | PATCH | Session (owner) | Update server name, description, visibility |
| `/v1/servers/:id` | DELETE | Session (owner) | Deregister server from Central |
| `/v1/servers/:id/heartbeat` | POST | Server secret | Heartbeat from a running server container |
| `/v1/servers/:id/transfer` | POST | Session (owner) | Transfer ownership to another account |
| `/v1/servers/:id/secret/rotate` | POST | Session (owner) | Generate new server_secret |

### Marketplace endpoints

| Endpoint | Method | Auth | Purpose |
|---|---|---|---|
| `/v1/plugins` | GET | Session | Browse plugins (search, filter, sort by installs/rating) |
| `/v1/plugins/:slug` | GET | Session | Plugin details (description, screenshots, ratings, trust tier) |
| `/v1/plugins/:slug/download` | GET | Session | Download plugin package (signed, verified) |
| `/v1/plugins` | POST | Session (publisher) | Publish a new plugin |
| `/v1/plugins/:slug/versions` | POST | Session (publisher) | Publish a new version |
| `/v1/plugins/:slug/report` | POST | Session | Report a plugin |

### Internal / system endpoints

| Endpoint | Method | Auth | Purpose |
|---|---|---|---|
| `/v1/reports` | GET | Admin | Review pending reports (servers and plugins) |
| `/v1/reports/:id` | PATCH | Admin | Resolve a report (delist, revoke, dismiss) |
| `/health` | GET | No | Central health check |

---

## Rate Limiting

Central is small but it's the platform's trust anchor. Every critical endpoint has rate limits, enforced at the edge before any business logic runs.

### Per-endpoint limits

| Endpoint | Limit | Scope |
|---|---|---|
| `/v1/auth/register` | 3/hour | Per IP. 20/hour per ASN. |
| `/v1/auth/login` | 10/min | Per IP. Exponential backoff + account lockout on 5 consecutive failures. |
| `/v1/auth/token/server` | 30/min | Per account. This is hit every time a user joins a server or a token refreshes. |
| `/v1/servers/:id/heartbeat` | 3/min | Per server. Expected: 2/min (one every 30s). Grace for retries. |
| `/v1/servers` (directory browse) | 30/min | Per account. Per IP. |
| `/v1/plugins` (marketplace browse) | 60/min | Per account. |
| `/v1/plugins/:slug/download` | 10/min | Per account. |

### Enforcement

- Rate limits return **HTTP 429** with a `Retry-After` header.
- The shell app surfaces rate-limit errors as specific user messages, not generic failures.
- Starting numbers are conservative and tuned with real traffic. Exact values live in an ops runbook, not in the architecture doc, because they will change.

---

## Data Central Stores

| Data | What | Why |
|---|---|---|
| **Accounts** | email, hashed password (Argon2id), display name, avatar URL, Google OAuth link, registration date, phone_verified flag | Identity |
| **Server directory** | server_id, name, description, visibility, tunnel URL, online/offline, connected user count, runtime version, owner account ID, server_secret (hashed) | Discovery |
| **Heartbeat state** | Per-server sync version counter + delta log (retained 24 hours) | Dirty flag invalidation |
| **Plugin marketplace** | Plugin metadata, signed packages, download counts, ratings, publisher info, trust tier | Distribution |
| **Billing** | Stripe customer ID, subscription status, payment history | Payments |
| **Reports** | Reporter account, target (server or plugin), report type, evidence, status, reviewer notes | Trust & Safety |
| **Enforcement log** | Every delisting, revocation, and law enforcement response with timestamp and actor | Transparency |

### What Central does NOT store

Messages, files, voice recordings, plugin data, member rosters, role assignments, channel names, server configuration details, plugin SQLite databases, or anything that happens inside a server container. This is not a policy — it is structural. The data never arrives at Central.

---

## Central as a Permanent Single Point of Failure

The product pitch is "your data, your hardware, your server." The reality is that if Central permanently goes away — company dies, servers seized, whatever — every self-hosted server eventually degrades.

- Cached public keys rotate. Without fresh keys from Central, servers cannot validate new user tokens.
- No new users can join any server. Existing sessions work until tokens expire.
- The directory disappears. Servers are undiscoverable.
- The marketplace disappears. No new plugins can be installed.

For a platform whose identity is user ownership, Central being a permanent SPOF is a real tension.

### Options (not resolved — `[TBD-central-shutdown-story]`)

**Option A — Accept the tension.** Central staying alive is a prerequisite. Users accept this when they sign up. Most platforms have this same dependency (Steam, Discord, every SaaS).

**Option B — Last will and testament.** If Central is shutting down permanently, publish a signed shutdown package: long-lived fallback public keys, a data export of the directory, and documentation for running a self-hosted Central. Servers that trust UnCorded's root key accept the shutdown certificate and switch to offline-verification mode.

**Option C — Self-hostable Central in Phase 3+.** Power users can run their own Central entirely, federated or standalone. This is the strongest answer but the most engineering work.

**This is not resolved.** It is named honestly as an open question. The starting position is Option A (accept the tension, like every other platform). Options B and C are future refinements the architecture does not block.

---

## Behavior During Central Outages

### Already-connected users: unaffected
Servers cache Central's public keys and token validation results. Missed heartbeats mean no new invalidations are applied. Existing sessions continue working.

### New joins: fail closed by default
Server cannot validate fresh tokens → returns "UnCorded authentication is temporarily unavailable. Please try again shortly." Security > availability.

### Permissive mode (opt-in by server owner)
Server accepts new joins using cached public keys alone. No fresh user lookup, no ban-list refresh during the outage. **The admin UI must show a prominent warning with specific consequences:**
- Banned users can re-join during the outage
- Revoked accounts can still authenticate
- Globally banned users (ToS violations) are not blocked until Central returns

Enabling permissive mode is intentionally inconvenient — a security tradeoff the operator must actively accept.

### Default is strict
The platform ships with fail-closed behavior. Operators who need availability over freshness opt in with both eyes open.

---

## Summary

| Question | Answer |
|---|---|
| What does Central do? | Auth, directory, marketplace, heartbeat. That's it. |
| What does Central NOT do? | Proxy user data, store messages/files, moderate content, run servers. |
| Database? | PostgreSQL |
| Runtime? | Bun (with 72-hour Node tripwire) |
| Is every endpoint rate-limited? | Yes. Per-IP and per-account. |
| Is Central a SPOF? | Yes. Acknowledged honestly. Options B and C exist but are not resolved. |
| What happens during a Central outage? | Running servers keep running. New joins fail closed by default. Permissive mode is opt-in with loud warnings. |

---

## Future Refinements

### Central shutdown story (`[TBD-central-shutdown-story]`)
- **What changes:** A defined plan for what happens if UnCorded Central permanently shuts down. Options range from "accept the tension" to "publish a shutdown package with fallback keys" to "self-hostable Central."
- **Why not now:** The platform hasn't launched. Solving permanent-shutdown before first-user is premature. But the tension is named honestly so it isn't a surprise later.
- **What today's code must not do:** Central's public key infrastructure must not use keys that are impossible to publish externally. The key format and validation logic must be documented well enough that a third party could theoretically run their own key server. This keeps Option B and C viable.

### Central multi-region
- **What changes:** Central runs in multiple regions for lower latency and higher availability.
- **Why not now:** Phase 1 scale doesn't justify it. A single well-provisioned instance handles auth tokens + heartbeats + marketplace.
- **What today's code must not do:** Central must be stateless per-request (no in-memory session state, no local filesystem caches without invalidation). The database must be replicable. These are just good practices that happen to enable multi-region later.

### Central API versioning
- **What changes:** Central's API gets a formal versioning strategy (v1, v2) with deprecation lifecycle, so client apps and server containers can be updated independently.
- **Why not now:** Phase 1 has one version of everything. API versioning matters when there are multiple client versions in the wild that can't all update simultaneously.
- **What today's code must not do:** All Central endpoints are already under `/v1/`. This is the versioning strategy. When v2 ships, v1 continues to work for a deprecation period. The URL prefix is the mechanism.
