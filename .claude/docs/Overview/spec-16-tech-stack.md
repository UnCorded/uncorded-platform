---
vision: "Central knows nothing beyond 'this server exists at this URL'"
tenet: "Simplicity over cleverness"
depends-on: [spec-01-vision-and-wedge, spec-03-server-container, spec-08-uncorded-central, spec-09-client-apps]
last-verified: 2026-04-05
---

# 16 — Tech Stack

*Every technology choice, why it was chosen, and the escape hatch if it fails.*

---

## Server Container

| Layer | Choice | Why | Escape hatch |
|---|---|---|---|
| **Runtime** | Bun | Fast, native TypeScript, native SQLite, single binary. The server runtime is the most performance-sensitive component. | Node.js — standard TS, same ecosystem, mature. Migration cost: moderate (replace Bun-specific APIs). |
| **Database** | SQLite (per-plugin, WAL mode) | No database server process. Each plugin owns a file. Backup = copy files. Perfect for self-hosted hardware. | PostgreSQL in-container — heavier but handles high-concurrency better. Only if SQLite contention proves real under load. |
| **Wire format** | MessagePack (WebSocket frames) | Binary, compact, fast encode/decode. Strong TypeScript library ecosystem. | CBOR — slightly richer type system, negligible difference at Phase 1 scale. |
| **Token format** | JWT with Ed25519 (EdDSA) | Standard format, small signatures, fast verification, no RSA bloat. JSON payload for interop. | None needed — JWT + Ed25519 is the correct choice for this use case. |
| **Container** | Docker | Universal. Every homelab user has it. Volumes for persistence, networking for tunnels, `cap-drop` for security. | Podman — drop-in Docker replacement, rootless by default. Works with the same Dockerfile. |
| **Tunnel (Phase 1)** | Cloudflare (trycloudflare + authenticated) | Free, reliable, fast. Two modes: Demo (no account) and Production (free account, stable URL). | Tailscale Funnel (Phase 2). TunnelProvider interface allows any provider without runtime changes. |
| **Plugin IPC** | Stdio JSON (newline-delimited) | Cross-platform (works identically on Windows, Linux, macOS). No socket management. stdin = runtime→plugin, stdout = plugin→runtime (IPC:-prefixed). Bun's native IPC is broken on Windows — stdio solved it. | TCP sockets (multi-container future). `IpcTransport` interface abstracts the channel. |

---

## UnCorded Central

| Layer | Choice | Why | Escape hatch |
|---|---|---|---|
| **Runtime** | Bun | Developer velocity — same language as server runtime. Solo dev knows it well. Small codebase (~10k lines expected). | **Node.js — defined tripwire.** If Central exhibits memory growth, crash loops, or auth-path bugs traceable to the Bun runtime with no workaround within 72 hours, migrate to Node. Trigger is runtime-caused production incidents, not benchmarks or anxiety. |
| **Database** | PostgreSQL | Central is a traditional web service (accounts, directory, marketplace). PostgreSQL is the right tool. Relational, ACID, proven at scale. | None needed at Phase 1 scale. |
| **Object storage** | Cloudflare R2 | Zero egress fees. Already on Cloudflare for domain/DNS. Stores account avatars and plugin packages only. | Any S3-compatible store. R2 uses the S3 API. |
| **Auth crypto** | Ed25519 | Same as server-side token verification. One key type across the system. | None — Ed25519 is the correct choice. |
| **Payments** | Stripe | Industry standard. Handles subscriptions, tax (Stripe Tax), invoicing, compliance. | None at Phase 1. Stripe is the right choice until scale demands otherwise. |
| **Secrets** | TBD (`[TBD-central-secrets]`) | Doppler, Vault, or cloud-native KMS. Depends on hosting environment. | Decision deferred until Central's hosting environment is chosen. |

### Portability enforcement

Central's Bun dependency is tracked and enforced:

- **Lint rule:** `no-bun-specific-apis` fails the build on any `Bun.*` global or Bun-only import without an inline escape comment (`// bun-specific: <reason>`).
- **`PORTABILITY.md`:** every Bun-specific API call is listed with its justification and its Node.js replacement. The list is reviewed on every PR that adds to it.
- **The portability budget is finite.** PRs that grow the Bun-specific list require explicit approval.

---

## Client Apps

| Layer | Choice | Why | Escape hatch |
|---|---|---|---|
| **Web framework** | SolidJS | Fine-grained reactivity, small bundle, fast. NOT React — no virtual DOM overhead. | Preact — similar API weight. But SolidJS is already chosen and familiar. |
| **Styling** | Tailwind CSS | Utility-first, consistent, fast to develop with. Semantic tokens for theming. | Any CSS solution. Tailwind is a dev preference, not an architectural dependency. |
| **Desktop app** | Electron | Bundles Chromium for identical rendering on Windows/macOS/Linux. Critical for a solo dev without Apple hardware. Mature ecosystem, battle-tested `electron-updater`. | None needed — Electron was chosen specifically because Chromium consistency eliminates cross-platform rendering bugs the developer cannot test for. |
| **Desktop ↔ Docker** | `dockerode` or shell exec | Desktop app manages Docker containers: create, start, stop, restart, delete, pull images. | Direct Docker CLI calls via `child_process`. Either works. |
| **Linting** | Oxlint | Fast, Rust-based, catches real issues. | ESLint — slower but more configurable. |
| **Formatting** | Oxfmt | Consistent with Oxlint. Fast. | Prettier — industry standard, slower. |
| **Build** | Vite | Fast dev server, good Electron integration, SolidJS plugin support. | None needed at Phase 1 scale. |

---

## Protocol Summary

| Concern | Protocol | Format |
|---|---|---|
| Client ↔ Server (plugin communication) | WebSocket | MessagePack |
| Client ↔ Server (file uploads) | HTTP POST `/upload` | Multipart form-data |
| Client ↔ Server (static assets) | HTTP GET | Standard HTTP |
| Client ↔ Central (auth, directory, marketplace) | HTTPS | JSON |
| Server ↔ Central (heartbeat) | HTTPS POST | JSON |
| Plugin ↔ Runtime (IPC) | Stdio (stdin/stdout) | Newline-delimited JSON |
| Auth tokens | JWT | JSON payload, Ed25519 signature |

**Three wire formats total:** MessagePack for WebSocket frames (high-frequency client↔server), newline-delimited JSON for IPC (plugin↔runtime, moderate frequency), and standard JSON for Central API and tokens (low-frequency). No custom binary formats. No Protobuf. No gRPC. Simplicity over cleverness.

---

## What Is NOT in the Stack

| Technology | Why not |
|---|---|
| React | SolidJS was chosen. React's virtual DOM overhead is unnecessary for a real-time app with fine-grained reactivity needs. |
| Node.js (for server runtime) | Bun is faster and has native SQLite. Node is the escape hatch, not the default. |
| Tauri | Electron chosen for Chromium consistency across platforms. Tauri's system webview (WKWebView on Mac, WebKitGTK on Linux) creates rendering differences the developer cannot test without Apple/Linux hardware. |
| PostgreSQL (in server containers) | SQLite is lighter, file-based, needs no database process. Perfect for self-hosted containers on consumer hardware. |
| Redis | No cache layer in Phase 1. The server container is a single process talking to SQLite files. If a cache is ever needed, it's an in-memory Map, not a Redis instance. |
| GraphQL | REST-over-WebSocket (`sdk.request()`) is simpler for plugin developers. GraphQL adds schema complexity with no clear benefit at this scale. |
| gRPC / Protobuf | MessagePack is simpler, human-debuggable, and has better TypeScript support. gRPC is for microservice-to-microservice communication at scale we don't have. |
| Kubernetes | Docker Compose is the ceiling. Users run one container on a home server, not a cluster. |

---

## Summary

| Question | Answer |
|---|---|
| Server runtime | Bun |
| Server database | SQLite per-plugin, WAL mode |
| Central runtime | Bun (with 72-hour Node tripwire) |
| Central database | PostgreSQL |
| Desktop app | Electron |
| Web framework | SolidJS |
| Wire format | MessagePack (WebSocket/IPC), JSON (Central API, tokens) |
| Auth tokens | JWT + Ed25519 |
| Tunnel | Cloudflare (Phase 1), Tailscale Funnel (Phase 2) |
| Payments | Stripe |
| Container | Docker |
